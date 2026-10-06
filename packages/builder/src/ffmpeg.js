// Thin wrapper around the ffmpeg and ffprobe binaries.

import { spawn } from 'node:child_process';

/**
 * @typedef {object} Tools
 * @property {string} ffmpeg
 * @property {string} ffprobe
 * @property {(args: string[]) => Promise<void>} run       run ffmpeg
 * @property {(args: string[]) => Promise<string>} probeRaw run ffprobe, return stdout
 * @property {() => void} abort  kill every running process
 */

/**
 * @param {{ ffmpeg?: string, ffprobe?: string }} [opts]
 * @returns {Tools}
 */
export function createTools(opts = {}) {
  const ffmpeg = opts.ffmpeg || process.env.FFMPEG || 'ffmpeg';
  const ffprobe = opts.ffprobe || process.env.FFPROBE || 'ffprobe';
  const running = new Set();
  let aborted = false;

  function exec(bin, args, captureStdout) {
    return new Promise((resolve, reject) => {
      if (aborted) return reject(new Error('Aborted'));
      const proc = spawn(bin, args, { stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] });
      running.add(proc);
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      });
      proc.on('error', (err) => {
        running.delete(proc);
        const e = /** @type {NodeJS.ErrnoException} */ (err);
        reject(e.code === 'ENOENT' ? new Error(`"${bin}" was not found. Install ffmpeg or pass --ffmpeg/--ffprobe.`) : err);
      });
      proc.on('close', (code, signal) => {
        running.delete(proc);
        if (code === 0) return resolve(stdout);
        const tail = stderr.trim().split('\n').slice(-8).join('\n');
        const err = new Error(`${bin} ${signal ? `was killed (${signal})` : `exited with code ${code}`}${tail ? `:\n${tail}` : ''}`);
        Object.assign(err, { command: [bin, ...args].map(quote).join(' ') });
        reject(err);
      });
    });
  }

  return {
    ffmpeg,
    ffprobe,
    run: (args) => exec(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], false).then(() => {}),
    probeRaw: (args) => exec(ffprobe, ['-v', 'error', ...args], true),
    abort() {
      aborted = true;
      for (const p of running) p.kill('SIGTERM');
    },
  };
}

/**
 * Check what the installed ffmpeg supports.
 * @param {Tools} tools
 */
export async function detectCapabilities(tools) {
  const [versionOut, encoders, filters, xstackHelp] = await Promise.all([
    capture(tools.ffmpeg, ['-hide_banner', '-version']),
    capture(tools.ffmpeg, ['-hide_banner', '-encoders']),
    capture(tools.ffmpeg, ['-hide_banner', '-filters']),
    capture(tools.ffmpeg, ['-hide_banner', '-h', 'filter=xstack']),
  ]);
  await capture(tools.ffprobe, ['-version']);
  const has = (list, name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(list);
  return {
    version: /ffmpeg version (\S+)/.exec(versionOut)?.[1] ?? 'unknown',
    libx264: has(encoders, 'libx264'),
    libwebp: has(encoders, 'libwebp'),
    aac: has(encoders, 'aac'),
    xstack: has(filters, 'xstack'),
    xstackFill: /\bfill\b/.test(xstackHelp),
    zscale: has(filters, 'zscale'),
    tonemap: has(filters, 'tonemap'),
  };
}

/** @typedef {Awaited<ReturnType<typeof detectCapabilities>>} Capabilities */

/**
 * Throw a helpful error when a required feature is missing.
 * @param {Capabilities} caps
 * @param {{ stills: boolean, full: boolean }} needs
 */
export function assertCapabilities(caps, needs) {
  const missing = [];
  if (!caps.libx264) missing.push('the libx264 encoder');
  if (!caps.xstack || !caps.xstackFill) missing.push('the xstack filter with "fill" (ffmpeg 5.1 or newer)');
  if (needs.stills && !caps.libwebp) missing.push('the libwebp encoder (or build with --no-stills)');
  if (needs.full && !caps.aac) missing.push('the aac encoder');
  if (missing.length) {
    throw new Error(`ffmpeg ${caps.version} is missing ${missing.join(', ')}. Install a full ffmpeg build (e.g. from ffmpeg.org or your package manager).`);
  }
}

function capture(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', (err) => {
      const e = /** @type {NodeJS.ErrnoException} */ (err);
      reject(e.code === 'ENOENT' ? new Error(`"${bin}" was not found. Install ffmpeg or pass --ffmpeg/--ffprobe.`) : err);
    });
    proc.on('close', () => resolve(out));
  });
}

function quote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
