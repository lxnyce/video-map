// Discovery (plan §8.4): the search box, category and tag chips, the layout
// switcher, and the list view, an accessible alternative to the wall that
// lists every video, grouped as on the wall. Choosing a video in the list
// flies to it and opens it; choosing a group flies to the group.
//
// The panel only reports what the visitor asks for; the viewer owns the filter
// (it's in the URL), computes the matches and hands them back.

import { NO_FILTER, facets, isFiltering } from './search.js';

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
  clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
};

/**
 * @typedef {import('./search.js').Filter} Filter
 *
 * @typedef {object} DiscoverHost
 * @property {(f: Filter) => void} filter  the visitor changed the filter
 * @property {(video: any, from: { x: number, y: number, w: number, h: number }) => void} select  a video chosen in the list (from: its row, in viewer coordinates)
 * @property {(groupIndex: number) => void} flyToGroup
 * @property {() => void} showMatches  fit the matching videos in view
 * @property {(id: string) => void} setLayout
 * @property {() => void} toggled  the panel opened or closed
 * @property {(categoryId: string) => string} labelFor
 * @property {(path: string) => string} resolve  output-relative path → URL
 */

export class Discover {
  /**
   * @param {HTMLElement} side  the column under the title, which holds the search bar and the panel
   * @param {any} scene
   * @param {Array<{ id: string, label: string }>} layouts
   * @param {DiscoverHost} host
   */
  constructor(side, scene, layouts, host) {
    this.side = side;
    this.scene = scene;
    this.host = host;
    /** @type {Filter} */
    this.filter = { ...NO_FILTER };
    /** @type {Uint8Array|null} */
    this.matches = null;
    this.facets = facets(scene.videos, scene.categories ?? []);
    this.layoutId = layouts[0]?.id ?? 'default';
    const n = scene.videos.length;

    // Search bar: the field, a clear button and the browse toggle. On a phone only the toggle shows until it's opened.
    const bar = el('div', 'vm-searchbar');
    bar.setAttribute('role', 'search');
    const icon = el('span', 'vm-search-icon');
    icon.innerHTML = ICONS.search;
    this.input = el('input', 'vm-search');
    this.input.type = 'search';
    this.input.placeholder = `Search ${n} video${n === 1 ? '' : 's'}`;
    this.input.setAttribute('aria-label', 'Search videos');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.count = el('span', 'vm-search-count');
    this.count.hidden = true;
    this.clearBtn = iconButton('clear', 'Clear search and filters', 'vm-search-clear');
    this.clearBtn.hidden = true;
    this.toggleBtn = iconButton('list', 'Browse videos', 'vm-browse');
    // On a phone the open panel fills the screen, and this button closes it.
    const done = el('span', 'vm-browse-done');
    done.textContent = 'Done';
    this.toggleBtn.append(done);
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    this.badge = el('span', 'vm-badge');
    this.badge.hidden = true;
    this.toggleBtn.append(this.badge);
    bar.append(icon, this.input, this.count, this.clearBtn, this.toggleBtn);

    // The panel: layouts, chips, the result line and the list.
    const panel = el('section', 'vm-panel');
    panel.id = `vm-panel-${Math.random().toString(36).slice(2, 8)}`;
    panel.setAttribute('aria-label', 'Browse videos');
    panel.hidden = true;
    this.toggleBtn.setAttribute('aria-controls', panel.id);
    this.layoutsEl = el('div', 'vm-seg');
    this.layoutsEl.setAttribute('role', 'group');
    this.layoutsEl.setAttribute('aria-label', 'Arrange the wall');
    for (const l of layouts) {
      const b = el('button', 'vm-seg-btn');
      b.type = 'button';
      b.dataset.layout = l.id;
      b.textContent = l.label;
      this.layoutsEl.append(b);
    }
    const layoutRow = section('Arrange', this.layoutsEl);
    layoutRow.hidden = layouts.length < 2;

    this.catRow = el('div', 'vm-fchips');
    this.catRow.setAttribute('aria-label', 'Categories');
    this.tagRow = el('div', 'vm-fchips');
    this.tagRow.setAttribute('aria-label', 'Tags');
    const catSection = section('Categories', this.catRow);
    catSection.hidden = !this.facets.categories.length;
    this.tagSection = section('Tags', this.tagRow);
    this.tagSection.hidden = !this.facets.tags.length;

    const results = el('div', 'vm-results');
    this.resultText = el('span');
    this.resultText.setAttribute('aria-live', 'polite');
    this.showBtn = textButton('Show on wall', 'vm-link-btn');
    this.resetBtn = textButton('Clear', 'vm-link-btn');
    results.append(this.resultText, this.showBtn, this.resetBtn);

    this.list = el('ul', 'vm-list');
    this.list.setAttribute('aria-label', 'Videos');
    this.empty = el('p', 'vm-empty');
    this.empty.textContent = 'No videos match.';
    this.empty.hidden = true;

    const body = el('div', 'vm-panel-body');
    body.append(layoutRow, catSection, this.tagSection, results, this.list, this.empty);
    panel.append(body);
    this.panel = panel;
    this.body = body;
    side.append(bar, panel);
    this.bar = bar;

    /** Rows by video index, reused across layouts so posters load once. @type {HTMLLIElement[]} */
    this.rows = scene.videos.map((v, i) => this.row(v, i));
    /** @type {HTMLLIElement[]} */
    this.heads = [];
    this.groupIndex = new Int32Array(n).fill(-1);

    // Events
    this.input.addEventListener('input', () => this.change({ q: this.input.value }));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.input.value) this.change({ q: '' });
        else if (this.isOpen) this.open(false);
        else this.input.blur();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (!this.isOpen) this.open(true);
      } else if (e.key === 'ArrowDown') {
        if (!this.isOpen) this.open(true);
        /** @type {HTMLElement|null} */ (this.list.querySelector('li:not([hidden]) button'))?.focus();
        e.preventDefault();
      }
    });
    this.input.addEventListener('focus', () => { if (this.mobile && !this.isOpen) this.open(true); });
    this.clearBtn.addEventListener('click', () => {
      this.change({ ...NO_FILTER });
      this.input.focus();
    });
    this.toggleBtn.addEventListener('click', () => {
      this.open(!this.isOpen);
      if (this.isOpen && this.mobile) this.input.focus();
    });
    this.resetBtn.addEventListener('click', () => this.change({ ...NO_FILTER }));
    this.showBtn.addEventListener('click', () => {
      if (this.mobile) this.open(false);
      host.showMatches();
    });
    this.layoutsEl.addEventListener('click', (e) => {
      const id = /** @type {HTMLElement} */ (e.target).closest('button')?.dataset.layout;
      if (id && id !== this.layoutId) host.setLayout(id);
    });
    for (const [row, key] of /** @type {const} */ ([[this.catRow, 'cats'], [this.tagRow, 'tags']])) {
      row.addEventListener('click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('button');
        if (!b) return;
        const value = b.dataset.value;
        const list = this.filter[key];
        this.change({ [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value] });
      });
    }
    this.list.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!b) return;
      if (b.dataset.group !== undefined) {
        if (this.mobile) this.open(false);
        host.flyToGroup(Number(b.dataset.group));
        return;
      }
      const v = scene.videos[Number(b.dataset.video)];
      const r = b.getBoundingClientRect();
      const root = this.side.parentElement.getBoundingClientRect();
      const from = { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height };
      if (this.mobile) this.open(false);
      host.select(v, from);
    });
    // Arrow keys move through the list.
    this.list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const buttons = Array.from(this.list.querySelectorAll('li:not([hidden]) > button'));
      const i = buttons.indexOf(/** @type {any} */ (document.activeElement));
      const next = buttons[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) /** @type {HTMLElement} */ (next).focus();
      else if (e.key === 'ArrowUp') this.input.focus();
      e.preventDefault();
    });

    this.renderChips();
    this.renderStatus();
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  get mobile() {
    return (this.side.parentElement?.clientWidth ?? 1000) < 700;
  }

  /** @param {boolean} open */
  open(open) {
    if (open === this.isOpen) return;
    this.panel.hidden = !open;
    this.side.classList.toggle('vm-open', open);
    this.toggleBtn.setAttribute('aria-expanded', String(open));
    this.toggleBtn.classList.toggle('vm-active', open);
    if (open) this.renderList();
    this.host.toggled();
  }

  focusSearch() {
    if (this.mobile) this.open(true);
    this.input.focus();
    this.input.select();
  }

  /** The panel's box in viewer coordinates while it's open on a wide screen, so the camera can avoid it. */
  cover() {
    if (!this.isOpen || this.mobile) return null;
    const r = this.panel.getBoundingClientRect();
    const root = this.side.parentElement.getBoundingClientRect();
    return { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height };
  }

  /** @param {Partial<Filter>} part */
  change(part) {
    this.host.filter({ ...this.filter, ...part });
  }

  /**
   * Show a filter (typed, clicked, or from the URL) and its matches.
   * @param {Filter} f
   * @param {Uint8Array|null} matches
   */
  update(f, matches) {
    this.filter = f;
    this.matches = matches;
    if (this.input.value !== f.q) this.input.value = f.q;
    this.renderChips();
    this.renderStatus();
    if (this.isOpen) this.renderList();
  }

  /**
   * A new arrangement: the list follows its groups and order.
   * @param {string} id
   * @param {Int32Array} groupIndex  group per video
   */
  setWall(id, groupIndex) {
    this.layoutId = id;
    this.groupIndex = groupIndex;
    this.layoutsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === id)));
    this.listWall = null;
    if (this.isOpen) this.renderList();
  }

  renderChips() {
    const f = this.filter;
    const fill = (row, items, selected) => {
      row.replaceChildren(...items.map((it) => {
        const b = el('button', 'vm-fchip');
        b.type = 'button';
        b.dataset.value = it.id;
        b.setAttribute('aria-pressed', String(selected.includes(it.id)));
        if (it.color) {
          const dot = el('span', 'vm-dot');
          dot.style.background = it.color;
          b.append(dot);
        }
        b.append(it.label);
        if (it.count !== undefined) {
          const c = el('span', 'vm-fchip-count');
          c.textContent = String(it.count);
          b.append(c);
        }
        return b;
      }));
    };
    fill(this.catRow, this.facets.categories, f.cats);
    // Tags picked elsewhere (a window's chips, the URL) show even when they aren't among the most common.
    const shown = new Set(this.facets.tags.map((t) => t.id));
    const extra = f.tags.filter((t) => !shown.has(t)).map((t) => ({ id: t, label: t, color: null, count: undefined }));
    fill(this.tagRow, [...this.facets.tags, ...extra], f.tags);
    this.tagSection.hidden = !this.facets.tags.length && !extra.length;
    const facetCount = f.cats.length + f.tags.length;
    this.badge.hidden = !facetCount;
    this.badge.textContent = String(facetCount);
  }

  renderStatus() {
    const total = this.scene.videos.length;
    const filtering = isFiltering(this.filter);
    const found = this.matches ? this.matches.reduce((a, b) => a + b, 0) : total;
    this.resultText.textContent = filtering ? `${found} of ${total} video${total === 1 ? '' : 's'}` : `${total} video${total === 1 ? '' : 's'}`;
    this.count.textContent = filtering ? `${found}/${total}` : '';
    this.count.hidden = !filtering;
    this.clearBtn.hidden = !filtering;
    this.showBtn.hidden = !filtering || !found;
    this.resetBtn.hidden = !filtering;
    this.empty.hidden = !filtering || Boolean(found);
  }

  /** Lay the list out for the current arrangement (once per layout), then show only the matches. */
  renderList() {
    if (this.listWall !== this.layoutId) {
      this.listWall = this.layoutId;
      const videos = this.scene.videos;
      const groups = this.scene.groups ?? [];
      const order = videos.map((_, i) => i).filter((i) => videos[i].rect);
      const g = (i) => (this.groupIndex[i] < 0 ? groups.length : this.groupIndex[i]);
      order.sort((a, b) => g(a) - g(b) || videos[a].rect.y - videos[b].rect.y || videos[a].rect.x - videos[b].rect.x);
      this.heads = groups.map((grp, gi) => {
        const li = el('li', 'vm-list-group');
        const b = el('button');
        b.type = 'button';
        b.dataset.group = String(gi);
        b.title = `Show ${grp.label} on the wall`;
        if (grp.color) b.style.setProperty('--group-color', grp.color);
        const name = el('span');
        name.textContent = grp.label;
        const count = el('span', 'vm-list-count');
        b.append(name, count);
        li.append(b);
        return li;
      });
      const items = [];
      let last = -2;
      for (const i of order) {
        const gi = this.groupIndex[i];
        if (gi !== last && gi >= 0) items.push(this.heads[gi]);
        last = gi;
        items.push(this.rows[i]);
      }
      this.list.replaceChildren(...items);
    }
    const m = this.matches;
    const perGroup = new Int32Array(this.heads.length);
    const totals = new Int32Array(this.heads.length);
    this.rows.forEach((row, i) => {
      const on = !m || Boolean(m[i]);
      row.hidden = !on;
      const gi = this.groupIndex[i];
      if (gi >= 0) {
        totals[gi]++;
        if (on) perGroup[gi]++;
      }
    });
    this.heads.forEach((li, gi) => {
      li.hidden = !perGroup[gi];
      li.querySelector('.vm-list-count').textContent = m ? `${perGroup[gi]} / ${totals[gi]}` : String(totals[gi]);
    });
  }

  /** One list row: poster, title, and a line of category, length and tags. */
  row(v, i) {
    const li = el('li');
    const b = el('button', 'vm-row');
    b.type = 'button';
    b.dataset.video = String(i);
    const thumb = el('span', 'vm-thumb');
    if (v.poster) {
      const img = el('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = this.host.resolve(v.poster);
      thumb.append(img);
    }
    const text = el('span', 'vm-row-text');
    const title = el('span', 'vm-row-title');
    title.textContent = v.title;
    const sub = el('span', 'vm-row-sub');
    sub.textContent = [
      v.categories?.[0] && this.host.labelFor(v.categories[0]),
      v.duration ? formatTime(v.duration) : null,
      (v.tags ?? []).slice(0, 3).join(', '),
    ].filter(Boolean).join(' · ');
    text.append(title, sub);
    b.append(thumb, text);
    li.append(b);
    return li;
  }
}

function section(title, content) {
  const s = el('div', 'vm-panel-section');
  const h = el('h3');
  h.textContent = title;
  s.append(h, content);
  return s;
}

function iconButton(icon, label, cls) {
  const b = el('button', `vm-icon-btn ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = ICONS[icon];
  return b;
}

function textButton(text, cls) {
  const b = el('button', cls);
  b.type = 'button';
  b.textContent = text;
  return b;
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [cls]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
