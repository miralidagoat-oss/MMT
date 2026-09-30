// Block shapes, swept AABB collision and voxel raycasting.
import { B, BLOCKS, SOLID, RENDER, RENDER_TYPE, isLiquid, SHAPE_KIND, SHAPE_CTX } from './blocks.js';
import { shapeBoxes, collisionBoxes, unionBox } from './shapes.js';

const FULL = [0, 0, 0, 1, 1, 1];
const S16 = 1 / 16;

const CACTUS_BOX = [[S16, 0, S16, 1 - S16, 1 - S16, 1 - S16]];
const FULL_LIST = [FULL];

// Collision boxes (block-local) for the block at x,y,z, or null if passable.
export function blockCollision(world, x, y, z, id) {
  if (!SOLID[id]) return null;
  if (id === B.cactus) return CACTUS_BOX;
  if (SHAPE_KIND[id]) {
    const meta = world.getMeta(x, y, z);
    return collisionBoxes(SHAPE_CTX, id, meta, (dx, dy, dz) => world.getBlock(x + dx, y + dy, z + dz));
  }
  return FULL_LIST;
}

// Kept for callers that only know the id (plain cubes and cacti).
export function collisionBox(id) {
  if (!SOLID[id]) return null;
  if (id === B.cactus) return CACTUS_BOX[0];
  return FULL;
}

// Outline / hit box used for targeting.
export function selectionBoxAt(world, x, y, z, id, meta) {
  if (RENDER_TYPE[id] === RENDER.SHAPE) {
    const boxes = shapeBoxes(SHAPE_CTX, id, meta, (dx, dy, dz) => world.getBlock(x + dx, y + dy, z + dz));
    return boxes ? unionBox(boxes) : FULL;
  }
  return selectionBox(id, meta);
}

export function selectionBox(id, meta) {
  if (id === 0 || isLiquid(id)) return null;
  const rt = RENDER_TYPE[id];
  if (rt === RENDER.PORTAL) return null;
  if (rt === RENDER.CROP) return [0, 0, 0, 1, 0.25 + (meta & 7) * 0.08, 1];
  if (rt === RENDER.SHAPE) return FULL;
  if (rt === RENDER.CROSS) {
    if (id === B.sugar_cane) return [0.125, 0, 0.125, 0.875, 1, 0.875];
    if (id === B.tall_grass || id === B.fern || id === B.dead_bush) return [0.1, 0, 0.1, 0.9, 0.8, 0.9];
    if (id === B.brown_mushroom || id === B.red_mushroom) return [0.3, 0, 0.3, 0.7, 0.4, 0.7];
    return [0.25, 0, 0.25, 0.75, 0.65, 0.75];
  }
  if (rt === RENDER.TORCH) {
    const m = meta & 7;
    if (m === 1) return [0, 0.2, 0.35, 0.3, 0.8, 0.65];
    if (m === 2) return [0.7, 0.2, 0.35, 1, 0.8, 0.65];
    if (m === 3) return [0.35, 0.2, 0, 0.65, 0.8, 0.3];
    if (m === 4) return [0.35, 0.2, 0.7, 0.65, 0.8, 1];
    return [0.4, 0, 0.4, 0.6, 0.6, 0.6];
  }
  if (rt === RENDER.LADDER) {
    const m = (meta & 7) || 1;
    if (m === 1) return [0, 0, 0, 0.1875, 1, 1];
    if (m === 2) return [0.8125, 0, 0, 1, 1, 1];
    if (m === 3) return [0, 0, 0, 1, 1, 0.1875];
    return [0, 0, 0.8125, 1, 1, 1];
  }
  if (rt === RENDER.CACTUS) return [S16, 0, S16, 1 - S16, 1, 1 - S16];
  return FULL;
}

// Swept AABB movement against the world (Y, then X, then Z like the classic
// voxel games). e: { x, y, z, w (half width), h (height) } – position is the
// centre of the feet. Returns actual displacement and collision flags.
const boxes = [];
export function moveBox(world, e, dx, dy, dz) {
  const hw = e.w;
  let x0 = e.x - hw, y0 = e.y, z0 = e.z - hw, x1 = e.x + hw, y1 = e.y + e.h, z1 = e.z + hw;
  const bx0 = Math.floor(Math.min(x0, x0 + dx)) - 1, bx1 = Math.floor(Math.max(x1, x1 + dx)) + 1;
  const by0 = Math.floor(Math.min(y0, y0 + dy)) - 1, by1 = Math.floor(Math.max(y1, y1 + dy)) + 1;
  const bz0 = Math.floor(Math.min(z0, z0 + dz)) - 1, bz1 = Math.floor(Math.max(z1, z1 + dz)) + 1;
  boxes.length = 0;
  for (let y = by0; y <= by1; y++) for (let z = bz0; z <= bz1; z++) for (let x = bx0; x <= bx1; x++) {
    const id = world.getBlockSolidCheck(x, y, z);
    if (id === 0) continue;
    const list = blockCollision(world, x, y, z, id);
    if (!list) continue;
    for (const b of list) boxes.push(x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]);
  }
  const ody = dy, odx = dx, odz = dz;
  const EPS = 1e-7;
  // Y
  for (let i = 0; i < boxes.length; i += 6) {
    if (x1 <= boxes[i] + EPS || x0 >= boxes[i + 3] - EPS || z1 <= boxes[i + 2] + EPS || z0 >= boxes[i + 5] - EPS) continue;
    if (dy > 0 && y1 <= boxes[i + 1] + EPS) dy = Math.min(dy, boxes[i + 1] - y1);
    else if (dy < 0 && y0 >= boxes[i + 4] - EPS) dy = Math.max(dy, boxes[i + 4] - y0);
  }
  y0 += dy; y1 += dy;
  // X
  for (let i = 0; i < boxes.length; i += 6) {
    if (y1 <= boxes[i + 1] + EPS || y0 >= boxes[i + 4] - EPS || z1 <= boxes[i + 2] + EPS || z0 >= boxes[i + 5] - EPS) continue;
    if (dx > 0 && x1 <= boxes[i] + EPS) dx = Math.min(dx, boxes[i] - x1);
    else if (dx < 0 && x0 >= boxes[i + 3] - EPS) dx = Math.max(dx, boxes[i + 3] - x0);
  }
  x0 += dx; x1 += dx;
  // Z
  for (let i = 0; i < boxes.length; i += 6) {
    if (y1 <= boxes[i + 1] + EPS || y0 >= boxes[i + 4] - EPS || x1 <= boxes[i] + EPS || x0 >= boxes[i + 3] - EPS) continue;
    if (dz > 0 && z1 <= boxes[i + 2] + EPS) dz = Math.min(dz, boxes[i + 2] - z1);
    else if (dz < 0 && z0 >= boxes[i + 5] - EPS) dz = Math.max(dz, boxes[i + 5] - z0);
  }
  e.x += dx; e.y += dy; e.z += dz;
  return {
    dx, dy, dz,
    hitX: Math.abs(dx - odx) > 1e-9,
    hitY: Math.abs(dy - ody) > 1e-9,
    hitZ: Math.abs(dz - odz) > 1e-9,
    onGround: ody < 0 && Math.abs(dy - ody) > 1e-9,
  };
}

// Is the box at (x, y, z) free of solid blocks?
export function boxFree(world, x, y, z, hw, h) {
  const x0 = x - hw, x1 = x + hw, y0 = y, y1 = y + h, z0 = z - hw, z1 = z + hw;
  for (let by = Math.floor(y0) - 1; by <= Math.floor(y1 - 1e-6); by++)
    for (let bz = Math.floor(z0); bz <= Math.floor(z1 - 1e-6); bz++)
      for (let bx = Math.floor(x0); bx <= Math.floor(x1 - 1e-6); bx++) {
        const id = world.getBlockSolidCheck(bx, by, bz);
        const list = id && blockCollision(world, bx, by, bz, id);
        if (!list) continue;
        for (const b of list) if (x1 > bx + b[0] && x0 < bx + b[3] && y1 > by + b[1] && y0 < by + b[4] && z1 > bz + b[2] && z0 < bz + b[5]) return false;
      }
  return true;
}

// Voxel raycast (Amanatides & Woo). Returns the first block whose selection
// box is hit, with the face normal, or null.
export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist, opts = {}) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sy = dy > 0 ? 1 : dy < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tdx = sx ? Math.abs(1 / dx) : Infinity, tdy = sy ? Math.abs(1 / dy) : Infinity, tdz = sz ? Math.abs(1 / dz) : Infinity;
  let tmx = sx > 0 ? (x + 1 - ox) * tdx : sx < 0 ? (ox - x) * tdx : Infinity;
  let tmy = sy > 0 ? (y + 1 - oy) * tdy : sy < 0 ? (oy - y) * tdy : Infinity;
  let tmz = sz > 0 ? (z + 1 - oz) * tdz : sz < 0 ? (oz - z) * tdz : Infinity;
  let t = 0;
  for (let i = 0; i < 256 && t <= maxDist; i++) {
    const id = world.getBlock(x, y, z);
    if (id > 0) {
      const liquidHit = opts.liquids && isLiquid(id) && (world.getMeta(x, y, z) & 15) === 0;
      const box = liquidHit ? FULL : selectionBoxAt(world, x, y, z, id, world.getMeta(x, y, z));
      if (box) {
        const hit = rayBox(ox, oy, oz, dx, dy, dz, x + box[0], y + box[1], z + box[2], x + box[3], y + box[4], z + box[5]);
        if (hit && hit.t <= maxDist) return { x, y, z, id, face: hit.face, nx: hit.n[0], ny: hit.n[1], nz: hit.n[2], dist: hit.t, box, hx: ox + dx * hit.t, hy: oy + dy * hit.t, hz: oz + dz * hit.t };
      }
    }
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; }
    else { z += sz; t = tmz; tmz += tdz; }
  }
  return null;
}

// Ray vs AABB slab test; returns entry distance and entry face normal.
export function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let tmin = -Infinity, tmax = Infinity, n = null;
  const axes = [[ox, dx, x0, x1, [-1, 0, 0], [1, 0, 0]], [oy, dy, y0, y1, [0, -1, 0], [0, 1, 0]], [oz, dz, z0, z1, [0, 0, -1], [0, 0, 1]]];
  for (const [o, d, a, b, nNeg, nPos] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < a || o > b) return null;
      continue;
    }
    let t0 = (a - o) / d, t1 = (b - o) / d, nn = nNeg;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; nn = nPos; }
    if (t0 > tmin) { tmin = t0; n = nn; }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  if (tmin < 0) { tmin = 0; n = n || [0, 1, 0]; }
  const face = n[1] > 0 ? 0 : n[1] < 0 ? 1 : n[0] > 0 ? 2 : n[0] < 0 ? 3 : n[2] > 0 ? 4 : 5;
  return { t: tmin, n, face };
}

export const blockFriction = (id) => (BLOCKS[id] ? BLOCKS[id].friction : 0.6);

// Movement with step assist: when blocked sideways on the ground, try again
// lifted by up to `step` blocks (walks up slabs, stairs and paths).
export function moveStep(world, e, dx, dy, dz, step) {
  const x0 = e.x, y0 = e.y, z0 = e.z;
  const wasGround = e.onGround;
  const r = moveBox(world, e, dx, dy, dz);
  if (!(step > 0 && (r.hitX || r.hitZ) && (wasGround || r.onGround))) return r;
  const x1 = e.x, y1 = e.y, z1 = e.z;
  e.x = x0; e.y = y0; e.z = z0;
  const up = moveBox(world, e, 0, step, 0);
  const hor = moveBox(world, e, dx, 0, dz);
  const down = moveBox(world, e, 0, -up.dy + Math.min(0, dy), 0);
  const d1 = (x1 - x0) ** 2 + (z1 - z0) ** 2, d2 = (e.x - x0) ** 2 + (e.z - z0) ** 2;
  if (d2 <= d1 + 1e-9) { e.x = x1; e.y = y1; e.z = z1; return r; }
  return { dx: e.x - x0, dy: e.y - y0, dz: e.z - z0, hitX: hor.hitX, hitZ: hor.hitZ, hitY: down.hitY, onGround: down.onGround };
}

// Horizontal slowdown from the block underfoot (cinder sand).
export function surfaceSlow(world, e) {
  const id = world.getBlock(Math.floor(e.x), Math.floor(e.y - 0.1), Math.floor(e.z)) || world.getBlock(Math.floor(e.x), Math.floor(e.y + 0.01), Math.floor(e.z));
  return BLOCKS[id] && BLOCKS[id].slow ? BLOCKS[id].slow : 1;
}
