// Planning: everything up to (but not including) encoding. `vmap build --dry-run`
// stops here and prints the plan and size estimate.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { estimateSizes, formatSize, planWall, resolveLayouts, tileCodec } from '@videomap/core';
import { assignIds, validateScene } from '@videomap/core/validate';
import { exists, isUrl } from './cache.js';
import { previewWindow } from './encode.js';
import { probe } from './probe.js';

export { estimateSizes };

export class SceneError extends Error {
  /** @param {string} message @param {Array<{ path: string, message: string }>} [issues] */
  constructor(message, issues = []) {
    super(message);
    this.name = 'SceneError';
    this.issues = issues;
  }
}

/**
 * Read, parse and validate a scene file.
 * @param {string} scenePath
 */
export async function loadScene(scenePath) {
  let text;
  try {
    text = await readFile(scenePath, 'utf8');
  } catch (err) {
    throw new SceneError(`Couldn't read ${scenePath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
  }
  let scene;
  try {
    scene = JSON.parse(text);
  } catch (err) {
    throw new SceneError(`${scenePath} is not valid JSON: ${err.message}`);
  }
  const result = validateScene(scene);
  if (!result.valid) throw new SceneError(`${scenePath} has ${result.errors.length} problem(s)`, result.errors);
  return { scene, warnings: result.warnings.map((w) => `${w.path}: ${w.message}`) };
}

/**
 * @typedef {object} Source
 * @property {number} index
 * @property {string} id
 * @property {any} entry  the scene's video entry
 * @property {string} src  absolute path or URL
 * @property {string|null} posterSrc
 * @property {string} fingerprint
 * @property {import('./probe.js').ProbeInfo} probe
 * @property {{ start: number, loop: boolean, adjusted: boolean }} window
 * @property {{ x: number, y: number, w: number, h: number }} [rect]  set by planBuild: the video on the wall
 * @property {'cover'|'contain'} [fit]  set by planBuild
 */

/**
 * @param {object} o
 * @param {string} o.scenePath
 * @param {any} o.scene
 * @param {any} [o.overrides]
 * @param {import('./cache.js').BuildCache} o.cache
 * @param {import('./ffmpeg.js').Tools} o.tools
 * @param {<T>(fn: () => Promise<T>) => Promise<T>} o.limit
 * @param {import('./progress.js').Progress} o.progress
 * @param {boolean} [o.toneMapAvailable]
 */
export async function planBuild({ scenePath, scene, overrides, cache, tools, limit, progress, toneMapAvailable = false }) {
  const sceneDir = path.dirname(path.resolve(scenePath));
  // The main layout, then any pre-baked alternates; they share everything but the layout.
  const arrangements = resolveLayouts(scene, overrides);
  const config = arrangements[0].config;
  const ids = assignIds(scene.videos);
  const warnings = [];

  const resolve = (p) => (isUrl(p) ? p : path.resolve(sceneDir, p));
  const missing = [];
  await Promise.all(scene.videos.map(async (v, i) => {
    for (const [field, p] of [['src', v.src], ['poster', v.poster]]) {
      if (p && !isUrl(p) && !(await exists(resolve(p)))) missing.push({ path: `videos[${i}].${field}`, message: `file not found: ${p}` });
    }
  }));
  if (missing.length) {
    missing.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
    throw new SceneError(`${missing.length} file(s) not found`, missing);
  }

  // Probe every source (cached by fingerprint).
  const probeStarted = Date.now();
  const phase = progress.phase('Probe', scene.videos.length);
  /** @type {Source[]} */
  const sources = await Promise.all(scene.videos.map((entry, index) => limit(async () => {
    const src = resolve(entry.src);
    const fingerprint = await cache.fingerprint(src);
    let info = cache.probes[fingerprint];
    const cached = Boolean(info);
    if (!info) {
      info = await probe(tools, src);
      cache.probes[fingerprint] = info;
    }
    phase.tick(cached);
    const window = previewWindow({
      duration: info.duration,
      previewStart: entry.previewStart,
      strategy: config.preview.startStrategy,
      loopLength: config.preview.duration,
    });
    return { index, id: ids[index], entry, src, posterSrc: entry.poster ? resolve(entry.poster) : null, fingerprint, probe: info, window };
  })));
  phase.end();
  const probeSeconds = (Date.now() - probeStarted) / 1000;

  // Layout and pyramid, per arrangement: every video becomes a rectangle on the wall.
  const layoutVideos = sources.map((s) => ({
    id: s.id,
    title: s.entry.title ?? s.id,
    src: s.entry.src,
    categories: s.entry.categories,
    tags: s.entry.tags,
    meta: s.entry.meta,
    duration: s.probe.duration,
    aspect: s.probe.width / s.probe.height,
  }));
  /** @type {Wall[]} */
  const walls = arrangements.map(({ id, label, config: c }, i) => {
    const w = planWall(layoutVideos, c, { categories: scene.categories ?? [] });
    const prefix = i === 0 ? '' : `layouts/${id}/`;
    warnings.push(...w.warnings.map((msg) => (i === 0 ? msg : `layouts "${id}": ${msg}`)));
    return {
      id,
      label,
      config: c,
      prefix,
      layout: w.layout,
      pyramid: w.pyramid,
      tiles: w.tiles,
      codecs: c.output.tileCodecs.map((codec) => {
        const t = tileCodec(codec, w.pyramid.tile.w, w.pyramid.tile.h, c.preview.fps);
        return { ...t, template: prefix + t.template };
      }),
      // How each video fills its rectangle. Masonry rectangles already have the video's shape.
      fits: sources.map((s) => (w.layout.pack === 'grid' ? s.entry.fit ?? c.layout.fit : 'contain')),
    };
  });
  const { layout, pyramid, tiles, codecs } = walls[0];

  for (const s of sources) {
    s.rect = layout.rects[s.index];
    s.fit = walls[0].fits[s.index];
  }

  // Source warnings.
  const upscaled = [];
  for (const s of sources) {
    const p = s.probe;
    const { w, h } = s.rect;
    const factor = s.fit === 'cover' ? Math.max(w / p.width, h / p.height) : Math.min(w / p.width, h / p.height);
    if (factor > 1.5) upscaled.push(`${s.id} ${factor.toFixed(1)}× (${p.width}x${p.height})`);
    if (s.window.adjusted) warnings.push(`${s.id}: previewStart ${s.entry.previewStart}s leaves less than ${config.preview.duration}s of video; using ${s.window.start}s.`);
    if (p.hdr && !toneMapAvailable) warnings.push(`${s.id} is HDR but this ffmpeg lacks zscale/tonemap; colors will look washed out.`);
  }
  if (upscaled.length) {
    const target = layout.grid ? `${formatSize(layout.grid.cell)} cells` : `${layout.masonry.columnWidth}px columns`;
    warnings.push(`${upscaled.length} video(s) are upscaled to fill ${target}: ${upscaled.slice(0, 5).join(', ')}${upscaled.length > 5 ? ', …' : ''}`);
  }
  const looped = sources.filter((s) => s.window.loop).length;

  return {
    sceneDir,
    config,
    sources,
    walls,
    layout,
    pyramid,
    tiles,
    codecs,
    looped,
    warnings,
    probeSeconds,
    estimate: estimateSizes({ config, walls, sources }),
  };
}

/**
 * One arrangement of the videos and its tile pyramid. The first is the main
 * layout, built at the top of the output; alternates go under layouts/<id>/.
 * @typedef {object} Wall
 * @property {string} id
 * @property {string} label
 * @property {import('@videomap/core').ResolvedConfig} config
 * @property {string} prefix  output folder of its tiles and stills ("" for the main layout)
 * @property {import('@videomap/core').WallLayout} layout
 * @property {import('@videomap/core').Pyramid} pyramid
 * @property {Array<Array<[number, number]>>} tiles
 * @property {Array<ReturnType<typeof tileCodec>>} codecs  with `prefix` in their templates
 * @property {Array<'cover'|'contain'>} fits  per video
 */

/** @typedef {Awaited<ReturnType<typeof planBuild>>} BuildPlan */
