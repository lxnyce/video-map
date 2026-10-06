// Tile pyramid math. Pure functions shared by the builder and the viewer.
//
// The deepest level (z = maxZoom) shows cells at full size. Each tile there
// holds k.x × k.y cells. Every level up halves the resolution and doubles the
// cells per tile along each axis, so a cell never straddles two tiles at any
// level. Tiles always have the same pixel size; tiles that run past the
// content edge are filled with the background color.

import { floorEven, formatSize } from './dims.js';

/** @typedef {import('./dims.js').Size} Size */

/**
 * @typedef {object} Level
 * @property {number} z
 * @property {number} tilesX
 * @property {number} tilesY
 * @property {{ x: number, y: number }} cellsPerTile
 * @property {number} scale  level pixels per full-resolution pixel (1 at the deepest level)
 */

/**
 * @typedef {object} Pyramid
 * @property {Size} cell   cell size at the deepest level
 * @property {{ x: number, y: number }} k  cells per tile at the deepest level
 * @property {Size} tile   tile size in pixels (same at every level)
 * @property {number} cols
 * @property {number} rows
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
 * @param {{ cols: number, rows: number, cell: Size, k: { x: number, y: number } }} spec
 * @returns {Pyramid}
 */
export function createPyramid({ cols, rows, cell, k }) {
  if (cols < 1 || rows < 1) throw new Error('The grid needs at least one cell');
  const tile = { w: k.x * cell.w, h: k.y * cell.h };
  const deepX = Math.ceil(cols / k.x);
  const deepY = Math.ceil(rows / k.y);
  let maxZoom = 0;
  while (2 ** maxZoom < Math.max(deepX, deepY)) maxZoom++;

  const levels = [];
  for (let z = 0; z <= maxZoom; z++) {
    const f = 2 ** (maxZoom - z);
    levels.push({
      z,
      tilesX: Math.ceil(deepX / f),
      tilesY: Math.ceil(deepY / f),
      cellsPerTile: { x: k.x * f, y: k.y * f },
      scale: 1 / f,
    });
  }
  return { cell, k, tile, cols, rows, maxZoom, levels, contentWidth: cols * cell.w, contentHeight: rows * cell.h };
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
