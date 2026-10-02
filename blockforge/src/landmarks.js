// Landmarks: mineshafts under the hills, sun temples in the desert, jungle
// shrines, swamp huts, tide citadels on the deep sea floor and woodland
// manors in the dark forests. Each lives in a grid cell; its layout is
// decided once from the world seed so every chunk it crosses agrees, and
// builders write only what falls inside the chunk being generated.
import { B } from './blocks.js';
import { rng, hash2, rand3 } from './noise.js';

const SEA = 63;

// Stair facing that rises away from the outside direction d (0 N, 1 E, 2 S, 3 W).
const rise = (d) => (d + 2) & 3;

export const LANDMARKS = {
  mineshaft: { cell: 288, chance: 0.55, name: 'Mineshaft' },
  sun_temple: { cell: 352, chance: 0.6, biomes: ['DESERT'], name: 'Sun Temple' },
  jungle_shrine: { cell: 352, chance: 0.65, biomes: ['JUNGLE'], name: 'Jungle Shrine' },
  swamp_hut: { cell: 256, chance: 0.6, biomes: ['SWAMP'], name: 'Swamp Hut' },
  tide_citadel: { cell: 448, chance: 0.75, biomes: ['DEEP_OCEAN'], name: 'Tide Citadel' },
  manor: { cell: 512, chance: 0.75, biomes: ['DARK_FOREST'], name: 'Woodland Manor' },
  outpost: { cell: 416, chance: 0.6, biomes: ['PLAINS', 'SAVANNA', 'TAIGA', 'DESERT', 'MEADOW', 'SNOWY_PLAINS'], name: 'Raider Outpost' },
  igloo: { cell: 320, chance: 0.55, biomes: ['SNOWY_PLAINS', 'SNOWY_TAIGA'], name: 'Igloo' },
  shipwreck: { cell: 336, chance: 0.6, biomes: ['OCEAN', 'DEEP_OCEAN', 'BEACH'], name: 'Shipwreck' },
  ancient_city: { cell: 448, chance: 0.6, name: 'Ancient City' },
};
const SALT = { mineshaft: 0x51ab, sun_temple: 0x7e30, jungle_shrine: 0x5a71, swamp_hut: 0x4a7, tide_citadel: 0x71de, manor: 0x3a40, outpost: 0x0b05, igloo: 0x1910, shipwreck: 0x5b1b, ancient_city: 0xdeed };

export class Landmarks {
  constructor(gen, BIOME) { this.gen = gen; this.BIOME = BIOME; this.cache = new Map(); }

  // The landmark of `kind` in grid cell (cx, cz), or null.
  inCell(kind, cx, cz) {
    const key = `${kind}:${cx}:${cz}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const def = LANDMARKS[kind], g = this.gen;
    const r = rng(hash2(g.seed ^ SALT[kind], cx, cz));
    let s = null;
    if (r() < def.chance) {
      // a few tries to land in the right biome
      const m = 48;
      for (let attempt = 0; attempt < (def.biomes ? 10 : 1) && !s; attempt++) {
        const x = cx * def.cell + m + Math.floor(r() * (def.cell - m * 2));
        const z = cz * def.cell + m + Math.floor(r() * (def.cell - m * 2));
        const bio = g.biomeAt(x, z);
        const ok = def.biomes ? def.biomes.some((b) => this.BIOME[b] === bio)
          : ![this.BIOME.OCEAN, this.BIOME.DEEP_OCEAN, this.BIOME.FROZEN_OCEAN, this.BIOME.RIVER, this.BIOME.FROZEN_RIVER].includes(bio);
        if (ok && !(g.villages && g.villages.covers && g.villages.covers(x, z))) {
          s = { kind, x, z, seed: hash2(g.seed ^ SALT[kind] ^ 0x99, cx, cz) };
          LAYOUT[kind](s, rng(s.seed), g);
        }
      }
    }
    this.cache.set(key, s);
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
    return s;
  }

  // Landmarks whose bounds overlap the box.
  near(x0, z0, x1, z1) {
    const out = [];
    for (const kind of Object.keys(LANDMARKS)) {
      const cell = LANDMARKS[kind].cell, pad = 80;
      for (let cz = Math.floor((z0 - pad) / cell); cz <= Math.floor((z1 + pad) / cell); cz++)
        for (let cx = Math.floor((x0 - pad) / cell); cx <= Math.floor((x1 + pad) / cell); cx++) {
          const s = this.inCell(kind, cx, cz);
          if (s && s.bx1 >= x0 && s.bx0 <= x1 && s.bz1 >= z0 && s.bz0 <= z1) out.push(s);
        }
    }
    return out;
  }

  // The nearest landmark of a kind (searching `cells` grid cells around).
  locate(kind, x, z, cells = 3) {
    const cell = LANDMARKS[kind].cell;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    let best = null, bd = Infinity;
    for (let dz = -cells; dz <= cells; dz++) for (let dx = -cells; dx <= cells; dx++) {
      const s = this.inCell(kind, cx + dx, cz + dz);
      if (s) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
    }
    return best;
  }

  write(s, ctx, X0, Z0, out) {
    const inChunk = (x, z) => x >= X0 && x < X0 + 16 && z >= Z0 && z < Z0 + 16;
    const w = {
      ...ctx,
      inChunk,
      // a solid box (hollow: only the shell)
      box(x0, y0, z0, x1, y1, z1, id, meta = 0, hollow = false) {
        for (let x = Math.max(x0, X0); x <= Math.min(x1, X0 + 15); x++) for (let z = Math.max(z0, Z0); z <= Math.min(z1, Z0 + 15); z++)
          for (let y = y0; y <= y1; y++) {
            if (hollow && x > x0 && x < x1 && z > z0 && z < z1 && y > y0 && y < y1) continue;
            ctx.set(x, y, z, typeof id === 'function' ? id(x, y, z) : id, meta);
          }
      },
      chest(x, y, z, loot, meta = 2) { if (inChunk(x, z)) { ctx.set(x, y, z, B.chest, meta); out.chests.push({ x, y, z, loot }); } },
      spawn(type, x, y, z, extra = {}) { out.spawns.push({ type, x: x + 0.5, y, z: z + 0.5, persistent: true, ...extra }); },
      banner(x, y, z, base, bn, meta = 0) { if (inChunk(x, z)) { ctx.set(x, y, z, B.banner, meta); out.chests.push({ x, y, z, banner: { base, bn } }); } },
      spawner(x, y, z, mob) { if (inChunk(x, z)) { ctx.set(x, y, z, B.spawner, 0); out.spawners.push({ x, y, z, mob }); } },
      // sculk sensors and shriekers need to be listening from the start
      sculk(x, y, z, id) { if (inChunk(x, z)) { ctx.set(x, y, z, id, 0); out.chests.push({ x, y, z, sculk: 1 }); } },
      // the ground height of a column (from the noise, so all chunks agree)
      ground: (x, z) => this.gen.heightAt(x, z),
      rnd: (x, y, z, salt = 0) => rand3(s.seed ^ salt, x, y, z),
    };
    BUILD[s.kind](s, w);
  }
}

// ---------------------------------------------------------------------------
// Layouts: decide the shape and set the bounds (bx0..bx1, bz0..bz1).
const LAYOUT = {
  mineshaft(s, r) {
    s.y = 22 + Math.floor(r() * 16);
    const segs = [];
    const room = [s.x - 4, s.z - 4, s.x + 4, s.z + 4];
    const open = [[s.x, s.z, 0], [s.x, s.z, 1], [s.x, s.z, 2], [s.x, s.z, 3]];
    const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    while (open.length && segs.length < 22) {
      const [x, z, d] = open.splice(Math.floor(r() * open.length), 1)[0];
      const len = 10 + Math.floor(r() * 18);
      const sx = x + D[d][0] * 5, sz = z + D[d][1] * 5;
      const ex = sx + D[d][0] * len, ez = sz + D[d][1] * len;
      if (Math.abs(ex - s.x) > 70 || Math.abs(ez - s.z) > 70) continue;
      segs.push({ x0: Math.min(sx, ex), z0: Math.min(sz, ez), x1: Math.max(sx, ex), z1: Math.max(sz, ez), axis: d & 1, dy: 0 });
      // branches: straight on, left, right
      if (r() < 0.75) open.push([ex - D[d][0] * 5 + D[d][0] * 5, ez - D[d][1] * 5 + D[d][1] * 5, d]);
      if (r() < 0.5) open.push([sx + D[d][0] * Math.floor(len / 2) - D[(d + 1) & 3][0] * 4, sz + D[d][1] * Math.floor(len / 2) - D[(d + 1) & 3][1] * 4, (d + 1) & 3]);
      if (r() < 0.5) open.push([sx + D[d][0] * Math.floor(len / 2) - D[(d + 3) & 3][0] * 4, sz + D[d][1] * Math.floor(len / 2) - D[(d + 3) & 3][1] * 4, (d + 3) & 3]);
    }
    s.segs = segs; s.room = room;
    s.spawnerSeg = segs.length > 3 && r() < 0.6 ? 1 + Math.floor(r() * (segs.length - 1)) : -1;
    bounds(s, [room, ...segs.map((g) => [g.x0 - 1, g.z0 - 1, g.x1 + 1, g.z1 + 1])]);
  },
  sun_temple(s, r, g) { s.y = g.heightAt(s.x, s.z); s.face = Math.floor(r() * 4); bounds(s, [[s.x - 12, s.z - 12, s.x + 12, s.z + 12]]); },
  jungle_shrine(s, r, g) { s.y = g.heightAt(s.x, s.z); bounds(s, [[s.x - 8, s.z - 9, s.x + 8, s.z + 9]]); },
  swamp_hut(s, r, g) { s.y = Math.max(SEA + 2, g.heightAt(s.x, s.z) + 2); bounds(s, [[s.x - 5, s.z - 6, s.x + 5, s.z + 6]]); },
  tide_citadel(s, r, g) { s.y = g.heightAt(s.x, s.z) + 1; bounds(s, [[s.x - 19, s.z - 19, s.x + 19, s.z + 19]]); },
  manor(s, r, g) { s.y = g.heightAt(s.x, s.z) + 1; bounds(s, [[s.x - 17, s.z - 13, s.x + 17, s.z + 13]]); },
  outpost(s, r, g) { s.y = g.heightAt(s.x, s.z) + 1; s.cage = Math.floor(r() * 4); bounds(s, [[s.x - 14, s.z - 14, s.x + 14, s.z + 14]]); },
  ancient_city(s, r) { s.y = 14 + Math.floor(r() * 6); s.face = Math.floor(r() * 2); bounds(s, [[s.x - 30, s.z - 30, s.x + 30, s.z + 30]]); },
  igloo(s, r, g) { s.y = g.heightAt(s.x, s.z) + 1; s.face = Math.floor(r() * 4); s.basement = r() < 0.5; bounds(s, [[s.x - 7, s.z - 7, s.x + 7, s.z + 7]]); },
  shipwreck(s, r, g) {
    s.y = Math.min(SEA - 2, g.heightAt(s.x, s.z) + 1); s.axis = Math.floor(r() * 2); s.broken = Math.floor(r() * 3); s.mast = 4 + Math.floor(r() * 6);
    bounds(s, [[s.x - 13, s.z - 13, s.x + 13, s.z + 13]]);
  },
};
function bounds(s, rects) {
  s.bx0 = Math.min(...rects.map((q) => q[0])); s.bz0 = Math.min(...rects.map((q) => q[1]));
  s.bx1 = Math.max(...rects.map((q) => q[2])); s.bz1 = Math.max(...rects.map((q) => q[3]));
}

// ---------------------------------------------------------------------------
// Builders
const BUILD = {
  // Deep under the hills: a vast dark cavern floored in gloomstone and
  // sculk, a plaza before a great arch, pillars lit by wisp lanterns and the
  // broken rooms of whoever lived here. Sensors listen; shriekers wait.
  ancient_city(s, w) {
    const { x, z } = s, y = s.y, R = 27;
    const deep = B.deep_stone, brick = B.deep_bricks, tile = B.deep_tiles;
    const roll = (cx, cy, cz, salt) => w.rnd(cx, cy, cz, salt);
    // the cavern: a low dome, its floor and walls turned to gloomstone
    for (let dx = -R - 2; dx <= R + 2; dx++) for (let dz = -R - 2; dz <= R + 2; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz)) continue;
      const d = Math.hypot(dx, dz * 1.1) / R;
      if (d > 1.08) continue;
      const roof = d < 1 ? Math.floor(5 + 13 * Math.sqrt(1 - d * d)) : 0;
      for (let yy = y - 4; yy <= y + roof + 2; yy++) {
        const cur = w.get(cx, yy, cz);
        if (cur === B.bedrock) continue;
        if (yy < y) w.set(cx, yy, cz, yy === y - 1 && roll(cx, yy, cz, 1) < 0.55 + 0.4 * (1 - d) ? B.sculk : deep, 0);
        else if (yy <= y + roof && d < 1) w.set(cx, yy, cz, 0, 0);
        else if (cur && cur !== B.water && cur !== B.lava) w.set(cx, yy, cz, deep, 0);
      }
    }
    // the plaza and the paths of tiles that cross it
    w.box(x - 10, y - 1, z - 10, x + 10, y - 1, z + 10, (cx, cy, cz) => ((Math.abs(cx - x) + Math.abs(cz - z)) % 4 === 0 ? tile : brick));
    w.box(x - R, y - 1, z - 1, x + R, y - 1, z + 1, tile);
    w.box(x - 1, y - 1, z - R, x + 1, y - 1, z + R, tile);
    // the great arch at the plaza's far side (across x or across z)
    const along = s.face === 1;
    for (let k = -7; k <= 7; k++) for (let dy = 0; dy <= 11; dy++) {
      const leg = Math.abs(k) >= 5, top = dy >= 9 && Math.abs(k) <= 7 - (dy - 9);
      if (!leg && !top) continue;
      const bx = along ? x + k : x - 8, bz = along ? z - 8 : z + k;
      for (let t = 0; t <= 1; t++) {
        const px = along ? bx : bx - t, pz = along ? bz - t : bz;
        if (w.inChunk(px, pz)) w.set(px, y + dy, pz, dy === 11 || (leg && dy === 0) ? tile : brick, 0);
      }
    }
    // pillars around the plaza, crowned with wisp lanterns
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, px = x + Math.round(Math.cos(a) * 15), pz = z + Math.round(Math.sin(a) * 15);
      const hgt = 4 + Math.floor(roll(px, y, pz, 2) * 4);
      if (!w.inChunk(px, pz)) continue;
      for (let dy = 0; dy < hgt; dy++) w.set(px, y + dy, pz, roll(px, y + dy, pz, 3) < 0.12 ? deep : brick, 0);
      w.set(px, y + hgt, pz, B.wisp_lantern, 0);
    }
    // lanterns on short posts along the paths
    for (let k = -24; k <= 24; k += 8) for (const [px, pz] of [[x + k, z + 2], [x + 2, z + k]]) {
      if (!w.inChunk(px, pz) || Math.abs(k) < 11) continue;
      w.set(px, y, pz, brick, 0); w.set(px, y + 1, pz, B.wisp_lantern, 0);
    }
    // four broken rooms, each with a chest
    const rooms = [[x - 18, z - 18], [x + 18, z - 18], [x - 18, z + 18], [x + 18, z + 18]];
    rooms.forEach(([rx, rz], i) => {
      w.box(rx - 3, y - 1, rz - 3, rx + 3, y - 1, rz + 3, tile);
      w.box(rx - 3, y, rz - 3, rx + 3, y + 3, rz + 3, (cx, cy, cz) => {
        const edge = Math.abs(cx - rx) === 3 || Math.abs(cz - rz) === 3;
        if (!edge) return 0;
        if (cy - y >= 2 && roll(cx, cy, cz, 4) < 0.45) return 0; // crumbled tops
        if (cy - y < 2 && Math.abs(cx - rx) <= 0 && cz === rz + (i < 2 ? 3 : -3)) return 0; // doorway
        return brick;
      });
      w.chest(rx + 1, y, rz + 1, 'ancient_city', 2);
      if (w.inChunk(rx - 2, rz - 2)) w.set(rx - 2, y, rz - 2, B.wisp_lantern, 0);
    });
    // sculk growth: sensors and shriekers on the sculk, two catalysts by the arch
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz) || w.get(cx, y - 1, cz) !== B.sculk || w.get(cx, y, cz) !== 0) continue;
      const q = roll(cx, y, cz, 5);
      if (q < 0.022) w.sculk(cx, y, cz, B.sculk_sensor);
      else if (q < 0.03 && Math.hypot(dx, dz) > 8) w.sculk(cx, y, cz, B.sculk_shrieker);
    }
    for (const [cx, cz] of along ? [[x - 4, z - 6], [x + 4, z - 6]] : [[x - 6, z - 4], [x - 6, z + 4]]) if (w.inChunk(cx, cz)) w.set(cx, y - 1, cz, B.sculk_catalyst, 0);
  },

  // A raider watchtower of dark wood: four storeys climbed by ladder, a
  // lookout with the raiders' banner, tents around it and a caged alpaca.
  outpost(s, w) {
    const { x, z } = s, y = s.y;
    const log = B.dark_oak_log, plank = B.dark_oak_planks, fence = B.oak_fence;
    // level a yard around the tower
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz) || dx * dx + dz * dz > 150) continue;
      const gh = w.ground(cx, cz);
      const top = w.get(cx, gh, cz);
      for (let yy = gh + 1; yy < y; yy++) w.set(cx, yy, cz, B.dirt, 0);
      if (gh < y - 1) w.set(cx, y - 1, cz, top === B.sand || top === B.snowy_grass ? top : B.grass, 0);
      for (let yy = y; yy <= y + 24; yy++) w.set(cx, yy, cz, 0, 0);
    }
    // the tower: corner posts, plank walls with windows, floors every five blocks
    for (let dy = 0; dy <= 19; dy++) {
      const yy = y + dy, floor = dy % 5 === 4;
      w.box(x - 3, yy, z - 3, x + 3, yy, z + 3, (cx, cy, cz) => {
        const ex = Math.abs(cx - x) === 3, ez = Math.abs(cz - z) === 3;
        if (ex && ez) return log;
        if (ex || ez) {
          const along = ex ? cz - z : cx - x;
          if (dy % 5 === 2 && Math.abs(along) === 1) return 0; // windows
          if (dy < 3 && cz === z + 3 && cx === x) return 0;     // the door
          if (dy < 3 && cz === z + 3 && cx === x + 1 && dy < 2) return 0;
          return plank;
        }
        if (floor) return cx === x - 2 && cz === z - 2 ? 0 : plank; // a hatch for the ladder
        return 0;
      });
      if (w.inChunk(x - 2, z - 2)) w.set(x - 2, yy, z - 2, B.ladder, 1);
    }
    // the lookout: an overhanging platform with a railing
    w.box(x - 4, y + 20, z - 4, x + 4, y + 20, z + 4, (cx, cy, cz) => (cx === x - 2 && cz === z - 2 ? B.ladder : plank), 0);
    if (w.inChunk(x - 2, z - 2)) w.set(x - 2, y + 20, z - 2, B.ladder, 1);
    w.box(x - 4, y + 21, z - 4, x + 4, y + 21, z + 4, (cx, cy, cz) => (Math.abs(cx - x) === 4 || Math.abs(cz - z) === 4 ? fence : 0));
    for (const [cx, cz] of [[x - 4, z - 4], [x + 4, z - 4], [x - 4, z + 4], [x + 4, z + 4]]) for (let yy = y + 22; yy <= y + 24; yy++) if (w.inChunk(cx, cz)) w.set(cx, yy, cz, log, 0);
    w.box(x - 4, y + 25, z - 4, x + 4, y + 25, z + 4, plank);
    w.chest(x + 2, y + 21, z + 2, 'outpost', 2);
    w.banner(x, y + 21, z, 0, [['chevron', 7], ['circle', 1], ['border', 7]]);
    // tents of wool
    for (const [tx, tz] of [[x + 8, z - 6], [x - 8, z + 6]]) {
      for (let k = -1; k <= 1; k++) {
        w.box(tx - 2, y, tz + k, tx + 2, y + 2, tz + k, (cx, cy, cz) => {
          const d = Math.abs(cx - tx);
          if (cy - y === 2 - d || (d === 2 && cy === y)) return B.white_wool;
          return 0;
        });
      }
    }
    // a cage of fences with a captive alpaca
    const [cx0, cz0] = [[x + 7, z + 6], [x - 7, z - 7], [x + 7, z - 9], [x - 9, z + 7]][s.cage];
    w.box(cx0 - 2, y, cz0 - 2, cx0 + 2, y + 2, cz0 + 2, (cx, cy, cz) => (Math.abs(cx - cx0) === 2 || Math.abs(cz - cz0) === 2 ? fence : 0));
    w.box(cx0 - 2, y + 3, cz0 - 2, cx0 + 2, y + 3, cz0 + 2, plank);
    if (w.inChunk(cx0, cz0)) w.spawn('alpaca', cx0, y, cz0);
    // the garrison
    if (w.inChunk(x, z)) {
      w.spawn('marauder', x + 1, y + 21, z - 1, { variant: 'captain' });
      w.spawn('marauder', x + 1, y, z + 5);
      w.spawn('ranger', x - 1, y + 21, z + 1);
      w.spawn('marauder', x - 5, y, z - 2);
    }
  },

  // A snow dome with a bed and a stove; some hide a laboratory below a
  // trapdoor in the floor.
  igloo(s, w) {
    const { x, z } = s, y = s.y;
    const D = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.face];
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz)) continue;
      const gh = w.ground(cx, cz);
      for (let yy = gh + 1; yy < y; yy++) w.set(cx, yy, cz, B.snow_block, 0);
      for (let yy = y; yy <= y + 6; yy++) w.set(cx, yy, cz, 0, 0);
      if (dx * dx + dz * dz <= 16) w.set(cx, y - 1, cz, B.snow_block, 0);
    }
    // the dome: an ellipsoid shell
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 0; dy <= 4; dy++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz)) continue;
      const v = (dx * dx) / 16 + (dz * dz) / 16 + (dy * dy) / 13;
      if (v <= 1.08 && v > 0.55) w.set(cx, y + dy, cz, B.snow_block, 0);
    }
    // windows of ice to the sides, a doorway to the front
    for (const side of [-1, 1]) {
      const wx = x + (D[1] ? side * 4 : 0), wz = z + (D[0] ? side * 4 : 0);
      if (w.inChunk(wx, wz)) w.set(wx, y + 1, wz, B.ice, 0);
    }
    for (let k = 3; k <= 5; k++) for (let yy = y; yy <= y + 1; yy++) {
      const cx = x + D[0] * k, cz = z + D[1] * k;
      if (!w.inChunk(cx, cz)) continue;
      w.set(cx, yy, cz, 0, 0);
      if (k === 5) for (const o of [-1, 1]) { const ox = cx + (D[1] ? o : 0), oz = cz + (D[0] ? o : 0); if (w.inChunk(ox, oz)) { w.set(ox, yy, oz, B.snow_block, 0); w.set(ox, y + 2, oz, B.snow_block, 0); } }
      if (k === 5) w.set(cx, y + 2, cz, B.snow_block, 0);
    }
    // inside: a wool floor, a bed, a stove and a workbench, a lantern
    w.box(x - 3, y - 1, z - 3, x + 3, y - 1, z + 3, (cx, cy, cz) => ((cx - x) ** 2 + (cz - z) ** 2 <= 9 ? B.white_wool : B.snow_block));
    const back = [x - D[0] * 2, z - D[1] * 2];
    const sideV = [D[1], -D[0]];
    if (w.inChunk(back[0] + sideV[0] * 2, back[1] + sideV[1] * 2)) w.set(back[0] + sideV[0] * 2, y, back[1] + sideV[1] * 2, B.furnace, [5, 2, 4, 3][s.face]);
    if (w.inChunk(back[0] - sideV[0] * 2, back[1] - sideV[1] * 2)) w.set(back[0] - sideV[0] * 2, y, back[1] - sideV[1] * 2, B.crafting_table, 0);
    const bf = (s.face + 2) & 3; // the bed points away from the door
    if (w.inChunk(back[0], back[1]) && w.inChunk(back[0] - D[0], back[1] - D[1])) {
      w.set(back[0] + D[0], y, back[1] + D[1], B.bed, bf);
      w.set(back[0], y, back[1], B.bed, bf | 4);
    }
    if (w.inChunk(x, z)) w.set(x, y + 3, z, B.lantern, 1);
    if (!s.basement) return;
    // the laboratory below
    const ly = y - 9;
    const hx = x + sideV[0], hz = z + sideV[1];
    if (w.inChunk(hx, hz)) {
      w.set(hx, y - 1, hz, B.oak_trapdoor, 0);
      for (let yy = ly + 1; yy < y - 1; yy++) { w.set(hx, yy, hz, B.ladder, 0); }
    }
    w.box(x - 4, ly - 1, z - 3, x + 4, ly + 4, z + 3, B.stone_bricks, 0, true);
    w.box(x - 3, ly, z - 2, x + 3, ly + 3, z + 2, 0);
    for (let yy = ly + 1; yy < y - 1; yy++) for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const cx = hx + ox, cz = hz + oz; if (w.inChunk(cx, cz) && w.get(cx, yy, cz) === 0) w.set(cx, yy, cz, B.stone_bricks, 0); }
    // ladders cling to a wall: give the shaft one
    if (w.inChunk(hx, hz)) for (let yy = ly; yy < y - 1; yy++) { w.set(hx - 1, yy, hz, B.stone_bricks, 0); w.set(hx, yy, hz, B.ladder, 1); }
    if (w.inChunk(x - 3, z)) w.set(x - 3, ly, z, B.brewing_stand, 0);
    if (w.inChunk(x - 3, z + 1)) w.set(x - 3, ly, z + 1, B.cauldron, 2);
    w.chest(x + 3, ly, z - 2, 'igloo', 4);
    if (w.inChunk(x + 2, z + 2)) w.set(x + 2, ly + 3, z + 2, B.cobweb, 0);
    if (w.inChunk(x, z)) w.set(x, ly + 3, z, B.lantern, 2);
  },

  // A broken merchant ship on the sea floor (or run aground), its hold
  // still full.
  shipwreck(s, w) {
    const { x, z } = s, y = s.y;
    const along = s.axis === 0; // the keel runs along x
    const at = (u, v) => (along ? [x + u, z + v] : [x + v, z + u]);
    const fill = (yy) => (yy <= SEA - 1 ? B.water : 0);
    const plank = B.spruce_planks, log = B.spruce_log;
    for (let u = -11; u <= 11; u++) {
      const half = Math.max(1, Math.round(3.2 * Math.sqrt(Math.max(0, 1 - (u / 12) ** 2))));
      const broken = (s.broken === 0 && u > 4) || (s.broken === 1 && u < -5);
      for (let v = -half - 1; v <= half + 1; v++) {
        const [cx, cz] = at(u, v);
        if (!w.inChunk(cx, cz)) continue;
        for (let dy = 0; dy <= 5; dy++) {
          const yy = y + dy;
          const rim = Math.abs(v) === half + 1 || Math.abs(u) === 11;
          const keel = dy === 0 && Math.abs(v) <= half;
          let id = 0;
          if ((rim && dy <= 4) || keel) id = plank;
          if (dy === 3 && Math.abs(v) <= half && Math.abs(u) < 10) id = plank; // the deck
          if (rim && dy === 4) id = B.oak_fence;
          if (id && broken && w.rnd(cx, yy, cz, 3) < 0.55) id = 0;
          if (id && w.rnd(cx, yy, cz, 4) < 0.08) id = 0; // holes from the reef
          w.set(cx, yy, cz, id || fill(yy), 0);
        }
        // sand drifts into the hull
        if (w.rnd(cx, y, cz, 6) < 0.3 && Math.abs(v) <= half) w.set(cx, y + 1, cz, B.sand, 0);
      }
    }
    // the mast, snapped off
    const [mx, mz] = at(-1, 0);
    if (w.inChunk(mx, mz)) for (let dy = 1; dy <= 3 + s.mast; dy++) w.set(mx, y + dy, mz, log, 0);
    // supplies at the stern, treasure in the hold
    const [sx, sz] = at(-8, 0), [tx, tz] = at(2, 0), [px, pz] = at(7, 1);
    w.chest(sx, y + 1, sz, 'shipwreck', 2);
    w.chest(tx, y + 1, tz, 'shipwreck_treasure', 2);
    if (s.broken !== 0) w.chest(px, y + 1, pz, 'shipwreck', 3);
  },

  // Wooden-propped tunnels with rails, cobwebs, lanterns and the odd chest.
  mineshaft(s, w) {
    const y = s.y;
    const [rx0, rz0, rx1, rz1] = s.room;
    w.box(rx0, y, rz0, rx1, y + 4, rz1, 0);
    w.box(rx0, y - 1, rz0, rx1, y - 1, rz1, B.dirt);
    s.segs.forEach((g, i) => {
      const along = g.axis === 1 ? 'x' : 'z';
      for (let x = g.x0; x <= g.x1; x++) for (let z = g.z0; z <= g.z1; z++) {
        for (let o = -1; o <= 1; o++) {
          const cx = along === 'x' ? x : x + o, cz = along === 'x' ? z + o : z;
          if (!w.inChunk(cx, cz)) continue;
          for (let yy = y; yy <= y + 2; yy++) w.set(cx, yy, cz, 0, 0);
          if (!w.get(cx, y - 1, cz) || w.get(cx, y - 1, cz) === B.water || w.get(cx, y - 1, cz) === B.lava) w.set(cx, y - 1, cz, B.oak_planks, 0);
          if (w.rnd(cx, y + 2, cz, 7) < 0.05) w.set(cx, y + 2, cz, B.cobweb, 0);
          if (i === s.spawnerSeg && w.rnd(cx, y + 1, cz, 9) < 0.25) w.set(cx, y + 1 + (w.rnd(cx, 0, cz, 3) < 0.5 ? 1 : 0), cz, B.cobweb, 0);
        }
        const pos = (((along === 'x' ? x : z) % 4) + 4) % 4;
        // supports every four blocks: posts and a beam
        if (pos === 0) {
          for (const o of [-1, 1]) {
            const cx = along === 'x' ? x : x + o, cz = along === 'x' ? z + o : z;
            if (w.inChunk(cx, cz)) { w.set(cx, y, cz, B.oak_fence, 0); w.set(cx, y + 1, cz, B.oak_fence, 0); }
          }
          for (let o = -1; o <= 1; o++) { const cx = along === 'x' ? x : x + o, cz = along === 'x' ? z + o : z; if (w.inChunk(cx, cz)) w.set(cx, y + 2, cz, B.oak_planks, 0); }
          if (w.inChunk(x, z) && w.rnd(x, y, z, 11) < 0.3) w.set(x, y + 1, z, B.lantern, 1);
        } else if (w.inChunk(x, z) && w.rnd(x, y, z, 13) < 0.72) w.set(x, y, z, B.rail, g.axis === 1 ? 1 : 0);
        // a chest tucked against the wall now and then
        if (pos === 2 && w.rnd(x, y, z, 17) < 0.035) {
          const cx = along === 'x' ? x : x + 1, cz = along === 'x' ? z + 1 : z;
          w.chest(cx, y, cz, 'mineshaft', along === 'x' ? 3 : 5);
        }
      }
      if (i === s.spawnerSeg) {
        const mx = (g.x0 + g.x1) >> 1, mz = (g.z0 + g.z1) >> 1;
        w.spawner(mx, y, mz, 'crawler');
      }
    });
  },

  // A stepped sandstone pyramid with two towers; the treasure room under the
  // middle is guarded by a pressure plate over blast crates.
  sun_temple(s, w) {
    const { x, z } = s, y = s.y;
    const ss = B.sandstone, cs = B.chiseled_sandstone, ot = B.orange_terracotta, wt = B.white_terracotta;
    // level the ground and lay a foundation
    for (let dx = -11; dx <= 11; dx++) for (let dz = -11; dz <= 11; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz)) continue;
      const gh = w.ground(cx, cz);
      for (let yy = Math.min(gh, y - 1); yy <= y; yy++) w.set(cx, yy, cz, ss, 0);
      for (let yy = y + 1; yy <= y + 30; yy++) w.set(cx, yy, cz, 0, 0);
    }
    // the pyramid: hollow inside, stepped outside
    for (let L = 0; L <= 9; L++) {
      const R = 10 - L;
      w.box(x - R, y + 1 + L, z - R, x + R, y + 1 + L, z + R, (cx, cy, cz) => {
        const edge = Math.abs(cx - x) === R || Math.abs(cz - z) === R;
        if (!edge && R > 1 && L < 6) return 0;
        return (cy - y) % 4 === 2 && edge ? ot : ss;
      });
    }
    // hall floor with a star of terracotta
    w.box(x - 8, y + 1, z - 8, x + 8, y + 1, z + 8, (cx, cy, cz) => (Math.abs(cx - x) === Math.abs(cz - z) || cx === x || cz === z ? ot : ss));
    w.box(x - 1, y + 1, z - 1, x + 1, y + 1, z + 1, wt);
    // entrance and pillars on the facing side
    const D = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.face];
    for (let k = 7; k <= 11; k++) for (let o = -1; o <= 1; o++) for (let yy = y + 2; yy <= y + 4; yy++) {
      const cx = x + D[0] * k + (D[1] ? o : 0), cz = z + D[1] * k + (D[0] ? o : 0);
      if (w.inChunk(cx, cz)) w.set(cx, yy, cz, 0, 0);
    }
    for (const o of [-2, 2]) for (let yy = y + 1; yy <= y + 5; yy++) {
      const cx = x + D[0] * 11 + (D[1] ? o : 0), cz = z + D[1] * 11 + (D[0] ? o : 0);
      if (w.inChunk(cx, cz)) w.set(cx, yy, cz, cs, 0);
    }
    // two towers at the front corners
    for (const side of [-1, 1]) {
      const tx = x + D[0] * 9 + (D[1] ? side * 9 : 0), tz = z + D[1] * 9 + (D[0] ? side * 9 : 0);
      w.box(tx - 2, y + 1, tz - 2, tx + 2, y + 13, tz + 2, (cx, cy, cz) => ((cy - y) % 3 === 0 ? ot : ss), 0, true);
      w.box(tx - 1, y + 2, tz - 1, tx + 1, y + 12, tz + 1, 0);
      w.box(tx - 2, y + 14, tz - 2, tx + 2, y + 14, tz + 2, cs);
    }
    // the treasure chamber: a shaft from the hall down to a room of four chests
    const cy = y - 12;
    w.box(x - 4, cy - 1, z - 4, x + 4, cy + 4, z + 4, ss, 0, true);
    w.box(x - 3, cy, z - 3, x + 3, cy + 3, z + 3, 0);
    w.box(x - 4, cy - 1, z - 4, x + 4, cy - 1, z + 4, (cx, yy, cz) => ((cx + cz) % 2 ? ot : cs));
    w.box(x, cy + 4, z, x, y + 1, z, 0);
    w.chest(x, cy, z - 3, 'temple', 3); w.chest(x, cy, z + 3, 'temple', 2);
    w.chest(x - 3, cy, z, 'temple', 5); w.chest(x + 3, cy, z, 'temple', 4);
    if (w.inChunk(x, z)) {
      w.set(x, cy, z, B.stone_pressure_plate, 0);
      w.box(x - 1, cy - 3, z - 1, x + 1, cy - 2, z + 1, B.tnt);
      w.set(x, cy - 1, z, B.tnt, 0);
    }
  },

  // A mossy stone shrine in three tiers, overgrown with vines; an arrow
  // trap guards the stair down to its treasure.
  jungle_shrine(s, w) {
    const { x, z } = s, y = s.y;
    const stone = (cx, cy, cz) => (w.rnd(cx, cy, cz, 5) < 0.4 ? B.mossy_cobblestone : B.cobblestone);
    for (let dx = -7; dx <= 7; dx++) for (let dz = -8; dz <= 8; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz)) continue;
      const gh = w.ground(cx, cz);
      for (let yy = Math.min(gh, y - 1); yy <= y; yy++) w.set(cx, yy, cz, stone(cx, yy, cz), 0);
      for (let yy = y + 1; yy <= y + 30; yy++) w.set(cx, yy, cz, 0, 0);
    }
    // three shrinking tiers
    w.box(x - 6, y + 1, z - 7, x + 6, y + 5, z + 7, stone, 0, true);
    w.box(x - 4, y + 6, z - 5, x + 4, y + 9, z + 5, stone, 0, true);
    w.box(x - 2, y + 10, z - 3, x + 2, y + 12, z + 3, stone, 0, true);
    // door and windows
    w.box(x - 1, y + 2, z + 7, x + 1, y + 4, z + 7, 0);
    for (const dz of [-4, 0, 4]) { w.box(x - 6, y + 3, z + dz, x - 6, y + 3, z + dz, 0); w.box(x + 6, y + 3, z + dz, x + 6, y + 3, z + dz, 0); }
    w.box(x - 1, y + 6, z + 5, x + 1, y + 7, z + 5, 0); // to the upper tier
    w.box(x, y + 5, z + 4, x, y + 5, z + 4, 0);
    // the trap corridor: a plate in front of the stair, a dispenser of arrows
    if (w.inChunk(x, z + 2)) w.set(x, y + 2, z + 2, B.stone_pressure_plate, 0);
    // (recorded as a 'trap' chest so it is filled with arrows, then made a dispenser facing +X)
    w.chest(x - 5, y + 2, z + 2, 'trap');
    if (w.inChunk(x - 5, z + 2)) w.set(x - 5, y + 2, z + 2, B.dispenser, 2);
    for (let k = -4; k <= -1; k++) if (w.inChunk(x + k, z + 2)) w.set(x + k, y + 1, z + 2, B.spark_wire, 0);
    // stair down to the vault
    for (let k = 0; k < 4; k++) w.box(x + 3, y - k, z - 2 + k, x + 4, y - k + 2, z - 2 + k, 0);
    w.box(x - 3, y - 6, z - 4, x + 5, y - 2, z + 4, stone, 0, true);
    w.box(x - 2, y - 5, z - 3, x + 4, y - 3, z + 3, 0);
    w.chest(x - 2, y - 5, z, 'shrine', 5);
    w.chest(x + 1, y + 7, z - 2, 'shrine', 3);
    // vines over the walls
    for (let dx = -7; dx <= 7; dx++) for (let dz = -8; dz <= 8; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz) || w.rnd(cx, 0, cz, 21) > 0.35) continue;
      const m = dx === -7 ? 2 : dx === 7 ? 1 : dz === -8 ? 4 : dz === 8 ? 3 : 0;
      if (!m) continue;
      const top = y + 1 + Math.floor(w.rnd(cx, 1, cz, 23) * 5);
      for (let yy = top; yy >= y + 1; yy--) if (w.get(cx, yy, cz) === 0) w.set(cx, yy, cz, B.vines, m);
    }
  },

  // A little house on stilts above the swamp water; a hexer lives here.
  swamp_hut(s, w) {
    const { x, z } = s, y = s.y;
    const P = B.spruce_planks;
    for (const [dx, dz] of [[-3, -4], [3, -4], [-3, 4], [3, 4]]) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz)) continue;
      for (let yy = y - 1; yy >= w.ground(cx, cz) - 1 && yy > 0; yy--) w.set(cx, yy, cz, B.oak_log, 0);
    }
    w.box(x - 3, y, z - 4, x + 3, y, z + 4, P);
    w.box(x - 3, y + 1, z - 3, x + 3, y + 4, z + 4, P, 0, true);
    w.box(x - 2, y + 1, z - 2, x + 2, y + 3, z + 3, 0);
    w.box(x, y + 1, z - 3, x, y + 2, z - 3, 0); // door
    w.box(x - 3, y + 2, z + 1, x - 3, y + 2, z + 1, B.glass_pane);
    w.box(x + 3, y + 2, z + 1, x + 3, y + 2, z + 1, B.glass_pane);
    w.box(x - 4, y + 5, z - 5, x + 4, y + 5, z + 5, B.oak_slab);
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 4], [3, 4]]) w.box(x + dx, y + 1, z + dz, x + dx, y + 4, z + dz, B.oak_log);
    w.box(x - 2, y + 1, z + 3, x - 2, y + 1, z + 3, B.crafting_table);
    if (w.inChunk(x + 2, z + 3)) w.set(x + 2, y + 1, z + 3, B.cauldron, 1 + Math.floor(w.rnd(x, y, z, 3) * 3));
    w.chest(x + 2, y + 1, z + 1, 'hut', 4);
    if (w.inChunk(x, z)) w.set(x, y + 3, z, B.lantern, 1);
    w.spawn('hexer', x, y + 1, z + 1, { home: true });
  },

  // A great hall of tidestone on the sea floor: a broad base, a tall middle
  // keep, four corner towers, glowing lanterns; wardens patrol it.
  tide_citadel(s, w) {
    const { x, z } = s, y = s.y;
    const brick = (cx, cy, cz) => { const v = w.rnd(cx, cy, cz, 3); return v < 0.55 ? B.tidestone_bricks : v < 0.85 ? B.tidestone : B.dark_tidestone; };
    // foundation down to the floor
    for (let dx = -18; dx <= 18; dx++) for (let dz = -18; dz <= 18; dz++) {
      const cx = x + dx, cz = z + dz;
      if (!w.inChunk(cx, cz)) continue;
      for (let yy = w.ground(cx, cz); yy < y; yy++) w.set(cx, yy, cz, B.tidestone, 0);
    }
    const top = Math.min(SEA - 2, y + 22);
    w.box(x - 18, y, z - 18, x + 18, y + 7, z + 18, brick, 0, true);       // base hall
    w.box(x - 17, y + 1, z - 17, x + 17, y + 6, z + 17, B.water);
    w.box(x - 7, y + 7, z - 7, x + 7, top, z + 7, brick, 0, true);         // keep
    w.box(x - 6, y + 8, z - 6, x + 6, top - 1, z + 6, B.water);
    for (const [dx, dz] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) { // corner towers
      w.box(x + dx - 3, y + 7, z + dz - 3, x + dx + 3, y + 15, z + dz + 3, brick, 0, true);
      w.box(x + dx - 2, y + 8, z + dz - 2, x + dx + 2, y + 14, z + dz + 2, B.water);
    }
    // gates on four sides and openings between the rooms
    for (const [dx, dz] of [[0, -18], [0, 18], [-18, 0], [18, 0]]) w.box(x + dx - (dz ? 2 : 0), y + 1, z + dz - (dx ? 2 : 0), x + dx + (dz ? 2 : 0), y + 4, z + dz + (dx ? 2 : 0), B.water);
    w.box(x - 2, y + 7, z - 2, x + 2, y + 7, z + 2, B.water);
    // the treasure vault in the heart of the base
    w.box(x - 3, y + 1, z - 3, x + 3, y + 5, z + 3, B.dark_tidestone, 0, true);
    w.box(x - 2, y + 2, z - 2, x + 2, y + 4, z + 2, B.water);
    w.box(x - 1, y + 1, z - 1, x + 1, y + 1, z + 1, B.gold_block);
    w.box(x, y + 2, z - 3, x, y + 3, z - 3, B.water);
    w.chest(x, y + 2, z + 2, 'citadel', 2);
    // lanterns set into the walls, glowing through the water
    for (let dx = -18; dx <= 18; dx += 6) for (const dz of [-18, 18]) { w.box(x + dx, y + 5, z + dz, x + dx, y + 5, z + dz, B.lumen_lantern); w.box(x + dz, y + 5, z + dx, x + dz, y + 5, z + dx, B.lumen_lantern); }
    for (let k = -6; k <= 6; k += 4) { w.box(x + k, top, z, x + k, top, z, B.lumen_lantern); w.box(x, top, z + k, x, top, z + k, B.lumen_lantern); }
    for (const [dx, dz] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) w.box(x + dx, y + 15, z + dz, x + dx, y + 15, z + dz, B.lumen_lantern);
    // wardens inside and around
    const spots = [[-10, 3, -10], [10, 3, -10], [-10, 3, 10], [10, 3, 10], [0, 12, 0], [0, 3, -13], [-15, 10, -15], [15, 10, 15]];
    for (const [dx, dy, dz] of spots) w.spawn('tide_warden', x + dx, y + dy, z + dz);
  },

  // A dark oak manor of two storeys: hall, library, bedrooms, a dining room
  // and a strongroom; hexers and archers keep it.
  manor(s, w) {
    const { x, z } = s, y = s.y;
    const X0 = x - 15, X1 = x + 15, Z0 = z - 11, Z1 = z + 11;
    const P = B.dark_oak_planks, L = B.dark_oak_log;
    for (let cx = X0 - 1; cx <= X1 + 1; cx++) for (let cz = Z0 - 1; cz <= Z1 + 1; cz++) {
      if (!w.inChunk(cx, cz)) continue;
      const gh = w.ground(cx, cz);
      for (let yy = Math.min(gh, y - 1); yy < y; yy++) w.set(cx, yy, cz, B.cobblestone, 0);
      for (let yy = y; yy <= y + 32; yy++) w.set(cx, yy, cz, 0, 0);
    }
    // floors, walls, posts
    w.box(X0, y, Z0, X1, y, Z1, B.cobblestone);
    w.box(X0, y + 1, Z0, X1, y + 5, Z1, P, 0, true);
    w.box(X0, y + 6, Z0, X1, y + 6, Z1, B.oak_planks);
    w.box(X0, y + 7, Z0, X1, y + 11, Z1, B.birch_planks, 0, true);
    for (let cx = X0; cx <= X1; cx += 5) for (const cz of [Z0, Z1]) w.box(cx, y + 1, cz, cx, y + 11, cz, L);
    for (let cz = Z0; cz <= Z1; cz += 5) for (const cx of [X0, X1]) w.box(cx, y + 1, cz, cx, y + 11, cz, L);
    w.box(X0 + 1, y + 1, Z0 + 1, X1 - 1, y + 5, Z1 - 1, 0);
    w.box(X0 + 1, y + 7, Z0 + 1, X1 - 1, y + 11, Z1 - 1, 0);
    // windows
    for (let cx = X0 + 2; cx < X1; cx += 5) for (const cz of [Z0, Z1]) { w.box(cx, y + 2, cz, cx + 1, y + 3, cz, B.glass_pane); w.box(cx, y + 8, cz, cx + 1, y + 9, cz, B.glass_pane); }
    for (let cz = Z0 + 2; cz < Z1; cz += 5) for (const cx of [X0, X1]) { w.box(cx, y + 2, cz, cx, y + 3, cz + 1, B.glass_pane); w.box(cx, y + 8, cz, cx, y + 9, cz + 1, B.glass_pane); }
    // roof: stepped cobblestone stairs with a ridge
    for (let k = 0; k <= 12; k++) {
      const yy = y + 12 + Math.floor(k / 2);
      if (Z0 - 1 + k > Z1 + 1 - k) break;
      w.box(X0 - 1, yy, Z0 - 1 + k, X1 + 1, yy, Z0 - 1 + k, B.cobblestone_stairs, rise(0));
      w.box(X0 - 1, yy, Z1 + 1 - k, X1 + 1, yy, Z1 + 1 - k, B.cobblestone_stairs, rise(2));
      w.box(X0, yy, Z0 - 1 + k + 1, X0, yy, Z1 - k, P); w.box(X1, yy, Z0 - 1 + k + 1, X1, yy, Z1 - k, P);
    }
    // front door and steps
    w.box(x - 1, y + 1, Z1, x + 1, y + 3, Z1, 0);
    w.box(x - 2, y, Z1 + 1, x + 2, y, Z1 + 2, B.cobblestone_slab);
    // inner walls: a central hall with rooms either side
    w.box(x - 4, y + 1, Z0 + 1, x - 4, y + 5, Z1 - 1, P); w.box(x + 4, y + 1, Z0 + 1, x + 4, y + 5, Z1 - 1, P);
    w.box(x - 4, y + 1, z + 4, x - 4, y + 3, z + 5, 0); w.box(x + 4, y + 1, z + 4, x + 4, y + 3, z + 5, 0);
    w.box(X0 + 1, y + 1, z, x - 5, y + 5, z, P); w.box(x + 5, y + 1, z, X1 - 1, y + 5, z, P);
    w.box(x - 9, y + 1, z, x - 8, y + 3, z, 0); w.box(x + 8, y + 1, z, x + 9, y + 3, z, 0);
    // hall: a red runner, a stair to the upper floor
    w.box(x - 1, y, Z0 + 1, x + 1, y, Z1 - 1, B.red_wool);
    for (let k = 0; k < 5; k++) w.box(x - 3, y + 1 + k, Z0 + 2 + k, x - 2, y + 1 + k, Z0 + 2 + k, B.oak_stairs, rise(0));
    w.box(x - 3, y + 6, Z0 + 2, x - 2, y + 6, Z0 + 7, 0);
    // library (front left), dining (front right)
    for (let cx = X0 + 1; cx <= x - 5; cx++) w.box(cx, y + 1, Z1 - 1, cx, y + 4, Z1 - 1, cx % 3 ? B.bookshelf : P);
    w.box(X0 + 4, y + 1, z + 4, X0 + 6, y + 1, z + 6, B.bookshelf);
    w.box(x + 7, y + 1, z + 5, x + 12, y + 1, z + 6, B.oak_fence);
    w.box(x + 7, y + 2, z + 5, x + 12, y + 2, z + 6, B.oak_pressure_plate);
    // back rooms: bedrooms and the strongroom
    for (const bx of [X0 + 3, X0 + 7]) { w.box(bx, y + 1, Z0 + 2, bx, y + 1, Z0 + 2, B.bed, 0); w.box(bx, y + 1, Z0 + 1, bx, y + 1, Z0 + 1, B.bed, 4); }
    w.chest(x + 8, y + 1, Z0 + 1, 'manor', 2); w.chest(x + 12, y + 1, Z0 + 1, 'manor', 2);
    w.chest(X0 + 2, y + 7, Z1 - 1, 'manor', 3);
    // lights
    for (let cx = X0 + 3; cx < X1; cx += 6) for (const cz of [z - 5, z + 5]) { w.box(cx, y + 5, cz, cx, y + 5, cz, B.lantern, 1); w.box(cx, y + 11, cz, cx, y + 11, cz, B.lantern, 1); }
    // keepers
    w.spawn('hexer', x - 8, y + 1, z - 6, { home: true }); w.spawn('hexer', x + 8, y + 7, z + 5, { home: true });
    w.spawn('archer', x, y + 1, z - 4); w.spawn('archer', x - 8, y + 7, z - 5);
  },
};
