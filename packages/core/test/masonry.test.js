import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { computeMasonry, dealColumns, masonryHeight } from '../src/masonry.js';
import { createPyramid, rectTiles, tileContents } from '../src/pyramid.js';
import { planWall } from '../src/wall.js';

const ASPECTS = [16 / 9, 9 / 16, 1, 4 / 3, 21 / 9, 16 / 9, 3 / 4, 16 / 9];
/** counts per group → videos with a mix of shapes, titled so sort order is predictable */
const make = (counts) => counts.flatMap((n, g) => Array.from({ length: n }, (_, i) => ({
  id: `g${g}-${i}`, title: `Video ${String(i).padStart(3, '0')}`, categories: [`c${g}`], aspect: ASPECTS[(i * 3 + g) % ASPECTS.length],
})));
const base = { columnWidth: 384, gap: 0, groupGap: 0, groupArrange: /** @type {const} */ ('columns'), labels: true, avoidSplits: true, aspect: 16 / 9, tile: { w: 768, h: 1024 } };

function assertSound(m, n) {
  assert.equal(m.rects.length, n, 'every video is placed');
  assert.deepEqual(m.rects.map((r) => r.video), Array.from({ length: n }, (_, i) => i), 'rects are indexed by video');
  const pitch = m.columnWidth + m.gap;
  for (const r of m.rects) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= m.width && r.y + r.h <= m.height, `rect ${JSON.stringify(r)} inside the ${m.width}x${m.height} wall`);
    assert.equal(r.w, m.columnWidth);
    assert.equal(r.x % pitch, 0, 'videos sit on column edges');
    assert.ok(r.h % 2 === 0 && r.y % 2 === 0, 'even sizes and positions');
  }
  const byCol = new Map();
  for (const r of m.rects) {
    if (!byCol.has(r.x)) byCol.set(r.x, []);
    byCol.get(r.x).push(r);
  }
  for (const col of byCol.values()) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) assert.ok(col[i].y >= col[i - 1].y + col[i - 1].h + m.gap, 'no overlaps within a column');
  }
  assert.equal(m.tile.w % pitch, 0, 'tiles are a whole number of columns wide');
}

describe('masonryHeight', () => {
  it('keeps the whole frame, rounded to even pixels', () => {
    assert.equal(masonryHeight(384, 16 / 9), 216);
    assert.equal(masonryHeight(384, 9 / 16), 682);
    assert.equal(masonryHeight(384, 1), 384);
  });

  it('clamps extreme shapes to between a third and twice the width', () => {
    assert.equal(masonryHeight(384, 10), 128);
    assert.equal(masonryHeight(384, 0.1), 768);
    assert.equal(masonryHeight(384, NaN), 216, 'unknown shapes default to 16:9');
  });
});

describe('dealColumns', () => {
  it('sends each video to the shortest column, ties to the leftmost', () => {
    const { place, bottom } = dealColumns([100, 50, 30, 30, 10], { cols: 3 });
    assert.deepEqual(place, [{ col: 0, y: 0 }, { col: 1, y: 0 }, { col: 2, y: 0 }, { col: 2, y: 30 }, { col: 1, y: 50 }]);
    assert.equal(bottom, 100);
  });

  it('adds the gap between videos but not after the last', () => {
    const { place, bottom } = dealColumns([100, 100], { cols: 1, gap: 8, y0: 20 });
    assert.deepEqual(place.map((p) => p.y), [20, 128]);
    assert.equal(bottom, 228);
  });

  it('moves a video that fits in one tile down to the next tile edge', () => {
    const { place } = dealColumns([300, 300, 300, 300], { cols: 1, tileH: 1000 });
    assert.deepEqual(place.map((p) => p.y), [0, 300, 600, 1000]);
    // A video taller than a tile can't avoid crossing an edge, so it isn't moved.
    assert.deepEqual(dealColumns([900, 1200], { cols: 1, tileH: 1000 }).place.map((p) => p.y), [0, 900]);
  });

  it('prefers a column where the video fits without moving', () => {
    const { place } = dealColumns([900, 950, 300], { cols: 2, tileH: 1000 });
    assert.deepEqual(place[2], { col: 0, y: 1000 }, 'both columns move to the same edge; the tie goes left');
    const free = dealColumns([900, 600, 300], { cols: 2, tileH: 1000 }).place;
    assert.deepEqual(free[2], { col: 1, y: 600 });
  });
});

describe('computeMasonry', () => {
  it('places every video once, inside the wall, without overlaps', () => {
    const videos = make([40, 25, 12, 30]);
    const m = computeMasonry(videos, { ...base, groupBy: 'category', sortBy: ['title'] });
    assertSound(m, videos.length);
    assert.deepEqual(m.splits, [], 'avoidSplits keeps every video inside one tile');
  });

  it('keeps each video at its own shape', () => {
    const videos = make([20]);
    const m = computeMasonry(videos, { ...base, groupBy: 'none' });
    for (const r of m.rects) assert.equal(r.h, masonryHeight(384, videos[r.video].aspect));
  });

  it('deals videos in sort order: the first goes top left under the label strip', () => {
    const videos = make([12]).reverse();
    const m = computeMasonry(videos, { ...base, groupBy: 'category', sortBy: ['title'] });
    const first = videos.findIndex((v) => v.title === 'Video 000');
    assert.deepEqual([m.rects[first].x, m.rects[first].y], [0, m.labelHeight]);
    assert.ok(m.labelHeight > 0);
    const unlabelled = computeMasonry(videos, { ...base, groupBy: 'none', sortBy: ['title'] });
    assert.deepEqual([unlabelled.rects[first].x, unlabelled.rects[first].y], [0, 0]);
    assert.equal(unlabelled.labelHeight, 0);
    assert.deepEqual(unlabelled.groups, []);
  });

  it('shapes the wall close to the target aspect', () => {
    for (const aspect of [16 / 9, 1, 9 / 16]) {
      const m = computeMasonry(make([300]), { ...base, groupBy: 'none', aspect });
      const shape = m.width / m.height;
      assert.ok(shape > aspect * 0.75 && shape < aspect * 1.33, `aspect ${aspect.toFixed(2)} → ${shape.toFixed(2)}`);
    }
  });

  it('puts column groups side by side, each in its own run of columns, ending at similar heights', () => {
    const videos = make([60, 60, 60]);
    const m = computeMasonry(videos, { ...base, groupBy: 'category' });
    assert.equal(m.groups.length, 3);
    assert.deepEqual(m.groups.map((g) => g.y), [0, 0, 0], 'one shelf');
    for (let i = 1; i < 3; i++) assert.equal(m.groups[i].x, m.groups[i - 1].x + m.groups[i - 1].w, 'adjacent, groupGap 0');
    const heights = m.groups.map((g) => g.h);
    assert.ok(Math.max(...heights) / Math.min(...heights) < 1.35, `balanced: ${heights.join(', ')}`);
    for (const r of m.rects) {
      const g = m.groups[Number(videos[r.video].categories[0].slice(1))];
      assert.ok(r.x >= g.x && r.x + r.w <= g.x + g.w && r.y >= g.y + m.labelHeight && r.y + r.h <= g.y + g.h, 'videos stay in their group');
    }
  });

  it('gives every group at least one column and leaves groupGap columns between them', () => {
    const m = computeMasonry(make([80, 1, 2]), { ...base, groupBy: 'category', groupGap: 1 });
    const pitch = m.columnWidth;
    for (const g of m.groups) assert.ok(g.w >= m.columnWidth);
    const sameShelf = m.groups.filter((g) => g.y === 0).sort((a, b) => a.x - b.x);
    for (let i = 1; i < sameShelf.length; i++) assert.ok(sameShelf[i].x >= sameShelf[i - 1].x + sameShelf[i - 1].w + pitch);
  });

  it('wraps many groups onto shelves', () => {
    const videos = make(Array.from({ length: 24 }, () => 3));
    const m = computeMasonry(videos, { ...base, groupBy: 'category' });
    assertSound(m, videos.length);
    assert.ok(new Set(m.groups.map((g) => g.y)).size > 1, 'more than one shelf');
    for (const [i, a] of m.groups.entries()) {
      for (const b of m.groups.slice(i + 1)) {
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.label} and ${b.label} don't overlap`);
      }
    }
  });

  it('stacks bands across the full width, in group order', () => {
    const videos = make([30, 10, 20]);
    const m = computeMasonry(videos, { ...base, groupBy: 'category', groupArrange: 'bands' });
    assertSound(m, videos.length);
    for (const g of m.groups) assert.deepEqual([g.x, g.w], [0, m.width]);
    for (let i = 1; i < m.groups.length; i++) assert.ok(m.groups[i].y >= m.groups[i - 1].y + m.groups[i - 1].h);
  });

  it('leaves splits to tall videos (or everything without avoidSplits)', () => {
    const videos = make([60]);
    const loose = computeMasonry(videos, { ...base, groupBy: 'none', avoidSplits: false, tile: { w: 768, h: 432 } });
    assert.ok(loose.splits.length > 0);
    const tight = computeMasonry(videos, { ...base, groupBy: 'none', tile: { w: 768, h: 432 } });
    for (const v of tight.splits) assert.ok(tight.rects[v].h > 432, 'only videos taller than a tile cross an edge');
    assert.ok(tight.height >= loose.height, 'avoiding splits costs some empty space');
  });

  it('rounds the gap and snaps the tile to whole columns', () => {
    const m = computeMasonry(make([10]), { ...base, groupBy: 'none', gap: 7, tile: { w: 1000, h: 1000 } });
    assert.equal(m.gap, 8);
    assert.deepEqual(m.tile, { w: 3 * 392, h: 1000 });
    assert.ok(m.warnings.some((w) => /Gap rounded/.test(w)));
    assert.ok(m.warnings.some((w) => /Tile size adjusted/.test(w)));
    assertSound(m, 10);
  });

  it('derives the column width from a canvas and fits inside it', () => {
    const canvas = { w: 3840, h: 2160 };
    const m = computeMasonry(make([50, 50]), { ...base, columnWidth: null, canvas, groupBy: 'category' });
    assert.ok(m.width <= canvas.w && m.height <= canvas.h * 1.02, `${m.width}x${m.height}`);
    assert.ok(m.width > canvas.w * 0.6 || m.height > canvas.h * 0.6, 'and fills a good part of it');
  });
});

describe('planWall', () => {
  it('turns the grid into rectangles that never cross a tile edge', () => {
    const videos = make([30, 20]);
    const config = resolveConfig({ output: { cell: '128x72', tile: '256x144' } });
    const { layout, pyramid, tiles } = planWall(videos, config);
    assert.equal(layout.pack, 'grid');
    assert.equal(layout.rects.length, 50);
    for (const r of layout.rects) {
      const c = layout.grid.cells.find((cell) => cell.video === r.video);
      assert.deepEqual(r, { video: r.video, x: c.col * 128, y: c.row * 72, w: 128, h: 72 });
    }
    for (const pieces of tileContents(pyramid, layout.rects).values()) {
      for (const p of pieces) assert.deepEqual(p.crop, { x: 0, y: 0, w: 128, h: 72 });
    }
    assert.equal(tiles[0].length, 1);
    assert.deepEqual(layout.groups.map((g) => [g.x, g.y]), layout.groups.map((g) => [g.col * 128, g.row * 72]));
  });

  it('builds a masonry wall with the taller default tile', () => {
    const config = resolveConfig({ layout: { pack: 'masonry' } });
    assert.deepEqual(config.output.tile, { w: 768, h: 1024 });
    assert.equal(config.layout.groupGap, 0);
    assert.equal(config.output.cell, null);
    const { layout, pyramid, tiles } = planWall(make([20, 20]), config);
    assert.equal(layout.pack, 'masonry');
    assert.equal(layout.grid, null);
    assert.equal(layout.masonry.columnWidth, 384);
    assert.deepEqual(pyramid.tile, { w: 768, h: 1024 });
    assert.equal(pyramid.cell, null);
    assert.deepEqual([pyramid.contentWidth, pyramid.contentHeight], [layout.width, layout.height]);
    assert.deepEqual(tiles[pyramid.maxZoom], rectTiles(pyramid, layout.rects)[pyramid.maxZoom]);
  });
});

describe('tileContents', () => {
  it('splits a video that crosses a tile edge between both tiles', () => {
    const p = createPyramid({ width: 400, height: 400, tile: { w: 200, h: 200 } });
    const contents = tileContents(p, [{ video: 7, x: 200, y: 150, w: 200, h: 100 }]);
    assert.deepEqual([...contents.keys()], ['1,0', '1,1']);
    assert.deepEqual(contents.get('1,0'), [{ video: 7, crop: { x: 0, y: 0, w: 200, h: 50 }, at: { x: 0, y: 150 } }]);
    assert.deepEqual(contents.get('1,1'), [{ video: 7, crop: { x: 0, y: 50, w: 200, h: 50 }, at: { x: 0, y: 0 } }]);
    assert.deepEqual(rectTiles(p, [{ x: 200, y: 150, w: 200, h: 100 }]), [[[0, 0]], [[1, 0], [1, 1]]]);
  });
});
