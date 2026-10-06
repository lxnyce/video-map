// Facts about a project's source videos for the editor: probe results (the
// live layout preview needs each video's shape and length, the size estimate
// its codecs) and small thumbnails for the library. Both are cached in the
// project's .studio folder, keyed by the file's path, size and modification
// time, like the build cache.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probe } from '@videomap/builder';

const THUMB_WIDTH = 320;

export class MediaInfo {
  /**
   * @param {object} o
   * @param {ReturnType<typeof import('@videomap/builder').createTools>} o.tools
   * @param {() => Promise<{ libwebp: boolean }>} o.caps  ffmpeg capabilities (lazily detected)
   * @param {number} [o.jobs]
   */
  constructor({ tools, caps, jobs = 4 }) {
    this.tools = tools;
    this.caps = caps;
    // Separate queues, so a page of thumbnails doesn't hold up the probes the layout preview waits for.
    this.probeLimit = limiter(jobs);
    this.thumbLimit = limiter(Math.max(1, Math.ceil(jobs / 2)));
    /** @type {Map<string, Promise<Record<string, any>>>} project dir → probe cache */
    this.probeCaches = new Map();
    /** @type {Map<string, Promise<any>>} in-flight work by key */
    this.pending = new Map();
    /** @type {Map<string, { writing: Promise<void>, again: boolean }>} probe cache writes per project, one at a time */
    this.saving = new Map();
  }

  /**
   * Probe a file (cached).
   * @param {import('./projects.js').Project} project
   * @param {string} file absolute path
   * @returns {Promise<Awaited<ReturnType<typeof probe>>>}
   */
  async probe(project, file) {
    const fp = await fingerprint(file);
    const cache = await this.probeCache(project);
    if (cache[fp]) return cache[fp];
    return this.once(`probe|${fp}`, () => this.probeLimit(async () => {
      const info = await probe(this.tools, file);
      cache[fp] = info;
      this.saveProbes(project, cache);
      return info;
    }));
  }

  /**
   * A thumbnail image for a file, made on first request.
   * @param {import('./projects.js').Project} project
   * @param {string} file
   * @returns {Promise<{ file: string, etag: string }>}
   */
  async thumbnail(project, file) {
    const fp = await fingerprint(file);
    const { libwebp } = await this.caps();
    const etag = createHash('sha1').update(`${fp}|${THUMB_WIDTH}`).digest('hex').slice(0, 20);
    const out = path.join(project.studioDir, 'thumbs', `${etag}.${libwebp ? 'webp' : 'jpg'}`);
    if (await stat(out).catch(() => null)) return { file: out, etag };
    return this.once(`thumb|${out}`, async () => {
      const info = await this.probe(project, file);
      await this.thumbLimit(async () => {
        await mkdir(path.dirname(out), { recursive: true });
        const tmp = out.replace(/(\.\w+)$/, `.partial-${process.pid}$1`);
        // A frame a little way in: the very first one is often black.
        const time = Math.round(Math.min(info.duration * 0.1 + 0.5, info.duration / 2) * 1000) / 1000;
        await this.tools.run([
          '-ss', String(time), '-i', file, '-frames:v', '1',
          '-vf', `scale='min(${THUMB_WIDTH},iw)':-2:flags=bicubic`,
          ...(libwebp ? ['-c:v', 'libwebp', '-quality', '75'] : ['-q:v', '5']),
          tmp,
        ]);
        await rename(tmp, out);
      });
      return { file: out, etag };
    });
  }

  /** Run `fn` once per key at a time; concurrent callers share the result. */
  once(key, fn) {
    let p = this.pending.get(key);
    if (!p) {
      p = fn().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  /** @param {import('./projects.js').Project} project */
  probeCache(project) {
    let p = this.probeCaches.get(project.dir);
    if (!p) {
      p = readFile(path.join(project.studioDir, 'probes.json'), 'utf8').then(JSON.parse, () => ({}));
      this.probeCaches.set(project.dir, p);
    }
    return p;
  }

  /** Forget a deleted project's cache. @param {import('./projects.js').Project} project */
  forget(project) {
    this.probeCaches.delete(project.dir);
  }

  /**
   * Write a project's probe cache. Writes are serialized (on Windows, two
   * renames onto the same file at once fail) and coalesced: probes finishing
   * during a write are saved by one more write after it. A failed write only
   * costs a re-probe later.
   */
  saveProbes(project, cache) {
    const state = this.saving.get(project.dir);
    if (state) {
      state.again = true;
      return state.writing;
    }
    const file = path.join(project.studioDir, 'probes.json');
    const entry = { writing: Promise.resolve(), again: false };
    entry.writing = (async () => {
      do {
        entry.again = false;
        try {
          await mkdir(project.studioDir, { recursive: true });
          const tmp = `${file}.tmp-${process.pid}`;
          await writeFile(tmp, JSON.stringify(cache));
          await rename(tmp, file);
        } catch (err) {
          console.error(`Couldn't save the probe cache ${file}: ${err.message}`);
        }
      } while (entry.again);
      this.saving.delete(project.dir);
    })();
    this.saving.set(project.dir, entry);
    return entry.writing;
  }

}

/** Identity of a file: path, size and modification time. @param {string} file */
async function fingerprint(file) {
  const s = await stat(file);
  return `${path.resolve(file)}|${s.size}|${Math.round(s.mtimeMs)}`;
}

/**
 * At most `n` jobs at a time. Unlike the builder's limiter, a failure doesn't
 * cancel the queue: one unreadable upload mustn't stop every later probe.
 * @param {number} n
 */
export function limiter(n) {
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          queue.shift()?.();
        });
      };
      if (active < n) start();
      else queue.push(start);
    });
  };
}
