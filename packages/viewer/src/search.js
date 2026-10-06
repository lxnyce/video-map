// Search and filtering (plan §8.4): which videos match the search text and the
// chosen categories and tags. Nothing is re-encoded; the viewer dims the videos
// that don't match. Pure, so it runs in tests.

/**
 * @typedef {object} Filter
 * @property {string} q  search text: every word must appear somewhere in the video's text
 * @property {string[]} cats  category ids: a video matches if it has any of them
 * @property {string[]} tags  tags: a video matches if it has all of them
 */

/** @type {Filter} */
export const NO_FILTER = Object.freeze({ q: '', cats: [], tags: [] });

/** @param {Filter} f */
export function isFiltering(f) {
  return Boolean(f.q.trim() || f.cats.length || f.tags.length);
}

/** Lower case without accents, so "Cafe" finds "Café". @param {any} s */
export function fold(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * @param {any[]} videos manifest videos
 * @param {(categoryId: string) => string} [labelFor]
 */
export function createSearch(videos, labelFor = (id) => id) {
  // Everything a word can match: id, title, description, categories (ids and labels), tags, credits and meta values.
  const text = videos.map((v) => fold([
    v.id,
    v.title,
    v.description,
    ...(v.categories ?? []).flatMap((c) => [c, labelFor(c)]),
    ...(v.tags ?? []),
    v.credits?.author,
    ...Object.entries(v.meta ?? {}).flatMap(([k, x]) => [k, typeof x === 'object' && x !== null ? JSON.stringify(x) : x]),
  ].filter((x) => x !== undefined && x !== null && x !== '').join('\n')));

  return {
    /**
     * @param {Filter} f
     * @returns {Uint8Array|null} 1 for each matching video, in `videos` order; null when nothing is filtered
     */
    match(f) {
      if (!isFiltering(f)) return null;
      const words = fold(f.q).split(/\s+/).filter(Boolean);
      const cats = new Set(f.cats);
      const out = new Uint8Array(videos.length);
      videos.forEach((v, i) => {
        if (cats.size && !(v.categories ?? []).some((c) => cats.has(c))) return;
        if (f.tags.length && !f.tags.every((t) => v.tags?.includes(t))) return;
        if (words.length && !words.every((w) => text[i].includes(w))) return;
        out[i] = 1;
      });
      return out;
    },
  };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The chips to filter by: categories in the scene's order (then any it doesn't
 * list), and the most common tags. A chip every video has filters nothing, so
 * it's left out.
 * @param {any[]} videos
 * @param {Array<{ id: string, label?: string, color?: string }>} [categories]
 * @param {number} [maxTags]
 */
export function facets(videos, categories = [], maxTags = 16) {
  const count = (list) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const v of videos) for (const x of new Set(list(v) ?? [])) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const cats = count((v) => v.categories);
  const tags = count((v) => v.tags);
  const useful = (n) => n < videos.length;
  const known = new Map(categories.map((c) => [c.id, c]));
  const catList = [
    ...categories.filter((c) => cats.has(c.id)).map((c) => c.id),
    ...[...cats.keys()].filter((id) => !known.has(id)).sort(collator.compare),
  ].map((id) => ({ id, label: known.get(id)?.label ?? id, color: known.get(id)?.color ?? null, count: cats.get(id) }));
  const tagList = [...tags]
    .filter(([, n]) => useful(n))
    .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
    .map(([id, n]) => ({ id, label: id, color: null, count: n }));
  return {
    categories: catList.length > 1 || catList.some((c) => useful(c.count)) ? catList : [],
    tags: tagList.slice(0, maxTags),
    moreTags: Math.max(0, tagList.length - maxTags),
  };
}
