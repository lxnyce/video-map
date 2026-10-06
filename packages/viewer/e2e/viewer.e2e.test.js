// End-to-end: build tiny scenes with ffmpeg, serve them, and drive the viewer in
// Chromium: a grid wall with full renditions and an alternate layout, and a
// tiles-only masonry wall whose videos cross tile edges. Tiles are built in H.264 and VP9 so the video
// path runs even in Chromium builds without H.264. Skipped when ffmpeg or a
// Playwright browser is missing.
//
//   npm run test:e2e

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
const CURVED = {
  cylinder: { type: 'cylinder', arc: 360, latitudeBand: [-60, 60], view: 'inside' },
  sphere: { type: 'sphere', arc: 360, latitudeBand: [-60, 60], view: 'outside' },
};
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
      videos[i] = { id: `v${i}`, src: file, title: `Video ${i}`, categories: [cats[i % 3]], tags: ['test', `place:${i % 2 ? 'Kyoto' : 'Lima'}`] };
    }));
    await writeFile(path.join(dir, 'scene.json'), JSON.stringify({
      title: 'E2E wall',
      categories: cats.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
      preview: { duration: 2, fps: 10 },
      output: { cell: '256x144', tile: '512x288', tileCodecs: ['h264', 'vp9'] },
      build: { hardware: 'off' },
      layouts: [{ id: 'place', groupBy: 'tag:place' }],
      videos,
    }));
    await buildScene({ scenePath: path.join(dir, 'scene.json'), jobs: 4 });
    // The surface is only a viewer setting, so curved walls are copies of the grid build with a different surface.
    for (const [name, surface] of Object.entries(CURVED)) {
      await cp(path.join(dir, 'dist'), path.join(dir, name), { recursive: true });
      const file = path.join(dir, name, 'scene.json');
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), surface }));
    }

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
    for (const name of Object.keys(CURVED)) await rename(path.join(dir, name), path.join(dir, 'dist', name));
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
    // The first video whose middle isn't under the title or search bar.
    const target = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      for (const video of v.scene.videos) {
        const r = v.screenRect(video);
        const x = r.x + r.w / 2;
        const y = r.y + r.h / 2;
        if (document.elementFromPoint(x, y) === v.canvas) return { id: video.id, n: video.id.slice(1), x, y };
      }
      return null;
    });
    await page.mouse.click(target.x, target.y);
    await page.waitForSelector('.vm-window');
    await page.waitForTimeout(500); // open animation
    assert.equal(await page.getAttribute('.vm-window', 'aria-label'), `Video ${target.n}`);
    assert.equal(await page.getAttribute('.vm-leader', 'visibility'), 'visible');
    assert.equal(await page.getAttribute('.vm-window video', 'src'), `media/${target.id}.mp4`);
    await page.waitForFunction((id) => location.hash.includes(`v=${id}`), target.id);

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

  /** Viewport point of a video's middle on the wall, and whether it's in view. */
  const videoPoint = (page, id) => page.evaluate((vid) => {
    const v = /** @type {any} */ (window).VideoMap.instances[0];
    const r = v.byId.get(vid).rect;
    return v.camera.project(r.x + r.w / 2, r.y + r.h / 2);
  }, id);

  it('plays a wall wrapped inside a cylinder, picks on the curve, and wraps at the seam', async () => {
    const page = await open('', { width: 1280, height: 760 }, {}, 'cylinder/');
    await page.waitForFunction(() => /** @type {any} */ (window).VideoMap.instances[0]?.pool.slots.some((s) => s.state === 'playing'), null, { timeout: 15_000 });
    const info = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      // A video well off to the side, where the wall curves most on screen.
      const p = v.camera.screenToContent(1000, 380);
      return { id: v.index.at(p.x, p.y)?.id, label: v.canvas.getAttribute('aria-label'), width: v.scene.content.width };
    });
    assert.ok(info.id, 'a video at the side of the screen');
    assert.match(info.label, /cylinder of 14 videos\. Drag to look around/);
    await page.mouse.click(1000, 380);
    await page.waitForSelector('.vm-window');
    assert.equal(await page.getAttribute('.vm-window', 'aria-label'), `Video ${info.id.slice(1)}`);
    await page.waitForTimeout(500);
    assert.equal(await page.getAttribute('.vm-leader', 'visibility'), 'visible');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vm-window'));

    // Drag right past the left end of the wall: the camera comes round to its right end.
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(300, 400);
      await page.mouse.down();
      await page.mouse.move(1100, 400, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      return { x: v.camera.x, tiles: v.state.tiles.length, budget: v.pool.size };
    });
    assert.ok(after.x >= 0 && after.x < info.width, `x stays on the wall (${after.x})`);
    assert.ok(after.tiles <= after.budget);
    await page.close();
  });

  it('turns a sphere seen from outside, and only picks the side facing the camera', async () => {
    const page = await open('#v=v7', { width: 1280, height: 760 }, {}, 'sphere/');
    await page.waitForSelector('.vm-window');
    await page.waitForTimeout(600);
    // The deep link turns the sphere so the video faces the camera.
    const pt = await videoPoint(page, 'v7');
    assert.ok(pt.visible);
    assert.ok(Math.abs(pt.x - 640) < 200 && Math.abs(pt.y - 380) < 200, `v7 near the middle (${pt.x}, ${pt.y})`);
    await page.focus('.vm-canvas');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vm-window'));

    const back = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      v.camera.set(v.camera.homeView());
      const far = v.scene.videos.map((x) => ({ id: x.id, p: v.camera.project(x.rect.x + x.rect.w / 2, x.rect.y + x.rect.h / 2) })).find((x) => !x.p.visible);
      return { far: far?.id ?? null, corner: v.pick(4, 4) };
    });
    assert.ok(back.far, 'some videos are round the back');
    assert.equal(back.corner, null, 'the space around the sphere picks nothing');
    await page.waitForTimeout(300);
    await page.mouse.click(640, 380);
    await page.waitForSelector('.vm-window');
    const opened = await page.getAttribute('.vm-window', 'aria-label');
    assert.notEqual(opened, `Video ${back.far.slice(1)}`);
    await page.close();
  });

  /**
   * Render now and read the wall's color at a viewport point (the drawing buffer is
   * only readable before the frame is shown).
   */
  const pixel = (page, x, y) => page.evaluate(([px, py]) => {
    const v = /** @type {any} */ (window).VideoMap.instances[0];
    v.render(v.state.z, v.state.tiles, performance.now());
    const gl = v.renderer.gl;
    const out = new Uint8Array(4);
    const r = v.renderer.ratio;
    gl.readPixels(Math.round(px * r), Math.round(v.canvas.height - py * r), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0], out[1], out[2]];
  }, [x, y]);
  const brightness = (c) => c[0] + c[1] + c[2];

  it('searches and filters: dims the rest, counts matches per group, and keeps the filter in the URL', async () => {
    const page = await open('&videos=0');
    const center = (id) => page.evaluate((vid) => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      const r = v.screenRect(v.byId.get(vid));
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }, id);
    const other = await center('v2');
    const before = brightness(await pixel(page, other.x, other.y));
    await page.fill('.vm-search', 'video 1');
    await page.waitForFunction(() => location.hash.includes('q=video%201'));
    const found = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      return v.scene.videos.filter((_, i) => v.matches[i]).map((x) => x.id);
    });
    assert.deepEqual(found, ['v1', 'v10', 'v11', 'v12', 'v13']);
    assert.equal(await page.textContent('.vm-search-count'), '5/14');
    const after = brightness(await pixel(page, other.x, other.y));
    assert.ok(after < before * 0.5, `a video that doesn't match is dimmed (${before} → ${after})`);
    const match = await center('v1');
    assert.ok(brightness(await pixel(page, match.x, match.y)) > after, 'a match is not');
    const labels = await page.$$eval('.vm-label-count', (els) => els.map((e) => e.textContent));
    assert.deepEqual(labels.sort(), ['1/4', '1/5', '3/5']);

    // The list shows the same five, under their groups; a category chip narrows it.
    await page.click('.vm-browse');
    assert.equal(await page.locator('.vm-list .vm-row:visible').count(), 5);
    assert.equal(await page.locator('.vm-list-group:visible').count(), 3);
    await page.click('.vm-fchip[data-value="city"]');
    assert.equal(await page.locator('.vm-list .vm-row:visible').count(), 3);
    assert.equal(await page.textContent('.vm-results > span'), '3 of 14 videos');
    await page.waitForFunction(() => location.hash.includes('cat=city'));
    await page.click('.vm-results .vm-link-btn:has-text("Clear")');
    assert.equal(await page.locator('.vm-list .vm-row:visible').count(), 14);
    assert.equal(await page.inputValue('.vm-search'), '');
    await page.waitForFunction(() => !location.hash.includes('q='));

    // A filter in the URL is applied on load.
    const linked = await open('&videos=0#tag=place%3AKyoto&q=video');
    assert.equal(await linked.textContent('.vm-search-count'), '7/14');
    await linked.close();
    await page.close();
  });

  it('opens a video from the list, and flies to a group from its label', async () => {
    const page = await open('&videos=0');
    await page.click('.vm-browse');
    await page.click('.vm-row[data-video="4"]');
    await page.waitForSelector('.vm-window');
    assert.equal(await page.getAttribute('.vm-window', 'aria-label'), 'Video 4');
    await page.waitForTimeout(900); // camera flight
    const placed = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      const r = v.screenRect(v.byId.get('v4'));
      const panel = document.querySelector('.vm-panel').getBoundingClientRect();
      const win = document.querySelector('.vm-window').getBoundingClientRect();
      return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, panelRight: panel.right, win: { x: win.left, y: win.top, r: win.right, b: win.bottom } };
    });
    assert.ok(placed.cx > placed.panelRight, 'the video is clear of the panel');
    const inWin = placed.cx > placed.win.x && placed.cx < placed.win.r && placed.cy > placed.win.y && placed.cy < placed.win.b;
    assert.ok(!inWin, 'and of its window');
    await page.keyboard.press('Escape');
    await page.click('.vm-browse');

    await page.click('.vm-label:has-text("Forest")');
    await page.waitForTimeout(900);
    const group = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      const g = v.scene.groups.find((x) => x.label === 'Forest');
      return { g: v.wallToScreen(g), vw: v.camera.vw, vh: v.camera.vh };
    });
    assert.ok(group.g.x >= -1 && group.g.y >= -1 && group.g.x + group.g.w <= group.vw + 1 && group.g.y + group.g.h <= group.vh + 1, 'the whole group is in view');
    assert.ok(group.g.w > group.vw * 0.5 || group.g.h > group.vh * 0.5, 'and fills the screen');
    await page.close();
  });

  it('switches to a pre-baked layout and back, with the layout in the URL', async () => {
    const page = await open('#layout=place');
    await page.waitForFunction(() => /** @type {any} */ (window).VideoMap.instances[0]?.pool.slots.some((s) => s.state === 'playing'), null, { timeout: 15_000 });
    const s = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      return { wall: v.wall.id, groups: v.scene.groups.map((g) => g.label), srcs: v.pool.slots.map((x) => x.el.getAttribute('src')).filter(Boolean) };
    });
    assert.equal(s.wall, 'place');
    assert.deepEqual(s.groups, ['Kyoto', 'Lima']);
    assert.ok(s.srcs.length && s.srcs.every((u) => u.includes('/layouts/place/tiles/')), s.srcs.join(' '));
    assert.equal(await page.locator('.vm-label').count(), 2);
    assert.match(await page.textContent('.vm-titlebar p'), /By place/);

    // Clicking a video opens the right one in this layout.
    const t = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      const r = v.screenRect(v.byId.get('v3'));
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    });
    await page.mouse.click(t.x, t.y);
    await page.waitForSelector('.vm-window');
    assert.equal(await page.getAttribute('.vm-window', 'aria-label'), 'Video 3');

    await page.click('.vm-browse');
    await page.click('.vm-seg-btn[data-layout="default"]');
    await page.waitForFunction(() => !location.hash.includes('layout='));
    assert.equal(await page.locator('.vm-label').count(), 3);
    const back = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      const p = v.camera.project ? null : v.camera.contentToScreen(v.byId.get('v3').rect.x, v.byId.get('v3').rect.y);
      return { wall: v.wall.id, open: v.players.focused?.video.id, p, vw: v.camera.vw, vh: v.camera.vh };
    });
    assert.equal(back.wall, 'default');
    assert.equal(back.open, 'v3', 'the window stays open');
    assert.ok(back.p.x > -50 && back.p.x < back.vw && back.p.y > -50 && back.p.y < back.vh, 'and its video is still in view');
    await page.close();
  });

  it('shows a minimap once zoomed in, and moves the camera from it', async () => {
    const page = await open('&videos=0');
    assert.ok(await page.isHidden('.vm-minimap'), 'not while the whole wall is in view');
    await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      v.camera.set({ x: 200, y: 200, zoom: 2 });
      v.moved = true;
    });
    await page.waitForSelector('.vm-minimap:visible');
    const box = await page.locator('.vm-minimap').boundingBox();
    await page.mouse.click(box.x + box.width - 3, box.y + box.height - 3);
    await page.waitForTimeout(500);
    const cam = await page.evaluate(() => {
      const v = /** @type {any} */ (window).VideoMap.instances[0];
      return { x: v.camera.x, y: v.camera.y, w: v.scene.content.width, h: v.scene.content.height };
    });
    assert.ok(cam.x > cam.w * 0.6 && cam.y > cam.h * 0.6, `camera moved toward the bottom right (${cam.x}, ${cam.y})`);
    await page.close();
  });

  it('browses full screen on a phone, and opens the chosen video in a sheet', async () => {
    const page = await open('&videos=0', { width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    assert.ok(await page.isHidden('.vm-search'), 'just a button until opened');
    await page.tap('.vm-browse');
    const side = await page.locator('.vm-side').boundingBox();
    assert.deepEqual([side.x, side.y, side.width, side.height], [0, 0, 390, 844]);
    await page.fill('.vm-search', 'video 7');
    await page.tap('.vm-row[data-video="7"]');
    await page.waitForSelector('.vm-window.vm-sheet');
    assert.ok(await page.isHidden('.vm-panel'), 'the panel closes');
    await page.close();
  });

  it('logged no page errors', () => {
    // Media decode errors for H.264 full renditions are expected in Chromium builds without H.264.
    assert.deepEqual(errors.filter((e) => !/Failed to load resource|MEDIA_ERR|NotSupportedError/.test(e)), []);
  });
});
