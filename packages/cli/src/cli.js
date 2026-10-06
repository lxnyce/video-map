#!/usr/bin/env node
// vmap: build, validate and preview VideoMap scenes.

import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SCENE_FORMAT, formatSize, resolveConfig } from '@videomap/core';
import {
  HW_ORDER,
  SceneError,
  buildScene,
  cleanCache,
  createProgress,
  createTools,
  defaultJobs,
  detectCapabilities,
  detectHardware,
  loadScene,
} from '@videomap/builder';
import { scaffoldScene } from './init.js';
import { startServer } from './server.js';

const EXIT = { ok: 0, failed: 1, usage: 2 };

const HELP = `vmap: play hundreds of videos at once from a static folder

Usage
  vmap init [dir]               Create scene.json from a folder of videos
  vmap validate <scene.json>    Check a scene file (add --probe to read every video)
  vmap build <scene.json>       Build the hostable output folder
  vmap preview [dist]           Serve an output folder locally (and on your LAN)
  vmap info [dist]              Summarize an output folder
  vmap doctor                   Check ffmpeg, its features and hardware encoders
  vmap clean [scene.json]       Delete the build cache

Run "vmap <command> --help" for options.`;

const COMMAND_HELP = {
  init: `vmap init [dir] [options]

Scans dir (default: current folder) for videos and writes dir/scene.json.
Videos in sub-folders get the folder name as their category.

  -o, --out <file>     Scene file to write (default: <dir>/scene.json)
      --title <text>   Scene title
      --force          Overwrite an existing scene file`,
  validate: `vmap validate <scene.json> [options]

  --probe              Also read every video with ffprobe and report layout warnings
  --json               Print the result as JSON
  --ffprobe <path>     ffprobe binary (default: ffprobe on PATH or $FFPROBE)
  --ffmpeg <path>      ffmpeg binary (default: ffmpeg on PATH or $FFMPEG)`,
  build: `vmap build <scene.json> [options]

Output
  -o, --out <dir>             Output folder (default: dist next to the scene)
      --canvas <WxH>          Full-resolution wall size, e.g. 7680x4320
      --cell <WxH>            Size of one video at full zoom (alternative to --canvas)
      --tile <WxH>            Target tile video size (default 768x432)
      --tile-crf <n>          Tile quality, lower is better (default 28)
      --tile-codecs <list>    Tile codecs in order of preference: h264 (default), vp9
      --surface <type>        plane | cylinder | sphere
      --no-stills             Skip the still-image pyramid
      --no-full               Tiles only: skip full renditions (the viewer shows an info card)
      --full-max-height <px>  Max height of full renditions (default 1080)

Preview loop
      --preview-duration <s>  Loop length in seconds (default 10)
      --fps <n>               Tile frame rate (default 24)

Layout
      --pack <strategy>       grid (default) | masonry
      --group-by <spec>       none | category | tag:<prefix> | meta.<key>
      --fit <mode>            Grid: contain (default, whole frame) | cover (crop to fill)
      --column-width <px>     Masonry: column width at full zoom (default 384)
      --gap <px>              Masonry: gutter between videos (default 0)
      --group-arrange <mode>  Masonry: columns (groups side by side, default) | bands

Build
  -j, --jobs <n>              Parallel ffmpeg processes (default ${defaultJobs()})
      --hw <encoder>          auto (default) | off | nvenc | qsv | amf | videotoolbox | vaapi
      --hw-jobs <n>           Concurrent hardware encode sessions (default 3)
      --hw-final              Also encode the final tiles on the hardware encoder (default: libx264)
      --cache <dir>           Cache folder (default: .vmap-cache next to the scene)
      --no-keep-cache         Delete cached clips and tile masters after a successful build
      --rebuild               Ignore the cache and re-encode everything
      --dry-run               Print the plan and size estimate without encoding
      --force                 Allow a non-empty output folder vmap didn't create
      --json                  Print the build report as JSON
      --ffmpeg <path>         ffmpeg binary
      --ffprobe <path>        ffprobe binary`,
  preview: `vmap preview [dist] [options]

  -p, --port <n>       Port (default 8080; 0 picks a free one)
      --host <addr>    Interface to listen on (default 0.0.0.0, i.e. also your LAN)
      --open           Open the browser`,
  info: `vmap info [dist] [--json]`,
  doctor: `vmap doctor [--ffmpeg <path>] [--ffprobe <path>]

Checks ffmpeg's encoders and filters, and test-encodes with each hardware
H.264 encoder (the result is cached for builds).`,
  clean: `vmap clean [scene.json] [--cache <dir>]

Deletes the build cache (.vmap-cache next to the scene, or --cache). The next
build re-encodes clips and tiles from the sources.`,
};

// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');

class UsageError extends Error {}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP);
    return EXIT.ok;
  }
  if (command === '-v' || command === '--version') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return EXIT.ok;
  }
  const run = { init, validate, build, preview, info, doctor, clean }[command];
  if (!run) throw new UsageError(`Unknown command "${command}". Run "vmap --help".`);
  if (rest.includes('-h') || rest.includes('--help')) {
    console.log(COMMAND_HELP[command]);
    return EXIT.ok;
  }
  return run(rest);
}

/**
 * @param {string[]} args
 * @param {import('node:util').ParseArgsConfig['options']} options
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
function parse(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
}

// ---------------------------------------------------------------------------
// init

async function init(args) {
  const { values, positionals } = parse(args, {
    out: { type: 'string', short: 'o' },
    title: { type: 'string' },
    force: { type: 'boolean' },
  });
  const dir = path.resolve(positionals[0] ?? '.');
  const out = path.resolve(values.out ?? path.join(dir, 'scene.json'));
  if (!values.force && (await stat(out).catch(() => null))) {
    throw new UsageError(`${out} already exists. Pass --force to overwrite it.`);
  }
  const scene = await scaffoldScene(dir, path.dirname(out), { title: values.title });
  if (!scene.videos.length) {
    console.error(red(`No videos found in ${dir}.`));
    return EXIT.failed;
  }
  await writeFile(out, `${JSON.stringify(scene, null, 2)}\n`);
  const cats = scene.categories?.length ?? 0;
  console.log(`${green('✔')} Wrote ${rel(out)} with ${scene.videos.length} video(s)${cats ? ` in ${cats} categories` : ''}.`);
  console.log(dim(`Next: add titles, descriptions and tags, then run "vmap build ${rel(out)}".`));
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// validate

async function validate(args) {
  const { values, positionals } = parse(args, {
    probe: { type: 'boolean' },
    json: { type: 'boolean' },
    ffmpeg: { type: 'string' },
    ffprobe: { type: 'string' },
  });
  const scenePath = requireScene(positionals);
  const result = { valid: true, errors: [], warnings: [] };

  try {
    const { scene, warnings } = await loadScene(scenePath);
    result.warnings.push(...warnings);
    resolveConfig(scene);
    if (values.probe) {
      const { report } = await buildScene({ scenePath, dryRun: true, ffmpeg: values.ffmpeg, ffprobe: values.ffprobe });
      result.warnings = report.warnings;
    } else {
      const dir = path.dirname(path.resolve(scenePath));
      for (const [i, v] of scene.videos.entries()) {
        for (const field of ['src', 'poster']) {
          const p = v[field];
          if (p && !/^https?:\/\//i.test(p) && !(await stat(path.resolve(dir, p)).catch(() => null))) {
            result.errors.push(`videos[${i}].${field}: file not found: ${p}`);
          }
        }
      }
    }
  } catch (err) {
    // Schema problems, bad sizes in settings and unreadable videos all count as an invalid scene.
    result.errors.push(...(err.issues?.length ? err.issues.map((i) => `${i.path}: ${i.message}`) : [err.message]));
  }
  result.valid = result.errors.length === 0;

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const e of result.errors) console.log(`${red('✖')} ${e}`);
    for (const w of result.warnings) console.log(`${yellow('!')} ${w}`);
    if (result.valid) console.log(`${green('✔')} ${rel(scenePath)} is valid${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ''}.`);
  }
  return result.valid ? EXIT.ok : EXIT.usage;
}

// ---------------------------------------------------------------------------
// build

async function build(args) {
  const { values, positionals } = parse(args, {
    out: { type: 'string', short: 'o' },
    canvas: { type: 'string' },
    cell: { type: 'string' },
    tile: { type: 'string' },
    'tile-crf': { type: 'string' },
    'tile-codecs': { type: 'string' },
    surface: { type: 'string' },
    'no-stills': { type: 'boolean' },
    'no-full': { type: 'boolean' },
    'full-max-height': { type: 'string' },
    'preview-duration': { type: 'string' },
    fps: { type: 'string' },
    pack: { type: 'string' },
    'group-by': { type: 'string' },
    fit: { type: 'string' },
    'column-width': { type: 'string' },
    gap: { type: 'string' },
    'group-arrange': { type: 'string' },
    jobs: { type: 'string', short: 'j' },
    hw: { type: 'string' },
    'hw-jobs': { type: 'string' },
    'hw-final': { type: 'boolean' },
    cache: { type: 'string' },
    'no-keep-cache': { type: 'boolean' },
    rebuild: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    json: { type: 'boolean' },
    ffmpeg: { type: 'string' },
    ffprobe: { type: 'string' },
  });
  const scenePath = requireScene(positionals);
  if (values.canvas && values.cell) throw new UsageError('Use either --canvas or --cell, not both.');
  if (values.surface && !['plane', 'cylinder', 'sphere'].includes(values.surface)) throw new UsageError('--surface must be plane, cylinder or sphere.');
  if (values.fit && !['cover', 'contain'].includes(values.fit)) throw new UsageError('--fit must be cover or contain.');
  if (values.pack && !['grid', 'masonry'].includes(values.pack)) throw new UsageError('--pack must be grid or masonry.');
  if (values['group-arrange'] && !['columns', 'bands'].includes(values['group-arrange'])) throw new UsageError('--group-arrange must be columns or bands.');
  if (values.hw && !['auto', 'off', ...HW_ORDER].includes(values.hw)) throw new UsageError(`--hw must be auto, off, ${HW_ORDER.join(', ')}.`);
  const tileCodecs = values['tile-codecs']?.split(',').map((c) => c.trim().toLowerCase());
  if (tileCodecs && (!tileCodecs.length || tileCodecs.some((c) => !['h264', 'vp9'].includes(c)) || new Set(tileCodecs).size !== tileCodecs.length)) {
    throw new UsageError('--tile-codecs must be a comma-separated list of h264 and/or vp9, e.g. h264,vp9.');
  }

  const overrides = {
    surface: { type: values.surface },
    preview: {
      duration: num(values['preview-duration'], '--preview-duration', { min: 0.1, max: 300 }),
      fps: num(values.fps, '--fps', { min: 1, max: 60, int: true }),
    },
    layout: {
      pack: values.pack,
      groupBy: values['group-by'],
      fit: values.fit,
      columnWidth: num(values['column-width'], '--column-width', { min: 32, max: 2048, int: true }),
      gap: num(values.gap, '--gap', { min: 0, max: 256, int: true }),
      groupArrange: values['group-arrange'],
    },
    output: {
      canvas: values.canvas,
      cell: values.cell,
      tile: values.tile,
      tileCrf: num(values['tile-crf'], '--tile-crf', { min: 10, max: 51, int: true }),
      tileCodecs,
      stills: values['no-stills'] ? false : undefined,
      full: {
        enabled: values['no-full'] ? false : undefined,
        maxHeight: num(values['full-max-height'], '--full-max-height', { min: 144, max: 4320, int: true }),
      },
    },
    build: {
      hardware: values.hw,
      hardwareFinal: values['hw-final'] ? true : undefined,
      hardwareJobs: num(values['hw-jobs'], '--hw-jobs', { min: 1, max: 32, int: true }),
    },
  };

  const progress = createProgress({ mode: values.json ? 'silent' : 'auto' });
  let result;
  try {
    result = await buildScene({
      scenePath,
      outDir: values.out,
      overrides,
      jobs: num(values.jobs, '--jobs', { min: 1, max: 256, int: true }),
      cacheDir: values.cache,
      keepCache: !values['no-keep-cache'],
      ffmpeg: values.ffmpeg,
      ffprobe: values.ffprobe,
      dryRun: values['dry-run'],
      force: values.force,
      rebuild: values.rebuild,
      progress,
    });
  } catch (err) {
    if (err instanceof SceneError) {
      if (values.json) {
        console.log(JSON.stringify({ ok: false, error: err.message, issues: err.issues }, null, 2));
      } else {
        console.error(red(`✖ ${err.message}`));
        for (const i of err.issues) console.error(`  ${i.path}: ${i.message}`);
      }
      return EXIT.usage;
    }
    throw err;
  }

  const r = result.report;
  if (values.json) {
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
    return EXIT.ok;
  }
  printReport(r, result.dryRun);
  return EXIT.ok;
}

function printReport(r, dryRun) {
  const out = rel(r.outDir);
  console.log();
  console.log(dryRun ? bold(`Plan for ${r.videos} video(s) → ${out}`) : `${green('✔')} ${bold(`Built ${r.videos} video(s) in ${r.seconds}s → ${out}`)}`);
  const levelList = r.levels.map((l) => `z${l.z} ${l.tiles}`).join(', ');
  const totalTiles = r.levels.reduce((n, l) => n + l.tiles, 0);
  const l = r.layout;
  const groups = l.groups ? `, ${l.groups} groups` : '';
  if (l.pack === 'masonry') {
    row('Masonry', `${l.columns} columns of ${l.columnWidth}px${l.gap ? ` (gap ${l.gap})` : ''} → ${l.width}×${l.height} px${groups}${l.groups ? ` as ${l.groupArrange}` : ''}`
      + (l.splits ? ` · ${l.splits} video(s) cross a tile edge` : ''));
  } else {
    row('Grid', `${l.cols}×${l.rows} cells of ${formatSize(l.cell)} → ${l.width}×${l.height} px${groups}`);
  }
  row('Pyramid', `${r.levels.length} level(s) of ${formatSize(r.tile)} tiles: ${levelList} (${totalTiles} tiles)`);
  row('Loop', `${r.preview.duration}s at ${r.preview.fps} fps${r.looped ? ` · ${r.looped} short video(s) looped` : ''}`);
  const e = r.encoder;
  const hw = e.setting === 'off' ? 'hardware off' : e.detected?.length === 0 ? 'no working hardware encoder' : '';
  row('Encoder', `${e.h264}${e.finalTiles !== e.h264 ? ` (final tiles: ${e.finalTiles})` : ''}${hw ? dim(` · ${hw}`) : ''}`
    + (e.fallbacks ? yellow(` · ${e.fallbacks} job(s) fell back to libx264${e.disabled ? ', then hardware was turned off' : ''}`) : ''));
  if (r.jobs) {
    const j = r.jobs;
    const part = (name, c) => `${name} ${c.run + c.cached}${c.cached ? ` (${c.cached} cached)` : ''}`;
    row('Jobs', [part('clips', j.clips), part('tiles', j.tiles), ...(r.full ? [part('media', j.media)] : []), part('posters', j.posters)].join(' · ')
      + (j.media.copied ? ` · ${j.media.copied} media remuxed without re-encoding` : ''));
    const t = r.timings;
    row('Time', `probe ${t.probe}s · clips ${t.clips}s · tiles ${t.tiles}s${r.full ? ` · media ${t.media}s` : ''} · posters ${t.posters}s`);
  }
  if (r.sizes) {
    const s = r.sizes;
    row('Size', `tiles ${mb(s.tiles)} · stills ${mb(s.stills)}${r.full ? ` · media ${mb(s.media)}` : ''} · posters ${mb(s.posters)} · total ${bold(mb(s.total))}`);
    row('Cache', r.cacheCleared ? 'intermediates deleted (--no-keep-cache)' : `${mb(s.cache)} in the build cache${dim(' (vmap clean deletes it)')}`);
  } else {
    const s = r.estimate;
    row('Estimate', `tiles ${mb(s.tiles)} · stills ${mb(s.stills)}${r.full ? ` · media ${mb(s.media)}` : ''} · posters ${mb(s.posters)} · total ${bold(mb(s.total))}`);
    row('', r.full ? `${mb(s.withoutMedia)} without full renditions (--no-full)` : `full renditions would add ${mb(s.withMedia - s.withoutMedia)}`);
  }
  for (const w of r.warnings) console.log(`${yellow('!')} ${w}`);
  if (!dryRun) console.log(dim(`\nPreview it with: vmap preview ${out}`));
}

function row(label, text) {
  console.log(`  ${dim(label.padEnd(9))} ${text}`);
}

// ---------------------------------------------------------------------------
// preview

async function preview(args) {
  const { values, positionals } = parse(args, {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    open: { type: 'boolean' },
  });
  const root = path.resolve(positionals[0] ?? 'dist');
  if (!(await stat(path.join(root, 'scene.json')).catch(() => null))) {
    console.error(yellow(`! ${rel(root)} has no scene.json; run "vmap build" first.`));
  }
  const { urls } = await startServer({
    root,
    port: num(values.port, '--port', { min: 0, max: 65535, int: true }) ?? 8080,
    host: values.host ?? '0.0.0.0',
  });
  console.log(`Serving ${rel(root)}:`);
  urls.forEach((u, i) => console.log(`  ${u}${i > 0 ? dim('   (other devices on your network)') : ''}`));
  console.log(dim('Press Ctrl+C to stop.'));
  if (values.open) openBrowser(urls[0]);
  return new Promise(() => {}); // run until interrupted
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ---------------------------------------------------------------------------
// info

async function info(args) {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const root = path.resolve(positionals[0] ?? 'dist');
  let scene;
  try {
    scene = JSON.parse(await readFile(path.join(root, 'scene.json'), 'utf8'));
  } catch {
    throw new UsageError(`${rel(root)} has no readable scene.json.`);
  }
  if (scene.format !== SCENE_FORMAT) throw new UsageError(`${rel(root)}/scene.json is not a VideoMap build output.`);

  const sizes = {};
  for (const dir of ['tiles', 'stills', 'media', 'posters']) sizes[dir] = await dirSize(path.join(root, dir));
  const summary = {
    title: scene.title,
    version: scene.version,
    generator: scene.generator,
    videos: scene.videos.length,
    surface: scene.surface.type,
    pack: scene.layout?.pack ?? 'grid',
    grid: scene.grid ? `${scene.grid.cols}x${scene.grid.rows}` : null,
    cell: scene.grid ? formatSize(scene.grid.cell) : null,
    columns: scene.layout?.pack === 'masonry' ? scene.layout.columns : null,
    columnWidth: scene.layout?.pack === 'masonry' ? scene.layout.columnWidth : null,
    tilesOnly: scene.videos.every((v) => !v.media),
    tile: formatSize(scene.pyramid.tile),
    content: `${scene.content.width}x${scene.content.height}`,
    levels: scene.pyramid.levels.map((l) => l.tiles.length),
    preview: `${scene.preview.duration}s @ ${scene.preview.fps} fps`,
    groups: scene.groups.map((g) => `${g.label} (${g.count})`),
    sizes,
  };
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return EXIT.ok;
  }
  console.log(bold(summary.title));
  row('Videos', `${summary.videos} on a ${summary.surface}${summary.tilesOnly ? ', tiles only' : ''}`);
  if (summary.pack === 'masonry') row('Masonry', `${summary.columns} columns of ${summary.columnWidth}px → ${summary.content} px`);
  else row('Grid', `${summary.grid} cells of ${summary.cell} → ${summary.content} px`);
  row('Pyramid', `${summary.levels.length} levels of ${summary.tile} tiles: ${summary.levels.map((n, z) => `z${z} ${n}`).join(', ')}`);
  row('Loop', summary.preview);
  if (summary.groups.length) row('Groups', summary.groups.join(', '));
  row('Size', Object.entries(sizes).map(([k, v]) => `${k} ${mb(v)}`).join(' · '));
  return EXIT.ok;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// doctor

async function doctor(args) {
  const { values } = parse(args, { ffmpeg: { type: 'string' }, ffprobe: { type: 'string' } });
  const tools = createTools({ ffmpeg: values.ffmpeg, ffprobe: values.ffprobe });
  let caps;
  try {
    caps = await detectCapabilities(tools);
  } catch (err) {
    console.log(`${red('✖')} ${err.message}`);
    return EXIT.failed;
  }
  const checks = [
    ['ffmpeg and ffprobe', true, `ffmpeg ${caps.version}`, true],
    ['libx264 encoder', caps.libx264, 'tiles and full renditions', true],
    ['xstack filter with fill', caps.xstack && caps.xstackFill, 'compositing tiles (ffmpeg 5.1+)', true],
    ['libvpx-vp9 encoder', caps.libvpxVp9, 'optional VP9 tiles (--tile-codecs h264,vp9)', false],
    ['libwebp encoder', caps.libwebp, 'stills and posters (otherwise use --no-stills; posters fall back to JPEG)', false],
    ['aac encoder', caps.aac, 'audio in full renditions', true],
    ['zscale + tonemap filters', caps.zscale && caps.tonemap, 'HDR sources (otherwise colors look washed out)', false],
  ];
  let ok = true;
  for (const [name, pass, why, required] of checks) {
    console.log(`${pass ? green('✔') : required ? red('✖') : yellow('!')} ${name} ${dim(`- ${why}`)}`);
    if (!pass && required) ok = false;
  }

  // Hardware H.264 encoders: listed ones get a test encode (the result is cached for builds).
  console.log(`\n${bold('Hardware encoding')} ${dim('(--hw auto uses the first one that works)')}`);
  const hw = await detectHardware(tools, caps, { refresh: true });
  for (const e of hw.encoders) {
    const status = e.works ? green('✔') : e.listed ? yellow('!') : dim('·');
    const note = e.works ? 'works' : e.listed ? `listed, but the test encode failed: ${e.error}` : 'not in this ffmpeg build';
    console.log(`${status} ${e.label} ${dim(`(${e.name}) - ${note}`)}`);
  }
  const first = hw.encoders.find((e) => e.works);
  console.log(first ? `Builds will encode H.264 with ${first.label}.` : 'Builds will encode H.264 with libx264 (software).');
  return ok ? EXIT.ok : EXIT.failed;
}

// ---------------------------------------------------------------------------
// clean

async function clean(args) {
  const { values, positionals } = parse(args, { cache: { type: 'string' } });
  const scenePath = path.resolve(positionals[0] ?? 'scene.json');
  const dir = path.resolve(values.cache ?? path.join(path.dirname(scenePath), '.vmap-cache'));
  if (!values.cache && !positionals[0] && !(await stat(scenePath).catch(() => null))) {
    throw new UsageError('No scene.json in this folder. Pass the scene file, e.g. "vmap clean wall/scene.json", or --cache <dir>.');
  }
  const freed = await cleanCache(dir);
  if (freed === null) console.log(`No build cache at ${rel(dir)}.`);
  else console.log(`${green('✔')} Deleted ${rel(dir)} (${mb(freed)}).`);
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// helpers

function requireScene(positionals) {
  if (!positionals[0]) throw new UsageError('Missing the scene file, e.g. "vmap build scene.json".');
  return positionals[0];
}

/**
 * Parse an optional numeric flag.
 * @param {string|undefined} value
 * @param {string} name
 * @param {{ min?: number, max?: number, int?: boolean }} [range]
 */
function num(value, name, { min = -Infinity, max = Infinity, int = false } = {}) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new UsageError(`${name} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max}, got "${value}".`);
  }
  return n;
}

function mb(bytes) {
  if (!bytes) return '0 MB';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function rel(p) {
  const r = path.relative(process.cwd(), path.resolve(p));
  return r && !r.startsWith('..') ? r : path.resolve(p);
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    if (err instanceof UsageError) {
      console.error(red(err.message));
      process.exitCode = EXIT.usage;
    } else {
      console.error(red(`✖ ${err.message}`));
      if (process.env.VMAP_DEBUG && err.command) console.error(dim(err.command));
      if (process.env.VMAP_DEBUG) console.error(err.stack);
      process.exitCode = EXIT.failed;
    }
  },
);
