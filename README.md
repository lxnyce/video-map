# VideoMap

Play hundreds of videos at the same time on a flat, cylindrical or spherical surface. It uses a map-style video tile pyramid, and a Node CLI builds static output you can host from any folder.

**Status:**
- Milestone 0 (device feasibility test) is built; its results from real phones are pending.
- Milestone 1 (scene format, layout, pyramid builder and `vmap` CLI) is built.
- Milestone 2 (WebGL viewer for the flat wall) is built: level-of-detail video tiles, pan and zoom, linked floating player windows and deep links.
- Milestone 3 (layout and build revisions) is built: whole frames by default, masonry packing, hardware encoding (NVENC, Quick Sync, AMF, VideoToolbox, VA-API) with a libx264 fallback, and tiles-only builds.
- Milestone 4 (curved surfaces) is built: walls wrapped inside or around a cylinder or a sphere, with controls, picking and player windows that follow the curve.
- Milestone 5 (discovery) is built: search, category and tag filters that dim the rest of the wall, a list view, clickable group labels, a minimap, and pre-baked alternate layouts the viewer can switch between.
- Milestone 6 (Studio) is built: a local web app to upload videos, edit their details and the layout with a live preview of the wall, build with live progress, preview the result and download it as a zip.
- Next is milestone 7: sample scenes, theming, an accessibility pass and release packaging.

## Quick start

You need Node 22+ and ffmpeg 5.1+ (with libx264, libwebp and aac).

```sh
npm install                                      # also builds the viewer
npx vmap doctor                                  # check ffmpeg and hardware encoders
npx vmap init ~/Videos/wall -o wall/scene.json   # scaffold a scene from a folder
npx vmap build wall/scene.json -o wall/dist      # encode the tile pyramid (add --pack masonry for columns,
                                                 #   --surface cylinder or sphere to wrap the wall)
npx vmap preview wall/dist                       # open http://localhost:8080
```

Upload `wall/dist/` to any static host, in any folder.

Or do all of that in the browser:

```sh
npx vmap studio --open                           # VideoMap Studio on http://localhost:5170
```

## Docs

- [docs/PLAN.md](docs/PLAN.md) is the implementation plan.
- [docs/cli.md](docs/cli.md) covers the `vmap` commands, options and build pipeline.
- [docs/viewer.md](docs/viewer.md) covers the viewer's controls, deep links, URL parameters, embedding and theming.
- [docs/studio.md](docs/studio.md) covers the Studio: projects, the library, layout preview, JSON editing, builds and its API.
- [docs/scene-format.md](docs/scene-format.md) is the `scene.json` reference. [docs/examples/scene.example.json](docs/examples/scene.example.json) is a full example.
- [spike/](spike/README.md) holds the milestone 0 device test.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Scene schema and validation, layout, pyramid math and the runtime manifest. It's pure JS, shared with the viewer. |
| `packages/builder` | The ffmpeg pipeline: probing, clips, tiles, renditions and the cache. |
| `packages/viewer` | The WebGL viewer (Vite build), copied into every output folder. |
| `packages/cli` | The `vmap` command and preview server. |
| `packages/studio` | VideoMap Studio: a Node API server (uploads, build queue, export) and its Preact web UI. |
| `spike/` | The milestone 0 device test. |

## Development

```sh
npm test            # unit tests + ffmpeg integration tests (skipped without ffmpeg)
npm run test:e2e    # viewer and Studio in headless Chromium (needs ffmpeg + npx playwright install chromium)
npm run typecheck   # tsc --checkJs over all packages
npm run dev:viewer  # viewer dev server; set VMAP_SCENE=path/to/a/built/dist
npm run dev:studio  # Studio UI dev server; proxies to a running "vmap studio"
npm run build:studio # rebuild the Studio UI (npm install does this too)
npm run schema      # regenerate packages/core/schema/scene.schema.json after editing schema.js
```
