// The Studio API over HTTP: projects, scene saves, settings, the request
// guard, tus uploads, and (with ffmpeg) probes, thumbnails, a queued build
// followed over SSE, the preview and the zip export.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { checkOrigin, parseMetadata, safeFileName, startStudio } from '../src/server/index.js';
import { readZip } from './zip-reader.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);

describe('studio helpers', () => {
  it('keeps upload names readable and safe', () => {
    assert.equal(safeFileName('Coral Reef (4K).mp4'), 'Coral Reef (4K).mp4');
    assert.equal(safeFileName('../../etc/passwd.mp4'), 'passwd.mp4');
    assert.equal(safeFileName('a<b>:c|d?.MOV'), 'a_b__c_d_.mov');
    assert.equal(safeFileName('CON.mp4'), 'video_CON.mp4');
    assert.equal(safeFileName(' .mp4'), 'video.mp4');
    assert.equal(safeFileName('Café.webm'), 'Café.webm');
  });

  it('parses tus metadata', () => {
    const b64 = (s) => Buffer.from(s).toString('base64');
    assert.deepEqual(parseMetadata(`filename ${b64('clip one.mp4')},filetype ${b64('video/mp4')},flag`), { filename: 'clip one.mp4', filetype: 'video/mp4', flag: '' });
  });

  it('refuses other hosts and cross-site writes', () => {
    const req = (method, headers) => /** @type {any} */ ({ method, headers });
    assert.equal(checkOrigin(req('GET', { host: 'localhost:5170' })), null);
    assert.equal(checkOrigin(req('GET', { host: '127.0.0.1:5170' })), null);
    assert.equal(checkOrigin(req('GET', { host: '[::1]:5170' })), null);
    assert.equal(checkOrigin(req('GET', { host: '192.168.1.20:5170' })), null);
    assert.match(checkOrigin(req('GET', { host: 'evil.example:5170' })), /not allowed/);
    assert.equal(checkOrigin(req('GET', { host: 'studio.lan' }), ['studio.lan']), null);
    assert.equal(checkOrigin(req('POST', { host: 'localhost:5170', origin: 'http://localhost:5170' })), null);
    assert.equal(checkOrigin(req('POST', { host: 'localhost:5170' })), null, 'no Origin: not a browser');
    assert.match(checkOrigin(req('POST', { host: 'localhost:5170', origin: 'https://evil.example' })), /not allowed/);
    assert.match(checkOrigin(req('PUT', { host: 'localhost:5170', origin: 'null' })), /opaque/);
  });
});

describe('studio API', () => {
  let dir;
  let studio;
  let base;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-studio-'));
    process.env.VMAP_HW_CACHE = path.join(dir, 'hw-cache.json');
    studio = await startStudio({ dataDir: path.join(dir, 'data'), port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${studio.port}`;
  });
  after(async () => {
    await studio?.close();
    delete process.env.VMAP_HW_CACHE;
    await rm(dir, { recursive: true, force: true });
  });

  const api = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };

  it('creates, lists, saves and deletes projects', async () => {
    const created = await api('POST', '/api/projects', { title: 'Nature Wall' });
    assert.equal(created.status, 201);
    assert.equal(created.data.id, 'nature-wall');
    assert.deepEqual(created.data.scene.videos, []);
    assert.equal((await api('POST', '/api/projects', { title: 'Nature Wall' })).data.id, 'nature-wall-2', 'ids stay unique');

    const list = await api('GET', '/api/projects');
    assert.deepEqual(list.data.map((p) => p.id).sort(), ['nature-wall', 'nature-wall-2']);

    // Saves name the revision they edited.
    const { rev } = created.data;
    const scene = { ...created.data.scene, description: 'Forests and oceans' };
    const saved = await api('PUT', '/api/projects/nature-wall/scene', { scene, rev });
    assert.equal(saved.status, 200);
    assert.notEqual(saved.data.rev, rev);
    const stale = await api('PUT', '/api/projects/nature-wall/scene', { scene: { ...scene, title: 'Old tab' }, rev });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.scene.description, 'Forests and oceans', 'a conflict returns the current scene');
    const invalid = await api('PUT', '/api/projects/nature-wall/scene', { scene: { ...scene, layout: { pack: 'spiral' } }, rev: saved.data.rev });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.data.issues[0].path, 'layout.pack');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'data/nature-wall/scene.json'), 'utf8'));
    assert.equal(onDisk.description, 'Forests and oceans', 'scene.json is a plain vmap scene');

    const imported = await api('POST', '/api/projects/nature-wall-2/import', { title: 'Imported', videos: [{ src: 'media/a.mp4' }] });
    assert.equal(imported.status, 200);
    assert.equal((await api('GET', '/api/projects/nature-wall-2')).data.scene.title, 'Imported');
    assert.equal((await api('POST', '/api/projects/nature-wall-2/import', { videos: 'nope' })).status, 422);

    const fromScene = await api('POST', '/api/projects', { scene: { title: 'From JSON', videos: [{ src: 'x.mp4', title: 'X' }] } });
    assert.equal(fromScene.data.id, 'from-json');
    assert.equal(fromScene.data.scene.videos[0].title, 'X');

    assert.equal((await api('DELETE', '/api/projects/from-json')).status, 204);
    assert.equal((await api('GET', '/api/projects/from-json')).status, 404);
    assert.equal((await api('GET', '/api/projects/..%2F..')).status, 404);
  });

  it('keeps build settings per machine and checks them', async () => {
    assert.equal((await api('GET', '/api/settings')).data.hardware, 'auto');
    const bad = await api('PUT', '/api/settings', { hardware: 'gpu', hardwareJobs: 0, color: 'red' });
    assert.equal(bad.status, 422);
    assert.equal(bad.data.errors.length, 3);
    const ok = await api('PUT', '/api/settings', { hardware: 'off', jobs: 2 });
    assert.equal(ok.data.hardware, 'off');
    assert.equal(ok.data.jobs, 2);
    const stored = JSON.parse(await readFile(path.join(dir, 'data/settings.json'), 'utf8'));
    assert.equal(stored.hardware, 'off');
  });

  it('refuses requests from other sites', async () => {
    const raw = (method, headers) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: studio.port, path: '/api/projects', method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{"title":"x"}' : undefined);
    });
    assert.equal(await raw('GET', { Host: 'attacker.example' }), 403, 'DNS rebinding');
    assert.equal(await raw('POST', { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }), 403);
    assert.equal(await raw('POST', { 'Content-Type': 'text/plain' }), 415, 'a simple cross-site form post is not JSON');
  });

  it('accepts resumable tus uploads', async () => {
    const opts = await fetch(`${base}/api/projects/nature-wall/uploads`, { method: 'OPTIONS' });
    assert.equal(opts.headers.get('tus-version'), '1.0.0');
    assert.match(opts.headers.get('tus-extension'), /creation/);

    const tus = { 'Tus-Resumable': '1.0.0' };
    const meta = (name) => `filename ${Buffer.from(name).toString('base64')}`;
    const refused = await fetch(`${base}/api/projects/nature-wall/uploads`, { method: 'POST', headers: { ...tus, 'Upload-Length': '4', 'Upload-Metadata': meta('notes.txt') } });
    assert.equal(refused.status, 415);

    const created = await fetch(`${base}/api/projects/nature-wall/uploads`, { method: 'POST', headers: { ...tus, 'Upload-Length': '10', 'Upload-Metadata': meta('clip.mp4') } });
    assert.equal(created.status, 201);
    const url = base + created.headers.get('location');
    const patch = (offset, body) => fetch(url, { method: 'PATCH', headers: { ...tus, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body });
    const first = await patch(0, 'hello');
    assert.equal(first.status, 204);
    assert.equal(first.headers.get('upload-offset'), '5');
    assert.equal((await fetch(url, { method: 'HEAD', headers: tus })).headers.get('upload-offset'), '5', 'HEAD tells where to resume');
    const wrong = await patch(2, 'xxx');
    assert.equal(wrong.status, 409);
    assert.equal(wrong.headers.get('upload-offset'), '5');
    // Not a video: the last chunk lands, ffprobe can't read it, so it's refused and deleted.
    const last = await patch(5, 'world');
    assert.equal(last.status, 422);
    assert.match((await last.json()).error, /couldn't be read as a video/);
    assert.deepEqual((await api('GET', '/api/projects/nature-wall/media')).data, []);

    const abandoned = await fetch(`${base}/api/projects/nature-wall/uploads`, { method: 'POST', headers: { ...tus, 'Upload-Length': '10', 'Upload-Metadata': meta('b.mp4') } });
    const abandonedUrl = base + abandoned.headers.get('location');
    assert.equal((await fetch(abandonedUrl, { method: 'DELETE', headers: tus })).status, 204);
    assert.equal((await fetch(abandonedUrl, { method: 'HEAD', headers: tus })).status, 404);
  });

  it('has nothing to preview or export before a build', async () => {
    assert.equal((await fetch(`${base}/preview/nature-wall/`)).status, 404);
    assert.equal((await api('GET', '/api/projects/nature-wall/export.zip')).status, 404);
    const r = await api('POST', '/api/projects/nature-wall/build', {});
    assert.equal(r.status, 422);
    assert.match(r.data.error, /at least one video/);
  });

  describe('with ffmpeg', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 180_000 }, () => {
    const clips = {};
    before(async () => {
      for (const [name, size, d] of /** @type {Array<[string, string, number]>} */ ([['wide.mp4', '320x180', 2], ['tall.mp4', '180x320', 3]])) {
        const file = path.join(dir, name);
        await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=20:d=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
        clips[name] = await readFile(file);
      }
    });

    /** Upload a file in two PATCH requests, resuming from HEAD in between. */
    async function upload(name, data) {
      const tus = { 'Tus-Resumable': '1.0.0' };
      const created = await fetch(`${base}/api/projects/nature-wall/uploads`, {
        method: 'POST',
        headers: { ...tus, 'Upload-Length': String(data.length), 'Upload-Metadata': `filename ${Buffer.from(name).toString('base64')}` },
      });
      const url = base + created.headers.get('location');
      const half = Math.floor(data.length / 2);
      const send = (offset, body) => fetch(url, { method: 'PATCH', headers: { ...tus, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body });
      await send(0, data.subarray(0, half));
      const offset = Number((await fetch(url, { method: 'HEAD', headers: tus })).headers.get('upload-offset'));
      const done = await send(offset, data.subarray(offset));
      assert.equal(done.status, 204);
      return decodeURIComponent(done.headers.get('x-vmap-src'));
    }

    it('uploads, probes and thumbnails videos', async () => {
      assert.equal(await upload('wide.mp4', clips['wide.mp4']), 'media/wide.mp4');
      assert.equal(await upload('tall.mp4', clips['tall.mp4']), 'media/tall.mp4');
      assert.equal(await upload('wide.mp4', clips['wide.mp4']), 'media/wide-2.mp4', 'same name: made unique');
      assert.deepEqual((await api('GET', '/api/projects/nature-wall/media')).data.map((m) => m.name), ['tall.mp4', 'wide-2.mp4', 'wide.mp4']);
      assert.equal((await api('DELETE', '/api/projects/nature-wall/media/wide-2.mp4')).status, 204);

      const probes = await api('POST', '/api/projects/nature-wall/probe', { srcs: ['media/wide.mp4', 'media/tall.mp4', 'media/gone.mp4', '../../secret.mp4', 'https://example.com/v.mp4'] });
      const r = probes.data.results;
      assert.equal(r['media/wide.mp4'].probe.width, 320);
      assert.equal(r['media/tall.mp4'].probe.height, 320);
      assert.equal(r['media/tall.mp4'].probe.duration, 3);
      assert.equal(r['media/gone.mp4'].missing, true);
      assert.equal(r['../../secret.mp4'].error, 'not allowed', 'only project files and files the scene names');
      assert.equal(r['https://example.com/v.mp4'].remote, true);

      const thumb = await fetch(`${base}/api/projects/nature-wall/thumb?src=media/tall.mp4`);
      assert.equal(thumb.status, 200);
      assert.match(thumb.headers.get('content-type'), /image\//);
      const again = await fetch(`${base}/api/projects/nature-wall/thumb?src=media/tall.mp4`, { headers: { 'If-None-Match': thumb.headers.get('etag') } });
      assert.equal(again.status, 304);
      const source = await fetch(`${base}/api/projects/nature-wall/source?src=media/wide.mp4`, { headers: { Range: 'bytes=0-9' } });
      assert.equal(source.status, 206);
      assert.equal((await source.arrayBuffer()).byteLength, 10);
    });

    it('queues a build, streams its progress, previews and exports it', async () => {
      const { data: project } = await api('GET', '/api/projects/nature-wall');
      const scene = {
        ...project.scene,
        preview: { duration: 1, fps: 6 },
        output: { cell: '64x36', tile: '128x72' },
        categories: [{ id: 'a', label: 'Alpha' }],
        videos: [
          { id: 'wide', src: 'media/wide.mp4', title: 'Wide', categories: ['a'] },
          { id: 'tall', src: 'media/tall.mp4', title: 'Tall', categories: ['a'] },
        ],
      };
      assert.equal((await api('PUT', '/api/projects/nature-wall/scene', { scene, rev: project.rev })).status, 200);

      // Follow the queue over SSE.
      const events = [];
      const controller = new AbortController();
      const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const finished = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return null;
          buffer += decoder.decode(value, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            const payload = JSON.parse(data);
            events.push({ event, payload });
            if (event === 'job' && payload.job.kind === 'build' && ['done', 'failed', 'cancelled'].includes(payload.job.state)) return payload.job;
          }
        }
      })();

      const dry = await api('POST', '/api/projects/nature-wall/build', { dryRun: true });
      assert.equal(dry.status, 202);
      const queued = await api('POST', '/api/projects/nature-wall/build', {});
      assert.equal(queued.data.state, 'queued', 'waits for the dry run');
      assert.equal((await api('POST', '/api/projects/nature-wall/build', {})).data.id, queued.data.id, 'asking again reuses the queued build');

      const job = await finished;
      controller.abort();
      assert.equal(job.state, 'done', job.error);
      assert.equal(events[0].event, 'snapshot');
      const dryDone = events.find((e) => e.event === 'job' && e.payload.job.id === dry.data.id && e.payload.job.state === 'done');
      assert.ok(dryDone, 'the dry run finished first');
      assert.equal(dryDone.payload.job.report.dryRun ?? true, true);
      assert.ok(job.phases.some((p) => p.name === 'Tiles' && p.done === p.total), 'phases stream with counts');
      const lines = events.filter((e) => e.event === 'job' && e.payload.job.id === job.id).flatMap((e) => e.payload.lines);
      assert.ok(lines.some((l) => /^Tiles: \d+\/\d+/.test(l)), 'log lines stream');
      assert.equal(job.report.videos, 2);

      const full = await api('GET', `/api/jobs/${job.id}`);
      assert.ok(full.data.log.length > 0);
      assert.equal((await api('GET', '/api/projects/nature-wall')).data.lastBuild.report.videos, 2);
      const listed = (await api('GET', '/api/projects')).data.find((p) => p.id === 'nature-wall');
      assert.equal(listed.lastBuild.videos, 2);

      const redirect = await fetch(`${base}/preview/nature-wall`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      const page = await fetch(`${base}/preview/nature-wall/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/i);
      const manifest = await (await fetch(`${base}/preview/nature-wall/scene.json`)).json();
      assert.equal(manifest.videos.length, 2);

      const zip = await fetch(`${base}/api/projects/nature-wall/export.zip`);
      assert.equal(zip.status, 200);
      assert.match(zip.headers.get('content-disposition'), /nature-wall\.zip/);
      const buf = Buffer.from(await zip.arrayBuffer());
      assert.equal(buf.length, Number(zip.headers.get('content-length')));
      const names = readZip(buf).entries.map((e) => e.name);
      assert.ok(names.includes('nature-wall/index.html'));
      assert.ok(names.includes('nature-wall/scene.json'));
      assert.ok(names.some((n) => n.startsWith('nature-wall/tiles/')));
      assert.ok(names.every((n) => n.startsWith('nature-wall/')));

      const storage = await api('GET', '/api/projects/nature-wall/storage');
      assert.ok(storage.data.dist > 0 && storage.data.cache > 0 && storage.data.media > 0);
      const cleaned = await api('POST', '/api/projects/nature-wall/clean', {});
      assert.ok(cleaned.data.freed > 0);
      assert.equal(await stat(path.join(dir, 'data/nature-wall/.vmap-cache')).catch(() => null), null);
    });

    it('cancels a running build', async () => {
      const { data: job } = await api('POST', '/api/projects/nature-wall/build', { rebuild: true });
      for (let i = 0; i < 100 && (await api('GET', `/api/jobs/${job.id}`)).data.state === 'queued'; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal((await api('DELETE', `/api/jobs/${job.id}`)).status, 200);
      let state;
      for (let i = 0; i < 200; i++) {
        state = (await api('GET', `/api/jobs/${job.id}`)).data.state;
        if (state !== 'running' && state !== 'queued') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(state, 'cancelled');
      assert.equal((await api('DELETE', '/api/projects/nature-wall')).status, 204, 'nothing running blocks deleting it');
    });
  });
});
