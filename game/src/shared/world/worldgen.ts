/**
 * Deterministic world generation. Given (seed, WORLDGEN_VERSION) every machine
 * produces the identical logical world: island layout, terrain heights, biomes,
 * resource node placement, wrecks, caves and creature spawn zones.
 *
 * Authoritative *mutable* state (node depletion, containers, structures...) is
 * owned by the server simulation; this module only describes the pristine world.
 */
import { WORLD, WORLDGEN_VERSION } from '../config';
import { Rng, hashInts, hash01, hashString } from '../math/rng';
import { Simplex2 } from '../math/noise';
import { clamp, smoothstep, lerp } from '../math/vec';
import { NODES } from '../defs/nodes';
import type { CreatureKind } from '../defs/types';
import { islandName } from './names';

export type IslandArchetype = 'start' | 'atoll' | 'sandbar' | 'rocky' | 'jungle' | 'volcanic';

export interface Island {
  id: number;
  name: string;
  x: number;
  z: number;
  radius: number;
  maxHeight: number;
  archetype: IslandArchetype;
  seed: number;
}

export type Biome = 'deep' | 'ocean' | 'reef' | 'shallows' | 'beach' | 'grass' | 'jungle' | 'rock' | 'peak' | 'volcanic' | 'lagoon';

export interface NodeSpawn {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: number;
}

export interface Wreck {
  id: string;
  kind: 'shallow' | 'deep';
  x: number;
  y: number;
  z: number;
  yaw: number;
  islandId: number;
  /** crate positions (world space) */
  crates: { id: string; x: number; y: number; z: number }[];
}

export interface Cave {
  id: string;
  islandId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** collision spheres forming the rock shell */
  rocks: { x: number; y: number; z: number; r: number }[];
  crate: { id: string; x: number; y: number; z: number };
}

export interface SpawnZone {
  id: string;
  kind: CreatureKind;
  x: number;
  z: number;
  radius: number;
  count: number;
  islandId: number;
}

interface ArchetypeProfile {
  heightRange: [number, number];
  radiusRange: [number, number];
  detailAmp: number;
  ridged: number;
  nodeDensity: Record<string, number>; // per 100 m^2 of matching biome, keyed `${biome}:${nodeType}`
}

const P = (o: Record<string, number>) => o;

const ARCHETYPES: Record<IslandArchetype, ArchetypeProfile> = {
  start: {
    heightRange: [16, 20], radiusRange: [WORLD.startIslandRadius, WORLD.startIslandRadius], detailAmp: 3, ridged: 0.15,
    nodeDensity: P({
      'beach:palm': 0.5, 'beach:loose_stone': 0.5, 'beach:loose_stick': 0.6, 'beach:beach_shell': 0.6, 'beach:driftwood': 0.15, 'beach:fallen_coconut': 0.3,
      'grass:palm': 0.7, 'grass:fiber_bush': 1.0, 'grass:berry_bush': 0.18, 'grass:rock': 0.15, 'grass:loose_stick': 0.5, 'grass:loose_stone': 0.3, 'grass:wild_aloe': 0.08, 'grass:wild_flax': 0.1,
      'jungle:hardwood': 0.35, 'jungle:palm': 0.35, 'jungle:fiber_bush': 1.0, 'jungle:wild_taro': 0.12, 'jungle:clay_bank': 0.05,
      'rock:rock': 0.6, 'rock:clay_bank': 0.12, 'rock:loose_stone': 0.5,
      'reef:coral': 0.4, 'reef:kelp': 0.5, 'reef:oyster': 0.08, 'shallows:kelp': 0.15, 'shallows:loose_stone': 0.1,
    }),
  },
  atoll: {
    heightRange: [5, 8], radiusRange: [150, 230], detailAmp: 1.2, ridged: 0,
    nodeDensity: P({
      'beach:palm': 0.8, 'beach:fallen_coconut': 0.5, 'beach:beach_shell': 0.9, 'beach:driftwood': 0.25, 'beach:loose_stick': 0.5,
      'grass:palm': 1.2, 'grass:fiber_bush': 0.8, 'grass:berry_bush': 0.25, 'grass:wild_flax': 0.15,
      'lagoon:coral': 0.6, 'lagoon:kelp': 0.4, 'lagoon:oyster': 0.25, 'reef:coral': 0.7, 'reef:kelp': 0.6, 'reef:oyster': 0.15,
    }),
  },
  sandbar: {
    heightRange: [2, 3.5], radiusRange: [55, 95], detailAmp: 0.5, ridged: 0,
    nodeDensity: P({ 'beach:palm': 0.15, 'beach:beach_shell': 1.0, 'beach:driftwood': 0.5, 'beach:loose_stick': 0.2, 'grass:fiber_bush': 0.4, 'reef:coral': 0.3, 'reef:kelp': 0.4 }),
  },
  rocky: {
    heightRange: [24, 34], radiusRange: [130, 200], detailAmp: 6, ridged: 0.6,
    nodeDensity: P({
      'beach:loose_stone': 1.0, 'beach:beach_shell': 0.3, 'beach:driftwood': 0.2,
      'grass:fiber_bush': 0.5, 'grass:palm': 0.2, 'grass:rock': 0.4, 'grass:wild_aloe': 0.15, 'grass:clay_bank': 0.08,
      'rock:rock': 0.9, 'rock:iron_vein': 0.15, 'rock:clay_bank': 0.2, 'rock:loose_stone': 0.6,
      'peak:rock': 0.5, 'peak:iron_vein': 0.25,
      'reef:coral': 0.3, 'reef:kelp': 0.6, 'reef:oyster': 0.1,
    }),
  },
  jungle: {
    heightRange: [18, 26], radiusRange: [170, 260], detailAmp: 4, ridged: 0.25,
    nodeDensity: P({
      'beach:palm': 0.6, 'beach:fallen_coconut': 0.3, 'beach:loose_stick': 0.5, 'beach:beach_shell': 0.4,
      'grass:palm': 0.6, 'grass:fiber_bush': 1.2, 'grass:berry_bush': 0.35, 'grass:wild_taro': 0.2, 'grass:wild_aloe': 0.15,
      'jungle:hardwood': 0.9, 'jungle:palm': 0.4, 'jungle:fiber_bush': 1.4, 'jungle:wild_taro': 0.3, 'jungle:berry_bush': 0.2, 'jungle:clay_bank': 0.08, 'jungle:loose_stick': 0.6,
      'rock:rock': 0.5, 'rock:clay_bank': 0.15,
      'reef:coral': 0.4, 'reef:kelp': 0.4,
    }),
  },
  volcanic: {
    heightRange: [40, 55], radiusRange: [150, 210], detailAmp: 5, ridged: 0.8,
    nodeDensity: P({
      'beach:loose_stone': 0.8, 'beach:driftwood': 0.2,
      'grass:fiber_bush': 0.3, 'grass:palm': 0.15,
      'rock:rock': 0.5, 'rock:iron_vein': 0.3, 'rock:obsidian_rock': 0.25,
      'volcanic:obsidian_rock': 0.45, 'volcanic:iron_vein': 0.3, 'peak:obsidian_rock': 0.3,
      'reef:coral': 0.2, 'reef:kelp': 0.3,
    }),
  },
};

const CANDIDATE_CELL = 4; // meters between candidate node positions

export class WorldGen {
  readonly seed: number;
  readonly islands: Island[] = [];
  readonly wrecks: Wreck[] = [];
  readonly caves: Cave[] = [];
  readonly spawnZones: SpawnZone[] = [];
  readonly half = WORLD.size / 2;
  private noise: Simplex2;
  private detail: Simplex2;
  private warp: Simplex2;
  private nodeCache = new Map<string, NodeSpawn[]>();
  private islandGrid = new Map<string, Island[]>();
  private readonly islandCell = 600;

  constructor(seed: number | string) {
    this.seed = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    this.noise = new Simplex2(hashInts(this.seed, 1));
    this.detail = new Simplex2(hashInts(this.seed, 2));
    this.warp = new Simplex2(hashInts(this.seed, 3));
    this.placeIslands();
    for (const isl of this.islands) this.indexIsland(isl);
    this.placeWrecks();
    this.placeCaves();
    this.placeSpawnZones();
  }

  /** Hash summarizing the logical world; clients verify it on join. */
  fingerprint(): number {
    let h = hashInts(this.seed, WORLDGEN_VERSION);
    for (const i of this.islands) h = hashInts(h, Math.round(i.x), Math.round(i.z), Math.round(i.radius), hashString(i.archetype));
    for (const w of this.wrecks) h = hashInts(h, Math.round(w.x), Math.round(w.z));
    h = hashInts(h, Math.round(this.heightAt(13.37, -42.1) * 1000), Math.round(this.heightAt(-500.5, 220.25) * 1000));
    return h >>> 0;
  }

  // ------------------------------------------------------------------ layout
  private placeIslands(): void {
    const rng = new Rng(hashInts(this.seed, 100));
    const start: Island = {
      id: 0, name: '', x: 0, z: 0, radius: WORLD.startIslandRadius, maxHeight: rng.range(...ARCHETYPES.start.heightRange),
      archetype: 'start', seed: hashInts(this.seed, 1000),
    };
    start.name = islandName(rng.fork('name0'), 'start');
    this.islands.push(start);

    // guarantee at least one of each archetype, then random
    const order: IslandArchetype[] = ['sandbar', 'atoll', 'rocky', 'jungle', 'volcanic', 'sandbar', 'atoll', 'jungle', 'rocky'];
    const margin = 450;
    let attempts = 0;
    while (this.islands.length < WORLD.islandCount && attempts < 5000) {
      attempts++;
      const idx = this.islands.length;
      const arch: IslandArchetype = idx - 1 < order.length ? order[idx - 1]! : rng.pick(['sandbar', 'atoll', 'rocky', 'jungle', 'volcanic'] as const);
      const prof = ARCHETYPES[arch];
      const radius = rng.range(...prof.radiusRange);
      // nearer islands for early archetypes so the first voyage is reachable
      const maxDist = idx <= 3 ? 1150 : this.half - margin;
      const ang = rng.range(0, Math.PI * 2);
      const d = rng.range(idx <= 3 ? 560 : 700, maxDist);
      const x = Math.cos(ang) * d;
      const z = Math.sin(ang) * d;
      if (Math.abs(x) > this.half - margin || Math.abs(z) > this.half - margin) continue;
      let ok = true;
      for (const o of this.islands) {
        if (Math.hypot(o.x - x, o.z - z) < WORLD.islandMinSpacing + (o.radius + radius) * 0.6) { ok = false; break; }
      }
      if (!ok) continue;
      this.islands.push({
        id: idx, name: islandName(rng.fork(`name${idx}`), arch), x, z, radius, maxHeight: rng.range(...prof.heightRange), archetype: arch,
        seed: hashInts(this.seed, 1000 + idx),
      });
    }
  }

  private indexIsland(isl: Island): void {
    const reach = isl.radius * 2.2;
    const c0x = Math.floor((isl.x - reach) / this.islandCell), c1x = Math.floor((isl.x + reach) / this.islandCell);
    const c0z = Math.floor((isl.z - reach) / this.islandCell), c1z = Math.floor((isl.z + reach) / this.islandCell);
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const k = `${cx},${cz}`;
      let arr = this.islandGrid.get(k);
      if (!arr) { arr = []; this.islandGrid.set(k, arr); }
      arr.push(isl);
    }
  }

  private islandsNear(x: number, z: number): Island[] {
    return this.islandGrid.get(`${Math.floor(x / this.islandCell)},${Math.floor(z / this.islandCell)}`) ?? EMPTY;
  }

  nearestIsland(x: number, z: number): { island: Island; dist: number } {
    let best = this.islands[0]!;
    let bd = Infinity;
    for (const i of this.islands) {
      const d = Math.hypot(i.x - x, i.z - z) - i.radius;
      if (d < bd) { bd = d; best = i; }
    }
    return { island: best, dist: bd };
  }

  // ------------------------------------------------------------------ terrain
  /** Normalized island distance with organic coastline warp (1 == shoreline). */
  private islandD(isl: Island, x: number, z: number): number {
    const dx = x - isl.x, dz = z - isl.z;
    const dist = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx);
    const s = isl.seed % 997;
    const wobble = 1
      + 0.22 * this.warp.noise(Math.cos(ang) * 1.3 + s, Math.sin(ang) * 1.3 - s)
      + 0.08 * this.warp.noise(Math.cos(ang) * 4 + s * 2, Math.sin(ang) * 4)
      + 0.06 * this.warp.noise(x * 0.01, z * 0.01);
    return dist / (isl.radius * wobble);
  }

  private islandHeight(isl: Island, x: number, z: number): number {
    const d = this.islandD(isl, x, z);
    const prof = ARCHETYPES[isl.archetype];
    let lagoon = 0;
    let t = 1 - d; // >0 on land
    if (isl.archetype === 'atoll' && d < 1) {
      // ring of land between d=0.62..1 with a shallow lagoon inside
      if (d >= 0.62) t = (1 - Math.abs(d - 0.81) / 0.19) * 0.45;
      else { t = -0.05; lagoon = smoothstep(0.62, 0.5, d); }
    }
    let h: number;
    if (t > 0) {
      const core = Math.pow(smoothstep(0, 1, t), isl.archetype === 'volcanic' ? 1.6 : 1.25);
      const berm = 1.3 * smoothstep(0, 0.1, t);
      const nx = x * 0.012, nz = z * 0.012;
      const rough = this.noise.fbm(nx + isl.seed % 101, nz, 4) * (1 - prof.ridged) + this.noise.ridged(nx * 0.8, nz * 0.8, 4) * prof.ridged * 1.6;
      const detail = this.detail.fbm(x * 0.06, z * 0.06, 3) * 0.6;
      const landMask = smoothstep(0.02, 0.3, t);
      h = 0.4 + berm + core * isl.maxHeight + rough * prof.detailAmp * landMask + detail * landMask;
      if (isl.archetype === 'volcanic') {
        const crater = smoothstep(0.82, 0.95, t);
        h -= crater * isl.maxHeight * 0.25;
      }
    } else {
      const u = -t; // distance beyond shore, normalized
      const shelfDepth = isl.archetype === 'atoll' || isl.archetype === 'start' ? 4.5 : 6;
      const shelf = lerp(0.6, shelfDepth, smoothstep(0, 0.32, u));
      const drop = smoothstep(0.3, 1.0, u);
      h = -lerp(shelf, -WORLD.oceanFloor, drop);
      h += this.detail.fbm(x * 0.05, z * 0.05, 3) * 0.8 * (1 - drop * 0.5);
    }
    if (lagoon > 0) h = lerp(h, -2.2 + this.detail.noise(x * 0.04, z * 0.04) * 0.6, lagoon);
    return h;
  }

  /** Base ocean floor away from any island. */
  private oceanFloorAt(x: number, z: number): number {
    return WORLD.oceanFloor + this.noise.fbm(x * 0.002, z * 0.002, 3) * 10 + this.detail.noise(x * 0.02, z * 0.02) * 1.5;
  }

  /** Authoritative terrain height (meters, sea level = 0). */
  heightAt(x: number, z: number): number {
    let h = this.oceanFloorAt(x, z);
    const near = this.islandsNear(x, z);
    for (let i = 0; i < near.length; i++) {
      const isl = near[i]!;
      const dx = x - isl.x, dz = z - isl.z;
      if (dx * dx + dz * dz > (isl.radius * 2.1) ** 2) continue;
      const ih = this.islandHeight(isl, x, z);
      if (ih > h) h = ih;
    }
    // world edge: deepen to discourage leaving the playable sea
    const edge = Math.max(Math.abs(x), Math.abs(z));
    if (edge > this.half - 200) h -= smoothstep(this.half - 200, this.half, edge) * 30;
    return h;
  }

  normalAt(x: number, z: number): [number, number, number] {
    const e = 0.75;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
  }

  islandAt(x: number, z: number): Island | null {
    let best: Island | null = null;
    let bd = Infinity;
    for (const isl of this.islandsNear(x, z)) {
      const d = this.islandD(isl, x, z);
      if (d < 1.9 && d < bd) { bd = d; best = isl; }
    }
    return best;
  }

  biomeAt(x: number, z: number, hIn?: number): Biome {
    const h = hIn ?? this.heightAt(x, z);
    const isl = this.islandAt(x, z);
    if (h < -16) return 'deep';
    if (!isl) return h < -8 ? 'ocean' : 'shallows';
    if (h < -0.4) {
      if (isl.archetype === 'atoll' && this.islandD(isl, x, z) < 0.62) return 'lagoon';
      if (h > -10) return h > -1.6 ? 'shallows' : 'reef';
      return 'ocean';
    }
    if (h < 1.9) return 'beach';
    const n = this.normalAt(x, z);
    const slope = 1 - n[1];
    const relH = h / Math.max(4, isl.maxHeight);
    if (isl.archetype === 'volcanic' && relH > 0.45) return relH > 0.8 ? 'peak' : 'volcanic';
    if (relH > 0.82 && isl.maxHeight > 12) return 'peak';
    if (slope > 0.32) return 'rock';
    const veg = this.noise.noise(x * 0.008 + 50, z * 0.008 - 50);
    if (isl.archetype === 'rocky') return veg > 0.25 ? 'grass' : 'rock';
    if (isl.archetype === 'jungle') return veg > -0.35 ? 'jungle' : 'grass';
    if (isl.archetype === 'start') return veg > 0.2 && relH > 0.25 ? 'jungle' : relH > 0.6 && veg < -0.3 ? 'rock' : 'grass';
    if (isl.archetype === 'volcanic') return 'rock';
    return 'grass';
  }

  // ------------------------------------------------------------------ nodes
  chunkKey(cx: number, cz: number): string { return `${cx},${cz}`; }

  /** Resource nodes for a chunk; cached, pure function of seed. */
  nodesInChunk(cx: number, cz: number): NodeSpawn[] {
    const key = this.chunkKey(cx, cz);
    const cached = this.nodeCache.get(key);
    if (cached) return cached;
    const out: NodeSpawn[] = [];
    const cs = 64;
    const x0 = cx * cs, z0 = cz * cs;
    // quick reject: is chunk near any island?
    const near = this.islandsNear(x0 + cs / 2, z0 + cs / 2);
    let relevant = false;
    for (const isl of near) if (Math.hypot(isl.x - (x0 + cs / 2), isl.z - (z0 + cs / 2)) < isl.radius * 1.75 + cs) { relevant = true; break; }
    if (relevant) {
      const n = cs / CANDIDATE_CELL;
      let idx = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const hseed = hashInts(this.seed, cx, cz, i, j);
        const x = x0 + (i + hash01(hseed, 1)) * CANDIDATE_CELL;
        const z = z0 + (j + hash01(hseed, 2)) * CANDIDATE_CELL;
        const h = this.heightAt(x, z);
        const isl = this.islandAt(x, z);
        if (!isl) continue;
        const biome = this.biomeAt(x, z, h);
        const prof = ARCHETYPES[isl.archetype].nodeDensity;
        // pick one node type with probability = density * cellArea/100
        const cellArea = CANDIDATE_CELL * CANDIDATE_CELL;
        let r = hash01(hseed, 3);
        for (const k in prof) {
          const sep = k.indexOf(':');
          if (k.slice(0, sep) !== biome) continue;
          const p = prof[k]! * cellArea / 100;
          if (r < p) {
            const type = k.slice(sep + 1);
            const def = NODES[type]!;
            if (def.underwater && h > -0.8) break;
            if (!def.underwater && h < 0.15) break;
            out.push({ id: `${cx}.${cz}.${idx++}`, type, x, y: h, z, rot: hash01(hseed, 4) * Math.PI * 2, scale: 0.8 + hash01(hseed, 5) * 0.45 });
            break;
          }
          r -= p;
        }
      }
    }
    // wreck debris
    for (const w of this.wrecks) {
      if (Math.floor(w.x / cs) !== cx || Math.floor(w.z / cs) !== cz) continue;
      const rr = new Rng(hashInts(this.seed, hashString(w.id), 9));
      for (let k = 0; k < 4; k++) {
        const a = rr.range(0, Math.PI * 2), d = rr.range(5, 11);
        const x = w.x + Math.cos(a) * d, z = w.z + Math.sin(a) * d;
        out.push({ id: `${w.id}.d${k}`, type: 'scrap_pile', x, y: this.heightAt(x, z), z, rot: rr.range(0, 6.28), scale: rr.range(0.8, 1.2) });
      }
    }
    this.nodeCache.set(key, out);
    return out;
  }

  nodesInRadius(x: number, z: number, r: number, out: NodeSpawn[] = []): NodeSpawn[] {
    const cs = 64;
    const c0x = Math.floor((x - r) / cs), c1x = Math.floor((x + r) / cs);
    const c0z = Math.floor((z - r) / cs), c1z = Math.floor((z + r) / cs);
    const r2 = r * r;
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      for (const n of this.nodesInChunk(cx, cz)) {
        const dx = n.x - x, dz = n.z - z;
        if (dx * dx + dz * dz <= r2) out.push(n);
      }
    }
    return out;
  }

  /** Lookup node by id (id encodes its chunk). */
  nodeById(id: string): NodeSpawn | undefined {
    const parts = id.split('.');
    if (parts[0] === 'wreck') {
      const w = this.wrecks.find((wr) => id.startsWith(wr.id + '.'));
      if (!w) return undefined;
      return this.nodesInChunk(Math.floor(w.x / 64), Math.floor(w.z / 64)).find((n) => n.id === id);
    }
    const cx = Number(parts[0]), cz = Number(parts[1]);
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return undefined;
    return this.nodesInChunk(cx, cz).find((n) => n.id === id);
  }

  // ------------------------------------------------------------------ landmarks
  private findShorePoint(isl: Island, rng: Rng, minH: number, maxH: number, tries = 200): { x: number; z: number; h: number } | null {
    for (let i = 0; i < tries; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = isl.radius * rng.range(0.5, 1.9);
      const x = isl.x + Math.cos(a) * d, z = isl.z + Math.sin(a) * d;
      const h = this.heightAt(x, z);
      if (h >= minH && h <= maxH) return { x, z, h };
    }
    return null;
  }

  private placeWrecks(): void {
    const rng = new Rng(hashInts(this.seed, 200));
    let n = 0;
    // shallow wrecks around most islands
    for (const isl of this.islands) {
      if (isl.archetype === 'sandbar' && !rng.chance(0.6)) continue;
      const p = this.findShorePoint(isl, rng, -9, -3);
      if (!p) continue;
      this.addWreck(`wreck${n++}`, 'shallow', p.x, p.h, p.z, rng.range(0, Math.PI * 2), isl.id, rng);
    }
    // deep wrecks: at least 3, away from start island
    const far = this.islands.filter((i) => i.id !== 0).sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z));
    let deep = 0;
    for (const isl of far) {
      if (deep >= 3) break;
      const p = this.findShorePoint(isl, rng, -34, -18, 400);
      if (!p) continue;
      this.addWreck(`wreck${n++}`, 'deep', p.x, p.h, p.z, rng.range(0, Math.PI * 2), isl.id, rng);
      deep++;
    }
  }

  private addWreck(id: string, kind: 'shallow' | 'deep', x: number, y: number, z: number, yaw: number, islandId: number, rng: Rng) {
    const crates: Wreck['crates'] = [];
    const count = kind === 'deep' ? 2 : rng.int(1, 2);
    for (let i = 0; i < count; i++) {
      const lx = rng.range(-1.2, 1.2), lz = (i - (count - 1) / 2) * 4;
      const cx = x + Math.cos(yaw) * lx - Math.sin(yaw) * lz;
      const cz = z + Math.sin(yaw) * lx + Math.cos(yaw) * lz;
      crates.push({ id: `${id}.crate${i}`, x: cx, y: this.heightAt(cx, cz) + 0.6, z: cz });
    }
    this.wrecks.push({ id, kind, x, y, z, yaw, islandId, crates });
  }

  private placeCaves(): void {
    const rng = new Rng(hashInts(this.seed, 300));
    for (const isl of this.islands) {
      if (isl.archetype !== 'rocky' && isl.archetype !== 'volcanic' && isl.archetype !== 'jungle') continue;
      const p = this.findShorePoint(isl, rng, 3, isl.maxHeight * 0.5, 300);
      if (!p) continue;
      const yaw = Math.atan2(p.z - isl.z, p.x - isl.x); // opening faces outwards
      const rocks: Cave['rocks'] = [];
      const len = 14, width = 3.4;
      // two side walls and a roof made of overlapping boulders
      for (let s = 0; s <= len; s += 2.2) {
        for (const side of [-1, 1]) {
          const lx = -s, lz = side * (width + 1.6);
          rocks.push(this.caveRock(p, yaw, lx, lz, 2.1 + rng.range(0, 0.6)));
          rocks.push(this.caveRock(p, yaw, lx, lz * 0.85, 2.2 + rng.range(0, 0.4), 3.2));
        }
        rocks.push(this.caveRock(p, yaw, -s, 0, 2.6 + rng.range(0, 0.4), 5.2));
      }
      rocks.push(this.caveRock(p, yaw, -len - 2.4, 0, 3.4, 1.6)); // back wall
      const back = this.caveLocal(p, yaw, -len + 1.5, 0);
      this.caves.push({
        id: `cave${isl.id}`, islandId: isl.id, x: p.x, y: p.h, z: p.z, yaw, rocks,
        crate: { id: `cave${isl.id}.crate`, x: back.x, y: this.heightAt(back.x, back.z) + 0.5, z: back.z },
      });
    }
  }

  private caveLocal(p: { x: number; z: number }, yaw: number, lx: number, lz: number) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: p.x + c * lx - s * lz, z: p.z + s * lx + c * lz };
  }

  private caveRock(p: { x: number; z: number; h: number }, yaw: number, lx: number, lz: number, r: number, up = 0.8) {
    const w = this.caveLocal(p, yaw, lx, lz);
    return { x: w.x, y: this.heightAt(w.x, w.z) + up, z: w.z, r };
  }

  private placeSpawnZones(): void {
    const rng = new Rng(hashInts(this.seed, 400));
    let n = 0;
    const add = (kind: CreatureKind, isl: Island, minH: number, maxH: number, radius: number, count: number) => {
      const p = this.findShorePoint(isl, rng, minH, maxH, 300);
      if (p) this.spawnZones.push({ id: `z${n++}`, kind, x: p.x, z: p.z, radius, count, islandId: isl.id });
    };
    for (const isl of this.islands) {
      const big = isl.radius / 200;
      const zones = Math.max(1, Math.round(3 * big));
      for (let i = 0; i < zones; i++) add('crab', isl, 0.3, 2.2, 18, 3);
      for (let i = 0; i < Math.max(1, Math.round(2 * big)); i++) add('fish', isl, -7, -1.5, 14, 6);
      if (isl.archetype !== 'sandbar') add('ray', isl, -6, -2, 16, 1);
      if (isl.archetype === 'jungle') { for (let i = 0; i < 3; i++) add('boar', isl, 4, 20, 30, 2); for (let i = 0; i < 3; i++) add('snake', isl, 3, 18, 18, 2); }
      if (isl.archetype === 'start') { add('boar', isl, 8, 16, 26, 1); add('snake', isl, 4, 14, 14, 1); }
      if (isl.archetype === 'rocky' || isl.archetype === 'volcanic') add('snake', isl, 4, 20, 16, 2);
      if (isl.archetype !== 'start') add('shark', isl, -30, -12, 45, isl.archetype === 'sandbar' ? 2 : 1);
      add('gull', isl, 1, 8, 30, 3);
    }
    // the start island's outer reef gets a single shark (danger beyond the shelf)
    const start = this.islands[0]!;
    add('shark', start, -32, -16, 50, 1);
  }

  // ------------------------------------------------------------------ helpers
  spawnPoint(index: number): { x: number; y: number; z: number } {
    const isl = this.islands[0]!;
    const rng = new Rng(hashInts(this.seed, 500));
    const base = this.findShorePoint(isl, rng, 1.2, 2.8, 500) ?? { x: isl.x, z: isl.z + isl.radius * 0.8, h: 2 };
    const a = index * 1.7;
    const x = base.x + Math.cos(a) * 2.5 * Math.min(1, index), z = base.z + Math.sin(a) * 2.5 * Math.min(1, index);
    return { x, y: this.heightAt(x, z) + 0.05, z };
  }

  isLand(x: number, z: number): boolean {
    return this.heightAt(x, z) > 0;
  }
}

const EMPTY: Island[] = [];
