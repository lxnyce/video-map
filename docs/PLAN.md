# VideoMap — Implementation Plan (for review)

**Status:** Milestones 1–3 built · **Revision 2:** 2026-10-05

> **What changed in revision 2:** videos are no longer cropped by default
> (G12). The packing strategy can now be chosen, and masonry columns are the
> first new one (G13, §5.1). Hardware encoding is on by default (G14, §5.2). A
> tiles-only output saves disk space (G15, §5.3). A new milestone 3 covers this
> work (§11).

VideoMap plays hundreds of videos at the same time on a flat, cylindrical or
spherical surface. It arranges them into tiles automatically, lets the viewer
pan and zoom like a map, and opens any one video in a floating high-resolution
player. A Node CLI turns a JSON list of videos into a static folder. You can
drop that folder into any directory of any web host.

---

## 1. Goals and constraints

| # | Requirement | How the plan meets it |
|---|---|---|
| G1 | Hundreds of videos visibly playing at once | The videos are pre-composited into **mosaic tiles** (the map-pyramid idea), so the browser decodes a few tile videos, not hundreds of files |
| G2 | Flat, cylindrical, spherical surfaces | One quadtree tile renderer that maps tile (u,v) space onto a pluggable surface function |
| G3 | Auto-organize into tiles | Layout engine groups and sorts by category and tags, then packs the videos with a selectable strategy: a uniform grid aligned with the tiles, or masonry columns (§5.1) |
| G4 | Smooth on low-end phones | A hard cap on how many videos decode at once, an adaptive level of detail, H.264 Main profile, a still-image pyramid as fallback, and a small custom WebGL renderer |
| G5 | Click → floating, maximizable player with the higher-resolution file | A windowed player that plays a per-video "full" rendition and stays visibly linked to the video's cell on the wall |
| G6 | Configurable preview length; shorter videos loop | `preview.duration` sets one shared loop length; short clips are looped up to it when the tiles are built. *(As built: `preview.duration` / `--preview-duration`, default 10 s, up to 300 s. Tile size grows linearly with it.)* |
| G7 | Selectable output resolution | `--canvas WxH` (or `--cell WxH`) plus `--tile WxH` set the full-resolution pixel size of the pyramid |
| G8 | Hostable from any folder | All output paths are relative, there are no server-side requirements, and one `index.html` is the entry point |
| G9 | CLI from a JSON manifest | `vmap build scene.json --out dist/` |
| G10 | Professional front end, with uploads, JSON editing and sample scenes later | A "Studio" app on a Node backend that calls the same build pipeline |
| G11 | JavaScript / Node | Node ≥ 22 (ESM), plain JS with JSDoc types and `checkJs`, Vite for front-end bundling |
| G12 | Show each video's whole frame, never cropped | `layout.fit: "contain"` becomes the default and letterboxes inside grid cells. Masonry packing gives each video a cell with its own aspect ratio, so it needs neither cropping nor borders |
| G13 | Control the packing order and strategy | `layout.pack`: `"grid"` (as built, and still the default) or `"masonry"` (opt-in: fixed-width columns, each video goes to the shortest column, groups side by side as column groups or stacked as bands). Later: `"rows"`, `"random"`, `"rotated"`, `"stack"` (§5.1) |
| G14 | Fast builds with hardware encoding | `build.hardware: "auto"` (the default) finds a working NVENC, Quick Sync, AMF, VideoToolbox or VAAPI encoder and falls back to libx264. It can be changed from the CLI and the Studio (§5.2) |
| G15 | Tiles-only output to save disk space | `output.full.enabled: false` (`--no-full`) skips full renditions. The floating window then shows the poster and metadata (§5.3) |

---

## 2. The core problem and the chosen approach

### Why "one `<video>` per file" fails

Browsers and phones limit how many videos they can decode at once. Mobile
hardware decoders usually allow about 4–16 concurrent streams. iOS Safari and
low-end Android devices stall, drop frames or refuse to play past that. Even
desktop Chrome struggles with more than about 50 `<video>` elements. Hundreds of
separate decodes is not workable on a phone.

### Chosen approach: a video tile pyramid (like OpenLayers/Leaflet, but every tile is a video)

```
Level 0   ┌───────┐            1 tile   – every video, tiny (all of them playing)
          │▪▪▪▪▪▪▪│
          └───────┘
Level 1   ┌───┬───┐            2×2 tiles
          ├───┼───┤
          └───┴───┘
Level 2   4×4 tiles  …         …
Level N   2^N × 2^N tiles      – full "canvas" resolution chosen by the user
```

* The **CLI** composites all preview clips onto a large virtual canvas and cuts
  it into fixed-size tile videos at each zoom level. Every tile is a short H.264
  MP4, and every tile has **exactly the same duration and frame rate** (the
  preview loop length).
* The **viewer** shows only the tiles that are visible, at the level that
  matches the current zoom, just as a slippy map does. Zoomed out, a single
  level-0 tile shows *every* video playing. That is one decoder for hundreds of
  videos.
* The number of tile videos playing at once is **capped**, for example at 4 on
  low-end phones and 9–16 on desktops. When the cap would be exceeded, the
  viewer drops to a lower-resolution level. The display never stalls.
* Tile videos are uploaded as **WebGL textures** and drawn onto plane, cylinder
  or sphere geometry.

### Alternatives considered (and rejected)

| Option | Why not |
|---|---|
| One `<video>` per source file | Runs into decoder limits, as described above |
| Animated WebP/GIF sprite sheets | Large files, heavy CPU decode, no hardware acceleration, and high memory use |
| A single giant mosaic video | It can't be zoomed to detail, and an 8K stream won't decode on phones |
| WebCodecs to decode a custom stream | Powerful, but support is uneven on older iOS. Kept as a **future** optimization behind the same tile interface |
| HLS/DASH adaptive tiles | Adds server and segmenter complexity for clips that are only seconds long. Short progressive MP4s are simpler and cache well. HLS stays an option for the *full-resolution* player |

---

## 3. System overview

```
                ┌─────────────────────────────── Node ──────────────────────────────┐
 scene.json ──▶ │ validate ─▶ probe (ffprobe) ─▶ layout ─▶ normalize clips ─▶ tiles │ ──▶ dist/
 (+ files)      │                                         (loop/trim/scale)   pyramid│      index.html
                │                     └─▶ full renditions ─▶ posters ─▶ manifest   │      viewer.[hash].js
                │                         (optional)                                │      scene.json
                │        encoder: hardware (NVENC/QSV/AMF/VT/VAAPI) or libx264      │      tiles/{z}/{x}/{y}.mp4
                └───────────────────────────────────────────────────────────────────┘      stills/{z}/{x}/{y}.webp
                      ▲                                                                    media/{id}.mp4 (optional)
                      │ same pipeline (job queue)
                ┌─────┴──────┐
                │  Studio    │  upload, edit metadata, preview, build, download zip        posters/{id}.webp
                │ (web + API)│
                └────────────┘
```

### Repository layout (npm workspaces monorepo)

```
video-map/
├─ packages/
│  ├─ core/        # Pure JS, shared by CLI, Studio and viewer: schemas, layout, pyramid math, manifest types
│  ├─ builder/     # ffmpeg/ffprobe pipeline: probe, normalize, composite, encode, posters, cache
│  ├─ cli/         # `vmap` command (thin wrapper over builder)
│  ├─ viewer/      # Static runtime: WebGL renderer, tile scheduler, controls, floating player, UI
│  └─ studio/      # Authoring app: web UI (Vite) + Node API server (Fastify) + job queue
├─ samples/        # Sample scene manifests (+ script to fetch openly licensed source clips)
├─ docs/
└─ test/fixtures/  # Synthetic clips generated with ffmpeg `testsrc` (no binaries committed)
```

---

## 4. Input manifest (JSON) — `scene.json`

Validated with JSON Schema (`ajv`). The schema is published from `packages/core`
so the Studio and CLI share it, and editors get autocomplete.

```jsonc
{
  "$schema": "https://…/video-map/scene.schema.json",
  "title": "Nature Wall",
  "description": "Optional scene description",
  "surface": {
    "type": "cylinder",            // "plane" | "cylinder" | "sphere"
    "arc": 360,                    // cylinder: degrees wrapped; sphere: longitude span
    "latitudeBand": [-60, 60],     // sphere only: avoid pole distortion
    "view": "inside"               // cylinder/sphere: "inside" (immersive) | "outside" (object)
  },
  "preview": {
    "duration": 10,                // seconds; the shared loop length for every tile
    "fps": 24,                     // tile frame rate (lower = cheaper on phones)
    "startStrategy": "auto",       // "auto" (skip intros ~10%) | "start" | per-video previewStart
    "loopShort": true              // loop clips shorter than duration (default)
  },
  "layout": {
    "pack": "grid",                // "grid" | "masonry" (later: "rows" | "random" | "rotated" | "stack"), §5.1
    "cellAspect": "16:9",          // grid only
    "fit": "contain",              // grid only: "contain" (letterbox, default) | "cover" (crop to fill)
    "columnWidth": 384,            // masonry only: column width in px at full zoom (or derived from canvas)
    "gap": 0,                      // masonry only: gutter between videos in px at full zoom
    "groupBy": "category",         // "category" | "tag:<name>" | "none"
    "sortBy": ["category", "title"],  // also sets the order videos are dealt to columns in masonry
    "groupArrange": "columns",     // masonry only: "columns" (side-by-side column groups, default) | "bands"
    "groupGap": 1,                 // empty cells (grid) or whole columns (masonry, default 0) between groups
    "labels": true                 // draw group labels on the wall
  },
  "output": {
    "canvas": "7680x4320",         // full-res pyramid size in px (or use "cell")
    "cell": null,                  // e.g. "384x216" – alternative to canvas
    "tile": "768x432",             // tile video size in px
    "full": { "enabled": true, "maxHeight": 1080, "codec": "h264" },   // false = tiles only (§5.3)
    "stills": true                 // also emit a still-image pyramid (fallback + instant first paint)
  },
  "build": {                       // how to build, not what: CLI flags and Studio settings override it
    "hardware": "auto",            // "auto" | "off" | "nvenc" | "qsv" | "amf" | "videotoolbox" | "vaapi", §5.2
    "hardwareFinal": false,        // also use hardware for the final tiles (default false = x264 for those only)
    "hardwareJobs": 3              // concurrent hardware encode sessions
  },
  "categories": [
    { "id": "ocean", "label": "Ocean", "color": "#2b7bb9" }
  ],
  "videos": [
    {
      "id": "reef-01",                         // stable, URL-safe; generated if omitted
      "src": "media/reef-01.mov",              // path relative to the manifest, or http(s) URL
      "title": "Coral Reef",
      "description": "Long-form description…",
      "categories": ["ocean"],
      "tags": ["underwater", "4k", "fish"],
      "previewStart": 12.5,                    // optional
      "fit": "cover",                          // optional per-video override of layout.fit (grid only)
      "poster": "posters/reef.jpg",            // optional; otherwise extracted
      "credits": { "author": "…", "license": "CC-BY-4.0", "url": "…" },
      "links": [{ "label": "Source", "href": "…" }],
      "meta": { "anything": "free-form, shown in the info panel" }
    }
  ]
}
```

Every CLI flag overrides the matching manifest field. Values set nowhere fall
back to defaults tuned for phones.

---

## 5. Build pipeline (`packages/builder`)

1. **Validate** the manifest with the schema. Give friendly errors with JSON paths.
2. **Probe** each source with `ffprobe` for duration, dimensions, rotation, fps,
   audio and codec. Fail fast on unreadable files.
3. **Layout** (pure, in `core`). Steps 3–6 below describe `pack: "grid"`.
   §5.1 covers masonry and how it changes the tile invariant.
   * Group, then sort, then shelf-pack each group as a rectangular block, with
     gaps between groups. Several shelf widths and block heights are tried, and
     the most compact packing nearest the target aspect wins.
     *(As built: typical category mixes fill 80–88% of the grid.)* For a cylinder the grid wraps horizontally. For a sphere the grid
     is laid out on equirectangular (u,v) space inside the latitude band.
   * The **grid snaps to tile boundaries.** Tile dimensions are an integer
     multiple of the cell dimensions at the deepest level, and each level up
     doubles the cells per tile along each axis, so **no cell ever straddles two tiles at any level.** That
     prevents seams and keeps picking simple.
   * Grid shape: choose `cols × rows` to match the canvas aspect (for example
     400 videos → 20×20 cells of 16:9 → a 16:9 canvas). Unused cells get a
     neutral backdrop or a group label.
   * Levels halve Deep-Zoom style (`ceil(n/2)` tiles per axis), so the canvas
     doesn't need padding to a power of two. *(As built: edge tiles keep the
     full tile size and are filled with the background color, so every tile
     video has the same dimensions.)*
4. **Normalize preview clips** (one ffmpeg job per video, run in parallel):
   seek to `previewStart`, then **loop clips shorter than `duration`**
   (`-stream_loop -1` + trim). Trim long ones. Then apply fps, `cover`/`contain`
   scaling to the cell size at the deepest level, and a constant frame count of
   `duration × fps`. All clips come out frame-exact and the same length, so
   every tile loops seamlessly and in sync.
   *(Revision 2: `contain` becomes the default and can be overridden per
   video. In masonry each clip is scaled to its own rectangle, so it is never
   cropped or padded beyond rounding to even pixels.)*
5. **Deepest tile level:** each tile is an `xstack` of the normalized clips that
   fall inside it (for example 2×2 to 4×4 cells). Empty slots use a color source.
6. **Lower levels, built bottom-up:** each parent tile = the 2×2 child tiles,
   stacked and scaled by 0.5. That costs the same per tile at every level and
   never needs a huge canvas in memory. It works the way `gdal2tiles` builds
   overviews. *(As built: each tile run also writes a high-quality master into
   the cache, and parents are built from masters rather than from the final
   CRF-28 tiles, so quality doesn't degrade level after level. Level 0 is an
   overview tile with the whole wall scaled to fit it, not the next power of
   two down. In a 240-video test, halving alone left the wall filling only
   28% of that tile.)*
7. **Encoding (tiles):** H.264 **Main** profile, `yuv420p`, no audio,
   `+faststart`, a keyframe at frame 0 and every 1 s, even pixel dimensions, CRF ~28 with a bitrate cap,
   and `-tune fastdecode`. Optional extra AV1/HEVC sources can come later
   (`<source>` negotiation).
   *(As built: optional VP9 tiles (`--tile-codecs h264,vp9`) are written
   from the same composite, and the viewer plays the first codec the browser
   supports. VP9 also lets the browser tests exercise real video playback in
   Playwright's Chromium, which has no H.264.)*
   *(Revision 2: H.264 encodes go to a hardware encoder when one works. VP9
   stays on libvpx. See §5.2.)*
8. **Stills pyramid:** the first frame of each tile → WebP. These give instant
   first paint, a fallback while a video tile loads, and the image for
   reduced-motion and Low Power modes.
9. **Full renditions:** each source → H.264 MP4 (≤ `full.maxHeight`) with AAC
   audio and faststart, plus a poster image. Optional HLS output for long sources.
   *(As built: sources that are already web-compatible are remuxed, not
   re-encoded. Revision 2: full renditions can be turned off and posters are
   still made. See §5.3.)*
10. **Emit** the output `scene.json` (runtime manifest), copy the prebuilt viewer
    bundle and `index.html`, and write a build report: sizes, timing, and
    warnings such as "video X upscaled 3×".

**Incremental builds and caching:** each artifact is keyed by
`hash(source file fingerprint + relevant params)` in `.vmap-cache/`. Changing
only metadata rebuilds only the manifest. Changing the layout re-encodes tiles
from cached normalized clips without re-decoding the sources.

**Concurrency:** a worker pool sized to the number of CPUs (`--jobs`), with a
progress bar and ETA. ffmpeg comes from the system `PATH` (or `--ffmpeg`).
*(The `ffmpeg-static` fallback is deferred: its binaries are downloaded at
install time, which fails behind restrictive networks. `vmap doctor` explains
what's missing instead.)*

**Size estimate (example):** 400 videos, 7680×4320 canvas, 768×432 tiles, 10 s
at 24 fps → levels of 10×10, 5×5, 3×3, 2×2 and 1×1 tiles = **139 tile videos at ~0.5–1 MB each ≈ 70–140 MB**, plus
the full renditions. The build report prints this estimate *before* encoding.

### 5.1 Packing strategies (`layout.pack`) — revision 2

The grid makes every video the same shape, so a portrait clip on a 16:9 wall
is either cropped hard (`cover`) or shrunk inside wide black bars
(`contain`). Packing strategies let each video keep its own shape.

**The layout model becomes rectangles.** Each strategy outputs one rectangle
per video, `{ x, y, w, h }`, in full-resolution wall pixels. The runtime
manifest stores it as `videos[].rect`. The grid outputs rectangles too
(cell position × cell size) and keeps `cell` for the grid-only fast paths. The
builder, picking, highlight, leader line, Locate, group labels and filtering
all work from `rect`, so every strategy uses the same code. The model leaves
room for an optional `rotation` and `z` later.

| `pack` | Shape of each video | Order | Status |
|---|---|---|---|
| `grid` | Uniform cells (`cellAspect`), `fit: contain` or `cover` | Row-major within shelf-packed group blocks | Built (`contain` becomes the default) |
| `masonry` | Fixed column width, height from the video's own aspect | Each video, in sort order, goes to the **shortest column** (ties go to the leftmost) | Milestone 3, opt-in (`grid` stays the default) |
| `rows` | Fixed row height, width from the aspect (justified rows) | Left to right, wrapping when a row is full | Later |
| `random`, `rotated`, `stack` | Free placement, optional rotation and overlap (photo-stack look) | Seeded, so builds can be reproduced | Later. Needs rotated compositing (`rotate` + alpha `overlay`) and z-ordered, rotated picking |

**Masonry in detail:**

* **Column width** `W` comes from `layout.columnWidth` (default 384 px), or is
  derived from `output.canvas`. Each video's height is
  `h = even(W / displayAspect)`, using the aspect after rotation and
  sample-aspect correction. That is the whole frame with no borders. Extreme
  shapes are clamped to between `W/3` and `2W` tall, and only clips beyond
  that range get borders inside the clamp. A 9:16 phone clip at `W = 384`
  is 682 px tall (heights are rounded to even pixels).
* **Column count:** like the grid's packer, the layout tries a range of column
  counts around `√(Σ area × aspect) / W`. The winner best matches
  `layout.aspect` with the least empty space under the shorter columns.
  *(As built: the search estimates each candidate with `avoidSplits`
  applied. With 1024 px tiles, avoiding splits adds about 15% height, and
  ignoring it skewed the chosen shape. With a canvas and no `columnWidth`,
  the column width is fitted to both canvas dimensions, not just the width.)*
* **Groups:** `layout.groupArrange` picks how groups are arranged.
  * `"columns"` (the default) places groups **side by side as column
    groups**. Each group gets a run of whole columns, sized in proportion to
    its total video area, so neighbouring groups end at about the same
    height. Each group gets at least one column. A label strip sits above each
    group. When there are too many groups for one row, they wrap onto shelves,
    the same way the grid's shelf packer wraps its blocks. The space between
    groups is `groupGap` whole columns (default 0 for masonry), which keeps
    column edges on tile edges. The viewer draws a thin divider between
    adjacent groups.
    *(As built: after each group's first column, every spare column goes to
    whichever group is currently tallest. That levels the groups better than
    rounding a proportional share. For shelves, a range of target heights is
    tried, and each group gets enough columns to stay under the target.)*
  * `"bands"` stacks groups as horizontal **bands** across the full width.
    Before a group starts, every column is levelled to the tallest one, the
    leftover space is filled with background, and a label band is reserved.
* **Gutter:** `layout.gap` px between videos. It is drawn as background.

**Effect on the tile invariant (§5 step 3).** The grid guarantees that no cell
crosses a tile edge. Masonry keeps that guarantee horizontally only:

* Tile width is a whole number of columns, `k × (W + gap)`, so column edges
  fall on tile edges at every level.
* Tile height is independent, so **videos can cross horizontal tile edges.**
  A tall clip may be taller than a whole tile.
* **Builder:** a deepest-level tile composites every clip whose `rect`
  intersects it. Each input is first cropped to the part inside the tile
  (`crop`), then placed with `xstack` as today. A normalized clip is cached
  once and reused by every tile it touches. Parent levels don't change,
  because they only depend on tile geometry. *(As built: videos that share a
  source and size also share one clip. Before, two such videos could encode
  the same cache file at once and fail.)*
* **Visible tears:** if two tiles that share a video drift apart by even a
  frame, the video shows a seam. Mitigations:
  1. The scheduler treats tiles that share a video as one sync group, with a
     tighter drift threshold.
  2. `layout.avoidSplits: true` (the default for masonry) moves a clip that
     fits inside one tile down to the next tile edge rather than letting it
     cross one. Edges at coarser levels are multiples of the deepest ones, so
     this holds at every level. The cost is some empty space per column.
  3. The default tile height for masonry is taller (for example 1024 px), so
     most clips fit inside one tile.
* **Viewer:** picking maps the wall point to its column, then binary-searches
  that column's videos by `y`. Rendering is unchanged, because tiles are still
  tiles. *(As built: picking uses one coarse bucket index over the video
  rectangles for every packing, so the grid and masonry share a code path, and
  future free-placement packers will too.)*

Masonry wraps on a cylinder the same way the grid does, since columns tile
horizontally.

### 5.2 Hardware encoding — revision 2

On by default (`build.hardware: "auto"`). It can be changed with `--hw` or
from the Studio's build settings.

* **Detection:** read `ffmpeg -encoders`, then run a 0.2 s **test encode**
  with each candidate, in the order NVENC → Quick Sync → AMF → VideoToolbox →
  VAAPI. A listed encoder may still have no device or driver behind it. On the
  development machine, the ffmpeg build lists NVENC, QSV and AMF, but only
  NVENC works. The result is cached per ffmpeg binary and version, and
  `vmap doctor` prints it. *(As built: each candidate encodes 12 frames
  with both its master and its final-tile settings, and ffprobe checks the
  final-tile output for Main profile and no B-frames. Results are cached for
  7 days in the user cache folder (`VMAP_HW_CACHE` overrides it);
  `vmap doctor` always re-tests and shows ffmpeg's specific reason, for
  example "DLL amfrt64.dll failed to open". Detection takes about 1.3 s
  uncached.)*
* **What uses it:** every H.264 encode. That covers the normalized clips, the
  tile masters, the final tiles and transcoded full renditions. VP9 tiles stay
  on libvpx. WebP stills and posters don't change.
* **Final tiles:** `build.hardwareFinal` (default `false` since milestone 3;
  it was `true`) decides whether the final tiles also go to the hardware
  encoder. With `false` (the default; `--hw-final` or the Studio switch turns
  it on), only the final tiles are encoded with x264. Those are the
  bytes viewers download, and hardware still handles the intermediates and
  full renditions, which take most of the build time.
* **Settings mapping:** each encoder gets a table of equivalent settings. The
  high-quality intermediates use the encoder's constant-quality mode (for
  example NVENC `-rc vbr -cq 18 -b:v 0`). The final tiles keep the browser
  contract from §5 step 7: Main profile and level, a keyframe every second,
  the bitrate cap and faststart. They use the closest equivalent of
  `-tune fastdecode` where one exists (no B-frames, CAVLC where supported). A
  test checks the output with ffprobe. *(As built: intermediates use
  quality 16 (NVENC `-cq 16`, matching x264 CRF 14 masters more closely than
  18). **B-frames stay on**: x264's `-tune fastdecode` keeps them too
  (it only drops CABAC and deblocking), and without them NVENC needed about
  twice the bytes for lower SSIM. NVENC final tiles use `p7`, spatial AQ, a
  20-frame lookahead, CAVLC and `-cq` = tile CRF + 4; full renditions use
  `-cq` = CRF + 5. Those offsets come from SSIM comparisons with x264 at the
  same CRF. Encoders without a constant-quality mode with a cap (Quick Sync,
  AMF, VideoToolbox, VA-API) use VBR at 70% of the cap. Only NVENC could be
  tested here; the others are guarded by the test encode and the fallback.
  The settings tables are data (`HW_ENCODERS` in `encode.js`), so the
  fallback test registers a deliberately broken encoder.)*
* **Decoding:** `-hwaccel auto` for the sources. Decoding 4K and HEVC sources
  is often the slow part of normalization. Software decode is the fallback.
  Filters (scale, pad, xstack) stay on the CPU at first. GPU filters
  (`scale_cuda` etc.) are a later optimization. *(As built: only for HEVC,
  AV1 and VP9 sources and sources above 1440p. For 48 1080p H.264 sources,
  GPU decoding made clip normalization 13% slower, because frames are copied
  back for the CPU filters. Clips smaller than 1280×720 also stay on libx264:
  NVENC didn't make them faster, since decoding dominates, and their sessions
  then held up tiles and full renditions.)*
* **Concurrency:** a separate pool for hardware sessions
  (`build.hardwareJobs`, default 3). Consumer GPUs limit how many encode
  sessions can run at once. The CPU pool (`--jobs`) is unchanged.
  *(As built: a hardware job holds its sessions and a CPU slot. A tile run
  that writes both a master and a final tile on the GPU counts as two
  sessions.)*
* **Failure handling:** a hardware job that fails is retried with libx264 and
  a warning is logged. After 3 failures in a row, hardware is turned off for
  the rest of the build.
* **Cache:** the encoder name is part of the cache key, so switching between
  hardware and software re-encodes the affected outputs.
* **Trade-off:** hardware H.264 usually needs somewhat more bits than x264 for
  the same quality. The build report shows the encoder, the time per phase and
  the output size, so the two can be compared on a real wall. If the tiles come
  out too large, use `hardwareFinal: false`. *(As built, measured on 48 1080p
  sources with NVENC: libx264 155 s, 10.0 MB of tiles and 244 MB of media;
  NVENC 108 s, 14.5 MB and 284 MB; NVENC with x264 final tiles 99 s, 9.9 MB
  and 284 MB. With x264 finals the build is fastest and the tiles are
  smallest: those tile runs need one GPU session instead of two, so more of
  them run at once. So `hardwareFinal` now defaults to `false`.)*

### 5.3 Tiles-only output and disk use — revision 2

Full renditions dominate the size of the output. In a 61-video test wall,
tiles, stills and posters took about **22 MB** and `media/` took **7.9 GB**.

* `output.full.enabled: false` (`--no-full`) already skips full renditions.
  Posters are always made. The manifest sets `media: null`. Leftover `media/`
  files from an earlier build are pruned like any other stale output.
* **Viewer:** with no `media`, the floating window becomes an **info card**.
  It shows a large poster and the full metadata, with no transport controls.
  Before milestone 3 it showed an empty player with a "No full-resolution
  version" message. The card keeps the highlight, leader line and Locate.
  *(As built: the details panel is open on the card, and it has no details
  toggle.)*
  *Later option:* play the cell's crop of the deepest tile that is already
  loaded in the window. That gives a moving preview at cell resolution with no
  extra bytes.
* **Build cache:** `.vmap-cache` holds high-quality intermediate clips and
  tile masters, and can be bigger than the output (172 MB against 112 MB in
  one test). `vmap clean` deletes it. `--no-keep-cache` deletes the
  intermediates after a successful build, so the next build starts from
  scratch. *(As built: `vmap clean` refuses folders that hold anything but
  cache files. `--no-keep-cache` keeps the small probe and output records,
  so full renditions and posters are still reused. The build report shows
  the cache size.)*
* The dry run and the Studio's size estimate show the bytes with and without
  full renditions.

---

## 6. CLI (`packages/cli`, binary `vmap`)

```
vmap init [dir]                 # scaffold scene.json from a folder of videos (auto-fills ids/titles)
vmap validate scene.json        # schema + file existence + probe warnings
vmap build scene.json -o dist/  # full pipeline
    --canvas 7680x4320 | --cell 384x216
    --tile 768x432
    --surface plane|cylinder|sphere
    --preview-duration 10  --fps 24
    --full-max-height 1080 | --no-full (tiles only)
    --pack grid|masonry    --fit contain|cover    --column-width 384   --gap 0
    --group-arrange columns|bands
    --hw auto|off|nvenc|qsv|amf|videotoolbox|vaapi   --hw-jobs 3   --hw-final
    --group-by category    --jobs 8   --no-stills   --no-keep-cache
    --dry-run (print plan + size estimate)
vmap preview dist/              # tiny static server (range requests) + opens browser
vmap info dist/                 # summarize an existing output
vmap doctor                     # ffmpeg features, plus working hardware encoders (rev. 2)
vmap clean [scene.json]         # delete the build cache (rev. 2)
```

Exit codes and a `--json` output mode let CI pipelines and the Studio drive the CLI.

---

## 7. Output (static, host anywhere)

```
dist/
├─ index.html          # loads ./viewer.[hash].js, reads ./scene.json
├─ viewer.[hash].js    # ~60–90 KB gzipped target
├─ viewer.[hash].css
├─ scene.json          # runtime manifest: levels, tile templates, cells → video metadata
├─ tiles/{z}/{x}/{y}.mp4
├─ stills/{z}/{x}/{y}.webp
├─ media/{id}.mp4      # full renditions (absent when built tiles-only, §5.3)
└─ posters/{id}.webp   # always present
```

* All URLs are **relative**, so the folder works at `/`, `/foo/bar/` or on a CDN.
* It needs only a static server that supports **HTTP range requests** (every
  mainstream host does). That is required for MP4 playback on iOS.
* **Limitation:** opening `index.html` directly from disk (`file://`) won't
  work. Browsers taint cross-origin video textures and block `fetch` there.
  `vmap preview` covers local viewing.
* **Embedding:** `<iframe src="…/dist/index.html">`, or an ES-module API
  `VideoMap.mount(el, { scene: './scene.json' })`.
* Deep links: `#v=reef-01` opens a video, and `#cam=…` restores the camera.

---

## 8. Viewer runtime (`packages/viewer`)

### 8.1 Renderer

* **A small custom WebGL renderer** (WebGL2, with a WebGL1 fallback), not
  three.js. *(As built: about 17 KB gzipped JS for the whole viewer.)* The geometry is just tessellated quad patches, and a few KB of
  focused code beats a 150 KB+ dependency on low-end phones.
  *(Decision point: three.js would speed up development. See §13.)*
* **One unified quadtree.** A tile (z, x, y) covers a (u,v) rectangle. A
  **surface function** maps (u,v) → 3D position and normal:
  * plane: `(u, v, 0)` with an orthographic or perspective pan/zoom camera
  * cylinder: `(r·sin θ, v, r·cos θ)`, θ = u·arc, camera inside or outside
  * sphere: lon/lat from (u,v) within the latitude band
* Each visible tile is a patch mesh (tessellated more finely on curved
  surfaces) with its own texture.
* **LOD selection:** choose the level where one texel ≈ one screen pixel,
  scaled by `min(devicePixelRatio, 1.5)`. On high-DPR phones that roughly halves
  the tile count. A tier-dependent bias can lower it further.
* **Fallback rendering:** while a tile's video isn't ready, the renderer draws
  the matching sub-rectangle of the nearest loaded ancestor (video or still).
  The screen never shows holes. *(As built: it also draws the four children
  when they're ready and the parent isn't, which covers zooming out. A spare
  decoder plays the level-0 overview as the base layer.)*
* Picking: ray → surface → (u,v) → cell index. This is analytic, with no GPU
  readback. *(Revision 2: (u,v) → wall point → video `rect`. The grid uses
  index math and masonry uses a per-column binary search, §5.1. As built: one
  bucket index over the rectangles serves every packing.)*

### 8.2 Tile scheduler (the performance core)

* **A pool of `<video>` elements** (muted, `playsinline`, `loop`, preloaded).
  Elements are reused by swapping `src`. The pool size is the **decoder budget**.
* **Device tiers**, from `hardwareConcurrency`, `deviceMemory`, the GPU renderer
  string and a short frame-time probe. The tier is adjusted at runtime: if frame
  time stays high, the budget drops and the LOD bias rises.

  | Tier | Concurrent tile videos | Max texture uploads/frame | Notes |
  |---|---|---|---|
  | low | 4 | 2 | prefers stills while camera moves |
  | mid | 9 | 4 | |
  | high | 16 | 8 | |
* **Priority:** visible tiles at the target level, ordered by distance from the
  screen center, come first, then prefetch of the parent and neighbors. Videos
  pause and release while the camera is moving fast, and resume when it settles.
* **Texture upload:** `requestVideoFrameCallback`, where available, uploads only
  when a new frame exists. Uploads are spread across frames within a per-frame
  budget. Preview fps (24 by default, 15 suggested for low tier) directly lowers
  upload cost.
* **Synchronization:** one master clock (`t mod duration`). Newly started tiles
  seek to the master time. Small drift is corrected with a tiny `playbackRate`
  nudge, and drift above a threshold with a seek. Because every tile has the
  same frame count, cells look continuous when tiles swap levels.
* **Autoplay policies:** autoplay is muted inline. If autoplay is blocked (iOS
  Low Power Mode, data saver), the viewer shows the still pyramid and a "Tap to
  play" overlay. Honors `prefers-reduced-motion` (stills by default, with an
  opt-in toggle) and `Save-Data`.
* The scheduler pauses everything when the page is hidden.

### 8.3 Interaction

* Plane: drag to pan, wheel or pinch to zoom, double-tap to zoom in, with
  inertia and bounds. *(As built: double-tap zooms only on empty areas, since
  tapping a video opens it.)*
* Cylinder and sphere: drag to orbit or look around, pinch for field of view or
  dolly, gyroscope look-around on mobile (opt-in).
* Keyboard: arrow keys, `+`/`-`, Tab through cells, Enter to open.
* Hovering (desktop) or long-pressing (mobile) a cell shows its title and tags.

### 8.4 Filtering and search (no re-encode)

* A search box and tag/category chips. Non-matching cells are **dimmed and
  desaturated in the shader** through a per-cell mask texture (1 texel per
  cell). It updates instantly and costs no decode.
  *(Revision 2: a 1-texel-per-cell mask only works for the uniform grid.
  Instead, the dimming is drawn as one quad per non-matching video `rect`,
  which works for every packing strategy and is just as cheap.)*
* "Fly to group" jumps the camera to a category region.
* A **list view** (accessible alternative) shows every video with poster,
  metadata and search. Selecting one flies to it on the wall.
* *Re-layout* by a different grouping needs a rebuild. Optionally the CLI can
  pre-bake several layouts (`layouts: ["category", "tag:location"]`) and the
  viewer switches between them.

### 8.5 Floating video player (windowed)

* Opens on click or tap. A **FLIP animation** grows the window out of the
  cell's on-screen rectangle, and the window plays `media/{id}.mp4` with sound
  and full controls.
* Desktop: draggable, resizable, **maximize/restore**, minimize to a dock,
  native fullscreen, and multiple windows. Each window remembers its own
  geometry.
* Mobile: a bottom sheet that expands to full screen. Swipe down to dismiss.
  *(As built: if a new window or sheet covers its own cell, the camera moves
  the cell into view.)*
* **Link back to the original position:**
  1. The source cell gets an animated **highlight outline**, drawn in the shader
     so it follows the surface's curvature.
  2. A thin **leader line** (an SVG overlay) runs from the window to the cell's
     projected screen position and updates every frame. When the cell is off
     screen, an arrow at the screen edge points toward it.
  3. A **"Locate"** button flies the camera back to the cell.
  4. Closing the window animates it back into the cell.
  5. Optional: the full player starts at the same moment the preview is showing
     (`previewStart + masterTime`), so continuity feels natural.
* An info panel shows title, description, categories, tags, credits, links and
  free-form `meta`.
* **Tiles-only scenes** (no `media`): the window opens as an info card with the
  poster and metadata instead of a player (§5.3).

### 8.6 UI and polish

* A dark, cinematic default theme with CSS custom-property design tokens
  (themeable from `scene.json`), a system font stack, and no web-font
  dependency in the viewer.
* A loading sequence: the still level 0 appears in under 1 s, then video fades
  in.
* A minimap (plane) or orientation compass (cylinder/sphere), surface switcher
  (if baked), fullscreen and a share link.
* Optional on-screen performance HUD (`?debug`) showing FPS, active decoders,
  LOD and texture memory.

---

## 9. Studio (front end + Node backend) — `packages/studio`

The authoring app. The viewer stays fully static; the Studio is for making scenes.

* **Backend:** Fastify (ESM).
  * `POST /api/projects` and `GET/PUT /api/projects/:id`: projects are stored on
    disk as a folder holding `scene.json` and the media.
  * `POST /api/projects/:id/uploads`: resumable or chunked uploads (tus
    protocol). ffprobe runs on arrival to fill in duration and a poster.
  * `POST /api/projects/:id/import`: paste or upload a JSON manifest, validated
    against the shared schema.
  * `POST /api/projects/:id/build`: queues a build job that runs the same
    `builder` package. Progress streams over Server-Sent Events.
  * `GET /api/projects/:id/export.zip`: the ready-to-host `dist/` folder.
  * Serves built outputs for live preview.
* **Front end** (Vite + a light component framework, for example **Preact** or
  **Svelte**):
  * A media library with a grid and table, drag-and-drop upload, bulk tag and
    category editing, and inline metadata editing.
  * A JSON editor (CodeMirror) with schema validation, kept in two-way sync with
    the form UI.
  * Layout and output settings that show a live **size estimate and tile
    count**. These include the packing strategy and the sort order. Layout is
    pure JS from `core` and uses probed sizes, so the wall's layout redraws
    instantly as you change them. They also include the preview loop length,
    fit, and full renditions on or off (tiles only).
  * Build settings: a **hardware encoding** switch, which defaults to on and
    lists the encoders that work, a "use hardware for final tiles" switch
    (also on by default) and the number of hardware sessions. These
    are saved per machine, because they describe the computer, not the scene.
  * Build with a progress log, then preview it in the embedded viewer.
  * A **sample scenes gallery**: one click loads a sample manifest and fetches
    its openly licensed clips.
* **Scope note:** v1 is a single-user tool run locally or on a private server,
  with no authentication. Multi-user hosting (auth, quotas, object storage)
  would come later. See §13.

---

## 10. Performance budgets (acceptance criteria)

| Metric | Low-end phone (e.g. ~$150 Android, iPhone SE 2) | Desktop |
|---|---|---|
| First still paint | < 1.5 s on 4G | < 0.5 s |
| First moving video | < 3 s | < 1 s |
| Render frame rate (pan/zoom) | ≥ 30 fps | 60 fps |
| Concurrent decoders | ≤ 4 | ≤ 16 |
| Viewer JS (gz) | ≤ 90 KB | — |
| GPU texture memory | ≤ 64 MB | ≤ 256 MB |
| Videos visibly playing at level 0 | all of them (e.g. 400+) | all |

These are checked with Playwright on desktop Chromium and WebKit with CPU
throttling, plus a manual device matrix (below) before each milestone.

---

## 11. Milestones

| Phase | Deliverable | Notes |
|---|---|---|
| **0. Feasibility spike** (first) — *built, awaiting device results* | A hard-coded page playing N 512/768 px H.264 tiles as WebGL textures on real low-end iOS and Android devices | **Validates the main risk** (decoder count and texture upload cost) and sets the tier numbers. Includes a test of seamless loop sync |
| **1. Core + CLI MVP** — *built* | Schema, layout (plane), normalize and loop, tile pyramid, stills, full renditions, `vmap build/validate/preview`, cache | Unit tests on layout and pyramid math; integration tests on synthetic `testsrc` clips |
| **2. Viewer MVP (plane)** — *built* | WebGL quadtree, scheduler, pan/zoom, picking, floating player with highlight, leader line and Locate, deep links | Playwright smoke tests and screenshots |
| **3. Layout and build revisions** (revision 2) — *built* | **3a.** `fit: "contain"` by default, plus a per-video `fit` override. **3b.** Tiles-only: info-card window, size estimate with and without media, `vmap clean`, `--no-keep-cache`. **3c.** Hardware encoding: detection by test encode, `auto` by default, per-encoder settings tables, a hardware session pool, libx264 fallback, `--hw`/`--hw-jobs`, `hardwareFinal` (default off after measuring, `--hw-final`), `vmap doctor` output. **3d.** Masonry: the rectangle layout model in `core` and the manifest (`videos[].rect`), the shortest-column packer as an opt-in (`grid` stays the default), both group arrangements (side-by-side column groups by default, and bands), tiles that are whole columns wide, cropped compositing for clips that cross tiles, `avoidSplits`, sync groups in the scheduler, and rectangle-based picking, highlight and labels | 3a–3c are small and independent, so they ship first. 3d changes the manifest, so it comes before curved surfaces and discovery, which build on the layout model. Tests: packer unit tests (order, column balance, aspect, `avoidSplits`); a build test with portrait, landscape and square sources that checks nothing is cropped; an encoder-fallback test with a fake failing encoder; a hardware vs libx264 timing and size comparison in the build report; a Playwright test that clicks a masonry video crossing a tile edge. *(As built: all of these exist. The no-cropping test samples each video's border pixels in the decoded tiles, including videos split across two tiles. The hardware test checks NVENC tiles with ffprobe (Main profile, a keyframe per second) and skips without a working encoder. Building masonry walls from repeated sources found two latent races, fixed here: videos sharing a source shared a clip file, and tiles with identical content shared a master file.)* |
| **4. Curved surfaces** (next) | Cylinder (inside and outside), sphere (latitude band), surface-aware controls and picking | Works with both grid and masonry |
| **5. Discovery** | Search, tag/category filtering (rectangle dimming), group labels, list view, minimap, optional pre-baked alternate layouts | |
| **6. Studio** | Uploads, metadata editing, JSON editor, build queue with SSE, preview, zip export, live layout preview, hardware encoding setting | |
| **7. Samples and polish** | 3–4 sample scenes, theming, accessibility pass, docs site, perf HUD, release packaging (`npx vmap`) | |
| **Later** | More packing strategies: `rows` (justified), `random`, `rotated`, `stack` (photo stack). GPU filter chain for faster builds. A live tile crop in the tiles-only info card | The rectangle model from 3d is designed so these are new packers plus rotated compositing, not a new pipeline |

**Test device matrix:** an iPhone SE (2nd gen) on iOS 16 and the latest iOS, a
low-end Android (Helio G-series or Snapdragon 4xx, 3 GB RAM) on Chrome, a
mid-range Android, desktop Chrome, Firefox and Safari.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Decoder limits lower than expected on some devices | Adaptive budget, LOD bias, and fallback to stills while moving. The phase 0 spike measures this first |
| Video→texture upload is slow on old GPUs | Lower preview fps, smaller tiles (512) for low tier, `requestVideoFrameCallback`, and an upload budget per frame |
| Tiles drifting out of sync visibly | Identical frame counts, a master clock, rate nudging. Tile boundaries never cut through cells, so drift between tiles never splits one video |
| Sphere distortion near poles | Default latitude band of ±60° and per-row cell sizing as a later option |
| Large output sizes | A dry-run size estimate, CRF and bitrate controls, optional skipping of the deepest level, and stills only for the deepest level |
| Source variety (rotation, odd sample aspect ratio, VFR, HDR) | Normalize everything when probing (rotation metadata, SAR, tone-map HDR to SDR, constant fps) |
| ffmpeg availability | Use the system ffmpeg if present, otherwise `ffmpeg-static`. `vmap doctor` checks codecs |
| Sample content licensing | Use only CC0 or CC-BY content (for example Blender open movies or public-domain archives), with a credits field shown in the UI |
| Masonry videos that cross a tile edge show a seam when the two tiles drift | `avoidSplits` by default, taller default tiles, and sync groups with a tighter drift threshold in the scheduler (§5.1) |
| A hardware encoder is listed but doesn't work, or fails partway through a build | A test encode at detection time, per-job fallback to libx264, and hardware turned off after repeated failures (§5.2) |
| Hardware H.264 tiles are larger or fail the browser contract (profile, keyframes) | Per-encoder settings tables, an ffprobe check of the output, and size shown in the build report. Final tiles stay on x264 by default (`hardwareFinal: false`) |
| Consumer GPU limits on concurrent encode sessions | A separate `hardwareJobs` pool (default 3) |

---

## 13. Open questions for you

1. **Scale target:** is "hundreds" around 200–500, or should we design for 1,000–5,000?
   That changes the default canvas and the number of pyramid levels.
2. **Low-end reference device:** which phone should we treat as the floor?
3. **Renderer:** custom lean WebGL (recommended for mobile and bundle size) or
   three.js (faster to build, larger)?
4. **Studio framework:** Preact or Svelte (recommended for a small, fast UI),
   or React for familiarity?
5. **Re-layout by tag in the viewer:** is the instant dimming filter plus
   optional pre-baked layouts enough, or do you need arbitrary live re-layout?
   Live re-layout would need a different, more expensive per-cell rendering
   path.
6. **Studio hosting:** local and single-user only for v1, or does it need
   accounts and cloud storage (S3 etc.) soon?
7. **Codecs:** H.264 only for v1, or also produce AV1 or HEVC variants for
   smaller downloads on modern devices?
8. **Audio:** should hovering a tile ever play audio, or is audio only in the
   floating player?
9. **TypeScript:** plain JS with JSDoc types is the plan (it matches the request
   for "JavaScript"). Would TypeScript be acceptable?

**Decided in revision 2:**

* `grid` stays the default packing. `masonry` is opt-in (`--pack masonry`).
* Hardware is used for the final tiles by default (`build.hardwareFinal:
  true`). `--no-hw-final` keeps them on x264. *(Changed after milestone 3's
  measurements: the final tiles now stay on x264 by default
  (`hardwareFinal: false`), which built faster and gave smaller tiles.
  `--hw-final` opts in.)*
* Masonry supports both group arrangements. Side-by-side column groups are the
  default (`layout.groupArrange: "columns"`), and `"bands"` is the
  alternative.
