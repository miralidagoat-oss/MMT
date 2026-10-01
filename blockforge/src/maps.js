// Maps: a 128x128 picture of the land around where the map was made, filled
// in as the holder explores. Pixels are palette colours shaded by height.
import { B, BLOCKS, isLiquid, TINT } from './blocks.js';

export const MAP_SIZE = 128;

// Base map colour for a top block.
function baseColour(id) {
  if (id === B.water) return [52, 92, 196];
  if (id === B.lava) return [230, 100, 20];
  if (id === B.grass) return [104, 164, 64];
  if (id === B.snowy_grass || id === B.snow_block || id === B.ice) return [236, 240, 248];
  if (id === B.sand || id === B.sandstone) return [222, 210, 150];
  if (id === B.gravel) return [146, 140, 136];
  if (id === B.dirt || id === B.farmland || id === B.dirt_path) return [146, 104, 70];
  if (id === B.clay) return [160, 166, 180];
  const n = BLOCKS[id] ? BLOCKS[id].name : '';
  if (n.endsWith('leaves')) return [52, 120, 40];
  if (n.endsWith('log') || n.endsWith('planks') || n.includes('oak')) return [140, 104, 64];
  if (n.includes('wool')) return [220, 220, 220];
  if (n === 'scorchstone' || n === 'magma_rock' || n === 'ember_bricks') return [120, 40, 34];
  if (n === 'duskstone' || n === 'duskstone_bricks') return [214, 206, 170];
  if (TINT[id] === 1) return [110, 170, 70];
  if (BLOCKS[id] && BLOCKS[id].sound === 'stone') return [124, 124, 124];
  return [150, 140, 120];
}

export class MapData {
  constructor(o) {
    this.id = o.id; this.cx = o.cx; this.cz = o.cz; this.dim = o.dim || 'overworld';
    this.px = new Uint8Array(MAP_SIZE * MAP_SIZE * 3);
    this.known = new Uint8Array(MAP_SIZE * MAP_SIZE);
    if (o.data) {
      const bin = atob(o.data);
      for (let i = 0; i < bin.length && i < this.px.length + this.known.length; i++) {
        if (i < this.px.length) this.px[i] = bin.charCodeAt(i); else this.known[i - this.px.length] = bin.charCodeAt(i);
      }
    }
    this.dirty = true;
    this.cursor = 0;
  }

  toJSON() {
    let s = '';
    const all = new Uint8Array(this.px.length + this.known.length);
    all.set(this.px); all.set(this.known, this.px.length);
    for (let i = 0; i < all.length; i += 8192) s += String.fromCharCode.apply(null, all.subarray(i, i + 8192));
    return { id: this.id, cx: this.cx, cz: this.cz, dim: this.dim, data: btoa(s) };
  }

  // Fill in pixels near (x, z), a few hundred per call.
  explore(world, x, z, budget = 400) {
    const half = MAP_SIZE / 2;
    const r = 40;
    const px0 = Math.floor(x - this.cx + half), pz0 = Math.floor(z - this.cz + half);
    for (let n = 0; n < budget; n++) {
      // sweep a square around the explorer
      const k = this.cursor++ % ((r * 2) * (r * 2));
      const dx = (k % (r * 2)) - r, dz = Math.floor(k / (r * 2)) - r;
      if (dx * dx + dz * dz > r * r) continue;
      const px = px0 + dx, pz = pz0 + dz;
      if (px < 0 || pz < 0 || px >= MAP_SIZE || pz >= MAP_SIZE) continue;
      const wx = this.cx - half + px, wz = this.cz - half + pz;
      const c = world.getChunk(wx >> 4, wz >> 4);
      if (!c || !c.blocks) continue;
      const top = topBlock(world, wx, wz);
      if (!top) continue;
      const north = topBlock(world, wx, wz - 1);
      let col = baseColour(top.id);
      if (top.id === B.water) {
        // deeper water is darker
        let d = 0;
        while (d < 10 && world.getBlock(wx, top.y - d - 1, wz) === B.water) d++;
        const f = 1 - d * 0.05;
        col = [col[0] * f, col[1] * f, col[2] * f];
      } else if (north) {
        const f = top.y > north.y ? 1.1 : top.y < north.y ? 0.82 : 0.95;
        col = [Math.min(255, col[0] * f), Math.min(255, col[1] * f), Math.min(255, col[2] * f)];
      }
      const i = pz * MAP_SIZE + px;
      this.px[i * 3] = col[0]; this.px[i * 3 + 1] = col[1]; this.px[i * 3 + 2] = col[2];
      if (!this.known[i]) this.known[i] = 1;
      this.dirty = true;
    }
  }

  // Draw onto a 2D canvas context of size MAP_SIZE.
  paint(ctx) {
    const img = ctx.createImageData(MAP_SIZE, MAP_SIZE);
    for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
      if (this.known[i]) { img.data[i * 4] = this.px[i * 3]; img.data[i * 4 + 1] = this.px[i * 3 + 1]; img.data[i * 4 + 2] = this.px[i * 3 + 2]; }
      else { img.data[i * 4] = 214; img.data[i * 4 + 1] = 200; img.data[i * 4 + 2] = 160; }
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.dirty = false;
  }
}

function topBlock(world, x, z) {
  const c = world.getChunk(x >> 4, z >> 4);
  if (!c || !c.blocks) return null;
  const lx = x & 15, lz = z & 15;
  for (let y = Math.min(255, c.maxY); y >= 0; y--) {
    const id = c.blocks[(y << 8) | (lz << 4) | lx];
    if (!id) continue;
    const d = BLOCKS[id];
    if (!d || (d.render !== 1 && !isLiquid(id) && !d.name.endsWith('leaves') && d.render !== 7)) continue;
    return { id, y };
  }
  return null;
}
