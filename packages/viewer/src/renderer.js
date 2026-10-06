// Minimal WebGL renderer: textured quads (tiles, or a sub-rectangle of a coarser
// tile while a finer one loads), solid rectangles, and animated outlines.
// All rectangles are in CSS pixels; the renderer maps them to clip space.

const VS = `
attribute vec2 a_pos;
uniform vec4 u_rect;   // clip-space x, y (bottom-left), w, h
uniform vec4 u_uv;     // u0, v0, u1, v1
varying vec2 v_uv;
varying vec2 v_local;
void main() {
  v_local = a_pos;
  v_uv = vec2(mix(u_uv.x, u_uv.z, a_pos.x), mix(u_uv.w, u_uv.y, a_pos.y));
  gl_Position = vec4(u_rect.xy + a_pos * u_rect.zw, 0.0, 1.0);
}`;

const FS_QUAD = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform float u_solid;
uniform float u_alpha;
varying vec2 v_uv;
void main() {
  vec4 c = mix(texture2D(u_tex, v_uv), u_color, u_solid);
  gl_FragColor = vec4(c.rgb, c.a * u_alpha);
}`;

const FS_OUTLINE = `
precision mediump float;
uniform vec2 u_size;    // rect size in device pixels
uniform float u_width;  // line width in device pixels
uniform vec4 u_color;
varying vec2 v_local;
void main() {
  vec2 p = v_local * u_size;
  float d = min(min(p.x, u_size.x - p.x), min(p.y, u_size.y - p.y));
  float line = 1.0 - smoothstep(u_width - 1.0, u_width, d);
  float glow = (1.0 - smoothstep(0.0, u_width * 1.5, d)) * 0.18;
  gl_FragColor = vec4(u_color.rgb, u_color.a * max(line, glow));
}`;

/** @typedef {{ x: number, y: number, w: number, h: number }} ScreenRect */
/** @typedef {{ tex: WebGLTexture, w: number, h: number }} TextureInfo */

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.cssW = 1;
    this.cssH = 1;
    this.ratio = 1;
    this.lost = false;
    /** @type {string|null} */
    this.current = null;
    /** @type {Set<() => void>} */
    this.restoreHandlers = new Set();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.init();
      this.lost = false;
      for (const fn of this.restoreHandlers) fn();
    });
    this.init();
  }

  init() {
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: /** @type {const} */ ('default') };
    const gl = /** @type {WebGLRenderingContext} */ (this.canvas.getContext('webgl2', attrs) || this.canvas.getContext('webgl', attrs));
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    this.quad = this.program(VS, FS_QUAD, ['u_rect', 'u_uv', 'u_tex', 'u_color', 'u_solid', 'u_alpha']);
    this.outlineProg = this.program(VS, FS_OUTLINE, ['u_rect', 'u_uv', 'u_size', 'u_width', 'u_color']);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.blank = this.createTexture();
  }

  program(vs, fs, uniforms) {
    const gl = this.gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
      gl.attachShader(prog, sh);
    }
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    /** @type {Record<string, WebGLUniformLocation>} */
    const loc = {};
    for (const u of uniforms) loc[u] = gl.getUniformLocation(prog, u);
    return { prog, loc };
  }

  /** @param {number} cssW @param {number} cssH @param {number} ratio device px per CSS px */
  resize(cssW, cssH, ratio) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.ratio = ratio;
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** @param {number[]} rgb 0..1 */
  begin(rgb) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.current = null;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  /** @param {ScreenRect} r */
  clipRect(r) {
    return [(r.x / this.cssW) * 2 - 1, 1 - ((r.y + r.h) / this.cssH) * 2, (r.w / this.cssW) * 2, (r.h / this.cssH) * 2];
  }

  useQuad() {
    if (this.current === 'quad') return;
    this.current = 'quad';
    const gl = this.gl;
    gl.useProgram(this.quad.prog);
    gl.uniform1i(this.quad.loc.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** @param {ScreenRect} r @param {number[]} rgba 0..1 */
  fillRect(r, rgba) {
    const gl = this.gl;
    this.useQuad();
    const { loc } = this.quad;
    gl.uniform4fv(loc.u_rect, this.clipRect(r));
    gl.uniform4f(loc.u_uv, 0, 0, 1, 1);
    gl.uniform4fv(loc.u_color, rgba);
    gl.uniform1f(loc.u_solid, 1);
    gl.uniform1f(loc.u_alpha, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.blank.tex);
    this.draw(rgba[3] < 1);
  }

  /**
   * @param {TextureInfo} t
   * @param {ScreenRect} r
   * @param {{ u0: number, v0: number, u1: number, v1: number }} [uv]
   * @param {number} [alpha]
   */
  drawTexture(t, r, uv = { u0: 0, v0: 0, u1: 1, v1: 1 }, alpha = 1) {
    const gl = this.gl;
    this.useQuad();
    const { loc } = this.quad;
    gl.uniform4fv(loc.u_rect, this.clipRect(r));
    gl.uniform4f(loc.u_uv, uv.u0, uv.v0, uv.u1, uv.v1);
    gl.uniform1f(loc.u_solid, 0);
    gl.uniform1f(loc.u_alpha, alpha);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    this.draw(alpha < 1);
  }

  /** @param {ScreenRect} r @param {number[]} rgba @param {number} widthCss */
  outline(r, rgba, widthCss) {
    const gl = this.gl;
    const pad = widthCss * 2;
    const outer = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    gl.useProgram(this.outlineProg.prog);
    this.current = 'outline';
    const { loc } = this.outlineProg;
    gl.uniform4fv(loc.u_rect, this.clipRect(outer));
    gl.uniform4f(loc.u_uv, 0, 0, 1, 1);
    gl.uniform2f(loc.u_size, outer.w * this.ratio, outer.h * this.ratio);
    gl.uniform1f(loc.u_width, (widthCss + pad) * this.ratio);
    gl.uniform4fv(loc.u_color, rgba);
    this.draw(true);
  }

  draw(blend) {
    const gl = this.gl;
    if (blend) gl.enable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (blend) gl.disable(gl.BLEND);
  }

  /** @returns {TextureInfo} */
  createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return { tex, w: 0, h: 0 };
  }

  /** @param {TextureInfo} t */
  deleteTexture(t) {
    this.gl.deleteTexture(t.tex);
  }

  /**
   * Upload the current frame of a video or a decoded image.
   * @param {TextureInfo} t
   * @param {HTMLVideoElement | HTMLImageElement | ImageBitmap} source
   * @param {number} w
   * @param {number} h
   */
  upload(t, source, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (t.w !== w || t.h !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      t.w = w;
      t.h = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }
}

/** "#101318" → [r, g, b] in 0..1 */
export function hexToRgb(hex) {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
