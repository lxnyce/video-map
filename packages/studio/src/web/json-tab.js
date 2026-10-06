// The scene as JSON, in two-way sync with the forms: a valid edit here updates
// the scene (and is saved), and a change made in another tab replaces the text
// unless it has edits of its own that aren't valid yet.

import { useEffect, useRef, useState } from 'preact/hooks';
import { parseIssuePath, validateDraft } from './scene.js';
import { replaceScene, useStore } from './store.js';
import { Icon, Issues, html } from './ui.js';

const format = (scene) => `${JSON.stringify(scene, null, 2)}\n`;

export function JsonTab() {
  const project = useStore((s) => s.project);
  const host = useRef(null);
  const editor = useRef(/** @type {any} */ (null));
  const synced = useRef(JSON.stringify(project.scene));
  const timer = useRef(null);
  const [status, setStatus] = useState(/** @type {{ parseError: string|null, issues: any[], warnings: any[] }} */ ({ parseError: project.parseError, issues: project.parseError ? [] : project.issues, warnings: project.warnings }));
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    import('./json-editor.js').then(({ createEditor }) => {
      if (disposed) return;
      editor.current = createEditor({
        parent: host.current,
        // A broken scene.json opens as it is, to be fixed here.
        doc: project.parseError ? project.rawText ?? '' : format(project.scene),
        onChange: (text) => {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => apply(text), 300);
        },
        check: (text, parsed) => {
          const result = validateDraft(parsed);
          return [
            ...result.errors.map((i) => ({ ...toLint(i), severity: /** @type {const} */ ('error') })),
            ...result.warnings.map((i) => ({ ...toLint(i), severity: /** @type {const} */ ('warning') })),
          ];
        },
      });
      setLoading(false);
    });
    return () => {
      disposed = true;
      clearTimeout(timer.current);
      const pending = editor.current?.getText();
      if (pending !== undefined) apply(pending);
      editor.current?.destroy();
    };
  }, []);

  // A change from the forms, an upload, undo or another tab: show it here.
  useEffect(() => {
    const ed = editor.current;
    const next = JSON.stringify(project.scene);
    if (!ed || next === synced.current) return;
    let local = null;
    try {
      local = JSON.stringify(JSON.parse(ed.getText()));
    } catch {
      // the text has a syntax error in progress
    }
    if (local === next) {
      synced.current = next;
      return;
    }
    if (local === synced.current) {
      ed.setText(format(project.scene));
      synced.current = next;
      setStale(false);
    } else {
      setStale(true);
    }
  }, [project.scene]);

  function apply(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setStatus({ parseError: err.message, issues: [], warnings: [] });
      return;
    }
    const result = validateDraft(parsed);
    setStatus({ parseError: null, issues: result.errors, warnings: result.warnings });
    if (!result.valid) return;
    const s = JSON.stringify(parsed);
    synced.current = s;
    setStale(false);
    replaceScene(parsed, { coalesce: 'json' });
  }

  const reload = () => {
    editor.current?.setText(format(project.scene));
    synced.current = JSON.stringify(project.scene);
    setStale(false);
    setStatus({ parseError: null, issues: project.issues, warnings: project.warnings });
  };

  const pick = (issue) => {
    const { path, property } = toLint(issue);
    editor.current?.reveal(path, property);
  };

  return html`
    <div class="json-tab">
      <div class="toolbar">
        <span class="muted">The scene file exactly as <code>vmap build</code> reads it. Valid edits apply as you type.</span>
        <span class="spacer" />
        <button class="button small" onClick=${() => {
          try {
            editor.current?.setText(format(JSON.parse(editor.current.getText())));
          } catch {
            // nothing to format until it parses
          }
        }}>Format</button>
        <label class="button small">
          <${Icon} name="file" size=${14} /> Load file…
          <input type="file" accept=".json,application/json" hidden onChange=${async (e) => {
            const text = await e.currentTarget.files?.[0]?.text();
            e.currentTarget.value = '';
            if (text !== undefined) editor.current?.setText(text);
          }} />
        </label>
        <button class="button small" onClick=${() => {
          const blob = new Blob([editor.current?.getText() ?? format(project.scene)], { type: 'application/json' });
          const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'scene.json' });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }}><${Icon} name="download" size=${14} /> Download</button>
      </div>
      ${stale && html`<div class="notice warn"><${Icon} name="alert" /><span>The scene changed elsewhere while this text has unapplied edits.</span><button class="button small" onClick=${reload}>Load the current scene</button></div>`}
      <div class="json-body">
        <div class="json-editor" ref=${host}>${loading && html`<div class="loading">Loading editor…</div>`}</div>
        <aside class="json-issues">
          ${status.parseError ? html`<p class="bad-text"><strong>Not valid JSON:</strong> ${status.parseError}</p>`
            : status.issues.length ? html`<h3>${status.issues.length} problem${status.issues.length === 1 ? '' : 's'}: not saved</h3>`
              : html`<p class="ok-text"><${Icon} name="check" size=${16} /> Valid scene</p>`}
          <${Issues} issues=${status.issues} onPick=${pick} />
          ${status.warnings.length > 0 && html`<h3>Warnings</h3><${Issues} issues=${status.warnings} kind="warning" onPick=${pick} />`}
        </aside>
      </div>
    </div>`;
}

/** A validator issue → the editor path to mark (unknown properties mark the property's name). */
function toLint(issue) {
  const unknown = /has unknown property "(.+)"/.exec(issue.message);
  return { path: parseIssuePath(issue.path), property: unknown?.[1], message: `${issue.path}: ${issue.message}` };
}
