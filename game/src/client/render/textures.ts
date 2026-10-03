/**
 * Procedural texture generation (ASSET REPLACEMENT POINT).
 * Every texture used by the game is generated here at startup from tileable noise,
 * so no third-party art is required. Swap any generator for a loaded image later.
 */
import * as THREE from 'three';

function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise on a period-P lattice. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (a: number) => ((a % period) + period) % period;
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbmTile(x: number, y: number, period: number, oct: number, seed: number): number {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * vnoise(x * f, y * f, period * f, seed + o * 17);
    n += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / n;
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeCanvas(size: number) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = (c as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
  return { c, ctx };
}

function fromPixels(size: number, fn: (x: number, y: number) => [number, number, number, number?], srgb = true, repeat = true): THREE.Texture {
  const { c, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b, a] = fn(x, y);
    const i = (y * size + x) * 4;
    img.data[i] = r * 255; img.data[i + 1] = g * 255; img.data[i + 2] = b * 255; img.data[i + 3] = (a ?? 1) * 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c as HTMLCanvasElement);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Height field -> tangent-space normal map. */
function normalFromHeight(size: number, h: (x: number, y: number) => number, strength: number): THREE.Texture {
  const hm = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) hm[y * size + x] = h(x, y);
  const at = (x: number, y: number) => hm[((y + size) % size) * size + ((x + size) % size)]!;
  return fromPixels(size, (x, y) => {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l) * 0.5 + 0.5, (-dy / l) * 0.5 + 0.5, (1 / l) * 0.5 + 0.5];
  }, false);
}

export interface TextureSet {
  sand: THREE.Texture; grass: THREE.Texture; rock: THREE.Texture; dirt: THREE.Texture; terrainNormal: THREE.Texture;
  waterNormal: THREE.Texture; foam: THREE.Texture; noise: THREE.Texture;
  palmLeaf: THREE.Texture; broadLeaf: THREE.Texture; grassBlade: THREE.Texture; bark: THREE.Texture;
  thatch: THREE.Texture; wood: THREE.Texture; brick: THREE.Texture; stone: THREE.Texture; cloth: THREE.Texture; metal: THREE.Texture;
  particle: THREE.Texture; cloudNoise: THREE.Texture;
}

let cached: TextureSet | null = null;

export function textures(): TextureSet {
  if (cached) return cached;
  const S = 256;
  const P = 8; // noise period in lattice cells across the texture
  const sand = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * P, y / S * P, P, 5, 1);
    const grain = hash(x, y, 9) * 0.12;
    const ripple = Math.sin((x / S + fbmTile(x / S * 4, y / S * 4, 4, 2, 2) * 0.4) * Math.PI * 2 * 12) * 0.03;
    const c = mix([0.82, 0.74, 0.58], [0.93, 0.87, 0.72], n);
    const k = 0.94 + grain + ripple;
    return [c[0] * k, c[1] * k, c[2] * k];
  });
  const grass = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * P, y / S * P, P, 5, 3);
    const m = fbmTile(x / S * 2, y / S * 2, 2, 3, 4);
    const blade = hash(x, y, 5) * 0.18;
    const c = mix(mix([0.2, 0.36, 0.1], [0.36, 0.5, 0.16], n), [0.45, 0.42, 0.2], clamp01(m * 1.4 - 0.55));
    return [c[0] * (0.88 + blade), c[1] * (0.88 + blade), c[2] * (0.88 + blade)];
  });
  const rock = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * P, y / S * P, P, 6, 6);
    const cr = Math.abs(fbmTile(x / S * 4, y / S * 4, 4, 3, 7) - 0.5) < 0.025 ? 0.65 : 1;
    const strata = Math.sin(y / S * Math.PI * 2 * 6 + n * 4) * 0.05;
    const c = mix([0.36, 0.34, 0.31], [0.58, 0.55, 0.5], n);
    return [c[0] * cr + strata, c[1] * cr + strata, c[2] * cr + strata];
  });
  const dirt = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * P, y / S * P, P, 5, 8);
    const c = mix([0.3, 0.22, 0.14], [0.46, 0.34, 0.22], n);
    const peb = hash(x, y, 2) > 0.985 ? 1.3 : 1;
    return [c[0] * peb, c[1] * peb, c[2] * peb];
  });
  const terrainNormal = normalFromHeight(S, (x, y) => fbmTile(x / S * P, y / S * P, P, 6, 11), 2.4);
  const waterNormal = normalFromHeight(S, (x, y) => {
    const a = fbmTile(x / S * 6, y / S * 6, 6, 4, 21);
    const b = fbmTile(x / S * 12 + 3, y / S * 12, 12, 3, 22);
    return a * 0.7 + b * 0.3;
  }, 3.2);
  const foam = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * 8, y / S * 8, 8, 5, 31);
    const cells = fbmTile(x / S * 16, y / S * 16, 16, 2, 32);
    const v = clamp01((n - 0.45) * 3) * clamp01((cells - 0.3) * 3);
    return [v, v, v, 1];
  }, false);
  const noise = fromPixels(S, (x, y) => [fbmTile(x / S * 4, y / S * 4, 4, 5, 41), fbmTile(x / S * 8, y / S * 8, 8, 4, 42), fbmTile(x / S * 16, y / S * 16, 16, 3, 43), hash(x, y, 44)], false);
  const cloudNoise = fromPixels(S, (x, y) => [fbmTile(x / S * 4, y / S * 4, 4, 6, 51), fbmTile(x / S * 8, y / S * 8, 8, 6, 52), fbmTile(x / S * 2, y / S * 2, 2, 5, 53), 1], false);

  // palm frond: a central rib with many narrow leaflets, alpha-tested
  const palmLeaf = fromPixels(S, (x, y) => {
    const u = x / S, v = y / S; // v along frond
    const rib = Math.abs(u - 0.5);
    const width = 0.48 * Math.sin(Math.PI * Math.min(1, v * 1.05)) ** 0.7;
    const leaflet = Math.abs(((v * 26 + rib * 7) % 1) - 0.5) < 0.38;
    const inside = rib < width && (leaflet || rib < 0.035);
    const shade = 0.75 + 0.25 * fbmTile(u * 8, v * 8, 8, 3, 61);
    const col = rib < 0.03 ? [0.55, 0.6, 0.25] : mix([0.17, 0.38, 0.1], [0.36, 0.58, 0.18], v * 0.6 + rib);
    return [col[0]! * shade, col[1]! * shade, col[2]! * shade, inside ? 1 : 0];
  }, true, false);
  const broadLeaf = fromPixels(S, (x, y) => {
    // cluster of several leaves on one card
    let a = 0, shade = 0;
    for (let k = 0; k < 7; k++) {
      const cx = 0.2 + hash(k, 1, 70) * 0.6, cy = 0.2 + hash(k, 2, 70) * 0.6, ang = hash(k, 3, 70) * Math.PI * 2;
      const dx = x / S - cx, dy = y / S - cy;
      const lx = dx * Math.cos(ang) + dy * Math.sin(ang), ly = -dx * Math.sin(ang) + dy * Math.cos(ang);
      const e = (lx / 0.2) ** 2 + (ly / 0.09) ** 2;
      if (e < 1) { a = 1; shade = Math.max(shade, 0.65 + 0.35 * (1 - e) + (Math.abs(ly) < 0.006 ? 0.15 : 0)); }
    }
    const c = mix([0.12, 0.3, 0.08], [0.3, 0.52, 0.16], fbmTile(x / S * 6, y / S * 6, 6, 3, 71));
    return [c[0] * shade, c[1] * shade, c[2] * shade, a];
  }, true, false);
  const grassBlade = fromPixels(128, (x, y) => {
    const u = x / 128, v = 1 - y / 128;
    let a = 0;
    for (let k = 0; k < 9; k++) {
      const base = 0.08 + hash(k, 0, 80) * 0.84, lean = (hash(k, 1, 80) - 0.5) * 0.3, h = 0.55 + hash(k, 2, 80) * 0.45;
      const cx = base + lean * v * v;
      const w = 0.035 * (1 - v / h);
      if (v < h && Math.abs(u - cx) < w) a = 1;
    }
    const c = mix([0.12, 0.26, 0.06], [0.5, 0.62, 0.24], v);
    return [c[0], c[1], c[2], a];
  }, true, false);
  const bark = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * 4, y / S * 16, 4, 5, 90);
    const ring = Math.abs(Math.sin(y / S * Math.PI * 2 * 18 + n * 3)) < 0.18 ? 0.7 : 1;
    const c = mix([0.3, 0.22, 0.15], [0.52, 0.4, 0.28], n);
    return [c[0] * ring, c[1] * ring, c[2] * ring];
  });
  const thatch = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * 32, y / S * 2, 32, 3, 100);
    const strand = 0.7 + 0.3 * Math.sin(x / S * Math.PI * 2 * 64 + n * 8);
    const row = (y / S * 8) % 1 < 0.08 ? 0.55 : 1;
    const c = mix([0.55, 0.45, 0.22], [0.8, 0.7, 0.4], n);
    return [c[0] * strand * row, c[1] * strand * row, c[2] * strand * row];
  });
  const wood = fromPixels(S, (x, y) => {
    const board = Math.floor(y / S * 4);
    const n = fbmTile(x / S * 2 + board * 3.1, y / S * 24, 2, 4, 110 + board);
    const grain = 0.82 + 0.18 * Math.sin((y / S * 4 % 1) * 40 + n * 12);
    const gap = (y / S * 4) % 1 < 0.04 ? 0.35 : 1;
    const nail = ((x / S * 2) % 1 < 0.02 || (x / S * 2) % 1 > 0.98) && Math.abs(((y / S * 4) % 1) - 0.5) < 0.05 ? 0.4 : 1;
    const c = mix([0.42, 0.28, 0.16], [0.64, 0.45, 0.27], n);
    return [c[0] * grain * gap * nail, c[1] * grain * gap * nail, c[2] * grain * gap * nail];
  });
  const brick = fromPixels(S, (x, y) => {
    const row = Math.floor(y / S * 8);
    const bx = (x / S * 4 + (row % 2) * 0.5) % 1, by = (y / S * 8) % 1;
    const mortar = bx < 0.05 || by < 0.1;
    const n = fbmTile(x / S * 8, y / S * 8, 8, 4, 120);
    const tint = hash(Math.floor(x / S * 4 + (row % 2) * 0.5), row, 121) * 0.2;
    if (mortar) return [0.62 + n * 0.1, 0.58 + n * 0.1, 0.52 + n * 0.1];
    const c = mix([0.5, 0.2, 0.12], [0.68, 0.33, 0.2], n);
    return [c[0] - tint * 0.3, c[1] - tint * 0.2, c[2] - tint * 0.1];
  });
  const stone = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * P, y / S * P, P, 5, 130);
    const c = mix([0.42, 0.42, 0.4], [0.62, 0.6, 0.56], n);
    return c;
  });
  const cloth = fromPixels(S, (x, y) => {
    const weave = 0.85 + 0.15 * ((x + y) % 4 < 2 ? 1 : 0.6);
    const n = fbmTile(x / S * 4, y / S * 4, 4, 4, 140);
    const c = mix([0.72, 0.68, 0.58], [0.88, 0.85, 0.76], n);
    return [c[0] * weave, c[1] * weave, c[2] * weave];
  });
  const metal = fromPixels(S, (x, y) => {
    const n = fbmTile(x / S * P, y / S * P, P, 5, 150);
    const rust = clamp01((fbmTile(x / S * 4, y / S * 4, 4, 4, 151) - 0.55) * 4);
    const c = mix(mix([0.45, 0.48, 0.5], [0.62, 0.65, 0.68], n), [0.45, 0.22, 0.1], rust);
    return c;
  });
  const particle = fromPixels(64, (x, y) => {
    const d = Math.hypot(x - 31.5, y - 31.5) / 32;
    const a = clamp01(1 - d) ** 2;
    return [1, 1, 1, a];
  }, false, false);

  for (const t of [sand, grass, rock, dirt, bark, thatch, wood, brick, stone, cloth, metal]) t.anisotropy = 8;
  cached = { sand, grass, rock, dirt, terrainNormal, waterNormal, foam, noise, palmLeaf, broadLeaf, grassBlade, bark, thatch, wood, brick, stone, cloth, metal, particle, cloudNoise };
  return cached;
}

export function setAnisotropy(level: number): void {
  const t = textures();
  for (const k of ['sand', 'grass', 'rock', 'dirt', 'bark', 'thatch', 'wood', 'brick', 'stone', 'cloth', 'metal'] as const) {
    t[k].anisotropy = level;
    t[k].needsUpdate = true;
  }
}
