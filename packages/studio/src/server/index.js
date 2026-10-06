// VideoMap Studio server: the JSON API, resumable uploads, the build queue
// (streamed over Server-Sent Events), build previews, zip export and the web
// UI. Single-user and local by default: it listens on 127.0.0.1 and refuses
// requests that could come from other websites (see checkOrigin).

import { readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildScene,
  cleanCache,
  createTools,
  defaultJobs,
  detectCapabilities,
  detectHardware,
  dirSize,
  serveFile,
  serveStatic,
} from '@videomap/builder';
import { HttpError, checkOrigin, createRouter, readJson, sendJson, sendText } from './http.js';
import { JobQueue, summary } from './jobs.js';
import { MediaInfo } from './media.js';
import { ProjectStore, validateDraft } from './projects.js';
import { SettingsStore, checkSettings } from './settings.js';
import { TUS_VERSION, createUploads } from './uploads.js';
import { zipStream } from './zip.js';

export { ProjectStore, validateDraft } from './projects.js';
export { planZip, zipStream } from './zip.js';
export { safeFileName, parseMetadata } from './uploads.js';
export { checkOrigin } from './http.js';

const WEB_DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const MAX_PROBES = 5000;

/** The default data folder: ~/VideoMap Studio, or $VMAP_STUDIO_DATA. */
export function defaultDataDir() {
  return process.env.VMAP_STUDIO_DATA ? path.resolve(process.env.VMAP_STUDIO_DATA) : path.join(os.homedir(), 'VideoMap Studio');
}

/**
 * @typedef {object} StudioOptions
 * @property {string} [dataDir]     where projects and settings live (default: defaultDataDir())
 * @property {number} [port]        default 5170; 0 picks a free port
 * @property {string} [host]        default 127.0.0.1 (this computer only)
 * @property {string[]} [allowHosts] extra Host names to accept besides localhost and IP addresses
 * @property {string} [ffmpeg]
 * @property {string} [ffprobe]
 * @property {string} [webDist]     built web UI (default: this package's dist/)
 */

/** @param {StudioOptions} [opts] */
export async function startStudio(opts = {}) {
  const dataDir = path.resolve(opts.dataDir ?? defaultDataDir());
  const store = new ProjectStore(dataDir);
  await store.init();
  const settings = new SettingsStore(dataDir);
  await settings.load();
  const tools = createTools({ ffmpeg: opts.ffmpeg, ffprobe: opts.ffprobe });
  const webDist = path.resolve(opts.webDist ?? WEB_DIST);

  // ffmpeg's capabilities and working hardware encoders, detected on first use.
  let capsPromise = null;
  const caps = () => {
    capsPromise ??= detectCapabilities(tools).catch((err) => {
      capsPromise = null; // try again next time, e.g. after installing ffmpeg
      throw err;
    });
    return capsPromise;
  };
  let hardwarePromise = null;
  const hardware = (refresh = false) => {
    if (refresh || !hardwarePromise) {
      hardwarePromise = caps().then((c) => detectHardware(tools, c, { refresh })).catch((err) => {
        hardwarePromise = null;
        throw err;
      });
    }
    return hardwarePromise;
  };

  const media = new MediaInfo({ tools, caps, jobs: Math.max(2, Math.min(8, defaultJobs())) });
  const getProject = async (id) => {
    if (!(await store.exists(id))) throw new HttpError(404, `There is no project "${id}".`);
    return store.open(id);
  };
  const uploads = createUploads({ project: getProject, probe: (project, file) => media.probe(project, file) });

  const jobs = new JobQueue(async (job, { signal, progress }) => {
    const project = store.open(job.project);
    const s = settings.value;
    const result = await buildScene({
      scenePath: project.scenePath,
      outDir: project.distDir,
      cacheDir: project.cacheDir,
      overrides: { build: { hardware: s.hardware, hardwareFinal: s.hardwareFinal, hardwareJobs: s.hardwareJobs } },
      jobs: s.jobs ?? undefined,
      keepCache: s.keepCache,
      dryRun: job.kind === 'dry-run',
      rebuild: Boolean(job.options.rebuild),
      ffmpeg: opts.ffmpeg,
      ffprobe: opts.ffprobe,
      signal,
      progress,
    });
    if (!result.dryRun) await project.saveLastBuild({ at: Date.now(), report: result.report });
    return result.report;
  });

  for (const p of await store.list()) await uploads.sweep(store.open(p.id)).catch(() => {});

  const router = createRouter();
  const api = (method, pattern, handler) => router.add(method, pattern, handler);

  // --- System and settings -------------------------------------------------

  api('GET', '/api/system', async (req, res) => {
    const out = { dataDir, defaultJobs: defaultJobs(), tus: TUS_VERSION, ffmpeg: null, ffmpegError: null, hardware: null, webBuilt: await exists(path.join(webDist, 'index.html')) };
    try {
      out.ffmpeg = await caps();
      out.hardware = await hardware();
    } catch (err) {
      out.ffmpegError = err.message;
    }
    sendJson(res, 200, out);
  });

  api('POST', '/api/system/hardware', async (req, res) => {
    sendJson(res, 200, await hardware(true));
  });

  api('GET', '/api/settings', (req, res) => sendJson(res, 200, settings.value));

  api('PUT', '/api/settings', async (req, res) => {
    const { settings: update, errors } = checkSettings(await readJson(req));
    if (errors.length) throw new HttpError(422, errors.join(' '), { errors });
    sendJson(res, 200, await settings.save(update));
  });

  // --- Projects -------------------------------------------------------------

  api('GET', '/api/projects', async (req, res) => sendJson(res, 200, await store.list()));

  api('POST', '/api/projects', async (req, res) => {
    const body = await readJson(req);
    const result = await store.create({ title: body.title, scene: body.scene });
    if ('error' in result) throw new HttpError(422, result.error, { issues: result.issues });
    sendJson(res, 201, await projectDetails(result.project));
  });

  api('GET', '/api/projects/:id', async (req, res, { params }) => {
    sendJson(res, 200, await projectDetails(await getProject(params.id)));
  });

  api('DELETE', '/api/projects/:id', async (req, res, { params }) => {
    const project = await getProject(params.id);
    if (jobs.active(project.id).length) throw new HttpError(409, 'A build of this project is queued or running; cancel it first.');
    media.forget(project);
    await store.remove(project.id);
    res.writeHead(204).end();
  });

  // Save the scene. The client names the revision it edited, so a save can't
  // silently undo a change made elsewhere (another tab, or a text editor).
  api('PUT', '/api/projects/:id/scene', async (req, res, { params }) => {
    const project = await getProject(params.id);
    const body = await readJson(req);
    if (!body.scene || typeof body.scene !== 'object') throw new HttpError(400, 'Send { scene, rev }.');
    const result = await project.write(body.scene, typeof body.rev === 'string' ? body.rev : null);
    if (result.ok) return sendJson(res, 200, { rev: result.rev });
    if (result.conflict) {
      const current = await project.read();
      throw new HttpError(409, 'The scene was changed elsewhere since it was loaded.', { rev: current.rev, scene: current.scene });
    }
    throw new HttpError(422, 'The scene has problems.', { issues: result.issues });
  });

  // Replace the scene with a pasted or uploaded manifest.
  api('POST', '/api/projects/:id/import', async (req, res, { params }) => {
    const project = await getProject(params.id);
    const scene = await readJson(req);
    const result = await project.write(scene, null);
    if (!result.ok) throw new HttpError(422, 'The scene has problems.', { issues: result.issues });
    sendJson(res, 200, { rev: result.rev, scene });
  });

  api('GET', '/api/projects/:id/media', async (req, res, { params }) => {
    sendJson(res, 200, await (await getProject(params.id)).media());
  });

  api('DELETE', '/api/projects/:id/media/:name', async (req, res, { params }) => {
    const project = await getProject(params.id);
    const file = path.join(project.mediaDir, params.name);
    if (path.dirname(file) !== project.mediaDir || params.name.startsWith('.')) throw new HttpError(400, 'Not a media file.');
    await rm(file, { force: true });
    res.writeHead(204).end();
  });

  // Probe results for a list of scene paths (the layout preview and size estimate need them).
  api('POST', '/api/projects/:id/probe', async (req, res, { params }) => {
    const project = await getProject(params.id);
    const { srcs } = await readJson(req);
    if (!Array.isArray(srcs) || srcs.length > MAX_PROBES) throw new HttpError(400, `Send { srcs: [...] } with at most ${MAX_PROBES} paths.`);
    const results = {};
    await Promise.all([...new Set(srcs.map(String))].map(async (src) => {
      if (/^https?:\/\//i.test(src)) {
        results[src] = { remote: true };
        return;
      }
      const file = await project.resolveSource(src);
      if (!file) {
        results[src] = { error: 'not allowed' };
        return;
      }
      if (!(await exists(file))) {
        results[src] = { missing: true };
        return;
      }
      try {
        results[src] = { probe: await media.probe(project, file) };
      } catch (err) {
        results[src] = { error: String(err.message).split('\n').pop() };
      }
    }));
    sendJson(res, 200, { results });
  });

  api('GET', '/api/projects/:id/thumb', async (req, res, { params, url }) => {
    const project = await getProject(params.id);
    const file = await sourceFile(project, url.searchParams.get('src'));
    const thumb = await media.thumbnail(project, file);
    const etag = `"${thumb.etag}"`;
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, { ETag: etag }).end();
    const info = await stat(thumb.file);
    serveFile(thumb.file, info.size, req, res, { ETag: etag, 'Cache-Control': 'no-cache' });
  });

  // The source file itself, so the details panel can play it and pick a preview start.
  api('GET', '/api/projects/:id/source', async (req, res, { params, url }) => {
    const project = await getProject(params.id);
    const file = await sourceFile(project, url.searchParams.get('src'));
    const info = await stat(file);
    serveFile(file, info.size, req, res);
  });

  api('OPTIONS', '/api/projects/:id/uploads', uploads.options);
  api('POST', '/api/projects/:id/uploads', uploads.create);
  api('HEAD', '/api/projects/:id/uploads/:uid', uploads.head);
  api('PATCH', '/api/projects/:id/uploads/:uid', uploads.patch);
  api('DELETE', '/api/projects/:id/uploads/:uid', uploads.remove);

  // --- Builds -------------------------------------------------------------

  api('POST', '/api/projects/:id/build', async (req, res, { params }) => {
    const project = await getProject(params.id);
    const body = await readJson(req);
    const kind = body.dryRun ? 'dry-run' : 'build';
    const { scene, parseError } = await project.read();
    if (parseError) throw new HttpError(422, `scene.json is not valid JSON: ${parseError}`);
    if (!scene.videos?.length) throw new HttpError(422, 'Add at least one video before building.');
    // Asking again for a build that is still waiting in the queue doesn't queue a second one.
    const waiting = jobs.active(project.id).find((j) => j.state === 'queued' && j.kind === kind && Boolean(j.options.rebuild) === Boolean(body.rebuild));
    const job = waiting ?? jobs.add({ project: project.id, kind, options: { rebuild: Boolean(body.rebuild) } });
    sendJson(res, waiting ? 200 : 202, summary(job));
  });

  api('GET', '/api/projects/:id/storage', async (req, res, { params }) => {
    const project = await getProject(params.id);
    const [mediaBytes, dist, cache] = await Promise.all([dirSize(project.mediaDir), dirSize(project.distDir), dirSize(project.cacheDir)]);
    sendJson(res, 200, { media: mediaBytes, dist, cache });
  });

  api('POST', '/api/projects/:id/clean', async (req, res, { params }) => {
    const project = await getProject(params.id);
    if (jobs.active(project.id).length) throw new HttpError(409, 'A build of this project is queued or running; wait for it or cancel it first.');
    const freed = await cleanCache(project.cacheDir);
    sendJson(res, 200, { freed: freed ?? 0 });
  });

  api('GET', '/api/projects/:id/export.zip', async (req, res, { params }) => {
    const project = await getProject(params.id);
    if (!(await exists(path.join(project.distDir, 'scene.json')))) throw new HttpError(404, 'Build the project before exporting it.');
    if (jobs.active(project.id).some((j) => j.state === 'running' && j.kind === 'build')) {
      throw new HttpError(409, 'A build is writing the output; download it when the build finishes.');
    }
    const entries = await listFiles(project.distDir, project.id);
    const { stream, size } = zipStream(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${project.id}.zip"`,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  api('GET', '/api/jobs', (req, res) => sendJson(res, 200, jobs.list()));

  api('GET', '/api/jobs/:id', (req, res, { params }) => {
    const job = jobs.get(params.id);
    if (!job) throw new HttpError(404, 'No such job.');
    sendJson(res, 200, job);
  });

  api('DELETE', '/api/jobs/:id', (req, res, { params }) => {
    if (!jobs.get(params.id)) throw new HttpError(404, 'No such job.');
    jobs.cancel(params.id);
    sendJson(res, 200, summary(jobs.get(params.id)));
  });

  // Live job updates. The first event is a snapshot of every job (with logs);
  // after that, changed jobs and new log lines, batched every 200 ms.
  api('GET', '/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', { jobs: jobs.jobs });
    /** @type {Map<string, { job: any, lines: string[] }>} */
    const pending = new Map();
    let timer = null;
    const flush = () => {
      timer = null;
      for (const [, p] of pending) send('job', { job: summary(p.job), lines: p.lines });
      pending.clear();
    };
    const queue = (job, line) => {
      const p = pending.get(job.id) ?? { job, lines: [] };
      if (line !== undefined) p.lines.push(line);
      pending.set(job.id, p);
      timer ??= setTimeout(flush, 200);
    };
    const onChange = (job) => queue(job);
    const onLog = (job, line) => queue(job, line);
    jobs.on('change', onChange);
    jobs.on('log', onLog);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
      jobs.off('change', onChange);
      jobs.off('log', onLog);
      clearInterval(keepAlive);
      if (timer) clearTimeout(timer);
    });
  });

  // --- Build previews and the web UI -------------------------------------

  router.add('GET', '/preview/:id/*', async (req, res, { params, url }) => {
    const project = await getProject(params.id);
    if (!url.pathname.endsWith('/') && !params['*']) {
      res.writeHead(302, { Location: `${url.pathname}/${url.search}` });
      return res.end();
    }
    if (!(await exists(path.join(project.distDir, 'scene.json')))) return sendText(res, 404, 'This project has not been built yet.');
    await serveStatic(project.distDir, `/${params['*']}`, req, res);
  });

  router.add('GET', '/*', async (req, res, { params }) => {
    if (params['*'] === 'api' || params['*'].startsWith('api/')) throw new HttpError(404, 'Not found');
    if (!(await exists(path.join(webDist, 'index.html')))) {
      return sendText(res, 503, 'The Studio web UI is not built. Run "npm run build:studio" in the video-map folder, then reload.');
    }
    await serveStatic(webDist, `/${params['*']}`, req, res);
  });

  const allowHosts = (opts.allowHosts ?? []).map((h) => h.toLowerCase());
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        const { headers = {}, ...details } = err.details ?? {};
        return sendJson(res, err.status, { error: err.message, ...details }, headers);
      }
      console.error(err);
      sendJson(res, 500, { error: err.message });
    });
  });
  // Uploads and zips can take a long time; don't cut them off.
  server.requestTimeout = 0;

  async function handle(req, res) {
    const refusal = checkOrigin(req, allowHosts);
    if (refusal) throw new HttpError(403, refusal);
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      throw new HttpError(400, 'Bad request');
    }
    const found = router.match(req.method ?? 'GET', url.pathname);
    if (found === 'method') throw new HttpError(405, 'Method not allowed');
    if (!found) throw new HttpError(404, 'Not found');
    await found.handler(req, res, { params: found.params, url });
  }

  async function projectDetails(project) {
    const { scene, rev, parseError, text } = await project.read();
    return {
      id: project.id,
      dir: project.dir,
      scene,
      rev,
      parseError,
      text: parseError ? text : undefined,
      lastBuild: await project.lastBuild(),
      built: await exists(path.join(project.distDir, 'scene.json')),
    };
  }

  /** @param {import('./projects.js').Project} project @param {string|null} src */
  async function sourceFile(project, src) {
    const file = await project.resolveSource(src ?? '');
    if (!file) throw new HttpError(403, 'That file is not part of this project.');
    if (!(await exists(file))) throw new HttpError(404, `File not found: ${src}`);
    return file;
  }

  const port = opts.port ?? 5170;
  const host = opts.host ?? '127.0.0.1';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  const urls = [`http://localhost:${actual}/`];
  if (host === '0.0.0.0' || host === '::') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${actual}/`);
    }
  }

  return {
    server,
    port: actual,
    url: urls[0],
    urls,
    dataDir,
    jobs,
    store,
    /** Stop accepting requests, cancel builds and close open connections (SSE streams stay open otherwise). */
    async close() {
      for (const j of jobs.jobs) jobs.cancel(j.id);
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      });
    },
  };
}

/** Every file under `dir`, named `<prefix>/<relative path>` for the zip. */
async function listFiles(dir, prefix) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    // Half-written files of an interrupted build are not part of the output.
    if (/\.partial-\d+\.\w+$/.test(e.name)) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    const s = await stat(file);
    out.push({ name: `${prefix}/${path.relative(dir, file).split(path.sep).join('/')}`, file, size: s.size, mtime: s.mtime });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function exists(p) {
  return stat(p).then(() => true, () => false);
}
