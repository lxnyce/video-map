// 2D camera for the flat wall. Positions are in content pixels (the wall at
// full resolution); zoom is CSS pixels per content pixel.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** @typedef {{ x: number, y: number, zoom: number }} View */

export class Camera {
  /**
   * @param {number} contentWidth
   * @param {number} contentHeight
   * @param {{ maxZoom?: number }} [opts] maxZoom in CSS px per content px
   */
  constructor(contentWidth, contentHeight, { maxZoom = 2 } = {}) {
    this.cw = contentWidth;
    this.ch = contentHeight;
    this.vw = 1;
    this.vh = 1;
    this.maxZoom = maxZoom;
    this.x = contentWidth / 2;
    this.y = contentHeight / 2;
    this.zoom = 1;
    /** @type {{ from: View, to: View, start: number, duration: number } | null} */
    this.anim = null;
    /** @type {{ vx: number, vy: number, last: number } | null} screen px per ms */
    this.velocity = null;
  }

  /** Zoom that fits the whole wall in the viewport. */
  get fitZoom() {
    return Math.min(this.vw / this.cw, this.vh / this.ch);
  }

  get minZoom() {
    return Math.min(this.fitZoom * 0.75, this.maxZoom);
  }

  get moving() {
    return Boolean(this.anim || this.velocity);
  }

  setViewport(w, h) {
    this.vw = Math.max(1, w);
    this.vh = Math.max(1, h);
    this.clamp();
  }

  /** @returns {View} */
  homeView() {
    return { x: this.cw / 2, y: this.ch / 2, zoom: Math.min(this.fitZoom * 0.94, this.maxZoom) };
  }

  /** @returns {View} */
  get view() {
    return { x: this.x, y: this.y, zoom: this.zoom };
  }

  /** @param {View} v */
  set(v) {
    this.x = v.x;
    this.y = v.y;
    this.zoom = v.zoom;
    this.clamp();
  }

  /** Keep zoom in range. A wall bigger than the viewport can't leave a gap at its edges; a smaller one stays fully on screen. */
  clamp() {
    this.zoom = clamp(this.zoom, this.minZoom, this.maxZoom);
    const v = this.clampedCenter(this.x, this.y, this.zoom);
    this.x = v.x;
    this.y = v.y;
  }

  clampedCenter(x, y, zoom) {
    const hw = this.vw / 2 / zoom;
    const hh = this.vh / 2 / zoom;
    return {
      x: clamp(x, Math.min(hw, this.cw - hw), Math.max(hw, this.cw - hw)),
      y: clamp(y, Math.min(hh, this.ch - hh), Math.max(hh, this.ch - hh)),
    };
  }

  screenToContent(sx, sy) {
    return { x: this.x + (sx - this.vw / 2) / this.zoom, y: this.y + (sy - this.vh / 2) / this.zoom };
  }

  contentToScreen(x, y) {
    return { x: (x - this.x) * this.zoom + this.vw / 2, y: (y - this.y) * this.zoom + this.vh / 2 };
  }

  /** Visible part of the wall in content pixels (may extend past the wall). */
  visibleRect() {
    const hw = this.vw / 2 / this.zoom;
    const hh = this.vh / 2 / this.zoom;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }

  /** Zoom by `factor`, keeping the content point under (sx, sy) fixed. */
  zoomAt(factor, sx, sy) {
    const p = this.screenToContent(sx, sy);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    this.x = p.x - (sx - this.vw / 2) / this.zoom;
    this.y = p.y - (sy - this.vh / 2) / this.zoom;
    this.clamp();
  }

  /** Move the wall by a screen-pixel delta (dragging right moves the wall right). */
  panBy(dx, dy) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** The view that would result from zoomAt(factor, sx, sy), without applying it. */
  zoomedView(factor, sx, sy) {
    const p = this.screenToContent(sx, sy);
    const zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    return { x: p.x - (sx - this.vw / 2) / zoom, y: p.y - (sy - this.vh / 2) / zoom, zoom };
  }

  /**
   * View that shows a content rectangle, centered at a screen point (default: viewport center),
   * taking up `fraction` of the viewport's limiting dimension.
   * @param {{ x: number, y: number, w: number, h: number }} rect
   * @param {{ fraction?: number, at?: { x: number, y: number } }} [opts]
   * @returns {View}
   */
  viewForRect(rect, { fraction = 0.5, at } = {}) {
    const zoom = clamp(Math.min((this.vw * fraction) / rect.w, (this.vh * fraction) / rect.h), this.minZoom, this.maxZoom);
    const sx = at?.x ?? this.vw / 2;
    const sy = at?.y ?? this.vh / 2;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const c = this.clampedCenter(cx - (sx - this.vw / 2) / zoom, cy - (sy - this.vh / 2) / zoom, zoom);
    return { x: c.x, y: c.y, zoom };
  }

  /** @param {View} to @param {number} now @param {number} [duration] ms */
  flyTo(to, now, duration = 650) {
    const c = this.clampedCenter(to.x, to.y, clamp(to.zoom, this.minZoom, this.maxZoom));
    this.velocity = null;
    this.anim = { from: this.view, to: { ...c, zoom: clamp(to.zoom, this.minZoom, this.maxZoom) }, start: now, duration };
  }

  /** Start inertial panning with a screen velocity in px/ms. */
  fling(vx, vy, now) {
    this.anim = null;
    if (Math.hypot(vx, vy) > 0.05) this.velocity = { vx, vy, last: now };
  }

  stop() {
    this.anim = null;
    this.velocity = null;
  }

  /** Advance animations. @returns {boolean} whether the view changed */
  step(now) {
    if (this.anim) {
      const { from, to, start, duration } = this.anim;
      const t = clamp((now - start) / duration, 0, 1);
      const e = easeInOut(t);
      // Interpolate zoom in log space so zooming feels uniform.
      this.zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e);
      this.x = from.x + (to.x - from.x) * e;
      this.y = from.y + (to.y - from.y) * e;
      if (t >= 1) {
        this.anim = null;
        this.set(to);
      }
      return true;
    }
    if (this.velocity) {
      const v = this.velocity;
      const dt = Math.min(64, now - v.last);
      v.last = now;
      const before = this.view;
      this.panBy(v.vx * dt, v.vy * dt);
      const decay = Math.exp(-dt / 325);
      v.vx *= decay;
      v.vy *= decay;
      const stuck = before.x === this.x && before.y === this.y;
      if (Math.hypot(v.vx, v.vy) < 0.02 || stuck) this.velocity = null;
      return !stuck;
    }
    return false;
  }
}
