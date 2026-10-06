// The runtime manifest (dist/scene.json) that the viewer loads.

export const SCENE_FORMAT = 'videomap-scene';
// 2: videos[].rect, group rectangles and `layout` (masonry); `grid` is null for masonry.
export const SCENE_VERSION = 2;

/** Output paths, relative to the output folder. */
export const PATHS = Object.freeze({
  tile: 'tiles/{z}/{x}/{y}.mp4',
  still: 'stills/{z}/{x}/{y}.webp',
  media: 'media/{id}.mp4',
  poster: 'posters/{id}.webp',
});

/**
 * @param {string} template e.g. "tiles/{z}/{x}/{y}.mp4"
 * @param {Record<string, string|number>} vars
 */
export function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`Missing template variable "${k}" in ${template}`);
    return String(vars[k]);
  });
}

/**
 * @typedef {object} ManifestVideo
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {string[]} categories
 * @property {string[]} tags
 * @property {any} [credits]
 * @property {any[]} [links]
 * @property {Record<string, any>} [meta]
 * @property {number|null} duration  source duration in seconds
 * @property {number|null} width     source display width
 * @property {number|null} height
 * @property {boolean} hasAudio
 * @property {number} previewStart  where the preview loop starts in the source
 * @property {boolean} looped        the source is shorter than the loop and repeats
 * @property {string|null} media     full rendition path (null for tiles-only builds)
 * @property {string|null} poster
 * @property {'cover'|'contain'} [fit] grid only: how the frame fills its cell
 */

/**
 * @param {object} args
 * @param {import('./config.js').ResolvedConfig} args.config
 * @param {import('./pyramid.js').Pyramid} args.pyramid
 * @param {import('./wall.js').WallLayout} args.layout
 * @param {ManifestVideo[]} args.videos  in the same order as the layout's video indexes
 * @param {Array<Array<[number, number]>>} args.tiles occupied tiles per level
 * @param {Array<{ template: string, mime: string }>} args.tileSources  in order of preference
 * @param {Array<{ id: string, label?: string, color?: string }>} [args.categories]
 * @param {{ name: string, version: string }} [args.generator]
 */
export function createRuntimeManifest({ config, pyramid, layout, videos, tiles, tileSources, categories = [], generator }) {
  const cellOf = new Map((layout.grid?.cells ?? []).map((c) => [c.video, c]));
  const rectOf = new Map(layout.rects.map((r) => [r.video, r]));
  const m = layout.masonry;
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    generator: generator ?? null,
    title: config.title,
    description: config.description,
    surface: config.surface,
    preview: { duration: config.preview.duration, fps: config.preview.fps, frames: config.preview.frames },
    background: config.output.background,
    layout: m
      ? { pack: 'masonry', columnWidth: m.columnWidth, gap: m.gap, columns: m.columns, labelHeight: m.labelHeight, groupArrange: m.groupArrange }
      : { pack: 'grid' },
    // Grid-only fast paths (picking by cell index); null for other packings.
    grid: layout.grid ? { cols: layout.grid.cols, rows: layout.grid.rows, cell: layout.grid.cell } : null,
    content: { width: pyramid.contentWidth, height: pyramid.contentHeight },
    pyramid: {
      tile: pyramid.tile,
      cellsPerTile: pyramid.k,
      maxZoom: pyramid.maxZoom,
      // The viewer plays the first source the browser supports.
      video: { ...tileSources[0], alternates: tileSources.slice(1) },
      still: config.output.stills ? { template: PATHS.still, mime: 'image/webp' } : null,
      levels: pyramid.levels.map((l) => ({ ...l, tiles: tiles[l.z] })),
    },
    labels: config.layout.labels,
    categories,
    groups: layout.groups,
    videos: videos.map((v, i) => {
      const cell = cellOf.get(i);
      const r = rectOf.get(i);
      return { ...v, rect: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null, cell: cell ? { col: cell.col, row: cell.row } : null };
    }),
  };
}
