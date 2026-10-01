// Chunk lighting and mesh building. Runs in workers (or on the main thread as
// a fallback). Input: the chunk plus its 8 neighbours. Light is flood-filled
// over the whole 48x48 region so light crossing chunk borders is exact
// (light never travels further than 15 blocks).
import {
  OPAQUE, RENDER_TYPE, RENDER_PASS, EMIT, OPACITY, TINT, WAVE, SELF_CULL, SOLID,
  faceTexture, ROT, RENDER, PASS, B, TEX,
} from './blocks.js';
import { HEIGHT } from './constants.js';
import { shapeBoxes, SHAPE } from './shapes.js';
import { SHAPE_KIND, BLOCKS } from './blocks.js';
import { SHAPE_CTX } from './blocks.js';
import { BIRCH_TINT, SPRUCE_TINT } from './worldgen.js';

const RX = 48, RZ = 48, LAYER = RX * RZ;

// Spark wire colour by power level (packed RGB tint).
const WIRE_TINT = new Uint32Array(16);
for (let p = 0; p < 16; p++) {
  const r = Math.round(255 * (0.3 + 0.7 * p / 15)), g = Math.round((p / 15) * 50), b = Math.round((p / 15) * 24);
  WIRE_TINT[p] = r | (g << 8) | (b << 16);
}
const WIRE_DX = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W
// Rail shapes (0-9): curve shapes pick a texture turn.
const RAIL_CURVE_TURN = { 6: 0, 7: 3, 8: 2, 9: 1 };

export const FLAG = { WAVE_LEAF: 1, WAVE_PLANT: 2, ANIM: 4, ANIM_SLOW: 8, FULLBRIGHT: 16, WATER: 32, EMISSIVE: 64 };

// Blocks that give off their own light glow on HDR targets.
const EMISSIVE = new Uint8Array(1024);
for (const n of ['lamp', 'spark_lamp_on', 'ember_crystal', 'torch', 'spark_torch', 'glow_rod', 'lantern']) if (B[n] !== undefined) EMISSIVE[B[n]] = 1;

// Faces: 0 +Y, 1 -Y, 2 +X, 3 -X, 4 +Z, 5 -Z. Corner positions are unit-cube
// offsets in counter-clockwise order seen from outside.
const FACES = [
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];
export const FACE_SHADE = [1.0, 0.5, 0.6, 0.6, 0.8, 0.8];
const AO_CURVE = [0.42, 0.6, 0.8, 1.0];

// Texture coordinates (0..16) for a point on a face, derived from its position
// so partial boxes pick the matching texels (torches, cacti, liquids).
function faceUV(f, x, y, z) {
  switch (f) {
    case 0: return [x, z];
    case 1: return [x, 16 - z];
    case 2: return [16 - z, 16 - y];
    case 3: return [z, 16 - y];
    case 4: return [x, 16 - y];
    default: return [16 - x, 16 - y];
  }
}

// Precomputed per face/corner: tangent offsets for AO and smooth light.
const CORNER_T = FACES.map((F) => F.c.map((c) => {
  const t = [];
  for (let a = 0; a < 3; a++) {
    if (F.n[a] !== 0) continue;
    const v = [0, 0, 0]; v[a] = c[a] ? 1 : -1; t.push(v);
  }
  return t; // two tangent vectors
}));

class Builder {
  constructor() { this.data = new Uint32Array(1 << 16); this.n = 0; }
  reset() { this.n = 0; }
  push(w0, w1, w2, w3) {
    if (this.n + 4 > this.data.length) {
      const d = new Uint32Array(this.data.length * 2); d.set(this.data); this.data = d;
    }
    const d = this.data, n = this.n;
    d[n] = w0; d[n + 1] = w1; d[n + 2] = w2; d[n + 3] = w3;
    this.n = n + 4;
  }
  get quads() { return this.n >> 4; }
}

export class Mesher {
  constructor() {
    this.cap = 0;
    this.ensure(128);
    this.queue = new Int32Array(1 << 20);
    this.builders = [new Builder(), new Builder(), new Builder()];
    this.colTop = new Int16Array(LAYER);
    this.tmpA = new Float32Array(3);
  }

  ensure(ry) {
    const size = LAYER * ry;
    if (size <= this.cap) return;
    this.cap = size;
    this.blk = new Uint8Array(size);
    this.meta = new Uint8Array(size);
    this.sky = new Uint8Array(size);
    this.bl = new Uint8Array(size);
  }

  // job: { cx, cz, chunks: [{blocks, meta, maxY} x9 ordered (dz,dx) from -1], tints }
  build(job) {
    let top = 0;
    for (const c of job.chunks) if (c.maxY > top) top = c.maxY;
    const ry = Math.min(HEIGHT, top + 2);
    this.ry = ry;
    this.ensure(ry);
    const size = LAYER * ry;
    const R = this.blk, M = this.meta;
    R.fill(0, 0, size); M.fill(0, 0, size);
    for (let ci = 0; ci < 9; ci++) {
      const ch = job.chunks[ci];
      const ox = (ci % 3) * 16, oz = Math.floor(ci / 3) * 16;
      const cb = ch.blocks, cm = ch.meta;
      const yMax = Math.min(ry, cb.length >> 8);
      for (let y = 0; y < yMax; y++) {
        for (let z = 0; z < 16; z++) {
          const s = (y << 8) | (z << 4);
          const d = (y * RZ + oz + z) * RX + ox;
          R.set(cb.subarray(s, s + 16), d);
          M.set(cm.subarray(s, s + 16), d);
        }
      }
    }
    this.computeLight(ry, !!job.noSky);
    return this.mesh(job, ry);
  }

  // ---------------------------------------------------------------------------
  computeLight(ry, noSky = false) {
    const R = this.blk, S = this.sky, L = this.bl, Q = this.queue, top = this.colTop;
    const size = LAYER * ry;
    S.fill(0, 0, size); L.fill(0, 0, size);
    const QM = Q.length - 1;
    let head = 0, tail = 0;

    if (!noSky) {
      // Direct skylight down each column.
      for (let z = 0; z < RZ; z++) for (let x = 0; x < RX; x++) {
        let light = 15, y = ry - 1, i = (y * RZ + z) * RX + x;
        for (; y >= 0; y--, i -= LAYER) {
          if (OPACITY[R[i]] !== 0) break;
          S[i] = 15;
        }
        top[z * RX + x] = y + 1;
        for (; y >= 0; y--, i -= LAYER) {
          const op = OPACITY[R[i]];
          if (op >= 15) break;
          light -= op;
          if (light <= 0) break;
          S[i] = light;
        }
      }
      // Seed cells that can spread sideways or under overhangs.
      for (let z = 0; z < RZ; z++) for (let x = 0; x < RX; x++) {
        const c = z * RX + x;
        let mt = top[c];
        if (x > 0 && top[c - 1] > mt) mt = top[c - 1];
        if (x < RX - 1 && top[c + 1] > mt) mt = top[c + 1];
        if (z > 0 && top[c - RX] > mt) mt = top[c - RX];
        if (z < RZ - 1 && top[c + RX] > mt) mt = top[c + RX];
        for (let y = 0; y < mt && y < ry; y++) {
          const i = y * LAYER + c;
          if (S[i] > 1) { Q[tail] = x | (z << 6) | (y << 12); tail = (tail + 1) & QM; }
        }
      }
      this.flood(S, head, tail, ry);
    }

    // Block light from emitters.
    head = 0; tail = 0;
    for (let i = 0; i < size; i++) {
      const e = EMIT[R[i]];
      if (e) {
        L[i] = e;
        const y = (i / LAYER) | 0, r = i - y * LAYER, z = (r / RX) | 0, x = r - z * RX;
        Q[tail] = x | (z << 6) | (y << 12); tail = (tail + 1) & QM;
      }
    }
    this.flood(L, head, tail, ry);
  }

  flood(A, head, tail, ry) {
    const R = this.blk, Q = this.queue, QM = Q.length - 1;
    while (head !== tail) {
      const p = Q[head]; head = (head + 1) & QM;
      const x = p & 63, z = (p >> 6) & 63, y = p >> 12;
      const i = (y * RZ + z) * RX + x;
      const l = A[i];
      if (l <= 1) continue;
      // six neighbours
      for (let d = 0; d < 6; d++) {
        let nx = x, ny = y, nz = z, j;
        switch (d) {
          case 0: if (x === 0) continue; nx--; j = i - 1; break;
          case 1: if (x === RX - 1) continue; nx++; j = i + 1; break;
          case 2: if (z === 0) continue; nz--; j = i - RX; break;
          case 3: if (z === RZ - 1) continue; nz++; j = i + RX; break;
          case 4: if (y === 0) continue; ny--; j = i - LAYER; break;
          default: if (y === ry - 1) continue; ny++; j = i + LAYER; break;
        }
        const op = OPACITY[R[j]];
        if (op >= 15) continue;
        const nl = l - (op > 1 ? op : 1);
        if (nl > A[j]) {
          A[j] = nl;
          Q[tail] = nx | (nz << 6) | (ny << 12); tail = (tail + 1) & QM;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  mesh(job, ry) {
    const R = this.blk, M = this.meta, S = this.sky, L = this.bl;
    const [opq, cut, tra] = this.builders;
    opq.reset(); cut.reset(); tra.reset();
    const tints = job.tints;
    const wx0 = job.cx * 16, wz0 = job.cz * 16;
    let minY = HEIGHT, maxY = 0;

    const idxOf = (x, y, z) => (y * RZ + z) * RX + x;
    const blockAt = (x, y, z) => (y < 0 ? B.bedrock : y >= ry ? 0 : R[idxOf(x, y, z)]);
    const skyAt = (x, y, z) => (y < 0 ? 0 : y >= ry ? 15 : S[idxOf(x, y, z)]);
    const blAt = (x, y, z) => (y < 0 || y >= ry ? 0 : L[idxOf(x, y, z)]);
    const opaqueAt = (x, y, z) => (y < 0 ? 1 : y >= ry ? 0 : OPAQUE[R[idxOf(x, y, z)]]);

    const tintFor = (id, lx, lz) => {
      const t = TINT[id];
      if (!t) return 0xffffff;
      if (t === 4) return BIRCH_TINT[0] | (BIRCH_TINT[1] << 8) | (BIRCH_TINT[2] << 16);
      if (t === 5) return SPRUCE_TINT[0] | (SPRUCE_TINT[1] << 8) | (SPRUCE_TINT[2] << 16);
      const o = (lz * 16 + lx) * 9 + (t - 1) * 3;
      return tints[o] | (tints[o + 1] << 8) | (tints[o + 2] << 16);
    };

    const pack0 = (px, py, pz) => (px | (py << 9) | (pz << 22)) >>> 0;
    let extraFlags = 0;
    const pack1 = (u, v, layer, face, flags) => (u | (v << 5) | (layer << 10) | (face << 19) | ((flags | extraFlags) << 22)) >>> 0;
    const pack2 = (sky, bl, shade) => (Math.round(sky * 17) | (Math.round(bl * 17) << 8) | (Math.round(shade * 255) << 16)) >>> 0;

    const lightOut = new Uint8Array(256 * ry);
    const cornerAO = [0, 0, 0, 0], cornerSky = [0, 0, 0, 0], cornerBl = [0, 0, 0, 0];

    // Emit a full-cube face with smooth lighting and ambient occlusion.
    const cubeFace = (b, x, y, z, lx, lz, f, layer, rot, flags, tint) => {
      const F = FACES[f];
      const fx = x + F.n[0], fy = y + F.n[1], fz = z + F.n[2];
      const baseSky = skyAt(fx, fy, fz), baseBl = blAt(fx, fy, fz);
      for (let k = 0; k < 4; k++) {
        const [t1, t2] = CORNER_T[f][k];
        const s1 = opaqueAt(fx + t1[0], fy + t1[1], fz + t1[2]);
        const s2 = opaqueAt(fx + t2[0], fy + t2[1], fz + t2[2]);
        const cx = fx + t1[0] + t2[0], cy = fy + t1[1] + t2[1], cz = fz + t1[2] + t2[2];
        const co = s1 && s2 ? 1 : opaqueAt(cx, cy, cz);
        cornerAO[k] = s1 && s2 ? 0 : 3 - (s1 + s2 + co);
        let sk = baseSky, bl = baseBl, n = 1;
        if (!s1) { sk += skyAt(fx + t1[0], fy + t1[1], fz + t1[2]); bl += blAt(fx + t1[0], fy + t1[1], fz + t1[2]); n++; }
        if (!s2) { sk += skyAt(fx + t2[0], fy + t2[1], fz + t2[2]); bl += blAt(fx + t2[0], fy + t2[1], fz + t2[2]); n++; }
        if (!co) { sk += skyAt(cx, cy, cz); bl += blAt(cx, cy, cz); n++; }
        cornerSky[k] = sk / n; cornerBl[k] = bl / n;
      }
      const flip = cornerAO[0] + cornerAO[2] < cornerAO[1] + cornerAO[3];
      const shade = FACE_SHADE[f];
      for (let kk = 0; kk < 4; kk++) {
        const k = flip ? (kk + 1) & 3 : kk;
        const c = F.c[k];
        const px = (lx + c[0]) * 16, py = (y + c[1]) * 16, pz = (lz + c[2]) * 16;
        let [u, v] = faceUV(f, c[0] * 16, c[1] * 16, c[2] * 16);
        if (rot) { const t = u; u = v; v = 16 - t; }
        b.push(pack0(px, py, pz), pack1(u, v, layer, f, flags), pack2(cornerSky[k], cornerBl[k], shade * AO_CURVE[cornerAO[k]]), tint);
      }
      if (y < minY) minY = y;
      if (y + 1 > maxY) maxY = y + 1;
    };

    // Emit an axis-aligned box face (coordinates in 1/16 block units, local to
    // the block) with flat lighting from the given cell.
    const boxFace = (b, lx, y, lz, f, x0, y0, z0, x1, y1, z1, layer, flags, tint, sky, bl, shade, shift, rotUV = 0, uo = null) => {
      const F = FACES[f];
      for (let k = 0; k < 4; k++) {
        const c = F.c[k];
        let px = c[0] ? x1 : x0, py = c[1] ? y1 : y0, pz = c[2] ? z1 : z0;
        let [u, v] = faceUV(f, px, py, pz);
        for (let q = 0; q < rotUV; q++) { const t = u; u = 16 - v; v = t; }
        if (uo) { u += uo[0]; v += uo[1]; }
        if (shift) { const s = shift(py, px, pz); px += s[0]; pz += s[1]; py += s[2]; }
        b.push(pack0(lx * 16 + px, y * 16 + py, lz * 16 + pz), pack1(Math.max(0, Math.min(16, u)), Math.max(0, Math.min(16, v)), layer, f, flags), pack2(sky, bl, shade), tint);
      }
      if (y < minY) minY = y;
      if (y + 1 > maxY) maxY = y + 1;
    };

    // A free quad: pts in block-local 1/16 units, uvs per corner.
    const quad = (b, lx, y, lz, pts, uvs, layer, flags, tint, sky, bl, shade) => {
      for (let k = 0; k < 4; k++) {
        const p = pts[k];
        b.push(pack0(lx * 16 + p[0], y * 16 + p[1], lz * 16 + p[2]), pack1(Math.max(0, Math.min(16, uvs[k][0])), Math.max(0, Math.min(16, uvs[k][1])), layer, 6, flags), pack2(sky, bl, shade), tint);
      }
      if (y < minY) minY = y;
      if (y + 2 > maxY) maxY = y + 2;
    };
    const shadeOf = (n) => (n[1] > 0.5 ? 1 : n[1] < -0.5 ? 0.5 : Math.abs(n[0]) > 0.5 ? 0.6 : 0.8);
    const metaAtL = (xx, yy, zz) => (yy < 0 || yy >= ry ? 0 : M[idxOf(xx, yy, zz)]);
    // Does spark wire visually join the block next to it (d: 0 N, 1 E, 2 S, 3 W)?
    const wireJoins = (nid, nmeta, d) => {
      const sp = BLOCKS[nid] && BLOCKS[nid].spark;
      if (!sp) return false;
      if (sp === 'repeater') return ((nmeta & 3) & 1) === (d & 1);
      return sp === 'wire' || sp === 'torch' || sp === 'lever' || sp === 'button' || sp === 'plate' || sp === 'block' || sp === 'detector' || sp === 'sensor';
    };

    for (let y = 0; y < ry; y++) {
      for (let lz = 0; lz < 16; lz++) {
        const z = lz + 16;
        let i = idxOf(16, y, z);
        for (let lx = 0; lx < 16; lx++, i++) {
          const x = lx + 16;
          lightOut[(y << 8) | (lz << 4) | lx] = (S[i] << 4) | L[i];
          const id = R[i];
          if (id === 0) continue;
          extraFlags = EMISSIVE[id] ? FLAG.EMISSIVE : 0;
          const rt = RENDER_TYPE[id];
          const pass = RENDER_PASS[id];
          const b = pass === PASS.OPAQUE ? opq : pass === PASS.CUTOUT ? cut : tra;
          const meta = M[i];

          if (rt === RENDER.CUBE) {
            const tint = tintFor(id, lx, lz);
            const flags = WAVE[id] === 1 ? FLAG.WAVE_LEAF : 0;
            const selfCull = SELF_CULL[id];
            for (let f = 0; f < 6; f++) {
              const n = FACES[f].n;
              const ny = y + n[1];
              if (ny < 0) continue;
              const nid = ny >= ry ? 0 : R[i + n[0] + n[2] * RX + n[1] * LAYER];
              if (OPAQUE[nid]) continue;
              if (nid === id && selfCull) continue;
              if (id === B.ice && nid === B.water && f >= 2) continue;
              const layer = faceTexture(id, f, meta);
              cubeFace(b, x, y, z, lx, lz, f, layer, ROT[0], flags, tint);
            }
          } else if (rt === RENDER.CROSS) {
            const tint = tintFor(id, lx, lz);
            const layer = faceTexture(id, 2, meta);
            const sky = S[i], bl = L[i];
            let ox = 0, oz = 0;
            if (id === B.tall_grass || id === B.fern || id === B.dandelion || id === B.poppy || id === B.cornflower) {
              const h = Math.imul((wx0 + lx) * 73856093 ^ (wz0 + lz) * 19349663, 0x9e3779b1) >>> 0;
              ox = ((h >>> 4) % 5) - 2; oz = ((h >>> 12) % 5) - 2;
            }
            const wave = WAVE[id] === 2;
            const a = 2, c = 14;
            const planes = [
              [[a, a], [c, c]],
              [[a, c], [c, a]],
            ];
            for (const [[ax, az], [bx, bz]] of planes) {
              const pts = [[ax, 0, az], [ax, 16, az], [bx, 16, bz], [bx, 0, bz]];
              const uvs = [[0, 16], [0, 0], [16, 0], [16, 16]];
              for (const order of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
                for (const k of order) {
                  const p = pts[k];
                  const fl = wave && p[1] === 16 ? FLAG.WAVE_PLANT : 0;
                  b.push(
                    pack0(Math.max(0, Math.min(256, lx * 16 + p[0] + ox)), y * 16 + p[1], Math.max(0, Math.min(256, lz * 16 + p[2] + oz))),
                    pack1(uvs[k][0], uvs[k][1], layer, 6, fl),
                    pack2(sky, bl, 0.92), tint,
                  );
                }
              }
            }
            if (y < minY) minY = y;
            if (y + 1 > maxY) maxY = y + 1;
          } else if (rt === RENDER.TORCH) {
            const sky = S[i], bl = L[i];
            const side = faceTexture(id, 2, 0), topT = faceTexture(id, 0, 0);
            let shift = null;
            const m = meta & 7;
            if (m >= 1 && m <= 4) {
              // leaning torch: base 5px toward the wall it hangs on, raised 3px
              const dir = [[-1, 0], [1, 0], [0, -1], [0, 1]][m - 1];
              shift = (py) => {
                const s = py <= 0 ? 5 : 1;
                return [dir[0] * s, dir[1] * s, 3];
              };
            }
            for (let f = 0; f < 6; f++) {
              const layer = f === 0 ? topT : side;
              boxFace(cut, lx, y, lz, f, 7, 0, 7, 9, 10, 9, layer, 0, 0xffffff, sky, bl, FACE_SHADE[f], shift);
            }
          } else if (rt === RENDER.LADDER) {
            const sky = S[i], bl = L[i];
            const layer = faceTexture(id, 2, 0);
            const m = (meta & 7) || 1;
            // attached to the wall on side m (1 -X, 2 +X, 3 -Z, 4 +Z)
            const d = 1;
            const spec = [
              null,
              [2, d, 0, 0, d, 16, 16], [3, 16 - d, 0, 0, 16 - d, 16, 16],
              [4, 0, 0, d, 16, 16, d], [5, 0, 0, 16 - d, 16, 16, 16 - d],
            ][m];
            const [f, x0, y0, z0, x1, y1, z1] = spec;
            boxFace(cut, lx, y, lz, f, x0, y0, z0, x1, y1, z1, layer, 0, 0xffffff, sky, bl, FACE_SHADE[f], null);
            boxFace(cut, lx, y, lz, f ^ 1, x0, y0, z0, x1, y1, z1, layer, 0, 0xffffff, sky, bl, FACE_SHADE[f ^ 1], null);
          } else if (rt === RENDER.CACTUS) {
            for (let f = 0; f < 6; f++) {
              const ny = y + FACES[f].n[1];
              if (ny < 0) continue;
              if (f < 2) {
                const nid = ny >= ry ? 0 : R[i + FACES[f].n[1] * LAYER];
                if (OPAQUE[nid] || nid === id) continue;
              }
              const layer = faceTexture(id, f, meta);
              const lc = f < 2 && ny < ry ? i + FACES[f].n[1] * LAYER : i;
              const sky = ny >= ry ? 15 : S[lc], bl = ny >= ry ? 0 : L[lc];
              boxFace(cut, lx, y, lz, f, 1, 0, 1, 15, 16, 15, layer, 0, 0xffffff, sky, bl, FACE_SHADE[f], null);
            }
          } else if (rt === RENDER.SHAPE) {
            if (SHAPE_KIND[id] === SHAPE.SIGN) continue; // drawn with its text by the scene
            const boxes = shapeBoxes(SHAPE_CTX, id, meta, (dx, dy, dz) => blockAt(x + dx, y + dy, z + dz));
            if (boxes) {
              const tint = tintFor(id, lx, lz);
              for (const bx of boxes) {
                if (bx.pts) {
                  // a free-form box (lever handles): 8 corners, UVs from its model box
                  const P8 = bx.pts, ub = bx.uvb;
                  for (let f = 0; f < 6; f++) {
                    const F = FACES[f];
                    const pts = [], uvs = [];
                    for (let k = 0; k < 4; k++) {
                      const c = F.c[k];
                      pts.push(P8[c[0] + c[1] * 2 + c[2] * 4]);
                      uvs.push(faceUV(f, c[0] ? ub[3] : ub[0], c[1] ? ub[4] : ub[1], c[2] ? ub[5] : ub[2]));
                    }
                    const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
                    const e2 = [pts[3][0] - pts[0][0], pts[3][1] - pts[0][1], pts[3][2] - pts[0][2]];
                    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
                    quad(b, lx, y, lz, pts, uvs, bx.t[f], 0, tint, S[i], L[i], shadeOf([n[0] / nl, n[1] / nl, n[2] / nl]));
                  }
                  continue;
                }
                const [x0, y0, z0, x1, y1, z1] = bx.b;
                for (let f = 0; f < 6; f++) {
                  const boundary = (f === 0 && y1 === 16) || (f === 1 && y0 === 0) || (f === 2 && x1 === 16) ||
                    (f === 3 && x0 === 0) || (f === 4 && z1 === 16) || (f === 5 && z0 === 0);
                  let sky = S[i], bl = L[i];
                  if (boundary) {
                    const n = FACES[f].n;
                    const nid = blockAt(x + n[0], y + n[1], z + n[2]);
                    if (OPAQUE[nid]) continue;
                    if (nid === id && id === B.bed) continue;
                    sky = skyAt(x + n[0], y + n[1], z + n[2]); bl = blAt(x + n[0], y + n[1], z + n[2]);
                  }
                  const layer = bx.t ? bx.t[f] : faceTexture(id, f, meta);
                  boxFace(b, lx, y, lz, f, x0, y0, z0, x1, y1, z1, layer, 0, tint, sky, bl, FACE_SHADE[f], null, bx.r ? bx.r[f] : 0, bx.uo ? bx.uo[f] : null);
                }
              }
            }
          } else if (rt === RENDER.CROP) {
            const age = meta & 7;
            const layer = id === B.wheat ? TEX.wheat0 + age : (id === B.carrots ? TEX.carrots0 : TEX.potatoes0) + Math.min(3, age >> 1);
            const sky = S[i], bl = L[i];
            const planes = [[4, 0, 4, 16], [12, 0, 12, 16], [0, 4, 16, 4], [0, 12, 16, 12]];
            for (const [ax, az, bx2, bz] of planes) {
              const pts = [[ax, 0, az], [ax, 16, az], [bx2, 16, bz], [bx2, 0, bz]];
              const uvs = [[0, 16], [0, 0], [16, 0], [16, 16]];
              for (const order of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
                for (const k of order) {
                  const p = pts[k];
                  b.push(pack0(lx * 16 + p[0], Math.max(0, y * 16 + p[1] - 1), lz * 16 + p[2]), pack1(uvs[k][0], uvs[k][1], layer, 6, 0), pack2(sky, bl, 0.92), 0xffffff);
                }
              }
            }
            if (y < minY) minY = y;
            if (y + 1 > maxY) maxY = y + 1;
          } else if (rt === RENDER.PORTAL) {
            const axisX = (meta & 1) === 0;
            const bb = axisX ? [0, 0, 6, 16, 16, 10] : [6, 0, 0, 10, 16, 16];
            for (let f = 0; f < 6; f++) {
              const n = FACES[f].n;
              const nid = blockAt(x + n[0], y + n[1], z + n[2]);
              if (nid === id || OPAQUE[nid]) continue;
              if (axisX ? (f === 2 || f === 3) : (f === 4 || f === 5)) { if (nid === B.obsidian) continue; }
              boxFace(b, lx, y, lz, f, bb[0], bb[1], bb[2], bb[3], bb[4], bb[5], TEX.rift, FLAG.ANIM | FLAG.FULLBRIGHT, 0xffffff, 15, 15, 1, null);
            }
          } else if (rt === RENDER.WIRE) {
            const sky = S[i], bl = L[i];
            const tint = WIRE_TINT[meta & 15];
            const con = [0, 0, 0, 0], up = [0, 0, 0, 0];
            const coverAbove = OPAQUE[blockAt(x, y + 1, z)];
            for (let d = 0; d < 4; d++) {
              const nx = x + WIRE_DX[d][0], nz = z + WIRE_DX[d][1];
              const n = blockAt(nx, y, nz);
              if (wireJoins(n, metaAtL(nx, y, nz), d)) con[d] = 1;
              else if (!coverAbove && blockAt(nx, y + 1, nz) === B.spark_wire) { con[d] = 1; up[d] = 1; }
              else if (!OPAQUE[n] && blockAt(nx, y - 1, nz) === B.spark_wire) con[d] = 1;
            }
            const count = con[0] + con[1] + con[2] + con[3];
            const arms = con.slice();
            if (count === 0) arms.fill(1);
            else if (count === 1) for (let d = 0; d < 4; d++) if (con[d]) arms[(d + 2) & 3] = 1;
            const line = TEX.spark_line;
            boxFace(cut, lx, y, lz, 0, 0, 0, 0, 16, 1, 16, TEX.spark_dot, 0, tint, sky, bl, 1, null);
            if (arms[0]) boxFace(cut, lx, y, lz, 0, 0, 0, 0, 16, 1, 8, line, 0, tint, sky, bl, 1, null, 0);
            if (arms[2]) boxFace(cut, lx, y, lz, 0, 0, 0, 8, 16, 1, 16, line, 0, tint, sky, bl, 1, null, 0);
            if (arms[1]) boxFace(cut, lx, y, lz, 0, 8, 0, 0, 16, 1, 16, line, 0, tint, sky, bl, 1, null, 1);
            if (arms[3]) boxFace(cut, lx, y, lz, 0, 0, 0, 0, 8, 1, 16, line, 0, tint, sky, bl, 1, null, 1);
            // climbing the side of the block next to it
            if (up[0]) boxFace(cut, lx, y, lz, 4, 0, 0, 1, 16, 17, 1, line, 0, tint, sky, bl, 0.8, null);
            if (up[2]) boxFace(cut, lx, y, lz, 5, 0, 0, 15, 16, 17, 15, line, 0, tint, sky, bl, 0.8, null);
            if (up[1]) boxFace(cut, lx, y, lz, 3, 15, 0, 0, 15, 17, 16, line, 0, tint, sky, bl, 0.6, null);
            if (up[3]) boxFace(cut, lx, y, lz, 2, 1, 0, 0, 1, 17, 16, line, 0, tint, sky, bl, 0.6, null);
          } else if (rt === RENDER.RAIL) {
            const sky = Math.max(S[i], skyAt(x, y + 1, z)), bl = Math.max(L[i], blAt(x, y + 1, z));
            const plain = id === B.rail;
            const shape = plain ? meta & 15 : meta & 7;
            const on = !plain && (meta & 8);
            let layer = id === B.powered_rail ? (on ? TEX.powered_rail_on : TEX.powered_rail)
              : id === B.detector_rail ? (on ? TEX.detector_rail_on : TEX.detector_rail) : TEX.rail;
            if (shape >= 6 && plain) {
              boxFace(cut, lx, y, lz, 0, 0, 0, 0, 16, 1, 16, TEX.rail_corner, 0, 0xffffff, sky, bl, 1, null, RAIL_CURVE_TURN[shape]);
            } else if (shape <= 1) {
              boxFace(cut, lx, y, lz, 0, 0, 0, 0, 16, 1, 16, layer, 0, 0xffffff, sky, bl, 1, null, shape === 1 ? 1 : 0);
            } else {
              // ascending: 2 east, 3 west, 4 north, 5 south (the high side)
              const hi = { 2: (px) => px[0] === 16, 3: (px) => px[0] === 0, 4: (px) => px[2] === 0, 5: (px) => px[2] === 16 }[shape];
              const base = [[0, 0, 0], [0, 0, 16], [16, 0, 16], [16, 0, 0]];
              const pts = base.map((p) => [p[0], hi(p) ? 17 : 1, p[2]]);
              const ew = shape === 2 || shape === 3;
              const uvs = base.map((p) => (ew ? [16 - p[2], p[0]] : [p[0], p[2]]));
              quad(cut, lx, y, lz, pts, uvs, layer, 0, 0xffffff, sky, bl, 1);
            }
            if (y < minY) minY = y;
            if (y + 2 > maxY) maxY = y + 2;
          } else if (rt === RENDER.FIRE) {
            const planes = [[[2, 0], [2, 16]], [[14, 16], [14, 0]], [[0, 2], [16, 2]], [[16, 14], [0, 14]], [[0, 0], [16, 16]], [[16, 0], [0, 16]]];
            for (const [[ax, az], [bx2, bz]] of planes) {
              const pts = [[ax, 0, az], [ax, 20, az], [bx2, 20, bz], [bx2, 0, bz]];
              const uvs = [[0, 16], [0, 0], [16, 0], [16, 16]];
              quad(cut, lx, y, lz, pts, uvs, TEX.fire, FLAG.ANIM | FLAG.FULLBRIGHT, 0xffffff, 15, 15, 1);
            }
          } else if (rt === RENDER.VOIDGATE) {
            const flags = FLAG.ANIM_SLOW | FLAG.FULLBRIGHT;
            if (id === B.void_gate) {
              if (!OPAQUE[blockAt(x, y + 1, z)]) {
                boxFace(b, lx, y, lz, 0, 0, 0, 0, 16, 12, 16, TEX.void_gate, flags, 0xffffff, 15, 15, 1, null);
                boxFace(b, lx, y, lz, 1, 0, 12, 0, 16, 12, 16, TEX.void_gate, flags, 0xffffff, 15, 15, 1, null);
              }
            } else {
              for (let f = 0; f < 6; f++) {
                const n = FACES[f].n;
                const nid = blockAt(x + n[0], y + n[1], z + n[2]);
                if (nid === id || OPAQUE[nid]) continue;
                boxFace(b, lx, y, lz, f, 0, 0, 0, 16, 16, 16, TEX.void_gate, flags, 0xffffff, 15, 15, 1, null);
              }
            }
          } else if (rt === RENDER.LIQUID) {
            this.liquid(b, id, x, y, z, lx, lz, meta, blockAt, skyAt, blAt, pack0, pack1, pack2, tintFor(id, lx, lz));
            if (y < minY) minY = y;
            if (y + 1 > maxY) maxY = y + 1;
          }
        }
      }
    }

    const out = (bd) => bd.data.slice(0, bd.n);
    return {
      opaque: out(opq), cutout: out(cut), translucent: out(tra),
      light: lightOut, ry, minY: minY === HEIGHT ? 0 : minY, maxY,
    };
  }

  liquid(b, id, x, y, z, lx, lz, meta, blockAt, skyAt, blAt, pack0, pack1, pack2, tint) {
    const M = this.meta;
    const idxOf = (xx, yy, zz) => (yy * RZ + zz) * RX + xx;
    const metaAt = (xx, yy, zz) => (yy < 0 || yy >= this.ry ? 0 : M[idxOf(xx, yy, zz)]);
    const above = blockAt(x, y + 1, z);
    const layer = id === B.water ? TEX.water : TEX.lava;
    const flags = id === B.water ? FLAG.ANIM | FLAG.WATER : FLAG.ANIM_SLOW | FLAG.FULLBRIGHT;
    const levelH = (m) => ((m & 8) ? 14.2 : ((8 - (m & 7)) / 9) * 16);
    const corner = (cx, cz) => {
      let sum = 0, w = 0;
      for (let oz = -1; oz <= 0; oz++) for (let ox = -1; ox <= 0; ox++) {
        const bx = cx + ox, bz = cz + oz;
        if (blockAt(bx, y + 1, bz) === id) return 16;
        const bid = blockAt(bx, y, bz);
        if (bid === id) {
          const m = metaAt(bx, y, bz);
          const h = levelH(m);
          if ((m & 15) === 0) { sum += h * 10; w += 10; } else { sum += h; w += 1; }
        } else if (!SOLID[bid]) { w += 1; }
      }
      return w ? Math.max(1, Math.min(16, Math.round(sum / w))) : 14;
    };
    const full = above === id;
    const underIce = above === B.ice;
    // corner heights at (x,z), (x+1,z), (x+1,z+1), (x,z+1)
    const h00 = full ? 16 : corner(x, z), h10 = full ? 16 : corner(x + 1, z);
    const h11 = full ? 16 : corner(x + 1, z + 1), h01 = full ? 16 : corner(x, z + 1);
    const ownSky = skyAt(x, y, z), ownBl = blAt(x, y, z);
    const lightOf = (xx, yy, zz) => [Math.max(ownSky, skyAt(xx, yy, zz)), Math.max(ownBl, blAt(xx, yy, zz))];
    const X = lx * 16, Y = y * 16, Z = lz * 16;
    const put = (px, py, pz, u, v, f, sky, bl, shade) => {
      b.push(pack0(X + px, Y + py, Z + pz), pack1(u, v, layer, f, flags), pack2(sky, bl, shade), tint);
    };
    if (!full && !underIce) {
      const [sk, bl] = lightOf(x, y + 1, z);
      // top, visible from above and from below the surface
      put(0, h00, 0, 0, 0, 0, sk, bl, 1); put(0, h01, 16, 0, 16, 0, sk, bl, 1);
      put(16, h11, 16, 16, 16, 0, sk, bl, 1); put(16, h10, 0, 16, 0, 0, sk, bl, 1);
      if (id === B.water) {
        put(16, h10, 0, 16, 0, 1, sk, bl, 0.8); put(16, h11, 16, 16, 16, 1, sk, bl, 0.8);
        put(0, h01, 16, 0, 16, 1, sk, bl, 0.8); put(0, h00, 0, 0, 0, 1, sk, bl, 0.8);
      }
    }
    // bottom
    const below = blockAt(x, y - 1, z);
    if (below !== id && !OPAQUE[below] && y > 0) {
      const [sk, bl] = lightOf(x, y - 1, z);
      put(0, 0, 0, 0, 0, 1, sk, bl, 0.5); put(16, 0, 0, 16, 0, 1, sk, bl, 0.5);
      put(16, 0, 16, 16, 16, 1, sk, bl, 0.5); put(0, 0, 16, 0, 16, 1, sk, bl, 0.5);
    }
    // sides: [face, dx, dz, corner heights a,b in CCW order]
    const sides = [
      [2, 1, 0], [3, -1, 0], [4, 0, 1], [5, 0, -1],
    ];
    for (const [f, dx, dz] of sides) {
      const nid = blockAt(x + dx, y, z + dz);
      if (nid === id || OPAQUE[nid]) continue;
      if (id === B.water && nid === B.ice) continue;
      const [sk, bl] = lightOf(x + dx, y, z + dz);
      const shade = FACE_SHADE[f];
      // corners follow FACES[f].c; top corners use the liquid height
      const F = FACES[f];
      for (let k = 0; k < 4; k++) {
        const c = F.c[k];
        const cx = c[0] * 16, cz = c[2] * 16;
        let py = 0;
        if (c[1]) {
          py = cx === 0 && cz === 0 ? h00 : cx === 16 && cz === 0 ? h10 : cx === 16 && cz === 16 ? h11 : h01;
        }
        const [u] = faceUV(f, cx, py, cz);
        put(cx, py, cz, u, 16 - py, f, sk, bl, shade);
      }
    }
  }
}
