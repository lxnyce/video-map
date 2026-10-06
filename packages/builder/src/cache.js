// Build cache: probe results, normalized clips and tile masters, keyed by
// content hashes so unchanged work is skipped on the next build.

/** Folders of large intermediates; probes.json and outputs.json are small and stay. */
const INTERMEDIATES = ['clips', 'masters'];

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class BuildCache {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = path.resolve(dir);
    /** @type {Record<string, import('./probe.js').ProbeInfo>} */
    this.probes = {};
    /** @type {Record<string, Record<string, string>>} output dir → relative path → key */
    this.outputs = {};
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    this.probes = await readJson(path.join(this.dir, 'probes.json'), {});
    this.outputs = await readJson(path.join(this.dir, 'outputs.json'), {});
  }

  async save() {
    await writeJsonAtomic(path.join(this.dir, 'probes.json'), this.probes);
    await writeJsonAtomic(path.join(this.dir, 'outputs.json'), this.outputs);
  }

  /** Stable short hash of any JSON-serializable parts. */
  key(...parts) {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
  }

  /** Path for a cached artifact, sharded by key prefix. */
  file(kind, key, ext) {
    return path.join(this.dir, kind, key.slice(0, 2), `${key}.${ext}`);
  }

  /**
   * Identity of a source: path, size and mtime for files; the URL for remote sources.
   * @param {string} src
   */
  async fingerprint(src) {
    if (isUrl(src)) return src;
    const s = await stat(src);
    return `${path.resolve(src)}|${s.size}|${Math.round(s.mtimeMs)}`;
  }

  /** @param {string} outDir @param {string} rel */
  outputKey(outDir, rel) {
    return this.outputs[path.resolve(outDir)]?.[rel];
  }

  /** @param {string} outDir @param {string} rel @param {string} key */
  setOutputKey(outDir, rel, key) {
    const k = path.resolve(outDir);
    (this.outputs[k] ??= {})[rel] = key;
  }

  /** Bytes on disk. */
  size() {
    return dirSize(this.dir);
  }

  /**
   * Delete the cached clips and tile masters (--no-keep-cache). The next build
   * re-encodes every tile from the sources; full renditions and posters in the
   * output folder are still reused.
   */
  async clearIntermediates() {
    for (const d of INTERMEDIATES) await rm(path.join(this.dir, d), { recursive: true, force: true });
  }

  /** Forget output records that this build didn't produce. @param {string} outDir @param {Set<string>} keep */
  pruneOutputs(outDir, keep) {
    const rec = this.outputs[path.resolve(outDir)];
    if (!rec) return;
    for (const rel of Object.keys(rec)) if (!keep.has(rel)) delete rec[rel];
  }
}

/**
 * Delete a whole build cache folder (`vmap clean`). Refuses folders that don't
 * look like a vmap cache, so a wrong --cache can't delete anything else.
 * @param {string} dir
 * @returns {Promise<number|null>} bytes freed, or null if there was no cache
 */
export async function cleanCache(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const known = new Set([...INTERMEDIATES, 'probes.json', 'outputs.json']);
  const foreign = entries.filter((e) => !known.has(e) && !/.tmp-d+$/.test(e));
  if (foreign.length) {
    throw new Error(`${dir} doesn't look like a vmap build cache (it contains ${foreign.slice(0, 3).join(', ')}); not deleting it.`);
  }
  const bytes = await dirSize(dir);
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

/** Total size of the files under a folder (0 if it doesn't exist). @param {string} dir @returns {Promise<number>} */
export async function dirSize(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

/** @param {string} s */
export function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` with temporary paths for each target, then move them into place.
 * Partial files never land at the final path, so an interrupted build can't
 * leave a corrupt cache entry or output.
 * @param {string[]} targets final paths
 * @param {(temps: string[]) => Promise<void>} fn
 */
export async function produce(targets, fn) {
  const temps = targets.map((t) => {
    const ext = path.extname(t);
    return path.join(path.dirname(t), `.${path.basename(t, ext)}.partial-${process.pid}${ext}`);
  });
  await Promise.all(targets.map((t) => mkdir(path.dirname(t), { recursive: true })));
  try {
    await fn(temps);
    for (let i = 0; i < targets.length; i++) await rename(temps[i], targets[i]);
  } finally {
    await Promise.all(temps.map((t) => rm(t, { force: true })));
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}
