// The viewer: ties the camera, level-of-detail selection, video pool, stills,
// input, player windows and overlays together, and runs the render loop.

import { surfaceGeometry } from '@videomap/core/surface';
import { Camera } from './camera.js';
import { detectTier, gpuName } from './device.js';
import { formatHash, parseHash } from './hash.js';
import { Input } from './input.js';
import { byDistance, chooseLevel, occupancy } from './lod.js';
import { Players } from './player.js';
import { createRectIndex, normalizeScene, sharedTiles } from './rects.js';
import { Renderer, hexToRgb } from './renderer.js';
import { VideoPool } from './scheduler.js';
import { StillCache } from './stills.js';
import { SurfaceCamera } from './surface-camera.js';

const ACCENT = [0.36, 0.62, 1, 1];
const ICONS = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1.5"/><path d="M4 12h16M12 6v12"/></svg>',
  full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
};

/**
 * Load a built scene and show it in `root`.
 * @param {HTMLElement} root
 * @param {{ scene?: string }} [opts] URL of the runtime scene.json
 */
export async function mount(root, opts = {}) {
  root.classList.add('vm-root');
  const sceneUrl = new URL(opts.scene ?? 'scene.json', document.baseURI).href;
  if (location.protocol === 'file:') {
    return showError(root, 'This page has to be served over HTTP. Browsers block video textures and scene data on file:// pages. Run "vmap preview" on this folder, or upload it to a web server.');
  }
  let scene;
  try {
    const res = await fetch(sceneUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scene = await res.json();
  } catch (err) {
    return showError(root, `Couldn't load the scene (${err.message}).`);
  }
  if (scene.format !== 'videomap-scene' || ![1, 2].includes(scene.version)) {
    return showError(root, 'This scene.json was not produced by a compatible version of vmap.');
  }
  normalizeScene(scene);
  try {
    return new Viewer(root, scene, sceneUrl);
  } catch (err) {
    return showError(root, err.message);
  }
}

function showError(root, message) {
  const box = el('div', 'vm-error');
  box.setAttribute('role', 'alert');
  box.textContent = message;
  root.replaceChildren(box);
  return null;
}

export class Viewer {
  /**
   * @param {HTMLElement} root
   * @param {any} scene runtime manifest
   * @param {string} sceneUrl tile paths resolve against this
   */
  constructor(root, scene, sceneUrl) {
    this.root = root;
    this.scene = scene;
    this.base = sceneUrl;
    this.params = new URLSearchParams(location.search);
    this.debug = this.params.has('debug');
    const p = scene.pyramid;
    this.levels = p.levels;
    this.tile = p.tile;
    this.occupied = occupancy(p.levels);
    // Every video is a rectangle on the wall, whatever the packing (grid or masonry).
    this.index = createRectIndex(/** @type {any[]} */ (scene.videos), scene.content.width, scene.content.height);
    // Tiles that share a video (masonry) must stay tightly in sync, or the video shows a seam.
    this.shared = sharedTiles(p.levels, p.tile, scene.videos.map((v) => v.rect));
    this.byId = new Map(scene.videos.map((v) => [v.id, v]));
    this.catLabel = new Map((scene.categories ?? []).map((c) => [c.id, c.label ?? c.id]));
    this.bg = hexToRgb(scene.background ?? '#101318');
    this.outside = this.bg.map((c) => c * 0.55);
    // Null for the flat wall; otherwise how the wall wraps a cylinder or sphere.
    this.geo = surfaceGeometry(scene.surface, scene.content.width, scene.content.height);

    this.buildDom();
    this.renderer = new Renderer(this.canvas);
    this.tier = detectTier(/** @type {any} */ (navigator), gpuName(this.renderer.gl), this.params);
    this.lodBias = this.tier.lodBias;
    this.adapt = this.params.get('adapt') !== '0';
    this.downgrades = 0;

    // Tile video source: the first one this browser can play.
    const probe = document.createElement('video');
    const sources = [p.video, ...(p.video.alternates ?? [])];
    this.videoSource = sources.find((s) => probe.canPlayType(s.mime)) ?? null;
    this.stillSource = p.still;

    this.t0 = performance.now();
    this.duration = scene.preview.duration;
    this.clock = (t = performance.now()) => ((((t - this.t0) / 1000) % this.duration) + this.duration) % this.duration;

    this.pool = new VideoPool({ size: this.tier.budget, host: this.videoHost, renderer: this.renderer, clock: this.clock, duration: this.duration });
    this.stills = new StillCache({ renderer: this.renderer, limit: this.tier.stillCache, onLoad: () => { this.dirty = true; } });
    this.renderer.restoreHandlers.add(() => {
      this.pool.resetTextures();
      this.stills.reset();
      this.dirty = true;
    });

    // Videos start off when the visitor asked for less motion or less data, if stills can stand in.
    const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches || /** @type {any} */ (navigator).connection?.saveData === true;
    this.videosOn = Boolean(this.videoSource) && !(quiet && this.stillSource) && this.params.get('videos') !== '0';
    this.quietStart = quiet && !this.videosOn;
    this.userToggled = false;
    if (!this.videoSource && !this.stillSource) throw new Error('This browser cannot play the tile videos in this scene.');

    this.camera = this.geo ? new SurfaceCamera(this.geo) : new Camera(scene.content.width, scene.content.height);
    this.players = new Players(root, {
      cellRect: (v) => this.screenRect(v),
      locate: (v, rect) => this.locate(v, rect),
      masterTime: () => this.clock(),
      changed: () => {
        this.dirty = true;
        this.writeHash();
      },
      labelFor: (id) => this.catLabel.get(id) ?? id,
    });
    this.input = new Input(this.canvas, this.inputHandlers());

    this.state = { z: 0, ideal: 0, tiles: /** @type {Array<[number, number]>} */ ([]), wantSig: '', appliedSig: '', wantSince: 0 };
    this.hover = null;
    this.dirty = true;
    this.frames = [];
    this.lastCorrect = 0;
    this.lastAdapt = performance.now();
    this.slowWindows = 0;
    this.hashTimer = 0;
    this.firstPaint = false;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(root);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pool.pauseAll();
      else this.pool.resumeAll();
    });
    window.addEventListener('hashchange', () => this.applyHash(true));
    this.applyHash(false);
    this.updateVideoToggle();
    requestAnimationFrame((t) => this.frame(t));
  }

  // -------------------------------------------------------------------------
  // DOM

  buildDom() {
    const root = this.root;
    root.replaceChildren();
    const s = this.scene;
    this.canvas = el('canvas', 'vm-canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    const shape = this.geo?.type ?? 'wall';
    const drag = !this.geo ? 'Drag to pan' : this.geo.inside ? 'Drag to look around' : 'Drag to turn it';
    this.canvas.setAttribute('aria-label', `${s.title}: ${shape} of ${s.videos.length} videos. ${drag}, scroll or pinch to zoom, click a video to open it. Arrow keys pan, plus and minus zoom, 0 shows everything.`);
    this.videoHost = el('div', 'vm-video-host');
    this.videoHost.setAttribute('aria-hidden', 'true');
    this.labelLayer = el('div', 'vm-labels');
    this.labelLayer.setAttribute('aria-hidden', 'true');
    this.labels = (s.labels ? s.groups : []).map((g) => {
      const l = el('div', 'vm-label');
      l.textContent = g.label;
      const count = el('span', 'vm-label-count');
      count.textContent = String(g.count);
      l.append(count);
      if (g.color) l.style.setProperty('--group-color', g.color);
      this.labelLayer.append(l);
      return { g, el: l };
    });

    const title = el('header', 'vm-titlebar');
    const h1 = el('h1');
    h1.textContent = s.title;
    const sub = el('p');
    sub.textContent = `${s.videos.length} videos${s.groups.length > 1 ? ` · ${s.groups.length} groups` : ''}`;
    title.append(h1, sub);

    const controls = el('div', 'vm-controls');
    const button = (icon, label, fn) => {
      const b = el('button', 'vm-icon-btn');
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = ICONS[icon];
      b.addEventListener('click', fn);
      controls.append(b);
      return b;
    };
    button('plus', 'Zoom in', () => this.zoomBy(2));
    button('minus', 'Zoom out', () => this.zoomBy(0.5));
    button('home', 'Show everything', () => this.camera.flyTo(this.camera.homeView(), performance.now()));
    this.videoToggle = button('pause', 'Pause videos', () => this.setVideos(!this.videosOn));
    if (root.requestFullscreen) {
      button('full', 'Full screen', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else root.requestFullscreen().catch(() => {});
      });
    }

    this.banner = el('div', 'vm-banner');
    this.banner.hidden = true;
    this.banner.setAttribute('role', 'status');
    const bannerText = el('span');
    const bannerBtn = el('button', 'vm-btn');
    bannerBtn.type = 'button';
    bannerBtn.textContent = 'Play videos';
    bannerBtn.addEventListener('click', () => {
      this.setVideos(true);
      this.pool.unlock();
    });
    const bannerClose = el('button', 'vm-icon-btn');
    bannerClose.type = 'button';
    bannerClose.title = 'Dismiss';
    bannerClose.setAttribute('aria-label', 'Dismiss');
    bannerClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
    bannerClose.addEventListener('click', () => {
      this.bannerDismissed = true;
      this.banner.hidden = true;
    });
    this.banner.append(bannerText, bannerBtn, bannerClose);
    this.bannerText = bannerText;
    this.bannerBtn = bannerBtn;

    this.tooltip = el('div', 'vm-tooltip');
    this.tooltip.hidden = true;
    this.loading = el('div', 'vm-loading');
    this.loading.innerHTML = '<div class="vm-spinner"></div>';
    this.hud = el('pre', 'vm-hud');
    this.hud.hidden = !this.debug;

    root.append(this.canvas, this.videoHost, this.labelLayer, title, controls, this.banner, this.tooltip, this.loading, this.hud);
    // Any gesture is a chance to start videos that autoplay refused.
    root.addEventListener('pointerup', () => { if (this.pool?.blocked) this.pool.unlock(); });
  }

  resize() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    this.camera.setViewport(w, h);
    if (!this.homed) {
      this.camera.set(this.camera.homeView());
      this.homed = true;
    }
    this.players?.relayout();
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Input

  /** @returns {import('./input.js').InputHandlers} */
  inputHandlers() {
    return {
      pan: (dx, dy) => {
        this.camera.stop();
        this.camera.panBy(dx, dy);
        this.hideTooltip();
        this.moved = true;
      },
      zoom: (factor, x, y) => {
        this.camera.anim = null;
        this.camera.zoomAt(factor, x, y);
        this.moved = true;
      },
      tap: (x, y) => {
        const v = this.pick(x, y);
        if (v) this.open(v);
      },
      doubleTap: (x, y) => {
        if (!this.pick(x, y)) this.camera.flyTo(this.camera.zoomedView(2, x, y), performance.now(), 350);
      },
      press: (x, y) => this.showTooltip(x, y),
      hover: (x, y) => this.showTooltip(x, y),
      leave: () => this.hideTooltip(),
      gestureStart: () => this.camera.stop(),
      gestureEnd: (vx, vy) => this.camera.fling(vx, vy, performance.now()),
      key: (key) => this.onKey(key),
    };
  }

  onKey(key) {
    const now = performance.now();
    const step = 120;
    const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[key];
    if (pan) {
      const v = this.camera.view;
      this.camera.flyTo({ x: v.x - pan[0] / v.zoom, y: v.y - pan[1] / v.zoom, zoom: v.zoom }, now, 180);
      return true;
    }
    if (key === '+' || key === '=') return this.zoomBy(1.6), true;
    if (key === '-' || key === '_') return this.zoomBy(1 / 1.6), true;
    if (key === '0') return this.camera.flyTo(this.camera.homeView(), now), true;
    if (key === 'Escape') return this.players.closeTop();
    if (key === 'Enter') {
      const v = this.pick(this.camera.vw / 2, this.camera.vh / 2);
      if (v) this.open(v);
      return Boolean(v);
    }
    return false;
  }

  zoomBy(factor) {
    this.camera.flyTo(this.camera.zoomedView(factor, this.camera.vw / 2, this.camera.vh / 2), performance.now(), 300);
  }

  setVideos(on) {
    this.userToggled = true;
    this.videosOn = on && Boolean(this.videoSource);
    if (!this.videosOn) this.pool.clear();
    this.state.appliedSig = '';
    this.updateVideoToggle();
    this.dirty = true;
  }

  updateVideoToggle() {
    const on = this.videosOn;
    this.videoToggle.innerHTML = on ? ICONS.pause : ICONS.play;
    this.videoToggle.title = on ? 'Pause videos' : 'Play videos';
    this.videoToggle.setAttribute('aria-label', this.videoToggle.title);
    this.videoToggle.hidden = !this.videoSource;
  }

  // -------------------------------------------------------------------------
  // Picking and geometry

  /** Video under a viewport point, or null. */
  pick(sx, sy) {
    const p = this.camera.screenToContent(sx, sy);
    return p ? this.index.at(p.x, p.y) : null;
  }

  /** A video's rectangle in viewport CSS pixels (on a curved surface, its bounding box). */
  screenRect(v) {
    return this.wallToScreen(v.rect);
  }

  /**
   * A wall rectangle in viewport CSS pixels. On a curved surface it's the
   * bounding box of the part in view; `visible` is false when none of it is.
   * @param {{ x: number, y: number, w: number, h: number }} r
   * @returns {{ x: number, y: number, w: number, h: number, visible?: boolean }}
   */
  wallToScreen(r) {
    if (this.camera instanceof SurfaceCamera) return this.camera.rectToScreen(r);
    const p = this.camera.contentToScreen(r.x, r.y);
    return { x: p.x, y: p.y, w: r.w * this.camera.zoom, h: r.h * this.camera.zoom };
  }

  /** A tile's area on the wall, in wall pixels. */
  tileRect(z, x, y) {
    const s = this.levels[z].scale;
    return { x: (x * this.tile.w) / s, y: (y * this.tile.h) / s, w: this.tile.w / s, h: this.tile.h / s };
  }

  open(v) {
    if (!v.rect) return;
    this.hideTooltip();
    const cell = this.screenRect(v);
    const win = this.players.open(v, cell);
    // If the new window (e.g. the mobile sheet) covers its own cell, move the wall so the cell shows.
    const box = win.box();
    const cx = cell.x + cell.w / 2;
    const cy = cell.y + cell.h / 2;
    if (cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) this.locate(v, box);
  }

  /**
   * Fly the camera so the cell sits in the biggest area the window doesn't cover.
   * @param {any} v
   * @param {{ x: number, y: number, w: number, h: number } | null} windowRect viewer coordinates
   */
  locate(v, windowRect) {
    const cam = this.camera;
    const vw = cam.vw;
    const vh = cam.vh;
    let region = { x: 0, y: 0, w: vw, h: vh };
    if (windowRect) {
      const wx0 = windowRect.x;
      const wy0 = windowRect.y;
      const wx1 = wx0 + windowRect.w;
      const wy1 = wy0 + windowRect.h;
      const options = [
        { x: 0, y: 0, w: wx0, h: vh },
        { x: wx1, y: 0, w: vw - wx1, h: vh },
        { x: 0, y: 0, w: vw, h: wy0 },
        { x: 0, y: wy1, w: vw, h: vh - wy1 },
      ].filter((o) => o.w > 80 && o.h > 80);
      if (options.length) region = options.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    }
    const cell = v.rect;
    const zoom = Math.min(cam.maxZoom, Math.max(cam.minZoom, Math.min((region.w * 0.55) / cell.w, (region.h * 0.55) / cell.h)));
    const cx = cell.x + cell.w / 2 - (region.x + region.w / 2 - vw / 2) / zoom;
    const cy = cell.y + cell.h / 2 - (region.y + region.h / 2 - vh / 2) / zoom;
    cam.flyTo({ x: cx, y: cy, zoom }, performance.now(), 700);
  }

  // -------------------------------------------------------------------------
  // Tooltip and labels

  showTooltip(x, y) {
    const v = this.pick(x, y);
    if (v !== this.hover) {
      this.hover = v;
      this.dirty = true;
    }
    this.canvas.style.cursor = v ? 'pointer' : '';
    if (!v) return this.hideTooltip();
    const t = this.tooltip;
    if (t.dataset.id !== v.id) {
      t.dataset.id = v.id;
      t.replaceChildren();
      const title = el('strong');
      title.textContent = v.title;
      const meta = el('span');
      meta.textContent = [v.categories?.[0] && (this.catLabel.get(v.categories[0]) ?? v.categories[0]), ...(v.tags ?? []).slice(0, 3)].filter(Boolean).join(' · ');
      t.append(title, meta);
    }
    t.hidden = false;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const left = Math.min(x + 14, this.camera.vw - w - 8);
    const top = y + 18 + h > this.camera.vh ? y - h - 12 : y + 18;
    t.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }

  hideTooltip() {
    this.tooltip.hidden = true;
    if (this.hover) {
      this.hover = null;
      this.dirty = true;
    }
  }

  updateLabels() {
    const vw = this.camera.vw;
    const vh = this.camera.vh;
    for (const { g, el: label } of this.labels) {
      const p = this.wallToScreen(g);
      const { w, h } = p;
      const visible = p.visible !== false && w >= 90 && p.x < vw && p.y < vh && p.x + w > 0 && p.y + h > 0;
      label.hidden = !visible;
      if (visible) {
        // Stick to the top-left of the visible part of the group.
        const x = Math.min(Math.max(p.x, 8), p.x + w - label.offsetWidth - 4);
        const y = Math.min(Math.max(p.y, 64), p.y + h - label.offsetHeight - 4);
        label.style.transform = `translate(${Math.round(x + 6)}px, ${Math.round(y + 6)}px)`;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Deep links

  applyHash(fromEvent) {
    const { v, cam } = parseHash(location.hash);
    const now = performance.now();
    if (cam) {
      if (fromEvent) this.camera.flyTo(cam, now);
      else this.camera.set(cam);
    }
    const video = v ? this.byId.get(v) : null;
    if (video?.rect && !this.players.windows.some((w) => w.video === video)) {
      if (!cam) this.camera.set(this.camera.viewForRect(video.rect, { fraction: 0.4 }));
      this.open(video);
    }
    this.dirty = true;
  }

  writeHash() {
    clearTimeout(this.hashTimer);
    this.hashTimer = window.setTimeout(() => {
      const hash = formatHash({ cam: this.camera.view, v: this.players.focused?.video.id ?? null });
      if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname + location.search);
    }, 350);
  }

  // -------------------------------------------------------------------------
  // Frame loop

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    if (this.renderer.lost) return;
    const cam = this.camera;
    const camChanged = cam.step(now) || this.moved;
    this.moved = false;
    if (camChanged) this.writeHash();
    this.measure(now);

    const ratio = Math.min(window.devicePixelRatio || 1, this.tier.pixelRatio);
    const budget = this.videosOn ? this.pool.size : Math.max(4, Math.floor(this.tier.stillCache / 2));
    const lod = { levels: this.levels, zoom: cam.zoom, pixelRatio: ratio, bias: this.lodBias, budget };
    let choice;
    let tiles;
    if (cam instanceof SurfaceCamera) {
      // Rays through the screen find the visible tiles, already nearest-first. The zoom at the middle sets the level.
      choice = chooseLevel({ ...lod, tilesAt: (z) => cam.visibleTiles(this.levels[z], this.tile, this.occupied[z]) });
      tiles = choice.tiles;
    } else {
      choice = chooseLevel({ ...lod, tile: this.tile, occupied: this.occupied, rect: cam.visibleRect() });
      tiles = byDistance(choice.tiles, this.levels[choice.z], this.tile, cam.x, cam.y);
    }
    const levelChanged = choice.z !== this.state.z || tiles.join(';') !== this.state.tiles.join(';');
    this.state.z = choice.z;
    this.state.ideal = choice.ideal;
    this.state.tiles = tiles;

    if (this.videosOn && !document.hidden) this.schedule(choice.z, tiles, now);
    this.pool.poll(now);
    if (now - this.lastCorrect > 250) {
      this.pool.correct(now);
      this.lastCorrect = now;
    }
    const uploads = this.pool.upload(this.tier.uploads);
    this.wantStills(choice.z, tiles, now);

    if (camChanged || levelChanged || uploads || this.dirty || this.players.windows.length) {
      this.render(choice.z, tiles, now);
      this.dirty = false;
    }
    const viewKey = `${cam.x},${cam.y},${cam.zoom},${cam.vw},${cam.vh}`;
    if (viewKey !== this.lastViewKey) {
      this.lastViewKey = viewKey;
      this.updateLabels();
    }
    if (this.players.windows.length) this.players.frame();
    this.updateBanner();
    if (this.debug && now - (this.lastHud ?? 0) > 250) this.updateHud(now, uploads);
  }

  /** Ask the pool for the visible tiles, waiting for the set to settle while the camera moves. */
  schedule(z, tiles, now) {
    if (!this.videoSource) return;
    const s = this.state;
    const wanted = tiles.map(([x, y]) => ({ key: `${z}/${x}/${y}`, url: this.url(this.videoSource.template, z, x, y), tight: this.shared[z].has(`${x},${y}`) }));
    // A spare decoder plays the overview, which stands in anywhere a finer tile is still loading.
    if (z > 0 && wanted.length < this.pool.size) wanted.push({ key: '0/0/0', url: this.url(this.videoSource.template, 0, 0, 0) });
    const sig = wanted.map((w) => w.key).join('|');
    if (sig !== s.wantSig) {
      s.wantSig = sig;
      s.wantSince = now;
    }
    const settle = this.camera.moving || this.input.active ? 220 : 40;
    if (sig !== s.appliedSig && now - s.wantSince >= settle) {
      this.pool.update(wanted, now);
      s.appliedSig = sig;
    }
  }

  wantStills(z, tiles, now) {
    if (!this.stillSource) return;
    const t = this.stillSource.template;
    this.stills.want('0/0/0', this.url(t, 0, 0, 0), 0, now, true);
    tiles.forEach(([x, y], i) => this.stills.want(`${z}/${x}/${y}`, this.url(t, z, x, y), 1 + i, now));
    this.stills.pump(now);
  }

  url(template, z, x, y) {
    return new URL(template.replace('{z}', z).replace('{x}', x).replace('{y}', y), this.base).href;
  }

  texture(z, x, y) {
    const key = `${z}/${x}/${y}`;
    return this.pool.texture(key) ?? this.stills.texture(key);
  }

  render(z, tiles, now) {
    const r = this.renderer;
    const cam = this.camera;
    r.resize(cam.vw, cam.vh, Math.min(window.devicePixelRatio || 1, 2));
    r.begin(this.outside);
    const wall = { x: 0, y: 0, w: this.scene.content.width, h: this.scene.content.height };

    let drawn = 0;
    if (cam instanceof SurfaceCamera) {
      // No depth buffer: from inside, nothing on the surface hides anything else. From
      // outside, the near side always covers the far side, so the back of the wall
      // (seen past an open end or edge) goes first, as a plain color.
      r.setSurface(this.geo, cam.matrix(), cam.pose.eye);
      if (!this.geo.inside) r.meshFill(wall, [...this.bg.map((c) => c * 0.8), 1], -1);
      // The overview under everything, so tiles the screen rays missed never leave a hole.
      const base = this.texture(0, 0, 0);
      const s0 = this.levels[0].scale;
      if (base) {
        this.patch(base, wall, { u0: 0, v0: 0, u1: (wall.w * s0) / this.tile.w, v1: (wall.h * s0) / this.tile.h });
        drawn++;
      } else this.fill(wall, [...this.bg, 1]);
      if (z > 0) for (const [x, y] of tiles) if (this.drawTile(z, x, y)) drawn++;
    } else {
      this.fill(wall, [...this.bg, 1]);
      for (const [x, y] of tiles) if (this.drawTile(z, x, y)) drawn++;
    }
    if (drawn && !this.firstPaint) {
      this.firstPaint = true;
      this.loading.classList.add('vm-done');
    }
    this.drawDividers();

    if (this.hover && !this.players.videos.includes(this.hover)) this.outline(this.hover.rect, [1, 1, 1, 0.55], 1.5);
    const pulse = 0.75 + 0.25 * Math.sin(now / 260);
    const focused = this.players.focused?.video;
    for (const v of this.players.videos) {
      this.outline(v.rect, [ACCENT[0], ACCENT[1], ACCENT[2], v === focused ? pulse : 0.6], v === focused ? 2.5 : 1.5);
    }
  }

  /** Which side of a curved surface shows the wall: the inner side from inside, the outer from outside. */
  get face() {
    return this.geo?.inside ? -1 : 1;
  }

  /**
   * Draw a texture, or the `uv` part of it, over a wall rectangle.
   * @param {import('./renderer.js').TextureInfo} tex
   * @param {{ x: number, y: number, w: number, h: number }} rect wall pixels
   * @param {{ u0: number, v0: number, u1: number, v1: number }} [uv]
   */
  patch(tex, rect, uv = { u0: 0, v0: 0, u1: 1, v1: 1 }) {
    if (!this.geo) return this.renderer.drawTexture(tex, this.wallToScreen(rect), uv);
    // Edge tiles run past the wall; on a surface that would overlap the far edge (or hang off the end), so clip.
    const c = this.clipToWall(rect);
    if (!c) return;
    const du = (uv.u1 - uv.u0) / rect.w;
    const dv = (uv.v1 - uv.v0) / rect.h;
    this.renderer.meshTexture(tex, c, { u0: uv.u0 + (c.x - rect.x) * du, v0: uv.v0 + (c.y - rect.y) * dv, u1: uv.u0 + (c.x + c.w - rect.x) * du, v1: uv.v0 + (c.y + c.h - rect.y) * dv }, this.face);
  }

  /** @param {{ x: number, y: number, w: number, h: number }} rect wall pixels @param {number[]} rgba */
  fill(rect, rgba) {
    if (!this.geo) return this.renderer.fillRect(this.wallToScreen(rect), rgba);
    const c = this.clipToWall(rect);
    if (c) this.renderer.meshFill(c, rgba, this.face);
  }

  /** @param {{ x: number, y: number, w: number, h: number }} rect wall pixels @param {number[]} rgba @param {number} width CSS px */
  outline(rect, rgba, width) {
    if (!this.geo) return this.renderer.outline(this.wallToScreen(rect), rgba, width);
    const s = this.wallToScreen(rect);
    if (s.visible === false) return;
    // Size the line from the rectangle's size on screen; pad by the glow's width in wall pixels.
    const pad = (width * 2) / Math.max(1e-6, Math.max(s.w / rect.w, s.h / rect.h));
    const k = { w: (s.w * (rect.w + pad * 2)) / rect.w, h: (s.h * (rect.h + pad * 2)) / rect.h };
    this.renderer.meshOutline(rect, rgba, width, pad, k, this.face);
  }

  clipToWall(r) {
    const W = this.scene.content.width;
    const H = this.scene.content.height;
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(W, r.x + r.w);
    const y1 = Math.min(H, r.y + r.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Masonry column groups sit edge to edge, so a thin line marks where one group ends and the next begins. */
  drawDividers() {
    const l = this.scene.layout;
    if (l.pack !== 'masonry' || l.groupArrange !== 'columns') return;
    const cam = this.camera;
    // Line width in wall pixels: 1–2 CSS px.
    const w = Math.max(1, Math.min(2, (l.gap || 4) * cam.zoom)) / cam.zoom;
    for (const g of this.scene.groups) {
      if (g.x <= 0) continue;
      this.fill({ x: g.x - (l.gap ?? 0) / 2 - w / 2, y: g.y, w, h: g.h }, [1, 1, 1, 0.16]);
    }
  }

  /**
   * Draw a tile with the best texture available: its own video or still, else its
   * children (when zooming out), else the matching part of the nearest ancestor.
   */
  drawTile(z, x, y) {
    const rect = this.tileRect(z, x, y);
    const own = this.texture(z, x, y);
    if (own) {
      this.patch(own, rect);
      return true;
    }
    if (z < this.levels.length - 1) {
      const next = this.levels[z + 1];
      const kids = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = x * 2 + dx;
          const cy = y * 2 + dy;
          if (z > 0 && cx < next.tilesX && cy < next.tilesY && this.occupied[z + 1].has(`${cx},${cy}`)) kids.push([cx, cy]);
        }
      }
      const texs = kids.map(([cx, cy]) => this.texture(z + 1, cx, cy));
      if (kids.length && texs.every(Boolean)) {
        kids.forEach(([cx, cy], i) => this.patch(texs[i], this.tileRect(z + 1, cx, cy)));
        return true;
      }
    }
    // Ancestors: find the tile that contains this one's area at each coarser level.
    const s = this.levels[z].scale;
    const cx0 = (x * this.tile.w) / s;
    const cy0 = (y * this.tile.h) / s;
    const cw = this.tile.w / s;
    const ch = this.tile.h / s;
    for (let pz = z - 1; pz >= 0; pz--) {
      const ps = this.levels[pz].scale;
      const ax = Math.floor((cx0 * ps) / this.tile.w);
      const ay = Math.floor((cy0 * ps) / this.tile.h);
      const tex = this.texture(pz, ax, ay);
      if (!tex) continue;
      const u0 = (cx0 * ps - ax * this.tile.w) / this.tile.w;
      const v0 = (cy0 * ps - ay * this.tile.h) / this.tile.h;
      this.patch(tex, rect, { u0, v0, u1: u0 + (cw * ps) / this.tile.w, v1: v0 + (ch * ps) / this.tile.h });
      return true;
    }
    return false;
  }

  updateBanner() {
    let text = '';
    if (!this.videoSource) text = "This browser can't play this wall's videos, so it shows still frames.";
    else if (this.videosOn && this.pool.blocked) text = 'This browser paused the videos.';
    else if (this.quietStart && !this.userToggled) text = 'Videos are paused to reduce motion.';
    this.bannerBtn.hidden = !this.videoSource;
    const show = Boolean(text) && !this.bannerDismissed;
    if (show !== !this.banner.hidden) this.banner.hidden = !show;
    if (show && this.bannerText.textContent !== text) this.bannerText.textContent = text;
  }

  /** Track frame times; when playback can't keep up, decode fewer videos. */
  measure(now) {
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 2000) this.frames.shift();
    if (!this.adapt || now - this.lastAdapt < 2000) return;
    this.lastAdapt = now;
    const fps = (this.frames.length - 1) / ((now - this.frames[0]) / 1000 || 1);
    if (this.videosOn && this.pool.playing >= 2 && fps < 22 && !document.hidden) this.slowWindows++;
    else this.slowWindows = 0;
    if (this.slowWindows >= 2 && this.pool.size > 1 && this.downgrades < 3) {
      this.slowWindows = 0;
      this.downgrades++;
      this.pool.resize(Math.max(1, Math.round(this.pool.size * 0.7)));
      this.lodBias *= 0.85;
      this.state.appliedSig = '';
    }
  }

  updateHud(now, uploads) {
    this.lastHud = now;
    const fps = this.frames.length > 1 ? ((this.frames.length - 1) / ((now - this.frames[0]) / 1000)).toFixed(0) : '–';
    const slots = this.pool.slots.map((s) => s.state[0]).join('');
    this.hud.textContent = [
      `fps ${fps}  tier ${this.tier.name}${this.downgrades ? ` (-${this.downgrades})` : ''}`,
      `level ${this.state.z}/${this.levels.length - 1} (ideal ${this.state.ideal})  tiles ${this.state.tiles.length}`,
      `videos ${this.videosOn ? `${this.pool.playing}/${this.pool.size}` : 'off'} [${slots}]  drift ${(this.pool.maxDrift * 1000).toFixed(0)}ms`,
      `uploads ${uploads}/frame  seeks ${this.pool.stats.seeks}  stills ${this.stills.count}`,
      `zoom ${this.camera.zoom.toFixed(3)}  ${this.geo ? `${this.geo.type} ${this.geo.inside ? 'inside' : 'outside'}` : 'plane'}  codec ${this.videoSource?.mime.split('"')[1] ?? 'none'}`,
    ].join('\n');
  }
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
