// Executes a build plan: normalized clips → deepest tiles → parent levels,
// full renditions and posters in parallel, then the runtime manifest.

import { copyFile, cp, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PATHS,
  SCENE_FORMAT,
  createRuntimeManifest,
  fillTemplate,
  levelContentSize,
  resolveConfig,
  tileCellRange,
  tileChildren,
} from '@videomap/core';
import { BuildCache, exists, isUrl, produce } from './cache.js';
import {
  ENCODER_VERSION,
  clipArgs,
  fullArgs,
  isWebCompatible,
  overviewGraph,
  parentGraph,
  posterArgs,
  stackGraph,
  tileArgs,
  tileEncode,
} from './encode.js';
import { assertCapabilities, createTools, detectCapabilities } from './ffmpeg.js';
import { loadScene, planBuild } from './plan.js';
import { createLimiter, createProgress } from './progress.js';

const MANAGED_DIRS = ['tiles', 'stills', 'media', 'posters', 'assets'];
const FALLBACK_VIEWER = new URL('../assets/fallback-viewer.html', import.meta.url);

/**
 * The built WebGL viewer (packages/viewer/dist), or null if it hasn't been built.
 * @returns {Promise<string|null>}
 */
export async function viewerDist() {
  try {
    const pkg = fileURLToPath(import.meta.resolve('@videomap/viewer/package.json'));
    const dist = path.join(path.dirname(pkg), 'dist');
    return (await exists(path.join(dist, 'index.html'))) ? dist : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} BuildOptions
 * @property {string} scenePath
 * @property {string} [outDir]      default: "dist" next to the scene file
 * @property {any} [overrides]      settings that win over the scene's (same shape)
 * @property {number} [jobs]        parallel ffmpeg processes
 * @property {string} [cacheDir]    default: ".vmap-cache" next to the scene file
 * @property {string} [ffmpeg]
 * @property {string} [ffprobe]
 * @property {boolean} [dryRun]     plan and estimate only
 * @property {boolean} [force]      allow writing into a non-empty folder vmap didn't create
 * @property {boolean} [rebuild]    ignore cached clips, masters and outputs
 * @property {import('./progress.js').Progress} [progress]
 */

export function defaultJobs() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.ceil(cpus / 2));
}

/** @param {BuildOptions} opts */
export async function buildScene(opts) {
  const started = Date.now();
  const progress = opts.progress ?? createProgress({ mode: 'silent' });
  const scenePath = path.resolve(opts.scenePath);
  const sceneDir = path.dirname(scenePath);
  const outDir = path.resolve(opts.outDir ?? path.join(sceneDir, 'dist'));

  const { scene, warnings: sceneWarnings } = await loadScene(scenePath);
  const preConfig = resolveConfig(scene, opts.overrides);
  const tools = createTools({ ffmpeg: opts.ffmpeg, ffprobe: opts.ffprobe });
  const caps = await detectCapabilities(tools);
  assertCapabilities(caps, { stills: preConfig.output.stills, full: preConfig.output.full.enabled, vp9: preConfig.output.tileCodecs.includes('vp9') });

  const cache = new BuildCache(opts.cacheDir ?? path.join(sceneDir, '.vmap-cache'));
  await cache.load();
  const limit = createLimiter(opts.jobs ?? defaultJobs());
  const toneMap = caps.zscale && caps.tonemap;

  try {
    const plan = await planBuild({ scenePath, scene, overrides: opts.overrides, cache, tools, limit, progress, toneMapAvailable: toneMap });
    plan.warnings.unshift(...sceneWarnings);
    if (opts.dryRun) {
      return { dryRun: true, plan, report: report({ plan, outDir, caps, started, counts: null, sizes: null }) };
    }

    await prepareOutDir(outDir, { force: opts.force, scenePath, sources: plan.sources });
    const ctx = {
      plan,
      cache,
      tools,
      limit,
      progress,
      outDir,
      rebuild: Boolean(opts.rebuild),
      toneMap,
      webp: caps.libwebp,
      produced: new Set(['index.html', 'scene.json']),
      counts: {
        clips: { run: 0, cached: 0 },
        tiles: { run: 0, cached: 0 },
        media: { run: 0, cached: 0, copied: 0 },
        posters: { run: 0, cached: 0 },
      },
      /** @type {Map<number, { media: string|null, poster: string|null }>} */
      outputs: new Map(),
    };

    await Promise.all([buildTiles(ctx), buildMedia(ctx)]);
    await writeManifest(ctx, scene);
    const viewer = await installViewer(outDir, ctx.produced);
    if (!viewer) plan.warnings.push('The WebGL viewer is not built, so a basic debug viewer was used. Run "npm run build:viewer" and build again.');
    await removeStale(outDir, ctx.produced);
    cache.pruneOutputs(outDir, ctx.produced);
    const sizes = await measure(outDir);
    return { dryRun: false, plan, report: report({ plan, outDir, caps, started, counts: ctx.counts, sizes }) };
  } catch (err) {
    tools.abort();
    throw err;
  } finally {
    progress.close();
    await cache.save();
  }
}

// ---------------------------------------------------------------------------
// Tiles

async function buildTiles(ctx) {
  const { plan, cache, tools, limit, progress, outDir, counts } = ctx;
  const { config, pyramid, tiles, layout, codecs } = plan;
  const { fps, frames } = config.preview;
  const bg = config.output.background;

  // 1. Normalized preview clips, one per video.
  const clipPhase = progress.phase('Clips', plan.sources.length);
  /** @type {Map<number, { key: string, file: string }>} */
  const clips = new Map();
  await Promise.all(plan.sources.map((s) => limit(async () => {
    const hdr = ctx.toneMap && s.probe.hdr;
    const key = cache.key('clip', ENCODER_VERSION, s.fingerprint, s.window, config.preview.loopShort, fps, frames,
      pyramid.cell, config.layout.fit, config.layout.fit === 'contain' ? bg : null, hdr);
    const file = cache.file('clips', key, 'mp4');
    const cached = !ctx.rebuild && (await exists(file));
    if (!cached) {
      await produce([file], ([tmp]) => tools.run(clipArgs({
        src: s.src,
        probe: s.probe,
        window: s.window,
        loopShort: config.preview.loopShort,
        fps,
        frames,
        cell: pyramid.cell,
        fit: config.layout.fit,
        background: bg,
        toneMap: ctx.toneMap,
      }, tmp)));
    }
    clips.set(s.index, { key, file });
    counts.clips[cached ? 'cached' : 'run']++;
    clipPhase.tick(cached);
  })));
  clipPhase.end();

  // 2. Tiles, deepest level first; each parent is built from its children's masters.
  const cellVideo = new Map(layout.cells.map((c) => [`${c.col},${c.row}`, c.video]));
  const finalEncodes = codecs.map((c) => ({ ...c, encode: tileEncode({ tile: pyramid.tile, fps, crf: config.output.tileCrf, level: c.level, codec: c.codec }) }));
  /** @type {Map<string, { key: string, file: string }>} */
  const masters = new Map();
  const tilePhase = progress.phase('Tiles', tiles.reduce((n, l) => n + l.length, 0));

  for (let z = pyramid.maxZoom; z >= 0; z--) {
    await Promise.all(tiles[z].map(([x, y]) => limit(async () => {
      let inputs;
      let graph;
      let masterKey;
      if (z === pyramid.maxZoom) {
        const r = tileCellRange(pyramid, z, x, y);
        const items = [];
        for (let row = r.row0; row < r.row1; row++) {
          for (let col = r.col0; col < r.col1; col++) {
            const v = cellVideo.get(`${col},${row}`);
            if (v !== undefined) items.push({ clip: clips.get(v), x: (col - r.col0) * pyramid.cell.w, y: (row - r.row0) * pyramid.cell.h });
          }
        }
        masterKey = cache.key('tile', ENCODER_VERSION, items.map((i) => [i.clip.key, i.x, i.y]), pyramid.tile, bg, fps, frames);
        inputs = items.map((i) => i.clip.file);
        graph = stackGraph(items, pyramid.tile, bg);
      } else {
        const kids = tileChildren(pyramid, z, x, y).filter((c) => masters.has(`${c.z}/${c.x}/${c.y}`));
        masterKey = cache.key(z === 0 ? 'overview' : 'parent', ENCODER_VERSION, kids.map((c) => [masters.get(`${c.z}/${c.x}/${c.y}`).key, c.dx, c.dy]),
          pyramid.tile, bg, fps, frames, z === 0 ? [pyramid.contentWidth, pyramid.contentHeight] : null);
        inputs = kids.map((c) => masters.get(`${c.z}/${c.x}/${c.y}`).file);
        graph = z === 0
          ? overviewGraph(kids, pyramid.tile, levelContentSize(pyramid, 1), pyramid.levels[0].scale / pyramid.levels[1].scale, bg)
          : parentGraph(kids, pyramid.tile, bg);
      }

      const needMaster = z > 0; // the top tile has no parent
      const masterFile = cache.file('masters', masterKey, 'mp4');
      masters.set(`${z}/${x}/${y}`, { key: masterKey, file: masterFile });

      const finals = finalEncodes.map((f) => ({ encode: f.encode, rel: fillTemplate(f.template, { z, x, y }) }));
      const stillRel = config.output.stills ? fillTemplate(PATHS.still, { z, x, y }) : null;
      const outRels = [...finals.map((f) => f.rel), ...(stillRel ? [stillRel] : [])];
      for (const r of outRels) ctx.produced.add(r);
      const finalKey = cache.key('final', masterKey, finalEncodes.map((f) => f.encode), Boolean(stillRel));

      const masterOk = !needMaster || (!ctx.rebuild && (await exists(masterFile)));
      let finalOk = !ctx.rebuild;
      for (const r of outRels) finalOk = finalOk && (await upToDate(ctx, r, finalKey));
      if (masterOk && finalOk) {
        counts.tiles.cached++;
        tilePhase.tick(true);
        return;
      }
      if (needMaster && masterOk) {
        // Only the final encode is stale (e.g. a different CRF): re-encode from the master.
        inputs = [masterFile];
        graph = '[0:v]null[t]';
      }

      const writeMaster = needMaster && !masterOk;
      const targets = [
        ...(writeMaster ? [masterFile] : []),
        ...finals.map((f) => path.join(outDir, f.rel)),
        ...(stillRel ? [path.join(outDir, stillRel)] : []),
      ];
      await produce(targets, async (temps) => {
        const queue = [...temps];
        const outs = {
          master: writeMaster ? queue.shift() : undefined,
          finals: finals.map((f) => ({ encode: f.encode, path: queue.shift() })),
          still: stillRel ? queue.shift() : undefined,
        };
        await tools.run(tileArgs({ inputs, graph, fps, frames }, outs));
      });
      for (const r of outRels) cache.setOutputKey(outDir, r, finalKey);
      counts.tiles.run++;
      tilePhase.tick(false);
    })));
  }
  tilePhase.end();
}

// ---------------------------------------------------------------------------
// Full renditions and posters

async function buildMedia(ctx) {
  const { plan, cache, tools, limit, progress, outDir, counts } = ctx;
  const { config } = plan;
  const full = config.output.full;
  const mediaPhase = full.enabled ? progress.phase('Media', plan.sources.length) : null;
  const posterPhase = progress.phase('Posters', plan.sources.length);

  await Promise.all(plan.sources.map(async (s) => {
    const out = { media: null, poster: null };
    ctx.outputs.set(s.index, out);
    const hdr = ctx.toneMap && s.probe.hdr;

    const jobs = [];
    if (full.enabled) {
      jobs.push(limit(async () => {
        const rel = fillTemplate(PATHS.media, { id: s.id });
        const key = cache.key('full', ENCODER_VERSION, s.fingerprint, full.maxHeight, full.crf, hdr);
        ctx.produced.add(rel);
        out.media = rel;
        const cached = !ctx.rebuild && (await upToDate(ctx, rel, key));
        if (!cached) {
          await produce([path.join(outDir, rel)], ([tmp]) => tools.run(fullArgs({ src: s.src, probe: s.probe, maxHeight: full.maxHeight, crf: full.crf, toneMap: ctx.toneMap }, tmp)));
          cache.setOutputKey(outDir, rel, key);
          if (isWebCompatible(s.probe, full.maxHeight)) counts.media.copied++;
        }
        counts.media[cached ? 'cached' : 'run']++;
        mediaPhase.tick(cached);
      }));
    }

    jobs.push(limit(async () => {
      const ext = ctx.webp ? 'webp' : 'jpg';
      const rel = fillTemplate(PATHS.poster.replace(/\.webp$/, `.${ext}`), { id: s.id });
      const src = s.posterSrc ?? s.src;
      const time = s.posterSrc ? 0 : Math.round((s.window.start + Math.min(1, s.probe.duration / 2)) * 1000) / 1000;
      const key = cache.key('poster', ENCODER_VERSION, s.posterSrc ? await cache.fingerprint(s.posterSrc) : s.fingerprint, time, ext, hdr);
      ctx.produced.add(rel);
      out.poster = rel;
      const cached = !ctx.rebuild && (await upToDate(ctx, rel, key));
      if (!cached) {
        await produce([path.join(outDir, rel)], ([tmp]) => tools.run(posterArgs({ src, probe: s.posterSrc ? null : s.probe, time, webp: ctx.webp, toneMap: ctx.toneMap }, tmp)));
        cache.setOutputKey(outDir, rel, key);
      }
      counts.posters[cached ? 'cached' : 'run']++;
      posterPhase.tick(cached);
    }));

    await Promise.all(jobs);
  }));
  mediaPhase?.end();
  posterPhase.end();
}

async function upToDate(ctx, rel, key) {
  return ctx.cache.outputKey(ctx.outDir, rel) === key && exists(path.join(ctx.outDir, rel));
}

// ---------------------------------------------------------------------------
// Manifest, viewer and output folder housekeeping

async function writeManifest(ctx, scene) {
  const { plan, outDir } = ctx;
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const videos = plan.sources.map((s) => {
    const p = s.probe;
    const out = ctx.outputs.get(s.index);
    return compact({
      id: s.id,
      title: s.entry.title ?? s.id,
      description: s.entry.description,
      categories: s.entry.categories ?? [],
      tags: s.entry.tags ?? [],
      credits: s.entry.credits,
      links: s.entry.links,
      meta: s.entry.meta,
      duration: Math.round(p.duration * 1000) / 1000,
      width: p.width,
      height: p.height,
      hasAudio: Boolean(p.audioCodec),
      previewStart: s.window.start,
      looped: s.window.loop,
      media: out?.media ?? null,
      poster: out?.poster ?? null,
    });
  });
  const manifest = createRuntimeManifest({
    config: plan.config,
    pyramid: plan.pyramid,
    layout: plan.layout,
    videos,
    tiles: plan.tiles,
    tileSources: plan.codecs.map((c) => ({ template: c.template, mime: c.mime })),
    categories: scene.categories ?? [],
    generator: { name: 'videomap', version: pkg.version },
  });
  await writeFile(path.join(outDir, 'scene.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Copy the viewer (index.html + hashed assets) into the output. @returns {Promise<boolean>} whether the WebGL viewer was used */
async function installViewer(outDir, produced) {
  const dist = await viewerDist();
  if (!dist) {
    await copyFile(FALLBACK_VIEWER, path.join(outDir, 'index.html'));
    return false;
  }
  await copyFile(path.join(dist, 'index.html'), path.join(outDir, 'index.html'));
  const assets = path.join(dist, 'assets');
  if (await exists(assets)) {
    await cp(assets, path.join(outDir, 'assets'), { recursive: true });
    for (const f of await walk(assets)) produced.add(`assets/${path.relative(assets, f).split(path.sep).join('/')}`);
  }
  return true;
}

/** Refuse to write somewhere a build could clobber sources or unrelated files. */
async function prepareOutDir(outDir, { force, scenePath, sources }) {
  const sceneDir = path.dirname(scenePath);
  if (isInside(sceneDir, outDir)) {
    throw new Error(`The output folder ${outDir} contains the scene file; choose a separate folder with --out (e.g. ${path.join(sceneDir, 'dist')}).`);
  }
  for (const s of sources) {
    for (const p of [s.src, s.posterSrc]) {
      if (p && !isUrl(p) && isInside(p, outDir)) {
        throw new Error(`Source ${p} is inside the output folder ${outDir}; keep sources outside it.`);
      }
    }
  }
  let entries = [];
  try {
    entries = await readdir(outDir);
  } catch {
    // doesn't exist yet
  }
  if (entries.length && !force) {
    let marker = null;
    try {
      marker = JSON.parse(await readFile(path.join(outDir, 'scene.json'), 'utf8'));
    } catch {
      // not a previous build
    }
    if (marker?.format !== SCENE_FORMAT) {
      throw new Error(`${outDir} is not empty and wasn't created by vmap. Choose an empty folder or pass --force.`);
    }
  }
  await mkdir(outDir, { recursive: true });
}

/** Delete files in managed folders that this build didn't produce (old tiles, removed videos, partial files). */
async function removeStale(outDir, produced) {
  for (const dir of MANAGED_DIRS) {
    const root = path.join(outDir, dir);
    for (const file of await walk(root)) {
      const rel = path.relative(outDir, file).split(path.sep).join('/');
      if (!produced.has(rel)) await rm(file, { force: true });
    }
    await pruneEmptyDirs(root);
  }
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function pruneEmptyDirs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name));
  if ((await readdir(dir)).length === 0) await rmdir(dir);
}

async function measure(outDir) {
  const sizes = { tiles: 0, stills: 0, media: 0, posters: 0, total: 0 };
  for (const dir of MANAGED_DIRS) {
    for (const file of await walk(path.join(outDir, dir))) sizes[dir] += (await stat(file)).size;
  }
  for (const f of ['index.html', 'scene.json']) sizes.total += (await stat(path.join(outDir, f))).size;
  sizes.total += sizes.tiles + sizes.stills + sizes.media + sizes.posters;
  return sizes;
}

function report({ plan, outDir, caps, started, counts, sizes }) {
  const { pyramid, layout, tiles, config } = plan;
  return {
    outDir,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ffmpeg: caps.version,
    videos: plan.sources.length,
    looped: plan.looped,
    grid: { cols: layout.cols, rows: layout.rows, groups: layout.groups.length },
    cell: pyramid.cell,
    tile: pyramid.tile,
    content: { width: pyramid.contentWidth, height: pyramid.contentHeight },
    preview: { duration: config.preview.duration, fps: config.preview.fps },
    levels: pyramid.levels.map((l) => ({ z: l.z, tilesX: l.tilesX, tilesY: l.tilesY, tiles: tiles[l.z].length })),
    codecs: plan.codecs.map((c) => c.mime),
    jobs: counts,
    sizes,
    estimate: plan.estimate,
    warnings: plan.warnings,
  };
}

/** @typedef {ReturnType<typeof report>} BuildReport */

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
