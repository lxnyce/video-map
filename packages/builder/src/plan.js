// Planning: everything up to (but not including) encoding. `vmap build --dry-run`
// stops here and prints the plan and size estimate.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  computeLayout,
  createPyramid,
  formatSize,
  occupiedTiles,
  resolveCellAndTile,
  resolveConfig,
  tileCodec,
} from '@videomap/core';
import { assignIds, validateScene } from '@videomap/core/validate';
import { exists, isUrl } from './cache.js';
import { isWebCompatible, previewWindow } from './encode.js';
import { probe } from './probe.js';

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
  const config = resolveConfig(scene, overrides);
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

  // Layout and pyramid.
  const gridAspect = config.output.canvas ? config.output.canvas.w / config.output.canvas.h : config.layout.aspect;
  const layout = computeLayout(
    sources.map((s) => ({
      id: s.id,
      title: s.entry.title ?? s.id,
      src: s.entry.src,
      categories: s.entry.categories,
      tags: s.entry.tags,
      meta: s.entry.meta,
      duration: s.probe.duration,
    })),
    {
      groupBy: config.layout.groupBy,
      sortBy: config.layout.sortBy,
      groupGap: config.layout.groupGap,
      aspect: gridAspect / config.layout.cellAspect,
      categories: scene.categories ?? [],
    },
  );
  const dims = resolveCellAndTile(layout, { ...config.output, cellAspect: config.layout.cellAspect });
  warnings.push(...dims.warnings);
  const pyramid = createPyramid({ cols: layout.cols, rows: layout.rows, cell: dims.cell, k: dims.k });
  const tiles = occupiedTiles(pyramid, layout.cells);
  const codecs = config.output.tileCodecs.map((c) => tileCodec(c, pyramid.tile.w, pyramid.tile.h, config.preview.fps));

  // Source warnings.
  const upscaled = [];
  for (const s of sources) {
    const p = s.probe;
    const factor = config.layout.fit === 'cover'
      ? Math.max(dims.cell.w / p.width, dims.cell.h / p.height)
      : Math.min(dims.cell.w / p.width, dims.cell.h / p.height);
    if (factor > 1.5) upscaled.push(`${s.id} ${factor.toFixed(1)}× (${p.width}x${p.height})`);
    if (s.window.adjusted) warnings.push(`${s.id}: previewStart ${s.entry.previewStart}s leaves less than ${config.preview.duration}s of video; using ${s.window.start}s.`);
    if (p.hdr && !toneMapAvailable) warnings.push(`${s.id} is HDR but this ffmpeg lacks zscale/tonemap; colors will look washed out.`);
  }
  if (upscaled.length) {
    warnings.push(`${upscaled.length} video(s) are upscaled to fill ${formatSize(dims.cell)} cells: ${upscaled.slice(0, 5).join(', ')}${upscaled.length > 5 ? ', …' : ''}`);
  }
  const looped = sources.filter((s) => s.window.loop).length;

  return {
    sceneDir,
    config,
    sources,
    layout,
    pyramid,
    tiles,
    codecs,
    looped,
    warnings,
    estimate: estimateSizes({ config, pyramid, tiles, sources }),
  };
}

/** @typedef {Awaited<ReturnType<typeof planBuild>>} BuildPlan */

/**
 * Rough output size, printed before encoding. Tiles typically land at ~70% of
 * their bitrate cap; full renditions are copied when already web-friendly.
 */
export function estimateSizes({ config, pyramid, tiles, sources }) {
  const tileCount = tiles.reduce((n, level) => n + level.length, 0);
  const { w, h } = pyramid.tile;
  const { fps, duration } = config.preview;
  const tileBytes = tileCount * ((w * h * fps * 0.12) / 8) * duration * 0.7;
  const stillBytes = config.output.stills ? tileCount * w * h * 0.09 : 0;
  let mediaBytes = 0;
  if (config.output.full.enabled) {
    for (const s of sources) {
      const p = s.probe;
      const scale = Math.min(1, config.output.full.maxHeight / p.height);
      const bps = isWebCompatible(p, config.output.full.maxHeight)
        ? p.width * p.height * Math.min(p.fps, 60) * 0.1
        : p.width * scale * p.height * scale * Math.min(p.fps, 30) * 0.065;
      mediaBytes += (bps / 8) * p.duration + (p.audioCodec ? 16000 * p.duration : 0);
    }
  }
  const posterBytes = sources.length * 40_000;
  return {
    tileCount,
    tiles: Math.round(tileBytes),
    stills: Math.round(stillBytes),
    media: Math.round(mediaBytes),
    posters: posterBytes,
    total: Math.round(tileBytes + stillBytes + mediaBytes + posterBytes),
  };
}
