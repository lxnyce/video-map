import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULTS, resolveConfig } from '../src/config.js';
import { parseRatio, parseSize } from '../src/dims.js';
import { createRuntimeManifest, fillTemplate } from '../src/manifest.js';
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
  it('attaches cells to videos and tile lists to levels', () => {
    const config = resolveConfig({ title: 'T', videos: [] });
    const pyramid = { cell: { w: 2, h: 2 }, k: { x: 1, y: 1 }, tile: { w: 2, h: 2 }, cols: 2, rows: 1, maxZoom: 1, contentWidth: 4, contentHeight: 2,
      levels: [{ z: 0, tilesX: 1, tilesY: 1, cellsPerTile: { x: 2, y: 2 }, scale: 0.5 }, { z: 1, tilesX: 2, tilesY: 1, cellsPerTile: { x: 1, y: 1 }, scale: 1 }] };
    const layout = { cols: 2, rows: 1, cells: [{ video: 0, col: 1, row: 0 }, { video: 1, col: 0, row: 0 }], groups: [] };
    const m = createRuntimeManifest({ config, pyramid, layout, videos: /** @type {any} */ ([{ id: 'a' }, { id: 'b' }]), tiles: [[[0, 0]], [[0, 0], [1, 0]]], tileMime: 'video/mp4' });
    assert.equal(m.format, 'videomap-scene');
    assert.deepEqual(m.videos.map((v) => v.cell), [{ col: 1, row: 0 }, { col: 0, row: 0 }]);
    assert.deepEqual(m.pyramid.levels[1].tiles, [[0, 0], [1, 0]]);
    assert.equal(fillTemplate(m.pyramid.video.template, { z: 1, x: 0, y: 2 }), 'tiles/1/0/2.mp4');
  });
});

describe('docs/examples/scene.example.json', () => {
  it('is a valid scene', () => {
    const scene = JSON.parse(readFileSync(new URL('../../../docs/examples/scene.example.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateScene(scene), { valid: true, errors: [], warnings: [] });
    assert.doesNotThrow(() => resolveConfig(scene));
  });
});
