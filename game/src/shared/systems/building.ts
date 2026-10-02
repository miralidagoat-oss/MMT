/**
 * Modular building rules: snapping (used by the client preview), and validation,
 * support and stability (authoritative on the server). Both sides share this file
 * so the preview predicts exactly what the server will accept.
 */
import { BUILD } from '../config';
import { STRUCTURES } from '../defs/structures';
import { VEHICLES } from '../defs/vehicles';
import type { StructureDef } from '../defs/types';
import type { StructureState } from '../state';
import type { CollisionWorld } from '../world/collision';
import type { WorldGen } from '../world/worldgen';

const G = BUILD.grid;
const HALF = G / 2;
const WH = BUILD.wallHeight;
const EPS = 0.3;

export interface Placement { x: number; y: number; z: number; yaw: number; snapped: boolean; valid: boolean; reason?: string }

export interface BuildContext {
  structures: Record<string, StructureState>;
  col: CollisionWorld;
  gen: WorldGen;
  waterLevel: (x: number, z: number) => number;
}

function local(s: { x: number; z: number; yaw: number }, lx: number, lz: number) {
  const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  return { x: s.x + c * lx + n * lz, z: s.z - n * lx + c * lz };
}

function toLocal(s: { x: number; z: number; yaw: number }, x: number, z: number) {
  const dx = x - s.x, dz = z - s.z;
  const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  return { lx: c * dx - n * dz, lz: n * dx + c * dz };
}

function topOf(s: StructureState): number {
  const def = STRUCTURES[s.type]!;
  return s.y + def.size[1];
}

const isBase = (d: StructureDef | undefined) => !!d && (d.category === 'foundation');
const isFloorLike = (d: StructureDef | undefined) => !!d && (d.category === 'foundation' || d.category === 'floor');
const isWall = (d: StructureDef | undefined) => !!d && d.category === 'wall';

function nearby(ctx: BuildContext, x: number, z: number, r: number): StructureState[] {
  const out: StructureState[] = [];
  for (const s of Object.values(ctx.structures)) if (Math.abs(s.x - x) < r && Math.abs(s.z - z) < r) out.push(s);
  return out;
}

function angDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Terrain footprint stats for a grid-sized piece. */
function footprint(ctx: BuildContext, x: number, z: number, yaw: number, hx: number, hz: number) {
  let min = Infinity, max = -Infinity;
  for (const [lx, lz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz], [0, 0]] as const) {
    const p = local({ x, z, yaw }, lx, lz);
    const h = ctx.gen.heightAt(p.x, p.z);
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max };
}

/**
 * Compute a snapped placement for `defId` aimed at `aim` (point the player looks at).
 * `rot` is the player's chosen rotation in radians (applied for free/grid placement).
 */
export function computePlacement(ctx: BuildContext, defId: string, aim: { x: number; y: number; z: number }, rot: number): Placement {
  const def = STRUCTURES[defId];
  if (!def) return { x: aim.x, y: aim.y, z: aim.z, yaw: rot, snapped: false, valid: false, reason: 'Unknown blueprint' };
  let pl: Placement = { x: aim.x, y: aim.y, z: aim.z, yaw: rot, snapped: false, valid: true };
  const near = nearby(ctx, aim.x, aim.z, 7);

  switch (def.snap) {
    case 'grid': {
      // snap to neighbouring foundation cell
      let best: Placement | null = null;
      let bd = Infinity;
      for (const s of near) {
        const sd = STRUCTURES[s.type];
        if (!isBase(sd) && !(def.category === 'stairs' && isFloorLike(sd))) continue;
        const { lx, lz } = toLocal(s, aim.x, aim.z);
        const gx = Math.round(lx / G), gz = Math.round(lz / G);
        const cands: [number, number][] = def.category === 'stairs' ? [[gx, gz]] : [[gx, gz]];
        for (const [cx, cz] of cands) {
          if (def.category !== 'stairs' && cx === 0 && cz === 0) continue;
          if (Math.abs(cx) + Math.abs(cz) !== 1 && def.category !== 'stairs') continue;
          const p = local(s, cx * G, cz * G);
          const d = Math.hypot(p.x - aim.x, p.z - aim.z);
          if (d < bd && d < G) {
            bd = d;
            const y = def.category === 'stairs' ? topOf(s) : s.y;
            best = { x: p.x, y, z: p.z, yaw: def.category === 'stairs' ? s.yaw + Math.round(angDiff(rot, s.yaw) / (Math.PI / 2)) * (Math.PI / 2) : s.yaw, snapped: true, valid: true };
          }
        }
      }
      if (best) { pl = best; break; }
      if (def.category === 'stairs') { pl.valid = false; pl.reason = 'Stairs must be placed on a foundation or floor'; break; }
      const water = ctx.waterLevel(aim.x, aim.z);
      const fp = footprint(ctx, aim.x, aim.z, rot, def.size[0], def.size[2]);
      if (def.allowWater && fp.max < 0.6) pl.y = Math.max(fp.max, 0) + 1.2;
      else pl.y = fp.max - 0.12;
      void water;
      break;
    }
    case 'edge': {
      let best: Placement | null = null;
      let bd = Infinity;
      for (const s of near) {
        const sd = STRUCTURES[s.type];
        const edges: { lx: number; lz: number; yaw: number; y: number }[] = [];
        if (isFloorLike(sd)) {
          const y = topOf(s);
          edges.push({ lx: 0, lz: HALF, yaw: s.yaw, y }, { lx: 0, lz: -HALF, yaw: s.yaw, y },
            { lx: HALF, lz: 0, yaw: s.yaw + Math.PI / 2, y }, { lx: -HALF, lz: 0, yaw: s.yaw + Math.PI / 2, y });
        } else if (isWall(sd) && def.category === 'wall') {
          edges.push({ lx: 0, lz: 0, yaw: s.yaw, y: s.y + WH });
        }
        for (const e of edges) {
          const p = local(s, e.lx, e.lz);
          const d = Math.hypot(p.x - aim.x, p.z - aim.z) + Math.abs(e.y - aim.y) * 0.3;
          if (d < bd && d < 2.2) { bd = d; best = { x: p.x, y: e.y, z: p.z, yaw: e.yaw, snapped: true, valid: true }; }
        }
      }
      if (best) { pl = best; break; }
      if (def.needsSupport) { pl.valid = false; pl.reason = 'Walls must snap to a foundation, floor or wall'; break; }
      pl.y = ctx.col.ground(aim.x, aim.z, aim.y + 1).h;
      break;
    }
    case 'top': {
      let best: Placement | null = null;
      let bd = Infinity;
      for (const s of near) {
        const sd = STRUCTURES[s.type];
        const cands: { x: number; z: number; y: number; yaw: number }[] = [];
        if (isFloorLike(sd)) {
          // cell above this foundation/floor
          cands.push({ ...local(s, 0, 0), y: topOf(s) + WH, yaw: s.yaw });
          if (sd!.category === 'floor' && def.category === 'floor') {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cands.push({ ...local(s, dx! * G, dz! * G), y: s.y, yaw: s.yaw });
          }
        }
        if (isWall(sd)) {
          // either side of a wall at its top
          for (const side of [1, -1]) cands.push({ ...local(s, 0, side * HALF), y: s.y + WH, yaw: s.yaw });
        }
        for (const c of cands) {
          const d = Math.hypot(c.x - aim.x, c.z - aim.z) + Math.abs(c.y - aim.y) * 0.25;
          if (d < bd && d < 2.6) { bd = d; best = { x: c.x, y: c.y, z: c.z, yaw: c.yaw, snapped: true, valid: true }; }
        }
      }
      if (best) {
        // dedupe: snap to the existing cell grid of nearby floors at that level
        pl = best;
        break;
      }
      pl.valid = false;
      pl.reason = 'Needs walls or a floor to rest on';
      break;
    }
    case 'doorway': {
      let best: Placement | null = null;
      let bd = Infinity;
      for (const s of near) {
        if (!s.type.endsWith('_doorway')) continue;
        const d = Math.hypot(s.x - aim.x, s.z - aim.z);
        if (d < bd && d < 2.5) { bd = d; best = { x: s.x, y: s.y, z: s.z, yaw: s.yaw, snapped: true, valid: true }; }
      }
      if (best) pl = best;
      else { pl.valid = false; pl.reason = 'Doors fit into a doorway'; }
      break;
    }
    case 'water': {
      const vdef = def.vehicle ? VEHICLES[def.vehicle] : undefined;
      const depth = -ctx.gen.heightAt(aim.x, aim.z);
      pl.y = ctx.waterLevel(aim.x, aim.z);
      if (!vdef || depth < vdef.draft + 0.5) { pl.valid = false; pl.reason = 'Build boats in water at least waist deep'; }
      break;
    }
    case 'free':
    default: {
      pl.y = ctx.col.ground(aim.x, aim.z, aim.y + 0.6).h;
      break;
    }
  }
  if (pl.valid) {
    const err = validateGeometry(ctx, def, pl.x, pl.y, pl.z, pl.yaw);
    if (err) { pl.valid = false; pl.reason = err; }
  }
  return pl;
}

/** Geometry/environment rules (no inventory/range checks). */
export function validateGeometry(ctx: BuildContext, def: StructureDef, x: number, y: number, z: number, yaw: number, ignoreId?: string): string | null {
  if (![x, y, z, yaw].every(Number.isFinite)) return 'Invalid position';
  const terrain = ctx.gen.heightAt(x, z);
  const water = 0; // calm sea level used for build rules (waves ignored)
  if (def.snap === 'water') {
    const v = def.vehicle ? VEHICLES[def.vehicle] : undefined;
    if (!v || -terrain < v.draft + 0.5) return 'Needs deeper water';
    return null;
  }
  if (def.category === 'foundation' && def.snap === 'grid') {
    const fp = footprint(ctx, x, z, yaw, def.size[0], def.size[2]);
    const snappedToNeighbour = Object.values(ctx.structures).some((s) => s.id !== ignoreId && isBase(STRUCTURES[s.type]) && Math.abs(s.y - y) < 0.05
      && Math.abs(Math.hypot(s.x - x, s.z - z) - G) < EPS);
    if (def.allowWater) {
      if (water - fp.min > BUILD.stiltMaxWaterDepth) return 'Too deep for stilts';
    } else {
      if (water - fp.min > BUILD.maxFoundationWaterDepth && !snappedToNeighbour) return 'Too deep — use a stilt platform';
      if (fp.max - fp.min > BUILD.maxFoundationSlope && !snappedToNeighbour) return 'Ground is too uneven';
      if (y < fp.max - 0.6) return 'Foundation is buried';
    }
    if (y - fp.min > 4.5) return 'Too high above the ground';
  } else if (!def.needsSupport && def.snap === 'free') {
    if (terrain < water - 0.3 && !ctx.col.ground(x, z, y + 0.1).onStructure) return 'Cannot build underwater';
    if (y - terrain > 0.25 && !ctx.col.ground(x, z, y + 0.1).onStructure) return 'Must rest on the ground or a floor';
  }
  if (def.minAltitude !== undefined && y < def.minAltitude) return `Must be built at least ${def.minAltitude} m above the sea`;
  // collision with other structures
  const ignore = new Set<string>(ignoreId ? [ignoreId] : []);
  const cy = y + def.size[1] / 2;
  const hit = ctx.col.overlapsStructure(x, cy, z, def.size[0], def.size[1] / 2, def.size[2], yaw, ignore);
  if (hit) {
    const other = ctx.structures[hit];
    // doors live inside doorways
    if (!(def.door && other?.type.endsWith('_doorway'))) return 'Blocked by another structure';
  }
  // duplicate check (exact same slot)
  for (const s of Object.values(ctx.structures)) {
    if (s.id === ignoreId) continue;
    if (s.type === def.id || STRUCTURES[s.type]?.category === def.category) {
      if (Math.hypot(s.x - x, s.z - z) < 0.2 && Math.abs(s.y - y) < 0.2 && Math.abs(angDiff(s.yaw, yaw)) % Math.PI < 0.2) return 'Something is already there';
    }
  }
  // solid nodes (trees, rocks) block foundations and stations
  if (def.solid && def.category !== 'wall' && def.category !== 'roof' && def.category !== 'floor') {
    if (ctx.col.solidNodeNear(x, z, Math.min(def.size[0], def.size[2]) * 0.9)) return 'Blocked by a tree or rock';
  }
  if (!isSupported(ctx.structures, { id: '__new', type: def.id, x, y, z, yaw } as StructureState, ignoreId)) return 'Not supported';
  return null;
}

/** Whether a structure is held up by terrain or its neighbours. */
export function isSupported(structures: Record<string, StructureState>, s: StructureState, excludeId?: string): boolean {
  const def = STRUCTURES[s.type];
  if (!def) return false;
  if (!def.needsSupport) return true;
  const others = Object.values(structures).filter((o) => o.id !== s.id && o.id !== excludeId && Math.abs(o.x - s.x) < G * 1.6 && Math.abs(o.z - s.z) < G * 1.6);
  if (def.category === 'wall' || def.snap === 'edge') {
    for (const o of others) {
      const od = STRUCTURES[o.type];
      if (isFloorLike(od) && Math.abs(topOf(o) - s.y) < 0.05) {
        const { lx, lz } = toLocal(o, s.x, s.z);
        const onEdge = (Math.abs(Math.abs(lx) - HALF) < EPS && Math.abs(lz) < EPS) || (Math.abs(Math.abs(lz) - HALF) < EPS && Math.abs(lx) < EPS);
        if (onEdge) return true;
      }
      if (isWall(od) && Math.abs(o.y + WH - s.y) < 0.05 && Math.hypot(o.x - s.x, o.z - s.z) < EPS) return true;
    }
    return false;
  }
  if (def.category === 'floor' || def.category === 'roof') {
    for (const o of others) {
      const od = STRUCTURES[o.type];
      if (isWall(od) && Math.abs(o.y + WH - s.y) < 0.05) {
        const { lx, lz } = toLocal(s, o.x, o.z);
        const onEdge = (Math.abs(Math.abs(lx) - HALF) < EPS && Math.abs(lz) < EPS) || (Math.abs(Math.abs(lz) - HALF) < EPS && Math.abs(lx) < EPS);
        if (onEdge) return true;
      }
    }
    if (def.category === 'floor') {
      // cantilever from an adjacent floor that is itself wall-supported
      for (const o of others) {
        if (STRUCTURES[o.type]?.category !== 'floor' || Math.abs(o.y - s.y) > 0.05) continue;
        if (Math.abs(Math.hypot(o.x - s.x, o.z - s.z) - G) > EPS) continue;
        const sub = { ...structures };
        delete sub[s.id];
        if (excludeId) delete sub[excludeId];
        if (isSupportedDirect(sub, o)) return true;
      }
    }
    return false;
  }
  if (def.category === 'stairs') {
    return others.some((o) => isFloorLike(STRUCTURES[o.type]) && Math.abs(topOf(o) - s.y) < 0.05 && Math.hypot(o.x - s.x, o.z - s.z) < EPS);
  }
  if (def.door) {
    return others.some((o) => o.type.endsWith('_doorway') && Math.hypot(o.x - s.x, o.z - s.z) < EPS && Math.abs(o.y - s.y) < 0.05);
  }
  return true;
}

function isSupportedDirect(structures: Record<string, StructureState>, s: StructureState): boolean {
  for (const o of Object.values(structures)) {
    if (o.id === s.id || !isWall(STRUCTURES[o.type]) || Math.abs(o.y + WH - s.y) > 0.05) continue;
    const { lx, lz } = toLocal(s, o.x, o.z);
    if ((Math.abs(Math.abs(lx) - HALF) < EPS && Math.abs(lz) < EPS) || (Math.abs(Math.abs(lz) - HALF) < EPS && Math.abs(lx) < EPS)) return true;
  }
  return false;
}

/** After removing `removedId`, find every structure that is no longer supported (cascade). */
export function findUnsupported(structures: Record<string, StructureState>, removedId: string): string[] {
  const remaining: Record<string, StructureState> = { ...structures };
  delete remaining[removedId];
  const fallen: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of Object.values(remaining)) {
      if (!STRUCTURES[s.type]?.needsSupport) continue;
      if (!isSupported(remaining, s)) {
        fallen.push(s.id);
        delete remaining[s.id];
        changed = true;
      }
    }
  }
  return fallen;
}
