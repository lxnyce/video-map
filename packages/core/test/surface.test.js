import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { mercator, surfaceAspect, surfaceGeometry, surfaceHit, surfacePoint, surfaceScale, wallPoint, wrapDelta } from '../src/surface.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('surface geometry', () => {
  it('is null for the plane', () => {
    assert.equal(surfaceGeometry({ type: 'plane' }, 100, 100), null);
    assert.equal(surfaceGeometry(undefined, 100, 100), null);
  });

  it('wraps a cylinder so the arc length is the wall width', () => {
    const g = surfaceGeometry({ type: 'cylinder', arc: 360 }, 6000, 1500);
    close(g.radius, 6000 / (2 * Math.PI));
    assert.ok(g.wrap && g.inside);
    const half = surfaceGeometry({ type: 'cylinder', arc: 180, view: 'outside' }, 3000, 1500);
    close(half.radius, 3000 / Math.PI);
    assert.ok(!half.wrap && !half.inside);
  });

  it('puts the middle of the wall in front of the viewer and reads left to right from either side', () => {
    for (const view of ['inside', 'outside']) {
      for (const type of ['cylinder', 'sphere']) {
        const g = surfaceGeometry(/** @type {any} */ ({ type, view }), 4000, 1600);
        const mid = surfacePoint(g, 2000, 800);
        // Inside, the camera at the origin looks down -z; outside, it sits at +z looking back. Either way +x is right.
        close(mid.p[0], 0);
        assert.equal(Math.sign(mid.p[2]), view === 'inside' ? -1 : 1);
        assert.ok(surfacePoint(g, 2100, 800).p[0] > 0, `${type} ${view}: x grows to the right`);
        assert.ok(surfacePoint(g, 2000, 700).p[1] > mid.p[1], `${type} ${view}: smaller y is higher`);
      }
    }
  });

  it('maps wall pixels to the surface and back', () => {
    for (const spec of [{ type: 'cylinder' }, { type: 'cylinder', arc: 120, view: 'outside' }, { type: 'sphere' }, { type: 'sphere', arc: 200, latitudeBand: [-30, 70], view: 'outside' }]) {
      const g = surfaceGeometry(/** @type {any} */ (spec), 4000, 1600);
      for (const [x, y] of [[10, 10], [2000, 800], [3990, 1590], [1234, 321]]) {
        const { p, n } = surfacePoint(g, x, y);
        const back = wallPoint(g, p);
        close(back.x, x, 1e-6);
        close(back.y, y, 1e-6);
        close(Math.hypot(...n), 1);
      }
    }
  });

  it('joins the two ends of a 360° wall', () => {
    const g = surfaceGeometry({ type: 'cylinder' }, 6000, 1500);
    assert.ok(dist(surfacePoint(g, 0, 700).p, surfacePoint(g, 6000, 700).p) < 1e-6);
    close(wallPoint(g, surfacePoint(g, 5999, 700).p).x, 5999, 1e-6);
    close(wrapDelta(5900 - 100, 6000), -200);
    close(wrapDelta(100 - 5900, 6000), 200);
  });

  it('keeps shapes on the sphere: Mercator scales both directions alike', () => {
    const g = surfaceGeometry({ type: 'sphere' }, 6000, 2400);
    for (const y of [g.height / 2, 200, 2200]) {
      const a = surfacePoint(g, 3000, y).p;
      const h = dist(a, surfacePoint(g, 3001, y).p);
      const v = dist(a, surfacePoint(g, 3000, y + 1).p);
      close(h / v, 1, 1e-3);
      close(h, surfaceScale(g, y), 1e-3);
    }
    assert.ok(surfaceScale(g, 100) < 0.6, 'videos near the band edge are smaller');
  });

  it('centers a wall in the latitude band when the shapes differ', () => {
    // Too tall for the band: spans less longitude, so it doesn't wrap.
    const tall = surfaceGeometry({ type: 'sphere' }, 1600, 1600);
    assert.ok(!tall.wrap);
    close(tall.radius, 1600 / (2 * mercator(Math.PI / 3)));
    const top = surfacePoint(tall, 800, 0).p;
    close(Math.asin(top[1] / tall.radius), Math.PI / 3, 1e-9);
    // Too wide: spans less latitude.
    const wide = surfaceGeometry({ type: 'sphere' }, 8000, 1000);
    assert.ok(wide.wrap);
    assert.ok(Math.asin(surfacePoint(wide, 4000, 0).p[1] / wide.radius) < Math.PI / 3);
  });

  it('finds the wall pixel a ray sees', () => {
    const inside = surfaceGeometry({ type: 'sphere' }, 6000, 2400);
    const target = surfacePoint(inside, 4200, 900).p;
    const hit = surfaceHit(inside, [0, 0, 0], target);
    close(hit.x, 4200, 1e-6);
    close(hit.y, 900, 1e-6);

    const outside = surfaceGeometry({ type: 'cylinder', view: 'outside' }, 6000, 1500);
    const r = outside.radius;
    // From in front, straight at the axis: the near side, the middle of the wall.
    const front = surfaceHit(outside, [0, 0, r * 3], [0, 0, -1]);
    close(front.x, 3000, 1e-6);
    close(front.y, 750, 1e-6);
    assert.equal(surfaceHit(outside, [0, 0, r * 3], [0, 1, 0]), null, 'a miss');
    assert.equal(surfaceHit(outside, [0, 0, r * 3], [0, 0.5, -1]), null, 'above the wall');
    // An arc seen from behind: the ray reaches only the back of the wall.
    const arc = surfaceGeometry({ type: 'cylinder', arc: 90, view: 'outside' }, 1500, 600);
    assert.ok(surfaceHit(arc, [0, 0, arc.radius * 3], [0, 0, -1]));
    assert.equal(surfaceHit(arc, [0, 0, -arc.radius * 3], [0, 0, 1]), null);
  });
});

describe('surface aspect', () => {
  it('shapes the wall to fill the surface', () => {
    close(surfaceAspect({ type: 'cylinder', arc: 360 }), (2 * Math.PI) / 1.5);
    close(surfaceAspect({ type: 'sphere', latitudeBand: [-60, 60] }), (2 * Math.PI) / (2 * mercator(Math.PI / 3)));
    assert.equal(surfaceAspect({ type: 'plane' }), null);
  });

  it('is the default layout aspect for a curved surface, unless the scene sets one', () => {
    close(resolveConfig({ surface: { type: 'cylinder' } }).layout.aspect, (2 * Math.PI) / 1.5);
    close(resolveConfig({ surface: { type: 'cylinder' }, layout: { aspect: '2:1' } }).layout.aspect, 2);
    close(resolveConfig({ videos: [] }, { surface: { type: 'sphere' }, layout: { aspect: '3:1' } }).layout.aspect, 3);
    close(resolveConfig({ videos: [] }).layout.aspect, 16 / 9);
  });
});
