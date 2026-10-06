// Shared UI pieces. Components are Preact with htm templates: plain JS, no build-time JSX.

import { h } from 'preact';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import htm from 'htm';

/** @type {(strings: TemplateStringsArray, ...values: any[]) => any} */
export const html = /** @type {any} */ (htm).bind(h);

const ICONS = {
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'm15 14 5-5-5-5m5 5H9a5 5 0 0 0 0 10h3',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5L20 7',
  plus: 'M12 5v14M5 12h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  download: 'M12 4v12m0 0-4-4m4 4 4-4M4 20h16',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.3-4.3',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5',
  cpu: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6zM10 10h4v4h-4z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};

/** @param {{ name: keyof typeof ICONS, size?: number }} props */
export function Icon({ name, size = 18 }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true"><path d=${ICONS[name]} /></svg>`;
}

/** A labelled form row. */
export function Field({ label, hint = null, children, wide = false, htmlFor = undefined }) {
  return html`
    <div class=${`field${wide ? ' wide' : ''}`}>
      <label class="field-label" for=${htmlFor}>${label}</label>
      <div class="field-control">${children}</div>
      ${hint && html`<div class="field-hint">${hint}</div>`}
    </div>`;
}

/**
 * Text input that reports every keystroke. It keeps its own text, so the
 * store's echo of what was just typed doesn't move the cursor, but any other
 * change of `value` (undo, the JSON editor, a reload) replaces the text.
 */
export function TextInput({ value, onInput, placeholder = '', multiline = false, id = undefined, class: cls = '', autoFocus = false, onKeyDown = undefined, ariaLabel = undefined }) {
  const text = useRef(value ?? '');
  const sent = useRef(value ?? '');
  const [, rerender] = useReducer((n) => n + 1, 0);
  // Decided while rendering (not in an effect), so the field never lags a frame behind the store.
  if ((value ?? '') !== sent.current) {
    sent.current = value ?? '';
    text.current = value ?? '';
  }
  const props = {
    id,
    class: `input ${cls}`,
    value: text.current,
    placeholder,
    autoFocus,
    'aria-label': ariaLabel,
    onInput: (e) => {
      const t = e.currentTarget.value;
      text.current = t;
      sent.current = t;
      rerender(undefined);
      onInput(t);
    },
    onKeyDown,
  };
  return multiline ? html`<textarea rows="3" ...${props} />` : html`<input type="text" ...${props} />`;
}

/** Number input: empty means "use the default" (undefined). Invalid text isn't committed. */
export function NumberInput({ value, onChange, placeholder = '', min = undefined, max = undefined, step = 'any', integer = false, id = undefined, ariaLabel = undefined }) {
  const show = (v) => (v === undefined || v === null ? '' : String(v));
  const textRef = useRef(show(value));
  const sent = useRef(value ?? undefined);
  const [, rerender] = useReducer((n) => n + 1, 0);
  if ((value ?? undefined) !== sent.current) {
    sent.current = value ?? undefined;
    textRef.current = show(value);
  }
  const text = textRef.current;
  const setText = (t) => {
    textRef.current = t;
    rerender(undefined);
  };
  const n = Number(text);
  const bad = text.trim() !== '' && (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max));
  return html`<input
    type="number" id=${id} class=${`input number${bad ? ' bad' : ''}`} value=${text} placeholder=${placeholder} min=${min} max=${max} step=${integer ? 1 : step}
    aria-label=${ariaLabel} aria-invalid=${bad}
    onBlur=${() => { if (bad) setText(show(value)); }}
    onInput=${(e) => {
      const t = e.currentTarget.value;
      setText(t);
      if (t.trim() === '') {
        sent.current = undefined;
        return onChange(undefined);
      }
      const v = Number(t);
      if (Number.isFinite(v) && (!integer || Number.isInteger(v)) && (min === undefined || v >= min) && (max === undefined || v <= max)) {
        sent.current = v;
        onChange(v);
      }
    }}
  />`;
}

/** @param {{ value: any, options: Array<{ value: any, label: string }>, onChange: (v: any) => void, id?: string, ariaLabel?: string }} props */
export function Select({ value, options, onChange, id = undefined, ariaLabel = undefined }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return html`
    <select id=${id} class="input select" aria-label=${ariaLabel} value=${String(index)} onChange=${(e) => onChange(options[Number(e.currentTarget.value)].value)}>
      ${options.map((o, i) => html`<option value=${String(i)} selected=${i === index}>${o.label}</option>`)}
    </select>`;
}

/** A switch with a label. */
export function Toggle({ checked, onChange, label, id = undefined }) {
  return html`
    <label class="toggle">
      <input type="checkbox" id=${id} checked=${Boolean(checked)} onChange=${(e) => onChange(e.currentTarget.checked)} />
      <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb" /></span>
      <span>${label}</span>
    </label>`;
}

/** Buttons that pick one of a few values. */
export function Segmented({ value, options, onChange, ariaLabel = undefined }) {
  return html`
    <div class="segmented" role="radiogroup" aria-label=${ariaLabel}>
      ${options.map((o) => html`
        <button type="button" role="radio" aria-checked=${o.value === value} class=${o.value === value ? 'on' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
    </div>`;
}

/** Chips plus a text box: Enter or comma adds, × removes. */
export function TokenInput({ values = [], onChange, suggestions = [], placeholder = 'Add…', ariaLabel = undefined }) {
  const [text, setText] = useState('');
  const listId = useRef(`tokens-${Math.random().toString(36).slice(2)}`).current;
  const add = (raw) => {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...values, ...parts])]);
    setText('');
  };
  return html`
    <div class="tokens">
      ${values.map((v) => html`
        <span class="chip">${v}<button type="button" class="chip-x" aria-label=${`Remove ${v}`} onClick=${() => onChange(values.filter((x) => x !== v))}><${Icon} name="x" size=${12} /></button></span>`)}
      <input class="token-input" list=${listId} value=${text} placeholder=${placeholder} aria-label=${ariaLabel}
        onInput=${(e) => {
          const t = e.currentTarget.value;
          if (t.includes(',')) add(t);
          else setText(t);
        }}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur=${() => text && add(text)} />
      <datalist id=${listId}>${suggestions.filter((s) => !values.includes(s)).slice(0, 50).map((s) => html`<option value=${s} />`)}</datalist>
    </div>`;
}

export function ProgressBar({ value, max, label = undefined }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return html`<div class="progress" role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax=${max} aria-valuenow=${value}><div class="progress-fill" style=${`width:${pct}%`} /></div>`;
}

/** A dialog over the page. Escape or the backdrop closes it. */
export function Modal({ title, onClose, children, actions = null, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    ref.current?.querySelector('input, textarea, select, button')?.focus();
    return () => document.removeEventListener('keydown', key);
  }, []);
  return html`
    <div class="modal-backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class=${`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
        <div class="modal-head"><h2>${title}</h2><button class="icon-button" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
        <div class="modal-body">${children}</div>
        ${actions && html`<div class="modal-actions">${actions}</div>`}
      </div>
    </div>`;
}

export function Empty({ icon = 'film', title, children = null }) {
  return html`<div class="empty"><${Icon} name=${icon} size=${36} /><h3>${title}</h3>${children && html`<div class="empty-body">${children}</div>`}</div>`;
}

/** A list of validation problems, each clickable when `onPick` is given. */
export function Issues({ issues, kind = 'error', onPick = null, limit = 20 }) {
  if (!issues?.length) return null;
  return html`
    <ul class=${`issues ${kind}`}>
      ${issues.slice(0, limit).map((i) => html`
        <li>${onPick ? html`<button class="link" onClick=${() => onPick(i)}><code>${i.path}</code></button>` : html`<code>${i.path}</code>`} ${i.message}</li>`)}
      ${issues.length > limit && html`<li>…and ${issues.length - limit} more</li>`}
    </ul>`;
}
