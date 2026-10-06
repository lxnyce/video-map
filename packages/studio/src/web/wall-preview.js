// Live preview of the wall: every video's rectangle as the build will lay it
// out (same core layout code), with thumbnails, group outlines and labels, and
// optionally the deepest level's tile grid. Hover names a video; click selects it.

import { useEffect, useRef, useState } from 'preact/hooks';
import { thumbUrl } from './api.js';
import { colorFor } from './scene.js';
import { html } from './ui.js';

/** Thumbnails shared across redraws: src → image (or null while loading / failed). */
const images = new Map();

/**
 * @param {{ wall: any, scene: any, probes: Record<string, any>, projectId: string, showTiles: boolean, onPick?: (index: number) => void }} props
 */
export function WallPreview({ wall, scene, probes, projectId, showTiles, onPick }) {
  const canvas = useRef(/** @type {HTMLCanvasElement|null} */ (null));
  const [hover, setHover] = useState(/** @type {{ index: number, x: number, y: number }|null} */ (null));
  const [tick, setTick] = useState(0);
  const view = useRef({ scale: 1, ox: 0, oy: 0 });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !wall) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    el.width = Math.round(cw * dpr);
    el.height = Math.round(ch * dpr);
    const ctx = el.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const { layout, pyramid, config } = wall;
    const pad = 16;
    const scale = Math.min((cw - pad * 2) / layout.width, (ch - pad * 2) / layout.height);
    const ox = (cw - layout.width * scale) / 2;
    const oy = (ch - layout.height * scale) / 2;
    view.current = { scale, ox, oy };
    const X = (x) => ox + x * scale;
    const Y = (y) => oy + y * scale;

    ctx.fillStyle = config.output.background;
    ctx.fillRect(X(0), Y(0), layout.width * scale, layout.height * scale);

    const videos = scene.videos ?? [];
    const cats = new Map((scene.categories ?? []).map((c) => [c.id, c]));
    layout.rects.forEach((r, i) => {
      const v = videos[i];
      if (!v) return;
      const cat = v.categories?.[0];
      const color = cat ? cats.get(cat)?.color ?? colorFor(cat) : '#5a6170';
      const x = X(r.x);
      const y = Y(r.y);
      const w = r.w * scale;
      const hh = r.h * scale;
      const img = thumbnail(projectId, v.src, probes[v.src], () => setTick((t) => t + 1));
      const p = probes[v.src]?.probe;
      if (img) {
        const fit = wall.fits[i];
        const aspect = p ? p.width / p.height : img.width / img.height;
        if (fit === 'cover') {
          // Crop the image to the cell's shape.
          const cellAspect = r.w / r.h;
          let sw = img.width;
          let sh = img.height;
          if (aspect > cellAspect) sw = sh * cellAspect;
          else sh = sw / cellAspect;
          ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, hh);
        } else {
          let dw = w;
          let dh = w / aspect;
          if (dh > hh) {
            dh = hh;
            dw = hh * aspect;
          }
          ctx.drawImage(img, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh);
        }
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, hh - 1));
        ctx.globalAlpha = 1;
      }
      // A thin category stripe along the bottom edge.
      ctx.fillStyle = color;
      ctx.fillRect(x, y + hh - Math.max(1.5, hh * 0.04), w, Math.max(1.5, hh * 0.04));
      if (probes[v.src]?.missing) {
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 1, y + 1, w - 2, hh - 2);
      }
    });

    if (showTiles) {
      const deepest = pyramid.levels[pyramid.maxZoom];
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let tx = 0; tx <= deepest.tilesX; tx++) {
        const x = Math.round(X(Math.min(layout.width, tx * pyramid.tile.w))) + 0.5;
        ctx.moveTo(x, Y(0));
        ctx.lineTo(x, Y(Math.min(layout.height, deepest.tilesY * pyramid.tile.h)));
      }
      for (let ty = 0; ty <= deepest.tilesY; ty++) {
        const y = Math.round(Y(Math.min(layout.height, ty * pyramid.tile.h))) + 0.5;
        ctx.moveTo(X(0), y);
        ctx.lineTo(X(Math.min(layout.width, deepest.tilesX * pyramid.tile.w)), y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (config.layout.labels !== false) {
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      for (const g of layout.groups) {
        const text = `${g.label} · ${g.count}`;
        const tw = ctx.measureText(text).width;
        ctx.strokeStyle = g.color ?? 'rgba(255,255,255,0.35)';
        ctx.globalAlpha = 0.7;
        ctx.strokeRect(X(g.x) + 0.5, Y(g.y) + 0.5, g.w * scale - 1, g.h * scale - 1);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(11,13,18,0.82)';
        ctx.fillRect(X(g.x) + 4, Y(g.y) + 4, tw + 12, 20);
        ctx.fillStyle = '#eef0f5';
        ctx.fillText(text, X(g.x) + 10, Y(g.y) + 8);
      }
    }

    if (hover && layout.rects[hover.index]) {
      const r = layout.rects[hover.index];
      ctx.strokeStyle = '#5b9dff';
      ctx.lineWidth = 2;
      ctx.strokeRect(X(r.x) + 1, Y(r.y) + 1, r.w * scale - 2, r.h * scale - 2);
    }
  }, [wall, scene, probes, showTiles, hover, tick]);

  const pick = (e) => {
    if (!wall) return null;
    const rect = canvas.current.getBoundingClientRect();
    const { scale, ox, oy } = view.current;
    const x = (e.clientX - rect.left - ox) / scale;
    const y = (e.clientY - rect.top - oy) / scale;
    const index = wall.layout.rects.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    return index >= 0 ? { index, x: e.clientX - rect.left, y: e.clientY - rect.top } : null;
  };

  const hovered = hover ? scene.videos?.[hover.index] : null;
  return html`
    <div class="wall-preview">
      <canvas ref=${canvas} role="img" aria-label=${wall ? `Preview of the wall: ${wall.layout.width} by ${wall.layout.height} pixels` : 'Wall preview'}
        onMouseMove=${(e) => {
          const h = pick(e);
          if (h?.index !== hover?.index) setHover(h);
          else if (h) setHover(h);
        }}
        onMouseLeave=${() => setHover(null)}
        onClick=${(e) => { const h = pick(e); if (h && onPick) onPick(h.index); }} />
      ${hovered && html`<div class="wall-tip" style=${`left:${hover.x + 12}px;top:${hover.y + 12}px`}>${hovered.title || hovered.id || hovered.src}</div>`}
    </div>`;
}

function thumbnail(projectId, src, info, redraw) {
  if (!info?.probe) return null;
  const key = `${projectId}|${src}`;
  if (images.has(key)) {
    const img = images.get(key);
    return img?.complete && img.naturalWidth ? img : null;
  }
  const img = new Image();
  img.onload = redraw;
  img.onerror = () => images.set(key, null);
  img.src = thumbUrl(projectId, src);
  images.set(key, img);
  return null;
}
