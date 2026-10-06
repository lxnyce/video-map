// The Studio's scene editing helpers (pure, shared with the browser UI).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addUpload,
  bulkEdit,
  metadataKeys,
  matchesQuery,
  nextCategoryColor,
  parseIssuePath,
  parseMetaValue,
  planScene,
  removeCategory,
  renameCategory,
  setPath,
  validateDraft,
} from '../src/web/scene.js';

describe('studio scene helpers', () => {
  it('sets and clears nested fields, dropping emptied parents', () => {
    const s = { layout: { pack: 'masonry' } };
    setPath(s, ['output', 'full', 'enabled'], false);
    assert.deepEqual(s.output, { full: { enabled: false } });
    setPath(s, ['output', 'full', 'enabled'], undefined);
    assert.equal(s.output, undefined, 'cleared field falls back to the default');
    setPath(s, ['layout', 'pack'], '');
    assert.equal(s.layout, undefined);
    setPath(s, ['videos', 0, 'title'], 'x');
    assert.deepEqual(s.videos, [{ title: 'x' }]);
  });

  it('allows an empty video list while editing, and nothing else invalid', () => {
    assert.equal(validateDraft({ title: 'New', videos: [] }).valid, true);
    assert.equal(validateDraft({ videos: [], layout: { pack: 'spiral' } }).valid, false);
    assert.equal(validateDraft({ videos: [{ src: 'a.mp4', id: 'x' }, { src: 'b.mp4', id: 'x' }] }).valid, false);
  });

  it('adds uploads with unique ids, and fills in missing files of the same name', () => {
    const scene = { videos: [{ src: 'clips/reef.mp4', title: 'Reef' }, { id: 'coral', src: 'media/coral.mp4' }] };
    const missing = new Set(['clips/reef.mp4']);
    assert.deepEqual(addUpload(scene, 'media/Reef.mp4', 'Reef.mp4', (src) => missing.has(src)), { index: 0, relinked: true });
    assert.equal(scene.videos[0].src, 'media/Reef.mp4');
    assert.equal(scene.videos[0].title, 'Reef', 'keeps its details');
    addUpload(scene, 'media/coral-2.mp4', 'coral.mp4', () => false);
    assert.deepEqual(scene.videos[2], { id: 'coral-2', src: 'media/coral-2.mp4', title: 'Coral' });
    addUpload(scene, 'media/sea_turtle.mov', 'sea_turtle.mov', () => false);
    assert.deepEqual(scene.videos[3], { id: 'sea-turtle', src: 'media/sea_turtle.mov', title: 'Sea turtle' });
    assert.deepEqual(addUpload(scene, 'media/sea_turtle.mov', 'sea_turtle.mov', () => false), { index: 3, relinked: false }, 'no duplicates');
    assert.equal(scene.videos.length, 4);
    assert.equal(validateDraft(scene).valid, true);
  });

  it('applies bulk edits and keeps categories consistent', () => {
    const scene = {
      categories: [{ id: 'a' }, { id: 'b' }],
      videos: [{ src: '1', categories: ['a'] }, { src: '2', tags: ['x'] }, { src: '3', categories: ['b'], tags: ['x', 'y'] }],
    };
    bulkEdit(scene, [0, 1], { type: 'addCategory', value: 'b' });
    assert.deepEqual(scene.videos.map((v) => v.categories), [['a', 'b'], ['b'], ['b']]);
    bulkEdit(scene, [1, 2], { type: 'addTags', value: ['x', 'z'] });
    assert.deepEqual(scene.videos[2].tags, ['x', 'y', 'z']);
    bulkEdit(scene, [0, 1, 2], { type: 'removeTag', value: 'x' });
    assert.equal(scene.videos[1].tags.join(), 'z');
    renameCategory(scene, 'a', 'b');
    assert.deepEqual(scene.videos[0].categories, ['b'], 'merging into an existing id leaves no duplicates');
    removeCategory(scene, 'b');
    assert.equal(scene.videos.some((v) => v.categories), false);
    assert.equal(scene.categories, undefined, 'the last category removed takes the list with it');
  });

  it('searches, offers group keys and types meta values', () => {
    const v = { id: 'reef-01', title: 'Récif corallien', tags: ['place:Bali'], categories: ['ocean'] };
    assert.ok(matchesQuery(v, 'recif bali'));
    assert.ok(!matchesQuery(v, 'recif kyoto'));
    assert.deepEqual(metadataKeys({ videos: [v, { src: 'x', meta: { year: 2001, camera: 'A' } }] }), { tagPrefixes: ['place'], metaKeys: ['camera', 'year'] });
    assert.equal(parseMetaValue('1999'), 1999);
    assert.equal(parseMetaValue('true'), true);
    assert.equal(parseMetaValue('01234 x'), '01234 x');
    assert.deepEqual(parseIssuePath('videos[3].credits.url'), ['videos', 3, 'credits', 'url']);
    assert.deepEqual(parseIssuePath('(root)'), []);
    assert.notEqual(nextCategoryColor([]), nextCategoryColor([{ color: nextCategoryColor([]) }]));
  });

  it('plans every arrangement and the size estimate from the probes so far', () => {
    const probe = (w, h, d) => ({ probe: { width: w, height: h, duration: d, fps: 25, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: null, container: 'mov,mp4', rotation: 0, sar: 1, hdr: false } });
    const scene = {
      categories: [{ id: 'a', label: 'Alpha' }],
      layout: { pack: 'masonry', columnWidth: 128 },
      layouts: [{ id: 'flat', pack: 'grid', groupBy: 'none' }],
      videos: [
        { src: 'w.mp4', categories: ['a'] },
        { src: 't.mp4', categories: ['a'] },
        { src: 'n.mp4' },
      ],
    };
    const probes = { 'w.mp4': probe(320, 180, 4), 't.mp4': probe(180, 320, 3) };
    const plan = planScene(scene, probes);
    assert.equal(plan.error, null);
    assert.equal(plan.unknown, 1, 'n.mp4 is not probed yet');
    assert.deepEqual(plan.walls.map((w) => [w.id, w.layout.pack]), [['default', 'masonry'], ['flat', 'grid']]);
    const [main] = plan.walls;
    assert.equal(main.layout.rects[1].h, 228, 'a portrait video keeps its shape: 128 × 16/9, rounded to even');
    assert.ok(plan.estimate.total > 0 && plan.estimate.withMedia >= plan.estimate.withoutMedia);
    assert.equal(planScene({ ...scene, output: { canvas: '100x100', cell: '10x10' } }, probes).error, 'output.canvas and output.cell are alternatives; set only one');
    assert.deepEqual(planScene({ videos: [] }, {}).walls, []);
  });
});
