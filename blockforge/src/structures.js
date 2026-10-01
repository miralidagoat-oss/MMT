// Generated structures: villages (houses, farms, smithy, pens, well, roads,
// lamps) and underground dungeons. Villages are laid out deterministically
// from the seed so every chunk agrees on them; each chunk only writes the
// blocks that fall inside it.
import { rng, hash2 } from './noise.js';
import { B } from './blocks.js';
import { SEA_LEVEL } from './constants.js';
import { DIRS, DIR_FACE, DOOR_UPPER, BED_HEAD } from './shapes.js';

const CELL = 360;
export const VILLAGE_RADIUS = 58;

const STYLES = {
  oak: { planks: B.oak_planks, log: B.oak_log, floor: B.oak_planks, found: B.cobblestone, stairs: B.oak_stairs, slab: B.oak_slab, path: B.dirt_path },
  spruce: { planks: B.spruce_planks, log: B.spruce_log, floor: B.spruce_planks, found: B.cobblestone, stairs: B.cobblestone_stairs, slab: B.cobblestone_slab, path: B.dirt_path },
  birch: { planks: B.birch_planks, log: B.oak_log, floor: B.birch_planks, found: B.cobblestone, stairs: B.oak_stairs, slab: B.oak_slab, path: B.dirt_path },
  sand: { planks: B.sandstone, log: B.sandstone, floor: B.sandstone, found: B.sandstone, stairs: B.cobblestone_stairs, slab: B.stone_slab, path: B.dirt_path },
};

// Settler professions by building.
export const PROFESSIONS = ['farmer', 'smith', 'shepherd', 'scholar'];

// ---------------------------------------------------------------------------
export class Villages {
  constructor(gen) {
    this.gen = gen;
    this.cache = new Map();
  }

  // The village in a grid cell, or null.
  inCell(cellX, cellZ) {
    const key = cellX * 100003 + cellZ;
    if (this.cache.has(key)) return this.cache.get(key);
    let v = null;
    const g = this.gen;
    const r = rng(hash2(g.seed ^ 0x71a6e, cellX, cellZ));
    if (r() < 0.62) {
      const x = cellX * CELL + 70 + Math.floor(r() * (CELL - 140));
      const z = cellZ * CELL + 70 + Math.floor(r() * (CELL - 140));
      const style = g.villageStyle(x, z);
      if (style) {
        const h = g.heightAt(x, z);
        let lo = h, hi = h;
        for (let a = 0; a < 8; a++) {
          const hh = g.heightAt(x + Math.round(Math.cos(a * 0.785) * 26), z + Math.round(Math.sin(a * 0.785) * 26));
          lo = Math.min(lo, hh); hi = Math.max(hi, hh);
        }
        if (h > SEA_LEVEL + 1 && h < 115 && hi - lo < 11 && lo > SEA_LEVEL - 2) {
          v = { x, z, h, style: STYLES[style], styleName: style, seed: hash2(g.seed ^ 0x3e11, x, z) };
          this.layout(v);
        }
      }
    }
    this.cache.set(key, v);
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
    return v;
  }

  near(x0, z0, x1, z1) {
    const out = [];
    const R = VILLAGE_RADIUS + 8;
    for (let cz = Math.floor((z0 - R) / CELL); cz <= Math.floor((z1 + R) / CELL); cz++)
      for (let cx = Math.floor((x0 - R) / CELL); cx <= Math.floor((x1 + R) / CELL); cx++) {
        const v = this.inCell(cx, cz);
        if (v && v.bx1 >= x0 && v.bx0 <= x1 && v.bz1 >= z0 && v.bz0 <= z1) out.push(v);
      }
    return out;
  }

  // Nearest village centre within `cells` grid cells of (x, z), or null.
  locate(x, z, cells = 6) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = null, bd = Infinity;
    for (let dz = -cells; dz <= cells; dz++) for (let dx = -cells; dx <= cells; dx++) {
      const v = this.inCell(cx + dx, cz + dz);
      if (!v) continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // Is (x, z) inside any village's footprint (used to keep trees out)?
  covers(x, z) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const v = this.inCell(cx + dx, cz + dz);
      if (v && x >= v.bx0 - 3 && x <= v.bx1 + 3 && z >= v.bz0 - 3 && z <= v.bz1 + 3) return true;
    }
    return false;
  }

  layout(v) {
    const g = this.gen;
    const r = rng(v.seed);
    const pieces = [];
    const rects = [];
    const free = (x0, z0, x1, z1) => !rects.some((q) => x0 <= q[2] + 1 && x1 >= q[0] - 1 && z0 <= q[3] + 1 && z1 >= q[1] - 1);
    // well in the middle
    pieces.push({ kind: 'well', x0: v.x - 2, z0: v.z - 2, x1: v.x + 1, z1: v.z + 1, y: v.h });
    rects.push([v.x - 3, v.z - 3, v.x + 2, v.z + 2]);
    const road = { kind: 'road', cells: [], x0: 1e9, z0: 1e9, x1: -1e9, z1: -1e9 };
    const addRoad = (x, z) => {
      road.cells.push([x, z]);
      road.x0 = Math.min(road.x0, x); road.z0 = Math.min(road.z0, z); road.x1 = Math.max(road.x1, x); road.z1 = Math.max(road.z1, z);
    };
    for (let dz = -3; dz <= 2; dz++) for (let dx = -3; dx <= 2; dx++) if (dx < -2 || dx > 1 || dz < -2 || dz > 1) addRoad(v.x + dx, v.z + dz);
    let smithy = false;
    const arms = [0, 1, 2, 3].filter(() => r() < 0.85);
    if (arms.length < 2) arms.push(0, 2);
    for (const a of new Set(arms)) {
      const [ax, az] = DIRS[a];
      const px = -az, pz = ax;
      const len = 18 + Math.floor(r() * 22);
      for (let t = 3; t <= len; t++) for (let o = -1; o <= 1; o++) {
        const x = v.x + ax * t + px * o, z = v.z + az * t + pz * o;
        if (t <= 3) continue;
        addRoad(x, z);
      }
      rects.push([Math.min(v.x + ax * 3 - 1, v.x + ax * len - 1), Math.min(v.z + az * 3 - 1, v.z + az * len - 1), Math.max(v.x + ax * 3 + 1, v.x + ax * len + 1), Math.max(v.z + az * 3 + 1, v.z + az * len + 1)]);
      // lamp at the end of the road
      pieces.push({ kind: 'lamp', x0: v.x + ax * (len + 1), z0: v.z + az * (len + 1), x1: v.x + ax * (len + 1), z1: v.z + az * (len + 1) });
      for (let t = 7; t <= len - 2; t += 10) {
        for (const side of [-1, 1]) {
          if (r() > 0.8) continue;
          const roll = r();
          let kind = roll < 0.42 ? 'house' : roll < 0.62 ? 'bighouse' : roll < 0.86 ? 'farm' : roll < 0.94 ? 'pen' : 'smithy';
          if (kind === 'smithy') { if (smithy) kind = 'house'; else smithy = true; }
          const [w, d] = { house: [5, 5], bighouse: [7, 7], farm: [9, 7], pen: [7, 7], smithy: [7, 7] }[kind];
          const half = w >> 1;
          const pts = [];
          for (const along of [t - half, t + half]) for (const perp of [side * 3, side * (3 + d - 1)]) {
            pts.push([v.x + ax * along + px * perp, v.z + az * along + pz * perp]);
          }
          const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
          const z0 = Math.min(...pts.map((p) => p[1])), z1 = Math.max(...pts.map((p) => p[1]));
          if (!free(x0, z0, x1, z1)) continue;
          const y = g.heightAt((x0 + x1) >> 1, (z0 + z1) >> 1);
          let lo = y, hi = y;
          for (const [qx, qz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) { const hh = g.heightAt(qx, qz); lo = Math.min(lo, hh); hi = Math.max(hi, hh); }
          if (y <= SEA_LEVEL || hi - lo > 6) continue;
          // the door faces the road
          const fx = -side * px, fz = -side * pz;
          const f = DIRS.findIndex(([dx, dz]) => dx === fx && dz === fz);
          rects.push([x0, z0, x1, z1]);
          pieces.push({ kind, x0, z0, x1, z1, w, d, f, y, seed: hash2(v.seed, x0, z0) });
          // short path to the door
          addRoad(v.x + ax * t + px * side * 2, v.z + az * t + pz * side * 2);
        }
      }
    }
    pieces.push(road);
    v.pieces = pieces;
    v.bx0 = Math.min(...pieces.map((p) => p.x0)); v.bz0 = Math.min(...pieces.map((p) => p.z0));
    v.bx1 = Math.max(...pieces.map((p) => p.x1)); v.bz1 = Math.max(...pieces.map((p) => p.z1));
  }

  // Write the parts of village v that overlap chunk (X0, Z0). Returns extra
  // records (spawns, chests) for things inside this chunk.
  write(v, ctx, X0, Z0, out) {
    const inChunk = (x, z) => x >= X0 && x < X0 + 16 && z >= Z0 && z < Z0 + 16;
    for (const p of v.pieces) {
      if (p.x1 < X0 - 1 || p.x0 > X0 + 16 || p.z1 < Z0 - 1 || p.z0 > Z0 + 16) continue;
      switch (p.kind) {
        case 'road': this.road(v, p, ctx, inChunk); break;
        case 'well': this.well(v, p, ctx); break;
        case 'lamp': this.lamp(v, p, ctx); break;
        default: this.building(v, p, ctx, inChunk, out);
      }
    }
  }

  surface(ctx, x, z, guess) {
    for (let y = Math.min(250, guess + 8); y > guess - 12 && y > 1; y--) {
      const id = ctx.get(x, y, z);
      if (id > 0 && id !== B.tall_grass && id !== B.fern && id !== B.dandelion && id !== B.poppy && id !== B.cornflower &&
        id !== B.oak_leaves && id !== B.birch_leaves && id !== B.spruce_leaves && id !== B.oak_log && id !== B.birch_log && id !== B.spruce_log &&
        id !== B.snow_block && id !== B.pumpkin && id !== B.sugar_cane && id !== B.dead_bush && id !== B.cactus) return y;
    }
    return guess;
  }

  road(v, p, ctx, inChunk) {
    const g = this.gen;
    for (const [x, z] of p.cells) {
      if (!inChunk(x, z)) continue;
      const y = this.surface(ctx, x, z, g.heightAt(x, z));
      const top = ctx.get(x, y, z);
      if (top === B.water || top === B.ice || y < SEA_LEVEL) {
        ctx.set(x, SEA_LEVEL, z, v.style.planks, 0); // little bridge
        for (let k = 1; k < 4; k++) ctx.set(x, SEA_LEVEL + k, z, 0, 0);
        continue;
      }
      ctx.set(x, y, z, v.style.path, 0);
      for (let k = 1; k < 4; k++) ctx.set(x, y + k, z, 0, 0);
    }
  }

  well(v, p, ctx) {
    const y = p.y;
    for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) {
      const x = p.x0 + dx, z = p.z0 + dz;
      const edge = dx === 0 || dz === 0 || dx === 3 || dz === 3;
      for (let k = -4; k <= 0; k++) ctx.set(x, y + k, z, edge || k === -4 ? B.cobblestone : B.water, 0);
      ctx.set(x, y + 1, z, edge ? B.cobblestone : 0, 0);
      for (let k = 2; k <= 3; k++) ctx.set(x, y + k, z, (dx === 0 || dx === 3) && (dz === 0 || dz === 3) ? B.oak_fence : 0, 0);
      ctx.set(x, y + 4, z, B.cobblestone_slab, 0);
      for (let k = 5; k <= 6; k++) ctx.set(x, y + k, z, 0, 0);
    }
  }

  lamp(v, p, ctx) {
    const y = this.surface(ctx, p.x0, p.z0, this.gen.heightAt(p.x0, p.z0));
    if (ctx.get(p.x0, y, p.z0) === B.water || y < 0) return;
    ctx.set(p.x0, y + 1, p.z0, B.oak_fence, 0);
    ctx.set(p.x0, y + 2, p.z0, B.oak_fence, 0);
    ctx.set(p.x0, y + 3, p.z0, B.lamp, 0);
  }

  building(v, p, ctx, inChunk, out) {
    const S = v.style;
    const { w, d, f, y } = p;
    const r = rng(p.seed);
    const at = (lx, lz) => {
      switch (f) {
        case 0: return [p.x0 + lx, p.z0 + lz];
        case 2: return [p.x0 + (w - 1 - lx), p.z0 + (d - 1 - lz)];
        case 1: return [p.x0 + (d - 1 - lz), p.z0 + lx];
        default: return [p.x0 + lz, p.z0 + (w - 1 - lx)];
      }
    };
    const put = (lx, ly, lz, id, meta = 0) => { const [x, z] = at(lx, lz); ctx.set(x, y + ly, z, id, meta); };
    const get = (lx, ly, lz) => { const [x, z] = at(lx, lz); return ctx.get(x, y + ly, z); };
    const wf = (lf) => (lf + f) % 4;               // local facing -> world facing
    const face = (lf) => DIR_FACE[wf(lf)];           // for chests/furnaces
    const torchMeta = (lf) => { const [dx, dz] = DIRS[wf(lf)]; return dx < 0 ? 1 : dx > 0 ? 2 : dz < 0 ? 3 : 4; };
    const H = p.kind === 'farm' || p.kind === 'pen' ? 4 : 8;
    // clear space and lay a foundation
    for (let lx = -1; lx <= w; lx++) for (let lz = -1; lz <= d; lz++) {
      const [x, z] = at(lx, lz);
      if (!inChunk(x, z)) continue;
      const border = lx < 0 || lz < 0 || lx >= w || lz >= d;
      for (let ly = 1; ly <= H; ly++) if (!border || ly > 1) ctx.set(x, y + ly, z, 0, 0);
      if (!border) {
        for (let ly = 0; ly >= -8; ly--) {
          const id = ctx.get(x, y + ly, z);
          if (ly < 0 && id > 0 && id !== B.water && id !== B.tall_grass) break;
          ctx.set(x, y + ly, z, ly === 0 ? (p.kind === 'farm' || p.kind === 'pen' ? B.dirt : S.found) : S.found, 0);
        }
      }
    }
    const mid = w >> 1;
    if (p.kind === 'house' || p.kind === 'bighouse') {
      for (let lx = 0; lx < w; lx++) for (let lz = 0; lz < d; lz++) {
        const edge = lx === 0 || lz === 0 || lx === w - 1 || lz === d - 1;
        const corner = (lx === 0 || lx === w - 1) && (lz === 0 || lz === d - 1);
        put(lx, 0, lz, edge ? S.found : S.floor);
        for (let ly = 1; ly <= 3; ly++) {
          if (!edge) continue;
          let id = corner ? S.log : S.planks;
          if (ly === 2 && !corner && ((lz === 0 || lz === d - 1) ? lx % 2 === 0 : lz % 2 === 0)) id = B.glass;
          put(lx, ly, lz, id);
        }
      }
      // door in the front wall
      put(mid, 1, 0, B.oak_door, wf(2) & 3);
      put(mid, 2, 0, B.oak_door, (wf(2) & 3) | DOOR_UPPER);
      // roof: stairs around the edge rising to a ridge
      for (let lx = -1; lx <= w; lx++) for (let lz = -1; lz <= d; lz++) {
        const ring = lx === -1 || lz === -1 || lx === w || lz === d;
        if (ring) {
          const lf = lz === -1 ? 2 : lz === d ? 0 : lx === -1 ? 1 : 3;
          put(lx, 4, lz, S.stairs, wf(lf));
        } else put(lx, 4, lz, S.planks);
      }
      for (let lx = 1; lx < w - 1; lx++) for (let lz = 1; lz < d - 1; lz++) put(lx, 5, lz, S.slab, 0);
      // furniture
      put(1, 1, d - 3, B.bed, wf(0) | BED_HEAD); put(1, 1, d - 2, B.bed, wf(0));
      put(w - 2, 1, d - 2, B.crafting_table, 0);
      put(mid, 3, d - 2, B.torch, torchMeta(2));
      out.spawns.push(this.settler(at, mid, 1, 2, y, p.kind === 'bighouse' ? 'scholar' : r() < 0.5 ? 'farmer' : 'shepherd'));
      if (p.kind === 'bighouse') {
        put(w - 2, 1, 1, B.bookshelf); put(w - 2, 2, 1, B.bookshelf);
        put(3, 1, d - 2, B.bed, wf(0)); put(3, 1, d - 3, B.bed, wf(0) | BED_HEAD);
        put(1, 1, 1, B.oak_fence); put(1, 2, 1, B.oak_slab, 0);
        out.spawns.push(this.settler(at, 2, 1, 3, y, r() < 0.5 ? 'farmer' : 'shepherd'));
      }
      if (r() < 0.5) {
        put(w - 2, 1, mid, B.chest, face(3));
        const [cx, cz] = at(w - 2, mid);
        out.chests.push({ x: cx, y: y + 1, z: cz, loot: 'village_house' });
      }
    } else if (p.kind === 'smithy') {
      for (let lx = 0; lx < w; lx++) for (let lz = 0; lz < d; lz++) {
        const edge = lx === 0 || lz === 0 || lx === w - 1 || lz === d - 1;
        put(lx, 0, lz, B.cobblestone);
        if (edge && lz > 1) for (let ly = 1; ly <= 3; ly++) put(lx, ly, lz, (lx === 0 || lx === w - 1) && (lz === d - 1 || lz === 2) ? S.log : B.cobblestone);
        if (edge && lz <= 1 && (lx === 0 || lx === w - 1)) for (let ly = 1; ly <= 3; ly++) put(lx, ly, lz, B.oak_fence);
        put(lx, 4, lz, B.cobblestone_slab, 0);
      }
      put(2, 1, d - 2, B.furnace, face(0)); put(3, 1, d - 2, B.furnace, face(0));
      put(w - 2, 1, d - 2, B.chest, face(0));
      const [cx, cz] = at(w - 2, d - 2);
      out.chests.push({ x: cx, y: y + 1, z: cz, loot: 'village_smith' });
      put(1, 1, 3, B.crafting_table);
      put(mid, 3, d - 2, B.torch, torchMeta(2));
      out.spawns.push(this.settler(at, mid, 1, 3, y, 'smith'));
    } else if (p.kind === 'farm') {
      const crops = [B.wheat, r() < 0.5 ? B.carrots : B.potatoes, B.wheat, r() < 0.5 ? B.potatoes : B.wheat];
      for (let lx = 0; lx < w; lx++) for (let lz = 0; lz < d; lz++) {
        const edge = lx === 0 || lz === 0 || lx === w - 1 || lz === d - 1;
        if (edge) { put(lx, 0, lz, S.log === B.sandstone ? B.sandstone : S.log, 0); continue; }
        if (lx === mid) { put(lx, 0, lz, B.water); continue; }
        put(lx, 0, lz, B.farmland, 7);
        const crop = crops[Math.min(3, Math.floor((lx < mid ? lx - 1 : lx - 2) / 2))];
        put(lx, 1, lz, crop, 1 + Math.floor(r() * 7));
      }
      if (r() < 0.6) out.spawns.push(this.settler(at, mid, 1, 0, y, 'farmer'));
    } else if (p.kind === 'pen') {
      for (let lx = 0; lx < w; lx++) for (let lz = 0; lz < d; lz++) {
        const edge = lx === 0 || lz === 0 || lx === w - 1 || lz === d - 1;
        put(lx, 0, lz, B.grass);
        if (edge) put(lx, 1, lz, lx === mid && lz === 0 ? B.oak_fence_gate : B.oak_fence, lx === mid && lz === 0 ? wf(0) : 0);
      }
      const kind = ['cow', 'sheep', 'pig'][Math.floor(r() * 3)];
      for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
        const [sx, sz] = at(1 + Math.floor(r() * (w - 2)), 1 + Math.floor(r() * (d - 2)));
        out.spawns.push({ type: kind, x: sx + 0.5, y: y + 1, z: sz + 0.5 });
      }
    }
  }

  settler(at, lx, ly, lz, y, profession) {
    const [x, z] = at(lx, lz);
    return { type: 'settler', profession, x: x + 0.5, y: y + ly, z: z + 0.5 };
  }
}

// ---------------------------------------------------------------------------
// Dungeon: a mossy stone room with a creature spawner and loot chests, cut
// into solid rock entirely inside one chunk.
export function placeDungeon(seed, cx, cz, blocks, meta, surfaceMin, out) {
  const r = rng(hash2(seed ^ 0xd06e, cx, cz));
  if (r() > 0.11) return;
  const idx = (x, y, z) => x | (z << 4) | (y << 8);
  const ox = 1 + Math.floor(r() * 8), oz = 1 + Math.floor(r() * 8);
  const top = Math.min(55, surfaceMin - 12);
  if (top < 14) return;
  const oy = 10 + Math.floor(r() * (top - 10));
  let solid = 0, total = 0;
  for (let dx = 0; dx < 7; dx++) for (let dy = 0; dy < 6; dy++) for (let dz = 0; dz < 7; dz++) {
    total++;
    const id = blocks[idx(ox + dx, oy + dy, oz + dz)];
    if (id !== 0 && id !== B.water && id !== B.lava) solid++;
  }
  if (solid / total < 0.72) return;
  for (let dx = 0; dx < 7; dx++) for (let dy = 0; dy < 6; dy++) for (let dz = 0; dz < 7; dz++) {
    const i = idx(ox + dx, oy + dy, oz + dz);
    const edge = dx === 0 || dz === 0 || dx === 6 || dz === 6 || dy === 0 || dy === 5;
    if (edge) {
      // leave existing openings into caves so the room can be found
      if (blocks[i] === 0 && dy > 0 && dy < 5) continue;
      blocks[i] = dy === 0 ? (r() < 0.6 ? B.mossy_cobblestone : B.cobblestone) : (r() < 0.3 ? B.mossy_cobblestone : B.cobblestone);
    } else blocks[i] = 0;
    meta[i] = 0;
  }
  const sx = ox + 3, sy = oy + 1, sz = oz + 3;
  blocks[idx(sx, sy, sz)] = B.spawner;
  const mob = ['ghoul', 'ghoul', 'archer', 'crawler'][Math.floor(r() * 4)];
  out.spawners.push({ x: cx * 16 + sx, y: sy, z: cz * 16 + sz, mob });
  const chestSpots = [[ox + 1, oz + 3, 3], [ox + 5, oz + 3, 2], [ox + 3, oz + 1, 4], [ox + 3, oz + 5, 5]];
  const n = 1 + (r() < 0.5 ? 1 : 0);
  for (let k = 0; k < n; k++) {
    const [x, z, faceMeta] = chestSpots[Math.floor(r() * chestSpots.length)];
    blocks[idx(x, sy, z)] = B.chest; meta[idx(x, sy, z)] = faceMeta;
    out.chests.push({ x: cx * 16 + x, y: sy, z: cz * 16 + z, loot: 'dungeon' });
  }
}

// ---------------------------------------------------------------------------
// Observatories: buried stone-brick halls holding the star gate (twelve
// frames around a lava pit), with corridors to a library and storerooms.
const OBS_CELL = 768;

export class Observatories {
  constructor(gen) { this.gen = gen; this.cache = new Map(); }

  inCell(cx, cz) {
    const key = cx * 100003 + cz;
    if (this.cache.has(key)) return this.cache.get(key);
    const g = this.gen;
    const r = rng(hash2(g.seed ^ 0x0b5e, cx, cz));
    let o = null;
    if (r() < 0.8) {
      const x = cx * OBS_CELL + 120 + Math.floor(r() * (OBS_CELL - 240));
      const z = cz * OBS_CELL + 120 + Math.floor(r() * (OBS_CELL - 240));
      const y = 18 + Math.floor(r() * 14);
      o = { x, y, z, pieces: [], chests: [], frames: [], spawner: null };
      this.layout(o, r);
    }
    this.cache.set(key, o);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return o;
  }

  locate(x, z, cells = 3) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    let best = null, bd = Infinity;
    for (let dz = -cells; dz <= cells; dz++) for (let dx = -cells; dx <= cells; dx++) {
      const o = this.inCell(cx + dx, cz + dz);
      if (o) { const d = Math.hypot(o.x - x, o.z - z); if (d < bd) { bd = d; best = o; } }
    }
    return best;
  }

  near(x0, z0, x1, z1) {
    const out = [];
    for (let cz = Math.floor((z0 - 80) / OBS_CELL); cz <= Math.floor((z1 + 80) / OBS_CELL); cz++)
      for (let cx = Math.floor((x0 - 80) / OBS_CELL); cx <= Math.floor((x1 + 80) / OBS_CELL); cx++) {
        const o = this.inCell(cx, cz);
        if (o && o.bx1 >= x0 && o.bx0 <= x1 && o.bz1 >= z0 && o.bz0 <= z1) out.push(o);
      }
    return out;
  }

  layout(o, r) {
    const { x, y, z } = o;
    const room = (x0, y0, z0, x1, y1, z1, kind = 'room') => o.pieces.push({ kind, b: [x0, y0, z0, x1, y1, z1] });
    // the gate hall
    room(x - 7, y, z - 7, x + 7, y + 9, z + 7, 'hall');
    // corridors in four directions, each ending in a room
    const ends = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const len = 14 + Math.floor(r() * 16);
      const sx = x + dx * 7, sz = z + dz * 7;
      const ex = x + dx * (7 + len), ez = z + dz * (7 + len);
      const ax0 = Math.min(sx, ex) - (dz ? 2 : 0), ax1 = Math.max(sx, ex) + (dz ? 2 : 0);
      const az0 = Math.min(sz, ez) - (dx ? 2 : 0), az1 = Math.max(sz, ez) + (dx ? 2 : 0);
      room(ax0, y, az0, ax1, y + 5, az1, 'corridor');
      ends.push([ex, ez, dx, dz]);
    }
    const kinds = ['library', 'store', 'store', 'cell'].sort(() => r() - 0.5);
    ends.forEach(([ex, ez, dx, dz], i) => {
      const cx = ex + dx * 5, cz = ez + dz * 5;
      const kind = kinds[i];
      const s = kind === 'library' ? 6 : 4;
      room(cx - s, y, cz - s, cx + s, y + (kind === 'library' ? 8 : 6), cz + s, kind);
      // doorway from the corridor
      o.pieces.push({ kind: 'door', b: [ex - (dz ? 1 : 0), y + 1, ez - (dx ? 1 : 0), ex + dx * 2 + (dz ? 1 : 0), y + 3, ez + dz * 2 + (dx ? 1 : 0)] });
      if (kind === 'library' || kind === 'store') o.chests.push({ x: cx + (kind === 'library' ? 3 : 0), y: y + 1, z: cz, loot: kind === 'library' ? 'observatory_library' : 'observatory' });
    });
    // hall doorways
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      o.pieces.push({ kind: 'door', b: [x + dx * 7 - (dz ? 1 : 0), y + 1, z + dz * 7 - (dx ? 1 : 0), x + dx * 7 + (dz ? 1 : 0), y + 3, z + dz * 7 + (dx ? 1 : 0)] });
    }
    // star gate: twelve frames around a 3x3 pit, each facing the middle
    for (let i = -1; i <= 1; i++) {
      o.frames.push([x + i, z - 2, 2], [x + i, z + 2, 0], [x - 2, z + i, 1], [x + 2, z + i, 3]);
    }
    o.frames = o.frames.map(([fx, fz, f]) => [fx, fz, f, r() < 0.1]);
    o.spawner = [x - 5, y + 1, z + 5];
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const p of o.pieces) { bx0 = Math.min(bx0, p.b[0]); bz0 = Math.min(bz0, p.b[2]); bx1 = Math.max(bx1, p.b[3]); bz1 = Math.max(bz1, p.b[5]); }
    Object.assign(o, { bx0, bz0, bx1, bz1 });
  }

  // Write the parts of observatory o that fall in this chunk.
  write(o, ctx, X0, Z0, out) {
    const r = rng(hash2(this.gen.seed ^ 0x0b5f, X0, Z0));
    const brick = () => { const v = r(); return v < 0.12 ? B.mossy_cobblestone : v < 0.2 ? B.cobblestone : B.stone_bricks; };
    const inChunk = (x, z) => x >= X0 && x < X0 + 16 && z >= Z0 && z < Z0 + 16;
    const shell = (b, hollow = true) => {
      const [x0, y0, z0, x1, y1, z1] = b;
      for (let x = Math.max(x0, X0); x <= Math.min(x1, X0 + 15); x++) for (let z = Math.max(z0, Z0); z <= Math.min(z1, Z0 + 15); z++) {
        for (let y = y0; y <= y1; y++) {
          const edge = x === x0 || x === x1 || z === z0 || z === z1 || y === y0 || y === y1;
          if (edge) { if (ctx.get(x, y, z) !== 0 || !hollow) ctx.set(x, y, z, brick(), 0); else ctx.set(x, y, z, brick(), 0); }
          else if (hollow) ctx.set(x, y, z, 0, 0);
        }
      }
    };
    // shells first, then carve the insides so rooms open into each other
    for (const p of o.pieces) if (p.kind !== 'door') shell(p.b, false);
    for (const p of o.pieces) {
      const [x0, y0, z0, x1, y1, z1] = p.b;
      const cut = p.kind === 'door' ? [x0, y0, z0, x1, y1, z1] : [x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1];
      for (let x = Math.max(cut[0], X0); x <= Math.min(cut[3], X0 + 15); x++) for (let z = Math.max(cut[2], Z0); z <= Math.min(cut[5], Z0 + 15); z++)
        for (let y = cut[1]; y <= cut[4]; y++) ctx.set(x, y, z, 0, 0);
    }
    // furnishings
    for (const p of o.pieces) {
      const [x0, y0, z0, x1, y1, z1] = p.b;
      if (p.kind === 'library') {
        for (let x = x0 + 1; x <= x1 - 1; x++) for (let z = z0 + 1; z <= z1 - 1; z++) {
          if (!inChunk(x, z)) continue;
          const wall = x === x0 + 1 || x === x1 - 1 || z === z0 + 1 || z === z1 - 1;
          if (wall && (x + z) % 5 !== 0) for (let y = y0 + 1; y <= y0 + 4; y++) ctx.set(x, y, z, B.bookshelf, 0);
          if (!wall && (x - x0) % 4 === 2 && (z - z0) % 3 !== 0) for (let y = y0 + 1; y <= y0 + 3; y++) ctx.set(x, y, z, B.bookshelf, 0);
        }
        const cx = (x0 + x1) >> 1, cz = (z0 + z1) >> 1;
        if (inChunk(cx, cz)) ctx.set(cx, y1 - 1, cz, B.lantern, 1);
      } else if (p.kind === 'cell') {
        for (let x = x0 + 1; x <= x1 - 1; x++) for (let z = z0 + 1; z <= z1 - 1; z++) if (inChunk(x, z) && r() < 0.25) ctx.set(x, y0 + 1 + Math.floor(r() * 3), z, B.cobweb, 0);
      } else if (p.kind === 'corridor') {
        // a lantern every so often
        const cx = (x0 + x1) >> 1, cz = (z0 + z1) >> 1;
        if (inChunk(cx, cz)) ctx.set(cx, y1 - 1, cz, B.lantern, 1);
      }
    }
    const { x, y, z } = o;
    // the gate dais: a raised platform, a lava pit and the frames
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const wx = x + dx, wz = z + dz;
      if (!inChunk(wx, wz)) continue;
      ctx.set(wx, y + 1, wz, B.stone_bricks, 0);
      ctx.set(wx, y + 2, wz, B.stone_bricks, 0);
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) { ctx.set(wx, y + 1, wz, B.lava, 0); ctx.set(wx, y + 2, wz, B.lava, 0); }
    }
    for (const [fx, fz, f, eye] of o.frames) if (inChunk(fx, fz)) ctx.set(fx, y + 3, fz, B.star_frame, f | (eye ? 4 : 0));
    // steps up to the dais
    for (let i = 0; i < 3; i++) { const wx = x + i - 1, wz = z + 4; if (inChunk(wx, wz)) { ctx.set(wx, y + 1, wz, B.stone_brick_stairs, 0); ctx.set(wx, y + 2, wz, 0, 0); } }
    for (let i = 0; i < 3; i++) { const wx = x + i - 1, wz = z + 3; if (inChunk(wx, wz)) ctx.set(wx, y + 2, wz, B.stone_brick_stairs, 0); }
    // lanterns on the hall pillars
    for (const [dx, dz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
      const wx = x + dx, wz = z + dz;
      if (!inChunk(wx, wz)) continue;
      for (let yy = y + 1; yy < y + 9; yy++) ctx.set(wx, yy, wz, B.stone_bricks, 0);
      ctx.set(wx + Math.sign(-dx), y + 6, wz, B.lantern, 0);
    }
    const [sx, sy, sz] = o.spawner;
    if (inChunk(sx, sz)) { ctx.set(sx, sy, sz, B.spawner, 0); out.spawners.push({ x: sx, y: sy, z: sz, mob: 'crawler' }); }
    for (const c of o.chests) if (inChunk(c.x, c.z)) { ctx.set(c.x, c.y, c.z, B.chest, 4); out.chests.push(c); }
  }
}
