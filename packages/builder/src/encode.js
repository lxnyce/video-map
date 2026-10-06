// ffmpeg argument builders. Pure functions, so they can be unit-tested and
// inspected with --dry-run without running ffmpeg.

/** @typedef {import('./probe.js').ProbeInfo} ProbeInfo */
/** @typedef {import('@videomap/core').Size} Size */

export const ENCODER_VERSION = 2; // bump to invalidate cached intermediates

const HDR_TO_SDR = [
  'zscale=t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=hable:desat=0',
  'zscale=t=bt709:m=bt709:r=tv',
  'format=yuv420p',
];

/**
 * One output's encoder settings.
 * @typedef {object} Encode
 * @property {string[]} args     output options: codec, rate control, GOP...
 * @property {string} [filter]   appended to this output's filter chain (e.g. upload to the GPU)
 * @property {string[]} [init]   global options that go before the inputs (e.g. a device)
 */

/** @typedef {'libx264'|'nvenc'|'qsv'|'amf'|'videotoolbox'|'vaapi'|string} H264Encoder */

/**
 * H.264 settings for one hardware encoder (plan §5.2), for three uses:
 *   master: high-quality intermediates in the cache (clips, tile masters)
 *   final:  the tiles browsers download; keeps the contract from plan §5 step 7
 *           (Main profile and level, a keyframe every second, a bitrate cap,
 *           faststart). CAVLC stands in for x264's -tune fastdecode, which also
 *           keeps B-frames: without them NVENC needed twice the bytes.
 *   full:   full renditions for the floating player (High profile)
 * NVENC quality offsets (cq = CRF + 4 for tiles, + 5 for renditions) come from
 * SSIM comparisons with x264 at the same CRF on real tiles and sources.
 * Each returns the options after "-c:v <codec>".
 * @typedef {object} HardwareEncoder
 * @property {string} codec  ffmpeg encoder name
 * @property {string} label
 * @property {string[]} [init]   global options before the inputs
 * @property {string} [filter]   filter that hands frames to the encoder
 * @property {(o: { fps: number, size: Size }) => string[]} master
 * @property {(o: { fps: number, crf: number, level: string, rate: { cap: number, target: number } }) => string[]} final
 * @property {(o: { crf: number, size: Size, fps: number }) => string[]} full
 */

/**
 * Hardware H.264 encoders in detection order.
 * @type {Record<string, HardwareEncoder>}
 */
export const HW_ENCODERS = {
  nvenc: {
    codec: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    master: ({ fps }) => ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '16', '-b:v', '0', '-g', String(fps), '-pix_fmt', 'yuv420p'],
    final: ({ fps, crf, level, rate }) => ['-preset', 'p7', '-tune', 'hq', '-profile:v', 'main', '-level:v', level,
      '-rc', 'vbr', '-cq', String(crf + 4), '-b:v', '0', ...cap(rate), '-bf', '3', '-spatial-aq', '1', '-rc-lookahead', '20',
      '-coder', 'cavlc', '-pix_fmt', 'yuv420p', ...gop(fps)],
    full: ({ crf }) => ['-preset', 'p7', '-tune', 'hq', '-profile:v', 'high', '-rc', 'vbr', '-cq', String(crf + 5), '-b:v', '0',
      '-bf', '3', '-spatial-aq', '1', '-rc-lookahead', '20', '-pix_fmt', 'yuv420p'],
  },
  qsv: {
    codec: 'h264_qsv',
    label: 'Intel Quick Sync',
    master: ({ fps }) => ['-preset', 'medium', '-global_quality', '16', '-g', String(fps), '-pix_fmt', 'nv12'],
    final: ({ fps, rate }) => ['-preset', 'medium', '-profile:v', 'main', ...vbr(rate), '-cavlc', '1', '-pix_fmt', 'nv12', ...gop(fps)],
    full: ({ crf }) => ['-preset', 'medium', '-profile:v', 'high', '-global_quality', String(crf), '-pix_fmt', 'nv12'],
  },
  amf: {
    codec: 'h264_amf',
    label: 'AMD AMF',
    master: ({ fps }) => ['-quality', 'quality', '-rc', 'cqp', '-qp_i', '16', '-qp_p', '16', '-qp_b', '16', '-g', String(fps)],
    final: ({ fps, rate }) => ['-quality', 'balanced', '-profile:v', 'main', '-rc', 'vbr_peak', ...vbr(rate), '-coder', 'cavlc', ...gop(fps)],
    full: ({ crf }) => ['-quality', 'quality', '-profile:v', 'high', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2), '-qp_b', String(crf + 4)],
  },
  videotoolbox: {
    codec: 'h264_videotoolbox',
    label: 'Apple VideoToolbox',
    master: ({ fps, size }) => ['-b:v', kbps(size.w * size.h * fps * 0.6), '-g', String(fps)],
    final: ({ fps, rate }) => ['-profile:v', 'main', ...vbr(rate), '-coder', 'cavlc', ...gop(fps)],
    full: ({ size, fps }) => ['-profile:v', 'high', '-b:v', kbps(size.w * size.h * Math.min(fps, 30) * 0.1)],
  },
  vaapi: {
    codec: 'h264_vaapi',
    label: 'VA-API',
    init: ['-vaapi_device', '/dev/dri/renderD128'],
    filter: 'format=nv12,hwupload',
    master: ({ fps }) => ['-rc_mode', 'CQP', '-qp', '16', '-g', String(fps)],
    final: ({ fps, rate }) => ['-profile:v', 'main', '-rc_mode', 'VBR', ...vbr(rate), '-coder', 'cavlc', ...gop(fps)],
    full: ({ crf }) => ['-profile:v', 'high', '-rc_mode', 'CQP', '-qp', String(crf)],
  },
};

const cap = (rate) => ['-maxrate', kbps(rate.cap), '-bufsize', kbps(rate.cap * 2)];
const vbr = (rate) => ['-b:v', kbps(rate.target), ...cap(rate)];
const gop = (fps) => ['-g', String(fps), '-movflags', '+faststart', '-an'];

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

// ---------------------------------------------------------------------------
// H.264 encodes (libx264, or a hardware encoder from HW_ENCODERS)

/**
 * High-quality intermediate encode for clips and tile masters.
 * @param {H264Encoder} encoder
 * @param {{ fps: number, size: Size }} o  size: the frame size, for encoders that need a bitrate
 * @returns {Encode}
 */
export function masterEncode(encoder, o) {
  if (encoder !== 'libx264') return hw(encoder, HW_ENCODERS[encoder].master(o));
  return { args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', String(o.fps), '-pix_fmt', 'yuv420p'] };
}

/**
 * Final tile encode: what browsers decode (plan §5 step 7).
 * @param {{ tile: Size, fps: number, crf: number, level: string, codec?: 'h264'|'vp9', encoder?: H264Encoder }} o
 * @returns {Encode}
 */
export function tileEncode(o) {
  const bps = Math.round(o.tile.w * o.tile.h * o.fps * 0.12);
  const fps = String(o.fps);
  if (o.codec === 'vp9') {
    // Constrained quality; VP9's CRF scale runs higher than x264's for similar quality.
    return {
      args: [
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', String(Math.min(63, o.crf + 8)),
        '-b:v', kbps(bps), '-g', fps, '-row-mt', '1',
        '-deadline', 'good', '-cpu-used', '4', '-an',
      ],
    };
  }
  if (o.encoder && o.encoder !== 'libx264') {
    return hw(o.encoder, HW_ENCODERS[o.encoder].final({ fps: o.fps, crf: o.crf, level: o.level, rate: { cap: bps, target: bps * 0.7 } }));
  }
  return {
    args: [
      '-c:v', 'libx264', '-profile:v', 'main', '-level:v', o.level, '-pix_fmt', 'yuv420p',
      '-preset', 'medium', '-crf', String(o.crf), ...cap({ cap: bps }),
      '-g', fps, '-keyint_min', fps, '-sc_threshold', '0',
      '-tune', 'fastdecode', '-movflags', '+faststart', '-an',
    ],
  };
}

/**
 * Full-rendition encode (High profile, constant quality where the encoder has it).
 * @param {H264Encoder} encoder
 * @param {{ crf: number, size: Size, fps: number }} o  size and fps: the expected output, for bitrate-only encoders
 * @returns {Encode}
 */
export function fullEncode(encoder, o) {
  if (encoder !== 'libx264') return hw(encoder, HW_ENCODERS[encoder].full(o));
  return { args: ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', String(o.crf)] };
}

/** @param {string} encoder @param {string[]} args @returns {Encode} */
function hw(encoder, args) {
  const spec = HW_ENCODERS[encoder];
  if (!spec) throw new Error(`Unknown hardware encoder "${encoder}"`);
  return { args: ['-c:v', spec.codec, ...args], ...(spec.filter ? { filter: spec.filter } : {}), ...(spec.init ? { init: spec.init } : {}) };
}

function kbps(bps) {
  return `${Math.round(bps / 1000)}k`;
}

/** Global options every encode in one ffmpeg run needs, without repeats. @param {Encode[]} encodes */
function initArgs(encodes) {
  const seen = new Set();
  const out = [];
  for (const e of encodes) {
    if (!e.init || seen.has(e.init.join(' '))) continue;
    seen.add(e.init.join(' '));
    out.push(...e.init);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview clips and tiles

/**
 * Normalize one source into a preview clip: `size`, constant fps, exactly `frames` frames.
 * @param {object} o
 * @param {string} o.src
 * @param {ProbeInfo} o.probe
 * @param {{ start: number, loop: boolean }} o.window
 * @param {boolean} o.loopShort  false holds the last frame instead of looping
 * @param {number} o.fps
 * @param {number} o.frames
 * @param {Size} o.size  the video's rectangle on the wall at full zoom
 * @param {'cover'|'contain'} o.fit
 * @param {string} o.background
 * @param {boolean} o.toneMap
 * @param {Encode} [o.encode]  defaults to the libx264 master settings
 * @param {boolean} [o.hwDecode]  decode the source on the GPU when possible
 * @param {string} out
 */
export function clipArgs(o, out) {
  const { w, h } = o.size;
  const encode = o.encode ?? masterEncode('libx264', { fps: o.fps, size: o.size });
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
  if (encode.filter) vf.push(encode.filter);

  const loop = o.window.loop && o.loopShort;
  return [
    ...initArgs([encode]),
    ...(o.hwDecode ? ['-hwaccel', 'auto'] : []),
    ...(o.window.start > 0 ? ['-ss', String(o.window.start)] : []),
    ...(loop ? ['-stream_loop', '-1'] : []),
    '-i', o.src,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', vf.join(','),
    '-frames:v', String(o.frames),
    ...encode.args,
    out,
  ];
}

/**
 * Filter graph that places inputs at pixel offsets on a `size` canvas, labelled [t].
 * An input with `crop` contributes only that part of its frame (a video that
 * crosses a tile edge).
 * @param {Array<{ x: number, y: number, crop?: { x: number, y: number, w: number, h: number } }>} positions one per input, in input order
 * @param {Size} size
 * @param {string} background
 */
export function stackGraph(positions, size, background) {
  const bg = ffColor(background);
  const crops = [];
  const ins = positions.map((p, i) => {
    if (!p.crop) return `[${i}:v]`;
    crops.push(`[${i}:v]crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y}[c${i}]`);
    return `[c${i}]`;
  });
  const pre = crops.length ? `${crops.join(';')};` : '';
  if (positions.length === 1) {
    const [p] = positions;
    return `${pre}${ins[0]}pad=${size.w}:${size.h}:${p.x}:${p.y}:color=${bg}[t]`;
  }
  const layout = positions.map((p) => `${p.x}_${p.y}`).join('|');
  return `${pre}${ins.join('')}xstack=inputs=${positions.length}:layout=${layout}:fill=${bg}[s];[s]pad=${size.w}:${size.h}:0:0:color=${bg}[t]`;
}

/**
 * One ffmpeg run that composites a tile and writes every output from it:
 * the cached high-quality master, one final tile per codec, and the still.
 * @param {object} o
 * @param {string[]} o.inputs input files
 * @param {string} o.graph filter graph ending in [t] at final tile size
 * @param {number} o.fps
 * @param {number} o.frames
 * @param {{ master?: string, masterEncode?: Encode, finals: Array<{ encode: Encode, path: string }>, still?: string }} outs
 */
export function tileArgs(o, outs) {
  /** @type {Array<{ encode: Encode, args: string[] }>} */
  const targets = [];
  if (outs.master) {
    const encode = outs.masterEncode ?? masterEncode('libx264', { fps: o.fps, size: { w: 0, h: 0 } });
    targets.push({ encode, args: [...encode.args, '-an', '-frames:v', String(o.frames), outs.master] });
  }
  for (const f of outs.finals) targets.push({ encode: f.encode, args: [...f.encode.args, '-frames:v', String(o.frames), f.path] });
  if (outs.still) targets.push({ encode: { args: [] }, args: ['-frames:v', '1', ...stillEncode(), outs.still] });

  const labels = targets.map((_, i) => `[o${i}]`);
  let graph = `${o.graph};[t]split=${targets.length}${labels.join('')}`;
  targets.forEach((t, i) => {
    if (!t.encode.filter) return;
    graph += `;[o${i}]${t.encode.filter}[o${i}u]`;
    labels[i] = `[o${i}u]`;
  });
  const args = [...initArgs(targets.map((t) => t.encode)), ...o.inputs.flatMap((f) => ['-i', f])];
  args.push('-filter_complex', graph);
  targets.forEach((t, i) => args.push('-map', labels[i], ...t.args));
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

/**
 * Graph for the level-0 overview tile: the level-1 children stacked 2×2,
 * cropped to the wall and scaled to fit one tile (anchored top-left).
 * @param {Array<{ dx: number, dy: number }>} children in input order
 * @param {Size} tile
 * @param {Size} content wall size in level-1 pixels
 * @param {number} scale level-0 pixels per level-1 pixel
 * @param {string} background
 */
export function overviewGraph(children, tile, content, scale, background) {
  const positions = children.map((c) => ({ x: c.dx * tile.w, y: c.dy * tile.h }));
  const doubled = stackGraph(positions, { w: tile.w * 2, h: tile.h * 2 }, background).replace(/\[t\]$/, '[d]');
  const cw = Math.min(tile.w * 2, evenCeil(content.w));
  const ch = Math.min(tile.h * 2, evenCeil(content.h));
  const w = Math.min(tile.w, evenRound(content.w * scale));
  const h = Math.min(tile.h, evenRound(content.h * scale));
  return `${doubled};[d]crop=${cw}:${ch}:0:0,scale=${w}:${h}:flags=area,pad=${tile.w}:${tile.h}:0:0:color=${ffColor(background)},setsar=1[t]`;
}

function evenCeil(x) {
  return Math.ceil(x / 2) * 2;
}

function evenRound(x) {
  return Math.max(2, Math.round(x / 2) * 2);
}

function stillEncode() {
  return ['-c:v', 'libwebp', '-quality', '75', '-compression_level', '4'];
}

// ---------------------------------------------------------------------------
// Full renditions and posters

/**
 * Is decoding this source on the GPU worth it? Copying frames back for the CPU
 * filters makes it slower for 1080p H.264 (measured), so only sources that are
 * expensive to decode in software qualify.
 * @param {ProbeInfo} p
 */
export function worthHwDecode(p) {
  return ['hevc', 'av1', 'vp9'].includes(p.videoCodec) || Math.min(p.width, p.height) > 1440;
}

/** Clips at least this many pixels are encoded on the GPU; smaller ones are cheap for x264, and their sessions are better spent on tiles. */
export const HW_CLIP_PIXELS = 1280 * 720;

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
 * @param {{ src: string, probe: ProbeInfo, maxHeight: number, crf: number, toneMap: boolean, encoder?: H264Encoder, hwDecode?: boolean }} o
 * @param {string} out
 */
export function fullArgs(o, out) {
  const input = ['-i', o.src, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  if (isWebCompatible(o.probe, o.maxHeight)) {
    return [...input, '-c', 'copy', '-movflags', '+faststart', out];
  }
  const height = Math.min(o.maxHeight, o.probe.height);
  const size = { w: Math.round((o.probe.width * height) / o.probe.height), h: height };
  const encode = fullEncode(o.encoder ?? 'libx264', { crf: o.crf, size, fps: o.probe.fps });
  const vf = sourceFilters(o.probe, o.toneMap);
  vf.push(`scale=-2:'min(${o.maxHeight},trunc(ih/2)*2)':flags=bicubic`, 'format=yuv420p');
  if (encode.filter) vf.push(encode.filter);
  return [
    ...initArgs([encode]),
    ...(o.hwDecode ? ['-hwaccel', 'auto'] : []),
    ...input,
    '-vf', vf.join(','),
    ...encode.args,
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
