// Minimal static file server for `vmap preview`. Supports HTTP range requests,
// which iOS Safari needs to play MP4.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * @param {{ root: string, port?: number, host?: string }} opts
 * @returns {Promise<{ server: http.Server, port: number, urls: string[] }>}
 */
export function startServer({ root, port = 8080, host = '0.0.0.0' }) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    handle(base, req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, `Server error: ${err.message}`);
      else res.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      const urls = [`http://localhost:${actual}/`];
      if (host === '0.0.0.0' || host === '::') {
        for (const list of Object.values(os.networkInterfaces())) {
          for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${actual}/`);
        }
      }
      resolve({ server, port: actual, urls });
    });
  });
}

async function handle(base, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  let file = path.join(base, pathname);
  if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden');

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) return send(res, 404, 'Not found');

  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    let start;
    let end;
    if (range[1] === '') {
      start = Math.max(0, info.size - Number(range[2]));
      end = info.size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? info.size - 1 : Math.min(Number(range[2]), info.size - 1);
    }
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}
