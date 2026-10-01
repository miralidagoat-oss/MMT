// Round-four creatures: hounds (tameable), steeds (rideable), iron and frost
// sentinels (village and player-built guardians), hexers (potion-throwing
// swamp dwellers), tide wardens (beam-firing fish around the tide citadels)
// and shroom cows. Each type's `ai` runs inside Mob.tick and returns a
// movement goal {tx, tz, speed}, {moved: true} when it moved the creature
// itself, or null to fall back to the shared wander/panic behaviour.
import { B, SOLID } from './blocks.js';
import { I } from './items.js';
import { moveBox } from './physics.js';

const pick = (r, n) => Math.floor(r() * n);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const MEAT = () => [I.raw_pork, I.cooked_pork, I.raw_beef, I.cooked_beef, I.raw_chicken, I.cooked_chicken, I.raw_mutton, I.cooked_mutton, I.tainted_flesh];

// Is `e` still something worth fighting?
function alive(e) { return !!e && !e.removed && !e.dead; }

// Nearest hostile creature within r of m.
function nearestHostile(m, game, r) {
  let best = null, bd = r;
  for (const e of game.entities) {
    if (!e.isMob || !e.hostile || e.dead || e === m) continue;
    if (e.def.neutral && !(e.angry > 0)) continue;
    const d = dist3(e, m);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// Melee: walk at the target and strike when close.
function melee(m, game, T, lookAt, { reach, speed, damage, cooldown = 20, knockUp = 0 }) {
  const d = Math.hypot(T.x - m.x, T.z - m.z);
  lookAt(T.x, T.y + (T.h || 1.6) * 0.8, T.z, false);
  if (d < reach && Math.abs(T.y - m.y) < 2 && m.attackCooldown <= 0) {
    m.attackCooldown = cooldown;
    m.swing = 10;
    const dmg = typeof damage === 'function' ? damage() : damage;
    let hit;
    if (T.isMob) hit = T.hurt(game, dmg, m.x, m.z, 'mob:' + m.type, m);
    else hit = T.damage(game, dmg, 'mob:' + m.type, m.x, m.z);
    if (hit && knockUp) T.vy = Math.max(T.vy || 0, knockUp);
    game.audio.mob(m.def.sound, 'idle', m.x, m.y, m.z);
  }
  return { tx: T.x, tz: T.z, speed: d < reach * 0.7 ? 0 : speed };
}

// ---------------------------------------------------------------------------
function houndAI(m, game, p, pdist, lookAt) {
  const owner = m.tamed ? game.ownerOf(m.owner) : null;
  if (m.sitting) { m.target = null; m.headYaw *= 0.9; return { tx: null, tz: null, speed: 0 }; }
  if (m.target && (!alive(m.target) || dist3(m.target, m) > 24 || (m.target === owner))) m.target = null;
  if (m.tamed) {
    // defend the owner: what they attack, and what attacks them
    if (!m.target && owner === game.player) {
      const foe = [game.lastAttackTarget, game.lastHurtBy].find((e) => alive(e) && e.isMob && e !== m && !(e.tamed && e.owner === m.owner) && dist3(e, m) < 16);
      if (foe) m.target = foe;
    }
  } else if (m.angry > 0 && alive(m.angerTarget)) m.target = m.angerTarget;
  if (m.target) return melee(m, game, m.target, lookAt, { reach: 1.6, speed: 0.08, damage: 4 });
  if (owner && !owner.dead) {
    const d = dist3(owner, m);
    if (d > 24 && owner.onGround !== false && game.world.chunkReady(Math.floor(owner.x) >> 4, Math.floor(owner.z) >> 4)) {
      // catch up: appear beside the owner
      m.x = m.px = owner.x + (Math.random() - 0.5) * 2; m.z = m.pz = owner.z + (Math.random() - 0.5) * 2; m.y = m.py = owner.y;
      m.vx = m.vy = m.vz = 0;
      return { tx: null, tz: null, speed: 0 };
    }
    if (d > 6) { lookAt(owner.x, owner.y + 1.5, owner.z); return { tx: owner.x, tz: owner.z, speed: d > 12 ? 0.09 : 0.06 }; }
    if (d < 4 && Math.random() < 0.02) lookAt(owner.x, owner.y + 1.5, owner.z);
  }
  return null;
}

function houndInteract(m, game, stack) {
  const p = game.player;
  if (m.baby) return undefined;
  if (!m.tamed) {
    if (!stack || stack.id !== I.bone || m.angry > 0) return undefined;
    if (Math.random() < 0.34) {
      m.tamed = true; m.owner = game.localName(); m.sitting = true; m.maxHp = 20; m.health = 20; m.target = null;
      for (let i = 0; i < 7; i++) game.particles.heart(m.x + (Math.random() - 0.5), m.y + m.h + Math.random() * 0.4, m.z + (Math.random() - 0.5));
      game.audio.mob('hound', 'whine', m.x, m.y, m.z);
      game.advance('tame');
    } else for (let i = 0; i < 6; i++) game.particles.smoke(m.x + (Math.random() - 0.5) * 0.6, m.y + m.h, m.z + (Math.random() - 0.5) * 0.6);
    return 'consume';
  }
  if (m.owner !== game.localName()) return undefined;
  if (stack && MEAT().includes(stack.id)) {
    if (m.health < m.maxHealth) { m.health = Math.min(m.maxHealth, m.health + 4); game.particles.heart(m.x, m.y + m.h + 0.2, m.z); return 'consume'; }
    if (!(m.love > 0) && !(m.breedCooldown > 0)) { m.love = 600; return 'consume'; }
  }
  m.sitting = !m.sitting;
  m.target = null; m.vx = m.vz = 0;
  void p;
  return 'sit';
}

// ---------------------------------------------------------------------------
function steedAI(m, game, p, pdist, lookAt) {
  const rider = m.rider;
  if (!rider) return null;
  const ri = m.riderInput || {};
  if (!m.tamed) {
    // an untamed steed tries to throw its rider; patience builds trust
    m.bucking = (m.bucking || 0) + 1;
    m.bodyYaw += Math.sin(m.age * 0.6) * 0.15;
    if (m.bucking > 40 + pick(Math.random, 60)) {
      m.bucking = 0;
      m.temper = (m.temper || 0) + 5;
      if (Math.random() * 100 < m.temper) {
        m.tamed = true; m.owner = game.localName();
        for (let i = 0; i < 7; i++) game.particles.heart(m.x + (Math.random() - 0.5), m.y + m.h, m.z + (Math.random() - 0.5));
        game.ui.message('The steed trusts you now. Put a saddle on it to ride where you like.', '#f2e27a');
        game.advance('tame');
      } else {
        game.dismount();
        for (let i = 0; i < 6; i++) game.particles.smoke(m.x + (Math.random() - 0.5), m.y + m.h, m.z + (Math.random() - 0.5));
        game.audio.mob('steed', 'hurt', m.x, m.y, m.z);
        m.vy = 0.3;
      }
    }
    return { tx: null, tz: null, speed: 0 };
  }
  if (!m.saddled) return { tx: null, tz: null, speed: 0 };
  if (ri.jump && m.onGround) { m.vy = m.jumpStr || 0.62; game.audio.mob('steed', 'idle', m.x, m.y, m.z); }
  const f = ri.forward || 0, st = ri.strafe || 0;
  if (!f && !st) { m.bodyYaw += ((rider.yaw - m.bodyYaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * 0.1; return { tx: null, tz: null, speed: 0 }; }
  const dir = rider.yaw + Math.atan2(-st, Math.max(0.0001, Math.abs(f))) * (f < 0 ? -1 : 1) + (f < 0 ? Math.PI : 0);
  const sp = (m.speedAttr || 0.24) * (f < 0 ? 0.35 : 1) * (ri.sprint ? 1.25 : 1);
  return { tx: m.x + Math.sin(dir) * 6, tz: m.z - Math.cos(dir) * 6, speed: sp, steer: 0.5 };
}

function steedInteract(m, game, stack) {
  if (m.baby) return undefined;
  const p = game.player;
  if (stack && stack.id === I.saddle && m.tamed && !m.saddled) {
    m.saddled = true;
    game.audio.material('cloth', 'place', m.x, m.y + 1, m.z);
    return 'consume';
  }
  const feeds = { [I.wheat]: [2, 3], [I.apple]: [3, 3], [I.sugar]: [1, 3], [I.golden_carrot]: [4, 5], [I.golden_apple]: [10, 10] };
  if (stack && feeds[stack.id]) {
    const [heal, temper] = feeds[stack.id];
    if (m.tamed && (stack.id === I.golden_carrot || stack.id === I.golden_apple) && m.health >= m.maxHealth && !(m.love > 0)) { m.love = 600; return 'consume'; }
    if (m.health >= m.maxHealth && m.tamed) return undefined;
    m.health = Math.min(m.maxHealth, m.health + heal);
    m.temper = Math.min(100, (m.temper || 0) + temper);
    game.particles.heart(m.x, m.y + m.h, m.z);
    game.audio.play('eat', m.x, m.y + 1, m.z);
    return 'consume';
  }
  if (p.sneaking || m.rider) return undefined;
  game.mount(m);
  return 'ride';
}

// ---------------------------------------------------------------------------
function sentinelAI(m, game, p, pdist, lookAt) {
  if (m.target && (!alive(m.target) || dist3(m.target, m) > 24)) m.target = null;
  if (m.angry > 0 && alive(m.angerTarget)) m.target = m.angerTarget;
  else if (!m.target && (m.age + m.id) % 10 === 0) m.target = nearestHostile(m, game, 16);
  if (m.target) return melee(m, game, m.target, lookAt, { reach: 2.6, speed: 0.06, damage: () => 7 + Math.floor(Math.random() * 14), cooldown: 25, knockUp: 0.55 });
  // stroll near home
  if (m.home && Math.hypot(m.home.x - m.x, m.home.z - m.z) > 20) return { tx: m.home.x, tz: m.home.z, speed: 0.035 };
  return null;
}

function sentinelInteract(m, game, stack) {
  if (stack && stack.id === I.iron_ingot && m.health < m.maxHealth) {
    m.health = Math.min(m.maxHealth, m.health + 25);
    game.audio.mob('sentinel', 'idle', m.x, m.y, m.z);
    return 'consume';
  }
  return undefined;
}

function frostAI(m, game, p, pdist, lookAt) {
  // melts somewhere hot, wet or rained on
  if (m.age % 20 === 0) {
    const gen = game.world.gen;
    const hot = game.dim === 'underworld' || (game.dim === 'overworld' && gen.biomeAt && [11, 12, 19, 20].includes(gen.biomeAt(Math.floor(m.x), Math.floor(m.z))));
    const rained = game.rain > 0.5 && game.dim === 'overworld' && game.world.rainHeight(Math.floor(m.x), Math.floor(m.z)) < m.y;
    if (hot || m.inWater || rained) m.hurt(game, 1, undefined, undefined, 'melt');
  }
  if (m.target && (!alive(m.target) || dist3(m.target, m) > 16)) m.target = null;
  if (!m.target && (m.age + m.id) % 10 === 0) m.target = nearestHostile(m, game, 10);
  const T = m.target;
  if (!T) return null;
  lookAt(T.x, T.y + (T.h || 1) * 0.6, T.z, true);
  if (m.attackCooldown <= 0 && game.canSee(m, T)) {
    m.attackCooldown = 20;
    game.mobThrow(m, 'snowball', T.x, T.y + (T.h || 1) * 0.6, T.z, 1.6);
  }
  return { tx: null, tz: null, speed: 0 };
}

// ---------------------------------------------------------------------------
function hexerAI(m, game, p, pdist, lookAt) {
  if (m.drinking > 0) {
    m.drinking--;
    if (m.drinking === 0) {
      if (m.drinkKind === 'healing') m.health = Math.min(m.maxHealth, m.health + 8);
      if (m.drinkKind === 'fire_resistance') { m.effects = m.effects || {}; m.effects.fire_resistance = { amp: 0, time: 3600 }; m.fire = 0; }
      game.audio.play('drink', m.x, m.y + 1.5, m.z);
      m.drinkCooldown = 60;
    }
    return { tx: null, tz: null, speed: 0 };
  }
  if (m.drinkCooldown > 0) m.drinkCooldown--;
  if (!(m.drinkCooldown > 0)) {
    if (m.health < m.maxHealth * 0.5) { m.drinking = 32; m.drinkKind = 'healing'; return { tx: null, tz: null, speed: 0 }; }
    if (m.fire > 0 && !(m.effects && m.effects.fire_resistance)) { m.drinking = 32; m.drinkKind = 'fire_resistance'; return { tx: null, tz: null, speed: 0 }; }
  }
  const T = m.target;
  if (!T) return null;
  const dx = T.x - m.x, dz = T.z - m.z, d = Math.hypot(dx, dz);
  const see = game.canSee(m, T);
  lookAt(T.x, T.y + 1.4, T.z, true);
  if (see && d < 11 && m.attackCooldown <= 0) {
    m.attackCooldown = 50 + pick(Math.random, 30);
    const fx = T.effects || {};
    let kind = 'harming';
    if (d >= 8 && !fx.slowness) kind = 'slowness';
    else if ((T.health || 0) >= 8 && !fx.poison) kind = 'poison';
    else if (d <= 3 && !fx.weakness && Math.random() < 0.25) kind = 'weakness';
    m.swing = 10;
    game.mobThrow(m, 'potion', T.x + (T.vx || 0) * 8, T.y + 1.1, T.z + (T.vz || 0) * 8, 0.75, { item: I['splash_potion_' + kind] });
    game.audio.mob('hexer', 'idle', m.x, m.y, m.z);
  }
  if (d > 9 || !see) return { tx: T.x, tz: T.z, speed: m.def.chase };
  if (d < 5) return { tx: m.x - dx, tz: m.z - dz, speed: m.def.chase };
  return { tx: null, tz: null, speed: 0 };
}

// ---------------------------------------------------------------------------
// Tide wardens swim freely in water and charge a beam at nearby players.
function wardenAI(m, game, p, pdist, lookAt) {
  const w = game.world;
  m.checkFluids(w);
  m.pLimbAmount = m.limbAmount;
  if (m.inWater) {
    const T = p && !p.dead && !p.creative && !p.spectator && pdist < 16 && (p.inWater || pdist < 10) && game.canSee(m, p) ? p : null;
    if (T) {
      m.beamTarget = T;
      lookAt(T.x, T.y + 1, T.z, true);
      m.beam = (m.beam || 0) + 1;
      if (m.beam === 1) game.audio.mob('warden', 'idle', m.x, m.y, m.z);
      if (m.beam >= 60) {
        m.beam = -20;
        T.damage(game, 6, 'mob:tide_warden', m.x, m.z);
        game.audio.play('laser_hit', T.x, T.y + 1, T.z, 0.8);
      }
      m.vx *= 0.8; m.vy *= 0.8; m.vz *= 0.8;
    } else {
      m.beamTarget = null; m.beam = 0;
      if (!(m.swimTimer > 0) || m.sx === undefined) {
        m.swimTimer = 60 + pick(Math.random, 80);
        for (let k = 0; k < 6; k++) {
          const tx = m.x + (Math.random() - 0.5) * 16, ty = m.y + (Math.random() - 0.5) * 6, tz = m.z + (Math.random() - 0.5) * 16;
          if (w.getBlock(Math.floor(tx), Math.floor(ty), Math.floor(tz)) === B.water) { m.sx = tx; m.sy = ty; m.sz = tz; break; }
        }
      }
      m.swimTimer--;
      if (m.sx !== undefined) {
        const dx = m.sx - m.x, dy = m.sy - m.y, dz = m.sz - m.z, d = Math.hypot(dx, dy, dz) || 1;
        m.vx += (dx / d) * 0.012; m.vy += (dy / d) * 0.012; m.vz += (dz / d) * 0.012;
        m.bodyYaw += ((Math.atan2(dx, -dz) - m.bodyYaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * 0.15;
        if (d < 1) m.sx = undefined;
      }
      m.vx *= 0.9; m.vy *= 0.9; m.vz *= 0.9;
    }
  } else {
    // stranded: flop about
    m.beam = 0; m.beamTarget = null;
    m.vy -= 0.08;
    if (m.onGround && Math.random() < 0.1) { m.vy = 0.4; m.vx = (Math.random() - 0.5) * 0.3; m.vz = (Math.random() - 0.5) * 0.3; game.audio.mob('warden', 'hurt', m.x, m.y, m.z); }
    m.vx *= 0.9; m.vz *= 0.9;
  }
  const r = moveBox(w, m, m.vx, m.vy, m.vz);
  m.applyHits(r);
  m.yaw = m.bodyYaw;
  const moved = Math.hypot(m.x - m.px, m.y - m.py, m.z - m.pz);
  m.limbAmount += (Math.min(1, moved * 6) - m.limbAmount) * 0.3;
  m.limbSwing += 0.2 + moved * 3;
  if (m.attackCooldown > 0) m.attackCooldown--;
  return { moved: true };
}

// ---------------------------------------------------------------------------
function shroomInteract(m, game, stack) {
  if (m.baby || !stack) return undefined;
  if (stack.id === I.bowl) { game.replaceHeld({ id: I.mushroom_stew, count: 1 }); game.audio.play('milk', m.x, m.y + 1, m.z); return 'milked'; }
  if (stack.id === I.shears) {
    game.dropItem(m.x, m.y + 1, m.z, { id: B.red_mushroom, count: 5 });
    m.convertTo = 'cow';
    game.audio.play('shear', m.x, m.y, m.z);
    for (let i = 0; i < 8; i++) game.particles.smoke(m.x, m.y + 0.8, m.z);
    return 'damage_tool';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
export const CREATURE_TYPES = {
  hound: {
    model: 'hound', health: 8, wander: 0.045, chase: 0.08, panic: 0.09, xp: 2, sound: 'hound', neutral: true, noPanic: true,
    food: [], drops: () => [], ai: houndAI, interact: houndInteract,
  },
  steed: {
    model: 'steed', health: 22, wander: 0.04, panic: 0.11, xp: 3, sound: 'steed', food: [], noPanic: false,
    drops: (r) => [[I.leather, pick(r, 3)]], ai: steedAI, interact: steedInteract, rideable: true,
  },
  sentinel: {
    model: 'sentinel', health: 100, wander: 0.025, chase: 0.06, xp: 0, sound: 'sentinel', neutral: true, noPanic: true, noFall: true, heavy: true,
    drops: (r) => [[I.iron_ingot, 3 + pick(r, 3)], [B.poppy, pick(r, 3)]], ai: sentinelAI, interact: sentinelInteract,
  },
  frost_sentinel: {
    model: 'frost_sentinel', health: 4, wander: 0.03, xp: 0, sound: 'frost', noPanic: true,
    drops: (r) => [[I.snowball, pick(r, 16)]], ai: frostAI,
  },
  hexer: {
    model: 'hexer', health: 26, wander: 0.03, chase: 0.05, hostile: true, xp: 5, sound: 'hexer',
    drops: (r) => [[I.glass_bottle, pick(r, 3)], [I.sugar, pick(r, 3)], [I.spark_dust, pick(r, 3)], [I.string, pick(r, 2)], [I.stick, pick(r, 2)], ...(r() < 0.3 ? [[I.imp_horn, 1]] : [])],
    ai: hexerAI,
  },
  tide_warden: {
    model: 'tide_warden', health: 30, wander: 0.03, chase: 0.05, hostile: true, xp: 10, sound: 'warden', spiky: true, aquatic: true,
    drops: (r) => [[I.tide_shard, pick(r, 3)], ...(r() < 0.4 ? [[I.tide_crystal, 1]] : []), ...(r() < 0.4 ? [[I.raw_silverfin, 1]] : [])],
    ai: wardenAI,
  },
  shroomcow: {
    model: 'shroomcow', health: 10, wander: 0.035, panic: 0.08, food: [I.wheat], xp: 2, sound: 'cow',
    drops: (r) => [[I.raw_beef, 1 + pick(r, 3)], [I.leather, pick(r, 3)]], interact: shroomInteract,
  },
};

// Hound food for breeding (meat), set once items are loaded.
CREATURE_TYPES.hound.food = MEAT();

// Can a sentinel or a frost sentinel be built here? Called after a carved
// pumpkin or jack o'lantern is placed at (x, y, z). Returns the type or null.
export function golemAt(world, x, y, z) {
  const g = (dx, dy, dz) => world.getBlock(x + dx, y + dy, z + dz);
  if (g(0, -1, 0) === B.snow_block && g(0, -2, 0) === B.snow_block) return { type: 'frost_sentinel', blocks: [[0, -1, 0], [0, -2, 0]] };
  if (g(0, -1, 0) === B.iron_block && g(0, -2, 0) === B.iron_block) {
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      if (g(ax, -1, az) === B.iron_block && g(-ax, -1, -az) === B.iron_block) {
        return { type: 'sentinel', blocks: [[0, -1, 0], [0, -2, 0], [ax, -1, az], [-ax, -1, -az]] };
      }
    }
  }
  return null;
}
void SOLID;
