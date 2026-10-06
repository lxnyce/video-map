// Curved surfaces (plan §8.1): where each wall pixel sits in 3D, and which wall
// pixel a ray hits. Shared by the viewer (rendering, camera, picking) and the
// build (the default wall shape for a surface).
//
// The wall keeps its pixel layout and the surface wraps it, in wall-pixel
// units. On a cylinder the arc's length equals the wall's width and the height
// is the wall's height, so nothing stretches. A sphere uses the Mercator
// projection inside its latitude band. Mercator keeps every video's shape, so
// only its size shrinks away from the equator, to half at ±60°. A plain
// latitude/longitude mapping would squash videos sideways by the same factor
// instead.
//
// World axes: y is up. The middle of the wall faces the viewer: it sits at -z
// for the inside view (camera at the center) and at +z for the outside view, so
// the wall reads left to right from either side.

const DEG = Math.PI / 180;

/** Height of the default cylinder wall, in radii: about 75° of view from the axis. */
export const CYLINDER_HEIGHT = 1.5;

/** @param {number} lat radians */
export const mercator = (lat) => Math.log(Math.tan(Math.PI / 4 + lat / 2));
/** @param {number} m */
export const inverseMercator = (m) => 2 * Math.atan(Math.exp(m)) - Math.PI / 2;

/**
 * @typedef {object} SurfaceSpec
 * @property {'plane'|'cylinder'|'sphere'} type
 * @property {number} [arc]  degrees: cylinder wrap, sphere longitude span
 * @property {number[]} [latitudeBand]  sphere: [south, north] degrees
 * @property {'inside'|'outside'} [view]
 */

/**
 * @typedef {object} SurfaceGeometry
 * @property {'cylinder'|'sphere'} type
 * @property {boolean} inside   camera inside the surface (immersive) or outside (object)
 * @property {number} side      -1 inside, +1 outside: the sign of z at the wall's middle
 * @property {number} radius    in wall pixels
 * @property {number} width     wall size in pixels
 * @property {number} height
 * @property {number} mid       sphere: Mercator coordinate of the wall's vertical middle (0 on a cylinder)
 * @property {boolean} wrap     the wall closes on itself, so x wraps modulo width
 */

/**
 * Wall aspect (width / height) that fills a surface, used as the default
 * layout aspect. Null for a plane.
 * @param {SurfaceSpec} surface
 */
export function surfaceAspect(surface) {
  const arc = (surface.arc ?? 360) * DEG;
  if (surface.type === 'cylinder') return Math.max(1, arc / CYLINDER_HEIGHT);
  if (surface.type === 'sphere') {
    const [s, n] = (surface.latitudeBand ?? [-60, 60]).map((d) => d * DEG);
    return arc / (mercator(n) - mercator(s));
  }
  return null;
}

/**
 * How a wall of the given size wraps a surface. A sphere wall whose shape
 * doesn't match the band is centered in it: a wall too tall for the band spans
 * less longitude, and one too wide spans less latitude. Null for a plane.
 * @param {SurfaceSpec|null|undefined} surface
 * @param {number} width
 * @param {number} height
 * @returns {SurfaceGeometry|null}
 */
export function surfaceGeometry(surface, width, height) {
  if (!surface || (surface.type !== 'cylinder' && surface.type !== 'sphere')) return null;
  const arc = Math.min(360, Math.max(1, surface.arc ?? 360)) * DEG;
  let radius = width / arc;
  let mid = 0;
  if (surface.type === 'sphere') {
    const [s, n] = (surface.latitudeBand ?? [-60, 60]).map((d) => d * DEG);
    const ms = mercator(s);
    const mn = mercator(n);
    radius = Math.max(radius, height / (mn - ms));
    mid = (ms + mn) / 2;
  }
  const inside = surface.view !== 'outside';
  return {
    type: surface.type,
    inside,
    side: inside ? -1 : 1,
    radius,
    width,
    height,
    mid,
    wrap: arc >= 2 * Math.PI - 1e-9 && Math.abs(width / radius - 2 * Math.PI) < 1e-6,
  };
}

/**
 * The 3D point of a wall pixel, and the surface's outward normal there.
 * @param {SurfaceGeometry} g
 * @param {number} x
 * @param {number} y
 * @returns {{ p: number[], n: number[] }}
 */
export function surfacePoint(g, x, y) {
  const lon = (x - g.width / 2) / g.radius;
  if (g.type === 'cylinder') {
    const n = [Math.sin(lon), 0, g.side * Math.cos(lon)];
    return { p: [g.radius * n[0], g.height / 2 - y, g.radius * n[2]], n };
  }
  const lat = inverseMercator(g.mid + (g.height / 2 - y) / g.radius);
  const c = Math.cos(lat);
  const n = [c * Math.sin(lon), Math.sin(lat), g.side * c * Math.cos(lon)];
  return { p: n.map((v) => v * g.radius), n };
}

/**
 * World units per wall pixel at a wall row: 1 on a cylinder, cos(latitude) on a
 * sphere (Mercator scales both directions alike).
 * @param {SurfaceGeometry} g
 * @param {number} y
 */
export function surfaceScale(g, y) {
  if (g.type === 'cylinder') return 1;
  return Math.cos(inverseMercator(g.mid + (g.height / 2 - y) / g.radius));
}

/**
 * The wall pixel at a 3D point on the surface (not checked against the wall's bounds).
 * @param {SurfaceGeometry} g
 * @param {number[]} p
 * @returns {{ x: number, y: number }}
 */
export function wallPoint(g, p) {
  let x = g.width / 2 + Math.atan2(p[0], g.side * p[2]) * g.radius;
  if (g.wrap) x = mod(x, g.width);
  if (g.type === 'cylinder') return { x, y: g.height / 2 - p[1] };
  const lat = Math.asin(Math.max(-1, Math.min(1, p[1] / g.radius)));
  return { x, y: g.height / 2 - (mercator(lat) - g.mid) * g.radius };
}

/**
 * The wall pixel a ray sees, or null when it sees no video side of the wall
 * (it misses, passes outside the wall's bounds, or, from outside, would only
 * reach the back of the wall).
 * @param {SurfaceGeometry} g
 * @param {number[]} o ray origin
 * @param {number[]} d ray direction (any length)
 * @returns {{ x: number, y: number } | null}
 */
export function surfaceHit(g, o, d) {
  const cyl = g.type === 'cylinder';
  const a = d[0] * d[0] + (cyl ? 0 : d[1] * d[1]) + d[2] * d[2];
  const b = 2 * (o[0] * d[0] + (cyl ? 0 : o[1] * d[1]) + o[2] * d[2]);
  const c = o[0] * o[0] + (cyl ? 0 : o[1] * o[1]) + o[2] * o[2] - g.radius * g.radius;
  if (a < 1e-12) return null;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  // From inside, the ray leaves through the far root. From outside, the near root is the front of the wall.
  const t = g.inside ? (-b + sq) / (2 * a) : (-b - sq) / (2 * a);
  if (!(t > 0)) return null;
  const w = wallPoint(g, [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]]);
  return w.x >= 0 && w.x < g.width && w.y >= 0 && w.y < g.height ? w : null;
}

/** A horizontal distance on a wall that wraps, taken the short way round (within ±width/2). */
export function wrapDelta(d, width) {
  return d - Math.round(d / width) * width;
}

function mod(a, n) {
  return ((a % n) + n) % n;
}
