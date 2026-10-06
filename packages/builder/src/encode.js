// ffmpeg argument builders. Pure functions, so they can be unit-tested and
// inspected with --dry-run without running ffmpeg.

/** @typedef {import('./probe.js').ProbeInfo} ProbeInfo */
/** @typedef {import('@videomap/core').Size} Size */

export const ENCODER_VERSION = 1; // bump to invalidate cached intermediates

const HDR_TO_SDR = [
  'zscale=t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=hable:desat=0',
  'zscale=t=bt709:m=bt709:r=tv',
  'format=yuv420p',
];

/** ffmpeg color syntax: "#101318" → "0x101318". */
export function ffColor(hex) {
  return hex.replace(/^#/, '0x');
}

/**
 * Where the preview loop starts in the source, and whether it has to loop.
 * @param {{ duration: number, previewStart?: number, strategy: 'auto'|'start', loopLength: number }} o
 * @returns {{ start: number, loop: boolean, adjusted: boolean }}
 */
export function previewWindow({ duration, previewStart, strategy, loopLength }) {
  if (duration <= loopLength) return { start: 0, loop: true, adjusted: Boolean(previewStart) };
  const latest = duration - loopLength;
  if (previewStart !== undefined && previewStart !== null) {
    const start = Math.min(previewStart, latest);
    return { start: round3(start), loop: false, adjusted: start !== previewStart };
  }
  if (strategy === 'start') return { start: 0, loop: false, adjusted: false };
  return { start: round3(Math.min(duration * 0.1, latest)), loop: false, adjusted: false };
}

/** Filters that undo non-square pixels and (optionally) tone-map HDR to SDR. */
function sourceFilters(probe, toneMap) {
  const vf = [];
  if (Math.abs(probe.sar - 1) > 0.01) vf.push('scale=trunc(iw*sar/2)*2:ih', 'setsar=1');
  if (probe.hdr && toneMap) vf.push(...HDR_TO_SDR);
  return vf;
}

/**
 * Normalize one source into a preview clip: cell-sized, constant fps, exactly `frames` frames.
 * @param {object} o
 * @param {string} o.src
 * @param {ProbeInfo} o.probe
 * @param {{ start: number, loop: boolean }} o.window
 * @param {boolean} o.loopShort  false holds the last frame instead of looping
 * @param {number} o.fps
 * @param {number} o.frames
 * @param {Size} o.cell
 * @param {'cover'|'contain'} o.fit
 * @param {string} o.background
 * @param {boolean} o.toneMap
 * @param {string} out
 */
export function clipArgs(o, out) {
  const { w, h } = o.cell;
  const vf = sourceFilters(o.probe, o.toneMap);
  vf.push(`fps=${o.fps}`);
  if (o.fit === 'contain') {
    vf.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`);
    vf.push(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${ffColor(o.background)}`);
  } else {
    vf.push(`scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bicubic`, `crop=${w}:${h}`);
  }
  // Padding with the last frame guarantees the exact frame count even if the source ends early.
  vf.push('setsar=1', 'format=yuv420p', 'tpad=stop_mode=clone:stop=-1');

  const loop = o.window.loop && o.loopShort;
  return [
    ...(o.window.start > 0 ? ['-ss', String(o.window.start)] : []),
    ...(loop ? ['-stream_loop', '-1'] : []),
    '-i', o.src,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', vf.join(','),
    '-frames:v', String(o.frames),
    ...masterEncode(o.fps),
    out,
  ];
}

/** High-quality intermediate encode for clips and tile masters. */
function masterEncode(fps) {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', String(fps), '-pix_fmt', 'yuv420p'];
}

/**
 * Final tile encode: what browsers decode (plan §5 step 7).
 * @param {{ tile: Size, fps: number, crf: number, level: string }} o
 */
export function tileEncode(o) {
  const bps = Math.round(o.tile.w * o.tile.h * o.fps * 0.12);
  return [
    '-c:v', 'libx264', '-profile:v', 'main', '-level:v', o.level, '-pix_fmt', 'yuv420p',
    '-preset', 'medium', '-crf', String(o.crf),
    '-maxrate', `${Math.round(bps / 1000)}k`, '-bufsize', `${Math.round((bps * 2) / 1000)}k`,
    '-g', String(o.fps), '-keyint_min', String(o.fps), '-sc_threshold', '0',
    '-tune', 'fastdecode', '-movflags', '+faststart', '-an',
  ];
}

/**
 * Filter graph that places inputs at pixel offsets on a `size` canvas, labelled [t].
 * @param {Array<{ x: number, y: number }>} positions one per input, in input order
 * @param {Size} size
 * @param {string} background
 */
export function stackGraph(positions, size, background) {
  const bg = ffColor(background);
  if (positions.length === 1) {
    const [p] = positions;
    return `[0:v]pad=${size.w}:${size.h}:${p.x}:${p.y}:color=${bg}[t]`;
  }
  const ins = positions.map((_, i) => `[${i}:v]`).join('');
  const layout = positions.map((p) => `${p.x}_${p.y}`).join('|');
  return `${ins}xstack=inputs=${positions.length}:layout=${layout}:fill=${bg}[s];[s]pad=${size.w}:${size.h}:0:0:color=${bg}[t]`;
}

/**
 * One ffmpeg run that composites a tile and writes up to three outputs:
 * the cached high-quality master, the final tile and the still.
 * @param {object} o
 * @param {string[]} o.inputs input files
 * @param {string} o.graph filter graph ending in [t] at final tile size
 * @param {number} o.fps
 * @param {number} o.frames
 * @param {string[]} o.finalEncode from tileEncode()
 * @param {{ master?: string, final: string, still?: string }} outs
 */
export function tileArgs(o, outs) {
  const targets = [];
  if (outs.master) targets.push([...masterEncode(o.fps), '-an', '-frames:v', String(o.frames), outs.master]);
  targets.push([...o.finalEncode, '-frames:v', String(o.frames), outs.final]);
  if (outs.still) targets.push(['-frames:v', '1', ...stillEncode(), outs.still]);

  const labels = targets.map((_, i) => `[o${i}]`);
  const graph = `${o.graph};[t]split=${targets.length}${labels.join('')}`;
  const args = o.inputs.flatMap((f) => ['-i', f]);
  args.push('-filter_complex', graph);
  targets.forEach((t, i) => args.push('-map', labels[i], ...t));
  return args;
}

/**
 * Graph for a parent tile: up to four child masters stacked 2×2, then halved.
 * @param {Array<{ dx: number, dy: number }>} children in input order
 * @param {Size} tile
 * @param {string} background
 */
export function parentGraph(children, tile, background) {
  const positions = children.map((c) => ({ x: c.dx * tile.w, y: c.dy * tile.h }));
  const doubled = stackGraph(positions, { w: tile.w * 2, h: tile.h * 2 }, background).replace(/\[t\]$/, '[d]');
  return `${doubled};[d]scale=${tile.w}:${tile.h}:flags=area,setsar=1[t]`;
}

function stillEncode() {
  return ['-c:v', 'libwebp', '-quality', '75', '-compression_level', '4'];
}

/**
 * Can the source be served as-is (remuxed) as the full rendition?
 * @param {ProbeInfo} p
 * @param {number} maxHeight
 */
export function isWebCompatible(p, maxHeight) {
  return p.videoCodec === 'h264'
    && (p.pixFmt === 'yuv420p' || p.pixFmt === 'yuvj420p')
    && p.height <= maxHeight
    && (p.audioCodec === null || p.audioCodec === 'aac')
    && /mp4|mov/.test(p.container)
    && p.rotation === 0
    && Math.abs(p.sar - 1) <= 0.01
    && !p.hdr;
}

/**
 * Full-resolution rendition for the floating player.
 * @param {{ src: string, probe: ProbeInfo, maxHeight: number, crf: number, toneMap: boolean }} o
 * @param {string} out
 */
export function fullArgs(o, out) {
  const common = ['-i', o.src, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  if (isWebCompatible(o.probe, o.maxHeight)) {
    return [...common, '-c', 'copy', '-movflags', '+faststart', out];
  }
  const vf = sourceFilters(o.probe, o.toneMap);
  vf.push(`scale=-2:'min(${o.maxHeight},trunc(ih/2)*2)':flags=bicubic`, 'format=yuv420p');
  return [
    ...common,
    '-vf', vf.join(','),
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', String(o.crf),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    out,
  ];
}

/**
 * Poster image, at most 640 px wide.
 * @param {{ src: string, probe?: ProbeInfo|null, time: number, webp: boolean, toneMap: boolean }} o
 * @param {string} out
 */
export function posterArgs(o, out) {
  const vf = o.probe ? sourceFilters(o.probe, o.toneMap) : [];
  vf.push(`scale='min(640,iw)':-2:flags=bicubic`);
  return [
    ...(o.time > 0 ? ['-ss', String(o.time)] : []),
    '-i', o.src,
    '-frames:v', '1',
    '-vf', vf.join(','),
    ...(o.webp ? ['-c:v', 'libwebp', '-quality', '80'] : ['-q:v', '4']),
    out,
  ];
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
