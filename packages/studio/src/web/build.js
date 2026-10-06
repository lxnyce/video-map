// Build, follow its progress, preview the result, download it, and the
// machine's build settings (hardware encoding and parallel jobs).

import { useEffect, useRef, useState } from 'preact/hooks';
import { exportUrl, previewUrl, server } from './api.js';
import { formatBytes, timeAgo } from './scene.js';
import { cancelJob, notify, retestHardware, saveSettings, startBuild, useStore } from './store.js';
import { Field, Icon, Issues, NumberInput, ProgressBar, Select, Toggle, html } from './ui.js';

export function BuildTab() {
  const project = useStore((s) => s.project);
  const jobs = useStore((s) => s.jobs);
  const mine = jobs.filter((j) => j.project === project.id);
  const active = mine.find((j) => j.state === 'running') ?? mine.find((j) => j.state === 'queued');
  const latest = active ?? mine[mine.length - 1] ?? null;
  const [storage, setStorage] = useState(null);
  const [previewKey, setPreviewKey] = useState(0);
  const videos = project.scene.videos?.length ?? 0;
  const blocked = !videos ? 'Add videos first.' : project.status === 'invalid' ? 'Fix the scene\'s problems first.' : project.status === 'conflict' ? 'Resolve the save conflict first.' : null;

  const loadStorage = () => server.storage(project.id).then(setStorage, () => {});
  useEffect(() => { loadStorage(); }, [project.id, project.lastBuild?.at]);
  useEffect(() => { setPreviewKey((k) => k + 1); }, [project.lastBuild?.at]);

  const busy = Boolean(active);
  return html`
    <div class="build-tab">
      <div class="build-main">
        <section class="card">
          <div class="build-actions">
            <button class="button primary big" disabled=${Boolean(blocked) || (busy && active.kind === 'build')} onClick=${() => startBuild()}><${Icon} name="play" /> Build</button>
            <button class="button" disabled=${Boolean(blocked)} onClick=${() => startBuild({ dryRun: true })} title="Probe the videos and plan the pyramid without encoding">Estimate</button>
            <button class="button" disabled=${Boolean(blocked)} onClick=${() => { if (confirm('Re-encode everything from the sources, ignoring the cache?')) startBuild({ rebuild: true }); }}>Rebuild everything</button>
            ${active && html`<button class="button danger" onClick=${() => cancelJob(active.id)}><${Icon} name="stop" /> ${active.state === 'queued' ? 'Remove from queue' : 'Cancel'}</button>`}
            <span class="muted small">${blocked ?? (project.status !== 'saved' ? 'Unsaved changes are saved first.' : `${videos} video${videos === 1 ? '' : 's'}`)}</span>
          </div>
          ${latest ? html`<${JobView} job=${latest} />` : project.lastBuild ? html`<${Report} report=${project.lastBuild.report} at=${project.lastBuild.at} />`
            : html`<p class="muted">Not built yet. A build writes a static folder you can host anywhere: tiles, stills, posters${project.scene.output?.full?.enabled === false ? '' : ', full-resolution videos'} and the viewer.</p>`}
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Output</h2>
            ${project.built && html`
              <a class="button small" href=${previewUrl(project.id)} target="_blank" rel="noopener"><${Icon} name="external" size=${14} /> Open preview</a>
              <a class="button small" href=${exportUrl(project.id)} download><${Icon} name="download" size=${14} /> Download zip</a>`}
          </div>
          ${project.built ? html`<iframe key=${previewKey} class="preview-frame" title="Preview of the built wall" src=${previewUrl(project.id)} allow="fullscreen; autoplay" />`
            : html`<p class="muted">Build the project to preview it here.</p>`}
          <div class="storage muted small">
            <span>Project folder: <code>${project.dir}</code></span>
            ${storage && html`<span>Uploads ${formatBytes(storage.media)} · output ${formatBytes(storage.dist)} · build cache ${formatBytes(storage.cache)}</span>`}
            ${storage?.cache > 0 && html`<button class="button small" disabled=${busy} onClick=${async () => {
              if (!confirm('Delete the build cache? The next build re-encodes clips and tiles from the sources.')) return;
              try {
                const { freed } = await server.clean(project.id);
                notify(`Freed ${formatBytes(freed)}.`, 'success');
                loadStorage();
              } catch (err) {
                notify(err.message, 'error');
              }
            }}>Clear build cache</button>`}
          </div>
        </section>
      </div>
      <aside class="build-side"><${MachineSettings} /></aside>
    </div>`;
}

function JobView({ job }) {
  const log = useRef(null);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.log?.length]);
  const label = job.kind === 'dry-run' ? 'Estimate' : job.options?.rebuild ? 'Rebuild' : 'Build';
  const states = { queued: 'waiting in the queue', running: 'running', done: 'finished', failed: 'failed', cancelled: 'cancelled' };
  const elapsed = job.startedAt ? ((job.endedAt ?? Date.now()) - job.startedAt) / 1000 : 0;
  return html`
    <div class=${`job ${job.state}`}>
      <div class="job-head">
        <strong>${label} ${states[job.state]}</strong>
        ${job.startedAt && html`<span class="muted small">${job.state === 'running' ? 'started' : ''} ${timeAgo(job.startedAt)}${job.endedAt ? ` · took ${elapsed.toFixed(1)} s` : ''}</span>`}
      </div>
      ${job.phases.length > 0 && html`
        <ul class="phases">
          ${job.phases.map((p) => html`
            <li class=${p.endedAt ? 'ended' : ''}>
              <span class="phase-name">${p.name}</span>
              <${ProgressBar} value=${p.done} max=${p.total} label=${p.name} />
              <span class="muted small">${p.done}/${p.total}${p.cached ? ` (${p.cached} cached)` : ''}${eta(p)}</span>
            </li>`)}
        </ul>`}
      ${job.error && html`<p class="bad-text">${job.error}</p>`}
      <${Issues} issues=${job.issues} />
      ${job.report && html`<${Report} report=${job.report} dryRun=${job.kind === 'dry-run'} />`}
      ${job.log?.length > 0 && html`<details class="log" open=${job.state === 'failed'}><summary>Log (${job.log.length} lines)</summary><pre ref=${log}>${job.log.join('\n')}</pre></details>`}
    </div>`;
}

function eta(p) {
  if (p.endedAt) return '';
  const fresh = p.done - p.cached;
  const remaining = p.total - p.done;
  if (fresh < 2 || !remaining) return '';
  const secs = ((Date.now() - p.startedAt) / fresh) * remaining / 1000;
  return ` · about ${secs < 60 ? `${Math.ceil(secs)} s` : `${Math.round(secs / 60)} min`} left`;
}

function Report({ report: r, at = null, dryRun = false }) {
  if (!r) return null;
  const l = r.layout;
  const tiles = r.levels.reduce((n, x) => n + x.tiles, 0);
  const s = r.sizes;
  const e = r.estimate;
  return html`
    <div class="report">
      ${at && html`<p class="muted small">Last build ${timeAgo(at)}, ${r.seconds} s.</p>`}
      <dl class="stats">
        <div><dt>Videos</dt><dd>${r.videos}${r.looped ? ` · ${r.looped} short ones looped` : ''}</dd></div>
        <div><dt>${l.pack === 'masonry' ? 'Masonry' : 'Grid'}</dt><dd>${l.pack === 'masonry' ? `${l.columns} columns of ${l.columnWidth} px` : `${l.cols} × ${l.rows} cells of ${l.cell.w}×${l.cell.h}`} → ${l.width} × ${l.height} px</dd></div>
        <div><dt>Pyramid</dt><dd>${r.levels.length} levels, ${tiles} tiles of ${r.tile.w}×${r.tile.h}${r.alternates.length ? ` · plus ${r.alternates.length} alternate layout(s)` : ''}</dd></div>
        <div><dt>Encoder</dt><dd>${r.encoder.h264}${r.encoder.finalTiles !== r.encoder.h264 ? ` (final tiles: ${r.encoder.finalTiles})` : ''}${r.encoder.fallbacks ? ` · ${r.encoder.fallbacks} job(s) fell back to libx264` : ''}</dd></div>
        ${r.timings && !dryRun && html`<div><dt>Time</dt><dd>probe ${r.timings.probe} s · clips ${r.timings.clips} s · tiles ${r.timings.tiles} s${r.full ? ` · media ${r.timings.media} s` : ''} · posters ${r.timings.posters} s</dd></div>`}
        ${s ? html`<div><dt>Size</dt><dd><strong>${formatBytes(s.total)}</strong> · tiles ${formatBytes(s.tiles)} · stills ${formatBytes(s.stills)}${s.layouts ? ` · other layouts ${formatBytes(s.layouts)}` : ''}${r.full ? ` · media ${formatBytes(s.media)}` : ''} · posters ${formatBytes(s.posters)}</dd></div>`
          : e && html`<div><dt>Estimate</dt><dd><strong>${formatBytes(e.total)}</strong> · ${formatBytes(e.withoutMedia)} without full-resolution videos</dd></div>`}
      </dl>
      ${r.warnings?.length > 0 && html`<ul class="issues warning">${r.warnings.map((w) => html`<li>${w}</li>`)}</ul>`}
    </div>`;
}

/** Build settings for this computer. They override the scene's `build` section. */
function MachineSettings() {
  const settings = useStore((s) => s.settings);
  const system = useStore((s) => s.system);
  const [testing, setTesting] = useState(false);
  if (!settings) return html`<section class="card"><div class="loading">Loading…</div></section>`;
  const encoders = system?.hardware?.encoders ?? [];
  const working = encoders.filter((e) => e.works);
  return html`
    <section class="card machine">
      <h2><${Icon} name="cpu" /> This computer</h2>
      <p class="muted small">These describe the machine, not the scene, so they're kept with the Studio's data and apply to every project.</p>
      ${system?.ffmpeg && html`<p class="small">ffmpeg ${system.ffmpeg.version}</p>`}
      <${Field} label="Hardware encoding" hint=${working.length ? `Works here: ${working.map((e) => e.label).join(', ')}.` : system?.hardware ? 'No working hardware encoder found; builds use libx264.' : ''}>
        <${Select} ariaLabel="Hardware encoding" value=${settings.hardware} onChange=${(v) => saveSettings({ hardware: v })}
          options=${[
            { value: 'auto', label: working.length ? `Automatic (${working[0].label})` : 'Automatic' },
            { value: 'off', label: 'Off (libx264 only)' },
            ...encoders.filter((e) => e.listed).map((e) => ({ value: e.name, label: `${e.label}${e.works ? '' : ' (failed its test)'}` })),
          ]} />
      </${Field}>
      ${encoders.some((e) => e.listed && !e.works) && html`
        <details class="small"><summary>Why some encoders don't work</summary>
          <ul>${encoders.filter((e) => e.listed && !e.works).map((e) => html`<li><strong>${e.label}:</strong> ${e.error}</li>`)}</ul>
        </details>`}
      <${Toggle} label="Also use it for the final tiles" checked=${settings.hardwareFinal} onChange=${(c) => saveSettings({ hardwareFinal: c })} />
      <p class="muted small">Off by default: libx264 final tiles were smaller, and the build faster overall.</p>
      <div class="field-row">
        <${Field} label="Hardware sessions"><${NumberInput} integer=${true} min=${1} max=${32} value=${settings.hardwareJobs} ariaLabel="Hardware sessions" onChange=${(n) => n && saveSettings({ hardwareJobs: n })} /></${Field}>
        <${Field} label="ffmpeg processes"><${NumberInput} integer=${true} min=${1} max=${256} value=${settings.jobs} placeholder=${String(system?.defaultJobs ?? '')} ariaLabel="ffmpeg processes" onChange=${(n) => saveSettings({ jobs: n ?? null })} /></${Field}>
      </div>
      <${Toggle} label="Keep the build cache (faster rebuilds, more disk)" checked=${settings.keepCache} onChange=${(c) => saveSettings({ keepCache: c })} />
      <button class="button small" disabled=${testing} onClick=${async () => { setTesting(true); await retestHardware(); setTesting(false); }}>
        <${Icon} name="refresh" size=${14} /> ${testing ? 'Testing…' : 'Re-test encoders'}</button>
    </section>`;
}
