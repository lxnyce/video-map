// CodeMirror for the JSON tab, loaded on demand so the rest of the Studio stays
// small. Problems from the shared scene validator are shown as lint marks on
// the exact property, found through the JSON syntax tree.

import { EditorView, basicSetup } from 'codemirror';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { tags } from '@lezer/highlight';

/** Colors to match the Studio's dark theme. */
const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: '#8ab8ff' },
  { tag: tags.string, color: '#8fd6a3' },
  { tag: tags.number, color: '#f2b35b' },
  { tag: [tags.bool, tags.null], color: '#e39bff' },
  { tag: tags.punctuation, color: '#9aa3b5' },
]);

const VALUE_NODES = new Set(['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null']);

/**
 * @param {object} o
 * @param {HTMLElement} o.parent
 * @param {string} o.doc
 * @param {(text: string) => void} o.onChange
 * @param {(text: string, parsed: any) => Array<{ path: Array<string|number>, message: string, severity: 'error'|'warning', property?: string }>} o.check
 */
export function createEditor({ parent, doc, onChange, check }) {
  const parseLint = jsonParseLinter();
  const schemaLint = (view) => {
    const text = view.state.doc.toString();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return parseLint(view);
    }
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, 500);
    return check(text, parsed).map((issue) => {
      const range = tree ? locate(tree, view.state, issue.path, issue.property) : null;
      return { from: range?.from ?? 0, to: range?.to ?? Math.min(1, text.length), severity: issue.severity, message: issue.message };
    });
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        json(),
        syntaxHighlighting(highlight),
        lintGutter(),
        linter(schemaLint, { delay: 300 }),
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()); }),
        EditorView.theme({}, { dark: true }),
      ],
    }),
  });

  return {
    view,
    getText: () => view.state.doc.toString(),
    /** Replace the text, keeping the cursor near where it was. @param {string} text */
    setText(text) {
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
    },
    /** Select the value at a path and scroll to it. @param {Array<string|number>} path */
    reveal(path, property) {
      const tree = ensureSyntaxTree(view.state, view.state.doc.length, 500);
      const range = tree && locate(tree, view.state, path, property);
      if (!range) return;
      view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}

/**
 * The text range of the value at `path` (or of the property name `property`
 * inside it, for "unknown property" problems).
 * @param {any} tree
 * @param {EditorState} state
 * @param {Array<string|number>} path
 * @param {string} [property]
 */
function locate(tree, state, path, property) {
  let node = tree.topNode.firstChild;
  while (node && !VALUE_NODES.has(node.name)) node = node.nextSibling;
  if (!node) return null;
  const keys = property ? [...path, property] : path;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let next = null;
    if (node.name === 'Object' && typeof key === 'string') {
      for (let p = node.firstChild; p; p = p.nextSibling) {
        if (p.name !== 'Property') continue;
        const name = p.firstChild;
        if (name?.name !== 'PropertyName') continue;
        let text;
        try {
          text = JSON.parse(state.sliceDoc(name.from, name.to));
        } catch {
          continue;
        }
        if (text !== key) continue;
        // For an unknown property, mark its name; otherwise its value.
        if (property && i === keys.length - 1) return { from: name.from, to: name.to };
        let v = name.nextSibling;
        while (v && !VALUE_NODES.has(v.name)) v = v.nextSibling;
        next = v;
        break;
      }
    } else if (node.name === 'Array' && typeof key === 'number') {
      let n = 0;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (!VALUE_NODES.has(c.name)) continue;
        if (n++ === key) {
          next = c;
          break;
        }
      }
    }
    if (!next) break;
    node = next;
  }
  return { from: node.from, to: node.name === 'Object' || node.name === 'Array' ? Math.min(node.to, node.from + 1) : node.to };
}
