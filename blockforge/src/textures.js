// Procedural pixel-art textures. Every texture is painted in code from seeded
// noise and simple shapes; there are no image assets. Pure JS (no DOM) so it
// can also run in Node for previews.
import { TEXTURE_LIST, ALPHA_TEXTURES } from './blocks.js';
import { ITEM_TEXTURES } from './items.js';
import { rng, hashSeed } from './noise.js';

export const TS = 16; // texture size

// ---------------------------------------------------------------------------
class Tex {
  constructor(w = TS, h = TS) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); }
  set(x, y, c, a = 255) {
    x = ((x % this.w) + this.w) % this.w; y = ((y % this.h) + this.h) % this.h;
    const i = (y * this.w + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = c.length > 3 ? c[3] : a;
  }
  // set without wrapping; ignores out of range
  put(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.set(x, y, c, a);
  }
  get(x, y) {
    x = ((x % this.w) + this.w) % this.w; y = ((y % this.h) + this.h) % this.h;
    const i = (y * this.w + x) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]];
  }
  alpha(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.d[(y * this.w + x) * 4 + 3];
  }
  fill(c, a = 255) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c, a); }
  each(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) fn(x, y); }
  rect(x0, y0, w, h, c, a = 255) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.put(x, y, c, a); }
}

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const gray = (v) => [v, v, v];

// Tileable value noise with a period of `p` cells across the texture.
function valueNoise(seed, p) {
  const r = rng(seed);
  const g = new Float32Array(p * p);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x, y) => {
    const fx = (x / TS) * p, fy = (y / TS) * p;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (a, b) => g[(((b % p) + p) % p) * p + (((a % p) + p) % p)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function fbm(seed, ps, weights) {
  const ns = ps.map((p, i) => valueNoise(seed + i * 101, p));
  const tot = weights.reduce((a, b) => a + b, 0);
  return (x, y) => ns.reduce((s, n, i) => s + n(x, y) * weights[i], 0) / tot;
}

// Tileable Voronoi: returns {id, d1, d2, dx, dy} for a pixel.
function voronoi(seed, count) {
  const r = rng(seed);
  const pts = [];
  for (let i = 0; i < count; i++) pts.push([r() * TS, r() * TS, r()]);
  return (x, y) => {
    let d1 = 1e9, d2 = 1e9, id = 0, dx = 0, dy = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const px = pts[i][0] + ox * TS, py = pts[i][1] + oy * TS;
        const ddx = x + 0.5 - px, ddy = y + 0.5 - py;
        const d = Math.hypot(ddx, ddy);
        if (d < d1) { d2 = d1; d1 = d; id = i; dx = ddx; dy = ddy; } else if (d < d2) d2 = d;
      }
    }
    return { id, d1, d2, dx, dy, v: pts[id][2] };
  };
}

// ---------------------------------------------------------------------------
// Block painters. Each receives (t: Tex, r: rng, frame)

function speckle(t, r, base, amt, n) {
  const noise = fbm(Math.floor(r() * 1e9), [4, 8, 16], [0.5, 0.3, 0.2]);
  t.each((x, y) => {
    const v = (noise(x, y) - 0.5) * 2 * amt + (r() - 0.5) * amt * n;
    t.set(x, y, [base[0] + v, base[1] + v * 0.95, base[2] + v * 0.9]);
  });
}

function stone(t, r) {
  const n = fbm(Math.floor(r() * 1e9), [4, 8, 16], [0.45, 0.35, 0.2]);
  t.each((x, y) => {
    let v = 122 + (n(x, y) - 0.5) * 48 + (r() - 0.5) * 10;
    t.set(x, y, gray(v));
  });
  // darker flecks and short cracks
  for (let i = 0; i < 7; i++) {
    let x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    const len = 1 + Math.floor(r() * 3);
    for (let k = 0; k < len; k++) { const c = t.get(x, y); t.set(x, y, mul(c, 0.8)); x += r() < 0.5 ? 1 : 0; y += r() < 0.5 ? 0 : 1; }
  }
  for (let i = 0; i < 5; i++) { const x = Math.floor(r() * 16), y = Math.floor(r() * 16); t.set(x, y, mul(t.get(x, y), 1.15)); }
}

function cobble(t, r, base = [128, 128, 128], mortar = [62, 62, 62], cells = 11) {
  const vor = voronoi(Math.floor(r() * 1e9), cells);
  const n = valueNoise(Math.floor(r() * 1e9), 16);
  t.each((x, y) => {
    const c = vor(x, y);
    if (c.d2 - c.d1 < 1.15) { t.set(x, y, mix(mortar, base, n(x, y) * 0.3)); return; }
    let v = 0.72 + c.v * 0.42 + (n(x, y) - 0.5) * 0.15;
    // light from the top-left
    v += (-c.dx - c.dy) * 0.035;
    t.set(x, y, mul(base, v));
  });
}

function bricks(t, r, brick, mortar, rows = 4, bw = 8) {
  const n = valueNoise(Math.floor(r() * 1e9), 16);
  const rh = TS / rows;
  const shades = [];
  for (let i = 0; i < 32; i++) shades.push(0.85 + r() * 0.3);
  t.each((x, y) => {
    const row = Math.floor(y / rh);
    const off = row % 2 ? bw / 2 : 0;
    const bx = (x + off) % TS;
    const col = Math.floor(bx / bw);
    const ly = y % rh, lx = bx % bw;
    if (ly === rh - 1 || lx === bw - 1) { t.set(x, y, mix(mortar, [0, 0, 0], n(x, y) * 0.15)); return; }
    let v = shades[row * 4 + col] + (n(x, y) - 0.5) * 0.18;
    if (ly === 0 || lx === 0) v *= 1.12;
    if (ly === rh - 2 || lx === bw - 2) v *= 0.9;
    t.set(x, y, mul(brick, v));
  });
}

function dirt(t, r) {
  const n = fbm(Math.floor(r() * 1e9), [4, 8, 16], [0.4, 0.35, 0.25]);
  t.each((x, y) => {
    const v = 0.82 + n(x, y) * 0.38 + (r() - 0.5) * 0.08;
    t.set(x, y, mul([122, 86, 58], v));
  });
  for (let i = 0; i < 10; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    t.set(x, y, r() < 0.5 ? [88, 62, 42] : [150, 112, 80]);
  }
  for (let i = 0; i < 3; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    t.set(x, y, [132, 124, 116]);
  }
}

// grass top is painted in grayscale; alpha 0 marks it for biome tinting
function grassTop(t, r) {
  const n = fbm(Math.floor(r() * 1e9), [4, 8, 16], [0.3, 0.3, 0.4]);
  t.each((x, y) => {
    const v = 150 + n(x, y) * 70 + (r() - 0.5) * 30;
    t.set(x, y, gray(v), 0);
  });
  // short blade strokes
  for (let i = 0; i < 18; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    t.set(x, y, gray(r() < 0.5 ? 120 : 225), 0);
    t.set(x, y + 1, gray(r() < 0.5 ? 140 : 205), 0);
  }
}

function grassSide(t, r, snowy) {
  dirt(t, r);
  const n = valueNoise(Math.floor(r() * 1e9), 8);
  for (let x = 0; x < 16; x++) {
    let d = 3 + Math.floor(n(x, 0) * 2.2);
    if (r() < 0.2) d += 1;
    if (r() < 0.12) d += 2;
    for (let y = 0; y < d; y++) {
      if (snowy) {
        const v = 232 + (r() - 0.5) * 20 - (y === d - 1 ? 18 : 0);
        t.set(x, y, [v, v + 4, v + 10]);
      } else {
        const v = 170 + (r() - 0.5) * 50 - (y === d - 1 ? 25 : 0);
        t.set(x, y, gray(v), 0);
      }
    }
  }
}

function sandLike(t, r, base, amt = 16) {
  const n = fbm(Math.floor(r() * 1e9), [8, 16], [0.5, 0.5]);
  t.each((x, y) => {
    const v = 1 + (n(x, y) - 0.5) * amt / 100 * 2 + (r() - 0.5) * 0.07;
    t.set(x, y, mul(base, v));
  });
  for (let i = 0; i < 8; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    t.set(x, y, mul(base, r() < 0.5 ? 0.86 : 1.08));
  }
}

function sandstoneSide(t, r) {
  sandLike(t, r, [216, 202, 150], 8);
  const bands = [[0, 1.08], [1, 1.04], [2, 0.93], [3, 1.0], [6, 0.95], [9, 1.0], [11, 0.94], [12, 0.97], [14, 0.9], [15, 0.84]];
  for (const [y, f] of bands) for (let x = 0; x < 16; x++) t.set(x, y, mul(t.get(x, y), f));
  for (let x = 0; x < 16; x++) if (r() < 0.3) t.set(x, 4 + Math.floor(r() * 8), mul(t.get(x, 7), 0.92));
}

function gravel(t, r) {
  const vor = voronoi(Math.floor(r() * 1e9), 22);
  const cols = [[120, 116, 112], [98, 94, 92], [140, 132, 128], [110, 100, 92], [84, 80, 80], [150, 146, 140]];
  t.each((x, y) => {
    const c = vor(x, y);
    const base = cols[Math.floor(c.v * cols.length)];
    let v = 1 - c.d1 * 0.06 + (-c.dx - c.dy) * 0.03;
    if (c.d2 - c.d1 < 0.8) v *= 0.7;
    t.set(x, y, mul(base, v));
  });
}

function bedrock(t, r) {
  const vor = voronoi(Math.floor(r() * 1e9), 14);
  t.each((x, y) => {
    const c = vor(x, y);
    const v = c.v < 0.3 ? 40 : c.v < 0.6 ? 80 : c.v < 0.85 ? 110 : 150;
    t.set(x, y, gray(v * (1 - c.d1 * 0.04) + (r() - 0.5) * 12));
  });
}

function logSide(t, r, base, crack, light) {
  const n = valueNoise(Math.floor(r() * 1e9), 16);
  const colShade = [];
  for (let x = 0; x < 16; x++) colShade.push(0.85 + r() * 0.3);
  t.each((x, y) => {
    let v = colShade[x] * (0.9 + n(x, y * 0.25) * 0.2);
    t.set(x, y, mul(base, v));
  });
  // vertical fissures
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(r() * 16);
    let y = Math.floor(r() * 16);
    const len = 3 + Math.floor(r() * 8);
    for (let k = 0; k < len; k++) t.set(x, y + k, crack);
  }
  if (light) for (let i = 0; i < 10; i++) t.set(Math.floor(r() * 16), Math.floor(r() * 16), light);
}

function birchSide(t, r) {
  const n = valueNoise(Math.floor(r() * 1e9), 8);
  t.each((x, y) => {
    const v = 206 + n(x, y) * 30 + (r() - 0.5) * 8;
    t.set(x, y, [v, v - 2, v - 8]);
  });
  // dark horizontal marks
  for (let i = 0; i < 9; i++) {
    const y = Math.floor(r() * 16), x = Math.floor(r() * 16), len = 2 + Math.floor(r() * 4);
    for (let k = 0; k < len; k++) t.set(x + k, y, k === 0 || k === len - 1 ? [70, 66, 60] : [40, 38, 36]);
    if (r() < 0.4) t.set(x + 1, y + 1, [80, 76, 70]);
  }
}

function logTop(t, r, wood, bark) {
  const n = valueNoise(Math.floor(r() * 1e9), 8);
  t.each((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) { t.set(x, y, mul(bark, 0.9 + r() * 0.2)); return; }
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) + Math.hypot(x - 7.5, y - 7.5) * 0.35 + n(x, y) * 0.8;
    const ring = Math.floor(d) % 3 === 0;
    t.set(x, y, mul(wood, (ring ? 0.82 : 1.0) + (r() - 0.5) * 0.06));
  });
}

function planks(t, r, base) {
  const n = valueNoise(Math.floor(r() * 1e9), 16);
  const boardShade = [0.95 + r() * 0.1, 0.92 + r() * 0.1, 0.95 + r() * 0.1, 0.9 + r() * 0.1];
  const seams = [Math.floor(r() * 16), Math.floor(r() * 16), Math.floor(r() * 16), Math.floor(r() * 16)];
  t.each((x, y) => {
    const b = y >> 2, ly = y & 3;
    let v = boardShade[b] * (0.93 + n(x * 0.3, y * 2) * 0.14);
    if (ly === 3) v *= 0.68;
    else if (ly === 0) v *= 1.06;
    if (x === seams[b]) v *= 0.72;
    t.set(x, y, mul(base, v + (r() - 0.5) * 0.03));
  });
  // grain streaks
  for (let i = 0; i < 8; i++) {
    const y = Math.floor(r() * 16);
    if ((y & 3) === 3) continue;
    const x = Math.floor(r() * 16), len = 2 + Math.floor(r() * 5);
    for (let k = 0; k < len; k++) t.set(x + k, y, mul(t.get(x + k, y), 0.9));
  }
}

function leaves(t, r, holeP, style) {
  const n = valueNoise(Math.floor(r() * 1e9), 8);
  t.each((x, y) => {
    const v = 105 + n(x, y) * 110 + (r() - 0.5) * 40;
    let hole = r() < holeP * (0.6 + n(x + 3, y + 7) * 0.8);
    if (style === 'spruce') hole = ((x + y * 2) % 4 === 0 && r() < 0.6) || r() < holeP * 0.5;
    if (hole) t.set(x, y, [0, 0, 0], 0);
    else t.set(x, y, gray(v));
  });
  // darker leaf clusters
  for (let i = 0; i < 14; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    if (t.alpha(x, y)) t.set(x, y, gray(80));
  }
}

function glass(t, r) {
  t.fill([0, 0, 0], 0);
  const frame = [214, 232, 238];
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, frame); t.set(i, 15, [170, 196, 206]); t.set(0, i, frame); t.set(15, i, [170, 196, 206]);
  }
  // glints
  const g = [236, 246, 250];
  for (const [x, y] of [[3, 2], [2, 3], [4, 2], [2, 4], [11, 12], [12, 11], [12, 12]]) t.set(x, y, g);
  if (r() < 2) t.set(5, 5, g);
}

function ore(t, r, color, hi, lo, clusters = 5) {
  stone(t, r);
  for (let i = 0; i < clusters; i++) {
    const cx = 1 + Math.floor(r() * 13), cy = 1 + Math.floor(r() * 13);
    const pts = [[0, 0]];
    const n = 3 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const [px, py] = pts[Math.floor(r() * pts.length)];
      const d = [[1, 0], [0, 1], [-1, 0], [0, -1]][Math.floor(r() * 4)];
      pts.push([px + d[0], py + d[1]]);
    }
    for (const [px, py] of pts) t.set(cx + px, cy + py, color);
    for (const [px, py] of pts) {
      // darker rim where the ore meets stone
      for (const [ox, oy] of [[1, 0], [0, 1]]) {
        if (!pts.some(([qx, qy]) => qx === px + ox && qy === py + oy)) t.set(cx + px + ox, cy + py + oy, mul(t.get(cx + px + ox, cy + py + oy), 0.78));
      }
    }
    for (const [px, py] of pts) {
      if (!pts.some(([qx, qy]) => qx === px && qy === py - 1)) t.set(cx + px, cy + py, hi);
      else if (!pts.some(([qx, qy]) => qx === px + 1 && qy === py)) t.set(cx + px, cy + py, lo);
    }
  }
}

function cactusSide(t, r) {
  t.each((x, y) => {
    let v = 0.9 + (r() - 0.5) * 0.08;
    if (x % 4 === 0) v *= 0.75;
    if (x % 4 === 2) v *= 1.1;
    if (x === 0 || x === 15) v *= 0.8;
    t.set(x, y, mul([76, 136, 52], v));
  });
  for (let y = 1; y < 16; y += 4) for (let x = 2; x < 16; x += 4) {
    const yy = (y + (x >> 2) * 2) % 16;
    t.set(x, yy, [226, 222, 168]);
  }
}

function cactusTop(t, r, dim) {
  t.each((x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    let v = d > 6.5 ? 0.78 : Math.floor(d) % 2 ? 0.95 : 1.05;
    t.set(x, y, mul([86, 146, 58], v * (dim ? 0.8 : 1) + (r() - 0.5) * 0.06));
  });
  t.set(7, 7, [200, 210, 140]); t.set(8, 8, [200, 210, 140]);
}

// Plants: drawn onto transparent background
function blade(t, x, yTop, lean, shadeFn, r) {
  let fx = x;
  for (let y = 15; y >= yTop; y--) {
    t.put(Math.round(fx), y, shadeFn(y));
    fx += lean * (1 - (y - yTop) / 16) * 0.35;
  }
}

function tallGrass(t, r) {
  t.fill([0, 0, 0], 0);
  const blades = 9;
  for (let i = 0; i < blades; i++) {
    const x = 1 + Math.floor(r() * 14);
    const top = 2 + Math.floor(r() * 9);
    const lean = (r() - 0.5) * 2.2;
    blade(t, x, top, lean, (y) => gray(120 + ((15 - y) / 13) * 110 + (r() - 0.5) * 16), r);
  }
}

function fern(t, r) {
  t.fill([0, 0, 0], 0);
  for (const [sx, lean] of [[4, -1], [8, 0.3], [11, 1]]) {
    let fx = sx;
    for (let y = 15; y >= 3; y--) {
      const x = Math.round(fx);
      t.put(x, y, gray(150 + (15 - y) * 5));
      if (y % 2 === 0 && y < 14) {
        t.put(x - 1, y, gray(130 + (15 - y) * 6));
        t.put(x + 1, y, gray(130 + (15 - y) * 6));
        if (y < 12) { t.put(x - 2, y - 1, gray(170)); t.put(x + 2, y - 1, gray(170)); }
      }
      fx += lean * 0.18;
    }
  }
}

function flower(t, r, petal, center, petalDark) {
  t.fill([0, 0, 0], 0);
  const stem = [70, 130, 45];
  for (let y = 8; y < 16; y++) t.put(7 + (y > 12 ? 1 : 0), y, mul(stem, 0.9 + (y % 2) * 0.12));
  t.put(6, 12, [84, 150, 56]); t.put(5, 11, [84, 150, 56]); t.put(9, 13, [84, 150, 56]); t.put(10, 12, [84, 150, 56]);
  const cx = 7, cy = 5;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1], [1, -1], [-1, 1]]) {
    const edge = Math.abs(dx) + Math.abs(dy) === 2 && dx && dy;
    t.put(cx + dx, cy + dy, edge ? petalDark : petal);
  }
  t.put(cx, cy, center);
  t.put(cx + 1, cy - 2, mul(petal, 1.1));
}

function deadBush(t, r) {
  t.fill([0, 0, 0], 0);
  const c = [118, 84, 44];
  const branch = (x, y, dx, len) => {
    for (let i = 0; i < len; i++) { t.put(Math.round(x), y, mul(c, 0.85 + r() * 0.3)); x += dx; y--; if (y < 2) break; }
  };
  branch(8, 15, 0, 4);
  branch(8, 12, -0.8, 7); branch(8, 12, 0.7, 7); branch(8, 11, -0.2, 8); branch(6, 9, -0.9, 4); branch(10, 9, 1, 4);
}

function sugarCane(t, r) {
  t.fill([0, 0, 0], 0);
  for (const sx of [3, 8, 12]) {
    for (let y = 0; y < 16; y++) {
      const joint = (y + sx) % 5 === 0;
      const base = joint ? [150, 190, 110] : [120, 176, 88];
      t.put(sx, y, mul(base, 1.08)); t.put(sx + 1, y, mul(base, 0.85));
    }
    t.put(sx - 1, (sx * 3) % 16, [100, 160, 70]);
    t.put(sx + 2, (sx * 5 + 6) % 16, [100, 160, 70]);
  }
}

function ice(t, r) {
  const n = valueNoise(Math.floor(r() * 1e9), 8);
  t.each((x, y) => {
    const v = 0.92 + n(x, y) * 0.12;
    t.set(x, y, mul([150, 186, 250], v), 175);
  });
  for (let i = 0; i < 4; i++) {
    let x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    for (let k = 0; k < 5; k++) { t.set(x, y, [214, 232, 255], 200); x += r() < 0.5 ? 1 : -1; y += 1; }
  }
}

function obsidian(t, r) {
  const n = fbm(Math.floor(r() * 1e9), [4, 8], [0.6, 0.4]);
  t.each((x, y) => {
    const v = n(x, y);
    t.set(x, y, v > 0.72 ? [70, 48, 104] : v > 0.6 ? [42, 30, 64] : mix([14, 10, 22], [26, 18, 40], r()));
  });
}

function bookshelf(t, r) {
  planks(t, r, [162, 130, 78]);
  const colors = [[150, 40, 36], [44, 70, 140], [48, 120, 60], [120, 90, 50], [170, 140, 60], [90, 50, 110], [40, 40, 44]];
  for (const shelfY of [1, 9]) {
    for (let y = shelfY; y < shelfY + 6; y++) for (let x = 1; x < 15; x++) t.set(x, y, [42, 30, 20]);
    let x = 1;
    while (x < 15) {
      const w = 1 + (r() < 0.6 ? 1 : 0);
      const h = 4 + Math.floor(r() * 3);
      const c = colors[Math.floor(r() * colors.length)];
      for (let xx = x; xx < Math.min(15, x + w); xx++) for (let y = shelfY + 6 - h; y < shelfY + 6; y++) {
        t.set(xx, y, mul(c, xx === x ? 1.1 : 0.85));
      }
      if (h > 4) t.set(x, shelfY + 6 - h + 1, mul(c, 1.4));
      x += w + (r() < 0.15 ? 1 : 0);
    }
  }
}

function craftTop(t, r) {
  planks(t, r, [170, 136, 84]);
  const dark = [92, 66, 40];
  for (let i = 0; i < 16; i++) { t.set(i, 0, dark); t.set(i, 15, dark); t.set(0, i, dark); t.set(15, i, dark); }
  for (let i = 2; i < 14; i++) { t.set(i, 5, mul(dark, 1.2)); t.set(i, 10, mul(dark, 1.2)); t.set(5, i, mul(dark, 1.2)); t.set(10, i, mul(dark, 1.2)); }
  for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) t.set(x, y, [150, 150, 156]);
}

function craftSide(t, r, front) {
  planks(t, r, [150, 116, 70]);
  const dark = [80, 58, 34];
  for (let i = 0; i < 16; i++) { t.set(i, 0, [170, 136, 84]); t.set(i, 1, [120, 92, 56]); }
  const metal = [168, 168, 176], metalD = [110, 110, 120], wood = [110, 76, 40];
  if (!front) {
    // hammer
    for (let y = 5; y < 14; y++) t.set(4, y, wood);
    for (let x = 2; x < 7; x++) { t.set(x, 4, metal); t.set(x, 5, metalD); }
    // saw
    for (let x = 8; x < 14; x++) { t.set(x, 6, metal); t.set(x, 7, metal); if (x % 2) t.set(x, 8, metalD); }
    t.set(14, 6, wood); t.set(14, 7, wood); t.set(15, 6, wood); t.set(15, 7, wood);
  } else {
    // square and chisel
    for (let y = 4; y < 13; y++) t.set(3, y, metal);
    for (let x = 3; x < 9; x++) t.set(x, 12, metal);
    for (let y = 4; y < 10; y++) t.set(11, y, wood);
    for (let y = 10; y < 13; y++) t.set(11, y, metalD);
    t.set(11, 13, metal);
  }
  for (let i = 2; i < 16; i++) t.set(i, 15, dark);
}

function furnaceSide(t, r) {
  stone(t, r);
  t.each((x, y) => t.set(x, y, mul(t.get(x, y), 0.95)));
  for (let i = 0; i < 16; i++) { t.set(i, 0, gray(150)); t.set(i, 15, gray(78)); t.set(0, i, gray(140)); t.set(15, i, gray(84)); }
}

function furnaceFront(t, r, lit) {
  furnaceSide(t, r);
  for (let y = 7; y < 14; y++) for (let x = 3; x < 13; x++) {
    let c = [26, 24, 24];
    if (lit) {
      const h = (y - 7) / 6;
      c = mix([255, 220, 90], [220, 70, 20], 1 - h);
      if ((x + y) % 3 === 0) c = mix(c, [255, 250, 200], 0.4);
    }
    t.set(x, y, c);
  }
  for (let x = 3; x < 13; x++) { t.set(x, 6, gray(96)); t.set(x, 14, gray(170)); }
  for (let y = 7; y < 14; y++) { t.set(2, y, gray(96)); t.set(13, y, gray(170)); }
  // grate
  for (let x = 4; x < 12; x += 2) t.set(x, 10, lit ? [255, 240, 170] : gray(60));
  for (let x = 4; x < 12; x++) t.set(x, 3, gray(90));
}

function chest(t, r, part) {
  planks(t, r, [160, 112, 50]);
  const dark = [70, 46, 20];
  for (let i = 0; i < 16; i++) { t.set(i, 0, dark); t.set(i, 15, dark); t.set(0, i, dark); t.set(15, i, dark); }
  if (part !== 'top') {
    for (let x = 0; x < 16; x++) { t.set(x, 5, dark); t.set(x, 6, mul(dark, 1.4)); }
  }
  if (part === 'front') {
    const gold = [230, 190, 60], goldD = [150, 110, 30];
    t.rect(7, 4, 2, 4, gold);
    t.set(8, 7, goldD); t.set(7, 7, goldD);
    t.set(7, 5, [40, 30, 20]);
  }
}

function torch(t) {
  t.fill([0, 0, 0], 0);
  for (let y = 8; y < 16; y++) { t.set(7, y, [150, 110, 60]); t.set(8, y, [110, 78, 40]); }
  t.set(7, 6, [255, 244, 170]); t.set(8, 6, [255, 210, 90]);
  t.set(7, 7, [255, 190, 60]); t.set(8, 7, [236, 140, 40]);
}

function torchTop(t) {
  t.each((x, y) => t.set(x, y, (x + y) % 2 ? [255, 222, 110] : [255, 244, 170]));
}

function lamp(t, r) {
  t.each((x, y) => {
    const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
    let c = mix([255, 236, 160], [214, 130, 40], Math.min(1, d / 11));
    if (Math.floor(d) % 4 === 0) c = mix(c, [255, 255, 220], 0.5);
    c = mul(c, 0.94 + r() * 0.1);
    t.set(x, y, c);
  });
  for (let i = 0; i < 16; i++) { t.set(i, 0, [150, 90, 30]); t.set(0, i, [150, 90, 30]); t.set(i, 15, [120, 70, 24]); t.set(15, i, [120, 70, 24]); }
}

function wool(t, r, base) {
  const n = valueNoise(Math.floor(r() * 1e9), 8);
  t.each((x, y) => {
    let v = 0.9 + n(x, y) * 0.15;
    if ((x + y * 3) % 7 === 0) v *= 0.9;
    if ((x * 2 + y) % 9 === 0) v *= 1.06;
    t.set(x, y, mul(base, v + (r() - 0.5) * 0.04));
  });
}

function metalBlock(t, r, base) {
  t.each((x, y) => {
    let v = 1 + (r() - 0.5) * 0.04;
    if ((x + y) % 6 === 0 && x > 1 && y > 1 && x < 14 && y < 14) v *= 1.07;
    if (x === 0 || y === 0) v *= 1.25;
    else if (x === 15 || y === 15) v *= 0.72;
    else if (x === 1 || y === 1) v *= 1.1;
    else if (x === 14 || y === 14) v *= 0.86;
    t.set(x, y, mul(base, v));
  });
}

function gourdSide(t, r, base, stripe) {
  t.each((x, y) => {
    let v = 1 + (r() - 0.5) * 0.08;
    const s = x % 4;
    if (s === 0) v *= 0.78;
    t.set(x, y, mul(s === 0 ? stripe : base, v));
  });
  for (let x = 0; x < 16; x++) { t.set(x, 0, mul(t.get(x, 0), 0.85)); t.set(x, 15, mul(t.get(x, 15), 0.8)); }
}

function gourdTop(t, r, base, stripe) {
  t.each((x, y) => {
    const a = Math.atan2(y - 7.5, x - 7.5);
    const rib = Math.abs(Math.sin(a * 4)) < 0.25;
    t.set(x, y, mul(rib ? stripe : base, 0.95 + r() * 0.08));
  });
  t.rect(7, 7, 2, 2, [96, 80, 36]);
}

function sapling(t, r, kind) {
  t.fill([0, 0, 0], 0);
  const stem = kind === 'birch' ? [220, 216, 206] : [110, 80, 44];
  for (let y = 9; y < 16; y++) t.put(7, y, stem);
  const leaf = kind === 'birch' ? [130, 170, 80] : kind === 'spruce' ? [60, 110, 70] : [70, 140, 40];
  if (kind === 'spruce') {
    for (let y = 1; y < 12; y++) {
      const w = Math.floor((y - 1) / 2.4);
      for (let x = 7 - w; x <= 7 + w; x++) if ((x + y) % 3 || x === 7) t.put(x, y, mul(leaf, 0.85 + r() * 0.3));
    }
  } else {
    for (let y = 1; y < 11; y++) for (let x = 2; x < 13; x++) {
      const d = Math.hypot(x - 7, (y - 5.5) * 1.1);
      if (d < 5 - r() * 1.2) t.put(x, y, mul(leaf, 0.8 + r() * 0.4));
    }
  }
}

function ladder(t) {
  t.fill([0, 0, 0], 0);
  const rail = [132, 96, 52], railD = [96, 68, 36];
  for (let y = 0; y < 16; y++) { t.set(2, y, rail); t.set(3, y, railD); t.set(12, y, rail); t.set(13, y, railD); }
  for (const y of [2, 6, 10, 14]) for (let x = 4; x < 12; x++) { t.set(x, y, [150, 112, 64]); t.set(x, y + 1, railD); }
}

function mushroom(t, r, red) {
  t.fill([0, 0, 0], 0);
  const stem = [222, 214, 196];
  for (let y = 9; y < 15; y++) { t.set(7, y, stem); t.set(8, y, mul(stem, 0.85)); }
  const cap = red ? [200, 36, 30] : [150, 106, 74];
  for (let y = 5; y < 10; y++) for (let x = 3; x < 13; x++) {
    const d = Math.hypot((x - 7.5) / 5, (y - 9.2) / 4);
    if (d < 1) t.set(x, y, mul(cap, 0.85 + (9 - y) * 0.06));
  }
  if (red) for (const [x, y] of [[5, 7], [9, 6], [10, 8], [7, 8]]) t.set(x, y, [245, 240, 232]);
}

function blastCrate(t, r, part) {
  planks(t, r, [180, 52, 40]);
  const band = [230, 200, 90];
  if (part === 'side') {
    for (let y = 5; y < 11; y++) for (let x = 0; x < 16; x++) t.set(x, y, ((x + y) >> 1) % 2 ? [36, 30, 28] : band);
    for (let x = 0; x < 16; x++) { t.set(x, 4, [110, 30, 24]); t.set(x, 11, [110, 30, 24]); }
  } else if (part === 'top') {
    for (let i = 0; i < 16; i++) { t.set(i, 0, [110, 30, 24]); t.set(0, i, [110, 30, 24]); t.set(15, i, [110, 30, 24]); t.set(i, 15, [110, 30, 24]); }
    t.rect(6, 6, 4, 4, band); t.rect(7, 7, 2, 2, [60, 50, 40]);
    t.set(8, 5, [200, 200, 200]); t.set(9, 4, [220, 220, 220]);
  } else {
    t.each((x, y) => t.set(x, y, mul(t.get(x, y), 0.7)));
  }
}

// Crack stages share one set of fracture lines, revealed progressively.
let crackLines = null;
function crack(t, stage) {
  if (!crackLines) {
    const r = rng(9001);
    crackLines = [];
    for (let i = 0; i < 26; i++) {
      const line = [];
      let x = 8 + (r() - 0.5) * (i < 6 ? 4 : 14), y = 8 + (r() - 0.5) * (i < 6 ? 4 : 14);
      let a = r() * Math.PI * 2;
      const len = 3 + Math.floor(r() * 5);
      for (let k = 0; k < len; k++) {
        line.push([Math.floor(x), Math.floor(y)]);
        a += (r() - 0.5) * 1.2; x += Math.cos(a); y += Math.sin(a);
      }
      crackLines.push(line);
    }
  }
  t.fill(gray(128));
  const n = Math.round(((stage + 1) / 10) * crackLines.length);
  for (let i = 0; i < n; i++) for (const [x, y] of crackLines[i]) {
    t.set(x, y, gray(38));
    t.set(x + 1, y, t.get(x + 1, y)[0] === 128 ? gray(160) : t.get(x + 1, y));
  }
}

function particle(t, name, r) {
  t.fill([0, 0, 0], 0);
  const disc = (cx, cy, rad, c, a = 255) => t.each((x, y) => { if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rad) t.set(x, y, c, a); });
  switch (name) {
    case 'p_flame':
      t.each((x, y) => {
        const dx = (x + 0.5 - 8) / 5, dy = (y + 0.5 - 10) / 6;
        const d = dx * dx + dy * dy * (y < 10 ? 0.6 : 1.4);
        if (d < 1) t.set(x, y, mix([255, 250, 200], [255, 120, 20], Math.min(1, d * 1.3)));
      });
      break;
    case 'p_smoke0': case 'p_smoke1': case 'p_smoke2': case 'p_smoke3': {
      const k = +name.slice(-1);
      t.each((x, y) => {
        const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
        if (d < 7 - k * 1.4 && r() > 0.12) t.set(x, y, gray(200 - d * 8 + (r() - 0.5) * 30));
      });
      break;
    }
    case 'p_bubble':
      disc(8, 8, 6, [200, 230, 255]); disc(8, 8, 4.6, [0, 0, 0], 0); t.set(5, 5, [255, 255, 255]); t.set(6, 5, [255, 255, 255]);
      break;
    case 'p_splash': disc(8, 9, 5, [120, 170, 255]); disc(7, 7, 2, [210, 230, 255]); break;
    case 'p_rain': for (let y = 0; y < 16; y++) { t.set(7, y, [170, 200, 255], 200); t.set(8, y, [140, 170, 240], 160); } break;
    case 'p_snow': disc(8, 8, 5, [250, 252, 255]); t.set(6, 6, [255, 255, 255]); break;
    case 'p_spark': disc(8, 8, 3, [255, 255, 230]); for (let i = 1; i < 7; i++) { t.set(8, 8 + i, [255, 230, 150]); t.set(8, 8 - i, [255, 230, 150]); t.set(8 + i, 8, [255, 230, 150]); t.set(8 - i, 8, [255, 230, 150]); } break;
    case 'p_portal': disc(8, 8, 4, [90, 110, 240]); disc(8, 8, 2, [190, 245, 255]); break;
    case 'p_xp': disc(8, 8, 5, [150, 230, 40]); disc(7, 7, 3, [220, 255, 120]); t.set(6, 6, [255, 255, 220]); break;
    case 'p_heart': for (const [x, y] of [[4, 5], [5, 4], [6, 4], [7, 5], [8, 5], [9, 4], [10, 4], [11, 5], [4, 6], [11, 6], [5, 8], [10, 8], [6, 9], [9, 9], [7, 10], [8, 10]]) t.set(x, y, [220, 40, 50]); for (let y = 5; y < 10; y++) for (let x = 5; x < 11; x++) if (!(y >= 8 && (x < 6 + y - 8 || x > 9 - (y - 8)))) t.set(x, y, [240, 70, 80]); break;
    case 'p_glyph': for (let i = 0; i < 9; i++) { const x = 4 + Math.floor(r() * 8), y = 3 + Math.floor(r() * 10); t.set(x, y, [230, 230, 255]); t.set(x + (r() < 0.5 ? 1 : 0), y + 1, [200, 200, 255]); } break;
    case 'p_effect': disc(8, 8, 3.5, [255, 255, 255]); t.set(8, 3, [255, 255, 255]); t.set(8, 12, [255, 255, 255]); t.set(3, 8, [255, 255, 255]); t.set(12, 8, [255, 255, 255]); break;
    case 'p_note': for (let y = 3; y < 11; y++) { t.set(9, y, [255, 255, 255]); t.set(10, y, [235, 235, 235]); } disc(7, 11, 2.6, [255, 255, 255]); t.set(11, 3, [255, 255, 255]); t.set(12, 4, [255, 255, 255]); break;
    case 'p_spark_dust': disc(8, 8, 2.5, [255, 60, 40]); t.set(7, 7, [255, 160, 140]); break;
    case 'p_void': disc(8, 8, 2, [230, 200, 255]); for (let i = 1; i < 5; i++) { t.set(8, 8 + i, [170, 120, 240]); t.set(8, 8 - i, [170, 120, 240]); t.set(8 + i, 8, [170, 120, 240]); t.set(8 - i, 8, [170, 120, 240]); } break;
    case 'p_fish': disc(8, 8, 3, [200, 230, 255]); t.set(7, 7, [255, 255, 255]); break;
    case 'p_crit': for (let i = 2; i < 14; i++) { t.set(i, 8, [255, 255, 200]); t.set(8, i, [255, 255, 200]); } t.set(6, 6, [255, 240, 180]); t.set(10, 10, [255, 240, 180]); t.set(6, 10, [255, 240, 180]); t.set(10, 6, [255, 240, 180]); break;
    case 'p_explosion':
      t.each((x, y) => { const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8); if (d < 7.5 && r() > 0.1) t.set(x, y, gray(255 - d * 14 - r() * 30)); });
      break;
    default: break;
  }
}

function water(t, frame) {
  const P = Math.PI * 2, f = frame / 16;
  t.each((x, y) => {
    const u = x / 16, v = y / 16;
    let w = Math.sin(P * (u * 2 + f)) * 0.35 + Math.sin(P * (v * 3 - f * 2 + u)) * 0.3 +
      Math.sin(P * (u * 1 + v * 2 + f * 3)) * 0.25 + Math.sin(P * (u * 4 - v + f)) * 0.1;
    w = w * 0.5 + 0.5;
    const c = mix([184, 200, 230], [206, 222, 246], Math.pow(w, 1.5));
    t.set(x, y, c, 176 + w * 12);
  });
}

function lava(t, frame) {
  const P = Math.PI * 2, f = frame / 16;
  t.each((x, y) => {
    const u = x / 16, v = y / 16;
    let w = Math.sin(P * (u * 2 + f)) * Math.cos(P * (v * 2 - f)) * 0.5 +
      Math.sin(P * (u * 3 + v * 1 + f * 2)) * 0.3 + Math.sin(P * (v * 4 + f)) * 0.2;
    w = w * 0.5 + 0.5;
    let c = mix([190, 40, 10], [255, 150, 30], w);
    if (w > 0.78) c = mix(c, [255, 236, 130], (w - 0.78) * 4);
    if (w < 0.22) c = mix(c, [120, 20, 8], (0.22 - w) * 3);
    t.set(x, y, c);
  });
}


// ---------------------------------------------------------------------------
// Farming, furniture, underworld and other added blocks

function pathTop(t, r) {
  sandLike(t, r, [150, 120, 74], 12);
  for (let i = 0; i < 10; i++) { const x = Math.floor(r() * 16), y = Math.floor(r() * 16); t.set(x, y, mul(t.get(x, y), r() < 0.5 ? 0.85 : 1.1)); }
}

function pathSide(t, r) {
  dirt(t, r);
  for (let x = 0; x < 16; x++) for (let y = 1; y < 3 + (r() < 0.3 ? 1 : 0); y++) t.set(x, y, mul([150, 120, 74], 0.9 + r() * 0.15));
}

function farmland(t, r, wet) {
  const base = wet ? [74, 48, 30] : [110, 76, 50];
  t.each((x, y) => {
    let v = 0.9 + (r() - 0.5) * 0.12;
    if (y % 4 === 0) v *= 0.75;
    if (y % 4 === 1) v *= 1.1;
    if (x === 0 || x === 15) v *= 0.85;
    t.set(x, y, mul(base, v));
  });
}

function wheat(t, r, stage) {
  t.fill([0, 0, 0], 0);
  const h = 3 + Math.round(stage * 1.6);
  const ripe = stage / 7;
  const stalk = mix([70, 150, 40], [200, 170, 60], ripe);
  const head = mix([110, 170, 60], [230, 200, 90], ripe);
  for (const sx of [2, 5, 8, 11, 14]) {
    const lean = (r() - 0.5) * 1.2;
    let fx = sx;
    const top = 16 - h - Math.floor(r() * 2);
    for (let y = 15; y >= top; y--) { t.put(Math.round(fx), y, mul(stalk, 0.85 + r() * 0.3)); fx += lean * 0.12; }
    if (stage >= 5) for (let y = top; y < top + 4; y++) { t.put(Math.round(fx) - 1, y, mul(head, 0.9 + r() * 0.2)); t.put(Math.round(fx) + 1, y + 1, mul(head, 0.8 + r() * 0.2)); }
  }
}

function rootCrop(t, r, stage, root) {
  t.fill([0, 0, 0], 0);
  const leaf = [60, 150, 50];
  const h = 3 + stage * 2;
  for (const sx of [3, 7, 11]) {
    for (let y = 15; y >= 16 - h; y--) t.put(sx + ((y % 3) - 1), y, mul(leaf, 0.8 + r() * 0.4));
    t.put(sx - 1, 16 - h + 1, mul(leaf, 1.15)); t.put(sx + 1, 16 - h + 2, mul(leaf, 1.15));
    if (stage === 3) { t.put(sx, 14, root); t.put(sx + 1, 14, mul(root, 0.85)); t.put(sx, 15, mul(root, 0.9)); }
  }
}

function door(t, r, upper) {
  planks(t, r, [166, 132, 80]);
  // vertical boards with a frame
  t.each((x, y) => {
    let c = t.get(x, y);
    if (x % 4 === 3) c = mul(c, 0.78);
    t.set(x, y, c);
  });
  const frame = [110, 82, 48];
  for (let i = 0; i < 16; i++) { t.set(0, i, frame); t.set(15, i, frame); t.set(1, i, mul(frame, 1.2)); }
  if (upper) {
    for (let i = 0; i < 16; i++) t.set(i, 0, frame);
    for (const [x0, y0] of [[3, 3], [9, 3], [3, 9], [9, 9]]) {
      for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) t.set(x, y, [0, 0, 0], 0);
    }
  } else {
    for (let i = 0; i < 16; i++) t.set(i, 15, frame);
    for (let x = 3; x < 13; x++) { t.set(x, 5, frame); t.set(x, 11, frame); }
    t.set(12, 1, [60, 60, 66]); t.set(12, 2, [150, 150, 160]); t.set(13, 2, [60, 60, 66]);
  }
}

const RED = [178, 40, 38], REDD = [132, 26, 28], WOOD = [150, 112, 64], WOODD = [96, 68, 36], PILLOW = [236, 234, 228];
function bedTop(t, r, head) {
  t.each((x, y) => t.set(x, y, mul(RED, 0.92 + r() * 0.1)));
  for (let y = 0; y < 16; y++) { t.set(0, y, REDD); t.set(15, y, REDD); }
  if (head) {
    for (let y = 1; y < 6; y++) for (let x = 2; x < 14; x++) t.set(x, y, mul(PILLOW, (y === 1 || y === 5 || x === 2 || x === 13) ? 0.85 : 0.97 + r() * 0.05));
    for (let x = 0; x < 16; x++) t.set(x, 7, mul(RED, 1.15));
  } else {
    for (let x = 0; x < 16; x++) { t.set(x, 14, REDD); t.set(x, 15, mul(REDD, 0.85)); }
  }
}

function bedSide(t, r, head) {
  t.fill([0, 0, 0], 0);
  for (let y = 7; y < 12; y++) for (let x = 0; x < 16; x++) t.set(x, y, mul(RED, 0.9 + r() * 0.1));
  if (head) for (let y = 7; y < 10; y++) for (let x = 11; x < 15; x++) t.set(x, y, PILLOW);
  for (let y = 12; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, mul(WOOD, 0.9 + r() * 0.15));
  for (let x = 0; x < 16; x++) t.set(x, 12, WOODD);
  for (let y = 13; y < 16; y++) { t.set(head ? 15 : 0, y, WOODD); t.set(head ? 14 : 1, y, WOODD); }
}

function bedEnd(t, r, head) {
  t.fill([0, 0, 0], 0);
  for (let y = 7; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, mul(WOOD, 0.9 + r() * 0.15));
  if (!head) for (let y = 7; y < 11; y++) for (let x = 0; x < 16; x++) t.set(x, y, mul(RED, 0.9 + r() * 0.1));
  for (let x = 0; x < 16; x++) t.set(x, head ? 7 : 11, WOODD);
}

function scorch(t, r, base = [110, 38, 34]) {
  const n = fbm(Math.floor(r() * 1e9), [4, 8, 16], [0.4, 0.35, 0.25]);
  t.each((x, y) => {
    const v = 0.7 + n(x, y) * 0.55 + (r() - 0.5) * 0.1;
    t.set(x, y, mul(base, v));
  });
  for (let i = 0; i < 12; i++) { const x = Math.floor(r() * 16), y = Math.floor(r() * 16); t.set(x, y, mul(base, 0.55)); }
}

function magma(t, r) {
  scorch(t, r, [70, 30, 24]);
  const n = valueNoise(Math.floor(r() * 1e9), 4);
  t.each((x, y) => {
    const v = Math.abs(n(x, y) - 0.5);
    if (v < 0.05) t.set(x, y, [255, 150, 40]);
    else if (v < 0.09) t.set(x, y, [200, 70, 20]);
  });
}

function emberCrystal(t, r) {
  const vor = voronoi(Math.floor(r() * 1e9), 7);
  t.each((x, y) => {
    const c = vor(x, y);
    let col = mix([255, 170, 50], [255, 236, 150], c.v);
    if (c.d2 - c.d1 < 1.1) col = [190, 90, 20];
    col = mul(col, 0.9 + (-c.dx - c.dy) * 0.03);
    t.set(x, y, col);
  });
}

function glowcap(t, r) {
  t.fill([0, 0, 0], 0);
  const stem = [200, 190, 170];
  for (let y = 8; y < 16; y++) { t.set(7, y, stem); t.set(8, y, mul(stem, 0.85)); }
  for (let y = 3; y < 9; y++) for (let x = 2; x < 14; x++) {
    const d = Math.hypot((x - 7.5) / 6, (y - 8.5) / 5.5);
    if (d < 1) t.set(x, y, mix([60, 230, 210], [180, 255, 240], (8 - y) / 6 * 0.6 + r() * 0.2));
  }
  for (const [x, y] of [[5, 5], [9, 4], [10, 7], [4, 7]]) t.set(x, y, [230, 255, 250]);
}

function spawnerCage(t) {
  t.fill([0, 0, 0], 0);
  const bar = [44, 46, 58], hi = [90, 96, 116];
  for (let i = 0; i < 16; i++) {
    for (const k of [0, 5, 10, 15]) { t.set(k, i, i % 3 ? bar : hi); t.set(i, k, i % 3 ? bar : hi); }
  }
}

function enchantTop(t, r) {
  obsidian(t, r);
  for (let i = 0; i < 16; i++) { t.set(i, 0, [150, 30, 36]); t.set(i, 15, [150, 30, 36]); t.set(0, i, [150, 30, 36]); t.set(15, i, [150, 30, 36]); }
  for (let y = 5; y < 11; y++) for (let x = 3; x < 13; x++) t.set(x, y, x === 7 || x === 8 ? [150, 120, 90] : [236, 228, 206]);
  for (let y = 6; y < 10; y += 2) for (let x = 4; x < 12; x++) if (x !== 7 && x !== 8 && r() < 0.7) t.set(x, y, [120, 110, 140]);
}

function enchantSide(t, r) {
  obsidian(t, r);
  for (let y = 4; y < 7; y++) for (let x = 0; x < 16; x++) t.set(x, y, mul([160, 34, 40], y === 6 ? 0.7 : 1));
  for (let x = 1; x < 16; x += 3) t.set(x, 7, [180, 150, 60]);
}

function hay(t, r, top) {
  t.each((x, y) => {
    let c = mix([214, 176, 60], [236, 206, 96], r());
    if (!top && (x % 3 === 0)) c = mul(c, 0.85);
    if (top && ((x + y) % 4 === 0)) c = mul(c, 0.8);
    t.set(x, y, c);
  });
  if (!top) for (const y of [3, 12]) for (let x = 0; x < 16; x++) t.set(x, y, [120, 40, 30]);
  if (top) for (let i = 0; i < 16; i++) { t.set(i, 0, [170, 130, 40]); t.set(0, i, [170, 130, 40]); t.set(i, 15, [170, 130, 40]); t.set(15, i, [170, 130, 40]); }
}

function rift(t, frame) {
  const P = Math.PI * 2, f = frame / 16;
  t.each((x, y) => {
    const u = x / 16 - 0.5, v = y / 16 - 0.5;
    const a = Math.atan2(v, u), d = Math.hypot(u, v);
    let w = Math.sin(a * 2 + d * 14 - f * P) * 0.5 + Math.sin(u * 9 + f * P * 2) * 0.25 + Math.sin(v * 7 - f * P) * 0.25;
    w = w * 0.5 + 0.5;
    // deep indigo swirling into pale cyan, with a few bright motes
    let c = w < 0.5 ? mix([22, 10, 64], [70, 60, 190], w * 2) : mix([70, 60, 190], [140, 235, 255], (w - 0.5) * 2);
    if (((x * 7 + y * 13 + frame * 3) % 37) === 0) c = [230, 250, 255];
    t.set(x, y, c, 170 + w * 70);
  });
}


// ---------------------------------------------------------------------------
// Round three: spark circuits, rails, brewing, the void, fire and extras.
function clear(t) { t.fill([0, 0, 0], 0); }

function sparkLine(t, r) {
  clear(t);
  for (let y = 0; y < 16; y++) for (let x = 6; x < 10; x++) {
    if ((x === 6 || x === 9) && r() < 0.35) continue;
    t.set(x, y, gray(200 + Math.floor(r() * 55)));
  }
}
function sparkDot(t, r) {
  clear(t);
  for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) {
    if ((x === 5 || x === 10) && (y === 5 || y === 10)) continue;
    t.set(x, y, gray(205 + Math.floor(r() * 50)));
  }
}
function sparkTorch(t, on) {
  clear(t);
  for (let y = 8; y < 16; y++) { t.set(7, y, [150, 110, 60]); t.set(8, y, [110, 78, 40]); }
  const a = on ? [255, 90, 70] : [110, 40, 34], b = on ? [220, 30, 20] : [80, 26, 22];
  t.set(7, 6, a); t.set(8, 6, b); t.set(7, 7, b); t.set(8, 7, mul(b, 0.8));
  if (on) { t.set(6, 6, [255, 140, 120], 120); t.set(9, 7, [255, 140, 120], 120); }
}
function sparkTorchTop(t, on) {
  t.each((x, y) => t.set(x, y, on ? ((x + y) % 2 ? [255, 70, 50] : [255, 140, 110]) : ((x + y) % 2 ? [90, 30, 26] : [120, 44, 36])));
}
function leverTex(t) {
  clear(t);
  for (let y = 0; y < 16; y++) { t.set(7, y, [150, 110, 60]); t.set(8, y, [112, 80, 42]); }
  for (let y = 0; y < 6; y++) { t.set(7, y, [176, 176, 176]); t.set(8, y, [128, 128, 128]); }
}
function repeaterTop(t, r, on) {
  stone(t, r);
  t.each((x, y) => t.set(x, y, mul(t.get(x, y), 1.05)));
  const red = on ? [255, 60, 40] : [120, 30, 26];
  // a red trace down the middle and an arrow pointing forward (up)
  for (let y = 3; y < 15; y++) t.set(7, y, red), t.set(8, y, mul(red, 0.85));
  for (let k = 0; k < 4; k++) { t.set(7 - k, 3 + k, red); t.set(8 + k, 3 + k, red); }
  for (let x = 0; x < 16; x++) { t.set(x, 0, gray(150)); t.set(x, 15, gray(90)); }
}
function sparkLamp(t, r, on) {
  t.each((x, y) => {
    const cell = (x % 4 === 0) || (y % 4 === 0);
    let c = on ? (cell ? [170, 90, 40] : mix([255, 230, 170], [255, 170, 80], r())) : (cell ? [56, 36, 24] : mix([110, 66, 40], [90, 54, 32], r()));
    t.set(x, y, c);
  });
  for (let i = 0; i < 16; i++) { const e = on ? [140, 70, 30] : [44, 28, 20]; t.set(i, 0, e); t.set(0, i, e); t.set(i, 15, e); t.set(15, i, e); }
}
function pistonFace(t, r, sticky) {
  planks(t, r, sticky ? [176, 140, 60] : [168, 132, 82]);
  if (sticky) t.each((x, y) => { if (x > 1 && y > 1 && x < 14 && y < 14) t.set(x, y, mix([214, 150, 40], [250, 196, 80], r() * 0.6), 255); });
  for (let i = 0; i < 16; i++) for (const [a, b] of [[i, 0], [0, i], [i, 15], [15, i]]) t.set(a, b, [140, 140, 146]);
}
function pistonSide(t, r) {
  cobble(t, r, [124, 124, 124], [70, 70, 70], 9);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) t.set(x, y, mul([168, 132, 82], 0.85 + r() * 0.2));
  for (let x = 0; x < 16; x++) { t.set(x, 4, [96, 96, 100]); }
}
function pistonBottom(t, r) {
  cobble(t, r, [120, 120, 120], [66, 66, 66], 9);
  t.rect(5, 5, 6, 6, [150, 150, 156]); t.rect(6, 6, 4, 4, [110, 110, 116]);
}
function pistonInner(t, r) {
  cobble(t, r, [112, 112, 112], [60, 60, 60], 9);
  t.rect(6, 6, 4, 4, [168, 132, 82]);
}
function noteBlock(t, r) {
  planks(t, r, [128, 82, 52]);
  const n = [40, 24, 16];
  for (let y = 3; y < 11; y++) t.set(10, y, n);
  t.rect(7, 10, 3, 2, n); t.set(11, 3, n); t.set(12, 4, n);
}
function daylightTop(t, r) {
  t.each((x, y) => {
    const frame = x % 5 === 0 || y % 5 === 0 || x === 15 || y === 15;
    t.set(x, y, frame ? [226, 220, 210] : mix([60, 90, 140], [110, 150, 200], r() * 0.6 + (x + y) / 60));
  });
}
function daylightSide(t, r) { planks(t, r, [150, 112, 64]); for (let y = 0; y < 10; y++) for (let x = 0; x < 16; x++) t.set(x, y, [0, 0, 0], 0); t.each((x, y) => { if (y >= 10 && y <= 10) t.set(x, y, [226, 220, 210]); }); }
function sparkBlock(t, r) {
  metalBlock(t, r, [196, 30, 24]);
  for (let i = 3; i < 13; i += 4) for (let k = 2; k < 14; k++) { t.set(i, k, [130, 14, 10]); t.set(k, i, [130, 14, 10]); }
}
function trapdoor(t, r) {
  planks(t, r, [156, 118, 70]);
  for (const [x0, y0] of [[3, 3], [9, 3], [3, 9], [9, 9]]) t.rect(x0, y0, 4, 4, [0, 0, 0], 0);
  for (let i = 0; i < 16; i++) { t.set(i, 0, [110, 80, 44]); t.set(i, 15, [110, 80, 44]); t.set(0, i, [110, 80, 44]); t.set(15, i, [110, 80, 44]); }
}
function dispenserFront(t, r, vertical) {
  cobble(t, r, [120, 120, 120], [66, 66, 66], 9);
  if (vertical) {
    t.each((x, y) => { const d = Math.hypot(x - 7.5, y - 7.5); if (d < 4.5) t.set(x, y, d < 3 ? [20, 20, 22] : [70, 70, 74]); });
  } else {
    t.rect(4, 5, 8, 6, [70, 70, 74]); t.rect(5, 6, 6, 4, [20, 20, 22]);
  }
}
function hopperTop(t) {
  t.each((x, y) => {
    const rim = x < 2 || y < 2 || x > 13 || y > 13;
    t.set(x, y, rim ? mix([70, 70, 74], [100, 100, 106], (x + y) / 30) : [26, 26, 30]);
  });
}
function hopperSide(t, r) { metalBlock(t, r, [74, 74, 80]); }
function railTex(t, r, kind, on) {
  clear(t);
  const iron = kind === 'powered' ? [214, 172, 40] : [176, 176, 180], ironD = mul(iron, 0.7);
  const wood = [118, 84, 46], woodD = [86, 60, 32];
  for (const y of [1, 5, 9, 13]) for (let x = 1; x < 15; x++) { t.set(x, y, wood); t.set(x, y + 1, woodD); }
  for (let y = 0; y < 16; y++) { t.set(2, y, iron); t.set(3, y, ironD); t.set(12, y, iron); t.set(13, y, ironD); }
  if (kind === 'powered') for (let y = 0; y < 16; y++) { t.set(7, y, on ? [255, 60, 40] : [100, 28, 24]); t.set(8, y, on ? [210, 30, 20] : [80, 20, 18]); }
  if (kind === 'detector') { t.rect(5, 5, 6, 6, [120, 120, 120]); t.rect(6, 6, 4, 4, on ? [255, 60, 40] : [110, 30, 26]); }
}
function railCorner(t) {
  clear(t);
  const iron = [176, 176, 180], ironD = mul(iron, 0.7), wood = [118, 84, 46], woodD = [86, 60, 32];
  // sleepers radiate around the corner at (16, 16)
  for (let a = 0.1; a < Math.PI / 2; a += 0.38) {
    for (let d = 2; d < 15; d += 0.5) {
      const x = Math.floor(16 - Math.cos(a) * d), y = Math.floor(16 - Math.sin(a) * d);
      t.put(x, y, wood); t.put(x + 1, y, woodD);
    }
  }
  t.each((x, y) => {
    const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
    if (Math.abs(d - 3.5) < 0.8 || Math.abs(d - 13.5) < 0.8) t.set(x, y, iron);
    else if (Math.abs(d - 4.5) < 0.6 || Math.abs(d - 12.5) < 0.6) t.set(x, y, ironD);
  });
}
function brewingRod(t) {
  clear(t);
  for (let y = 0; y < 16; y++) { t.set(7, y, [238, 190, 70]); t.set(8, y, [190, 130, 40]); }
}
function duskstone(t, r) {
  speckle(t, r, [206, 196, 214], 14, 0.6);
  for (let i = 0; i < 9; i++) { const x = Math.floor(r() * 15), y = Math.floor(r() * 15); t.set(x, y, [160, 150, 172]); t.set(x + 1, y, [176, 166, 188]); }
}
function starFrameTop(t, r) {
  speckle(t, r, [46, 92, 96], 12, 0.5);
  t.each((x, y) => { const d = Math.hypot(x - 7.5, y - 7.5); if (d < 4) t.set(x, y, [16, 30, 36]); else if (d < 5) t.set(x, y, [120, 200, 190]); });
}
function starFrameSide(t, r) {
  duskstone(t, r);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) t.set(x, y, mix([46, 92, 96], [70, 130, 130], r() * 0.5));
  for (let x = 0; x < 16; x += 4) t.set(x + 1, 2, [150, 230, 220]);
}
function starFrameEye(t, r) {
  t.each((x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5) / 8;
    let c = mix([150, 120, 255], [20, 16, 60], Math.min(1, d * 1.4));
    if (r() < 0.04) c = [255, 255, 255];
    t.set(x, y, c);
  });
  t.rect(7, 7, 2, 2, [255, 250, 220]);
}
function voidStalk(t, r) {
  t.each((x, y) => {
    const v = Math.sin(x * 1.3 + Math.floor(y / 3) * 2.1) * 0.5 + 0.5;
    t.set(x, y, mix([70, 40, 90], [140, 100, 170], v * 0.7 + r() * 0.3));
  });
}
function voidBloom(t, r) {
  t.each((x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const petal = Math.sin(Math.atan2(y - 7.5, x - 7.5) * 5) * 0.5 + 0.5;
    t.set(x, y, d < 3 ? [250, 236, 255] : mix([140, 90, 190], [220, 180, 250], petal * 0.8 + r() * 0.2));
  });
}
function astralBricks(t, r) {
  t.each((x, y) => {
    const edge = x % 8 === 0 || y % 8 === 0;
    t.set(x, y, edge ? [70, 66, 130] : mix([110, 106, 190], [136, 132, 214], r() * 0.5 + ((x % 8) + (y % 8)) / 28));
  });
}
function astralPillar(t, r, top) {
  t.each((x, y) => {
    if (top) { const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)); t.set(x, y, Math.floor(d) % 3 === 0 ? [80, 76, 150] : mix([116, 112, 196], [140, 136, 220], r() * 0.4)); }
    else t.set(x, y, x % 5 === 0 ? [80, 76, 150] : mix([116, 112, 196], [140, 136, 220], r() * 0.4));
  });
}
function glowRod(t) {
  clear(t);
  for (let y = 0; y < 16; y++) { t.set(7, y, [255, 255, 250]); t.set(8, y, [220, 214, 240]); }
  t.rect(6, 15, 4, 1, [140, 120, 170]); t.rect(6, 14, 4, 1, [180, 160, 210]);
}
function wyrmEgg(t, r) {
  t.each((x, y) => t.set(x, y, r() < 0.1 ? [120, 40, 160] : mix([14, 8, 22], [36, 20, 48], r())));
}
function cobwebTex(t) {
  clear(t);
  const c = [230, 230, 236];
  for (let i = 0; i < 16; i++) { t.set(i, i, c); t.set(15 - i, i, c); t.set(7, i, c); t.set(i, 8, c); }
  for (const rad of [3, 6]) for (let a = 0; a < Math.PI * 2; a += 0.15) t.put(Math.round(7.5 + Math.cos(a) * rad), Math.round(7.5 + Math.sin(a) * rad), c);
}
function ironBars(t) {
  clear(t);
  const a = [150, 150, 156], b = [100, 100, 106];
  for (let y = 0; y < 16; y++) for (const x of [1, 5, 9, 13]) { t.set(x, y, a); t.set(x + 1, y, b); }
  for (let x = 0; x < 16; x++) { t.set(x, 1, a); t.set(x, 14, b); }
}
function lanternTex(t, r) {
  clear(t);
  const frame = [54, 56, 66], glow = [255, 200, 90], glowD = [230, 140, 40];
  // side art: rows 9..15, cols 5..10
  for (let y = 9; y < 16; y++) for (let x = 5; x < 11; x++) {
    const edge = x === 5 || x === 10 || y === 9 || y === 15;
    t.set(x, y, edge ? frame : (y < 12 ? glow : glowD));
  }
  // cap: rows 7..8, cols 6..9
  for (let y = 7; y < 9; y++) for (let x = 6; x < 10; x++) t.set(x, y, frame);
  // top art: rows 0..5, cols 0..5
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) t.set(x, y, (x === 0 || y === 0 || x === 5 || y === 5) ? frame : [80, 82, 92]);
  void r;
}
function chainTex(t) {
  clear(t);
  for (let y = 0; y < 16; y++) { const link = y % 4; if (link === 0 || link === 3) { t.set(7, y, [70, 72, 84]); t.set(8, y, [50, 52, 62]); } else { t.set(6, y, [80, 82, 94]); t.set(9, y, [50, 52, 62]); } }
}
function cakeTex(t, r, part) {
  const sponge = [214, 160, 96], icing = [248, 244, 238], cherry = [210, 30, 40];
  if (part === 'top') { t.each((x, y) => t.set(x, y, mul(icing, 0.96 + r() * 0.06))); for (const [x, y] of [[4, 4], [11, 5], [7, 10], [3, 11], [12, 12]]) t.set(x, y, cherry); }
  else if (part === 'bottom') t.each((x, y) => t.set(x, y, mul(sponge, 0.8 + r() * 0.1)));
  else if (part === 'inner') t.each((x, y) => t.set(x, y, y < 9 ? mul(icing, 0.95) : y < 10 ? [180, 40, 50] : mul(sponge, 0.9 + r() * 0.1)));
  else t.each((x, y) => t.set(x, y, y < 10 ? mul(icing, 0.95 + r() * 0.05) : y === 10 ? [200, 60, 70] : mul(sponge, 0.92 + r() * 0.1)));
}
function fireTex(t, frame) {
  clear(t);
  const P = Math.PI * 2, f = frame / 16;
  t.each((x, y) => {
    const u = x / 16, v = y / 16;
    let h = 0.55 + Math.sin(P * (u * 2 + f)) * 0.12 + Math.sin(P * (u * 5 - f * 2)) * 0.08 + Math.sin(P * (u * 9 + f * 3)) * 0.05;
    const k = (v - (1 - h)) / h; // 0 at the flame tip, 1 at the base
    if (k < 0) return;
    const flick = Math.sin(P * (u * 7 + v * 3 - f * 4)) * 0.15;
    const heat = Math.min(1, k + flick);
    const c = heat > 0.75 ? mix([255, 200, 60], [255, 240, 170], (heat - 0.75) * 4) : heat > 0.35 ? mix([240, 90, 10], [255, 200, 60], (heat - 0.35) * 2.5) : mix([160, 30, 0], [240, 90, 10], heat / 0.35);
    t.set(x, y, c, k < 0.08 ? 160 : 255);
  });
}
function voidGate(t, frame) {
  const f = frame / 16;
  const rr = rng(4242);
  t.each((x, y) => t.set(x, y, mix([6, 8, 20], [16, 26, 44], (Math.sin((x + y * 0.7) * 0.5 + f * 6.28) * 0.5 + 0.5) * 0.6)));
  for (let i = 0; i < 22; i++) {
    const sx = Math.floor(rr() * 16), sy = Math.floor(rr() * 16), ph = rr();
    const b = 0.5 + 0.5 * Math.sin((f + ph) * Math.PI * 2);
    const col = [[150, 220, 220], [120, 160, 255], [220, 200, 255]][i % 3];
    t.set((sx + Math.floor(f * 4 * (i % 3 + 1))) % 16, sy, mix([10, 14, 30], col, b));
  }
}

function paintBlock(name, frame) {
  const t = new Tex();
  const r = rng(hashSeed('bf:' + name) + frame * 7919);
  switch (name) {
    case 'stone': stone(t, r); break;
    case 'cobblestone': cobble(t, r); break;
    case 'mossy_cobblestone': {
      cobble(t, r);
      const n = valueNoise(Math.floor(r() * 1e9), 4);
      t.each((x, y) => { if (n(x, y) > 0.55 && r() > 0.2) t.set(x, y, mul([84, 120, 58], 0.8 + r() * 0.4)); });
      break;
    }
    case 'stone_bricks': bricks(t, r, [124, 124, 124], [70, 70, 70], 2, 16); {
      // two rows of long bricks with a centred joint on the lower row
      for (let y = 8; y < 15; y++) { t.set(7, y, gray(70)); t.set(8, y, gray(92)); }
    } break;
    case 'bricks': bricks(t, r, [150, 74, 58], [184, 172, 160], 4, 8); break;
    case 'dirt': dirt(t, r); break;
    case 'grass_top': grassTop(t, r); break;
    case 'grass_side': grassSide(t, r, false); break;
    case 'snowy_grass_side': grassSide(t, r, true); break;
    case 'snow': sandLike(t, r, [236, 244, 250], 5); break;
    case 'sand': sandLike(t, r, [220, 206, 158]); break;
    case 'sandstone_top': sandLike(t, r, [222, 208, 156], 6); break;
    case 'sandstone_bottom': sandLike(t, r, [206, 190, 138], 10); break;
    case 'sandstone_side': sandstoneSide(t, r); break;
    case 'gravel': gravel(t, r); break;
    case 'clay': sandLike(t, r, [158, 164, 178], 8); break;
    case 'bedrock': bedrock(t, r); break;
    case 'oak_log': logSide(t, r, [108, 84, 50], [64, 48, 28], [130, 104, 66]); break;
    case 'oak_log_top': logTop(t, r, [182, 146, 92], [100, 78, 46]); break;
    case 'birch_log': birchSide(t, r); break;
    case 'birch_log_top': logTop(t, r, [214, 196, 146], [216, 212, 204]); break;
    case 'spruce_log': logSide(t, r, [66, 46, 28], [36, 24, 14], [84, 62, 40]); break;
    case 'spruce_log_top': logTop(t, r, [140, 104, 62], [62, 44, 26]); break;
    case 'oak_planks': planks(t, r, [166, 132, 80]); break;
    case 'birch_planks': planks(t, r, [202, 184, 128]); break;
    case 'spruce_planks': planks(t, r, [116, 86, 50]); break;
    case 'oak_leaves': leaves(t, r, 0.22); break;
    case 'birch_leaves': leaves(t, r, 0.16); break;
    case 'spruce_leaves': leaves(t, r, 0.18, 'spruce'); break;
    case 'glass': glass(t, r); break;
    case 'coal_ore': ore(t, r, [36, 36, 38], [70, 70, 74], [20, 20, 22]); break;
    case 'iron_ore': ore(t, r, [214, 172, 142], [238, 206, 180], [160, 118, 92]); break;
    case 'copper_ore': ore(t, r, [220, 120, 70], [250, 170, 110], [80, 160, 130]); break;
    case 'gold_ore': ore(t, r, [250, 214, 60], [255, 246, 150], [190, 140, 20], 4); break;
    case 'diamond_ore': ore(t, r, [80, 222, 222], [200, 255, 255], [30, 140, 150], 4); break;
    case 'emerald_ore': ore(t, r, [50, 200, 100], [150, 255, 180], [20, 120, 60], 3); break;
    case 'cactus_side': cactusSide(t, r); break;
    case 'cactus_top': cactusTop(t, r, false); break;
    case 'cactus_bottom': cactusTop(t, r, true); break;
    case 'tall_grass': tallGrass(t, r); break;
    case 'fern': fern(t, r); break;
    case 'dandelion': flower(t, r, [250, 220, 40], [240, 150, 20], [220, 180, 20]); break;
    case 'poppy': flower(t, r, [220, 30, 36], [40, 20, 20], [160, 20, 24]); break;
    case 'cornflower': flower(t, r, [80, 110, 240], [230, 230, 250], [50, 70, 190]); break;
    case 'dead_bush': deadBush(t, r); break;
    case 'sugar_cane': sugarCane(t, r); break;
    case 'ice': ice(t, r); break;
    case 'obsidian': obsidian(t, r); break;
    case 'bricks_': break;
    case 'bookshelf': bookshelf(t, r); break;
    case 'crafting_table_top': craftTop(t, r); break;
    case 'crafting_table_side': craftSide(t, r, false); break;
    case 'crafting_table_front': craftSide(t, r, true); break;
    case 'furnace_front': furnaceFront(t, r, false); break;
    case 'furnace_front_lit': furnaceFront(t, r, true); break;
    case 'furnace_side': furnaceSide(t, r); break;
    case 'furnace_top': furnaceSide(t, r); break;
    case 'chest_top': chest(t, r, 'top'); break;
    case 'chest_side': chest(t, r, 'side'); break;
    case 'chest_front': chest(t, r, 'front'); break;
    case 'torch': torch(t); break;
    case 'torch_top': torchTop(t); break;
    case 'lamp': lamp(t, r); break;
    case 'white_wool': wool(t, r, [236, 236, 236]); break;
    case 'red_wool': wool(t, r, [176, 44, 40]); break;
    case 'orange_wool': wool(t, r, [232, 120, 30]); break;
    case 'yellow_wool': wool(t, r, [240, 200, 50]); break;
    case 'green_wool': wool(t, r, [84, 140, 40]); break;
    case 'blue_wool': wool(t, r, [52, 70, 170]); break;
    case 'purple_wool': wool(t, r, [124, 54, 170]); break;
    case 'black_wool': wool(t, r, [30, 30, 34]); break;
    case 'iron_block': metalBlock(t, r, [216, 216, 220]); break;
    case 'gold_block': metalBlock(t, r, [246, 206, 58]); break;
    case 'diamond_block': metalBlock(t, r, [104, 226, 222]); break;
    case 'coal_block': metalBlock(t, r, [36, 36, 40]); break;
    case 'copper_block': metalBlock(t, r, [196, 110, 72]); break;
    case 'emerald_block': metalBlock(t, r, [56, 196, 106]); break;
    case 'pumpkin_side': gourdSide(t, r, [222, 124, 28], [180, 90, 16]); break;
    case 'pumpkin_top': gourdTop(t, r, [222, 124, 28], [180, 90, 16]); break;
    case 'melon_side': gourdSide(t, r, [110, 164, 40], [60, 110, 24]); break;
    case 'melon_top': gourdTop(t, r, [120, 170, 44], [70, 120, 28]); break;
    case 'oak_sapling': sapling(t, r, 'oak'); break;
    case 'birch_sapling': sapling(t, r, 'birch'); break;
    case 'spruce_sapling': sapling(t, r, 'spruce'); break;
    case 'ladder': ladder(t); break;
    case 'brown_mushroom': mushroom(t, r, false); break;
    case 'red_mushroom': mushroom(t, r, true); break;
    case 'tnt_side': blastCrate(t, r, 'side'); break;
    case 'tnt_top': blastCrate(t, r, 'top'); break;
    case 'tnt_bottom': blastCrate(t, r, 'bottom'); break;
    case 'dirt_path_top': pathTop(t, r); break;
    case 'dirt_path_side': pathSide(t, r); break;
    case 'farmland': farmland(t, r, false); break;
    case 'farmland_wet': farmland(t, r, true); break;
    case 'oak_door_top': door(t, r, true); break;
    case 'oak_door_bottom': door(t, r, false); break;
    case 'bed_head_top': bedTop(t, r, true); break;
    case 'bed_foot_top': bedTop(t, r, false); break;
    case 'bed_head_side': bedSide(t, r, true); break;
    case 'bed_foot_side': bedSide(t, r, false); break;
    case 'bed_head_end': bedEnd(t, r, true); break;
    case 'bed_foot_end': bedEnd(t, r, false); break;
    case 'scorchstone': scorch(t, r); break;
    case 'cinder_sand': sandLike(t, r, [96, 78, 70], 18); for (let i = 0; i < 6; i++) t.set(Math.floor(r() * 16), Math.floor(r() * 16), [200, 90, 40]); break;
    case 'ember_crystal': emberCrystal(t, r); break;
    case 'magma_rock': magma(t, r); break;
    case 'quartz_ore': scorch(t, r); for (let i = 0; i < 6; i++) { const x = 1 + Math.floor(r() * 13), y = 1 + Math.floor(r() * 13); t.set(x, y, [240, 236, 228]); t.set(x + 1, y, [220, 214, 206]); t.set(x, y + 1, [200, 194, 186]); } break;
    case 'ember_gold_ore': scorch(t, r); for (let i = 0; i < 7; i++) { const x = 1 + Math.floor(r() * 14), y = 1 + Math.floor(r() * 14); t.set(x, y, [255, 214, 60]); if (r() < 0.5) t.set(x + 1, y, [220, 170, 30]); } break;
    case 'glowcap': glowcap(t, r); break;
    case 'ashen_shrub': deadBush(t, r); t.each((x, y) => { const c = t.get(x, y); if (c[3]) t.set(x, y, mul([120, 110, 104], 0.8 + r() * 0.4)); }); break;
    case 'ember_bricks': bricks(t, r, [96, 30, 30], [40, 14, 16], 4, 8); break;
    case 'spawner': spawnerCage(t); break;
    case 'enchanting_table_top': enchantTop(t, r); break;
    case 'enchanting_table_side': enchantSide(t, r); break;
    case 'enchanting_table_bottom': obsidian(t, r); break;
    case 'hay_side': hay(t, r, false); break;
    case 'hay_top': hay(t, r, true); break;
    case 'quartz_block': metalBlock(t, r, [232, 226, 216]); break;
    case 'rift': rift(t, frame); break;
    case 'fire': fireTex(t, frame); break;
    case 'void_gate': voidGate(t, frame); break;
    case 'spark_ore': ore(t, r, [220, 30, 24], [255, 110, 90], [150, 16, 12], 6); break;
    case 'spark_line': sparkLine(t, r); break;
    case 'spark_dot': sparkDot(t, r); break;
    case 'spark_torch': sparkTorch(t, true); break;
    case 'spark_torch_off': sparkTorch(t, false); break;
    case 'spark_torch_top': sparkTorchTop(t, true); break;
    case 'spark_torch_top_off': sparkTorchTop(t, false); break;
    case 'lever': leverTex(t); break;
    case 'repeater': repeaterTop(t, r, false); break;
    case 'repeater_on': repeaterTop(t, r, true); break;
    case 'spark_lamp': sparkLamp(t, r, false); break;
    case 'spark_lamp_on': sparkLamp(t, r, true); break;
    case 'piston_top': pistonFace(t, r, false); break;
    case 'piston_top_sticky': pistonFace(t, r, true); break;
    case 'piston_side': pistonSide(t, r); break;
    case 'piston_bottom': pistonBottom(t, r); break;
    case 'piston_inner': pistonInner(t, r); break;
    case 'note_block': noteBlock(t, r); break;
    case 'daylight_top': daylightTop(t, r); break;
    case 'daylight_side': daylightSide(t, r); break;
    case 'spark_block': sparkBlock(t, r); break;
    case 'oak_trapdoor': trapdoor(t, r); break;
    case 'dispenser_front': dispenserFront(t, r, false); break;
    case 'dispenser_front_v': dispenserFront(t, r, true); break;
    case 'hopper_top': hopperTop(t); break;
    case 'hopper_side': hopperSide(t, r); break;
    case 'rail': railTex(t, r, 'plain', false); break;
    case 'rail_corner': railCorner(t); break;
    case 'powered_rail': railTex(t, r, 'powered', false); break;
    case 'powered_rail_on': railTex(t, r, 'powered', true); break;
    case 'detector_rail': railTex(t, r, 'detector', false); break;
    case 'detector_rail_on': railTex(t, r, 'detector', true); break;
    case 'brewing_base': cobble(t, r, [100, 100, 104], [56, 56, 60], 8); break;
    case 'brewing_rod': brewingRod(t); break;
    case 'duskstone': duskstone(t, r); break;
    case 'duskstone_bricks': bricks(t, r, [206, 196, 214], [150, 140, 160], 4, 8); break;
    case 'star_frame_top': starFrameTop(t, r); break;
    case 'star_frame_side': starFrameSide(t, r); break;
    case 'star_frame_eye': starFrameEye(t, r); break;
    case 'void_stalk': voidStalk(t, r); break;
    case 'void_bloom': voidBloom(t, r); break;
    case 'astral_bricks': astralBricks(t, r); break;
    case 'astral_pillar': astralPillar(t, r, false); break;
    case 'astral_pillar_top': astralPillar(t, r, true); break;
    case 'glow_rod': glowRod(t); break;
    case 'wyrm_egg': wyrmEgg(t, r); break;
    case 'cobweb': cobwebTex(t); break;
    case 'iron_bars': ironBars(t); break;
    case 'lantern': lanternTex(t, r); break;
    case 'chain': chainTex(t); break;
    case 'cake_top': cakeTex(t, r, 'top'); break;
    case 'cake_side': cakeTex(t, r, 'side'); break;
    case 'cake_inner': cakeTex(t, r, 'inner'); break;
    case 'cake_bottom': cakeTex(t, r, 'bottom'); break;
    case 'water': water(t, frame); break;
    case 'lava': lava(t, frame); break;
    case 'white': t.fill([255, 255, 255]); break;
    default:
      if (name.startsWith('crack')) crack(t, +name.slice(5));
      else if (/^wheat\d$/.test(name)) wheat(t, r, +name.slice(5));
      else if (/^carrots\d$/.test(name)) rootCrop(t, r, +name.slice(7), [240, 130, 30]);
      else if (/^potatoes\d$/.test(name)) rootCrop(t, r, +name.slice(8), [200, 170, 100]);
      else if (name.startsWith('p_')) particle(t, name, r);
      else { t.fill([255, 0, 255]); }
  }
  return t;
}

// Build mip levels. Alpha-as-transparency textures keep coverage (a texel
// survives if enough of its children are solid); alpha-as-tint-mask textures
// average everything.
export function buildMips(data, size, transparent) {
  const levels = [data];
  let cur = data, s = size;
  while (s > 1) {
    const ns = s >> 1;
    const out = new Uint8ClampedArray(ns * ns * 4);
    for (let y = 0; y < ns; y++) for (let x = 0; x < ns; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((y * 2 + dy) * s + x * 2 + dx) * 4;
        const al = cur[i + 3];
        if (transparent) {
          if (al > 0) { r += cur[i]; g += cur[i + 1]; b += cur[i + 2]; n++; }
          a += al;
        } else { r += cur[i]; g += cur[i + 1]; b += cur[i + 2]; a += al; n++; }
      }
      const o = (y * ns + x) * 4;
      if (n) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; }
      out[o + 3] = transparent ? (a / 4 > 60 ? Math.max(a / 4, 160) : 0) : a / 4;
    }
    levels.push(out);
    cur = out; s = ns;
  }
  return levels;
}

export function generateBlockTextures() {
  return TEXTURE_LIST.map(({ name, frame }) => {
    const t = paintBlock(name, frame);
    return { name, frame, data: t.d, transparent: ALPHA_TEXTURES.has(name) };
  });
}

// ---------------------------------------------------------------------------
// Items: sprites painted as material maps, then shaded and outlined.

const MATERIAL = {
  wooden: [[120, 88, 50], [162, 128, 78], [196, 160, 104]],
  stone: [[90, 90, 90], [128, 128, 128], [168, 168, 168]],
  iron: [[150, 150, 156], [210, 210, 214], [246, 246, 250]],
  golden: [[190, 140, 20], [248, 208, 60], [255, 244, 150]],
  diamond: [[30, 150, 150], [90, 226, 222], [200, 255, 250]],
};
const HANDLE = [[74, 52, 28], [118, 84, 46], [150, 112, 64]];

class Sprite {
  constructor() { this.m = new Int16Array(256).fill(-1); this.pal = []; }
  mat(colors) { this.pal.push(colors); return this.pal.length - 1; }
  put(x, y, m) { if (x >= 0 && y >= 0 && x < 16 && y < 16) this.m[y * 16 + x] = m; }
  at(x, y) { return x < 0 || y < 0 || x > 15 || y > 15 ? -1 : this.m[y * 16 + x]; }
  line(x0, y0, x1, y1, m, w = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      for (let oy = 0; oy < w; oy++) for (let ox = 0; ox < w; ox++) this.put(Math.round(x) + ox, Math.round(y) + oy, m);
    }
  }
  disc(cx, cy, rx, ry, m) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) this.put(x, y, m);
    }
  }
  poly(pts, m) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const px = x + 0.5, py = y + 0.5;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) this.put(x, y, m);
    }
  }
  // Render: per-material 3-tone shading from exposure to the top-left light,
  // plus a dark outline around the silhouette.
  render(outline = true) {
    const t = new Tex();
    t.fill([0, 0, 0], 0);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const m = this.at(x, y);
      if (m < 0) continue;
      const pal = this.pal[m];
      const up = this.at(x, y - 1) !== m, left = this.at(x - 1, y) !== m;
      const down = this.at(x, y + 1) !== m, right = this.at(x + 1, y) !== m;
      let tone = 1;
      if (up || left) tone = 2;
      if ((down || right) && !(up || left)) tone = 0;
      t.set(x, y, pal[tone]);
    }
    if (outline) {
      const o = new Tex(); o.d.set(t.d);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        if (this.at(x, y) >= 0) continue;
        const n = [this.at(x + 1, y), this.at(x - 1, y), this.at(x, y + 1), this.at(x, y - 1)].find((v) => v >= 0);
        if (n !== undefined) o.set(x, y, mul(this.pal[n][0], 0.45));
      }
      return o;
    }
    return t;
  }
}

function toolSprite(type, mat) {
  const s = new Sprite();
  const h = s.mat(HANDLE), m = s.mat(MATERIAL[mat]);
  if (type === 'sword') {
    s.line(2, 13, 4, 11, h, 1);
    s.line(1, 14, 1, 14, h);
    s.line(3, 9, 6, 12, m, 1); // guard
    s.line(5, 10, 13, 2, m, 2);
    s.put(13, 1, m); s.put(14, 1, m);
  } else {
    s.line(2, 13, 10, 5, h, 1);
    s.line(3, 13, 10, 6, h, 1);
    if (type === 'pickaxe') {
      // curved head: an annulus sector centred down the handle line
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const dx = x + 0.5 - 4, dy = y + 0.5 - 11.5;
        const d = Math.hypot(dx, dy), ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (ang < -99 || ang > 9) continue;
        const t = Math.abs(ang + 45) / 54;
        if (d >= 8.1 && d <= 10.4 - 1.3 * t * t) s.put(x, y, m);
      }
    } else if (type === 'axe') {
      s.poly([[8, 2], [12, 1], [14, 4], [13, 8], [10, 9], [9, 6]], m);
    } else if (type === 'hoe') {
      s.poly([[6, 2], [12, 2], [13, 3], [13, 5], [11, 5], [11, 4], [6, 4]], m);
    } else if (type === 'shovel') {
      s.poly([[9, 4], [12, 1], [14, 1], [15, 3], [15, 4], [12, 7]], m);
      s.put(10, 5, m);
    }
  }
  return s.render();
}

export const POTION_COLORS = {
  water: [60, 90, 230], awkward: [80, 110, 210], swiftness: [110, 190, 230], slowness: [80, 96, 120],
  strength: [190, 40, 40], weakness: [90, 90, 84], healing: [250, 80, 90], harming: [90, 20, 40],
  regeneration: [220, 110, 190], poison: [90, 160, 50], fire_resistance: [240, 150, 50],
  water_breathing: [50, 110, 200], night_vision: [60, 60, 200], invisibility: [180, 186, 200],
  leaping: [120, 230, 90], slow_falling: [240, 220, 200],
};
const GLASS = [[150, 170, 190], [200, 214, 228], [240, 246, 252]];
const tone3 = (c) => [mul(c, 0.6), c, mix(c, [255, 255, 255], 0.45)];

function bottleSprite(color, splash) {
  const s = new Sprite();
  const g = s.mat(GLASS), liq = s.mat(tone3(color)), cork = s.mat([[100, 70, 40], [140, 100, 60], [180, 140, 90]]);
  if (splash) {
    s.disc(8, 10.5, 5, 4.8, g); s.disc(8, 11, 4, 3.6, liq);
    s.poly([[6, 3], [10, 3], [10, 6], [6, 6]], g); s.poly([[6, 1], [10, 1], [10, 3], [6, 3]], cork);
  } else {
    s.disc(8, 10, 5.2, 5, g); s.disc(8, 10.6, 4.2, 3.8, liq);
    s.poly([[7, 2], [9, 2], [9, 6], [7, 6]], g); s.poly([[6, 1], [10, 1], [10, 3], [6, 3]], cork);
  }
  return s.render();
}

function blockSprite(name, r) {
  const s = new Sprite();
  const stoneM = [[96, 96, 96], [130, 130, 130], [170, 170, 170]], woodM = [[110, 78, 40], [156, 118, 70], [190, 152, 100]];
  switch (name) {
    case 'lever': s.poly([[4, 11], [12, 11], [12, 14], [4, 14]], s.mat(stoneM)); s.line(7, 11, 10, 3, s.mat(HANDLE), 1); s.disc(10.5, 2.5, 1.5, 1.5, s.mat(MATERIAL.stone)); break;
    case 'stone_button': s.poly([[4, 6], [12, 6], [12, 10], [4, 10]], s.mat(stoneM)); break;
    case 'oak_button': s.poly([[4, 6], [12, 6], [12, 10], [4, 10]], s.mat(woodM)); break;
    case 'stone_pressure_plate': s.poly([[1, 8], [15, 8], [15, 11], [1, 11]], s.mat(stoneM)); break;
    case 'oak_pressure_plate': s.poly([[1, 8], [15, 8], [15, 11], [1, 11]], s.mat(woodM)); break;
    case 'repeater': {
      s.poly([[1, 9], [15, 9], [15, 13], [1, 13]], s.mat(stoneM));
      const red = s.mat([[150, 20, 16], [230, 50, 36], [255, 140, 120]]);
      s.line(4, 4, 4, 8, s.mat(HANDLE)); s.line(11, 5, 11, 8, s.mat(HANDLE));
      s.put(4, 3, red); s.put(11, 4, red); s.line(4, 10, 11, 10, red);
      break;
    }
    case 'hopper': {
      const m = s.mat([[50, 50, 56], [82, 82, 90], [120, 120, 130]]);
      s.poly([[1, 2], [15, 2], [15, 6], [11, 9], [11, 11], [9, 13], [7, 13], [5, 11], [5, 9], [1, 6]], m);
      s.poly([[3, 3], [13, 3], [13, 5], [3, 5]], s.mat([[16, 16, 20], [26, 26, 30], [40, 40, 46]]));
      break;
    }
    case 'brewing_stand': {
      s.poly([[2, 12], [14, 12], [14, 14], [2, 14]], s.mat(stoneM));
      s.line(8, 2, 8, 12, s.mat([[170, 110, 30], [238, 190, 70], [255, 230, 140]]));
      s.disc(4, 10, 2, 2.4, s.mat(GLASS)); s.disc(12, 10, 2, 2.4, s.mat(GLASS));
      break;
    }
    case 'oak_sign': s.poly([[1, 2], [15, 2], [15, 10], [1, 10]], s.mat(woodM)); s.line(8, 10, 8, 15, s.mat(HANDLE)); {
      const ink = s.mat([[40, 30, 20], [60, 44, 30], [80, 60, 40]]);
      s.line(3, 4, 12, 4, ink); s.line(3, 6, 10, 6, ink); s.line(3, 8, 11, 8, ink);
    } break;
    case 'lantern': {
      const f = s.mat([[40, 42, 50], [64, 66, 78], [96, 98, 112]]);
      s.poly([[4, 5], [12, 5], [12, 15], [4, 15]], f);
      s.poly([[5, 7], [11, 7], [11, 13], [5, 13]], s.mat([[230, 140, 40], [255, 200, 90], [255, 240, 180]]));
      s.poly([[6, 2], [10, 2], [10, 5], [6, 5]], f); s.put(7, 1, f); s.put(8, 1, f);
      break;
    }
    case 'cake': {
      s.poly([[1, 7], [15, 7], [15, 14], [1, 14]], s.mat([[170, 120, 70], [214, 160, 96], [236, 200, 140]]));
      s.poly([[1, 5], [15, 5], [15, 9], [1, 9]], s.mat([[220, 216, 210], [248, 244, 238], [255, 255, 255]]));
      const ch = s.mat([[160, 20, 30], [210, 30, 40], [250, 110, 110]]);
      s.put(4, 4, ch); s.put(8, 3, ch); s.put(12, 4, ch);
      break;
    }
    default: s.disc(8, 8, 5, 5, s.mat([[255, 0, 255], [255, 0, 255], [255, 0, 255]]));
  }
  void r;
  return s.render();
}

function paintItem(name) {
  const r = rng(hashSeed('item:' + name));
  const parts = name.split('_');
  if (name.startsWith('block_')) return blockSprite(name.slice(6), r);
  if (name.startsWith('potion_')) return bottleSprite(POTION_COLORS[name.slice(7)] || [200, 0, 200], false);
  if (name.startsWith('splash_potion_')) return bottleSprite(POTION_COLORS[name.slice(14)] || [200, 0, 200], true);
  if (parts.length === 2 && MATERIAL[parts[0]] && ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].includes(parts[1])) {
    return toolSprite(parts[1], parts[0]);
  }
  const ARMOR = { leather: [[92, 54, 30], [140, 88, 52], [178, 124, 80]], golden: MATERIAL.golden, iron: MATERIAL.iron, diamond: MATERIAL.diamond };
  if (parts.length === 2 && ARMOR[parts[0]] && ['helmet', 'chestplate', 'leggings', 'boots'].includes(parts[1])) {
    const sp = new Sprite();
    const m = sp.mat(ARMOR[parts[0]]);
    if (parts[1] === 'helmet') { sp.poly([[3, 4], [5, 2], [11, 2], [13, 4], [13, 11], [10, 11], [10, 8], [6, 8], [6, 11], [3, 11]], m); }
    else if (parts[1] === 'chestplate') sp.poly([[2, 2], [6, 2], [7, 4], [9, 4], [10, 2], [14, 2], [14, 7], [12, 7], [12, 14], [4, 14], [4, 7], [2, 7]], m);
    else if (parts[1] === 'leggings') sp.poly([[3, 2], [13, 2], [13, 14], [10, 14], [9, 6], [7, 6], [6, 14], [3, 14]], m);
    else { sp.poly([[2, 6], [6, 6], [6, 10], [7, 10], [7, 14], [2, 14]], m); sp.poly([[10, 6], [14, 6], [14, 14], [9, 14], [9, 10], [10, 10]], m); }
    return sp.render();
  }
  const s = new Sprite();
  switch (name) {
    case 'stick': s.line(3, 13, 12, 4, s.mat(HANDLE), 1); s.line(4, 13, 12, 5, s.mat(HANDLE), 1); break;
    case 'coal': case 'charcoal': {
      const c = name === 'coal' ? [[20, 20, 22], [44, 44, 48], [84, 84, 90]] : [[30, 22, 16], [54, 40, 30], [96, 76, 60]];
      const m = s.mat(c);
      s.poly([[4, 6], [8, 3], [12, 5], [13, 10], [9, 13], [4, 11]], m);
      break;
    }
    case 'iron_ingot': case 'gold_ingot': case 'copper_ingot': {
      const c = name === 'iron_ingot' ? MATERIAL.iron : name === 'gold_ingot' ? MATERIAL.golden : [[140, 70, 40], [210, 120, 76], [250, 176, 130]];
      const m = s.mat(c);
      s.poly([[2, 9], [6, 5], [14, 5], [14, 8], [10, 12], [2, 12]], m);
      break;
    }
    case 'diamond': {
      const m = s.mat(MATERIAL.diamond);
      s.poly([[3, 6], [6, 3], [10, 3], [13, 6], [8, 13]], m);
      break;
    }
    case 'emerald': {
      const m = s.mat([[20, 120, 60], [60, 210, 110], [170, 255, 200]]);
      s.poly([[8, 2], [12, 6], [12, 10], [8, 14], [4, 10], [4, 6]], m);
      break;
    }
    case 'flint': s.poly([[5, 3], [10, 4], [12, 10], [8, 13], [4, 9]], s.mat([[30, 30, 34], [66, 64, 70], [120, 118, 126]])); break;
    case 'clay_ball': s.disc(8, 8.5, 5, 4.5, s.mat([[110, 116, 130], [158, 164, 178], [200, 206, 218]])); break;
    case 'brick': s.poly([[2, 8], [5, 5], [14, 5], [14, 8], [11, 11], [2, 11]], s.mat([[110, 50, 36], [168, 84, 62], [206, 120, 92]])); break;
    case 'string': {
      const m = s.mat([[180, 180, 180], [230, 230, 230], [255, 255, 255]]);
      for (let x = 2; x < 14; x++) s.put(x, Math.round(8 + Math.sin(x * 0.9) * 3), m);
      s.put(13, 4, m); s.put(12, 3, m);
      return s.render(false);
    }
    case 'feather': {
      const quill = s.mat([[180, 180, 170], [220, 220, 210], [250, 250, 240]]);
      const vane = s.mat([[200, 200, 206], [236, 236, 240], [255, 255, 255]]);
      s.poly([[5, 11], [11, 2], [14, 3], [8, 12]], vane);
      s.line(3, 14, 12, 3, quill);
      break;
    }
    case 'leather': s.poly([[3, 4], [7, 3], [9, 4], [13, 3], [12, 8], [13, 13], [8, 12], [3, 13], [4, 8]], s.mat([[100, 56, 30], [148, 88, 50], [180, 118, 72]])); break;
    case 'bone': {
      const m = s.mat([[190, 186, 170], [232, 228, 214], [255, 252, 240]]);
      s.line(4, 11, 11, 4, m, 2); s.disc(4, 12, 1.6, 1.6, m); s.disc(3, 11, 1.6, 1.6, m); s.disc(12, 4, 1.6, 1.6, m); s.disc(11, 3, 1.6, 1.6, m);
      break;
    }
    case 'snowball': s.disc(8, 8, 5, 5, s.mat([[190, 200, 214], [236, 242, 250], [255, 255, 255]])); break;
    case 'apple': {
      s.disc(8, 9.5, 5.2, 5, s.mat([[140, 16, 20], [206, 36, 36], [250, 110, 100]]));
      s.line(8, 2, 8, 4, s.mat(HANDLE));
      s.poly([[9, 3], [12, 2], [11, 4]], s.mat([[40, 100, 30], [70, 150, 50], [110, 190, 80]]));
      break;
    }
    case 'melon_slice': {
      s.poly([[2, 12], [8, 3], [14, 12]], s.mat([[170, 30, 36], [226, 64, 60], [255, 120, 110]]));
      s.line(2, 13, 14, 13, s.mat([[40, 100, 30], [80, 150, 40], [120, 190, 70]]), 1);
      const seed = s.mat([[20, 20, 20], [30, 30, 30], [60, 60, 60]]);
      s.put(7, 8, seed); s.put(9, 10, seed); s.put(6, 11, seed); s.put(10, 7, seed);
      break;
    }
    case 'raw_pork': case 'cooked_pork': {
      const raw = name.startsWith('raw');
      s.poly([[2, 7], [6, 4], [13, 5], [14, 9], [10, 12], [3, 11]], s.mat(raw ? [[200, 100, 110], [240, 150, 156], [255, 196, 200]] : [[120, 70, 40], [172, 112, 64], [210, 150, 96]]));
      s.line(4, 10, 11, 10, s.mat(raw ? [[230, 200, 200], [250, 230, 230], [255, 245, 245]] : [[200, 170, 120], [226, 200, 150], [240, 220, 180]]));
      break;
    }
    case 'raw_beef': case 'cooked_beef': {
      const raw = name.startsWith('raw');
      s.poly([[3, 5], [9, 3], [14, 6], [12, 12], [6, 13], [2, 10]], s.mat(raw ? [[140, 24, 28], [196, 50, 50], [230, 100, 96]] : [[70, 40, 24], [116, 72, 44], [156, 108, 70]]));
      s.line(5, 6, 10, 11, s.mat(raw ? [[220, 200, 196], [245, 230, 226], [255, 245, 240]] : [[170, 140, 100], [200, 170, 130], [220, 196, 160]]));
      break;
    }
    case 'raw_mutton': case 'cooked_mutton': {
      const raw = name.startsWith('raw');
      s.poly([[3, 4], [11, 3], [13, 9], [8, 13], [3, 10]], s.mat(raw ? [[160, 40, 44], [214, 80, 80], [240, 130, 126]] : [[96, 56, 30], [146, 94, 56], [186, 136, 90]]));
      s.line(10, 12, 14, 14, s.mat([[210, 206, 196], [236, 232, 222], [255, 252, 244]]), 1);
      break;
    }
    case 'raw_chicken': case 'cooked_chicken': {
      const raw = name.startsWith('raw');
      s.disc(9, 6.5, 4.5, 4, s.mat(raw ? [[210, 150, 140], [240, 190, 180], [255, 226, 216]] : [[150, 96, 40], [200, 140, 70], [236, 186, 110]]));
      s.line(3, 13, 6, 10, s.mat([[210, 206, 196], [236, 232, 222], [255, 252, 244]]), 1);
      s.put(2, 14, 1); s.put(3, 14, 1);
      break;
    }
    case 'tainted_flesh': s.poly([[3, 6], [7, 3], [12, 4], [13, 9], [9, 13], [4, 11]], s.mat([[80, 70, 40], [120, 104, 56], [150, 140, 80]])); {
      const spot = s.mat([[60, 90, 50], [80, 120, 60], [100, 140, 80]]);
      s.put(6, 7, spot); s.put(9, 9, spot); s.put(10, 6, spot);
    } break;
    case 'bucket': case 'water_bucket': case 'lava_bucket': {
      const metal = s.mat(MATERIAL.iron);
      s.poly([[3, 5], [13, 5], [12, 14], [4, 14]], metal);
      s.line(3, 4, 5, 2, metal); s.line(5, 2, 11, 2, metal); s.line(11, 2, 13, 4, metal);
      if (name !== 'bucket') {
        const liq = s.mat(name === 'water_bucket' ? [[30, 70, 200], [60, 110, 240], [140, 180, 255]] : [[200, 60, 10], [250, 130, 30], [255, 220, 110]]);
        s.line(4, 5, 12, 5, liq); s.line(4, 6, 12, 6, liq);
      }
      break;
    }
    case 'shears': {
      const m = s.mat(MATERIAL.iron), h = s.mat([[40, 40, 44], [70, 70, 76], [100, 100, 110]]);
      s.line(3, 12, 12, 3, m); s.line(5, 13, 13, 5, m);
      s.disc(3.5, 12.5, 2, 2, h); s.disc(12.5, 12.5, 2, 2, h);
      break;
    }
    case 'flint_and_steel': {
      const m = s.mat(MATERIAL.iron);
      s.line(3, 4, 7, 4, m); s.line(3, 4, 3, 9, m); s.line(3, 9, 7, 9, m);
      s.poly([[9, 8], [13, 9], [13, 13], [9, 13]], s.mat([[30, 30, 34], [66, 64, 70], [120, 118, 126]]));
      break;
    }
    case 'wheat_seeds': {
      const m = s.mat([[90, 110, 40], [140, 170, 70], [190, 210, 120]]);
      for (const [x, y] of [[4, 6], [8, 4], [11, 7], [6, 10], [10, 11], [3, 12], [13, 12]]) { s.put(x, y, m); s.put(x + 1, y, m); s.put(x, y + 1, m); }
      break;
    }
    case 'wheat': {
      const m = s.mat([[150, 110, 30], [214, 176, 60], [240, 214, 120]]);
      for (let i = 0; i < 4; i++) s.line(3 + i * 2, 14, 7 + i * 2, 3, m);
      s.line(5, 10, 11, 10, s.mat([[100, 60, 20], [140, 90, 40], [170, 120, 60]]));
      break;
    }
    case 'bread': s.poly([[2, 9], [5, 5], [11, 4], [14, 7], [13, 11], [4, 12]], s.mat([[140, 80, 30], [196, 130, 60], [230, 180, 100]])); break;
    case 'carrot': {
      s.poly([[4, 13], [11, 5], [13, 7], [6, 14]], s.mat([[180, 80, 10], [240, 130, 30], [255, 180, 80]]));
      s.line(11, 5, 14, 2, s.mat([[40, 110, 30], [70, 160, 50], [120, 200, 80]]));
      s.put(13, 5, 1); s.put(12, 3, 1);
      break;
    }
    case 'potato': s.disc(8, 8.5, 5, 4.2, s.mat([[150, 110, 60], [200, 160, 100], [230, 200, 140]])); break;
    case 'baked_potato': {
      s.disc(8, 8.5, 5, 4.2, s.mat([[140, 80, 30], [200, 130, 60], [236, 180, 100]]));
      s.line(5, 8, 11, 8, s.mat([[240, 220, 140], [250, 236, 170], [255, 250, 200]]));
      break;
    }
    case 'bone_meal': s.poly([[3, 12], [6, 7], [10, 6], [13, 12]], s.mat([[200, 200, 196], [236, 236, 232], [255, 255, 252]])); break;
    case 'bow': {
      const wood = s.mat(HANDLE);
      for (let a = -Math.PI / 2; a <= 0.01; a += 0.05) s.put(Math.round(2 + Math.cos(a) * 11), Math.round(14 + Math.sin(a) * 11), wood);
      const str = s.mat([[200, 200, 200], [230, 230, 230], [255, 255, 255]]);
      s.line(3, 3, 13, 13, str);
      return s.render(true);
    }
    case 'arrow': {
      s.line(3, 12, 11, 4, s.mat(HANDLE));
      s.poly([[10, 3], [13, 2], [12, 5]], s.mat(MATERIAL.stone));
      const f = s.mat([[200, 200, 200], [236, 236, 236], [255, 255, 255]]);
      s.put(2, 12, f); s.put(3, 13, f); s.put(2, 13, f); s.put(4, 14, f);
      break;
    }
    case 'paper': s.poly([[3, 3], [12, 2], [13, 13], [4, 14]], s.mat([[200, 200, 190], [240, 238, 228], [255, 255, 250]])); break;
    case 'book': {
      s.poly([[3, 3], [12, 3], [12, 13], [3, 13]], s.mat([[100, 50, 30], [150, 80, 50], [190, 120, 80]]));
      s.line(4, 12, 12, 12, s.mat([[220, 214, 200], [240, 236, 226], [255, 255, 250]]));
      s.line(5, 5, 10, 5, s.mat([[200, 170, 60], [230, 200, 90], [250, 230, 140]]));
      break;
    }
    case 'clock': {
      s.disc(8, 8, 6, 6, s.mat(MATERIAL.golden));
      s.disc(8, 8, 4.4, 4.4, s.mat([[40, 60, 120], [70, 100, 180], [120, 150, 220]]));
      s.poly([[4, 8], [12, 8], [12, 12], [4, 12]], s.mat([[60, 130, 60], [90, 170, 90], [140, 210, 140]]));
      s.put(8, 5, s.mat([[240, 220, 90], [255, 240, 120], [255, 250, 180]]));
      break;
    }
    case 'compass': {
      s.disc(8, 8, 6, 6, s.mat(MATERIAL.iron));
      s.disc(8, 8, 4.4, 4.4, s.mat([[190, 190, 180], [220, 220, 210], [240, 240, 232]]));
      s.line(8, 4, 8, 8, s.mat([[160, 20, 20], [220, 40, 40], [250, 90, 90]]));
      s.line(8, 9, 8, 11, s.mat([[60, 60, 60], [90, 90, 90], [120, 120, 120]]));
      break;
    }
    case 'ember_dust': s.poly([[3, 12], [7, 6], [9, 6], [13, 12]], s.mat([[200, 90, 20], [255, 150, 40], [255, 220, 120]])); break;
    case 'quartz': s.poly([[5, 13], [4, 7], [8, 2], [11, 6], [11, 12]], s.mat([[190, 186, 178], [232, 228, 220], [255, 255, 250]])); break;
    case 'gold_nugget': s.poly([[5, 10], [7, 6], [11, 7], [11, 11], [7, 12]], s.mat(MATERIAL.golden)); break;
    case 'ember_brick': s.poly([[2, 8], [5, 5], [14, 5], [14, 8], [11, 11], [2, 11]], s.mat([[60, 20, 20], [110, 36, 34], [150, 60, 50]])); break;
    case 'egg': s.disc(8, 8.5, 4, 5.2, s.mat([[200, 180, 150], [236, 220, 196], [255, 245, 230]])); break;
    case 'spark_dust': {
      const m = s.mat([[140, 16, 12], [220, 36, 26], [255, 120, 100]]);
      s.poly([[3, 12], [6, 8], [9, 9], [13, 12], [9, 13]], m);
      for (const [x, y] of [[5, 6], [10, 6], [12, 9], [3, 9]]) s.put(x, y, m);
      break;
    }
    case 'minecart': {
      const m = s.mat(MATERIAL.iron);
      s.poly([[1, 5], [15, 5], [14, 11], [2, 11]], m);
      s.poly([[3, 6], [13, 6], [12, 8], [4, 8]], s.mat([[40, 40, 44], [60, 60, 66], [80, 80, 88]]));
      const w = s.mat([[30, 30, 34], [60, 60, 66], [90, 90, 96]]);
      s.disc(4.5, 12.5, 1.8, 1.8, w); s.disc(11.5, 12.5, 1.8, 1.8, w);
      break;
    }
    case 'boat': {
      const m = s.mat([[110, 78, 40], [156, 118, 70], [190, 152, 100]]);
      s.poly([[1, 7], [15, 7], [12, 12], [4, 12]], m);
      s.line(2, 7, 14, 7, s.mat(HANDLE));
      s.line(5, 4, 8, 7, s.mat(HANDLE)); s.line(11, 4, 8, 7, s.mat(HANDLE));
      break;
    }
    case 'glass_bottle': {
      const g = s.mat(GLASS);
      s.disc(8, 10, 5.2, 5, g); s.poly([[7, 2], [9, 2], [9, 6], [7, 6]], g);
      s.disc(8, 10.6, 3.6, 3.2, s.mat([[220, 230, 240], [236, 242, 250], [250, 252, 255]]));
      break;
    }
    case 'sugar': s.poly([[3, 12], [6, 8], [10, 8], [13, 12]], s.mat([[220, 220, 224], [244, 244, 248], [255, 255, 255]])); break;
    case 'glistering_melon': {
      s.poly([[2, 12], [8, 3], [14, 12]], s.mat([[200, 140, 40], [250, 200, 70], [255, 240, 160]]));
      s.line(2, 13, 14, 13, s.mat(MATERIAL.golden), 1);
      break;
    }
    case 'golden_carrot': {
      s.poly([[4, 13], [11, 5], [13, 7], [6, 14]], s.mat(MATERIAL.golden));
      s.line(11, 5, 14, 2, s.mat([[40, 110, 30], [70, 160, 50], [120, 200, 80]]));
      break;
    }
    case 'crawler_eye': case 'fermented_crawler_eye': {
      const f = name.startsWith('ferm');
      s.disc(8, 8.5, 5, 4.5, s.mat(f ? [[110, 60, 50], [150, 90, 70], [190, 130, 110]] : [[120, 20, 30], [190, 40, 50], [240, 110, 110]]));
      s.disc(8, 8, 2, 2, s.mat([[10, 10, 10], [20, 20, 20], [40, 40, 40]]));
      if (f) s.line(4, 4, 12, 12, s.mat([[60, 40, 30], [80, 56, 40], [100, 70, 50]]));
      break;
    }
    case 'imp_horn': s.poly([[4, 13], [6, 13], [12, 3], [11, 2]], s.mat([[120, 30, 20], [180, 60, 30], [230, 120, 60]])); break;
    case 'blast_powder': {
      const m = s.mat([[50, 50, 54], [80, 80, 86], [120, 120, 128]]);
      s.poly([[3, 12], [6, 7], [10, 7], [13, 12]], m);
      for (const [x, y] of [[5, 5], [11, 6], [8, 4]]) s.put(x, y, m);
      break;
    }
    case 'milk_bucket': {
      const metal = s.mat(MATERIAL.iron);
      s.poly([[3, 5], [13, 5], [12, 14], [4, 14]], metal);
      s.line(3, 4, 5, 2, metal); s.line(5, 2, 11, 2, metal); s.line(11, 2, 13, 4, metal);
      const milk = s.mat([[220, 220, 220], [250, 250, 250], [255, 255, 255]]);
      s.line(4, 5, 12, 5, milk); s.line(4, 6, 12, 6, milk);
      break;
    }
    case 'golden_apple': {
      s.disc(8, 9.5, 5.2, 5, s.mat(MATERIAL.golden));
      s.line(8, 2, 8, 4, s.mat(HANDLE));
      s.poly([[9, 3], [12, 2], [11, 4]], s.mat([[40, 100, 30], [70, 150, 50], [110, 190, 80]]));
      break;
    }
    case 'resin': s.disc(8, 9, 4.5, 4, s.mat([[180, 100, 20], [230, 150, 40], [255, 210, 120]])); break;
    case 'iron_nugget': s.poly([[5, 10], [7, 6], [11, 7], [11, 11], [7, 12]], s.mat(MATERIAL.iron)); break;
    case 'void_pearl': {
      s.disc(8, 8, 5, 5, s.mat([[20, 60, 70], [40, 110, 120], [120, 200, 200]]));
      s.disc(8, 8, 2.2, 2.2, s.mat([[10, 30, 34], [16, 46, 50], [30, 70, 76]]));
      break;
    }
    case 'star_eye': {
      s.disc(8, 8, 5, 5, s.mat([[40, 90, 70], [70, 150, 110], [150, 220, 180]]));
      s.disc(8, 8, 2.4, 2.4, s.mat([[20, 20, 60], [40, 40, 120], [150, 150, 255]]));
      s.put(8, 8, s.mat([[255, 255, 230], [255, 255, 230], [255, 255, 255]]));
      break;
    }
    case 'void_fruit': case 'popped_void_fruit': {
      const p = name.startsWith('popped');
      s.disc(8, 9, 5, 5, s.mat(p ? [[150, 110, 180], [200, 160, 230], [240, 220, 255]] : [[80, 40, 100], [130, 80, 160], [190, 140, 220]]));
      for (const [x, y] of [[6, 7], [10, 8], [8, 11]]) s.put(x, y, s.mat([[50, 20, 70], [70, 30, 90], [100, 50, 120]]));
      break;
    }
    case 'glider': {
      const m = s.mat([[110, 90, 150], [160, 140, 200], [210, 196, 240]]);
      s.poly([[8, 3], [2, 6], [1, 14], [7, 9]], m); s.poly([[8, 3], [14, 6], [15, 14], [9, 9]], m);
      s.line(8, 3, 8, 9, s.mat([[70, 60, 100], [90, 80, 130], [120, 110, 160]]));
      break;
    }
    case 'fishing_rod': {
      s.line(2, 14, 13, 2, s.mat(HANDLE), 1);
      const str = s.mat([[200, 200, 200], [230, 230, 230], [255, 255, 255]]);
      s.line(13, 2, 13, 10, str); s.put(12, 11, s.mat(MATERIAL.iron)); s.put(13, 11, s.mat(MATERIAL.iron));
      return s.render(true);
    }
    case 'raw_silverfin': case 'cooked_silverfin': case 'raw_rosefin': case 'cooked_rosefin': case 'pufferfish': case 'glimmerfish': {
      const cooked = name.startsWith('cooked');
      const base = name.includes('silverfin') ? [[110, 120, 130], [170, 180, 190], [220, 228, 236]]
        : name.includes('rosefin') ? [[150, 60, 60], [210, 110, 100], [250, 170, 150]]
          : name === 'pufferfish' ? [[180, 150, 40], [230, 200, 70], [255, 240, 150]] : [[40, 120, 200], [80, 180, 240], [200, 240, 255]];
      const c = cooked ? [[120, 70, 30], [170, 110, 60], [210, 160, 100]] : base;
      if (name === 'pufferfish') { s.disc(8, 8, 5, 5, s.mat(c)); for (const [x, y] of [[3, 3], [13, 3], [3, 13], [13, 13], [8, 2], [8, 14]]) s.put(x, y, s.mat(c)); }
      else { s.disc(7, 8, 5, 3.2, s.mat(c)); s.poly([[11, 8], [15, 5], [15, 11]], s.mat(c)); }
      s.put(4, 7, s.mat([[10, 10, 10], [20, 20, 20], [30, 30, 30]]));
      break;
    }
    case 'empty_map': case 'filled_map': {
      s.poly([[2, 2], [14, 2], [14, 14], [2, 14]], s.mat([[180, 170, 130], [220, 210, 170], [240, 232, 200]]));
      if (name === 'filled_map') {
        s.poly([[4, 5], [9, 4], [11, 8], [6, 11], [4, 9]], s.mat([[70, 130, 60], [100, 170, 80], [140, 200, 110]]));
        s.poly([[9, 9], [12, 9], [12, 12], [9, 12]], s.mat([[50, 90, 180], [80, 120, 210], [120, 160, 240]]));
      } else s.disc(8, 8, 2.5, 2.5, s.mat(MATERIAL.iron));
      break;
    }
    case 'shield': {
      s.poly([[3, 2], [13, 2], [13, 9], [8, 14], [3, 9]], s.mat([[110, 78, 40], [156, 118, 70], [190, 152, 100]]));
      s.line(8, 2, 8, 13, s.mat(MATERIAL.iron)); s.line(3, 6, 13, 6, s.mat(MATERIAL.iron));
      break;
    }
    case 'bowl': s.poly([[2, 7], [14, 7], [12, 12], [4, 12]], s.mat([[110, 78, 40], [156, 118, 70], [190, 152, 100]])); break;
    case 'mushroom_stew': {
      s.poly([[2, 7], [14, 7], [12, 12], [4, 12]], s.mat([[110, 78, 40], [156, 118, 70], [190, 152, 100]]));
      s.line(3, 7, 13, 7, s.mat([[150, 100, 60], [190, 140, 90], [220, 180, 130]]));
      break;
    }
    default: s.disc(8, 8, 5, 5, s.mat([[255, 0, 255], [255, 0, 255], [255, 0, 255]]));
  }
  void r;
  return s.render();
}

export function generateItemTextures() {
  return ITEM_TEXTURES.map((name) => ({ name, data: paintItem(name).d }));
}
