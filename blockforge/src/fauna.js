// Round-six animals: rabbits, goats, turtles, squid and frogs. As in
// creatures.js, an `ai` returns a movement goal, {moved: true} when it moved
// the creature itself, or null for the shared wander behaviour.
import { B, SOLID, TEX } from './blocks.js';
import { I } from './items.js';
import { moveBox } from './physics.js';
import { alive, dist3, steedAI, steedInteract } from './creatures.js';
import { nearestOf } from './wildlife.js';

const pick = (r, n) => Math.floor(r() * n);
const wrapA = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

function awayFrom(m, from, dist, speed) {
  const dx = m.x - from.x, dz = m.z - from.z, l = Math.hypot(dx, dz) || 1;
  return { tx: m.x + (dx / l) * dist, tz: m.z + (dz / l) * dist, ty: m.y, speed };
}

// ---------------------------------------------------------------------------
// Rabbits hop about, keep clear of people without a carrot, and raid
// carrot fields.
function rabbitAI(m, game, p, pdist) {
  const held = p && p.inventory && p.inventory.held;
  const tempted = held && m.def.food.includes(held.id);
  if (p && !p.dead && !p.creative && !p.spectator && pdist < 6 && !tempted && !p.sneaking) return awayFrom(m, p, 8, m.def.panic);
  // nibble a ripe carrot now and then
  if ((m.age + m.id) % 80 === 0 && !m.crop && Math.random() < 0.4) {
    const w = game.world, X = Math.floor(m.x), Y = Math.floor(m.y), Z = Math.floor(m.z);
    for (let dz = -6; dz <= 6 && !m.crop; dz++) for (let dx = -6; dx <= 6 && !m.crop; dx++) {
      for (let y = Y + 1; y >= Y - 1; y--) {
        if (w.getBlock(X + dx, y, Z + dz) === B.carrots && (w.getMeta(X + dx, y, Z + dz) & 7) >= 4) { m.crop = { x: X + dx, y, z: Z + dz }; break; }
      }
    }
  }
  if (m.crop) {
    const c = m.crop, w = game.world;
    if (w.getBlock(c.x, c.y, c.z) !== B.carrots) { m.crop = null; return null; }
    if (Math.hypot(c.x + 0.5 - m.x, c.z + 0.5 - m.z) < 0.9) {
      const meta = w.getMeta(c.x, c.y, c.z) & 7;
      if (meta > 0) w.setBlock(c.x, c.y, c.z, B.carrots, meta - 1); else w.setBlock(c.x, c.y, c.z, 0, 0);
      game.audio.play('eat', m.x, m.y, m.z, 0.4);
      m.crop = null;
      return null;
    }
    return { tx: c.x + 0.5, tz: c.z + 0.5, ty: c.y, speed: m.def.wander * 1.4 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Goats leap about the peaks and, now and then, lower their heads and charge
// at whatever stands nearby. A charge into rock may knock off a horn.
const HORN_ROCK = () => new Set([B.stone, B.cobblestone, B.packed_ice, B.coal_ore, B.iron_ore, B.copper_ore, B.emerald_ore, B.oak_log, B.spruce_log, B.birch_log, B.snow_block]);
function goatAI(m, game, p, pdist, lookAt) {
  if (m.ram) {
    const R = m.ram;
    R.t++;
    m.bodyYaw = R.yaw; m.headPitch = 0.5;
    const dx = Math.sin(R.yaw), dz = -Math.cos(R.yaw);
    if (R.t < 20) return { tx: null, tz: null, speed: 0 }; // lowers its head, paws the ground
    m.vx += dx * 0.06; m.vz += dz * 0.06;
    // a hit on a creature or player
    for (const e of [...game.entities, ...(game.players ? game.players() : [game.player])]) {
      if (e === m || e.dead || e.removed || !(e.isMob || e.isPlayer) || (e.isPlayer && (e.creative || e.spectator))) continue;
      if (Math.abs(e.x - m.x) < 0.9 + (e.w || 0.3) && Math.abs(e.z - m.z) < 0.9 + (e.w || 0.3) && Math.abs(e.y - m.y) < 1.2) {
        const kb = 1.1;
        if (e.isMob) { e.hurt(game, 2, m.x, m.z, 'mob:goat', m); e.vx += dx * kb; e.vz += dz * kb; e.vy = 0.45; }
        else if (e.isRemote) { if (game.net) game.net.hitRemote(e, 2, 'mob:goat', m.x, m.z); }
        else if (e.damage) { e.damage(game, 2, 'mob:goat', m.x, m.z); e.vx += dx * kb; e.vz += dz * kb; e.vy = 0.45; }
        game.audio.mob('goat', 'ram', m.x, m.y, m.z);
        m.ram = null; m.ramCool = 600 + pick(Math.random, 1200);
        return { tx: null, tz: null, speed: 0 };
      }
    }
    // into rock: a horn may break off
    if (m.hitX || m.hitZ) {
      const bx = Math.floor(m.x + dx * 0.9), by = Math.floor(m.y + 0.5), bz = Math.floor(m.z + dz * 0.9);
      if (HORN_ROCK().has(game.world.getBlock(bx, by, bz)) && (m.horns ?? 2) > 0) {
        m.horns = (m.horns ?? 2) - 1;
        game.dropItem(m.x + dx * 0.5, m.y + 0.8, m.z + dz * 0.5, { id: I.goat_horn, count: 1, horn: pick(Math.random, 4) });
      }
      game.audio.mob('goat', 'ram', m.x, m.y, m.z);
      m.ram = null; m.ramCool = 600 + pick(Math.random, 1200);
    }
    if (R.t > 70) { m.ram = null; m.ramCool = 400; }
    return { moved: false, tx: null, tz: null, speed: 0 };
  }
  if (m.ramCool === undefined) m.ramCool = 300 + pick(Math.random, 900);
  if (m.ramCool > 0) m.ramCool--;
  else if (!m.baby && (m.age + m.id) % 20 === 0) {
    const T = nearestOf(game, m, 10, (e) => e.type !== 'goat' && !e.hostile) || (p && !p.creative && !p.spectator && pdist < 10 && pdist > 2.5 ? p : null);
    if (T && dist3(T, m) > 2.5 && game.canSee(m, T)) {
      lookAt(T.x, T.y + 1, T.z, true);
      m.ram = { yaw: Math.atan2(T.x - m.x, -(T.z - m.z)), t: 0 };
      game.audio.mob('goat', 'idle', m.x, m.y, m.z);
      return { tx: null, tz: null, speed: 0 };
    }
  }
  // big leaps over the rocks
  if (m.onGround && (m.hitX || m.hitZ)) m.vy = 0.6;
  return null;
}

function goatInteract(m, game, stack) {
  if (stack && stack.id === I.bucket && !m.baby) { game.replaceHeld({ id: I.milk_bucket, count: 1 }); game.audio.play('milk', m.x, m.y + 1, m.z); return 'milked'; }
  return undefined;
}

// ---------------------------------------------------------------------------
// Turtles plod on the sand and glide through the shallows. When a young
// one grows up it sheds a scute.
function turtleAI(m, game) {
  if (!m.inWater) return null;
  const w = game.world;
  if (!(m.swimTimer > 0) || m.sx === undefined) {
    m.swimTimer = 80 + pick(Math.random, 100);
    for (let k = 0; k < 6; k++) {
      const tx = m.x + (Math.random() - 0.5) * 16, tz = m.z + (Math.random() - 0.5) * 16;
      if (w.getBlock(Math.floor(tx), Math.floor(m.y), Math.floor(tz)) === B.water) { m.sx = tx; m.sz = tz; break; }
    }
  }
  m.swimTimer--;
  return m.sx !== undefined ? { tx: m.sx, tz: m.sz, ty: m.y, speed: 0.07 } : null;
}

// ---------------------------------------------------------------------------
// Squid drift through open water, pulsing along, and squirt ink when hurt.
function squidAI(m, game) {
  const w = game.world;
  m.checkFluids(w);
  m.pLimbAmount = m.limbAmount;
  if (m.inWater) {
    m.pulse = (m.pulse || 0) + 1;
    if (!m.sDir || m.pulse % 60 === 0) {
      const a = Math.random() * Math.PI * 2;
      m.sDir = [Math.cos(a), (Math.random() - 0.5) * 0.6, Math.sin(a)];
    }
    if (m.hurtTime === 9) {
      // a cloud of ink, then away
      for (let i = 0; i < 24; i++) game.particles.add({ x: m.x, y: m.y + 0.4, z: m.z, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, vz: (Math.random() - 0.5) * 2, size: 0.18, layer: TEX.p_smoke1, life: 1.6, gravity: 0, drag: 0.85, r: 0.08, g: 0.08, b: 0.12, collide: false });
      m.sDir = [Math.sin(m.bodyYaw + Math.PI), 0.2, -Math.cos(m.bodyYaw + Math.PI)];
      m.pulse = 1;
    }
    const phase = m.pulse % 30;
    if (phase === 0) { m.vx += m.sDir[0] * 0.22; m.vy += m.sDir[1] * 0.18; m.vz += m.sDir[2] * 0.22; }
    // don't leave the water
    if (w.getBlock(Math.floor(m.x), Math.floor(m.y + 1.2), Math.floor(m.z)) !== B.water && m.vy > 0) m.vy *= 0.3;
    m.vx *= 0.93; m.vy *= 0.93; m.vz *= 0.93;
    const sp = Math.hypot(m.vx, m.vz);
    if (sp > 0.01) m.bodyYaw += wrapA(Math.atan2(m.vx, -m.vz) - m.bodyYaw) * 0.1;
    m.dry = 0;
  } else {
    m.vy -= 0.08;
    m.vx *= 0.8; m.vz *= 0.8;
    m.dry = (m.dry || 0) + 1;
    if (m.dry % 20 === 0) m.hurt(game, 1, undefined, undefined, 'dry');
  }
  const r = moveBox(w, m, m.vx, m.vy, m.vz);
  m.applyHits(r);
  m.yaw = m.bodyYaw;
  m.limbSwing = (m.pulse || 0) % 30;
  m.limbAmount = 1;
  if (m.attackCooldown > 0) m.attackCooldown--;
  return { moved: true };
}

// ---------------------------------------------------------------------------
// Frogs hop along the swamp edges, swim well and croak in the evening.
function frogAI(m, game, p, pdist) {
  if (m.inWater) {
    if (!(m.swimTimer > 0) || m.sx === undefined) {
      m.swimTimer = 60 + pick(Math.random, 80);
      m.sx = m.x + (Math.random() - 0.5) * 12; m.sz = m.z + (Math.random() - 0.5) * 12;
    }
    m.swimTimer--;
    return { tx: m.sx, tz: m.sz, ty: m.y, speed: 0.08 };
  }
  if (!game.isDay() && Math.random() < 0.004 && pdist < 24) game.audio.mob('frog', 'idle', m.x, m.y, m.z);
  void p;
  return null;
}

// ---------------------------------------------------------------------------
// Camels: tall, patient desert beasts. Broken in and saddled like a steed;
// a tap of jump sends one dashing forward.
function camelAI(m, game, p, pdist, lookAt) {
  m.speedAttr = m.speedAttr || 0.17;
  m.jumpStr = 0.42;
  if (m.dashCool > 0) m.dashCool--;
  const ri = m.riderInput;
  if (m.rider && m.tamed && m.saddled && ri && ri.jump && m.onGround && !(m.dashCool > 0)) {
    const yaw = m.rider.yaw;
    m.vx += Math.sin(yaw) * 1.1; m.vz -= Math.cos(yaw) * 1.1; m.vy = 0.35;
    m.dashCool = 55;
    game.audio.mob('camel', 'dash', m.x, m.y, m.z);
    m.riderInput = { ...ri, jump: false };
  }
  return steedAI(m, game, p, pdist, lookAt);
}

// Cactus is a camel's treat: it heals them, wins them over and, once they
// are tame and well, puts them in the mood for a calf.
function camelInteract(m, game, stack) {
  if (stack && stack.id === B.cactus && !m.baby) {
    if (m.tamed && m.health >= m.maxHealth) {
      if (m.love > 0) return undefined;
      m.love = 600;
      game.particles.heart(m.x, m.y + m.h, m.z);
      return 'consume';
    }
    m.health = Math.min(m.maxHealth, m.health + 2);
    m.temper = Math.min(100, (m.temper || 0) + 6);
    game.particles.heart(m.x, m.y + m.h, m.z);
    game.audio.play('eat', m.x, m.y + 1, m.z);
    return 'consume';
  }
  return steedInteract(m, game, stack);
}

export const FAUNA_TYPES = {
  camel: {
    model: 'camel', health: 32, wander: 0.03, panic: 0.07, xp: 3, sound: 'camel', noPanic: false, rideable: true,
    food: [], drops: (r) => [[I.leather, pick(r, 3)]], ai: camelAI, interact: camelInteract,
  },
  rabbit: {
    model: 'rabbit', health: 3, wander: 0.05, panic: 0.11, xp: 1, sound: 'rabbit', hops: true, noFall: true,
    food: [], drops: (r) => [[I.raw_rabbit, pick(r, 2)], [I.rabbit_hide, pick(r, 2)], ...(r() < 0.1 ? [[I.rabbit_foot, 1]] : [])],
    ai: rabbitAI,
  },
  goat: {
    model: 'goat', health: 10, wander: 0.04, panic: 0.09, xp: 2, sound: 'goat', noFall: true,
    food: [], drops: () => [], ai: goatAI, interact: goatInteract,
  },
  turtle: {
    model: 'turtle', health: 30, wander: 0.015, panic: 0.03, xp: 2, sound: 'turtle', noPanic: true,
    food: [], drops: (r) => [[I.scute, r() < 0.2 ? 1 : 0]], ai: turtleAI,
  },
  squid: {
    model: 'squid', health: 10, wander: 0.02, xp: 1, sound: 'squid', aquatic: true, noPanic: true,
    drops: (r) => [[I.ink_sac, 1 + pick(r, 3)]], ai: squidAI,
  },
  frog: {
    model: 'frog', health: 10, wander: 0.04, panic: 0.08, xp: 1, sound: 'frog', hops: true, noFall: true,
    food: [], drops: () => [], ai: frogAI,
  },
};
FAUNA_TYPES.rabbit.food = [I.carrot, I.golden_carrot, B.dandelion];
FAUNA_TYPES.goat.food = [I.wheat];
FAUNA_TYPES.turtle.food = [I.raw_silverfin, B.sugar_cane];
FAUNA_TYPES.frog.food = [I.wheat_seeds];
export const FAUNA_VARIANTS = { rabbit: ['brown', 'white', 'gold'], frog: ['marsh', 'warm', 'cold'] };
void SOLID; void alive;
