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
