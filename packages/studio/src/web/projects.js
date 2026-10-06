// The project list: create, import a scene.json, open, delete.

import { useState } from 'preact/hooks';
import { ApiError } from './api.js';
import { formatBytes, timeAgo } from './scene.js';
import { createProject, deleteProject, notify, useStore } from './store.js';
import { Empty, Icon, Issues, Modal, TextInput, html } from './ui.js';

export function ProjectsPage() {
  const projects = useStore((s) => s.projects);
  const system = useStore((s) => s.system);
  const [title, setTitle] = useState('');
  const [importing, setImporting] = useState(false);

  const create = async (e) => {
    e.preventDefault();
    try {
      await createProject({ title: title.trim() || 'Untitled wall' });
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  return html`
    <div class="projects">
      <section class="projects-head">
        <div>
          <h1>Projects</h1>
          <p class="muted">Each project is a folder with its scene, uploaded videos and build output${system ? html` in <code>${system.dataDir}</code>` : ''}.</p>
        </div>
        <form class="new-project" onSubmit=${create}>
          <${TextInput} value=${title} onInput=${setTitle} placeholder="New wall title" ariaLabel="New project title" />
          <button class="button primary" type="submit"><${Icon} name="plus" /> New project</button>
          <button class="button" type="button" onClick=${() => setImporting(true)}><${Icon} name="file" /> Import scene.json</button>
        </form>
      </section>
      ${projects === null && html`<div class="loading">Loading…</div>`}
      ${projects?.length === 0 && html`<${Empty} title="No projects yet">Create one, then drop videos into its library.</${Empty}>`}
      <ul class="project-grid">
        ${(projects ?? []).map((p) => html`
          <li class="project-card">
            <a class="project-open" href=${`#/p/${encodeURIComponent(p.id)}/library`}>
              <h2>${p.title}</h2>
              <div class="muted">${p.videos} video${p.videos === 1 ? '' : 's'} · edited ${timeAgo(p.updatedAt)}</div>
              <div class="muted small">${p.invalid ? html`<span class="bad-text">scene.json is not valid JSON</span>`
                : p.lastBuild ? `Built ${timeAgo(p.lastBuild.at)}${p.lastBuild.size ? ` · ${formatBytes(p.lastBuild.size)}` : ''}` : 'Not built yet'}</div>
            </a>
            <button class="icon-button danger" aria-label=${`Delete ${p.title}`} title="Delete project"
              onClick=${async () => {
                if (!confirm(`Delete "${p.title}"? Its folder, uploaded videos and build output are removed from disk.`)) return;
                try {
                  await deleteProject(p.id);
                } catch (err) {
                  notify(err.message, 'error');
                }
              }}><${Icon} name="trash" /></button>
          </li>`)}
      </ul>
      ${importing && html`<${ImportDialog} onClose=${() => setImporting(false)} />`}
    </div>`;
}

function ImportDialog({ onClose }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [issues, setIssues] = useState([]);

  const submit = async () => {
    setError(null);
    setIssues([]);
    let scene;
    try {
      scene = JSON.parse(text);
    } catch (err) {
      setError(`Not valid JSON: ${err.message}`);
      return;
    }
    try {
      await createProject({ scene });
      onClose();
    } catch (err) {
      setError(err.message);
      if (err instanceof ApiError) setIssues(err.body?.issues ?? []);
    }
  };

  return html`
    <${Modal} title="Import a scene" onClose=${onClose} wide=${true} actions=${html`
      <button class="button" onClick=${onClose}>Cancel</button>
      <button class="button primary" disabled=${!text.trim()} onClick=${submit}>Create project</button>`}>
      <p class="muted">Paste a <code>scene.json</code> or choose the file. Video paths stay as they are: upload files with the same names to fill them in.</p>
      <input type="file" accept=".json,application/json" aria-label="Scene file"
        onChange=${async (e) => setText(await e.currentTarget.files?.[0]?.text() ?? '')} />
      <textarea class="input code" rows="14" placeholder='{ "title": "My wall", "videos": [ { "src": "media/clip.mp4" } ] }' value=${text}
        aria-label="Scene JSON" onInput=${(e) => setText(e.currentTarget.value)} />
      ${error && html`<p class="bad-text">${error}</p>`}
      <${Issues} issues=${issues} />
    </${Modal}>`;
}
