// Box models for creatures and the player, their procedurally painted skins,
// and mesh builders for held/dropped items. All designs are original.
import { skinBox, cubeMesh } from './renderer.js';
import { rng } from './noise.js';
import { faceTexture, RENDER_TYPE, RENDER, BLOCKS, TINT } from './blocks.js';
import { ITEMS } from './items.js';

export const SKIN = { PLAYER: 0, PIG: 1, COW: 2, SHEEP: 3, CHICKEN: 4, GHOUL: 5, SHEEP_WOOL: 6 };
const SKIN_COUNT = 7;

// ---------------------------------------------------------------------------
// Skin painting helpers (64x64 RGBA)
class Skin {
  constructor(seed) { this.d = new Uint8ClampedArray(64 * 64 * 4); this.r = rng(seed); }
  px(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x >= 64 || y >= 64) return;
    const i = (y * 64 + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a;
  }
  // Paint every face of a box-unwrapped part. fn(face, x, y, w, h) -> color
  box(u, v, w, h, d, fn) {
    const rects = {
      top: [u + d, v, w, d], bottom: [u + d + w, v, w, d],
      right: [u, v + d, d, h], front: [u + d, v + d, w, h],
      left: [u + d + w, v + d, d, h], back: [u + d + w + d, v + d, w, h],
    };
    for (const [face, [rx, ry, rw, rh]] of Object.entries(rects)) {
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const c = fn(face, x, y, rw, rh);
        if (c) this.px(rx + x, ry + y, c, c[3] ?? 255);
      }
    }
  }
  vary(c, amt = 0.08) {
    const f = 1 + (this.r() - 0.5) * 2 * amt;
    return [c[0] * f, c[1] * f, c[2] * f];
  }
}

const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function paintPlayer() {
  const s = new Skin(11);
  const skin = [226, 180, 142], hair = [92, 58, 34], jacket = [214, 92, 40], jacketD = [168, 66, 30];
  const pants = [64, 68, 78], boots = [96, 64, 40], scarf = [52, 150, 140];
  // head 8x8x8 at (0,0)
  s.box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'top') return s.vary(hair, 0.1);
    if (f === 'bottom') return skin;
    if (f === 'back') return y < 7 ? s.vary(hair, 0.1) : skin;
    if (f === 'left' || f === 'right') return y < 3 || (y < 5 && (f === 'right' ? x < 5 : x > 2)) ? s.vary(hair, 0.1) : s.vary(skin, 0.03);
    // face
    if (y < 2) return s.vary(hair, 0.1);
    if (y === 2 && (x < 2 || x > 5)) return s.vary(hair, 0.1);
    if (y === 3 && (x === 1 || x === 6)) return [70, 44, 26];
    if (y === 4 && (x === 1 || x === 6)) return [245, 245, 245];
    if (y === 4 && (x === 2 || x === 5)) return [60, 130, 90];
    if (y === 5 && (x === 3 || x === 4)) return mixc(skin, [150, 90, 70], 0.4);
    if (y === 6 && x >= 2 && x <= 5) return x === 2 || x === 5 ? skin : [150, 86, 72];
    return s.vary(skin, 0.03);
  });
  // body 8x12x4 at (16,16)
  s.box(16, 16, 8, 12, 4, (f, x, y, w) => {
    if (f === 'top') return scarf;
    if (f === 'bottom') return pants;
    if (y < 2) return s.vary(scarf, 0.06);
    if (y === 9) return [50, 36, 26];
    if (y > 9) return s.vary(pants, 0.05);
    if (f === 'front' && (x === 3 || x === 4)) return jacketD;
    if (f === 'front' && y === 5 && (x === 1 || x === 6)) return [230, 200, 80];
    return s.vary(jacket, 0.05);
  });
  // arm 4x12x4 at (40,16)
  s.box(40, 16, 4, 12, 4, (f, x, y) => {
    if (f === 'top') return jacket;
    if (f === 'bottom') return skin;
    if (y >= 9) return s.vary(skin, 0.03);
    if (y === 8) return jacketD;
    return s.vary(jacket, 0.05);
  });
  // leg 4x12x4 at (0,16)
  s.box(0, 16, 4, 12, 4, (f, x, y) => {
    if (f === 'top') return pants;
    if (f === 'bottom') return [60, 40, 26];
    if (y >= 9) return s.vary(boots, 0.06);
    return s.vary(pants, 0.05);
  });
  return s.d;
}

function paintPig() {
  const s = new Skin(21);
  const pink = [236, 164, 160], pinkD = [210, 130, 132], snout = [220, 128, 136];
  // head 8x7x7 at (0,0)
  s.box(0, 0, 8, 7, 7, (f, x, y) => {
    if (f !== 'front') return s.vary(pink, 0.05);
    if (y === 2 && (x === 1 || x === 6)) return [30, 26, 30];
    if (y === 2 && (x === 2 || x === 5)) return [250, 250, 250];
    return s.vary(pink, 0.04);
  });
  // snout 4x3x1 at (30,0)
  s.box(30, 0, 4, 3, 1, (f, x, y) => (f === 'front' && y === 1 && (x === 0 || x === 3) ? [120, 60, 70] : snout));
  // ears 2x2x1 at (40,0)
  s.box(40, 0, 2, 2, 1, () => pinkD);
  // body 10x9x13 at (0,16)
  s.box(0, 16, 10, 9, 13, (f, x, y) => {
    const spot = ((x * 7 + y * 13) % 17 === 0);
    return spot ? pinkD : s.vary(pink, 0.05);
  });
  // leg 4x6x4 at (48,0)
  s.box(48, 0, 4, 6, 4, (f, x, y) => (y >= 5 ? [150, 90, 90] : s.vary(pinkD, 0.04)));
  // tail 1x1x3 at (56,16)
  s.box(56, 16, 1, 1, 3, () => pinkD);
  return s.d;
}

function paintCow() {
  const s = new Skin(31);
  const tan = [196, 146, 92], dark = [120, 76, 44], cream = [236, 220, 190], muzzle = [70, 50, 44];
  // head 8x8x6 at (0,0)
  s.box(0, 0, 8, 8, 6, (f, x, y) => {
    if (f === 'front') {
      if (y >= 5) return y === 6 && (x === 2 || x === 5) ? [30, 20, 20] : s.vary(muzzle, 0.05);
      if (y === 2 && (x === 1 || x === 6)) return [20, 16, 16];
      if (y === 2 && (x === 2 || x === 5)) return [240, 236, 230];
      if (x >= 3 && x <= 4 && y < 5) return cream;
    }
    return s.vary(tan, 0.05);
  });
  // horn 1x3x1 at (28,0)
  s.box(28, 0, 1, 3, 1, (f, x, y) => (y === 0 ? [90, 80, 70] : [230, 220, 196]));
  // body 12x10x16 at (0,16)
  s.box(0, 16, 12, 10, 16, (f, x, y, w, h) => {
    if (f === 'top') return x >= 5 && x <= 6 ? s.vary(dark, 0.05) : s.vary(tan, 0.05);
    if (f === 'bottom') return cream;
    if ((f === 'left' || f === 'right') && y > h - 3) return s.vary(cream, 0.04);
    return s.vary(tan, 0.06);
  });
  // leg 4x10x4 at (48,0)
  s.box(48, 0, 4, 10, 4, (f, x, y) => (y >= 8 ? [50, 40, 36] : s.vary(tan, 0.05)));
  // udder 4x2x3 at (48,20)
  s.box(48, 20, 4, 2, 3, () => [236, 170, 170]);
  return s.d;
}

function paintSheep() {
  const s = new Skin(41);
  const face = [58, 54, 56], wool = [236, 234, 228];
  // head 6x7x7 at (0,0)
  s.box(0, 0, 6, 7, 7, (f, x, y) => {
    if (f === 'front' && y === 2 && (x === 1 || x === 4)) return [230, 200, 80];
    if (f === 'front' && y === 5 && (x === 2 || x === 3)) return [36, 34, 36];
    if (f === 'top' || (f !== 'front' && y < 2)) return s.vary(wool, 0.05);
    return s.vary(face, 0.06);
  });
  // ear 3x1x2 at (28,0)
  s.box(28, 0, 3, 1, 2, () => face);
  // body (shorn) 8x8x13 at (0,16)
  s.box(0, 16, 8, 8, 13, () => s.vary([214, 196, 180], 0.05));
  // leg 3x9x3 at (48,0)
  s.box(48, 0, 3, 9, 3, (f, x, y) => (y < 3 ? s.vary(wool, 0.05) : s.vary(face, 0.06)));
  return s.d;
}

function paintSheepWool() {
  const s = new Skin(43);
  const wool = [236, 234, 228];
  s.box(0, 16, 12, 11, 16, (f, x, y) => {
    const n = ((x * 5 + y * 3) % 7 === 0) ? 0.9 : ((x + y * 2) % 5 === 0 ? 1.04 : 1);
    return s.vary([wool[0] * n, wool[1] * n, wool[2] * n], 0.04);
  });
  s.box(0, 0, 7, 3, 6, () => s.vary(wool, 0.05));
  return s.d;
}

function paintChicken() {
  const s = new Skin(51);
  const brown = [170, 104, 56], light = [214, 160, 100], comb = [220, 40, 36], beak = [236, 180, 50];
  // head 4x5x3 at (0,0)
  s.box(0, 0, 4, 5, 3, (f, x, y) => {
    if (f === 'front' && y === 1 && (x === 0 || x === 3)) return [20, 16, 16];
    return s.vary(light, 0.06);
  });
  // beak 2x2x2 at (16,0)
  s.box(16, 0, 2, 2, 2, () => beak);
  // comb 1x2x3 at (16,8)
  s.box(16, 8, 1, 2, 3, () => comb);
  // body 6x7x7 at (0,16)
  s.box(0, 16, 6, 7, 7, (f, x, y) => {
    const speck = (x * 3 + y * 5) % 4 === 0;
    return speck ? light : s.vary(brown, 0.08);
  });
  // wing 1x5x6 at (32,16)
  s.box(32, 16, 1, 5, 6, (f, x, y) => (y % 2 ? s.vary([140, 82, 42], 0.05) : s.vary(brown, 0.05)));
  // leg 1x5x1 at (40,0)
  s.box(40, 0, 1, 5, 1, () => beak);
  return s.d;
}

function paintGhoul() {
  const s = new Skin(61);
  const skin = [150, 140, 162], skinD = [118, 108, 132], robe = [72, 56, 46], robeD = [52, 40, 34];
  // head 7x8x7 at (0,0)
  s.box(0, 0, 7, 8, 7, (f, x, y) => {
    if (f === 'front') {
      if ((y === 3 || y === 4) && (x === 1 || x === 2 || x === 4 || x === 5)) {
        if (y === 4 && (x === 2 || x === 4)) return [255, 222, 90];
        return [26, 20, 30];
      }
      if (y === 6 && x >= 2 && x <= 4) return [40, 30, 40];
      if (y === 1 && (x === 0 || x === 6)) return skinD;
    }
    if (f === 'top') return (x + y) % 3 === 0 ? [60, 56, 66] : s.vary(skinD, 0.05);
    return s.vary(skin, 0.05);
  });
  // body 8x12x4 at (16,16)
  s.box(16, 16, 8, 12, 4, (f, x, y) => {
    if (y < 1) return skinD;
    const tear = (x * 7 + y * 3) % 11 === 0;
    if (tear) return s.vary(skin, 0.05);
    if (y === 7) return [34, 28, 24];
    return s.vary(y > 7 ? robeD : robe, 0.07);
  });
  // arm 3x14x3 at (40,16)
  s.box(40, 16, 3, 14, 3, (f, x, y) => (y < 5 ? s.vary(robe, 0.06) : s.vary(skin, 0.05)));
  // leg 3x12x3 at (0,32)
  s.box(0, 32, 3, 12, 3, (f, x, y) => (y < 8 ? s.vary(robeD, 0.06) : s.vary(skinD, 0.06)));
  return s.d;
}

export function generateSkins() {
  const out = new Array(SKIN_COUNT);
  out[SKIN.PLAYER] = paintPlayer();
  out[SKIN.PIG] = paintPig();
  out[SKIN.COW] = paintCow();
  out[SKIN.SHEEP] = paintSheep();
  out[SKIN.CHICKEN] = paintChicken();
  out[SKIN.GHOUL] = paintGhoul();
  out[SKIN.SHEEP_WOOL] = paintSheepWool();
  return out;
}

// ---------------------------------------------------------------------------
// Model definitions (units: 1/16 block, origin at the feet, front facing -Z).
// part: { box: [x, y, z, w, h, d], uv: [u, v], pivot: [x, y, z], skin?, inflate?, mirror? }
export const MODELS = {
  player: {
    skin: SKIN.PLAYER, width: 0.6, height: 1.8, eye: 1.62,
    parts: {
      head: { box: [-4, 24, -4, 8, 8, 8], uv: [0, 0], pivot: [0, 24, 0] },
      body: { box: [-4, 12, -2, 8, 12, 4], uv: [16, 16], pivot: [0, 24, 0] },
      armR: { box: [-8, 12, -2, 4, 12, 4], uv: [40, 16], pivot: [-6, 22, 0] },
      armL: { box: [4, 12, -2, 4, 12, 4], uv: [40, 16], pivot: [6, 22, 0], mirror: true },
      legR: { box: [-4, 0, -2, 4, 12, 4], uv: [0, 16], pivot: [-2, 12, 0] },
      legL: { box: [0, 0, -2, 4, 12, 4], uv: [0, 16], pivot: [2, 12, 0], mirror: true },
    },
  },
  pig: {
    skin: SKIN.PIG, width: 0.9, height: 0.9,
    parts: {
      body: { box: [-5, 6, -6, 10, 9, 13], uv: [0, 16], pivot: [0, 10, 0] },
      head: { box: [-4, 7, -12, 8, 7, 7], uv: [0, 0], pivot: [0, 11, -6] },
      snout: { box: [-2, 8, -13, 4, 3, 1], uv: [30, 0], pivot: [0, 11, -6], parent: 'head' },
      earR: { box: [-4, 14, -9, 2, 2, 1], uv: [40, 0], pivot: [0, 11, -6], parent: 'head' },
      earL: { box: [2, 14, -9, 2, 2, 1], uv: [40, 0], pivot: [0, 11, -6], parent: 'head' },
      tail: { box: [-0.5, 12, 7, 1, 1, 3], uv: [56, 16], pivot: [0, 12, 7] },
      leg0: { box: [-5, 0, -5, 4, 6, 4], uv: [48, 0], pivot: [-3, 6, -3] },
      leg1: { box: [1, 0, -5, 4, 6, 4], uv: [48, 0], pivot: [3, 6, -3] },
      leg2: { box: [-5, 0, 2, 4, 6, 4], uv: [48, 0], pivot: [-3, 6, 4] },
      leg3: { box: [1, 0, 2, 4, 6, 4], uv: [48, 0], pivot: [3, 6, 4] },
    },
  },
  cow: {
    skin: SKIN.COW, width: 0.9, height: 1.4,
    parts: {
      body: { box: [-6, 10, -8, 12, 10, 16], uv: [0, 16], pivot: [0, 15, 0] },
      head: { box: [-4, 13, -14, 8, 8, 6], uv: [0, 0], pivot: [0, 18, -8] },
      hornR: { box: [-5, 20, -12, 1, 3, 1], uv: [28, 0], pivot: [0, 18, -8], parent: 'head' },
      hornL: { box: [4, 20, -12, 1, 3, 1], uv: [28, 0], pivot: [0, 18, -8], parent: 'head' },
      udder: { box: [-2, 8, 2, 4, 2, 3], uv: [48, 20], pivot: [0, 10, 3] },
      leg0: { box: [-6, 0, -7, 4, 10, 4], uv: [48, 0], pivot: [-4, 10, -5] },
      leg1: { box: [2, 0, -7, 4, 10, 4], uv: [48, 0], pivot: [4, 10, -5] },
      leg2: { box: [-6, 0, 3, 4, 10, 4], uv: [48, 0], pivot: [-4, 10, 5] },
      leg3: { box: [2, 0, 3, 4, 10, 4], uv: [48, 0], pivot: [4, 10, 5] },
    },
  },
  sheep: {
    skin: SKIN.SHEEP, width: 0.9, height: 1.3,
    parts: {
      body: { box: [-4, 10, -6, 8, 8, 13], uv: [0, 16], pivot: [0, 14, 0] },
      wool: { box: [-6, 9, -8, 12, 11, 16], uv: [0, 16], pivot: [0, 14, 0], skin: SKIN.SHEEP_WOOL, woolOnly: true },
      head: { box: [-3, 14, -12, 6, 7, 7], uv: [0, 0], pivot: [0, 17, -6] },
      headWool: { box: [-3.5, 19, -11, 7, 3, 6], uv: [0, 0], pivot: [0, 17, -6], parent: 'head', skin: SKIN.SHEEP_WOOL, woolOnly: true },
      earR: { box: [-6, 17, -9, 3, 1, 2], uv: [28, 0], pivot: [0, 17, -6], parent: 'head' },
      earL: { box: [3, 17, -9, 3, 1, 2], uv: [28, 0], pivot: [0, 17, -6], parent: 'head' },
      leg0: { box: [-4, 0, -5, 3, 10, 3], uv: [48, 0], pivot: [-2.5, 10, -3.5] },
      leg1: { box: [1, 0, -5, 3, 10, 3], uv: [48, 0], pivot: [2.5, 10, -3.5] },
      leg2: { box: [-4, 0, 3, 3, 10, 3], uv: [48, 0], pivot: [-2.5, 10, 4.5] },
      leg3: { box: [1, 0, 3, 3, 10, 3], uv: [48, 0], pivot: [2.5, 10, 4.5] },
    },
  },
  chicken: {
    skin: SKIN.CHICKEN, width: 0.4, height: 0.7,
    parts: {
      body: { box: [-3, 4, -3, 6, 7, 7], uv: [0, 16], pivot: [0, 8, 0] },
      head: { box: [-2, 9, -6, 4, 5, 3], uv: [0, 0], pivot: [0, 10, -3] },
      beak: { box: [-1, 10, -8, 2, 2, 2], uv: [16, 0], pivot: [0, 10, -3], parent: 'head' },
      comb: { box: [-0.5, 14, -6, 1, 2, 3], uv: [16, 8], pivot: [0, 10, -3], parent: 'head' },
      wingR: { box: [-4, 5, -2, 1, 5, 6], uv: [32, 16], pivot: [-3, 10, 0] },
      wingL: { box: [3, 5, -2, 1, 5, 6], uv: [32, 16], pivot: [3, 10, 0], mirror: true },
      legR: { box: [-2, 0, 0, 1, 5, 1], uv: [40, 0], pivot: [-1.5, 5, 0.5] },
      legL: { box: [1, 0, 0, 1, 5, 1], uv: [40, 0], pivot: [1.5, 5, 0.5] },
    },
  },
  ghoul: {
    skin: SKIN.GHOUL, width: 0.6, height: 1.9,
    parts: {
      head: { box: [-3.5, 24, -3.5, 7, 8, 7], uv: [0, 0], pivot: [0, 24, 0] },
      body: { box: [-4, 12, -2, 8, 12, 4], uv: [16, 16], pivot: [0, 24, 0] },
      armR: { box: [-7, 9, -1.5, 3, 14, 3], uv: [40, 16], pivot: [-5.5, 22, 0] },
      armL: { box: [4, 9, -1.5, 3, 14, 3], uv: [40, 16], pivot: [5.5, 22, 0], mirror: true },
      legR: { box: [-3.5, 0, -1.5, 3, 12, 3], uv: [0, 32], pivot: [-2, 12, 0] },
      legL: { box: [0.5, 0, -1.5, 3, 12, 3], uv: [0, 32], pivot: [2, 12, 0], mirror: true },
    },
  },
};

// Build GPU meshes for each model part (lazily, per renderer).
export function buildModelMeshes(renderer) {
  const out = {};
  for (const [name, m] of Object.entries(MODELS)) {
    const parts = {};
    for (const [pn, p] of Object.entries(m.parts)) {
      const [x, y, z, w, h, d] = p.box;
      const skin = p.skin ?? m.skin;
      const data = skinBox(x, y, z, w, h, d, p.uv[0], p.uv[1], skin, 64, 64, p.inflate || 0, !!p.mirror);
      parts[pn] = renderer.createModel(new Float32Array(data));
    }
    out[name] = parts;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Item meshes: block items are small cubes, everything else is an extruded
// sprite (1 texel thick) built from the texture's alpha.
export function extrudedSprite(texData, layer) {
  const out = [];
  const a = (x, y) => (x < 0 || y < 0 || x > 15 || y > 15 ? 0 : texData[(y * 16 + x) * 4 + 3]);
  const T = 1 / 32; // half thickness
  const P = (x, y, z, n, u, v) => out.push(x, y, z, n[0], n[1], n[2], u, v, layer);
  // front (+Z) and back (-Z) full quads
  P(-0.5, -0.5, T, [0, 0, 1], 0, 1); P(0.5, -0.5, T, [0, 0, 1], 1, 1); P(0.5, 0.5, T, [0, 0, 1], 1, 0); P(-0.5, 0.5, T, [0, 0, 1], 0, 0);
  P(0.5, -0.5, -T, [0, 0, -1], 1, 1); P(-0.5, -0.5, -T, [0, 0, -1], 0, 1); P(-0.5, 0.5, -T, [0, 0, -1], 0, 0); P(0.5, 0.5, -T, [0, 0, -1], 1, 0);
  for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
    if (a(px, py) < 128) continue;
    const x0 = px / 16 - 0.5, x1 = x0 + 1 / 16, y1 = 0.5 - py / 16, y0 = y1 - 1 / 16;
    const u = (px + 0.5) / 16, v = (py + 0.5) / 16;
    if (a(px, py - 1) < 128) { P(x0, y1, -T, [0, 1, 0], u, v); P(x0, y1, T, [0, 1, 0], u, v); P(x1, y1, T, [0, 1, 0], u, v); P(x1, y1, -T, [0, 1, 0], u, v); }
    if (a(px, py + 1) < 128) { P(x0, y0, -T, [0, -1, 0], u, v); P(x1, y0, -T, [0, -1, 0], u, v); P(x1, y0, T, [0, -1, 0], u, v); P(x0, y0, T, [0, -1, 0], u, v); }
    if (a(px + 1, py) < 128) { P(x1, y0, -T, [1, 0, 0], u, v); P(x1, y1, -T, [1, 0, 0], u, v); P(x1, y1, T, [1, 0, 0], u, v); P(x1, y0, T, [1, 0, 0], u, v); }
    if (a(px - 1, py) < 128) { P(x0, y0, T, [-1, 0, 0], u, v); P(x0, y1, T, [-1, 0, 0], u, v); P(x0, y1, -T, [-1, 0, 0], u, v); P(x0, y0, -T, [-1, 0, 0], u, v); }
  }
  return new Float32Array(out);
}

// Item mesh cache keyed by item id. Returns { model, kind: 'block'|'sprite', tex, tint }
export class ItemMeshes {
  constructor(renderer, blockTextures, itemTextures) {
    this.r = renderer; this.bt = blockTextures; this.it = itemTextures;
    this.cache = new Map();
  }
  get(id) {
    let m = this.cache.get(id);
    if (m) return m;
    const def = ITEMS[id];
    if (!def) return null;
    if (def.block !== undefined) {
      const rt = RENDER_TYPE[def.block];
      const tintKind = TINT[def.block];
      const tint = tintKind === 1 ? [0.48, 0.72, 0.32] : tintKind === 2 ? [0.38, 0.65, 0.23] : tintKind === 4 ? [0.5, 0.65, 0.33] : tintKind === 5 ? [0.38, 0.6, 0.38] : [1, 1, 1];
      if (rt === RENDER.CUBE || rt === RENDER.CACTUS) {
        const bid = def.block;
        const data = cubeMesh(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, (f) => faceTexture(bid, f, 0));
        const pass = BLOCKS[bid].pass;
        m = { model: this.r.createModel(data), kind: 'block', tex: 'block', tint, blockMode: pass === 1 ? 2 : pass === 2 ? 3 : 1 };
      } else {
        const layer = faceTexture(def.block, 2, 0);
        const src = this.bt[layer].data;
        m = { model: this.r.createModel(extrudedSprite(src, layer)), kind: 'sprite', tex: 'block', tint, blockMode: 2 };
      }
    } else {
      m = { model: this.r.createModel(extrudedSprite(this.it[def.tex].data, def.tex)), kind: 'sprite', tex: 'item', tint: [1, 1, 1], blockMode: 0 };
    }
    this.cache.set(id, m);
    return m;
  }
}

