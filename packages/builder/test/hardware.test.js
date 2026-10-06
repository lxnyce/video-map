// Integration tests for hardware encoding: the libx264 fallback (with a
// deliberately broken encoder, so it runs everywhere) and, when this machine
// has a working hardware encoder, the browser contract of its tiles plus a
// time and size comparison with libx264. Skipped when ffmpeg isn't installed.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { buildScene } from '../src/build.js';
import { HW_ENCODERS } from '../src/encode.js';
import { createTools, detectCapabilities } from '../src/ffmpeg.js';
import { detectHardware } from '../src/hardware.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);

async function ffmpeg(...args) {
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

async function tileInfo(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,level,has_b_frames,nb_frames',
    '-of', 'json', file]);
  const { stdout: keys } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]);
  return { ...JSON.parse(stdout).streams[0], keyframes: keys.trim().split(/\s+/).map(Number) };
}

describe('hardware encoding (ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  let dir;
  let scenePath;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-hw-'));
    process.env.VMAP_HW_CACHE = path.join(dir, 'hardware.json');
    await mkdir(path.join(dir, 'src'));
    await Promise.all([0, 1, 2, 3].map((i) => ffmpeg('-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24:d=3`, '-vf', `hue=h=${i * 60}`,
      '-c:v', 'mpeg4', '-q:v', '3', path.join(dir, `src/v${i}.avi`))));
    scenePath = path.join(dir, 'scene.json');
    await writeFile(scenePath, JSON.stringify({
      preview: { duration: 2, fps: 12 },
      output: { cell: '192x108', tile: '192x108' },
      videos: [0, 1, 2, 3].map((i) => ({ id: `v${i}`, src: `src/v${i}.avi` })),
    }));
  }, { timeout: 60_000 });

  after(async () => {
    delete HW_ENCODERS.broken;
    delete process.env.VMAP_HW_CACHE;
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to libx264 when hardware jobs fail, and gives up on hardware after three in a row', { timeout: 120_000 }, async () => {
    HW_ENCODERS.broken = {
      codec: 'h264_vmap_does_not_exist',
      label: 'Broken',
      master: () => [],
      final: () => [],
      full: () => [],
    };
    const { report } = await buildScene({ scenePath, outDir: path.join(dir, 'broken'), cacheDir: path.join(dir, 'cache-broken'), jobs: 2, hardwareEncoder: 'broken' });
    assert.ok(report.encoder.fallbacks >= 3, `fallbacks: ${report.encoder.fallbacks}`);
    assert.equal(report.encoder.disabled, true);
    assert.equal(report.encoder.h264, 'libx264');
    assert.ok(report.warnings.some((w) => /Hardware encode failed for .*re-encoded with libx264/.test(w)));
    assert.ok(report.warnings.some((w) => /turned off for the rest of the build/.test(w)));
    const info = await tileInfo(path.join(dir, 'broken/tiles/1/0/0.mp4'));
    assert.deepEqual([info.codec_name, info.profile], ['h264', 'Main'], 'tiles still come out, from libx264');
  });

  it('builds browser-ready tiles on a working hardware encoder', { timeout: 240_000 }, async (t) => {
    const tools = createTools();
    const found = await detectHardware(tools, await detectCapabilities(tools));
    const encoder = found.encoders.find((e) => e.works);
    if (!encoder) {
      t.skip(`no working hardware encoder (${found.encoders.filter((e) => e.listed).map((e) => `${e.name}: ${e.error}`).join('; ') || 'none listed'})`);
      return;
    }

    const hwBuild = await buildScene({ scenePath, outDir: path.join(dir, 'hw'), cacheDir: path.join(dir, 'cache-hw'), jobs: 2, overrides: { build: { hardwareFinal: true } } });
    const r = hwBuild.report;
    assert.equal(r.encoder.setting, 'auto');
    assert.equal(r.encoder.h264, encoder.label);
    assert.equal(r.encoder.finalTiles, encoder.label);
    assert.equal(r.encoder.fallbacks, 0);
    assert.ok(r.encoder.hardwareJobs > 0);
    assert.equal(r.jobs.clips.run, 4);

    for (const level of [0, 1]) {
      const info = await tileInfo(path.join(dir, `hw/tiles/${level}/0/0.mp4`));
      assert.equal(info.codec_name, 'h264');
      assert.equal(info.profile, 'Main', `level ${level}: Main profile`);
      assert.ok(Number(info.level) <= 30, `level ${info.level} within the declared 3.0`);
      assert.deepEqual(info.keyframes, [0, 1], 'a keyframe every second');
    }

    // By default the final tiles stay on libx264 while hardware does the rest.
    const mixed = await buildScene({ scenePath, outDir: path.join(dir, 'mixed'), cacheDir: path.join(dir, 'cache-hw'), jobs: 2 });
    assert.equal(mixed.report.encoder.finalTiles, 'libx264');
    assert.equal(mixed.report.jobs.clips.run, 0, 'hardware clips are reused');

    const swBuild = await buildScene({ scenePath, outDir: path.join(dir, 'sw'), cacheDir: path.join(dir, 'cache-sw'), jobs: 2, overrides: { build: { hardware: 'off' } } });
    const s = swBuild.report;
    t.diagnostic(`${encoder.label}: ${r.timings.total}s, tiles ${r.sizes.tiles} B · libx264: ${s.timings.total}s, tiles ${s.sizes.tiles} B`);
    assert.equal(s.encoder.h264, 'libx264');
  });
});
