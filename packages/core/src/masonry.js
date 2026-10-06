// Masonry packing (plan §5.1). Videos keep their own shape: every column has
// the same width, each video's height comes from its aspect ratio, and each
// video in sort order goes to the shortest column (ties go to the leftmost).
//
// Groups are either side-by-side runs of whole columns ("columns", wrapping
// onto shelves when there are too many groups for one row) or full-width
// horizontal bands ("bands"). Several column counts and shelf heights are
// tried, and the packing nearest the target aspect with the least empty area
// wins, as in the grid packer.
//
// Tiles are a whole number of columns wide, so column edges fall on tile edges
// at every level. Tile height is free, so a video can cross a horizontal tile
// edge; with `avoidSplits`, a video that fits inside one tile is moved down to
// the next tile edge instead.

import { floorEven, formatSize, roundEven } from './dims.js';
import { comparator, groupVideos } from './layout.js';

/** Masonry heights are clamped to [w × MIN_RATIO, w × MAX_RATIO]; videos outside get borders. */
export const MIN_RATIO = 1 / 3;
export const MAX_RATIO = 2;
const MAX_TILE_SIZE = 2048;

/**
 * Height of a video in a column `width` px wide: the whole frame, clamped.
 * @param {number} width
 * @param {number} aspect display width / height
 */
export function masonryHeight(width, aspect) {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  return roundEven(Math.min(Math.max(width / a, width * MIN_RATIO), width * MAX_RATIO));
}

/**
 * Deal videos into columns: each goes where it would start highest, i.e. the
 * shortest column. With `tileH`, a video that fits in one tile never crosses a
 * tile edge; it starts at the next edge instead.
 * @param {number[]} heights in placement order
 * @param {{ cols: number, y0?: number, gap?: number, tileH?: number }} o
 * @returns {{ place: Array<{ col: number, y: number }>, bottom: number }} bottom: lowest video edge (y0 when empty)
 */
export function dealColumns(heights, { cols, y0 = 0, gap = 0, tileH = 0 }) {
  const next = new Array(cols).fill(y0);
  const place = heights.map((h) => {
    let best = 0;
    let bestY = Infinity;
    for (let c = 0; c < cols; c++) {
      let y = next[c];
      if (tileH && h <= tileH && Math.floor(y / tileH) !== Math.floor((y + h - 1) / tileH)) y = Math.ceil(y / tileH) * tileH;
      if (y < bestY) {
        bestY = y;
        best = c;
      }
    }
    next[best] = bestY + h + gap;
    return { col: best, y: bestY };
  });
  let bottom = y0;
  for (const n of next) if (n > y0) bottom = Math.max(bottom, n - gap);
  return { place, bottom };
}

/**
 * @typedef {object} MasonryLayout
 * @property {number} width   content size in px
 * @property {number} height
 * @property {number} columnWidth
 * @property {number} gap
 * @property {number} columns  used columns
 * @property {number} labelHeight  label strip above each group (0 without labels)
 * @property {'columns'|'bands'} groupArrange
 * @property {import('./dims.js').Size} tile  deepest-level tile size (a whole number of columns wide)
 * @property {Array<{ video: number, x: number, y: number, w: number, h: number }>} rects  one per video, in input order
 * @property {Array<{ key: string|null, label: string, color: string|null, count: number, x: number, y: number, w: number, h: number }>} groups
 * @property {number[]} splits  videos that cross a horizontal edge of the deepest tiles
 * @property {string[]} warnings
 */

/**
 * @param {Array<import('./layout.js').LayoutVideo & { aspect: number }>} videos
 * @param {object} o
 * @param {string} [o.groupBy]
 * @param {string[]} [o.sortBy]
 * @param {Array<{ id: string, label?: string, color?: string }>} [o.categories]
 * @param {number|null} [o.columnWidth]  null: derive it from o.canvas
 * @param {import('./dims.js').Size|null} [o.canvas]
 * @param {number} [o.aspect]  target wall aspect (width / height), when there's no canvas
 * @param {number} [o.gap]
 * @param {number} [o.groupGap]  whole columns between column groups
 * @param {'columns'|'bands'} [o.groupArrange]
 * @param {boolean} [o.labels]
 * @param {boolean} [o.avoidSplits]
 * @param {import('./dims.js').Size} o.tile  target tile size
 * @returns {MasonryLayout}
 */
export function computeMasonry(videos, o) {
  const {
    groupBy = 'none', sortBy = [], categories = [], canvas = null, gap: rawGap = 0, groupGap = 0,
    groupArrange = 'columns', labels = true, avoidSplits = true,
  } = o;
  if (!videos.length) throw new Error('Masonry needs at least one video');
  const warnings = [];
  const gap = rawGap % 2 ? rawGap + 1 : rawGap;
  if (gap !== rawGap) warnings.push(`Gap rounded to ${gap}px (video needs even dimensions).`);
  const aspect = canvas ? canvas.w / canvas.h : o.aspect ?? 16 / 9;

  const groups = groupVideos(videos, groupBy, categories);
  const compare = comparator(videos, sortBy);
  for (const g of groups) g.items.sort(compare);
  const labelled = groupBy !== 'none' && labels;

  const tileH = floorEven(o.tile.h);
  const splitH = avoidSplits ? tileH : 0;
  const search = { gap, groupGap, groupArrange, labelled, aspect, tileH: splitH };
  let width;
  let best;
  if (o.columnWidth) {
    width = floorEven(o.columnWidth);
    if (width !== o.columnWidth) warnings.push(`Column width rounded to ${width}px (video needs even dimensions).`);
    best = arrange(groups, videos, { ...search, width, fixedCols: 0 });
  } else if (canvas) {
    // The best shape barely depends on the column width, so find the column
    // count at a nominal width, then scale the columns to fit the canvas.
    const nominal = 384;
    const probe = arrange(groups, videos, { ...search, width: nominal, fixedCols: 0 });
    width = floorEven(Math.min((canvas.w + gap) / probe.cols - gap, (nominal * canvas.h) / probe.height));
    for (let i = 0; i < 4; i++) {
      best = arrange(groups, videos, { ...search, width, fixedCols: probe.cols });
      if (best.height <= canvas.h * 1.01 || width <= 32) break;
      width = Math.max(32, floorEven((width * canvas.h) / best.height));
    }
  } else {
    throw new Error('Masonry needs a column width or a canvas size');
  }

  const pitch = width + gap;
  const k = Math.max(1, Math.round(o.tile.w / pitch));
  const tile = { w: k * pitch, h: tileH };
  if (tile.w > MAX_TILE_SIZE || tile.h > MAX_TILE_SIZE) {
    throw new Error(`Tile size ${formatSize(tile)} exceeds ${MAX_TILE_SIZE}px; use a smaller column width or tile size`);
  }
  if (tile.w !== o.tile.w || tile.h !== o.tile.h) {
    warnings.push(`Tile size adjusted from ${formatSize(o.tile)} to ${formatSize(tile)} so it is exactly ${k} column(s) of ${width}px${gap ? ` plus ${gap}px gaps` : ''} wide.`);
  }

  const placed = place(groups, videos, best, { width, gap, labelled, tileH: splitH, bands: groupArrange === 'bands' });

  const splits = placed.rects
    .filter((r) => Math.floor(r.y / tile.h) !== Math.floor((r.y + r.h - 1) / tile.h))
    .map((r) => r.video)
    .sort((a, b) => a - b);
  return {
    width: best.cols * pitch - gap,
    height: roundEven(placed.height),
    columnWidth: width,
    gap,
    columns: best.cols,
    labelHeight: labelled ? labelHeight(width) : 0,
    groupArrange,
    tile,
    rects: placed.rects.sort((a, b) => a.video - b.video),
    groups: groupBy === 'none' ? [] : placed.groups,
    splits,
    warnings,
  };
}

/** Height of the label strip above each group. */
function labelHeight(width) {
  return roundEven(Math.min(96, Math.max(28, width / 8)));
}

/**
 * @typedef {object} Arrangement
 * @property {number} cols  used columns
 * @property {number} height  estimated wall height
 * @property {Array<{ col: number, cols: number, shelf: number }>} groups  column run per group (bands: every group spans all columns)
 */

/**
 * Search column counts (and, for column groups, shelf heights) for the packing
 * whose shape is nearest the target aspect with the least area. Group heights
 * are estimated as if each group started at the top of a tile.
 * @returns {Arrangement}
 */
function arrange(groups, videos, { width, gap, groupGap, groupArrange, labelled, aspect, fixedCols, tileH }) {
  const pitch = width + gap;
  const lh = labelled ? labelHeight(width) : 0;
  const heights = groups.map((g) => g.items.map((i) => masonryHeight(width, videos[i].aspect)));
  const stacks = heights.map((hs) => hs.reduce((a, h) => a + h + gap, 0));
  const total = stacks.reduce((a, b) => a + b, 0);
  /** @type {Map<string, number>} */
  const memo = new Map();
  const groupHeight = (gi, cols) => {
    const key = `${gi},${cols}`;
    let h = memo.get(key);
    if (h === undefined) {
      h = dealColumns(heights[gi], { cols, gap, y0: lh, tileH }).bottom;
      memo.set(key, h);
    }
    return h;
  };
  const n0 = Math.sqrt((total * aspect) / pitch);
  const nMax = Math.min(1000, Math.max(4, Math.ceil(n0 * 2.5) + groups.length * (1 + groupGap)));
  const counts = fixedCols ? [fixedCols] : Array.from({ length: nMax }, (_, i) => i + 1);

  let best = null;
  const consider = (cols, height, placement) => {
    const w = cols * pitch - gap;
    const score = w * height * Math.exp(Math.abs(Math.log(w / height / aspect)) * 1.5);
    if (!best || score < best.score) best = { score, cols, height, groups: placement };
  };

  if (groupArrange === 'bands') {
    for (const n of counts) {
      let h = 0;
      groups.forEach((g, gi) => { h += groupHeight(gi, n) + (gi ? gap : 0); });
      consider(n, h, groups.map(() => ({ col: 0, cols: n, shelf: 0 })));
    }
    return best;
  }

  const G = groups.length;
  for (const n of counts) {
    // One shelf: every group gets a column, then each spare column goes to the
    // tallest group, so columns follow each group's area and groups end level.
    const avail = n - groupGap * (G - 1);
    if (avail >= G) {
      const share = groups.map(() => 1);
      for (let spare = avail - G; spare > 0; spare--) {
        let tallest = 0;
        for (let gi = 1; gi < G; gi++) if (groupHeight(gi, share[gi]) > groupHeight(tallest, share[tallest])) tallest = gi;
        share[tallest]++;
      }
      let col = 0;
      const placement = share.map((c) => {
        const p = { col, cols: c, shelf: 0 };
        col += c + groupGap;
        return p;
      });
      consider(n, Math.max(...share.map((c, gi) => groupHeight(gi, c))), placement);
    }
    // Several shelves: each group gets enough columns to stay under a target height, then next-fit packing.
    if (G > 1) {
      const minH = Math.max(...heights.flat()) + lh;
      const maxH = total + lh;
      for (let s = 0; s <= 40; s++) {
        const target = minH * (maxH / minH) ** (s / 40);
        const shelf = shelfPack(stacks.map((st) => Math.min(n, Math.max(1, Math.ceil(st / (target - lh || 1))))), n, groupGap);
        const shelfH = [];
        shelf.placement.forEach((p, gi) => { shelfH[p.shelf] = Math.max(shelfH[p.shelf] ?? 0, groupHeight(gi, p.cols)); });
        consider(shelf.cols, shelfH.reduce((a, b) => a + b, 0) + gap * (shelfH.length - 1), shelf.placement);
      }
    }
  }
  return best;
}

/** Next-fit shelves of column runs, keeping group order. */
function shelfPack(widths, n, groupGap) {
  let x = 0;
  let shelf = 0;
  let used = 0;
  const placement = widths.map((c) => {
    if (x > 0 && x + c > n) {
      shelf++;
      x = 0;
    }
    const p = { col: x, cols: c, shelf };
    used = Math.max(used, x + c);
    x += c + groupGap;
    return p;
  });
  return { cols: used, placement };
}

/** Final placement with real positions, label strips and split avoidance. */
function place(groups, videos, arrangement, { width, gap, labelled, tileH, bands }) {
  const pitch = width + gap;
  const lh = labelled ? labelHeight(width) : 0;
  const rects = [];
  const outGroups = [];
  let y = 0;
  let shelf = -1;
  let shelfBottom = 0;
  groups.forEach((g, gi) => {
    const p = arrangement.groups[gi];
    if (bands ? gi > 0 : p.shelf !== shelf) {
      // A new shelf (or band) starts below everything placed so far.
      y = gi === 0 ? 0 : shelfBottom + gap;
      shelf = p.shelf;
    }
    const top = y;
    const hs = g.items.map((i) => masonryHeight(width, videos[i].aspect));
    const dealt = dealColumns(hs, { cols: p.cols, y0: top + lh, gap, tileH });
    g.items.forEach((video, i) => {
      const d = dealt.place[i];
      rects.push({ video, x: (p.col + d.col) * pitch, y: d.y, w: width, h: hs[i] });
    });
    const bottom = Math.max(dealt.bottom, top + lh);
    shelfBottom = Math.max(shelfBottom, bottom);
    outGroups.push({ key: g.key, label: g.label, color: g.color, count: g.items.length, x: p.col * pitch, y: top, w: p.cols * pitch - gap, h: bottom - top });
  });
  return { rects, groups: outGroups, height: shelfBottom };
}
