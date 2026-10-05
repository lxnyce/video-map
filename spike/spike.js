// Milestone 0 spike: how many tile videos can this device decode, upload to
// WebGL and keep in sync at once? See spike/README.md for how to run it.

const $ = (id) => document.getElementById(id);

const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const MAX_COUNT = 32;               // beyond the 16 files, tiles repeat with ?dup=n so each is its own decoder
const RAMP_LEVELS = [1, 2, 4, 6, 9, 12, 16, 20, 25, 32];
const RAMP_START_TIMEOUT_MS = 8000;
const RAMP_SETTLE_MS = 2500;
const RAMP_MEASURE_MS = 6000;
const HARD_DRIFT_S = 0.3;           // seek when further off than this
const RATE_GAIN = 0.5;              // playbackRate nudge per second of drift
const CORRECTION_COOLDOWN_MS = 600; // let a seek or rate change take effect before correcting again

// Pass criteria for one ramp level. The render floor is the 30 fps budget with 5% tolerance,
// or 90% of the idle rate on displays capped below that (e.g. iOS Low Power Mode at 30 Hz).
const PASS = { minRenderFps: 28.5, minRenderRatioOfIdle: 0.9, minVideoFpsRatio: 0.85, maxDriftP95Ms: 100 };
const FREEZE_MS = 300;              // no new frame for this long (outside a sync seek) counts as a stall

const state = {
  manifest: null,
  set: null,
  videos: [],
  running: false,
  t0: 0,
  uploadMode: 'rvfc',
  budget: 0,
  sync: true,
  rr: 0,
  autoplay: 'untested',
  ramp: null,
  device: null,
};

// ---------------------------------------------------------------------------
// Master clock: every tile has the same loop length, so "now" maps to one
// position in the loop that every video should be showing.

function masterTime(now = performance.now()) {
  const d = state.manifest.duration;
  return ((((now - state.t0) / 1000) % d) + d) % d;
}

function wrapDrift(x, d) {
  return ((((x + d / 2) % d) + d) % d) - d / 2;
}

// ---------------------------------------------------------------------------
// Measurement windows. Several can be open at once (the HUD and a ramp level).

const windows = new Set();

class MeasureWindow {
  constructor() {
    this.start = performance.now();
    this.frameTimes = [];
    this.drifts = [];
    this.uploadMs = 0;
    this.uploads = 0;
    this.base = new Map(state.videos.map((v) => [v, v.counters()]));
    windows.add(this);
  }

  close() {
    windows.delete(this);
  }

  result() {
    const secs = (performance.now() - this.start) / 1000;
    const ft = this.frameTimes;
    const totalMs = ft.reduce((a, b) => a + b, 0);
    const perVideo = [];
    let dropped = 0;
    let stalls = 0;
    let seeks = 0;
    for (const [v, b] of this.base) {
      if (v.disposed) continue;
      const c = v.counters();
      perVideo.push((c.frames - b.frames) / secs);
      dropped += c.dropped - b.dropped;
      stalls += c.stalls - b.stalls;
      seeks += c.seeks - b.seeks;
    }
    const firstFrames = state.videos.map((v) => v.firstFrameMs).filter((x) => x != null);
    return {
      videos: state.videos.length,
      seconds: round(secs, 1),
      renderFps: round(ft.length && (ft.length * 1000) / totalMs, 1),
      frameP95Ms: round(percentile(ft, 0.95), 1),
      videoFpsMin: round(perVideo.length ? Math.min(...perVideo) : 0, 1),
      videoFpsAvg: round(avg(perVideo), 1),
      driftP95Ms: round(percentile(this.drifts, 0.95) * 1000, 0),
      driftMaxMs: round((this.drifts.length ? Math.max(...this.drifts) : 0) * 1000, 0),
      droppedPerSec: round(dropped / secs, 1),
      stalls,
      seeks,
      uploadMsPerFrame: round(ft.length ? this.uploadMs / ft.length : 0, 2),
      uploadsPerSec: round(this.uploads / secs, 1),
      firstFrameAvgMs: round(avg(firstFrames), 0),
      firstFrameMaxMs: round(firstFrames.length ? Math.max(...firstFrames) : 0, 0),
      failed: state.videos.filter((v) => v.failed).map((v) => `${v.index}: ${v.failed}`),
    };
  }
}

// ---------------------------------------------------------------------------
// One tile video: a muted inline <video>, its WebGL texture and its counters.

class TileVideo {
  constructor(index, url, renderer) {
    this.index = index;
    this.renderer = renderer;
    this.tex = renderer.createTexture();
    this.texW = 0;
    this.texH = 0;
    this.ready = false;
    this.dirty = false;
    this.disposed = false;
    this.frames = 0;
    this.lastPresented = null;
    this.lastCurrentTime = -1;
    this.firstFrameMs = null;
    this.startedAt = 0;
    this.stalls = 0;
    this.lastFrameAt = 0;
    this.frozen = false;
    this.seeks = 0;
    this.seekLead = 0.1;
    this.seekRequestedAt = 0;
    this.cooldownUntil = 0;
    this.drift = 0;
    this.failed = null;

    const el = document.createElement('video');
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.setAttribute('muted', '');
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.loop = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.disablePictureInPicture = true;
    el.src = url;
    el.addEventListener('error', () => { this.failed = el.error ? `media error ${el.error.code}` : 'error'; });
    el.addEventListener('seeked', () => {
      this.lastFrameAt = performance.now();
      // Learn how long seeks take on this device so the next one lands on time.
      const took = (performance.now() - this.seekRequestedAt) / 1000;
      if (took > 0 && took < 2) this.seekLead = this.seekLead * 0.5 + took * 0.5;
    });
    el.addEventListener('loadedmetadata', () => { if (state.sync) this.seekTo(masterTime() + this.seekLead); }, { once: true });
    this.el = el;
    $('video-host').append(el);
  }

  start() {
    this.startedAt = performance.now();
    const p = this.el.play();
    if (p) p.catch((err) => { if (!this.disposed) this.failed = `play(): ${err.name}`; });
    if (HAS_RVFC) this.requestFrame();
  }

  requestFrame() {
    if (this.disposed) return;
    this.el.requestVideoFrameCallback((now, md) => {
      if (this.disposed) return;
      const delta = this.lastPresented == null ? 1 : Math.max(1, md.presentedFrames - this.lastPresented);
      this.lastPresented = md.presentedFrames;
      this.onNewFrame(delta, md.mediaTime, md.expectedDisplayTime);
      this.requestFrame();
    });
  }

  // Fallback when requestVideoFrameCallback is missing: detect new frames from currentTime.
  pollFrame(now) {
    const ct = this.el.currentTime;
    if (ct !== this.lastCurrentTime && this.el.readyState >= 2) {
      this.lastCurrentTime = ct;
      this.onNewFrame(1, ct, now);
    }
  }

  onNewFrame(count, mediaTime, displayTime) {
    if (this.frames === 0) this.firstFrameMs = performance.now() - this.startedAt;
    this.frames += count;
    this.lastFrameAt = performance.now();
    this.frozen = false;
    this.dirty = true;
    this.drift = wrapDrift(mediaTime - masterTime(displayTime), state.manifest.duration);
    if (!this.el.seeking && performance.now() > this.cooldownUntil) {
      for (const w of windows) w.drifts.push(Math.abs(this.drift));
    }
  }

  correct(now) {
    const el = this.el;
    if (!state.sync || this.frames < 2 || el.seeking || el.paused || now < this.cooldownUntil) return;
    const a = Math.abs(this.drift);
    const softDrift = 0.5 / state.set.fps;
    if (a > HARD_DRIFT_S) {
      el.playbackRate = 1;
      this.seekTo(masterTime(now) + this.seekLead);
    } else if (a > softDrift) {
      el.playbackRate = clamp(1 - this.drift * RATE_GAIN, 0.9, 1.1);
      this.cooldownUntil = now + CORRECTION_COOLDOWN_MS;
    } else if (el.playbackRate !== 1) {
      el.playbackRate = 1;
    }
  }

  // A stall is a visible freeze: the video is playing but no new frame arrived for FREEZE_MS.
  checkFreeze(now) {
    const el = this.el;
    if (this.frames === 0 || this.frozen || el.paused || el.seeking) return;
    if (now - this.lastFrameAt > Math.max(FREEZE_MS, 4000 / state.set.fps)) {
      this.frozen = true;
      this.stalls++;
    }
  }

  seekTo(t) {
    this.seeks++;
    this.seekRequestedAt = performance.now();
    this.cooldownUntil = this.seekRequestedAt + CORRECTION_COOLDOWN_MS;
    this.el.currentTime = t % state.manifest.duration;
  }

  counters() {
    const q = this.el.getVideoPlaybackQuality?.();
    return { frames: this.frames, dropped: q ? q.droppedVideoFrames : 0, stalls: this.stalls, seeks: this.seeks };
  }

  dispose() {
    this.disposed = true;
    const el = this.el;
    el.pause();
    el.removeAttribute('src');
    el.load(); // releases the decoder immediately
    el.remove();
    this.renderer.deleteTexture(this.tex);
  }
}

// ---------------------------------------------------------------------------
// Minimal WebGL renderer: one textured quad per video, laid out edge to edge.

const VS = `
attribute vec2 a_pos;
uniform vec4 u_rect;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x, 1.0 - a_pos.y);
  gl_Position = vec4(u_rect.xy + a_pos * u_rect.zw, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_ready;
varying vec2 v_uv;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  gl_FragColor = vec4(mix(vec3(0.11, 0.12, 0.15), c, u_ready), 1.0);
}`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'default' };
    const gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs);
    if (!gl) throw new Error('WebGL is not available on this device.');
    this.gl = gl;
    this.webglVersion = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 2 : 1;
    this.uploadErrors = 0;

    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.uRect = gl.getUniformLocation(prog, 'u_rect');
    this.uReady = gl.getUniformLocation(prog, 'u_ready');
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([28, 30, 38, 255]));
    return tex;
  }

  deleteTexture(tex) {
    this.gl.deleteTexture(tex);
  }

  upload(v) {
    const gl = this.gl;
    const el = v.el;
    if (el.readyState < 2 || !el.videoWidth) return false;
    gl.bindTexture(gl.TEXTURE_2D, v.tex);
    try {
      if (el.videoWidth !== v.texW || el.videoHeight !== v.texH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
        v.texW = el.videoWidth;
        v.texH = el.videoHeight;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, el);
      }
    } catch (err) {
      this.uploadErrors++;
      v.failed = `upload: ${err.name}`;
      return false;
    }
    v.ready = true;
    return true;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // `area` is the part of the screen not covered by the HUD or panel, in CSS pixels.
  draw(videos, aspect, area) {
    const gl = this.gl;
    this.resize();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const scale = cw / (this.canvas.clientWidth || cw);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.043, 0.051, 0.071, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const n = videos.length;
    if (!n) return;

    const ax = area.left * scale;
    const ay = area.top * scale;
    const aw = Math.max(1, (area.right - area.left) * scale);
    const ah = Math.max(1, (area.bottom - area.top) * scale);
    const { cols, rows, w } = layoutGrid(n, aw, ah, aspect);
    const h = w / aspect;
    const ox = ax + (aw - cols * w) / 2;
    const oy = ay + (ah - rows * h) / 2;
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < n; i++) {
      const x = ox + (i % cols) * w;
      const y = oy + Math.floor(i / cols) * h;
      gl.uniform4f(this.uRect, (x / cw) * 2 - 1, 1 - ((y + h) / ch) * 2, (w / cw) * 2, (h / ch) * 2);
      gl.uniform1f(this.uReady, videos[i].ready ? 1 : 0);
      gl.bindTexture(gl.TEXTURE_2D, videos[i].tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}

// Pick the column count that makes tiles as large as possible.
function layoutGrid(n, cw, ch, aspect) {
  let best = { cols: 1, rows: n, w: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min(cw / cols, (ch / rows) * aspect);
    if (w > best.w) best = { cols, rows, w };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main loop: detect new frames, upload within budget, draw.

let renderer;
let lastRaf = 0;
let freeArea = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };

// Keep tiles out from under the HUD and the controls panel.
function updateFreeArea() {
  const gap = 8;
  const hud = $('hud').getBoundingClientRect();
  const panel = $('panel').getBoundingClientRect();
  const area = { left: 0, top: hud.bottom + gap, right: innerWidth, bottom: innerHeight };
  if (panel.width >= innerWidth * 0.9) area.bottom = Math.min(area.bottom, panel.top); // bottom sheet
  else area.right = Math.min(area.right, panel.left - gap);                            // side panel
  freeArea = area;
}

function frame(now) {
  requestAnimationFrame(frame);
  if (lastRaf) {
    const dt = now - lastRaf;
    for (const w of windows) w.frameTimes.push(dt);
  }
  lastRaf = now;

  const videos = state.videos;
  const n = videos.length;
  if (!HAS_RVFC) for (const v of videos) v.pollFrame(now);

  const t = performance.now();
  let budget = state.budget || Infinity;
  let uploads = 0;
  for (let k = 0; k < n && budget > 0; k++) {
    const i = (state.rr + k) % n;
    const v = videos[i];
    const due = state.uploadMode === 'raf' ? true : v.dirty;
    if (!due) continue;
    if (renderer.upload(v)) {
      v.dirty = false;
      uploads++;
      budget--;
      state.rr = (i + 1) % n;
    }
  }
  const uploadMs = performance.now() - t;
  for (const w of windows) {
    w.uploadMs += uploadMs;
    w.uploads += uploads;
  }

  renderer.draw(videos, state.set ? state.set.width / state.set.height : 16 / 9, freeArea);
}

// ---------------------------------------------------------------------------
// Controls

function setCount(n) {
  n = clamp(n, 0, MAX_COUNT);
  while (state.videos.length > n) state.videos.pop().dispose();
  while (state.videos.length < n) {
    const i = state.videos.length;
    const files = state.set.files;
    const dup = Math.floor(i / files.length);
    const url = `media/${files[i % files.length]}${dup ? `?dup=${dup}` : ''}`;
    const v = new TileVideo(i, url, renderer);
    state.videos.push(v);
    if (state.running) v.start();
  }
  $('count').value = String(n);
  $('count-out').textContent = String(n);
}

function start() {
  if (!state.running) {
    state.running = true;
    state.t0 = performance.now();
    for (const v of state.videos) v.start();
  }
  if (state.videos.length === 0) setCount(Number($('count').value) || 4);
  setStatus(`Playing ${state.set.id}.`);
}

function stop() {
  if (state.ramp) state.ramp.abort = true;
  const n = state.videos.length;
  setCount(0);
  state.running = false;
  $('count').value = String(n);
  $('count-out').textContent = String(n);
  setStatus('Stopped.');
}

function selectSet(id) {
  const n = state.videos.length;
  setCount(0);
  state.set = state.manifest.sets.find((s) => s.id === id);
  state.t0 = performance.now();
  if (state.running) {
    setCount(n);
    setStatus(`Playing ${state.set.id}.`);
  }
}

// ---------------------------------------------------------------------------
// Ramp test: add videos step by step and find the largest count that passes.

async function runRamp() {
  if (state.ramp) return;
  const ramp = { abort: false, hidden: false };
  state.ramp = ramp;
  $('ramp').disabled = true;
  $('results').hidden = false;
  $('results-body').replaceChildren();
  $('verdict').textContent = '';
  $('results-json').value = '';

  try {
    if (!state.running) {
      state.running = true;
      state.t0 = performance.now();
    }
    setCount(0);
    setStatus('Measuring idle render rate…');
    await sleep(1000);
    let w = new MeasureWindow();
    await sleep(2000);
    const idleFps = w.result().renderFps;
    w.close();

    const levels = [];
    let consecutiveFails = 0;
    for (const n of RAMP_LEVELS) {
      if (ramp.abort) break;
      setStatus(`Testing ${n} concurrent videos…`);
      setCount(n);
      await waitUntil(() => state.videos.every((v) => v.frames > 0 || v.failed) || ramp.abort, RAMP_START_TIMEOUT_MS);
      await sleep(RAMP_SETTLE_MS);
      if (ramp.abort) break;
      w = new MeasureWindow();
      await sleep(RAMP_MEASURE_MS);
      const r = w.result();
      w.close();
      r.pass = passes(r, idleFps);
      levels.push(r);
      addResultRow(r);
      consecutiveFails = r.pass ? 0 : consecutiveFails + 1;
      if (consecutiveFails >= 2) break;
    }

    let budget = 0;
    for (const r of levels) {
      if (!r.pass) break;
      budget = r.videos;
    }
    const report = {
      generatedAt: new Date().toISOString(),
      set: { id: state.set.id, width: state.set.width, height: state.set.height, fps: state.set.fps, codec: state.set.codec, avgBytes: Math.round(state.set.bytes / state.set.files.length) },
      settings: { uploadMode: state.uploadMode, uploadBudget: state.budget, sync: state.sync, rvfc: HAS_RVFC },
      passCriteria: PASS,
      idleRenderFps: idleFps,
      recommendedConcurrentVideos: budget,
      interruptedByPageHide: ramp.hidden,
      aborted: ramp.abort,
      levels,
      device: state.device,
    };
    $('verdict').textContent = ramp.hidden
      ? '— invalid: page was hidden during the test'
      : `— budget ${budget} video${budget === 1 ? '' : 's'}`;
    $('results-json').value = JSON.stringify(report, null, 2);
    setStatus(ramp.abort ? 'Ramp stopped.' : `Ramp done: ${budget} concurrent ${state.set.width}×${state.set.height} videos pass.`);
    setCount(Math.max(budget, 1));
  } finally {
    state.ramp = null;
    $('ramp').disabled = false;
  }
}

function passes(r, idleFps) {
  return r.renderFps >= Math.min(PASS.minRenderFps, idleFps * PASS.minRenderRatioOfIdle)
    && r.videoFpsMin >= state.set.fps * PASS.minVideoFpsRatio
    && r.driftP95Ms <= PASS.maxDriftP95Ms
    && r.stalls === 0
    && r.failed.length === 0;
}

function addResultRow(r) {
  const tr = document.createElement('tr');
  const cells = [
    r.videos, r.renderFps, `${r.frameP95Ms} ms`, `${r.videoFpsMin} / ${r.videoFpsAvg}`,
    `${r.driftP95Ms} / ${r.driftMaxMs} ms`, r.droppedPerSec, r.stalls, `${r.firstFrameAvgMs} ms`, r.pass ? 'yes' : 'no',
  ];
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = String(c);
    tr.append(td);
  }
  tr.lastChild.className = r.pass ? 'pass' : 'fail';
  if (r.failed.length) tr.title = r.failed.join('\n');
  $('results-body').append(tr);
}

// ---------------------------------------------------------------------------
// Device capabilities and autoplay probe

async function probeAutoplay(url) {
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.setAttribute('muted', '');
  el.setAttribute('playsinline', '');
  el.src = url;
  $('video-host').append(el);
  try {
    await Promise.race([el.play(), sleep(4000).then(() => { throw new Error('timeout'); })]);
    return 'allowed';
  } catch (err) {
    return `blocked (${err.name === 'Error' ? err.message : err.name})`;
  } finally {
    el.pause();
    el.removeAttribute('src');
    el.load();
    el.remove();
  }
}

async function collectDeviceInfo() {
  const gl = renderer.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const probe = document.createElement('video');
  const info = {
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform,
    mobile: navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/.test(navigator.userAgent),
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${innerWidth}x${innerHeight}`,
    webgl: renderer.webglVersion,
    gpuVendor: gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
    gpuRenderer: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    requestVideoFrameCallback: HAS_RVFC,
    autoplayWithoutGesture: state.autoplay,
    canPlayType: {
      h264: probe.canPlayType('video/mp4; codecs="avc1.4D401F"'),
      hevc: probe.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      vp9: probe.canPlayType('video/webm; codecs="vp09.00.31.08"'),
      av1: probe.canPlayType('video/mp4; codecs="av01.0.05M.08"'),
    },
    connection: navigator.connection ? { effectiveType: navigator.connection.effectiveType, saveData: navigator.connection.saveData } : null,
    mediaCapabilities: {},
  };
  if (navigator.mediaCapabilities?.decodingInfo) {
    for (const s of state.manifest.sets) {
      try {
        const r = await navigator.mediaCapabilities.decodingInfo({
          type: 'file',
          video: { contentType: s.mime, width: s.width, height: s.height, framerate: s.fps, bitrate: Math.round((s.bytes * 8) / s.files.length / state.manifest.duration) },
        });
        info.mediaCapabilities[s.id] = { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
      } catch (err) {
        info.mediaCapabilities[s.id] = { error: err.name };
      }
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// HUD

function updateHud(w) {
  const r = w.result();
  const vids = state.videos;
  const ready = vids.filter((v) => v.ready).length;
  $('hud-fps').textContent = `${r.renderFps} fps · p95 ${r.frameP95Ms} ms`;
  $('hud-videos').textContent = `${ready}/${vids.length}`;
  $('hud-vfps').textContent = vids.length ? `${r.videoFpsMin} min · ${r.videoFpsAvg} avg` : '–';
  $('hud-drift').textContent = vids.length ? `${r.driftP95Ms} ms p95 · ${r.driftMaxMs} max` : '–';
  $('hud-dropped').textContent = String(r.droppedPerSec);
  $('hud-stalls').textContent = `${r.stalls} · seeks ${r.seeks}`;
  const failed = vids.filter((v) => v.failed);
  if (failed.length && !state.ramp) {
    setStatus(`${failed.length} video(s) failed: ${failed[0].failed}${failed[0].failed.includes('NotAllowed') ? ' — tap Start to allow playback' : ''}`, true);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(fn, timeoutMs) {
  const end = performance.now() + timeoutMs;
  while (!fn() && performance.now() < end) await sleep(100);
}
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function round(x, d) { const f = 10 ** d; return Math.round((x || 0) * f) / f; }
function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function downloadResults() {
  const text = $('results-json').value;
  if (!text) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = `videomap-spike-${state.set.id}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyResults() {
  const ta = $('results-json');
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch {
    // The Clipboard API needs a secure context; plain-HTTP LAN pages fall back to execCommand.
    ta.select();
    document.execCommand('copy');
  }
  setStatus('Results copied.');
}

// ---------------------------------------------------------------------------
// Boot

async function main() {
  try {
    renderer = new Renderer($('stage'));
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  updateFreeArea();
  new ResizeObserver(updateFreeArea).observe($('panel'));
  new ResizeObserver(updateFreeArea).observe($('hud'));
  addEventListener('resize', updateFreeArea);
  requestAnimationFrame(frame);

  try {
    const res = await fetch('media/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.manifest = await res.json();
  } catch (err) {
    setStatus(`Couldn't load media/manifest.json (${err.message}). Run "npm run spike:generate" first.`, true);
    return;
  }

  const probe = document.createElement('video');
  const sel = $('set');
  for (const s of state.manifest.sets) {
    const opt = new Option(`${s.width}×${s.height} @ ${s.fps} fps · ${s.codec} · ~${Math.round(s.bytes / s.files.length / 1000)} KB`, s.id);
    opt.disabled = !probe.canPlayType(s.mime);
    sel.append(opt);
  }
  const playable = state.manifest.sets.find((s) => probe.canPlayType(s.mime));
  if (!playable) {
    setStatus('This browser cannot play any of the generated tile sets. Try generating with --codec both.', true);
    return;
  }
  sel.value = playable.id;
  state.set = playable;
  $('count').max = String(MAX_COUNT);

  sel.addEventListener('change', () => selectSet(sel.value));
  $('count').addEventListener('input', (e) => {
    $('count-out').textContent = e.target.value;
    if (state.running) setCount(Number(e.target.value));
  });
  $('upload').addEventListener('change', (e) => { state.uploadMode = e.target.value; });
  $('budget').addEventListener('change', (e) => { state.budget = Number(e.target.value); });
  $('sync').addEventListener('change', (e) => {
    state.sync = e.target.checked;
    if (!state.sync) for (const v of state.videos) v.el.playbackRate = 1;
  });
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', stop);
  $('ramp').addEventListener('click', () => runRamp().catch((err) => setStatus(err.message, true)));
  $('download').addEventListener('click', downloadResults);
  $('copy').addEventListener('click', copyResults);
  $('panel-toggle').addEventListener('click', () => {
    const open = $('panel').classList.toggle('open');
    $('panel-toggle').setAttribute('aria-expanded', String(open));
    updateFreeArea();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.ramp) state.ramp.hidden = true;
  });

  setInterval(() => {
    const now = performance.now();
    for (const v of state.videos) {
      v.checkFreeze(now);
      v.correct(now);
    }
  }, 250);

  let hud = new MeasureWindow();
  setInterval(() => {
    updateHud(hud);
    hud.close();
    hud = new MeasureWindow();
  }, 1000);

  setStatus('Checking whether muted autoplay is allowed…');
  state.autoplay = await probeAutoplay(`media/${playable.files[0]}`);
  state.device = await collectDeviceInfo();
  $('device-info').textContent = JSON.stringify(state.device, null, 2);

  if (state.autoplay === 'allowed') {
    start();
  } else {
    setStatus(`Autoplay ${state.autoplay}. Tap Start or Run ramp test.`);
  }
}

main();
