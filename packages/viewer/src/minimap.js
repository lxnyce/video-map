// Minimap for the flat wall (plan §8.6): the whole wall in miniature, from the
// level-0 still, with the part in view outlined. Videos the filter leaves out
// are dimmed here too. Click or drag it to move the camera. It shows only while
// the wall is bigger than the screen.

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

export class Minimap {
  /**
   * @param {HTMLElement} parent
   * @param {object} host
   * @param {(x: number, y: number, animate: boolean) => void} host.moveTo  center the camera on a wall point
   */
  constructor(parent, host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vm-minimap';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    parent.append(this.canvas);
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    /** The wall with its dimming, redrawn only when the wall, the image or the filter changes. */
    this.base = document.createElement('canvas');
    this.wall = { w: 1, h: 1 };
    this.size = { w: 1, h: 1 };
    /** @type {HTMLImageElement|null} */
    this.image = null;
    /** @type {HTMLImageElement|null} */
    this.pendingImage = null;
    this.imageRect = null;
    /** @type {{ rects: Array<Rect|null>, background: string, matches: Uint8Array|null }} */
    this.data = { rects: [], background: '#101318', matches: null };
    this.view = null;
    this.baseDirty = true;

    let dragging = false;
    const point = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * this.wall.w, y: ((e.clientY - r.top) / r.height) * this.wall.h };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      const p = point(e);
      this.host.moveTo(p.x, p.y, true);
      e.preventDefault();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = point(e);
      this.host.moveTo(p.x, p.y, false);
    });
    const end = () => { dragging = false; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  /**
   * A new wall (on load, or when the layout switches).
   * @param {object} o
   * @param {number} o.width  wall size
   * @param {number} o.height
   * @param {string|null} o.image  URL of the level-0 still, or null
   * @param {Rect|null} o.imageRect  the wall's part of that image, in image pixels
   * @param {Array<Rect|null>} o.rects  per video
   * @param {string} o.background
   */
  setWall({ width, height, image, imageRect, rects, background }) {
    this.wall = { w: width, h: height };
    this.data = { ...this.data, rects, background };
    this.image = null;
    this.pendingImage = null;
    this.imageRect = imageRect;
    if (image) {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (this.pendingImage !== img) return;
        this.image = img;
        this.baseDirty = true;
        this.draw();
      };
      img.src = image;
      this.pendingImage = img;
    }
    this.baseDirty = true;
    this.resize();
  }

  /** @param {Uint8Array|null} matches */
  setMatches(matches) {
    this.data.matches = matches;
    this.baseDirty = true;
    this.draw();
  }

  /** Size the map to the wall's shape, within a box that suits the screen. */
  resize() {
    const small = (this.canvas.parentElement?.clientWidth ?? 1000) < 700;
    const maxW = small ? 120 : 200;
    const maxH = small ? 90 : 140;
    const aspect = this.wall.w / this.wall.h;
    const w = Math.round(Math.min(maxW, maxH * aspect));
    const h = Math.round(w / aspect);
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.canvas, this.base]) {
      c.width = Math.max(1, Math.round(w * ratio));
      c.height = Math.max(1, Math.round(h * ratio));
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.baseDirty = true;
  }

  /**
   * Show or hide the map and outline the part in view.
   * @param {{ x0: number, y0: number, x1: number, y1: number } | null} view  null hides the map
   */
  update(view) {
    this.canvas.hidden = !view;
    if (!view) return;
    this.view = view;
    this.draw();
  }

  drawBase() {
    const c = this.base.getContext('2d');
    const { width: cw, height: ch } = this.base;
    const sx = cw / this.wall.w;
    const sy = ch / this.wall.h;
    c.fillStyle = this.data.background;
    c.fillRect(0, 0, cw, ch);
    if (this.image && this.imageRect) {
      const r = this.imageRect;
      c.drawImage(this.image, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
    } else {
      // No still: sketch the videos.
      c.fillStyle = 'rgba(255, 255, 255, 0.22)';
      for (const r of this.data.rects) if (r) c.fillRect(r.x * sx + 0.5, r.y * sy + 0.5, Math.max(1, r.w * sx - 1), Math.max(1, r.h * sy - 1));
    }
    const m = this.data.matches;
    if (m) {
      c.fillStyle = this.data.background;
      c.globalAlpha = 0.8;
      this.data.rects.forEach((r, i) => {
        if (r && !m[i]) c.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
      });
      c.globalAlpha = 1;
    }
    this.baseDirty = false;
  }

  draw() {
    if (this.canvas.hidden || !this.view) return;
    if (this.baseDirty) this.drawBase();
    const c = this.ctx;
    const { width: cw, height: ch } = this.canvas;
    c.clearRect(0, 0, cw, ch);
    c.drawImage(this.base, 0, 0);
    const sx = cw / this.wall.w;
    const sy = ch / this.wall.h;
    const v = this.view;
    const x0 = Math.max(0, v.x0 * sx);
    const y0 = Math.max(0, v.y0 * sy);
    const x1 = Math.min(cw, v.x1 * sx);
    const y1 = Math.min(ch, v.y1 * sy);
    const ratio = cw / this.size.w;
    c.fillStyle = 'rgba(91, 157, 255, 0.14)';
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.strokeStyle = '#5b9dff';
    c.lineWidth = 1.5 * ratio;
    c.strokeRect(x0 + c.lineWidth / 2, y0 + c.lineWidth / 2, Math.max(1, x1 - x0 - c.lineWidth), Math.max(1, y1 - y0 - c.lineWidth));
  }
}
