// H.264 level selection, so tiles declare the smallest level a decoder needs.

// [level, max macroblocks per frame, max macroblocks per second] (ITU-T H.264 Table A-1)
/** @type {Array<[string, number, number]>} */
const H264_LEVELS = [
  ['3.0', 1620, 40500],
  ['3.1', 3600, 108000],
  ['3.2', 5120, 216000],
  ['4.0', 8192, 245760],
  ['4.2', 8704, 522240],
  ['5.0', 22080, 589824],
  ['5.1', 36864, 983040],
];

/**
 * Smallest H.264 level that fits a stream, plus its RFC 6381 codec string for Main profile.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {{ level: string, codecs: string, mime: string }}
 */
export function h264Level(width, height, fps) {
  const mbFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbSecond = mbFrame * fps;
  const found = H264_LEVELS.find(([, maxFrame, maxSecond]) => mbFrame <= maxFrame && mbSecond <= maxSecond);
  if (!found) throw new Error(`${width}x${height}@${fps} exceeds H.264 level 5.1; use smaller tiles`);
  const level = found[0];
  const levelHex = Math.round(Number(level) * 10).toString(16).toUpperCase().padStart(2, '0');
  const codecs = `avc1.4D40${levelHex}`;
  return { level, codecs, mime: `video/mp4; codecs="${codecs}"` };
}

// [level, max luma picture size, max luma sample rate] (VP9 levels, webmproject.org)
/** @type {Array<[string, number, number]>} */
const VP9_LEVELS = [
  ['10', 36864, 829440],
  ['11', 73728, 2764800],
  ['20', 122880, 4608000],
  ['21', 245760, 9216000],
  ['30', 552960, 20736000],
  ['31', 983040, 36864000],
  ['40', 2228224, 83558400],
  ['41', 2228224, 160432128],
  ['50', 8912896, 311951360],
];

/**
 * VP9 profile 0, 8-bit codec string for a stream.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 */
export function vp9Level(width, height, fps) {
  const samples = width * height;
  const found = VP9_LEVELS.find(([, maxPic, maxRate]) => samples <= maxPic && samples * fps <= maxRate);
  if (!found) throw new Error(`${width}x${height}@${fps} exceeds VP9 level 5.0; use smaller tiles`);
  const codecs = `vp09.00.${found[0]}.08`;
  return { level: found[0], codecs, mime: `video/webm; codecs="${codecs}"` };
}

export const TILE_CODECS = /** @type {const} */ (['h264', 'vp9']);

/**
 * Everything the builder and viewer need to know about one tile codec.
 * @param {'h264'|'vp9'} codec
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {{ codec: 'h264'|'vp9', ext: string, level: string, mime: string, template: string }}
 */
export function tileCodec(codec, width, height, fps) {
  if (codec === 'vp9') {
    const { level, mime } = vp9Level(width, height, fps);
    return { codec, ext: 'webm', level, mime, template: 'tiles/{z}/{x}/{y}.webm' };
  }
  const { level, mime } = h264Level(width, height, fps);
  return { codec: 'h264', ext: 'mp4', level, mime, template: 'tiles/{z}/{x}/{y}.mp4' };
}
