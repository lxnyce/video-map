#!/usr/bin/env node
// Milestone 0 spike: generates synthetic tile videos for the device test page.
//
// Each tile imitates a real pyramid tile: a grid of "cells" with moving
// content, encoded exactly as the planned pipeline would encode it (fixed
// frame count, 1 s GOP, faststart, no audio). Every tile also shows a frame
// counter and a progress bar driven by its timestamp, so drift between tiles
// is visible by eye.
//
// Usage: node spike/generate.mjs [--sets 768x432@24,512x288@24] [--count 16]
//          [--duration 10] [--codec h264|vp9|both] [--jobs N] [--out dir]

import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const { values: opts } = parseArgs({
  options: {
    sets: { type: 'string', default: '768x432@24,512x288@24,512x288@15' },
    count: { type: 'string', default: '16' },
    duration: { type: 'string', default: '10' },
    codec: { type: 'string', default: 'h264' },
    jobs: { type: 'string', default: String(Math.max(1, Math.floor(os.cpus().length / 2))) },
    out: { type: 'string', default: path.join(here, 'media') },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help) {
  console.log(`Usage: node spike/generate.mjs [options]

  --sets      Comma-separated WxH@fps tile variants (default: ${'768x432@24,512x288@24,512x288@15'})
  --count     Distinct tile videos per variant (default: 16)
  --duration  Loop length in seconds (default: 10)
  --codec     h264 | vp9 | both (default: h264; vp9 is useful for headless Chromium)
  --jobs      Parallel ffmpeg processes (default: half the CPU cores)
  --out       Output directory (default: spike/media)
  FFMPEG=/path/to/ffmpeg overrides the ffmpeg binary.`);
  process.exit(0);
}

const count = toInt(opts.count, 'count');
const duration = toInt(opts.duration, 'duration');
const jobs = toInt(opts.jobs, 'jobs');

function toInt(value, name) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) fail(`--${name} must be a positive integer`);
  return n;
}

function parseSet(spec) {
  const m = /^(\d+)x(\d+)@(\d+)$/.exec(spec.trim());
  if (!m) fail(`Bad set "${spec}". Expected WxH@fps, e.g. 768x432@24`);
  const [width, height, fps] = m.slice(1).map(Number);
  if (width % 2 || height % 2) fail(`Set "${spec}": width and height must be even for yuv420p`);
  return { width, height, fps };
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const CODECS = {
  h264: {
    ext: 'mp4',
    mime: 'video/mp4; codecs="avc1.4D401F"',
    args: (s) => [
      '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-preset', 'medium', '-crf', '28', '-maxrate', bitrateFor(s), '-bufsize', bitrateFor(s, 2),
      '-g', String(s.fps), '-keyint_min', String(s.fps), '-sc_threshold', '0',
      '-tune', 'fastdecode', '-movflags', '+faststart',
    ],
  },
  vp9: {
    ext: 'webm',
    mime: 'video/webm; codecs="vp09.00.31.08"',
    args: (s) => [
      // Constrained quality: CRF with -b:v as the ceiling.
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', '36', '-b:v', bitrateFor(s),
      '-g', String(s.fps), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
    ],
  },
};

const codecs = opts.codec === 'both' ? ['h264', 'vp9'] : [opts.codec];
for (const c of codecs) {
  if (!CODECS[c]) fail(`Unknown codec "${c}". Use h264, vp9 or both.`);
}
const sets = opts.sets.split(',').map(parseSet);

// Roughly 0.12 bits per pixel per frame, the cap the real pipeline would use.
function bitrateFor({ width, height, fps }, mult = 1) {
  return `${Math.round((width * height * fps * 0.12 * mult) / 1000)}k`;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').slice(-5).join('\n')))));
  });
}

async function canDrawText() {
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:d=0.1',
      '-vf', "drawtext=text='0':fontsize=12", '-frames:v', '1', '-f', 'null', '-']);
    return true;
  } catch {
    return false;
  }
}

function filterFor(set, index, withText) {
  const hue = Math.round((index * 360) / count);
  const cells = set.width >= 768 ? 4 : 3;
  const bar = Math.max(6, Math.round(set.height / 40));
  const label = `T${String(index).padStart(2, '0')}`;
  const base = [
    `hue=h=${hue}`,
    // Temporal noise brings the bitrate closer to real footage than a flat test pattern.
    'noise=alls=6:allf=t',
    `drawgrid=w=iw/${cells}:h=ih/${cells}:t=2:c=black@0.6`,
  ];
  if (withText) {
    const size = Math.round(set.height / 12);
    base.push(`drawtext=text='${label} %{frame_num}':x=8:y=8:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`);
  }
  // A progress bar that slides in with the timestamp; adjacent tiles' bars line up when they are in sync.
  // (overlay re-evaluates x per frame; drawbox in ffmpeg 6 does not.)
  return `[0:v]${base.join(',')}[base];`
    + `color=c=white:s=${set.width}x${bar}:r=${set.fps}[bar];`
    + `[base][bar]overlay=x='-w+w*t/${duration}':y=H-h:eval=frame:shortest=1[out]`;
}

async function pool(tasks, size, onDone) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
      onDone();
    }
  });
  await Promise.all(workers);
}

async function main() {
  try {
    await run(['-hide_banner', '-version']);
  } catch {
    fail(`ffmpeg not found ("${FFMPEG}"). Install ffmpeg or set FFMPEG=/path/to/ffmpeg.`);
  }
  const withText = await canDrawText();
  if (!withText) console.warn('warning: ffmpeg drawtext is unavailable; tiles will have no frame counter text.');

  await rm(opts.out, { recursive: true, force: true });
  const manifest = { generatedAt: new Date().toISOString(), duration, count, sets: [] };
  const tasks = [];

  for (const set of sets) {
    for (const codec of codecs) {
      const spec = CODECS[codec];
      const id = `${set.width}x${set.height}@${set.fps}-${codec}`;
      const dir = path.join(opts.out, id);
      await mkdir(dir, { recursive: true });
      const entry = { id, ...set, codec, mime: spec.mime, files: [], bytes: 0 };
      manifest.sets.push(entry);

      for (let i = 0; i < count; i++) {
        const file = `tile-${String(i).padStart(2, '0')}.${spec.ext}`;
        const dest = path.join(dir, file);
        entry.files.push(`${id}/${file}`);
        tasks.push(async () => {
          await run([
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', `testsrc2=s=${set.width}x${set.height}:r=${set.fps}:d=${duration}`,
            '-filter_complex', filterFor(set, i, withText), '-map', '[out]',
            '-frames:v', String(set.fps * duration), '-an',
            ...spec.args(set), dest,
          ]);
          entry.bytes += (await stat(dest)).size;
        });
      }
    }
  }

  let done = 0;
  const started = Date.now();
  await pool(tasks, jobs, () => {
    done++;
    process.stdout.write(`\rEncoding tiles ${done}/${tasks.length}`);
  });
  process.stdout.write('\n');

  await writeFile(path.join(opts.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const s of manifest.sets) {
    console.log(`  ${s.id.padEnd(20)} ${s.files.length} tiles, ${(s.bytes / 1e6).toFixed(1)} MB (avg ${(s.bytes / s.files.length / 1e3).toFixed(0)} KB)`);
  }
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s → ${path.relative(process.cwd(), opts.out) || '.'}`);
}

main().catch((err) => fail(err.message));
