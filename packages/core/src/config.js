// Merges scene settings, CLI overrides and defaults into one resolved config.

import { parseRatio, parseSize } from './dims.js';
import { surfaceAspect } from './surface.js';

/**
 * Defaults tuned for low-end phones (plan §8.2 and §10). A few depend on
 * layout.pack and are filled in by resolveConfig: output.tile, output.cell,
 * layout.groupGap and layout.columnWidth.
 */
export const DEFAULTS = Object.freeze({
  surface: { type: 'plane', arc: 360, latitudeBand: [-60, 60], view: 'inside' },
  preview: { duration: 10, fps: 24, startStrategy: 'auto', loopShort: true },
  layout: {
    pack: 'grid',
    cellAspect: '16:9',
    aspect: '16:9',
    fit: 'contain',
    gap: 0,
    groupArrange: 'columns',
    avoidSplits: true,
    groupBy: 'category',
    sortBy: ['title'],
    labels: true,
  },
  output: {
    canvas: null,
    cell: null,
    tileCrf: 28,
    tileCodecs: ['h264'],
    background: '#101318',
    stills: true,
    full: { enabled: true, maxHeight: 1080, crf: 23 },
  },
  // Final tiles stay on libx264: measured faster overall (each tile run then needs one GPU session, not two) and smaller.
  build: { hardware: 'auto', hardwareFinal: false, hardwareJobs: 3 },
});

/** Default cell size (grid) when neither output.canvas nor output.cell is set. */
export const DEFAULT_CELL = '384x216';
/** Default column width (masonry) when output.canvas isn't set. */
export const DEFAULT_COLUMN_WIDTH = 384;
/** Default tile size per packing. Masonry tiles are taller so most videos fit in one tile (plan §5.1). */
export const DEFAULT_TILE = Object.freeze({ grid: '768x432', masonry: '768x1024' });

/** @typedef {'auto'|'off'|'nvenc'|'qsv'|'amf'|'videotoolbox'|'vaapi'} HardwareSetting */

/**
 * @typedef {object} ResolvedConfig
 * @property {string} title
 * @property {string} description
 * @property {{ type: 'plane'|'cylinder'|'sphere', arc: number, latitudeBand: number[], view: 'inside'|'outside' }} surface
 * @property {{ duration: number, fps: number, frames: number, startStrategy: 'auto'|'start', loopShort: boolean }} preview
 * @property {{ pack: 'grid'|'masonry', cellAspect: number, aspect: number, fit: 'cover'|'contain', columnWidth: number|null, gap: number,
 *   groupArrange: 'columns'|'bands', avoidSplits: boolean, groupBy: string, sortBy: string[], groupGap: number, labels: boolean }} layout
 *   columnWidth is null when it is derived from output.canvas
 * @property {{ canvas: import('./dims.js').Size|null, cell: import('./dims.js').Size|null, tile: import('./dims.js').Size,
 *   tileCrf: number, tileCodecs: Array<'h264'|'vp9'>, background: string, stills: boolean, full: { enabled: boolean, maxHeight: number, crf: number } }} output
 * @property {{ hardware: HardwareSetting, hardwareFinal: boolean, hardwareJobs: number }} build
 */

/**
 * Resolve the effective configuration. Precedence: overrides (CLI) > scene > defaults.
 * @param {any} scene parsed scene.json
 * @param {any} [overrides] same shape as the scene's settings sections
 * @returns {ResolvedConfig}
 */
export function resolveConfig(scene, overrides = {}) {
  const pick = (section) => merge(DEFAULTS[section], scene?.[section], overrides?.[section]);
  const surface = pick('surface');
  const preview = pick('preview');
  const layout = pick('layout');
  const output = pick('output');
  const build = pick('build');
  const masonry = layout.pack === 'masonry';

  if (output.canvas && output.cell) {
    // A CLI override of one wins over the scene's other.
    if (overrides?.output?.cell && !overrides?.output?.canvas) output.canvas = null;
    else if (overrides?.output?.canvas && !overrides?.output?.cell) output.cell = null;
    else throw new Error('output.canvas and output.cell are alternatives; set only one');
  }
  if (!output.canvas && !output.cell && !masonry) output.cell = DEFAULT_CELL;
  output.tile ??= DEFAULT_TILE[masonry ? 'masonry' : 'grid'];
  layout.groupGap ??= masonry ? 0 : 1;
  layout.columnWidth ??= output.canvas ? null : DEFAULT_COLUMN_WIDTH;
  // A curved surface shapes the wall to fill it (a 360° cylinder is about 4:1), unless the scene sets a shape.
  const aspectSet = scene?.layout?.aspect !== undefined || overrides?.layout?.aspect !== undefined;
  const aspect = aspectSet ? parseRatio(layout.aspect, 'layout.aspect') : surfaceAspect(surface) ?? parseRatio(layout.aspect, 'layout.aspect');

  const fps = preview.fps;
  const duration = preview.duration;
  const frames = Math.round(duration * fps);
  if (frames < 1) throw new Error('preview.duration × preview.fps must be at least one frame');

  return {
    title: scene?.title ?? 'Untitled scene',
    description: scene?.description ?? '',
    surface,
    preview: { ...preview, frames },
    layout: {
      ...layout,
      cellAspect: parseRatio(layout.cellAspect, 'layout.cellAspect'),
      aspect,
    },
    output: {
      ...output,
      canvas: output.canvas ? parseSize(output.canvas, 'output.canvas') : null,
      cell: output.cell ? parseSize(output.cell, 'output.cell') : null,
      tile: parseSize(output.tile, 'output.tile'),
    },
    build,
  };
}

/**
 * Deep-merge plain objects; later sources win, `undefined` is ignored, arrays are replaced.
 * @returns {any}
 */
function merge(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? merge(out[k], v) : clone(v);
    }
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) return merge(v);
  return v;
}
