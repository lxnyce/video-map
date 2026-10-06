// Minimal WebGL renderer: textured quads (tiles, or a sub-rectangle of a coarser
// tile while a finer one loads), solid rectangles, and animated outlines.
// On the flat wall all rectangles are in CSS pixels and the renderer maps them
// to clip space. On curved surfaces the same three kinds of drawing are
// patches: rectangles in wall pixels that the vertex shader bends onto the
// surface (the mapping is in @videomap/core/surface).

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

// Curved patches. a_pos runs 0..1 across a grid; the shader places each vertex
// on the surface and passes along which way the surface faces the camera there.
const VS_MESH = `
attribute vec2 a_pos;
uniform mat4 u_mvp;
uniform vec3 u_eye;
uniform vec4 u_patch;  // wall-pixel rectangle: x, y, w, h
uniform vec4 u_uv;     // u0, v0, u1, v1
uniform vec4 u_surf;   // kind (0 cylinder, 1 sphere), radius, wall width / 2, wall height / 2
uniform vec2 u_surf2;  // side (-1 inside, +1 outside), sphere: Mercator middle
varying vec2 v_uv;
varying vec2 v_local;
varying float v_facing;
void main() {
  vec2 c = u_patch.xy + a_pos * u_patch.zw;
  float r = u_surf.y;
  float lon = (c.x - u_surf.z) / r;
  vec3 n;
  vec3 p;
  if (u_surf.x < 0.5) {
    n = vec3(sin(lon), 0.0, u_surf2.x * cos(lon));
    p = vec3(r * n.x, u_surf.w - c.y, r * n.z);
  } else {
    float lat = 2.0 * atan(exp(u_surf2.y + (u_surf.w - c.y) / r)) - 1.5707963;
    n = vec3(cos(lat) * sin(lon), sin(lat), u_surf2.x * cos(lat) * cos(lon));
    p = r * n;
  }
  v_facing = dot(n, u_eye - p);
  v_local = a_pos;
  v_uv = mix(u_uv.xy, u_uv.zw, a_pos);
  gl_Position = u_mvp * vec4(p, 1.0);
}`;

// u_face picks the side to draw: +1 the outer side of the surface, -1 the inner side.
const FS_MESH = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform float u_solid;
uniform float u_alpha;
uniform float u_face;
varying vec2 v_uv;
varying float v_facing;
void main() {
  if (v_facing * u_face < 0.0) discard;
  vec4 c = mix(texture2D(u_tex, v_uv), u_color, u_solid);
  gl_FragColor = vec4(c.rgb, c.a * u_alpha);
}`;

const FS_MESH_OUTLINE = `
precision mediump float;
uniform vec2 u_size;
uniform float u_width;
uniform vec4 u_color;
uniform float u_face;
varying vec2 v_local;
varying float v_facing;
void main() {
  if (v_facing * u_face < 0.0) discard;
  vec2 p = v_local * u_size;
  float d = min(min(p.x, u_size.x - p.x), min(p.y, u_size.y - p.y));
  float line = 1.0 - smoothstep(u_width - 1.0, u_width, d);
  float glow = (1.0 - smoothstep(0.0, u_width * 1.5, d)) * 0.18;
  gl_FragColor = vec4(u_color.rgb, u_color.a * max(line, glow));
}`;

/** Patch grids have about one cell per 2° of arc, in powers of two. */
const MESH_STEP = (2 * Math.PI) / 180;
const MESH_MAX = 128;

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
    /** The program in use: 'quad', 'outline', a mesh program, or null. @type {any} */
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
    const meshUniforms = ['u_mvp', 'u_eye', 'u_patch', 'u_uv', 'u_surf', 'u_surf2', 'u_face'];
    this.meshProg = this.program(VS_MESH, FS_MESH, [...meshUniforms, 'u_tex', 'u_color', 'u_solid', 'u_alpha']);
    this.meshOutlineProg = this.program(VS_MESH, FS_MESH_OUTLINE, [...meshUniforms, 'u_size', 'u_width', 'u_color']);
    /** @type {Map<string, { vbo: WebGLBuffer, ibo: WebGLBuffer, count: number }>} */
    this.grids = new Map();
    /** The vertex buffer attribute 0 reads from: 'quad', a grid, or null (unknown). @type {any} */
    this.bound = null;

    const buf = gl.createBuffer();
    this.quadBuf = buf;
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
    this.bound = null;
    gl.enableVertexAttribArray(0);
    this.bindQuad();
  }

  bindQuad() {
    if (this.bound === 'quad') return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.bound = 'quad';
  }

  /** @param {ScreenRect} r */
  clipRect(r) {
    return [(r.x / this.cssW) * 2 - 1, 1 - ((r.y + r.h) / this.cssH) * 2, (r.w / this.cssW) * 2, (r.h / this.cssH) * 2];
  }

  useQuad() {
    if (this.current === 'quad') return;
    this.current = 'quad';
    const gl = this.gl;
    this.bindQuad();
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
    this.bindQuad();
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

  // -------------------------------------------------------------------------
  // Curved surfaces

  /**
   * Set the surface and camera for the patches drawn this frame.
   * @param {import('@videomap/core/surface').SurfaceGeometry} geo
   * @param {Float32Array} mvp
   * @param {number[]} eye
   */
  setSurface(geo, mvp, eye) {
    this.surface = { geo, mvp, eye };
    this.current = null;
  }

  /** A grid of n × m cells over 0..1, as indexed triangles. */
  grid(n, m) {
    const key = `${n}x${m}`;
    let g = this.grids.get(key);
    if (g) return g;
    const gl = this.gl;
    const verts = new Float32Array((n + 1) * (m + 1) * 2);
    for (let j = 0, k = 0; j <= m; j++) {
      for (let i = 0; i <= n; i++) {
        verts[k++] = i / n;
        verts[k++] = j / m;
      }
    }
    const idx = new Uint16Array(n * m * 6);
    for (let j = 0, k = 0; j < m; j++) {
      for (let i = 0; i < n; i++, k += 6) {
        const a = j * (n + 1) + i;
        const b = a + n + 1;
        idx.set([a, a + 1, b, b, a + 1, b + 1], k);
      }
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.bound = null;
    g = { vbo, ibo, count: idx.length };
    this.grids.set(key, g);
    return g;
  }

  /** @param {{ w: number, h: number }} rect wall pixels */
  gridFor(rect) {
    const geo = this.surface.geo;
    const steps = (angle) => {
      let n = 1;
      while (n < MESH_MAX && angle / n > MESH_STEP) n *= 2;
      return n;
    };
    // A cylinder is straight up and down, so one row of cells is exact.
    return this.grid(steps(rect.w / geo.radius), geo.type === 'cylinder' ? 1 : steps(rect.h / geo.radius));
  }

  /**
   * @param {{ prog: WebGLProgram, loc: Record<string, WebGLUniformLocation> }} p
   * @param {{ x: number, y: number, w: number, h: number }} rect wall pixels
   * @param {number} face +1 the outer side, -1 the inner side
   */
  useMesh(p, rect, face) {
    const gl = this.gl;
    const { geo, mvp, eye } = this.surface;
    if (this.current !== p) {
      this.current = p;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.loc.u_mvp, false, mvp);
      gl.uniform3f(p.loc.u_eye, eye[0], eye[1], eye[2]);
      gl.uniform4f(p.loc.u_surf, geo.type === 'cylinder' ? 0 : 1, geo.radius, geo.width / 2, geo.height / 2);
      gl.uniform2f(p.loc.u_surf2, geo.side, geo.mid);
      if (p.loc.u_tex) {
        gl.uniform1i(p.loc.u_tex, 0);
        gl.activeTexture(gl.TEXTURE0);
      }
    }
    gl.uniform4f(p.loc.u_patch, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1f(p.loc.u_face, face);
    const g = this.gridFor(rect);
    if (this.bound !== g) {
      gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.bound = g;
    }
    return g;
  }

  /**
   * A texture (or part of one) on a wall rectangle.
   * @param {TextureInfo} t
   * @param {{ x: number, y: number, w: number, h: number }} rect
   * @param {{ u0: number, v0: number, u1: number, v1: number }} uv
   * @param {number} face
   */
  meshTexture(t, rect, uv, face) {
    const gl = this.gl;
    const { loc } = this.meshProg;
    const g = this.useMesh(this.meshProg, rect, face);
    gl.uniform4f(loc.u_uv, uv.u0, uv.v0, uv.u1, uv.v1);
    gl.uniform1f(loc.u_solid, 0);
    gl.uniform1f(loc.u_alpha, 1);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    this.drawMesh(g, false);
  }

  /** @param {{ x: number, y: number, w: number, h: number }} rect @param {number[]} rgba @param {number} face */
  meshFill(rect, rgba, face) {
    const gl = this.gl;
    const { loc } = this.meshProg;
    const g = this.useMesh(this.meshProg, rect, face);
    gl.uniform4f(loc.u_uv, 0, 0, 1, 1);
    gl.uniform4fv(loc.u_color, rgba);
    gl.uniform1f(loc.u_solid, 1);
    gl.uniform1f(loc.u_alpha, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.blank.tex);
    this.drawMesh(g, rgba[3] < 1);
  }

  /**
   * An outline that follows the surface, like outline(): the patch extends
   * `pad` wall pixels past the rectangle for the glow, and `size` is the padded
   * patch's size on screen, which sets the line width.
   * @param {{ x: number, y: number, w: number, h: number }} rect
   * @param {number[]} rgba
   * @param {number} widthCss
   * @param {number} pad
   * @param {{ w: number, h: number }} size CSS px
   * @param {number} face
   */
  meshOutline(rect, rgba, widthCss, pad, size, face) {
    const gl = this.gl;
    const { loc } = this.meshOutlineProg;
    const outer = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
    const g = this.useMesh(this.meshOutlineProg, outer, face);
    gl.uniform2f(loc.u_size, Math.max(1, size.w * this.ratio), Math.max(1, size.h * this.ratio));
    gl.uniform1f(loc.u_width, widthCss * 3 * this.ratio);
    gl.uniform4fv(loc.u_color, rgba);
    this.drawMesh(g, true);
  }

  drawMesh(g, blend) {
    const gl = this.gl;
    if (blend) gl.enable(gl.BLEND);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, 0);
    if (blend) gl.disable(gl.BLEND);
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
