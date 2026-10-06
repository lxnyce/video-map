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
| `vmap info [dist]` | Summarizes a build output: grid, pyramid, groups and sizes. `--json`. |
| `vmap doctor` | Checks ffmpeg/ffprobe and the encoders and filters vmap uses. |

Exit codes: `0` success, `1` failure (e.g. ffmpeg error), `2` invalid
usage or an invalid scene. `VMAP_DEBUG=1` prints the failing ffmpeg command
and the stack trace.

### Build options

Flags override the scene file, which overrides the defaults.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --out <dir>` | `dist` next to the scene | Output folder. vmap refuses a non-empty folder it didn't create (use `--force`) and any folder that contains the scene or its sources. |
| `--canvas <WxH>` | | Full-resolution wall size in pixels. The cell size is derived from it. |
| `--cell <WxH>` | `384x216` | Size of one video at full zoom. An alternative to `--canvas`. |
| `--tile <WxH>` | `768x432` | Target tile video size. It's snapped to a whole number of cells. |
| `--tile-crf <n>` | `28` | Tile quality (lower is better and larger). |
| `--tile-codecs <list>` | `h264` | Tile codecs in order of preference, e.g. `h264,vp9`. The viewer plays the first one the browser supports. VP9 tiles are smaller on Android and desktop, but slower to encode. |
| `--preview-duration <s>` | `10` | Loop length shared by every tile. |
| `--fps <n>` | `24` | Tile frame rate. |
| `--group-by <spec>` | `category` | `none`, `category`, `tag:<prefix>` (tags like `place:Paris`) or `meta.<key>`. |
| `--fit <mode>` | `cover` | `cover` crops to fill the cell; `contain` letterboxes. |
| `--surface <type>` | `plane` | `plane`, `cylinder` or `sphere` (recorded for the viewer). |
| `--no-stills` | | Skip the still-image pyramid. |
| `--no-full` | | Skip full-resolution renditions. |
| `--full-max-height <px>` | `1080` | Max height of full renditions. |
| `-j, --jobs <n>` | half the CPU cores | Parallel ffmpeg processes. |
| `--cache <dir>` | `.vmap-cache` next to the scene | Build cache. |
| `--rebuild` | | Ignore the cache. |
| `--dry-run` | | Print the plan and size estimate only. |
| `--json` | | Print the build report as JSON (no progress output). |
| `--ffmpeg`, `--ffprobe` | `$FFMPEG`/`$FFPROBE` or `PATH` | Binaries to use. |

## What a build does

1. **Validate** the scene and check that every file exists.
2. **Probe** each video with ffprobe (cached by path, size and modification time).
3. **Lay out** the videos. They're grouped and sorted, and each group becomes a
   rectangular block. Blocks are shelf-packed to match the canvas aspect.
4. **Size the pyramid.** The cell size comes from `--canvas` or `--cell`. The
   tile size is snapped to a whole number of cells, so no video ever straddles
   two tiles at any zoom level.
5. **Normalize** each video into a cell-sized clip of exactly
   `duration × fps` frames. Short videos loop; long ones start about 10% in
   (or at `previewStart`).
6. **Composite tiles.** The deepest level stacks clips with `xstack`. Each
   level above stacks its four children and halves them. Level 0 is an
   overview, with the whole wall scaled to fit one tile. Every run writes
   the final H.264 tile, a WebP still, and a high-quality master in the cache.
   Parent tiles are built from masters, so quality doesn't degrade level after
   level.
7. **Full renditions and posters.** Web-friendly sources (H.264/AAC MP4, at
   most `maxHeight`) are remuxed without re-encoding. Others are transcoded.
8. **Write `scene.json` and install the viewer** (`index.html` + `assets/`),
   and remove files that earlier builds left behind. If the viewer hasn't
   been built (`npm run build:viewer`), a basic debug page is used instead,
   with a warning.

Rebuilds are incremental. Unchanged clips, tiles and renditions are reused.
Changing only `--tile-crf` re-encodes tiles from cached masters, without
re-reading the sources.

## Output folder

```
dist/
├─ index.html                 # the viewer (see viewer.md)
├─ assets/                    # viewer JS and CSS (hashed names)
├─ scene.json                 # runtime manifest
├─ tiles/{z}/{x}/{y}.mp4      # tile videos (.webm too with --tile-codecs h264,vp9); z = 0 is one overview tile
├─ stills/{z}/{x}/{y}.webp    # first frame of each tile
├─ media/{id}.mp4             # full renditions for the floating player
└─ posters/{id}.webp
```

The scene file format is documented in [scene-format.md](scene-format.md).
