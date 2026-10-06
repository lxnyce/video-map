// Auto-organizes videos into a grid of cells: group, sort, then pack.
//
// One group flows row by row into a grid shaped to the target aspect.
// Several groups each become a rectangular block, and blocks are shelf-packed
// (left to right, then a new shelf) with `groupGap` empty cells between them.
// Several shelf widths are tried, and the one whose overall shape best matches
// the target aspect with the least wasted area wins.

/**
 * @typedef {object} LayoutVideo
 * @property {string} id
 * @property {string} [title]
 * @property {string} [src]
 * @property {string[]} [categories]
 * @property {string[]} [tags]
 * @property {Record<string, any>} [meta]
 * @property {number} [duration] seconds, when known
 */

/**
 * @typedef {object} LayoutGroup
 * @property {string|null} key
 * @property {string} label
 * @property {string|null} color
 * @property {number} col
 * @property {number} row
 * @property {number} cols
 * @property {number} rows
 * @property {number} count
 */

/**
 * @typedef {object} Layout
 * @property {number} cols
 * @property {number} rows
 * @property {Array<{ video: number, col: number, row: number }>} cells  `video` indexes the input array
 * @property {LayoutGroup[]} groups
 */

/**
 * @param {LayoutVideo[]} videos
 * @param {object} opts
 * @param {string} [opts.groupBy] "none" | "category" | "tag:<prefix>" | "meta.<key>"
 * @param {string[]} [opts.sortBy] keys like "title", "-duration", "meta.year"
 * @param {number} [opts.groupGap] empty cells between group blocks
 * @param {number} [opts.aspect] target grid aspect in cell units (columns / rows)
 * @param {Array<{ id: string, label?: string, color?: string }>} [opts.categories]
 * @returns {Layout}
 */
export function computeLayout(videos, opts = {}) {
  const { groupBy = 'none', sortBy = [], groupGap = 1, aspect = 1, categories = [] } = opts;
  if (!videos.length) return { cols: 0, rows: 0, cells: [], groups: [] };

  const groups = groupVideos(videos, groupBy, categories);
  const compare = comparator(videos, sortBy);
  for (const g of groups) g.items.sort(compare);

  if (groups.length === 1) {
    const g = groups[0];
    const { w, h } = blockShape(g.items.length, aspect, Infinity);
    const cells = g.items.map((video, i) => ({ video, col: i % w, row: Math.floor(i / w) }));
    const outGroups = groupBy === 'none' ? [] : [{ key: g.key, label: g.label, color: g.color, col: 0, row: 0, cols: w, rows: h, count: g.items.length }];
    return { cols: w, rows: h, cells, groups: outGroups };
  }

  const best = bestShelfPacking(groups.map((g) => g.items.length), aspect, groupGap);
  const cells = [];
  const outGroups = [];
  groups.forEach((g, gi) => {
    const p = best.placements[gi];
    g.items.forEach((video, i) => cells.push({ video, col: p.col + (i % p.cols), row: p.row + Math.floor(i / p.cols) }));
    outGroups.push({ key: g.key, label: g.label, color: g.color, col: p.col, row: p.row, cols: p.cols, rows: p.rows, count: g.items.length });
  });
  return { cols: best.cols, rows: best.rows, cells, groups: outGroups };
}

// ---------------------------------------------------------------------------
// Grouping

/**
 * @param {LayoutVideo[]} videos
 * @param {string} groupBy
 * @param {Array<{ id: string, label?: string, color?: string }>} categories
 * @returns {Array<{ key: string|null, label: string, color: string|null, items: number[] }>}
 */
export function groupVideos(videos, groupBy, categories = []) {
  const keyOf = groupKeyFn(groupBy);
  /** @type {Map<string|null, number[]>} */
  const byKey = new Map();
  videos.forEach((v, i) => {
    const k = keyOf(v);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });

  const catIndex = new Map(categories.map((c, i) => [c.id, i]));
  const keys = [...byKey.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (groupBy === 'category') {
      const ia = catIndex.get(a) ?? Infinity;
      const ib = catIndex.get(b) ?? Infinity;
      if (ia !== ib) return ia - ib;
    }
    return naturalCompare(a, b);
  });

  return keys.map((key) => {
    const cat = groupBy === 'category' && key !== null ? categories.find((c) => c.id === key) : undefined;
    return {
      key,
      label: key === null ? 'Other' : cat?.label ?? key,
      color: cat?.color ?? null,
      items: byKey.get(key),
    };
  });
}

/** @param {string} groupBy @returns {(v: LayoutVideo) => string|null} */
function groupKeyFn(groupBy) {
  if (!groupBy || groupBy === 'none') return () => '';
  if (groupBy === 'category') return (v) => v.categories?.[0] ?? null;
  if (groupBy.startsWith('tag:')) {
    const prefix = `${groupBy.slice(4)}:`;
    return (v) => {
      const tag = v.tags?.find((t) => t.startsWith(prefix));
      return tag ? tag.slice(prefix.length) : null;
    };
  }
  if (groupBy.startsWith('meta.')) {
    const key = groupBy.slice(5);
    return (v) => {
      const value = v.meta?.[key];
      return value === undefined || value === null || value === '' ? null : String(value);
    };
  }
  throw new Error(`Unknown groupBy "${groupBy}"`);
}

// ---------------------------------------------------------------------------
// Sorting

/**
 * @param {LayoutVideo[]} videos
 * @param {string[]} sortBy
 * @returns {(a: number, b: number) => number}
 */
function comparator(videos, sortBy) {
  const keys = sortBy.map((spec) => {
    const desc = spec.startsWith('-');
    const field = desc ? spec.slice(1) : spec;
    /** @type {(v: LayoutVideo) => any} */
    let get;
    if (field === 'category') get = (v) => v.categories?.[0];
    else if (field.startsWith('meta.')) get = (v) => v.meta?.[field.slice(5)];
    else get = (v) => v[field];
    return { get, dir: desc ? -1 : 1 };
  });
  return (a, b) => {
    for (const { get, dir } of keys) {
      const va = get(videos[a]);
      const vb = get(videos[b]);
      // Videos without the field go last in either direction.
      const ma = isMissing(va);
      const mb = isMissing(vb);
      if (ma || mb) {
        if (ma !== mb) return ma ? 1 : -1;
        continue;
      }
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : naturalCompare(String(va), String(vb));
      if (c) return c * dir;
    }
    return a - b;
  };
}

function isMissing(v) {
  return v === undefined || v === null || v === '';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function naturalCompare(a, b) {
  return collator.compare(a, b);
}

// ---------------------------------------------------------------------------
// Packing

/**
 * Block of `n` cells shaped close to `aspect` (cols / rows), no wider than maxCols.
 * @returns {{ w: number, h: number }}
 */
export function blockShape(n, aspect, maxCols) {
  let w = Math.max(1, Math.min(n, maxCols, Math.round(Math.sqrt(n * aspect))));
  const h = Math.ceil(n / w);
  w = Math.ceil(n / h);
  return { w, h };
}

/**
 * Try a range of shelf widths and block shapes; keep the packing with the
 * least area, penalized by how far its shape is from the target aspect.
 * @param {number[]} counts cells per group, in display order
 * @param {number} aspect target cols / rows
 * @param {number} gap
 */
function bestShelfPacking(counts, aspect, gap) {
  const total = counts.reduce((a, b) => a + b, 0);
  const w0 = Math.max(1, Math.round(Math.sqrt(total * aspect)));
  const h0 = Math.max(1, Math.round(Math.sqrt(total / aspect)));
  const maxWidth = w0 * 2 + gap * counts.length;
  let best = null;
  for (let width = Math.max(1, Math.floor(w0 / 2)); width <= maxWidth; width++) {
    // shelfHeight 0 shapes each block like the target aspect; otherwise blocks share a fixed height.
    for (let shelfHeight = 0; shelfHeight <= h0; shelfHeight++) {
      const packed = shelfPack(counts, width, aspect, gap, shelfHeight);
      const shape = packed.cols / packed.rows;
      const score = packed.cols * packed.rows * Math.exp(Math.abs(Math.log(shape / aspect)) * 1.5);
      if (!best || score < best.score) best = { ...packed, score };
    }
  }
  return best;
}

/**
 * Next-fit shelf packing that keeps groups in order.
 * @param {number[]} counts
 * @param {number} width max columns per shelf
 * @param {number} aspect
 * @param {number} gap
 * @param {number} shelfHeight 0 = aspect-shaped blocks; n = blocks n rows tall (fewer for small groups, more for groups wider than a shelf)
 * @returns {{ cols: number, rows: number, placements: Array<{ col: number, row: number, cols: number, rows: number }> }}
 */
function shelfPack(counts, width, aspect, gap, shelfHeight) {
  let x = 0;
  let y = 0;
  let shelfH = 0;
  let usedW = 0;
  const placements = counts.map((n) => {
    let w;
    let h;
    if (shelfHeight > 0) {
      h = Math.min(shelfHeight, n);
      w = Math.ceil(n / h);
      if (w > width) {
        w = width;
        h = Math.ceil(n / w);
      }
      w = Math.ceil(n / h);
    } else {
      ({ w, h } = blockShape(n, aspect, width));
    }
    if (x > 0 && x + w > width) {
      y += shelfH + gap;
      x = 0;
      shelfH = 0;
    }
    const p = { col: x, row: y, cols: w, rows: h };
    usedW = Math.max(usedW, x + w);
    x += w + gap;
    shelfH = Math.max(shelfH, h);
    return p;
  });
  return { cols: usedW, rows: y + shelfH, placements };
}
