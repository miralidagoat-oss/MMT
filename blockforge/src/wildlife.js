// Round-five animals: foxes, cats, parrots, bees, alpacas and dolphins.
// Like creatures.js, each type's `ai` runs inside Mob.tick and returns a
// movement goal {tx, tz, ty, speed}, {moved: true} when it moved the creature
// itself (fliers and swimmers), or null for the shared wander behaviour.
import { B, SOLID, isLiquid, TEX } from './blocks.js';
import { I } from './items.js';
import { moveBox } from './physics.js';
import { addEffect } from './effects.js';
import { alive, dist3, melee } from './creatures.js';

const wrapA = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
export const FISH = () => [I.raw_silverfin, I.raw_rosefin];
const FLOWERS = () => new Set([B.dandelion, B.poppy, B.cornflower, B.petals, B.blossom_leaves]);
const CROPS = () => new Set([B.wheat, B.carrots, B.potatoes, B.berry_bush]);

export const VARIANTS = {
  fox: ['red', 'snow'],
  cat: ['tabby', 'black', 'ginger', 'cream', 'calico'],
  parrot: ['scarlet', 'azure', 'emerald', 'sunny', 'slate'],
  alpaca: ['cream', 'brown', 'grey', 'white'],
  sheep: null,
};

// The nearest living creature within r of m that matches pred.
export function nearestOf(game, m, r, pred) {
  let best = null, bd = r;
  for (const e of game.entities) {
    if (e === m || !e.isMob || e.dead || e.removed || !pred(e)) continue;
    const d = dist3(e, m);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// An effect on a creature, the local player or (through the host) a guest.
function giveEffect(game, T, name, amp, ticks) {
  if (T.isRemote && T.applyPotion) T.applyPotion(game, { effect: name, amp, ticks });
  else addEffect(T, name, amp, ticks);
}

function hearts(game, m, n = 7) {
  for (let i = 0; i < n; i++) game.particles.heart(m.x + (Math.random() - 0.5), m.y + m.h + Math.random() * 0.4, m.z + (Math.random() - 0.5));
}
function smoke(game, m, n = 6) {
  for (let i = 0; i < n; i++) game.particles.smoke(m.x + (Math.random() - 0.5) * 0.6, m.y + m.h, m.z + (Math.random() - 0.5) * 0.6);
}

// Feeding an untamed animal: a chance to win it over.
function tryTame(m, game, chance, sound) {
  if (Math.random() < chance) {
    m.tamed = true; m.owner = game.localName(); m.sitting = true; m.target = null;
    m.health = m.maxHealth;
    hearts(game, m);
    game.audio.mob(sound, 'idle', m.x, m.y, m.z);
    game.advance('tame');
    return true;
  }
  smoke(game, m);
  return false;
}

// Tame animals keep up with their owner, and appear beside them if left far behind.
function followOwner(m, game, lookAt, speed, near) {
  const owner = m.tamed ? game.ownerOf(m.owner) : null;
  if (!owner || owner.dead) return null;
  const d = dist3(owner, m);
  if (d > 24 && owner.onGround !== false && game.world.chunkReady(Math.floor(owner.x) >> 4, Math.floor(owner.z) >> 4)) {
    m.x = m.px = owner.x + (Math.random() - 0.5) * 2; m.z = m.pz = owner.z + (Math.random() - 0.5) * 2; m.y = m.py = owner.y + 0.1;
    m.vx = m.vy = m.vz = 0;
    return { tx: null, tz: null, speed: 0 };
  }
  if (d > near) { lookAt(owner.x, owner.y + 1.5, owner.z); return { tx: owner.x, tz: owner.z, ty: owner.y, speed: d > 12 ? speed * 1.4 : speed }; }
  return null;
}

function awayFrom(m, from, dist, speed) {
  const dx = m.x - from.x, dz = m.z - from.z, l = Math.hypot(dx, dz) || 1;
  return { tx: m.x + (dx / l) * dist, tz: m.z + (dz / l) * dist, ty: m.y, speed };
}

// ---------------------------------------------------------------------------
// Flight for parrots and bees: steer the velocity at a point, flap, settle.
function flyTo(m, w, gx, gy, gz, accel, land = false) {
  const dx = gx - m.x, dy = gy - m.y, dz = gz - m.z, d = Math.hypot(dx, dy, dz);
  if (d > 0.35) {
    m.vx += (dx / d) * accel; m.vy += (dy / d) * accel * 1.3; m.vz += (dz / d) * accel;
    if (Math.hypot(dx, dz) > 0.2) m.bodyYaw += wrapA(Math.atan2(dx, -dz) - m.bodyYaw) * 0.25;
    m.flying = true;
  } else if (land) m.flying = false;
  if (!m.flying) m.vy -= 0.06;
  else m.vy -= 0.008;
  m.vx *= 0.86; m.vy *= 0.86; m.vz *= 0.86;
  const r = moveBox(w, m, m.vx, m.vy, m.vz);
  m.applyHits(r);
  if (r.hitX || r.hitZ) m.vy += 0.07;
  if (m.onGround && !m.flying) m.vy = 0;
  m.yaw = m.bodyYaw;
  const moved = Math.hypot(m.x - m.px, m.z - m.pz);
  m.limbAmount += (Math.min(1, moved * 6) - m.limbAmount) * 0.3;
  m.limbSwing += moved * 3;
  m.wingFlap = m.flying ? (m.wingFlap || 0) + 1.1 : (m.wingFlap || 0) * 0.7;
  if (m.attackCooldown > 0) m.attackCooldown--;
  if (m.swing > 0) m.swing--;
}

// A random spot to fly to: over the ground near (x, z), `up` blocks high.
function airSpot(w, x, y, z, range, upMin, upMax) {
  for (let k = 0; k < 8; k++) {
    const tx = Math.floor(x + (Math.random() - 0.5) * range * 2), tz = Math.floor(z + (Math.random() - 0.5) * range * 2);
    let ty = Math.floor(y) + 6;
    while (ty > Math.floor(y) - 8 && !SOLID[w.getBlock(tx, ty - 1, tz)] && !isLiquid(w.getBlock(tx, ty - 1, tz))) ty--;
    if (isLiquid(w.getBlock(tx, ty - 1, tz))) continue;
    const up = upMin + Math.random() * (upMax - upMin);
    if (SOLID[w.getBlock(tx, Math.floor(ty + up), tz)]) continue;
    return [tx + 0.5, ty + up, tz + 0.5, up < 0.3];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Foxes: shy, doze through the day, hunt chickens by night and carry
// whatever they find in their mouths. Foxes bred by a player trust them.
function foxAI(m, game, p, pdist, lookAt) {
  const day = game.isDay();
  const trusted = !!m.trusted && !!p && game.nameOf(p) === m.trusted;
  if (m.target && (!alive(m.target) || dist3(m.target, m) > 16)) m.target = null;
  if (m.angry > 0 && alive(m.angerTarget)) m.target = m.angerTarget;
  if (!trusted && !m.target && p && !p.dead && !p.creative && !p.spectator && pdist < (p.sneaking ? 2.5 : 7)) {
    m.sleeping = false;
    return awayFrom(m, p, 7, m.def.panic);
  }
  if (day && !m.target && !(m.love > 0) && game.rain < 0.5 && !m.seek) {
    if (!m.sleeping && m.onGround && !m.inWater && Math.random() < 0.008) m.sleeping = true;
    if (m.sleeping) { m.headPitch *= 0.8; m.headYaw *= 0.8; return { tx: null, tz: null, speed: 0 }; }
  } else if (m.sleeping) m.sleeping = false;
  if (!m.target && !day && (m.age + m.id) % 20 === 0) m.target = nearestOf(game, m, 12, (e) => e.type === 'chicken');
  if (m.target) return melee(m, game, m.target, lookAt, { reach: 1.4, speed: 0.1, damage: 2 });
  // picks things up in its mouth
  if (!m.held) {
    if (!m.seek && (m.age + m.id) % 10 === 0) {
      for (const it of game.items) if (!it.removed && !it.mirror && !it.pickedBy && it.pickupDelay === 0 && dist3(it, m) < 8) { m.seek = it; break; }
    }
    const it = m.seek;
    if (it) {
      if (it.removed || it.pickedBy || dist3(it, m) > 10) m.seek = null;
      else if (dist3(it, m) < 1.2) {
        m.held = { ...it.stack, count: 1 };
        if (--it.stack.count <= 0) it.removed = true;
        m.seek = null;
        game.audio.play('pop', m.x, m.y, m.z, 0.4);
      } else return { tx: it.x, tz: it.z, ty: it.y, speed: m.def.wander * 1.6 };
    }
  } else if (m.held && ITEMS_FOOD(m.held.id) && m.health < m.maxHealth && Math.random() < 0.002) {
    m.held = null; m.health = m.maxHealth; game.audio.play('eat', m.x, m.y + 0.5, m.z);
  }
  if (trusted && pdist > 10 && pdist < 24) return { tx: p.x, tz: p.z, ty: p.y, speed: 0.07 };
  return null;
}
const ITEMS_FOOD = (id) => id === I.sweet_berries || id === I.raw_chicken || id === I.cooked_chicken;

function foxInteract(m, game, stack) {
  if (stack && stack.id === I.sweet_berries && m.held) {
    game.dropItem(m.x, m.y + 0.5, m.z, m.held);
    m.held = null;
  }
  return undefined; // feeding and breeding use the shared rules
}

// ---------------------------------------------------------------------------
// Cats: strays live in villages and keep their distance; a fish wins them
// over. Crawlers give cats a wide berth.
function catAI(m, game, p, pdist, lookAt) {
  if ((m.age + m.id) % 10 === 0) {
    for (const e of game.entities) {
      if (e.isMob && e.type === 'crawler' && !e.dead && dist3(e, m) < 7) { e.fleeFrom = m; e.fleeTime = 60; e.target = null; }
    }
  }
  if (m.sitting) { m.target = null; return { tx: null, tz: null, speed: 0 }; }
  if (m.tamed) {
    const f = followOwner(m, game, lookAt, 0.07, 6);
    if (f) return f;
    return null;
  }
  const held = p && p.inventory && p.inventory.held;
  if (p && !p.dead && !p.creative && pdist < 5 && !(held && FISH().includes(held.id))) return awayFrom(m, p, 6, 0.08);
  return null;
}

function catInteract(m, game, stack) {
  if (m.baby) return undefined;
  const fish = stack && FISH().includes(stack.id);
  if (!m.tamed) {
    if (!fish) return undefined;
    tryTame(m, game, 0.34, 'cat');
    return 'consume';
  }
  if (m.owner !== game.localName()) return undefined;
  if (fish) {
    if (m.health < m.maxHealth) { m.health = Math.min(m.maxHealth, m.health + 4); game.particles.heart(m.x, m.y + m.h + 0.2, m.z); return 'consume'; }
    if (!(m.love > 0) && !(m.breedCooldown > 0)) { m.love = 600; return 'consume'; }
  }
  m.sitting = !m.sitting;
  m.vx = m.vz = 0;
  game.audio.mob('cat', 'purr', m.x, m.y, m.z);
  return 'sit';
}

// Tame cats that saw their owner sleep bring a little present in the morning.
export function catGifts(game) {
  const p = game.player;
  const gifts = [I.string, I.feather, I.raw_chicken, I.leather, I.raw_silverfin, I.bone];
  for (const m of game.entities) {
    if (m.type !== 'cat' || !m.tamed || m.sitting || m.dead || m.owner !== game.localName()) continue;
    if (dist3(m, p) > 16 || Math.random() > 0.7) continue;
    m.x = m.px = p.x + (Math.random() - 0.5) * 2; m.z = m.pz = p.z + (Math.random() - 0.5) * 2; m.y = m.py = p.y;
    game.dropItem(m.x, m.y + 0.4, m.z, { id: gifts[Math.floor(Math.random() * gifts.length)], count: 1 });
    game.audio.mob('cat', 'purr', m.x, m.y, m.z);
  }
}

// ---------------------------------------------------------------------------
// Parrots: flit about the jungle canopy, dance to music, mimic the
// creatures they hear and ride on a friend's shoulder.
function parrotAI(m, game, p, pdist, lookAt) {
  const w = game.world;
  m.checkFluids(w);
  m.pLimbAmount = m.limbAmount;
  const owner = m.tamed ? game.ownerOf(m.owner) : null;
  if (m.perch) {
    const o = m.perch;
    if (!alive(o) || o !== owner || o.inWater || o.gliding || o.sleeping || o.hurtTime > 0 || o.flying || --m.perchTime <= 0) {
      m.perch = null; m.vy = 0.25; m.perchCool = 600; m.flying = true; m.perchWish = false;
    } else {
      const yaw = o.bodyYaw ?? o.yaw, side = m.perchSide || 1;
      m.x = o.x + Math.cos(yaw) * 0.4 * side; m.z = o.z + Math.sin(yaw) * 0.4 * side;
      m.y = o.y + (o.sneaking ? 1.28 : 1.42);
      m.vx = m.vy = m.vz = 0;
      m.bodyYaw = m.yaw = yaw; m.onGround = true; m.flying = false;
      m.limbAmount *= 0.8; m.wingFlap = 0;
      return { moved: true };
    }
  }
  if (m.perchCool > 0) m.perchCool--;
  if (m.sitting) { flyTo(m, w, m.x, m.y, m.z, 0, true); return { moved: true }; }
  // dance near a note block that is playing
  const note = game.lastNote;
  if (note && game.tickCount - note.t < 100 && Math.hypot(note.x + 0.5 - m.x, note.y - m.y, note.z + 0.5 - m.z) < 4) m.dancing = 60;
  if (m.dancing > 0) { m.dancing--; flyTo(m, w, m.x, m.y, m.z, 0, true); return { moved: true }; }
  let goal = null, land = false;
  if (owner && !owner.dead) {
    const d = dist3(owner, m);
    const ds = Math.hypot(owner.x - m.x, owner.y + 1.45 - m.y, owner.z - m.z); // to the shoulder
    if (d > 24 && w.chunkReady(Math.floor(owner.x) >> 4, Math.floor(owner.z) >> 4)) {
      m.x = m.px = owner.x; m.z = m.pz = owner.z; m.y = m.py = owner.y + 2; m.vx = m.vy = m.vz = 0;
    } else if (d > 5) goal = [owner.x, owner.y + 2.2, owner.z];
    else if (!(m.perchCool > 0) && owner.onGround && !owner.inWater && !owner.sneaking && (m.perchWish || (m.perchWish = Math.random() < 0.02)) && ds >= 0.9) {
      // flutter over to a shoulder
      goal = [owner.x, owner.y + 1.5, owner.z];
    } else if (!(m.perchCool > 0) && ds < 0.9 && owner.onGround && !owner.inWater && !owner.sneaking) {
      const taken = game.entities.filter((e) => e !== m && e.perch === owner).map((e) => e.perchSide);
      const side = !taken.includes(1) ? 1 : !taken.includes(-1) ? -1 : 0;
      if (side) {
        m.perch = owner; m.perchSide = side; m.perchTime = 1200 + Math.floor(Math.random() * 2400); m.perchWish = false;
        game.audio.mob('parrot', 'idle', m.x, m.y, m.z);
        if (owner === game.player) game.advance('parrot');
        return { moved: true };
      }
    }
  }
  if (!goal) {
    if (!(m.flyTimer > 0) || !m.fly) {
      m.flyTimer = 60 + Math.floor(Math.random() * 120);
      const home = owner && !owner.dead ? owner : m;
      m.fly = airSpot(w, home.x, home.y, home.z, owner ? 4 : 8, Math.random() < 0.4 ? 0 : 1, 5);
    }
    m.flyTimer--;
    if (m.fly) { goal = m.fly; land = m.fly[3]; }
  }
  if (goal) flyTo(m, w, goal[0], goal[1], goal[2], 0.035, land);
  else flyTo(m, w, m.x, m.y, m.z, 0, true);
  // a fair mimic of the creatures it hears
  if (Math.random() < 0.0015) {
    const h = nearestOf(game, m, 20, (e) => e.hostile);
    if (h) game.audio.mob(h.def.sound, 'idle', m.x, m.y, m.z);
  }
  return { moved: true };
}

function parrotInteract(m, game, stack) {
  if (!m.tamed) {
    if (!stack || stack.id !== I.wheat_seeds) return undefined;
    tryTame(m, game, 0.3, 'parrot');
    return 'consume';
  }
  if (m.owner !== game.localName() || m.perch) return undefined;
  m.sitting = !m.sitting;
  return 'sit';
}

// ---------------------------------------------------------------------------
// Bees: gather pollen from flowers, help crops along, and bring it home to
// their nest, which slowly fills with honey. Disturb them and they sting.
export function hiveFront(w, h) {
  const f = (w.getMeta(h.x, h.y, h.z) & 7) || 4;
  const d = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][f];
  return { x: h.x + d[0], y: h.y + d[1], z: h.z + d[2] };
}
export const HIVE_IDS = () => [B.bee_nest, B.beehive];

function findFlower(w, m, r) {
  const fl = FLOWERS();
  const x0 = Math.floor(m.x), y0 = Math.floor(m.y), z0 = Math.floor(m.z);
  for (let k = 0; k < 40; k++) {
    const x = x0 + Math.floor((Math.random() - 0.5) * r * 2), z = z0 + Math.floor((Math.random() - 0.5) * r * 2);
    for (let y = y0 + 4; y >= y0 - 6; y--) {
      const id = w.getBlock(x, y, z);
      if (fl.has(id)) return { x, y, z };
      if (SOLID[id]) break;
    }
  }
  return null;
}

// Put a bee into its hive (it is stored there until it comes out again).
export function enterHive(game, m) {
  const w = game.world, h = m.hive;
  const key = `${h.x},${h.y},${h.z}`;
  let be = w.blockEntities.get(key);
  if (!be || be.type !== 'hive') { be = { type: 'hive', bees: [] }; w.blockEntities.set(key, be); }
  if (be.bees.length >= 3) return false;
  if (m.pollen) {
    const meta = w.getMeta(h.x, h.y, h.z);
    const lvl = Math.min(5, (meta >> 3) + 1);
    w.setBlock(h.x, h.y, h.z, w.getBlock(h.x, h.y, h.z), (meta & 7) | (lvl << 3), { notify: false });
  }
  const data = m.serialize();
  data.pollen = false;
  be.bees.push({ data, at: game.tickCount });
  m.removed = true;
  return true;
}

function beeAI(m, game, p, pdist, lookAt) {
  const w = game.world;
  m.checkFluids(w);
  m.pLimbAmount = m.limbAmount;
  if (m.stung) {
    m.stungAge = (m.stungAge || 0) + 1;
    if (m.stungAge > 600 + (m.id % 600)) m.hurt(game, 100, undefined, undefined, 'magic');
  }
  if (m.inWater && m.age % 20 === 0) m.hurt(game, 1, undefined, undefined, 'drown');
  const day = game.isDay() && game.rain < 0.5;
  let goal = null, land = false;
  const T = m.angry > 0 && alive(m.angerTarget) && !m.stung ? m.angerTarget : null;
  if (T) {
    goal = [T.x, T.y + (T.h || 1.8) * 0.6, T.z];
    if (dist3({ x: T.x, y: T.y + (T.h || 1.8) * 0.5, z: T.z }, m) < 1.4 && m.attackCooldown <= 0) {
      m.attackCooldown = 20; m.swing = 10;
      const hit = T.isMob ? T.hurt(game, 2, m.x, m.z, 'mob:bee', m) : T.damage(game, 2, 'mob:bee', m.x, m.z);
      if (hit) {
        giveEffect(game, T, 'poison', 0, 200);
        m.stung = true; m.stungAge = 0; m.angry = 0; m.angerTarget = null;
      }
    }
  } else if (m.hive) {
    const h = m.hive;
    if (w.chunkReady(h.x >> 4, h.z >> 4) && !HIVE_IDS().includes(w.getBlock(h.x, h.y, h.z))) m.hive = null;
    else {
      const out = m.age - (m.outAt || 0);
      const goHome = !day || (m.pollen && out > 300) || out > 2400;
      if (goHome) {
        const f = hiveFront(w, h);
        goal = [f.x + 0.5, f.y + 0.4, f.z + 0.5];
        if (Math.hypot(goal[0] - m.x, goal[1] - m.y, goal[2] - m.z) < 1.1 && enterHive(game, m)) return { moved: true };
      }
    }
  }
  if (!goal && day && !m.pollen && !m.stung) {
    if (!m.flower || (m.age + m.id) % 60 === 0 && !FLOWERS().has(w.getBlock(m.flower.x, m.flower.y, m.flower.z))) m.flower = findFlower(w, m, 10);
    if (m.flower) {
      const f = m.flower;
      goal = [f.x + 0.5, f.y + 0.55, f.z + 0.5];
      if (Math.hypot(goal[0] - m.x, goal[1] - m.y, goal[2] - m.z) < 0.7) {
        m.pollinating = (m.pollinating || 0) + 1;
        if (m.pollinating > 80) { m.pollen = true; m.pollinating = 0; m.flower = null; }
      }
    }
  }
  // pollen helps crops grow on the way home
  if (m.pollen && m.age % 15 === 0) {
    const x = Math.floor(m.x), z = Math.floor(m.z);
    for (let y = Math.floor(m.y); y > Math.floor(m.y) - 3; y--) {
      const id = w.getBlock(x, y, z);
      if (!CROPS().has(id)) { if (SOLID[id]) break; continue; }
      const meta = w.getMeta(x, y, z), max = id === B.berry_bush ? 3 : 7;
      if ((meta & 7) < max && Math.random() < 0.3) {
        w.setBlock(x, y, z, id, (meta & 7) + 1);
        for (let i = 0; i < 4; i++) game.particles.add({ x: x + Math.random(), y: y + 0.5 + Math.random() * 0.5, z: z + Math.random(), vx: 0, vy: 0.2, vz: 0, size: 0.05, layer: TEX.p_spark, r: 0.6, g: 1, b: 0.5, life: 0.6, fullbright: true, collide: false });
      }
      break;
    }
  }
  if (!goal) {
    if (!(m.flyTimer > 0) || !m.fly) {
      m.flyTimer = 40 + Math.floor(Math.random() * 80);
      const c = m.hive || m;
      m.fly = airSpot(w, c.x, c.y, c.z, 6, 1, 4);
    }
    m.flyTimer--;
    if (m.fly) { goal = m.fly; land = false; }
  }
  if (goal) flyTo(m, w, goal[0], goal[1], goal[2], T ? 0.05 : 0.03, land);
  else flyTo(m, w, m.x, m.y + 0.2, m.z, 0.01);
  if (m.pollen && Math.random() < 0.08) game.particles.add({ x: m.x, y: m.y + 0.1, z: m.z, vx: 0, vy: -0.4, vz: 0, size: 0.035, layer: TEX.p_honey, r: 1, g: 1, b: 1, life: 0.7, collide: true });
  if (T || pdist < 6) { if (m.age % 30 === 0) game.audio.mob('bee', T ? 'angry' : 'idle', m.x, m.y, m.z); }
  return { moved: true };
}

// Bees nearby turn on whoever disturbed their hive.
export function angerBees(game, h, who) {
  for (const e of game.entities) {
    if (e.type !== 'bee' || e.dead || e.stung) continue;
    if ((e.hive && e.hive.x === h.x && e.hive.y === h.y && e.hive.z === h.z) || dist3(e, { x: h.x, y: h.y, z: h.z }) < 10) { e.angry = 800; e.angerTarget = who; }
  }
}

// ---------------------------------------------------------------------------
// Alpacas: sturdy pack animals of the hills. Win one over with wheat or hay,
// strap a chest to it, and it follows you with your things. They spit at
// creatures that threaten them.
function alpacaAI(m, game, p, pdist, lookAt) {
  if (m.target && (!alive(m.target) || dist3(m.target, m) > 16)) m.target = null;
  if (!m.target && m.angry > 0 && alive(m.angerTarget)) m.target = m.angerTarget;
  // spit at hostiles that come for it or its owner
  if (!m.target && (m.age + m.id) % 20 === 0) {
    const owner = m.tamed ? game.ownerOf(m.owner) : null;
    m.target = nearestOf(game, m, 10, (e) => e.hostile && e.type !== 'gloamer' && !!e.target && (e.target === m || (owner && e.target === owner)));
  }
  const T = m.target;
  if (T) {
    lookAt(T.x, T.y + (T.h || 1.6) * 0.8, T.z, true);
    if (m.attackCooldown <= 0 && game.canSee(m, T)) {
      m.attackCooldown = 40;
      game.mobThrow(m, 'spit', T.x, T.y + (T.h || 1.6) * 0.6, T.z, 1.3);
      game.audio.mob('alpaca', 'spit', m.x, m.y, m.z);
    }
    const d = Math.hypot(T.x - m.x, T.z - m.z);
    if (d < 4) return awayFrom(m, T, 4, 0.06);
    return { tx: null, tz: null, speed: 0 };
  }
  if (m.sitting) return { tx: null, tz: null, speed: 0 };
  if (m.tamed) { const f = followOwner(m, game, lookAt, 0.065, 5); if (f) return f; }
  return null;
}

function alpacaInteract(m, game, stack) {
  if (m.baby) return undefined;
  const p = game.player;
  const treat = stack && (stack.id === I.wheat || stack.id === B.hay_bale);
  if (!m.tamed) {
    if (!treat) return undefined;
    m.temper = Math.min(100, (m.temper || 0) + (stack.id === B.hay_bale ? 20 : 5));
    game.audio.play('eat', m.x, m.y + 1, m.z);
    if (Math.random() * 100 < m.temper) tryTame(m, game, 1, 'alpaca');
    else smoke(game, m, 3);
    return 'consume';
  }
  if (m.owner !== game.localName()) return undefined;
  if (stack && stack.id === B.chest && !m.pack) {
    m.pack = { type: 'pack', slots: new Array(9).fill(null) };
    game.audio.material('wood', 'place', m.x, m.y + 1, m.z);
    return 'consume';
  }
  if (treat && m.health < m.maxHealth) { m.health = Math.min(m.maxHealth, m.health + 4); game.particles.heart(m.x, m.y + m.h, m.z); return 'consume'; }
  if (treat && !(m.love > 0) && !(m.breedCooldown > 0)) { m.love = 600; return 'consume'; }
  if (m.pack && p.sneaking) {
    game.ui.openScreen('chest', { key: 'pack:' + m.id, be: m.pack, title: (m.customName || 'Alpaca') + "'s Pack", mob: m });
    return 'open';
  }
  m.sitting = !m.sitting;
  m.vx = m.vz = 0;
  return 'sit';
}

// ---------------------------------------------------------------------------
// Dolphins: playful swimmers of the open sea. They need air, leap from the
// waves, lend swimmers their speed, and fed a fish they lead the way to
// sunken treasure.
function dolphinAI(m, game, p, pdist, lookAt) {
  const w = game.world;
  m.checkFluids(w);
  m.pLimbAmount = m.limbAmount;
  if (m.air === undefined) m.air = 4800;
  if (m.eyesInWater) m.air--; else m.air = Math.min(4800, m.air + 40);
  if (m.air <= 0 && m.age % 20 === 0) m.hurt(game, 2, undefined, undefined, 'drown');
  if (m.inWater) {
    m.dry = 0;
    let goal = null;
    const T = m.angry > 0 && alive(m.angerTarget) ? m.angerTarget : null;
    if (T) {
      goal = [T.x, T.y + 0.5, T.z];
      if (dist3(T, m) < 1.8 && m.attackCooldown <= 0) {
        m.attackCooldown = 20;
        if (T.isMob) T.hurt(game, 3, m.x, m.z, 'mob:dolphin', m); else T.damage(game, 3, 'mob:dolphin', m.x, m.z);
      }
    } else if (m.air < 900) {
      goal = [m.x + Math.sin(m.bodyYaw) * 2, m.y + 6, m.z - Math.cos(m.bodyYaw) * 2];
    } else if (m.treasure && m.treasureTime > 0) {
      m.treasureTime--;
      goal = [m.treasure.x, Math.max(m.treasure.y, m.y - 2), m.treasure.z];
      if (m.age % 3 === 0) game.particles.add({ x: m.x, y: m.y + 0.3, z: m.z, vx: 0, vy: 0.3, vz: 0, size: 0.06, layer: TEX.p_bubble, r: 1, g: 1, b: 1, life: 1, collide: false });
      if (Math.hypot(m.treasure.x - m.x, m.treasure.z - m.z) < 4) m.treasureTime = 0;
    } else if (p && !p.dead && (p.inWater || (p.vehicle && p.vehicle.isBoat)) && pdist < 16) {
      // play alongside swimmers and boats
      goal = [p.x + Math.sin(m.age * 0.05) * 3, p.y - 0.5, p.z + Math.cos(m.age * 0.05) * 3];
      if (p.inWater && pdist < 7 && m.age % 20 === 0) giveEffect(game, p, 'sea_grace', 0, 100);
    } else {
      // swim with the pod
      if (!(m.swimTimer > 0) || m.sx === undefined) {
        m.swimTimer = 80 + Math.floor(Math.random() * 120);
        const mate = nearestOf(game, m, 20, (e) => e.type === 'dolphin');
        const cx = mate ? (mate.x + m.x) / 2 : m.x, cz = mate ? (mate.z + m.z) / 2 : m.z;
        for (let k = 0; k < 8; k++) {
          const tx = cx + (Math.random() - 0.5) * 24, ty = m.y + (Math.random() - 0.5) * 4, tz = cz + (Math.random() - 0.5) * 24;
          if (w.getBlock(Math.floor(tx), Math.floor(ty), Math.floor(tz)) === B.water) { m.sx = tx; m.sy = ty; m.sz = tz; break; }
        }
      }
      m.swimTimer--;
      if (m.sx !== undefined) goal = [m.sx, m.sy, m.sz];
    }
    if (goal) {
      const dx = goal[0] - m.x, dy = goal[1] - m.y, dz = goal[2] - m.z, d = Math.hypot(dx, dy, dz) || 1;
      const sp = T ? 0.03 : 0.022;
      m.vx += (dx / d) * sp; m.vy += (dy / d) * sp; m.vz += (dz / d) * sp;
      m.bodyYaw += wrapA(Math.atan2(dx, -dz) - m.bodyYaw) * 0.12;
      if (d < 1.2) m.sx = undefined;
    }
    // leap from the waves now and then
    if (!m.eyesInWater && m.vy > 0 && Math.random() < 0.03 && !T) { m.vy = 0.55; m.vx *= 1.6; m.vz *= 1.6; game.audio.play('splash', m.x, m.y, m.z, 0.3); }
    m.vx *= 0.9; m.vy *= 0.9; m.vz *= 0.9;
  } else {
    // out of the water: arc back in, or flop and dry out
    m.vy -= 0.06;
    if (m.onGround) {
      m.dry = (m.dry || 0) + 1;
      if (m.dry % 40 === 0) m.hurt(game, 1, undefined, undefined, 'dry');
      if (Math.random() < 0.08) { m.vy = 0.35; m.vx = (Math.random() - 0.5) * 0.3; m.vz = (Math.random() - 0.5) * 0.3; }
      m.vx *= 0.8; m.vz *= 0.8;
    } else { m.vx *= 0.99; m.vz *= 0.99; }
  }
  const r = moveBox(w, m, m.vx, m.vy, m.vz);
  m.applyHits(r);
  m.yaw = m.bodyYaw;
  m.pitchSwim = Math.max(-1, Math.min(1, -Math.atan2(m.vy, Math.hypot(m.vx, m.vz) + 0.001)));
  const moved = Math.hypot(m.x - m.px, m.y - m.py, m.z - m.pz);
  m.limbAmount += (Math.min(1, moved * 5) - m.limbAmount) * 0.3;
  m.limbSwing += 0.15 + moved * 3;
  if (m.attackCooldown > 0) m.attackCooldown--;
  return { moved: true };
}

function dolphinInteract(m, game, stack) {
  if (!stack || !FISH().includes(stack.id)) return undefined;
  const loc = game.locateTreasure ? game.locateTreasure(m.x, m.z) : null;
  hearts(game, m, 4);
  game.audio.mob('dolphin', 'idle', m.x, m.y, m.z);
  if (loc) { m.treasure = loc; m.treasureTime = 1200; }
  return 'consume';
}

// ---------------------------------------------------------------------------
const pick = (r, n) => Math.floor(r() * n);
export const WILD_TYPES = {
  fox: {
    model: 'fox', health: 10, wander: 0.04, panic: 0.1, chase: 0.09, xp: 2, sound: 'fox', noPanic: false,
    food: [], drops: (r, m) => (m.held ? [[m.held.id, m.held.count || 1]] : []), ai: foxAI, interact: foxInteract,
  },
  cat: {
    model: 'cat', health: 10, wander: 0.04, panic: 0.1, xp: 2, sound: 'cat', noPanic: false, noFall: true,
    food: [], drops: (r) => [[I.string, pick(r, 3)]], ai: catAI, interact: catInteract,
  },
  parrot: {
    model: 'parrot', health: 6, wander: 0.04, panic: 0.08, xp: 2, sound: 'parrot', noFall: true, flier: true,
    drops: (r) => [[I.feather, 1 + pick(r, 2)]], ai: parrotAI, interact: parrotInteract,
  },
  bee: {
    model: 'bee', health: 10, wander: 0.04, panic: 0.06, xp: 1, sound: 'bee', noFall: true, flier: true, neutral: true, noPanic: true,
    food: [], drops: () => [], ai: beeAI,
  },
  alpaca: {
    model: 'alpaca', health: 22, wander: 0.035, panic: 0.09, xp: 2, sound: 'alpaca', noPanic: true,
    food: [], drops: (r, m) => [[I.leather, pick(r, 3)], ...(m.pack ? [[B.chest, 1]] : [])], ai: alpacaAI, interact: alpacaInteract,
  },
  dolphin: {
    model: 'dolphin', health: 10, wander: 0.03, xp: 1, sound: 'dolphin', aquatic: true, noPanic: true, neutral: true,
    drops: (r) => [[I.raw_silverfin, pick(r, 2)]], ai: dolphinAI, interact: dolphinInteract,
  },
};
WILD_TYPES.fox.food = [I.sweet_berries];
WILD_TYPES.cat.food = FISH();
WILD_TYPES.bee.food = [B.dandelion, B.poppy, B.cornflower];
WILD_TYPES.alpaca.food = [I.wheat, B.hay_bale];
