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
    /** Items whose rectangles meet a wall region, each once. */
    query(x0, y0, x1, y1) {
      /** @type {Set<T>} */
      const out = new Set();
      if (x1 <= 0 || y1 <= 0 || x0 >= width || y0 >= height) return out;
      for (let by = clampY(y0); by <= clampY(y1); by++) {
        for (let bx = clampX(x0); bx <= clampX(x1); bx++) {
          for (const item of buckets[by * cols + bx]) {
            const r = item.rect;
            if (r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0) out.add(item);
          }
        }
      }
      return out;
    },
  };
}

/**
 * The group each video sits in (index into `groups`, or -1): the group whose
 * rectangle holds the middle of the video's.
 * @param {Array<{ rect: Rect|null }>} videos
 * @param {Rect[]} groups
 * @returns {Int32Array}
 */
export function groupOf(videos, groups) {
  const out = new Int32Array(videos.length).fill(-1);
  videos.forEach((v, i) => {
    const r = v.rect;
    if (!r) return;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    out[i] = groups.findIndex((g) => cx >= g.x && cx < g.x + g.w && cy >= g.y && cy < g.y + g.h);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Layouts: a scene can carry pre-baked alternate arrangements of its videos,
// each with its own tile pyramid (plan §8.4).

/**
 * @typedef {object} Wall  one arrangement: everything that changes when the layout switches
 * @property {string} id
 * @property {string} label
 * @property {any} layout
 * @property {any} grid
 * @property {{ width: number, height: number }} content
 * @property {any} pyramid
 * @property {boolean} labels
 * @property {any[]} groups
 * @property {Array<Rect|null>} rects  per video
 * @property {Array<{ col: number, row: number }|null>} cells  per video
 */

/**
 * Every arrangement in a (normalized) scene, the main one first.
 * @param {any} scene
 * @returns {Wall[]}
 */
export function wallsOf(scene) {
  const main = scene.layouts?.[0];
  /** @type {Wall[]} */
  const walls = [{
    id: main?.id ?? 'default',
    label: main?.label ?? 'Default',
    layout: scene.layout,
    grid: scene.grid,
    content: scene.content,
    pyramid: scene.pyramid,
    labels: scene.labels,
    groups: scene.groups ?? [],
    rects: scene.videos.map((v) => v.rect),
    cells: scene.videos.map((v) => v.cell ?? null),
  }];
  for (const alt of (scene.layouts ?? []).slice(1)) {
    walls.push({
      id: alt.id,
      label: alt.label ?? alt.id,
      layout: alt.layout,
      grid: alt.grid,
      content: alt.content,
      pyramid: alt.pyramid,
      labels: alt.labels,
      groups: alt.groups ?? [],
      rects: scene.videos.map((_, i) => {
        const r = alt.rects?.[i];
        return r ? { x: r[0], y: r[1], w: r[2], h: r[3] } : null;
      }),
      cells: scene.videos.map((_, i) => {
        const c = alt.cells?.[i];
        return c ? { col: c[0], row: c[1] } : null;
      }),
    });
  }
  return walls;
}

/**
 * Make an arrangement the scene's current one: the top-level fields and every
 * video's `rect` and `cell` then describe it.
 * @param {any} scene
 * @param {Wall} wall
 */
export function applyWall(scene, wall) {
  Object.assign(scene, { layout: wall.layout, grid: wall.grid, content: wall.content, pyramid: wall.pyramid, labels: wall.labels, groups: wall.groups });
  scene.videos.forEach((v, i) => {
    v.rect = wall.rects[i];
    v.cell = wall.cells[i];
  });
  return scene;
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
