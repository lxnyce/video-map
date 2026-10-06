// Build settings for this computer: they describe the machine (its GPU and
// CPUs), not the scene, so they're kept in the data folder, not in projects.
// They override a scene's `build` section, like CLI flags.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HW_ORDER } from '@videomap/builder';

export const DEFAULT_SETTINGS = Object.freeze({
  hardware: 'auto',
  hardwareFinal: false,
  hardwareJobs: 3,
  /** Parallel ffmpeg processes; null uses the builder's default (half the CPUs). */
  jobs: null,
  /** false deletes cached clips and tile masters after each successful build. */
  keepCache: true,
});

/** @typedef {{ hardware: string, hardwareFinal: boolean, hardwareJobs: number, jobs: number|null, keepCache: boolean }} Settings */

/**
 * Check a settings update. Unknown keys and bad values are reported, not dropped.
 * @param {any} input
 * @returns {{ settings?: Partial<Settings>, errors: string[] }}
 */
export function checkSettings(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['Settings must be an object.'] };
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'hardware':
        if (!['auto', 'off', ...HW_ORDER].includes(value)) errors.push(`hardware must be auto, off or one of ${HW_ORDER.join(', ')}.`);
        else out.hardware = value;
        break;
      case 'hardwareFinal':
      case 'keepCache':
        if (typeof value !== 'boolean') errors.push(`${key} must be true or false.`);
        else out[key] = value;
        break;
      case 'hardwareJobs':
        if (!Number.isInteger(value) || value < 1 || value > 32) errors.push('hardwareJobs must be a whole number from 1 to 32.');
        else out.hardwareJobs = value;
        break;
      case 'jobs':
        if (value !== null && (!Number.isInteger(value) || value < 1 || value > 256)) errors.push('jobs must be empty (automatic) or a whole number from 1 to 256.');
        else out.jobs = value;
        break;
      default:
        errors.push(`Unknown setting "${key}".`);
    }
  }
  return { settings: out, errors };
}

export class SettingsStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    /** @type {Settings} */
    this.value = { ...DEFAULT_SETTINGS };
  }

  async load() {
    const stored = await readFile(this.file, 'utf8').then(JSON.parse, () => ({}));
    const { settings } = checkSettings(stored);
    this.value = { ...DEFAULT_SETTINGS, ...settings };
    return this.value;
  }

  /** @param {Partial<Settings>} update already checked */
  async save(update) {
    this.value = { ...this.value, ...update };
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(this.value, null, 2)}\n`);
    await rename(tmp, this.file);
    return this.value;
  }
}
