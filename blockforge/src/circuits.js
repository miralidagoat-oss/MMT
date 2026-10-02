// Spark circuits: power sources, wire networks and the parts they drive.
//
// Power follows a small set of rules:
// - Sources (levers, buttons, pressure plates, detector rails, spark torches,
//   blocks of spark, daylight sensors, powered repeaters) emit level 15 (the
//   sensor emits its stored level) into the blocks next to them.
// - Levers, buttons, plates and detector rails also strongly power the block
//   they sit on; a torch strongly powers the block above it; a repeater
//   strongly powers the block it faces.
// - Wire takes the strongest of its inputs and loses one level per block.
//   It weakly powers the block under it and the blocks it points into.
// - A part (lamp, piston, door, note block, blast crate, dispenser...) runs
//   when anything next to it delivers power, including a powered solid block.
// - A spark torch turns off while the block it hangs on is powered.
import { B, BLOCKS, OPAQUE, SOLID, REPLACEABLE, isLiquid } from './blocks.js';
import { ATTACH_DIR, FACE_DIR, PISTON_EXTENDED, DIRS, DOOR_OPEN, DOOR_UPPER } from './shapes.js';
import { daylight } from './env.js';

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const WD = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // wire directions N E S W
const TORCH_ATTACH = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];
const K = (x, y, z) => `${x},${y},${z}`;
const role = (id) => (BLOCKS[id] ? BLOCKS[id].spark : null);

// Blocks a piston cannot move.
const IMMOVABLE = new Set();
// Blocks a piston breaks instead of pushing.
const FRAGILE = new Set();
function initSets() {
  if (IMMOVABLE.size) return;
  for (const n of ['bedrock', 'obsidian', 'piston_head', 'spawner', 'star_frame', 'void_gate', 'void_gateway', 'rift',
    'chest', 'furnace', 'furnace_lit', 'brewing_stand', 'dispenser', 'hopper', 'oak_sign', 'oak_wall_sign', 'enchanting_table',
    'dropper', 'beacon', 'void_chest', 'crafter', 'lectern', 'bee_nest', 'beehive', 'banner', 'wall_banner']) IMMOVABLE.add(B[n]);
  for (const n of ['spark_wire', 'spark_torch', 'spark_torch_off', 'torch', 'lever', 'stone_button', 'oak_button',
    'stone_pressure_plate', 'oak_pressure_plate', 'repeater', 'rail', 'powered_rail', 'detector_rail', 'fire', 'cobweb',
    'wheat', 'carrots', 'potatoes', 'tall_grass', 'fern', 'dandelion', 'poppy', 'cornflower', 'dead_bush', 'sugar_cane',
    'oak_sapling', 'birch_sapling', 'spruce_sapling', 'brown_mushroom', 'red_mushroom', 'ladder', 'oak_door', 'bed',
    'cake', 'lantern', 'glowcap', 'ashen_shrub', 'snow_block', 'void_stalk', 'void_bloom', 'glow_rod']) FRAGILE.add(B[n]);
}

export class Circuits {
  constructor(game) {
    this.game = game;
    this.queue = [];
    this.queued = new Set();
    this.timers = [];
    this.flips = new Map();     // torch burnout bookkeeping
    this.sensors = new Set();
    this.comparators = new Set(); // re-read now and then: containers fill without block changes
    this.occupied = new Set();  // plates and detector rails something stands on
    this.updates = 0;
    initSets();
  }

  get world() { return this.game.world; }
  clear() { this.queue.length = 0; this.queued.clear(); this.timers.length = 0; this.flips.clear(); this.sensors.clear(); this.occupied.clear(); this.comparators.clear(); }

  // ---------------------------------------------------------------------------
  // Scheduling
  mark(x, y, z) {
    const k = K(x, y, z);
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push(x, y, z);
  }
  markAround(x, y, z, r = 1) {
    for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) this.mark(x + dx, y + dy, z + dz);
  }
  // after a part changed state: its neighbours and theirs (powering through blocks)
  markOut(x, y, z) {
    this.mark(x, y, z);
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      this.mark(nx, ny, nz);
      if (OPAQUE[this.world.getBlock(nx, ny, nz)]) for (const [ex, ey, ez] of N6) this.mark(nx + ex, ny + ey, nz + ez);
    }
  }
  schedule(x, y, z, delay, kind) { this.timers.push({ t: this.game.tickCount + delay, x, y, z, kind }); }

  onBlockChanged(x, y, z, old, id) {
    if (role(old) || role(id) || OPAQUE[old] !== OPAQUE[id]) {
      this.markAround(x, y, z, 1);
      // wires two blocks away can climb over the changed block
      for (const [dx, , dz] of N6) if (dx || dz) { this.mark(x + dx * 2, y, z + dz * 2); this.mark(x + dx, y - 1, z + dz); this.mark(x + dx, y + 1, z + dz); }
    }
    if (id === B.daylight_sensor) this.sensors.add(K(x, y, z));
    if (id === B.comparator) this.comparators.add(K(x, y, z));
  }

  // Any change at (x,y,z), including quiet ones: observers watching it pulse.
  observe(x, y, z) {
    for (const [dx, dy, dz] of N6) {
      const ox = x + dx, oy = y + dy, oz = z + dz;
      if (this.get(ox, oy, oz) !== B.observer) continue;
      const m = this.meta(ox, oy, oz);
      const [fx, fy, fz] = FACE_DIR[m & 7];
      if (ox + fx !== x || oy + fy !== y || oz + fz !== z || (m & 8)) continue;
      const k = K(ox, oy, oz);
      if (this.pending && this.pending.has(k)) continue;
      (this.pending || (this.pending = new Set())).add(k);
      this.schedule(ox, oy, oz, 2, 'observer_on');
    }
  }

  tick() {
    const g = this.game;
    // timers
    if (this.timers.length) {
      const due = [];
      this.timers = this.timers.filter((t) => (t.t <= g.tickCount ? (due.push(t), false) : true));
      for (const t of due) this.fire(t);
    }
    // pressure plates and detector rails
    if (g.tickCount % 2 === 0) this.checkPlates();
    if (g.tickCount % 20 === 0) this.tickSensors();
    if (g.tickCount % 4 === 0) {
      for (const k of this.comparators) {
        const [x, y, z] = k.split(',').map(Number);
        if (this.get(x, y, z) !== B.comparator) this.comparators.delete(k); else this.mark(x, y, z);
      }
    }
    // queued updates (a budget keeps runaway loops from freezing the game)
    this.netDone = new Set();
    let budget = 3000, head = 0;
    const q = this.queue;
    while (head < q.length && budget-- > 0) {
      const x = q[head], y = q[head + 1], z = q[head + 2];
      head += 3;
      this.queued.delete(K(x, y, z));
      this.update(x, y, z);
    }
    if (budget <= 0) { q.length = 0; this.queued.clear(); } else q.splice(0, head);
  }

  // ---------------------------------------------------------------------------
  // Queries
  get(x, y, z) { return this.world.getBlock(x, y, z); }
  meta(x, y, z) { return this.world.getMeta(x, y, z); }

  torchAttach(x, y, z) {
    const m = this.meta(x, y, z) & 7;
    const d = TORCH_ATTACH[m] || TORCH_ATTACH[0];
    return [x + d[0], y + d[1], z + d[2]];
  }
  attachOf(x, y, z) {
    const a = this.meta(x, y, z) & 7;
    const d = ATTACH_DIR[a] || ATTACH_DIR[0];
    return [x + d[0], y + d[1], z + d[2]];
  }

  // Power a source at (x,y,z) sends into the neighbouring position (tx,ty,tz).
  emitsTo(x, y, z, tx, ty, tz) {
    const id = this.get(x, y, z);
    const r = role(id);
    if (!r) return 0;
    const m = this.meta(x, y, z);
    switch (r) {
      case 'block': return 15;
      case 'torch': {
        if (id !== B.spark_torch) return 0;
        const [ax, ay, az] = this.torchAttach(x, y, z);
        return ax === tx && ay === ty && az === tz ? 0 : 15;
      }
      case 'lever': case 'button': return m & 8 ? 15 : 0;
      case 'plate': return m & 1 ? 15 : 0;
      case 'detector': return m & 8 ? 15 : 0;
      case 'sensor': return m & 15;
      case 'pulse': return (m >> 4) & 15; // lightning rods and sculk sensors
      case 'repeater': {
        if (!(m & 16)) return 0;
        const [dx, dz] = DIRS[m & 3];
        return x + dx === tx && y === ty && z + dz === tz ? 15 : 0;
      }
      case 'comparator': {
        const lvl = (m >> 4) & 15;
        if (!lvl) return 0;
        const [dx, dz] = DIRS[m & 3];
        return x + dx === tx && y === ty && z + dz === tz ? lvl : 0;
      }
      case 'observer': {
        if (!(m & 8)) return 0;
        const [dx, dy, dz] = FACE_DIR[m & 7];
        return x - dx === tx && y - dy === ty && z - dz === tz ? 15 : 0;
      }
      default: return 0;
    }
  }

  // Is the solid block at b strongly powered (lever on it, torch under it...)?
  strong(bx, by, bz) {
    for (const [dx, dy, dz] of N6) {
      const x = bx + dx, y = by + dy, z = bz + dz;
      const id = this.get(x, y, z);
      const r = role(id);
      if (!r) continue;
      const m = this.meta(x, y, z);
      if ((r === 'lever' || r === 'button') && (m & 8)) {
        const [ax, ay, az] = this.attachOf(x, y, z);
        if (ax === bx && ay === by && az === bz) return true;
      } else if (r === 'torch' && id === B.spark_torch && dy === -1) {
        return true; // a torch powers the block above it
      } else if ((r === 'plate' && (m & 1) && dy === 1) || (r === 'detector' && (m & 8) && dy === 1)) {
        return true;
      } else if (r === 'repeater' && (m & 16)) {
        const [fx, fz] = DIRS[m & 3];
        if (x + fx === bx && y === by && z + fz === bz) return true;
      } else if (r === 'comparator' && ((m >> 4) & 15)) {
        const [fx, fz] = DIRS[m & 3];
        if (x + fx === bx && y === by && z + fz === bz) return true;
      } else if (r === 'observer' && (m & 8)) {
        const [fx, fy, fz] = FACE_DIR[m & 7];
        if (x - fx === bx && y - fy === by && z - fz === bz) return true;
      }
    }
    return false;
  }

  // Wire connection directions (N E S W), as drawn.
  wireCon(x, y, z) {
    const con = [0, 0, 0, 0];
    const cover = OPAQUE[this.get(x, y + 1, z)];
    for (let d = 0; d < 4; d++) {
      const nx = x + WD[d][0], nz = z + WD[d][1];
      const n = this.get(nx, y, nz);
      const r = role(n);
      if (r && ((r !== 'repeater' && r !== 'comparator') || ((this.meta(nx, y, nz) & 3) & 1) === (d & 1)) &&
        ['wire', 'torch', 'lever', 'button', 'plate', 'block', 'detector', 'sensor', 'repeater', 'comparator', 'observer'].includes(r)) con[d] = 1;
      else if (!cover && this.get(nx, y + 1, nz) === B.spark_wire) con[d] = 1;
      else if (!OPAQUE[n] && this.get(nx, y - 1, nz) === B.spark_wire) con[d] = 1;
    }
    return con;
  }

  // Does the wire at w point into direction d?
  wirePoints(x, y, z, d) {
    const con = this.wireCon(x, y, z);
    const n = con[0] + con[1] + con[2] + con[3];
    if (n === 0) return true;
    if (n === 1) return con[d] || con[(d + 2) & 3];
    return !!con[d];
  }

  // Weak power into a solid block: wire on top, or wire pointing into it.
  weak(bx, by, bz) {
    if (this.get(bx, by + 1, bz) === B.spark_wire && (this.meta(bx, by + 1, bz) & 15) > 0) return true;
    for (let d = 0; d < 4; d++) {
      const x = bx - WD[d][0], z = bz - WD[d][1]; // a wire on the far side pointing toward us (direction d)
      if (this.get(x, by, z) === B.spark_wire && (this.meta(x, by, z) & 15) > 0 && this.wirePoints(x, by, z, d)) return true;
    }
    return false;
  }

  blockPowered(x, y, z) { return OPAQUE[this.get(x, y, z)] === 1 && (this.strong(x, y, z) || this.weak(x, y, z)); }

  // Does anything next to (x,y,z) deliver power to a part sitting there?
  // skip: an optional neighbour position to ignore (a piston's face).
  receives(x, y, z, skip = null) {
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (skip && skip[0] === nx && skip[1] === ny && skip[2] === nz) continue;
      const id = this.get(nx, ny, nz);
      if (!id) continue;
      if (id === B.spark_wire) {
        const p = this.meta(nx, ny, nz) & 15;
        if (!p) continue;
        if (dy === 1) return true; // wire resting on this part's top
        if (dy === 0) {
          const d = WD.findIndex((w) => w[0] === -dx && w[1] === -dz);
          if (d >= 0 && this.wirePoints(nx, ny, nz, d)) return true;
        }
        continue;
      }
      if (this.emitsTo(nx, ny, nz, x, y, z) > 0) return true;
      if (OPAQUE[id] && (this.strong(nx, ny, nz) || this.weak(nx, ny, nz))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Updates
  update(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    const r = role(id);
    if (!r) {
      if (id === B.piston_head) this.checkHead(x, y, z);
      return;
    }
    this.updates++;
    const m = w.getMeta(x, y, z);
    switch (r) {
      case 'wire': this.updateNetwork(x, y, z); break;
      case 'torch': {
        const [ax, ay, az] = this.torchAttach(x, y, z);
        const powered = this.blockPowered(ax, ay, az);
        const on = id === B.spark_torch;
        if (on === powered) this.schedule(x, y, z, 2, 'torch');
        break;
      }
      case 'repeater': {
        const input = this.repeaterInput(x, y, z, m);
        if (input !== !!(m & 16)) this.schedule(x, y, z, (((m >> 2) & 3) + 1) * 2, 'repeater');
        break;
      }
      case 'lamp': {
        const p = this.receives(x, y, z);
        if (p && id === B.spark_lamp) { w.setBlock(x, y, z, B.spark_lamp_on, 0, { notify: false }); this.markOut(x, y, z); this.game.advance('spark'); }
        else if (!p && id === B.spark_lamp_on) this.schedule(x, y, z, 4, 'lamp');
        break;
      }
      case 'piston': this.updatePiston(x, y, z, id, m); break;
      case 'door': {
        if (m & DOOR_UPPER) { this.mark(x, y - 1, z); break; }
        const p = this.receives(x, y, z) || this.receives(x, y + 1, z);
        const mem = !!(m & 32);
        if (p !== mem) {
          const open = p ? DOOR_OPEN : 0;
          const nm = (m & ~(DOOR_OPEN | 32)) | open | (p ? 32 : 0);
          w.setBlock(x, y, z, id, nm, { notify: false });
          if (w.getBlock(x, y + 1, z) === id) { const um = w.getMeta(x, y + 1, z); w.setBlock(x, y + 1, z, id, (um & ~DOOR_OPEN) | open, { notify: false }); }
          if (!!(m & DOOR_OPEN) !== p) this.game.audio.play(p ? 'door_open' : 'door_close', x + 0.5, y + 0.5, z + 0.5);
        }
        break;
      }
      case 'trapdoor': case 'gate': {
        const bit = r === 'trapdoor' ? 16 : 8;
        const p = this.receives(x, y, z);
        if (p !== !!(m & bit)) {
          const nm = (m & ~(4 | bit)) | (p ? 4 | bit : 0);
          w.setBlock(x, y, z, id, nm, { notify: false });
          if (!!(m & 4) !== p) this.game.audio.play(p ? 'door_open' : 'door_close', x + 0.5, y + 0.5, z + 0.5, 0.8);
        }
        break;
      }
      case 'note': {
        const p = this.receives(x, y, z);
        if (p !== !!(m & 32)) {
          w.setBlock(x, y, z, id, (m & 31) | (p ? 32 : 0), { notify: false });
          if (p) this.game.playNote(x, y, z);
        }
        break;
      }
      case 'tnt': if (this.receives(x, y, z)) this.game.primeCrate(x, y, z); break;
      case 'dispenser': {
        const p = this.receives(x, y, z);
        if (p !== !!(m & 8)) {
          w.setBlock(x, y, z, id, (m & 7) | (p ? 8 : 0), { notify: false, keepEntity: true });
          if (p) this.schedule(x, y, z, 4, 'dispense');
        }
        break;
      }
      case 'pulse': break;
      case 'crafter': {
        const p = this.receives(x, y, z);
        if (p !== !!(m & 8)) {
          w.setBlock(x, y, z, id, (m & 7) | (p ? 8 : 0), { notify: false, keepEntity: true });
          if (p) this.schedule(x, y, z, 4, 'craft');
        }
        break;
      }
      case 'hopper': {
        const p = this.receives(x, y, z);
        if (p !== !!(m & 8)) w.setBlock(x, y, z, id, (m & 7) | (p ? 8 : 0), { notify: false, keepEntity: true });
        break;
      }
      case 'powered_rail': {
        const p = this.railPowered(x, y, z);
        if (p !== !!(m & 8)) {
          w.setBlock(x, y, z, id, (m & 7) | (p ? 8 : 0), { notify: false });
          // neighbours along the line re-check
          for (const [dx, , dz] of N6) if (dx || dz) for (let dy = -1; dy <= 1; dy++) this.mark(x + dx, y + dy, z + dz);
        }
        break;
      }
      case 'button': if (m & 8) this.schedule(x, y, z, id === B.oak_button ? 30 : 20, 'button'); break;
      case 'plate': case 'detector': if ((r === 'plate' ? m & 1 : m & 8)) this.schedule(x, y, z, 20, 'plate'); break;
      case 'sensor': this.sensors.add(K(x, y, z)); break;
      case 'comparator': {
        this.comparators.add(K(x, y, z));
        if (this.comparatorOutput(x, y, z, m) !== ((m >> 4) & 15)) this.schedule(x, y, z, 2, 'comparator');
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------------------
  // Comparators: the signal from behind (a container's fullness, a wire's
  // strength...) against the strongest signal from the sides. Compare mode
  // passes the back signal if it is at least the side; subtract mode outputs
  // the difference.
  comparatorOutput(x, y, z, m) {
    const [dx, dz] = DIRS[m & 3];
    const back = this.levelInto(x - dx, y, z - dz, x, y, z, true);
    let side = 0;
    for (const s of [1, 3]) {
      const [sx, sz] = DIRS[((m & 3) + s) & 3];
      side = Math.max(side, this.levelInto(x + sx, y, z + sz, x, y, z, false));
    }
    if (m & 4) return Math.max(0, back - side);
    return back >= side ? back : 0;
  }

  // Signal strength the block at n sends into (x,y,z).
  levelInto(nx, ny, nz, x, y, z, measure) {
    const id = this.get(nx, ny, nz);
    if (!id) return 0;
    if (measure) {
      const lvl = this.game.measureBlock ? this.game.measureBlock(nx, ny, nz, id) : -1;
      if (lvl >= 0) return lvl;
    }
    if (id === B.spark_wire) return this.meta(nx, ny, nz) & 15;
    const e = this.emitsTo(nx, ny, nz, x, y, z);
    if (e) return e;
    if (measure && OPAQUE[id] && (this.strong(nx, ny, nz) || this.weak(nx, ny, nz))) return 15;
    return 0;
  }

  toggleComparator(x, y, z) {
    const m = this.meta(x, y, z) ^ 4;
    this.world.setBlock(x, y, z, B.comparator, m, { notify: false });
    this.game.audio.play('click', x + 0.5, y + 0.2, z + 0.5, m & 4 ? 0.55 : 0.45);
    this.mark(x, y, z);
  }

  // Timer callbacks.
  fire(t) {
    const { x, y, z } = t;
    const w = this.world;
    const id = w.getBlock(x, y, z), m = w.getMeta(x, y, z);
    switch (t.kind) {
      case 'unpulse':
        if (role(id) === 'pulse' && (m >> 4)) { w.setBlock(x, y, z, id, m & 15, { notify: false, keepEntity: true }); this.markOut(x, y, z); }
        return;
      case 'torch': {
        if (role(id) !== 'torch') return;
        const [ax, ay, az] = this.torchAttach(x, y, z);
        const powered = this.blockPowered(ax, ay, az);
        const on = id === B.spark_torch;
        if (on !== powered) return; // already right
        // burnout: too many flips in a short time
        const k = K(x, y, z);
        const now = this.game.tickCount;
        const list = (this.flips.get(k) || []).filter((tt) => now - tt < 60);
        if (on === false && list.length >= 8) {
          this.schedule(x, y, z, 160, 'torch');
          this.game.particles.smoke(x + 0.5, y + 0.7, z + 0.5);
          this.game.audio.play('fizz', x + 0.5, y + 0.5, z + 0.5, 0.4);
          return;
        }
        list.push(now); this.flips.set(k, list);
        w.setBlock(x, y, z, on ? B.spark_torch_off : B.spark_torch, m, { notify: false });
        this.markOut(x, y, z);
        this.mark(ax, ay + 1, az);
        return;
      }
      case 'repeater': {
        if (id !== B.repeater) return;
        const input = this.repeaterInput(x, y, z, m);
        if (input === !!(m & 16)) return;
        w.setBlock(x, y, z, id, (m & ~16) | (input ? 16 : 0), { notify: false });
        const [dx, dz] = DIRS[m & 3];
        this.markOut(x + dx, y, z + dz);
        this.mark(x, y, z);
        return;
      }
      case 'lamp':
        if (id === B.spark_lamp_on && !this.receives(x, y, z)) { w.setBlock(x, y, z, B.spark_lamp, 0, { notify: false }); this.markOut(x, y, z); }
        return;
      case 'button':
        if (role(id) === 'button' && (m & 8)) {
          w.setBlock(x, y, z, id, m & ~8, { notify: false });
          this.game.audio.play('click', x + 0.5, y + 0.5, z + 0.5, 0.5);
          this.markOut(x, y, z);
          const [ax, ay, az] = this.attachOf(x, y, z);
          this.markOut(ax, ay, az);
        }
        return;
      case 'plate': {
        const r = role(id);
        if (r !== 'plate' && r !== 'detector') return;
        const pressed = r === 'plate' ? m & 1 : m & 8;
        if (!pressed) return;
        if (this.occupied.has(K(x, y, z))) { this.schedule(x, y, z, 20, 'plate'); return; }
        w.setBlock(x, y, z, id, r === 'plate' ? m & ~1 : m & ~8, { notify: false });
        if (r === 'plate') this.game.audio.play('click', x + 0.5, y + 0.1, z + 0.5, 0.4);
        this.markOut(x, y, z); this.markOut(x, y - 1, z);
        return;
      }
      case 'dispense':
        if (id === B.dispenser || id === B.dropper) this.game.dispense(x, y, z, m & 7, id === B.dropper);
        return;
      case 'craft':
        if (id === B.crafter) this.game.crafterCraft(x, y, z, m & 7);
        return;
      case 'comparator': {
        if (id !== B.comparator) return;
        const out = this.comparatorOutput(x, y, z, m);
        if (out === ((m >> 4) & 15)) return;
        w.setBlock(x, y, z, id, (m & 7) | (out ? 8 : 0) | (out << 4), { notify: false });
        const [dx, dz] = DIRS[m & 3];
        this.markOut(x + dx, y, z + dz);
        this.mark(x, y, z);
        return;
      }
      case 'observer_on': {
        if (this.pending) this.pending.delete(K(x, y, z));
        if (id !== B.observer || (m & 8)) return;
        w.setBlock(x, y, z, id, m | 8, { notify: false });
        const [dx, dy, dz] = FACE_DIR[m & 7];
        this.markOut(x - dx, y - dy, z - dz);
        this.schedule(x, y, z, 2, 'observer_off');
        return;
      }
      case 'observer_off': {
        if (id !== B.observer || !(m & 8)) return;
        w.setBlock(x, y, z, id, m & ~8, { notify: false });
        const [dx, dy, dz] = FACE_DIR[m & 7];
        this.markOut(x - dx, y - dy, z - dz);
        return;
      }
      case 'piston':
        this.update(x, y, z);
        return;
      default:
    }
  }

  repeaterInput(x, y, z, m) {
    const [dx, dz] = DIRS[m & 3];
    const bx = x - dx, bz = z - dz;
    const bid = this.get(bx, y, bz);
    if (bid === B.spark_wire) return (this.meta(bx, y, bz) & 15) > 0;
    if (this.emitsTo(bx, y, bz, x, y, z) > 0) return true;
    if (OPAQUE[bid]) return this.strong(bx, y, bz) || this.weak(bx, y, bz);
    return false;
  }

  // Powered rails pass power along up to 8 rails in a straight line.
  railPowered(x, y, z) {
    if (this.receives(x, y, z)) return true;
    const shape = this.meta(x, y, z) & 7;
    const axes = shape === 1 || shape === 2 || shape === 3 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [dx, dz] of axes) {
      let cx = x, cy = y, cz = z;
      for (let i = 1; i <= 8; i++) {
        cx += dx; cz += dz;
        let id = this.get(cx, cy, cz);
        if (id !== B.powered_rail) { if (this.get(cx, cy + 1, cz) === B.powered_rail) cy++; else if (this.get(cx, cy - 1, cz) === B.powered_rail) cy--; else break; id = B.powered_rail; }
        if (this.receives(cx, cy, cz)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Wire networks: gather the connected wire and spread power from its inputs.
  wireNeighbours(x, y, z) {
    const out = [];
    const cover = OPAQUE[this.get(x, y + 1, z)];
    for (let d = 0; d < 4; d++) {
      const nx = x + WD[d][0], nz = z + WD[d][1];
      const n = this.get(nx, y, nz);
      if (n === B.spark_wire) out.push([nx, y, nz]);
      else {
        if (!cover && this.get(nx, y + 1, nz) === B.spark_wire) out.push([nx, y + 1, nz]);
        if (!OPAQUE[n] && this.get(nx, y - 1, nz) === B.spark_wire) out.push([nx, y - 1, nz]);
      }
    }
    return out;
  }

  wireInput(x, y, z) {
    let best = 0;
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const id = this.get(nx, ny, nz);
      if (!id || id === B.spark_wire) continue;
      const e = this.emitsTo(nx, ny, nz, x, y, z);
      if (e > best) best = e;
      if (best < 15 && OPAQUE[id] && this.strong(nx, ny, nz)) best = 15;
      if (best === 15) return 15;
    }
    return best;
  }

  updateNetwork(x, y, z) {
    const k0 = K(x, y, z);
    if (this.netDone.has(k0)) return;
    const w = this.world;
    const nodes = [], index = new Map();
    const stack = [[x, y, z]];
    index.set(k0, 0); nodes.push({ x, y, z, p: 0, adj: null });
    while (stack.length && nodes.length < 4096) {
      const [cx, cy, cz] = stack.pop();
      const node = nodes[index.get(K(cx, cy, cz))];
      node.adj = [];
      for (const [nx, ny, nz] of this.wireNeighbours(cx, cy, cz)) {
        const k = K(nx, ny, nz);
        if (!index.has(k)) { index.set(k, nodes.length); nodes.push({ x: nx, y: ny, z: nz, p: 0, adj: null }); stack.push([nx, ny, nz]); }
        node.adj.push(index.get(k));
      }
    }
    // inputs, then spread highest first
    const buckets = Array.from({ length: 16 }, () => []);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      this.netDone.add(K(n.x, n.y, n.z));
      n.p = this.wireInput(n.x, n.y, n.z);
      if (n.p > 0) buckets[n.p].push(i);
    }
    for (let lvl = 15; lvl > 1; lvl--) {
      for (const i of buckets[lvl]) {
        const n = nodes[i];
        if (n.p !== lvl || !n.adj) continue;
        for (const j of n.adj) if (nodes[j].p < lvl - 1) { nodes[j].p = lvl - 1; buckets[lvl - 1].push(j); }
      }
    }
    for (const n of nodes) {
      const old = w.getMeta(n.x, n.y, n.z) & 15;
      if (old === n.p) continue;
      w.setBlock(n.x, n.y, n.z, B.spark_wire, n.p, { notify: false, urgent: true });
      // parts and blocks around this wire re-check
      for (const [dx, dy, dz] of N6) {
        const ax = n.x + dx, ay = n.y + dy, az = n.z + dz;
        const id = this.get(ax, ay, az);
        if (id === B.spark_wire) continue;
        this.mark(ax, ay, az);
        if (OPAQUE[id]) for (const [ex, ey, ez] of N6) { const bid = this.get(ax + ex, ay + ey, az + ez); if (bid !== B.spark_wire && role(bid)) this.mark(ax + ex, ay + ey, az + ez); }
      }
      if (n.p > 0 && Math.random() < 0.02) this.game.particles.sparkDust(n.x + 0.5, n.y + 0.1, n.z + 0.5);
    }
  }

  // ---------------------------------------------------------------------------
  // Pistons
  updatePiston(x, y, z, id, m) {
    const f = m & 7;
    const [dx, dy, dz] = FACE_DIR[f];
    const ext = !!(m & PISTON_EXTENDED);
    if (ext && this.get(x + dx, y + dy, z + dz) !== B.piston_head) {
      // lost its head (broken or moved): retract quietly
      this.world.setBlock(x, y, z, id, m & ~PISTON_EXTENDED, { notify: false });
      return;
    }
    const p = this.receives(x, y, z, [x + dx, y + dy, z + dz]);
    if (p && !ext) this.extend(x, y, z, id, f);
    else if (!p && ext) this.retract(x, y, z, id, f);
  }

  checkHead(x, y, z) {
    const m = this.meta(x, y, z);
    const [dx, dy, dz] = FACE_DIR[m & 7];
    const base = this.get(x - dx, y - dy, z - dz);
    const bm = this.meta(x - dx, y - dy, z - dz);
    if ((base !== B.piston && base !== B.sticky_piston) || !(bm & PISTON_EXTENDED) || (bm & 7) !== (m & 7)) this.world.setBlock(x, y, z, 0, 0);
  }

  // Blocks in front of a piston that would move, or null if it cannot extend.
  pushList(x, y, z, f) {
    const [dx, dy, dz] = FACE_DIR[f];
    const list = [];
    let cx = x, cy = y, cz = z;
    for (let i = 0; i <= 12; i++) {
      cx += dx; cy += dy; cz += dz;
      if (cy < 1 || cy > 254) return null;
      const id = this.get(cx, cy, cz);
      if (id === 0 || isLiquid(id) || FRAGILE.has(id) || (REPLACEABLE[id] && !SOLID[id])) return { list, end: [cx, cy, cz], endId: id };
      if (i === 12) return null;
      if (IMMOVABLE.has(id) || BLOCKS[id].hardness < 0) return null;
      if ((id === B.piston || id === B.sticky_piston) && (this.meta(cx, cy, cz) & PISTON_EXTENDED)) return null;
      if (this.world.blockEntities.has(K(cx, cy, cz))) return null;
      list.push([cx, cy, cz, id, this.meta(cx, cy, cz)]);
    }
    return null;
  }

  extend(x, y, z, id, f) {
    const w = this.world, g = this.game;
    const plan = this.pushList(x, y, z, f);
    if (!plan) return false;
    const [dx, dy, dz] = FACE_DIR[f];
    if (plan.endId && !isLiquid(plan.endId)) g.breakNaturally(...plan.end);
    for (let i = plan.list.length - 1; i >= 0; i--) {
      const [bx, by, bz, bid, bm] = plan.list[i];
      w.setBlock(bx + dx, by + dy, bz + dz, bid, bm);
    }
    w.setBlock(x + dx, y + dy, z + dz, B.piston_head, f | (id === B.sticky_piston ? 8 : 0), { notify: false });
    w.setBlock(x, y, z, id, f | PISTON_EXTENDED, { notify: false });
    // carry anything standing in the way
    const cells = [[x + dx, y + dy, z + dz], ...plan.list.map(([bx, by, bz]) => [bx + dx, by + dy, bz + dz])];
    g.pushEntities(cells, dx, dy, dz);
    g.audio.play('piston_out', x + 0.5, y + 0.5, z + 0.5);
    for (const [cx, cy, cz] of cells) this.markOut(cx, cy, cz);
    this.markOut(x, y, z);
    return true;
  }

  retract(x, y, z, id, f) {
    const w = this.world, g = this.game;
    const [dx, dy, dz] = FACE_DIR[f];
    w.setBlock(x + dx, y + dy, z + dz, 0, 0, { notify: false });
    w.setBlock(x, y, z, id, f, { notify: false });
    if (id === B.sticky_piston) {
      const px = x + dx * 2, py = y + dy * 2, pz = z + dz * 2;
      const pid = this.get(px, py, pz);
      if (pid && !isLiquid(pid) && !FRAGILE.has(pid) && !IMMOVABLE.has(pid) && BLOCKS[pid].hardness >= 0 && !REPLACEABLE[pid] &&
        !w.blockEntities.has(K(px, py, pz)) && !((pid === B.piston || pid === B.sticky_piston) && (this.meta(px, py, pz) & PISTON_EXTENDED))) {
        const pm = this.meta(px, py, pz);
        w.setBlock(px, py, pz, 0, 0);
        w.setBlock(x + dx, y + dy, z + dz, pid, pm);
      }
    }
    g.audio.play('piston_in', x + 0.5, y + 0.5, z + 0.5);
    this.markOut(x + dx, y + dy, z + dz);
    this.markOut(x + dx * 2, y + dy * 2, z + dz * 2);
    this.markOut(x, y, z);
  }

  // ---------------------------------------------------------------------------
  // Pressure plates and detector rails: pressed while something is on them.
  checkPlates() {
    const g = this.game, w = this.world;
    const occ = new Set();
    const consider = (e, wood) => {
      const x0 = Math.floor(e.x - e.w + 0.05), x1 = Math.floor(e.x + e.w - 0.05);
      const z0 = Math.floor(e.z - e.w + 0.05), z1 = Math.floor(e.z + e.w - 0.05);
      const y = Math.floor(e.y + 0.05);
      for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) {
        const id = w.getBlock(xx, y, zz);
        if (id === B.stone_pressure_plate && wood === 'item') continue;
        if (id === B.stone_pressure_plate || id === B.oak_pressure_plate || (id === B.detector_rail && wood === 'cart')) occ.add(K(xx, y, zz));
      }
    };
    const p = g.player;
    if (p && !p.dead && !p.spectator) consider(p, 'player');
    for (const e of g.entities) if (!e.removed && !e.dead && e.isCart) consider(e, 'cart'); else if (!e.removed && !e.dead && e.isMob) consider(e, 'mob');
    for (const it of g.items) if (!it.removed) consider(it, 'item');
    if (g.remotePlayers) for (const rp of g.remotePlayers()) consider(rp, 'player');
    this.occupied = occ;
    for (const k of occ) {
      const [x, y, z] = k.split(',').map(Number);
      const id = w.getBlock(x, y, z), m = w.getMeta(x, y, z);
      if (id === B.detector_rail) {
        if (!(m & 8)) { w.setBlock(x, y, z, id, m | 8, { notify: false }); this.markOut(x, y, z); this.markOut(x, y - 1, z); this.schedule(x, y, z, 20, 'plate'); }
      } else if (!(m & 1)) {
        w.setBlock(x, y, z, id, m | 1, { notify: false });
        g.audio.play('click', x + 0.5, y + 0.1, z + 0.5, 0.4);
        this.markOut(x, y, z); this.markOut(x, y - 1, z);
        this.schedule(x, y, z, 20, 'plate');
      }
    }
  }

  // Daylight sensors follow the sun.
  tickSensors() {
    const g = this.game, w = this.world;
    for (const k of this.sensors) {
      const [x, y, z] = k.split(',').map(Number);
      if (w.getBlock(x, y, z) !== B.daylight_sensor) { this.sensors.delete(k); continue; }
      const sky = w.getLight(x, y + 1, z) >> 4;
      const level = g.dim === 'overworld' ? Math.max(0, Math.min(15, Math.round(sky * daylight(g.dayTime, g.rain) - 1))) : 0;
      if ((w.getMeta(x, y, z) & 15) !== level) { w.setBlock(x, y, z, B.daylight_sensor, level, { notify: false, urgent: false }); this.markOut(x, y, z); }
    }
  }

  // ---------------------------------------------------------------------------
  // Player actions on parts.
  toggleLever(x, y, z) {
    const m = this.meta(x, y, z) ^ 8;
    this.world.setBlock(x, y, z, B.lever, m, { notify: false });
    this.game.audio.play('click', x + 0.5, y + 0.5, z + 0.5, 0.6);
    this.markOut(x, y, z);
    const [ax, ay, az] = this.attachOf(x, y, z);
    this.markOut(ax, ay, az);
  }
  pressButton(x, y, z) {
    const id = this.get(x, y, z), m = this.meta(x, y, z);
    if (m & 8) return;
    this.world.setBlock(x, y, z, id, m | 8, { notify: false });
    this.game.audio.play('click', x + 0.5, y + 0.5, z + 0.5, 0.6);
    this.markOut(x, y, z);
    const [ax, ay, az] = this.attachOf(x, y, z);
    this.markOut(ax, ay, az);
    this.schedule(x, y, z, id === B.oak_button ? 30 : 20, 'button');
  }
  cycleRepeater(x, y, z) {
    const m = this.meta(x, y, z);
    const delay = (((m >> 2) & 3) + 1) & 3;
    this.world.setBlock(x, y, z, B.repeater, (m & ~12) | (delay << 2), { notify: false });
    this.game.audio.play('click', x + 0.5, y + 0.2, z + 0.5, 0.4);
  }
}
