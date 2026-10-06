// Pointer, wheel and keyboard input for the wall. Reports gestures to handlers;
// it does not touch the camera itself.

const TAP_SLOP = 8;          // px a tap may move
const TAP_TIME = 450;        // ms
const DOUBLE_TAP_TIME = 300; // ms
const LONG_PRESS = 500;      // ms

/**
 * @typedef {object} InputHandlers
 * @property {(dx: number, dy: number) => void} pan
 * @property {(factor: number, x: number, y: number, animate?: boolean) => void} zoom
 * @property {(x: number, y: number) => void} tap
 * @property {(x: number, y: number) => void} doubleTap
 * @property {(x: number, y: number) => void} press    long press (touch) shows info
 * @property {(x: number, y: number) => void} hover
 * @property {() => void} leave
 * @property {() => void} gestureStart
 * @property {(vx: number, vy: number) => void} gestureEnd  release velocity in px/ms
 * @property {(key: string) => boolean} key  return true if handled
 */

export class Input {
  /**
   * @param {HTMLElement} el
   * @param {InputHandlers} h
   */
  constructor(el, h) {
    this.el = el;
    this.h = h;
    /** @type {Map<number, { x: number, y: number, startX: number, startY: number, t0: number, type: string }>} */
    this.pointers = new Map();
    /** @type {Array<{ x: number, y: number, t: number }>} */
    this.samples = [];
    this.pinch = null;
    this.moved = false;
    this.lastTap = null;
    this.pressTimer = 0;
    this.active = false;

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.pointers.size) h.leave(); });
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('keydown', (e) => {
      if (h.key(e.key)) e.preventDefault();
    });
    el.addEventListener('contextmenu', (e) => { if (this.pointers.size) e.preventDefault(); });
  }

  /** @param {PointerEvent} e */
  local(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** @param {PointerEvent} e */
  down(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, startX: p.x, startY: p.y, t0: performance.now(), type: e.pointerType });
    if (this.pointers.size === 1) {
      this.moved = false;
      this.samples = [{ ...p, t: performance.now() }];
      this.active = true;
      this.h.gestureStart();
      if (e.pointerType !== 'mouse') {
        clearTimeout(this.pressTimer);
        this.pressTimer = window.setTimeout(() => {
          if (!this.moved && this.pointers.size === 1) {
            this.pressed = true;
            this.h.press(p.x, p.y);
          }
        }, LONG_PRESS);
      }
    } else if (this.pointers.size === 2) {
      clearTimeout(this.pressTimer);
      this.moved = true;
      this.pinch = this.pinchState();
    }
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  /** @param {PointerEvent} e */
  move(e) {
    const p = this.local(e);
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) {
      if (e.pointerType === 'mouse') this.h.hover(p.x, p.y);
      return;
    }
    const dx = p.x - ptr.x;
    const dy = p.y - ptr.y;
    ptr.x = p.x;
    ptr.y = p.y;
    if (!this.moved && Math.hypot(p.x - ptr.startX, p.y - ptr.startY) > TAP_SLOP) {
      this.moved = true;
      clearTimeout(this.pressTimer);
    }

    if (this.pointers.size === 1 && this.moved) {
      this.h.pan(dx, dy);
      const now = performance.now();
      this.samples.push({ ...p, t: now });
      while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
    } else if (this.pointers.size === 2 && this.pinch) {
      const next = this.pinchState();
      this.h.pan(next.cx - this.pinch.cx, next.cy - this.pinch.cy);
      this.h.zoom(next.dist / this.pinch.dist, next.cx, next.cy);
      this.pinch = next;
    }
  }

  /** @param {PointerEvent} e @param {boolean} [cancel] */
  up(e, cancel = false) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    this.pointers.delete(e.pointerId);
    clearTimeout(this.pressTimer);

    if (this.pointers.size === 1) {
      // Pinch ended with one finger still down: continue as a pan from here.
      this.pinch = null;
      const [rest] = this.pointers.values();
      this.samples = [{ x: rest.x, y: rest.y, t: performance.now() }];
      return;
    }
    if (this.pointers.size > 0) return;
    this.active = false;
    this.pinch = null;

    const pressed = this.pressed;
    this.pressed = false;
    if (cancel) {
      this.h.gestureEnd(0, 0);
      return;
    }
    const now = performance.now();
    if (!this.moved && !pressed && now - ptr.t0 < TAP_TIME) {
      this.h.gestureEnd(0, 0);
      const last = this.lastTap;
      if (last && now - last.t < DOUBLE_TAP_TIME && Math.hypot(ptr.x - last.x, ptr.y - last.y) < 30) {
        this.lastTap = null;
        this.h.doubleTap(ptr.x, ptr.y);
      } else {
        this.lastTap = { x: ptr.x, y: ptr.y, t: now };
        this.h.tap(ptr.x, ptr.y);
      }
      return;
    }
    // Release velocity from the last ~100 ms of movement.
    const first = this.samples[0];
    const lastS = this.samples[this.samples.length - 1];
    const dt = lastS && first ? lastS.t - first.t : 0;
    if (this.moved && dt > 10 && now - lastS.t < 80) this.h.gestureEnd((lastS.x - first.x) / dt, (lastS.y - first.y) / dt);
    else this.h.gestureEnd(0, 0);
  }

  /** @param {WheelEvent} e */
  wheel(e) {
    e.preventDefault();
    const p = { x: e.clientX - this.el.getBoundingClientRect().left, y: e.clientY - this.el.getBoundingClientRect().top };
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.el.clientHeight : 1;
    const dy = e.deltaY * unit;
    // ctrlKey is set for trackpad pinch gestures, which send small deltas.
    const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018));
    this.h.zoom(Math.min(4, Math.max(0.25, factor)), p.x, p.y);
  }
}
