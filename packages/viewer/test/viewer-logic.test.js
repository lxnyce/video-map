import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPyramid, occupiedTiles } from '@videomap/core';
import { Camera } from '../src/camera.js';
import { TIERS, detectTier } from '../src/device.js';
import { formatHash, parseHash } from '../src/hash.js';
import { byDistance, chooseLevel, idealLevel, occupancy, tilesInRect } from '../src/lod.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('Camera', () => {
  const make = () => {
    const c = new Camera(6400, 3600);
    c.setViewport(1280, 720);
    c.set(c.homeView());
    return c;
  };

  it('starts fitted and centered', () => {
    const c = make();
    close(c.x, 3200);
    close(c.y, 1800);
    close(c.zoom, 0.2 * 0.94);
  });

  it('converts between screen and content coordinates', () => {
    const c = make();
    c.set({ x: 1000, y: 800, zoom: 1 });
    const p = c.screenToContent(100, 50);
    const s = c.contentToScreen(p.x, p.y);
    close(s.x, 100);
    close(s.y, 50);
    close(c.screenToContent(640, 360).x, 1000);
  });

  it('zooms about the cursor', () => {
    const c = make();
    c.set({ x: 3200, y: 1800, zoom: 0.5 });
    const before = c.screenToContent(300, 200);
    c.zoomAt(2, 300, 200);
    const after = c.screenToContent(300, 200);
    close(before.x, after.x);
    close(before.y, after.y);
    close(c.zoom, 1);
  });

  it('clamps zoom and keeps the wall on screen', () => {
    const c = make();
    c.set({ x: -5000, y: 99999, zoom: 50 });
    assert.equal(c.zoom, c.maxZoom);
    const r = c.visibleRect();
    assert.ok(r.x0 >= 0 && r.y1 <= 3600);
    c.set({ x: 0, y: 0, zoom: 0.0001 });
    close(c.zoom, c.minZoom);
    const small = c.visibleRect();
    assert.ok(small.x0 <= 0 && small.x1 >= 6400 && small.y0 <= 0 && small.y1 >= 3600, 'a wall smaller than the screen stays fully visible');
    c.set({ x: 3000, y: 1700, zoom: c.minZoom });
    close(c.x, 3000, 1e-6);
  });

  it('pans with the pointer direction', () => {
    const c = make();
    c.set({ x: 3200, y: 1800, zoom: 1 });
    c.panBy(100, -50);
    close(c.x, 3100);
    close(c.y, 1850);
  });

  it('animates flights to the exact target and decays flings', () => {
    const c = make();
    c.flyTo({ x: 1000, y: 1000, zoom: 1 }, 0, 500);
    assert.ok(c.moving);
    c.step(250);
    assert.ok(c.zoom > 0.188 && c.zoom < 1);
    c.step(500);
    assert.ok(!c.moving);
    assert.deepEqual(c.view, { x: 1000, y: 1000, zoom: 1 });

    c.fling(1, 0, 1000);
    let t = 1000;
    while (c.moving && t < 10000) c.step((t += 16));
    assert.ok(!c.moving, 'fling stops');
    assert.ok(c.x < 1000, 'moved in the fling direction');
  });

  it('frames a rectangle', () => {
    const c = make();
    const v = c.viewForRect({ x: 1000, y: 1000, w: 320, h: 180 }, { fraction: 0.5 });
    close(v.zoom, 2, 1e-9); // limited by maxZoom (640/320 = 2)
    close(v.x, 1160);
    close(v.y, 1090);
  });
});

describe('level of detail', () => {
  const p = createPyramid({ cols: 20, rows: 20, cell: { w: 384, h: 216 }, k: { x: 2, y: 2 } });
  const cells = Array.from({ length: 400 }, (_, i) => ({ col: i % 20, row: Math.floor(i / 20) }));
  const tiles = occupiedTiles(p, cells);
  const levels = p.levels.map((l) => ({ ...l, tiles: tiles[l.z] }));
  const occupied = occupancy(levels);

  it('picks the coarsest level that is sharp enough', () => {
    assert.equal(idealLevel(levels, 0.1, 1), 0);
    assert.equal(idealLevel(levels, 0.12, 1), 1);
    assert.equal(idealLevel(levels, 0.5, 1), 3);
    assert.equal(idealLevel(levels, 0.5, 2), 4);
    assert.equal(idealLevel(levels, 5, 2), 4, 'never beyond the deepest level');
    assert.equal(idealLevel(levels, 0.5, 1, 0.5), 2, 'bias accepts coarser tiles');
  });

  it('lists visible tiles that exist', () => {
    const all = { x0: 0, y0: 0, x1: 7680, y1: 4320 };
    assert.equal(tilesInRect(levels[4], p.tile, all, occupied[4]).length, 100);
    assert.deepEqual(tilesInRect(levels[4], p.tile, { x0: 700, y0: 400, x1: 800, y1: 450 }, occupied[4]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
    assert.deepEqual(tilesInRect(levels[0], p.tile, all, occupied[0]), [[0, 0]]);
    assert.deepEqual(tilesInRect(levels[4], p.tile, { x0: -500, y0: -500, x1: -1, y1: -1 }, occupied[4]), []);
  });

  it('coarsens until the visible tiles fit the decoder budget', () => {
    const rect = { x0: 0, y0: 0, x1: 2560, y1: 1440 }; // 3.3 × 3.3 deepest tiles
    const deep = chooseLevel({ levels, tile: p.tile, occupied, rect, zoom: 0.5, pixelRatio: 2, bias: 1, budget: 16 });
    assert.equal(deep.z, 4);
    assert.equal(deep.tiles.length, 16);
    const low = chooseLevel({ levels, tile: p.tile, occupied, rect, zoom: 0.5, pixelRatio: 2, bias: 1, budget: 4 });
    assert.equal(low.ideal, 4);
    assert.equal(low.z, 3);
    assert.ok(low.tiles.length <= 4);
  });

  it('orders tiles nearest the view center first', () => {
    const order = byDistance([[0, 0], [2, 2], [1, 1]], levels[4], p.tile, 1.5 * 768, 1.5 * 432);
    assert.deepEqual(order[0], [1, 1]);
  });
});

describe('deep links', () => {
  it('round-trips camera and video', () => {
    const hash = formatHash({ cam: { x: 1234.56, y: 78.9, zoom: 0.123456 }, v: 'reef 01' });
    assert.equal(hash, '#cam=1235,79,0.1235&v=reef%2001');
    assert.deepEqual(parseHash(hash), { v: 'reef 01', cam: { x: 1235, y: 79, zoom: 0.1235 } });
  });

  it('ignores junk', () => {
    assert.deepEqual(parseHash('#cam=a,b,c&v=&x=1&%E0'), { v: null, cam: null });
    assert.equal(formatHash({}), '');
  });
});

describe('device tiers', () => {
  it('classifies typical devices', () => {
    const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', hardwareConcurrency: 6 };
    assert.equal(detectTier(iphone).name, 'mid');
    const budgetAndroid = { userAgent: 'Mozilla/5.0 (Linux; Android 11; Moto) Mobile', hardwareConcurrency: 8, deviceMemory: 2 };
    assert.equal(detectTier(budgetAndroid).name, 'low');
    const desktop = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', hardwareConcurrency: 12, deviceMemory: 8 };
    assert.equal(detectTier(desktop, 'ANGLE (NVIDIA GeForce RTX 3060)').name, 'high');
    assert.equal(detectTier(desktop, 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))').name, 'low');
  });

  it('accepts URL overrides', () => {
    const t = detectTier({ userAgent: 'x', hardwareConcurrency: 16 }, '', new URLSearchParams('tier=low&budget=6'));
    assert.equal(t.name, 'low');
    assert.equal(t.budget, 6);
    assert.equal(TIERS.low.budget, 4, 'presets are not mutated');
  });
});
