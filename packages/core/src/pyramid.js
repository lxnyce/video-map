// Tile pyramid math. Pure functions shared by the builder and the viewer.
//
// The deepest level (z = maxZoom) shows cells at full size. Each tile there
// holds k.x × k.y cells. Every level up halves the resolution and doubles the
// cells per tile along each axis, so a cell never straddles two tiles at any
// level. Tiles always have the same pixel size; tiles that run past the
// content edge are filled with the background color.
//
// Level 0 is the exception: it is a single overview tile with the whole wall
// scaled to fit it, rather than the next power of two down. Halving alone can
// leave the wall filling as little as a quarter of that tile, and level 0 is
// the view that shows every video at once on a single decoder. Every level
// records its `scale`, so placement math stays the same for all levels.
//
// Masonry walls have no cells: tiles are a whole number of columns wide and
// any height, so videos can cross horizontal tile edges. The rectangle
// functions at the end (rectTiles, tileContents) work for both packings.

import { floorEven, formatSize } from './dims.js';

/** @typedef {import('./dims.js').Size} Size */

/**
 * @typedef {object} Level
 * @property {number} z
 * @property {number} tilesX
 * @property {number} tilesY
 * @property {{ x: number, y: number }|null} cellsPerTile  grid only
 * @property {number} scale  level pixels per full-resolution pixel (1 at the deepest level)
 */

/**
 * @typedef {object} Pyramid
 * @property {Size|null} cell   cell size at the deepest level (grid only)
 * @property {{ x: number, y: number }|null} k  cells per tile at the deepest level (grid only)
 * @property {Size} tile   tile size in pixels (same at every level)
 * @property {number|null} cols  grid only
 * @property {number|null} rows
 * @property {number} maxZoom
 * @property {Level[]} levels  indexed by z
 * @property {number} contentWidth   full-resolution content size in pixels
 * @property {number} contentHeight
 */

export const MAX_TILE_SIZE = 2048;

/**
 * Pick the cell size (from a canvas or explicit cell size) and how many cells
 * fit in a tile, snapping the tile size so cells divide it exactly.
 * @param {{ cols: number, rows: number }} grid
 * @param {{ canvas: Size|null, cell: Size|null, tile: Size, cellAspect: number }} out
 * @returns {{ cell: Size, k: { x: number, y: number }, tile: Size, warnings: string[] }}
 */
export function resolveCellAndTile(grid, { canvas, cell, tile, cellAspect }) {
  const warnings = [];
  /** @type {Size} */
  let c;
  if (cell) {
    c = { w: floorEven(cell.w), h: floorEven(cell.h) };
    if (c.w !== cell.w || c.h !== cell.h) warnings.push(`Cell size rounded to ${formatSize(c)} (video needs even dimensions).`);
  } else if (canvas) {
    const w = floorEven(Math.min(canvas.w / grid.cols, (canvas.h / grid.rows) * cellAspect));
    c = { w, h: floorEven(w / cellAspect) };
  } else {
    throw new Error('Either a canvas or a cell size is required');
  }

  const k = { x: Math.max(1, Math.round(tile.w / c.w)), y: Math.max(1, Math.round(tile.h / c.h)) };
  const t = { w: k.x * c.w, h: k.y * c.h };
  if (t.w > MAX_TILE_SIZE || t.h > MAX_TILE_SIZE) {
    throw new Error(`Tile size ${formatSize(t)} exceeds ${MAX_TILE_SIZE}px; use a smaller cell or tile size`);
  }
  if (t.w !== tile.w || t.h !== tile.h) {
    warnings.push(`Tile size adjusted from ${formatSize(tile)} to ${formatSize(t)} so ${k.x}×${k.y} cells of ${formatSize(c)} fit exactly.`);
  }
  if (c.w < 48 || c.h < 27) {
    warnings.push(`Cells are only ${formatSize(c)} at full zoom; use a larger canvas or cell size for sharper videos.`);
  }
  return { cell: c, k, tile: t, warnings };
}

/**
 * A pyramid for a grid of cells, or for any content size and tile size
 * (masonry, where tiles are whole columns wide but videos are free in y).
 * @param {{ cols: number, rows: number, cell: Size, k: { x: number, y: number } } | { width: number, height: number, tile: Size }} spec
 * @returns {Pyramid}
 */
export function createPyramid(spec) {
  const grid = 'cols' in spec ? spec : null;
  if (grid && (grid.cols < 1 || grid.rows < 1)) throw new Error('The grid needs at least one cell');
  const tile = grid ? { w: grid.k.x * grid.cell.w, h: grid.k.y * grid.cell.h } : /** @type {any} */ (spec).tile;
  const contentWidth = grid ? grid.cols * grid.cell.w : /** @type {any} */ (spec).width;
  const contentHeight = grid ? grid.rows * grid.cell.h : /** @type {any} */ (spec).height;
  if (!(contentWidth > 0 && contentHeight > 0)) throw new Error('The wall is empty');
  const deepX = Math.ceil(contentWidth / tile.w);
  const deepY = Math.ceil(contentHeight / tile.h);
  let maxZoom = 0;
  while (2 ** maxZoom < Math.max(deepX, deepY)) maxZoom++;

  const levels = [];
  for (let z = 0; z <= maxZoom; z++) {
    const f = 2 ** (maxZoom - z);
    levels.push({
      z,
      tilesX: Math.ceil(deepX / f),
      tilesY: Math.ceil(deepY / f),
      cellsPerTile: grid ? { x: grid.k.x * f, y: grid.k.y * f } : null,
      scale: 1 / f,
    });
  }
  if (maxZoom > 0) {
    const scale = Math.min(tile.w / contentWidth, tile.h / contentHeight);
    levels[0] = {
      z: 0,
      tilesX: 1,
      tilesY: 1,
      cellsPerTile: grid
        ? { x: Math.max(grid.cols, Math.ceil(tile.w / (grid.cell.w * scale))), y: Math.max(grid.rows, Math.ceil(tile.h / (grid.cell.h * scale))) }
        : null,
      scale,
    };
  }
  return {
    cell: grid?.cell ?? null,
    k: grid?.k ?? null,
    tile,
    cols: grid?.cols ?? null,
    rows: grid?.rows ?? null,
    maxZoom,
    levels,
    contentWidth,
    contentHeight,
  };
}

/**
 * Size of the content at a level, in that level's pixels.
 * @param {Pyramid} p
 * @param {number} z
 */
export function levelContentSize(p, z) {
  const { scale } = p.levels[z];
  return { w: p.contentWidth * scale, h: p.contentHeight * scale };
}

/**
 * Cells covered by a tile (end exclusive, clipped to the grid).
 * @param {Pyramid} p
 * @returns {{ col0: number, row0: number, col1: number, row1: number }}
 */
export function tileCellRange(p, z, x, y) {
  const { cellsPerTile: cpt } = p.levels[z];
  return {
    col0: x * cpt.x,
    row0: y * cpt.y,
    col1: Math.min(p.cols, (x + 1) * cpt.x),
    row1: Math.min(p.rows, (y + 1) * cpt.y),
  };
}

/**
 * The tile containing a cell at level z.
 * @param {Pyramid} p
 * @returns {{ x: number, y: number }}
 */
export function cellTile(p, z, col, row) {
  const { cellsPerTile: cpt } = p.levels[z];
  return { x: Math.floor(col / cpt.x), y: Math.floor(row / cpt.y) };
}

/**
 * Child tiles of (z, x, y) at level z + 1 that exist in the grid. `dx`/`dy` give the quadrant.
 * @param {Pyramid} p
 * @returns {Array<{ z: number, x: number, y: number, dx: number, dy: number }>}
 */
export function tileChildren(p, z, x, y) {
  if (z >= p.maxZoom) return [];
  const next = p.levels[z + 1];
  const out = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const cx = x * 2 + dx;
      const cy = y * 2 + dy;
      if (cx < next.tilesX && cy < next.tilesY) out.push({ z: z + 1, x: cx, y: cy, dx, dy });
    }
  }
  return out;
}

/**
 * Tile rectangle in full-resolution content pixels.
 * @param {Pyramid} p
 */
export function tileRect(p, z, x, y) {
  const f = 1 / p.levels[z].scale;
  return { x: x * p.tile.w * f, y: y * p.tile.h * f, w: p.tile.w * f, h: p.tile.h * f };
}

/**
 * Tiles that contain at least one occupied cell, per level, sorted by row then column.
 * @param {Pyramid} p
 * @param {Iterable<{ col: number, row: number }>} cells
 * @returns {Array<Array<[number, number]>>} indexed by z
 */
export function occupiedTiles(p, cells) {
  const levels = Array.from({ length: p.maxZoom + 1 }, () => new Set());
  const keyOf = (x, y) => `${x},${y}`;
  for (const { col, row } of cells) {
    const t = cellTile(p, p.maxZoom, col, row);
    levels[p.maxZoom].add(keyOf(t.x, t.y));
  }
  for (let z = p.maxZoom; z > 0; z--) {
    for (const key of levels[z]) {
      const [x, y] = key.split(',').map(Number);
      levels[z - 1].add(keyOf(x >> 1, y >> 1));
    }
  }
  return levels.map((set) =>
    [...set]
      .map((key) => /** @type {[number, number]} */ (key.split(',').map(Number)))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]),
  );
}

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * Tiles that a set of rectangles (full-resolution px) touch, per level, sorted
 * by row then column. The rectangle form of occupiedTiles.
 * @param {Pyramid} p
 * @param {Iterable<Rect>} rects
 * @returns {Array<Array<[number, number]>>} indexed by z
 */
export function rectTiles(p, rects) {
  const levels = Array.from({ length: p.maxZoom + 1 }, () => new Set());
  for (const r of rects) {
    const { x0, y0, x1, y1 } = deepTileRange(p, r);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) levels[p.maxZoom].add(`${x},${y}`);
  }
  for (let z = p.maxZoom; z > 0; z--) {
    for (const key of levels[z]) {
      const [x, y] = key.split(',').map(Number);
      levels[z - 1].add(`${x >> 1},${y >> 1}`);
    }
  }
  return levels.map((set) =>
    [...set]
      .map((key) => /** @type {[number, number]} */ (key.split(',').map(Number)))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]),
  );
}

/**
 * What each deepest-level tile composites: the part of every video rectangle
 * inside it. `crop` is in the video's own pixels, `at` in tile pixels. In a
 * grid nothing is cropped; in masonry a video crossing a tile edge is split
 * between the tiles it touches.
 * @template {Rect & { video: number }} R
 * @param {Pyramid} p
 * @param {Iterable<R>} rects
 * @returns {Map<string, Array<{ video: number, crop: Rect, at: { x: number, y: number } }>>} keyed "x,y"
 */
export function tileContents(p, rects) {
  const out = new Map();
  const { w: tw, h: th } = p.tile;
  for (const r of rects) {
    const { x0, y0, x1, y1 } = deepTileRange(p, r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const left = Math.max(r.x, tx * tw);
        const top = Math.max(r.y, ty * th);
        const right = Math.min(r.x + r.w, (tx + 1) * tw);
        const bottom = Math.min(r.y + r.h, (ty + 1) * th);
        const key = `${tx},${ty}`;
        if (!out.has(key)) out.set(key, []);
        out.get(key).push({
          video: r.video,
          crop: { x: left - r.x, y: top - r.y, w: right - left, h: bottom - top },
          at: { x: left - tx * tw, y: top - ty * th },
        });
      }
    }
  }
  return out;
}

/** Deepest-level tiles a rectangle covers (inclusive). @param {Pyramid} p @param {Rect} r */
function deepTileRange(p, r) {
  const { w: tw, h: th } = p.tile;
  return {
    x0: Math.floor(r.x / tw),
    y0: Math.floor(r.y / th),
    x1: Math.floor((r.x + r.w - 1) / tw),
    y1: Math.floor((r.y + r.h - 1) / th),
  };
}
