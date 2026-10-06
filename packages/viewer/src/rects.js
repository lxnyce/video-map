// Videos as rectangles on the wall (plan §5.1): picking, and the tiles that
// share a video. Works for every packing, so the viewer has one code path for
// the grid and masonry.

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * Bring an older manifest up to the rectangle model: version 1 had only grid
 * cells, so derive each video's and group's rectangle from them.
 * @param {any} scene runtime manifest
 * @returns {any} the same object
 */
export function normalizeScene(scene) {
  scene.layout ??= { pack: 'grid' };
  const cell = scene.grid?.cell;
  for (const v of scene.videos) {
    if (!v.rect && v.cell && cell) v.rect = { x: v.cell.col * cell.w, y: v.cell.row * cell.h, w: cell.w, h: cell.h };
    v.rect ??= null;
  }
  for (const g of scene.groups ?? []) {
    if (g.x === undefined && cell) Object.assign(g, { x: g.col * cell.w, y: g.row * cell.h, w: g.cols * cell.w, h: g.rows * cell.h });
  }
  return scene;
}

/**
 * Constant-time lookup of the item under a wall point. Items are bucketed on a
 * coarse grid; a point checks only the items in its bucket.
 * @template {{ rect: Rect | null }} T
 * @param {T[]} items
 * @param {number} width  wall size
 * @param {number} height
 * @param {number} [bucket] bucket size in wall pixels
 */
export function createRectIndex(items, width, height, bucket = 0) {
  const placed = items.filter((i) => i.rect);
  // About one item per bucket on average, but never absurdly small buckets.
  const avg = placed.length ? Math.sqrt(placed.reduce((a, i) => a + i.rect.w * i.rect.h, 0) / placed.length) : 1;
  const size = bucket || Math.max(16, avg);
  const cols = Math.max(1, Math.ceil(width / size));
  const rows = Math.max(1, Math.ceil(height / size));
  /** @type {T[][]} */
  const buckets = Array.from({ length: cols * rows }, () => []);
  const clampX = (x) => Math.min(cols - 1, Math.max(0, Math.floor(x / size)));
  const clampY = (y) => Math.min(rows - 1, Math.max(0, Math.floor(y / size)));
  for (const item of placed) {
    const r = item.rect;
    for (let by = clampY(r.y); by <= clampY(r.y + r.h - 1e-6); by++) {
      for (let bx = clampX(r.x); bx <= clampX(r.x + r.w - 1e-6); bx++) buckets[by * cols + bx].push(item);
    }
  }
  return {
    /** Item whose rectangle contains (x, y), or null (gaps, label strips, outside the wall). */
    at(x, y) {
      if (!(x >= 0 && y >= 0 && x < width && y < height)) return null;
      for (const item of buckets[clampY(y) * cols + clampX(x)]) {
        const r = item.rect;
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return item;
      }
      return null;
    },
  };
}

/**
 * Tiles, per level, that show part of a video another tile also shows. Their
 * playback has to stay tightly in sync, or the video shows a seam. In a grid
 * no video crosses a tile edge, so these sets are empty.
 * @param {Array<{ scale: number, tilesX: number, tilesY: number }>} levels
 * @param {{ w: number, h: number }} tile  tile size in level pixels
 * @param {Array<Rect|null>} rects  video rectangles in wall pixels
 * @returns {Set<string>[]} keys "x,y" per level
 */
export function sharedTiles(levels, tile, rects) {
  return levels.map((level) => {
    const out = new Set();
    if (level.tilesX * level.tilesY <= 1) return out;
    const tw = tile.w / level.scale;
    const th = tile.h / level.scale;
    for (const r of rects) {
      if (!r) continue;
      const x0 = Math.floor(r.x / tw);
      const x1 = Math.floor((r.x + r.w - 1e-6) / tw);
      const y0 = Math.floor(r.y / th);
      const y1 = Math.floor((r.y + r.h - 1e-6) / th);
      if (x0 === x1 && y0 === y1) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.add(`${x},${y}`);
    }
    return out;
  });
}
