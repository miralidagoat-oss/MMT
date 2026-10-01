// Inventory icons painted onto 2D canvases: isometric cubes for blocks,
// flat sprites for items, plus the HUD status icons.
import { BLOCKS, RENDER_TYPE, RENDER, TINT, faceTexture } from './blocks.js';
import { ITEMS } from './items.js';

const SIZE = 64;

export class Icons {
  constructor(blockTextures, itemTextures) {
    this.bt = blockTextures; this.it = itemTextures;
    this.cache = new Map();
  }

  get(id) {
    let u = this.cache.get(id);
    if (u) return u;
    const def = ITEMS[id];
    if (!def) return '';
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    if (def.block !== undefined && def.sprite) this.flat(g, this.it[def.tex].data, null, false);
    else if (def.block !== undefined) {
      const rt = RENDER_TYPE[def.block];
      if (rt === RENDER.CUBE || rt === RENDER.CACTUS || BLOCKS[def.block].icon === 'cube') this.cube(g, def.block);
      else this.flat(g, this.bt[faceTexture(def.block, 2, 0)].data, tintOf(def.block), true);
    } else this.flat(g, this.it[def.tex].data, null, false);
    u = c.toDataURL();
    this.cache.set(id, u);
    return u;
  }

  flat(g, data, tint, blockTex) {
    const s = SIZE / 16;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      if (data[i + 3] < (blockTex ? 128 : 20)) continue;
      let r = data[i], gg = data[i + 1], b = data[i + 2];
      if (tint) { r *= tint[0]; gg *= tint[1]; b *= tint[2]; }
      g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
      g.fillRect(x * s, y * s, s, s);
    }
  }

  cube(g, id) {
    const bd = BLOCKS[id];
    const im = bd.iconMeta || 0;
    const cutout = bd.pass === 1;
    const tint = tintOf(id);
    // corners of the isometric cube
    const T = [32, 3], L = [5, 17.5], R = [59, 17.5], C = [32, 32], LB = [5, 47], RB = [59, 47], CB = [32, 61.5];
    const faces = [
      { tex: faceTexture(id, 0, im), o: T, u: [R[0] - T[0], R[1] - T[1]], v: [L[0] - T[0], L[1] - T[1]], shade: 1, top: true },
      { tex: faceTexture(id, 4, im), o: L, u: [C[0] - L[0], C[1] - L[1]], v: [LB[0] - L[0], LB[1] - L[1]], shade: 0.78 },
      { tex: faceTexture(id, 2, im), o: C, u: [R[0] - C[0], R[1] - C[1]], v: [CB[0] - C[0], CB[1] - C[1]], shade: 0.6 },
    ];
    void RB;
    for (const f of faces) {
      const data = this.bt[f.tex].data;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        const a = data[i + 3];
        let r = data[i], gg = data[i + 1], b = data[i + 2];
        if (cutout) { if (a < 128) continue; if (tint) { r *= tint[0]; gg *= tint[1]; b *= tint[2]; } }
        else if (tint && a < 255) { const m = 1 - a / 255; r *= 1 - m + m * tint[0]; gg *= 1 - m + m * tint[1]; b *= 1 - m + m * tint[2]; }
        r *= f.shade; gg *= f.shade; b *= f.shade;
        const p = (uu, vv) => [f.o[0] + f.u[0] * uu / 16 + f.v[0] * vv / 16, f.o[1] + f.u[1] * uu / 16 + f.v[1] * vv / 16];
        const p0 = p(x, y), p1 = p(x + 1, y), p2 = p(x + 1, y + 1), p3 = p(x, y + 1);
        g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
        g.beginPath();
        g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.lineTo(p3[0], p3[1]);
        g.closePath();
        g.fill();
        // cover hairline seams between texels
        g.strokeStyle = g.fillStyle; g.lineWidth = 0.6; g.stroke();
      }
    }
  }
}

// Front view of the player figure, cut from its box-unwrapped skin.
export function playerPortrait(skin) {
  const c = document.createElement('canvas');
  const S = 8;
  c.width = 16 * S; c.height = 32 * S;
  const g = c.getContext('2d');
  const blit = (u, v, w, h, dx, dy, mirror = false) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = mirror ? u + w - 1 - x : u + x;
      const i = ((v + y) * 64 + sx) * 4;
      if (skin[i + 3] < 10) continue;
      g.fillStyle = `rgb(${skin[i]},${skin[i + 1]},${skin[i + 2]})`;
      g.fillRect((dx + x) * S, (dy + y) * S, S, S);
    }
  };
  blit(8, 8, 8, 8, 4, 0);        // head
  blit(20, 20, 8, 12, 4, 8);     // body
  blit(44, 20, 4, 12, 0, 8);     // right arm
  blit(44, 20, 4, 12, 12, 8, true);
  blit(4, 20, 4, 12, 4, 20);     // legs
  blit(4, 20, 4, 12, 8, 20, true);
  return c.toDataURL();
}

function tintOf(id) {
  const t = TINT[id];
  if (t === 1) return [0.48, 0.72, 0.32];
  if (t === 2) return [0.38, 0.65, 0.23];
  if (t === 4) return [0.5, 0.65, 0.33];
  if (t === 5) return [0.38, 0.6, 0.38];
  return null;
}

// Small pixel icons for the HUD, drawn from character maps.
function pixelIcon(rows, palette, scale = 4) {
  const c = document.createElement('canvas');
  const w = rows[0].length, h = rows.length;
  c.width = w * scale; c.height = h * scale;
  const g = c.getContext('2d');
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const col = palette[rows[y][x]];
    if (!col) continue;
    g.fillStyle = col;
    g.fillRect(x * scale, y * scale, scale, scale);
  }
  return c.toDataURL();
}

const HEART = [
  '.XX...XX.',
  'XRRX.XRRX',
  'XRWRXRRRX',
  'XRRRRRRRX',
  'XRRRRRRRX',
  '.XRRRRRX.',
  '..XRRRX..',
  '...XRX...',
  '....X....',
];
const FOOD = [
  '.........',
  '..XXXXX..',
  '.XWbbbbX.',
  'XbBbBbBbX',
  'XbbbbbbbX',
  'XdddddddX',
  '.XXXXXXX.',
  '.........',
  '.........',
];
const BUBBLE = [
  '..XXXXX..',
  '.XWWBBBX.',
  'XWBBBBBBX',
  'XWBBBBBBX',
  'XBBBBBBBX',
  'XBBBBBBBX',
  'XBBBBBBBX',
  '.XBBBBBX.',
  '..XXXXX..',
];

const VEST = [
  '.XXX.XXX.',
  'XAAAXAAAX',
  'XAWAAAAAX',
  'XAAAAAAAX',
  '.XAAAAAX.',
  '.XAAAAAX.',
  '.XAAAAAX.',
  '.XADDDAX.',
  '..XXXXX..',
];

function halfOf(rows, fullKeys, emptyKey) {
  return rows.map((r) => r.split('').map((ch, x) => (x >= Math.floor(r.length / 2) && fullKeys.includes(ch) ? emptyKey : ch)).join(''));
}

export function statusIcons() {
  const emptyHeart = HEART.map((r) => r.replace(/[RW]/g, 'e'));
  const heartPal = { X: '#1a0608', R: '#e23a3a', W: '#ffb4b4', e: '#3a1a1c' };
  const emptyFood = FOOD.map((r) => r.replace(/[bBWd]/g, 'e'));
  const foodPal = { X: '#2a1606', b: '#d8984a', B: '#f2c27a', W: '#ffe2b0', d: '#9a5e24', e: '#3a2616' };
  const armorPal = { X: '#0e1116', A: '#c9d2dc', W: '#ffffff', D: '#8a96a4', e: '#262c34' };
  return {
    heart: pixelIcon(HEART, heartPal),
    heartHalf: pixelIcon(halfOf(HEART, 'RW', 'e'), heartPal),
    heartEmpty: pixelIcon(emptyHeart, heartPal),
    heartFlash: pixelIcon(HEART, { X: '#ffffff', R: '#ff8080', W: '#ffffff' }),
    heartPoison: pixelIcon(HEART, { X: '#0c1a06', R: '#6a9a2a', W: '#c8f090' }),
    heartPoisonHalf: pixelIcon(halfOf(HEART, 'RW', 'e'), { X: '#0c1a06', R: '#6a9a2a', W: '#c8f090', e: '#3a1a1c' }),
    heartGold: pixelIcon(HEART, { X: '#2a1a02', R: '#e8b830', W: '#fff0a0' }),
    heartGoldHalf: pixelIcon(halfOf(HEART, 'RW', '.'), { X: '#2a1a02', R: '#e8b830', W: '#fff0a0' }),
    food: pixelIcon(FOOD, foodPal),
    foodHalf: pixelIcon(halfOf(FOOD, 'bBWd', 'e'), foodPal),
    foodEmpty: pixelIcon(emptyFood, foodPal),
    bubble: pixelIcon(BUBBLE, { X: '#0c2a5a', W: '#ffffff', B: '#62a6ff' }),
    bubblePop: pixelIcon(BUBBLE.map((r) => r.replace(/[WB]/g, '.')), { X: '#62a6ff' }),
    armor: pixelIcon(VEST, armorPal),
    armorHalf: pixelIcon(halfOf(VEST, 'AWD', 'e'), armorPal),
    armorEmpty: pixelIcon(VEST.map((r) => r.replace(/[AWD]/g, 'e')), armorPal),
  };
}
