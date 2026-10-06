import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockShape, computeLayout, groupVideos } from '../src/layout.js';

const make = (counts) => counts.flatMap((n, g) => Array.from({ length: n }, (_, i) => ({ id: `g${g}-${i}`, title: `Video ${i}`, categories: [`c${g}`] })));

function assertValid(layout, n) {
  assert.equal(layout.cells.length, n, 'every video gets a cell');
  assert.deepEqual(new Set(layout.cells.map((c) => c.video)).size, n, 'each video placed once');
  const taken = new Set();
  for (const c of layout.cells) {
    assert.ok(c.col >= 0 && c.col < layout.cols && c.row >= 0 && c.row < layout.rows, `cell ${c.col},${c.row} inside grid`);
    const key = `${c.col},${c.row}`;
    assert.ok(!taken.has(key), `no two videos share ${key}`);
    taken.add(key);
  }
}

describe('computeLayout', () => {
  it('handles an empty list', () => {
    assert.deepEqual(computeLayout([]), { cols: 0, rows: 0, cells: [], groups: [] });
  });

  it('flows a single group into a grid close to the target aspect', () => {
    const videos = make([400]);
    const layout = computeLayout(videos, { groupBy: 'none', aspect: 1 });
    assertValid(layout, 400);
    assert.equal(layout.cols, 20);
    assert.equal(layout.rows, 20);
    assert.deepEqual(layout.groups, []);
  });

  it('tightens columns so the last row is as full as possible', () => {
    const layout = computeLayout(make([10]), { groupBy: 'none', aspect: 1 });
    assert.equal(layout.cols * layout.rows - 10 < layout.cols, true);
  });

  it('keeps groups as non-overlapping rectangles separated by the gap', () => {
    const counts = [120, 90, 70, 60, 40, 20];
    const layout = computeLayout(make(counts), { groupBy: 'category', aspect: 1, groupGap: 1 });
    assertValid(layout, 400);
    assert.equal(layout.groups.length, 6);
    for (const [i, a] of layout.groups.entries()) {
      for (const b of layout.groups.slice(i + 1)) {
        const apart = a.col + a.cols + 1 <= b.col || b.col + b.cols + 1 <= a.col || a.row + a.rows + 1 <= b.row || b.row + b.rows + 1 <= a.row;
        assert.ok(apart, `${a.label} and ${b.label} are separated by at least one cell`);
      }
    }
    for (const c of layout.cells) {
      const g = layout.groups.find((gr) => c.col >= gr.col && c.col < gr.col + gr.cols && c.row >= gr.row && c.row < gr.row + gr.rows);
      assert.ok(g, 'cell lies inside a group block');
    }
  });

  it('packs realistic category mixes densely and near the target aspect', () => {
    /** @type {Array<[number[], number]>} */
    const cases = [[[120, 90, 70, 60, 40, 20], 1], [[60, 60, 60, 60, 60, 60], 1], [[300, 8, 6, 4], 1], [[400, 250, 150, 100, 60, 40], 2]];
    for (const [counts, aspect] of cases) {
      const n = counts.reduce((a, b) => a + b, 0);
      const layout = computeLayout(make(counts), { groupBy: 'category', aspect, groupGap: 1 });
      assertValid(layout, n);
      const fill = n / (layout.cols * layout.rows);
      const shape = layout.cols / layout.rows;
      assert.ok(fill >= 0.75, `fill ${fill.toFixed(2)} for ${counts}`);
      assert.ok(shape / aspect < 1.25 && aspect / shape < 1.25, `aspect ${shape.toFixed(2)} vs ${aspect} for ${counts}`);
    }
  });

  it('sorts within groups, with descending keys and missing values last', () => {
    const videos = [
      { id: 'a', title: 'Charlie', meta: { year: 2001 } },
      { id: 'b', title: 'alpha', meta: { year: 1999 } },
      { id: 'c', title: 'Bravo 10' },
      { id: 'd', title: 'Bravo 9', meta: { year: 2020 } },
    ];
    const byTitle = computeLayout(videos, { groupBy: 'none', sortBy: ['title'], aspect: 4 });
    assert.deepEqual(byTitle.cells.map((c) => videos[c.video].id), ['b', 'd', 'c', 'a'], 'case-insensitive, numeric-aware');
    const byYear = computeLayout(videos, { groupBy: 'none', sortBy: ['-meta.year'], aspect: 4 });
    assert.deepEqual(byYear.cells.map((c) => videos[c.video].id), ['d', 'a', 'b', 'c']);
  });

  it('is deterministic', () => {
    const videos = make([33, 17, 9]);
    assert.deepEqual(computeLayout(videos, { groupBy: 'category' }), computeLayout(videos, { groupBy: 'category' }));
  });

  it('lays out thousands of videos quickly', () => {
    const videos = Array.from({ length: 5000 }, (_, i) => ({ id: `v${i}`, categories: [`c${i % 40}`] }));
    const t = performance.now();
    const layout = computeLayout(videos, { groupBy: 'category', aspect: 1 });
    assertValid(layout, 5000);
    assert.ok(performance.now() - t < 2000);
  });
});

describe('groupVideos', () => {
  const videos = [
    { id: '1', categories: ['ocean'], tags: ['place:Reef'], meta: { year: 2020 } },
    { id: '2', categories: ['city'], tags: ['place:Paris'] },
    { id: '3', tags: ['x'] },
    { id: '4', categories: ['ocean'], meta: { year: 2019 } },
  ];

  it('orders categories as declared, then alphabetically, with uncategorized last', () => {
    const groups = groupVideos(videos, 'category', [{ id: 'ocean', label: 'Ocean', color: '#123456' }]);
    assert.deepEqual(groups.map((g) => [g.key, g.label, g.items]), [['ocean', 'Ocean', [0, 3]], ['city', 'city', [1]], [null, 'Other', [2]]]);
    assert.equal(groups[0].color, '#123456');
  });

  it('groups by tag prefix and by meta field', () => {
    assert.deepEqual(groupVideos(videos, 'tag:place').map((g) => g.key), ['Paris', 'Reef', null]);
    assert.deepEqual(groupVideos(videos, 'meta.year').map((g) => [g.key, g.items]), [['2019', [3]], ['2020', [0]], [null, [1, 2]]]);
  });

  it('rejects unknown groupBy values', () => {
    assert.throws(() => groupVideos(videos, 'color'), /Unknown groupBy/);
  });
});

describe('blockShape', () => {
  it('never exceeds the max width and always fits n cells', () => {
    for (let n = 1; n < 60; n++) {
      for (const aspect of [0.5, 1, 1.78, 3]) {
        const { w, h } = blockShape(n, aspect, 7);
        assert.ok(w <= 7 && w * h >= n && w * (h - 1) < n);
      }
    }
  });
});
