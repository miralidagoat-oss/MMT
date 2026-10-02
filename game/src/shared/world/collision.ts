/**
 * Collision world shared by server simulation and client prediction.
 * Combines: heightfield terrain, tree/rock nodes (cylinders/spheres),
 * structures (oriented boxes), cave rock shells (spheres).
 */
import { WorldGen } from './worldgen';
import { STRUCTURES } from '../defs/structures';
import { NODES } from '../defs/nodes';
import { SpatialHash } from '../math/spatial';
import type { StructureState } from '../state';

export interface Box {
  ownerId: string;
  cx: number; cy: number; cz: number; // center
  hx: number; hy: number; hz: number;
  yaw: number;
  cos: number; sin: number;
  walkable: boolean;
  ramp: boolean; // rises toward local -Z
}

export interface Sphere { x: number; y: number; z: number; r: number }

export interface GroundHit { h: number; normalY: number; onStructure: boolean }

export class CollisionWorld {
  private boxes = new SpatialHash<Box>(8);
  private boxesByOwner = new Map<string, Box[]>();
  private spheres = new SpatialHash<Sphere>(16);
  private tmpBoxes: Box[] = [];
  private tmpSpheres: Sphere[] = [];
  private tmpNodes: ReturnType<WorldGen['nodesInRadius']> = [];

  constructor(public gen: WorldGen, private isNodeDepleted: (id: string) => boolean) {
    for (const cave of gen.caves) for (const r of cave.rocks) this.spheres.insert(r, r.x, r.z);
  }

  // ------------------------------------------------------------- structures
  addStructure(s: StructureState, isOpenDoor = false): void {
    this.removeStructure(s.id);
    const def = STRUCTURES[s.type];
    if (!def || (!def.solid && !def.walkable)) return;
    if (def.door && isOpenDoor) return;
    const cos = Math.cos(s.yaw), sin = Math.sin(s.yaw);
    const list: Box[] = [];
    const cols = def.colliders ?? [[0, def.size[1] / 2, 0, def.size[0], def.size[1] / 2, def.size[2]]];
    for (const [lx, ly, lz, hx, hy, hz] of cols) {
      const b: Box = {
        ownerId: s.id,
        cx: s.x + cos * lx + sin * lz, cy: s.y + ly, cz: s.z - sin * lx + cos * lz,
        hx, hy, hz, yaw: s.yaw, cos, sin, walkable: !!def.walkable || def.solid, ramp: !!def.ramp,
      };
      list.push(b);
      this.boxes.insert(b, b.cx, b.cz);
    }
    this.boxesByOwner.set(s.id, list);
  }

  removeStructure(id: string): void {
    const list = this.boxesByOwner.get(id);
    if (!list) return;
    for (const b of list) this.boxes.remove(b);
    this.boxesByOwner.delete(id);
  }

  /** Convert world point into box local coords. */
  private toLocal(b: Box, x: number, z: number): [number, number] {
    const dx = x - b.cx, dz = z - b.cz;
    // inverse rotation of (lx, lz) -> world: x = cos*lx + sin*lz ; z = -sin*lx + cos*lz
    return [b.cos * dx - b.sin * dz, b.sin * dx + b.cos * dz];
  }

  private boxTopAt(b: Box, lx: number, lz: number): number {
    if (!b.ramp) return b.cy + b.hy;
    const t = (b.hz - lz) / (2 * b.hz); // 0 at +Z edge, 1 at -Z edge
    return b.cy - b.hy + Math.max(0, Math.min(1, t)) * 2 * b.hy;
  }

  // ------------------------------------------------------------- queries
  terrainHeight(x: number, z: number): number { return this.gen.heightAt(x, z); }

  /** Highest supporting surface under (x,z) that is at most `maxY` high. */
  ground(x: number, z: number, maxY: number, radius = 0): GroundHit {
    const th = this.gen.heightAt(x, z);
    let best: GroundHit = { h: th, normalY: 1, onStructure: false };
    if (best.h > maxY) {
      // terrain is above us (we're inside it) — still terrain
      best.h = th;
    }
    const boxes = this.boxes.query(x, z, 4, this.tmpBoxes); this.tmpBoxes = [];
    for (const b of boxes) {
      if (!b.walkable) continue;
      const [lx, lz] = this.toLocal(b, x, z);
      const pad = radius * 0.5;
      if (Math.abs(lx) > b.hx + pad || Math.abs(lz) > b.hz + pad) continue;
      const top = this.boxTopAt(b, lx, lz);
      if (top <= maxY && top > best.h) best = { h: top, normalY: 1, onStructure: true };
    }
    const spheres = this.spheres.query(x, z, 6, this.tmpSpheres); this.tmpSpheres = [];
    for (const s of spheres) {
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= s.r * s.r) continue;
      const top = s.y + Math.sqrt(s.r * s.r - d2);
      if (top <= maxY && top > best.h) best = { h: top, normalY: Math.sqrt(1 - d2 / (s.r * s.r)), onStructure: true };
    }
    return best;
  }

  /**
   * Push a vertical capsule (feet at y, height h, radius r) out of solid obstacles.
   * Returns corrected x,z and optional ceiling clamp.
   */
  resolve(x: number, y: number, z: number, r: number, h: number, stepH: number): { x: number; z: number; ceiling: number } {
    let ceiling = Infinity;
    // node trunks/rocks
    this.tmpNodes.length = 0;
    const nodes = this.gen.nodesInRadius(x, z, 3, this.tmpNodes);
    for (const n of nodes) {
      const def = NODES[n.type];
      if (!def || !def.solid) continue;
      if (this.isNodeDepleted(n.id)) continue;
      const nr = def.radius * n.scale;
      const top = n.y + def.height * n.scale;
      if (y + stepH >= top || y + h <= n.y - 0.5) continue;
      const dx = x - n.x, dz = z - n.z;
      const d = Math.hypot(dx, dz);
      const min = nr + r;
      if (d < min) {
        if (d < 1e-5) { x += min; continue; }
        x = n.x + (dx / d) * min;
        z = n.z + (dz / d) * min;
      }
    }
    // structure boxes
    const boxes = this.boxes.query(x, z, 5, this.tmpBoxes); this.tmpBoxes = [];
    for (const b of boxes) {
      const bottom = b.cy - b.hy;
      const [lx, lz] = this.toLocal(b, x, z);
      const top = this.boxTopAt(b, lx, lz);
      if (y + stepH >= top || y + h <= bottom) {
        if (y + h > bottom && y < bottom && Math.abs(lx) < b.hx && Math.abs(lz) < b.hz) ceiling = Math.min(ceiling, bottom);
        continue;
      }
      // closest point on box (2D, local) to circle center
      const cx = Math.max(-b.hx, Math.min(b.hx, lx));
      const cz = Math.max(-b.hz, Math.min(b.hz, lz));
      let dx = lx - cx, dz = lz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      let nlx: number, nlz: number;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        nlx = cx + (dx / d) * r;
        nlz = cz + (dz / d) * r;
      } else {
        // center inside box: push out along smallest penetration axis
        const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
        if (px < pz) { nlx = Math.sign(lx || 1) * (b.hx + r); nlz = lz; }
        else { nlz = Math.sign(lz || 1) * (b.hz + r); nlx = lx; }
      }
      dx = nlx; dz = nlz;
      // back to world
      x = b.cx + b.cos * dx + b.sin * dz;
      z = b.cz - b.sin * dx + b.cos * dz;
    }
    // cave rocks (3D sphere vs vertical segment)
    const spheres = this.spheres.query(x, z, 6, this.tmpSpheres); this.tmpSpheres = [];
    for (const s of spheres) {
      const segLo = y + stepH, segHi = y + h - r;
      const cy = Math.max(segLo, Math.min(segHi, s.y));
      const dx = x - s.x, dy = cy - s.y, dz = z - s.z;
      const d = Math.hypot(dx, dy, dz);
      const min = s.r + r;
      if (d >= min) continue;
      const hd = Math.hypot(dx, dz);
      if (s.y > y + h * 0.6 && hd < s.r * 0.8) {
        ceiling = Math.min(ceiling, s.y - Math.sqrt(Math.max(0, s.r * s.r - hd * hd)));
        continue;
      }
      if (hd < 1e-5) continue;
      const push = Math.sqrt(Math.max(0, min * min - dy * dy));
      x = s.x + (dx / hd) * push;
      z = s.z + (dz / hd) * push;
    }
    return { x, z, ceiling };
  }

  /** Is there a live solid node (tree/rock) within r of x,z? */
  solidNodeNear(x: number, z: number, r: number): string | null {
    this.tmpNodes.length = 0;
    for (const n of this.gen.nodesInRadius(x, z, r + 1.5, this.tmpNodes)) {
      const def = NODES[n.type];
      if (!def?.solid || this.isNodeDepleted(n.id)) continue;
      if (Math.hypot(n.x - x, n.z - z) < r + def.radius * n.scale) return n.id;
    }
    return null;
  }

  /** Check whether a world-space box overlaps any solid structure (placement validation). */
  overlapsStructure(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number, ignore?: Set<string>, shrink = 0.08): string | null {
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const boxes = this.boxes.query(cx, cz, Math.max(hx, hz) + 4, this.tmpBoxes); this.tmpBoxes = [];
    const ax = hx - shrink, ay = hy - shrink, az = hz - shrink;
    for (const b of boxes) {
      if (ignore?.has(b.ownerId)) continue;
      if (Math.abs(b.cy - cy) >= b.hy + ay) continue;
      if (obbOverlap2D(cx, cz, ax, az, cos, sin, b.cx, b.cz, b.hx - shrink, b.hz - shrink, b.cos, b.sin)) return b.ownerId;
    }
    return null;
  }

  /** Raycast against structures, returns hit owner id and distance. */
  raycastStructures(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): { id: string; t: number } | null {
    const mx = ox + dx * maxDist / 2, mz = oz + dz * maxDist / 2;
    const boxes = this.boxes.query(mx, mz, maxDist / 2 + 4, this.tmpBoxes); this.tmpBoxes = [];
    let best: { id: string; t: number } | null = null;
    for (const b of boxes) {
      // transform ray into local space
      const rx = ox - b.cx, rz = oz - b.cz;
      const lox = b.cos * rx - b.sin * rz, loz = b.sin * rx + b.cos * rz;
      const ldx = b.cos * dx - b.sin * dz, ldz = b.sin * dx + b.cos * dz;
      const t = slab(lox, oy - b.cy, loz, ldx, dy, ldz, b.hx, b.hy, b.hz);
      if (t >= 0 && t <= maxDist && (!best || t < best.t)) best = { id: b.ownerId, t };
    }
    return best;
  }

  /** Line of sight test against terrain (sampled) and cave rocks. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dist = Math.hypot(bx - ax, by - ay, bz - az);
    const steps = Math.max(2, Math.ceil(dist / 3));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      if (this.gen.heightAt(x, z) > y) return false;
    }
    return true;
  }
}

function slab(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, hx: number, hy: number, hz: number): number {
  let tmin = -Infinity, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], h = [hx, hy, hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-9) { if (Math.abs(o[i]!) > h[i]!) return -1; continue; }
    let t1 = (-h[i]! - o[i]!) / d[i]!, t2 = (h[i]! - o[i]!) / d[i]!;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  return tmin >= 0 ? tmin : 0;
}

/** Separating axis test for two oriented rectangles on the XZ plane. */
function obbOverlap2D(ax: number, az: number, ahx: number, ahz: number, acos: number, asin: number,
  bx: number, bz: number, bhx: number, bhz: number, bcos: number, bsin: number): boolean {
  // local axes in world: X axis = (cos, -sin), Z axis = (sin, cos)
  const axes = [[acos, -asin], [asin, acos], [bcos, -bsin], [bsin, bcos]];
  const aAx = [[acos, -asin], [asin, acos]], bAx = [[bcos, -bsin], [bsin, bcos]];
  const tx = bx - ax, tz = bz - az;
  for (const [nx, nz] of axes) {
    const ra = ahx * Math.abs(aAx[0]![0]! * nx! + aAx[0]![1]! * nz!) + ahz * Math.abs(aAx[1]![0]! * nx! + aAx[1]![1]! * nz!);
    const rb = bhx * Math.abs(bAx[0]![0]! * nx! + bAx[0]![1]! * nz!) + bhz * Math.abs(bAx[1]![0]! * nx! + bAx[1]![1]! * nz!);
    if (Math.abs(tx * nx! + tz * nz!) > ra + rb) return false;
  }
  return true;
}
