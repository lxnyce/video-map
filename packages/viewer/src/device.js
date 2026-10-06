// Device tiers: how many tile videos to decode at once and how hard to push the GPU.
// The numbers are the plan's placeholders until milestone 0 device results come in.

/**
 * @typedef {object} Tier
 * @property {'low'|'mid'|'high'} name
 * @property {number} budget       concurrent tile videos
 * @property {number} uploads      video texture uploads per frame
 * @property {number} lodBias      < 1 accepts slightly blurrier tiles to need fewer of them
 * @property {number} pixelRatio   cap on device pixels per CSS pixel
 * @property {number} stillCache   still textures kept in GPU memory
 */

/** @type {Record<'low'|'mid'|'high', Tier>} */
export const TIERS = {
  low: { name: 'low', budget: 4, uploads: 2, lodBias: 0.75, pixelRatio: 1, stillCache: 24 },
  mid: { name: 'mid', budget: 9, uploads: 4, lodBias: 0.9, pixelRatio: 1.5, stillCache: 48 },
  high: { name: 'high', budget: 16, uploads: 8, lodBias: 1, pixelRatio: 1.5, stillCache: 96 },
};

const WEAK_GPU = /Mali-[4T]|Mali-G(31|51|52|57)|Adreno \(TM\) [2-5]\d\d|PowerVR|SwiftShader|llvmpipe|Intel.*HD Graphics [2-5]\d{2,3}\b/i;

/**
 * @param {{ userAgent: string, hardwareConcurrency?: number, deviceMemory?: number, maxTouchPoints?: number }} nav
 * @param {string} gpu unmasked renderer string, if available
 * @param {URLSearchParams} [params] ?tier=low|mid|high and ?budget=n override detection
 * @returns {Tier}
 */
export function detectTier(nav, gpu = '', params = new URLSearchParams()) {
  const forced = params.get('tier');
  let tier;
  if (forced === 'low' || forced === 'mid' || forced === 'high') {
    tier = { ...TIERS[forced] };
  } else {
    const ua = nav.userAgent;
    const mobile = /Android|iPhone|iPad|iPod|Mobi/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
    const cores = nav.hardwareConcurrency ?? 4;
    const memory = nav.deviceMemory ?? (mobile ? 3 : 8);
    if (WEAK_GPU.test(gpu) || memory <= 2 || (mobile && cores <= 4)) tier = { ...TIERS.low };
    else if (mobile || memory <= 4 || cores <= 4) tier = { ...TIERS.mid };
    else tier = { ...TIERS.high };
  }
  const budget = Number(params.get('budget'));
  if (Number.isInteger(budget) && budget >= 1 && budget <= 32) tier.budget = budget;
  return tier;
}

/** @param {WebGLRenderingContext} gl */
export function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    return '';
  }
}
