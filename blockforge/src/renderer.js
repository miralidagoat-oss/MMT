// WebGL2 renderer: chunk meshes, sky, clouds, entities, particles, overlays
// and the first-person hand. Everything is drawn camera-relative so precision
// stays exact far from the origin.
import * as S from './shaders.js';
import {
  mat4, perspective, multiply, invert, viewRotation, frustumPlanes, boxInFrustum,
} from './math.js';
import { TEXTURE_COUNT, TEX } from './blocks.js';
import { buildMips, TS } from './textures.js';
import { rng } from './noise.js';

const WHITE = [1, 1, 1];
const AMBIENT = [0.028, 0.028, 0.028];
const CLOUD_Y = 192, CLOUD_CELL = 12, CLOUD_GRID = 96, CLOUD_H = 4;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    throw new Error('Shader compile failed: ' + log + '\n' + src.split('\n').map((l, i) => i + 1 + ': ' + l).join('\n'));
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: true, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.renderScale = 1;
    this.maxDpr = 3;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    this.progChunk = program(gl, S.CHUNK_VS, S.CHUNK_FS);
    this.progSky = program(gl, S.SKY_VS, S.SKY_FS);
    this.progModel = program(gl, S.MODEL_VS, S.MODEL_FS);
    this.progParticle = program(gl, S.PARTICLE_VS, S.PARTICLE_FS);
    this.progLine = program(gl, S.LINE_VS, S.LINE_FS);
    this.progCloud = program(gl, S.CLOUD_VS, S.CLOUD_FS);
    // the shadow sampler lives on texture unit 1
    for (const pr of [this.progChunk, this.progModel]) { gl.useProgram(pr.p); gl.uniform1i(pr.u.uShadowMap, 1); }
    // relief (normal) maps for the terrain live on texture unit 2
    gl.useProgram(this.progChunk.p); gl.uniform1i(this.progChunk.u.uNormTex, 2);
    gl.useProgram(null);
    // optional passes: if a driver rejects them the game still runs without
    try {
      this.progShadow = program(gl, S.SHADOW_VS, S.SHADOW_FS);
      this.shadowOK = true;
    } catch (err) { console.warn('shadows unavailable', err); this.shadowOK = false; }
    try {
      this.progPre = program(gl, S.POST_VS, S.BLOOM_PRE_FS);
      this.progDown = program(gl, S.POST_VS, S.BLOOM_DOWN_FS);
      this.progUp = program(gl, S.POST_VS, S.BLOOM_UP_FS);
      this.progComp = program(gl, S.POST_VS, S.COMPOSITE_FS);
      this.progFxaa = program(gl, S.POST_VS, S.FXAA_FS);
      this.postOK = true;
    } catch (err) { console.warn('post-processing unavailable', err); this.postOK = false; }
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
    // quality settings, filled in from the options (see main.js)
    this.quality = { shadows: 0, bloom: false, aa: 'off', grading: false, waterFx: false, waving: true };
    this.emissive = 1;
    this.post = false;
    this.shadowVP = mat4(); this.lightDir = [0, 1, 0]; this.shadowParams = [0, 0, 0, 0];
    this.postVao = gl.createVertexArray();
    this.dummyShadow = this.createShadowTexture(1);
    this.targets = null;

    this.proj = mat4(); this.view = mat4(); this.viewProj = mat4(); this.invViewProj = mat4();
    this.handProj = mat4(); this.tmp = mat4();
    this.planes = new Float32Array(24);

    // shared quad index buffer (grown in place; VAOs keep referencing it)
    this.indexBuffer = gl.createBuffer();
    this.indexQuads = 0;
    this.ensureIndices(1 << 16);

    this.skyVao = gl.createVertexArray();
    this.initDynamic();
    this.buildClouds(1234);
    this.stats = { chunks: 0, drawn: 0, quads: 0 };
    this.resize();
  }

  ensureIndices(quads) {
    if (quads <= this.indexQuads) return;
    let n = Math.max(this.indexQuads, 1 << 16);
    while (n < quads) n *= 2;
    const gl = this.gl;
    const idx = new Uint32Array(n * 6);
    for (let q = 0, i = 0; q < n; q++, i += 6) {
      const v = q * 4;
      idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2; idx[i + 3] = v; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.indexQuads = n;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr) * this.renderScale;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.width = w; this.height = h;
  }

  // ---------------------------------------------------------------------------
  // Textures
  // smooth: linear filtering with anisotropy (detailed textures) instead of
  // crisp nearest-texel sampling (classic 16px art).
  createArrayTexture(layers, size, transparentFlags, mipmaps = true, smooth = false, maxLevel = -1) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    const levels = mipmaps ? (maxLevel >= 0 ? Math.min(maxLevel, Math.log2(size)) : Math.log2(size)) + 1 : 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, size, size, layers.length);
    layers.forEach((data, i) => {
      const mips = mipmaps ? buildMips(data, size, transparentFlags ? transparentFlags[i] : true) : [data];
      mips.forEach((m, lvl) => {
        if (lvl >= levels) return;
        const s = size >> lvl;
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, lvl, 0, 0, i, s, s, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
      });
    });
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, mipmaps ? (smooth ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR) : (smooth ? gl.LINEAR : gl.NEAREST));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mipmaps) gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, levels - 1);
    const aniso = smooth && mipmaps && (this.anisoExt || (this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')));
    if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1));
    return tex;
  }

  // Upload the painted textures (any detail level; replaces what was there).
  setTextures(blockTextures, itemTextures, skins, normals = null) {
    if (blockTextures.length !== TEXTURE_COUNT) throw new Error('texture count mismatch');
    const gl = this.gl;
    for (const t of [this.blockTex, this.itemTex, this.skinTex, this.normalTex]) if (t) gl.deleteTexture(t);
    const bs = blockTextures[0].size || TS, is = itemTextures[0].size || TS;
    const ss = Math.round(Math.sqrt(skins[0].length / 4));
    this.texDetail = bs / TS;
    this.blockTex = this.createArrayTexture(blockTextures.map((t) => t.data), bs, blockTextures.map((t) => t.transparent), true, bs > TS);
    this.itemTex = this.createArrayTexture(itemTextures.map((t) => t.data), is, null, true, is > TS);
    this.skinTex = this.createArrayTexture(skins, ss, null, ss > 64, ss > 64, 2);
    this.normalTex = normals ? this.createArrayTexture(normals.map((t) => t.data), bs, null, true, bs > TS) : null;
  }

  // ---------------------------------------------------------------------------
  // Render targets
  createShadowTexture(size) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  colorTexture(w, h, hdr) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, hdr ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  framebuffer(color, depthRb = null) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (color) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    if (depthRb) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? fb : null;
  }

  renderbuffer(fmt, w, h, samples) {
    const gl = this.gl;
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h);
    else gl.renderbufferStorage(gl.RENDERBUFFER, fmt, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    return rb;
  }

  freeTargets() {
    const t = this.targets, gl = this.gl;
    if (!t) return;
    for (const x of t.textures) gl.deleteTexture(x);
    for (const x of t.fbos) gl.deleteFramebuffer(x);
    for (const x of t.rbs) gl.deleteRenderbuffer(x);
    this.targets = null;
  }

  // (Re)build off-screen targets for the current size and quality settings.
  ensureTargets() {
    const q = this.quality, gl = this.gl;
    this.post = this.postOK && (q.bloom || q.aa !== 'off' || q.grading);
    if (!this.post) { this.freeTargets(); this.emissive = 1; return; }
    const w = this.width, h = this.height;
    const samples = q.aa === 'msaa' ? Math.min(4, this.maxSamples) : 0;
    const hdr = this.hdr;
    const key = `${w}x${h}:${samples}:${hdr}:${q.bloom}:${q.aa}`;
    this.emissive = hdr ? (q.bloom ? 1.6 : 1.15) : 1;
    if (this.targets && this.targets.key === key) return;
    this.freeTargets();
    const t = { key, textures: [], fbos: [], rbs: [], samples, bloom: [] };
    t.scene = this.colorTexture(w, h, hdr); t.textures.push(t.scene);
    if (samples) {
      const crb = this.renderbuffer(hdr ? gl.RGBA16F : gl.RGBA8, w, h, samples);
      const drb = this.renderbuffer(gl.DEPTH_COMPONENT24, w, h, samples);
      t.rbs.push(crb, drb);
      t.msFbo = gl.createFramebuffer(); t.fbos.push(t.msFbo);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, crb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, drb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { t.msFbo = null; t.samples = 0; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    const depth = this.renderbuffer(gl.DEPTH_COMPONENT24, w, h, 0); t.rbs.push(depth);
    t.sceneFbo = this.framebuffer(t.scene, depth); t.fbos.push(t.sceneFbo);
    if (!t.sceneFbo) { this.targets = t; this.freeTargets(); this.postOK = false; this.post = false; this.emissive = 1; return; }
    if (q.bloom) {
      let bw = w >> 1, bh = h >> 1;
      for (let i = 0; i < 6 && bw >= 8 && bh >= 8; i++, bw >>= 1, bh >>= 1) {
        const tex = this.colorTexture(bw, bh, hdr);
        const fb = this.framebuffer(tex);
        t.textures.push(tex); t.fbos.push(fb);
        t.bloom.push({ tex, fb, w: bw, h: bh });
      }
    }
    if (q.aa === 'fxaa') {
      t.ldr = this.colorTexture(w, h, false); t.textures.push(t.ldr);
      t.ldrFbo = this.framebuffer(t.ldr); t.fbos.push(t.ldrFbo);
    }
    this.targets = t;
  }

  // ---------------------------------------------------------------------------
  // Sun shadows: a depth map of the land around the camera seen from the sun.
  renderShadows(scene) {
    const gl = this.gl, q = this.quality, env = scene.env, cam = scene.cam;
    const level = this.shadowOK ? q.shadows | 0 : 0;
    const strength = env.shadowStrength || 0;
    const bindMap = (tex) => { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex); gl.activeTexture(gl.TEXTURE0); };
    if (!level || strength <= 0.01) { this.shadowParams[0] = 0; bindMap(this.dummyShadow); return; }
    const size = Math.min(this.maxTex, [0, 1024, 2048, 4096][level]);
    const R = [0, 44, 72, 112][level];
    if (!this.shadow || this.shadow.size !== size) {
      if (this.shadow) { gl.deleteTexture(this.shadow.tex); gl.deleteFramebuffer(this.shadow.fb); }
      const tex = this.createShadowTexture(size);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) { this.shadowOK = false; this.shadowParams[0] = 0; bindMap(this.dummyShadow); return; }
      this.shadow = { size, tex, fb };
    }
    // light basis: f points away from the light
    const sd = env.sunDir;
    const L = sd[1] >= 0 ? sd : [-sd[0], -sd[1], -sd[2]];
    this.lightDir = L;
    const f = [-L[0], -L[1], -L[2]];
    let r = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0]; // cross(f, +Z)
    const rl = Math.hypot(r[0], r[1], r[2]) || 1; r = [r[0] / rl, r[1] / rl, r[2] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const dot = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;
    // centre a little ahead of the camera, snapped to whole texels so edges don't shimmer
    const ahead = R * 0.3;
    const Cx = cam.x + Math.sin(cam.yaw) * ahead, Cy = cam.y, Cz = cam.z - Math.cos(cam.yaw) * ahead;
    const texel = (2 * R) / size;
    const lx = Math.floor(dot(r, Cx, Cy, Cz) / texel) * texel;
    const ly = Math.floor(dot(u, Cx, Cy, Cz) / texel) * texel;
    const lz = dot(f, Cx, Cy, Cz);
    const D = 200;
    const m = this.shadowVP;
    m[0] = r[0] / R; m[4] = r[1] / R; m[8] = r[2] / R; m[12] = (dot(r, cam.x, cam.y, cam.z) - lx) / R;
    m[1] = u[0] / R; m[5] = u[1] / R; m[9] = u[2] / R; m[13] = (dot(u, cam.x, cam.y, cam.z) - ly) / R;
    m[2] = f[0] / D; m[6] = f[1] / D; m[10] = f[2] / D; m[14] = (dot(f, cam.x, cam.y, cam.z) - lz) / D;
    m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
    this.shadowParams[0] = strength;
    this.shadowParams[1] = 1 / size;
    this.shadowParams[2] = texel;
    this.shadowParams[3] = level >= 2 ? 2 : 1;

    bindMap(this.dummyShadow); // never sample the map while drawing into it
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fb);
    gl.viewport(0, 0, size, size);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.6, 3.0);
    const ps = this.progShadow;
    gl.useProgram(ps.p);
    gl.uniformMatrix4fv(ps.u.uLightVP, false, m);
    gl.uniform1f(ps.u.uTime, scene.time.seconds);
    gl.uniform1f(ps.u.uAnim, 0);
    gl.uniform1f(ps.u.uAnimSlow, 0);
    gl.uniform1f(ps.u.uWave, q.waving ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blockTex);
    gl.uniform1i(ps.u.uTex, 0);
    const reach = R + 24;
    for (const c of scene.chunks) {
      const g = c.gpu;
      if (!g || g.empty || !(g.nO + g.nC)) continue;
      const ox = c.cx * 16 + 8 - Cx, oz = c.cz * 16 + 8 - Cz;
      if (Math.abs(ox) > reach || Math.abs(oz) > reach) continue;
      gl.bindVertexArray(g.vao);
      gl.uniform3f(ps.u.uOffset, c.cx * 16 - cam.x, -cam.y, c.cz * 16 - cam.z);
      gl.uniform3f(ps.u.uChunkPos, (c.cx * 16) % 4096, 0, (c.cz * 16) % 4096);
      if (g.nO) { gl.uniform1i(ps.u.uPass, 0); gl.drawElements(gl.TRIANGLES, g.nO * 6, gl.UNSIGNED_INT, 0); }
      if (g.nC) { gl.uniform1i(ps.u.uPass, 1); gl.drawElements(gl.TRIANGLES, g.nC * 6, gl.UNSIGNED_INT, g.nO * 24); }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    bindMap(this.shadow.tex);
  }

  // ---------------------------------------------------------------------------
  // Post-processing: resolve, bloom, grade, FXAA.
  postProcess() {
    const gl = this.gl, t = this.targets, q = this.quality;
    const w = this.width, h = this.height;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    gl.bindVertexArray(this.postVao);
    if (t.samples && t.msFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.sceneFbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    const pass = (prog, fb, vw, vh, src, tw, th) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, vw, vh);
      gl.useProgram(prog.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(prog.u.uSrc, 0);
      if (prog.u.uTexel) gl.uniform2f(prog.u.uTexel, 1 / tw, 1 / th);
    };
    const B = t.bloom;
    const useBloom = q.bloom && B.length > 1;
    if (useBloom) {
      pass(this.progPre, B[0].fb, B[0].w, B[0].h, t.scene, w, h);
      gl.uniform2f(this.progPre.u.uThreshold, this.hdr ? 1.0 : 0.8, this.hdr ? 0.4 : 0.2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (let i = 1; i < B.length; i++) {
        pass(this.progDown, B[i].fb, B[i].w, B[i].h, B[i - 1].tex, B[i - 1].w, B[i - 1].h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = B.length - 1; i > 0; i--) {
        pass(this.progUp, B[i - 1].fb, B[i - 1].w, B[i - 1].h, B[i].tex, B[i].w, B[i].h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }
    const fxaa = q.aa === 'fxaa' && t.ldrFbo;
    const pc = this.progComp;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fxaa ? t.ldrFbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(pc.p);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, useBloom ? B[0].tex : t.scene);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.scene);
    gl.uniform1i(pc.u.uScene, 0);
    gl.uniform1i(pc.u.uBloom, 1);
    gl.uniform1f(pc.u.uBloomAmt, useBloom ? (this.hdr ? 0.26 : 0.16) : 0);
    gl.uniform1f(pc.u.uGrade, q.grading ? 1 : 0);
    gl.uniform1f(pc.u.uFxaaLuma, fxaa ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (fxaa) {
      pass(this.progFxaa, null, w, h, t.ldr, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  // ---------------------------------------------------------------------------
  // Chunk meshes
  uploadChunk(chunk, mesh) {
    const gl = this.gl;
    const nO = mesh.opaque.length >> 4, nC = mesh.cutout.length >> 4, nT = mesh.translucent.length >> 4;
    const total = nO + nC + nT;
    let g = chunk.gpu;
    if (!total) { this.freeChunk(chunk); chunk.gpu = { empty: true }; return; }
    if (!g || g.empty) {
      g = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), bytes: 0 };
      gl.bindVertexArray(g.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, 16, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bindVertexArray(null);
    }
    this.ensureIndices(total);
    const bytes = total * 64;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
    let off = 0;
    for (const arr of [mesh.opaque, mesh.cutout, mesh.translucent]) {
      if (arr.length) gl.bufferSubData(gl.ARRAY_BUFFER, off, arr);
      off += arr.byteLength;
    }
    g.bytes = bytes;
    g.nO = nO; g.nC = nC; g.nT = nT;
    g.minY = mesh.minY; g.maxY = mesh.maxY;
    chunk.gpu = g;
  }

  freeChunk(chunk) {
    const g = chunk.gpu;
    if (g && !g.empty) {
      this.gl.deleteVertexArray(g.vao);
      this.gl.deleteBuffer(g.vbo);
    }
    chunk.gpu = null;
  }

  // ---------------------------------------------------------------------------
  // Clouds: a tiling grid of flat boxes.
  buildClouds(seed) {
    const gl = this.gl;
    const r = rng(seed);
    const G = CLOUD_GRID;
    const lattice = new Float32Array(16 * 16);
    for (let i = 0; i < lattice.length; i++) lattice[i] = r();
    const lattice2 = new Float32Array(32 * 32);
    for (let i = 0; i < lattice2.length; i++) lattice2[i] = r();
    const vn = (lat, p, x, y) => {
      const fx = (x / G) * p, fy = (y / G) * p;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const at = (a, b) => lat[((b % p + p) % p) * p + ((a % p + p) % p)];
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
    const cell = new Uint8Array(G * G);
    for (let z = 0; z < G; z++) for (let x = 0; x < G; x++) {
      const v = vn(lattice, 16, x, z) * 0.65 + vn(lattice2, 32, x, z) * 0.35;
      cell[z * G + x] = v > 0.56 ? 1 : 0;
    }
    const has = (x, z) => cell[((z % G + G) % G) * G + ((x % G + G) % G)];
    const verts = [];
    const quad = (pts, shade) => {
      for (const i of [0, 1, 2, 0, 2, 3]) verts.push(pts[i][0], pts[i][1], pts[i][2], shade);
    };
    const C = CLOUD_CELL, H = CLOUD_H;
    for (let z = 0; z < G; z++) for (let x = 0; x < G; x++) {
      if (!has(x, z)) continue;
      const x0 = x * C, x1 = x0 + C, z0 = z * C, z1 = z0 + C;
      quad([[x0, H, z0], [x0, H, z1], [x1, H, z1], [x1, H, z0]], 1.0);
      quad([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], 0.72);
      if (!has(x + 1, z)) quad([[x1, 0, z0], [x1, H, z0], [x1, H, z1], [x1, 0, z1]], 0.86);
      if (!has(x - 1, z)) quad([[x0, 0, z1], [x0, H, z1], [x0, H, z0], [x0, 0, z0]], 0.86);
      if (!has(x, z + 1)) quad([[x1, 0, z1], [x1, H, z1], [x0, H, z1], [x0, 0, z1]], 0.93);
      if (!has(x, z - 1)) quad([[x0, 0, z0], [x0, H, z0], [x1, H, z0], [x1, 0, z0]], 0.93);
    }
    this.cloudVao = gl.createVertexArray();
    gl.bindVertexArray(this.cloudVao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
    this.cloudCount = verts.length / 4;
  }

  // ---------------------------------------------------------------------------
  // Dynamic buffers for particles, lines and generic models.
  initDynamic() {
    const gl = this.gl;
    this.partVao = gl.createVertexArray();
    this.partVbo = gl.createBuffer();
    gl.bindVertexArray(this.partVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);
    this.partData = new Float32Array(40 * 4096);

    this.lineVao = gl.createVertexArray();
    this.lineVbo = gl.createBuffer();
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);
    this.lineData = new Float32Array(3 * 4 * 64);
  }

  // Model mesh: Float32Array of [px,py,pz, nx,ny,nz, u,v,layer] per vertex, quads.
  createModel(data) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 24);
    const quads = data.length / 36;
    this.ensureIndices(quads);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);
    return { vao, vbo, quads };
  }

  // A one-layer array texture from a canvas (sign text, name tags, maps).
  createCanvasTexture(canvas, old = null) {
    const gl = this.gl;
    const tex = old || gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, canvas.width, canvas.height, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, canvas.width, canvas.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  deleteTexture(t) { if (t) this.gl.deleteTexture(t); }

  deleteModel(m) {
    if (!m) return;
    this.gl.deleteVertexArray(m.vao);
    this.gl.deleteBuffer(m.vbo);
  }

  // ---------------------------------------------------------------------------
  setCommonUniforms(prog, env) {
    const gl = this.gl, u = prog.u;
    if (u.uSkyBright) gl.uniform1f(u.uSkyBright, env.skyBright);
    if (u.uSkyLightColor) gl.uniform3fv(u.uSkyLightColor, env.skyLightColor);
    if (u.uGamma) gl.uniform1f(u.uGamma, env.gamma);
    if (u.uFlicker) gl.uniform1f(u.uFlicker, env.flicker);
    if (u.uFogColor) gl.uniform3fv(u.uFogColor, env.fogColor);
    if (u.uSunset) gl.uniform4fv(u.uSunset, env.sunset);
    if (u.uSunDir) gl.uniform3fv(u.uSunDir, env.sunDir);
    if (u.uFog) gl.uniform3f(u.uFog, env.fogStart, env.fogEnd, env.fogMode);
    if (u.uAmbient) gl.uniform3fv(u.uAmbient, env.ambient || AMBIENT);
    if (u.uEmissive) gl.uniform1f(u.uEmissive, this.emissive);
    if (u.uShadowParams) {
      gl.uniform4fv(u.uShadowParams, this.shadowParams);
      gl.uniformMatrix4fv(u.uShadowVP, false, this.shadowVP);
      if (u.uLightDir) gl.uniform3fv(u.uLightDir, this.lightDir);
    }
  }

  // scene: { cam, env, chunks, renderDist, time, entities, particles, selection, breaking, hand }
  render(scene) {
    const gl = this.gl;
    this.resize();
    const { cam, env } = scene;
    const aspect = this.width / this.height;
    const far = Math.max(512, scene.renderDist * 16 * 1.8);
    perspective(this.proj, (cam.fov * Math.PI) / 180, aspect, 0.05, far);
    viewRotation(this.view, cam.yaw, cam.pitch, cam.roll || 0);
    // camera offset for bobbing is applied by shifting the camera position
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);
    frustumPlanes(this.planes, this.viewProj);

    this.ensureTargets();
    // the chunk list is walked twice (shadows, then the view)
    if (!Array.isArray(scene.chunks)) scene.chunks = Array.from(scene.chunks);
    this.renderShadows(scene);
    const t = this.post ? this.targets : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? (t.samples && t.msFbo ? t.msFbo : t.sceneFbo) : null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(env.fogColor[0], env.fogColor[1], env.fogColor[2], 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sky
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const ps = this.progSky;
    gl.useProgram(ps.p);
    this.setCommonUniforms(ps, env);
    gl.uniformMatrix4fv(ps.u.uInvViewProj, false, this.invViewProj);
    gl.uniform3fv(ps.u.uZenith, env.zenith);
    gl.uniform1f(ps.u.uStars, env.stars);
    gl.uniform1f(ps.u.uMoonPhase, env.moonPhase);
    gl.uniform1f(ps.u.uTime, scene.time.seconds);
    gl.uniform1f(ps.u.uRain, env.rain);
    gl.uniform1f(ps.u.uDay, env.day);
    gl.uniformMatrix3fv(ps.u.uCelestial, false, env.celestial);
    gl.uniform1f(ps.u.uSkyMode, env.skyMode || 0);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // Visible chunk list (sorted near to far)
    const vis = this.visible || (this.visible = []);
    vis.length = 0;
    let quads = 0, loaded = 0;
    for (const c of scene.chunks) {
      const g = c.gpu;
      if (!g || g.empty) continue;
      loaded++;
      const ox = c.cx * 16 - cam.x, oz = c.cz * 16 - cam.z;
      if (!boxInFrustum(this.planes, ox, g.minY - cam.y, oz, ox + 16, g.maxY - cam.y, oz + 16)) continue;
      const dx = ox + 8, dz = oz + 8;
      c._dist = dx * dx + dz * dz;
      vis.push(c);
    }
    vis.sort((a, b) => a._dist - b._dist);

    // Chunk passes
    const pc = this.progChunk;
    gl.useProgram(pc.p);
    this.setCommonUniforms(pc, env);
    gl.uniformMatrix4fv(pc.u.uViewProj, false, this.viewProj);
    gl.uniform1f(pc.u.uTime, scene.time.seconds);
    gl.uniform1f(pc.u.uAnim, Math.floor(scene.time.seconds * 10) % 16);
    gl.uniform1f(pc.u.uAnimSlow, Math.floor(scene.time.seconds * 5) % 16);
    gl.uniform1f(pc.u.uWave, this.quality.waving ? 1 : 0);
    gl.uniform1f(pc.u.uWaterFx, this.quality.waterFx ? 1 : 0);
    gl.uniform3fv(pc.u.uZenith, env.zenith);
    gl.uniform1f(pc.u.uRain, env.rain || 0);
    const relief = !!(this.quality.relief && this.normalTex);
    gl.uniform1f(pc.u.uRelief, relief ? 1 : 0);
    gl.uniform3fv(pc.u.uLightDir, this.lightDir);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, relief ? this.normalTex : this.blockTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blockTex);
    gl.uniform1i(pc.u.uTex, 0);
    const drawPass = (pass, list) => {
      gl.uniform1i(pc.u.uPass, pass);
      for (const c of list) {
        const g = c.gpu;
        const n = pass === 0 ? g.nO : pass === 1 ? g.nC : g.nT;
        if (!n) continue;
        const start = pass === 0 ? 0 : pass === 1 ? g.nO : g.nO + g.nC;
        gl.bindVertexArray(g.vao);
        gl.uniform3f(pc.u.uOffset, c.cx * 16 - cam.x, -cam.y, c.cz * 16 - cam.z);
        gl.uniform3f(pc.u.uChunkPos, (c.cx * 16) % 4096, 0, (c.cz * 16) % 4096);
        gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_INT, start * 24);
        quads += n;
      }
    };
    drawPass(0, vis);
    gl.disable(gl.CULL_FACE); // plants and leaves are seen from both sides
    drawPass(1, vis);
    gl.enable(gl.CULL_FACE);

    // Entities, dropped items, player model
    if (scene.drawModels) scene.drawModels(this);

    // Block break overlay
    if (scene.breaking) this.drawBreaking(scene.breaking, cam, env);
    // Selection outline
    if (scene.selection) this.drawSelection(scene.selection, cam);

    // Particles
    if (scene.particles && scene.particles.count) this.drawParticles(scene.particles, cam, env);

    const camAboveClouds = cam.y > CLOUD_Y + CLOUD_H;
    if (!camAboveClouds && scene.clouds) this.drawClouds(scene, cam, env);

    // Translucent chunks (water, ice): far to near, depth writes on so only
    // the nearest surface is blended.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(pc.p);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blockTex);
    gl.disable(gl.CULL_FACE);
    const rev = this.rev || (this.rev = []);
    rev.length = 0;
    for (let i = vis.length - 1; i >= 0; i--) if (vis[i].gpu.nT) rev.push(vis[i]);
    drawPass(2, rev);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    if (camAboveClouds && scene.clouds) this.drawClouds(scene, cam, env);

    this.stats.chunks = loaded;
    this.stats.drawn = vis.length;
    this.stats.quads = quads;

    // First-person hand
    if (scene.drawHand) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      perspective(this.handProj, (70 * Math.PI) / 180, aspect, 0.05, 10);
      scene.drawHand(this);
    }
    if (this.post) this.postProcess();
    gl.bindVertexArray(null);
  }

  // Draw a model with a camera-relative model matrix.
  drawModel(model, matrix, tex, light, env, opts = {}) {
    const gl = this.gl, pm = this.progModel;
    gl.useProgram(pm.p);
    this.setCommonUniforms(pm, env);
    gl.uniformMatrix4fv(pm.u.uViewProj, false, opts.proj || this.viewProj);
    gl.uniformMatrix4fv(pm.u.uModel, false, matrix);
    gl.uniform2f(pm.u.uLight, light[0], light[1]);
    const tint = opts.tint || [0, 0, 0, 0];
    gl.uniform4f(pm.u.uTint, tint[0], tint[1], tint[2], tint[3]);
    gl.uniform1i(pm.u.uMode, opts.mode || 0);
    gl.uniform1i(pm.u.uBlockMode, opts.blockMode || 0);
    const tc = opts.tintColor || WHITE;
    gl.uniform3f(pm.u.uTintColor, tc[0], tc[1], tc[2]);
    gl.uniform1f(pm.u.uAlpha, opts.alpha ?? 1);
    gl.uniform1f(pm.u.uGlow, opts.glow || 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, typeof tex === 'object' ? tex : tex === 'item' ? this.itemTex : tex === 'skin' ? this.skinTex : this.blockTex);
    gl.uniform1i(pm.u.uTex, 0);
    if (opts.noCull) gl.disable(gl.CULL_FACE);
    if (opts.blend) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
    gl.bindVertexArray(model.vao);
    gl.drawElements(gl.TRIANGLES, model.quads * 6, gl.UNSIGNED_INT, 0);
    if (opts.blend) { gl.disable(gl.BLEND); gl.depthMask(true); }
    if (opts.noCull) gl.enable(gl.CULL_FACE);
  }

  drawBreaking(b, cam, env) {
    const gl = this.gl;
    if (!this.crackModels) this.crackModels = [];
    let m = this.crackModels[b.stage];
    if (!m) {
      m = this.crackModels[b.stage] = this.createModel(cubeMesh(0, 0, 0, 1, 1, 1, () => TEX.crack0 + b.stage));
    }
    const M = this.tmp;
    const [x0, y0, z0, x1, y1, z1] = b.box;
    const e = 0.002;
    M.fill(0);
    M[0] = x1 - x0 + 2 * e; M[5] = y1 - y0 + 2 * e; M[10] = z1 - z0 + 2 * e; M[15] = 1;
    M[12] = b.x + x0 - e - cam.x; M[13] = b.y + y0 - e - cam.y; M[14] = b.z + z0 - e - cam.z;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    this.drawModel(m, M, 'block', [1, 1], env, { mode: 1 });
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  drawSelection(sel, cam) {
    const gl = this.gl;
    const [x0, y0, z0, x1, y1, z1] = sel.box;
    const e = 0.003;
    const bx0 = sel.x + x0 - e - cam.x, by0 = sel.y + y0 - e - cam.y, bz0 = sel.z + z0 - e - cam.z;
    const bx1 = sel.x + x1 + e - cam.x, by1 = sel.y + y1 + e - cam.y, bz1 = sel.z + z1 + e - cam.z;
    const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, cz = (bz0 + bz1) / 2;
    const dist = Math.max(0.5, Math.hypot(cx, cy, cz));
    const t = dist * 0.0022 * (1080 / Math.max(600, this.height)) * 1.4;
    const edges = [
      [bx0, by0, bz0, bx1, by0, bz0], [bx0, by1, bz0, bx1, by1, bz0], [bx0, by0, bz1, bx1, by0, bz1], [bx0, by1, bz1, bx1, by1, bz1],
      [bx0, by0, bz0, bx0, by1, bz0], [bx1, by0, bz0, bx1, by1, bz0], [bx0, by0, bz1, bx0, by1, bz1], [bx1, by0, bz1, bx1, by1, bz1],
      [bx0, by0, bz0, bx0, by0, bz1], [bx1, by0, bz0, bx1, by0, bz1], [bx0, by1, bz0, bx0, by1, bz1], [bx1, by1, bz0, bx1, by1, bz1],
    ];
    const d = this.lineData;
    let n = 0;
    for (const [ax, ay, az, bx, by, bz] of edges) {
      // two crossed thin quads per edge so it reads from any angle
      const axis = ax !== bx ? 0 : ay !== by ? 1 : 2;
      const o1 = axis === 0 ? [0, t, 0] : [t, 0, 0];
      const o2 = axis === 2 ? [0, t, 0] : [0, 0, t];
      for (const o of [o1, o2]) {
        const pts = [
          [ax - o[0], ay - o[1], az - o[2]], [bx - o[0], by - o[1], bz - o[2]],
          [bx + o[0], by + o[1], bz + o[2]], [ax + o[0], ay + o[1], az + o[2]],
        ];
        for (const p of pts) { d[n++] = p[0]; d[n++] = p[1]; d[n++] = p[2]; }
      }
    }
    gl.useProgram(this.progLine.p);
    gl.uniformMatrix4fv(this.progLine.u.uViewProj, false, this.viewProj);
    gl.uniform4f(this.progLine.u.uColor, 0.02, 0.02, 0.02, 0.72);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n), gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.drawElements(gl.TRIANGLES, (n / 12) * 6, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  drawParticles(p, cam, env) {
    const gl = this.gl;
    const count = Math.min(p.count, 4096);
    if (this.partData.length < count * 40) this.partData = new Float32Array(count * 40);
    const d = this.partData;
    // camera basis
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const rx = cy, ry = 0, rz = sy;
    const fx = sy * cp, fy = sp, fz = -cy * cp;
    const ux = -(fy * rz - fz * ry), uy = -(fz * rx - fx * rz), uz = -(fx * ry - fy * rx);
    let n = 0;
    const src = p.data;
    for (let i = 0; i < count; i++) {
      const o = i * 16;
      const x = src[o] - cam.x, y = src[o + 1] - cam.y, z = src[o + 2] - cam.z;
      const s = src[o + 3] * 0.5;
      const u0 = src[o + 4], v0 = src[o + 5], u1 = src[o + 6], v1 = src[o + 7], layer = src[o + 8];
      const r = src[o + 9], g = src[o + 10], b = src[o + 11], a = src[o + 12];
      const vertical = src[o + 13];
      const glow = src[o + 14] ? 1 + (this.emissive - 1) * 0.7 : 1;
      let axx = rx * s, axy = ry * s, axz = rz * s;
      let bxx = ux * s, bxy = uy * s, bxz = uz * s;
      if (vertical) { bxx = 0; bxy = s * vertical; bxz = 0; }
      const corners = [[-1, -1, u0, v1], [1, -1, u1, v1], [1, 1, u1, v0], [-1, 1, u0, v0]];
      for (const [cx, cyy, uu, vv] of corners) {
        d[n++] = x + axx * cx + bxx * cyy; d[n++] = y + axy * cx + bxy * cyy; d[n++] = z + axz * cx + bxz * cyy;
        d[n++] = uu; d[n++] = vv; d[n++] = layer;
        d[n++] = r * glow; d[n++] = g * glow; d[n++] = b * glow; d[n++] = a;
      }
    }
    const pp = this.progParticle;
    gl.useProgram(pp.p);
    this.setCommonUniforms(pp, env);
    gl.uniformMatrix4fv(pp.u.uViewProj, false, this.viewProj);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blockTex);
    gl.uniform1i(pp.u.uTex, 0);
    gl.bindVertexArray(this.partVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partVbo);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  drawClouds(scene, cam, env) {
    const gl = this.gl, pc = this.progCloud;
    const tile = CLOUD_GRID * CLOUD_CELL;
    const scroll = scene.time.cloudScroll; // clouds drift east
    const baseX = cam.x - scroll, baseZ = cam.z;
    const tx = Math.floor(baseX / tile), tz = Math.floor(baseZ / tile);
    const fx = baseX - tx * tile, fz = baseZ - tz * tile;
    const ox = fx < tile / 2 ? -1 : 0, oz = fz < tile / 2 ? -1 : 0;
    gl.useProgram(pc.p);
    this.setCommonUniforms(pc, env);
    gl.uniformMatrix4fv(pc.u.uViewProj, false, this.viewProj);
    gl.uniform3fv(pc.u.uCloudColor, env.cloudColor);
    gl.uniform1f(pc.u.uCloudFar, Math.max(260, scene.renderDist * 16 * 1.6));
    gl.bindVertexArray(this.cloudVao);
    gl.disable(gl.CULL_FACE);
    const draw = () => {
      for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const X = (tx + ox + dx) * tile + scroll - cam.x;
        const Z = (tz + oz + dz) * tile - cam.z;
        gl.uniform3f(pc.u.uOffset, X, CLOUD_Y - cam.y, Z);
        gl.drawArrays(gl.TRIANGLES, 0, this.cloudCount);
      }
    };
    // depth pre-pass so overlapping cloud faces blend only once
    gl.colorMask(false, false, false, false);
    draw();
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    draw();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  // Capture the current frame as a data URL (call right after render()).
  capture() {
    try { return this.canvas.toDataURL('image/png'); } catch { return null; }
  }
}

// ---------------------------------------------------------------------------
// Mesh helpers for models (quads; 9 floats per vertex).
const CUBE_FACES = [
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];
function uvFor(f, x, y, z) {
  switch (f) {
    case 0: return [x, z];
    case 1: return [x, 1 - z];
    case 2: return [1 - z, 1 - y];
    case 3: return [z, 1 - y];
    case 4: return [x, 1 - y];
    default: return [1 - x, 1 - y];
  }
}

// Unit cube scaled to a box; layerFn(face) picks the texture layer. UVs are
// taken from the position inside the unit cube (so partial boxes crop).
export function cubeMesh(x0, y0, z0, x1, y1, z1, layerFn, uvBox = [0, 0, 0, 1, 1, 1]) {
  const out = [];
  for (let f = 0; f < 6; f++) {
    const F = CUBE_FACES[f];
    const layer = layerFn(f);
    if (layer < 0) continue;
    for (const c of F.c) {
      const px = c[0] ? x1 : x0, py = c[1] ? y1 : y0, pz = c[2] ? z1 : z0;
      const ux = c[0] ? uvBox[3] : uvBox[0], uy = c[1] ? uvBox[4] : uvBox[1], uz = c[2] ? uvBox[5] : uvBox[2];
      const [u, v] = uvFor(f, ux, uy, uz);
      out.push(px, py, pz, F.n[0], F.n[1], F.n[2], u, v, layer);
    }
  }
  return new Float32Array(out);
}

// Box with explicit per-face UV rectangles in a texture of size texW x texH
// (entity skins). Standard box unwrap: origin (u,v), size w,h,d in texels.
export function skinBox(x0, y0, z0, w, h, d, u, v, layer, texW = 64, texH = 64, inflate = 0, mirror = false) {
  const X0 = x0 - inflate, Y0 = y0 - inflate, Z0 = z0 - inflate;
  const X1 = x0 + w + inflate, Y1 = y0 + h + inflate, Z1 = z0 + d + inflate;
  // rects: [u0, v0, u1, v1] in texels
  const rect = {
    top: [u + d, v, u + d + w, v + d],
    bottom: [u + d + w, v, u + d + w + w, v + d],
    right: [u, v + d, u + d, v + d + h], // -X side
    front: [u + d, v + d, u + d + w, v + d + h], // -Z
    left: [u + d + w, v + d, u + d + w + d, v + d + h], // +X
    back: [u + d + w + d, v + d, u + d + w + d + w, v + d + h], // +Z
  };
  if (mirror) { const t = rect.right; rect.right = rect.left; rect.left = t; }
  const out = [];
  const push = (p, n, uu, vv) => out.push(p[0], p[1], p[2], n[0], n[1], n[2], uu / texW, vv / texH, layer);
  // pts: bottom-left, top-left, top-right, bottom-right as seen from outside;
  // emitted in reverse so the winding is counter-clockwise.
  const face = (pts, n, r) => {
    let [a, b, c, dd] = r;
    if (mirror) { const t = a; a = c; c = t; }
    push(pts[3], n, c, dd); push(pts[2], n, c, b); push(pts[1], n, a, b); push(pts[0], n, a, dd);
  };
  // -Z (front): seen from -Z, left is +X... use right-handed view: viewer at -Z looking +Z, right = -X
  face([[X1, Y0, Z0], [X1, Y1, Z0], [X0, Y1, Z0], [X0, Y0, Z0]], [0, 0, -1], rect.front);
  // +Z (back): viewer at +Z looking -Z, right = +X
  face([[X0, Y0, Z1], [X0, Y1, Z1], [X1, Y1, Z1], [X1, Y0, Z1]], [0, 0, 1], rect.back);
  // -X side: viewer at -X looking +X, right = +Z
  face([[X0, Y0, Z0], [X0, Y1, Z0], [X0, Y1, Z1], [X0, Y0, Z1]], [-1, 0, 0], rect.right);
  // +X side: viewer at +X looking -X, right = -Z
  face([[X1, Y0, Z1], [X1, Y1, Z1], [X1, Y1, Z0], [X1, Y0, Z0]], [1, 0, 0], rect.left);
  // top: seen from above, front edge (-Z) at the bottom of the rect
  face([[X1, Y1, Z0], [X1, Y1, Z1], [X0, Y1, Z1], [X0, Y1, Z0]], [0, 1, 0], rect.top);
  // bottom
  face([[X1, Y0, Z1], [X1, Y0, Z0], [X0, Y0, Z0], [X0, Y0, Z1]], [0, -1, 0], rect.bottom);
  return out;
}
