// Projects on disk. Each project is a folder in the Studio's data folder:
//
//   <id>/scene.json      the scene, exactly what `vmap build` reads
//   <id>/media/          uploaded videos (scene srcs are relative to the folder)
//   <id>/dist/           the build output, ready to host
//   <id>/.vmap-cache/    the build cache
//   <id>/.studio/        Studio state: probes, thumbnails, partial uploads, the last build report
//
// So a project folder is also a plain vmap project: `vmap build <id>/scene.json`
// gives the same output.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify, validateScene } from '@videomap/core/validate';

const SCHEMA_URL = 'https://videomap.dev/schema/scene.schema.json';
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * Validate a scene the Studio may save. A project starts with no videos, which
 * a build refuses, so an empty video list is allowed here.
 * @param {any} scene
 */
export function validateDraft(scene) {
  if (scene && typeof scene === 'object' && Array.isArray(scene.videos) && scene.videos.length === 0) {
    const result = validateScene({ ...scene, videos: [{ src: 'placeholder.mp4' }] });
    return { ...result, empty: true };
  }
  return { ...validateScene(scene), empty: false };
}

/** Stable revision of a scene file's text: saves name the revision they edited. @param {string} text */
export function revision(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export class ProjectStore {
  /** @param {string} root data folder */
  constructor(root) {
    this.root = path.resolve(root);
    /** @type {Map<string, Project>} */
    this.cache = new Map();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  /** Every project, most recently changed first. */
  async list() {
    const out = [];
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID.test(e.name)) continue;
      const project = this.open(e.name);
      const info = await stat(project.scenePath).catch(() => null);
      if (!info) continue;
      let scene = null;
      try {
        scene = JSON.parse(await readFile(project.scenePath, 'utf8'));
      } catch {
        // listed as invalid
      }
      out.push({
        id: e.name,
        title: scene?.title ?? e.name,
        videos: Array.isArray(scene?.videos) ? scene.videos.length : 0,
        invalid: !scene,
        updatedAt: info.mtimeMs,
        lastBuild: summarizeBuild(await project.lastBuild()),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Create a project from a title, or from an imported scene.
   * @param {{ title?: string, scene?: any }} o
   * @returns {Promise<{ project: Project } | { error: string, issues: any[] }>}
   */
  async create({ title, scene }) {
    const name = String(title ?? scene?.title ?? '').trim().slice(0, 500) || 'Untitled wall';
    const initial = scene ? { ...scene } : { $schema: SCHEMA_URL, title: name, videos: [] };
    if (!initial.title) initial.title = name;
    const check = validateDraft(initial);
    if (!check.valid) return { error: 'The scene has problems.', issues: check.errors };
    const base = slugify(name).slice(0, 60).replace(/-+$/, '') || 'wall';
    let id = base;
    for (let n = 2; await stat(path.join(this.root, id)).catch(() => null); n++) id = `${base}-${n}`;
    const project = this.open(id);
    await mkdir(project.mediaDir, { recursive: true });
    await project.writeText(`${JSON.stringify(initial, null, 2)}\n`);
    return { project };
  }

  /** @param {string} id */
  async exists(id) {
    if (!ID.test(id)) return false;
    return stat(path.join(this.root, id, 'scene.json')).then(() => true, () => false);
  }

  /** @param {string} id */
  open(id) {
    if (!ID.test(id)) throw new Error(`Invalid project id "${id}"`);
    let p = this.cache.get(id);
    if (!p) {
      p = new Project(id, path.join(this.root, id));
      this.cache.set(id, p);
    }
    return p;
  }

  /** @param {string} id */
  async remove(id) {
    const project = this.open(id);
    await rm(project.dir, { recursive: true, force: true });
    this.cache.delete(id);
  }
}

export class Project {
  /** @param {string} id @param {string} dir */
  constructor(id, dir) {
    this.id = id;
    this.dir = dir;
    this.scenePath = path.join(dir, 'scene.json');
    this.mediaDir = path.join(dir, 'media');
    this.distDir = path.join(dir, 'dist');
    this.cacheDir = path.join(dir, '.vmap-cache');
    this.studioDir = path.join(dir, '.studio');
    /** Serializes scene writes. */
    this.lock = Promise.resolve();
  }

  /** The scene and its revision; `scene` is null when the file isn't valid JSON. */
  async read() {
    const text = await readFile(this.scenePath, 'utf8');
    let scene = null;
    let parseError = null;
    try {
      scene = JSON.parse(text);
    } catch (err) {
      parseError = err.message;
    }
    return { scene, text, rev: revision(text), parseError };
  }

  /**
   * Save a scene if the file is still at revision `expected` (null skips the check).
   * @param {any} scene
   * @param {string|null} expected
   * @returns {Promise<{ ok: boolean, rev?: string, conflict?: boolean, issues?: Array<{ path: string, message: string }> }>}
   */
  write(scene, expected) {
    const run = this.lock.then(async () => {
      const check = validateDraft(scene);
      if (!check.valid) return { ok: false, issues: check.errors };
      if (expected !== null) {
        const current = revision(await readFile(this.scenePath, 'utf8').catch(() => ''));
        if (current !== expected) return { ok: false, conflict: true, rev: current };
      }
      const rev = await this.writeText(`${JSON.stringify(scene, null, 2)}\n`);
      return { ok: true, rev };
    });
    this.lock = run.then(() => {}, () => {});
    return run;
  }

  /** @param {string} text */
  async writeText(text) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.scenePath}.tmp-${process.pid}`;
    await writeFile(tmp, text);
    await rename(tmp, this.scenePath);
    return revision(text);
  }

  /** The record of the last finished build, or null. */
  async lastBuild() {
    try {
      return JSON.parse(await readFile(path.join(this.studioDir, 'last-build.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** @param {any} record */
  async saveLastBuild(record) {
    await mkdir(this.studioDir, { recursive: true });
    await writeFile(path.join(this.studioDir, 'last-build.json'), JSON.stringify(record));
  }

  /** Files in media/, with their sizes. */
  async media() {
    let entries = [];
    try {
      entries = await readdir(this.mediaDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const s = await stat(path.join(this.mediaDir, e.name));
      out.push({ name: e.name, src: `media/${e.name}`, size: s.size, mtime: s.mtimeMs });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  }

  /**
   * Resolve a scene path (a video's src or poster) to a file the Studio may
   * read: files inside the project folder (but not its Studio state or cache),
   * and any file the saved scene names, since a build reads those anyway.
   * @param {string} src
   * @returns {Promise<string|null>}
   */
  async resolveSource(src) {
    if (typeof src !== 'string' || !src || /^https?:\/\//i.test(src) || src.includes('\0')) return null;
    const file = path.resolve(this.dir, src);
    if (isInside(file, this.dir) && !isInside(file, this.studioDir) && !isInside(file, this.cacheDir)) return file;
    const { scene } = await this.read().catch(() => ({ scene: null }));
    const named = (scene?.videos ?? []).some((v) => v && (v.src === src || v.poster === src));
    return named ? file : null;
  }
}

/** The parts of a build record the project list shows. @param {any} record */
export function summarizeBuild(record) {
  if (!record) return null;
  return { at: record.at, seconds: record.report?.seconds, videos: record.report?.videos, size: record.report?.sizes?.total ?? null };
}

/** @param {string} child @param {string} parent */
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
