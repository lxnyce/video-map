// One entry point for every packing strategy (plan §5.1): lay out the wall,
// size the tile pyramid and list its tiles. Whatever the strategy, each video
// comes out as a rectangle in full-resolution wall pixels, and the builder,
// manifest and viewer work from those rectangles.

import { computeLayout } from './layout.js';
import { computeMasonry } from './masonry.js';
import { createPyramid, rectTiles, resolveCellAndTile } from './pyramid.js';

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * @typedef {object} WallGroup
 * @property {string|null} key
 * @property {string} label
 * @property {string|null} color
 * @property {number} count
 * @property {number} x  rectangle in wall pixels
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} [col]  grid only: the group's block in cells
 * @property {number} [row]
 * @property {number} [cols]
 * @property {number} [rows]
 */

/**
 * @typedef {object} WallLayout
 * @property {'grid'|'masonry'} pack
 * @property {number} width   wall size in pixels
 * @property {number} height
 * @property {Array<Rect & { video: number }>} rects  indexed by video
 * @property {WallGroup[]} groups
 * @property {{ cols: number, rows: number, cell: import('./dims.js').Size, cells: Array<{ video: number, col: number, row: number }> } | null} grid
 * @property {{ columnWidth: number, gap: number, columns: number, labelHeight: number, groupArrange: 'columns'|'bands', splits: number[] } | null} masonry
 */

/**
 * @param {Array<import('./layout.js').LayoutVideo & { aspect: number }>} videos  aspect = display width / height
 * @param {import('./config.js').ResolvedConfig} config
 * @param {{ categories?: Array<{ id: string, label?: string, color?: string }> }} [opts]
 * @returns {{ layout: WallLayout, pyramid: import('./pyramid.js').Pyramid, tiles: Array<Array<[number, number]>>, warnings: string[] }}
 */
export function planWall(videos, config, { categories = [] } = {}) {
  const { layout: l, output } = config;
  const aspect = output.canvas ? output.canvas.w / output.canvas.h : l.aspect;

  if (l.pack === 'masonry') {
    const m = computeMasonry(videos, {
      groupBy: l.groupBy,
      sortBy: l.sortBy,
      categories,
      columnWidth: l.columnWidth,
      canvas: output.canvas,
      aspect,
      gap: l.gap,
      groupGap: l.groupGap,
      groupArrange: l.groupArrange,
      labels: l.labels,
      avoidSplits: l.avoidSplits,
      tile: output.tile,
    });
    const warnings = [...m.warnings];
    if (output.cell) warnings.push('output.cell only applies to the grid; masonry uses layout.columnWidth.');
    const pyramid = createPyramid({ width: m.width, height: m.height, tile: m.tile });
    return {
      layout: {
        pack: 'masonry',
        width: m.width,
        height: m.height,
        rects: m.rects,
        groups: m.groups,
        grid: null,
        masonry: { columnWidth: m.columnWidth, gap: m.gap, columns: m.columns, labelHeight: m.labelHeight, groupArrange: m.groupArrange, splits: m.splits },
      },
      pyramid,
      tiles: rectTiles(pyramid, m.rects),
      warnings,
    };
  }

  const grid = computeLayout(videos, {
    groupBy: l.groupBy,
    sortBy: l.sortBy,
    groupGap: l.groupGap,
    aspect: aspect / l.cellAspect,
    categories,
  });
  const dims = resolveCellAndTile(grid, { ...output, cellAspect: l.cellAspect });
  const pyramid = createPyramid({ cols: grid.cols, rows: grid.rows, cell: dims.cell, k: dims.k });
  const { w, h } = dims.cell;
  const rects = grid.cells
    .map((c) => ({ video: c.video, x: c.col * w, y: c.row * h, w, h }))
    .sort((a, b) => a.video - b.video);
  return {
    layout: {
      pack: 'grid',
      width: pyramid.contentWidth,
      height: pyramid.contentHeight,
      rects,
      groups: grid.groups.map((g) => ({ ...g, x: g.col * w, y: g.row * h, w: g.cols * w, h: g.rows * h })),
      grid: { cols: grid.cols, rows: grid.rows, cell: dims.cell, cells: grid.cells },
      masonry: null,
    },
    pyramid,
    tiles: rectTiles(pyramid, rects),
    warnings: dims.warnings,
  };
}
