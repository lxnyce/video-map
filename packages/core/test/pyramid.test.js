import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { h264Level } from '../src/codec.js';
import { cellTile, createPyramid, occupiedTiles, resolveCellAndTile, tileCellRange, tileChildren, tileRect } from '../src/pyramid.js';

describe('resolveCellAndTile', () => {
  it('derives the cell from a canvas and snaps the tile to whole cells', () => {
    const r = resolveCellAndTile({ cols: 20, rows: 20 }, { canvas: { w: 7680, h: 4320 }, cell: null, tile: { w: 768, h: 432 }, cellAspect: 16 / 9 });
    assert.deepEqual(r.cell, { w: 384, h: 216 });
    assert.deepEqual(r.k, { x: 2, y: 2 });
    assert.deepEqual(r.tile, { w: 768, h: 432 });
    assert.deepEqual(r.warnings, []);
  });

  it('keeps cells even and warns when the tile size changes', () => {
    const r = resolveCellAndTile({ cols: 7, rows: 7 }, { canvas: { w: 2000, h: 1125 }, cell: null, tile: { w: 768, h: 432 }, cellAspect: 16 / 9 });
    assert.equal(r.cell.w % 2, 0);
    assert.equal(r.cell.h % 2, 0);
    assert.ok(r.cell.w * 7 <= 2000 && r.cell.h * 7 <= 1125, 'fits the canvas');
    assert.equal(r.tile.w % r.cell.w, 0);
    assert.equal(r.tile.h % r.cell.h, 0);
    assert.match(r.warnings.join(), /Tile size adjusted/);
  });

  it('uses an explicit cell size, rounding odd dimensions down', () => {
    const r = resolveCellAndTile({ cols: 3, rows: 3 }, { canvas: null, cell: { w: 257, h: 144 }, tile: { w: 512, h: 288 }, cellAspect: 16 / 9 });
    assert.deepEqual(r.cell, { w: 256, h: 144 });
    assert.deepEqual(r.tile, { w: 512, h: 288 });
    assert.match(r.warnings.join(), /rounded/);
  });

  it('makes the tile one cell when cells are bigger than the target tile', () => {
    const r = resolveCellAndTile({ cols: 2, rows: 2 }, { canvas: null, cell: { w: 1280, h: 720 }, tile: { w: 768, h: 432 }, cellAspect: 16 / 9 });
    assert.deepEqual(r.k, { x: 1, y: 1 });
    assert.deepEqual(r.tile, { w: 1280, h: 720 });
  });

  it('rejects tiles too large to decode on phones', () => {
    assert.throws(() => resolveCellAndTile({ cols: 2, rows: 2 }, { canvas: null, cell: { w: 2560, h: 1440 }, tile: { w: 768, h: 432 }, cellAspect: 16 / 9 }), /exceeds/);
  });
});

describe('createPyramid', () => {
  const p = createPyramid({ cols: 20, rows: 20, cell: { w: 384, h: 216 }, k: { x: 2, y: 2 } });

  it('matches the plan example: 400 videos → 10×10, 5×5, 3×3, 2×2, 1×1 tiles', () => {
    assert.equal(p.maxZoom, 4);
    assert.deepEqual(p.levels.map((l) => [l.tilesX, l.tilesY]), [[1, 1], [2, 2], [3, 3], [5, 5], [10, 10]]);
    assert.deepEqual(p.levels.map((l) => l.scale), [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]);
    assert.equal(p.contentWidth, 7680);
    assert.equal(p.contentHeight, 4320);
  });

  it('has a single level when everything fits in one tile', () => {
    const one = createPyramid({ cols: 2, rows: 1, cell: { w: 384, h: 216 }, k: { x: 2, y: 2 } });
    assert.equal(one.maxZoom, 0);
    assert.equal(one.levels.length, 1);
  });

  it('never splits a cell across tiles at any level', () => {
    for (const level of p.levels) {
      const tileW = p.tile.w / level.scale;
      const cellsPerTile = tileW / p.cell.w;
      assert.equal(cellsPerTile, level.cellsPerTile.x);
      assert.ok(Number.isInteger(cellsPerTile));
    }
  });

  it('maps cells to tiles and back consistently', () => {
    for (let z = 0; z <= p.maxZoom; z++) {
      for (const [col, row] of [[0, 0], [7, 3], [19, 19], [10, 11]]) {
        const t = cellTile(p, z, col, row);
        const r = tileCellRange(p, z, t.x, t.y);
        assert.ok(col >= r.col0 && col < r.col1 && row >= r.row0 && row < r.row1);
      }
    }
  });

  it('clips tile ranges to the grid at the edges', () => {
    assert.deepEqual(tileCellRange(p, 2, 2, 2), { col0: 16, row0: 16, col1: 20, row1: 20 });
    assert.deepEqual(tileCellRange(p, 0, 0, 0), { col0: 0, row0: 0, col1: 20, row1: 20 });
  });

  it('lists only children that exist', () => {
    assert.deepEqual(tileChildren(p, 0, 0, 0).map((c) => [c.x, c.y, c.dx, c.dy]), [[0, 0, 0, 0], [1, 0, 1, 0], [0, 1, 0, 1], [1, 1, 1, 1]]);
    assert.deepEqual(tileChildren(p, 2, 2, 2).map((c) => [c.x, c.y]), [[4, 4]], 'level 3 has 5×5 tiles, so only one child');
    assert.deepEqual(tileChildren(p, p.maxZoom, 0, 0), []);
  });

  it('places tiles in full-resolution pixels', () => {
    assert.deepEqual(tileRect(p, 0, 0, 0), { x: 0, y: 0, w: 768 * 16, h: 432 * 16 });
    assert.deepEqual(tileRect(p, 4, 3, 2), { x: 3 * 768, y: 2 * 432, w: 768, h: 432 });
  });
});

describe('occupiedTiles', () => {
  it('includes only tiles with videos, propagated up the pyramid', () => {
    const p = createPyramid({ cols: 8, rows: 8, cell: { w: 64, h: 36 }, k: { x: 2, y: 2 } });
    const tiles = occupiedTiles(p, [{ col: 0, row: 0 }, { col: 7, row: 7 }]);
    assert.deepEqual(tiles[2], [[0, 0], [3, 3]]);
    assert.deepEqual(tiles[1], [[0, 0], [1, 1]]);
    assert.deepEqual(tiles[0], [[0, 0]]);
  });
});

describe('h264Level', () => {
  it('picks the smallest level and builds the codec string', () => {
    assert.deepEqual(h264Level(768, 432, 24), { level: '3.0', codecs: 'avc1.4D401E', mime: 'video/mp4; codecs="avc1.4D401E"' });
    assert.equal(h264Level(1280, 720, 30).level, '3.1');
    assert.equal(h264Level(1920, 1080, 30).level, '4.0');
    assert.equal(h264Level(1920, 1080, 30).codecs, 'avc1.4D4028');
    assert.throws(() => h264Level(8192, 8192, 60), /exceeds/);
  });
});
