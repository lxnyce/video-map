# vmap command line

`vmap` turns a JSON list of videos into a folder you can upload to any web
host, in any sub-folder. It needs Node 22+ and ffmpeg 5.1+ (with libx264,
libwebp and aac) on your `PATH`. `vmap doctor` checks them.

```sh
npm install                      # from the repo root, links the workspace packages
npx vmap --help                  # or: npm run vmap -- --help
```

## Typical workflow

```sh
vmap init ~/Videos/wall -o wall/scene.json   # scaffold from a folder (sub-folders → categories)
vmap validate wall/scene.json                # schema + missing files
vmap build wall/scene.json --dry-run         # layout, pyramid and size estimate, no encoding
vmap build wall/scene.json -o wall/dist      # encode
vmap preview wall/dist                       # http://localhost:8080 and your LAN address
```

Then upload `wall/dist/` anywhere. All paths inside it are relative. The
host only needs to serve static files with HTTP range requests, which every
mainstream host and CDN does.

## Commands

| Command | What it does |
|---|---|
| `vmap init [dir]` | Scans `dir` for videos and writes `scene.json`. Videos in sub-folders get the folder as their category. Options: `-o <file>`, `--title`, `--force`. |
| `vmap validate <scene>` | Checks the schema, settings and that every file exists. `--probe` also reads each video and reports layout warnings (upscaling, HDR, adjusted preview starts). `--json` for machine output. |
| `vmap build <scene>` | Runs the pipeline (below). See the options table. |
| `vmap preview [dist]` | Serves a build output with range requests. `--port`, `--host`, `--open`. |
| `vmap info [dist]` | Summarizes a build output: layout, pyramid, groups, alternate layouts and sizes. `--json`. |
| `vmap doctor` | Checks ffmpeg/ffprobe and the encoders and filters vmap uses, and test-encodes with each hardware H.264 encoder. |
| `vmap clean [scene]` | Deletes the build cache next to the scene (or `--cache <dir>`). The next build re-encodes clips and tiles from the sources. |

Exit codes: `0` success, `1` failure (e.g. ffmpeg error), `2` invalid
usage or an invalid scene. `VMAP_DEBUG=1` prints the failing ffmpeg command
and the stack trace.

### Build options

Flags override the scene file, which overrides the defaults.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --out <dir>` | `dist` next to the scene | Output folder. vmap refuses a non-empty folder it didn't create (use `--force`) and any folder that contains the scene or its sources. |
| `--canvas <WxH>` | | Full-resolution wall size in pixels. The cell size (grid) or column width (masonry) is derived from it. |
| `--cell <WxH>` | `384x216` | Grid: size of one video at full zoom. An alternative to `--canvas`. |
| `--tile <WxH>` | `768x432` (grid), `768x1024` (masonry) | Target tile video size. It's snapped to a whole number of cells or columns. |
| `--tile-crf <n>` | `28` | Tile quality (lower is better and larger). |
| `--tile-codecs <list>` | `h264` | Tile codecs in order of preference, e.g. `h264,vp9`. The viewer plays the first one the browser supports. VP9 tiles are smaller on Android and desktop, but slower to encode. |
| `--preview-duration <s>` | `10` | Loop length shared by every tile. |
| `--fps <n>` | `24` | Tile frame rate. |
| `--pack <strategy>` | `grid` | `grid` (uniform cells) or `masonry` (fixed-width columns; every video at its own shape). |
| `--group-by <spec>` | `category` | `none`, `category`, `tag:<prefix>` (tags like `place:Paris`) or `meta.<key>`. |
| `--fit <mode>` | `contain` | Grid: `contain` shows the whole frame with bars; `cover` crops to fill the cell. |
| `--column-width <px>` | `384` | Masonry: column width at full zoom. |
| `--gap <px>` | `0` | Masonry: gutter between videos. |
| `--group-arrange <mode>` | `columns` | Masonry: `columns` (groups side by side) or `bands` (groups stacked). |
| `--surface <type>` | `plane` | `plane`, `cylinder` or `sphere`. On a curved surface the wall is shaped to fill it unless `layout.aspect` or `--canvas` is set (see [scene-format.md](scene-format.md#surface)). |
| `--view <side>` | `inside` | Curved surfaces: `inside` puts the viewer at the center, `outside` shows the surface as an object. |
| `--arc <degrees>` | `360` | Curved surfaces: how far the wall wraps around (the sphere's longitude span). |
| `--no-stills` | | Skip the still-image pyramid. |
| `--no-full` | | Tiles only: skip full renditions. The viewer opens an info card instead of a player. |
| `--full-max-height <px>` | `1080` | Max height of full renditions. |
| `-j, --jobs <n>` | half the CPU cores | Parallel ffmpeg processes. |
| `--hw <encoder>` | `auto` | H.264 encoder: `auto`, `off`, `nvenc`, `qsv`, `amf`, `videotoolbox` or `vaapi`. See below. |
| `--hw-jobs <n>` | `3` | Concurrent hardware encode sessions. |
| `--hw-final` | | Also encode the final tiles on the hardware encoder. By default they stay on libx264. |
| `--cache <dir>` | `.vmap-cache` next to the scene | Build cache. |
| `--no-keep-cache` | | Delete the cached clips and tile masters after a successful build. |
| `--rebuild` | | Ignore the cache. |
| `--dry-run` | | Print the plan and size estimate only. |
| `--json` | | Print the build report as JSON (no progress output). |
| `--ffmpeg`, `--ffprobe` | `$FFMPEG`/`$FFPROBE` or `PATH` | Binaries to use. |

## What a build does

1. **Validate** the scene and check that every file exists.
2. **Probe** each video with ffprobe (cached by path, size and modification time).
3. **Lay out** the videos. They're grouped and sorted, then packed:
   - **Grid:** each group becomes a rectangular block of cells. Blocks are
     shelf-packed to match the canvas aspect. The cell size comes from
     `--canvas` or `--cell`, and the tile size is snapped to a whole number
     of cells, so no video ever straddles two tiles at any zoom level.
   - **Masonry:** videos are dealt into fixed-width columns, each to the
     shortest one, at their own aspect ratio. Several column counts (and,
     for many groups, shelf heights) are tried, and the one nearest the
     target aspect with the least empty space wins. Tiles are a whole number
     of columns wide; a video may cross a horizontal tile edge, though by
     default one that fits in a tile is moved down to the next edge instead.
4. **Normalize** each video into a clip the size of its rectangle, of exactly
   `duration × fps` frames. Short videos loop; long ones start about 10% in
   (or at `previewStart`). Videos that share a source and size share a clip.
5. **Composite tiles.** The deepest level stacks clips with `xstack`; a
   video crossing a tile edge is cropped into each tile it touches. Each
   level above stacks its four children and halves them. Level 0 is an
   overview, with the whole wall scaled to fit one tile. Every run writes
   the final H.264 tile, a WebP still, and a high-quality master in the
   cache. Parent tiles are built from masters, so quality doesn't degrade
   level after level.
6. **Full renditions and posters.** Web-friendly sources (H.264/AAC MP4, at
   most `maxHeight`) are remuxed without re-encoding. Others are transcoded.
   Posters are always made, even when full renditions are off.
   Steps 3 to 5 run once per layout: first the main one, then each
   alternate in `layouts` (see [scene-format.md](scene-format.md#layouts)),
   whose tiles and stills go to `layouts/<id>/`. Clips are shared between
   layouts wherever a video's size is the same.
7. **Write `scene.json` and install the viewer** (`index.html` + `assets/`),
   and remove files that earlier builds left behind. If the viewer hasn't
   been built (`npm run build:viewer`), a basic debug page is used instead,
   with a warning.

Rebuilds are incremental. Unchanged clips, tiles and renditions are reused.
Changing only `--tile-crf` re-encodes tiles from cached masters, without
re-reading the sources.

The report lists the layout (and a line per alternate layout, with its tile
count), the encoder, the time per phase (probe, clips, tiles, media,
posters) and the output size, so different settings are easy to compare. A
dry run prints the estimated size with and without full renditions,
counting every layout's tiles.

## Hardware encoding

With `--hw auto` (the default), vmap looks for an H.264 hardware encoder in
this order: NVIDIA NVENC, Intel Quick Sync, AMD AMF, Apple VideoToolbox,
VA-API. ffmpeg builds often list encoders that have no device or driver
behind them, so each candidate must pass a short test encode, and its output
is checked against what browsers need (Main profile). The
result is cached per ffmpeg binary and version for a week; `vmap doctor`
re-runs the test and shows why an encoder failed.

- **What uses it:** the tile masters and final tiles, transcoded full
  renditions, and preview clips of 1280×720 or more. Smaller clips stay on
  libx264: for them, decoding the source is the real work, and their GPU
  sessions are better spent on tiles. HEVC, AV1 and VP9 sources, and sources
  above 1440p, are also decoded on the GPU (`-hwaccel auto`); for 1080p
  H.264 that turned out slower than the CPU. VP9 tiles, stills and posters
  stay in software.
- **Final tiles** keep the browser contract on every encoder: Main profile
  and level, a keyframe every second, the bitrate cap and faststart, with
  CAVLC standing in for x264's `-tune fastdecode`. By default the final
  tiles stay on libx264 anyway (`--hw-final` moves them to the GPU): they
  are the bytes viewers download, hardware H.264 needs more bits than x264 for
  the same quality, and each tile run then needs one GPU session instead of
  two, so more run at once (see below).
- **Sessions:** hardware jobs share a separate pool (`--hw-jobs`, default 3),
  because consumer GPUs limit concurrent encode sessions. A tile run that
  writes both a master and a final tile on the GPU counts as two.
- **Failures:** a hardware job that fails is redone with libx264, with a
  warning. After three failures in a row, hardware is turned off for the rest
  of the build.
- **Cache:** the encoder is part of each cache key, so switching between
  hardware and software re-encodes what it affects.

On a test wall of 48 1080p sources (default settings, 16 threads, NVENC):

| Encoder | Build time | Tiles | Full renditions |
|---|---|---|---|
| libx264 (`--hw off`) | 155 s | 10.0 MB | 244 MB |
| NVENC (default: final tiles on libx264) | 99 s | 9.9 MB | 284 MB |
| NVENC with `--hw-final` | 108 s | 14.5 MB | 284 MB |

So hardware saves about a third of the build time, and keeping the final tiles
on libx264 is both faster and keeps the downloaded tiles as small as x264's. Hardware encoders start up more
slowly than x264, so on tiny walls (test builds with thumbnail-sized tiles)
`--hw off` can be faster.

## Disk space

Full renditions are usually most of the output. In a 61-video test wall,
tiles, stills and posters took about 22 MB and `media/` took 7.9 GB.
`--no-full` builds tiles only.

The build cache (`.vmap-cache`) holds high-quality intermediate clips and
tile masters, and can be bigger than the output; the report shows its size.
`vmap clean` deletes it, and `--no-keep-cache` deletes the intermediates
after each successful build. Either way the next build re-encodes the tiles
from the sources; full renditions and posters already in the output folder
are still reused.

## Output folder

```
dist/
├─ index.html                 # the viewer (see viewer.md)
├─ assets/                    # viewer JS and CSS (hashed names)
├─ scene.json                 # runtime manifest
├─ tiles/{z}/{x}/{y}.mp4      # tile videos (.webm too with --tile-codecs h264,vp9); z = 0 is one overview tile
├─ stills/{z}/{x}/{y}.webp    # first frame of each tile
├─ media/{id}.mp4             # full renditions for the floating player (not with --no-full)
├─ posters/{id}.webp
└─ layouts/{id}/              # each alternate layout's own tiles/ and stills/ (only with "layouts")
```

The scene file format is documented in [scene-format.md](scene-format.md).
