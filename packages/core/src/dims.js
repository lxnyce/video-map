// Parsing and rounding helpers for pixel sizes and aspect ratios.

/** @typedef {{ w: number, h: number }} Size */

/**
 * Parse "WxH" (e.g. "768x432") into a size.
 * @param {string} value
 * @param {string} [name] used in error messages
 * @returns {Size}
 */
export function parseSize(value, name = 'size') {
  const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(String(value));
  if (!m) throw new Error(`${name} must look like WIDTHxHEIGHT (e.g. 768x432), got "${value}"`);
  const size = { w: Number(m[1]), h: Number(m[2]) };
  if (size.w < 2 || size.h < 2) throw new Error(`${name} must be at least 2x2, got "${value}"`);
  return size;
}

/**
 * Parse "16:9", "1.78" or a number into width / height.
 * @param {string | number} value
 * @param {string} [name]
 * @returns {number}
 */
export function parseRatio(value, name = 'ratio') {
  if (typeof value === 'number') {
    if (value > 0 && Number.isFinite(value)) return value;
  } else {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value));
    if (m && Number(m[2]) > 0 && Number(m[1]) > 0) return Number(m[1]) / Number(m[2]);
    const n = Number(value);
    if (n > 0 && Number.isFinite(n)) return n;
  }
  throw new Error(`${name} must look like W:H (e.g. 16:9), got "${value}"`);
}

/** @param {Size} s */
export function formatSize(s) {
  return `${s.w}x${s.h}`;
}

/** Largest even integer ≤ x (minimum 2). yuv420p video needs even dimensions. */
export function floorEven(x) {
  return Math.max(2, Math.floor(x / 2) * 2);
}

/** Nearest even integer to x (minimum 2). */
export function roundEven(x) {
  return Math.max(2, Math.round(x / 2) * 2);
}
