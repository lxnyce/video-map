// Details of one video: a player for picking the preview start, and every
// field of its scene entry.

import { useRef, useState } from 'preact/hooks';
import { server, sourceUrl } from './api.js';
import { allTags, assignIds, colorFor, formatBytes, formatDuration, formatMetaValue, parseMetaValue, setPath } from './scene.js';
import { editScene, notify, refreshMedia, select, useStore } from './store.js';
import { Field, Icon, NumberInput, Select, TextInput, TokenInput, html } from './ui.js';

export function DetailsPanel({ index }) {
  const project = useStore((s) => s.project);
  const scene = project.scene;
  const v = scene.videos[index];
  const player = useRef(/** @type {HTMLVideoElement|null} */ (null));
  const [playable, setPlayable] = useState(true);
  if (!v) return null;
  const info = project.probes[v.src];
  const p = info?.probe;
  const id = assignIds(scene.videos)[index];
  const grid = (scene.layout?.pack ?? 'grid') === 'grid';
  const file = project.media.find((m) => m.src === v.src);

  /** Edit a field of this video; typing in one field is one undo step. */
  const edit = (keys, value) => editScene((s) => setPath(s.videos[index], keys, value), { coalesce: `${index}:${keys.join('.')}` });

  return html`
    <div class="panel details">
      <div class="panel-head">
        <h2 title=${v.title}>${v.title || id}</h2>
        <button class="icon-button" aria-label="Close details" onClick=${() => select([])}><${Icon} name="x" /></button>
      </div>
      ${info?.missing ? html`<div class="notice warn"><${Icon} name="alert" /><span>The file <code>${v.src}</code> is missing. Upload a file named <strong>${v.src.split('/').pop()}</strong> to fill it in.</span></div>`
        : info?.error ? html`<div class="notice warn"><${Icon} name="alert" /><span>${info.error}</span></div>`
          : info?.remote ? html`<p class="muted small">Remote video: details appear after a build reads it.</p>`
            : html`
              <div class="player">
                ${playable ? html`<video ref=${player} src=${sourceUrl(project.id, v.src)} controls muted playsinline preload="metadata" onError=${() => setPlayable(false)} />`
                  : html`<div class="thumb placeholder"><${Icon} name="film" /><span>The browser can't play this format; the build will convert it.</span></div>`}
              </div>`}
      ${p && html`<div class="facts muted small">${formatDuration(p.duration)} · ${p.width}×${p.height} · ${Math.round(p.fps * 100) / 100} fps · ${p.videoCodec}${p.audioCodec ? ` + ${p.audioCodec}` : ', no audio'}${p.hdr ? ' · HDR' : ''}${file ? ` · ${formatBytes(file.size)}` : ''}</div>`}

      <div class="form">
        <${Field} label="Title"><${TextInput} value=${v.title ?? ''} placeholder=${id} onInput=${(t) => edit(['title'], t)} ariaLabel="Title" /></${Field}>
        <${Field} label="Description"><${TextInput} multiline=${true} value=${v.description ?? ''} onInput=${(t) => edit(['description'], t)} ariaLabel="Description" /></${Field}>
        <${Field} label="Categories">
          <div class="chip-list">
            ${(scene.categories ?? []).map((c) => {
              const on = (v.categories ?? []).includes(c.id);
              return html`<button class=${`chip toggle${on ? ' on' : ''}`} aria-pressed=${on}
                onClick=${() => edit(['categories'], on ? (v.categories.length > 1 ? v.categories.filter((x) => x !== c.id) : undefined) : [...(v.categories ?? []), c.id])}>
                <span class="dot" style=${`background:${c.color ?? colorFor(c.id)}`} />${c.label ?? c.id}</button>`;
            })}
            ${(v.categories ?? []).filter((c) => !(scene.categories ?? []).some((x) => x.id === c)).map((c) => html`<span class="chip warn" title="Not in the scene's category list">${c}</span>`)}
            ${!(scene.categories ?? []).length && html`<span class="muted small">No categories yet (add them with nothing selected).</span>`}
          </div>
        </${Field}>
        <${Field} label="Tags" hint="Tags like place:Kyoto can group the wall (group by tag:place).">
          <${TokenInput} values=${v.tags ?? []} suggestions=${allTags(scene)} ariaLabel="Tags" onChange=${(tags) => edit(['tags'], tags.length ? tags : undefined)} />
        </${Field}>
        <${Field} label="Preview start" hint=${`Seconds into the video where its ${scene.preview?.duration ?? 10} s loop on the wall begins. Empty: chosen automatically.`}>
          <div class="row">
            <${NumberInput} value=${v.previewStart} min=${0} placeholder="auto" ariaLabel="Preview start" onChange=${(n) => edit(['previewStart'], n)} />
            ${p && playable && html`<button class="button small" onClick=${() => {
              const t = player.current?.currentTime;
              if (t !== undefined) edit(['previewStart'], Math.round(t * 10) / 10);
            }}>Use player time</button>`}
          </div>
        </${Field}>
        ${grid && html`<${Field} label="Fit in its cell">
          <${Select} ariaLabel="Fit" value=${v.fit ?? null} onChange=${(f) => edit(['fit'], f ?? undefined)}
            options=${[{ value: null, label: `Scene default (${scene.layout?.fit ?? 'contain'})` }, { value: 'contain', label: 'Contain: whole frame' }, { value: 'cover', label: 'Cover: crop to fill' }]} />
        </${Field}>`}
        <${Field} label="Id" hint="Used in links to this video (#v=…). Empty: from the file name.">
          <${TextInput} value=${v.id ?? ''} placeholder=${id} ariaLabel="Id" onInput=${(t) => edit(['id'], t)} />
        </${Field}>
        <${Field} label="File"><code class="small break">${v.src}</code></${Field}>
        <${Field} label="Poster image" hint="Optional image path; otherwise a frame is used.">
          <${TextInput} value=${v.poster ?? ''} onInput=${(t) => edit(['poster'], t)} ariaLabel="Poster" />
        </${Field}>
        <h3>Credits</h3>
        <${Field} label="Author"><${TextInput} value=${v.credits?.author ?? ''} onInput=${(t) => edit(['credits', 'author'], t)} ariaLabel="Author" /></${Field}>
        <${Field} label="License"><${TextInput} value=${v.credits?.license ?? ''} placeholder="CC-BY-4.0" onInput=${(t) => edit(['credits', 'license'], t)} ariaLabel="License" /></${Field}>
        <${Field} label="Source URL"><${TextInput} value=${v.credits?.url ?? ''} onInput=${(t) => edit(['credits', 'url'], t)} ariaLabel="Source URL" /></${Field}>
        <h3>Links</h3>
        <${Links} links=${v.links ?? []} onChange=${(links) => edit(['links'], links.length ? links : undefined)} />
        <h3>More details</h3>
        <${Meta} meta=${v.meta ?? {}} onChange=${(meta) => edit(['meta'], Object.keys(meta).length ? meta : undefined)} />
      </div>
      <div class="panel-section">
        <button class="button danger" onClick=${async () => {
          const uploaded = /^media\/[^/]+$/.test(v.src) && !scene.videos.some((x, i) => i !== index && x.src === v.src);
          if (!confirm(`Remove "${v.title ?? id}" from the wall?`)) return;
          const removeFile = uploaded && confirm(`Also delete the uploaded file ${v.src}?`);
          editScene((s) => { s.videos.splice(index, 1); });
          select([]);
          if (removeFile) {
            await server.deleteMedia(project.id, v.src.slice(6)).catch((err) => notify(err.message, 'error'));
            refreshMedia();
          }
        }}><${Icon} name="trash" /> Remove from wall</button>
      </div>
    </div>`;
}

function Links({ links, onChange }) {
  const set = (i, key, value) => onChange(links.map((l, k) => {
    if (k !== i) return l;
    const next = { ...l };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  }));
  return html`
    <div class="rows">
      ${links.map((l, i) => html`
        <div class="row" key=${i}>
          <${TextInput} value=${l.label ?? ''} placeholder="Label" ariaLabel="Link label" onInput=${(t) => set(i, 'label', t)} />
          <${TextInput} value=${l.href ?? ''} placeholder="https://…" ariaLabel="Link address" onInput=${(t) => set(i, 'href', t)} />
          <button class="icon-button" aria-label="Remove link" onClick=${() => onChange(links.filter((_, k) => k !== i))}><${Icon} name="x" size=${14} /></button>
        </div>`)}
      <button class="button small" onClick=${() => onChange([...links, { label: '', href: 'https://' }])}><${Icon} name="plus" size=${14} /> Add link</button>
    </div>`;
}

/** Free-form key/value details (`meta`). Numbers and true/false keep their type. */
function Meta({ meta, onChange }) {
  const entries = Object.entries(meta);
  const rename = (from, to) => {
    if (!to || to === from || to in meta) return;
    onChange(Object.fromEntries(entries.map(([k, v]) => [k === from ? to : k, v])));
  };
  return html`
    <div class="rows">
      ${entries.map(([k, value]) => html`
        <div class="row" key=${k}>
          <input class="input" value=${k} aria-label="Detail name" onChange=${(e) => rename(k, e.currentTarget.value.trim())} />
          <${TextInput} value=${formatMetaValue(value)} ariaLabel=${`Value of ${k}`} onInput=${(t) => onChange({ ...meta, [k]: parseMetaValue(t) })} />
          <button class="icon-button" aria-label=${`Remove ${k}`} onClick=${() => { const next = { ...meta }; delete next[k]; onChange(next); }}><${Icon} name="x" size=${14} /></button>
        </div>`)}
      <button class="button small" onClick=${() => {
        let key = 'detail';
        for (let n = 2; key in meta; n++) key = `detail${n}`;
        onChange({ ...meta, [key]: '' });
      }}><${Icon} name="plus" size=${14} /> Add detail</button>
    </div>`;
}
