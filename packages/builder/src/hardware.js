// Hardware H.264 encoding (plan §5.2).
//
// Detection: `ffmpeg -encoders` only says what the build supports. A listed
// encoder may still have no device or driver behind it, so each candidate runs
// a short test encode with both the cache-master and the final-tile settings,
// and the final-tile output is checked with ffprobe against the browser
// contract (Main profile). Results are cached per ffmpeg binary
// and version; `vmap doctor` re-runs the detection.
//
// Running: a hardware job holds one or more encode sessions from a separate
// pool (consumer GPUs limit concurrent sessions) as well as a CPU slot. A
// failed hardware job is retried with libx264; after three failures in a row,
// hardware is turned off for the rest of the build.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HW_ENCODERS, masterEncode, tileEncode } from './encode.js';

/** Detection order: the first working encoder wins in "auto". */
export const HW_ORDER = /** @type {const} */ (['nvenc', 'qsv', 'amf', 'videotoolbox', 'vaapi']);
const CACHE_DAYS = 7;
const TEST_TIMEOUT = 20_000;
const MAX_STREAK = 3;

/**
 * @typedef {object} EncoderStatus
 * @property {import('./encode.js').H264Encoder} name
 * @property {string} label
 * @property {string} codec    ffmpeg encoder name
 * @property {boolean} listed  in this ffmpeg build
 * @property {boolean} works   passed the test encode
 * @property {string} [error]  why it didn't
 */

/**
 * @typedef {object} HardwareReport
 * @property {string} ffmpeg
 * @property {string} version
 * @property {number} checkedAt  ms since the epoch
 * @property {EncoderStatus[]} encoders  in detection order
 */

/** Where detection results are cached. */
export function hardwareCacheFile() {
  if (process.env.VMAP_HW_CACHE) return path.resolve(process.env.VMAP_HW_CACHE);
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'videomap', 'hardware.json');
}

/**
 * Find the hardware encoders that work with this ffmpeg.
 * @param {import('./ffmpeg.js').Tools} tools
 * @param {{ version: string, hwListed: string[] }} caps  from detectCapabilities
 * @param {{ refresh?: boolean, cacheFile?: string|null }} [opts] cacheFile null disables the cache
 * @returns {Promise<HardwareReport>}
 */
export async function detectHardware(tools, caps, { refresh = false, cacheFile = hardwareCacheFile() } = {}) {
  const key = `${tools.ffmpeg}|${caps.version}`;
  const cache = cacheFile ? await readJson(cacheFile) : {};
  const hit = cache[key];
  const fresh = hit && Date.now() - hit.checkedAt < CACHE_DAYS * 86_400_000
    && HW_ORDER.every((n) => hit.encoders.some((e) => e.name === n && e.listed === caps.hwListed.includes(n)));
  if (fresh && !refresh) return hit;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-hw-'));
  try {
    /** @type {EncoderStatus[]} */
    const encoders = [];
    for (const name of HW_ORDER) {
      const spec = HW_ENCODERS[name];
      const status = { name, label: spec.label, codec: spec.codec, listed: caps.hwListed.includes(name), works: false };
      if (status.listed) {
        const error = await testEncoder(tools, name, dir);
        if (error) status.error = error;
        else status.works = true;
      }
      encoders.push(status);
    }
    const report = { ffmpeg: tools.ffmpeg, version: caps.version, checkedAt: Date.now(), encoders };
    if (cacheFile) {
      cache[key] = report;
      await writeJson(cacheFile, cache).catch(() => {});
    }
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Test-encode a short clip with the encoder's master and final-tile settings.
 * @returns {Promise<string|null>} null when it works, else the reason
 */
async function testEncoder(tools, name, dir) {
  const size = { w: 320, h: 240 };
  const fps = 24;
  const src = ['-f', 'lavfi', '-i', `testsrc2=s=${size.w}x${size.h}:r=${fps}:d=1`];
  const out = path.join(dir, `${name}.mp4`);
  const final = tileEncode({ tile: size, fps, crf: 28, level: '3.0', encoder: name });
  const master = masterEncode(name, { fps, size });
  const vf = (e) => ['-vf', ['format=yuv420p', e.filter].filter(Boolean).join(',')];
  const ffmpeg = (args) => exec(tools.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args]);
  try {
    await ffmpeg([...(final.init ?? []), ...src, ...vf(final), ...final.args, '-frames:v', '12', out]);
    await ffmpeg([...(master.init ?? []), ...src, ...vf(master), ...master.args, '-frames:v', '12', '-f', 'null', '-']);
  } catch (err) {
    return lastLine(err.message);
  }
  const info = await exec(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=profile', '-of', 'json', out])
    .then((o) => JSON.parse(o).streams?.[0], () => null);
  if (!info) return 'the test output could not be read';
  if (info.profile !== 'Main' && info.profile !== 'Constrained Baseline') return `produced ${info.profile} profile instead of Main`;
  return null;
}

/**
 * Pick the encoder for a build.
 * @param {import('@videomap/core').HardwareSetting} setting
 * @param {HardwareReport|null} report  null when detection was skipped ("off")
 * @returns {{ encoder: import('./encode.js').H264Encoder|null, warning: string|null }}
 */
export function chooseEncoder(setting, report) {
  if (setting === 'off' || !report) return { encoder: null, warning: null };
  if (setting === 'auto') return { encoder: report.encoders.find((e) => e.works)?.name ?? null, warning: null };
  const e = report.encoders.find((s) => s.name === setting);
  if (e?.works) return { encoder: e.name, warning: null };
  const why = !e?.listed ? `isn't in this ffmpeg build (${report.version})` : `failed its test encode (${e.error})`;
  return { encoder: null, warning: `Hardware encoder "${setting}" ${why}; encoding with libx264 instead.` };
}

/**
 * Runs H.264 jobs on the hardware encoder while it is active, with libx264 as the fallback.
 * @param {object} o
 * @param {import('./encode.js').H264Encoder|null} o.encoder
 * @param {number} o.sessions  concurrent hardware encode sessions
 * @param {<T>(fn: () => Promise<T>) => Promise<T>} o.limit  the CPU job pool
 * @param {(msg: string) => void} o.warn
 * @param {() => boolean} o.aborted
 */
export function createEncoderRunner({ encoder, sessions, limit, warn, aborted }) {
  const acquire = createSemaphore(Math.max(1, sessions));
  let active = Boolean(encoder);
  let streak = 0;
  const runner = {
    /** The encoder a job starting now should use for hardware-eligible encodes. */
    get current() {
      return active ? encoder : 'libx264';
    },
    jobs: 0,
    fallbacks: 0,
    disabled: false,
    /**
     * @param {number} weight  hardware sessions the job opens (0 = none; runs on the CPU pool only)
     * @param {string} what   for warnings, e.g. "clip reef-01"
     * @param {(encoder: import('./encode.js').H264Encoder) => Promise<void>} job
     */
    async run(weight, what, job) {
      if (!active || weight === 0 || !encoder) return limit(() => job('libx264'));
      const err = await acquire(weight, () => limit(() => job(encoder).then(() => null, (e) => e)));
      runner.jobs++;
      if (!err) {
        streak = 0;
        return undefined;
      }
      if (aborted()) throw err;
      runner.fallbacks++;
      streak++;
      if (runner.fallbacks <= 3) warn(`Hardware encode failed for ${what}; re-encoded with libx264. ${lastLine(err.message)}`);
      if (streak >= MAX_STREAK && active) {
        active = false;
        runner.disabled = true;
        warn(`Hardware encoding was turned off for the rest of the build after ${MAX_STREAK} failures in a row.`);
      }
      return limit(() => job('libx264'));
    },
  };
  return runner;
}

/**
 * FIFO semaphore whose jobs take `weight` permits (capped at the total).
 * @param {number} total
 */
export function createSemaphore(total) {
  let free = total;
  /** @type {Array<{ weight: number, go: () => void }>} */
  const queue = [];
  const pump = () => {
    while (queue.length && queue[0].weight <= free) {
      const next = queue.shift();
      free -= next.weight;
      next.go();
    }
  };
  /**
   * @template T
   * @param {number} weight
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  return function acquire(weight, fn) {
    const w = Math.min(Math.max(1, weight), total);
    return new Promise((resolve, reject) => {
      queue.push({
        weight: w,
        go: () => {
          fn().then(resolve, reject).finally(() => {
            free += w;
            pump();
          });
        },
      });
      pump();
    });
  };
}

function exec(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), TEST_TIMEOUT);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(signal ? 'timed out' : err.trim() || `exit code ${code}`));
    });
  });
}

/** The most telling line of an ffmpeg error: the last one that isn't a generic wrap-up. */
function lastLine(s) {
  const generic = /^(Error initializing output stream|Error while (opening|processing)|Conversion failed|\S+ exited with code|Error opening output)/;
  const lines = String(s).trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.filter((l) => !generic.test(l)).pop() ?? lines.pop() ?? '';
  return line.replace(/^\[[^\]]+\]\s*/, '').slice(0, 200);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}
