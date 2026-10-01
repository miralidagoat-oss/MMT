// Gameplay for the third wave of features, mixed into Game: vehicles,
// circuit parts, dispensers and hoppers, brewing, fire, the star gate and the
// Void, maps, signs, fishing, drinking and shields.
import { B, BLOCKS, SOLID, OPAQUE, REPLACEABLE, isLiquid, SHAPE_KIND } from './blocks.js';
import { ITEMS, I, maxStack, POTION_KINDS } from './items.js';
import { Mob, MOB_TYPES, ItemEntity, PrimedCrate, Projectile } from './entities.js';
import { golemAt } from './creatures.js';
import { Minecart, Boat, placeRail, isRail, loadVehicle } from './vehicles.js';
import { potionEffect, brew, isIngredient, addEffect, EFFECTS } from './effects.js';
import { Pylon, Wyrm, StarEye, WYRM_HEALTH } from './voidboss.js';
import { Bobber } from './fishing.js';
import { MapData } from './maps.js';
import { ATTACH_DIR, FACE_DIR, DIRS, SHAPE, PISTON_EXTENDED } from './shapes.js';
import { boxFree, raycast } from './physics.js';
import { newChest } from './inventory.js';
import { OUTER_START } from './voidlands.js';

const K = (x, y, z) => `${x},${y},${z}`;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const INSTRUMENT = { wood: 'bass', stone: 'drum', sand: 'snare', gravel: 'snare', glass: 'click', metal: 'bell', cloth: 'guitar', snow: 'chime' };

// Does a block offer a solid top for wire, rails, plates and repeaters?
export function solidTop(id, meta) {
  if (OPAQUE[id]) return true;
  const k = SHAPE_KIND[id];
  if (k === SHAPE.SLAB) return (meta & 1) === 1;
  if (k === SHAPE.STAIRS) return (meta & 4) === 4;
  return id === B.piston || id === B.sticky_piston || id === B.hopper || id === B.glass || id === B.ice;
}

export function newBrewing() { return { type: 'brewing', slots: [null, null, null, null, null], brewTime: 0, fuel: 0, ingId: 0 }; }
export function newDispenser() { return { type: 'dispenser', slots: new Array(9).fill(null) }; }
export function newHopper() { return { type: 'hopper', slots: new Array(5).fill(null), cooldown: 0 }; }

export function installFeatures(Game) {
  Object.assign(Game.prototype, methods);
}

const methods = {
  // ---------------------------------------------------------------------------
  // Vehicles
  mount(v) {
    const p = this.player;
    if (p.vehicle) this.dismount();
    if (p.sleeping) return;
    p.vehicle = v; v.rider = p;
    p.flying = false; p.gliding = false; p.sneaking = false;
    if (this.net && this.net.isGuest) this.net.claimVehicle(v);
    this.syncRider();
    p.px = p.x; p.py = p.y; p.pz = p.z;
    if (!v.isMob) this.advance(v.isBoat ? 'boat' : 'cart');
    const msg = v.isBoat ? 'Rowing: W/S to move, A/D to turn, Shift to get out'
      : v.isMob ? (v.tamed && v.saddled ? 'Riding: WASD to ride, Space to jump, Shift to get off' : v.tamed ? 'Put a saddle on the steed to steer it. Shift to get off' : 'The steed is wild. Hold on, or Shift to get off')
        : 'Riding: W to push off, Shift to get out';
    this.ui.message(msg, '#9fb3c8');
  },

  dismount() {
    const p = this.player, v = p.vehicle;
    if (!v) return;
    v.rider = null; v.riderInput = null; p.vehicle = null;
    if (this.net && this.net.isGuest) this.net.releaseVehicle(v);
    const w = this.world;
    for (const [dx, dy, dz] of [[0, 1, 0], [1.2, 0.2, 0], [-1.2, 0.2, 0], [0, 0.2, 1.2], [0, 0.2, -1.2], [0, 1.6, 0]]) {
      const x = v.x + dx, y = v.y + dy + 0.4, z = v.z + dz;
      if (boxFree(w, x, y, z, p.w, p.h)) { p.x = p.px = x; p.y = p.py = y; p.z = p.pz = z; break; }
    }
    p.vx = p.vy = p.vz = 0; p.fallDistance = 0;
  },

  syncRider() {
    const p = this.player, v = p.vehicle;
    if (!v) return;
    const [x, y, z] = v.seat();
    p.x = x; p.y = y; p.z = z;
    p.vx = v.vx; p.vy = 0; p.vz = v.vz;
    p.onGround = true; p.fallDistance = 0;
  },

  // Move entities caught in cells a piston just pushed into.
  pushEntities(cells, dx, dy, dz) {
    const hits = (e) => cells.some(([x, y, z]) => e.x + e.w > x && e.x - e.w < x + 1 && e.y + e.h > y && e.y < y + 1 && e.z + e.w > z && e.z - e.w < z + 1);
    const list = [this.player, ...this.entities, ...this.items];
    for (const e of list) {
      if (!e || e.removed || e.dead || e.vehicle === undefined && e.isPlayer && e.vehicle) continue;
      if (!hits(e)) continue;
      e.x += dx; e.y += dy; e.z += dz;
      if (dy > 0) e.vy = Math.max(e.vy, 0);
    }
  },

  // ---------------------------------------------------------------------------
  // Circuit parts
  playNote(x, y, z) {
    const w = this.world;
    if (SOLID[w.getBlock(x, y + 1, z)]) return;
    const pitch = w.getMeta(x, y, z) & 31;
    const below = BLOCKS[w.getBlock(x, y - 1, z)];
    const inst = (below && (below.id === B.gold_block ? 'bell' : INSTRUMENT[below.sound])) || 'harp';
    this.audio.note(pitch, inst, x + 0.5, y + 0.5, z + 0.5);
    this.particles.note(x + 0.5, y + 1.2, z + 0.5, pitch);
  },

  primeCrate(x, y, z) {
    if (this.world.getBlock(x, y, z) !== B.tnt) return;
    this.world.setBlock(x, y, z, 0, 0);
    this.entities.push(new PrimedCrate(x, y, z));
    this.audio.play('fuse', x + 0.5, y + 0.5, z + 0.5);
  },

  dispense(x, y, z, f) {
    const w = this.world;
    const be = w.blockEntities.get(K(x, y, z));
    if (!be || !be.slots) return;
    const filled = [];
    be.slots.forEach((s, i) => { if (s) filled.push(i); });
    if (!filled.length) { this.audio.play('click', x + 0.5, y + 0.5, z + 0.5, 0.4); return; }
    const i = filled[Math.floor(Math.random() * filled.length)];
    const st = be.slots[i];
    const [dx, dy, dz] = FACE_DIR[f];
    const fx = x + 0.5 + dx * 0.7, fy = y + 0.5 + dy * 0.7 - (dy === 0 ? 0.15 : 0), fz = z + 0.5 + dz * 0.7;
    const tx = x + dx, ty = y + dy, tz = z + dz;
    const front = w.getBlock(tx, ty, tz);
    const take1 = () => { st.count--; if (st.count <= 0) be.slots[i] = null; };
    const jit = () => (Math.random() - 0.5) * 0.06;
    const shoot = (kind, speed) => {
      const pr = new Projectile(kind, fx, fy, fz, dx * speed + jit(), dy * speed + 0.1 + jit(), dz * speed + jit(), null, 2);
      if (kind === 'potion') { pr.item = st.id; pr.pot = st.pot; }
      this.entities.push(pr);
    };
    const d = ITEMS[st.id];
    let done = true;
    if (st.id === I.arrow) { shoot('arrow', 1.1); take1(); this.audio.play('bow', fx, fy, fz, 0.6); }
    else if (st.id === I.egg || st.id === I.snowball) { shoot(st.id === I.egg ? 'egg' : 'snowball', 1.1); take1(); }
    else if (d && d.splash) { shoot('potion', 0.8); take1(); }
    else if ((st.id === I.water_bucket || st.id === I.lava_bucket) && (front === 0 || (REPLACEABLE[front] && !isLiquid(front)))) {
      w.setBlock(tx, ty, tz, st.id === I.water_bucket ? B.water : B.lava, 0);
      be.slots[i] = { id: I.bucket, count: 1 };
    } else if (st.id === I.bucket && isLiquid(front) && (w.getMeta(tx, ty, tz) & 15) === 0) {
      w.setBlock(tx, ty, tz, 0, 0);
      be.slots[i] = { id: front === B.water ? I.water_bucket : I.lava_bucket, count: 1 };
    } else if (st.id === I.glass_bottle && front === B.water) {
      take1(); this.storeOrDrop(be, { id: I.potion_water, count: 1 }, fx, fy, fz);
    } else if (st.id === I.flint_and_steel) {
      if (front === B.tnt) this.primeCrate(tx, ty, tz); else this.placeFire(tx, ty, tz);
      st.dur = (st.dur || 0) + 1; if (st.dur >= d.durability) be.slots[i] = null;
    } else if (st.id === I.bone_meal && front) {
      if (this.bonemeal({ x: tx, y: ty, z: tz, id: front, face: 0 })) take1(); else done = false;
    } else if (st.id === B.tnt) {
      this.entities.push(new PrimedCrate(tx, ty, tz)); take1(); this.audio.play('fuse', tx + 0.5, ty + 0.5, tz + 0.5);
    } else if (st.id === I.minecart && isRail(front)) {
      this.entities.push(new Minecart(tx + 0.5, ty, tz + 0.5)); take1();
    } else if (st.id === I.boat && front === B.water) {
      this.entities.push(new Boat(tx + 0.5, ty + 0.5, tz + 0.5, Math.atan2(dx, -dz))); take1();
    } else done = false;
    if (!done) {
      // anything else is just thrown out the front
      const it = this.dropItem(fx, fy, fz, { ...st, count: 1 });
      it.vx = dx * 0.2 + jit(); it.vy = dy * 0.2 + 0.1; it.vz = dz * 0.2 + jit();
      take1();
    }
    this.audio.play('dispense', x + 0.5, y + 0.5, z + 0.5, 0.6);
    for (let k = 0; k < 4; k++) this.particles.smoke(fx, fy, fz);
  },

  storeOrDrop(be, stack, x, y, z) {
    for (let i = 0; i < be.slots.length; i++) if (!be.slots[i]) { be.slots[i] = stack; return; }
    this.dropItem(x, y, z, stack);
  },

  // ---------------------------------------------------------------------------
  // Brewing stands and hoppers
  tickBrewing() {
    const w = this.world;
    for (const [key, be] of w.blockEntities) {
      if (be.type !== 'brewing') continue;
      const [x, y, z] = key.split(',').map(Number);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      if (w.getBlock(x, y, z) !== B.brewing_stand) { w.blockEntities.delete(key); continue; }
      const s = be.slots;
      if (be.fuel <= 0 && s[4] && s[4].id === I.ember_dust) {
        be.fuel = 20; s[4].count--; if (s[4].count <= 0) s[4] = null;
      }
      const ing = s[3];
      const can = ing && be.fuel > 0 && [0, 1, 2].some((i) => s[i] && brew(s[i], ing.id));
      if (!can) { be.brewTime = 0; continue; }
      if (be.brewTime <= 0 || be.ingId !== ing.id) { be.brewTime = 400; be.ingId = ing.id; }
      be.brewTime--;
      if (be.brewTime % 40 === 0) this.particles.bubbleUp && this.particles.bubbleUp(x + 0.5, y + 0.8, z + 0.5);
      if (be.brewTime === 0) {
        for (let i = 0; i < 3; i++) { if (!s[i]) continue; const r = brew(s[i], ing.id); if (r) s[i] = r; }
        ing.count--; if (ing.count <= 0) s[3] = null;
        be.fuel--;
        this.audio.play('brew', x + 0.5, y + 0.5, z + 0.5);
      }
    }
  },

  containerAt(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    const key = K(x, y, z);
    let be = w.blockEntities.get(key);
    if (!be && id === B.chest) { be = newChest(); w.blockEntities.set(key, be); }
    return be && be.slots ? be : null;
  },

  // Put one item from `stack` into a container entered from `fromAbove`.
  insertOne(be, stack, fromAbove) {
    const one = { ...stack, count: 1 };
    const fits = (i) => {
      const s = be.slots[i];
      if (!s) { be.slots[i] = one; return true; }
      if (s.id === one.id && !s.dur && !s.ench && !one.ench && s.count < maxStack(s.id) && !s.pot && !one.pot && !s.map) { s.count++; return true; }
      return false;
    };
    if (be.type === 'furnace') return fromAbove ? fits(0) : (ITEMS[one.id] && ITEMS[one.id].fuel ? fits(1) : false);
    if (be.type === 'brewing') {
      if (fromAbove) return isIngredient(one.id) ? fits(3) : false;
      if (one.id === I.ember_dust) return fits(4);
      if (ITEMS[one.id] && ITEMS[one.id].potion) { for (let i = 0; i < 3; i++) if (!be.slots[i]) { be.slots[i] = one; return true; } }
      return false;
    }
    for (let i = 0; i < be.slots.length; i++) if (fits(i)) return true;
    return false;
  },

  // Take one item from a container (output slots for furnaces).
  extractOne(be) {
    const order = be.type === 'furnace' ? [2] : be.type === 'brewing' ? [0, 1, 2] : be.slots.map((_, i) => i);
    for (const i of order) {
      const s = be.slots[i];
      if (!s) continue;
      if (be.type === 'brewing' && !(ITEMS[s.id] && ITEMS[s.id].potion && s.id !== I.potion_water)) continue;
      const one = { ...s, count: 1 };
      s.count--; if (s.count <= 0) be.slots[i] = null;
      return one;
    }
    return null;
  },

  tickHoppers() {
    const w = this.world;
    for (const [key, be] of w.blockEntities) {
      if (be.type !== 'hopper') continue;
      if (be.cooldown > 0) { be.cooldown--; continue; }
      const [x, y, z] = key.split(',').map(Number);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      if (w.getBlock(x, y, z) !== B.hopper) { w.blockEntities.delete(key); continue; }
      const m = w.getMeta(x, y, z);
      if (m & 8) continue; // locked by power
      let moved = false;
      // push out
      const f = m & 7;
      const [dx, dy, dz] = FACE_DIR[f] || [0, -1, 0];
      const target = this.containerAt(x + dx, y + dy, z + dz);
      if (target) {
        for (let i = 0; i < 5 && !moved; i++) {
          const s = be.slots[i];
          if (!s) continue;
          if (this.insertOne(target, s, f === 1)) { s.count--; if (s.count <= 0) be.slots[i] = null; moved = true; }
        }
      }
      // pull from above
      const src = this.containerAt(x, y + 1, z);
      if (src) {
        const peek = this.extractOne(src);
        if (peek) {
          if (this.insertOne(be, peek, false)) moved = true;
          else this.insertOne(src, peek, false);
        }
      } else {
        for (const it of this.items) {
          if (it.removed || it.pickedBy) continue;
          if (it.x < x || it.x > x + 1 || it.z < z || it.z > z + 1 || it.y < y + 0.5 || it.y > y + 1.6) continue;
          while (it.stack.count > 0 && this.insertOne(be, it.stack, false)) { it.stack.count--; moved = true; }
          if (it.stack.count <= 0) it.removed = true;
          break;
        }
      }
      if (moved) be.cooldown = 8;
    }
  },

  // ---------------------------------------------------------------------------
  // Fire
  placeFire(x, y, z) {
    const w = this.world;
    const cur = w.getBlock(x, y, z);
    if (cur && !(REPLACEABLE[cur] && !isLiquid(cur))) return false;
    if (!this.fireCanStay(x, y, z)) return false;
    w.setBlock(x, y, z, B.fire, 0);
    this.fires.add(K(x, y, z));
    this.audio.play('ignite', x + 0.5, y + 0.5, z + 0.5, 0.6);
    return true;
  },

  fireCanStay(x, y, z) {
    const w = this.world;
    const below = w.getBlock(x, y - 1, z);
    if (SOLID[below] && below !== B.fire) return true;
    for (const [dx, dy, dz] of N6) if (BLOCKS[w.getBlock(x + dx, y + dy, z + dz)].burn > 0) return true;
    return false;
  },

  get fires() { return this._fires || (this._fires = new Set()); },

  tickFires() {
    if (this.tickCount % 10 !== 0) return;
    const w = this.world;
    const list = [...this.fires];
    if (list.length > 600) list.length = 600;
    for (const k of list) {
      const [x, y, z] = k.split(',').map(Number);
      if (w.getBlock(x, y, z) !== B.fire) { this.fires.delete(k); continue; }
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      if (Math.random() > 0.35) continue;
      const below = w.getBlock(x, y - 1, z);
      const forever = below === B.scorchstone || below === B.magma_rock;
      const age = w.getMeta(x, y, z) & 15;
      const rained = this.rain > 0.5 && this.dim === 'overworld' && w.rainHeight(x, z) <= y;
      if (!this.fireCanStay(x, y, z) || (rained && Math.random() < 0.5) || (!forever && age >= 15 && Math.random() < 0.5)) {
        w.setBlock(x, y, z, 0, 0); this.fires.delete(k); continue;
      }
      if (!forever) w.setBlock(x, y, z, B.fire, Math.min(15, age + 1 + Math.floor(Math.random() * 2)), { urgent: false, notify: false });
      // burn and spread
      for (const [dx, dy, dz] of N6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const nid = w.getBlock(nx, ny, nz);
        const burn = BLOCKS[nid] ? BLOCKS[nid].burn : 0;
        if (burn > 0 && Math.random() < burn * 0.25) {
          if (nid === B.tnt) { this.primeCrate(nx, ny, nz); continue; }
          if (Math.random() < 0.6 && !isLiquid(nid)) { w.setBlock(nx, ny, nz, B.fire, age, { urgent: false }); this.fires.add(K(nx, ny, nz)); }
          else w.setBlock(nx, ny, nz, 0, 0, { urgent: false });
        }
      }
      for (let i = 0; i < 2; i++) {
        const nx = x + Math.floor(Math.random() * 3) - 1, ny = y + Math.floor(Math.random() * 4) - 1, nz = z + Math.floor(Math.random() * 3) - 1;
        if (w.getBlock(nx, ny, nz) !== 0) continue;
        let near = 0;
        for (const [dx, dy, dz] of N6) near = Math.max(near, BLOCKS[w.getBlock(nx + dx, ny + dy, nz + dz)].burn);
        if (near > 0 && Math.random() < near * 0.3 && !(rained && w.rainHeight(nx, nz) <= ny)) { w.setBlock(nx, ny, nz, B.fire, age, { urgent: false }); this.fires.add(K(nx, ny, nz)); }
      }
      if (Math.random() < 0.15) this.audio.play('fire', x + 0.5, y + 0.5, z + 0.5, 0.4);
    }
  },

  // ---------------------------------------------------------------------------
  // Eating and drinking extras
  afterEat(stack) {
    const p = this.player;
    const id = stack.id;
    if (id === I.golden_apple) { addEffect(p, 'regeneration', 1, 100); addEffect(p, 'absorption', 0, 2400); }
    else if (id === I.crawler_eye) addEffect(p, 'poison', 0, 100);
    else if (id === I.pufferfish) addEffect(p, 'poison', 1, 300);
    else if (id === I.void_fruit) this.randomTeleport(p, 8);
  },

  finishDrink(stack) {
    const p = this.player;
    const d = ITEMS[stack.id];
    if (stack.id === I.milk_bucket) { p.effects = {}; p.absorption = 0; }
    else if (d.potion) p.applyPotion(this, potionEffect(stack));
    this.audio.play('burp', p.x, p.y + 1.5, p.z, 0.4);
    if (p.creative) return;
    if (d.leaves) this.replaceHeld({ id: I[d.leaves], count: 1 });
    else p.inventory.useHeld();
    if (d.potion && d.potion !== 'water') this.advance('potion');
  },

  randomTeleport(e, r) {
    const w = this.world;
    for (let i = 0; i < 16; i++) {
      const x = e.x + (Math.random() - 0.5) * 2 * r, z = e.z + (Math.random() - 0.5) * 2 * r;
      let y = Math.floor(e.y + (Math.random() - 0.5) * r);
      while (y > 1 && !SOLID[w.getBlock(Math.floor(x), y - 1, Math.floor(z))]) y--;
      if (!SOLID[w.getBlock(Math.floor(x), y - 1, Math.floor(z))] || !boxFree(w, x, y, z, e.w, e.h)) continue;
      e.x = e.px = x; e.y = e.py = y; e.z = e.pz = z; e.vx = e.vy = e.vz = 0; e.fallDistance = 0;
      this.audio.play('teleport', x, y, z);
      return true;
    }
    return false;
  },

  damageShield(n) {
    const p = this.player;
    const held = p.inventory.held;
    if (!held || held.id !== I.shield || p.creative) return;
    held.dur = (held.dur || 0) + n;
    if (held.dur >= ITEMS[I.shield].durability) { p.inventory.held = null; this.audio.material('wood', 'break', p.x, p.y + 1, p.z); }
  },

  // ---------------------------------------------------------------------------
  // Items that act on their own when used (before any block placement).
  // Returns true when handled.
  // A carved pumpkin on two snow blocks makes a frost sentinel; on a T of
  // four iron blocks it makes an iron sentinel.
  tryBuildGolem(x, y, z) {
    if (this.net && this.net.isGuest) return false;
    const g = golemAt(this.world, x, y, z);
    if (!g) return false;
    const w = this.world;
    for (const [dx, dy, dz] of [[0, 0, 0], ...g.blocks]) {
      const id = w.getBlock(x + dx, y + dy, z + dz);
      w.setBlock(x + dx, y + dy, z + dz, 0, 0);
      this.particles.blockBreak(x + dx, y + dy, z + dz, id, 0);
    }
    const mob = new Mob(g.type, x + 0.5, y - 2, z + 0.5, { persistent: true });
    mob.playerBuilt = true;
    mob.yaw = this.player.yaw + Math.PI;
    this.entities.push(mob);
    this.audio.mob(MOB_TYPES[g.type].sound, 'idle', x + 0.5, y, z + 0.5);
    this.advance('golem');
    return true;
  },

  useItemFirst(held, hit) {
    const p = this.player, w = this.world;
    const d = ITEMS[held.id];
    const [ex, ey, ez] = this.eyePos();
    const [dx, dy, dz] = this.lookDir();
    const throwIt = (kind, speed, extra = {}) => {
      const pr = new Projectile(kind, ex + dx * 0.3, ey - 0.1, ez + dz * 0.3, dx * speed, dy * speed + 0.1, dz * speed, p, 0);
      Object.assign(pr, extra);
      this.entities.push(pr);
      if (!p.creative) p.inventory.useHeld();
      this.audio.play('throw', p.x, p.y + 1.5, p.z, 0.6);
      this.startSwing();
    };
    if (held.id === I.void_pearl) { throwIt('pearl', 1.5); return true; }
    // shears carve a face into a pumpkin
    if (held.id === I.shears && hit && hit.id === B.pumpkin && !p.sneaking) {
      const f = hit.face >= 2 ? hit.face : [4, 3, 5, 2][this.facingIndex()];
      w.setBlock(hit.x, hit.y, hit.z, B.carved_pumpkin, f);
      this.audio.play('shear', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      const n = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][f];
      this.dropItem(hit.x + 0.5 + n[0] * 0.6, hit.y + 0.5, hit.z + 0.5 + n[2] * 0.6, { id: I.wheat_seeds, count: 2 + Math.floor(Math.random() * 3) }, true);
      this.damageTool(1); this.startSwing();
      this.tryBuildGolem(hit.x, hit.y, hit.z);
      return true;
    }
    if (held.id === I.sky_rocket) return this.useRocket(held, hit);
    if (held.id === I.photon_blaster || held.id === I.energy_cell) return true;
    if (d.splash) { throwIt('potion', 0.7, { item: held.id, pot: held.pot }); return true; }
    if (held.id === I.star_eye) {
      if (hit && hit.id === B.star_frame) return this.placeEye(hit);
      const obs = this.dim === 'overworld' && this.world.gen.observatories ? this.world.gen.observatories.locate(p.x, p.z, 3) : null;
      if (!obs) { this.ui.message('The eye shivers but finds nothing to follow here.', '#c8b8f0'); return true; }
      this.entities.push(new StarEye(ex, ey - 0.2, ez, obs.x, obs.z));
      if (!p.creative) p.inventory.useHeld();
      this.audio.play('throw', p.x, p.y + 1.5, p.z, 0.6);
      return true;
    }
    if (held.id === I.fishing_rod) {
      if (p.fishing && !p.fishing.removed) { const cost = p.fishing.reel(this); if (cost) this.damageTool(cost); }
      else {
        const b = new Bobber(p, ex + dx * 0.4, ey - 0.1, ez + dz * 0.4, dx * 0.9, dy * 0.9 + 0.15, dz * 0.9);
        this.entities.push(b);
        p.fishing = b;
        this.audio.play('fish_cast', p.x, p.y + 1.5, p.z, 0.5);
      }
      this.startSwing();
      return true;
    }
    if (held.id === I.empty_map) {
      this.createMap();
      return true;
    }
    if (held.id === I.glass_bottle || held.id === I.boat) {
      const lh = raycast(w, ex, ey, ez, dx, dy, dz, 5, { liquids: true });
      if (held.id === I.glass_bottle) {
        if (lh && lh.id === B.water) {
          this.replaceHeld({ id: I.potion_water, count: 1 });
          this.audio.play('splash', lh.x + 0.5, lh.y + 0.5, lh.z + 0.5, 0.3);
          return true;
        }
        return false;
      }
      // boats go on water, or on the ground in front
      if (lh && (lh.id === B.water || (hit && hit.face === 0))) {
        const top = lh.id === B.water ? lh.y + 1 : lh.y + 1;
        const b = new Boat(lh.hx, top - 0.3, lh.hz, p.yaw);
        if (lh.id !== B.water) b.y = lh.y + 1;
        this.entities.push(b);
        if (!p.creative) p.inventory.useHeld();
        this.audio.blockSound(B.oak_planks, 'place', lh.hx, top, lh.hz);
        return true;
      }
      return true;
    }
    if (held.id === I.minecart) {
      if (hit && isRail(hit.id)) {
        this.entities.push(new Minecart(hit.x + 0.5, hit.y + 0.0625, hit.z + 0.5));
        if (!p.creative) p.inventory.useHeld();
        this.audio.material('metal', 'place', hit.x + 0.5, hit.y, hit.z + 0.5);
      }
      return true;
    }
    if (held.id === I.flint_and_steel && hit && hit.id !== B.tnt) {
      return false; // the regular path handles portals, then lights fire (see lightFire)
    }
    return false;
  },

  // ---------------------------------------------------------------------------
  // Right-click behaviour of the new interactive blocks; true when handled.
  useBlockExtra(hit, held) {
    const w = this.world, p = this.player;
    const key = K(hit.x, hit.y, hit.z);
    const c = this.circuits;
    switch (hit.id) {
      case B.lever: c.toggleLever(hit.x, hit.y, hit.z); return true;
      case B.stone_button: case B.oak_button: c.pressButton(hit.x, hit.y, hit.z); return true;
      case B.repeater: c.cycleRepeater(hit.x, hit.y, hit.z); return true;
      case B.note_block: {
        const m = w.getMeta(hit.x, hit.y, hit.z);
        w.setBlock(hit.x, hit.y, hit.z, B.note_block, (((m & 31) + 1) % 25) | (m & 32), { notify: false });
        this.playNote(hit.x, hit.y, hit.z);
        return true;
      }
      case B.oak_trapdoor: {
        const m = w.getMeta(hit.x, hit.y, hit.z) ^ 4;
        w.setBlock(hit.x, hit.y, hit.z, B.oak_trapdoor, m, { notify: false });
        this.audio.play(m & 4 ? 'door_open' : 'door_close', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.8);
        return true;
      }
      case B.brewing_stand:
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newBrewing());
        this.ui.openScreen('brewing', { key, be: w.blockEntities.get(key) });
        return true;
      case B.dispenser:
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newDispenser());
        this.ui.openScreen('dispenser', { key, be: w.blockEntities.get(key) });
        return true;
      case B.hopper:
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newHopper());
        this.ui.openScreen('hopper', { key, be: w.blockEntities.get(key) });
        return true;
      case B.cake: {
        if (p.food >= 20 && !p.creative) return false;
        const m = w.getMeta(hit.x, hit.y, hit.z);
        p.food = Math.min(20, p.food + 2); p.saturation = Math.min(p.food, p.saturation + 0.4);
        if ((m & 7) >= 6) w.setBlock(hit.x, hit.y, hit.z, 0, 0); else w.setBlock(hit.x, hit.y, hit.z, B.cake, m + 1);
        this.audio.play('eat', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        return true;
      }
      case B.oak_sign: case B.oak_wall_sign:
        if (held && ITEMS[held.id] && ITEMS[held.id].block !== undefined && !p.sneaking) return false;
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, { type: 'sign', lines: ['', '', '', ''] });
        this.ui.openSign(key);
        return true;
      case B.star_frame:
        if (held && held.id === I.star_eye) return this.placeEye(hit);
        return false;
      default: return false;
    }
  },

  // ---------------------------------------------------------------------------
  // Special placement: spark dust, rails, signs, lanterns, fire. True if handled.
  placeSpecial(held, hit, tx, ty, tz) {
    const w = this.world, p = this.player;
    const id = held.id;
    const done = (bid) => {
      if (!p.creative) p.inventory.useHeld();
      this.audio.blockSound(bid, 'place', tx + 0.5, ty + 0.5, tz + 0.5);
      this.startSwing();
      return true;
    };
    if (id === I.spark_dust) {
      if (!solidTop(w.getBlock(tx, ty - 1, tz), w.getMeta(tx, ty - 1, tz))) return true;
      w.setBlock(tx, ty, tz, B.spark_wire, 0);
      return done(B.spark_wire);
    }
    if (isRail(id)) {
      if (!solidTop(w.getBlock(tx, ty - 1, tz), w.getMeta(tx, ty - 1, tz))) return true;
      const f = this.facingIndex();
      placeRail(w, tx, ty, tz, id, f === 1 || f === 3 ? 1 : 0);
      return done(id);
    }
    if (id === B.oak_sign) {
      const face = REPLACEABLE[hit.id] && !isLiquid(hit.id) ? 0 : hit.face;
      if (face === 1) return true;
      let bid, meta;
      if (face === 0) {
        if (!SOLID[w.getBlock(tx, ty - 1, tz)]) return true;
        bid = B.oak_sign;
        meta = Math.round(((p.yaw + Math.PI) / (Math.PI * 2)) * 16) & 15;
      } else {
        bid = B.oak_wall_sign;
        meta = { 2: 1, 3: 3, 4: 2, 5: 0 }[face];
      }
      w.setBlock(tx, ty, tz, bid, meta);
      w.blockEntities.set(K(tx, ty, tz), { type: 'sign', lines: ['', '', '', ''] });
      done(bid);
      this.ui.openSign(K(tx, ty, tz));
      return true;
    }
    if (id === B.lantern) {
      const face = REPLACEABLE[hit.id] && !isLiquid(hit.id) ? 0 : hit.face;
      const hang = face === 1 || !SOLID[w.getBlock(tx, ty - 1, tz)];
      if (hang ? !SOLID[w.getBlock(tx, ty + 1, tz)] : !SOLID[w.getBlock(tx, ty - 1, tz)]) return true;
      w.setBlock(tx, ty, tz, B.lantern, hang ? 1 : 0);
      return done(B.lantern);
    }
    return false;
  },

  // Orientation for the new block kinds; undefined when not ours.
  placementMetaExtra(b, hit, face) {
    const p = this.player;
    if (b.orient === 'attach') {
      const a = [0, 5, 1, 2, 3, 4][face];
      const f = this.facingIndex();
      return a | ((a === 0 || a === 5) && (f === 1 || f === 3) ? 16 : 0);
    }
    if (b.orient === 'facing6') {
      if (b.id === B.glow_rod) return face;
      if (p.pitch > 0.87) return 1;
      if (p.pitch < -0.87) return 0;
      return [4, 3, 5, 2][this.facingIndex()];
    }
    if (b.orient === 'hopper') return face <= 1 ? 1 : face ^ 1;
    if (b.orient === 'trapdoor') {
      const frac = hit.hy - Math.floor(hit.hy);
      const top = face === 1 || (face >= 2 && frac > 0.5);
      return this.facingIndex() | (top ? 8 : 0);
    }
    return undefined;
  },

  canSurviveExtra(b, meta, x, y, z) {
    const w = this.world;
    const below = w.getBlock(x, y - 1, z), bm = w.getMeta(x, y - 1, z);
    switch (b.support) {
      case 'attach': { const [dx, dy, dz] = ATTACH_DIR[meta & 7]; return OPAQUE[w.getBlock(x + dx, y + dy, z + dz)] === 1; }
      case 'wire': case 'repeater': case 'rail': case 'plate': return solidTop(below, bm) || (b.support === 'plate' && (below === B.oak_fence));
      case 'fire': return this.fireCanStay(x, y, z);
      case 'sign': return SOLID[below] === 1;
      case 'wall_sign': { const [dx, dz] = DIRS[meta & 3]; return SOLID[w.getBlock(x - dx, y, z - dz)] === 1; }
      case 'lantern': return meta & 1 ? SOLID[w.getBlock(x, y + 1, z)] === 1 : SOLID[below] === 1;
      case 'stalk': {
        if (below === B.duskstone || below === B.void_stalk) return true;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (w.getBlock(x + dx, y, z + dz) === B.void_stalk) return true;
        return false;
      }
      default: return undefined;
    }
  },

  // ---------------------------------------------------------------------------
  // The star gate and the Void
  placeEye(hit) {
    const w = this.world, p = this.player;
    const m = w.getMeta(hit.x, hit.y, hit.z);
    if (m & 4) return true;
    w.setBlock(hit.x, hit.y, hit.z, B.star_frame, m | 4);
    if (!p.creative) p.inventory.useHeld();
    this.audio.play('eye_place', hit.x + 0.5, hit.y + 1, hit.z + 0.5);
    for (let i = 0; i < 8; i++) this.particles.voidSpark(hit.x + Math.random(), hit.y + 1.1, hit.z + Math.random());
    this.checkGate(hit.x, hit.y, hit.z);
    return true;
  },

  checkGate(x, y, z) {
    const w = this.world;
    const full = (fx, fz) => w.getBlock(fx, y, fz) === B.star_frame && (w.getMeta(fx, y, fz) & 4);
    for (let cz = z - 2; cz <= z + 2; cz++) for (let cx = x - 2; cx <= x + 2; cx++) {
      let ok = true;
      for (let i = -1; i <= 1 && ok; i++) if (!full(cx + i, cz - 2) || !full(cx + i, cz + 2) || !full(cx - 2, cz + i) || !full(cx + 2, cz + i)) ok = false;
      if (!ok) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) w.setBlock(cx + dx, y, cz + dz, B.void_gate, 0, { notify: false });
      this.audio.play('gate_open', cx + 0.5, y, cz + 0.5);
      this.advance('gate');
      return true;
    }
    return false;
  },

  // Called every tick: void gates and gateways carry the player.
  tickVoidTravel() {
    const p = this.player;
    if (p.dead || this.state !== 'playing' || this.pendingPortal) return;
    if (this.net && this.net.isGuest) return; // the host leads the way between worlds
    if (p.voidCooldown > 0) { p.voidCooldown--; return; }
    if (p.touching(this.world, B.void_gate)) {
      p.voidCooldown = 100;
      if (this.dim === 'void') {
        // home again
        const s = p.spawn || p.worldSpawn || { x: 0, y: 80, z: 0 };
        this.travel('overworld', s.x, s.y, s.z, false);
        this.ui.showEpilogue && this.meta.voidBoss === 'dead' && !this.meta.epilogueSeen && (this.meta.epilogueSeen = true, setTimeout(() => this.ui.showEpilogue(), 1500));
      } else this.travel('void', 100.5, 50, 0.5, 'platform');
      return;
    }
    if (this.dim === 'void' && p.touching(this.world, B.void_gateway)) {
      p.voidCooldown = 60;
      const a = Math.atan2(p.z, p.x);
      const gen = this.world.gen;
      for (let d = OUTER_START + 60; d < OUTER_START + 600; d += 4) {
        const x = Math.round(Math.cos(a) * d), z = Math.round(Math.sin(a) * d);
        const col = gen.column(x, z);
        if (col) {
          p.x = p.px = x + 0.5; p.z = p.pz = z + 0.5; p.y = p.py = col[1] + 1;
          p.vx = p.vy = p.vz = 0; p.fallDistance = 0;
          this.audio.play('teleport', p.x, p.y, p.z);
          this.ui.message('The gateway flings you across the Void.', '#c8b8f0');
          return;
        }
      }
    }
  },

  // Arrival in the Void: a small obsidian platform out from the central island.
  buildVoidPlatform() {
    const w = this.world;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      w.setBlock(100 + dx, 48, dz, B.obsidian, 0);
      for (let dy = 1; dy <= 3; dy++) w.setBlock(100 + dx, 48 + dy, dz, 0, 0);
    }
  },

  spawnVoidBoss() {
    if (this.dim !== 'void' || this.meta.voidBoss === 'dead' || this.wyrm) return;
    if (this.net && this.net.isGuest) return; // the host's wyrm is mirrored
    const wyrm = new Wyrm(0, 85, 60, this.meta.voidWyrmHealth || WYRM_HEALTH);
    this.entities.push(wyrm);
    this.wyrm = wyrm;
  },

  onWyrmDefeated() {
    const w = this.world;
    this.meta.voidBoss = 'dead';
    this.meta.voidWyrmHealth = 0;
    this.wyrm = null;
    const fy = w.gen.fountainY ? w.gen.fountainY() : 64;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.hypot(dx, dz) > 2.5 || (dx === 0 && dz === 0)) continue;
      w.setBlock(dx, fy, dz, B.void_gate, 0, { notify: false });
    }
    w.setBlock(0, fy + 4, 0, B.wyrm_egg, 0, { notify: false });
    // a gateway out to the far islands
    const a = Math.random() * Math.PI * 2;
    const gx = Math.round(Math.cos(a) * 96), gz = Math.round(Math.sin(a) * 96), gy = 75;
    w.setBlock(gx, gy, gz, B.void_gateway, 0, { notify: false });
    w.setBlock(gx, gy + 1, gz, B.bedrock, 0); w.setBlock(gx, gy - 1, gz, B.bedrock, 0);
    for (const e of this.entities) if (e.isPylon) e.removed = true;
    this.ui.message('The Void Wyrm has fallen. The fountain opens the way home.', '#d8c8ff');
    this.advance('wyrm');
    this.audio.play('levelup_big');
  },

  // ---------------------------------------------------------------------------
  // Maps
  get maps() { return this._maps || (this._maps = new Map()); },

  mapData(id) {
    let m = this.maps.get(id);
    if (!m && this.meta.maps && this.meta.maps[id]) { m = new MapData(this.meta.maps[id]); this.maps.set(id, m); }
    return m || null;
  },

  createMap() {
    const p = this.player;
    const id = (this.meta.nextMap || 0) + 1;
    this.meta.nextMap = id;
    const cx = Math.floor(p.x / 128) * 128 + 64, cz = Math.floor(p.z / 128) * 128 + 64;
    const m = new MapData({ id, cx, cz, dim: this.dim });
    this.maps.set(id, m);
    this.meta.maps = this.meta.maps || {};
    m.explore(this.world, p.x, p.z, 6400);
    this.replaceHeld({ id: I.filled_map, count: 1, map: id });
    this.audio.play('page', p.x, p.y + 1, p.z);
    this.advance('map');
  },

  tickMaps() {
    if (this.tickCount % 4) return;
    const p = this.player;
    const held = p.inventory.held;
    if (!held || held.id !== I.filled_map || !held.map) return;
    const m = this.mapData(held.map);
    if (m && m.dim === this.dim) m.explore(this.world, p.x, p.z, 500);
  },

  saveMaps() {
    if (!this._maps) return;
    this.meta.maps = this.meta.maps || {};
    for (const [id, m] of this._maps) this.meta.maps[id] = m.toJSON();
  },

  // ---------------------------------------------------------------------------
  // Vehicles and pylons saved per dimension
  serializeObjects() {
    const out = [];
    for (const e of this.entities) {
      if (e.removed) continue;
      if (e.isCart || e.isBoat || e.isPylon) out.push(e.serialize());
    }
    return out;
  },

  loadObjects(list) {
    for (const o of list || []) {
      if (o.kind === 'pylon') this.entities.push(new Pylon(o.x, o.y, o.z));
      else { const v = loadVehicle(o); if (v) this.entities.push(v); }
    }
  },

  spawnPylon(s) { this.entities.push(new Pylon(s.x, s.y, s.z)); },

  // Effects summary for the HUD.
  effectList() {
    const p = this.player;
    return Object.entries(p.effects || {}).map(([name, e]) => ({ name, amp: e.amp, time: e.time, color: EFFECTS[name] ? EFFECTS[name].color : [255, 255, 255], label: EFFECTS[name] ? EFFECTS[name].name : name }));
  },
};

void Mob; void ItemEntity; void POTION_KINDS; void PISTON_EXTENDED;
