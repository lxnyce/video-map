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

| Field | Default | Notes |
|---|---|---|
| `cellAspect` | `"16:9"` | Aspect of each video's cell. |
| `aspect` | `"16:9"` | Wall aspect, when `output.canvas` isn't set. |
| `fit` | `"cover"` | `"cover"` crops to fill the cell; `"contain"` letterboxes with `output.background`. |
| `groupBy` | `"category"` | `"none"`, `"category"`, `"tag:<prefix>"` or `"meta.<key>"`. Videos without a value go to an "Other" group, placed last. |
| `sortBy` | `["title"]` | Keys: `id`, `title`, `duration`, `category`, `src`, `meta.<key>`. Prefix with `-` for descending order. Missing values sort last. |
| `groupGap` | `1` | Empty cells between group blocks. |
| `labels` | `true` | Whether the viewer shows group labels. |

## `output`

| Field | Default | Notes |
|---|---|---|
| `canvas` | | Full-resolution wall size, e.g. `"7680x4320"`. The cell size is derived from it. |
| `cell` | `"384x216"` | Size of one video at full zoom. Set either `canvas` or `cell`, not both. |
| `tile` | `"768x432"` | Target tile size. It's snapped to a whole number of cells (max 2048 px). |
| `tileCrf` | `28` | x264 CRF for tiles. A bitrate cap also applies. |
| `tileCodecs` | `["h264"]` | Tile codecs in order of preference: `"h264"`, `"vp9"`. The viewer plays the first one the browser supports. |
| `background` | `"#101318"` | Color of empty cells and letterboxing. |
| `stills` | `true` | Emit a WebP still per tile. |
| `full.enabled` | `true` | Emit full renditions for the floating player. |
| `full.maxHeight` | `1080` | |
| `full.crf` | `23` | Used when a source has to be transcoded. |

## `surface`

| Field | Default | Notes |
|---|---|---|
| `type` | `"plane"` | `"plane"`, `"cylinder"` or `"sphere"`. Curved surfaces are rendered by the viewer in milestone 3. |
| `arc` | `360` | Cylinder: degrees wrapped. Sphere: longitude span. |
| `latitudeBand` | `[-60, 60]` | Sphere only. Avoids distortion at the poles. |
| `view` | `"inside"` | `"inside"` (immersive) or `"outside"` (object). |

## Runtime manifest (`dist/scene.json`)

The build writes a different `scene.json` into the output folder, with
`"format": "videomap-scene"`. It holds everything the viewer needs:

- the grid (`cols`, `rows`, cell size)
- the pyramid: tile size, URL template and codec string for the preferred
  tile codec (others in `video.alternates`), and for each level its
  `tilesX`, `tilesY`, `scale` and the list of tiles that exist. Levels 1 and
  up halve the resolution each step. Level 0 is a single overview tile with
  the whole wall scaled to fit it, anchored top-left. A tile's rectangle in
  full-resolution pixels is always `(x, y, w, h) × tile size / scale`.
- the groups and their cell rectangles
- each video's cell, metadata, preview start, and full-rendition and poster
  paths

It's produced by `createRuntimeManifest` in `packages/core/src/manifest.js`.
