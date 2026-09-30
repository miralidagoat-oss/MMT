// The underworld: a closed cavern dimension 128 blocks tall with a lava sea,
// ash flats, glowing groves and hanging ember crystals.
import { Simplex, rng, hash2, rand3 } from './noise.js';
import { B } from './blocks.js';
import { CHUNK, CHUNK_VOLUME } from './constants.js';

export const UNDER_TOP = 127;
export const LAVA_SEA = 31;
const GY = 33; // grid points in y (4-block steps up to 128)

export class UnderworldGen {
  constructor(seed) {
    this.seed = (seed ^ 0x5eed7) | 0;
    this.nA = new Simplex(this.seed ^ 0x11);
    this.nB = new Simplex(this.seed ^ 0x22);
    this.nBiome = new Simplex(this.seed ^ 0x33);
    this.nPatch = new Simplex(this.seed ^ 0x44);
    this.grid = new Float32Array(5 * 5 * GY);
  }

  density(x, y, z) {
    let v = this.nA.fbm3(x / 96, y / 52, z / 96, 3) * 1.1 + this.nB.noise3(x / 28, y / 22, z / 28) * 0.28;
    if (y < 16) v += ((16 - y) / 16) * 1.4;
    if (y > 100) v += ((y - 100) / 27) * 1.6;
    return v - 0.3;
  }

  biomeAt() { return -1; }
  biomeName(x, z) { return { grove: 'Glowing Grove', flats: 'Cinder Flats', wastes: 'Ashen Wastes' }[this.biome(x, z)]; }

  biome(x, z) {
    const b = this.nBiome.fbm2(x / 180, z / 180, 3);
    return b > 0.28 ? 'grove' : b < -0.28 ? 'flats' : 'wastes';
  }

  generate(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const meta = new Uint8Array(CHUNK_VOLUME);
    const X0 = cx * CHUNK, Z0 = cz * CHUNK;
    const idx = (x, y, z) => x | (z << 4) | (y << 8);
    const G = this.grid;
    for (let gy = 0; gy < GY; gy++) for (let gz = 0; gz < 5; gz++) for (let gx = 0; gx < 5; gx++) {
      G[(gy * 5 + gz) * 5 + gx] = this.density(X0 + gx * 4, gy * 4, Z0 + gz * 4);
    }
    const seed = this.seed;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const gx = x >> 2, gz = z >> 2, fx = (x & 3) / 4, fz = (z & 3) / 4;
      for (let y = 0; y <= UNDER_TOP; y++) {
        let id;
        if (y === 0 || y === UNDER_TOP) id = B.bedrock;
        else if ((y <= 4 && rand3(seed ^ 0xbed, X0 + x, y, Z0 + z) < (5 - y) / 5) ||
          (y >= UNDER_TOP - 4 && rand3(seed ^ 0xbee, X0 + x, y, Z0 + z) < (y - (UNDER_TOP - 5)) / 5)) id = B.bedrock;
        else {
          const gy = y >> 2, fy = (y & 3) / 4;
          const g = (a, b, c) => G[((gy + b) * 5 + gz + c) * 5 + gx + a];
          const c00 = g(0, 0, 0) + (g(1, 0, 0) - g(0, 0, 0)) * fx, c10 = g(0, 0, 1) + (g(1, 0, 1) - g(0, 0, 1)) * fx;
          const c01 = g(0, 1, 0) + (g(1, 1, 0) - g(0, 1, 0)) * fx, c11 = g(0, 1, 1) + (g(1, 1, 1) - g(0, 1, 1)) * fx;
          const lo = c00 + (c10 - c00) * fz, hi = c01 + (c11 - c01) * fz;
          const d = lo + (hi - lo) * fy;
          id = d > 0 ? B.scorchstone : y <= LAVA_SEA ? B.lava : 0;
        }
        blocks[idx(x, y, z)] = id;
      }
    }

    // Surface dressing per column.
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const wx = X0 + x, wz = Z0 + z;
      const bio = this.biome(wx, wz);
      const patch = this.nPatch.noise2(wx / 20, wz / 20);
      for (let y = 2; y < UNDER_TOP - 1; y++) {
        const i = idx(x, y, z);
        if (blocks[i] !== B.scorchstone || blocks[i + 256] !== 0) continue;
        // floor block
        if (y >= LAVA_SEA - 2 && y <= LAVA_SEA + 3 && patch > -0.2) blocks[i] = B.magma_rock;
        else if (bio === 'flats' || (bio === 'wastes' && patch > 0.45)) {
          for (let k = 0; k < 3 && y - k > 0; k++) if (blocks[i - k * 256] === B.scorchstone) blocks[i - k * 256] = B.cinder_sand;
        }
        const r = rand3(seed ^ 0xf10, wx, y, wz);
        if (y + 1 < UNDER_TOP && blocks[i + 256] === 0) {
          if (bio === 'grove' && r < 0.14) blocks[i + 256] = B.glowcap;
          else if (r < 0.05) blocks[i + 256] = B.ashen_shrub;
        }
      }
    }

    // Ember crystal clusters hanging from ceilings.
    const cr = rng(hash2(seed ^ 0xc4, cx, cz));
    const clusters = 2 + Math.floor(cr() * 4);
    for (let c = 0; c < clusters; c++) {
      const x = 2 + Math.floor(cr() * 12), z = 2 + Math.floor(cr() * 12);
      for (let y = UNDER_TOP - 3; y > LAVA_SEA + 8; y--) {
        if (blocks[idx(x, y, z)] === 0 && blocks[idx(x, y + 1, z)] === B.scorchstone) {
          let px = x, py = y, pz = z;
          const n = 8 + Math.floor(cr() * 22);
          for (let k = 0; k < n; k++) {
            if (px >= 0 && px < 16 && pz >= 0 && pz < 16 && py > LAVA_SEA && blocks[idx(px, py, pz)] === 0) blocks[idx(px, py, pz)] = B.ember_crystal;
            const d = Math.floor(cr() * 6);
            if (d < 2) py--; else if (d === 2) px++; else if (d === 3) px--; else if (d === 4) pz++; else pz--;
            px = Math.max(0, Math.min(15, px)); pz = Math.max(0, Math.min(15, pz));
          }
          break;
        }
      }
    }

    // Ore veins (from this chunk and its neighbours).
    const ORES = [[B.quartz_ore, 14, 10, 10, 117], [B.ember_gold_ore, 9, 8, 10, 117]];
    for (let ncz = cz - 1; ncz <= cz + 1; ncz++) for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
      const r = rng(hash2(seed ^ 0x0e6, ncx, ncz));
      for (const [ore, per, size, minY, maxY] of ORES) {
        for (let v = 0; v < per; v++) {
          let px = ncx * 16 + r() * 16, py = minY + r() * (maxY - minY), pz = ncz * 16 + r() * 16;
          for (let s = 0; s < size; s += 2) {
            const bx = Math.floor(px) - X0, by = Math.floor(py), bz = Math.floor(pz) - Z0;
            for (const [ox, oy, oz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
              const lx = bx + ox, ly = by + oy, lz = bz + oz;
              if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || ly < 1 || ly > 126) continue;
              if (blocks[idx(lx, ly, lz)] === B.scorchstone) blocks[idx(lx, ly, lz)] = ore;
            }
            px += (r() - 0.5) * 2.4; py += (r() - 0.5) * 1.6; pz += (r() - 0.5) * 2.4;
          }
        }
      }
    }

    // Occasional ruined shrine with a chest.
    const chests = [];
    const sr = rng(hash2(seed ^ 0x5a1, cx, cz));
    if (sr() < 0.045) {
      const ox = 4 + Math.floor(sr() * 4), oz = 4 + Math.floor(sr() * 4);
      for (let y = LAVA_SEA + 4; y < 100; y++) {
        if (blocks[idx(ox + 3, y, oz + 3)] !== 0 && blocks[idx(ox + 3, y + 1, oz + 3)] === 0 && blocks[idx(ox + 3, y + 4, oz + 3)] === 0) {
          const floorY = y;
          for (let dx = 0; dx < 7; dx++) for (let dz = 0; dz < 7; dz++) {
            const edge = dx === 0 || dz === 0 || dx === 6 || dz === 6;
            for (let dy = 0; dy <= 5; dy++) {
              const i = idx(ox + dx, floorY + dy, oz + dz);
              if (dy === 0) blocks[i] = B.ember_bricks;
              else if (dy === 5) blocks[i] = (dx + dz) % 3 ? B.ember_bricks : 0;
              else if (edge) blocks[i] = sr() < 0.18 || (dy <= 2 && dz === 0 && dx === 3) ? 0 : B.ember_bricks;
              else blocks[i] = 0;
            }
          }
          blocks[idx(ox + 3, floorY + 1, oz + 3)] = B.chest; meta[idx(ox + 3, floorY + 1, oz + 3)] = 4;
          blocks[idx(ox + 1, floorY + 1, oz + 1)] = B.glowcap;
          chests.push({ x: X0 + ox + 3, y: floorY + 1, z: Z0 + oz + 3, loot: 'underworld' });
          break;
        }
      }
    }

    let maxY = UNDER_TOP;
    const tints = new Uint8Array(CHUNK * CHUNK * 9);
    for (let i = 0; i < 256; i++) tints.set([150, 110, 90, 140, 100, 80, 190, 80, 40], i * 9);
    return { blocks, meta, tints, maxY, spawns: [], chests, spawners: [] };
  }
}
