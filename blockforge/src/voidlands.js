// The Void: floating duskstone islands in a starry dark. A central island
// holds obsidian pillars topped with pylons around the exit fountain; far
// outer islands grow void stalks and carry astral spires with loot.
import { Simplex, rng, hash2 } from './noise.js';
import { B } from './blocks.js';
import { CHUNK, CHUNK_VOLUME, HEIGHT } from './constants.js';

export const VOID_PILLAR_RADIUS = 42;
export const OUTER_START = 440;
const SPIRE_CELL = 320;

export class VoidGen {
  constructor(seed) {
    this.seed = (seed ^ 0xe0d) | 0;
    this.nShape = new Simplex(this.seed ^ 0x51);
    this.nTop = new Simplex(this.seed ^ 0x52);
    this.nOuter = new Simplex(this.seed ^ 0x53);
    const r = rng(this.seed ^ 0x77);
    const a0 = r() * Math.PI * 2;
    this.pillars = [];
    for (let i = 0; i < 8; i++) {
      const a = a0 + (i / 8) * Math.PI * 2;
      const rad = 2 + Math.floor(r() * 4);
      this.pillars.push({
        x: Math.round(Math.cos(a) * VOID_PILLAR_RADIUS), z: Math.round(Math.sin(a) * VOID_PILLAR_RADIUS),
        r: rad, h: 76 + Math.floor(r() * 9) * 3, caged: i < 2,
      });
    }
    this.spireCache = new Map();
  }

  biomeAt() { return -1; }
  biomeName(x, z) { return Math.hypot(x, z) < 200 ? 'Central Island' : 'Outer Islands'; }

  // Column of the island at (x, z): [bottom, top] or null.
  column(x, z) {
    const r = Math.hypot(x, z);
    if (r < 200) {
      const ang = Math.atan2(z, x);
      const R = 74 + this.nShape.noise2(Math.cos(ang) * 1.6, Math.sin(ang) * 1.6) * 14 + this.nShape.noise2(x / 30, z / 30) * 6;
      if (r >= R) return null;
      const t = 1 - (r / R) * (r / R);
      const top = 58 + Math.round(this.nTop.noise2(x / 40, z / 40) * 3 + t * 5);
      const bottom = top - Math.round(4 + t * 42 + this.nShape.noise2(x / 12, z / 12) * 4);
      return [bottom, top];
    }
    if (r < OUTER_START) return null;
    const v = this.nOuter.fbm2(x / 110, z / 110, 3) + this.nOuter.noise2(x / 30, z / 30) * 0.12;
    if (v < 0.22) return null;
    const k = Math.min(1, (v - 0.22) * 3.2);
    const top = 56 + Math.round(this.nTop.noise2(x / 50, z / 50) * 6 + k * 6);
    return [top - Math.round(3 + k * 26), top];
  }

  // Deterministic spire in an outer cell, or null.
  spireIn(cx, cz) {
    const key = cx * 100003 + cz;
    if (this.spireCache.has(key)) return this.spireCache.get(key);
    let s = null;
    const r = rng(hash2(this.seed ^ 0x5b1e, cx, cz));
    if (r() < 0.55) {
      const x = cx * SPIRE_CELL + 60 + Math.floor(r() * (SPIRE_CELL - 120));
      const z = cz * SPIRE_CELL + 60 + Math.floor(r() * (SPIRE_CELL - 120));
      if (Math.hypot(x, z) > OUTER_START + 40) {
        const col = this.column(x, z);
        let ok = !!col;
        for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) if (!this.column(x + dx, z + dz)) ok = false;
        if (ok) s = { x, z, y: col[1] + 1, h: 18 + Math.floor(r() * 10) };
      }
    }
    this.spireCache.set(key, s);
    if (this.spireCache.size > 128) this.spireCache.delete(this.spireCache.keys().next().value);
    return s;
  }

  locateSpire(x, z, cells = 4) {
    const cx = Math.floor(x / SPIRE_CELL), cz = Math.floor(z / SPIRE_CELL);
    let best = null, bd = Infinity;
    for (let dz = -cells; dz <= cells; dz++) for (let dx = -cells; dx <= cells; dx++) {
      const s = this.spireIn(cx + dx, cz + dz);
      if (s) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
    }
    return best;
  }

  generate(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const meta = new Uint8Array(CHUNK_VOLUME);
    const tints = new Uint8Array(CHUNK * CHUNK * 9).fill(128);
    const X0 = cx * CHUNK, Z0 = cz * CHUNK;
    const idx = (x, y, z) => x | (z << 4) | (y << 8);
    const set = (wx, y, wz, id, m = 0) => {
      const lx = wx - X0, lz = wz - Z0;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y >= HEIGHT) return;
      blocks[idx(lx, y, lz)] = id; meta[idx(lx, y, lz)] = m;
    };
    const get = (wx, y, wz) => {
      const lx = wx - X0, lz = wz - Z0;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y >= HEIGHT) return -1;
      return blocks[idx(lx, y, lz)];
    };
    const spawns = [], chests = [];
    const tops = new Int16Array(256).fill(-1);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const col = this.column(X0 + x, Z0 + z);
      if (!col) continue;
      const [b, t] = col;
      for (let y = Math.max(1, b); y <= t; y++) blocks[idx(x, y, z)] = B.duskstone;
      tops[z * 16 + x] = t;
    }
    // obsidian pillars with pylons on top
    for (const p of this.pillars) {
      if (p.x + p.r + 2 < X0 || p.x - p.r - 2 > X0 + 15 || p.z + p.r + 2 < Z0 || p.z - p.r - 2 > Z0 + 15) continue;
      for (let dz = -p.r; dz <= p.r; dz++) for (let dx = -p.r; dx <= p.r; dx++) {
        if (dx * dx + dz * dz > p.r * p.r + 1) continue;
        for (let y = 40; y <= p.h; y++) set(p.x + dx, y, p.z + dz, B.obsidian);
      }
      set(p.x, p.h + 1, p.z, B.bedrock);
      if (p.caged) {
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy <= 4; dy++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 4;
          if (edge) set(p.x + dx, p.h + 1 + dy, p.z + dz, B.iron_bars);
        }
      }
      if (p.x >= X0 && p.x < X0 + 16 && p.z >= Z0 && p.z < Z0 + 16) spawns.push({ type: 'pylon', x: p.x + 0.5, y: p.h + 2, z: p.z + 0.5 });
    }
    // exit fountain at the centre (inactive until the guardian falls)
    if (X0 <= 4 && X0 + 15 >= -4 && Z0 <= 4 && Z0 + 15 >= -4) {
      const top = this.fountainY();
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > 3.6) continue;
        set(dx, top - 1, dz, B.bedrock);
        if (d > 2.5) set(dx, top, dz, B.bedrock);
        else set(dx, top, dz, 0);
        for (let y = top + 1; y < top + 6; y++) set(dx, y, dz, 0);
      }
      for (let y = top; y < top + 4; y++) set(0, y, 0, B.bedrock);
      for (const [dx, dz, f] of [[1, 0, 2], [-1, 0, 3], [0, 1, 4], [0, -1, 5]]) set(dx, top + 2, dz, B.glow_rod, f);
    }
    // outer islands: void stalks and blooms
    const pr = rng(hash2(this.seed ^ 0x9a17, cx, cz));
    if (Math.hypot(X0 + 8, Z0 + 8) > OUTER_START) {
      const n = Math.floor(pr() * 4);
      for (let i = 0; i < n; i++) {
        const lx = 2 + Math.floor(pr() * 12), lz = 2 + Math.floor(pr() * 12);
        const t = tops[lz * 16 + lx];
        if (t < 0) continue;
        this.growStalk(X0 + lx, t + 1, Z0 + lz, pr, set, get);
      }
    }
    // astral spires
    const sc0 = Math.floor((X0 - 16) / SPIRE_CELL), sc1 = Math.floor((X0 + 31) / SPIRE_CELL);
    const sz0 = Math.floor((Z0 - 16) / SPIRE_CELL), sz1 = Math.floor((Z0 + 31) / SPIRE_CELL);
    for (let scz = sz0; scz <= sz1; scz++) for (let scx = sc0; scx <= sc1; scx++) {
      const s = this.spireIn(scx, scz);
      if (!s || s.x + 8 < X0 || s.x - 8 > X0 + 15 || s.z + 8 < Z0 || s.z - 8 > Z0 + 15) continue;
      this.buildSpire(s, set, chests, X0, Z0);
    }
    let maxY = 0;
    for (let y = HEIGHT - 1; y >= 0 && !maxY; y--) { const base = y << 8; for (let i = 0; i < 256; i++) if (blocks[base + i]) { maxY = y; break; } }
    return { blocks, meta, tints, maxY, spawns, chests, spawners: [] };
  }

  fountainY() { const c = this.column(0, 0); return c ? c[1] + 1 : 60; }

  growStalk(x, y, z, r, set, get) {
    const h = 2 + Math.floor(r() * 4);
    for (let i = 0; i < h; i++) set(x, y + i, z, B.void_stalk);
    // a side branch or two
    for (let b = 0; b < 2; b++) {
      if (r() < 0.5) continue;
      const [dx, dz] = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(r() * 4)];
      const by = y + 1 + Math.floor(r() * (h - 1));
      if (get(x + dx, by, z + dz) !== 0) continue;
      set(x + dx, by, z + dz, B.void_stalk);
      set(x + dx, by + 1, z + dz, B.void_stalk);
      set(x + dx, by + 2, z + dz, B.void_bloom);
    }
    set(x, y + h, z, B.void_bloom);
  }

  buildSpire(s, set, chests, X0, Z0) {
    const { x, y, z, h } = s;
    // a hollow square tower with a stair-step crown and a treasure room on top
    for (let dy = -2; dy < h; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const edge = Math.abs(dx) === 3 || Math.abs(dz) === 3;
      const corner = Math.abs(dx) === 3 && Math.abs(dz) === 3;
      if (dy < 0) { set(x + dx, y + dy, z + dz, B.astral_bricks); continue; }
      if (corner) set(x + dx, y + dy, z + dz, B.astral_pillar);
      else if (edge) set(x + dx, y + dy, z + dz, dy % 6 === 3 && (dx === 0 || dz === 0) ? B.glass : B.astral_bricks);
      else set(x + dx, y + dy, z + dz, dy === 0 || dy === h - 1 ? B.astral_bricks : 0);
    }
    // ladder up the inside
    for (let dy = 1; dy < h - 1; dy++) set(x, y + dy, z - 2, B.ladder, 3);
    set(x, y + h - 1, z - 2, 0);
    // doorway
    set(x, y + 1, z + 3, 0); set(x, y + 2, z + 3, 0);
    // crown
    const top = y + h;
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      const edge = Math.abs(dx) === 4 || Math.abs(dz) === 4;
      set(x + dx, top - 1, z + dz, edge ? B.astral_pillar : B.astral_bricks);
      if (edge && (dx + dz) % 2 === 0) set(x + dx, top, z + dz, B.astral_bricks);
    }
    set(x, top - 1, z - 2, 0);
    for (const [dx, dz, f] of [[2, 2, 0], [-2, 2, 0], [2, -2, 0], [-2, -2, 0]]) set(x + dx, top, z + dz, B.glow_rod, f);
    // treasure: chests in the top room
    for (const [dx, dz, m] of [[2, 0, 3], [-2, 0, 2]]) {
      const cxw = x + dx, czw = z + dz, cy = y + h - 2;
      set(cxw, cy, czw, B.chest, m);
      if (cxw >= X0 && cxw < X0 + 16 && czw >= Z0 && czw < Z0 + 16) chests.push({ x: cxw, y: cy, z: czw, loot: dx > 0 ? 'spire_glider' : 'spire' });
    }
  }
}
