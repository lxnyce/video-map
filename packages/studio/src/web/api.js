// Calls to the Studio server.

export class ApiError extends Error {
  /** @param {number} status @param {any} body */
  constructor(status, body) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} method
 * @param {string} url
 * @param {any} [body]  sent as JSON
 */
export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const p = (id) => `/api/projects/${encodeURIComponent(id)}`;

export const server = {
  system: () => api('GET', '/api/system'),
  retestHardware: () => api('POST', '/api/system/hardware'),
  settings: () => api('GET', '/api/settings'),
  saveSettings: (s) => api('PUT', '/api/settings', s),
  projects: () => api('GET', '/api/projects'),
  createProject: (body) => api('POST', '/api/projects', body),
  project: (id) => api('GET', p(id)),
  deleteProject: (id) => api('DELETE', p(id)),
  saveScene: (id, scene, rev) => api('PUT', `${p(id)}/scene`, { scene, rev }),
  importScene: (id, scene) => api('POST', `${p(id)}/import`, scene),
  media: (id) => api('GET', `${p(id)}/media`),
  deleteMedia: (id, name) => api('DELETE', `${p(id)}/media/${encodeURIComponent(name)}`),
  probe: (id, srcs) => api('POST', `${p(id)}/probe`, { srcs }),
  build: (id, opts) => api('POST', `${p(id)}/build`, opts),
  storage: (id) => api('GET', `${p(id)}/storage`),
  clean: (id) => api('POST', `${p(id)}/clean`, {}),
  job: (jobId) => api('GET', `/api/jobs/${jobId}`),
  cancelJob: (jobId) => api('DELETE', `/api/jobs/${jobId}`),
};

/** @param {string} id @param {string} src */
export const thumbUrl = (id, src) => `${p(id)}/thumb?src=${encodeURIComponent(src)}`;
/** @param {string} id @param {string} src */
export const sourceUrl = (id, src) => `${p(id)}/source?src=${encodeURIComponent(src)}`;
/** @param {string} id */
export const previewUrl = (id) => `/preview/${encodeURIComponent(id)}/`;
/** @param {string} id */
export const exportUrl = (id) => `${p(id)}/export.zip`;
/** @param {string} id */
export const uploadsUrl = (id) => `${p(id)}/uploads`;

/**
 * Follow the build queue. Reconnects on its own (EventSource does).
 * @param {{ snapshot: (jobs: any[]) => void, job: (job: any, lines: string[]) => void, status?: (connected: boolean) => void }} handlers
 */
export function followJobs(handlers) {
  const source = new EventSource('/api/events');
  source.addEventListener('snapshot', (e) => handlers.snapshot(JSON.parse(/** @type {MessageEvent} */ (e).data).jobs));
  source.addEventListener('job', (e) => {
    const { job, lines } = JSON.parse(/** @type {MessageEvent} */ (e).data);
    handlers.job(job, lines);
  });
  source.onopen = () => handlers.status?.(true);
  source.onerror = () => handlers.status?.(false);
  return () => source.close();
}
