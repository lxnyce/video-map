// File-name helpers shared by `vmap init` and the Studio's uploads.

/** Extensions treated as videos when scanning folders and accepting uploads. */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.ts', '.mts', '.wmv', '.flv', '.ogv', '.3gp']);

/** "coral_reef-01" → "Coral reef 01" @param {string} s */
export function humanize(s) {
  const t = s.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}

/** Lower-case extension with the dot, e.g. ".mp4" ("" if none). @param {string} name */
export function extname(name) {
  const base = name.split(/[\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** The file name without folders or extension. @param {string} name */
export function basename(name) {
  const base = name.split(/[\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
