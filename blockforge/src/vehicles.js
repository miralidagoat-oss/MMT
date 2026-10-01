// Rails, minecarts and boats.
import { Entity } from './entities.js';
import { B, OPAQUE, SOLID, isLiquid } from './blocks.js';
import { moveBox, blockFriction } from './physics.js';
import { I } from './items.js';

// Rail shapes: 0 N-S, 1 E-W, 2 ascending east, 3 ascending west, 4 ascending
// north, 5 ascending south, 6 S-E curve, 7 S-W, 8 N-W, 9 N-E. Exits are the
// neighbouring rail positions each shape joins (dy for the raised end).
export const RAIL_EXITS = [
  [[0, 0, -1], [0, 0, 1]], [[-1, 0, 0], [1, 0, 0]],
  [[-1, 0, 0], [1, 1, 0]], [[-1, 1, 0], [1, 0, 0]], [[0, 1, -1], [0, 0, 1]], [[0, 0, -1], [0, 1, 1]],
  [[0, 0, 1], [1, 0, 0]], [[0, 0, 1], [-1, 0, 0]], [[0, 0, -1], [-1, 0, 0]], [[0, 0, -1], [1, 0, 0]],
];
export const isRail = (id) => id === B.rail || id === B.powered_rail || id === B.detector_rail;
export const railShape = (id, meta) => (id === B.rail ? meta & 15 : meta & 7);
const D4 = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W

// Does the rail at (x,y,z) have an exit leading to (tx,ty,tz)? Exits may be
// one block up or down at the other end.
function railJoins(world, x, y, z, tx, tz) {
  const id = world.getBlock(x, y, z);
  if (!isRail(id)) return false;
  for (const e of RAIL_EXITS[railShape(id, world.getMeta(x, y, z))]) if (x + e[0] === tx && z + e[2] === tz) return true;
  return false;
}

function exitsUsed(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  let n = 0;
  for (const e of RAIL_EXITS[railShape(id, world.getMeta(x, y, z))]) {
    const ex = x + e[0], ez = z + e[2];
    for (let dy = -1; dy <= 1; dy++) if (railJoins(world, ex, y + e[1] + dy, ez, x, z) || (isRail(world.getBlock(ex, y + e[1] + dy, ez)) && dy === 0)) { n++; break; }
  }
  return n;
}

// Pick a shape for the rail at (x,y,z) from the rails around it.
export function chooseRailShape(world, x, y, z, id, preferAxis = 0) {
  const conn = [null, null, null, null]; // dy of the neighbour rail, if any
  for (let d = 0; d < 4; d++) {
    const nx = x + D4[d][0], nz = z + D4[d][1];
    if (isRail(world.getBlock(nx, y, nz))) conn[d] = 0;
    else if (isRail(world.getBlock(nx, y + 1, nz))) conn[d] = 1;
    else if (isRail(world.getBlock(nx, y - 1, nz))) conn[d] = -1;
  }
  const has = (d) => conn[d] !== null;
  const canCurve = id === B.rail;
  const ascend = (d) => [4, 2, 5, 3][d]; // ascending toward direction d
  const straight = (axisNS, a, b) => {
    if (conn[a] === 1) return ascend(a);
    if (conn[b] === 1) return ascend(b);
    return axisNS ? 0 : 1;
  };
  if (has(0) && has(2)) return straight(true, 0, 2);
  if (has(1) && has(3)) return straight(false, 1, 3);
  if (canCurve) {
    if (has(2) && has(1)) return 6;
    if (has(2) && has(3)) return 7;
    if (has(0) && has(3)) return 8;
    if (has(0) && has(1)) return 9;
  }
  for (let d = 0; d < 4; d++) if (has(d)) return straight(d === 0 || d === 2, d, (d + 2) & 3);
  return preferAxis;
}

// After placing a rail: shape it, then let open-ended neighbours turn toward it.
export function placeRail(world, x, y, z, id, preferAxis) {
  const shape = chooseRailShape(world, x, y, z, id, preferAxis);
  world.setBlock(x, y, z, id, shape);
  for (let d = 0; d < 4; d++) for (let dy = -1; dy <= 1; dy++) {
    const nx = x + D4[d][0], ny = y + dy, nz = z + D4[d][1];
    const nid = world.getBlock(nx, ny, nz);
    if (!isRail(nid)) continue;
    if (railJoins(world, nx, ny, nz, x, z)) continue;
    if (exitsUsed(world, nx, ny, nz) >= 2) continue;
    const ns = chooseRailShape(world, nx, ny, nz, nid);
    const m = world.getMeta(nx, ny, nz);
    world.setBlock(nx, ny, nz, nid, nid === B.rail ? ns : (m & 8) | ns);
  }
  const m = world.getMeta(x, y, z);
  world.setBlock(x, y, z, id, id === B.rail ? chooseRailShape(world, x, y, z, id, m) : chooseRailShape(world, x, y, z, id, m & 7));
}

// ---------------------------------------------------------------------------
export class Minecart extends Entity {
  constructor(x, y, z) {
    super(x, y, z, 0.49, 0.7);
    this.isCart = true;
    this.vehicle = true;
    this.rider = null;
    this.hits = 0; this.shake = 0;
    this.pitch = 0;
  }

  get targetable() { return true; }

  railAt(world) {
    const bx = Math.floor(this.x), bz = Math.floor(this.z);
    let by = Math.floor(this.y + 0.01);
    let id = world.getBlock(bx, by, bz);
    if (!isRail(id)) { const below = world.getBlock(bx, by - 1, bz); if (isRail(below)) { by--; id = below; } else return null; }
    return { bx, by, bz, id, meta: world.getMeta(bx, by, bz) };
  }

  tick(game) {
    this.savePrev();
    this.age++;
    if (this.shake > 0) this.shake--;
    if (this.hits > 0 && this.age % 4 === 0) this.hits--;
    const w = game.world;
    this.checkFluids(w);
    const rail = this.railAt(w);
    if (rail) this.onRail(game, rail);
    else this.offRail(game);
    // carts nudge each other apart
    for (const e of game.entities) {
      if (e === this || !e.isCart || e.removed) continue;
      const dx = this.x - e.x, dz = this.z - e.z, d = Math.hypot(dx, dz);
      if (d < 1.0 && d > 1e-4 && Math.abs(this.y - e.y) < 1) {
        const push = (1.0 - d) * 0.25;
        this.vx += (dx / d) * push; this.vz += (dz / d) * push;
      }
    }
    if (this.y < -64) this.removed = true;
  }

  onRail(game, r) {
    const w = game.world;
    const shape = railShape(r.id, r.meta);
    const powered = r.id === B.powered_rail && (r.meta & 8);
    const braking = r.id === B.powered_rail && !(r.meta & 8);
    const [e0, e1] = RAIL_EXITS[shape] || RAIL_EXITS[0];
    // gravity along slopes
    const slope = 0.0078125;
    if (shape === 2) this.vx -= slope; else if (shape === 3) this.vx += slope;
    else if (shape === 4) this.vz += slope; else if (shape === 5) this.vz -= slope;
    let dx = e1[0] - e0[0], dz = e1[2] - e0[2];
    const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
    const along = this.vx * dx + this.vz * dz;
    const speed = Math.hypot(this.vx, this.vz);
    const sp = Math.abs(along) > 1e-6 ? Math.sign(along) * speed : 0;
    this.vx = dx * sp; this.vz = dz * sp;
    // rider pushes gently when slow
    const ri = this.rider && this.riderInput;
    if (ri && ri.forward > 0 && speed < 0.05) {
      const p = this.rider;
      this.vx += Math.sin(p.yaw) * 0.01; this.vz -= Math.cos(p.yaw) * 0.01;
    }
    let s = Math.hypot(this.vx, this.vz);
    if (powered) {
      if (s > 0.01) { this.vx += (this.vx / s) * 0.06; this.vz += (this.vz / s) * 0.06; }
      else if (shape <= 1) {
        // starting from rest: push away from a solid block at one end
        const a = shape === 1 ? [1, 0] : [0, 1];
        if (SOLID[w.getBlock(r.bx - a[0], r.by, r.bz - a[1])]) { this.vx = a[0] * 0.02; this.vz = a[1] * 0.02; }
        else if (SOLID[w.getBlock(r.bx + a[0], r.by, r.bz + a[1])]) { this.vx = -a[0] * 0.02; this.vz = -a[1] * 0.02; }
      }
    } else if (braking) {
      if (s < 0.03) { this.vx = 0; this.vz = 0; } else { this.vx *= 0.5; this.vz *= 0.5; }
    }
    s = Math.hypot(this.vx, this.vz);
    const max = this.inWater ? 0.2 : 0.4;
    if (s > max) { this.vx *= max / s; this.vz *= max / s; }
    // snap onto the line between the two exits and move along it
    const cx = r.bx + 0.5, cz = r.bz + 0.5;
    const p0x = cx + e0[0] * 0.5, p0z = cz + e0[2] * 0.5, p1x = cx + e1[0] * 0.5, p1z = cz + e1[2] * 0.5;
    const lx = p1x - p0x, lz = p1z - p0z, ll = lx * lx + lz * lz;
    let t = ((this.x - p0x) * lx + (this.z - p0z) * lz) / ll;
    this.x = p0x + lx * t; this.z = p0z + lz * t;
    const steps = Math.max(1, Math.ceil(s / 0.3));
    for (let i = 0; i < steps; i++) {
      const nx = this.x + this.vx / steps, nz = this.z + this.vz / steps;
      // blocked by a solid block at body height?
      if (SOLID[w.getBlock(Math.floor(nx + Math.sign(this.vx) * 0.45), Math.floor(this.y + 0.5), Math.floor(nz + Math.sign(this.vz) * 0.45))] &&
        !isRail(w.getBlock(Math.floor(nx), Math.floor(this.y + 0.5), Math.floor(nz)))) {
        // bounce back a little
        this.vx *= -0.3; this.vz *= -0.3;
        if (Math.hypot(this.vx, this.vz) > 0.05) game.audio.material('metal', 'step', this.x, this.y, this.z);
        break;
      }
      this.x = nx; this.z = nz;
    }
    // height on slopes
    t = ((this.x - p0x) * lx + (this.z - p0z) * lz) / ll;
    const tc = Math.max(0, Math.min(1, t));
    const h0 = e0[1], h1 = e1[1];
    this.y = r.by + h0 + (h1 - h0) * tc;
    this.pitch = h1 !== h0 ? Math.atan2(h1 - h0, 1) * (Math.abs(dx) > 0.5 ? Math.sign(dx) : Math.sign(dz)) : 0;
    this.vy = 0;
    this.onGround = true;
    // friction
    const drag = this.rider ? 0.997 : 0.96;
    this.vx *= drag; this.vz *= drag;
    if (Math.hypot(this.vx, this.vz) > 0.05 && this.age % 8 === 0) game.audio.play('cart_roll', this.x, this.y, this.z, Math.min(0.6, Math.hypot(this.vx, this.vz)));
    this.yaw = Math.abs(this.vx) + Math.abs(this.vz) > 1e-3 ? Math.atan2(this.vx, -this.vz) : this.yaw;
  }

  offRail(game) {
    const w = game.world;
    this.vy -= 0.04;
    const r = moveBox(w, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    const f = this.onGround ? 0.5 : 0.95;
    this.vx *= f; this.vz *= f; this.vy *= 0.98;
    this.pitch = 0;
  }

  // Player interactions
  interact(game) {
    if (this.rider) return false;
    game.mount(this);
    return 'ride';
  }

  hit(game, dmg = 10) {
    this.hits += dmg; this.shake = 10;
    game.audio.material('metal', 'hit', this.x, this.y, this.z);
    if (this.hits > 30 || game.player.creative) {
      this.removed = true;
      if (this.rider) game.dismount();
      if (!game.player.creative) game.dropItem(this.x, this.y + 0.5, this.z, { id: I.minecart, count: 1 });
      game.audio.material('metal', 'break', this.x, this.y, this.z);
    }
  }

  seat() { return [this.x, this.y + 0.25, this.z]; }

  serialize() { return { kind: 'minecart', x: this.x, y: this.y, z: this.z, vx: this.vx, vz: this.vz, yaw: this.yaw }; }
}

// ---------------------------------------------------------------------------
export class Boat extends Entity {
  constructor(x, y, z, yaw = 0) {
    super(x, y, z, 0.68, 0.55);
    this.isBoat = true;
    this.vehicle = true;
    this.rider = null;
    this.yaw = this.pyaw = yaw;
    this.speed = 0;
    this.paddle = 0; this.ppaddle = 0;
    this.hits = 0; this.shake = 0;
  }

  get targetable() { return true; }

  waterLevel(world) {
    // top of the water column the boat sits in, or null
    const x = Math.floor(this.x), z = Math.floor(this.z);
    for (let y = Math.floor(this.y + 0.6); y >= Math.floor(this.y - 0.6); y--) {
      if (world.getBlock(x, y, z) === B.water) {
        let top = y;
        while (world.getBlock(x, top + 1, z) === B.water && top < y + 2) top++;
        return top + 0.9;
      }
    }
    return null;
  }

  tick(game) {
    this.savePrev();
    this.ppaddle = this.paddle;
    this.age++;
    if (this.shake > 0) this.shake--;
    if (this.hits > 0 && this.age % 4 === 0) this.hits--;
    const w = game.world;
    const level = this.waterLevel(w);
    const ri = this.rider && this.riderInput;
    let turn = 0, push = 0;
    if (ri) { turn = -ri.strafe; push = ri.forward; }
    // A/D turn the boat, W/S row
    this.yaw += turn * 0.06 * (level !== null ? 1 : 0.4);
    if (this.rider) this.rider.yaw += turn * 0.06 * (level !== null ? 1 : 0.4);
    const acc = level !== null ? 0.04 : 0.006;
    this.vx += Math.sin(this.yaw) * push * acc; this.vz -= Math.cos(this.yaw) * push * acc;
    if (push) this.paddle += 0.4;
    if (level !== null) {
      const target = level - 0.42;
      this.vy += (target - this.y) * 0.18;
      this.vy *= 0.7;
    } else this.vy -= 0.04;
    const r = moveBox(w, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    let f;
    if (level !== null) f = 0.9;
    else if (this.onGround) f = blockFriction(w.getBlock(Math.floor(this.x), Math.floor(this.y - 0.3), Math.floor(this.z))) > 0.9 ? 0.98 : 0.45;
    else f = 0.95;
    this.vx *= f; this.vz *= f;
    if (level !== null && (Math.abs(this.vx) + Math.abs(this.vz)) > 0.08 && this.age % 3 === 0) game.particles.splash(this.x - Math.sin(this.yaw) * 0.7, this.y + 0.35, this.z + Math.cos(this.yaw) * 0.7, 2);
    if (lavaUnder(w, this)) { this.removed = true; if (this.rider) game.dismount(); }
    if (this.y < -64) this.removed = true;
  }

  interact(game) {
    if (this.rider) return false;
    game.mount(this);
    return 'ride';
  }

  hit(game, dmg = 10) {
    this.hits += dmg; this.shake = 10;
    game.audio.blockSound(B.oak_planks, 'hit', this.x, this.y, this.z);
    if (this.hits > 30 || game.player.creative) {
      this.removed = true;
      if (this.rider) game.dismount();
      if (!game.player.creative) game.dropItem(this.x, this.y + 0.5, this.z, { id: I.boat, count: 1 });
      game.audio.blockSound(B.oak_planks, 'break', this.x, this.y, this.z);
    }
  }

  seat() { return [this.x, this.y + 0.1, this.z]; }

  serialize() { return { kind: 'boat', x: this.x, y: this.y, z: this.z, yaw: this.yaw }; }
}

function lavaUnder(world, e) {
  return isLiquid(world.getBlock(Math.floor(e.x), Math.floor(e.y + 0.2), Math.floor(e.z))) && world.getBlock(Math.floor(e.x), Math.floor(e.y + 0.2), Math.floor(e.z)) === B.lava;
}

export function loadVehicle(v) {
  if (v.kind === 'minecart') { const c = new Minecart(v.x, v.y, v.z); c.vx = v.vx || 0; c.vz = v.vz || 0; c.yaw = v.yaw || 0; return c; }
  if (v.kind === 'boat') return new Boat(v.x, v.y, v.z, v.yaw || 0);
  return null;
}

void OPAQUE;
