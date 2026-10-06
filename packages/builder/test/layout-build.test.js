// Integration tests for milestone 3 layouts and outputs: masonry walls (nothing
// cropped, videos split across tiles), tiles-only builds and the build cache.
// Skipped when ffmpeg isn't installed.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { buildScene } from '../src/build.js';
import { cleanCache } from '../src/cache.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);

async function ffmpeg(...args) {
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** First frame of a video as RGB bytes. */
async function firstFrame(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const exists = (p) => stat(p).then(() => true, () => false);

describe('masonry builds (ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  let dir;
  // Solid blue frames with a thick white border: if any edge of a video were
  // cropped, its border would be missing from the wall.
  const shapes = { landscape: [320, 180], portrait: [180, 320], square: [240, 240], wide: [420, 180] };

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-masonry-'));
    await mkdir(path.join(dir, 'src'));
    await Promise.all(Object.entries(shapes).map(([name, [w, h]]) => {
      const t = Math.round(Math.min(w, h) * 0.12);
      return ffmpeg('-f', 'lavfi', '-i', `color=c=0x2050c0:s=${w}x${h}:r=12:d=1`,
        '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=${t}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, `src/${name}.mp4`));
    }));
  }, { timeout: 60_000 });

  after(() => rm(dir, { recursive: true, force: true }));

  async function build(name, layout, extra = {}) {
    const scenePath = path.join(dir, `${name}.json`);
    await writeFile(scenePath, JSON.stringify({
      title: name,
      preview: { duration: 1, fps: 6 },
      layout: { pack: 'masonry', groupBy: 'none', columnWidth: 128, ...layout },
      output: { tile: '256x256', tileCrf: 16, full: { enabled: false }, ...extra },
      build: { hardware: 'off' },
      videos: Object.keys(shapes).flatMap((s) => [1, 2].map((n) => ({ id: `${s}-${n}`, src: `src/${s}.mp4`, title: `${s} ${n}`, meta: { shape: s } }))),
    }));
    const outDir = path.join(dir, `${name}-dist`);
    const { report } = await buildScene({ scenePath, outDir, jobs: 4 });
    const scene = JSON.parse(await readFile(path.join(outDir, 'scene.json'), 'utf8'));
    return { report, scene, outDir };
  }

  /** Color at wall pixel (x, y), read from the deepest tile that holds it. */
  async function sampler(scene, outDir) {
    const { tile, maxZoom } = scene.pyramid;
    const frames = new Map();
    return async (x, y) => {
      const tx = Math.floor(x / tile.w);
      const ty = Math.floor(y / tile.h);
      const key = `${tx},${ty}`;
      if (!frames.has(key)) frames.set(key, await firstFrame(path.join(outDir, `tiles/${maxZoom}/${tx}/${ty}.mp4`)));
      const i = ((y - ty * tile.h) * tile.w + (x - tx * tile.w)) * 3;
      const f = frames.get(key);
      return [f[i], f[i + 1], f[i + 2]];
    };
  }

  /** @param {number[]} c */
  const white = (c) => c[0] > 190 && c[1] > 190 && c[2] > 190;
  /** @param {number[]} c */
  const blue = (c) => c[2] > 140 && c[0] < 90;

  async function assertWholeFrames(scene, outDir) {
    const at = await sampler(scene, outDir);
    for (const v of scene.videos) {
      const r = v.rect;
      const cx = r.x + Math.floor(r.w / 2);
      const cy = r.y + Math.floor(r.h / 2);
      // Two pixels inside each edge: the border must be there on all four sides.
      for (const [x, y, side] of [[cx, r.y + 2, 'top'], [cx, r.y + r.h - 3, 'bottom'], [r.x + 2, cy, 'left'], [r.x + r.w - 3, cy, 'right']]) {
        assert.ok(white(await at(x, y)), `${v.id}: ${side} border is visible at ${x},${y} (got ${await at(x, y)})`);
      }
      assert.ok(blue(await at(cx, cy)), `${v.id}: inside is blue`);
    }
  }

  it('keeps every video whole at its own shape', { timeout: 120_000 }, async () => {
    const { scene, outDir, report } = await build('whole', {});
    assert.equal(scene.layout.pack, 'masonry');
    assert.equal(scene.grid, null);
    const byId = Object.fromEntries(scene.videos.map((v) => [v.id, v]));
    assert.deepEqual([byId['landscape-1'].rect.w, byId['landscape-1'].rect.h], [128, 72]);
    assert.deepEqual([byId['portrait-1'].rect.w, byId['portrait-1'].rect.h], [128, 228]);
    assert.equal(byId['square-1'].rect.h, 128);
    assert.equal(report.layout.splits, 0, 'avoidSplits keeps each video inside one tile');
    await assertWholeFrames(scene, outDir);
  });

  it('splits videos across tile edges without losing any part', { timeout: 120_000 }, async () => {
    const { scene, outDir, report } = await build('split', { avoidSplits: false }, { tile: '256x160' });
    assert.ok(report.layout.splits > 0, 'some videos cross a tile edge');
    const crossing = scene.videos.filter((v) => Math.floor(v.rect.y / 160) !== Math.floor((v.rect.y + v.rect.h - 1) / 160));
    assert.ok(crossing.length > 0);
    await assertWholeFrames(scene, outDir);
  });

  it('packs groups side by side or as bands', { timeout: 120_000 }, async () => {
    const bands = await build('bands', { groupBy: 'meta.shape', groupArrange: 'bands' });
    assert.equal(bands.scene.groups.length, 4);
    for (const g of bands.scene.groups) assert.deepEqual([g.x, g.w], [0, bands.scene.content.width]);
    await assertWholeFrames(bands.scene, bands.outDir);

    const columns = await build('columns', { groupBy: 'meta.shape' });
    assert.equal(columns.scene.groups.length, 4);
    assert.equal(columns.scene.layout.groupArrange, 'columns');
    assert.ok(columns.scene.groups.every((g) => g.w < columns.scene.content.width), 'groups share the width');
    await assertWholeFrames(columns.scene, columns.outDir);
  });
});

describe('tiles-only builds and the cache (ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  let dir;
  let scenePath;
  const outDir = () => path.join(dir, 'dist');
  const cacheDir = () => path.join(dir, '.vmap-cache');

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-tiles-only-'));
    await mkdir(path.join(dir, 'src'));
    await Promise.all([0, 1, 2].map((i) => ffmpeg('-f', 'lavfi', '-i', `testsrc2=s=320x180:r=12:d=2`, '-vf', `hue=h=${i * 90}`,
      '-c:v', 'mpeg4', path.join(dir, `src/v${i}.avi`))));
    scenePath = path.join(dir, 'scene.json');
    await writeFile(scenePath, JSON.stringify({
      preview: { duration: 1, fps: 6 },
      output: { cell: '64x36', tile: '128x72' },
      build: { hardware: 'off' },
      videos: [0, 1, 2].map((i) => ({ id: `v${i}`, src: `src/v${i}.avi` })),
    }));
  }, { timeout: 60_000 });

  after(() => rm(dir, { recursive: true, force: true }));

  it('drops full renditions (and old media) when built tiles-only', { timeout: 120_000 }, async () => {
    await buildScene({ scenePath, jobs: 4 });
    assert.ok(await exists(path.join(outDir(), 'media/v0.mp4')));

    const { report } = await buildScene({ scenePath, jobs: 4, overrides: { output: { full: { enabled: false } } } });
    const scene = JSON.parse(await readFile(path.join(outDir(), 'scene.json'), 'utf8'));
    assert.deepEqual(scene.videos.map((v) => v.media), [null, null, null]);
    assert.ok(scene.videos.every((v) => v.poster), 'posters are always made');
    assert.ok(!(await exists(path.join(outDir(), 'media'))), 'media/ from the earlier build is pruned');
    assert.equal(report.full, false);
    assert.equal(report.sizes.media, 0);
    assert.equal(report.jobs.tiles.run, 0, 'tiles are reused');
    const e = report.estimate;
    assert.equal(e.total, e.withoutMedia);
    assert.ok(e.withMedia > e.withoutMedia, 'the estimate still says what media would cost');
  });

  it('builds walls where many tiles have identical content', { timeout: 120_000 }, async () => {
    // One source repeated: videos share a clip, and whole tiles share a master.
    const repeated = path.join(dir, 'repeated.json');
    await writeFile(repeated, JSON.stringify({
      preview: { duration: 1, fps: 6 },
      layout: { groupBy: 'none' },
      output: { cell: '64x36', tile: '128x72', full: { enabled: false } },
      build: { hardware: 'off' },
      videos: Array.from({ length: 16 }, (_, i) => ({ id: `r${i}`, src: 'src/v0.avi' })),
    }));
    const { report } = await buildScene({ scenePath: repeated, outDir: path.join(dir, 'repeated-dist'), jobs: 8 });
    assert.ok(report.jobs.clips.run <= 1, 'one clip, shared by every video');
    assert.equal(report.jobs.tiles.run, report.levels.reduce((n, l) => n + l.tiles, 0));
    const again = await buildScene({ scenePath: repeated, outDir: path.join(dir, 'repeated-dist'), jobs: 8, rebuild: true });
    assert.equal(again.report.jobs.tiles.run, report.jobs.tiles.run, 'also with --rebuild');
  });

  it('can delete its intermediates after a build, and vmap clean removes the cache', { timeout: 120_000 }, async () => {
    const { report } = await buildScene({ scenePath, jobs: 4, keepCache: false, overrides: { output: { tileCrf: 30 } } });
    assert.equal(report.cacheCleared, true);
    const left = await readdir(cacheDir());
    assert.ok(!left.includes('clips') && !left.includes('masters'), `left: ${left}`);
    assert.ok(left.includes('probes.json'));

    const again = await buildScene({ scenePath, jobs: 4 });
    assert.equal(again.report.jobs.clips.run, 3, 'the next build starts from the sources');
    assert.ok(again.report.sizes.cache > 0);

    const foreign = path.join(dir, 'src');
    await assert.rejects(cleanCache(foreign), /doesn't look like a vmap build cache/);
    assert.ok(await exists(foreign));
    assert.ok((await cleanCache(cacheDir())) > 0);
    assert.ok(!(await exists(cacheDir())));
    assert.equal(await cleanCache(cacheDir()), null);
  });
});
