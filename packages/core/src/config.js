// Merges scene settings, CLI overrides and defaults into one resolved config.

import { parseRatio, parseSize } from './dims.js';

/** Defaults tuned for low-end phones (plan §8.2 and §10). */
export const DEFAULTS = Object.freeze({
  surface: { type: 'plane', arc: 360, latitudeBand: [-60, 60], view: 'inside' },
  preview: { duration: 10, fps: 24, startStrategy: 'auto', loopShort: true },
  layout: { cellAspect: '16:9', aspect: '16:9', fit: 'cover', groupBy: 'category', sortBy: ['title'], groupGap: 1, labels: true },
  output: {
    canvas: null,
    cell: null,
    tile: '768x432',
    tileCrf: 28,
    background: '#101318',
    stills: true,
    full: { enabled: true, maxHeight: 1080, crf: 23 },
  },
});

/** Default cell size when neither output.canvas nor output.cell is set. */
export const DEFAULT_CELL = '384x216';

/**
 * @typedef {object} ResolvedConfig
 * @property {string} title
 * @property {string} description
 * @property {{ type: 'plane'|'cylinder'|'sphere', arc: number, latitudeBand: number[], view: 'inside'|'outside' }} surface
 * @property {{ duration: number, fps: number, frames: number, startStrategy: 'auto'|'start', loopShort: boolean }} preview
 * @property {{ cellAspect: number, aspect: number, fit: 'cover'|'contain', groupBy: string, sortBy: string[], groupGap: number, labels: boolean }} layout
 * @property {{ canvas: import('./dims.js').Size|null, cell: import('./dims.js').Size|null, tile: import('./dims.js').Size,
 *   tileCrf: number, background: string, stills: boolean, full: { enabled: boolean, maxHeight: number, crf: number } }} output
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

  if (output.canvas && output.cell) {
    // A CLI override of one wins over the scene's other.
    if (overrides?.output?.cell && !overrides?.output?.canvas) output.canvas = null;
    else if (overrides?.output?.canvas && !overrides?.output?.cell) output.cell = null;
    else throw new Error('output.canvas and output.cell are alternatives; set only one');
  }
  if (!output.canvas && !output.cell) output.cell = DEFAULT_CELL;

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
      aspect: parseRatio(layout.aspect, 'layout.aspect'),
    },
    output: {
      ...output,
      canvas: output.canvas ? parseSize(output.canvas, 'output.canvas') : null,
      cell: output.cell ? parseSize(output.cell, 'output.cell') : null,
      tile: parseSize(output.tile, 'output.tile'),
    },
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
