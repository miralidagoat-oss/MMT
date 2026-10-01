// Deterministic terrain generation. Every decision is a pure function of the
// world seed and world coordinates, so neighbouring chunks agree on features
// (trees, ore veins) that cross their borders.
import { Simplex, rng, hash2, rand2, rand3 } from './noise.js';
import { B } from './blocks.js';
import { CHUNK, HEIGHT, SEA_LEVEL, CHUNK_VOLUME } from './constants.js';
import { smoothstep, lerp } from './math.js';
import { Villages, placeDungeon, Observatories } from './structures.js';

const SEA = SEA_LEVEL;

export const BIOME = {
  OCEAN: 0, DEEP_OCEAN: 1, FROZEN_OCEAN: 2, BEACH: 3, SNOWY_BEACH: 4, PLAINS: 5, FOREST: 6,
  BIRCH_FOREST: 7, TAIGA: 8, SNOWY_PLAINS: 9, SNOWY_TAIGA: 10, DESERT: 11, SAVANNA: 12, SWAMP: 13,
  MOUNTAINS: 14, SNOWY_PEAKS: 15, RIVER: 16, FROZEN_RIVER: 17, MEADOW: 18,
};

const W_DEFAULT = [60, 110, 220], W_COLD = [52, 84, 196], W_WARM = [68, 150, 214], W_SWAMP = [84, 98, 64];
const G_PLAINS = [122, 184, 82], F_PLAINS = [98, 166, 58];
const G_SNOW = [138, 170, 150], F_SNOW = [118, 150, 128];

// name, grass tint, foliage tint, water tint, tree density, tree kind
export const BIOMES = [
  { name: 'Ocean', grass: G_PLAINS, foliage: F_PLAINS, water: W_DEFAULT },
  { name: 'Deep Ocean', grass: G_PLAINS, foliage: F_PLAINS, water: [48, 90, 200] },
  { name: 'Frozen Ocean', grass: G_SNOW, foliage: F_SNOW, water: W_COLD, cold: true },
  { name: 'Beach', grass: G_PLAINS, foliage: F_PLAINS, water: W_DEFAULT },
  { name: 'Snowy Beach', grass: G_SNOW, foliage: F_SNOW, water: W_COLD, cold: true },
  { name: 'Plains', grass: G_PLAINS, foliage: F_PLAINS, water: W_DEFAULT, trees: 0.0025, tree: 'oak' },
  { name: 'Forest', grass: [100, 168, 70], foliage: [78, 150, 48], water: W_DEFAULT, trees: 0.05, tree: 'mixed' },
  { name: 'Birch Forest', grass: [120, 176, 88], foliage: [100, 160, 70], water: W_DEFAULT, trees: 0.045, tree: 'birch' },
  { name: 'Taiga', grass: [112, 160, 110], foliage: [96, 140, 92], water: W_COLD, trees: 0.04, tree: 'spruce' },
  { name: 'Snowy Plains', grass: G_SNOW, foliage: F_SNOW, water: W_COLD, trees: 0.002, tree: 'spruce', cold: true },
  { name: 'Snowy Taiga', grass: G_SNOW, foliage: F_SNOW, water: W_COLD, trees: 0.035, tree: 'spruce', cold: true },
  { name: 'Desert', grass: [190, 180, 95], foliage: [175, 165, 80], water: W_WARM },
  { name: 'Savanna', grass: [178, 172, 78], foliage: [160, 160, 68], water: W_WARM, trees: 0.005, tree: 'oak' },
  { name: 'Swamp', grass: [96, 112, 60], foliage: [86, 100, 50], water: W_SWAMP, trees: 0.012, tree: 'swamp' },
  { name: 'Mountains', grass: [118, 160, 108], foliage: [100, 145, 90], water: W_COLD, trees: 0.006, tree: 'spruce' },
  { name: 'Snowy Peaks', grass: G_SNOW, foliage: F_SNOW, water: W_COLD, cold: true },
  { name: 'River', grass: G_PLAINS, foliage: F_PLAINS, water: W_DEFAULT },
  { name: 'Frozen River', grass: G_SNOW, foliage: F_SNOW, water: W_COLD, cold: true },
  { name: 'Meadow', grass: [128, 190, 80], foliage: [104, 170, 60], water: W_DEFAULT, trees: 0.0015, tree: 'birch' },
];

const BIRCH_TINT = [128, 167, 85], SPRUCE_TINT = [97, 153, 97];
export { BIRCH_TINT, SPRUCE_TINT };

// Spline through (x, y) control points.
function spline(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x < pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const t = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * (t * t * (3 - 2 * t));
    }
  }
  return pts[pts.length - 1][1];
}
const CONT_SPLINE = [[-1, 26], [-0.55, 34], [-0.3, 46], [-0.14, 56], [-0.05, 61], [0.02, 64], [0.2, 69], [0.55, 78], [1, 88]];

// Ore veins: [block, veins per chunk, size, minY, maxY]
const ORES = [
  ['spark_ore', 8, 8, 2, 16],
  ['coal_ore', 20, 14, 5, 132],
  ['iron_ore', 18, 8, 2, 72],
  ['copper_ore', 10, 10, 20, 100],
  ['gold_ore', 3, 8, 2, 34],
  ['diamond_ore', 1.4, 7, 2, 16],
  ['gravel', 7, 26, 5, 110],
  ['dirt', 8, 26, 5, 110],
  ['clay', 1, 14, 30, 60],
];

export class WorldGen {
  constructor(seed) {
    this.seed = seed | 0;
    const s = this.seed;
    this.nCont = new Simplex(s ^ 0x1001);
    this.nEro = new Simplex(s ^ 0x2002);
    this.nDetail = new Simplex(s ^ 0x3003);
    this.nBump = new Simplex(s ^ 0x3113);
    this.nMount = new Simplex(s ^ 0x4004);
    this.nRidge = new Simplex(s ^ 0x5005);
    this.nRiver = new Simplex(s ^ 0x6006);
    this.nTemp = new Simplex(s ^ 0x7007);
    this.nHum = new Simplex(s ^ 0x8008);
    this.nCaveA = new Simplex(s ^ 0x9009);
    this.nCaveB = new Simplex(s ^ 0xa00a);
    this.nCaveC = new Simplex(s ^ 0xb00b);
    this.nSurf = new Simplex(s ^ 0xc00c);
    this.col = { h: 0, biome: 0, temp: 0, humid: 0, river: 0, mount: 0, cont: 0 };
    this.villages = new Villages(this);
    this.observatories = new Observatories(this);
    this.caveGrid = new Float32Array(5 * 5 * 66 * 3);
  }

  // Terrain parameters for one world column. Returns a shared object.
  sampleColumn(x, z) {
    const c = Math.max(-1, Math.min(1, this.nCont.fbm2(x / 900, z / 900, 5) * 1.6 + 0.12));
    const ero = this.nEro.fbm2(x / 350, z / 350, 3) * 1.4;
    let h = spline(CONT_SPLINE, c);
    const land = smoothstep(-0.08, 0.12, c);
    const hillAmp = 5 + 15 * smoothstep(-0.3, 0.6, ero);
    h += this.nDetail.fbm2(x / 150, z / 150, 4) * hillAmp * (0.35 + 0.65 * land);
    h += this.nBump.fbm2(x / 38, z / 38, 2) * 2.2;
    const mount = smoothstep(0.12, 0.5, this.nMount.fbm2(x / 700, z / 700, 3) * 1.4) * land;
    if (mount > 0) {
      const r = this.nRidge.ridged2(x / 280, z / 280, 5);
      h += mount * (r * r * 105 + mount * 18);
    }
    // Rivers carve channels through low and mid terrain.
    const rv = Math.abs(this.nRiver.fbm2(x / 520, z / 520, 4));
    let river = (1 - smoothstep(0.012, 0.042, rv)) * (1 - smoothstep(0.25, 0.55, mount)) * smoothstep(-0.2, -0.02, c);
    if (river > 0 && h > SEA - 3) {
      h = lerp(h, SEA - 3 - river * 3, river);
    }
    let temp = this.nTemp.fbm2(x / 1200, z / 1200, 3) * 1.6 - Math.max(0, h - 95) / 90;
    const humid = this.nHum.fbm2(x / 1000 + 300, z / 1000, 3) * 1.6;
    h = Math.floor(h);
    if (h > HEIGHT - 20) h = HEIGHT - 20;
    if (h < 6) h = 6;

    let biome;
    if (h < SEA - 1) {
      if (river > 0.45 && c > -0.1) biome = temp < -0.4 ? BIOME.FROZEN_RIVER : BIOME.RIVER;
      else if (h < SEA - 17) biome = temp < -0.45 ? BIOME.FROZEN_OCEAN : BIOME.DEEP_OCEAN;
      else biome = temp < -0.45 ? BIOME.FROZEN_OCEAN : BIOME.OCEAN;
    } else if (h <= SEA + 2 && c < 0.06 && mount < 0.1) {
      biome = temp < -0.4 ? BIOME.SNOWY_BEACH : BIOME.BEACH;
    } else if (mount > 0.3 && h > 98) {
      biome = h > 138 || temp < -0.35 ? BIOME.SNOWY_PEAKS : BIOME.MOUNTAINS;
    } else if (temp < -0.4) {
      biome = humid > 0.05 ? BIOME.SNOWY_TAIGA : BIOME.SNOWY_PLAINS;
    } else if (temp < -0.12) {
      biome = BIOME.TAIGA;
    } else if (temp > 0.42) {
      biome = humid < -0.05 ? BIOME.DESERT : humid < 0.3 ? BIOME.SAVANNA : BIOME.FOREST;
    } else if (humid > 0.4 && h < SEA + 6) {
      biome = BIOME.SWAMP;
    } else if (humid > 0.08) {
      biome = humid > 0.32 && temp < 0.22 ? BIOME.BIRCH_FOREST : BIOME.FOREST;
    } else if (humid < -0.38 && temp > 0.05) {
      biome = BIOME.MEADOW;
    } else {
      biome = BIOME.PLAINS;
    }
    const o = this.col;
    o.h = h; o.biome = biome; o.temp = temp; o.humid = humid; o.river = river; o.mount = mount; o.cont = c;
    return o;
  }

  heightAt(x, z) { return this.sampleColumn(x, z).h; }

  // Building style for a village centred here, or null if villages don't form.
  villageStyle(x, z) {
    switch (this.biomeAt(x, z)) {
      case BIOME.PLAINS: case BIOME.MEADOW: return 'oak';
      case BIOME.SAVANNA: return 'birch';
      case BIOME.DESERT: return 'sand';
      case BIOME.TAIGA: case BIOME.SNOWY_PLAINS: case BIOME.SNOWY_TAIGA: return 'spruce';
      default: return null;
    }
  }
  biomeAt(x, z) { return this.sampleColumn(x, z).biome; }

  // --- caves ---------------------------------------------------------------
  caveNoise(gx, gy, gz, out, o) {
    out[o] = this.nCaveA.noise3(gx / 42, gy / 30, gz / 42);
    out[o + 1] = this.nCaveB.noise3(gx / 42, gy / 30, gz / 42);
    out[o + 2] = this.nCaveC.noise3(gx / 72, gy / 38, gz / 72);
  }

  static carve(n1, n2, n3, y, h, nearWater) {
    if (y < 1) return false;
    const depth = h - y;
    if (depth < 0) return false;
    if (h < SEA && depth < 7) return false;
    if (nearWater && y > SEA - 8 && depth < 10) return false;
    let w = 0.0042;
    if (depth < 5) w *= 0.55;
    if (n1 * n1 + n2 * n2 < w) return true;
    if (n3 > 0.62 && y < 54 && depth > 8) return true;
    return false;
  }

  // Direct (grid-consistent) cave test for arbitrary positions.
  caveAt(x, y, z, h, nearWater) {
    const gx = Math.floor(x / 4) * 4, gy = Math.floor(y / 4) * 4, gz = Math.floor(z / 4) * 4;
    const tmp = this._tmp || (this._tmp = new Float32Array(24));
    let k = 0;
    for (let dy = 0; dy <= 4; dy += 4) for (let dz = 0; dz <= 4; dz += 4) for (let dx = 0; dx <= 4; dx += 4) {
      this.caveNoise(gx + dx, gy + dy, gz + dz, tmp, k); k += 3;
    }
    const fx = (x - gx) / 4, fy = (y - gy) / 4, fz = (z - gz) / 4;
    const n = [0, 0, 0];
    for (let c = 0; c < 3; c++) n[c] = tri(tmp, c, 3, fx, fy, fz);
    return WorldGen.carve(n[0], n[1], n[2], y, h, nearWater);
  }

  // --- tree placement ------------------------------------------------------
  // Only depends on (x, z) so every chunk that can see the tree agrees on it.
  treeAt(x, z, colH, colBiome) {
    const bd = BIOMES[colBiome];
    if (!bd.trees) return null;
    if (colH <= SEA || colH > 170) return null;
    const hv = hash2(this.seed ^ 0x7e1e, x, z);
    const r = hv / 4294967296;
    // density varies smoothly over the landscape for natural clearings
    const patch = 0.55 + 0.9 * (this.nSurf.noise2(x / 60, z / 60) * 0.5 + 0.5);
    if (r >= bd.trees * patch) return null;
    // keep trunks apart: this tree must win against candidates nearby
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dz) continue;
      const o = hash2(this.seed ^ 0x7e1e, x + dx, z + dz);
      if (o / 4294967296 < bd.trees * patch && o < hv) return null;
    }
    if (this.caveAt(x, colH, z, colH, false) || this.caveAt(x, colH - 1, z, colH, false)) return null;
    if (this.villages.covers(x, z)) return null;
    let kind = bd.tree;
    const r2 = rand2(this.seed ^ 0x51, x, z);
    if (kind === 'mixed') kind = r2 < 0.2 ? 'birch' : r2 < 0.28 ? 'big_oak' : 'oak';
    else if (kind === 'oak' && r2 < 0.06) kind = 'big_oak';
    return { kind, r: rng(hv) };
  }

  // Write a tree into the chunk (only blocks that fall inside it).
  placeTree(ctx, wx, baseY, wz, kind, r) {
    const { set, get } = ctx;
    const leaf = (x, y, z, id) => { const c = get(x, y, z); if (c === 0 || c === B.tall_grass || c === B.fern) set(x, y, z, id, 0); };
    const log = (x, y, z, id) => { const c = get(x, y, z); if (c === 0 || c === B.tall_grass || c === B.fern || c === B.oak_leaves || c === B.birch_leaves || c === B.spruce_leaves || c === B.water) set(x, y, z, id, 0); };
    set(wx, baseY - 1, wz, B.dirt, 0);
    if (kind === 'oak' || kind === 'birch' || kind === 'swamp') {
      const logId = kind === 'birch' ? B.birch_log : B.oak_log;
      const leafId = kind === 'birch' ? B.birch_leaves : B.oak_leaves;
      const hgt = (kind === 'birch' ? 5 : 4) + Math.floor(r() * 3);
      const top = baseY + hgt;
      const rad = kind === 'swamp' ? 3 : 2;
      for (let y = top - 3; y <= top; y++) {
        const layer = y - (top - 3);
        const rr = layer < 2 ? rad : 1;
        for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
          const corner = Math.abs(dx) === rr && Math.abs(dz) === rr;
          if (corner && (layer >= 2 || r() < 0.5)) continue;
          if (layer === 3 && corner) continue;
          if (kind === 'swamp' && layer >= 2 && (Math.abs(dx) > 1 || Math.abs(dz) > 1)) continue;
          leaf(wx + dx, y, wz + dz, leafId);
        }
      }
      for (let y = baseY; y < top; y++) log(wx, y, wz, logId);
    } else if (kind === 'big_oak') {
      const hgt = 6 + Math.floor(r() * 4);
      const top = baseY + hgt;
      // a few branch clusters around the upper trunk
      const clusters = [[0, top, 0]];
      const nb = 2 + Math.floor(r() * 3);
      for (let i = 0; i < nb; i++) {
        const a = r() * Math.PI * 2, d = 2 + r() * 1.5;
        clusters.push([Math.round(Math.cos(a) * d), baseY + Math.floor(hgt * (0.55 + r() * 0.35)), Math.round(Math.sin(a) * d)]);
      }
      for (const [cx, cy, cz] of clusters) {
        for (let dy = -1; dy <= 2; dy++) {
          const rr = dy === -1 || dy === 2 ? 2 : 3;
          for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
            const dd = dx * dx + dz * dz + (dy - 0.5) * (dy - 0.5) * 1.6;
            if (dd > rr * rr + 0.5 || (dd > (rr - 1) * (rr - 1) + 1 && r() < 0.25)) continue;
            leaf(wx + cx + dx, cy + dy, wz + cz + dz, B.oak_leaves);
          }
        }
        // branch from trunk to cluster
        const steps = Math.max(Math.abs(cx), Math.abs(cz));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          log(wx + Math.round(cx * t), cy - 1 + Math.round(t), wz + Math.round(cz * t), B.oak_log);
        }
      }
      for (let y = baseY; y < top; y++) log(wx, y, wz, B.oak_log);
    } else if (kind === 'spruce') {
      const hgt = 6 + Math.floor(r() * 5);
      const top = baseY + hgt;
      leaf(wx, top + 1, wz, B.spruce_leaves);
      leaf(wx, top, wz, B.spruce_leaves);
      let rad = 0, maxR = 1 + (r() < 0.5 ? 1 : 2);
      for (let y = top - 1; y >= baseY + 2; y--) {
        rad = rad >= maxR ? 1 : rad + 1;
        if (y < top - 4 && rad === 1 && maxR < 3 && r() < 0.5) maxR++;
        for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > rad + (rad > 1 ? 1 : 0)) continue;
          if (!dx && !dz) continue;
          leaf(wx + dx, y, wz + dz, B.spruce_leaves);
        }
      }
      for (let y = baseY; y < top; y++) log(wx, y, wz, B.spruce_log);
    }
  }

  // --- chunk generation ----------------------------------------------------
  generate(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const meta = new Uint8Array(CHUNK_VOLUME);
    const X0 = cx * CHUNK, Z0 = cz * CHUNK;
    const seed = this.seed;
    const BORDER = 4, CW = CHUNK + BORDER * 2;
    const H = new Int16Array(CW * CW), BI = new Uint8Array(CW * CW);
    for (let dz = 0; dz < CW; dz++) for (let dx = 0; dx < CW; dx++) {
      const c = this.sampleColumn(X0 + dx - BORDER, Z0 + dz - BORDER);
      H[dz * CW + dx] = c.h; BI[dz * CW + dx] = c.biome;
    }
    const colH = (lx, lz) => H[(lz + BORDER) * CW + lx + BORDER];
    const colB = (lx, lz) => BI[(lz + BORDER) * CW + lx + BORDER];
    const nearWaterCol = (lx, lz) =>
      colH(lx + 1, lz) < SEA || colH(lx - 1, lz) < SEA || colH(lx, lz + 1) < SEA || colH(lx, lz - 1) < SEA ||
      colH(lx + 2, lz) < SEA || colH(lx - 2, lz) < SEA || colH(lx, lz + 2) < SEA || colH(lx, lz - 2) < SEA;

    const idx = (x, y, z) => x | (z << 4) | (y << 8);
    let maxH = 0;
    for (let i = 0; i < H.length; i++) if (H[i] > maxH) maxH = H[i];

    // 1. Stone, surface layers and water.
    for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) {
      const wx = X0 + x, wz = Z0 + z;
      const h = colH(x, z), bio = colB(x, z);
      const bd = BIOMES[bio];
      let slope = 0;
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) slope = Math.max(slope, Math.abs(colH(x + ox, z + oz) - h));
      const sn = this.nSurf.noise2(wx / 14, wz / 14);
      const depth = 3 + Math.floor((sn * 0.5 + 0.5) * 2.5);
      let top = B.grass, fill = B.dirt, fillDepth = depth, under = 0;
      switch (bio) {
        case BIOME.DESERT: top = B.sand; fill = B.sand; fillDepth = 4; under = B.sandstone; break;
        case BIOME.BEACH: top = B.sand; fill = B.sand; fillDepth = 3; under = B.sandstone; break;
        case BIOME.SNOWY_BEACH: top = B.sand; fill = B.sand; fillDepth = 3; break;
        case BIOME.SNOWY_PLAINS: case BIOME.SNOWY_TAIGA: top = B.snowy_grass; break;
        case BIOME.MOUNTAINS:
          if (slope > 2 || h > 128) { top = B.stone; fill = B.stone; }
          else if (sn > 0.55) { top = B.gravel; fill = B.gravel; fillDepth = 2; }
          break;
        case BIOME.SNOWY_PEAKS:
          if (slope > 3) { top = B.stone; fill = B.stone; } else { top = B.snow_block; fill = B.snow_block; fillDepth = 2; }
          break;
        default: break;
      }
      if (h < SEA - 1) {
        // underwater floors
        if (bio === BIOME.DEEP_OCEAN || h < SEA - 14) { top = B.gravel; fill = B.gravel; fillDepth = 2; }
        else if (sn > 0.35 && bio !== BIOME.SWAMP) { top = B.clay; fill = B.clay; fillDepth = 2; }
        else if (bio === BIOME.SWAMP || bio === BIOME.RIVER) { top = sn > -0.2 ? B.dirt : B.sand; fill = B.dirt; }
        else { top = B.sand; fill = B.sand; fillDepth = 3; under = B.sandstone; }
      } else if (h <= SEA && top === B.grass) {
        top = B.sand; fill = B.sand; // shorelines
      }
      if (bd.cold && h >= SEA && top === B.grass) top = B.snowy_grass;

      blocks[idx(x, 0, z)] = B.bedrock;
      for (let y = 1; y <= h; y++) {
        let id = B.stone;
        if (y <= 4 && rand3(seed ^ 0xbed, wx, y, wz) < (5 - y) / 5) id = B.bedrock;
        else if (y === h) id = top;
        else if (y > h - fillDepth) id = fill;
        else if (under && y > h - fillDepth - 3) id = under;
        blocks[idx(x, y, z)] = id;
      }
      for (let y = h + 1; y <= SEA; y++) {
        blocks[idx(x, y, z)] = B.water;
      }
      if (bd.cold && h < SEA) blocks[idx(x, SEA, z)] = B.ice;
    }

    // 2. Caves (trilinear-interpolated noise on a world-aligned 4-block grid).
    const GY = Math.min(HEIGHT, maxH + 2);
    const ny = (GY >> 2) + 2;
    const G = this.caveGrid.length >= 25 * ny * 3 ? this.caveGrid : (this.caveGrid = new Float32Array(25 * ny * 3));
    for (let gy = 0; gy < ny; gy++) for (let gz = 0; gz < 5; gz++) for (let gx = 0; gx < 5; gx++) {
      this.caveNoise(X0 + gx * 4, gy * 4, Z0 + gz * 4, G, ((gy * 5 + gz) * 5 + gx) * 3);
    }
    const cube = new Float32Array(24);
    for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) {
      const h = colH(x, z), nw = nearWaterCol(x, z);
      const gx = x >> 2, gz = z >> 2, fx = (x & 3) / 4, fz = (z & 3) / 4;
      for (let y = 1; y <= h; y++) {
        const gy = y >> 2, fy = (y & 3) / 4;
        let k = 0;
        for (let dy = 0; dy <= 1; dy++) for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
          const o = (((gy + dy) * 5 + gz + dz) * 5 + gx + dx) * 3;
          cube[k++] = G[o]; cube[k++] = G[o + 1]; cube[k++] = G[o + 2];
        }
        const n1 = tri(cube, 0, 3, fx, fy, fz), n2 = tri(cube, 1, 3, fx, fy, fz), n3 = tri(cube, 2, 3, fx, fy, fz);
        if (WorldGen.carve(n1, n2, n3, y, h, nw)) {
          const i = idx(x, y, z);
          if (blocks[i] === B.bedrock || blocks[i] === B.water || blocks[i] === B.ice) continue;
          blocks[i] = y <= 10 ? B.lava : 0;
        }
      }
      // exposed dirt at the top of a carved column becomes grass again
      const ti = idx(x, h, z);
      if (blocks[ti] === 0 && h > SEA) {
        for (let y = h - 1; y > h - 5 && y > 0; y--) {
          const j = idx(x, y, z);
          if (blocks[j] === B.dirt) { blocks[j] = BIOMES[colB(x, z)].cold ? B.snowy_grass : B.grass; break; }
          if (blocks[j] !== 0) break;
        }
      }
    }

    // 3. Ores, from veins seeded by this and neighbouring chunks.
    for (let ncz = cz - 1; ncz <= cz + 1; ncz++) for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
      const r = rng(hash2(seed ^ 0x0e5, ncx, ncz));
      for (const [name, per, size, minY, maxY] of ORES) {
        let count = Math.floor(per) + (r() < per - Math.floor(per) ? 1 : 0);
        const id = B[name];
        for (let v = 0; v < count; v++) {
          let px = ncx * CHUNK + r() * 16, pz = ncz * CHUNK + r() * 16, py = minY + r() * (maxY - minY);
          const ang = r() * Math.PI * 2, pitch = (r() - 0.5) * 0.8;
          let dx = Math.cos(ang) * Math.cos(pitch), dy = Math.sin(pitch), dz = Math.sin(ang) * Math.cos(pitch);
          const rad = size > 12 ? 1.5 : size > 8 ? 1.1 : 0.8;
          for (let s = 0; s < size; s += 2) {
            const lx0 = Math.floor(px - rad) - X0, lx1 = Math.floor(px + rad) - X0;
            const lz0 = Math.floor(pz - rad) - Z0, lz1 = Math.floor(pz + rad) - Z0;
            const y0 = Math.max(1, Math.floor(py - rad)), y1 = Math.min(HEIGHT - 1, Math.floor(py + rad));
            for (let yy = y0; yy <= y1; yy++) for (let lz = lz0; lz <= lz1; lz++) for (let lx = lx0; lx <= lx1; lx++) {
              if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
              const ddx = lx + X0 + 0.5 - px, ddy = yy + 0.5 - py, ddz = lz + Z0 + 0.5 - pz;
              if (ddx * ddx + ddy * ddy + ddz * ddz > rad * rad) continue;
              const i = idx(lx, yy, lz);
              if (blocks[i] === B.stone) blocks[i] = id;
            }
            px += dx * 1.4; py += dy * 1.4; pz += dz * 1.4;
            dx += (r() - 0.5) * 0.6; dy += (r() - 0.5) * 0.4; dz += (r() - 0.5) * 0.6;
            const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
          }
        }
      }
      // emeralds: single blocks deep in mountains
      const mb = this.biomeAt(ncx * CHUNK + 8, ncz * CHUNK + 8);
      if (mb === BIOME.MOUNTAINS || mb === BIOME.SNOWY_PEAKS) {
        const er = rng(hash2(seed ^ 0xe3e, ncx, ncz));
        for (let i = 0; i < 4; i++) {
          const ex = ncx * CHUNK + Math.floor(er() * 16) - X0, ez = ncz * CHUNK + Math.floor(er() * 16) - Z0;
          const ey = 4 + Math.floor(er() * 28);
          if (ex >= 0 && ex < 16 && ez >= 0 && ez < 16 && blocks[idx(ex, ey, ez)] === B.stone) blocks[idx(ex, ey, ez)] = B.emerald_ore;
        }
      }
    }

    // Dungeons deep in the rock.
    const extra = { spawns: [], chests: [], spawners: [] };
    let minH = 999;
    for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) minH = Math.min(minH, colH(x, z));
    placeDungeon(seed, cx, cz, blocks, meta, minH, extra);

    // 4. Trees (from columns in a border around the chunk).
    const ctx = {
      get: (wx, y, wz) => {
        const lx = wx - X0, lz = wz - Z0;
        if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y >= HEIGHT) return -1;
        return blocks[idx(lx, y, lz)];
      },
      set: (wx, y, wz, id, m) => {
        const lx = wx - X0, lz = wz - Z0;
        if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y >= HEIGHT) return;
        blocks[idx(lx, y, lz)] = id; meta[idx(lx, y, lz)] = m;
      },
    };
    for (let dz = -BORDER; dz < CHUNK + BORDER; dz++) for (let dx = -BORDER; dx < CHUNK + BORDER; dx++) {
      const h = colH(dx, dz), bio = colB(dx, dz);
      if (!BIOMES[bio].trees) continue;
      const t = this.treeAt(X0 + dx, Z0 + dz, h, bio);
      if (t) this.placeTree(ctx, X0 + dx, h + 1, Z0 + dz, t.kind, t.r);
    }

    // 5. Ground cover: grass, flowers, cacti, sugar cane, pumpkins, mushrooms.
    for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) {
      const wx = X0 + x, wz = Z0 + z;
      const h = colH(x, z), bio = colB(x, z);
      if (h + 1 >= HEIGHT) continue;
      const topId = blocks[idx(x, h, z)], above = blocks[idx(x, h + 1, z)];
      if (above !== 0) continue;
      const r = rand2(seed ^ 0x9a55, wx, wz), r2 = rand2(seed ^ 0xf10, wx, wz);
      const fl = this.nSurf.noise2(wx / 24 + 500, wz / 24);
      if (topId === B.grass) {
        let grassP = 0.12, flowerP = 0.01;
        if (bio === BIOME.PLAINS) { grassP = 0.3; flowerP = 0.02; }
        if (bio === BIOME.MEADOW) { grassP = 0.35; flowerP = 0.12; }
        if (bio === BIOME.SAVANNA) grassP = 0.45;
        if (bio === BIOME.FOREST || bio === BIOME.BIRCH_FOREST) { grassP = 0.2; flowerP = 0.015; }
        if (bio === BIOME.TAIGA) grassP = 0.2;
        if (bio === BIOME.SWAMP) grassP = 0.15;
        if (fl > 0.45) flowerP *= 4;
        if (r < flowerP) {
          const k = r2 < 0.45 ? B.dandelion : r2 < 0.85 ? B.poppy : B.cornflower;
          blocks[idx(x, h + 1, z)] = k;
        } else if (r < flowerP + grassP) {
          blocks[idx(x, h + 1, z)] = (bio === BIOME.TAIGA || bio === BIOME.MOUNTAINS) && r2 < 0.5 ? B.fern : B.tall_grass;
        } else if (r > 0.9993 && (bio === BIOME.PLAINS || bio === BIOME.FOREST || bio === BIOME.SAVANNA)) {
          blocks[idx(x, h + 1, z)] = B.pumpkin; meta[idx(x, h + 1, z)] = 2 + Math.floor(r2 * 4);
        } else if (r > 0.9985 && bio === BIOME.SWAMP) {
          blocks[idx(x, h + 1, z)] = r2 < 0.5 ? B.brown_mushroom : B.red_mushroom;
        }
      } else if (topId === B.snowy_grass) {
        if (r < 0.04) blocks[idx(x, h + 1, z)] = B.fern;
      } else if (topId === B.sand && h > SEA) {
        if (bio === BIOME.DESERT) {
          if (r < 0.006 && x > 0 && x < 15 && z > 0 && z < 15) {
            const ch = 1 + Math.floor(r2 * 3);
            for (let y = h + 1; y <= h + ch && y < HEIGHT; y++) blocks[idx(x, y, z)] = B.cactus;
          } else if (r > 0.992) blocks[idx(x, h + 1, z)] = B.dead_bush;
        }
      }
      // sugar cane beside water
      if ((topId === B.grass || topId === B.sand || topId === B.dirt) && h === SEA && r2 > 0.9 && x > 0 && x < 15 && z > 0 && z < 15) {
        if (blocks[idx(x + 1, h, z)] === B.water || blocks[idx(x - 1, h, z)] === B.water || blocks[idx(x, h, z + 1)] === B.water || blocks[idx(x, h, z - 1)] === B.water) {
          const ch = 1 + Math.floor(r * 3);
          for (let y = h + 1; y <= h + ch; y++) blocks[idx(x, y, z)] = B.sugar_cane;
        }
      }
    }
    // Villages overlapping this chunk.
    for (const v of this.villages.near(X0, Z0, X0 + 15, Z0 + 15)) this.villages.write(v, ctx, X0, Z0, extra);
    // Buried observatories.
    for (const o of this.observatories.near(X0, Z0, X0 + 15, Z0 + 15)) this.observatories.write(o, ctx, X0, Z0, extra);

    // cave mushrooms
    const mr = rng(hash2(seed ^ 0x3a1, cx, cz));
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(mr() * 16), z = Math.floor(mr() * 16), y = 12 + Math.floor(mr() * 40);
      if (y + 1 < HEIGHT && blocks[idx(x, y, z)] === B.stone && blocks[idx(x, y + 1, z)] === 0) {
        blocks[idx(x, y + 1, z)] = mr() < 0.5 ? B.brown_mushroom : B.red_mushroom;
      }
    }

    // 6. Height bound for the mesher.
    let maxY = 0;
    for (let y = HEIGHT - 1; y >= 0 && !maxY; y--) {
      const base = y << 8;
      for (let i = 0; i < 256; i++) if (blocks[base + i]) { maxY = y; break; }
    }

    // 7. Smoothly blended biome tints (5x5 box blur).
    const tints = new Uint8Array(CHUNK * CHUNK * 9);
    for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) {
      const acc = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const b = BIOMES[colB(x + dx, z + dz)];
        acc[0] += b.grass[0]; acc[1] += b.grass[1]; acc[2] += b.grass[2];
        acc[3] += b.foliage[0]; acc[4] += b.foliage[1]; acc[5] += b.foliage[2];
        acc[6] += b.water[0]; acc[7] += b.water[1]; acc[8] += b.water[2];
      }
      const o = (z * CHUNK + x) * 9;
      for (let k = 0; k < 9; k++) tints[o + k] = Math.round(acc[k] / 25);
    }

    // 8. Initial animals (about one chunk in eight gets a small herd).
    const spawns = [];
    const sr = rng(hash2(seed ^ 0xa11, cx, cz));
    if (sr() < 0.12) {
      const bio = colB(8, 8);
      let types = ['pig', 'cow', 'sheep', 'chicken'];
      if (bio === BIOME.SNOWY_PLAINS || bio === BIOME.SNOWY_TAIGA || bio === BIOME.MOUNTAINS) types = ['sheep'];
      if (bio === BIOME.DESERT || bio === BIOME.BEACH || bio === BIOME.SNOWY_BEACH || colH(8, 8) <= SEA) types = [];
      if (types.length) {
        const type = types[Math.floor(sr() * types.length)];
        const n = 2 + Math.floor(sr() * 3);
        for (let i = 0; i < n; i++) {
          const x = Math.floor(sr() * 16), z = Math.floor(sr() * 16);
          const h = colH(x, z);
          const t = blocks[idx(x, h, z)];
          if ((t === B.grass || t === B.snowy_grass) && h + 2 < HEIGHT && blocks[idx(x, h + 1, z)] !== B.oak_log) {
            spawns.push({ type, x: X0 + x + 0.5, y: h + 1, z: Z0 + z + 0.5 });
          }
        }
      }
    }

    const inChunk = (o) => Math.floor(o.x) >= X0 && Math.floor(o.x) < X0 + 16 && Math.floor(o.z) >= Z0 && Math.floor(o.z) < Z0 + 16;
    spawns.push(...extra.spawns.filter(inChunk));
    return { blocks, meta, tints, maxY, spawns, chests: extra.chests.filter(inChunk), spawners: extra.spawners };
  }

  // Find a dry spawn column near the origin.
  findSpawn() {
    for (let r = 0; r < 4000; r += 16) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = Math.round(Math.cos(ang) * r), z = Math.round(Math.sin(ang) * r);
        const c = this.sampleColumn(x, z);
        if (c.h > SEA + 1 && c.h < 110 && c.biome !== BIOME.BEACH && c.biome !== BIOME.SNOWY_BEACH) return { x: x + 0.5, z: z + 0.5, h: c.h };
        if (r === 0) break;
      }
    }
    return { x: 0.5, z: 0.5, h: this.heightAt(0, 0) };
  }
}

// Trilinear interpolation over 8 corners stored with a stride (dx fastest).
function tri(v, c, stride, fx, fy, fz) {
  const g = (i) => v[i * stride + c];
  const x00 = g(0) + (g(1) - g(0)) * fx;
  const x10 = g(2) + (g(3) - g(2)) * fx;
  const x01 = g(4) + (g(5) - g(4)) * fx;
  const x11 = g(6) + (g(7) - g(6)) * fx;
  const y0 = x00 + (x10 - x00) * fz;
  const y1 = x01 + (x11 - x01) * fz;
  return y0 + (y1 - y0) * fy;
}
