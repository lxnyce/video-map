# VideoMap

Play hundreds of videos at the same time on a flat, cylindrical or spherical surface. It uses a map-style video tile pyramid, and a Node CLI builds static output you can host from any folder.

**Status:**
- Milestone 0 (device feasibility test) is built; its results from real phones are pending.
- Milestone 1 (scene format, layout, pyramid builder and `vmap` CLI) is built.
- The WebGL viewer is next (milestone 2). Until then, builds include a simple debug viewer.

## Quick start

You need Node 22+ and ffmpeg 5.1+ (with libx264, libwebp and aac).

```sh
npm install
npx vmap doctor                                  # check ffmpeg
npx vmap init ~/Videos/wall -o wall/scene.json   # scaffold a scene from a folder
npx vmap build wall/scene.json -o wall/dist      # encode the tile pyramid
npx vmap preview wall/dist                       # open http://localhost:8080
```

Upload `wall/dist/` to any static host, in any folder.

## Docs

- [docs/PLAN.md](docs/PLAN.md) is the implementation plan.
- [docs/cli.md](docs/cli.md) covers the `vmap` commands, options and build pipeline.
- [docs/scene-format.md](docs/scene-format.md) is the `scene.json` reference. [docs/examples/scene.example.json](docs/examples/scene.example.json) is a full example.
- [spike/](spike/README.md) holds the milestone 0 device test.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Scene schema and validation, layout, pyramid math and the runtime manifest. It's pure JS, shared with the future viewer. |
| `packages/builder` | The ffmpeg pipeline: probing, clips, tiles, renditions, cache and the debug viewer asset. |
| `packages/cli` | The `vmap` command and preview server. |
| `spike/` | The milestone 0 device test. |

## Development

```sh
npm test            # unit tests + ffmpeg integration tests (skipped without ffmpeg)
npm run typecheck   # tsc --checkJs over all packages
npm run schema      # regenerate packages/core/schema/scene.schema.json after editing schema.js
```
