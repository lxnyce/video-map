// Scene editing helpers for the Studio UI. Pure functions over plain scene
// objects (no DOM), so they're unit-tested in Node.

import {
  DEFAULTS,
  basename,
  estimateSizes,
  humanize,
  planWall,
  resolveLayouts,
} from '@videomap/core';
import { assignIds, slugify, validateScene } from '@videomap/core/validate';

export { assignIds, slugify, humanize, basename };

/**
 * Validate a scene the Studio may save; an empty video list is allowed (same
 * rule as the server).
 * @param {any} scene
 */
export function validateDraft(scene) {
  if (scene && typeof scene === 'object' && Array.isArray(scene.videos) && scene.videos.length === 0) {
    return { ...validateScene({ ...scene, videos: [{ src: 'placeholder.mp4' }] }), empty: true };
  }
  return { ...validateScene(scene), empty: false };
}

/** Deep copy of JSON data. @template T @param {T} v @returns {T} */
export function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Read a nested value. @param {any} obj @param {Array<string|number>} keys
 */
export function getPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Set a nested value in place. `undefined` (or "") deletes the key, and parent
 * objects left empty are removed, so clearing a field falls back to the default.
 * @param {any} obj
 * @param {Array<string|number>} keys
 * @param {any} value
 */
export function setPath(obj, keys, value) {
  const remove = value === undefined || value === '';
  const parents = [];
  let cur = obj;
  for (const [i, k] of keys.slice(0, -1).entries()) {
    if (cur[k] == null || typeof cur[k] !== 'object') {
      if (remove) return obj;
      cur[k] = typeof keys[i + 1] === 'number' ? [] : {};
    }
    parents.push([cur, k]);
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (remove) {
    if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
    else delete cur[last];
    for (let i = parents.length - 1; i >= 0; i--) {
      const [p, k] = parents[i];
      const child = p[k];
      if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) delete p[k];
      else break;
    }
  } else {
    cur[last] = value;
  }
  return obj;
}

/** The default for a settings path, for placeholders: ["layout", "fit"] → "contain". */
export function defaultFor(keys) {
  return getPath(DEFAULTS, keys);
}

/**
 * Add an uploaded file to the scene. If a video's file is missing and has the
 * same name, the upload replaces it (so importing a scene and then dropping its
 * files fills it in); otherwise a new video is added with an id and a title
 * from the file name.
 * @param {any} scene  modified in place
 * @param {string} src  scene path of the uploaded file, e.g. "media/reef.mp4"
 * @param {string} filename  the name it was uploaded with
 * @param {(src: string) => boolean} isMissing
 * @returns {{ index: number, relinked: boolean }}
 */
export function addUpload(scene, src, filename, isMissing) {
  scene.videos ??= [];
  const want = filename.toLowerCase();
  const index = scene.videos.findIndex((v) => v.src !== src && isMissing(v.src) && fileName(v.src).toLowerCase() === want);
  if (index >= 0) {
    scene.videos[index].src = src;
    return { index, relinked: true };
  }
  const existing = scene.videos.findIndex((v) => v.src === src);
  if (existing >= 0) return { index: existing, relinked: false };
  const ids = new Set(assignIds(scene.videos));
  const base = slugify(basename(filename)) || 'video';
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  scene.videos.push({ id, src, title: humanize(basename(filename)) });
  return { index: scene.videos.length - 1, relinked: false };
}

/** @param {string} src */
export function fileName(src) {
  return String(src).split(/[\\/]/).pop() ?? '';
}

/**
 * Rename a category id everywhere it's used.
 * @param {any} scene  modified in place
 * @param {string} from
 * @param {string} to
 */
export function renameCategory(scene, from, to) {
  for (const c of scene.categories ?? []) if (c.id === from) c.id = to;
  for (const v of scene.videos ?? []) {
    if (v.categories) v.categories = [...new Set(v.categories.map((c) => (c === from ? to : c)))];
  }
}

/** Remove a category and its uses. @param {any} scene @param {string} id */
export function removeCategory(scene, id) {
  scene.categories = (scene.categories ?? []).filter((c) => c.id !== id);
  if (!scene.categories.length) delete scene.categories;
  for (const v of scene.videos ?? []) {
    if (!v.categories) continue;
    v.categories = v.categories.filter((c) => c !== id);
    if (!v.categories.length) delete v.categories;
  }
}

/**
 * Apply one bulk edit to the videos at `indexes`.
 * @param {any} scene  modified in place
 * @param {number[]} indexes
 * @param {{ type: 'addCategory'|'removeCategory'|'addTags'|'removeTag'|'setFit', value: any }} op
 */
export function bulkEdit(scene, indexes, op) {
  for (const i of indexes) {
    const v = scene.videos[i];
    if (!v) continue;
    switch (op.type) {
      case 'addCategory':
        v.categories = [...new Set([...(v.categories ?? []), op.value])];
        break;
      case 'removeCategory':
        v.categories = (v.categories ?? []).filter((c) => c !== op.value);
        if (!v.categories.length) delete v.categories;
        break;
      case 'addTags':
        v.tags = [...new Set([...(v.tags ?? []), ...op.value])];
        break;
      case 'removeTag':
        v.tags = (v.tags ?? []).filter((t) => t !== op.value);
        if (!v.tags.length) delete v.tags;
        break;
      case 'setFit':
        if (op.value) v.fit = op.value;
        else delete v.fit;
        break;
      default:
        throw new Error(`Unknown bulk edit ${op.type}`);
    }
  }
}

/** Remove the videos at `indexes`. @param {any} scene @param {number[]} indexes */
export function removeVideos(scene, indexes) {
  const drop = new Set(indexes);
  scene.videos = scene.videos.filter((_, i) => !drop.has(i));
}

/** Every tag used, most used first. @param {any} scene */
export function allTags(scene) {
  const counts = new Map();
  for (const v of scene.videos ?? []) for (const t of v.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** Group-by and sort keys the scene's metadata offers: tag prefixes ("place" from "place:Paris") and meta keys. @param {any} scene */
export function metadataKeys(scene) {
  const prefixes = new Set();
  const meta = new Set();
  for (const v of scene.videos ?? []) {
    for (const t of v.tags ?? []) {
      const i = t.indexOf(':');
      if (i > 0) prefixes.add(t.slice(0, i));
    }
    for (const k of Object.keys(v.meta ?? {})) meta.add(k);
  }
  return { tagPrefixes: [...prefixes].sort(), metaKeys: [...meta].sort() };
}

/**
 * Text search over the library: every word must appear in the title, id, src,
 * description, categories or tags (case and accents ignored).
 * @param {any} video
 * @param {string} query
 */
export function matchesQuery(video, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([video.title, video.id, video.src, video.description, ...(video.categories ?? []), ...(video.tags ?? [])].filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

/** @param {string} s */
function fold(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Store a meta value typed in a text field: numbers and true/false keep their
 * type (so `meta.year` sorts as a number); everything else is text.
 * @param {string} text
 */
export function parseMetaValue(text) {
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return text;
}

/** @param {any} value */
export function formatMetaValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Shape assumed for videos not probed yet. */
const UNKNOWN = { width: 1920, height: 1080, duration: 10, fps: 30, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', container: 'mov,mp4', rotation: 0, sar: 1, hdr: false };

/**
 * The walls a build would make, from the scene and the probe results so far:
 * the same layout and pyramid code the builder runs, so the preview matches
 * the build. Videos not probed yet count as 16:9 and 10 s.
 * @param {any} scene
 * @param {Record<string, any>} probes  src → { probe } | { missing } | { error } | { remote }
 */
export function planScene(scene, probes) {
  const videos = scene?.videos ?? [];
  if (!videos.length) return { walls: [], estimate: null, unknown: 0, warnings: [], error: null };
  let arrangements;
  try {
    arrangements = resolveLayouts(scene);
  } catch (err) {
    return { walls: [], estimate: null, unknown: 0, warnings: [], error: err.message };
  }
  const ids = assignIds(videos);
  let unknown = 0;
  const sources = videos.map((v) => {
    const p = probes[v.src]?.probe;
    if (!p) unknown++;
    return { probe: p ?? UNKNOWN };
  });
  const layoutVideos = videos.map((v, i) => ({
    id: ids[i],
    title: v.title ?? ids[i],
    src: v.src,
    categories: v.categories,
    tags: v.tags,
    meta: v.meta,
    duration: sources[i].probe.duration,
    aspect: sources[i].probe.width / sources[i].probe.height,
  }));
  const warnings = [];
  try {
    const walls = arrangements.map(({ id, label, config }, i) => {
      const w = planWall(layoutVideos, config, { categories: scene.categories ?? [] });
      warnings.push(...w.warnings.map((m) => (i === 0 ? m : `${label}: ${m}`)));
      return {
        id,
        label,
        config,
        layout: w.layout,
        pyramid: w.pyramid,
        tiles: w.tiles,
        fits: videos.map((v) => (w.layout.pack === 'grid' ? v.fit ?? config.layout.fit : 'contain')),
      };
    });
    const estimate = estimateSizes({ config: arrangements[0].config, walls, sources });
    return { walls, estimate, unknown, warnings, error: null, ids };
  } catch (err) {
    return { walls: [], estimate: null, unknown, warnings, error: err.message };
  }
}

/** Colors for new categories, in order; distinct on the dark wall. */
export const CATEGORY_COLORS = ['#4e9af1', '#f2b35b', '#4cc38a', '#e3698a', '#9b7bf2', '#3cc7c7', '#f28f5b', '#b5c94e', '#d77be0', '#7f8da8'];

/** The first palette color no category uses yet. @param {Array<{ color?: string }>} categories */
export function nextCategoryColor(categories) {
  const used = new Set(categories.map((c) => c.color?.toLowerCase()));
  return CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length];
}

/** A stable color for a category without one. @param {string} key */
export function colorFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

/**
 * Turn a validation path ("videos[3].title") into keys (["videos", 3, "title"]).
 * @param {string} p
 */
export function parseIssuePath(p) {
  if (!p || p === '(root)') return [];
  const keys = [];
  for (const m of p.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) keys.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return keys;
}

/** Bytes as "12.3 MB". @param {number|null|undefined} bytes */
export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Seconds as "1:05" or "12.5 s". @param {number} s */
export function formatDuration(s) {
  if (!Number.isFinite(s)) return '';
  if (s < 60) return `${Math.round(s * 10) / 10} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/** "3 minutes ago" @param {number} at ms since the epoch @param {number} [now] */
export function timeAgo(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
