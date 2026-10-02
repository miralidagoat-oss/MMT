// Bounded A* over the block grid so creatures walk around walls, up steps
// and down safe drops instead of steering straight at their goal. A node is
// the block a creature's feet stand in. Searches are capped by a node budget;
// when the goal is out of reach the path leads to the closest point found.
import { B, SOLID, BLOCKS, isLiquid } from './blocks.js';
import { blockCollision } from './physics.js';
import { DOOR_OPEN } from './shapes.js';

let HURTS = null; // blocks a creature will not stand in or on
function hurts() {
  if (!HURTS) HURTS = new Set([B.lava, B.fire, B.cactus, B.magma_rock, B.cobweb].filter((v) => v !== undefined));
  return HURTS;
}

// Height of the collision inside a cell: 0 when passable, up to 1.5 (fences).
// Closed doors count as passable for creatures that open them.
function cellTop(world, x, y, z, cache, opensDoors) {
  const k = ((x & 1023) * 1024 + (z & 1023)) * 512 + (y & 511);
  const c = cache.get(k);
  if (c !== undefined) return c;
  const id = world.getBlock(x, y, z);
  let t = 0;
  if (SOLID[id]) {
    if (id === B.oak_door) t = opensDoors || (world.getMeta(x, y, z) & DOOR_OPEN) ? 0 : 1;
    else {
      const boxes = blockCollision(world, x, y, z, id);
      if (boxes) for (const b of boxes) if (b[4] > t) t = b[4];
    }
  }
  cache.set(k, t);
  return t;
}

// Can a creature of `cells` blocks height stand with its feet in (x, y, z)?
// Returns 0 (no), 1 (on ground) or 2 (swimming).
function standable(world, x, y, z, cells, o, cache) {
  const sk = -1 - (((x & 1023) * 1024 + (z & 1023)) * 512 + (y & 511));
  const c = cache.get(sk);
  if (c !== undefined) return c;
  const v = standable0(world, x, y, z, cells, o, cache);
  cache.set(sk, v);
  return v;
}
function standable0(world, x, y, z, cells, o, cache) {
  const ft = cellTop(world, x, y, z, cache, o.opensDoors);
  if (ft > 0.55) return 0;
  const below = cellTop(world, x, y - 1, z, cache, o.opensDoors);
  if (below > 1.01) return 0; // the top of a fence or wall can't be reached
  const n = Math.ceil(cells + ft - 0.001);
  for (let k = 1; k < n; k++) if (cellTop(world, x, y + k, z, cache, o.opensDoors) > 0) return 0;
  const id = world.getBlock(x, y, z), bid = world.getBlock(x, y - 1, z);
  if (!o.fireproof && (hurts().has(id) || bid === B.lava || bid === B.magma_rock || bid === B.cactus)) return 0;
  if (isLiquid(id)) {
    // swimmers keep to the surface
    if (id === B.water) return o.swim && world.getBlock(x, y + 1, z) !== B.water ? 2 : 0;
    return o.fireproof ? 1 : 0;
  }
  if (ft > 0 || below >= 0.9) return 1;
  if (bid === B.water && o.swim) return 0; // above water: the node below is the swimming one
  return 0;
}

// Binary heap keyed on f.
class Heap {
  constructor() { this.a = []; }
  push(n) {
    const a = this.a; a.push(n);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= n.f) break; a[i] = a[p]; i = p; }
    a[i] = n;
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mf = last.f;
        if (l < a.length && a[l].f < mf) { m = l; mf = a[l].f; }
        if (r < a.length && a[r].f < mf) m = r;
        if (m === i) break;
        a[i] = a[m]; i = m;
      }
      a[i] = last;
    }
    return top;
  }
  get size() { return this.a.length; }
}

const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Find a path from feet cell (sx, sy, sz) toward (gx, gy, gz).
// opts: { height, maxNodes, maxDrop, swim, fireproof, opensDoors, near }
// Returns [[x, y, z], ...] (start excluded) or null when no progress is possible.
export function findPath(world, sx, sy, sz, gx, gy, gz, opts = {}) {
  const o = { height: 1.8, maxNodes: 600, maxDrop: 3, swim: true, fireproof: false, opensDoors: false, near: 1, ...opts };
  const cells = Math.max(1, o.height);
  const cache = new Map();
  // creatures standing on a half block or bobbing in water report the cell above/below
  if (!standable(world, sx, sy, sz, cells, o, cache)) {
    if (standable(world, sx, sy + 1, sz, cells, o, cache)) sy++;
    else if (standable(world, sx, sy - 1, sz, cells, o, cache)) sy--;
  }
  const key = (x, y, z) => ((x - sx + 512) * 1024 + (z - sz + 512)) * 512 + (y & 511);
  const h = (x, y, z) => {
    const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz) + Math.abs(y - gy) * 0.8;
  };
  const open = new Heap();
  const seen = new Map();
  const start = { x: sx, y: sy, z: sz, g: 0, f: h(sx, sy, sz), parent: null };
  open.push(start);
  seen.set(key(sx, sy, sz), start);
  let best = start, bestH = start.f, expanded = 0;
  const reached = (n) => Math.abs(n.x - gx) <= o.near && Math.abs(n.z - gz) <= o.near && Math.abs(n.y - gy) <= 1 &&
    (o.near > 0 || n.y === gy);
  const consider = (cur, x, y, z, cost) => {
    const k = key(x, y, z);
    const g = cur.g + cost;
    const old = seen.get(k);
    if (old && old.g <= g) return;
    const hv = h(x, y, z);
    const n = { x, y, z, g, f: g + hv * 1.1, parent: cur, closed: false };
    seen.set(k, n);
    open.push(n);
    if (hv < bestH) { bestH = hv; best = n; }
  };
  let goal = null;
  while (open.size && expanded < o.maxNodes) {
    const cur = open.pop();
    if (cur.closed) continue;
    const latest = seen.get(key(cur.x, cur.y, cur.z));
    if (latest !== cur) continue;
    cur.closed = true;
    expanded++;
    if (reached(cur)) { goal = cur; break; }
    const swimming = standable(world, cur.x, cur.y, cur.z, cells, o, cache) === 2;
    const headClear = cellTop(world, cur.x, cur.y + Math.ceil(cells), cur.z, cache, o.opensDoors) === 0;
    for (let d = 0; d < 8; d++) {
      const [dx, dz] = DIRS8[d];
      const x = cur.x + dx, z = cur.z + dz;
      const diag = dx && dz;
      if (diag) {
        // no cutting corners
        if (!standable(world, cur.x + dx, cur.y, cur.z, cells, o, cache) || !standable(world, cur.x, cur.y, cur.z + dz, cells, o, cache)) continue;
      }
      const base = diag ? 1.414 : 1;
      const here = standable(world, x, cur.y, z, cells, o, cache);
      if (here) { consider(cur, x, cur.y, z, base * (here === 2 ? 2.5 : 1)); continue; }
      if (diag) continue;
      // a step up (needs room to jump)
      if (headClear || swimming) {
        const up = standable(world, x, cur.y + 1, z, cells, o, cache);
        if (up) { consider(cur, x, cur.y + 1, z, base + 0.6); continue; }
      }
      // a drop: the column must be open all the way down
      if (cellTop(world, x, cur.y, z, cache, o.opensDoors) > 0) continue;
      for (let k = 1; k <= o.maxDrop; k++) {
        const y = cur.y - k;
        if (y < 1) break;
        const s = standable(world, x, y, z, cells, o, cache);
        if (s) { consider(cur, x, y, z, base + k * 0.4); break; }
        if (cellTop(world, x, y, z, cache, o.opensDoors) > 0) break;
      }
    }
    // swimming creatures can rise and sink
    if (swimming) {
      for (const dy of [1, -1]) {
        const s = standable(world, cur.x, cur.y + dy, cur.z, cells, o, cache);
        if (s) consider(cur, cur.x, cur.y + dy, cur.z, 1.5);
      }
    }
  }
  const end = goal || best;
  if (end === start) return null;
  const out = [];
  for (let n = end; n && n !== start; n = n.parent) out.push([n.x, n.y, n.z]);
  out.reverse();
  out.complete = !!goal;
  return out;
}

// Per-creature path following. Call every tick with the goal; returns the
// point to steer at ({x, z, up, door}) or null to steer straight at the goal.
export function navigate(m, game, gx, gy, gz, opts = {}) {
  const nav = m.nav || (m.nav = { path: null, i: 0, gx: 0, gy: 0, gz: 0, age: 0, stuck: 0, lx: m.x, lz: m.z, fails: 0 });
  const fx = Math.floor(m.x), fy = Math.floor(m.y + 0.05), fz = Math.floor(m.z);
  const GX = Math.floor(gx), GY = Math.floor(gy), GZ = Math.floor(gz);
  nav.age++;
  const urgent = !!opts.urgent;
  const moved = Math.abs(nav.gx - GX) + Math.abs(nav.gz - GZ) + Math.abs(nav.gy - GY);
  const stale = !nav.path || nav.i >= nav.path.length || moved > (urgent ? 1 : 2) || nav.age > (urgent ? 50 : 240) || nav.stuck > 20;
  // after a search that could not reach the goal, wait a while before trying again
  const wait = nav.incomplete && nav.age < 30 && moved <= 3;
  if (stale && !wait && (game.pathBudget ?? 1) > 0 && !(nav.cool > 0)) {
    if (game.pathBudget !== undefined) game.pathBudget--;
    nav.path = findPath(game.world, fx, fy, fz, GX, GY, GZ, {
      height: m.h, maxNodes: urgent ? 700 : 260, maxDrop: urgent ? 3 : 2, swim: !m.def.heavy,
      fireproof: !!m.def.fireproof, opensDoors: !!opts.opensDoors, near: opts.near ?? 1,
    });
    nav.i = 0; nav.gx = GX; nav.gy = GY; nav.gz = GZ; nav.age = 0; nav.stuck = 0;
    nav.incomplete = !!nav.path && !nav.path.complete;
    // a failed search backs off so a trapped creature doesn't search every tick
    if (!nav.path) { nav.fails++; nav.cool = Math.min(80, 10 * nav.fails); } else nav.fails = 0;
  }
  if (nav.cool > 0) nav.cool--;
  const path = nav.path;
  if (!path || !path.length) return null;
  while (nav.i < path.length) {
    const [wx, wy, wz] = path[nav.i];
    if (Math.abs(wx + 0.5 - m.x) < 0.42 && Math.abs(wz + 0.5 - m.z) < 0.42 && Math.abs(wy - m.y) < 1.1) nav.i++;
    else break;
  }
  if (nav.i >= path.length) return null;
  // stuck detection: barely moving while there is somewhere to go
  if (Math.hypot(m.x - nav.lx, m.z - nav.lz) < 0.015) nav.stuck++;
  else nav.stuck = Math.max(0, nav.stuck - 1);
  nav.lx = m.x; nav.lz = m.z;
  let [wx, wy, wz] = path[nav.i];
  // look one step ahead on flat runs so turns are smooth rather than zigzag
  const nx = path[nav.i + 1];
  if (nx && nx[1] === wy && wy === fy && Math.hypot(wx + 0.5 - m.x, wz + 0.5 - m.z) < 0.9) [wx, wy, wz] = nx;
  return { x: wx + 0.5, z: wz + 0.5, up: wy > fy, wx, wy, wz };
}

// Settlers open doors on their way and shut them behind them.
export function handleDoors(m, game, wp) {
  const w = game.world;
  const open = (x, y, z, want) => {
    if (w.getBlock(x, y, z) !== B.oak_door) return false;
    const meta = w.getMeta(x, y, z);
    if (!!(meta & DOOR_OPEN) === want) return false;
    w.setBlock(x, y, z, B.oak_door, meta ^ DOOR_OPEN);
    const oy = w.getBlock(x, y + 1, z) === B.oak_door ? y + 1 : y - 1;
    if (w.getBlock(x, oy, z) === B.oak_door) w.setBlock(x, oy, z, B.oak_door, w.getMeta(x, oy, z) ^ DOOR_OPEN, { notify: false });
    game.audio.play(want ? 'door_open' : 'door_close', x + 0.5, y + 0.5, z + 0.5);
    return true;
  };
  if (wp) {
    for (const [x, y, z] of [[wp.wx, wp.wy, wp.wz], [Math.floor(m.x), Math.floor(m.y + 0.05), Math.floor(m.z)]]) {
      if (w.getBlock(x, y, z) === B.oak_door && open(x, y, z, true)) m.openedDoor = [x, y, z, m.age];
    }
  }
  const d = m.openedDoor;
  if (d && m.age - d[3] > 20) {
    const inside = Math.floor(m.x) === d[0] && Math.floor(m.z) === d[2];
    if (!inside && Math.hypot(d[0] + 0.5 - m.x, d[2] + 0.5 - m.z) > 1.6) { open(d[0], d[1], d[2], false); m.openedDoor = null; }
  }
}

// The standing height near (x, z), searching a few blocks around y.
export function groundY(world, x, y, z) {
  const X = Math.floor(x), Z = Math.floor(z), Y = Math.floor(y);
  for (let yy = Y + 3; yy >= Y - 4; yy--) {
    if (SOLID[world.getBlock(X, yy - 1, Z)] && !SOLID[world.getBlock(X, yy, Z)]) return yy;
  }
  return Y;
}
void BLOCKS;
