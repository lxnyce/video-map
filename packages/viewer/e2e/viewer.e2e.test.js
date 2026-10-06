// End-to-end: build tiny scenes with ffmpeg, serve them, and drive the viewer in
// Chromium: a grid wall with full renditions, and a tiles-only masonry wall
// whose videos cross tile edges. Tiles are built in H.264 and VP9 so the video
// path runs even in Chromium builds without H.264. Skipped when ffmpeg or a
// Playwright browser is missing.
//
//   npm run test:e2e

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { buildScene } from '@videomap/builder';
import { startServer } from '../../cli/src/server.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
let chromium = null;
try {
  ({ chromium } = await import('playwright'));
  await (await chromium.launch()).close();
} catch {
  chromium = null;
}
const skip = !hasFfmpeg ? 'ffmpeg not installed' : !chromium ? 'no Playwright browser (npx playwright install chromium)' : false;
const GL_ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

describe('viewer (browser)', { skip, timeout: 240_000 }, () => {
  let dir;
  let server;
  let base;
  let browser;
  const errors = [];

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-e2e-'));
    await mkdir(path.join(dir, 'src'));
    const videos = [];
    const cats = ['ocean', 'city', 'forest'];
    await Promise.all(Array.from({ length: 14 }, async (_, i) => {
      const file = `src/v${i}.mp4`;
      await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=20:d=${2 + (i % 3)}`,
        '-vf', `hue=h=${i * 25}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, file)]);
      videos[i] = { id: `v${i}`, src: file, title: `Video ${i}`, categories: [cats[i % 3]], tags: ['test'] };
    }));
    await writeFile(path.join(dir, 'scene.json'), JSON.stringify({
      title: 'E2E wall',
      categories: cats.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
      preview: { duration: 2, fps: 10 },
      output: { cell: '256x144', tile: '512x288', tileCodecs: ['h264', 'vp9'] },
      build: { hardware: 'off' },
      videos,
    }));
    await buildScene({ scenePath: path.join(dir, 'scene.json'), jobs: 4 });

    // Masonry, tiles only: portrait, landscape and square videos, free to cross tile edges.
    const shapes = ['320x180', '180x320', '240x240'];
    await Promise.all(shapes.map((s, i) => run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${s}:r=20:d=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, `src/shape${i}.mp4`)])));
    await mkdir(path.join(dir, 'masonry'));
    await writeFile(path.join(dir, 'masonry/scene.json'), JSON.stringify({
      title: 'Masonry wall',
      categories: cats.map((id) => ({ id })),
      preview: { duration: 2, fps: 10 },
      layout: { pack: 'masonry', columnWidth: 128, avoidSplits: false },
      output: { tile: '256x200', tileCodecs: ['h264', 'vp9'], full: { enabled: false } },
      build: { hardware: 'off' },
      videos: Array.from({ length: 18 }, (_, i) => ({ id: `m${i}`, src: `../src/shape${i % 3}.mp4`, title: `Masonry ${i}`, categories: [cats[i % 3]], tags: ['shape'] })),
    }));
    await buildScene({ scenePath: path.join(dir, 'masonry/scene.json'), jobs: 4 });
    // One server for both walls: the grid at /, the masonry wall at /masonry/.
    await rename(path.join(dir, 'masonry/dist'), path.join(dir, 'dist/masonry'));
    ({ server } = await startServer({ root: path.join(dir, 'dist'), port: 0, host: '127.0.0.1' }));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/`;
    browser = await chromium.launch({ args: GL_ARGS });
  });

  after(async () => {
    await browser?.close();
    server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function open(query = '', viewport = { width: 1280, height: 760 }, extra = {}, wall = '') {
    const page = await browser.newPage({ viewport, ...extra });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}${wall}?adapt=0${query}`);
    await page.waitForSelector('.vm-loading.vm-done', { timeout: 20_000 });
    return page;
  }

  const viewerState = (page) => page.evaluate(() => {
    const v = /** @type {any} */ (window).VideoMap.instances[0];
    return {
      z: v.state.z,
      tiles: v.state.tiles.length,
      playing: v.pool.slots.filter((s) => s.state === 'playing').length,
      poolSize: v.pool.size,
      codec: v.videoSource?.mime ?? null,
      zoom: v.camera.zoom,
      windows: v.players.windows.length,
    };
  });

  it('paints the wall and plays tile videos', async () => {
    const page = await open();
    await page.waitForFunction(() => /** @type {any} */ (window).VideoMap.instances[0]?.pool.slots.some((s) => s.state === 'playing'), null, { timeout: 15_000 });
    const s = await viewerState(page);
    assert.ok(s.codec, 'picked a playable tile codec');
    assert.ok(s.playing >= 1);
    assert.ok(s.playing <= s.poolSize);
    assert.equal(await page.locator('.vm-label').count(), 3, 'one label per group');
    await page.close();
  });

  it('switches to finer levels when zooming, within the decoder budget', async () => {
    const page = await open('&budget=4', { width: 640, height: 400 });
    const before = await viewerState(page);
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, -250);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(1500);
    const afterZoom = await viewerState(page);
    assert.ok(afterZoom.zoom > before.zoom * 1.8);
    assert.ok(afterZoom.z > before.z, `level ${before.z} → ${afterZoom.z}`);
    assert.ok(afterZoom.playing <= 4, 'never more videos than the budget');
    assert.match(await page.evaluate(() => location.hash), /^#cam=/, 'camera is in the URL');
    await page.close();
  });

  it('opens a linked player window on click and closes it with Escape', async () => {
    const page = await open();
    const target = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      const video = v.scene.videos[0];
      const r = v.screenRect(video);
      return { id: video.id, x: r.x + r.w / 2, y: r.y + r.h / 2 };
    });
    await page.mouse.click(target.x, target.y);
    await page.waitForSelector('.vm-window');
    await page.waitForTimeout(500); // open animation
    assert.equal(await page.getAttribute('.vm-window', 'aria-label'), 'Video 0');
    assert.equal(await page.getAttribute('.vm-leader', 'visibility'), 'visible');
    assert.equal(await page.getAttribute('.vm-window video', 'src'), 'media/v0.mp4');
    await page.waitForFunction(() => location.hash.includes('v=v0'));

    await page.click('[data-act="max"]');
    assert.ok(await page.$('.vm-window.vm-max'));
    await page.click('[data-act="max"]');
    await page.focus('.vm-canvas');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vm-window'));
    await page.close();
  });

  it('restores a deep link on a phone, keeping the cell visible above the sheet', async () => {
    const page = await open('#v=v5', { width: 390, height: 844 }, { deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.waitForSelector('.vm-window.vm-sheet');
    await page.waitForTimeout(1000); // camera flight
    const { cell, sheetTop } = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      return { cell: v.screenRect(v.byId.get('v5')), sheetTop: document.querySelector('.vm-window').getBoundingClientRect().top };
    });
    assert.ok(cell.y + cell.h / 2 < sheetTop, 'cell center is above the sheet');
    assert.ok(cell.y + cell.h / 2 > 0);
    await page.close();
  });

  it('opens the right masonry video on either side of a tile edge it crosses', async () => {
    const page = await open('', { width: 1280, height: 760 }, {}, 'masonry/');
    const info = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      const deep = v.levels.length - 1;
      const th = v.tile.h / v.levels[deep].scale;
      const video = v.scene.videos.find((x) => Math.floor(x.rect.y / th) !== Math.floor((x.rect.y + x.rect.h - 1) / th));
      const edge = (Math.floor(video.rect.y / th) + 1) * th;
      v.camera.set(v.camera.viewForRect(video.rect, { fraction: 0.6 }));
      return { id: video.id, edge, rect: video.rect, pack: v.scene.layout.pack, shared: v.shared[deep].size };
    });
    assert.equal(info.pack, 'masonry');
    assert.ok(info.shared > 0, 'tiles sharing a video form sync groups');
    await page.waitForTimeout(400);
    for (const dy of [-6, 6]) {
      const pt = await page.evaluate(([x, y]) => /** @type {any} */ (window).VideoMap.instances[0].camera.contentToScreen(x, y), [info.rect.x + info.rect.w / 2, info.edge + dy]);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForSelector('.vm-window');
      assert.equal(await page.getAttribute('.vm-window', 'aria-label'), `Masonry ${info.id.slice(1)}`, `click ${dy < 0 ? 'above' : 'below'} the tile edge`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.vm-window'));
      await page.waitForTimeout(350); // two quick clicks this close together would be a double tap
    }
    const tight = await page.evaluate(() => /** @type {any} */ (window).VideoMap.instances[0].pool.slots.some((s) => s.tight));
    assert.ok(tight, 'a tile showing part of the split video plays in the tight sync group');
    await page.close();
  });

  it('shows an info card instead of a player in a tiles-only scene', async () => {
    const page = await open('#v=m4', { width: 1280, height: 760 }, {}, 'masonry/');
    await page.waitForSelector('.vm-window.vm-card');
    assert.equal(await page.locator('.vm-window video').count(), 0, 'no player');
    assert.equal(await page.getAttribute('.vm-window .vm-window-poster', 'src'), 'posters/m4.webp');
    assert.ok(await page.isVisible('.vm-window-info'), 'details are shown right away');
    assert.ok(!(await page.isVisible('[data-act="info"]')), 'no details toggle');
    await page.waitForTimeout(800);
    assert.equal(await page.getAttribute('.vm-leader', 'visibility'), 'visible', 'still linked to its place on the wall');
    assert.equal(await page.locator('.vm-label').count(), 3);
    await page.close();
  });

  it('logged no page errors', () => {
    // Media decode errors for H.264 full renditions are expected in Chromium builds without H.264.
    assert.deepEqual(errors.filter((e) => !/Failed to load resource|MEDIA_ERR|NotSupportedError/.test(e)), []);
  });
});
