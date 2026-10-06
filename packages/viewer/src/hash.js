// Deep links: #cam=x,y,zoom&v=video-id&layout=id&q=text&cat=a,b&tag=x,y

/**
 * @typedef {object} HashState
 * @property {string|null} v  open video
 * @property {{ x: number, y: number, zoom: number } | null} cam
 * @property {string|null} layout  alternate layout id (null: the main one)
 * @property {string} q  search text
 * @property {string[]} cats  category filter
 * @property {string[]} tags  tag filter
 */

/**
 * @param {string} hash location.hash
 * @returns {HashState}
 */
export function parseHash(hash) {
  /** @type {HashState} */
  const out = { v: null, cam: null, layout: null, q: '', cats: [], tags: [] };
  for (const part of hash.replace(/^#/, '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    const decode = (s) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return null;
      }
    };
    // Lists are comma-separated, with each item encoded on its own, so items may contain commas.
    const list = () => raw.split(',').map(decode).filter((s) => s);
    if (key === 'cat') out.cats = list();
    if (key === 'tag') out.tags = list();
    const value = decode(raw);
    if (value === null) continue;
    if (key === 'v' && value) out.v = value;
    if (key === 'layout' && value) out.layout = value;
    if (key === 'q') out.q = value;
    if (key === 'cam') {
      const [x, y, zoom] = value.split(',').map(Number);
      if ([x, y, zoom].every(Number.isFinite) && zoom > 0) out.cam = { x, y, zoom };
    }
  }
  return out;
}

/**
 * @param {Partial<HashState>} state
 */
export function formatHash({ v, cam, layout, q, cats, tags }) {
  const parts = [];
  const list = (items) => items.map((s) => encodeURIComponent(s)).join(',');
  if (layout) parts.push(`layout=${encodeURIComponent(layout)}`);
  if (cam) parts.push(`cam=${Math.round(cam.x)},${Math.round(cam.y)},${Number(cam.zoom.toPrecision(4))}`);
  if (v) parts.push(`v=${encodeURIComponent(v)}`);
  if (q?.trim()) parts.push(`q=${encodeURIComponent(q)}`);
  if (cats?.length) parts.push(`cat=${list(cats)}`);
  if (tags?.length) parts.push(`tag=${list(tags)}`);
  return parts.length ? `#${parts.join('&')}` : '';
}
