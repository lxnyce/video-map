// A small router and request helpers for the Studio API. The API has a couple
// of dozen routes, streams uploads, SSE and zips, and serves files with
// ranges; node:http does all of that without a framework.

import net from 'node:net';

export class HttpError extends Error {
  /** @param {number} status @param {string} message @param {any} [details] merged into the JSON error body */
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * @typedef {import('node:http').IncomingMessage} Req
 * @typedef {import('node:http').ServerResponse} Res
 * @typedef {(req: Req, res: Res, ctx: { params: Record<string, string>, url: URL }) => any} Handler
 */

export function createRouter() {
  /** @type {Array<{ method: string, parts: string[], rest: boolean, handler: Handler }>} */
  const routes = [];
  return {
    /**
     * @param {string} method  or "*" for any
     * @param {string} pattern  e.g. "/api/projects/:id"; a trailing "/*" matches the rest of the path as params["*"]
     * @param {Handler} handler
     */
    add(method, pattern, handler) {
      const rest = pattern.endsWith('/*');
      const parts = (rest ? pattern.slice(0, -2) : pattern).split('/').filter(Boolean);
      routes.push({ method, parts, rest, handler });
    },
    /** @param {string} method @param {string} pathname */
    match(method, pathname) {
      const segs = pathname.split('/').filter(Boolean);
      let allowed = false;
      for (const r of routes) {
        if (r.rest ? segs.length < r.parts.length : segs.length !== r.parts.length) continue;
        /** @type {Record<string, string>} */
        const params = {};
        let ok = true;
        for (let i = 0; i < r.parts.length && ok; i++) {
          const p = r.parts[i];
          if (p.startsWith(':')) {
            try {
              params[p.slice(1)] = decodeURIComponent(segs[i]);
            } catch {
              ok = false;
            }
          } else if (p !== segs[i]) {
            ok = false;
          }
        }
        if (!ok) continue;
        if (r.rest) params['*'] = segs.slice(r.parts.length).join('/');
        if (r.method !== '*' && r.method !== method && !(r.method === 'GET' && method === 'HEAD')) {
          allowed = true;
          continue;
        }
        return { handler: r.handler, params };
      }
      return allowed ? 'method' : null;
    },
  };
}

/** @param {Res} res @param {number} status @param {any} data @param {Record<string, string|number>} [headers] */
export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** @param {Res} res @param {number} status @param {string} text */
export function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/**
 * Read the whole body as text, up to `limit` bytes.
 * @param {Req} req
 * @param {number} [limit]
 */
export async function readText(req, limit = 16 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `The request body is larger than ${Math.round(limit / 1048576)} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read a JSON body. Requiring the JSON content type also means a page on
 * another site can't send it without a CORS preflight, which the Studio never
 * answers.
 * @param {Req} req
 */
export async function readJson(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  const text = await readText(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw new HttpError(400, `The request body is not valid JSON: ${err.message}`);
  }
}

/**
 * Refuse requests that could come from another website: a Host that isn't
 * localhost or an IP address (DNS rebinding), and state-changing requests
 * from another origin (cross-site request forgery).
 * @param {Req} req
 * @param {string[]} [allowedHosts] extra host names to accept
 * @returns {string|null} why the request is refused, or null
 */
export function checkOrigin(req, allowedHosts = []) {
  const host = String(req.headers.host ?? '');
  const hostname = hostName(host);
  if (!hostname || !(hostname === 'localhost' || net.isIP(hostname) || allowedHosts.includes(hostname))) {
    return `Host "${host}" is not allowed. Open the Studio at localhost or an IP address, or start it with --allow-host ${hostname || '<name>'}.`;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        // malformed: refused below
      }
      if (originHost !== host) return `Requests from ${origin} are not allowed.`;
    } else if (origin === 'null') {
      return 'Requests from an opaque origin are not allowed.';
    }
  }
  return null;
}

/** "localhost:5170" → "localhost", "[::1]:80" → "::1" @param {string} host */
function hostName(host) {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (m) return m[1];
  return host.replace(/:\d+$/, '').toLowerCase();
}
