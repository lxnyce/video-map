// The video pool: a fixed number of muted inline <video> elements (the decoder
// budget), each with its own texture. Tiles are assigned to slots by priority;
// a slot whose tile is no longer wanted pauses but keeps its source, so
// panning back to it is instant. Every playing slot follows one master clock.

const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const HARD_DRIFT = 0.3;  // seconds: seek
const RATE_GAIN = 0.5;   // playbackRate nudge per second of drift
const COOLDOWN = 600;    // ms after a correction before the next one

/**
 * @typedef {object} Slot
 * @property {HTMLVideoElement} el
 * @property {import('./renderer.js').TextureInfo} tex
 * @property {string|null} key
 * @property {'free'|'loading'|'playing'|'idle'} state
 * @property {boolean} ready     texture holds a frame of the current tile
 * @property {boolean} dirty     a new frame is waiting to be uploaded
 * @property {number} lastWanted
 * @property {number} drift      seconds, video minus master clock
 * @property {number} cooldownUntil
 * @property {number} seekLead
 * @property {number} seekAt
 * @property {number} lastTime   fallback frame detection
 * @property {number} generation increments on reassignment so stale callbacks are ignored
 */

export class VideoPool {
  /**
   * @param {object} o
   * @param {number} o.size
   * @param {HTMLElement} o.host  container for the (invisible) video elements
   * @param {import('./renderer.js').Renderer} o.renderer
   * @param {(t?: number) => number} o.clock master time in seconds at performance.now() t
   * @param {number} o.duration loop length in seconds
   */
  constructor({ size, host, renderer, clock, duration }) {
    this.host = host;
    this.renderer = renderer;
    this.clock = clock;
    this.duration = duration;
    /** @type {Slot[]} */
    this.slots = [];
    this.paused = false;
    /** Autoplay was refused; playback needs a user gesture. */
    this.blocked = false;
    /** @type {Set<string>} tiles that failed to load; drawn from stills instead */
    this.failed = new Set();
    this.rr = 0;
    this.stats = { assigned: 0, seeks: 0, uploads: 0 };
    this.resize(size);
  }

  get size() {
    return this.slots.length;
  }

  resize(n) {
    while (this.slots.length < n) this.slots.push(this.createSlot());
    while (this.slots.length > n) {
      // Drop the least useful slot: free first, then the longest-idle.
      const order = [...this.slots].sort((a, b) => rank(a) - rank(b) || a.lastWanted - b.lastWanted);
      this.disposeSlot(order[0]);
      this.slots.splice(this.slots.indexOf(order[0]), 1);
    }
  }

  /** @returns {Slot} */
  createSlot() {
    const el = document.createElement('video');
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.setAttribute('muted', '');
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.loop = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.disablePictureInPicture = true;
    this.host.append(el);
    /** @type {Slot} */
    const slot = {
      el, tex: this.renderer.createTexture(), key: null, state: 'free', ready: false, dirty: false,
      lastWanted: 0, drift: 0, cooldownUntil: 0, seekLead: 0.12, seekAt: 0, lastTime: -1, generation: 0,
    };
    el.addEventListener('loadedmetadata', () => {
      if (slot.state !== 'free') this.seek(slot, this.clock() + slot.seekLead);
    });
    el.addEventListener('seeked', () => {
      const took = (performance.now() - slot.seekAt) / 1000;
      if (took > 0 && took < 2) slot.seekLead = slot.seekLead * 0.6 + took * 0.4;
    });
    el.addEventListener('error', () => {
      if (slot.key) this.failed.add(slot.key);
      this.release(slot);
    });
    return slot;
  }

  disposeSlot(slot) {
    this.release(slot);
    slot.el.remove();
    this.renderer.deleteTexture(slot.tex);
  }

  release(slot) {
    slot.generation++;
    slot.key = null;
    slot.state = 'free';
    slot.ready = false;
    slot.dirty = false;
    slot.el.pause();
    slot.el.removeAttribute('src');
    slot.el.load(); // frees the decoder now rather than at garbage collection
  }

  /**
   * Make the pool play these tiles (highest priority first).
   * @param {Array<{ key: string, url: string }>} wanted
   * @param {number} now
   */
  update(wanted, now) {
    const want = new Map();
    for (const w of wanted) {
      if (want.size >= this.slots.length) break;
      if (!this.failed.has(w.key)) want.set(w.key, w);
    }
    for (const slot of this.slots) {
      if (slot.key && want.has(slot.key)) {
        slot.lastWanted = now;
        if (slot.state === 'idle') this.resume(slot);
        want.delete(slot.key);
      } else if (slot.state === 'loading' || slot.state === 'playing') {
        slot.state = 'idle';
        slot.el.pause();
      }
    }
    for (const w of want.values()) {
      const slot = this.slots.find((s) => s.state === 'free')
        ?? this.slots.filter((s) => s.state === 'idle').sort((a, b) => a.lastWanted - b.lastWanted)[0];
      if (!slot) break;
      this.assign(slot, w, now);
    }
  }

  assign(slot, w, now) {
    slot.generation++;
    slot.key = w.key;
    slot.state = 'loading';
    slot.ready = false;
    slot.dirty = false;
    slot.lastWanted = now;
    slot.lastTime = -1;
    slot.drift = 0;
    slot.el.playbackRate = 1;
    slot.el.src = w.url;
    this.stats.assigned++;
    this.play(slot);
    this.watchFrames(slot);
  }

  resume(slot) {
    slot.state = slot.ready ? 'playing' : 'loading';
    slot.cooldownUntil = 0;
    if (slot.el.readyState >= 1) this.seek(slot, this.clock() + slot.seekLead);
    this.play(slot);
  }

  play(slot) {
    if (this.paused) return;
    const p = slot.el.play();
    if (p) {
      p.then(() => { this.blocked = false; }, (err) => {
        if (err?.name === 'NotAllowedError') this.blocked = true;
      });
    }
  }

  watchFrames(slot) {
    if (!HAS_RVFC) return;
    const gen = slot.generation;
    const onFrame = (_now, md) => {
      if (slot.generation !== gen) return;
      this.onFrame(slot, md.mediaTime, md.expectedDisplayTime);
      slot.el.requestVideoFrameCallback(onFrame);
    };
    slot.el.requestVideoFrameCallback(onFrame);
  }

  onFrame(slot, mediaTime, displayTime) {
    if (slot.state === 'free') return;
    slot.dirty = true;
    slot.drift = wrap(mediaTime - this.clock(displayTime), this.duration);
  }

  /** Detect new frames without requestVideoFrameCallback. */
  poll(now) {
    if (HAS_RVFC) return;
    for (const slot of this.slots) {
      if (slot.state !== 'loading' && slot.state !== 'playing') continue;
      const t = slot.el.currentTime;
      if (t !== slot.lastTime && slot.el.readyState >= 2) {
        slot.lastTime = t;
        this.onFrame(slot, t, now);
      }
    }
  }

  /**
   * Upload new frames, at most `max` per call, round-robin so no tile starves.
   * @param {number} max
   * @returns {number} uploads done
   */
  upload(max) {
    let done = 0;
    const n = this.slots.length;
    for (let k = 0; k < n && done < max; k++) {
      const i = (this.rr + k) % n;
      const slot = this.slots[i];
      if (!slot.dirty || (slot.state !== 'loading' && slot.state !== 'playing')) continue;
      const el = slot.el;
      if (el.readyState < 2 || !el.videoWidth) continue;
      try {
        this.renderer.upload(slot.tex, el, el.videoWidth, el.videoHeight);
      } catch {
        if (slot.key) this.failed.add(slot.key);
        this.release(slot);
        continue;
      }
      slot.dirty = false;
      slot.ready = true;
      if (slot.state === 'loading') slot.state = 'playing';
      done++;
      this.rr = (i + 1) % n;
    }
    this.stats.uploads += done;
    return done;
  }

  /** Nudge playing slots back onto the master clock. */
  correct(now) {
    for (const slot of this.slots) {
      const el = slot.el;
      if (slot.state !== 'playing' || el.paused || el.seeking || now < slot.cooldownUntil) continue;
      const a = Math.abs(slot.drift);
      if (a > HARD_DRIFT) {
        el.playbackRate = 1;
        this.seek(slot, this.clock() + slot.seekLead);
      } else if (a > 0.04) {
        el.playbackRate = Math.min(1.1, Math.max(0.9, 1 - slot.drift * RATE_GAIN));
        slot.cooldownUntil = now + COOLDOWN;
      } else if (el.playbackRate !== 1) {
        el.playbackRate = 1;
      }
    }
  }

  seek(slot, t) {
    slot.seekAt = performance.now();
    slot.cooldownUntil = slot.seekAt + COOLDOWN;
    slot.el.currentTime = ((t % this.duration) + this.duration) % this.duration;
    this.stats.seeks++;
  }

  /** Texture for a tile if it is playing and has a frame. @param {string} key */
  texture(key) {
    for (const slot of this.slots) if (slot.key === key && slot.ready && slot.state === 'playing') return slot.tex;
    return null;
  }

  get playing() {
    return this.slots.filter((s) => s.state === 'playing' || s.state === 'loading').length;
  }

  get maxDrift() {
    return Math.max(0, ...this.slots.filter((s) => s.state === 'playing').map((s) => Math.abs(s.drift)));
  }

  pauseAll() {
    this.paused = true;
    for (const s of this.slots) s.el.pause();
  }

  resumeAll() {
    this.paused = false;
    for (const s of this.slots) if (s.state === 'playing' || s.state === 'loading') this.resume(s);
  }

  /** Call from a user gesture to retry playback after autoplay was refused. */
  unlock() {
    for (const s of this.slots) if (s.state === 'playing' || s.state === 'loading') this.play(s);
  }

  /** Release every slot (e.g. when videos are turned off). */
  clear() {
    for (const s of this.slots) if (s.state !== 'free') this.release(s);
  }

  /** After WebGL context loss: textures are gone, so frames must be re-uploaded. */
  resetTextures() {
    for (const s of this.slots) {
      s.tex = this.renderer.createTexture();
      s.ready = false;
      s.dirty = s.state !== 'free';
    }
  }
}

function rank(slot) {
  return slot.state === 'free' ? 0 : slot.state === 'idle' ? 1 : 2;
}

function wrap(x, d) {
  return ((((x + d / 2) % d) + d) % d) - d / 2;
}
