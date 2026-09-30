// Renders every procedural texture into a PNG contact sheet for review.
// Usage: node tools/texture-sheet.mjs out.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateBlockTextures, generateItemTextures } from '../src/textures.js';

const SCALE = 4, TS = 16, COLS = 16;
const tiles = [...generateBlockTextures().filter((t) => t.frame === 0 || t.frame === 8), ...generateItemTextures()];
const rows = Math.ceil(tiles.length / COLS);
const W = COLS * (TS * SCALE + 4), H = rows * (TS * SCALE + 4);
const img = new Uint8Array(W * H * 4);
tiles.forEach((t, i) => {
  const ox = (i % COLS) * (TS * SCALE + 4) + 2, oy = Math.floor(i / COLS) * (TS * SCALE + 4) + 2;
  for (let y = 0; y < TS * SCALE; y++) for (let x = 0; x < TS * SCALE; x++) {
    const s = ((y / SCALE | 0) * TS + (x / SCALE | 0)) * 4;
    const d = ((oy + y) * W + ox + x) * 4;
    const checker = ((x >> 3) + (y >> 3)) % 2 ? 60 : 90;
    const a = t.transparent || t.data[s + 3] === 0 && !t.name.startsWith('grass') ? t.data[s + 3] / 255 : 1;
    for (let c = 0; c < 3; c++) img[d + c] = t.data[s + c] * a + checker * (1 - a);
    img[d + 3] = 255;
  }
});
const crc = (buf) => { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; Buffer.from(img.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(process.argv[2] || 'sheet.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('tiles', tiles.length, W, H);
