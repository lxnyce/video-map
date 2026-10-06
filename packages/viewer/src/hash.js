// Deep links: #cam=x,y,zoom&v=video-id

/**
 * @param {string} hash location.hash
 * @returns {{ v: string|null, cam: { x: number, y: number, zoom: number } | null }}
 */
export function parseHash(hash) {
  const out = { v: null, cam: null };
  for (const part of hash.replace(/^#/, '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    let value;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue;
    }
    if (key === 'v' && value) out.v = value;
    if (key === 'cam') {
      const [x, y, zoom] = value.split(',').map(Number);
      if ([x, y, zoom].every(Number.isFinite) && zoom > 0) out.cam = { x, y, zoom };
    }
  }
  return out;
}

/**
 * @param {{ v?: string|null, cam?: { x: number, y: number, zoom: number } | null }} state
 */
export function formatHash({ v, cam }) {
  const parts = [];
  if (cam) parts.push(`cam=${Math.round(cam.x)},${Math.round(cam.y)},${Number(cam.zoom.toPrecision(4))}`);
  if (v) parts.push(`v=${encodeURIComponent(v)}`);
  return parts.length ? `#${parts.join('&')}` : '';
}
