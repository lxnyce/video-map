// Minimal static file server for `vmap preview`. Supports HTTP range requests,
// which iOS Safari needs to play MP4.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '@videomap/builder';

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
  return listen(server, port, host);
}

/**
 * Listen and list the URLs to open: localhost, plus LAN addresses when listening on every interface.
 * @param {http.Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<{ server: http.Server, port: number, urls: string[] }>}
 */
export function listen(server, port, host) {
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
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  await serveStatic(base, pathname, req, res, { 'Access-Control-Allow-Origin': '*' });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}
