// Integration tests: real ffmpeg builds on tiny synthetic clips.
// Skipped when ffmpeg isn't installed.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { buildScene, viewerDist } from '../src/build.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);

async function ffmpeg(...args) {
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

async function streamInfo(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_read_frames,codec_name,profile', '-of', 'json', file]);
  return JSON.parse(stdout).streams[0];
}

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'));
  }
  return out.sort();
}

describe('buildScene (ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  let dir;
  let scenePath;
  const out = () => path.join(dir, 'dist');
  const base = {
    title: 'Test wall',
    preview: { duration: 2, fps: 6 },
    layout: { groupBy: 'category', groupGap: 0 },
    output: { cell: '64x36', tile: '128x72' },
    // Hardware encoding has its own tests (hardware.test.js); keep these the same on every machine.
    build: { hardware: 'off' },
    categories: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
  };

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-build-'));
    await mkdir(path.join(dir, 'src'));
    // Varied sources: short (loops), long, portrait, 4:3, with audio, non-H.264.
    await Promise.all([
      ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'src/short.mp4')),
      ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'sine=d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'src/long.mp4')),
      ffmpeg('-f', 'lavfi', '-i', 'testsrc=s=180x320:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'src/portrait.mp4')),
      ffmpeg('-f', 'lavfi', '-i', 'testsrc=s=160x120:r=15:d=4', '-c:v', 'mpeg4', path.join(dir, 'src/old.avi')),
      ffmpeg('-f', 'lavfi', '-i', 'smptebars=s=320x180:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'src/bars.mp4')),
    ]);
    scenePath = path.join(dir, 'scene.json');
  }, { timeout: 60_000 });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeScene(overrides = {}) {
    const scene = {
      ...base,
      videos: [
        { id: 'short', src: 'src/short.mp4', title: 'Short', categories: ['a'], tags: ['loop'] },
        { id: 'long', src: 'src/long.mp4', title: 'Long', categories: ['a'], previewStart: 1 },
        { id: 'portrait', src: 'src/portrait.mp4', title: 'Portrait', categories: ['b'] },
        { id: 'old', src: 'src/old.avi', title: 'Old', categories: ['b'] },
        { id: 'bars', src: 'src/bars.mp4', title: 'Bars' },
      ],
      ...overrides,
    };
    await writeFile(scenePath, JSON.stringify(scene));
    return scene;
  }

  it('builds a complete, consistent output folder', { timeout: 120_000 }, async () => {
    await writeScene();
    const { report } = await buildScene({ scenePath, jobs: 4 });
    const scene = JSON.parse(await readFile(path.join(out(), 'scene.json'), 'utf8'));

    assert.equal(scene.format, 'videomap-scene');
    assert.equal(scene.videos.length, 5);
    assert.deepEqual(scene.preview, { duration: 2, fps: 6, frames: 12 });
    assert.deepEqual(scene.pyramid.tile, { w: 128, h: 72 });
    assert.deepEqual(scene.groups.map((g) => g.label), ['Alpha', 'Beta', 'Other']);

    const byId = Object.fromEntries(scene.videos.map((v) => [v.id, v]));
    assert.equal(byId.short.looped, true);
    assert.equal(byId.long.previewStart, 1);
    assert.equal(byId.long.hasAudio, true);
    assert.equal(byId.portrait.width, 180);

    // Every listed tile and still exists; nothing else is in the managed folders.
    const expected = new Set(['index.html', 'scene.json']);
    const viewer = await viewerDist();
    if (viewer) for (const f of await files(path.join(viewer, 'assets'))) expected.add(`assets/${f}`);
    for (const level of scene.pyramid.levels) {
      for (const [x, y] of level.tiles) {
        expected.add(`tiles/${level.z}/${x}/${y}.mp4`);
        expected.add(`stills/${level.z}/${x}/${y}.webp`);
      }
    }
    for (const v of scene.videos) {
      expected.add(v.media);
      expected.add(v.poster);
    }
    assert.deepEqual(await files(out()), [...expected].sort());

    // Tiles: exact frame count and size, H.264 Main.
    for (const level of scene.pyramid.levels) {
      const [x, y] = level.tiles[0];
      const info = await streamInfo(path.join(out(), `tiles/${level.z}/${x}/${y}.mp4`));
      assert.deepEqual([info.codec_name, info.profile, info.width, info.height, Number(info.nb_read_frames)], ['h264', 'Main', 128, 72, 12], `level ${level.z}`);
    }

    // Full renditions: web-friendly sources remuxed, others transcoded to H.264.
    assert.equal((await streamInfo(path.join(out(), byId.old.media))).codec_name, 'h264');
    assert.equal(report.jobs.media.copied, 4);
    assert.equal(report.jobs.clips.run, 5);
    assert.ok(report.sizes.total > 0);
  });

  it('reuses everything on an unchanged rebuild', { timeout: 60_000 }, async () => {
    const { report } = await buildScene({ scenePath, jobs: 4 });
    assert.deepEqual(
      Object.fromEntries(Object.entries(report.jobs).map(([k, v]) => [k, v.run])),
      { clips: 0, tiles: 0, media: 0, posters: 0 },
    );
  });

  it('re-encodes only final tiles when only tile quality changes', { timeout: 60_000 }, async () => {
    const { report } = await buildScene({ scenePath, jobs: 4, overrides: { output: { tileCrf: 30 } } });
    assert.equal(report.jobs.clips.run, 0);
    assert.ok(report.jobs.tiles.run > 0);
    assert.equal(report.jobs.media.run, 0);
  });

  it('removes outputs of videos that were dropped from the scene', { timeout: 120_000 }, async () => {
    const scene = await writeScene();
    scene.videos = scene.videos.filter((v) => v.id !== 'bars');
    await writeFile(scenePath, JSON.stringify(scene));
    await buildScene({ scenePath, jobs: 4 });
    const list = await files(out());
    assert.ok(!list.includes('media/bars.mp4'));
    assert.ok(!list.includes('posters/bars.webp'));
    const manifest = JSON.parse(await readFile(path.join(out(), 'scene.json'), 'utf8'));
    assert.equal(manifest.videos.length, 4);
  });

  it('plans without encoding on a dry run', async () => {
    await writeScene();
    const { dryRun, report } = await buildScene({ scenePath, dryRun: true, outDir: path.join(dir, 'never') });
    assert.equal(dryRun, true);
    assert.equal(report.jobs, null);
    assert.ok(report.estimate.total > 0);
    assert.ok(!(await files(dir)).some((f) => f.startsWith('never/')));
  });

  it('refuses unsafe output folders', async () => {
    await writeScene();
    await assert.rejects(buildScene({ scenePath, outDir: dir }), /contains the scene file/);
    const foreign = path.join(dir, 'foreign');
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, 'notes.txt'), 'keep me');
    await assert.rejects(buildScene({ scenePath, outDir: foreign }), /not empty/);
  });

  it('reports missing files and invalid scenes before running ffmpeg', async () => {
    await writeScene({ videos: [{ src: 'src/nope.mp4' }] });
    await assert.rejects(buildScene({ scenePath }), (/** @type {any} */ err) => err.name === 'SceneError' && /file not found/.test(err.issues[0].message));
    await writeFile(scenePath, JSON.stringify({ videos: [] }));
    await assert.rejects(buildScene({ scenePath }), (/** @type {any} */ err) => err.name === 'SceneError' && err.issues.length > 0);
  });
});
