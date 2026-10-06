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
  tileChildren,
  tileContents,
} from '@videomap/core';
import { BuildCache, dirSize, exists, isUrl, produce } from './cache.js';
import {
  ENCODER_VERSION,
  HW_ENCODERS,
  clipArgs,
  fullArgs,
  HW_CLIP_PIXELS,
  isWebCompatible,
  masterEncode,
  overviewGraph,
  parentGraph,
  posterArgs,
  stackGraph,
  tileArgs,
  tileEncode,
  worthHwDecode,
} from './encode.js';
import { assertCapabilities, createTools, detectCapabilities } from './ffmpeg.js';
import { chooseEncoder, createEncoderRunner, detectHardware } from './hardware.js';
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
 * @property {boolean} [keepCache]  false deletes cached clips and tile masters after a successful build (default true)
 * @property {string} [ffmpeg]
 * @property {string} [ffprobe]
 * @property {boolean} [dryRun]     plan and estimate only
 * @property {boolean} [force]      allow writing into a non-empty folder vmap didn't create
 * @property {boolean} [rebuild]    ignore cached clips, masters and outputs
 * @property {string|null} [hardwareEncoder]  skip detection and use this HW_ENCODERS entry (null: none)
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

  // Hardware encoding: find a working encoder (cached per ffmpeg build), unless it's off.
  const hardware = { setting: preConfig.build.hardware, detected: /** @type {string[]|null} */ (null), encoder: /** @type {string|null} */ (null), warning: null };
  if (opts.hardwareEncoder !== undefined) {
    hardware.encoder = opts.hardwareEncoder;
  } else if (hardware.setting !== 'off') {
    const found = await detectHardware(tools, caps);
    hardware.detected = found.encoders.filter((e) => e.works).map((e) => e.name);
    ({ encoder: hardware.encoder, warning: hardware.warning } = chooseEncoder(hardware.setting, found));
  }

  const cache = new BuildCache(opts.cacheDir ?? path.join(sceneDir, '.vmap-cache'));
  await cache.load();
  const limit = createLimiter(opts.jobs ?? defaultJobs());
  const toneMap = caps.zscale && caps.tonemap;

  try {
    const plan = await planBuild({ scenePath, scene, overrides: opts.overrides, cache, tools, limit, progress, toneMapAvailable: toneMap });
    plan.warnings.unshift(...sceneWarnings);
    if (hardware.warning) plan.warnings.push(hardware.warning);
    const runner = createEncoderRunner({
      encoder: hardware.encoder,
      sessions: plan.config.build.hardwareJobs,
      limit,
      warn: (msg) => {
        plan.warnings.push(msg);
        progress.log(`! ${msg}`);
      },
      aborted: () => tools.aborted,
    });
    const timings = { probe: plan.probeSeconds, clips: 0, tiles: 0, media: 0, posters: 0, total: 0 };
    if (opts.dryRun) {
      return { dryRun: true, plan, report: report({ plan, outDir, caps, started, counts: null, sizes: null, hardware, runner, timings, cacheCleared: false }) };
    }

    await prepareOutDir(outDir, { force: opts.force, scenePath, sources: plan.sources });
    const ctx = {
      plan,
      cache,
      tools,
      limit,
      runner,
      progress,
      outDir,
      timings,
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
    const keep = opts.keepCache !== false;
    if (!keep) await cache.clearIntermediates();
    const sizes = { ...(await measure(outDir)), cache: await cache.size() };
    timings.total = (Date.now() - started) / 1000;
    return { dryRun: false, plan, report: report({ plan, outDir, caps, started, counts: ctx.counts, sizes, hardware, runner, timings, cacheCleared: !keep }) };
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
  const { plan, cache, tools, runner, progress, outDir, counts, timings } = ctx;
  const { config, pyramid, tiles, codecs } = plan;
  const { fps, frames } = config.preview;
  const bg = config.output.background;
  const hwFinal = config.build.hardwareFinal;

  // 1. Normalized preview clips, one per video, sized to its rectangle on the wall.
  let t0 = Date.now();
  const clipPhase = progress.phase('Clips', plan.sources.length);
  /** @type {Map<number, { key: string, file: string, size: { w: number, h: number } }>} */
  const clips = new Map();
  /** @type {Map<string, Promise<boolean>>} clip key → whether it was cached; videos with the same source and size share a clip */
  const making = new Map();
  await Promise.all(plan.sources.map(async (s) => {
    const hdr = ctx.toneMap && s.probe.hdr;
    const size = { w: s.rect.w, h: s.rect.h };
    // Small clips are cheap for x264 (decoding the source is the real work), so only big ones use the GPU.
    const encoder = size.w * size.h >= HW_CLIP_PIXELS ? runner.current : 'libx264';
    const key = cache.key('clip', ENCODER_VERSION, s.fingerprint, s.window, config.preview.loopShort, fps, frames,
      size, s.fit, s.fit === 'contain' ? bg : null, hdr, encoder);
    const file = cache.file('clips', key, 'mp4');
    const first = !making.has(key);
    if (first) making.set(key, makeClip());
    const cached = (await making.get(key)) || !first;
    clips.set(s.index, { key, file, size });
    counts.clips[cached ? 'cached' : 'run']++;
    clipPhase.tick(cached);

    async function makeClip() {
      if (!ctx.rebuild && (await exists(file))) return true;
      await runner.run(encoder === 'libx264' ? 0 : 1, `clip ${s.id}`, (enc) => produce([file], ([tmp]) => tools.run(clipArgs({
        src: s.src,
        probe: s.probe,
        window: s.window,
        loopShort: config.preview.loopShort,
        fps,
        frames,
        size,
        fit: s.fit,
        background: bg,
        toneMap: ctx.toneMap,
        encode: masterEncode(enc, { fps, size }),
        hwDecode: enc !== 'libx264' && worthHwDecode(s.probe),
      }, tmp))));
      return false;
    }
  }));
  clipPhase.end();
  timings.clips = (Date.now() - t0) / 1000;

  // 2. Tiles, deepest level first; each parent is built from its children's masters.
  t0 = Date.now();
  const contents = tileContents(pyramid, plan.layout.rects);
  /** @type {Map<string, { key: string, file: string }>} */
  const masters = new Map();
  /** @type {Map<string, Promise<void>>} master key → settles when the tile writing it is done */
  const writing = new Map();
  const tilePhase = progress.phase('Tiles', tiles.reduce((n, l) => n + l.length, 0));
  const finalsFor = (encoder) => codecs.map((c) => ({
    ...c,
    encode: tileEncode({ tile: pyramid.tile, fps, crf: config.output.tileCrf, level: c.level, codec: c.codec, encoder: c.codec === 'h264' && hwFinal ? encoder : 'libx264' }),
  }));

  for (let z = pyramid.maxZoom; z >= 0; z--) {
    await Promise.all(tiles[z].map(async ([x, y]) => {
      let inputs;
      let graph;
      let masterKey;
      const encoder = runner.current;
      if (z === pyramid.maxZoom) {
        // Every video piece inside this tile; a video crossing a tile edge is cropped to its part.
        const items = (contents.get(`${x},${y}`) ?? []).map((piece) => {
          const clip = clips.get(piece.video);
          const whole = piece.crop.w === clip.size.w && piece.crop.h === clip.size.h;
          return { clip, x: piece.at.x, y: piece.at.y, crop: whole ? undefined : piece.crop };
        });
        masterKey = cache.key('tile', ENCODER_VERSION, items.map((i) => [i.clip.key, i.x, i.y, i.crop ?? null]), pyramid.tile, bg, fps, frames, encoder);
        inputs = items.map((i) => i.clip.file);
        graph = stackGraph(items, pyramid.tile, bg);
      } else {
        const kids = tileChildren(pyramid, z, x, y).filter((c) => masters.has(`${c.z}/${c.x}/${c.y}`));
        masterKey = cache.key(z === 0 ? 'overview' : 'parent', ENCODER_VERSION, kids.map((c) => [masters.get(`${c.z}/${c.x}/${c.y}`).key, c.dx, c.dy]),
          pyramid.tile, bg, fps, frames, z === 0 ? [pyramid.contentWidth, pyramid.contentHeight] : null, encoder);
        inputs = kids.map((c) => masters.get(`${c.z}/${c.x}/${c.y}`).file);
        graph = z === 0
          ? overviewGraph(kids, pyramid.tile, levelContentSize(pyramid, 1), pyramid.levels[0].scale / pyramid.levels[1].scale, bg)
          : parentGraph(kids, pyramid.tile, bg);
      }

      const needMaster = z > 0; // the top tile has no parent
      const masterFile = cache.file('masters', masterKey, 'mp4');
      masters.set(`${z}/${x}/${y}`, { key: masterKey, file: masterFile });
      // Tiles with identical content (e.g. a repeated source) share a master: the
      // first one writes it, the others wait and encode their finals from it.
      const sharing = needMaster ? writing.get(masterKey) : undefined;
      let release = () => {};
      if (needMaster && !sharing) writing.set(masterKey, new Promise((resolve) => { release = resolve; }));
      try {
        await tileJob();
      } finally {
        release();
      }

      async function tileJob() {
        const planned = finalsFor(encoder);
        const finals = planned.map((f) => ({ codec: f.codec, rel: fillTemplate(f.template, { z, x, y }) }));
        const stillRel = config.output.stills ? fillTemplate(PATHS.still, { z, x, y }) : null;
        const outRels = [...finals.map((f) => f.rel), ...(stillRel ? [stillRel] : [])];
        for (const r of outRels) ctx.produced.add(r);
        const finalKey = cache.key('final', masterKey, planned.map((f) => f.encode), Boolean(stillRel));

        if (sharing) await sharing;
        const masterOk = !needMaster || ((Boolean(sharing) || !ctx.rebuild) && (await exists(masterFile)));
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
        const hwSessions = encoder === 'libx264' ? 0
          : (writeMaster ? 1 : 0) + (hwFinal && codecs.some((c) => c.codec === 'h264') ? 1 : 0);
        const targets = [
          ...(writeMaster ? [masterFile] : []),
          ...finals.map((f) => path.join(outDir, f.rel)),
          ...(stillRel ? [path.join(outDir, stillRel)] : []),
        ];
        await runner.run(hwSessions, `tile ${z}/${x}/${y}`, (enc) => produce(targets, async (temps) => {
          const queue = [...temps];
          const encodes = finalsFor(enc);
          const outs = {
            master: writeMaster ? queue.shift() : undefined,
            masterEncode: masterEncode(enc, { fps, size: pyramid.tile }),
            finals: encodes.map((f) => ({ encode: f.encode, path: queue.shift() })),
            still: stillRel ? queue.shift() : undefined,
          };
          await tools.run(tileArgs({ inputs, graph, fps, frames }, outs));
        }));
        for (const r of outRels) cache.setOutputKey(outDir, r, finalKey);
        counts.tiles.run++;
        tilePhase.tick(false);
      }
    }));
  }
  tilePhase.end();
  timings.tiles = (Date.now() - t0) / 1000;
}

// ---------------------------------------------------------------------------
// Full renditions and posters

async function buildMedia(ctx) {
  const { plan, cache, tools, limit, runner, progress, outDir, counts, timings } = ctx;
  const { config } = plan;
  const full = config.output.full;
  const mediaPhase = full.enabled ? progress.phase('Media', plan.sources.length) : null;
  const posterPhase = progress.phase('Posters', plan.sources.length);
  const t0 = Date.now();
  const done = (phase) => { timings[phase] = Math.max(timings[phase], (Date.now() - t0) / 1000); };

  await Promise.all(plan.sources.map(async (s) => {
    const out = { media: null, poster: null };
    ctx.outputs.set(s.index, out);
    const hdr = ctx.toneMap && s.probe.hdr;

    const jobs = [];
    if (full.enabled) {
      jobs.push((async () => {
        const rel = fillTemplate(PATHS.media, { id: s.id });
        const remux = isWebCompatible(s.probe, full.maxHeight);
        const encoder = remux ? null : runner.current;
        const key = cache.key('full', ENCODER_VERSION, s.fingerprint, full.maxHeight, full.crf, hdr, encoder);
        ctx.produced.add(rel);
        out.media = rel;
        const cached = !ctx.rebuild && (await upToDate(ctx, rel, key));
        if (!cached) {
          await runner.run(!encoder || encoder === 'libx264' ? 0 : 1, `full rendition ${s.id}`, (enc) => produce([path.join(outDir, rel)], ([tmp]) => tools.run(fullArgs({
            src: s.src, probe: s.probe, maxHeight: full.maxHeight, crf: full.crf, toneMap: ctx.toneMap, encoder: enc, hwDecode: enc !== 'libx264' && worthHwDecode(s.probe),
          }, tmp))));
          cache.setOutputKey(outDir, rel, key);
          if (remux) counts.media.copied++;
        }
        counts.media[cached ? 'cached' : 'run']++;
        mediaPhase.tick(cached);
        done('media');
      })());
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
      done('posters');
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
      fit: plan.layout.pack === 'grid' ? s.fit : undefined,
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

/** Delete files in managed folders that this build didn't produce (old tiles, removed videos, media of a now tiles-only build). */
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
  for (const dir of ['tiles', 'stills', 'media', 'posters']) sizes[dir] = await dirSize(path.join(outDir, dir));
  sizes.total = await dirSize(outDir);
  return sizes;
}

function report({ plan, outDir, caps, started, counts, sizes, hardware, runner, timings, cacheCleared }) {
  const { pyramid, layout, tiles, config } = plan;
  const label = (name) => (name && name !== 'libx264' ? HW_ENCODERS[name]?.label ?? name : 'libx264');
  const h264 = hardware.encoder && !runner.disabled ? hardware.encoder : null;
  return {
    outDir,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ffmpeg: caps.version,
    videos: plan.sources.length,
    looped: plan.looped,
    layout: {
      pack: layout.pack,
      width: layout.width,
      height: layout.height,
      groups: layout.groups.length,
      ...(layout.grid ? { cols: layout.grid.cols, rows: layout.grid.rows, cell: layout.grid.cell } : {}),
      ...(layout.masonry ? {
        columns: layout.masonry.columns,
        columnWidth: layout.masonry.columnWidth,
        gap: layout.masonry.gap,
        groupArrange: layout.masonry.groupArrange,
        splits: layout.masonry.splits.length,
      } : {}),
    },
    tile: pyramid.tile,
    content: { width: pyramid.contentWidth, height: pyramid.contentHeight },
    preview: { duration: config.preview.duration, fps: config.preview.fps },
    levels: pyramid.levels.map((l) => ({ z: l.z, tilesX: l.tilesX, tilesY: l.tilesY, tiles: tiles[l.z].length })),
    codecs: plan.codecs.map((c) => c.mime),
    encoder: {
      setting: hardware.setting,
      detected: hardware.detected,
      // What encoded H.264 this build (final tiles stay on libx264 unless hardwareFinal is on).
      h264: label(h264),
      finalTiles: label(h264 && config.build.hardwareFinal ? h264 : null),
      hardwareJobs: runner.jobs,
      fallbacks: runner.fallbacks,
      disabled: runner.disabled,
    },
    full: config.output.full.enabled,
    jobs: counts,
    timings: roundAll(timings),
    sizes,
    cacheCleared,
    estimate: plan.estimate,
    warnings: plan.warnings,
  };
}

/** @typedef {ReturnType<typeof report>} BuildReport */

function roundAll(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * 10) / 10]));
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
