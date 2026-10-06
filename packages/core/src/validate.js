// Scene validation: JSON Schema plus checks a schema can't express.

import Ajv2020 from 'ajv/dist/2020.js';
import { sceneSchema } from './schema.js';

/**
 * @typedef {{ path: string, message: string }} Issue
 * @typedef {{ valid: boolean, errors: Issue[], warnings: Issue[] }} ValidationResult
 */

let compiled;
function schemaValidator() {
  if (!compiled) {
    // @ts-ignore -- ajv's CJS default export
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    compiled = ajv.compile(sceneSchema);
  }
  return compiled;
}

/**
 * Validate a parsed scene.json.
 * @param {any} scene
 * @returns {ValidationResult}
 */
export function validateScene(scene) {
  const validate = schemaValidator();
  /** @type {Issue[]} */
  const errors = [];
  /** @type {Issue[]} */
  const warnings = [];

  if (!validate(scene)) {
    for (const e of validate.errors ?? []) {
      // anyOf failures repeat their branch errors; the branches are reported on their own.
      if (e.keyword === 'anyOf') continue;
      let message = e.message ?? 'is invalid';
      if (e.keyword === 'additionalProperties') message = `has unknown property "${e.params.additionalProperty}"`;
      else if (e.keyword === 'enum') message = `must be one of ${e.params.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
      else if (e.keyword === 'pattern') message = describePattern(e.instancePath, message);
      errors.push({ path: toPath(e.instancePath), message });
    }
    return { valid: false, errors: dedupe(errors), warnings };
  }

  const videos = scene.videos;
  const seen = new Map();
  videos.forEach((v, i) => {
    if (v.id === undefined) return;
    if (seen.has(v.id)) errors.push({ path: `videos[${i}].id`, message: `duplicates videos[${seen.get(v.id)}].id "${v.id}"` });
    else seen.set(v.id, i);
  });

  const catIds = new Set((scene.categories ?? []).map((c) => c.id));
  if (catIds.size !== (scene.categories ?? []).length) {
    errors.push({ path: 'categories', message: 'contains duplicate ids' });
  }
  if (scene.categories?.length) {
    videos.forEach((v, i) => {
      (v.categories ?? []).forEach((c, j) => {
        if (!catIds.has(c)) warnings.push({ path: `videos[${i}].categories[${j}]`, message: `"${c}" is not listed in categories` });
      });
    });
  }

  if (scene.output?.canvas && scene.output?.cell) {
    errors.push({ path: 'output', message: 'set either canvas or cell, not both' });
  }
  for (const key of ['canvas', 'cell', 'tile']) {
    const value = scene.output?.[key];
    if (typeof value === 'string') {
      const [w, h] = value.toLowerCase().split('x').map(Number);
      if (w % 2 || h % 2) warnings.push({ path: `output.${key}`, message: `${value} has an odd dimension; it will be rounded down to even` });
    }
  }
  const band = scene.surface?.latitudeBand;
  if (band && band[0] >= band[1]) errors.push({ path: 'surface.latitudeBand', message: 'south limit must be below the north limit' });

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Give every video an id: keep explicit ids, derive the rest from the file name.
 * @param {Array<{ id?: string, src: string }>} videos
 * @returns {string[]}
 */
export function assignIds(videos) {
  const taken = new Set(videos.map((v) => v.id).filter(Boolean));
  return videos.map((v) => {
    if (v.id) return v.id;
    const base = slugify(v.src.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '') || 'video';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  });
}

/** @param {string} s */
export function slugify(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function toPath(instancePath) {
  if (!instancePath) return '(root)';
  return instancePath
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), '');
}

function describePattern(instancePath, fallback) {
  const field = instancePath.split('/').pop();
  if (['canvas', 'cell', 'tile'].includes(field)) return 'must look like WIDTHxHEIGHT, e.g. 768x432';
  if (['cellAspect', 'aspect'].includes(field)) return 'must look like W:H, e.g. 16:9';
  if (field === 'id') return 'must start with a letter or digit and use only letters, digits, ".", "_" and "-"';
  if (field === 'groupBy') return 'must be "none", "category", "tag:<prefix>" or "meta.<key>"';
  if (field === 'background' || field === 'color') return 'must be a hex color like #101318';
  if (/^\d+$/.test(field) && instancePath.includes('/sortBy/')) return 'must be id, title, duration, category, src or meta.<key>, optionally prefixed with "-"';
  return fallback;
}

function dedupe(issues) {
  const seen = new Set();
  return issues.filter((i) => {
    const key = `${i.path}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
