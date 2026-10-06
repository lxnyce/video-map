// Resumable uploads with the tus protocol (https://tus.io, version 1.0.0, with
// the creation and termination extensions). A dropped connection loses
// nothing: the client asks for the offset (HEAD) and sends the rest (PATCH).
//
// Partial uploads live in <project>/.studio/uploads as <id>.part plus <id>.json.
// When the last byte arrives the file moves to media/ under its own name
// (made unique), is probed, and the final PATCH answers with its scene path in
// X-Vmap-Src. A file ffprobe can't read is deleted and the PATCH fails with 422.

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VIDEO_EXTENSIONS, basename, extname } from '@videomap/core';
import { HttpError } from './http.js';

export const TUS_VERSION = '1.0.0';
/** Uploads not finished within this time are deleted when the Studio starts. */
const STALE_MS = 7 * 86_400_000;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A safe file name for media/, keeping the original where possible.
 * @param {string} name
 */
export function safeFileName(name) {
  const ext = extname(name);
  let base = basename(String(name))
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._()+-]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 120);
  if (!base || WINDOWS_RESERVED.test(base)) base = `video${base ? `_${base}` : ''}`;
  return `${base}${ext}`;
}

/**
 * @param {object} o
 * @param {(id: string) => Promise<import('./projects.js').Project>} o.project  throws 404 for unknown projects
 * @param {(project: import('./projects.js').Project, file: string) => Promise<any>} o.probe
 * @param {number} [o.maxSize]
 */
export function createUploads({ project: getProject, probe, maxSize = 64 * 1024 ** 3 }) {
  /** @type {Set<string>} uploads receiving a PATCH right now */
  const busy = new Set();
  const tusHeaders = { 'Tus-Resumable': TUS_VERSION };
  const dirOf = (project) => path.join(project.studioDir, 'uploads');

  async function load(project, uid) {
    if (!/^[a-f0-9]{32}$/.test(uid)) throw new HttpError(404, 'No such upload.');
    const meta = await readFile(path.join(dirOf(project), `${uid}.json`), 'utf8').then(JSON.parse, () => null);
    if (!meta) throw new HttpError(404, 'No such upload. It may have finished or expired; start it again.');
    const part = path.join(dirOf(project), `${uid}.part`);
    const size = (await stat(part).catch(() => null))?.size ?? 0;
    return { meta, part, offset: size };
  }

  function requireTus(req) {
    if (req.headers['tus-resumable'] !== TUS_VERSION) throw new HttpError(412, `Send Tus-Resumable: ${TUS_VERSION}.`, { headers: { 'Tus-Version': TUS_VERSION } });
  }

  return {
    /** OPTIONS: what this server supports. */
    options(req, res) {
      res.writeHead(204, { ...tusHeaders, 'Tus-Version': TUS_VERSION, 'Tus-Extension': 'creation,termination', 'Tus-Max-Size': String(maxSize) });
      res.end();
    },

    /** POST: start an upload. */
    async create(req, res, { params }) {
      requireTus(req);
      const project = await getProject(params.id);
      const length = Number(req.headers['upload-length']);
      if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, 'Send Upload-Length (bytes).');
      if (length > maxSize) throw new HttpError(413, `Files over ${Math.round(maxSize / 1024 ** 3)} GB are not accepted.`);
      const metadata = parseMetadata(String(req.headers['upload-metadata'] ?? ''));
      const filename = metadata.filename ?? '';
      if (!VIDEO_EXTENSIONS.has(extname(filename))) {
        throw new HttpError(415, `${filename || 'This file'} is not a video file the Studio accepts (${[...VIDEO_EXTENSIONS].join(' ')}).`);
      }
      const uid = randomBytes(16).toString('hex');
      await mkdir(dirOf(project), { recursive: true });
      await writeFile(path.join(dirOf(project), `${uid}.part`), '');
      await writeFile(path.join(dirOf(project), `${uid}.json`), JSON.stringify({ filename, length, created: Date.now() }));
      res.writeHead(201, { ...tusHeaders, Location: `/api/projects/${encodeURIComponent(project.id)}/uploads/${uid}`, 'Upload-Offset': '0' });
      res.end();
    },

    /** HEAD: how much has arrived. */
    async head(req, res, { params }) {
      const project = await getProject(params.id);
      const { meta, offset } = await load(project, params.uid);
      res.writeHead(200, { ...tusHeaders, 'Upload-Offset': String(offset), 'Upload-Length': String(meta.length), 'Cache-Control': 'no-store' });
      res.end();
    },

    /** PATCH: append bytes at the current offset. */
    async patch(req, res, { params }) {
      requireTus(req);
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/offset+octet-stream') {
        throw new HttpError(415, 'Send Content-Type: application/offset+octet-stream.');
      }
      const project = await getProject(params.id);
      const key = `${project.id}/${params.uid}`;
      if (busy.has(key)) throw new HttpError(409, 'This upload is already receiving data.');
      busy.add(key);
      let complete = false;
      let meta;
      let part;
      try {
        let offset;
        ({ meta, part, offset } = await load(project, params.uid));
        const claimed = Number(req.headers['upload-offset']);
        if (claimed !== offset) {
          throw new HttpError(409, `Upload-Offset ${req.headers['upload-offset']} doesn't match the ${offset} bytes received.`, { headers: { 'Upload-Offset': String(offset) } });
        }
        const written = await append(req, part, meta.length - offset);
        offset += written;
        complete = offset === meta.length;
        if (!complete) {
          res.writeHead(204, { ...tusHeaders, 'Upload-Offset': String(offset) });
          res.end();
          return;
        }
      } finally {
        if (!complete) busy.delete(key);
      }

      try {
        const src = await finish(project, params.uid, meta, part);
        res.writeHead(204, { ...tusHeaders, 'Upload-Offset': String(meta.length), 'X-Vmap-Src': encodeURIComponent(src), 'Access-Control-Expose-Headers': 'X-Vmap-Src, Upload-Offset' });
        res.end();
      } finally {
        busy.delete(key);
      }
    },

    /** DELETE: abandon an upload. */
    async remove(req, res, { params }) {
      requireTus(req);
      const project = await getProject(params.id);
      await load(project, params.uid);
      if (busy.has(`${project.id}/${params.uid}`)) throw new HttpError(409, 'This upload is receiving data; stop it first.');
      await rm(path.join(dirOf(project), `${params.uid}.part`), { force: true });
      await rm(path.join(dirOf(project), `${params.uid}.json`), { force: true });
      res.writeHead(204, tusHeaders);
      res.end();
    },

    /** Delete partial uploads older than a week. @param {import('./projects.js').Project} project */
    async sweep(project) {
      const dir = dirOf(project);
      for (const name of await readdir(dir).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        const meta = await readFile(path.join(dir, name), 'utf8').then(JSON.parse, () => null);
        if (!meta || Date.now() - meta.created > STALE_MS) {
          const uid = name.slice(0, -5);
          await rm(path.join(dir, `${uid}.part`), { force: true });
          await rm(path.join(dir, name), { force: true });
        }
      }
    },
  };

  /** Move a finished upload into media/ and check that it's a readable video. */
  async function finish(project, uid, meta, part) {
    await mkdir(project.mediaDir, { recursive: true });
    const name = safeFileName(meta.filename);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let file = path.join(project.mediaDir, name);
    for (let n = 2; await stat(file).catch(() => null); n++) file = path.join(project.mediaDir, `${stem}-${n}${ext}`);
    await rename(part, file);
    await rm(path.join(dirOf(project), `${uid}.json`), { force: true });
    try {
      await probe(project, file);
    } catch (err) {
      await rm(file, { force: true });
      throw new HttpError(422, `${meta.filename} couldn't be read as a video: ${String(err.message).split('\n').pop()}`);
    }
    return `media/${path.basename(file)}`;
  }
}

/**
 * Write the request body to the end of `file`, at most `room` bytes.
 * @returns {Promise<number>} bytes written
 */
function append(req, file, room) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file, { flags: 'a' });
    let written = 0;
    let failed = null;
    req.on('data', (chunk) => {
      if (failed) return;
      if (written + chunk.length > room) {
        failed = new HttpError(413, 'More bytes were sent than Upload-Length allows.');
        chunk = chunk.subarray(0, room - written);
      }
      written += chunk.length;
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    // A dropped connection keeps what arrived: the client resumes from there.
    let ended = false;
    const done = () => {
      if (ended) return;
      ended = true;
      out.end(() => (failed ? reject(failed) : resolve(written)));
    };
    req.on('end', done);
    req.on('close', done);
    req.on('error', done);
    out.on('error', reject);
  });
}

/** "filename ZmlsZS5tcDQ=,filetype dmlkZW8vbXA0" → { filename: "file.mp4", filetype: "video/mp4" } */
export function parseMetadata(header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const pair of header.split(',')) {
    const [key, value = ''] = pair.trim().split(' ');
    if (key) out[key] = Buffer.from(value, 'base64').toString('utf8');
  }
  return out;
}

