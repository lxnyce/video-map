# Milestone 0: device feasibility test

The plan's biggest risk is whether phones can decode several tile videos at
once, upload them to WebGL every frame and keep them in sync. This spike
measures that on real hardware, and the results set the viewer's decoder
budget per device tier (plan §8.2) and the default tile size and frame rate.

## What's here

| File | Purpose |
|---|---|
| `generate.mjs` | Uses ffmpeg to make synthetic tile videos, encoded with the settings the real pipeline will use (H.264 Main, 1 s GOP, faststart, fixed frame count) |
| `serve.mjs` | A static server with HTTP range requests (iOS needs them) that prints a LAN URL to open on a phone |
| `index.html`, `spike.js`, `spike.css` | The test page: a WebGL renderer, a video pool, master-clock sync and a ramp test |

Each tile shows its ID and frame number in the top-left corner and a progress bar along the bottom. When tiles are in sync, the frame numbers match and the bars line up across neighbouring tiles.

## Run it

You need Node 20+ and ffmpeg on your `PATH`, with no npm install.

```sh
npm run spike:generate          # ~1 min; writes spike/media/ (≈26 MB of H.264)
npm run spike:serve             # prints http://<your-LAN-IP>:8080/
```

Open the LAN URL on the phone. It must be on the same Wi-Fi, and your firewall
must allow port 8080. Generator options:

```sh
node spike/generate.mjs --sets 768x432@24,512x288@24,512x288@15 --count 16 --duration 10 --codec h264
#   --codec both also writes VP9 (Playwright's Chromium can't play H.264)
```

## What to do on each device

1. Open the page and wait for the status line. It reports whether muted
   autoplay worked without a tap.
2. Choose a **tile set**. Start with `768×432 @ 24 fps`.
3. Tap **Run ramp test** and keep the screen on with the page in front, for
   about 2 minutes. The test steps through 1, 2, 4, 6, 9, 12, 16, 20, 25 and 32
   concurrent videos. It measures each step for 6 s and stops after two failing
   steps in a row.
4. Tap **Download JSON** (or **Copy JSON**) and send the file back.
5. Repeat with `512×288 @ 24` and `512×288 @ 15`.
6. On one iPhone, also run it once in **Low Power Mode**. On one Android
   phone, run it once with **Battery Saver** on.

A step **passes** when all of these hold over its 6 s window:

- The render rate is ≥ 28.5 fps, or ≥ 90% of the idle rate on displays capped
  lower.
- Every video presents ≥ 85% of its frame rate.
- The 95th-percentile drift from the master clock is ≤ 100 ms.
- No video froze for more than 300 ms (outside its own sync seeks).
- No video failed to play.

The **budget** is the largest step with every step up to it passing.

You can also explore by hand. Set the slider and try the upload options:
- **On new frame** uploads a texture only when the video has a new frame.
- **Every render frame** is the naive approach, for comparison.
- **Max uploads per frame** spreads uploads across frames.

The HUD shows live numbers.

### Suggested device matrix

- iPhone SE (2nd gen) or similar, on the oldest iOS you want to support
- A current iPhone
- A low-end Android (e.g. Helio G-series or Snapdragon 4xx, 3–4 GB RAM) on Chrome
- A mid-range Android on Chrome
- Desktop Chrome, Safari and Firefox

## What the results decide

- The **decoder budget** per tier (the plan's placeholder is 4, 9 or 16
  concurrent tile videos).
- The **default tile size** (768×432 or 512×288) and **preview fps** (24 or 15)
  for low-end devices.
- Whether **requestVideoFrameCallback-driven uploads** and an upload budget are
  needed.
- Whether **master-clock sync** with playbackRate nudges holds drift under 100
  ms, or whether seeks are needed more often.
- Whether muted autoplay is reliable enough, or the tap-to-play fallback with
  still images needs to be the default on some platforms.

## Notes

- The page must be served over HTTP(S). Opening `index.html` from disk won't
  work, because the browser treats `file://` video as cross-origin and WebGL
  refuses it.
- Above 16 videos, the page reuses the tile files with a `?dup=n` query, so
  each copy still gets its own decoder.
- The "Copy JSON" fallback works on plain-HTTP LAN pages, where the Clipboard
  API isn't available.
