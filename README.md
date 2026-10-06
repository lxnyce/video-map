# VideoMap

Play hundreds of videos at the same time on a flat, cylindrical or spherical surface. It uses a map-style video tile pyramid, and a Node CLI builds static output you can host from any folder.

**Status:**
- Milestone 0 (device feasibility test) is built; its results from real phones are pending.
- Milestone 1 (scene format, layout, pyramid builder and `vmap` CLI) is built.
- Milestone 2 (WebGL viewer for the flat wall) is built: level-of-detail video tiles, pan and zoom, linked floating player windows and deep links.
- Milestone 3 (layout and build revisions) is built: whole frames by default, masonry packing, hardware encoding (NVENC, Quick Sync, AMF, VideoToolbox, VA-API) with a libx264 fallback, and tiles-only builds.
- Next is milestone 4: cylindrical and spherical surfaces.

## Quick start

You need Node 22+ and ffmpeg 5.1+ (with libx264, libwebp and aac).

```sh
npm install                                      # also builds the viewer
npx vmap doctor                                  # check ffmpeg and hardware encoders
npx vmap init ~/Videos/wall -o wall/scene.json   # scaffold a scene from a folder
npx vmap build wall/scene.json -o wall/dist      # encode the tile pyramid (add --pack masonry for columns)
npx vmap preview wall/dist                       # open http://localhost:8080
```

Upload `wall/dist/` to any static host, in any folder.

## Docs

- [docs/PLAN.md](docs/PLAN.md) is the implementation plan.
- [docs/cli.md](docs/cli.md) covers the `vmap` commands, options and build pipeline.
- [docs/viewer.md](docs/viewer.md) covers the viewer's controls, deep links, URL parameters, embedding and theming.
- [docs/scene-format.md](docs/scene-format.md) is the `scene.json` reference. [docs/examples/scene.example.json](docs/examples/scene.example.json) is a full example.
- [spike/](spike/README.md) holds the milestone 0 device test.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Scene schema and validation, layout, pyramid math and the runtime manifest. It's pure JS, shared with the future viewer. |
| `packages/builder` | The ffmpeg pipeline: probing, clips, tiles, renditions and the cache. |
| `packages/viewer` | The WebGL viewer (Vite build), copied into every output folder. |
| `packages/cli` | The `vmap` command and preview server. |
| `spike/` | The milestone 0 device test. |

## Development

```sh
npm test            # unit tests + ffmpeg integration tests (skipped without ffmpeg)
npm run test:e2e    # viewer in headless Chromium (needs ffmpeg + npx playwright install chromium)
npm run typecheck   # tsc --checkJs over all packages
npm run dev:viewer  # viewer dev server; set VMAP_SCENE=path/to/a/built/dist
npm run schema      # regenerate packages/core/schema/scene.schema.json after editing schema.js
```
