// Still images of tiles (first frames), loaded as textures. They give an
// instant first paint and fill in while tile videos start. LRU-evicted to a
// per-tier texture budget; the level-0 overview is never evicted.

/**
 * @typedef {object} StillEntry
 * @property {string} key
 * @property {string} url
 * @property {'queued'|'loading'|'ready'|'error'} state
 * @property {import('./renderer.js').TextureInfo|null} tex
 * @property {number} lastUsed
 * @property {number} priority lower loads first
 * @property {boolean} pinned
 */

export class StillCache {
  /**
   * @param {object} o
   * @param {import('./renderer.js').Renderer} o.renderer
   * @param {number} o.limit textures kept
   * @param {number} [o.concurrency]
   * @param {() => void} [o.onLoad]
   */
  constructor({ renderer, limit, concurrency = 6, onLoad = () => {} }) {
    this.renderer = renderer;
    this.limit = limit;
    this.concurrency = concurrency;
    this.onLoad = onLoad;
    /** @type {Map<string, StillEntry>} */
    this.entries = new Map();
    this.loading = 0;
  }

  /**
   * Ask for a still this frame.
   * @param {string} key
   * @param {string} url
   * @param {number} priority
   * @param {number} now
   * @param {boolean} [pinned]
   */
  want(key, url, priority, now, pinned = false) {
    let e = this.entries.get(key);
    if (!e) {
      e = { key, url, state: 'queued', tex: null, lastUsed: now, priority, pinned };
      this.entries.set(key, e);
    }
    e.lastUsed = now;
    e.priority = priority;
    e.pinned ||= pinned;
  }

  /** @param {string} key */
  texture(key) {
    const e = this.entries.get(key);
    return e?.state === 'ready' ? e.tex : null;
  }

  /** Start queued loads (highest priority first) and evict beyond the limit. */
  pump(now) {
    if (this.loading < this.concurrency) {
      const queued = [...this.entries.values()]
        .filter((e) => e.state === 'queued' && now - e.lastUsed < 1000)
        .sort((a, b) => a.priority - b.priority);
      for (const e of queued.slice(0, this.concurrency - this.loading)) this.load(e);
    }
    this.evict(now);
  }

  load(e) {
    e.state = 'loading';
    this.loading++;
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.src = e.url;
    const done = () => { this.loading--; };
    img.decode().then(() => {
      done();
      if (this.entries.get(e.key) !== e) return; // evicted or reset while loading
      e.tex = this.renderer.createTexture();
      this.renderer.upload(e.tex, img, img.naturalWidth, img.naturalHeight);
      e.state = 'ready';
      this.onLoad();
    }, () => {
      done();
      e.state = 'error';
    });
  }

  evict(now) {
    const ready = [...this.entries.entries()].filter(([, e]) => e.state === 'ready' && !e.pinned);
    let excess = ready.length - this.limit;
    if (excess <= 0) return;
    ready.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, e] of ready) {
      if (excess <= 0 || now - e.lastUsed < 50) break;
      this.renderer.deleteTexture(e.tex);
      this.entries.delete(key);
      excess--;
    }
  }

  /** After WebGL context loss: reload everything. */
  reset() {
    for (const e of this.entries.values()) {
      e.tex = null;
      if (e.state === 'ready') e.state = 'queued';
    }
  }

  get count() {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === 'ready') n++;
    return n;
  }
}
