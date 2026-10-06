// The Studio shell: header with tabs, save status and the build queue, and the
// page for the current route.

import { useEffect } from 'preact/hooks';
import { BuildTab } from './build.js';
import { JsonTab } from './json-tab.js';
import { LayoutTab } from './layout.js';
import { LibraryTab } from './library.js';
import { ProjectsPage } from './projects.js';
import { dismiss, go, redo, resolveConflict, undo, useStore } from './store.js';
import { Icon, html } from './ui.js';

const TABS = [
  { id: 'library', label: 'Library' },
  { id: 'layout', label: 'Layout & output' },
  { id: 'json', label: 'JSON' },
  { id: 'build', label: 'Build' },
];

export function App() {
  const route = useStore((s) => s.route);
  const project = useStore((s) => s.project);
  const system = useStore((s) => s.system);

  useEffect(() => {
    const key = (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const editing = target.closest('input, textarea, select, .cm-editor');
      if ((e.ctrlKey || e.metaKey) && !editing && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && !editing && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const inProject = route.page === 'project';
  return html`
    <div class="app">
      <header class="topbar">
        <a class="brand" href="#/" aria-label="All projects"><span class="brand-mark" aria-hidden="true" />VideoMap Studio</a>
        ${inProject && project && html`
          <span class="crumb" title=${project.dir}>${project.scene?.title || project.id}</span>
          <nav class="tabs" aria-label="Project">
            ${TABS.map((t) => html`<a class=${`tab${route.tab === t.id ? ' on' : ''}`} href=${`#/p/${encodeURIComponent(project.id)}/${t.id}`} aria-current=${route.tab === t.id ? 'page' : undefined}>${t.label}</a>`)}
          </nav>
          <div class="topbar-tools">
            <button class="icon-button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled=${!project.past.length} onClick=${undo}><${Icon} name="undo" /></button>
            <button class="icon-button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled=${!project.future.length} onClick=${redo}><${Icon} name="redo" /></button>
            <${SaveStatus} project=${project} />
          </div>`}
        <${QueueIndicator} />
      </header>
      ${system?.ffmpegError && html`<div class="banner error"><${Icon} name="alert" /> ${system.ffmpegError} Building and reading videos need ffmpeg; run <code>vmap doctor</code> for details.</div>`}
      ${system && !system.webBuilt && html`<div class="banner">The production UI isn't built (you're on the dev server, or run <code>npm run build:studio</code>).</div>`}
      ${project?.status === 'conflict' && html`
        <div class="banner warn">
          <${Icon} name="alert" /> The scene was changed somewhere else (another tab or an editor) since you opened it.
          <button class="button small" onClick=${() => resolveConflict('theirs')}>Load the other version</button>
          <button class="button small" onClick=${() => resolveConflict('mine')}>Keep mine</button>
        </div>`}
      ${project?.parseError && html`<div class="banner error"><${Icon} name="alert" /> scene.json on disk isn't valid JSON (${project.parseError}). Fix it in the JSON tab; saving replaces the file.</div>`}
      <main class="page">
        ${route.page === 'projects' && html`<${ProjectsPage} />`}
        ${inProject && !project && html`<div class="loading">Loading…</div>`}
        ${inProject && project && route.tab === 'library' && html`<${LibraryTab} />`}
        ${inProject && project && route.tab === 'layout' && html`<${LayoutTab} />`}
        ${inProject && project && route.tab === 'json' && html`<${JsonTab} />`}
        ${inProject && project && route.tab === 'build' && html`<${BuildTab} />`}
      </main>
      <${Toasts} />
    </div>`;
}

function SaveStatus({ project }) {
  const n = project.issues.length;
  const map = {
    saved: ['ok', 'Saved'],
    dirty: ['busy', 'Unsaved changes'],
    saving: ['busy', 'Saving…'],
    invalid: ['bad', `${n} problem${n === 1 ? '' : 's'}, not saved`],
    conflict: ['bad', 'Changed elsewhere'],
    error: ['bad', 'Save failed, retrying'],
  };
  const [kind, text] = map[project.status];
  const title = project.status === 'error' ? project.saveError : project.status === 'invalid' ? project.issues.map((i) => `${i.path}: ${i.message}`).join('\n') : undefined;
  const click = project.status === 'invalid' ? () => go(`#/p/${encodeURIComponent(project.id)}/json`) : undefined;
  return html`<button class=${`save-status ${kind}`} title=${title} onClick=${click} disabled=${!click} aria-live="polite">${text}</button>`;
}

function QueueIndicator() {
  const jobs = useStore((s) => s.jobs);
  const connected = useStore((s) => s.connected);
  const running = jobs.find((j) => j.state === 'running');
  const queued = jobs.filter((j) => j.state === 'queued').length;
  if (!connected) return html`<span class="queue offline" title="Reconnecting to the Studio server…">Offline</span>`;
  if (!running && !queued) return null;
  const phase = running?.phases.filter((p) => !p.endedAt).pop();
  return html`
    <a class="queue" href=${running ? `#/p/${encodeURIComponent(running.project)}/build` : undefined}>
      <span class="spinner" aria-hidden="true" />
      ${running ? `${running.kind === 'dry-run' ? 'Estimating' : 'Building'} ${running.project}${phase ? ` · ${phase.name} ${phase.done}/${phase.total}` : ''}` : ''}
      ${queued ? html`<span class="queue-count">${queued} queued</span>` : ''}
    </a>`;
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`
    <div class="toasts" role="status" aria-live="polite">
      ${toasts.map((t) => html`<div class=${`toast ${t.kind}`}><span>${t.message}</span><button class="icon-button" aria-label="Dismiss" onClick=${() => dismiss(t.id)}><${Icon} name="x" size=${14} /></button></div>`)}
    </div>`;
}
