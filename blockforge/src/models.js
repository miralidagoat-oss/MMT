// Box models for creatures and the player, their procedurally painted skins,
// and mesh builders for held/dropped items. All designs are original.
import { skinBox, cubeMesh } from './renderer.js';
import { rng } from './noise.js';
import { upscaleArt } from './textures.js';
import { faceTexture, RENDER_TYPE, RENDER, BLOCKS, TINT } from './blocks.js';
import { ITEMS } from './items.js';

export const SKIN = {
  PLAYER: 0, PIG: 1, COW: 2, SHEEP: 3, CHICKEN: 4, GHOUL: 5, SHEEP_WOOL: 6,
  FARMER: 7, SMITH: 8, SHEPHERD: 9, SCHOLAR: 10, ARCHER: 11, CRAWLER: 12, IMP: 13,
  ARMOR: 14, // 4 materials x 2 layers: leather A,B, golden A,B, iron A,B, diamond A,B
  GLOAMER: 22, WYRM: 23, GLIDER: 24,
  HOUND: 25, STEED_BROWN: 26, STEED_WHITE: 27, STEED_BLACK: 28, STEED_SADDLE: 29, SENTINEL: 30, SENTINEL_LIMBS: 31,
  FROST: 32, HEXER: 33, WARDEN: 34, SHROOMCOW: 35,
  FOX_RED: 36, FOX_SNOW: 37, CAT_TABBY: 38, CAT_BLACK: 39, CAT_GINGER: 40, CAT_CREAM: 41, CAT_CALICO: 42,
  PARROT_SCARLET: 43, PARROT_AZURE: 44, PARROT_EMERALD: 45, PARROT_SUNNY: 46, PARROT_SLATE: 47, BEE: 48,
  ALPACA_CREAM: 49, ALPACA_BROWN: 50, ALPACA_GREY: 51, ALPACA_WHITE: 52, ALPACA_PACK: 53, DOLPHIN: 54,
  STARSTEEL: 55, // two layers
  MARAUDER: 57, CAPTAIN: 58, BRUTE: 59,
  RABBIT_BROWN: 60, RABBIT_WHITE: 61, RABBIT_GOLD: 62, GOAT: 63, TURTLE: 64, SQUID: 65,
  FROG_MARSH: 66, FROG_WARM: 67, FROG_COLD: 68, TURTLE_SHELL: 69, // two layers
  LISTENER: 71, CAMEL: 72,
};
const SKIN_COUNT = 73;
export const ARMOR_SKIN = { leather: 14, golden: 16, iron: 18, diamond: 20, starsteel: 55, turtle: 69 };

// ---------------------------------------------------------------------------
// Skin painting helpers (64x64 RGBA)
// Skins are painted on a 64x64 texel grid; at higher detail the result is
// upscaled per face (see upscaleArt) when it is read.
let SKIN_K = 1;
class Skin {
  constructor(seed) {
    this.t = new Uint8ClampedArray(64 * 64 * 4); this.r = rng(seed); this.seed = seed;
    this.region = new Int32Array(64 * 64).fill(-1); this.face = -1; this.faces = 0;
  }
  get d() { return SKIN_K === 1 ? this.t : upscaleArt(this.t, 64, 64, SKIN_K, this.region, this.seed); }
  px(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x >= 64 || y >= 64) return;
    const i = (y * 64 + x) * 4;
    this.t[i] = c[0]; this.t[i + 1] = c[1]; this.t[i + 2] = c[2]; this.t[i + 3] = a;
    if (this.face >= 0) this.region[y * 64 + x] = this.face;
    else if (this.region[y * 64 + x] < 0) this.region[y * 64 + x] = 10000 + y * 64 + x;
  }
  // Paint every face of a box-unwrapped part. fn(face, x, y, w, h) -> color
  box(u, v, w, h, d, fn) {
    const rects = {
      top: [u + d, v, w, d], bottom: [u + d + w, v, w, d],
      right: [u, v + d, d, h], front: [u + d, v + d, w, h],
      left: [u + d + w, v + d, d, h], back: [u + d + w + d, v + d, w, h],
    };
    for (const [face, [rx, ry, rw, rh]] of Object.entries(rects)) {
      this.face = this.faces++;
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const c = fn(face, x, y, rw, rh);
        if (c) this.px(rx + x, ry + y, c, c[3] ?? 255);
      }
    }
    this.face = -1;
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


// Settlers: villagers of original design. Same body, outfit by profession.
function paintSettler(seed, outfit) {
  const s = new Skin(seed);
  const skinTones = [[230, 186, 150], [200, 150, 110], [150, 104, 74], [236, 200, 170]];
  const skin = skinTones[seed % skinTones.length];
  const hair = [[70, 44, 26], [30, 24, 20], [150, 110, 60], [200, 190, 180]][seed % 4];
  const { tunic, trim, pants, hat, hatBand } = outfit;
  s.box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'top') return s.vary(hair, 0.08);
    if (f === 'front') {
      if (y < 2) return s.vary(hair, 0.08);
      if (y === 3 && (x === 2 || x === 5)) return [40, 30, 26];
      if (y === 4 && (x === 2 || x === 5)) return [250, 250, 250];
      if (y === 5 && (x === 3 || x === 4)) return mixc(skin, [120, 70, 50], 0.35);
      if (outfit.beard && y >= 6) return s.vary(hair, 0.08);
      if (y === 6 && x >= 3 && x <= 4) return [140, 80, 70];
      return s.vary(skin, 0.03);
    }
    if (f === 'back') return y < 6 ? s.vary(hair, 0.08) : skin;
    return y < 3 ? s.vary(hair, 0.08) : s.vary(skin, 0.03);
  });
  // hat: brim 12x1x12 at (0,32), crown 8x3x8 at (32,0)
  s.box(0, 32, 12, 1, 12, () => (hat ? s.vary(hat, 0.08) : null));
  s.box(32, 0, 8, 3, 8, (f, x, y) => (hat ? (y === 2 && f !== 'top' && f !== 'bottom' ? hatBand : s.vary(hat, 0.08)) : null));
  s.box(16, 16, 8, 12, 4, (f, x, y) => {
    if (y === 8) return [60, 44, 30];
    if (y > 8) return s.vary(pants, 0.05);
    if (f === 'front' && (x === 3 || x === 4) && y > 1) return trim;
    if (y === 0) return trim;
    return s.vary(tunic, 0.05);
  });
  s.box(40, 16, 4, 12, 4, (f, x, y) => (y >= 9 ? s.vary(skin, 0.03) : y === 8 ? trim : s.vary(tunic, 0.05)));
  s.box(0, 16, 4, 12, 4, (f, x, y) => (y >= 10 ? [70, 50, 34] : s.vary(pants, 0.05)));
  return s.d;
}

function paintArcher() {
  const s = new Skin(71);
  const bone = [222, 216, 200], boneD = [170, 164, 150], hood = [52, 46, 58], hoodD = [36, 32, 42];
  s.box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'front') {
      if (y < 2) return hoodD;
      if ((x === 0 || x === 7) && y < 6) return hood;
      if (y === 3 && (x === 2 || x === 5)) return [20, 16, 24];
      if (y === 4 && (x === 2 || x === 5)) return [120, 200, 255];
      if (y === 6 && x % 2 === 1 && x > 1 && x < 7) return [40, 36, 40];
      return s.vary(bone, 0.04);
    }
    return s.vary(y < 6 || f === 'top' ? hood : bone, 0.06);
  });
  s.box(16, 16, 8, 12, 4, (f, x, y) => {
    if (y < 3) return s.vary(hood, 0.06);
    if (f === 'front' || f === 'back') {
      if (x === 3 || x === 4) return boneD;
      if (y % 2 === 0 && y < 9) return s.vary(bone, 0.04);
      return null; // gaps between the ribs
    }
    return y % 2 === 0 ? bone : null;
  });
  s.box(40, 16, 2, 12, 2, (f, x, y) => (y < 3 ? hood : s.vary(bone, 0.05)));
  s.box(0, 16, 2, 12, 2, (f, x, y) => s.vary(y < 2 ? boneD : bone, 0.05));
  return s.d;
}

function paintCrawler() {
  const s = new Skin(81);
  const shell = [74, 40, 56], dark = [44, 24, 34], eye = [255, 180, 40];
  s.box(0, 0, 8, 6, 8, (f, x, y) => {
    if (f === 'front') {
      if ((y === 2 && (x === 1 || x === 6)) || (y === 3 && (x === 2 || x === 5)) || (y === 1 && (x === 3 || x === 4))) return eye;
      if (y === 5 && (x === 3 || x === 4)) return [30, 16, 20];
    }
    return s.vary(shell, 0.08);
  });
  s.box(0, 16, 6, 5, 6, () => s.vary(dark, 0.08));
  s.box(0, 28, 10, 8, 12, (f, x, y) => ((x + y * 2) % 5 === 0 ? [110, 60, 70] : s.vary(shell, 0.08)));
  s.box(0, 48, 14, 2, 2, (f, x, y) => s.vary(dark, 0.1));
  return s.d;
}

function paintImp() {
  const s = new Skin(91);
  const skin = [196, 70, 40], skinD = [150, 44, 28], horn = [60, 40, 36], eye = [255, 230, 90];
  s.box(0, 0, 6, 6, 6, (f, x, y) => {
    if (f === 'front') {
      if (y === 2 && (x === 1 || x === 4)) return eye;
      if (y === 4 && x >= 1 && x <= 4) return x === 1 || x === 4 ? skinD : [40, 16, 12];
    }
    return s.vary(skin, 0.06);
  });
  s.box(24, 0, 1, 3, 1, () => horn);
  s.box(16, 16, 6, 7, 3, (f, x, y) => (y > 4 ? s.vary(skinD, 0.06) : s.vary(skin, 0.06)));
  s.box(40, 16, 2, 7, 2, () => s.vary(skinD, 0.06));
  s.box(0, 16, 2, 6, 2, (f, x, y) => (y > 4 ? horn : s.vary(skinD, 0.06)));
  s.box(48, 16, 1, 1, 6, (f, x, y) => (y === 0 ? skinD : horn));
  return s.d;
}

// Armor overlays. Layer A: helmet (head), chestplate (body, arms), boots
// (bottom of legs). Layer B: leggings (lower body, legs).
function paintArmor(mat, layerB) {
  const s = new Skin(101 + mat.length);
  const base = { leather: [140, 88, 52], golden: [246, 206, 58], iron: [210, 212, 216], diamond: [96, 224, 220], starsteel: [74, 64, 96], turtle: [72, 140, 64] }[mat];
  const hi = mul(base, 1.2), lo = mul(base, 0.7);
  const shade = (x, y, w, h) => (y === 0 || x === 0 ? hi : y === h - 1 || x === w - 1 ? lo : s.vary(base, 0.05));
  if (!layerB) {
    s.box(0, 0, 8, 8, 8, (f, x, y, w, h) => {
      if (f === 'bottom') return null;
      if (f === 'front' && y > 2 && y < 7 && x > 0 && x < 7) return null; // face opening
      if (y > 5 && f !== 'top') return null;
      return shade(x, y, w, h);
    });
    s.box(16, 16, 8, 12, 4, (f, x, y, w, h) => (y > 9 ? null : shade(x, y, w, h)));
    s.box(40, 16, 4, 12, 4, (f, x, y, w, h) => (y > 5 ? null : shade(x, y, w, h)));
    s.box(0, 16, 4, 12, 4, (f, x, y, w, h) => (y < 8 && f !== 'bottom' ? null : shade(x, y, w, h)));
  } else {
    s.box(16, 16, 8, 12, 4, (f, x, y, w, h) => (y < 8 || f === 'top' ? null : shade(x, y, w, h)));
    s.box(0, 16, 4, 12, 4, (f, x, y, w, h) => (y > 8 || f === 'top' || f === 'bottom' ? null : shade(x, y, w, h)));
  }
  return s.d;
}
const mul = (c, f) => [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];

// A tall, thin wanderer of the dark: soot-black with violet eyes and a faint
// scatter of stars across its skin.
function paintGloamer() {
  const s = new Skin(31);
  const base = [22, 20, 30];
  const star = () => (s.r() < 0.035 ? [150, 130, 220] : null);
  s.box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'front' && y === 4 && (x === 1 || x === 2 || x === 5 || x === 6)) return [200, 140, 255];
    if (f === 'front' && y === 5 && (x === 1 || x === 2 || x === 5 || x === 6)) return [120, 70, 190];
    return star() || s.vary(base, 0.12);
  });
  s.box(16, 16, 8, 12, 4, () => star() || s.vary(base, 0.1));
  s.box(40, 16, 2, 24, 2, (f, x, y) => (y > 21 ? [60, 40, 90] : star() || s.vary(base, 0.1)));
  s.box(0, 16, 2, 26, 2, () => star() || s.vary(base, 0.1));
  return s.d;
}

// The Void Wyrm: deep indigo scales, a pale underside and glowing cyan eyes.
function paintWyrm() {
  const s = new Skin(77);
  const scale = [44, 30, 70], belly = [120, 100, 150], ridge = [90, 60, 140];
  const scaled = (x, y) => ((x + (y % 2) * 2) % 4 === 0 ? mul(scale, 0.75) : s.vary(scale, 0.1));
  // head 10x7x12 at (0,0)
  s.box(0, 0, 10, 7, 12, (f, x, y) => {
    if (f === 'bottom') return s.vary(belly, 0.08);
    if (f === 'front') {
      if (y === 2 && (x === 1 || x === 2 || x === 7 || x === 8)) return [120, 255, 240];
      if (y === 5) return [16, 8, 24];
      if (y > 5) return s.vary(belly, 0.08);
    }
    return scaled(x, y);
  });
  // body 7x6x7 at (0,24)
  s.box(0, 24, 7, 6, 7, (f, x, y) => (f === 'bottom' ? s.vary(belly, 0.08) : f === 'top' && x === 3 ? ridge : scaled(x, y)));
  // tail 4x4x4 at (32,24)
  s.box(32, 24, 4, 4, 4, (f, x, y) => (f === 'bottom' ? belly : scaled(x, y)));
  // ridge spike 1x2x4 at (48,0)
  s.box(48, 0, 1, 2, 4, () => s.vary(ridge, 0.1));
  // horn 1x1x4 at (48,8)
  s.box(48, 8, 1, 1, 4, () => [210, 200, 230]);
  return s.d;
}

// Glider membrane: dusky violet with paler ribs.
function paintGlider() {
  const s = new Skin(91);
  s.box(0, 0, 10, 16, 1, (f, x, y) => (x % 3 === 0 ? [180, 160, 220] : s.vary([110, 90, 150], 0.08)));
  return s.d;
}


// --- round four creatures ------------------------------------------------------
function paintHound() {
  const s = new Skin(71);
  const fur = [168, 160, 150], furD = [120, 112, 104], belly = [214, 206, 194], nose = [36, 30, 30];
  // head 6x6x4 at (0,0)
  s.box(0, 0, 6, 6, 4, (f, x, y) => {
    if (f === 'front') {
      if (y === 2 && (x === 1 || x === 4)) return [30, 24, 20];
      if (y === 2 && (x === 2 || x === 3)) return s.vary(fur, 0.05);
      if (y >= 4) return s.vary(belly, 0.04);
    }
    if (f === 'top') return s.vary(furD, 0.06);
    return s.vary(fur, 0.06);
  });
  // snout 3x3x3 at (20,0)
  s.box(20, 0, 3, 3, 3, (f, x, y) => (f === 'front' && y === 0 ? nose : y === 2 ? s.vary(belly, 0.04) : s.vary(fur, 0.05)));
  // ear 2x2x1 at (36,0)
  s.box(36, 0, 2, 2, 1, () => s.vary(furD, 0.05));
  // body 6x6x9 at (0,12)
  s.box(0, 12, 6, 6, 9, (f, x, y) => (f === 'bottom' ? s.vary(belly, 0.05) : f === 'top' && (x + y) % 3 === 0 ? s.vary(furD, 0.05) : s.vary(fur, 0.06)));
  // mane 8x7x6 at (32,10)
  s.box(32, 10, 8, 7, 6, (f, x, y) => ((x * 3 + y * 5) % 4 === 0 ? s.vary(furD, 0.06) : s.vary(fur, 0.07)));
  // leg 2x7x2 at (0,28)
  s.box(0, 28, 2, 7, 2, (f, x, y) => (y >= 6 ? s.vary(furD, 0.05) : s.vary(fur, 0.05)));
  // tail 2x8x2 at (10,28)
  s.box(10, 28, 2, 8, 2, (f, x, y) => (y >= 6 ? s.vary(belly, 0.05) : s.vary(furD, 0.06)));
  // collar 9x2x7 at (30,28)
  s.box(30, 28, 9, 2, 7, (f, x) => (f === 'front' && x === 4 ? [240, 200, 60] : s.vary([200, 30, 34], 0.04)));
  return s.d;
}

function paintSteed(seed, coat, coatD, mane, socks) {
  const s = new Skin(seed);
  // neck 4x12x7 at (0,0)
  s.box(0, 0, 4, 12, 7, (f, x, y) => s.vary((x * 5 + y) % 9 === 0 ? coatD : coat, 0.05));
  // head 6x6x8 at (22,0)
  s.box(22, 0, 6, 6, 8, (f, x, y) => {
    if ((f === 'left' || f === 'right') && y === 2 && (f === 'left' ? x === 1 : x === 6)) return [20, 16, 14];
    if (f === 'front' && socks && x >= 2 && x <= 3) return [236, 232, 224];
    return s.vary(coat, 0.05);
  });
  // ears 2x3x1 at (50,0)
  s.box(50, 0, 2, 3, 1, () => s.vary(coatD, 0.05));
  // muzzle 4x5x5 at (22,14)
  s.box(22, 14, 4, 5, 5, (f, x, y) => (f === 'front' && y === 3 && (x === 0 || x === 3) ? [24, 20, 18] : s.vary(mul(coat, 0.9), 0.05)));
  // mane 2x13x3 at (40,14)
  s.box(40, 14, 2, 13, 3, (f, x, y) => s.vary((x + y) % 3 ? mane : mul(mane, 0.8), 0.06));
  // tail 3x10x3 at (50,4)
  s.box(50, 4, 3, 10, 3, (f, x, y) => s.vary((x + y) % 3 ? mane : mul(mane, 0.8), 0.07));
  // leg 3x11x3 at (0,19)
  s.box(0, 19, 3, 11, 3, (f, x, y) => (y >= 10 ? [50, 40, 34] : socks && y >= 7 ? s.vary([236, 232, 224], 0.03) : s.vary(coatD, 0.05)));
  // body 10x10x20 at (0,34)
  s.box(0, 34, 10, 10, 20, (f, x, y) => {
    if (f === 'bottom') return s.vary(mul(coat, 0.85), 0.05);
    const dapple = coat[0] > 200 && (x * 7 + y * 11) % 13 === 0;
    return s.vary(dapple ? coatD : coat, 0.05);
  });
  return s.d;
}

function paintSaddle() {
  const s = new Skin(77);
  const lea = [120, 72, 36], leaD = [86, 50, 26], iron = [190, 190, 196];
  // saddle 11x2x9 at (0,0)
  s.box(0, 0, 11, 2, 9, (f, x, y) => (f === 'top' && (x === 0 || x === 10) ? leaD : s.vary(lea, 0.05)));
  // strap 1x8x1 at (0,12)
  s.box(0, 12, 1, 8, 1, (f, x, y) => (y === 7 ? iron : leaD));
  // bridle 7x2x9 at (0,24)
  s.box(0, 24, 7, 2, 9, () => s.vary(leaD, 0.04));
  return s.d;
}

function paintSentinel() {
  const s = new Skin(81);
  const iron = [204, 198, 190], ironD = [158, 150, 142], rust = [150, 110, 70], vine = [70, 120, 40];
  // head 8x10x8 at (0,0)
  s.box(0, 0, 8, 10, 8, (f, x, y) => {
    if (f === 'front') {
      if (y === 4 && (x === 1 || x === 6)) return [200, 30, 20];
      if (y === 3 && x >= 1 && x <= 6) return ironD;
    }
    return s.vary((x * 3 + y * 7) % 13 === 0 ? rust : iron, 0.05);
  });
  // nose 2x4x2 at (32,0)
  s.box(32, 0, 2, 4, 2, () => s.vary(ironD, 0.05));
  // waist 9x6x6 at (32,6)
  s.box(32, 6, 9, 6, 6, (f, x, y) => s.vary(y === 0 ? ironD : iron, 0.05));
  // body 18x12x11 at (0,41)
  s.box(0, 41, 18, 12, 11, (f, x, y) => {
    if ((f === 'front' || f === 'back') && (x * 5 + y * 3) % 17 === 0) return s.vary(vine, 0.1);
    if (f === 'front' && y >= 3 && y <= 8 && (x === 6 || x === 11)) return ironD;
    return s.vary((x + y * 2) % 11 === 0 ? rust : iron, 0.05);
  });
  return s.d;
}
function paintSentinelLimbs() {
  const s = new Skin(83);
  const iron = [204, 198, 190], ironD = [158, 150, 142], vine = [70, 120, 40];
  // arm 4x30x6 at (0,0)
  s.box(0, 0, 4, 30, 6, (f, x, y) => (y > 24 ? s.vary(ironD, 0.05) : (x * 5 + y * 3) % 19 === 0 ? s.vary(vine, 0.1) : s.vary(iron, 0.05)));
  // leg 6x20x5 at (20,0)
  s.box(20, 0, 6, 20, 5, (f, x, y) => (y > 17 ? s.vary(ironD, 0.05) : s.vary(iron, 0.05)));
  return s.d;
}

function paintFrost() {
  const s = new Skin(85);
  const snow = [236, 242, 250], pump = [222, 124, 28], pumpD = [180, 90, 16];
  // pumpkin head 8x8x8 at (0,0)
  s.box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'front' && ((y === 2 && (x === 1 || x === 2 || x === 5 || x === 6)) || (y === 5 && x >= 1 && x <= 6) || (y === 6 && x % 2 === 1))) return [40, 24, 8];
    if (f === 'top' && x >= 3 && x <= 4 && y >= 3 && y <= 4) return [80, 70, 30];
    return s.vary(x % 3 === 0 ? pumpD : pump, 0.05);
  });
  // stick arm 10x2x2 at (32,0)
  s.box(32, 0, 10, 2, 2, () => s.vary([110, 80, 44], 0.08));
  // upper ball 10x10x10 at (0,20)
  s.box(0, 20, 10, 10, 10, () => s.vary(snow, 0.03));
  // lower ball 12x12x12 at (0,40)
  s.box(0, 40, 12, 12, 12, (f, x, y) => s.vary(f === 'bottom' ? mul(snow, 0.9) : snow, 0.03));
  return s.d;
}

function paintHexer() {
  const s = new Skin(87);
  const skin = [150, 170, 120], robe = [70, 46, 90], robeD = [50, 32, 66], hat = [36, 30, 40], band = [120, 80, 160];
  // head 8x8x8 at (0,0)
  s.box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'front') {
      if (y === 3 && (x === 1 || x === 6)) return [230, 230, 120];
      if (y === 3 && (x === 2 || x === 5)) return [40, 30, 20];
      if (y === 6 && x >= 2 && x <= 5) return [90, 60, 50];
      if (y === 7 && (x === 2 || x === 5)) return [60, 50, 40];
    }
    if (f === 'top' || y < 2) return s.vary([60, 50, 50], 0.06);
    return s.vary(skin, 0.05);
  });
  // nose 2x4x2 at (32,0)
  s.box(32, 0, 2, 4, 2, (f, x, y) => (y === 3 && x === 1 ? [90, 120, 60] : s.vary(skin, 0.05)));
  // hat brim 10x1x10 at (0,16)
  s.box(0, 16, 10, 1, 10, () => s.vary(hat, 0.05));
  // hat middle 7x4x7 at (0,27)
  s.box(0, 27, 7, 4, 7, (f, x, y) => (y === 3 ? band : s.vary(hat, 0.05)));
  // hat tip 4x4x4 at (28,27)
  s.box(28, 27, 4, 4, 4, () => s.vary(hat, 0.05));
  // hat point 2x3x2 at (44,27)
  s.box(44, 27, 2, 3, 2, () => s.vary(hat, 0.05));
  // robe 8x12x6 at (0,38)
  s.box(0, 38, 8, 12, 6, (f, x, y) => (y === 4 ? [140, 110, 60] : s.vary(y > 7 ? robeD : robe, 0.06)));
  // leg 4x12x4 at (28,38)
  s.box(28, 38, 4, 12, 4, (f, x, y) => (y > 10 ? [40, 30, 24] : s.vary(robeD, 0.06)));
  // arm 4x12x4 at (44,38)
  s.box(44, 38, 4, 12, 4, (f, x, y) => (y > 8 ? s.vary(skin, 0.05) : s.vary(robe, 0.06)));
  return s.d;
}

function paintWarden() {
  const s = new Skin(89);
  const body = [96, 150, 132], bodyD = [64, 108, 96], belly = [170, 120, 90], eye = [250, 240, 220];
  // body 12x12x12 at (0,0)
  s.box(0, 0, 12, 12, 12, (f, x, y) => {
    if (f === 'front') {
      const d = Math.hypot(x - 5.5, y - 5.5);
      if (d < 1.4) return [20, 20, 30];
      if (d < 3.2) return eye;
      if (d < 3.9) return bodyD;
    }
    if (f === 'bottom') return s.vary(belly, 0.06);
    if ((x + y) % 4 === 0) return s.vary(bodyD, 0.06);
    return s.vary(body, 0.06);
  });
  // tail 4x4x6 at (0,24)
  s.box(0, 24, 4, 4, 6, () => s.vary(body, 0.06));
  // tail2 3x3x5 at (20,24)
  s.box(20, 24, 3, 3, 5, () => s.vary(bodyD, 0.06));
  // fin 1x6x4 at (36,24)
  s.box(36, 24, 1, 6, 4, () => s.vary(belly, 0.06));
  // spike 1x4x1 at (48,0)
  s.box(48, 0, 1, 4, 1, (f, x, y) => (y === 0 ? [240, 230, 210] : [200, 180, 150]));
  return s.d;
}

function paintShroomcow() {
  const s = new Skin(91);
  const red = [180, 34, 30], spot = [236, 226, 214], muzzle = [190, 160, 150];
  s.box(0, 0, 8, 8, 6, (f, x, y) => {
    if (f === 'front') {
      if (y >= 5) return y === 6 && (x === 2 || x === 5) ? [30, 20, 20] : s.vary(muzzle, 0.05);
      if (y === 2 && (x === 1 || x === 6)) return [20, 16, 16];
    }
    return s.vary(red, 0.05);
  });
  s.box(28, 0, 1, 3, 1, () => [210, 200, 180]);
  s.box(0, 16, 12, 10, 16, (f, x, y) => ((x * 7 + y * 5) % 9 === 0 ? spot : s.vary(red, 0.05)));
  s.box(48, 0, 4, 10, 4, (f, x, y) => (y >= 8 ? [50, 40, 36] : s.vary(red, 0.05)));
  s.box(48, 20, 4, 2, 3, () => [236, 170, 170]);
  // mushroom cap 4x2x4 at (0,44) and stem 2x2x2 at (16,44)
  s.box(0, 44, 4, 2, 4, (f, x, y) => (f === 'top' && (x + y) % 3 === 0 ? spot : [200, 36, 30]));
  s.box(16, 44, 2, 2, 2, () => [222, 214, 196]);
  return s.d;
}

// --- round five animals ----------------------------------------------------------
function paintFox(seed, fur, furD, chest, sock) {
  const s = new Skin(seed);
  const eye = [40, 30, 20], nose = [30, 24, 22];
  // head 8x6x5 at (0,0)
  s.box(0, 0, 8, 6, 5, (f, x, y) => {
    if (f === 'front') {
      if (y === 2 && (x === 1 || x === 6)) return eye;
      if (y === 2 && (x === 2 || x === 5)) return [250, 250, 240];
      if (y >= 4) return s.vary(chest, 0.04);
      if (y === 3 && (x <= 1 || x >= 6)) return s.vary(chest, 0.04);
    }
    if ((f === 'left' || f === 'right') && y >= 4) return s.vary(chest, 0.04);
    if (f === 'top') return s.vary(mixc(fur, furD, 0.3), 0.05);
    return s.vary(fur, 0.05);
  });
  // snout 4x2x3 at (26,0)
  s.box(26, 0, 4, 2, 3, (f, x, y) => (f === 'front' && y === 0 && x >= 1 && x <= 2 ? nose : f === 'bottom' || y === 1 ? s.vary(chest, 0.04) : s.vary(fur, 0.05)));
  // ear 2x3x1 at (40,0)
  s.box(40, 0, 2, 3, 1, (f, x, y) => (y === 0 ? sock : f === 'front' && y > 0 ? [60, 40, 36] : s.vary(fur, 0.05)));
  // body 6x6x11 at (0,16)
  s.box(0, 16, 6, 6, 11, (f, x, y, w, h) => {
    if (f === 'bottom') return s.vary(chest, 0.05);
    if ((f === 'left' || f === 'right') && y >= h - 2) return s.vary(mixc(fur, chest, 0.5), 0.05);
    if (f === 'top' && (x + y * 2) % 7 === 0) return s.vary(furD, 0.05);
    return s.vary(mixc(fur, furD, y / h * 0.25), 0.05);
  });
  // tail 4x4x9 at (34,16): bushy, white at the tip
  s.box(34, 16, 4, 4, 9, (f, x, y, w, h) => {
    const tip = f === 'back' || ((f === 'left' || f === 'right' || f === 'top' || f === 'bottom') && (f === 'left' ? x : f === 'right' ? w - 1 - x : y) >= (f === 'top' || f === 'bottom' ? h - 2 : w - 2));
    if (tip) return s.vary(chest, 0.04);
    return s.vary((x + y) % 3 === 0 ? furD : fur, 0.06);
  });
  // leg 2x5x2 at (0,40)
  s.box(0, 40, 2, 5, 2, (f, x, y) => (y >= 2 ? s.vary(sock, 0.05) : s.vary(fur, 0.05)));
  return s.d;
}

function paintCat(seed, base, mark, belly, pattern) {
  const s = new Skin(seed);
  const eye = seed % 2 ? [120, 200, 60] : [230, 190, 50];
  const coat = (x, y, f) => {
    if (pattern === 'stripes' && (x + (f === 'top' ? 0 : y)) % 3 === 0) return s.vary(mark, 0.05);
    if (pattern === 'patches') {
      const v = Math.sin(x * 1.3 + seed) * Math.cos(y * 1.1 + seed * 0.7);
      if (v > 0.45) return s.vary(mark, 0.05);
      if (v < -0.5) return s.vary([40, 34, 32], 0.05);
    }
    return s.vary(base, 0.05);
  };
  // head 5x4x5 at (0,0)
  s.box(0, 0, 5, 4, 5, (f, x, y) => {
    if (f === 'front') {
      if (y === 1 && (x === 1 || x === 3)) return eye;
      if (y === 3 && x === 2) return [220, 140, 150];
      if (pattern === 'points' && y >= 2) return s.vary(mark, 0.05);
      if (y >= 2 && pattern !== 'solid') return s.vary(belly, 0.04);
    }
    if (pattern === 'points') return s.vary(base, 0.04);
    return coat(x, y, f);
  });
  // nose 3x2x1 at (20,0)
  s.box(20, 0, 3, 2, 1, (f, x, y) => (y === 0 && x === 1 ? [220, 140, 150] : pattern === 'points' ? s.vary(mark, 0.05) : s.vary(belly, 0.04)));
  // ear 1x1x2 at (28,0)
  s.box(28, 0, 1, 1, 2, () => (pattern === 'points' ? s.vary(mark, 0.05) : s.vary(mark, 0.05)));
  // tail 1x1x8 at (40,0) and tip 1x1x6 at (40,10)
  s.box(40, 0, 1, 1, 8, (f, x, y) => (pattern === 'points' ? s.vary(mark, 0.05) : coat(x, y, f)));
  s.box(40, 10, 1, 1, 6, (f, x, y) => (pattern === 'points' || pattern === 'stripes' ? s.vary(mark, 0.05) : coat(x, y, f)));
  // body 4x4x12 at (0,16)
  s.box(0, 16, 4, 4, 12, (f, x, y) => (f === 'bottom' ? s.vary(belly, 0.04) : pattern === 'points' ? s.vary(base, 0.04) : coat(x, y, f)));
  // leg 2x6x2 at (0,36)
  s.box(0, 36, 2, 6, 2, (f, x, y) => (y >= 5 ? s.vary(pattern === 'solid' ? base : belly, 0.04) : pattern === 'points' ? s.vary(mark, 0.05) : coat(x, y, f)));
  return s.d;
}

function paintParrot(seed, body, wing, head, tail, beak) {
  const s = new Skin(seed);
  // head 2x3x2 at (0,0)
  s.box(0, 0, 2, 3, 2, (f, x, y) => {
    if ((f === 'left' || f === 'right') && y === 1) return x === (f === 'left' ? 1 : 0) ? [20, 20, 20] : [250, 250, 250];
    return s.vary(head, 0.05);
  });
  // crest 1x2x3 at (10,0)
  s.box(10, 0, 1, 2, 3, () => s.vary(head, 0.07));
  // beak 1x2x1 at (20,0) and lower 1x1x1 at (24,0)
  s.box(20, 0, 1, 2, 1, (f, x, y) => (y === 1 ? mul(beak, 0.7) : beak));
  s.box(24, 0, 1, 1, 1, () => mul(beak, 0.6));
  // body 3x6x3 at (0,16)
  s.box(0, 16, 3, 6, 3, (f, x, y) => s.vary(y < 2 ? mixc(body, head, 0.4) : body, 0.05));
  // wing 1x5x3 at (20,16)
  s.box(20, 16, 1, 5, 3, (f, x, y) => s.vary(y >= 3 ? tail : wing, 0.06));
  // tail 3x4x1 at (32,16)
  s.box(32, 16, 3, 4, 1, (f, x, y) => s.vary(y >= 2 ? mul(tail, 0.85) : tail, 0.05));
  // leg 1x4x1 at (40,0)
  s.box(40, 0, 1, 4, 1, () => [110, 100, 96]);
  return s.d;
}

function paintBee() {
  const s = new Skin(97);
  const yel = [236, 190, 44], blk = [44, 34, 28], wing = [214, 232, 246];
  // body 7x7x10 at (0,0): striped, face at the front
  s.box(0, 0, 7, 7, 10, (f, x, y, w, h) => {
    if (f === 'front') {
      if (y >= 2 && y <= 4 && (x <= 1 || x >= 5)) return x === 0 || x === 6 ? [30, 22, 18] : [60, 50, 44];
      if (y === 5 && x >= 2 && x <= 4) return [90, 60, 30];
      return s.vary(yel, 0.04);
    }
    if (f === 'back') return s.vary(y > 4 ? blk : yel, 0.05);
    // stripes along the length (z): x for top/bottom/sides runs along depth
    const along = f === 'top' || f === 'bottom' ? y : x;
    const z = f === 'left' ? w - 1 - along : along;
    if (z === 3 || z === 4 || z === 7 || z === 8) return s.vary(blk, 0.05);
    if (f === 'bottom') return s.vary(mul(yel, 0.85), 0.05);
    return s.vary(yel, 0.04);
  });
  // stinger 1x1x2 at (40,0)
  s.box(40, 0, 1, 1, 2, () => [60, 50, 50]);
  // antenna 1x2x3 at (44,0)
  s.box(44, 0, 1, 2, 3, () => [36, 30, 26]);
  // wing 8x1x6 at (0,20)
  s.box(0, 20, 8, 1, 6, (f, x, y) => ((x + y) % 4 === 0 ? mul(wing, 0.9) : wing));
  return s.d;
}

function paintAlpaca(seed, wool, woolD) {
  const s = new Skin(seed);
  const face = mixc(wool, [250, 246, 238], 0.25);
  const fluff = (x, y) => s.vary(((x * 7 + y * 13 + seed) % 5 === 0) ? woolD : ((x + y * 3) % 4 === 0 ? mul(wool, 1.06) : wool), 0.05);
  // neck 8x18x6 at (0,0)
  s.box(0, 0, 8, 18, 6, (f, x, y) => fluff(x, y));
  // head 4x4x4 at (28,0)
  s.box(28, 0, 4, 4, 4, (f, x, y) => {
    if (f === 'front') { if (y === 2 && x >= 1 && x <= 2) return [50, 40, 36]; if (y === 3) return mul(face, 0.85); }
    return s.vary(face, 0.04);
  });
  // ear 2x3x2 at (44,0)
  s.box(44, 0, 2, 3, 2, (f, x, y) => (y === 0 ? woolD : s.vary(wool, 0.05)));
  // eyes painted on the neck's front near the top
  for (const ex of [1, 6]) s.px(6 + ex, 6 + 1, [24, 20, 20]);
  // tail 3x4x2 at (28,10)
  s.box(28, 10, 3, 4, 2, (f, x, y) => fluff(x, y));
  // leg 4x14x4 at (48,8)
  s.box(48, 8, 4, 14, 4, (f, x, y) => (y >= 12 ? [70, 56, 46] : fluff(x, y)));
  // body 12x10x18 at (0,32)
  s.box(0, 32, 12, 10, 18, (f, x, y) => (f === 'bottom' ? s.vary(mul(wool, 0.88), 0.05) : fluff(x, y)));
  return s.d;
}

function paintPack() {
  const s = new Skin(99);
  const wood = [150, 110, 60], woodD = [110, 76, 40], iron = [190, 190, 196];
  // pack 3x8x8 at (0,0)
  s.box(0, 0, 3, 8, 8, (f, x, y, w, h) => {
    if (y === 0 || y === h - 1 || x === 0 || x === w - 1) return woodD;
    if (y === 3 && (f === 'right' || f === 'left')) return x === 3 || x === 4 ? iron : woodD;
    return s.vary(wood, 0.06);
  });
  return s.d;
}

function paintDolphin() {
  const s = new Skin(101);
  const top = [112, 132, 156], side = [150, 164, 182], belly = [222, 226, 232];
  const shade = (f, y, h) => (f === 'top' ? s.vary(top, 0.04) : f === 'bottom' ? s.vary(belly, 0.03) : s.vary(y < h * 0.4 ? top : y < h * 0.7 ? side : belly, 0.04));
  // body 8x7x13 at (0,0)
  s.box(0, 0, 8, 7, 13, (f, x, y, w, h) => shade(f, y, h));
  // head 6x6x4 at (0,22)
  s.box(0, 22, 6, 6, 4, (f, x, y, w, h) => {
    if ((f === 'left' || f === 'right') && y === 2 && x === (f === 'right' ? 1 : 2)) return [20, 22, 30];
    return shade(f, y, h);
  });
  // snout 3x2x4 at (20,22)
  s.box(20, 22, 3, 2, 4, (f, x, y) => (y === 1 || f === 'bottom' ? s.vary(belly, 0.03) : s.vary(side, 0.04)));
  // dorsal fin 1x4x5 at (36,22)
  s.box(36, 22, 1, 4, 5, () => s.vary(top, 0.05));
  // flipper 5x1x3 at (48,0)
  s.box(48, 0, 5, 1, 3, () => s.vary(top, 0.05));
  // tail 4x4x9 at (0,34) and fluke 10x1x4 at (26,34)
  s.box(0, 34, 4, 4, 9, (f, x, y, w, h) => shade(f, y, h));
  s.box(26, 34, 10, 1, 4, () => s.vary(top, 0.05));
  return s.d;
}

// Raiders: marauders, their captain and the brute they ride with.
function paintMarauder(seed, captain) {
  const s = new Skin(seed);
  const skin = [150, 160, 160], cloak = captain ? [60, 50, 80] : [56, 62, 70], cloakD = mul(cloak, 0.7), belt = [90, 60, 36];
  s.box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'front') {
      if (y === 3 && (x === 1 || x === 2 || x === 5 || x === 6)) return x === 2 || x === 5 ? [30, 30, 34] : [230, 230, 230];
      if (y === 2 && x >= 1 && x <= 6) return [50, 50, 56]; // a heavy brow
      if (y >= 5 && y <= 6 && x >= 2 && x <= 5) return [110, 116, 118];
    }
    if (f === 'top' || y === 0) return s.vary([36, 32, 30], 0.06);
    return s.vary(skin, 0.04);
  });
  s.box(16, 16, 8, 12, 4, (f, x, y) => {
    if (y === 7) return belt;
    if (captain && f === 'front' && y >= 1 && y <= 5 && x >= 2 && x <= 5) return (x + y) % 2 ? [200, 170, 60] : [160, 40, 40];
    return s.vary(y > 7 ? cloakD : cloak, 0.06);
  });
  s.box(40, 16, 4, 12, 4, (f, x, y) => (y > 9 ? s.vary(skin, 0.04) : s.vary(cloak, 0.06)));
  s.box(0, 16, 4, 12, 4, (f, x, y) => (y > 10 ? [40, 34, 30] : s.vary(cloakD, 0.06)));
  // nose 2x4x2 at (32,0)
  s.box(32, 0, 2, 4, 2, () => s.vary(mul(skin, 0.92), 0.04));
  return s.d;
}

function paintBrute() {
  const s = new Skin(103);
  const hide = [96, 90, 84], hideD = [66, 62, 58], horn = [220, 210, 190], mouth = [60, 30, 30];
  // head 10x10x14 at (0,0)
  s.box(0, 0, 10, 10, 14, (f, x, y) => {
    if (f === 'front') {
      if (y === 3 && (x === 1 || x === 8)) return [240, 210, 80];
      if (y >= 6) return y === 6 ? mouth : s.vary(hideD, 0.05);
    }
    return s.vary((x * 3 + y * 5) % 7 === 0 ? hideD : hide, 0.06);
  });
  // horn 2x8x2 at (48,0)
  s.box(48, 0, 2, 8, 2, (f, x, y) => (y < 2 ? mul(horn, 1.05) : horn));
  // body 14x14x24 at (0,24)?  (box needs 2*(24+14)=76 > 64: drawn as 14x14x18 at (0,24))
  s.box(0, 24, 14, 12, 18, (f, x, y) => s.vary((x + y * 2) % 9 === 0 ? hideD : hide, 0.06));
  // leg 6x14x6 at (40,12)
  s.box(40, 12, 6, 14, 6, (f, x, y) => (y >= 12 ? [44, 40, 36] : s.vary(hide, 0.06)));
  return s.d;
}

// --- round six animals ---------------------------------------------------------------
function paintRabbit(seed, fur, furD, belly) {
  const s = new Skin(seed);
  // head 3x3x3 at (0,0)
  s.box(0, 0, 3, 3, 3, (f, x, y) => {
    if ((f === 'left' || f === 'right') && y === 1 && x === 1) return [30, 24, 22];
    if (f === 'front' && y === 2 && x === 1) return [220, 150, 150];
    if (f === 'front' && y === 2) return s.vary(belly, 0.04);
    return s.vary(fur, 0.05);
  });
  // ear 1x3x1 at (16,0)
  s.box(16, 0, 1, 3, 1, (f, x, y) => (f === 'front' ? [226, 180, 176] : s.vary(furD, 0.05)));
  // tail 2x2x2 at (24,0)
  s.box(24, 0, 2, 2, 2, () => s.vary([246, 244, 238], 0.03));
  // front leg 1x2x1 at (32,0); haunch 2x2x3 at (40,0)
  s.box(32, 0, 1, 2, 1, () => s.vary(furD, 0.05));
  s.box(40, 0, 2, 2, 3, (f, x, y) => s.vary(y === 1 ? furD : fur, 0.05));
  // body 4x4x6 at (0,16)
  s.box(0, 16, 4, 4, 6, (f, x, y) => (f === 'bottom' ? s.vary(belly, 0.04) : s.vary((x + y) % 4 === 0 ? furD : fur, 0.05)));
  return s.d;
}

function paintGoat() {
  const s = new Skin(161);
  const coat = [232, 228, 218], coatD = [200, 194, 182], horn = [176, 160, 136], hoof = [70, 60, 52];
  s.box(0, 0, 5, 6, 6, (f, x, y) => {
    if ((f === 'left' || f === 'right') && y === 1 && x === (f === 'left' ? 4 : 1)) return [200, 150, 40];
    if ((f === 'left' || f === 'right') && y === 1 && x === (f === 'left' ? 3 : 2)) return [30, 26, 22];
    if (f === 'front' && y >= 4) return s.vary([200, 186, 172], 0.04);
    return s.vary(coat, 0.04);
  });
  s.box(22, 0, 1, 3, 2, () => s.vary(coatD, 0.05));
  s.box(28, 0, 1, 4, 1, (f, x, y) => s.vary(y === 0 ? mul(horn, 0.8) : horn, 0.04));
  s.box(34, 0, 2, 1, 1, () => s.vary(coatD, 0.05));
  s.box(40, 0, 2, 2, 1, () => s.vary(coat, 0.04));
  s.box(48, 0, 3, 8, 3, (f, x, y) => (y >= 7 ? hoof : s.vary(y > 4 ? coatD : coat, 0.04)));
  s.box(0, 28, 9, 9, 15, (f, x, y) => s.vary((x * 3 + y * 5) % 7 === 0 ? coatD : coat, 0.05));
  return s.d;
}

function paintTurtle() {
  const s = new Skin(163);
  const shell = [70, 110, 48], plate = [104, 146, 70], skin = [120, 168, 104], belly = [216, 206, 150];
  // shell 14x5x16 at (0,0): plates on top
  s.box(0, 0, 14, 5, 16, (f, x, y) => {
    if (f === 'top') return ((x % 5 === 0) || (y % 5 === 0)) ? s.vary(mul(shell, 0.75), 0.05) : s.vary(plate, 0.06);
    if (f === 'bottom') return s.vary(belly, 0.04);
    return s.vary(y === 4 ? mul(shell, 0.8) : shell, 0.05);
  });
  s.box(0, 22, 12, 1, 14, () => s.vary(belly, 0.04));
  s.box(0, 38, 4, 3, 4, (f, x, y) => {
    if ((f === 'left' || f === 'right') && y === 0 && x === (f === 'left' ? 1 : 2)) return [20, 24, 20];
    return s.vary(skin, 0.05);
  });
  s.box(16, 38, 5, 1, 3, () => s.vary(skin, 0.05));
  s.box(32, 38, 3, 1, 4, () => s.vary(skin, 0.05));
  return s.d;
}

function paintSquid() {
  const s = new Skin(165);
  const ink = [36, 58, 92], inkL = [64, 96, 136], spot = [96, 130, 170];
  s.box(0, 0, 8, 10, 8, (f, x, y) => {
    if (f === 'front' && y === 7 && (x === 1 || x === 6)) return [240, 236, 220];
    if (f === 'front' && y === 7 && (x === 2 || x === 5)) return [20, 20, 24];
    return s.vary((x * 5 + y * 3) % 9 === 0 ? spot : y > 6 ? inkL : ink, 0.05);
  });
  s.box(40, 0, 2, 8, 2, (f, x, y) => s.vary(y > 5 ? inkL : ink, 0.06));
  return s.d;
}

function paintFrog(seed, back, side, belly) {
  const s = new Skin(seed);
  s.box(0, 0, 7, 2, 7, (f, x, y) => (f === 'front' && y === 1 ? s.vary(mul(side, 0.8), 0.04) : f === 'bottom' ? s.vary(belly, 0.04) : s.vary(back, 0.05)));
  s.box(28, 0, 3, 2, 3, (f, x, y) => (f === 'front' || f === 'left' || f === 'right' ? (x === 1 && y === 0 ? [20, 18, 14] : [230, 220, 160]) : s.vary(back, 0.05)));
  s.box(40, 0, 2, 2, 2, () => s.vary(side, 0.05));
  s.box(48, 8, 3, 2, 3, () => s.vary(side, 0.05));
  s.box(0, 16, 7, 3, 9, (f, x, y) => (f === 'bottom' ? s.vary(belly, 0.04) : f === 'top' ? s.vary((x + y) % 5 === 0 ? mul(back, 0.8) : back, 0.05) : s.vary(side, 0.05)));
  return s.d;
}

// The Listener: eyeless, dark as the deep, ribbed with bone, its chest
// lit by trapped souls; fronds on its head flare when it hears.
function paintListener() {
  const s = new Skin(191);
  const hide = [14, 36, 44], hideD = [8, 22, 28], bone = [214, 206, 180], soul = [70, 230, 240];
  // head 12x12x10 at (0,0)
  s.box(0, 0, 12, 12, 10, (f, x, y) => {
    if (f === 'front' && y >= 7 && y <= 9 && x >= 3 && x <= 8) return y === 8 ? [4, 8, 10] : s.vary(bone, 0.05); // a jaw, no eyes
    if (f === 'top' && (x + y) % 4 === 0) return s.vary(soul, 0.1);
    return s.vary((x * 3 + y * 5) % 7 === 0 ? hideD : hide, 0.08);
  });
  // body 14x16x8 at (0,22)
  s.box(0, 22, 14, 16, 8, (f, x, y, w, h) => {
    if (f === 'front') {
      if (y % 3 === 1 && x >= 2 && x <= w - 3 && y < 11) return s.vary(bone, 0.05); // ribs
      if (Math.hypot(x - 6.5, y - 6) < 2.5) return s.vary(soul, 0.08);            // the souls within
    }
    if (f === 'back' && x === 6) return s.vary(bone, 0.05);                         // a spine
    return s.vary(hide, 0.08);
  });
  // arm 5x18x5 at (44,0)
  s.box(44, 0, 5, 18, 5, (f, x, y) => (y >= 15 ? s.vary(bone, 0.06) : s.vary((x + y) % 5 === 0 ? hideD : hide, 0.08)));
  // leg 5x14x5 at (44,24)
  s.box(44, 24, 5, 14, 5, (f, x, y) => s.vary(y >= 12 ? hideD : hide, 0.08));
  // frond 5x6x1 at (0,46)
  s.box(0, 46, 5, 6, 1, (f, x, y) => (f === 'front' && x > 0 && x < 4 && y > 0 ? s.vary(soul, 0.1) : s.vary(hideD, 0.06)));
  return s.d;
}

function paintCamel() {
  const s = new Skin(193);
  const coat = [210, 170, 110], coatD = [176, 134, 80], hump = [196, 150, 90], dark = [80, 58, 40];
  // neck 4x12x4 at (0,0)
  s.box(0, 0, 4, 12, 4, () => s.vary(coat, 0.05));
  // head 5x5x9 at (16,0)
  s.box(16, 0, 5, 5, 9, (f, x, y) => {
    if ((f === 'left' || f === 'right') && y === 1 && x === (f === 'left' ? 6 : 2)) return [24, 18, 14];
    if (f === 'front') return y >= 3 ? s.vary(mul(coatD, 0.85), 0.05) : s.vary(coatD, 0.05);
    return s.vary(coat, 0.05);
  });
  // ear 1x2x1 at (44,0)
  s.box(44, 0, 1, 2, 1, () => s.vary(coatD, 0.05));
  // hump 6x5x8 at (0,17)
  s.box(0, 17, 6, 5, 8, (f, x, y) => s.vary(f === 'top' ? mul(hump, 1.05) : hump, 0.05));
  // leg 3x16x3 at (40,15)
  s.box(40, 15, 3, 16, 3, (f, x, y) => (y >= 15 ? dark : s.vary(y > 9 ? coatD : coat, 0.05)));
  // body 12x10x18 at (0,36)
  s.box(0, 36, 12, 10, 18, (f, x, y) => s.vary(f === 'bottom' ? coatD : (x * 5 + y * 3) % 11 === 0 ? coatD : coat, 0.05));
  return s.d;
}

export const OUTFITS = {
  farmer: { tunic: [96, 130, 60], trim: [150, 120, 70], pants: [110, 84, 56], hat: [226, 196, 110], hatBand: [150, 60, 40] },
  smith: { tunic: [70, 64, 60], trim: [120, 80, 40], pants: [56, 52, 50], hat: [90, 70, 50], hatBand: [60, 44, 30], beard: true },
  shepherd: { tunic: [226, 222, 210], trim: [140, 100, 60], pants: [120, 90, 60], hat: [120, 80, 50], hatBand: [226, 222, 210] },
  scholar: { tunic: [60, 70, 140], trim: [220, 190, 90], pants: [50, 50, 70], hat: null, hatBand: null, beard: true },
};

export function generateSkins(detail = 1) {
  SKIN_K = detail;
  try { return paintSkins(); } finally { SKIN_K = 1; }
}

function paintSkins() {
  const out = new Array(SKIN_COUNT);
  out[SKIN.PLAYER] = paintPlayer();
  out[SKIN.PIG] = paintPig();
  out[SKIN.COW] = paintCow();
  out[SKIN.SHEEP] = paintSheep();
  out[SKIN.CHICKEN] = paintChicken();
  out[SKIN.GHOUL] = paintGhoul();
  out[SKIN.SHEEP_WOOL] = paintSheepWool();
  out[SKIN.FARMER] = paintSettler(3, OUTFITS.farmer);
  out[SKIN.SMITH] = paintSettler(5, OUTFITS.smith);
  out[SKIN.SHEPHERD] = paintSettler(2, OUTFITS.shepherd);
  out[SKIN.SCHOLAR] = paintSettler(8, OUTFITS.scholar);
  out[SKIN.ARCHER] = paintArcher();
  out[SKIN.CRAWLER] = paintCrawler();
  out[SKIN.IMP] = paintImp();
  for (const [mat, layer] of Object.entries(ARMOR_SKIN)) {
    out[layer] = paintArmor(mat, false);
    out[layer + 1] = paintArmor(mat, true);
  }
  out[SKIN.GLOAMER] = paintGloamer();
  out[SKIN.WYRM] = paintWyrm();
  out[SKIN.GLIDER] = paintGlider();
  out[SKIN.HOUND] = paintHound();
  out[SKIN.STEED_BROWN] = paintSteed(93, [140, 92, 54], [104, 66, 38], [50, 36, 26], false);
  out[SKIN.STEED_WHITE] = paintSteed(95, [226, 222, 214], [190, 184, 176], [210, 206, 196], false);
  out[SKIN.STEED_BLACK] = paintSteed(97, [48, 42, 40], [30, 26, 24], [24, 20, 18], true);
  out[SKIN.STEED_SADDLE] = paintSaddle();
  out[SKIN.SENTINEL] = paintSentinel();
  out[SKIN.SENTINEL_LIMBS] = paintSentinelLimbs();
  out[SKIN.FROST] = paintFrost();
  out[SKIN.HEXER] = paintHexer();
  out[SKIN.WARDEN] = paintWarden();
  out[SKIN.SHROOMCOW] = paintShroomcow();
  out[SKIN.FOX_RED] = paintFox(111, [214, 110, 40], [168, 76, 26], [240, 234, 222], [56, 40, 34]);
  out[SKIN.FOX_SNOW] = paintFox(113, [236, 236, 240], [200, 202, 212], [250, 250, 252], [120, 116, 124]);
  out[SKIN.CAT_TABBY] = paintCat(121, [138, 120, 96], [86, 72, 58], [214, 204, 186], 'stripes');
  out[SKIN.CAT_BLACK] = paintCat(123, [36, 32, 36], [28, 24, 28], [230, 226, 220], 'solid');
  out[SKIN.CAT_GINGER] = paintCat(125, [220, 132, 56], [176, 92, 34], [240, 222, 196], 'stripes');
  out[SKIN.CAT_CREAM] = paintCat(127, [234, 222, 200], [96, 76, 62], [244, 236, 222], 'points');
  out[SKIN.CAT_CALICO] = paintCat(129, [240, 236, 228], [214, 130, 50], [246, 242, 236], 'patches');
  out[SKIN.PARROT_SCARLET] = paintParrot(131, [214, 36, 30], [50, 90, 210], [226, 52, 40], [240, 200, 50], [60, 56, 60]);
  out[SKIN.PARROT_AZURE] = paintParrot(133, [50, 110, 220], [40, 70, 170], [90, 170, 240], [230, 200, 60], [50, 50, 56]);
  out[SKIN.PARROT_EMERALD] = paintParrot(135, [60, 170, 60], [40, 120, 50], [230, 60, 40], [70, 120, 220], [236, 200, 70]);
  out[SKIN.PARROT_SUNNY] = paintParrot(137, [246, 200, 40], [60, 160, 220], [250, 226, 90], [60, 120, 210], [50, 50, 56]);
  out[SKIN.PARROT_SLATE] = paintParrot(139, [150, 154, 160], [110, 114, 122], [236, 236, 240], [200, 50, 40], [40, 40, 44]);
  out[SKIN.BEE] = paintBee();
  out[SKIN.ALPACA_CREAM] = paintAlpaca(141, [232, 214, 176], [200, 182, 146]);
  out[SKIN.ALPACA_BROWN] = paintAlpaca(143, [146, 104, 70], [112, 78, 50]);
  out[SKIN.ALPACA_GREY] = paintAlpaca(145, [156, 152, 146], [120, 116, 112]);
  out[SKIN.ALPACA_WHITE] = paintAlpaca(147, [242, 240, 234], [214, 210, 204]);
  out[SKIN.ALPACA_PACK] = paintPack();
  out[SKIN.DOLPHIN] = paintDolphin();
  out[SKIN.STARSTEEL] = paintArmor('starsteel', false);
  out[SKIN.STARSTEEL + 1] = paintArmor('starsteel', true);
  out[SKIN.MARAUDER] = paintMarauder(151, false);
  out[SKIN.CAPTAIN] = paintMarauder(153, true);
  out[SKIN.BRUTE] = paintBrute();
  out[SKIN.RABBIT_BROWN] = paintRabbit(171, [150, 112, 76], [116, 84, 56], [214, 196, 170]);
  out[SKIN.RABBIT_WHITE] = paintRabbit(173, [240, 238, 234], [214, 210, 206], [250, 248, 246]);
  out[SKIN.RABBIT_GOLD] = paintRabbit(175, [220, 186, 116], [186, 150, 86], [240, 222, 180]);
  out[SKIN.GOAT] = paintGoat();
  out[SKIN.TURTLE] = paintTurtle();
  out[SKIN.SQUID] = paintSquid();
  out[SKIN.FROG_MARSH] = paintFrog(181, [196, 122, 56], [170, 100, 44], [236, 210, 160]);
  out[SKIN.FROG_WARM] = paintFrog(183, [236, 230, 210], [214, 200, 170], [250, 244, 230]);
  out[SKIN.FROG_COLD] = paintFrog(185, [90, 150, 70], [70, 120, 56], [210, 220, 170]);
  out[SKIN.LISTENER] = paintListener();
  out[SKIN.CAMEL] = paintCamel();
  out[SKIN.TURTLE_SHELL] = paintArmor('turtle', false);
  out[SKIN.TURTLE_SHELL + 1] = paintArmor('turtle', true);
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
    skin: SKIN.GHOUL, width: 0.6, height: 1.9, humanoid: true,
    parts: {
      head: { box: [-3.5, 24, -3.5, 7, 8, 7], uv: [0, 0], pivot: [0, 24, 0] },
      body: { box: [-4, 12, -2, 8, 12, 4], uv: [16, 16], pivot: [0, 24, 0] },
      armR: { box: [-7, 9, -1.5, 3, 14, 3], uv: [40, 16], pivot: [-5.5, 22, 0] },
      armL: { box: [4, 9, -1.5, 3, 14, 3], uv: [40, 16], pivot: [5.5, 22, 0], mirror: true },
      legR: { box: [-3.5, 0, -1.5, 3, 12, 3], uv: [0, 32], pivot: [-2, 12, 0] },
      legL: { box: [0.5, 0, -1.5, 3, 12, 3], uv: [0, 32], pivot: [2, 12, 0], mirror: true },
    },
  },
  settler: {
    skin: SKIN.FARMER, width: 0.6, height: 1.9, humanoid: true,
    parts: {
      head: { box: [-4, 24, -4, 8, 8, 8], uv: [0, 0], pivot: [0, 24, 0] },
      brim: { box: [-6, 30, -6, 12, 1, 12], uv: [0, 32], pivot: [0, 24, 0], parent: 'head', hat: true },
      crown: { box: [-4, 31, -4, 8, 3, 8], uv: [32, 0], pivot: [0, 24, 0], parent: 'head', hat: true },
      body: { box: [-4, 12, -2, 8, 12, 4], uv: [16, 16], pivot: [0, 24, 0] },
      armR: { box: [-8, 12, -2, 4, 12, 4], uv: [40, 16], pivot: [-6, 22, 0] },
      armL: { box: [4, 12, -2, 4, 12, 4], uv: [40, 16], pivot: [6, 22, 0], mirror: true },
      legR: { box: [-4, 0, -2, 4, 12, 4], uv: [0, 16], pivot: [-2, 12, 0] },
      legL: { box: [0, 0, -2, 4, 12, 4], uv: [0, 16], pivot: [2, 12, 0], mirror: true },
    },
  },
  archer: {
    skin: SKIN.ARCHER, width: 0.6, height: 1.95, humanoid: true,
    parts: {
      head: { box: [-4, 24, -4, 8, 8, 8], uv: [0, 0], pivot: [0, 24, 0] },
      body: { box: [-4, 12, -2, 8, 12, 4], uv: [16, 16], pivot: [0, 24, 0] },
      armR: { box: [-6, 12, -1, 2, 12, 2], uv: [40, 16], pivot: [-5, 22, 0] },
      armL: { box: [4, 12, -1, 2, 12, 2], uv: [40, 16], pivot: [5, 22, 0], mirror: true },
      legR: { box: [-3, 0, -1, 2, 12, 2], uv: [0, 16], pivot: [-2, 12, 0] },
      legL: { box: [1, 0, -1, 2, 12, 2], uv: [0, 16], pivot: [2, 12, 0], mirror: true },
    },
  },
  crawler: {
    skin: SKIN.CRAWLER, width: 1.3, height: 0.8,
    parts: {
      head: { box: [-4, 5, -12, 8, 6, 8], uv: [0, 0], pivot: [0, 8, -5] },
      thorax: { box: [-3, 5, -5, 6, 5, 6], uv: [0, 16], pivot: [0, 8, 0] },
      abdomen: { box: [-5, 5, 1, 10, 8, 12], uv: [0, 28], pivot: [0, 8, 1] },
      leg0: { box: [-17, 7, -3, 14, 2, 2], uv: [0, 48], pivot: [-3, 8, -2] },
      leg1: { box: [3, 7, -3, 14, 2, 2], uv: [0, 48], pivot: [3, 8, -2] },
      leg2: { box: [-17, 7, -1, 14, 2, 2], uv: [0, 48], pivot: [-3, 8, 0] },
      leg3: { box: [3, 7, -1, 14, 2, 2], uv: [0, 48], pivot: [3, 8, 0] },
      leg4: { box: [-17, 7, 1, 14, 2, 2], uv: [0, 48], pivot: [-3, 8, 2] },
      leg5: { box: [3, 7, 1, 14, 2, 2], uv: [0, 48], pivot: [3, 8, 2] },
      leg6: { box: [-17, 7, 3, 14, 2, 2], uv: [0, 48], pivot: [-3, 8, 4] },
      leg7: { box: [3, 7, 3, 14, 2, 2], uv: [0, 48], pivot: [3, 8, 4] },
    },
  },
  imp: {
    skin: SKIN.IMP, width: 0.5, height: 1.1, humanoid: true,
    parts: {
      head: { box: [-3, 13, -3, 6, 6, 6], uv: [0, 0], pivot: [0, 13, 0] },
      hornR: { box: [-3, 19, -1, 1, 3, 1], uv: [24, 0], pivot: [0, 13, 0], parent: 'head' },
      hornL: { box: [2, 19, -1, 1, 3, 1], uv: [24, 0], pivot: [0, 13, 0], parent: 'head' },
      body: { box: [-3, 6, -1.5, 6, 7, 3], uv: [16, 16], pivot: [0, 13, 0] },
      armR: { box: [-5, 6, -1, 2, 7, 2], uv: [40, 16], pivot: [-4, 12, 0] },
      armL: { box: [3, 6, -1, 2, 7, 2], uv: [40, 16], pivot: [4, 12, 0], mirror: true },
      legR: { box: [-3, 0, -1, 2, 6, 2], uv: [0, 16], pivot: [-2, 6, 0] },
      legL: { box: [1, 0, -1, 2, 6, 2], uv: [0, 16], pivot: [2, 6, 0], mirror: true },
      tail: { box: [-0.5, 6, 1.5, 1, 1, 6], uv: [48, 16], pivot: [0, 7, 1.5] },
    },
  },
};

MODELS.gloamer = {
  skin: SKIN.GLOAMER, width: 0.6, height: 2.9, humanoid: true,
  parts: {
    head: { box: [-4, 38, -4, 8, 8, 8], uv: [0, 0], pivot: [0, 38, 0] },
    body: { box: [-4, 26, -2, 8, 12, 4], uv: [16, 16], pivot: [0, 38, 0] },
    armR: { box: [-6, 12, -1, 2, 24, 2], uv: [40, 16], pivot: [-5, 36, 0] },
    armL: { box: [4, 12, -1, 2, 24, 2], uv: [40, 16], pivot: [5, 36, 0], mirror: true },
    legR: { box: [-3, 0, -1, 2, 26, 2], uv: [0, 16], pivot: [-2, 26, 0] },
    legL: { box: [1, 0, -1, 2, 26, 2], uv: [0, 16], pivot: [2, 26, 0], mirror: true },
  },
};

// --- round four creatures ---------------------------------------------------------
MODELS.hound = {
  skin: SKIN.HOUND, width: 0.6, height: 0.85,
  parts: {
    body: { box: [-3, 7, -4, 6, 6, 9], uv: [0, 12], pivot: [0, 10, 0] },
    mane: { box: [-4, 7, -7, 8, 7, 6], uv: [32, 10], pivot: [0, 10, 0] },
    collar: { box: [-4.5, 12, -7.5, 9, 2, 7], uv: [30, 28], pivot: [0, 10, 0], tamedOnly: true },
    head: { box: [-3, 10, -11, 6, 6, 4], uv: [0, 0], pivot: [0, 13, -7] },
    snout: { box: [-1.5, 10, -14, 3, 3, 3], uv: [20, 0], pivot: [0, 13, -7], parent: 'head' },
    earR: { box: [-3, 16, -9, 2, 2, 1], uv: [36, 0], pivot: [0, 13, -7], parent: 'head' },
    earL: { box: [1, 16, -9, 2, 2, 1], uv: [36, 0], pivot: [0, 13, -7], parent: 'head' },
    leg0: { box: [-3, 0, -6, 2, 7, 2], uv: [0, 28], pivot: [-2, 7, -5] },
    leg1: { box: [1, 0, -6, 2, 7, 2], uv: [0, 28], pivot: [2, 7, -5] },
    leg2: { box: [-3, 0, 2, 2, 7, 2], uv: [0, 28], pivot: [-2, 7, 3] },
    leg3: { box: [1, 0, 2, 2, 7, 2], uv: [0, 28], pivot: [2, 7, 3] },
    tail: { box: [-1, 4, 5, 2, 8, 2], uv: [10, 28], pivot: [0, 12, 6] },
  },
};
MODELS.steed = {
  skin: SKIN.STEED_BROWN, width: 1.3, height: 1.6,
  parts: {
    body: { box: [-5, 11, -10, 10, 10, 20], uv: [0, 34], pivot: [0, 16, 0] },
    neck: { box: [-2, 16, -14, 4, 12, 7], uv: [0, 0], pivot: [0, 20, -9] },
    head: { box: [-3, 25, -18, 6, 6, 8], uv: [22, 0], pivot: [0, 20, -9], parent: 'neck' },
    muzzle: { box: [-2, 23, -21, 4, 5, 5], uv: [22, 14], pivot: [0, 20, -9], parent: 'neck' },
    earR: { box: [-2.5, 31, -12, 2, 3, 1], uv: [50, 0], pivot: [0, 20, -9], parent: 'neck' },
    earL: { box: [0.5, 31, -12, 2, 3, 1], uv: [50, 0], pivot: [0, 20, -9], parent: 'neck' },
    mane: { box: [-1, 18, -8, 2, 13, 3], uv: [40, 14], pivot: [0, 20, -9], parent: 'neck' },
    tail: { box: [-1.5, 8, 10, 3, 10, 3], uv: [50, 4], pivot: [0, 19, 10] },
    leg0: { box: [-4.5, 0, -9, 3, 11, 3], uv: [0, 19], pivot: [-3, 11, -7.5] },
    leg1: { box: [1.5, 0, -9, 3, 11, 3], uv: [0, 19], pivot: [3, 11, -7.5] },
    leg2: { box: [-4.5, 0, 6, 3, 11, 3], uv: [0, 19], pivot: [-3, 11, 7.5] },
    leg3: { box: [1.5, 0, 6, 3, 11, 3], uv: [0, 19], pivot: [3, 11, 7.5] },
    saddle: { box: [-5.5, 21, -5, 11, 2, 9], uv: [0, 0], pivot: [0, 16, 0], skin: SKIN.STEED_SADDLE, saddleOnly: true },
    strapR: { box: [-5.6, 13, -1, 1, 8, 1], uv: [0, 12], pivot: [0, 16, 0], skin: SKIN.STEED_SADDLE, saddleOnly: true },
    strapL: { box: [4.6, 13, -1, 1, 8, 1], uv: [0, 12], pivot: [0, 16, 0], skin: SKIN.STEED_SADDLE, saddleOnly: true },
    bridle: { box: [-3.3, 24.7, -16, 6.6, 2, 6], uv: [0, 24], pivot: [0, 20, -9], parent: 'neck', skin: SKIN.STEED_SADDLE, saddleOnly: true },
  },
};
MODELS.sentinel = {
  skin: SKIN.SENTINEL, width: 1.4, height: 2.7, humanoid: true,
  parts: {
    head: { box: [-4, 38, -7.5, 8, 10, 8], uv: [0, 0], pivot: [0, 38, -2] },
    nose: { box: [-1, 37, -9.5, 2, 4, 2], uv: [32, 0], pivot: [0, 38, -2], parent: 'head' },
    body: { box: [-9, 26, -6, 18, 12, 11], uv: [0, 41], pivot: [0, 26, 0] },
    waist: { box: [-4.5, 20, -3, 9, 6, 6], uv: [32, 6], pivot: [0, 26, 0] },
    armR: { box: [-13, 4, -3, 4, 30, 6], uv: [0, 0], pivot: [-11, 35, 0], skin: SKIN.SENTINEL_LIMBS },
    armL: { box: [9, 4, -3, 4, 30, 6], uv: [0, 0], pivot: [11, 35, 0], skin: SKIN.SENTINEL_LIMBS, mirror: true },
    legR: { box: [-7, 0, -2.5, 6, 20, 5], uv: [20, 0], pivot: [-4, 20, 0], skin: SKIN.SENTINEL_LIMBS },
    legL: { box: [1, 0, -2.5, 6, 20, 5], uv: [20, 0], pivot: [4, 20, 0], skin: SKIN.SENTINEL_LIMBS, mirror: true },
  },
};
MODELS.frost_sentinel = {
  skin: SKIN.FROST, width: 0.7, height: 1.9,
  parts: {
    lower: { box: [-6, 0, -6, 12, 12, 12], uv: [0, 40], pivot: [0, 6, 0] },
    upper: { box: [-5, 11, -5, 10, 10, 10], uv: [0, 20], pivot: [0, 16, 0] },
    head: { box: [-4, 20.5, -4, 8, 8, 8], uv: [0, 0], pivot: [0, 21, 0] },
    armR: { box: [-15, 17, -1, 10, 2, 2], uv: [32, 0], pivot: [-5, 18, 0] },
    armL: { box: [5, 17, -1, 10, 2, 2], uv: [32, 0], pivot: [5, 18, 0], mirror: true },
  },
};
MODELS.hexer = {
  skin: SKIN.HEXER, width: 0.6, height: 2.2, humanoid: true,
  parts: {
    head: { box: [-4, 24, -4, 8, 8, 8], uv: [0, 0], pivot: [0, 24, 0] },
    nose: { box: [-1, 25, -6, 2, 4, 2], uv: [32, 0], pivot: [0, 24, 0], parent: 'head' },
    brim: { box: [-5, 31, -5, 10, 1, 10], uv: [0, 16], pivot: [0, 24, 0], parent: 'head' },
    hatMid: { box: [-3.5, 32, -3.5, 7, 4, 7], uv: [0, 27], pivot: [0, 24, 0], parent: 'head' },
    hatTip: { box: [-2, 36, -1.5, 4, 4, 4], uv: [28, 27], pivot: [0, 24, 0], parent: 'head' },
    hatPoint: { box: [-1, 40, 0, 2, 3, 2], uv: [44, 27], pivot: [0, 24, 0], parent: 'head' },
    body: { box: [-4, 12, -3, 8, 12, 6], uv: [0, 38], pivot: [0, 24, 0] },
    armR: { box: [-8, 12, -2, 4, 12, 4], uv: [44, 38], pivot: [-6, 22, 0] },
    armL: { box: [4, 12, -2, 4, 12, 4], uv: [44, 38], pivot: [6, 22, 0], mirror: true },
    legR: { box: [-4, 0, -2, 4, 12, 4], uv: [28, 38], pivot: [-2, 12, 0] },
    legL: { box: [0, 0, -2, 4, 12, 4], uv: [28, 38], pivot: [2, 12, 0], mirror: true },
  },
};
MODELS.tide_warden = {
  skin: SKIN.WARDEN, width: 0.85, height: 0.85,
  parts: {
    body: { box: [-6, 1, -6, 12, 12, 12], uv: [0, 0], pivot: [0, 7, 0] },
    tail: { box: [-2, 5, 6, 4, 4, 6], uv: [0, 24], pivot: [0, 7, 6] },
    tail2: { box: [-1.5, 5.5, 12, 3, 3, 5], uv: [20, 24], pivot: [0, 7, 6], parent: 'tail' },
    fin: { box: [-0.5, 4, 16, 1, 6, 4], uv: [36, 24], pivot: [0, 7, 6], parent: 'tail' },
    spike0: { box: [-0.5, 13, -0.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
    spike1: { box: [-0.5, -3, -0.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
    spike2: { box: [-6.5, 13, -6.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
    spike3: { box: [5.5, 13, -6.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
    spike4: { box: [-6.5, 13, 5.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
    spike5: { box: [5.5, 13, 5.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
    spike6: { box: [-6.5, -3, -6.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
    spike7: { box: [5.5, -3, 5.5, 1, 4, 1], uv: [48, 0], pivot: [0, 7, 0] },
  },
};
MODELS.shroomcow = {
  ...MODELS.cow, skin: SKIN.SHROOMCOW,
  parts: {
    ...MODELS.cow.parts,
    cap0: { box: [-4, 20, -4, 4, 2, 4], uv: [0, 44], pivot: [0, 15, 0] },
    stem0: { box: [-3, 18, -3, 2, 2, 2], uv: [16, 44], pivot: [0, 15, 0] },
    cap1: { box: [1, 20, 2, 4, 2, 4], uv: [0, 44], pivot: [0, 15, 0] },
    stem1: { box: [2, 18, 3, 2, 2, 2], uv: [16, 44], pivot: [0, 15, 0] },
    cap2: { box: [-2, 23, -12, 4, 2, 4], uv: [0, 44], pivot: [0, 18, -8], parent: 'head' },
    stem2: { box: [-1, 21, -11, 2, 2, 2], uv: [16, 44], pivot: [0, 18, -8], parent: 'head' },
  },
};

// --- round five animals -----------------------------------------------------------
MODELS.fox = {
  skin: SKIN.FOX_RED, width: 0.6, height: 0.7,
  parts: {
    body: { box: [-3, 5, -5, 6, 6, 11], uv: [0, 16], pivot: [0, 8, 0] },
    head: { box: [-4, 7, -10, 8, 6, 5], uv: [0, 0], pivot: [0, 9, -5] },
    snout: { box: [-2, 7, -13, 4, 2, 3], uv: [26, 0], pivot: [0, 9, -5], parent: 'head' },
    earR: { box: [-4, 13, -8, 2, 3, 1], uv: [40, 0], pivot: [0, 9, -5], parent: 'head' },
    earL: { box: [2, 13, -8, 2, 3, 1], uv: [40, 0], pivot: [0, 9, -5], parent: 'head' },
    leg0: { box: [-3, 0, -4, 2, 5, 2], uv: [0, 40], pivot: [-2, 5, -3] },
    leg1: { box: [1, 0, -4, 2, 5, 2], uv: [0, 40], pivot: [2, 5, -3] },
    leg2: { box: [-3, 0, 3, 2, 5, 2], uv: [0, 40], pivot: [-2, 5, 4] },
    leg3: { box: [1, 0, 3, 2, 5, 2], uv: [0, 40], pivot: [2, 5, 4] },
    tail: { box: [-2, 3, 6, 4, 4, 9], uv: [34, 16], pivot: [0, 9, 6] },
  },
};
MODELS.cat = {
  skin: SKIN.CAT_TABBY, width: 0.6, height: 0.7,
  parts: {
    body: { box: [-2, 5, -6, 4, 4, 12], uv: [0, 16], pivot: [0, 7, 0] },
    head: { box: [-2.5, 7, -10.5, 5, 4, 5], uv: [0, 0], pivot: [0, 9, -6] },
    nose: { box: [-1.5, 7, -11.5, 3, 2, 1], uv: [20, 0], pivot: [0, 9, -6], parent: 'head' },
    earR: { box: [-2.5, 11, -8.5, 1, 1, 2], uv: [28, 0], pivot: [0, 9, -6], parent: 'head' },
    earL: { box: [1.5, 11, -8.5, 1, 1, 2], uv: [28, 0], pivot: [0, 9, -6], parent: 'head' },
    leg0: { box: [-2, 0, -5, 2, 6, 2], uv: [0, 36], pivot: [-1, 6, -4] },
    leg1: { box: [0, 0, -5, 2, 6, 2], uv: [0, 36], pivot: [1, 6, -4] },
    leg2: { box: [-2, 0, 3, 2, 6, 2], uv: [0, 36], pivot: [-1, 6, 4] },
    leg3: { box: [0, 0, 3, 2, 6, 2], uv: [0, 36], pivot: [1, 6, 4] },
    tail: { box: [-0.5, 8, 6, 1, 1, 8], uv: [40, 0], pivot: [0, 8.5, 6] },
    tail2: { box: [-0.5, 8, 14, 1, 1, 6], uv: [40, 10], pivot: [0, 8.5, 6], parent: 'tail' },
  },
};
MODELS.parrot = {
  skin: SKIN.PARROT_SCARLET, width: 0.5, height: 0.9,
  parts: {
    body: { box: [-1.5, 4, -1.5, 3, 6, 3], uv: [0, 16], pivot: [0, 7, 0] },
    head: { box: [-1, 10, -1.5, 2, 3, 2], uv: [0, 0], pivot: [0, 10, -0.5] },
    crest: { box: [-0.5, 12, -0.5, 1, 2, 3], uv: [10, 0], pivot: [0, 10, -0.5], parent: 'head' },
    beak: { box: [-0.5, 10.5, -2.5, 1, 2, 1], uv: [20, 0], pivot: [0, 10, -0.5], parent: 'head' },
    beakLow: { box: [-0.5, 10, -2.2, 1, 1, 1], uv: [24, 0], pivot: [0, 10, -0.5], parent: 'head' },
    wingR: { box: [-2.5, 5, -1.5, 1, 5, 3], uv: [20, 16], pivot: [-1.5, 9.5, 0] },
    wingL: { box: [1.5, 5, -1.5, 1, 5, 3], uv: [20, 16], pivot: [1.5, 9.5, 0], mirror: true },
    tail: { box: [-1.5, 1, 1.5, 3, 4, 1], uv: [32, 16], pivot: [0, 4.5, 1.5] },
    legR: { box: [-1, 0, -0.5, 1, 4, 1], uv: [40, 0], pivot: [-0.5, 4, 0] },
    legL: { box: [0, 0, -0.5, 1, 4, 1], uv: [40, 0], pivot: [0.5, 4, 0] },
  },
};
MODELS.bee = {
  skin: SKIN.BEE, width: 0.5, height: 0.5,
  parts: {
    body: { box: [-3.5, 1, -5, 7, 7, 10], uv: [0, 0], pivot: [0, 4.5, 0] },
    stinger: { box: [-0.5, 3.5, 5, 1, 1, 2], uv: [40, 0], pivot: [0, 4.5, 0], parent: 'body' },
    antR: { box: [-2, 6, -8, 1, 2, 3], uv: [44, 0], pivot: [0, 4.5, 0], parent: 'body' },
    antL: { box: [1, 6, -8, 1, 2, 3], uv: [44, 0], pivot: [0, 4.5, 0], parent: 'body' },
    wingR: { box: [-8.5, 8, -3, 8, 0.2, 6], uv: [0, 20], pivot: [-1.5, 8, -1] },
    wingL: { box: [0.5, 8, -3, 8, 0.2, 6], uv: [0, 20], pivot: [1.5, 8, -1], mirror: true },
  },
};
MODELS.alpaca = {
  skin: SKIN.ALPACA_CREAM, width: 0.9, height: 1.87,
  parts: {
    body: { box: [-6, 13, -8, 12, 10, 18], uv: [0, 32], pivot: [0, 18, 0] },
    neck: { box: [-4, 18, -12, 8, 18, 6], uv: [0, 0], pivot: [0, 20, -9] },
    head: { box: [-2, 30, -16, 4, 4, 4], uv: [28, 0], pivot: [0, 20, -9], parent: 'neck' },
    earR: { box: [-4, 36, -10, 2, 3, 2], uv: [44, 0], pivot: [0, 20, -9], parent: 'neck' },
    earL: { box: [2, 36, -10, 2, 3, 2], uv: [44, 0], pivot: [0, 20, -9], parent: 'neck' },
    tail: { box: [-1.5, 16, 10, 3, 4, 2], uv: [28, 10], pivot: [0, 20, 10] },
    leg0: { box: [-5.5, 0, -7, 4, 14, 4], uv: [48, 8], pivot: [-3.5, 14, -5] },
    leg1: { box: [1.5, 0, -7, 4, 14, 4], uv: [48, 8], pivot: [3.5, 14, -5] },
    leg2: { box: [-5.5, 0, 5, 4, 14, 4], uv: [48, 8], pivot: [-3.5, 14, 7] },
    leg3: { box: [1.5, 0, 5, 4, 14, 4], uv: [48, 8], pivot: [3.5, 14, 7] },
    packR: { box: [-9, 13, -1, 3, 8, 8], uv: [0, 0], pivot: [0, 18, 0], skin: SKIN.ALPACA_PACK, packOnly: true },
    packL: { box: [6, 13, -1, 3, 8, 8], uv: [0, 0], pivot: [0, 18, 0], skin: SKIN.ALPACA_PACK, packOnly: true, mirror: true },
  },
};
MODELS.dolphin = {
  skin: SKIN.DOLPHIN, width: 0.9, height: 0.6,
  parts: {
    body: { box: [-4, 0, -6, 8, 7, 13], uv: [0, 0], pivot: [0, 3.5, 0] },
    head: { box: [-3, 0.5, -10, 6, 6, 4], uv: [0, 22], pivot: [0, 3.5, 0], parent: 'body' },
    snout: { box: [-1.5, 1, -14, 3, 2, 4], uv: [20, 22], pivot: [0, 3.5, 0], parent: 'body' },
    fin: { box: [-0.5, 7, -1, 1, 4, 5], uv: [36, 22], pivot: [0, 3.5, 0], parent: 'body' },
    flipR: { box: [-9, 1, -5, 5, 1, 3], uv: [48, 0], pivot: [-4, 1.5, -4] },
    flipL: { box: [4, 1, -5, 5, 1, 3], uv: [48, 0], pivot: [4, 1.5, -4], mirror: true },
    tail: { box: [-2, 1.5, 7, 4, 4, 9], uv: [0, 34], pivot: [0, 3.5, 7] },
    fluke: { box: [-5, 3, 14, 10, 1, 4], uv: [26, 34], pivot: [0, 3.5, 7], parent: 'tail' },
  },
};
MODELS.marauder = {
  skin: SKIN.MARAUDER, width: 0.6, height: 1.95, humanoid: true,
  parts: {
    head: { box: [-4, 24, -4, 8, 8, 8], uv: [0, 0], pivot: [0, 24, 0] },
    nose: { box: [-1, 25, -6, 2, 4, 2], uv: [32, 0], pivot: [0, 24, 0], parent: 'head' },
    body: { box: [-4, 12, -2, 8, 12, 4], uv: [16, 16], pivot: [0, 24, 0] },
    armR: { box: [-8, 12, -2, 4, 12, 4], uv: [40, 16], pivot: [-6, 22, 0] },
    armL: { box: [4, 12, -2, 4, 12, 4], uv: [40, 16], pivot: [6, 22, 0], mirror: true },
    legR: { box: [-4, 0, -2, 4, 12, 4], uv: [0, 16], pivot: [-2, 12, 0] },
    legL: { box: [0, 0, -2, 4, 12, 4], uv: [0, 16], pivot: [2, 12, 0], mirror: true },
  },
};
MODELS.brute = {
  skin: SKIN.BRUTE, width: 1.9, height: 2.2,
  parts: {
    body: { box: [-7, 14, -10, 14, 12, 18], uv: [0, 24], pivot: [0, 20, 0] },
    head: { box: [-5, 14, -22, 10, 10, 14], uv: [0, 0], pivot: [0, 22, -10] },
    hornR: { box: [-7, 22, -16, 2, 8, 2], uv: [48, 0], pivot: [0, 22, -10], parent: 'head' },
    hornL: { box: [5, 22, -16, 2, 8, 2], uv: [48, 0], pivot: [0, 22, -10], parent: 'head' },
    leg0: { box: [-7, 0, -9, 6, 14, 6], uv: [40, 12], pivot: [-4, 14, -6] },
    leg1: { box: [1, 0, -9, 6, 14, 6], uv: [40, 12], pivot: [4, 14, -6] },
    leg2: { box: [-7, 0, 2, 6, 14, 6], uv: [40, 12], pivot: [-4, 14, 5] },
    leg3: { box: [1, 0, 2, 6, 14, 6], uv: [40, 12], pivot: [4, 14, 5] },
  },
};
// --- round six animals -------------------------------------------------------------
MODELS.rabbit = {
  skin: SKIN.RABBIT_BROWN, width: 0.4, height: 0.5,
  parts: {
    body: { box: [-2, 1, -3, 4, 4, 6], uv: [0, 16], pivot: [0, 3, 0] },
    head: { box: [-1.5, 4, -5.5, 3, 3, 3], uv: [0, 0], pivot: [0, 5, -3] },
    earR: { box: [-1.5, 7, -4.5, 1, 3, 1], uv: [16, 0], pivot: [0, 5, -3], parent: 'head' },
    earL: { box: [0.5, 7, -4.5, 1, 3, 1], uv: [16, 0], pivot: [0, 5, -3], parent: 'head' },
    tail: { box: [-1, 3, 3, 2, 2, 2], uv: [24, 0], pivot: [0, 4, 3] },
    leg0: { box: [-1.5, 0, -2.5, 1, 2, 1], uv: [32, 0], pivot: [-1, 2, -2] },
    leg1: { box: [0.5, 0, -2.5, 1, 2, 1], uv: [32, 0], pivot: [1, 2, -2] },
    leg2: { box: [-2.5, 0, 0.5, 2, 2, 3], uv: [40, 0], pivot: [-1.5, 2, 2] },
    leg3: { box: [0.5, 0, 0.5, 2, 2, 3], uv: [40, 0], pivot: [1.5, 2, 2] },
  },
};
MODELS.goat = {
  skin: SKIN.GOAT, width: 0.9, height: 1.3,
  parts: {
    body: { box: [-4.5, 8, -7, 9, 9, 15], uv: [0, 28], pivot: [0, 12, 0] },
    head: { box: [-2.5, 14, -12, 5, 6, 6], uv: [0, 0], pivot: [0, 16, -7] },
    beard: { box: [-0.5, 11, -11, 1, 3, 2], uv: [22, 0], pivot: [0, 16, -7], parent: 'head' },
    hornR: { box: [-2.5, 20, -9, 1, 4, 1], uv: [28, 0], pivot: [0, 16, -7], parent: 'head' },
    hornL: { box: [1.5, 20, -9, 1, 4, 1], uv: [28, 0], pivot: [0, 16, -7], parent: 'head' },
    earR: { box: [-4.5, 18, -9, 2, 1, 1], uv: [34, 0], pivot: [0, 16, -7], parent: 'head' },
    earL: { box: [2.5, 18, -9, 2, 1, 1], uv: [34, 0], pivot: [0, 16, -7], parent: 'head' },
    tail: { box: [-1, 14, 7.5, 2, 2, 1], uv: [40, 0], pivot: [0, 15, 8] },
    leg0: { box: [-4, 0, -6, 3, 8, 3], uv: [48, 0], pivot: [-2.5, 8, -4.5] },
    leg1: { box: [1, 0, -6, 3, 8, 3], uv: [48, 0], pivot: [2.5, 8, -4.5] },
    leg2: { box: [-4, 0, 4, 3, 8, 3], uv: [48, 0], pivot: [-2.5, 8, 5.5] },
    leg3: { box: [1, 0, 4, 3, 8, 3], uv: [48, 0], pivot: [2.5, 8, 5.5] },
  },
};
MODELS.turtle = {
  skin: SKIN.TURTLE, width: 1.2, height: 0.45,
  parts: {
    shell: { box: [-7, 2, -8, 14, 5, 16], uv: [0, 0], pivot: [0, 4, 0] },
    belly: { box: [-6, 1, -7, 12, 1, 14], uv: [0, 22], pivot: [0, 4, 0] },
    head: { box: [-2, 2, -12, 4, 3, 4], uv: [0, 38], pivot: [0, 3, -8] },
    flipR: { box: [-11, 2.5, -6, 5, 1, 3], uv: [16, 38], pivot: [-6, 3, -5] },
    flipL: { box: [6, 2.5, -6, 5, 1, 3], uv: [16, 38], pivot: [6, 3, -5], mirror: true },
    backR: { box: [-6, 2.5, 6, 3, 1, 4], uv: [32, 38], pivot: [-4.5, 3, 7] },
    backL: { box: [3, 2.5, 6, 3, 1, 4], uv: [32, 38], pivot: [4.5, 3, 7], mirror: true },
  },
};
MODELS.squid = {
  skin: SKIN.SQUID, width: 0.8, height: 0.8,
  parts: {
    body: { box: [-4, 6, -4, 8, 10, 8], uv: [0, 0], pivot: [0, 6, 0] },
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const a = (i / 8) * Math.PI * 2, px = Math.round(Math.cos(a) * 3 * 2) / 2, pz = Math.round(Math.sin(a) * 3 * 2) / 2;
      return [`t${i}`, { box: [px - 1, -2, pz - 1, 2, 8, 2], uv: [40, 0], pivot: [px, 6, pz] }];
    })),
  },
};
MODELS.frog = {
  skin: SKIN.FROG_MARSH, width: 0.5, height: 0.5,
  parts: {
    body: { box: [-3.5, 1, -4.5, 7, 3, 9], uv: [0, 16], pivot: [0, 2, 0] },
    head: { box: [-3.5, 4, -4.5, 7, 2, 7], uv: [0, 0], pivot: [0, 4, 2] },
    eyeR: { box: [-3.5, 6, -4, 3, 2, 3], uv: [28, 0], pivot: [0, 4, 2], parent: 'head' },
    eyeL: { box: [0.5, 6, -4, 3, 2, 3], uv: [28, 0], pivot: [0, 4, 2], parent: 'head' },
    leg0: { box: [-3.5, 0, -4, 2, 2, 2], uv: [40, 0], pivot: [-2.5, 2, -3] },
    leg1: { box: [1.5, 0, -4, 2, 2, 2], uv: [40, 0], pivot: [2.5, 2, -3] },
    leg2: { box: [-4.5, 0, 2, 3, 2, 3], uv: [48, 8], pivot: [-3, 2, 3.5] },
    leg3: { box: [1.5, 0, 2, 3, 2, 3], uv: [48, 8], pivot: [3, 2, 3.5] },
  },
};
MODELS.listener = {
  skin: SKIN.LISTENER, width: 0.9, height: 2.9, humanoid: true,
  parts: {
    head: { box: [-6, 30, -5, 12, 12, 10], uv: [0, 0], pivot: [0, 30, 0] },
    frondR: { box: [-11, 36, -0.5, 5, 6, 1], uv: [0, 46], pivot: [-6, 38, 0] },
    frondL: { box: [6, 36, -0.5, 5, 6, 1], uv: [0, 46], pivot: [6, 38, 0], mirror: true },
    body: { box: [-7, 14, -4, 14, 16, 8], uv: [0, 22], pivot: [0, 30, 0] },
    armR: { box: [-12, 10, -2.5, 5, 18, 5], uv: [44, 0], pivot: [-9.5, 27, 0] },
    armL: { box: [7, 10, -2.5, 5, 18, 5], uv: [44, 0], pivot: [9.5, 27, 0], mirror: true },
    legR: { box: [-6, 0, -2.5, 5, 14, 5], uv: [44, 24], pivot: [-3.5, 14, 0] },
    legL: { box: [1, 0, -2.5, 5, 14, 5], uv: [44, 24], pivot: [3.5, 14, 0], mirror: true },
  },
};
MODELS.camel = {
  skin: SKIN.CAMEL, width: 1.6, height: 2.3,
  parts: {
    body: { box: [-6, 16, -9, 12, 10, 18], uv: [0, 36], pivot: [0, 21, 0] },
    hump: { box: [-3, 26, -4, 6, 5, 8], uv: [0, 17], pivot: [0, 21, 0] },
    neck: { box: [-2, 22, -13, 4, 12, 4], uv: [0, 0], pivot: [0, 24, -10] },
    head: { box: [-2.5, 32, -20, 5, 5, 9], uv: [16, 0], pivot: [0, 24, -10], parent: 'neck' },
    earR: { box: [-3.5, 35, -13, 1, 2, 1], uv: [44, 0], pivot: [0, 24, -10], parent: 'neck' },
    earL: { box: [2.5, 35, -13, 1, 2, 1], uv: [44, 0], pivot: [0, 24, -10], parent: 'neck' },
    leg0: { box: [-5.5, 0, -8, 3, 16, 3], uv: [40, 15], pivot: [-4, 16, -6.5] },
    leg1: { box: [2.5, 0, -8, 3, 16, 3], uv: [40, 15], pivot: [4, 16, -6.5] },
    leg2: { box: [-5.5, 0, 5, 3, 16, 3], uv: [40, 15], pivot: [-4, 16, 6.5] },
    leg3: { box: [2.5, 0, 5, 3, 16, 3], uv: [40, 15], pivot: [4, 16, 6.5] },
    saddle: { box: [-5.5, 26, 3, 11, 2, 9], uv: [0, 0], pivot: [0, 21, 0], skin: SKIN.STEED_SADDLE, saddleOnly: true },
  },
};
export const MODEL_VARIANTS = {
  fox: { red: SKIN.FOX_RED, snow: SKIN.FOX_SNOW },
  cat: { tabby: SKIN.CAT_TABBY, black: SKIN.CAT_BLACK, ginger: SKIN.CAT_GINGER, cream: SKIN.CAT_CREAM, calico: SKIN.CAT_CALICO },
  parrot: { scarlet: SKIN.PARROT_SCARLET, azure: SKIN.PARROT_AZURE, emerald: SKIN.PARROT_EMERALD, sunny: SKIN.PARROT_SUNNY, slate: SKIN.PARROT_SLATE },
  alpaca: { cream: SKIN.ALPACA_CREAM, brown: SKIN.ALPACA_BROWN, grey: SKIN.ALPACA_GREY, white: SKIN.ALPACA_WHITE },
  marauder: { captain: SKIN.CAPTAIN },
  rabbit: { brown: SKIN.RABBIT_BROWN, white: SKIN.RABBIT_WHITE, gold: SKIN.RABBIT_GOLD },
  frog: { marsh: SKIN.FROG_MARSH, warm: SKIN.FROG_WARM, cold: SKIN.FROG_COLD },
};

// Wyrm parts are modelled at a quarter scale and drawn four times larger.
export const WYRM_PARTS = {
  head: { box: [-5, -3.5, -12, 10, 7, 12], uv: [0, 0] },
  hornR: { box: [-4, 3.5, -2, 1, 1, 4], uv: [48, 8] },
  hornL: { box: [3, 3.5, -2, 1, 1, 4], uv: [48, 8] },
  body: { box: [-3.5, -3, -3.5, 7, 6, 7], uv: [0, 24] },
  spike: { box: [-0.5, 3, -2, 1, 2, 4], uv: [48, 0] },
  tail: { box: [-2, -2, -2, 4, 4, 4], uv: [32, 24] },
};

// Armor overlays for humanoid models: [part to follow, box, uv, inflate, layer B?]
export const ARMOR_OVERLAYS = {
  helmet: [['head', [-4, 24, -4, 8, 8, 8], [0, 0], 1.0, false]],
  chestplate: [['body', [-4, 12, -2, 8, 12, 4], [16, 16], 1.0, false], ['armR', [-8, 12, -2, 4, 12, 4], [40, 16], 0.9, false], ['armL', [4, 12, -2, 4, 12, 4], [40, 16], 0.9, false, true]],
  leggings: [['body', [-4, 12, -2, 8, 12, 4], [16, 16], 0.5, true], ['legR', [-4, 0, -2, 4, 12, 4], [0, 16], 0.5, true], ['legL', [0, 0, -2, 4, 12, 4], [0, 16], 0.5, true, true]],
  boots: [['legR', [-4, 0, -2, 4, 12, 4], [0, 16], 1.0, false], ['legL', [0, 0, -2, 4, 12, 4], [0, 16], 1.0, false, true]],
};
// Build GPU meshes for each model part (lazily, per renderer).
export function buildModelMeshes(renderer) {
  const out = {};
  // armor overlay meshes per material and piece
  out.armor = {};
  for (const [mat, layer] of Object.entries(ARMOR_SKIN)) {
    out.armor[mat] = {};
    for (const [piece, parts] of Object.entries(ARMOR_OVERLAYS)) {
      out.armor[mat][piece] = parts.map(([follow, [x, y, z, w, h, d], [u, v], inflate, layerB, mirror]) => ({
        follow, model: renderer.createModel(new Float32Array(skinBox(x, y, z, w, h, d, u, v, layerB ? layer + 1 : layer, 64, 64, inflate, !!mirror))),
      }));
    }
  }
  const build = (m, skinOverride) => {
    const parts = {};
    for (const [pn, p] of Object.entries(m.parts)) {
      const [x, y, z, w, h, d] = p.box;
      const skin = p.skin ?? skinOverride ?? m.skin;
      const data = skinBox(x, y, z, w, h, d, p.uv[0], p.uv[1], skin, 64, 64, p.inflate || 0, !!p.mirror);
      parts[pn] = renderer.createModel(new Float32Array(data));
    }
    return parts;
  };
  for (const [name, m] of Object.entries(MODELS)) out[name] = build(m);
  out.wyrm = {};
  for (const [pn, p] of Object.entries(WYRM_PARTS)) {
    const [x, y, z, w, h, d] = p.box;
    out.wyrm[pn] = renderer.createModel(new Float32Array(skinBox(x, y, z, w, h, d, p.uv[0], p.uv[1], SKIN.WYRM, 64, 64, 0, false)));
  }
  // glider wings on a player's back (follow the body)
  out.glider = {
    wingR: renderer.createModel(new Float32Array(skinBox(-10, 8, 2.2, 10, 16, 1, 0, 0, SKIN.GLIDER, 64, 64, 0, false))),
    wingL: renderer.createModel(new Float32Array(skinBox(0, 8, 2.2, 10, 16, 1, 0, 0, SKIN.GLIDER, 64, 64, 0, true))),
  };
  // coats and colours share one model
  for (const [model, vs] of Object.entries(MODEL_VARIANTS)) for (const [v, skin] of Object.entries(vs)) out[`${model}:${v}`] = build(MODELS[model], skin);
  out['steed:white'] = build(MODELS.steed, SKIN.STEED_WHITE);
  out['steed:black'] = build(MODELS.steed, SKIN.STEED_BLACK);
  // settler outfits share one model with different skins
  for (const [prof, skin] of [['farmer', SKIN.FARMER], ['smith', SKIN.SMITH], ['shepherd', SKIN.SHEPHERD], ['scholar', SKIN.SCHOLAR]]) {
    out[`settler:${prof}`] = build(MODELS.settler, skin);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Item meshes: block items are small cubes, everything else is an extruded
// sprite (1 texel thick) built from the texture's alpha.
export function extrudedSprite(texData, layer) {
  const out = [];
  const S = Math.round(Math.sqrt(texData.length / 4));
  const a = (x, y) => (x < 0 || y < 0 || x >= S || y >= S ? 0 : texData[(y * S + x) * 4 + 3]);
  const T = 1 / 32; // half thickness
  const P = (x, y, z, n, u, v) => out.push(x, y, z, n[0], n[1], n[2], u, v, layer);
  // front (+Z) and back (-Z) full quads
  P(-0.5, -0.5, T, [0, 0, 1], 0, 1); P(0.5, -0.5, T, [0, 0, 1], 1, 1); P(0.5, 0.5, T, [0, 0, 1], 1, 0); P(-0.5, 0.5, T, [0, 0, 1], 0, 0);
  P(0.5, -0.5, -T, [0, 0, -1], 1, 1); P(-0.5, -0.5, -T, [0, 0, -1], 0, 1); P(-0.5, 0.5, -T, [0, 0, -1], 0, 0); P(0.5, 0.5, -T, [0, 0, -1], 1, 0);
  // side walls along the silhouette, merged into runs
  const solid = (x, y) => a(x, y) >= 128;
  for (let py = 0; py < S; py++) {
    for (const [dy, ny] of [[-1, [0, 1, 0]], [1, [0, -1, 0]]]) {
      for (let px = 0; px < S;) {
        if (!(solid(px, py) && !solid(px, py + dy))) { px++; continue; }
        let e = px; while (e + 1 < S && solid(e + 1, py) && !solid(e + 1, py + dy)) e++;
        const x0 = px / S - 0.5, x1 = (e + 1) / S - 0.5, yy = dy < 0 ? 0.5 - py / S : 0.5 - (py + 1) / S;
        const u0 = (px + 0.5) / S, u1 = (e + 0.5) / S, v = (py + 0.5) / S;
        if (dy < 0) { P(x0, yy, -T, ny, u0, v); P(x0, yy, T, ny, u0, v); P(x1, yy, T, ny, u1, v); P(x1, yy, -T, ny, u1, v); }
        else { P(x0, yy, -T, ny, u0, v); P(x1, yy, -T, ny, u1, v); P(x1, yy, T, ny, u1, v); P(x0, yy, T, ny, u0, v); }
        px = e + 1;
      }
    }
  }
  for (let px = 0; px < S; px++) {
    for (const [dx, nx] of [[1, [1, 0, 0]], [-1, [-1, 0, 0]]]) {
      for (let py = 0; py < S;) {
        if (!(solid(px, py) && !solid(px + dx, py))) { py++; continue; }
        let e = py; while (e + 1 < S && solid(px, e + 1) && !solid(px + dx, e + 1)) e++;
        const xx = dx > 0 ? (px + 1) / S - 0.5 : px / S - 0.5, y1 = 0.5 - py / S, y0 = 0.5 - (e + 1) / S;
        const u = (px + 0.5) / S, v0 = (py + 0.5) / S, v1 = (e + 0.5) / S;
        if (dx > 0) { P(xx, y0, -T, nx, u, v1); P(xx, y1, -T, nx, u, v0); P(xx, y1, T, nx, u, v0); P(xx, y0, T, nx, u, v1); }
        else { P(xx, y0, T, nx, u, v1); P(xx, y1, T, nx, u, v0); P(xx, y1, -T, nx, u, v0); P(xx, y0, -T, nx, u, v1); }
        py = e + 1;
      }
    }
  }
  return new Float32Array(out);
}

// Item mesh cache keyed by item id. Returns { model, kind: 'block'|'sprite', tex, tint }
export class ItemMeshes {
  constructor(renderer, blockTextures, itemTextures) {
    this.r = renderer; this.bt = blockTextures; this.it = itemTextures;
    this.cache = new Map();
  }
  // New textures: rebuild meshes on demand (sprite silhouettes follow the art).
  setTextures(blockTextures, itemTextures) {
    for (const m of this.cache.values()) if (this.r.deleteModel) this.r.deleteModel(m.model);
    this.bt = blockTextures; this.it = itemTextures;
    this.cache = new Map();
  }
  get(id) {
    let m = this.cache.get(id);
    if (m) return m;
    const def = ITEMS[id];
    if (!def) return null;
    if (def.block !== undefined && def.sprite) {
      m = { model: this.r.createModel(extrudedSprite(this.it[def.tex].data, def.tex)), kind: 'sprite', tex: 'item', tint: [1, 1, 1], blockMode: 0 };
    } else if (def.block !== undefined) {
      const rt = RENDER_TYPE[def.block];
      const tintKind = TINT[def.block];
      const tint = tintKind === 1 ? [0.48, 0.72, 0.32] : tintKind === 2 ? [0.38, 0.65, 0.23] : tintKind === 4 ? [0.5, 0.65, 0.33] : tintKind === 5 ? [0.38, 0.6, 0.38] : [1, 1, 1];
      if (rt === RENDER.CUBE || rt === RENDER.CACTUS || BLOCKS[def.block].icon === 'cube') {
        const bid = def.block;
        const im = BLOCKS[bid].iconMeta || 0;
        const data = cubeMesh(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, (f) => faceTexture(bid, f, im));
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

