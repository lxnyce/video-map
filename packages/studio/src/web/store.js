// App state and actions. One immutable state object; components pick the parts
// they need with useStore(selector) and re-render only when those change.
//
// The open project keeps the scene being edited. Every edit is validated with
// the shared schema and saved shortly after (only valid scenes are saved),
// naming the revision it started from so a save can't undo a change made
// elsewhere. Edits are undoable.

import { useEffect, useReducer, useRef } from 'preact/hooks';
import { ApiError, followJobs, server, uploadsUrl } from './api.js';
import { addUpload, clone, validateDraft } from './scene.js';
import { createUploader } from './upload.js';

const SAVE_DELAY = 600;
const HISTORY = 100;

/**
 * @typedef {object} Session  the open project
 * @property {string} id
 * @property {string} dir
 * @property {any} scene
 * @property {string} rev
 * @property {string} savedText  JSON of the scene as last saved
 * @property {'saved'|'dirty'|'saving'|'invalid'|'conflict'|'error'} status
 * @property {Array<{ path: string, message: string }>} issues
 * @property {Array<{ path: string, message: string }>} warnings
 * @property {{ scene: any, rev: string } | null} conflict
 * @property {string|null} saveError
 * @property {Record<string, any>} probes  src → probe result
 * @property {Array<{ name: string, src: string, size: number }>} media
 * @property {any} lastBuild
 * @property {boolean} built
 * @property {number[]} selection  indexes into scene.videos
 * @property {any[]} past
 * @property {any[]} future
 * @property {string|null} parseError  scene.json on disk isn't valid JSON: nothing is saved until the JSON tab fixes it
 * @property {string|null} rawText  the broken file's text, for the JSON tab
 */

let state = {
  route: parseRoute(location.hash),
  system: null,
  settings: null,
  projects: null,
  /** @type {any[]} */
  jobs: [],
  connected: false,
  /** @type {Session|null} */
  project: null,
  /** @type {import('./upload.js').UploadItem[]} */
  uploads: [],
  /** @type {Array<{ id: number, message: string, kind: string }>} */
  toasts: [],
};
const listeners = new Set();

export function getState() {
  return state;
}

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

/** @param {Partial<Session>} patch */
function setProject(patch) {
  if (!state.project) return;
  set({ project: { ...state.project, ...patch } });
}

/**
 * Subscribe a component to part of the state.
 * @template T
 * @param {(s: typeof state) => T} selector
 * @returns {T}
 */
export function useStore(selector) {
  const [, force] = useReducer((n) => n + 1, 0);
  const value = selector(state);
  const ref = useRef(value);
  const pick = useRef(selector);
  ref.current = value;
  pick.current = selector;
  useEffect(() => {
    const check = () => {
      if (!Object.is(pick.current(state), ref.current)) force(undefined);
    };
    listeners.add(check);
    check();
    return () => listeners.delete(check);
  }, []);
  return value;
}

// --- Routing -----------------------------------------------------------------

/** "#/p/nature-wall/layout" → { page: 'project', id: 'nature-wall', tab: 'layout' } @param {string} hash */
export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { page: 'project', id: parts[1], tab: parts[2] ?? 'library' };
  return { page: 'projects' };
}

/** @param {string} hash */
export function go(hash) {
  if (location.hash !== hash) location.hash = hash;
}

window.addEventListener('hashchange', () => routeChanged(parseRoute(location.hash)));

async function routeChanged(route) {
  const leaving = state.project && (route.page !== 'project' || route.id !== state.project.id);
  if (leaving) await closeProject();
  set({ route });
  if (route.page === 'projects') loadProjects();
  else if (!state.project || state.project.id !== route.id) openProject(route.id);
}

// --- Toasts ------------------------------------------------------------------

let toastId = 0;
/** @param {string} message @param {'info'|'error'|'success'} [kind] */
export function notify(message, kind = 'info') {
  const id = ++toastId;
  set({ toasts: [...state.toasts, { id, message, kind }] });
  setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000);
}
/** @param {number} id */
export function dismiss(id) {
  set({ toasts: state.toasts.filter((t) => t.id !== id) });
}

// --- Start-up ----------------------------------------------------------------

export function start() {
  followJobs({
    snapshot: (jobs) => set({ jobs }),
    job: jobUpdated,
    status: (connected) => set({ connected }),
  });
  loadSystem();
  server.settings().then((settings) => set({ settings }), () => {});
  routeChanged(state.route);
  window.addEventListener('beforeunload', (e) => {
    const p = state.project;
    if ((p && p.status !== 'saved') || uploader?.busy()) {
      saveNow();
      e.preventDefault();
    }
  });
}

export async function loadSystem() {
  try {
    set({ system: await server.system() });
  } catch (err) {
    notify(`Couldn't reach the Studio server: ${err.message}`, 'error');
  }
}

export async function loadProjects() {
  try {
    set({ projects: await server.projects() });
  } catch (err) {
    notify(err.message, 'error');
  }
}

// --- Projects ----------------------------------------------------------------

/** @param {{ title?: string, scene?: any }} body */
export async function createProject(body) {
  const project = await server.createProject(body);
  go(`#/p/${encodeURIComponent(project.id)}/library`);
  return project;
}

/** @param {string} id */
export async function deleteProject(id) {
  await server.deleteProject(id);
  notify('Project deleted.');
  loadProjects();
}

/** @type {ReturnType<typeof createUploader>|null} */
let uploader = null;

/** @param {string} id */
async function openProject(id) {
  let data;
  try {
    data = await server.project(id);
  } catch (err) {
    notify(err.status === 404 ? `There is no project "${id}".` : err.message, 'error');
    go('#/');
    return;
  }
  const scene = data.scene ?? { videos: [] };
  const check = validateDraft(scene);
  /** @type {Session} */
  const session = {
    id,
    dir: data.dir,
    scene,
    rev: data.rev,
    savedText: JSON.stringify(scene),
    status: check.valid && !data.parseError ? 'saved' : 'invalid',
    issues: data.parseError ? [{ path: '(root)', message: `scene.json is not valid JSON: ${data.parseError}` }] : check.errors,
    warnings: check.warnings,
    conflict: null,
    saveError: null,
    probes: {},
    media: [],
    lastBuild: data.lastBuild,
    built: data.built,
    selection: [],
    past: [],
    future: [],
    parseError: data.parseError,
    rawText: data.text ?? null,
  };
  set({ project: session, uploads: [] });
  uploader = createUploader({
    endpoint: uploadsUrl(id),
    scope: id,
    onChange: (uploads) => set({ uploads }),
    onDone: (item) => uploaded(id, item),
  });
  refreshProbes();
  refreshMedia();
}

async function closeProject() {
  await saveNow();
  uploader = null;
  set({ project: null, uploads: [] });
}

export async function refreshMedia() {
  const p = state.project;
  if (!p) return;
  try {
    const media = await server.media(p.id);
    if (state.project?.id === p.id) setProject({ media });
  } catch {
    // shown as no files
  }
}

/** @param {File[]} files */
export function uploadFiles(files) {
  uploader?.add(files);
}
export const cancelUpload = (key) => uploader?.cancel(key);
export const retryUpload = (key) => uploader?.retry(key);
export const clearUploads = () => uploader?.clear();

/** A finished upload becomes a video on the wall (or fills in a missing file of the same name). */
function uploaded(id, item) {
  const p = state.project;
  if (!p || p.id !== id || !item.src) return;
  let relinked = false;
  editScene((scene) => {
    ({ relinked } = addUpload(scene, item.src, item.name, (src) => Boolean(state.project.probes[src]?.missing)));
  });
  if (relinked) notify(`${item.name} replaced the missing file of the same name.`, 'success');
  refreshMedia();
}

/** Add files already in media/ (e.g. uploaded before the page was closed). @param {string[]} srcs */
export function addMediaFiles(srcs) {
  editScene((scene) => {
    for (const src of srcs) addUpload(scene, src, src.split('/').pop() ?? src, () => false);
  });
}

// --- Editing -----------------------------------------------------------------

let saveTimer = null;
let lastCoalesce = null;
let lastEditAt = 0;

/**
 * Change the scene. `coalesce` merges a run of edits to the same field (typing)
 * into one undo step.
 * @param {(scene: any) => void} mutate
 * @param {{ coalesce?: string }} [opts]
 */
export function editScene(mutate, opts = {}) {
  const p = state.project;
  if (!p) return;
  if (p.parseError) {
    notify('scene.json on disk is not valid JSON. Fix it in the JSON tab first.', 'error');
    return;
  }
  const next = clone(p.scene);
  mutate(next);
  replaceScene(next, opts);
}

/**
 * Replace the whole scene (the JSON editor does this).
 * @param {any} next
 * @param {{ coalesce?: string }} [opts]
 */
export function replaceScene(next, opts = {}) {
  const p = state.project;
  if (!p) return;
  if (!p.parseError && JSON.stringify(next) === JSON.stringify(p.scene)) return;
  const now = Date.now();
  const merge = opts.coalesce && opts.coalesce === lastCoalesce && now - lastEditAt < 1500;
  lastCoalesce = opts.coalesce ?? null;
  lastEditAt = now;
  const past = merge ? p.past : [...p.past, p.scene].slice(-HISTORY);
  // A valid scene from the JSON tab replaces a broken file.
  applyScene(next, { past, future: [], parseError: null, rawText: null });
}

function applyScene(scene, extra) {
  const check = validateDraft(scene);
  const p = state.project;
  const selection = p.selection.filter((i) => i < (scene.videos?.length ?? 0));
  const broken = 'parseError' in extra ? extra.parseError : p.parseError;
  setProject({
    scene,
    ...extra,
    selection,
    issues: check.errors,
    warnings: check.warnings,
    status: p.status === 'conflict' ? 'conflict' : !check.valid || broken ? 'invalid' : JSON.stringify(scene) === p.savedText ? 'saved' : 'dirty',
  });
  scheduleSave();
  refreshProbes();
}

export function undo() {
  const p = state.project;
  if (!p?.past.length) return;
  lastCoalesce = null;
  applyScene(p.past[p.past.length - 1], { past: p.past.slice(0, -1), future: [p.scene, ...p.future] });
}

export function redo() {
  const p = state.project;
  if (!p?.future.length) return;
  lastCoalesce = null;
  applyScene(p.future[0], { past: [...p.past, p.scene], future: p.future.slice(1) });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

let saving = null;

/** Save now if there are valid unsaved changes. Resolves when saved (or not needed). */
export async function saveNow() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  const p = state.project;
  if (!p || p.status === 'conflict' || p.parseError) return;
  const text = JSON.stringify(p.scene);
  if (text === p.savedText || !validateDraft(p.scene).valid) return;
  setProject({ status: 'saving', saveError: null });
  saving = (async () => {
    try {
      const { rev } = await server.saveScene(p.id, p.scene, p.rev);
      if (state.project?.id !== p.id) return;
      const now = state.project;
      setProject({ rev, savedText: text, status: JSON.stringify(now.scene) === text ? 'saved' : 'dirty' });
      if (state.project.status === 'dirty') scheduleSave();
    } catch (err) {
      if (state.project?.id !== p.id) return;
      if (err instanceof ApiError && err.status === 409) {
        setProject({ status: 'conflict', conflict: { scene: err.body.scene, rev: err.body.rev } });
      } else if (err instanceof ApiError && err.status === 422) {
        setProject({ status: 'invalid', issues: err.body.issues ?? [] });
      } else {
        setProject({ status: 'error', saveError: err.message });
        saveTimer = setTimeout(saveNow, 5000);
      }
    } finally {
      saving = null;
    }
  })();
  await saving;
}

/** Resolve a save conflict. @param {'mine'|'theirs'} keep */
export async function resolveConflict(keep) {
  const p = state.project;
  if (!p?.conflict) return;
  const { scene, rev } = p.conflict;
  if (keep === 'theirs') {
    const check = validateDraft(scene);
    setProject({ conflict: null, rev, scene, savedText: JSON.stringify(scene), status: check.valid ? 'saved' : 'invalid', issues: check.errors, past: [...p.past, p.scene], future: [] });
    refreshProbes();
  } else {
    // Forget what was saved, so the save goes through even without new edits.
    setProject({ conflict: null, rev, status: 'dirty', savedText: '' });
    await saveNow();
  }
}

/** @param {number[]} selection */
export function select(selection) {
  setProject({ selection });
}

// --- Probes ------------------------------------------------------------------

const probing = new Set();
let probeTimer = null;

/** Probe the scene's videos that haven't been probed yet (debounced). */
export function refreshProbes() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    const p = state.project;
    if (!p) return;
    const srcs = [...new Set((p.scene.videos ?? []).map((v) => v.src))].filter((src) => src && !(src in p.probes) && !probing.has(src));
    if (!srcs.length) return;
    srcs.forEach((s) => probing.add(s));
    try {
      const { results } = await server.probe(p.id, srcs);
      if (state.project?.id === p.id) setProject({ probes: { ...state.project.probes, ...results } });
    } catch (err) {
      notify(`Couldn't read video details: ${err.message}`, 'error');
    } finally {
      srcs.forEach((s) => probing.delete(s));
    }
  }, 250);
}

// --- Builds ------------------------------------------------------------------

function jobUpdated(job, lines) {
  const i = state.jobs.findIndex((j) => j.id === job.id);
  const prev = i >= 0 ? state.jobs[i] : null;
  const merged = { ...job, log: [...(prev?.log ?? []), ...lines].slice(-400) };
  const jobs = i >= 0 ? state.jobs.map((j, k) => (k === i ? merged : j)) : [...state.jobs, merged];
  set({ jobs });
  const finished = prev && prev.state !== job.state && (job.state === 'done' || job.state === 'failed');
  if (finished && job.kind === 'build') {
    if (job.state === 'done') notify(`Build of ${job.project} finished in ${job.report?.seconds ?? '?'} s.`, 'success');
    else notify(`Build of ${job.project} failed: ${job.error}`, 'error');
    if (state.project?.id === job.project) {
      server.project(job.project).then((d) => setProject({ lastBuild: d.lastBuild, built: d.built }), () => {});
    }
  }
}

/** Queue a build of the open project (saving first). @param {{ dryRun?: boolean, rebuild?: boolean }} [opts] */
export async function startBuild(opts = {}) {
  const p = state.project;
  if (!p) return;
  await saveNow();
  if (state.project.status !== 'saved') {
    notify('Fix the scene\'s problems before building.', 'error');
    return;
  }
  try {
    await server.build(p.id, opts);
  } catch (err) {
    notify(err.message, 'error');
  }
}

/** @param {string} id */
export async function cancelJob(id) {
  try {
    await server.cancelJob(id);
  } catch (err) {
    notify(err.message, 'error');
  }
}

/** @param {any} update */
export async function saveSettings(update) {
  try {
    set({ settings: await server.saveSettings(update) });
  } catch (err) {
    notify(err.message, 'error');
  }
}

export async function retestHardware() {
  try {
    const hardware = await server.retestHardware();
    set({ system: { ...state.system, hardware } });
    notify('Hardware encoders re-tested.', 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
}
