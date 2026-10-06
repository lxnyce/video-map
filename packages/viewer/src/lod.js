// Level-of-detail selection: which pyramid level to show and which tiles are visible.

/**
 * @typedef {{ z: number, tilesX: number, tilesY: number, scale: number, tiles: Array<[number, number]> }} Level
 * @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect
 */

/**
 * Coarsest level whose resolution is at least what the screen needs.
 * @param {Level[]} levels
 * @param {number} zoom CSS px per content px
 * @param {number} pixelRatio device px per CSS px (capped by the caller)
 * @param {number} [bias] < 1 accepts blurrier tiles to save decoders
 */
export function idealLevel(levels, zoom, pixelRatio, bias = 1) {
  const need = zoom * pixelRatio * bias;
  for (let z = 0; z < levels.length; z++) {
    if (levels[z].scale >= need * 0.999) return z;
  }
  return levels.length - 1;
}

/**
 * Tiles of a level that exist and intersect a content rectangle.
 * @param {Level} level
 * @param {{ w: number, h: number }} tile tile size in level pixels
 * @param {Rect} rect content pixels
 * @param {Set<string>} occupied keys "x,y" of tiles that exist at this level
 * @returns {Array<[number, number]>}
 */
export function tilesInRect(level, tile, rect, occupied) {
  const tw = tile.w / level.scale;
  const th = tile.h / level.scale;
  const x0 = Math.max(0, Math.floor(rect.x0 / tw));
  const y0 = Math.max(0, Math.floor(rect.y0 / th));
  const x1 = Math.min(level.tilesX - 1, Math.ceil(rect.x1 / tw) - 1);
  const y1 = Math.min(level.tilesY - 1, Math.ceil(rect.y1 / th) - 1);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) if (occupied.has(`${x},${y}`)) out.push([x, y]);
  }
  return out;
}

/**
 * Pick the level to play: the ideal one, coarsened until its visible tiles fit the decoder budget.
 * @param {object} o
 * @param {Level[]} o.levels
 * @param {{ w: number, h: number }} [o.tile]
 * @param {Set<string>[]} [o.occupied] per level
 * @param {Rect} [o.rect] visible content rect
 * @param {(z: number) => Array<[number, number]>} [o.tilesAt] visible tiles of a level, in place of tile, occupied and rect (curved surfaces)
 * @param {number} o.zoom
 * @param {number} o.pixelRatio
 * @param {number} o.bias
 * @param {number} o.budget max concurrent tile videos
 * @returns {{ z: number, ideal: number, tiles: Array<[number, number]> }}
 */
export function chooseLevel({ levels, tile, occupied, rect, tilesAt, zoom, pixelRatio, bias, budget }) {
  const at = tilesAt ?? ((z) => tilesInRect(levels[z], tile, rect, occupied[z]));
  const ideal = idealLevel(levels, zoom, pixelRatio, bias);
  let z = ideal;
  let tiles = at(z);
  while (z > 0 && tiles.length > budget) {
    z--;
    tiles = at(z);
  }
  return { z, ideal, tiles };
}

/**
 * Sort tiles by distance from a content point (nearest first).
 * @param {Array<[number, number]>} tiles
 * @param {Level} level
 * @param {{ w: number, h: number }} tile
 * @param {number} cx
 * @param {number} cy
 */
export function byDistance(tiles, level, tile, cx, cy) {
  const tw = tile.w / level.scale;
  const th = tile.h / level.scale;
  const d = (t) => ((t[0] + 0.5) * tw - cx) ** 2 + ((t[1] + 0.5) * th - cy) ** 2;
  return [...tiles].sort((a, b) => d(a) - d(b));
}

/** @param {Level[]} levels */
export function occupancy(levels) {
  return levels.map((l) => new Set(l.tiles.map(([x, y]) => `${x},${y}`)));
}
