// Banners, item frames and paintings. Banner cloth and the paintings are
// painted onto canvases at run time; every painting is an original scene.
import { Entity } from './entities.js';
import { B, SOLID } from './blocks.js';
import { I } from './items.js';
import { FACE_DIR } from './shapes.js';

export const BANNER_PATTERNS = ['stripe_top', 'stripe_bottom', 'stripe_center', 'stripe_left', 'cross', 'border', 'chevron', 'half_top', 'circle', 'diagonal', 'checks', 'star'];
export const BANNER_PATTERN_NAMES = {
  stripe_top: 'Chief', stripe_bottom: 'Base', stripe_center: 'Pale', stripe_left: 'Flank', cross: 'Saltire', border: 'Border',
  chevron: 'Chevron', half_top: 'Per Fess', circle: 'Roundel', diagonal: 'Per Bend', checks: 'Chequy', star: 'Star',
};
// Cloth colours in the order of BANNER_COLORS (items.js).
export const BANNER_RGB = [[236, 236, 230], [170, 44, 38], [226, 118, 34], [240, 200, 58], [92, 128, 32], [52, 72, 166], [120, 52, 168], [32, 32, 38]];

const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

// Paint banner cloth (base colour index, [[pattern, colour index]...]) onto
// a canvas twice as tall as it is wide.
export function paintBanner(canvas, base, patterns = []) {
  const W = canvas.width, H = canvas.height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = css(BANNER_RGB[base] || BANNER_RGB[0]);
  g.fillRect(0, 0, W, H);
  for (const [pat, ci] of patterns) {
    g.fillStyle = css(BANNER_RGB[ci] || BANNER_RGB[0]);
    g.strokeStyle = g.fillStyle;
    g.beginPath();
    switch (pat) {
      case 'stripe_top': g.rect(0, 0, W, H * 0.24); break;
      case 'stripe_bottom': g.rect(0, H * 0.76, W, H * 0.24); break;
      case 'stripe_center': g.rect(W * 0.36, 0, W * 0.28, H); break;
      case 'stripe_left': g.rect(0, 0, W * 0.27, H); break;
      case 'cross':
        g.lineWidth = W * 0.2; g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke(); continue;
      case 'border': g.lineWidth = W * 0.14; g.strokeRect(W * 0.07, W * 0.07, W * 0.86, H - W * 0.14); continue;
      case 'chevron': g.moveTo(0, H); g.lineTo(W / 2, H * 0.52); g.lineTo(W, H); break;
      case 'half_top': g.rect(0, 0, W, H / 2); break;
      case 'circle': g.arc(W / 2, H * 0.44, W * 0.27, 0, Math.PI * 2); break;
      case 'diagonal': g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, H); break;
      case 'checks':
        for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2) g.rect((x * W) / 4, (y * H) / 8, W / 4, H / 8);
        break;
      case 'star': {
        const cx = W / 2, cy = H * 0.44, R = W * 0.38, r = R * 0.42;
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R; g[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
        break;
      }
      default: break;
    }
    g.closePath();
    g.fill();
  }
  // cloth: a soft weave, a fold of shade, a stitched hem
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const weave = ((x + y) % 2 ? 0.97 : 1.02) * (1 - 0.07 * Math.sin((x / W) * Math.PI * 3) ** 2) * (y > H - W * 0.06 ? 0.8 : 1);
    d[i] *= weave; d[i + 1] *= weave; d[i + 2] *= weave;
  }
  g.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// Paintings: [key, title, width, height in blocks, painter(g, W, H, rnd)]
const sky = (g, W, H, top, bottom, to = 1) => { const gr = g.createLinearGradient(0, 0, 0, H * to); gr.addColorStop(0, top); gr.addColorStop(1, bottom); g.fillStyle = gr; g.fillRect(0, 0, W, H); };
const hills = (g, W, H, base, amp, color, seed, freq = 3) => {
  g.fillStyle = color; g.beginPath(); g.moveTo(0, H);
  for (let x = 0; x <= W; x += 2) g.lineTo(x, base + Math.sin(x / W * Math.PI * freq + seed) * amp + Math.sin(x / W * Math.PI * freq * 2.7 + seed * 3) * amp * 0.35);
  g.lineTo(W, H); g.closePath(); g.fill();
};
const disc = (g, x, y, r, c) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
const poly = (g, pts, c) => { g.fillStyle = c; g.beginPath(); pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](x, y)); g.closePath(); g.fill(); };
const glow = (g, x, y, r, c) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); };
const pine = (g, x, y, h, c) => poly(g, [[x, y - h], [x + h * 0.28, y], [x - h * 0.28, y]], c);

export const PAINTINGS = [
  ['meadow', 'Meadow at Dawn', 2, 1, (g, W, H, r) => {
    sky(g, W, H, '#8fc3ea', '#f6e3b0', 0.7);
    glow(g, W * 0.72, H * 0.42, H * 0.6, 'rgba(255,236,170,0.9)'); disc(g, W * 0.72, H * 0.42, H * 0.1, '#fff4c8');
    hills(g, W, H, H * 0.55, H * 0.06, '#7fa0a8', 1.2, 2);
    hills(g, W, H, H * 0.66, H * 0.07, '#6f9a4e', 2.5, 3);
    hills(g, W, H, H * 0.8, H * 0.05, '#4f7d33', 0.4, 4);
    for (let i = 0; i < 90; i++) disc(g, r() * W, H * 0.82 + r() * H * 0.18, 1 + r() * 1.6, ['#f2e86d', '#f4a0b8', '#ffffff', '#c98be8'][i % 4]);
  }],
  ['lighthouse', 'The Keeper\'s Light', 1, 2, (g, W, H, r) => {
    sky(g, W, H, '#2c2a5e', '#f08a5d', 0.62);
    g.fillStyle = 'rgba(255,240,180,0.25)'; g.beginPath(); g.moveTo(W * 0.52, H * 0.3); g.lineTo(-W * 0.2, H * 0.12); g.lineTo(-W * 0.2, H * 0.32); g.closePath(); g.fill();
    g.fillStyle = '#1d3557'; g.fillRect(0, H * 0.62, W, H * 0.38);
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(255,190,140,${0.15 + r() * 0.3})`; g.fillRect(r() * W, H * 0.63 + r() * H * 0.36, 3 + r() * 8, 1); }
    poly(g, [[W * 0.2, H * 0.66], [W * 0.38, H * 0.56], [W * 0.75, H * 0.57], [W * 0.95, H * 0.68]], '#3b3a3f');
    poly(g, [[W * 0.44, H * 0.58], [W * 0.48, H * 0.3], [W * 0.58, H * 0.3], [W * 0.62, H * 0.58]], '#f3efe6');
    for (let k = 0; k < 3; k++) { g.fillStyle = '#c0392b'; g.fillRect(W * (0.445 + k * 0.006), H * (0.36 + k * 0.08), W * (0.17 - k * 0.012), H * 0.035); }
    g.fillStyle = '#2b2b2b'; g.fillRect(W * 0.46, H * 0.27, W * 0.14, H * 0.04);
    glow(g, W * 0.53, H * 0.29, W * 0.25, 'rgba(255,240,170,1)');
  }],
  ['still_life', 'Still Life with Poppies', 1, 1, (g, W, H, r) => {
    sky(g, W, H, '#3a2f28', '#5b4636');
    g.fillStyle = '#7a5232'; g.fillRect(0, H * 0.72, W, H * 0.28);
    poly(g, [[W * 0.38, H * 0.74], [W * 0.33, H * 0.55], [W * 0.42, H * 0.45], [W * 0.58, H * 0.45], [W * 0.67, H * 0.55], [W * 0.62, H * 0.74]], '#6d8fb0');
    g.strokeStyle = '#3e6b2e'; g.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) { const a = -1.2 + i * 0.45; g.beginPath(); g.moveTo(W * 0.5, H * 0.47); g.lineTo(W * 0.5 + Math.sin(a) * W * 0.3, H * 0.47 - Math.cos(a) * H * 0.3); g.stroke(); disc(g, W * 0.5 + Math.sin(a) * W * 0.3, H * 0.47 - Math.cos(a) * H * 0.3, W * 0.07, i % 3 ? '#d93a2b' : '#f0c040'); }
    disc(g, W * 0.82, H * 0.76, W * 0.07, '#c7a23a');
  }],
  ['starry', 'Night over the Hills', 2, 2, (g, W, H, r) => {
    sky(g, W, H, '#0d1b4a', '#2f4c8f');
    g.lineWidth = 3;
    for (let i = 0; i < 14; i++) { g.strokeStyle = `rgba(${150 + r() * 80},${180 + r() * 60},255,0.35)`; g.beginPath(); g.arc(r() * W, r() * H * 0.6, 10 + r() * 30, r() * 6, r() * 6 + 2.5); g.stroke(); }
    for (let i = 0; i < 16; i++) { const x = r() * W, y = r() * H * 0.55; glow(g, x, y, 9 + r() * 8, 'rgba(255,240,170,0.8)'); disc(g, x, y, 1.6, '#fff8d8'); }
    disc(g, W * 0.82, H * 0.18, H * 0.07, '#f7e9a0'); disc(g, W * 0.85, H * 0.16, H * 0.06, '#0f1f52');
    hills(g, W, H, H * 0.72, H * 0.05, '#1a2c4f', 0.6, 2);
    hills(g, W, H, H * 0.84, H * 0.04, '#0e1a2e', 2.2, 3);
    g.fillStyle = '#081018'; g.beginPath(); g.moveTo(W * 0.15, H); g.quadraticCurveTo(W * 0.1, H * 0.5, W * 0.2, H * 0.25); g.quadraticCurveTo(W * 0.24, H * 0.55, W * 0.24, H); g.fill();
    for (let i = 0; i < 6; i++) disc(g, W * (0.4 + r() * 0.4), H * (0.84 + r() * 0.05), 2, '#ffd56b');
  }],
  ['mountain_lake', 'Still Water', 4, 2, (g, W, H, r) => {
    sky(g, W, H, '#6ea7d8', '#dfeef6', 0.55);
    const peaks = [[0, 0.55], [0.12, 0.3], [0.22, 0.42], [0.36, 0.18], [0.5, 0.4], [0.63, 0.24], [0.78, 0.45], [0.9, 0.3], [1, 0.5]];
    const ridge = (flip) => { g.beginPath(); g.moveTo(0, H * 0.55); for (const [x, y] of peaks) g.lineTo(x * W, flip ? H * (1.1 - y) : y * H); g.lineTo(W, H * 0.55); g.closePath(); };
    g.fillStyle = '#7f8ea3'; ridge(false); g.fill();
    for (const [x, y] of peaks.slice(1, -1)) poly(g, [[x * W, y * H], [x * W + W * 0.03, y * H + H * 0.07], [x * W - W * 0.03, y * H + H * 0.07]], '#f4f7fb');
    g.fillStyle = '#4a7aa0'; g.fillRect(0, H * 0.55, W, H * 0.45);
    g.globalAlpha = 0.45; g.fillStyle = '#7f8ea3'; ridge(true); g.fill(); g.globalAlpha = 1;
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(255,255,255,${0.1 + r() * 0.2})`; g.fillRect(r() * W, H * 0.56 + r() * H * 0.44, 6 + r() * 14, 1); }
    for (let i = 0; i < 18; i++) pine(g, (i / 18) * W + r() * 8, H * 0.58, H * (0.08 + r() * 0.06), '#24452f');
  }],
  ['sailboat', 'Fair Wind', 2, 1, (g, W, H, r) => {
    sky(g, W, H, '#9fd3f0', '#e9f6fb', 0.6);
    disc(g, W * 0.15, H * 0.25, H * 0.09, '#fff7d6');
    g.fillStyle = '#2f6fa3'; g.fillRect(0, H * 0.62, W, H * 0.38);
    for (let i = 0; i < 50; i++) { g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(r() * W, H * 0.64 + r() * H * 0.34, 4 + r() * 10, 1); }
    poly(g, [[W * 0.5, H * 0.18], [W * 0.5, H * 0.58], [W * 0.68, H * 0.58]], '#fbfaf4');
    poly(g, [[W * 0.48, H * 0.24], [W * 0.48, H * 0.58], [W * 0.38, H * 0.58]], '#f2d7a4');
    poly(g, [[W * 0.36, H * 0.6], [W * 0.72, H * 0.6], [W * 0.66, H * 0.68], [W * 0.41, H * 0.68]], '#8a4b2a');
    for (let i = 0; i < 3; i++) { const x = W * (0.75 + i * 0.06), y = H * (0.2 + i * 0.05); g.strokeStyle = '#4a4a4a'; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 4, y); g.quadraticCurveTo(x, y - 3, x + 4, y); g.stroke(); }
  }],
  ['forest_path', 'Under the Canopy', 2, 2, (g, W, H, r) => {
    sky(g, W, H, '#cfe6b8', '#5a8a3c');
    for (let i = 0; i < 50; i++) disc(g, r() * W, r() * H * 0.55, 10 + r() * 22, `rgba(${40 + r() * 40},${90 + r() * 60},${30 + r() * 30},0.85)`);
    g.fillStyle = 'rgba(255,250,200,0.18)';
    for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(W * (0.3 + i * 0.1), 0); g.lineTo(W * (0.38 + i * 0.1), 0); g.lineTo(W * (0.5 + i * 0.05), H); g.lineTo(W * (0.42 + i * 0.05), H); g.fill(); }
    for (const x of [0.12, 0.28, 0.72, 0.88]) { g.fillStyle = '#4b3221'; g.fillRect(W * x, H * 0.3, W * 0.05, H * 0.7); }
    poly(g, [[W * 0.45, H * 0.55], [W * 0.55, H * 0.55], [W * 0.8, H], [W * 0.2, H]], '#b99a62');
    for (let i = 0; i < 40; i++) disc(g, r() * W, H * 0.7 + r() * H * 0.3, 2, ['#6aa84f', '#8fce68', '#f4e06d'][i % 3]);
  }],
  ['wanderer', 'Above the Clouds', 1, 2, (g, W, H, r) => {
    sky(g, W, H, '#7b9cc4', '#e8eef3', 0.6);
    for (let i = 0; i < 30; i++) disc(g, r() * W, H * 0.55 + r() * H * 0.2, 8 + r() * 14, `rgba(255,255,255,${0.5 + r() * 0.4})`);
    poly(g, [[0, H * 0.72], [W * 0.55, H * 0.66], [W * 0.75, H * 0.75], [W, H * 0.85], [W, H], [0, H]], '#3d3b3a');
    g.fillStyle = '#1b1b1f'; g.fillRect(W * 0.47, H * 0.56, W * 0.08, H * 0.1); disc(g, W * 0.51, H * 0.545, W * 0.045, '#1b1b1f');
    poly(g, [[W * 0.47, H * 0.58], [W * 0.38, H * 0.66], [W * 0.47, H * 0.64]], '#1b1b1f');
  }],
  ['sunflowers', 'Field of Suns', 1, 1, (g, W, H, r) => {
    sky(g, W, H, '#3f6fb5', '#8fb6e0');
    for (let i = 0; i < 7; i++) {
      const x = W * (0.12 + r() * 0.76), y = H * (0.3 + r() * 0.5), s = W * (0.08 + r() * 0.05);
      g.fillStyle = '#3f7d2b'; g.fillRect(x - 1, y, 2, H - y);
      for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; disc(g, x + Math.cos(a) * s, y + Math.sin(a) * s, s * 0.5, '#f6c431'); }
      disc(g, x, y, s * 0.7, '#6b3e1e');
    }
  }],
  ['blocks', 'Composition in Earth', 2, 2, (g, W, H, r) => {
    g.fillStyle = '#efe6d2'; g.fillRect(0, 0, W, H);
    const cols = ['#b5452f', '#2f5d8a', '#e3b23c', '#3e7a4a', '#2b2b2b'];
    for (let i = 0; i < 9; i++) { g.fillStyle = cols[i % cols.length]; const x = Math.floor(r() * 4) * W / 4, y = Math.floor(r() * 4) * H / 4; g.fillRect(x, y, W / 4 * (1 + Math.floor(r() * 2)), H / 4); }
    g.fillStyle = '#1b1b1b';
    for (let i = 1; i < 4; i++) { g.fillRect((i * W) / 4 - 2, 0, 4, H); g.fillRect(0, (i * H) / 4 - 2, W, 4); }
  }],
  ['desert_arch', 'The Red Arch', 4, 3, (g, W, H, r) => {
    sky(g, W, H, '#f2a65a', '#f9e3b4', 0.6);
    disc(g, W * 0.3, H * 0.32, H * 0.08, '#fff1c4');
    hills(g, W, H, H * 0.62, H * 0.04, '#e0a060', 0.3, 2);
    g.fillStyle = '#b04a2c'; g.beginPath(); g.moveTo(W * 0.45, H * 0.85); g.lineTo(W * 0.5, H * 0.35); g.quadraticCurveTo(W * 0.66, H * 0.22, W * 0.8, H * 0.38); g.lineTo(W * 0.85, H * 0.85); g.lineTo(W * 0.77, H * 0.85); g.lineTo(W * 0.75, H * 0.5); g.quadraticCurveTo(W * 0.66, H * 0.38, W * 0.57, H * 0.52); g.lineTo(W * 0.54, H * 0.85); g.closePath(); g.fill();
    hills(g, W, H, H * 0.82, H * 0.05, '#d98b4f', 1.9, 3);
    for (let i = 0; i < 6; i++) { const x = r() * W; g.fillStyle = '#4f7a3a'; g.fillRect(x, H * 0.84, 3, -H * 0.06); g.fillRect(x - 4, H * 0.81, 3, -H * 0.03); g.fillRect(x + 4, H * 0.8, 3, -H * 0.03); }
  }],
  ['aurora', 'Northern Lights', 4, 2, (g, W, H, r) => {
    sky(g, W, H, '#050b1e', '#18324d');
    for (let i = 0; i < 120; i++) disc(g, r() * W, r() * H * 0.6, 0.8 + r(), '#ffffff');
    for (let b = 0; b < 3; b++) {
      const col = ['rgba(90,255,170,', 'rgba(140,120,255,', 'rgba(80,220,255,'][b];
      for (let x = 0; x < W; x += 2) {
        const y = H * (0.2 + b * 0.1) + Math.sin(x / W * 7 + b * 2) * H * 0.07;
        const gr = g.createLinearGradient(0, y, 0, y + H * 0.25);
        gr.addColorStop(0, col + '0.0)'); gr.addColorStop(0.2, col + '0.35)'); gr.addColorStop(1, col + '0.0)');
        g.fillStyle = gr; g.fillRect(x, y, 2, H * 0.25);
      }
    }
    hills(g, W, H, H * 0.78, H * 0.03, '#dfe8f2', 0.8, 2);
    poly(g, [[W * 0.66, H * 0.78], [W * 0.66, H * 0.7], [W * 0.7, H * 0.65], [W * 0.74, H * 0.7], [W * 0.74, H * 0.78]], '#3a2a20');
    glow(g, W * 0.7, H * 0.73, H * 0.06, 'rgba(255,200,90,0.9)');
    g.fillStyle = '#ffd27a'; g.fillRect(W * 0.69, H * 0.72, W * 0.01, H * 0.02);
    for (let i = 0; i < 12; i++) pine(g, W * (0.05 + i * 0.075) + r() * 6, H * 0.8 + r() * 4, H * (0.08 + r() * 0.05), '#0f2018');
  }],
];
export const PAINTING_BY_KEY = Object.fromEntries(PAINTINGS.map((p) => [p[0], p]));
const PX = 64; // canvas pixels per block

// Paint one painting with its wooden frame.
export function paintPainting(canvas, key) {
  const p = PAINTING_BY_KEY[key] || PAINTINGS[0];
  const W = p[2] * PX, H = p[3] * PX;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  let s = 0;
  for (const ch of key) s = (s * 31 + ch.charCodeAt(0)) | 0;
  const r = () => { s = (Math.imul(s, 1103515245) + 12345) | 0; return ((s >>> 8) & 0xffff) / 65536; };
  p[4](g, W, H, r);
  // brush texture over everything, then the frame
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < W * H; i++) { const f = 0.94 + r() * 0.1; d[i * 4] *= f; d[i * 4 + 1] *= f; d[i * 4 + 2] *= f; }
  g.putImageData(img, 0, 0);
  const fw = 4;
  g.fillStyle = '#5a3a1e'; g.fillRect(0, 0, W, fw); g.fillRect(0, H - fw, W, fw); g.fillRect(0, 0, fw, H); g.fillRect(W - fw, 0, fw, H);
  g.fillStyle = '#8a5e33'; g.fillRect(0, 0, W, 1.5); g.fillRect(0, 0, 1.5, H);
  g.fillStyle = '#3a2410'; g.fillRect(fw - 1, fw - 1, W - fw * 2 + 2, 1); g.fillRect(fw - 1, fw - 1, 1, H - fw * 2 + 2);
}

// ---------------------------------------------------------------------------
// Things hung on a wall: they sit on face `face` of block (bx, by, bz).
const RIGHT = { 2: [0, 0, -1], 3: [0, 0, 1], 4: [1, 0, 0], 5: [-1, 0, 0] }; // viewer's right for each wall face
export const wallRight = (face) => RIGHT[face] || [1, 0, 0];

class WallThing extends Entity {
  constructor(bx, by, bz, face, w, h) {
    super(0, 0, 0, 0.3, 0.3);
    this.isDecor = true; this.targetable = true;
    this.bx = bx; this.by = by; this.bz = bz; this.face = face;
    this.sw = w; this.sh = h; // size along the wall (blocks)
    this.place();
  }
  // centre of the face the thing covers
  place() {
    const [nx, ny, nz] = FACE_DIR[this.face];
    const [rx, , rz] = wallRight(this.face);
    const ox = (this.sw - 1) / 2, oy = (this.sh - 1) / 2;
    this.cx = this.bx + 0.5 + nx * 0.5 + rx * ox; this.cy = this.by + 0.5 + ny * 0.5 + oy; this.cz = this.bz + 0.5 + nz * 0.5 + rz * ox;
    this.x = this.px = this.cx; this.z = this.pz = this.cz; this.y = this.py = this.cy - 0.3;
  }
  // the wall blocks behind, and the spaces in front
  cells() {
    const [rx, , rz] = wallRight(this.face);
    const out = [];
    for (let j = 0; j < this.sh; j++) for (let i = 0; i < this.sw; i++) out.push([this.bx + rx * i, this.by + j, this.bz + rz * i]);
    return out;
  }
  hitBoxes() {
    const [nx, ny, nz] = FACE_DIR[this.face];
    const [rx, , rz] = wallRight(this.face);
    const hw = this.sw * this.inset / 2, hh = this.sh * this.inset / 2, t = 0.07;
    const flat = this.face < 2; // on a floor or ceiling
    const ax = flat ? hw : Math.abs(rx) * hw + Math.abs(nx) * t, ay = flat ? t : hh, az = flat ? hh : Math.abs(rz) * hw + Math.abs(nz) * t;
    const cx = this.cx + nx * t, cy = this.cy + ny * t, cz = this.cz + nz * t;
    return [[cx - ax, cy - ay, cz - az, cx + ax, cy + ay, cz + az]];
  }
  tick(game) {
    this.age++;
    if (this.age % 20 === 0 && !(game.net && game.net.isGuest)) {
      if (this.cells().some(([x, y, z]) => !SOLID[game.world.getBlock(x, y, z)])) this.breakOff(game, true);
    }
  }
  breakOff(game, drop) {
    if (this.removed) return;
    this.removed = true;
    const [nx, , nz] = FACE_DIR[this.face];
    if (drop && !game.player.creative) game.dropItem(this.cx + nx * 0.2, this.cy, this.cz + nz * 0.2, { id: this.itemId, count: 1 });
    game.audio.blockSound(B.oak_planks, 'break', this.cx, this.cy, this.cz);
  }
}

export class ItemFrame extends WallThing {
  constructor(bx, by, bz, face, stack = null, rot = 0) {
    super(bx, by, bz, face, 1, 1);
    this.isFrame = true; this.inset = 0.75; this.itemId = I.item_frame;
    this.stack = stack; this.rot = rot;
  }
  interact(game, held) {
    if (!this.stack) {
      if (!held) return undefined;
      this.stack = { ...held, count: 1 };
      game.audio.play('pop', this.cx, this.cy, this.cz, 0.5);
      return 'consume';
    }
    this.rot = (this.rot + 1) % 8;
    game.audio.play('click', this.cx, this.cy, this.cz, 0.4);
    return 'rotate';
  }
  hit(game) {
    if (this.stack) {
      const [nx, , nz] = FACE_DIR[this.face];
      if (!game.player.creative) game.dropItem(this.cx + nx * 0.2, this.cy, this.cz + nz * 0.2, this.stack);
      this.stack = null;
      game.audio.play('pop', this.cx, this.cy, this.cz, 0.5);
      return;
    }
    this.breakOff(game, true);
  }
  breakOff(game, drop) {
    if (this.stack && drop && !game.player.creative) game.dropItem(this.cx, this.cy, this.cz, this.stack);
    super.breakOff(game, drop);
  }
  serialize() { return { kind: 'item_frame', bx: this.bx, by: this.by, bz: this.bz, face: this.face, stack: this.stack, rot: this.rot }; }
}

export class Painting extends WallThing {
  constructor(bx, by, bz, face, key) {
    const p = PAINTING_BY_KEY[key] || PAINTINGS[0];
    super(bx, by, bz, face, p[2], p[3]);
    this.isPainting = true; this.inset = 1; this.itemId = I.painting; this.motif = p[0];
  }
  hit(game) { this.breakOff(game, true); }
  serialize() { return { kind: 'painting', bx: this.bx, by: this.by, bz: this.bz, face: this.face, motif: this.motif }; }
}

export function loadDecor(o) {
  if (o.kind === 'item_frame') return new ItemFrame(o.bx, o.by, o.bz, o.face, o.stack || null, o.rot || 0);
  if (o.kind === 'painting') return new Painting(o.bx, o.by, o.bz, o.face, o.motif);
  return null;
}

// Hang a painting on face `face` of block (x, y, z): the largest pieces
// that fit are tried first (a random one among equals). Returns it or null.
export function fitPainting(world, entities, x, y, z, face, r = Math.random) {
  if (face < 2) return null;
  const [nx, , nz] = FACE_DIR[face];
  const [rx, , rz] = wallRight(face);
  const taken = (cx, cy, cz) => entities.some((e) => e.isDecor && !e.removed && e.face === face && e.cells().some(([a, b, c]) => a === cx && b === cy && c === cz));
  const fits = (w, h) => {
    const bx = x - rx * Math.floor((w - 1) / 2), bz = z - rz * Math.floor((w - 1) / 2), by = y - Math.floor((h - 1) / 2);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const cx = bx + rx * i, cy = by + j, cz = bz + rz * i;
      if (!SOLID[world.getBlock(cx, cy, cz)] || SOLID[world.getBlock(cx + nx, cy, cz + nz)] || taken(cx, cy, cz)) return null;
    }
    return [bx, by, bz];
  };
  const options = PAINTINGS.map((p) => ({ p, at: fits(p[2], p[3]) })).filter((o) => o.at);
  if (!options.length) return null;
  const big = Math.max(...options.map((o) => o.p[2] * o.p[3]));
  const best = options.filter((o) => o.p[2] * o.p[3] === big);
  const o = best[Math.floor(r() * best.length)];
  return new Painting(o.at[0], o.at[1], o.at[2], face, o.p[0]);
}
