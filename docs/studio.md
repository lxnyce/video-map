# VideoMap Studio

The Studio is a local web app for making walls without editing JSON by hand.
You upload videos, edit their details, choose the layout while watching a live
preview of the wall, build, check the result in the real viewer, and download
it as a zip ready to host. It drives the same build pipeline as `vmap build`.

```sh
npx vmap studio --open          # http://localhost:5170
```

It needs the same things as the CLI: Node 22+ and ffmpeg 5.1+ on your `PATH`
(`vmap doctor` checks them). Run `npm install` once in the repository; it also
builds the Studio's web UI.

## Starting it

| Option | Default | Meaning |
|---|---|---|
| `-d, --data <dir>` | `~/VideoMap Studio` (or `$VMAP_STUDIO_DATA`) | Folder for projects and settings. |
| `-p, --port <n>` | `5170` | Port; `0` picks a free one. |
| `--host <addr>` | `127.0.0.1` | Interface to listen on. The default serves this computer only. `0.0.0.0` also serves your network, **without a login**: anyone who can reach it can upload, edit and delete projects. |
| `--allow-host <name>` | | Also accept this host name, e.g. behind a reverse proxy. Repeatable. |
| `--open` | | Open the browser. |
| `--ffmpeg`, `--ffprobe` | `PATH` | Binaries to use. |

`npm run studio` is a shortcut for `vmap studio --open`.

## Projects are plain vmap folders

Each project is a folder in the data folder:

```
~/VideoMap Studio/
├─ settings.json         this computer's build settings (below)
└─ nature-wall/
   ├─ scene.json         the scene, exactly what `vmap build` reads
   ├─ media/             uploaded videos (scene paths are relative to the folder)
   ├─ dist/              the latest build: the folder you host
   ├─ .vmap-cache/       the build cache
   └─ .studio/           Studio state: probe results, thumbnails, partial uploads, the last build report
```

So you can move between the Studio and the CLI freely: `vmap build
nature-wall/scene.json` builds the same output, and a `scene.json` edited in a
text editor shows up in the Studio. The Studio never silently overwrites such
an edit (see [Saving](#saving)).

## The four tabs

### Library

- **Add videos** by dropping files anywhere on the tab or with *Add videos*.
  Uploads are resumable (see [Uploads](#uploads)). When a file arrives, it is
  checked with ffprobe and added to the wall with an id and a title from its
  file name. A file ffprobe can't read is refused.
- If a video's file is **missing** (for example after importing a
  `scene.json` from elsewhere), upload a file with the same name and it fills
  that video in, keeping its details.
- Files in `media/` that aren't on the wall (an upload finished after the page
  was closed) are listed with *Add them* and *Delete* buttons.
- **Grid or table view.** Search matches titles, ids, file names,
  descriptions, categories and tags. The category menu filters the list.
- **Select** with a click, Ctrl/⌘-click to add one, Shift-click for a range.
  - One video: the details panel shows a player (for formats the browser can
    play) with *Use player time* to set the preview start, and every field:
    title, description, categories, tags, preview start, fit, id, poster,
    credits, links and free-form details (`meta`; numbers and true/false keep
    their type, so `meta.year` sorts as a number).
  - Several: toggle categories, add or remove tags, set the fit, or remove
    them from the wall (optionally deleting their uploaded files).
  - None: the categories panel adds, renames, recolors and deletes categories.
    Renaming an id updates every video that uses it.

### Layout & output

Every setting of the scene's `layout`, `surface`, `preview` and `output`
sections, plus alternate layouts, next to a **live preview of the wall**. The
preview runs the same layout and pyramid code as the build, on the probed
shape of every video, so what you see is what the build lays out: each video's
rectangle (with its thumbnail), group outlines and labels, and optionally the
deepest level's tile grid. Hover names a video; click opens it in the library.

Below the preview: the wall size, the grid or columns, the pyramid's levels and
tile counts, and the **size estimate**, with and without full-resolution videos.
Videos not probed yet count as 16:9 and 10 seconds until they are.

Clearing a field removes it from the scene, so the default applies (shown as
the placeholder).

### JSON

The scene file in a code editor, checked against the scene schema as you type.
Problems are marked on the exact property and listed beside the editor; click
one to jump to it. Valid edits apply immediately, and the other tabs follow
(and the other way round). *Load file…* replaces the text with a file,
*Download* saves it.

### Build

- **Build**, **Estimate** (probe and plan without encoding) and **Rebuild
  everything** (ignore the cache). Unsaved changes are saved first.
- Builds run **one at a time, in a queue** shared by every project and browser
  tab, because each one already uses all CPUs and the GPU's encode sessions.
  The header shows the running build from any page.
- Progress streams live: each phase (probe, clips, tiles, media, posters) with
  its count, how many came from the cache, and the time left; then the build
  report, its warnings and the log. *Cancel* stops ffmpeg; files already
  finished stay, so the output may be partly updated until the next build
  completes.
- The **preview** is the built wall in the real viewer, served with range
  requests like any host. *Open preview* opens it in its own tab, *Download
  zip* gives the whole output folder, ready to upload anywhere.
- The project's disk use (uploads, output, build cache) and *Clear build
  cache*.

**This computer:** hardware encoding (automatic, off, or a specific encoder;
the ones that passed a test encode are listed, with why the others failed),
whether the final tiles use it too, the number of hardware sessions and ffmpeg
processes, and whether to keep the build cache. These describe the machine, not
the scene, so they're saved in the data folder's `settings.json`, apply to
every project, and override a scene's `build` section the way CLI flags do.

## Saving

Edits save themselves half a second after you stop, and only when the scene is
valid; until then the header shows the number of problems (click it for the
JSON tab). Ctrl+Z and Ctrl+Shift+Z (or the arrows in the header) undo and redo;
typing in one field is one step.

Each save names the version of `scene.json` it started from. If the file
changed in the meantime (another tab, or a text editor), nothing is
overwritten: a banner offers *Load the other version* or *Keep mine*. A
`scene.json` that isn't valid JSON opens in the JSON tab as it is, and nothing
is saved until it parses.

## Uploads

Uploads use the [tus](https://tus.io) resumable upload protocol (1.0.0, with
the creation and termination extensions), in 8 MB chunks. A dropped connection
is retried with backoff, from the last byte the server has; reloading the page
and adding the same file again resumes it too. Partial uploads older than a
week are deleted when the Studio starts. The limit is 64 GB per file.

## Security

The Studio has no accounts: it's a single-user tool for your own computer.
It listens on 127.0.0.1 by default. To keep other websites you visit from
using it through your browser, it refuses:

- requests whose `Host` isn't `localhost` or an IP address (DNS rebinding),
  unless allowed with `--allow-host`;
- state-changing requests from another origin, and JSON requests without the
  JSON content type (so a cross-site form can't post one);
- reading files outside the project folder that the scene doesn't name.

## API

Everything the UI does goes through this JSON API, so it can be scripted.
Requests with a body send `Content-Type: application/json`.

| Method and path | What it does |
|---|---|
| `GET /api/system` | ffmpeg version and capabilities, working hardware encoders, default job count, data folder |
| `POST /api/system/hardware` | Re-test the hardware encoders |
| `GET`, `PUT /api/settings` | This computer's build settings (`hardware`, `hardwareFinal`, `hardwareJobs`, `jobs`, `keepCache`) |
| `GET /api/projects` | Projects, most recently changed first, with their last build |
| `POST /api/projects` | Create one: `{ title }`, or `{ scene }` to import a scene |
| `GET /api/projects/:id` | The scene, its revision (`rev`), the last build report, whether it's built |
| `DELETE /api/projects/:id` | Delete the project folder |
| `PUT /api/projects/:id/scene` | Save `{ scene, rev }`: `409` with the current scene if `rev` is stale, `422` with `issues` if invalid |
| `POST /api/projects/:id/import` | Replace the scene with the request body (validated) |
| `GET /api/projects/:id/media` | Files in `media/` |
| `DELETE /api/projects/:id/media/:name` | Delete one |
| `POST /api/projects/:id/probe` | `{ srcs }` → ffprobe facts per path (or `missing`, `remote`, `error`) |
| `GET /api/projects/:id/thumb?src=` | A 320 px thumbnail (made on first request) |
| `GET /api/projects/:id/source?src=` | The source file, with range requests |
| `OPTIONS`, `POST /api/projects/:id/uploads` | tus: capabilities, start an upload (`Upload-Length`, `Upload-Metadata` with `filename`) |
| `HEAD`, `PATCH`, `DELETE /api/projects/:id/uploads/:uid` | tus: offset, append, abandon. The last `PATCH` answers with the file's scene path in `X-Vmap-Src` (URI-encoded) |
| `POST /api/projects/:id/build` | Queue `{ dryRun?, rebuild? }`; returns the job |
| `GET /api/projects/:id/storage` | Bytes in uploads, output and build cache |
| `POST /api/projects/:id/clean` | Delete the build cache |
| `GET /api/projects/:id/export.zip` | The output folder as a zip |
| `GET /api/jobs`, `GET /api/jobs/:id` | The queue; one job with its log |
| `DELETE /api/jobs/:id` | Cancel a queued or running job |
| `GET /api/events` | Server-Sent Events: a `snapshot` of every job, then `job` events (`{ job, lines }`) as they change |
| `GET /preview/:id/` | The built output, served like a static host |

## Development

```sh
npx vmap studio                  # the server, on 5170
npm run dev:studio               # the UI with hot reload on 5173, proxying /api and /preview to 5170
npm run build:studio             # rebuild the UI the server serves (also done by npm install)
npm test                         # includes the Studio's API and helper tests
npm run test:e2e                 # includes the Studio in headless Chromium (rebuilds the UI first)
```

The server is plain `node:http` (`packages/studio/src/server`); the UI is
Preact with htm templates, so it's plain JavaScript with no JSX step
(`packages/studio/src/web`). The JSON editor (CodeMirror) is loaded only when
the JSON tab opens: the rest of the UI is about 82 KB gzipped.
