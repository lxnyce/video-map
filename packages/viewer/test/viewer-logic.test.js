import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPyramid, occupiedTiles, planWall, resolveConfig } from '@videomap/core';
import { Camera } from '../src/camera.js';
import { TIERS, detectTier } from '../src/device.js';
import { formatHash, parseHash } from '../src/hash.js';
import { byDistance, chooseLevel, idealLevel, occupancy, tilesInRect } from '../src/lod.js';
import { applyWall, createRectIndex, groupOf, normalizeScene, sharedTiles, wallsOf } from '../src/rects.js';
import { NO_FILTER, createSearch, facets, fold, isFiltering } from '../src/search.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('Camera', () => {
  const make = () => {
    const c = new Camera(6400, 3600);
    c.setViewport(1280, 720);
    c.set(c.homeView());
    return c;
  };

  it('starts fitted and centered', () => {
    const c = make();
    close(c.x, 3200);
    close(c.y, 1800);
    close(c.zoom, 0.2 * 0.94);
  });

  it('converts between screen and content coordinates', () => {
    const c = make();
    c.set({ x: 1000, y: 800, zoom: 1 });
    const p = c.screenToContent(100, 50);
    const s = c.contentToScreen(p.x, p.y);
    close(s.x, 100);
    close(s.y, 50);
    close(c.screenToContent(640, 360).x, 1000);
  });

  it('zooms about the cursor', () => {
    const c = make();
    c.set({ x: 3200, y: 1800, zoom: 0.5 });
    const before = c.screenToContent(300, 200);
    c.zoomAt(2, 300, 200);
    const after = c.screenToContent(300, 200);
    close(before.x, after.x);
    close(before.y, after.y);
    close(c.zoom, 1);
  });

  it('clamps zoom and keeps the wall on screen', () => {
    const c = make();
    c.set({ x: -5000, y: 99999, zoom: 50 });
    assert.equal(c.zoom, c.maxZoom);
    const r = c.visibleRect();
    assert.ok(r.x0 >= 0 && r.y1 <= 3600);
    c.set({ x: 0, y: 0, zoom: 0.0001 });
    close(c.zoom, c.minZoom);
    const small = c.visibleRect();
    assert.ok(small.x0 <= 0 && small.x1 >= 6400 && small.y0 <= 0 && small.y1 >= 3600, 'a wall smaller than the screen stays fully visible');
    c.set({ x: 3000, y: 1700, zoom: c.minZoom });
    close(c.x, 3000, 1e-6);
  });

  it('pans with the pointer direction', () => {
    const c = make();
    c.set({ x: 3200, y: 1800, zoom: 1 });
    c.panBy(100, -50);
    close(c.x, 3100);
    close(c.y, 1850);
  });

  it('animates flights to the exact target and decays flings', () => {
    const c = make();
    c.flyTo({ x: 1000, y: 1000, zoom: 1 }, 0, 500);
    assert.ok(c.moving);
    c.step(250);
    assert.ok(c.zoom > 0.188 && c.zoom < 1);
    c.step(500);
    assert.ok(!c.moving);
    assert.deepEqual(c.view, { x: 1000, y: 1000, zoom: 1 });

    c.fling(1, 0, 1000);
    let t = 1000;
    while (c.moving && t < 10000) c.step((t += 16));
    assert.ok(!c.moving, 'fling stops');
    assert.ok(c.x < 1000, 'moved in the fling direction');
  });

  it('frames a rectangle', () => {
    const c = make();
    const v = c.viewForRect({ x: 1000, y: 1000, w: 320, h: 180 }, { fraction: 0.5 });
    close(v.zoom, 2, 1e-9); // limited by maxZoom (640/320 = 2)
    close(v.x, 1160);
    close(v.y, 1090);
  });
});

describe('level of detail', () => {
  const p = createPyramid({ cols: 20, rows: 20, cell: { w: 384, h: 216 }, k: { x: 2, y: 2 } });
  const cells = Array.from({ length: 400 }, (_, i) => ({ col: i % 20, row: Math.floor(i / 20) }));
  const tiles = occupiedTiles(p, cells);
  const levels = p.levels.map((l) => ({ ...l, tiles: tiles[l.z] }));
  const occupied = occupancy(levels);

  it('picks the coarsest level that is sharp enough', () => {
    assert.equal(idealLevel(levels, 0.1, 1), 0);
    assert.equal(idealLevel(levels, 0.12, 1), 1);
    assert.equal(idealLevel(levels, 0.5, 1), 3);
    assert.equal(idealLevel(levels, 0.5, 2), 4);
    assert.equal(idealLevel(levels, 5, 2), 4, 'never beyond the deepest level');
    assert.equal(idealLevel(levels, 0.5, 1, 0.5), 2, 'bias accepts coarser tiles');
  });

  it('lists visible tiles that exist', () => {
    const all = { x0: 0, y0: 0, x1: 7680, y1: 4320 };
    assert.equal(tilesInRect(levels[4], p.tile, all, occupied[4]).length, 100);
    assert.deepEqual(tilesInRect(levels[4], p.tile, { x0: 700, y0: 400, x1: 800, y1: 450 }, occupied[4]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
    assert.deepEqual(tilesInRect(levels[0], p.tile, all, occupied[0]), [[0, 0]]);
    assert.deepEqual(tilesInRect(levels[4], p.tile, { x0: -500, y0: -500, x1: -1, y1: -1 }, occupied[4]), []);
  });

  it('coarsens until the visible tiles fit the decoder budget', () => {
    const rect = { x0: 0, y0: 0, x1: 2560, y1: 1440 }; // 3.3 × 3.3 deepest tiles
    const deep = chooseLevel({ levels, tile: p.tile, occupied, rect, zoom: 0.5, pixelRatio: 2, bias: 1, budget: 16 });
    assert.equal(deep.z, 4);
    assert.equal(deep.tiles.length, 16);
    const low = chooseLevel({ levels, tile: p.tile, occupied, rect, zoom: 0.5, pixelRatio: 2, bias: 1, budget: 4 });
    assert.equal(low.ideal, 4);
    assert.equal(low.z, 3);
    assert.ok(low.tiles.length <= 4);
  });

  it('orders tiles nearest the view center first', () => {
    const order = byDistance([[0, 0], [2, 2], [1, 1]], levels[4], p.tile, 1.5 * 768, 1.5 * 432);
    assert.deepEqual(order[0], [1, 1]);
  });
});

describe('deep links', () => {
  it('round-trips camera and video', () => {
    const hash = formatHash({ cam: { x: 1234.56, y: 78.9, zoom: 0.123456 }, v: 'reef 01' });
    assert.equal(hash, '#cam=1235,79,0.1235&v=reef%2001');
    assert.deepEqual(parseHash(hash), { v: 'reef 01', cam: { x: 1235, y: 79, zoom: 0.1235 }, layout: null, q: '', cats: [], tags: [] });
  });

  it('round-trips the layout, search text and filters, with commas inside items', () => {
    const state = { layout: 'by place', cam: { x: 10, y: 20, zoom: 1 }, v: null, q: 'café & bar', cats: ['ocean', 'sky'], tags: ['place:Lisbon, PT', 'aerial'] };
    const hash = formatHash(state);
    assert.match(hash, /^#layout=by%20place&cam=10,20,1&q=caf%C3%A9%20%26%20bar&cat=ocean,sky&tag=place%3ALisbon%2C%20PT,aerial$/);
    assert.deepEqual(parseHash(hash), state);
    assert.equal(formatHash({ q: '   ', cats: [], tags: [] }), '', 'blank search and empty filters stay out of the URL');
    assert.equal(parseHash('#q=a+b').q, 'a b');
  });

  it('ignores junk', () => {
    assert.deepEqual(parseHash('#cam=a,b,c&v=&x=1&%E0'), { v: null, cam: null, layout: null, q: '', cats: [], tags: [] });
    assert.deepEqual(parseHash('#tag=%E0,ok,').tags, ['ok']);
    assert.equal(formatHash({}), '');
  });
});

describe('device tiers', () => {
  it('classifies typical devices', () => {
    const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', hardwareConcurrency: 6 };
    assert.equal(detectTier(iphone).name, 'mid');
    const budgetAndroid = { userAgent: 'Mozilla/5.0 (Linux; Android 11; Moto) Mobile', hardwareConcurrency: 8, deviceMemory: 2 };
    assert.equal(detectTier(budgetAndroid).name, 'low');
    const desktop = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', hardwareConcurrency: 12, deviceMemory: 8 };
    assert.equal(detectTier(desktop, 'ANGLE (NVIDIA GeForce RTX 3060)').name, 'high');
    assert.equal(detectTier(desktop, 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))').name, 'low');
  });

  it('accepts URL overrides', () => {
    const t = detectTier({ userAgent: 'x', hardwareConcurrency: 16 }, '', new URLSearchParams('tier=low&budget=6'));
    assert.equal(t.name, 'low');
    assert.equal(t.budget, 6);
    assert.equal(TIERS.low.budget, 4, 'presets are not mutated');
  });
});

describe('video rectangles', () => {
  it('upgrades version 1 manifests from cells to rectangles', () => {
    const scene = normalizeScene({
      grid: { cols: 2, rows: 1, cell: { w: 384, h: 216 } },
      groups: [{ col: 1, row: 0, cols: 1, rows: 1 }],
      videos: [{ id: 'a', cell: { col: 1, row: 0 } }, { id: 'b', cell: null }],
    });
    assert.deepEqual(scene.layout, { pack: 'grid' });
    assert.deepEqual(scene.videos[0].rect, { x: 384, y: 0, w: 384, h: 216 });
    assert.equal(scene.videos[1].rect, null);
    assert.deepEqual([scene.groups[0].x, scene.groups[0].w], [384, 384]);
  });

  it('picks the video under a point, and nothing in gaps or outside the wall', () => {
    const items = [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 50 } },
      { id: 'b', rect: { x: 0, y: 60, w: 100, h: 300 } },
      { id: 'c', rect: { x: 110, y: 0, w: 100, h: 100 } },
      { id: 'none', rect: null },
    ];
    const index = createRectIndex(items, 210, 360, 64);
    assert.equal(index.at(10, 10)?.id, 'a');
    assert.equal(index.at(99.9, 49.9)?.id, 'a');
    assert.equal(index.at(50, 55), null, 'gutter');
    assert.equal(index.at(50, 300)?.id, 'b', 'tall video spanning several buckets');
    assert.equal(index.at(105, 10), null);
    assert.equal(index.at(150, 99)?.id, 'c');
    assert.equal(index.at(-1, 10), null);
    assert.equal(index.at(10, 360), null);
  });

  it('finds every video of a real masonry wall by its center', () => {
    const videos = Array.from({ length: 80 }, (_, i) => ({ id: `v${i}`, title: `${i}`, aspect: [16 / 9, 9 / 16, 1, 4 / 3][i % 4] }));
    const { layout } = planWall(videos, resolveConfig({ layout: { pack: 'masonry', groupBy: 'none', gap: 8 } }));
    const items = videos.map((v, i) => ({ ...v, rect: layout.rects[i] }));
    const index = createRectIndex(items, layout.width, layout.height);
    for (const it of items) assert.equal(index.at(it.rect.x + it.rect.w / 2, it.rect.y + it.rect.h / 2), it);
  });

  it('groups the tiles that share a video, per level', () => {
    const levels = [{ scale: 0.25, tilesX: 1, tilesY: 1 }, { scale: 0.5, tilesX: 1, tilesY: 2 }, { scale: 1, tilesX: 2, tilesY: 4 }];
    const tile = { w: 100, h: 100 };
    const shared = sharedTiles(levels, tile, [{ x: 0, y: 80, w: 100, h: 40 }, { x: 100, y: 0, w: 100, h: 50 }, null]);
    assert.deepEqual([...shared[2]].sort(), ['0,0', '0,1'], 'the video across y=100 links two deepest tiles');
    assert.deepEqual([...shared[1]], [], 'at level 1 it fits inside one tile');
    assert.deepEqual([...shared[0]], [], 'level 0 is a single tile');
  });
});

describe('search and filters', () => {
  const videos = [
    { id: 'a', title: 'Coral Reef', categories: ['ocean'], tags: ['fish', 'place:Lisbon'], description: 'Bright café fish' },
    { id: 'b', title: 'Night Market', categories: ['city'], tags: ['place:Kyoto', 'night'], meta: { year: 2021, camera: 'Sony' } },
    { id: 'c', title: 'Harbour at Night', categories: ['city', 'ocean'], tags: ['night', 'place:Lisbon'], credits: { author: 'Ana Ruiz' } },
    { id: 'd', title: 'Pines', categories: ['forest'], tags: ['place:Oslo'] },
  ];
  const s = createSearch(videos, (id) => ({ ocean: 'Sea and coast' })[id] ?? id);
  const ids = (m) => videos.filter((_, i) => m[i]).map((v) => v.id);
  const q = (text) => ({ q: text, cats: [], tags: [] });

  it('matches nothing to filter with null', () => {
    assert.equal(s.match(NO_FILTER), null);
    assert.equal(s.match(q('  ')), null);
    assert.ok(!isFiltering(q(' ')));
    assert.ok(isFiltering({ q: '', cats: [], tags: ['x'] }));
  });

  it('needs every word, anywhere in the text, ignoring case and accents', () => {
    assert.deepEqual(ids(s.match(q('night'))), ['b', 'c']);
    assert.deepEqual(ids(s.match(q('NIGHT harbour'))), ['c']);
    assert.deepEqual(ids(s.match(q('cafe'))), ['a'], 'description, without the accent');
    assert.deepEqual(ids(s.match(q('coast'))), ['a', 'c'], 'category labels');
    assert.deepEqual(ids(s.match(q('sony 2021'))), ['b'], 'meta values');
    assert.deepEqual(ids(s.match(q('ruiz'))), ['c'], 'credits');
    assert.deepEqual(ids(s.match(q('kyoto'))), ['b'], 'tags');
    assert.equal(fold('Ça Va'), 'ca va');
  });

  it('takes any of the chosen categories, and all of the chosen tags', () => {
    assert.deepEqual(ids(s.match({ q: '', cats: ['forest', 'city'], tags: [] })), ['b', 'c', 'd']);
    assert.deepEqual(ids(s.match({ q: '', cats: [], tags: ['night', 'place:Lisbon'] })), ['c']);
    assert.deepEqual(ids(s.match({ q: 'reef', cats: ['ocean'], tags: ['fish'] })), ['a']);
    assert.deepEqual(ids(s.match({ q: 'reef', cats: ['city'], tags: [] })), []);
  });

  it('offers category chips in the scene order and the commonest tags, leaving out chips that filter nothing', () => {
    const more = [...videos, { id: 'e', title: 'E', categories: ['misc'], tags: ['place:Lisbon'] }];
    const f = facets(more, [{ id: 'forest', label: 'Woods', color: '#3a9b5c' }, { id: 'ocean' }, { id: 'unused' }], 2);
    assert.deepEqual(f.categories.map((c) => `${c.id}:${c.label}:${c.count}`), ['forest:Woods:1', 'ocean:ocean:2', 'city:city:2', 'misc:misc:1']);
    assert.equal(f.categories[0].color, '#3a9b5c');
    assert.deepEqual(f.tags.map((t) => `${t.id}:${t.count}`), ['place:Lisbon:3', 'night:2']);
    assert.equal(f.moreTags, 3);
    const same = facets([{ categories: ['x'], tags: ['all'] }, { categories: ['x'], tags: ['all'] }]);
    assert.deepEqual(same.categories, [], 'one category that every video has');
    assert.deepEqual(same.tags, []);
  });
});

describe('layouts and groups', () => {
  const scene = normalizeScene({
    layout: { pack: 'grid' },
    grid: { cols: 4, rows: 1, cell: { w: 100, h: 50 } },
    content: { width: 400, height: 50 },
    pyramid: { tile: { w: 200, h: 50 }, levels: [] },
    labels: true,
    groups: [{ label: 'A', x: 0, y: 0, w: 200, h: 50, count: 2 }, { label: 'B', x: 200, y: 0, w: 200, h: 50, count: 1 }],
    layouts: [
      { id: 'default', label: 'By category' },
      {
        id: 'year', label: 'By year', layout: { pack: 'masonry' }, grid: null, content: { width: 100, height: 300 },
        pyramid: { tile: { w: 100, h: 100 }, levels: [] }, labels: false, groups: [{ label: '2020', x: 0, y: 0, w: 100, h: 300, count: 3 }],
        rects: [[0, 0, 100, 60], null, [0, 100, 100, 200]], cells: null,
      },
    ],
    videos: [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 50 }, cell: { col: 0, row: 0 } },
      { id: 'b', rect: { x: 100, y: 0, w: 100, h: 50 }, cell: { col: 1, row: 0 } },
      { id: 'c', rect: { x: 300, y: 0, w: 100, h: 50 }, cell: { col: 3, row: 0 } },
    ],
  });

  it('reads the main arrangement and the alternates, and switches between them', () => {
    const walls = wallsOf(scene);
    assert.deepEqual(walls.map((w) => `${w.id}:${w.label}`), ['default:By category', 'year:By year']);
    applyWall(scene, walls[1]);
    assert.equal(scene.layout.pack, 'masonry');
    assert.equal(scene.content.height, 300);
    assert.equal(scene.labels, false);
    assert.deepEqual(scene.videos.map((v) => v.rect), [{ x: 0, y: 0, w: 100, h: 60 }, null, { x: 0, y: 100, w: 100, h: 200 }]);
    assert.deepEqual(scene.videos.map((v) => v.cell), [null, null, null]);
    applyWall(scene, walls[0]);
    assert.deepEqual(scene.videos[2].rect, { x: 300, y: 0, w: 100, h: 50 });
    assert.deepEqual(scene.videos[1].cell, { col: 1, row: 0 });
    assert.equal(wallsOf({ ...scene, layouts: undefined })[0].id, 'default', 'scenes from before milestone 5 have one layout');
  });

  it('puts each video in the group that holds its middle', () => {
    assert.deepEqual([...groupOf(scene.videos, scene.groups)], [0, 0, 1]);
    assert.deepEqual([...groupOf([{ rect: null }, { rect: { x: 900, y: 0, w: 1, h: 1 } }], scene.groups)], [-1, -1]);
  });

  it('finds the videos meeting a region, each once', () => {
    const items = [{ rect: { x: 0, y: 0, w: 100, h: 100 } }, { rect: { x: 100, y: 0, w: 300, h: 100 } }, { rect: { x: 0, y: 100, w: 400, h: 100 } }, { rect: null }];
    const index = createRectIndex(items, 400, 200, 50);
    const found = (x0, y0, x1, y1) => [...index.query(x0, y0, x1, y1)].map((i) => items.indexOf(i)).sort();
    assert.deepEqual(found(0, 0, 400, 200), [0, 1, 2]);
    assert.deepEqual(found(10, 10, 50, 50), [0]);
    assert.deepEqual(found(99, 90, 101, 99), [0, 1]);
    assert.deepEqual(found(-50, -50, 400, 0), [], 'touching an edge is not meeting');
    assert.deepEqual(found(500, 0, 600, 100), []);
  });
});
