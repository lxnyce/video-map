// ffprobe → the facts the pipeline needs about a source video.

/**
 * @typedef {object} ProbeInfo
 * @property {number} duration      seconds
 * @property {number} width         display width (after rotation and sample aspect ratio)
 * @property {number} height        display height
 * @property {number} codedWidth
 * @property {number} codedHeight
 * @property {number} rotation      degrees, as stored in the file
 * @property {number} sar           sample (pixel) aspect ratio
 * @property {number} fps
 * @property {string} videoCodec
 * @property {string} pixFmt
 * @property {string|null} audioCodec
 * @property {boolean} hdr
 * @property {string} container
 */

/**
 * @param {import('./ffmpeg.js').Tools} tools
 * @param {string} src file path or URL
 * @returns {Promise<ProbeInfo>}
 */
export async function probe(tools, src) {
  let raw;
  try {
    raw = await tools.probeRaw(['-print_format', 'json', '-show_format', '-show_streams', src]);
  } catch (err) {
    throw new Error(`Couldn't read ${src}: ${err.message.split('\n').pop()}`);
  }
  return parseProbe(JSON.parse(raw), src);
}

/**
 * @param {any} data ffprobe JSON output
 * @param {string} src for error messages
 * @returns {ProbeInfo}
 */
export function parseProbe(data, src) {
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error(`${src} has no video stream`);
  const audio = streams.find((s) => s.codec_type === 'audio');

  const duration = num(data.format?.duration) || num(video.duration);
  if (!(duration > 0)) throw new Error(`${src} has an unknown or zero duration`);

  const rotation = readRotation(video);
  const sar = readRatio(video.sample_aspect_ratio) || 1;
  const codedWidth = num(video.width);
  const codedHeight = num(video.height);
  let width = Math.round(codedWidth * sar);
  let height = codedHeight;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

  const fps = readRatio(video.avg_frame_rate) || readRatio(video.r_frame_rate) || 30;
  const transfer = video.color_transfer ?? '';

  return {
    duration,
    width,
    height,
    codedWidth,
    codedHeight,
    rotation,
    sar,
    fps,
    videoCodec: video.codec_name ?? 'unknown',
    pixFmt: video.pix_fmt ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
    hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
    container: data.format?.format_name ?? 'unknown',
  };
}

function readRotation(stream) {
  for (const sd of stream.side_data_list ?? []) {
    if (typeof sd.rotation === 'number') return sd.rotation;
  }
  const tag = num(stream.tags?.rotate);
  return Number.isFinite(tag) ? tag : 0;
}

function readRatio(value) {
  if (typeof value !== 'string') return 0;
  const [a, b] = value.split(/[:/]/).map(Number);
  return a > 0 && b > 0 ? a / b : 0;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
