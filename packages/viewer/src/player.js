// Floating player windows. Each window plays one video's full rendition and
// stays linked to its cell on the wall: the cell is outlined, a leader line
// joins the window to the cell, "Locate" flies the camera back to it, and the
// window grows out of (and shrinks back into) the cell.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_WINDOWS = 4;
const ICONS = {
  locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="7.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  max: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/**
 * @typedef {object} PlayerHost
 * @property {(video: any) => { x: number, y: number, w: number, h: number }} cellRect  cell in viewport CSS px
 * @property {(video: any, windowRect: { x: number, y: number, w: number, h: number }|null) => void} locate
 * @property {() => number} masterTime seconds into the preview loop
 * @property {() => void} changed  windows opened, closed or focused
 * @property {(video: any) => string} labelFor  category label lookup
 */

export class Players {
  /**
   * @param {HTMLElement} root viewer root element
   * @param {PlayerHost} host
   */
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.layer = el('div', 'vm-windows');
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'vm-leaders');
    this.svg.setAttribute('aria-hidden', 'true');
    root.append(this.svg, this.layer);
    /** @type {PlayerWindow[]} */
    this.windows = [];
    this.z = 10;
  }

  get mobile() {
    return this.root.clientWidth < 700;
  }

  /** Videos with open windows, focused last. */
  get videos() {
    return this.windows.map((w) => w.video);
  }

  get focused() {
    return this.windows[this.windows.length - 1] ?? null;
  }

  /**
   * @param {any} video manifest video
   * @param {{ x: number, y: number, w: number, h: number }} from cell rect to grow from
   */
  open(video, from) {
    const existing = this.windows.find((w) => w.video.id === video.id);
    if (existing) {
      this.focus(existing);
      return existing;
    }
    if (this.mobile) for (const w of [...this.windows]) this.close(w, false);
    while (this.windows.length >= MAX_WINDOWS) this.close(this.windows[0], false);
    const win = new PlayerWindow(this, video, from);
    this.windows.push(win);
    this.focus(win);
    return win;
  }

  /** @param {PlayerWindow} win */
  focus(win) {
    win.el.style.zIndex = String(++this.z);
    this.windows = [...this.windows.filter((w) => w !== win), win];
    for (const w of this.windows) w.el.classList.toggle('vm-focused', w === win);
    this.host.changed();
  }

  /** @param {PlayerWindow} win @param {boolean} [animate] */
  close(win, animate = true) {
    if (!this.windows.includes(win)) return;
    this.windows = this.windows.filter((w) => w !== win);
    win.destroy(animate ? this.host.cellRect(win.video) : null);
    win.leader.remove();
    this.host.changed();
  }

  closeTop() {
    if (!this.focused) return false;
    this.close(this.focused);
    return true;
  }

  /** Per frame: point each window's leader line at its cell. */
  frame() {
    const vw = this.root.clientWidth;
    const vh = this.root.clientHeight;
    for (const w of this.windows) w.updateLeader(this.host.cellRect(w.video), vw, vh);
  }

  relayout() {
    for (const w of this.windows) w.fit();
  }
}

class PlayerWindow {
  /**
   * @param {Players} mgr
   * @param {any} video
   * @param {{ x: number, y: number, w: number, h: number }} from
   */
  constructor(mgr, video, from) {
    this.mgr = mgr;
    this.video = video;
    this.maximized = false;
    const mobile = mgr.mobile;

    const win = el('section', `vm-window${mobile ? ' vm-sheet' : ''}`);
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', video.title);
    win.tabIndex = -1;
    this.el = win;

    const bar = el('header', 'vm-window-bar');
    const title = el('h2', 'vm-window-title');
    title.textContent = video.title;
    const actions = el('div', 'vm-window-actions');
    const btn = (act, label) => {
      const b = el('button', 'vm-icon-btn');
      b.type = 'button';
      b.dataset.act = act;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = ICONS[act];
      actions.append(b);
      return b;
    };
    btn('locate', 'Show on wall');
    this.infoBtn = btn('info', 'Details');
    this.maxBtn = btn('max', 'Maximize');
    btn('close', 'Close');
    bar.append(title, actions);

    const media = el('div', 'vm-window-media');
    const v = document.createElement('video');
    v.controls = true;
    v.playsInline = true;
    v.preload = 'auto';
    if (video.poster) v.poster = video.poster;
    const aspect = video.width && video.height ? video.width / video.height : 16 / 9;
    media.style.aspectRatio = String(aspect);
    media.append(v);
    this.videoEl = v;
    this.aspect = aspect;

    this.info = buildInfo(video, mgr.host.labelFor);
    this.info.hidden = true;
    const grip = el('div', 'vm-window-grip');
    grip.setAttribute('aria-hidden', 'true');
    win.append(bar, media, this.info, grip);
    mgr.layer.append(win);

    this.leader = document.createElementNS(SVG_NS, 'g');
    this.leader.setAttribute('class', 'vm-leader');
    this.leader.innerHTML = '<line/><circle r="4"/><path class="vm-leader-arrow" d="M0 0 L-9 -5 L-9 5 Z"/>';
    mgr.svg.append(this.leader);

    actions.addEventListener('click', (e) => {
      const act = /** @type {HTMLElement} */ (e.target).closest('button')?.dataset.act;
      if (act === 'close') mgr.close(this);
      if (act === 'locate') mgr.host.locate(video, this.maximized ? null : this.box());
      if (act === 'info') this.toggleInfo();
      if (act === 'max') this.toggleMax();
    });
    win.addEventListener('pointerdown', () => mgr.focus(this), true);
    this.enableDrag(bar);
    this.enableResize(grip);
    bar.addEventListener('dblclick', (e) => {
      if (!(/** @type {HTMLElement} */ (e.target).closest('button'))) this.toggleMax();
    });

    this.place(from);
    this.animateFrom(from);

    // Continue from the moment the preview is showing, so the switch feels seamless.
    if (video.media) {
      v.src = video.media;
      const loop = mgr.host.masterTime();
      const start = video.looped && video.duration ? loop % video.duration : (video.previewStart ?? 0) + loop;
      v.addEventListener('loadedmetadata', () => {
        if (start < v.duration) v.currentTime = start;
      }, { once: true });
      v.play().catch(() => {
        v.muted = true;
        v.play().catch(() => {});
      });
    } else {
      media.classList.add('vm-no-media');
      media.dataset.message = 'No full-resolution version';
    }
  }

  /**
   * The window's resting rectangle in viewer coordinates, ignoring open/close animations.
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  box() {
    const e = this.el;
    return { x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight };
  }

  /** Initial geometry: beside the cell, on the side with more room. */
  place(from) {
    if (this.el.classList.contains('vm-sheet')) return;
    const vw = this.mgr.root.clientWidth;
    const vh = this.mgr.root.clientHeight;
    let w = Math.min(Math.max(360, vw * 0.42), 760, vw - 32);
    const chrome = 44 + 56;
    if (w / this.aspect + chrome > vh - 32) w = Math.max(280, (vh - 32 - chrome) * this.aspect);
    const h = w / this.aspect + chrome;
    const cx = from.x + from.w / 2;
    const offset = 16 * (this.mgr.windows.length % 4);
    // Opposite half of the screen from the cell, so the cell stays visible.
    let x = cx < vw / 2 ? vw - w - 16 - offset : 16 + offset;
    x = Math.min(Math.max(8, x), vw - w - 8);
    let y = from.y + from.h / 2 - h / 2 + offset;
    y = Math.min(Math.max(8, y), Math.max(8, vh - h - 8));
    this.geom = { x, y, w };
    this.apply();
  }

  apply() {
    const s = this.el.style;
    if (this.maximized || this.el.classList.contains('vm-sheet')) {
      s.left = s.top = s.width = '';
      return;
    }
    s.left = `${this.geom.x}px`;
    s.top = `${this.geom.y}px`;
    s.width = `${this.geom.w}px`;
  }

  /** Keep the window on screen after the viewport changes. */
  fit() {
    if (!this.geom) return;
    const vw = this.mgr.root.clientWidth;
    const vh = this.mgr.root.clientHeight;
    this.geom.w = Math.min(this.geom.w, vw - 16);
    this.geom.x = Math.min(Math.max(8, this.geom.x), vw - this.geom.w - 8);
    this.geom.y = Math.min(Math.max(8, this.geom.y), vh - 52);
    this.apply();
  }

  animateFrom(from) {
    const to = this.el.getBoundingClientRect();
    const root = this.mgr.root.getBoundingClientRect();
    if (!to.width || !this.el.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dx = root.left + from.x - to.left;
    const dy = root.top + from.y - to.top;
    this.el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${from.w / to.width}, ${from.h / to.height})`, opacity: 0.3 },
      { transform: 'none', opacity: 1 },
    ], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  /** @param {{ x: number, y: number, w: number, h: number } | null} to cell rect to shrink into */
  destroy(to) {
    const v = this.videoEl;
    v.pause();
    const finish = () => {
      v.removeAttribute('src');
      v.load();
      this.el.remove();
    };
    const box = this.el.getBoundingClientRect();
    const root = this.mgr.root.getBoundingClientRect();
    const visible = to && to.x + to.w > 0 && to.y + to.h > 0 && to.x < root.width && to.y < root.height;
    if (!this.el.animate || !box.width || matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
    const frames = visible
      ? [{ transform: 'none', opacity: 1 }, { transform: `translate(${root.left + to.x - box.left}px, ${root.top + to.y - box.top}px) scale(${to.w / box.width}, ${to.h / box.height})`, opacity: 0.2 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }];
    this.el.style.pointerEvents = 'none';
    this.el.animate(frames, { duration: 240, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }).finished.then(finish, finish);
  }

  toggleInfo() {
    this.info.hidden = !this.info.hidden;
    this.infoBtn.classList.toggle('vm-active', !this.info.hidden);
    this.infoBtn.setAttribute('aria-pressed', String(!this.info.hidden));
  }

  toggleMax() {
    this.maximized = !this.maximized;
    this.el.classList.toggle('vm-max', this.maximized);
    this.maxBtn.innerHTML = this.maximized ? ICONS.restore : ICONS.max;
    this.maxBtn.title = this.maximized ? 'Restore' : 'Maximize';
    this.maxBtn.setAttribute('aria-label', this.maxBtn.title);
    this.apply();
  }

  /** Drag by the title bar; on the mobile sheet, a downward swipe closes it. */
  enableDrag(bar) {
    let start = null;
    bar.addEventListener('pointerdown', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('button') || e.button !== 0) return;
      bar.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, gx: this.geom?.x ?? 0, gy: this.geom?.y ?? 0 };
    });
    bar.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (this.el.classList.contains('vm-sheet') && !this.maximized) {
        this.el.style.transform = `translateY(${Math.max(0, dy)}px)`;
        return;
      }
      if (this.maximized) return;
      const vw = this.mgr.root.clientWidth;
      const vh = this.mgr.root.clientHeight;
      this.geom.x = Math.min(Math.max(-this.geom.w + 80, start.gx + dx), vw - 80);
      this.geom.y = Math.min(Math.max(0, start.gy + dy), vh - 44);
      this.apply();
    });
    const end = (e) => {
      if (!start) return;
      const dy = e.clientY - start.y;
      start = null;
      if (this.el.classList.contains('vm-sheet') && !this.maximized) {
        this.el.style.transform = '';
        if (dy > 90) this.mgr.close(this);
      }
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  enableResize(grip) {
    let start = null;
    grip.addEventListener('pointerdown', (e) => {
      grip.setPointerCapture(e.pointerId);
      start = { x: e.clientX, w: this.geom?.w ?? 0 };
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start || this.maximized) return;
      const vw = this.mgr.root.clientWidth;
      this.geom.w = Math.min(Math.max(280, start.w + e.clientX - start.x), vw - this.geom.x - 8);
      this.apply();
    });
    grip.addEventListener('pointerup', () => { start = null; });
  }

  /**
   * @param {{ x: number, y: number, w: number, h: number }} cell
   * @param {number} vw
   * @param {number} vh
   */
  updateLeader(cell, vw, vh) {
    const g = this.leader;
    const box = this.box();
    const c = { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 };
    const inside = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    if (this.maximized || !box.w || inside(c, box)) {
      g.setAttribute('visibility', 'hidden');
      return;
    }
    g.setAttribute('visibility', 'visible');
    const margin = 14;
    const onScreen = c.x >= 0 && c.y >= 0 && c.x <= vw && c.y <= vh;
    const target = onScreen ? c : { x: Math.min(Math.max(margin, c.x), vw - margin), y: Math.min(Math.max(margin, c.y), vh - margin) };
    const anchor = { x: Math.min(Math.max(target.x, box.x), box.x + box.w), y: Math.min(Math.max(target.y, box.y), box.y + box.h) };
    const line = g.querySelector('line');
    line.setAttribute('x1', String(anchor.x));
    line.setAttribute('y1', String(anchor.y));
    line.setAttribute('x2', String(target.x));
    line.setAttribute('y2', String(target.y));
    const dot = g.querySelector('circle');
    dot.setAttribute('cx', String(target.x));
    dot.setAttribute('cy', String(target.y));
    dot.setAttribute('visibility', onScreen ? 'visible' : 'hidden');
    const arrow = g.querySelector('.vm-leader-arrow');
    arrow.setAttribute('visibility', onScreen ? 'hidden' : 'visible');
    const angle = (Math.atan2(target.y - anchor.y, target.x - anchor.x) * 180) / Math.PI;
    arrow.setAttribute('transform', `translate(${target.x} ${target.y}) rotate(${angle})`);
  }
}

/** Details panel: description, categories and tags, credits, links and free-form metadata. */
function buildInfo(video, labelFor) {
  const info = el('div', 'vm-window-info');
  if (video.description) {
    const p = el('p', 'vm-desc');
    p.textContent = video.description;
    info.append(p);
  }
  const chips = el('div', 'vm-chips');
  for (const c of video.categories ?? []) chips.append(chip(labelFor(c), 'vm-chip vm-chip-cat'));
  for (const t of video.tags ?? []) chips.append(chip(t, 'vm-chip'));
  if (chips.childElementCount) info.append(chips);

  const dl = el('dl', 'vm-meta');
  const row = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    const dt = el('dt');
    dt.textContent = k;
    const dd = el('dd');
    if (v instanceof Node) dd.append(v);
    else dd.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
    dl.append(dt, dd);
  };
  if (video.duration) row('Duration', formatTime(video.duration));
  if (video.width && video.height) row('Source', `${video.width}×${video.height}`);
  const cr = video.credits;
  if (cr) {
    row('Author', cr.author);
    row('License', cr.license);
    if (cr.url) row('Credit', link(cr.url, cr.url));
  }
  for (const l of video.links ?? []) row(l.label || 'Link', link(l.href, l.label || l.href));
  for (const [k, v] of Object.entries(video.meta ?? {})) row(k, v);
  if (dl.childElementCount) info.append(dl);
  return info;
}

function chip(text, cls) {
  const s = el('span', cls);
  s.textContent = text;
  return s;
}

/** Links come from scene data, so only allow web and relative URLs. */
function link(href, text) {
  const safe = /^(https?:|mailto:|\/|\.|#|[^:]*$)/i.test(String(href).trim());
  if (!safe) return String(text);
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [cls]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
