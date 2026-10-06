# Viewer

Every `vmap build` output folder includes the viewer: `index.html` plus a
small hashed bundle in `assets/` (about 22 KB of gzipped JavaScript). It loads
`scene.json` and shows the wall with WebGL. The source is in
`packages/viewer`.

## Using it

| Action | Mouse / keyboard | Touch |
|---|---|---|
| Pan | Drag, or the arrow keys | Drag (with inertia) |
| Zoom | Scroll wheel or trackpad pinch, `+` / `-` | Pinch, or double-tap an empty area |
| Show everything | Grid button, or `0` | Grid button |
| Open a video | Click it, or `Enter` on the video in the middle of the screen | Tap it |
| Video info | Hover | Long-press |
| Close the top window | `Esc` or ✕ | ✕, or swipe the sheet down |

A video opens in a **floating window** that grows out of its cell, plays the
full-resolution file with sound, and picks up at the moment the preview was
showing. The window stays linked to the wall:

- **Highlight:** the cell gets a pulsing outline.
- **Leader line:** a line runs from the window to the cell. When the cell is
  off screen, an arrow at the screen edge points to it.
- **Locate (target icon):** flies the camera so the cell sits in the biggest
  area the window doesn't cover.
- **Closing** shrinks the window back into its cell.

Windows can be dragged by the title bar, resized from the corner, and
maximized with the button or by double-clicking the title. Up to four can be
open at once. The details button shows the description, categories, tags,
credits, links and `meta`. On narrow screens the player is a bottom sheet
instead. If it would cover its own cell, the wall moves so the cell stays
visible above it.

**Tiles-only walls** (built with `--no-full`) have no full renditions. There
a video opens as an **info card**: a large poster with the description,
categories, tags, credits and links, and no player controls. The card is
linked to the wall in the same ways as a player window.

**Masonry walls** (built with `--pack masonry`) show every video at its own
shape in columns. When groups sit side by side, a thin line marks where one
group's columns end and the next begin, and each group's label sits in a strip
above it.

The pause button in the corner stops all tile videos, leaving still frames.

## Curved surfaces

Walls built with `--surface cylinder` or `--surface sphere` are drawn on that
surface, and everything above works the same way on the curve: picking,
hover, the highlight outline (drawn on the surface), leader lines, Locate and
deep links.

| Surface | Drag | Zoom |
|---|---|---|
| Cylinder, inside | Turns you around the wall; up and down slides along it, so rows stay level | Narrows the field of view (at most 100° tall, 120° wide) |
| Sphere, inside | Looks around | Narrows the field of view |
| Cylinder or sphere, outside | Turns the surface under the pointer | Moves the camera closer |

- A 360° wall has no ends: dragging or flying past one edge comes round to the
  other, the short way.
- From outside, only the side facing you can be clicked. The back of the wall
  shows as a plain dark surface where you can see it past an open end.
- When a video with an open window is round the back or behind you, its
  leader line points to the edge of the screen nearest it. Locate turns the
  surface to bring it back.
- **Show everything** (`0`) fits the whole object from outside. Inside, it
  shows the wall's full height where the field of view allows.

## Deep links

The URL hash tracks the camera and the focused window, so any view can be
shared:

```
index.html#cam=3264,1836,0.25&v=reef-01
```

- `cam=x,y,zoom` is the wall position in full-resolution pixels and the zoom
  (CSS pixels per wall pixel). On a curved surface it is the wall pixel in the
  middle of the screen and the zoom there, so links mean the same thing on
  every surface.
- `v=<id>` opens that video's window. Without `cam`, the camera centers on it.

## How playback works

- **Levels:** the viewer picks the coarsest pyramid level that is sharp enough
  at the current zoom (`devicePixelRatio` is capped by the device tier).
  It then coarsens further until the visible tiles fit the **decoder budget**.
- **Video pool:** a fixed set of muted inline `<video>` elements, one per
  decoder. Tiles nearest the center of the screen get them first. A tile
  scrolled out of view pauses but keeps its slot until another tile needs it,
  so panning back is instant. A spare slot plays the level-0 overview.
- **Fallbacks:** while a tile's video starts, the viewer draws its still,
  or its children (when zooming out), or the matching part of the nearest
  coarser tile. The screen never shows holes.
- **Sync:** every tile follows one master clock (`time mod loop length`).
  New tiles seek to it, small drift is corrected with a tiny `playbackRate`
  change, and large drift with a seek. In masonry walls a video can cross a
  tile edge, so two tiles each show part of it; a frame of drift between them
  would show as a seam. Tiles that share a video form a sync group with
  tighter limits (nudged above 15 ms of drift and re-seeked above 120 ms,
  against 40 ms and 300 ms for other tiles).
- **Picking:** a click maps to a point on the wall and then to the video
  whose rectangle contains it, through a coarse bucket index. It's the same
  for grid and masonry walls, and gaps and label strips pick nothing. On a
  curved surface the click is a ray, and where it meets the surface gives the
  wall point.
- **Curved surfaces:** tiles are drawn as patches that the vertex shader bends
  onto the surface. Rays through a grid of screen points find the visible
  tiles, nearest the middle first. The level comes from the zoom in the middle
  of the screen. The level-0 overview is drawn under everything, so a sliver
  of a tile the rays missed is never a hole.
- **Codecs:** the viewer plays the first tile codec in `scene.json` that
  the browser supports (H.264, then VP9 if built with
  `--tile-codecs h264,vp9`). If it can play none, it shows still frames and
  says so.
- **Polite defaults:**
  - With `prefers-reduced-motion` or Save-Data, the wall starts with still
    frames and a "Play videos" button.
  - If the browser refuses autoplay (e.g. iOS Low Power Mode), the next tap
    starts the videos.
  - Playback pauses while the tab is hidden.

### Device tiers

| Tier | Videos at once | Texture uploads per frame | Pixel ratio cap | Still textures |
|---|---|---|---|---|
| low | 4 | 2 | 1 | 24 |
| mid | 9 | 4 | 1.5 | 48 |
| high | 16 | 8 | 1.5 | 96 |

The tier comes from the device type, CPU cores, `deviceMemory` and the GPU
name. These numbers are placeholders until the milestone 0 device results are
in. If the frame rate stays below 22 fps while videos play, the viewer
lowers its budget, by up to three steps.

## URL parameters

| Parameter | Effect |
|---|---|
| `?debug` | Show a HUD: fps, tier, level, video slots (`f`ree/`l`oading/`p`laying/`i`dle), drift, uploads, stills, codec |
| `?tier=low\|mid\|high` | Force a tier |
| `?budget=n` | Force the number of concurrent tile videos |
| `?adapt=0` | Don't lower the budget when frames are slow |
| `?videos=0` | Start with still frames |

## Embedding

Copy the build folder anywhere and either link to its `index.html` or put it
in an iframe:

```html
<iframe src="/walls/nature/index.html" style="width:100%;height:80vh;border:0" allow="fullscreen"></iframe>
```

To mount it into your own page, load the bundle and call `mount`. The tile
paths resolve relative to the scene URL:

```html
<link rel="stylesheet" href="/walls/nature/assets/index-XXXX.css">
<div id="wall" style="height:80vh"></div>
<script type="module">
  // The bundle auto-mounts on #videomap; otherwise mount explicitly:
  await import('/walls/nature/assets/index-XXXX.js');
  VideoMap.mount(document.getElementById('wall'), { scene: '/walls/nature/scene.json' });
</script>
```

`VideoMap.instances` lists mounted viewers, for scripting and debugging.

## Theming

Colors, radius and font are CSS custom properties on `.vm-root`
(`--vm-bg`, `--vm-surface`, `--vm-accent`, `--vm-text`, `--vm-muted`,
`--vm-radius`, `--vm-font`, …). Override them in a stylesheet loaded after the
viewer's. The wall's background and empty cells use `output.background` from
the scene.

## Developing

```sh
npm run build:viewer                              # packages/viewer/dist (also runs on npm install)
VMAP_SCENE=path/to/dist npm run dev:viewer        # live-reload dev server using a built scene's tiles
npm run test:e2e                                  # builds a tiny scene and drives the viewer in Chromium
```

The end-to-end tests need ffmpeg and a Playwright browser
(`npx playwright install chromium`). They build VP9 tiles too, because
Playwright's Chromium can't decode H.264.
