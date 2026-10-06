// `vmap init`: scaffold a scene.json from a folder of videos.
// Videos in sub-folders get that folder as their category.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { slugify } from '@videomap/core/validate';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.ts', '.mts', '.wmv', '.flv', '.ogv', '.3gp']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vmap-cache']);

/**
 * @param {string} dir folder to scan
 * @param {string} sceneDir folder the scene file will live in (src paths are relative to it)
 * @param {{ title?: string }} [opts]
 */
export async function scaffoldScene(dir, sceneDir, opts = {}) {
  const files = (await findVideos(path.resolve(dir))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const root = path.resolve(dir);
  const categories = new Map();
  const ids = new Set();

  const videos = files.map((file) => {
    const relToRoot = path.relative(root, file).split(path.sep);
    const base = path.basename(file, path.extname(file));
    let id = slugify(base) || 'video';
    for (let n = 2; ids.has(id); n++) id = `${slugify(base) || 'video'}-${n}`;
    ids.add(id);

    const entry = {
      id,
      src: path.relative(sceneDir, file).split(path.sep).join('/'),
      title: humanize(base),
    };
    if (relToRoot.length > 1) {
      const folder = relToRoot[0];
      const catId = slugify(folder) || 'other';
      if (!categories.has(catId)) categories.set(catId, { id: catId, label: humanize(folder) });
      entry.categories = [catId];
    }
    return entry;
  });

  return {
    $schema: 'https://videomap.dev/schema/scene.schema.json',
    title: opts.title ?? humanize(path.basename(root)),
    preview: { duration: 10, fps: 24 },
    layout: { groupBy: categories.size ? 'category' : 'none', sortBy: ['title'] },
    output: { cell: '384x216', tile: '768x432' },
    ...(categories.size ? { categories: [...categories.values()] } : {}),
    videos,
  };
}

async function findVideos(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await findVideos(p)));
    } else if (VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

/** "coral_reef-01" → "Coral reef 01" */
function humanize(s) {
  const t = s.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}
