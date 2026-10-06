// Layout and output settings with a live preview of the wall, its tile
// pyramid and the size estimate. Everything is computed in the browser with
// the same core code the build uses, from the probed video shapes.

import { useMemo, useState } from 'preact/hooks';
import { DEFAULT_CELL, DEFAULT_COLUMN_WIDTH, DEFAULT_TILE } from '@videomap/core';
import { defaultFor, formatBytes, getPath, metadataKeys, planScene, setPath } from './scene.js';
import { editScene, go, select, useStore } from './store.js';
import { Field, Icon, NumberInput, Segmented, Select, TextInput, Toggle, html } from './ui.js';
import { WallPreview } from './wall-preview.js';

export function LayoutTab() {
  const project = useStore((s) => s.project);
  const { scene, probes } = project;
  const plan = useMemo(() => planScene(scene, probes), [scene, probes]);
  const [wallId, setWallId] = useState('default');
  const [showTiles, setShowTiles] = useState(false);
  const wall = plan.walls.find((w) => w.id === wallId) ?? plan.walls[0] ?? null;

  const get = (...keys) => getPath(scene, keys);
  const set = (keys, value) => editScene((s) => setPath(s, keys, value), { coalesce: keys.join('.') });
  const masonry = get('layout', 'pack') === 'masonry';
  const surface = get('surface', 'type') ?? 'plane';
  const { tagPrefixes, metaKeys } = metadataKeys(scene);

  return html`
    <div class="layout-tab">
      <div class="settings">
        <section class="settings-section">
          <h2>Scene</h2>
          <${Field} label="Title"><${TextInput} value=${get('title') ?? ''} placeholder="Untitled scene" ariaLabel="Scene title" onInput=${(t) => set(['title'], t)} /></${Field}>
          <${Field} label="Description"><${TextInput} multiline=${true} value=${get('description') ?? ''} ariaLabel="Scene description" onInput=${(t) => set(['description'], t)} /></${Field}>
        </section>

        <section class="settings-section">
          <h2>Arrangement</h2>
          <${Field} label="Packing">
            <${Segmented} ariaLabel="Packing" value=${masonry ? 'masonry' : 'grid'} onChange=${(v) => editScene((s) => {
              setPath(s, ['layout', 'pack'], v === 'grid' ? undefined : v);
              // Settings of the other packing don't apply any more (the validator warns about them).
              for (const k of v === 'grid' ? ['columnWidth', 'gap', 'groupArrange', 'avoidSplits'] : ['cellAspect', 'fit']) setPath(s, ['layout', k], undefined);
            })} options=${[{ value: 'grid', label: 'Grid: uniform cells' }, { value: 'masonry', label: 'Masonry: each video\'s own shape' }]} />
          </${Field}>
          <${Field} label="Group by" hint="Videos with the same value sit together under a label.">
            <${GroupBy} value=${get('layout', 'groupBy')} tagPrefixes=${tagPrefixes} metaKeys=${metaKeys} onChange=${(v) => set(['layout', 'groupBy'], v)} />
          </${Field}>
          <${Field} label="Sort by" hint="Order within each group; also the order masonry deals videos to columns.">
            <${SortBy} value=${get('layout', 'sortBy')} metaKeys=${metaKeys} onChange=${(v) => set(['layout', 'sortBy'], v)} />
          </${Field}>
          <div class="field-row">
            <${Toggle} label="Group labels" checked=${get('layout', 'labels') ?? true} onChange=${(c) => set(['layout', 'labels'], c ? undefined : false)} />
            <${Field} label=${masonry ? 'Columns between groups' : 'Cells between groups'}>
              <${NumberInput} integer=${true} min=${0} max=${10} value=${get('layout', 'groupGap')} placeholder=${masonry ? '0' : '1'} ariaLabel="Group gap" onChange=${(n) => set(['layout', 'groupGap'], n)} />
            </${Field}>
          </div>
          ${!masonry && html`
            <div class="field-row">
              <${Field} label="Cell shape"><${TextInput} value=${get('layout', 'cellAspect') ?? ''} placeholder="16:9" ariaLabel="Cell shape" onInput=${(t) => set(['layout', 'cellAspect'], t)} /></${Field}>
              <${Field} label="Fit">
                <${Select} ariaLabel="Fit" value=${get('layout', 'fit') ?? 'contain'} onChange=${(v) => set(['layout', 'fit'], v === 'contain' ? undefined : v)}
                  options=${[{ value: 'contain', label: 'Contain: whole frame' }, { value: 'cover', label: 'Cover: crop to fill' }]} />
              </${Field}>
            </div>`}
          ${masonry && html`
            <div class="field-row">
              <${Field} label="Column width (px)"><${NumberInput} integer=${true} min=${32} max=${2048} value=${get('layout', 'columnWidth')} placeholder=${get('output', 'canvas') ? 'from canvas' : String(DEFAULT_COLUMN_WIDTH)} ariaLabel="Column width" onChange=${(n) => set(['layout', 'columnWidth'], n)} /></${Field}>
              <${Field} label="Gap (px)"><${NumberInput} integer=${true} min=${0} max=${256} value=${get('layout', 'gap')} placeholder="0" ariaLabel="Gap" onChange=${(n) => set(['layout', 'gap'], n)} /></${Field}>
            </div>
            <${Field} label="Groups">
              <${Segmented} ariaLabel="Group arrangement" value=${get('layout', 'groupArrange') ?? 'columns'} onChange=${(v) => set(['layout', 'groupArrange'], v === 'columns' ? undefined : v)}
                options=${[{ value: 'columns', label: 'Side by side' }, { value: 'bands', label: 'Stacked bands' }]} />
            </${Field}>
            <${Toggle} label="Keep videos inside one tile when they fit (fewer seams)" checked=${get('layout', 'avoidSplits') ?? true} onChange=${(c) => set(['layout', 'avoidSplits'], c ? undefined : false)} />`}
          ${!get('output', 'canvas') && html`
            <${Field} label="Wall shape" hint=${surface === 'plane' ? 'Overall aspect the layout aims for.' : 'Empty: shaped to fill the surface.'}>
              <${TextInput} value=${get('layout', 'aspect') ?? ''} placeholder=${surface === 'plane' ? '16:9' : 'fill the surface'} ariaLabel="Wall shape" onInput=${(t) => set(['layout', 'aspect'], t)} />
            </${Field}>`}
        </section>

        <section class="settings-section">
          <h2>Surface</h2>
          <${Segmented} ariaLabel="Surface" value=${surface} onChange=${(v) => set(['surface', 'type'], v === 'plane' ? undefined : v)}
            options=${[{ value: 'plane', label: 'Flat' }, { value: 'cylinder', label: 'Cylinder' }, { value: 'sphere', label: 'Sphere' }]} />
          ${surface !== 'plane' && html`
            <div class="field-row">
              <${Field} label="View from">
                <${Select} ariaLabel="View from" value=${get('surface', 'view') ?? 'inside'} onChange=${(v) => set(['surface', 'view'], v === 'inside' ? undefined : v)}
                  options=${[{ value: 'inside', label: 'Inside (immersive)' }, { value: 'outside', label: 'Outside (an object)' }]} />
              </${Field}>
              <${Field} label="Wraps (degrees)"><${NumberInput} min=${1} max=${360} value=${get('surface', 'arc')} placeholder="360" ariaLabel="Arc" onChange=${(n) => set(['surface', 'arc'], n)} /></${Field}>
            </div>`}
          ${surface === 'sphere' && html`
            <div class="field-row">
              <${Field} label="South limit (°)"><${NumberInput} min=${-89} max=${89} value=${get('surface', 'latitudeBand')?.[0]} placeholder="-60" ariaLabel="South limit" onChange=${(n) => set(['surface', 'latitudeBand'], band(get('surface', 'latitudeBand'), 0, n))} /></${Field}>
              <${Field} label="North limit (°)"><${NumberInput} min=${-89} max=${89} value=${get('surface', 'latitudeBand')?.[1]} placeholder="60" ariaLabel="North limit" onChange=${(n) => set(['surface', 'latitudeBand'], band(get('surface', 'latitudeBand'), 1, n))} /></${Field}>
            </div>`}
        </section>

        <section class="settings-section">
          <h2>Preview loop</h2>
          <div class="field-row">
            <${Field} label="Loop length (s)" hint="Tile size grows with it."><${NumberInput} min=${0.1} max=${300} value=${get('preview', 'duration')} placeholder="10" ariaLabel="Loop length" onChange=${(n) => set(['preview', 'duration'], n)} /></${Field}>
            <${Field} label="Frame rate"><${NumberInput} integer=${true} min=${1} max=${60} value=${get('preview', 'fps')} placeholder="24" ariaLabel="Frame rate" onChange=${(n) => set(['preview', 'fps'], n)} /></${Field}>
          </div>
          <${Field} label="Loop starts">
            <${Select} ariaLabel="Loop starts" value=${get('preview', 'startStrategy') ?? 'auto'} onChange=${(v) => set(['preview', 'startStrategy'], v === 'auto' ? undefined : v)}
              options=${[{ value: 'auto', label: 'Automatically (skip intros)' }, { value: 'start', label: 'At the start' }]} />
          </${Field}>
          <${Toggle} label="Loop videos shorter than the loop" checked=${get('preview', 'loopShort') ?? true} onChange=${(c) => set(['preview', 'loopShort'], c ? undefined : false)} />
        </section>

        <section class="settings-section">
          <h2>Output</h2>
          <${Field} label="Size">
            <${Segmented} ariaLabel="Size by" value=${get('output', 'canvas') ? 'canvas' : 'cell'} onChange=${(v) => editScene((s) => {
              if (v === 'canvas') {
                setPath(s, ['output', 'cell'], undefined);
                setPath(s, ['output', 'canvas'], wall ? `${wall.layout.width - (wall.layout.width % 2)}x${wall.layout.height - (wall.layout.height % 2)}` : '7680x4320');
              } else {
                setPath(s, ['output', 'canvas'], undefined);
              }
            })} options=${[{ value: 'cell', label: masonry ? 'By column width' : 'By video size' }, { value: 'canvas', label: 'By wall size' }]} />
          </${Field}>
          <div class="field-row">
            ${get('output', 'canvas') ? html`
              <${Field} label="Wall (px)"><${TextInput} value=${get('output', 'canvas')} placeholder="7680x4320" ariaLabel="Wall size" onInput=${(t) => set(['output', 'canvas'], t || undefined)} /></${Field}>`
              : !masonry && html`<${Field} label="Each video (px)"><${TextInput} value=${get('output', 'cell') ?? ''} placeholder=${DEFAULT_CELL} ariaLabel="Video size" onInput=${(t) => set(['output', 'cell'], t)} /></${Field}>`}
            <${Field} label="Tile (px)"><${TextInput} value=${get('output', 'tile') ?? ''} placeholder=${DEFAULT_TILE[masonry ? 'masonry' : 'grid']} ariaLabel="Tile size" onInput=${(t) => set(['output', 'tile'], t)} /></${Field}>
          </div>
          <div class="field-row">
            <${Field} label="Tile quality (CRF)" hint="Lower is better and bigger."><${NumberInput} integer=${true} min=${10} max=${51} value=${get('output', 'tileCrf')} placeholder=${String(defaultFor(['output', 'tileCrf']))} ariaLabel="Tile quality" onChange=${(n) => set(['output', 'tileCrf'], n)} /></${Field}>
            <${Field} label="Background"><input type="color" class="swatch wide" aria-label="Background color" value=${get('output', 'background') ?? defaultFor(['output', 'background'])} onInput=${(e) => set(['output', 'background'], e.currentTarget.value)} /></${Field}>
          </div>
          <${Toggle} label="Also make VP9 tiles (smaller on Android and desktop, slower to build)" checked=${(get('output', 'tileCodecs') ?? []).includes('vp9')} onChange=${(c) => set(['output', 'tileCodecs'], c ? ['h264', 'vp9'] : undefined)} />
          <${Toggle} label="Still-image pyramid (instant first paint, reduced-motion fallback)" checked=${get('output', 'stills') ?? true} onChange=${(c) => set(['output', 'stills'], c ? undefined : false)} />
          <${Toggle} label="Full-resolution videos for the player window" checked=${get('output', 'full', 'enabled') ?? true} onChange=${(c) => set(['output', 'full', 'enabled'], c ? undefined : false)} />
          ${(get('output', 'full', 'enabled') ?? true) ? html`
            <div class="field-row">
              <${Field} label="Max height (px)"><${NumberInput} integer=${true} min=${144} max=${4320} value=${get('output', 'full', 'maxHeight')} placeholder="1080" ariaLabel="Max height" onChange=${(n) => set(['output', 'full', 'maxHeight'], n)} /></${Field}>
              <${Field} label="Quality (CRF)"><${NumberInput} integer=${true} min=${10} max=${51} value=${get('output', 'full', 'crf')} placeholder="23" ariaLabel="Full quality" onChange=${(n) => set(['output', 'full', 'crf'], n)} /></${Field}>
            </div>`
            : html`<p class="muted small">Tiles only: the window shows the poster and details instead of a player.</p>`}
        </section>

        <${Alternates} scene=${scene} tagPrefixes=${tagPrefixes} metaKeys=${metaKeys} />
      </div>

      <div class="preview-col">
        <div class="preview-head">
          ${plan.walls.length > 1 && html`<${Select} ariaLabel="Arrangement to preview" value=${wall?.id} onChange=${setWallId} options=${plan.walls.map((w) => ({ value: w.id, label: w.label }))} />`}
          <${Toggle} label="Tile grid" checked=${showTiles} onChange=${setShowTiles} />
          ${surface !== 'plane' && html`<span class="muted small">Shown flat; the viewer wraps it ${surface === 'cylinder' ? 'around a cylinder' : 'onto a sphere'}.</span>`}
        </div>
        ${plan.error ? html`<div class="notice warn"><${Icon} name="alert" /><span>${plan.error}</span></div>`
          : !wall ? html`<div class="empty small"><p>Add videos to see the wall.</p><button class="button" onClick=${() => go(`#/p/${encodeURIComponent(project.id)}/library`)}>Go to the library</button></div>`
            : html`<${WallPreview} wall=${wall} scene=${scene} probes=${probes} projectId=${project.id} showTiles=${showTiles}
                onPick=${(i) => { select([i]); go(`#/p/${encodeURIComponent(project.id)}/library`); }} />`}
        ${wall && html`<${Stats} plan=${plan} wall=${wall} full=${get('output', 'full', 'enabled') ?? true} />`}
      </div>
    </div>`;
}

function band(current, i, n) {
  const next = [...(current ?? [-60, 60])];
  next[i] = n ?? (i === 0 ? -60 : 60);
  return next[0] === -60 && next[1] === 60 ? undefined : next;
}

function GroupBy({ value, tagPrefixes, metaKeys, onChange }) {
  const v = value ?? 'category';
  const kind = v === 'none' || v === 'category' ? v : v.startsWith('tag:') ? 'tag' : 'meta';
  const key = kind === 'tag' ? v.slice(4) : kind === 'meta' ? v.slice(5) : '';
  const keys = kind === 'tag' ? tagPrefixes : metaKeys;
  return html`
    <div class="row">
      <${Select} ariaLabel="Group by" value=${kind} onChange=${(k) => onChange(
        k === 'category' ? undefined : k === 'none' ? 'none' : k === 'tag' ? `tag:${tagPrefixes[0] ?? 'place'}` : `meta.${metaKeys[0] ?? 'year'}`,
      )} options=${[
        { value: 'category', label: 'Category' },
        { value: 'tag', label: 'Tag prefix (tag:…)' },
        { value: 'meta', label: 'Detail (meta.…)' },
        { value: 'none', label: 'Nothing (one block)' },
      ]} />
      ${(kind === 'tag' || kind === 'meta') && html`
        <input class="input" list="group-keys" value=${key} aria-label="Group key" onInput=${(e) => {
          const k = e.currentTarget.value.trim();
          if (k) onChange(`${kind === 'tag' ? 'tag:' : 'meta.'}${k}`);
        }} />
        <datalist id="group-keys">${keys.map((k) => html`<option value=${k} />`)}</datalist>`}
    </div>`;
}

function SortBy({ value, metaKeys, onChange }) {
  const list = value ?? ['title'];
  const options = [
    { value: 'title', label: 'Title' },
    { value: 'id', label: 'Id' },
    { value: 'duration', label: 'Length' },
    { value: 'category', label: 'Category' },
    { value: 'src', label: 'File name' },
    ...metaKeys.map((k) => ({ value: `meta.${k}`, label: `Detail: ${k}` })),
  ];
  const commit = (next) => onChange(next.length === 1 && next[0] === 'title' ? undefined : next);
  return html`
    <div class="rows">
      ${list.map((entry, i) => {
        const desc = entry.startsWith('-');
        const key = desc ? entry.slice(1) : entry;
        const opts = options.some((o) => o.value === key) ? options : [...options, { value: key, label: key }];
        return html`
          <div class="row" key=${i}>
            <span class="muted small">${i === 0 ? 'By' : 'then'}</span>
            <${Select} ariaLabel=${`Sort key ${i + 1}`} value=${key} options=${opts} onChange=${(k) => commit(list.map((e, j) => (j === i ? (desc ? `-${k}` : k) : e)))} />
            <${Select} ariaLabel=${`Sort direction ${i + 1}`} value=${desc} options=${[{ value: false, label: 'A → Z, short → long' }, { value: true, label: 'Z → A, long → short' }]}
              onChange=${(d) => commit(list.map((e, j) => (j === i ? (d ? `-${key}` : key) : e)))} />
            ${list.length > 1 && html`<button class="icon-button" aria-label="Remove sort key" onClick=${() => commit(list.filter((_, j) => j !== i))}><${Icon} name="x" size=${14} /></button>`}
          </div>`;
      })}
      ${list.length < 4 && html`<button class="button small" onClick=${() => commit([...list, options.find((o) => !list.includes(o.value))?.value ?? 'id'])}><${Icon} name="plus" size=${14} /> Then by</button>`}
    </div>`;
}

/** Pre-baked alternate arrangements (scene.layouts): the viewer switches between them. */
function Alternates({ scene, tagPrefixes, metaKeys }) {
  const alts = scene.layouts ?? [];
  const set = (i, key, value) => editScene((s) => setPath(s, ['layouts', i, key], value), { coalesce: `layouts.${i}.${key}` });
  return html`
    <section class="settings-section">
      <h2>Alternate layouts</h2>
      <p class="muted small">Extra arrangements of the same videos, each built as its own tile pyramid. The viewer offers a switcher. More options are in the JSON tab.</p>
      ${alts.map((a, i) => html`
        <div class="alternate" key=${i}>
          <div class="field-row">
            <${Field} label="Id"><${TextInput} value=${a.id} ariaLabel="Layout id" onInput=${(t) => set(i, 'id', t || `layout-${i + 1}`)} /></${Field}>
            <${Field} label="Name in the switcher"><${TextInput} value=${a.label ?? ''} placeholder="e.g. By place" ariaLabel="Layout name" onInput=${(t) => set(i, 'label', t)} /></${Field}>
          </div>
          <${Field} label="Packing">
            <${Segmented} ariaLabel="Alternate packing" value=${a.pack ?? scene.layout?.pack ?? 'grid'} onChange=${(v) => set(i, 'pack', v)}
              options=${[{ value: 'grid', label: 'Grid' }, { value: 'masonry', label: 'Masonry' }]} />
          </${Field}>
          <${Field} label="Group by"><${GroupBy} value=${a.groupBy} tagPrefixes=${tagPrefixes} metaKeys=${metaKeys} onChange=${(v) => set(i, 'groupBy', v)} /></${Field}>
          <${Field} label="Sort by"><${SortBy} value=${a.sortBy} metaKeys=${metaKeys} onChange=${(v) => set(i, 'sortBy', v)} /></${Field}>
          <button class="button small danger" onClick=${() => editScene((s) => { s.layouts.splice(i, 1); if (!s.layouts.length) delete s.layouts; })}><${Icon} name="trash" size=${14} /> Remove</button>
        </div>`)}
      ${alts.length < 8 && html`<button class="button small" onClick=${() => editScene((s) => {
        const ids = new Set((s.layouts ?? []).map((l) => l.id));
        let id = tagPrefixes[0] ?? 'alternate';
        for (let n = 2; ids.has(id) || id === 'default'; n++) id = `${tagPrefixes[0] ?? 'alternate'}-${n}`;
        s.layouts = [...(s.layouts ?? []), { id, groupBy: tagPrefixes.length ? `tag:${tagPrefixes[0]}` : 'none' }];
      })}><${Icon} name="plus" size=${14} /> Add a layout</button>`}
    </section>`;
}

function Stats({ plan, wall, full }) {
  const { layout, pyramid } = wall;
  const e = plan.estimate;
  const tiles = wall.tiles.reduce((n, l) => n + l.length, 0);
  return html`
    <dl class="stats">
      <div><dt>Wall</dt><dd>${layout.width.toLocaleString()} × ${layout.height.toLocaleString()} px${layout.groups.length ? `, ${layout.groups.length} groups` : ''}</dd></div>
      <div><dt>${layout.pack === 'grid' ? 'Grid' : 'Masonry'}</dt><dd>${layout.grid
        ? `${layout.grid.cols} × ${layout.grid.rows} cells of ${layout.grid.cell.w}×${layout.grid.cell.h}`
        : `${layout.masonry.columns} columns of ${layout.masonry.columnWidth} px${layout.masonry.splits.length ? ` · ${layout.masonry.splits.length} cross a tile edge` : ''}`}</dd></div>
      <div><dt>Pyramid</dt><dd>${pyramid.levels.length} levels of ${pyramid.tile.w}×${pyramid.tile.h} tiles: ${wall.tiles.map((l, z) => `z${z} ${l.length}`).join(', ')} (${tiles})</dd></div>
      ${e && html`
        <div><dt>Tile videos</dt><dd>${e.tileCount}${plan.walls.length > 1 ? ` across ${plan.walls.length} layouts` : ''}</dd></div>
        <div><dt>Estimate</dt><dd><strong>${formatBytes(e.total)}</strong> · tiles ${formatBytes(e.tiles)} · stills ${formatBytes(e.stills)}${full ? ` · media ${formatBytes(e.media)}` : ''} · posters ${formatBytes(e.posters)}</dd></div>
        <div><dt></dt><dd class="muted">${full ? `${formatBytes(e.withoutMedia)} without full-resolution videos` : `Full-resolution videos would add ${formatBytes(e.withMedia - e.withoutMedia)}`}</dd></div>`}
      ${plan.unknown > 0 && html`<div><dt></dt><dd class="muted">${plan.unknown} video${plan.unknown === 1 ? '' : 's'} not read yet, counted as 16:9 and 10 s.</dd></div>`}
      ${plan.warnings.map((w) => html`<div><dt></dt><dd class="warn-text">${w}</dd></div>`)}
    </dl>`;
}
