// The library: the scene's videos as a grid or table, with uploads (drop files
// anywhere on the tab), search, selection, bulk edits and the categories.

import { useMemo, useRef, useState } from 'preact/hooks';
import { server, thumbUrl } from './api.js';
import { DetailsPanel } from './details.js';
import {
  allTags,
  bulkEdit,
  colorFor,
  formatBytes,
  formatDuration,
  matchesQuery,
  nextCategoryColor,
  removeCategory,
  removeVideos,
  renameCategory,
  slugify,
} from './scene.js';
import {
  addMediaFiles,
  cancelUpload,
  clearUploads,
  editScene,
  notify,
  refreshMedia,
  retryUpload,
  select,
  uploadFiles,
  useStore,
} from './store.js';
import { Empty, Icon, ProgressBar, Select, TextInput, TokenInput, html } from './ui.js';

const ACCEPT = 'video/*,.mkv,.avi,.mts,.ts,.wmv,.flv,.ogv,.3gp,.m4v,.mov,.mpg,.mpeg';

export function LibraryTab() {
  const project = useStore((s) => s.project);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(null);
  const [view, setView] = useState(() => readPref('vmap-library-view', 'grid'));
  const [dragging, setDragging] = useState(false);
  const anchor = useRef(-1);
  const fileInput = useRef(null);
  const depth = useRef(0);

  const scene = project.scene;
  const videos = scene.videos ?? [];
  const cats = scene.categories ?? [];
  const shown = useMemo(() => videos.map((v, i) => i).filter((i) => {
    const v = videos[i];
    if (category === '__none') return !(v.categories?.length);
    if (category && !(v.categories ?? []).includes(category)) return false;
    return matchesQuery(v, query);
  }), [videos, query, category]);
  const selection = project.selection;
  const selected = new Set(selection);

  const onPick = (i, e) => {
    if (e.shiftKey && anchor.current >= 0) {
      const a = shown.indexOf(anchor.current);
      const b = shown.indexOf(i);
      const range = shown.slice(Math.min(a, b), Math.max(a, b) + 1);
      select([...new Set([...(e.ctrlKey || e.metaKey ? selection : []), ...range])]);
    } else if (e.ctrlKey || e.metaKey) {
      select(selected.has(i) ? selection.filter((x) => x !== i) : [...selection, i]);
      anchor.current = i;
    } else {
      select(selected.has(i) && selection.length === 1 ? [] : [i]);
      anchor.current = i;
    }
  };

  const used = new Set(videos.map((v) => v.src));
  const orphans = project.media.filter((m) => !used.has(m.src));
  const missing = videos.filter((v) => project.probes[v.src]?.missing).length;

  const drop = (e) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) uploadFiles(files);
  };

  return html`
    <div class=${`library${dragging ? ' dragging' : ''}`}
      onDragEnter=${(e) => { if (e.dataTransfer?.types.includes('Files')) { depth.current++; setDragging(true); } }}
      onDragLeave=${() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }}
      onDragOver=${(e) => e.preventDefault()}
      onDrop=${drop}>
      <div class="library-main">
        <div class="toolbar">
          <div class="search">
            <${Icon} name="search" />
            <input class="input" type="search" placeholder="Search titles, tags, files…" value=${query} aria-label="Search videos" onInput=${(e) => setQuery(e.currentTarget.value)} />
          </div>
          <${Select} ariaLabel="Category filter" value=${category} onChange=${setCategory}
            options=${[{ value: null, label: 'All categories' }, ...cats.map((c) => ({ value: c.id, label: c.label ?? c.id })), { value: '__none', label: 'No category' }]} />
          <div class="segmented" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked=${view === 'grid'} class=${view === 'grid' ? 'on' : ''} title="Grid" aria-label="Grid view" onClick=${() => { setView('grid'); writePref('vmap-library-view', 'grid'); }}><${Icon} name="grid" /></button>
            <button role="radio" aria-checked=${view === 'table'} class=${view === 'table' ? 'on' : ''} title="Table" aria-label="Table view" onClick=${() => { setView('table'); writePref('vmap-library-view', 'table'); }}><${Icon} name="list" /></button>
          </div>
          <span class="muted count">${shown.length === videos.length ? `${videos.length} videos` : `${shown.length} of ${videos.length}`}</span>
          <button class="button primary" onClick=${() => fileInput.current?.click()}><${Icon} name="upload" /> Add videos</button>
          <input ref=${fileInput} type="file" multiple accept=${ACCEPT} hidden data-testid="upload-input"
            onChange=${(e) => { uploadFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ''; }} />
        </div>

        <${Uploads} />

        ${orphans.length > 0 && html`
          <div class="notice">
            <${Icon} name="folder" />
            <span>${orphans.length} uploaded file${orphans.length === 1 ? ' is' : 's are'} not on the wall: ${orphans.slice(0, 3).map((o) => o.name).join(', ')}${orphans.length > 3 ? '…' : ''}</span>
            <button class="button small" onClick=${() => addMediaFiles(orphans.map((o) => o.src))}>Add ${orphans.length === 1 ? 'it' : 'them'}</button>
            <button class="button small" onClick=${async () => {
              if (!confirm(`Delete ${orphans.length} unused file(s) from the project's media folder?`)) return;
              for (const o of orphans) await server.deleteMedia(project.id, o.name).catch((err) => notify(err.message, 'error'));
              refreshMedia();
            }}>Delete</button>
          </div>`}
        ${missing > 0 && html`
          <div class="notice warn"><${Icon} name="alert" /><span>${missing} video file${missing === 1 ? ' is' : 's are'} missing. Upload files with the same names to fill them in.</span></div>`}

        ${videos.length === 0 ? html`
          <${Empty} icon="upload" title="Drop videos here">
            <p>Or use <strong>Add videos</strong>. Uploads resume if the connection drops; each file is checked with ffprobe and added to the wall.</p>
          </${Empty}>`
        : view === 'grid' ? html`<${VideoGrid} project=${project} indexes=${shown} selected=${selected} onPick=${onPick} />`
        : html`<${VideoTable} project=${project} indexes=${shown} selected=${selected} onPick=${onPick} />`}
        ${dragging && html`<div class="drop-overlay"><${Icon} name="upload" size=${42} /><div>Drop to upload</div></div>`}
      </div>
      <aside class="library-side">
        ${selection.length === 1 && html`<${DetailsPanel} key=${selection[0]} index=${selection[0]} />`}
        ${selection.length > 1 && html`<${BulkPanel} project=${project} indexes=${selection} />`}
        ${selection.length === 0 && html`<${CategoriesPanel} scene=${scene} />`}
      </aside>
    </div>`;
}

function Uploads() {
  const uploads = useStore((s) => s.uploads);
  if (!uploads.length) return null;
  const finished = uploads.filter((u) => u.state === 'done' || u.state === 'error').length;
  return html`
    <div class="uploads">
      <div class="uploads-head">
        <strong>Uploads</strong>
        <span class="muted">${uploads.filter((u) => u.state === 'done').length} of ${uploads.length} done</span>
        ${finished > 0 && html`<button class="button small" onClick=${clearUploads}>Clear finished</button>`}
      </div>
      <ul>
        ${uploads.map((u) => html`
          <li class=${`upload ${u.state}`}>
            <span class="upload-name" title=${u.name}>${u.name}</span>
            <${ProgressBar} value=${u.sent} max=${u.size} label=${`Upload of ${u.name}`} />
            <span class="upload-state">${
              u.state === 'error' ? u.error
                : u.state === 'processing' ? 'Checking…'
                  : u.state === 'done' ? 'Added'
                    : u.state === 'queued' ? 'Waiting'
                      : u.error ?? `${Math.round((u.sent / Math.max(1, u.size)) * 100)}% of ${formatBytes(u.size)}`}</span>
            ${u.state === 'error' && html`<button class="button small" onClick=${() => retryUpload(u.key)}>Retry</button>`}
            ${u.state !== 'done' && html`<button class="icon-button" aria-label=${`Cancel ${u.name}`} onClick=${() => cancelUpload(u.key)}><${Icon} name="x" size=${14} /></button>`}
          </li>`)}
      </ul>
    </div>`;
}

/** Thumbnail, or a placeholder for missing and unreadable files. */
function Thumb({ project, video }) {
  const info = project.probes[video.src];
  const [failed, setFailed] = useState(false);
  if (info?.missing) return html`<div class="thumb placeholder bad"><${Icon} name="alert" /><span>Missing file</span></div>`;
  if (info?.error) return html`<div class="thumb placeholder bad" title=${info.error}><${Icon} name="alert" /><span>Unreadable</span></div>`;
  if (info?.remote) return html`<div class="thumb placeholder"><${Icon} name="link" /><span>Remote</span></div>`;
  if (!info || failed) return html`<div class="thumb placeholder"><${Icon} name="film" /></div>`;
  return html`<img class="thumb" loading="lazy" alt="" src=${thumbUrl(project.id, video.src)} onError=${() => setFailed(true)} />`;
}

function categoryColor(scene, id) {
  return (scene.categories ?? []).find((c) => c.id === id)?.color ?? colorFor(id);
}

function VideoGrid({ project, indexes, selected, onPick }) {
  const videos = project.scene.videos;
  return html`
    <ul class="video-grid" role="listbox" aria-multiselectable="true" aria-label="Videos">
      ${indexes.map((i) => {
        const v = videos[i];
        const p = project.probes[v.src]?.probe;
        return html`
          <li key=${`${i}|${v.src}`} class=${`video-card${selected.has(i) ? ' selected' : ''}`} role="option" aria-selected=${selected.has(i)} tabIndex="0"
            onClick=${(e) => onPick(i, e)} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(i, e); } }}>
            <div class="thumb-box"><${Thumb} project=${project} video=${v} /></div>
            <div class="video-meta">
              <div class="video-title" title=${v.title ?? v.src}>${v.title || v.id || v.src}</div>
              <div class="muted small">${p ? `${formatDuration(p.duration)} · ${p.width}×${p.height}` : ' '}</div>
              <div class="dots">
                ${(v.categories ?? []).map((c) => html`<span class="dot" style=${`background:${categoryColor(project.scene, c)}`} title=${c} />`)}
                ${v.tags?.length ? html`<span class="muted small">${v.tags.length} tag${v.tags.length === 1 ? '' : 's'}</span>` : ''}
              </div>
            </div>
          </li>`;
      })}
    </ul>`;
}

function VideoTable({ project, indexes, selected, onPick }) {
  const videos = project.scene.videos;
  const all = indexes.length > 0 && indexes.every((i) => selected.has(i));
  return html`
    <div class="table-wrap">
      <table class="video-table">
        <thead><tr>
          <th><input type="checkbox" aria-label="Select all" checked=${all} onChange=${() => select(all ? [] : indexes)} /></th>
          <th></th><th>Title</th><th>Categories</th><th>Tags</th><th>Length</th><th>Size</th><th>File</th>
        </tr></thead>
        <tbody>
          ${indexes.map((i) => {
            const v = videos[i];
            const p = project.probes[v.src]?.probe;
            return html`
              <tr key=${`${i}|${v.src}`} class=${selected.has(i) ? 'selected' : ''} onClick=${(e) => { if (!e.target.closest('input')) onPick(i, e); }}>
                <td><input type="checkbox" aria-label=${`Select ${v.title ?? v.src}`} checked=${selected.has(i)} onChange=${(e) => onPick(i, { ctrlKey: true, shiftKey: e.shiftKey })} /></td>
                <td class="table-thumb"><${Thumb} project=${project} video=${v} /></td>
                <td><${TextInput} value=${v.title ?? ''} placeholder=${v.id ?? ''} ariaLabel="Title" onInput=${(t) => editScene((s) => { if (t) s.videos[i].title = t; else delete s.videos[i].title; }, { coalesce: `title:${i}` })} /></td>
                <td>${(v.categories ?? []).map((c) => html`<span class="chip small"><span class="dot" style=${`background:${categoryColor(project.scene, c)}`} />${c}</span>`)}</td>
                <td class="muted">${(v.tags ?? []).join(', ')}</td>
                <td class="num">${p ? formatDuration(p.duration) : ''}</td>
                <td class="num">${p ? `${p.width}×${p.height}` : ''}</td>
                <td class="muted file" title=${v.src}>${v.src}</td>
              </tr>`;
          })}
        </tbody>
      </table>
    </div>`;
}

function BulkPanel({ project, indexes }) {
  const scene = project.scene;
  const cats = scene.categories ?? [];
  const [tags, setTags] = useState([]);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const picked = indexes.map((i) => scene.videos[i]).filter(Boolean);
  const usedCats = [...new Set(picked.flatMap((v) => v.categories ?? []))];
  const usedTags = [...new Set(picked.flatMap((v) => v.tags ?? []))].sort();
  const apply = (op) => editScene((s) => bulkEdit(s, indexes, op));

  return html`
    <div class="panel">
      <div class="panel-head"><h2>${indexes.length} videos selected</h2><button class="button small" onClick=${() => select([])}>Clear</button></div>
      <div class="panel-section">
        <h3>Categories</h3>
        ${cats.length === 0 && html`<p class="muted small">Add categories in the panel shown when nothing is selected.</p>`}
        <div class="chip-list">
          ${cats.map((c) => {
            const count = picked.filter((v) => (v.categories ?? []).includes(c.id)).length;
            const all = count === picked.length;
            return html`<button class=${`chip toggle${all ? ' on' : count ? ' some' : ''}`} aria-pressed=${all}
              onClick=${() => apply({ type: all ? 'removeCategory' : 'addCategory', value: c.id })}>
              <span class="dot" style=${`background:${c.color ?? colorFor(c.id)}`} />${c.label ?? c.id}${count && !all ? ` (${count})` : ''}</button>`;
          })}
          ${usedCats.filter((c) => !cats.some((x) => x.id === c)).map((c) => html`<button class="chip toggle some" onClick=${() => apply({ type: 'removeCategory', value: c })}>${c} ×</button>`)}
        </div>
      </div>
      <div class="panel-section">
        <h3>Add tags</h3>
        <div class="row">
          <${TokenInput} values=${tags} onChange=${setTags} suggestions=${allTags(scene)} placeholder="tag, place:Kyoto…" ariaLabel="Tags to add" />
          <button class="button small" disabled=${!tags.length} onClick=${() => { apply({ type: 'addTags', value: tags }); setTags([]); }}>Add</button>
        </div>
        ${usedTags.length > 0 && html`
          <h3>Remove a tag</h3>
          <div class="chip-list">${usedTags.map((t) => html`<button class="chip toggle" onClick=${() => apply({ type: 'removeTag', value: t })}>${t} ×</button>`)}</div>`}
      </div>
      ${(scene.layout?.pack ?? 'grid') === 'grid' && html`
        <div class="panel-section">
          <h3>Fit in the grid cell</h3>
          <${Select} ariaLabel="Fit" value=${null} onChange=${(v) => v !== null && apply({ type: 'setFit', value: v || undefined })}
            options=${[{ value: null, label: 'Change…' }, { value: '', label: 'Scene default' }, { value: 'contain', label: 'Contain (whole frame)' }, { value: 'cover', label: 'Cover (crop to fill)' }]} />
        </div>`}
      <div class="panel-section">
        <label class="check"><input type="checkbox" checked=${deleteFiles} onChange=${(e) => setDeleteFiles(e.currentTarget.checked)} /> Also delete their uploaded files</label>
        <button class="button danger" onClick=${async () => {
          if (!confirm(`Remove ${indexes.length} videos from the wall${deleteFiles ? ' and delete their uploaded files' : ''}?`)) return;
          const files = deleteFiles ? picked.map((v) => v.src).filter((s) => /^media\/[^/]+$/.test(s)) : [];
          editScene((s) => removeVideos(s, indexes));
          select([]);
          for (const f of files) await server.deleteMedia(project.id, f.slice(6)).catch((err) => notify(err.message, 'error'));
          if (files.length) refreshMedia();
        }}><${Icon} name="trash" /> Remove from wall</button>
      </div>
    </div>`;
}

function CategoriesPanel({ scene }) {
  const cats = scene.categories ?? [];
  const [name, setName] = useState('');
  const counts = new Map();
  for (const v of scene.videos ?? []) for (const c of v.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);

  const add = (e) => {
    e.preventDefault();
    const label = name.trim();
    if (!label) return;
    const base = slugify(label) || 'category';
    let id = base;
    for (let n = 2; cats.some((c) => c.id === id); n++) id = `${base}-${n}`;
    editScene((s) => { s.categories = [...(s.categories ?? []), { id, label, color: nextCategoryColor(s.categories ?? []) }]; });
    setName('');
  };

  return html`
    <div class="panel">
      <div class="panel-head"><h2>Categories</h2></div>
      <p class="muted small">Videos are grouped by category on the wall by default. Select videos to assign them; select one to edit its details.</p>
      <ul class="category-list">
        ${cats.map((c, i) => html`
          <li key=${c.id}>
            <input type="color" class="swatch" aria-label=${`Color of ${c.label ?? c.id}`} value=${toHex(c.color ?? colorFor(c.id))}
              onInput=${(e) => editScene((s) => { s.categories[i].color = e.currentTarget.value; }, { coalesce: `color:${c.id}` })} />
            <${TextInput} value=${c.label ?? ''} placeholder=${c.id} ariaLabel="Category label"
              onInput=${(t) => editScene((s) => { if (t) s.categories[i].label = t; else delete s.categories[i].label; }, { coalesce: `label:${c.id}` })} />
            <span class="muted small" title="Videos in this category">${counts.get(c.id) ?? 0}</span>
            <button class="icon-button" aria-label=${`Rename id of ${c.id}`} title=${`Id: ${c.id} (click to change)`}
              onClick=${() => {
                const next = prompt('New id (letters, digits, "-", "_" and "."):', c.id);
                if (!next || next === c.id) return;
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(next)) return notify('That id has characters that are not allowed.', 'error');
                if (cats.some((x) => x.id === next)) return notify(`There is already a category "${next}".`, 'error');
                editScene((s) => renameCategory(s, c.id, next));
              }}><code class="small">${c.id}</code></button>
            <button class="icon-button danger" aria-label=${`Delete category ${c.id}`}
              onClick=${() => { if (confirm(`Delete the category "${c.label ?? c.id}"? Its ${counts.get(c.id) ?? 0} video(s) stay on the wall.`)) editScene((s) => removeCategory(s, c.id)); }}>
              <${Icon} name="trash" size=${16} /></button>
          </li>`)}
      </ul>
      <form class="row" onSubmit=${add}>
        <${TextInput} value=${name} onInput=${setName} placeholder="New category" ariaLabel="New category" />
        <button class="button small" type="submit" disabled=${!name.trim()}><${Icon} name="plus" size=${14} /> Add</button>
      </form>
    </div>`;
}

/** Any CSS color → #rrggbb for <input type=color>. */
function toHex(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(color);
  if (!m) return '#888888';
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}
