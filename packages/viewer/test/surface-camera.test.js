import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPyramid, rectTiles, surfaceGeometry, surfacePoint } from '@videomap/core';
import { chooseLevel, occupancy } from '../src/lod.js';
import { SurfaceCamera } from '../src/surface-camera.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const SURFACES = [
  { type: 'cylinder', view: 'inside' },
  { type: 'cylinder', view: 'outside' },
  { type: 'cylinder', arc: 160, view: 'inside' },
  { type: 'sphere', view: 'inside' },
  { type: 'sphere', view: 'outside' },
];

/** @param {any} spec */
function make(spec, w = 6000, h = 1500) {
  const c = new SurfaceCamera(surfaceGeometry(spec, w, h));
  c.setViewport(1280, 720);
  c.set(c.homeView());
  return c;
}

describe('SurfaceCamera', () => {
  for (const spec of SURFACES) {
    const name = `${spec.type} ${spec.view}${spec.arc ? ` ${spec.arc}°` : ''}`;

    it(`${name}: (x, y) is in the middle of the screen at the given zoom`, () => {
      const c = make(spec);
      c.set({ x: 2500, y: 600, zoom: 0.6 });
      const mid = c.project(c.x, c.y);
      close(mid.x, 640, 1e-6);
      close(mid.y, 360, 1e-6);
      assert.ok(mid.visible);
      const hit = c.screenToContent(640, 360);
      close(hit.x, c.x, 1e-6);
      close(hit.y, c.y, 1e-6);
      // One wall pixel across the middle is `zoom` CSS pixels.
      const right = c.project(c.x + 1, c.y);
      const down = c.project(c.x, c.y + 1);
      close(right.x - mid.x, c.zoom, 1e-3);
      close(down.y - mid.y, c.zoom, 1e-3);
    });

    it(`${name}: picks back what it projects`, () => {
      const c = make(spec);
      c.set({ x: 3100, y: 700, zoom: 0.5 });
      for (const [x, y] of [[2900, 600], [3300, 800], [3000, 750]]) {
        const s = c.project(x, y);
        assert.ok(s.visible);
        const p = c.screenToContent(s.x, s.y);
        close(p.x, x, 1e-4);
        close(p.y, y, 1e-4);
      }
    });

    it(`${name}: zooms about the pointer and drags the wall along`, () => {
      const c = make(spec);
      c.set({ x: 3000, y: 750, zoom: 0.5 });
      const before = c.screenToContent(800, 300);
      c.zoomAt(1.5, 800, 300);
      close(c.zoom, 0.75);
      const after = c.screenToContent(800, 300);
      close(after.x, before.x, 0.05);
      close(after.y, before.y, 0.05);

      c.set({ x: 3000, y: 750, zoom: 1 });
      const grabbed = c.screenToContent(640 - 40, 360 - 20);
      c.panBy(40, 20);
      close(c.x, grabbed.x, 1e-6);
      close(c.y, grabbed.y, 1e-6);
    });

    it(`${name}: home shows the wall and the limits hold`, () => {
      const c = make(spec);
      const home = c.homeView();
      close(home.x, 3000);
      assert.ok(c.screenToContent(640, 360), 'the middle of the screen is on the wall');
      if (spec.view === 'outside') {
        // The whole wall is in view: its corners and edges project inside the screen.
        for (const [x, y] of [[3000, 0], [3000, 1500], [0, 750], [5999, 750]]) {
          const s = c.project(x, y);
          assert.ok(s.x >= -1 && s.x <= 1281 && s.y >= -1 && s.y <= 721, `${x},${y} at ${s.x},${s.y}`);
        }
      }
      c.set({ x: 3000, y: 750, zoom: 1e-6 });
      close(c.zoom, c.minZoom, 1e-9);
      if (spec.view === 'inside') {
        const fov = 2 * Math.atan(360 / c.focal(c.zoom, c.y));
        assert.ok(fov <= (100 * Math.PI) / 180 + 1e-9, 'never wider than 100° inside');
      }
      c.set({ x: 3000, y: 750, zoom: 99 });
      assert.equal(c.zoom, c.maxZoom);
    });
  }

  it('wraps a 360° wall: x stays on the wall and flights go the short way', () => {
    const c = make({ type: 'cylinder' });
    c.set({ x: 100, y: 750, zoom: 1 });
    c.panBy(300, 0);
    assert.ok(c.x > 5000 && c.x < 6000, `${c.x}`);
    c.flyTo({ x: 200, y: 750, zoom: 1 }, 0, 500);
    c.step(250);
    assert.ok(c.x > 5500 || c.x < 200, `crosses the seam, not the whole wall (${c.x})`);
    c.step(500);
    close(c.x, 200);
  });

  it('clamps a partial arc like the flat wall', () => {
    const c = make({ type: 'cylinder', arc: 160 });
    c.set({ x: 0, y: 750, zoom: 1 });
    const left = c.screenToContent(1, 360);
    assert.ok(left && left.x >= 0 && left.x < 20, 'the left end of the wall is at the left of the screen');
  });

  it('hides the far side of a sphere seen from outside, and points the way to it', () => {
    const c = make({ type: 'sphere', view: 'outside' });
    const back = c.rectToScreen({ x: 0, y: 700, w: 100, h: 100 });
    assert.equal(back.visible, false);
    assert.ok(back.x < 0 || back.x > 1280 || back.y < 0 || back.y > 720, 'off screen');
    assert.ok(c.rectToScreen({ x: 2950, y: 700, w: 100, h: 100 }).visible);
    assert.equal(c.screenToContent(5, 5), null, 'the corner of the screen is past the sphere');
  });

  it('finds visible tiles on both sides of the seam, nearest first, within the budget', () => {
    const pyramid = createPyramid({ width: 6144, height: 1536, tile: { w: 768, h: 768 } });
    const rects = [{ x: 0, y: 0, w: 6144, h: 1536 }];
    const levels = pyramid.levels.map((l, z) => ({ ...l, tiles: rectTiles(pyramid, rects)[z] }));
    const occupied = occupancy(levels);
    const c = new SurfaceCamera(surfaceGeometry({ type: 'cylinder' }, 6144, 1536));
    c.setViewport(1280, 720);
    c.set({ x: 200, y: 1000, zoom: 1 });
    const deep = levels.length - 1;
    const tiles = c.visibleTiles(levels[deep], pyramid.tile, occupied[deep]);
    const xs = new Set(tiles.map((t) => t[0]));
    assert.ok(xs.has(0) && xs.has(levels[deep].tilesX - 1), `tiles ${[...xs]}`);
    assert.deepEqual(tiles[0], [0, 1], 'the tile in the middle comes first');
    const choice = chooseLevel({ levels, zoom: 1, pixelRatio: 1, bias: 1, budget: 2, tilesAt: (z) => c.visibleTiles(levels[z], pyramid.tile, occupied[z]) });
    assert.ok(choice.tiles.length <= 2 && choice.z < choice.ideal);
  });

  it('builds a view-projection matrix that agrees with project()', () => {
    for (const spec of SURFACES) {
      const c = make(spec);
      c.set({ x: 2800, y: 700, zoom: 0.7 });
      const m = c.matrix();
      const s = c.project(2900, 650);
      const w = surfacePoint(c.geo, 2900, 650).p;
      const clip = [0, 1, 2, 3].map((r) => m[r] * w[0] + m[4 + r] * w[1] + m[8 + r] * w[2] + m[12 + r]);
      const ndc = [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
      close((ndc[0] + 1) * 640, s.x, 1e-2);
      close((1 - ndc[1]) * 360, s.y, 1e-2);
      assert.ok(ndc[2] > -1 && ndc[2] < 1, 'inside the depth range');
    }
  });
});

describe('SurfaceCamera visible bounds', () => {
  it('cover every wall point on screen, and split at the seam of a wrapping wall', () => {
    for (const spec of SURFACES) {
      const c = make(spec);
      for (const x of [3000, 150, 5900]) {
        c.set({ x, y: 700, zoom: c.zoom * 1.5 });
        const regions = c.visibleBounds();
        const name = `${spec.type} ${spec.view}${spec.arc ? ` ${spec.arc}°` : ''} at x=${x}`;
        assert.ok(regions.length >= 1 && regions.length <= 2, name);
        if (c.geo.wrap) for (const r of regions) assert.ok(r.x0 >= 0 && r.x1 <= 6000 + 1e-6, `${name}: inside the wall`);
        for (let sy = 0; sy <= 720; sy += 60) {
          for (let sx = 0; sx <= 1280; sx += 64) {
            const p = c.screenToContent(sx, sy);
            if (!p) continue;
            assert.ok(regions.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1), `${name}: (${sx}, ${sy}) shows (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
          }
        }
        if (c.geo.wrap && spec.view === 'inside' && x === 150) assert.equal(regions.length, 2, `${name}: the view crosses the seam`);
      }
    }
  });
});
