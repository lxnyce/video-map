# Scene format (`scene.json`)

The input to `vmap build`. Only `videos[].src` is required; everything else
has a default. The JSON Schema is at
[`packages/core/schema/scene.schema.json`](../packages/core/schema/scene.schema.json),
so editors that understand `$schema` give autocomplete and inline errors. A
complete example is in [examples/scene.example.json](examples/scene.example.json).

```json
{
  "title": "Nature Wall",
  "videos": [
    { "src": "media/reef.mov", "title": "Coral Reef", "categories": ["ocean"], "tags": ["fish"] }
  ]
}
```

## Top level

| Field | Type | Default | Notes |
|---|---|---|---|
| `title` | string | `"Untitled scene"` | |
| `description` | string | | |
| `surface` | object | plane | See below. |
| `preview` | object | | See below. |
| `layout` | object | | See below. |
| `output` | object | | See below. |
| `build` | object | | How to build (hardware encoding). See below. |
| `categories` | array | `[]` | `{ id, label?, color?, description? }`. Their order sets the order of category groups on the wall. |
| `videos` | array | required | See below. |

## `videos[]`

| Field | Type | Notes |
|---|---|---|
| `src` | string | **Required.** A path relative to the scene file, or an `http(s)` URL. Any format ffmpeg reads. |
| `id` | string | URL-safe and unique. If omitted, it's derived from the file name. Used for `media/{id}.mp4` and deep links. |
| `title` | string | Defaults to the id. |
| `description` | string | |
| `categories` | string[] | The first one is used for `groupBy: "category"`. |
| `tags` | string[] | Free-form. Tags shaped like `prefix:value` can be grouped with `groupBy: "tag:prefix"`. |
| `previewStart` | number | Seconds into the source where the preview loop starts. It's pulled back if less than one loop remains. |
| `fit` | string | Grid only: `"contain"` or `"cover"` for this video, overriding `layout.fit`. |
| `poster` | string | Image to use as the poster instead of a frame from the video. |
| `credits` | object | `{ author?, license?, url? }` |
| `links` | array | `{ label?, href }` |
| `meta` | object | Anything else. It's shown in the info panel and usable in `sortBy`/`groupBy` as `meta.<key>`. |

## `preview`

| Field | Default | Notes |
|---|---|---|
| `duration` | `10` | Loop length in seconds. Every tile has exactly `duration × fps` frames, so tiles loop together. |
| `fps` | `24` | Lower values are cheaper to decode on phones (try 15). |
| `startStrategy` | `"auto"` | `"auto"` skips about the first 10% of long videos; `"start"` begins at 0. |
| `loopShort` | `true` | Loop videos shorter than `duration`. When `false`, the last frame is held. |

## `layout`

Videos are grouped, sorted, then packed. Two packing strategies:

- **`"grid"`** (the default): every video gets a cell of the same shape.
  `fit: "contain"` (the default) shows the whole frame with bars;
  `"cover"` crops it to fill the cell.
- **`"masonry"`**: fixed-width columns. Each video's height comes from its
  own aspect ratio, so the whole frame shows with no bars and no cropping.
  In sort order, each video goes to the shortest column (ties go to the
  leftmost). Extreme shapes are clamped to between a third of and twice the
  column width tall, and only those get bars.

| Field | Default | Notes |
|---|---|---|
| `pack` | `"grid"` | `"grid"` or `"masonry"`. |
| `groupBy` | `"category"` | `"none"`, `"category"`, `"tag:<prefix>"` or `"meta.<key>"`. Videos without a value go to an "Other" group, placed last. |
| `sortBy` | `["title"]` | Keys: `id`, `title`, `duration`, `category`, `src`, `meta.<key>`. Prefix with `-` for descending order. Missing values sort last. In masonry this is also the order videos are dealt to columns. |
| `aspect` | `"16:9"` | Wall aspect, when `output.canvas` isn't set. |
| `groupGap` | `1` (grid), `0` (masonry) | Empty cells (grid) or whole columns (masonry) between groups. |
| `labels` | `true` | Whether the viewer shows group labels. In masonry, a label strip is reserved above each group. |
| `cellAspect` | `"16:9"` | Grid only. Aspect of each cell. |
| `fit` | `"contain"` | Grid only. `"contain"` letterboxes with `output.background`; `"cover"` crops to fill the cell. |
| `columnWidth` | `384` | Masonry only. Column width in pixels at full zoom. With `output.canvas` and no `columnWidth`, it's derived so the wall fits the canvas. |
| `gap` | `0` | Masonry only. Gutter between videos, in pixels at full zoom (rounded to even). |
| `groupArrange` | `"columns"` | Masonry only. `"columns"` puts groups side by side, each in its own run of whole columns sized to its videos, so groups end at about the same height. Groups wrap onto shelves when there are too many for one row. `"bands"` stacks groups as full-width horizontal bands instead. |
| `avoidSplits` | `true` | Masonry only. A video that fits inside one tile is moved down to the next tile edge rather than crossing it. See below. |

**Masonry and tiles.** Tiles are a whole number of columns wide, so column
edges always fall on tile edges. Tile height is free, so a video can cross a
horizontal tile edge, and then two tiles each show part of it. The builder
crops each part into its tile, and the viewer keeps the two tiles in tight
sync. `avoidSplits` (on by default) keeps most videos inside one tile at the
cost of some empty space, and masonry tiles are taller by default (768×1024)
so that most videos fit in one.

## `output`

| Field | Default | Notes |
|---|---|---|
| `canvas` | | Full-resolution wall size, e.g. `"7680x4320"`. Grid: the cell size is derived from it. Masonry: the column width is (unless `layout.columnWidth` is set). |
| `cell` | `"384x216"` | Grid only. Size of one video at full zoom. Set either `canvas` or `cell`, not both. |
| `tile` | `"768x432"` (grid), `"768x1024"` (masonry) | Target tile size. It's snapped to a whole number of cells (grid) or columns (masonry), max 2048 px. |
| `tileCrf` | `28` | Tile quality (x264 CRF, or the hardware encoder's equivalent). A bitrate cap also applies. |
| `tileCodecs` | `["h264"]` | Tile codecs in order of preference: `"h264"`, `"vp9"`. The viewer plays the first one the browser supports. |
| `background` | `"#101318"` | Color of empty space, gutters and letterboxing. |
| `stills` | `true` | Emit a WebP still per tile. |
| `full.enabled` | `true` | Emit full renditions for the floating player. `false` builds **tiles only**: no `media/` folder (files from an earlier build are removed), and the viewer opens an info card with the poster and details instead of a player. Full renditions are usually most of the output's size. |
| `full.maxHeight` | `1080` | |
| `full.crf` | `23` | Used when a source has to be transcoded. |

## `build`

How to build, not what to build. CLI flags (and, later, the Studio's
per-machine settings) override these.

| Field | Default | Notes |
|---|---|---|
| `hardware` | `"auto"` | H.264 encoder: `"auto"` uses the first hardware encoder that passes a test encode (NVENC, Quick Sync, AMF, VideoToolbox, then VA-API) and falls back to libx264. `"off"` always uses libx264. A name (`"nvenc"`, `"qsv"`, `"amf"`, `"videotoolbox"`, `"vaapi"`) asks for that one; if it doesn't work, the build warns and uses libx264. |
| `hardwareFinal` | `false` | Also use hardware for the final tiles. By default the tiles viewers download stay on libx264, while hardware encodes the cached intermediates and full renditions. That measured both faster overall and smaller (see [cli.md](cli.md#hardware-encoding)). |
| `hardwareJobs` | `3` | Concurrent hardware encode sessions. Consumer GPUs limit these. |

VP9 tiles, stills and posters never use hardware encoding.

## `surface`

| Field | Default | Notes |
|---|---|---|
| `type` | `"plane"` | `"plane"`, `"cylinder"` or `"sphere"`. Curved surfaces are rendered by the viewer in milestone 4. |
| `arc` | `360` | Cylinder: degrees wrapped. Sphere: longitude span. |
| `latitudeBand` | `[-60, 60]` | Sphere only. Avoids distortion at the poles. |
| `view` | `"inside"` | `"inside"` (immersive) or `"outside"` (object). |

## Runtime manifest (`dist/scene.json`)

The build writes a different `scene.json` into the output folder, with
`"format": "videomap-scene"` and `"version": 2`. It holds everything the
viewer needs:

- `layout`: the packing (`{ "pack": "grid" }`, or for masonry its
  `columnWidth`, `gap`, `columns`, `labelHeight` and `groupArrange`)
- `grid`: `cols`, `rows` and the cell size, for grid walls only (`null` for
  masonry)
- the pyramid: tile size, URL template and codec string for the preferred
  tile codec (others in `video.alternates`), and for each level its
  `tilesX`, `tilesY`, `scale` and the list of tiles that exist. Levels 1 and
  up halve the resolution each step. Level 0 is a single overview tile with
  the whole wall scaled to fit it, anchored top-left. A tile's rectangle in
  full-resolution pixels is always `(x, y, w, h) × tile size / scale`.
- the groups, each with its rectangle (`x`, `y`, `w`, `h`) on the wall
- each video's rectangle (`rect`, in full-resolution wall pixels), its
  `cell` in grid walls, its metadata and preview start, and the paths of its
  full rendition (`null` when built tiles-only) and poster

Version 1 manifests (milestones 1 and 2) had only cells; the viewer still
reads them. The manifest is produced by `createRuntimeManifest` in
`packages/core/src/manifest.js`.
