// Camera for curved surfaces. It keeps the flat camera's state (x, y and zoom:
// the wall pixel at the middle of the screen, and CSS pixels per wall pixel
// there), so deep links, flights, flings and Locate work unchanged, and turns
// that state into a 3D pose:
//
//   cylinder, inside   camera on the axis at the row's height, turned toward x
//                      (moving up and down slides along the axis, so rows stay level)
//   sphere, inside     camera at the center, looking at (x, y)
//   outside            camera out along the surface normal at (x, y), looking back at it
//
// Zoom changes the field of view inside and the distance outside.

import { surfaceHit, surfacePoint, surfaceScale, wrapDelta } from '@videomap/core/surface';
import { Camera } from './camera.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Widest view inside, in degrees (vertical, horizontal). */
const MAX_FOV = [100, 120];
/** Vertical field of view of the home view inside a sphere. */
const HOME_FOV = 75;
/** Vertical field of view outside; zoom moves the camera instead. */
const OUTSIDE_FOV = 40;
/** Screen spacing of the rays that find the visible tiles, in CSS px. */
const SAMPLE_STEP = 48;

/**
 * @typedef {object} Pose
 * @property {number[]} eye
 * @property {number[]} fwd
 * @property {number[]} right
 * @property {number[]} up
 * @property {number} f  focal length in CSS px
 */

export class SurfaceCamera extends Camera {
  /**
   * @param {import('@videomap/core/surface').SurfaceGeometry} geo
   * @param {{ maxZoom?: number }} [opts]
   */
  constructor(geo, opts) {
    super(geo.width, geo.height, opts);
    this.geo = geo;
    /** @type {{ key: string, pose: Pose } | null} */
    this.poseCache = null;
    /** @type {{ key: string, points: Array<{ x: number, y: number, d: number }> } | null} */
    this.sampleCache = null;
  }

  // -------------------------------------------------------------------------
  // Pose

  /** World units per wall pixel at a row. */
  scaleAt(y) {
    return surfaceScale(this.geo, y);
  }

  /** Focal length (CSS px) for a zoom at a row. */
  focal(zoom, y) {
    if (this.geo.inside) return (zoom * this.geo.radius) / this.scaleAt(y);
    return this.vh / 2 / Math.tan((OUTSIDE_FOV / 2) * DEG);
  }

  /** Smallest focal length inside: the widest view allowed. */
  get minFocal() {
    return Math.max(this.vh / 2 / Math.tan((MAX_FOV[0] / 2) * DEG), this.vw / 2 / Math.tan((MAX_FOV[1] / 2) * DEG));
  }

  /** @returns {Pose} */
  get pose() {
    const key = `${this.x},${this.y},${this.zoom},${this.vw},${this.vh}`;
    if (this.poseCache?.key !== key) this.poseCache = { key, pose: this.poseFor(this.x, this.y, this.zoom) };
    return this.poseCache.pose;
  }

  /** @returns {Pose} */
  poseFor(x, y, zoom) {
    const g = this.geo;
    const f = this.focal(zoom, y);
    const { p, n } = surfacePoint(g, x, y);
    if (g.inside && g.type === 'cylinder') {
      // Look straight out at the wall from the axis, at the row's height.
      return { eye: [0, p[1], 0], fwd: n, right: [-n[2], 0, n[0]], up: [0, 1, 0], f };
    }
    let eye;
    let fwd;
    if (g.inside) {
      eye = [0, 0, 0];
      fwd = n;
    } else {
      const d = (f * this.scaleAt(y)) / zoom;
      eye = [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d];
      fwd = [-n[0], -n[1], -n[2]];
    }
    const right = normalize(cross(fwd, [0, 1, 0]));
    return { eye, fwd, right, up: cross(right, fwd), f };
  }

  /**
   * Column-major view-projection matrix for WebGL. There's no depth test (the
   * renderer draws in an order that needs none), so near and far only clip.
   */
  matrix() {
    const { eye, fwd, right, up, f } = this.pose;
    const g = this.geo;
    const reach = g.radius * 2 + g.height + Math.hypot(eye[0], eye[1], eye[2]);
    const near = reach * 1e-4;
    const far = reach * 4;
    const sx = (2 * f) / this.vw;
    const sy = (2 * f) / this.vh;
    const a = (far + near) / (far - near);
    const b = (-2 * far * near) / (far - near);
    const rows = [
      [sx * right[0], sx * right[1], sx * right[2], -sx * dot(right, eye)],
      [sy * up[0], sy * up[1], sy * up[2], -sy * dot(up, eye)],
      [a * fwd[0], a * fwd[1], a * fwd[2], -a * dot(fwd, eye) + b],
      [fwd[0], fwd[1], fwd[2], -dot(fwd, eye)],
    ];
    const m = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m[c * 4 + r] = rows[r][c];
    return m;
  }

  // -------------------------------------------------------------------------
  // Projection and picking

  /** Ray direction through a viewport point. */
  ray(sx, sy) {
    const { fwd, right, up, f } = this.pose;
    const dx = sx - this.vw / 2;
    const dy = sy - this.vh / 2;
    return [fwd[0] * f + right[0] * dx - up[0] * dy, fwd[1] * f + right[1] * dx - up[1] * dy, fwd[2] * f + right[2] * dx - up[2] * dy];
  }

  /** The wall pixel under a viewport point, or null off the wall. */
  screenToContent(sx, sy) {
    return surfaceHit(this.geo, this.pose.eye, this.ray(sx, sy));
  }

  /**
   * Where a wall pixel appears, and whether it's in view: in front of the camera
   * and on the side of the wall that faces it.
   * @returns {{ x: number, y: number, visible: boolean }}
   */
  project(x, y) {
    const { eye, fwd, right, up, f } = this.pose;
    const { p, n } = surfacePoint(this.geo, x, y);
    const q = sub(p, eye);
    const cx = dot(q, right);
    const cy = dot(q, up);
    const cz = dot(q, fwd);
    // From inside, every point in front of the camera is in view; from outside, only the side facing it.
    const facing = this.geo.inside || dot(n, q) < 0;
    if (cz <= 1e-6) {
      // Behind the camera: far off screen, in the direction it lies.
      const l = Math.hypot(cx, cy) || 1;
      return { x: this.vw / 2 + (cx / l) * 1e5, y: this.vh / 2 - (cy / l) * 1e5, visible: false };
    }
    return { x: this.vw / 2 + (f * cx) / cz, y: this.vh / 2 - (f * cy) / cz, visible: facing };
  }

  contentToScreen(x, y) {
    const p = this.project(x, y);
    return { x: p.x, y: p.y };
  }

  /**
   * Screen bounding box of a wall rectangle, from points sampled across it.
   * A rectangle that isn't in view gets a box just off screen in its direction,
   * so a leader line points the way to it.
   * @param {{ x: number, y: number, w: number, h: number }} r
   * @returns {{ x: number, y: number, w: number, h: number, visible: boolean }}
   */
  rectToScreen(r) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const n = 4;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const p = this.project(r.x + (r.w * i) / n, r.y + (r.h * j) / n);
        if (!p.visible) continue;
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
    if (x0 <= x1) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, visible: true };
    const c = this.project(r.x + r.w / 2, r.y + r.h / 2);
    let dx = c.x - this.vw / 2;
    let dy = c.y - this.vh / 2 || -1;
    // Behind a sphere seen from outside, the projection lands on the sphere itself; push it out past the edge.
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const reach = Math.min(Math.abs(dx) > 1e-9 ? (this.vw / 2 + 40) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? (this.vh / 2 + 40) / Math.abs(dy) : Infinity);
    return { x: this.vw / 2 + dx * reach - 1, y: this.vh / 2 + dy * reach - 1, w: 2, h: 2, visible: false };
  }

  /**
   * Wall pixels seen through a grid of viewport points, each with its squared
   * screen distance from the middle. Visible tiles are the tiles these fall in.
   * @returns {Array<{ x: number, y: number, d: number }>}
   */
  samples() {
    const key = `${this.x},${this.y},${this.zoom},${this.vw},${this.vh}`;
    if (this.sampleCache?.key === key) return this.sampleCache.points;
    const nx = Math.max(2, Math.ceil(this.vw / SAMPLE_STEP) + 1);
    const ny = Math.max(2, Math.ceil(this.vh / SAMPLE_STEP) + 1);
    const points = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const sx = (this.vw * i) / (nx - 1);
        const sy = (this.vh * j) / (ny - 1);
        const hit = this.screenToContent(sx, sy);
        if (hit) points.push({ x: hit.x, y: hit.y, d: (sx - this.vw / 2) ** 2 + (sy - this.vh / 2) ** 2 });
      }
    }
    this.sampleCache = { key, points };
    return points;
  }

  /**
   * Tiles of a level that are in view, nearest the middle of the screen first.
   * @param {{ scale: number }} level
   * @param {{ w: number, h: number }} tile
   * @param {Set<string>} occupied
   * @returns {Array<[number, number]>}
   */
  visibleTiles(level, tile, occupied) {
    const tw = tile.w / level.scale;
    const th = tile.h / level.scale;
    /** @type {Map<string, number>} */
    const best = new Map();
    for (const s of this.samples()) {
      const key = `${Math.floor(s.x / tw)},${Math.floor(s.y / th)}`;
      if (occupied.has(key) && !(best.get(key) <= s.d)) best.set(key, s.d);
    }
    return [...best].sort((a, b) => a[1] - b[1]).map(([k]) => /** @type {[number, number]} */ (k.split(',').map(Number)));
  }

  // -------------------------------------------------------------------------
  // Limits

  get minZoom() {
    return this.minZoomAt(this.y);
  }

  minZoomAt(y) {
    const g = this.geo;
    if (g.inside) return Math.min(this.maxZoom, (this.minFocal * this.scaleAt(y)) / g.radius);
    return Math.min(this.maxZoom, this.fitZoomAt(y) * 0.75);
  }

  /** Outside: the zoom at which the whole wall is in view. */
  fitZoomAt(y) {
    const g = this.geo;
    const f = this.focal(1, y);
    const tanX = this.vw / 2 / f;
    const tanY = this.vh / 2 / f;
    let d;
    if (g.type === 'sphere') {
      d = g.radius / Math.sin(Math.atan(Math.min(tanX, tanY))) - g.radius;
    } else {
      const half = Math.min(Math.PI / 2, g.width / g.radius / 2);
      const depth = g.radius * (1 - Math.cos(half));
      d = Math.max(g.height / 2 / tanY, (g.radius * Math.sin(half)) / tanX - depth, g.radius * 0.1);
    }
    return (f * this.scaleAt(y)) / (d * 1.06);
  }

  /** @returns {import('./camera.js').View} */
  homeView() {
    const g = this.geo;
    const y = g.height / 2;
    let zoom;
    if (!g.inside) zoom = this.fitZoomAt(y);
    else if (g.type === 'cylinder') zoom = Math.max(this.minZoomAt(y), (this.vh * 0.94) / g.height);
    else zoom = (Math.max(this.minFocal, this.vh / 2 / Math.tan((HOME_FOV / 2) * DEG)) * this.scaleAt(y)) / g.radius;
    return { x: g.width / 2, y, zoom: clamp(zoom, this.minZoomAt(y), this.maxZoom) };
  }

  clamp() {
    this.zoom = clamp(this.zoom, this.minZoomAt(this.y), this.maxZoom);
    const v = this.clampedCenter(this.x, this.y, this.zoom);
    this.x = this.geo.wrap ? ((v.x % this.cw) + this.cw) % this.cw : v.x;
    this.y = v.y;
  }

  /** Keep the view on the wall where it can be, like the flat camera, measuring the view in angles inside. */
  clampedCenter(x, y, zoom) {
    const g = this.geo;
    const f = this.focal(zoom, y);
    const hw = g.inside ? Math.atan(this.vw / 2 / f) * g.radius : this.vw / 2 / zoom;
    if (!g.wrap) x = clamp(x, Math.min(hw, g.width - hw), Math.max(hw, g.width - hw));
    if (g.inside && g.type === 'sphere') {
      // Keep the band's edges at or beyond the top and bottom of the view.
      const half = Math.atan(this.vh / 2 / f);
      const top = this.latAt(0) - half;
      const bottom = this.latAt(g.height) + half;
      y = bottom > top ? g.height / 2 : this.yAtLat(clamp(this.latAt(y), bottom, top));
    } else {
      const hh = this.vh / 2 / zoom;
      y = clamp(y, Math.min(hh, g.height - hh), Math.max(hh, g.height - hh));
    }
    return { x, y };
  }

  latAt(y) {
    const p = surfacePoint(this.geo, this.geo.width / 2, y).p;
    return Math.asin(clamp(p[1] / this.geo.radius, -1, 1));
  }

  yAtLat(lat) {
    const g = this.geo;
    return g.height / 2 - (Math.log(Math.tan(Math.PI / 4 + lat / 2)) - g.mid) * g.radius;
  }

  // -------------------------------------------------------------------------
  // Movement

  /** Drag: the wall pixel that was `(dx, dy)` from the middle moves to the middle. */
  panBy(dx, dy) {
    const hit = this.screenToContent(this.vw / 2 - dx, this.vh / 2 - dy);
    if (hit) {
      this.x += this.geo.wrap ? wrapDelta(hit.x - this.x, this.cw) : hit.x - this.x;
      this.y = hit.y;
    } else {
      this.x -= dx / this.zoom;
      this.y -= dy / this.zoom;
    }
    this.clamp();
  }

  /** Zoom by `factor`, keeping the wall pixel under (sx, sy) in place. */
  zoomAt(factor, sx, sy) {
    const target = this.screenToContent(sx, sy);
    this.zoom = clamp(this.zoom * factor, this.minZoomAt(this.y), this.maxZoom);
    if (target) {
      // The pixel under the pointer moves about one-for-one with the middle, so a few steps converge.
      for (let i = 0; i < 4; i++) {
        const now = this.screenToContent(sx, sy);
        if (!now) break;
        this.x += this.geo.wrap ? wrapDelta(target.x - now.x, this.cw) : target.x - now.x;
        this.y += target.y - now.y;
      }
    }
    this.clamp();
  }

  zoomedView(factor, sx, sy) {
    const saved = this.view;
    this.zoomAt(factor, sx, sy);
    const v = this.view;
    this.x = saved.x;
    this.y = saved.y;
    this.zoom = saved.zoom;
    return v;
  }

  /** @param {import('./camera.js').View} to @param {number} now @param {number} [duration] */
  flyTo(to, now, duration) {
    super.flyTo(to, now, duration);
    // Round a wrapping wall the short way.
    if (this.anim && this.geo.wrap) this.anim.to.x = this.anim.from.x + wrapDelta(this.anim.to.x - this.anim.from.x, this.cw);
  }
}
