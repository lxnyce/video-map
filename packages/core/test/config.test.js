import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULTS, describeLayout, resolveConfig, resolveLayouts } from '../src/config.js';
import { parseRatio, parseSize } from '../src/dims.js';
import { PATHS, createRuntimeManifest, fillTemplate } from '../src/manifest.js';
import { createPyramid } from '../src/pyramid.js';
import { planWall } from '../src/wall.js';
import { sceneSchema } from '../src/schema.js';
import { assignIds, slugify, validateScene } from '../src/validate.js';

describe('parseSize / parseRatio', () => {
  it('parses sizes and ratios', () => {
    assert.deepEqual(parseSize('768x432'), { w: 768, h: 432 });
    assert.deepEqual(parseSize(' 10 X 20 '), { w: 10, h: 20 });
    assert.throws(() => parseSize('768'), /WIDTHxHEIGHT/);
    assert.throws(() => parseSize('1x1'), /at least/);
    assert.equal(parseRatio('16:9'), 16 / 9);
    assert.equal(parseRatio('4/3'), 4 / 3);
    assert.equal(parseRatio(2), 2);
    assert.throws(() => parseRatio('wide'), /W:H/);
  });
});

describe('resolveConfig', () => {
  it('fills defaults and derives the frame count', () => {
    const c = resolveConfig({ videos: [] });
    assert.equal(c.preview.frames, 240);
    assert.deepEqual(c.output.cell, { w: 384, h: 216 });
    assert.equal(c.output.canvas, null);
    assert.equal(c.layout.cellAspect, 16 / 9);
    assert.equal(c.surface.type, 'plane');
    assert.equal(c.layout.pack, 'grid');
    assert.equal(c.layout.fit, 'contain', 'whole frames by default');
    assert.equal(c.layout.groupGap, 1);
    assert.deepEqual(c.output.tile, { w: 768, h: 432 });
    assert.deepEqual(c.build, { hardware: 'auto', hardwareFinal: false, hardwareJobs: 3 });
  });

  it('lets overrides win over the scene, and the scene over defaults', () => {
    const scene = { preview: { duration: 6, fps: 15 }, output: { tile: '512x288', full: { maxHeight: 720 } } };
    const c = resolveConfig(scene, { preview: { fps: 12 }, output: { full: { crf: 20 } } });
    assert.equal(c.preview.duration, 6);
    assert.equal(c.preview.fps, 12);
    assert.equal(c.preview.frames, 72);
    assert.deepEqual(c.output.tile, { w: 512, h: 288 });
    assert.deepEqual(c.output.full, { enabled: true, maxHeight: 720, crf: 20 });
    assert.equal(DEFAULTS.output.full.maxHeight, 1080, 'defaults are not mutated');
  });

  it('lets a --canvas override replace the scene cell (and vice versa)', () => {
    assert.deepEqual(resolveConfig({ output: { cell: '256x144' } }, { output: { canvas: '3840x2160' } }).output.cell, null);
    assert.deepEqual(resolveConfig({ output: { canvas: '3840x2160' } }, { output: { cell: '256x144' } }).output.canvas, null);
    assert.throws(() => resolveConfig({ output: { canvas: '3840x2160', cell: '256x144' } }), /only one/);
  });
});

describe('resolveLayouts', () => {
  const scene = {
    layout: { groupBy: 'category', label: 'By topic' },
    output: { cell: '256x144' },
    layouts: [
      { id: 'place', groupBy: 'tag:place', sortBy: ['-duration'] },
      { id: 'flow', label: 'Free flow', pack: 'masonry', groupBy: 'none' },
    ],
    videos: [],
  };

  it('resolves the main layout, then each alternate on top of the shared settings', () => {
    const all = resolveLayouts(scene, { layout: { groupBy: 'meta.year', fit: 'cover' }, preview: { fps: 12 } });
    assert.deepEqual(all.map((l) => `${l.id}: ${l.label}`), ['default: By topic', 'place: By place', 'flow: Free flow']);
    const [main, place, flow] = all.map((l) => l.config);
    assert.equal(main.layout.groupBy, 'meta.year', 'the CLI wins over the scene for the main layout');
    assert.equal(place.layout.groupBy, 'tag:place', "an alternate's own fields win over the CLI");
    assert.deepEqual(place.layout.sortBy, ['-duration']);
    assert.equal(place.layout.fit, 'cover', 'everything else is shared, CLI overrides included');
    assert.equal(place.preview.fps, 12);
    assert.deepEqual(place.output.cell, { w: 256, h: 144 });
    assert.equal(place.layout.label, undefined, "the main layout's label isn't inherited");
    assert.equal(flow.layout.pack, 'masonry');
    assert.equal(flow.output.cell, null, 'the grid cell size means nothing to a masonry alternate');
    assert.deepEqual(flow.output.tile, { w: 768, h: 1024 }, 'masonry tile default');
    assert.equal(resolveLayouts({ videos: [] }).length, 1);
  });

  it('names layouts after what they group or sort by', () => {
    assert.equal(describeLayout({ groupBy: 'category', sortBy: [] }), 'By category');
    assert.equal(describeLayout({ groupBy: 'tag:place', sortBy: [] }), 'By place');
    assert.equal(describeLayout({ groupBy: 'meta.year', sortBy: [] }), 'By year');
    assert.equal(describeLayout({ groupBy: 'none', sortBy: ['-duration'] }), 'By duration');
    assert.equal(describeLayout({ groupBy: 'none', sortBy: [] }), 'All videos');
  });
});

describe('validateScene', () => {
  const ok = { videos: [{ src: 'a.mp4' }] };

  it('accepts a minimal scene', () => {
    assert.deepEqual(validateScene(ok), { valid: true, errors: [], warnings: [] });
  });

  it('reports schema problems with readable paths', () => {
    const r = validateScene({
      title: 'x',
      surprise: 1,
      output: { tile: '768' },
      layout: { fit: 'stretch', groupBy: 'colour' },
      videos: [{ src: 'a.mp4', id: 'bad id' }, {}],
    });
    assert.equal(r.valid, false);
    const text = r.errors.map((e) => `${e.path}: ${e.message}`);
    assert.ok(text.includes('(root): has unknown property "surprise"'), text.join('\n'));
    assert.ok(text.includes('output.tile: must look like WIDTHxHEIGHT, e.g. 768x432'), text.join('\n'));
    assert.ok(text.includes('layout.fit: must be one of "cover", "contain"'), text.join('\n'));
    assert.ok(text.some((t) => t.startsWith('layout.groupBy:')), text.join('\n'));
    assert.ok(text.some((t) => t.startsWith('videos[0].id:')), text.join('\n'));
    assert.ok(text.includes("videos[1]: must have required property 'src'"), text.join('\n'));
  });

  it('catches duplicate ids, both canvas and cell, and unknown categories', () => {
    const r = validateScene({
      output: { canvas: '100x100', cell: '10x10' },
      categories: [{ id: 'a' }],
      videos: [{ id: 'x', src: '1.mp4', categories: ['b'] }, { id: 'x', src: '2.mp4' }],
    });
    assert.equal(r.valid, false);
    assert.deepEqual(r.errors.map((e) => e.path), ['videos[1].id', 'output']);
    assert.deepEqual(r.warnings.map((w) => w.path), ['videos[0].categories[0]']);
  });

  it('checks alternate layouts: unique ids, not "default", and layout fields only', () => {
    const r = validateScene({
      layouts: [{ id: 'place', groupBy: 'tag:place' }, { id: 'place' }, { id: 'default' }, { id: 'x', canvas: '10x10' }, { groupBy: 'none' }],
      videos: [{ src: 'a.mp4' }],
    });
    assert.equal(r.valid, false);
    const text = r.errors.map((e) => `${e.path}: ${e.message}`);
    assert.ok(text.includes('layouts[3]: has unknown property "canvas"'), text.join('\n'));
    assert.ok(text.includes("layouts[4]: must have required property 'id'"), text.join('\n'));
    const dupes = validateScene({ layouts: [{ id: 'place' }, { id: 'place' }, { id: 'default' }], videos: [{ src: 'a.mp4' }] });
    assert.deepEqual(dupes.errors.map((e) => e.path), ['layouts[1].id', 'layouts[2].id']);
    assert.ok(validateScene({ layout: { label: 'Main' }, layouts: [{ id: 'flow', pack: 'masonry', label: 'Flow' }], videos: [{ src: 'a.mp4' }] }).valid);
  });
});

describe('ids', () => {
  it('derives unique ids from file names', () => {
    assert.deepEqual(assignIds([{ src: 'a/Coral Reef.mp4' }, { src: 'b/coral-reef.mov' }, { id: 'coral-reef-3', src: 'x' }, { src: 'Été.mp4' }]), ['coral-reef', 'coral-reef-2', 'coral-reef-3', 'ete']);
    assert.equal(slugify('  Hello, World!  '), 'hello-world');
  });
});

describe('schema file', () => {
  it('matches the schema in source (run "npm run schema" after editing)', () => {
    const file = JSON.parse(readFileSync(new URL('../schema/scene.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(file, JSON.parse(JSON.stringify(sceneSchema)));
  });
});

describe('createRuntimeManifest', () => {
  it('attaches rectangles and cells to videos and tile lists to levels', () => {
    const config = resolveConfig({ title: 'T', videos: [] });
    const pyramid = createPyramid({ cols: 2, rows: 1, cell: { w: 2, h: 2 }, k: { x: 1, y: 1 } });
    const cells = [{ video: 0, col: 1, row: 0 }, { video: 1, col: 0, row: 0 }];
    const layout = {
      pack: /** @type {const} */ ('grid'), width: 4, height: 2, groups: [], masonry: null,
      rects: [{ video: 0, x: 2, y: 0, w: 2, h: 2 }, { video: 1, x: 0, y: 0, w: 2, h: 2 }],
      grid: { cols: 2, rows: 1, cell: { w: 2, h: 2 }, cells },
    };
    const m = createRuntimeManifest({ config, pyramid, layout, videos: /** @type {any} */ ([{ id: 'a' }, { id: 'b' }]), tiles: [[[0, 0]], [[0, 0], [1, 0]]], tileSources: [{ template: PATHS.tile, mime: 'video/mp4' }] });
    assert.equal(m.format, 'videomap-scene');
    assert.equal(m.version, 2);
    assert.deepEqual(m.layout, { pack: 'grid' });
    assert.deepEqual(m.grid, { cols: 2, rows: 1, cell: { w: 2, h: 2 } });
    assert.deepEqual(m.videos.map((v) => v.cell), [{ col: 1, row: 0 }, { col: 0, row: 0 }]);
    assert.deepEqual(m.videos.map((v) => v.rect), [{ x: 2, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 2, h: 2 }]);
    assert.deepEqual(m.pyramid.levels[1].tiles, [[0, 0], [1, 0]]);
    assert.equal(fillTemplate(m.pyramid.video.template, { z: 1, x: 0, y: 2 }), 'tiles/1/0/2.mp4');
  });

  it('describes a masonry wall without a grid', () => {
    const config = resolveConfig({ layout: { pack: 'masonry', groupBy: 'none' }, videos: [] });
    const videos = [{ id: 'a', aspect: 16 / 9 }, { id: 'b', aspect: 9 / 16 }];
    const { layout, pyramid, tiles } = planWall(videos, config);
    const m = createRuntimeManifest({ config, pyramid, layout, videos: /** @type {any} */ (videos), tiles, tileSources: [{ template: PATHS.tile, mime: 'video/mp4' }] });
    assert.equal(m.grid, null);
    assert.equal(m.pyramid.cellsPerTile, null);
    assert.deepEqual(m.layout, { pack: 'masonry', columnWidth: 384, gap: 0, columns: layout.masonry.columns, labelHeight: 0, groupArrange: 'columns' });
    assert.deepEqual(m.videos.map((v) => v.cell), [null, null]);
    assert.deepEqual(m.videos.map((v) => v.rect.h), [216, 682]);
  });

  it('lists the layouts, with each alternate\'s pyramid, groups and rectangles under its own folder', () => {
    const scene = { layout: { groupBy: 'none' }, layouts: [{ id: 'flow', pack: 'masonry', groupBy: 'none' }], videos: [] };
    const [main, flow] = resolveLayouts(scene);
    const videos = [{ id: 'a', aspect: 16 / 9 }, { id: 'b', aspect: 9 / 16 }];
    const w0 = planWall(videos, main.config);
    const w1 = planWall(videos, flow.config);
    const m = createRuntimeManifest({
      config: main.config,
      ...w0,
      videos: /** @type {any} */ (videos),
      tileSources: [{ template: PATHS.tile, mime: 'video/mp4' }],
      main: { id: main.id, label: main.label },
      alternates: [{ id: flow.id, label: flow.label, config: flow.config, ...w1, tileSources: [{ template: `layouts/flow/${PATHS.tile}`, mime: 'video/mp4' }], prefix: 'layouts/flow/' }],
    });
    assert.deepEqual(m.layouts.map((l) => l.id), ['default', 'flow']);
    assert.deepEqual(m.layouts[0], { id: 'default', label: 'By title' }, "the main layout's data stays at the top level");
    const alt = /** @type {any} */ (m.layouts[1]);
    assert.equal(alt.layout.pack, 'masonry');
    assert.equal(alt.grid, null);
    assert.equal(alt.cells, null);
    assert.deepEqual(alt.rects, w1.layout.rects.map((r) => [r.x, r.y, r.w, r.h]));
    assert.equal(alt.pyramid.video.template, 'layouts/flow/tiles/{z}/{x}/{y}.mp4');
    assert.equal(alt.pyramid.still.template, 'layouts/flow/stills/{z}/{x}/{y}.webp');
    assert.deepEqual(alt.pyramid.levels.map((l) => l.tiles), w1.tiles);
    assert.deepEqual(alt.content, { width: w1.pyramid.contentWidth, height: w1.pyramid.contentHeight });
    assert.equal(m.pyramid.still.template, PATHS.still);
    assert.deepEqual(m.videos.map((v) => v.rect.w), [384, 384], 'the main layout (a grid) is still on the videos');
  });
});

describe('docs/examples/scene.example.json', () => {
  it('is a valid scene', () => {
    const scene = JSON.parse(readFileSync(new URL('../../../docs/examples/scene.example.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateScene(scene), { valid: true, errors: [], warnings: [] });
    assert.doesNotThrow(() => resolveConfig(scene));
  });
});
