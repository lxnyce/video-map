// Build cache: probe results, normalized clips and tile masters, keyed by
// content hashes so unchanged work is skipped on the next build.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

  /** Forget output records that this build didn't produce. @param {string} outDir @param {Set<string>} keep */
  pruneOutputs(outDir, keep) {
    const rec = this.outputs[path.resolve(outDir)];
    if (!rec) return;
    for (const rel of Object.keys(rec)) if (!keep.has(rel)) delete rec[rel];
  }
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
