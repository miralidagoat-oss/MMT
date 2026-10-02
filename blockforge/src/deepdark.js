// The Listener: the blind guardian of the Deep Dark. It cannot see; it hears.
// Every vibration it notices points it somewhere, and whoever keeps making
// noise angers it. Close up it strikes hard; at range it charges a sonic
// blast that passes through walls. Left in peace it sinks back into the ground.
import { I } from './items.js';
import { B, SOLID, TEX } from './blocks.js';
import { addEffect } from './effects.js';
import { alive, dist3 } from './creatures.js';

function hurtTarget(game, m, T, dmg, src) {
  if (T.isMob) return T.hurt(game, dmg, m.x, m.z, src, m);
  if (T.isRemote) { if (game.net) game.net.hitRemote(T, dmg, src, m.x, m.z); return true; }
  return T.damage(game, dmg, src, m.x, m.z);
}

function listenerAI(m, game, p, pdist, lookAt) {
  const w = game.world;
  // rising out of the ground, or sinking back into it
  if (m.emerging > 0) {
    m.emerging--;
    if (m.age % 4 === 0) game.particles.blockBreak(Math.floor(m.x), Math.floor(m.y) - 1, Math.floor(m.z), w.getBlock(Math.floor(m.x), Math.floor(m.y) - 1, Math.floor(m.z)) || B.deep_stone, 0);
    return { tx: null, tz: null, speed: 0 };
  }
  if (m.digging > 0) {
    m.digging--;
    if (m.age % 4 === 0) game.particles.blockBreak(Math.floor(m.x), Math.floor(m.y) - 1, Math.floor(m.z), w.getBlock(Math.floor(m.x), Math.floor(m.y) - 1, Math.floor(m.z)) || B.deep_stone, 0);
    if (m.digging === 0) m.removed = true;
    return { tx: null, tz: null, speed: 0 };
  }
  m.anger = m.anger || new Map();
  // anger fades slowly; the dead and the gone are forgotten
  let target = null, top = 0;
  for (const [e, a] of m.anger) {
    if (!alive(e) || (e.isPlayer && (e.creative || e.spectator)) || dist3(e, m) > 48) { m.anger.delete(e); continue; }
    const na = Math.max(0, a - 0.02);
    m.anger.set(e, na);
    if (na > top) { top = na; target = e; }
  }
  // every so often it sniffs the air for anyone close by
  if (m.age % 120 === 0) {
    game.audio.mob('listener', 'sniff', m.x, m.y, m.z);
    for (const pl of game.players ? game.players() : [game.player]) {
      if (pl.creative || pl.spectator || pl.dead || dist3(pl, m) > 20) continue;
      m.anger.set(pl, (m.anger.get(pl) || 0) + 6);
    }
  }
  // its presence darkens the world around it
  if (m.age % 100 === 0) {
    for (const pl of game.players ? game.players() : [game.player]) {
      if (dist3(pl, m) > 20) continue;
      if (pl.isRemote) { if (pl.applyPotion) pl.applyPotion(game, { effect: 'darkness', amp: 0, ticks: 260 }); } else addEffect(pl, 'darkness', 0, 260);
    }
  }
  if (m.age % 40 === 0) game.audio.mob('listener', 'heart', m.x, m.y, m.z);
  m.calm = (m.calm || 0) + 1;
  if (top >= 30) m.calm = 0;
  if (m.calm > 1200) { m.digging = 100; game.audio.mob('listener', 'dig', m.x, m.y, m.z); return { tx: null, tz: null, speed: 0 }; }
  if (m.attackCooldown > 0) m.attackCooldown--;
  if (target && top >= 30) {
    m.listening = 0;
    const d = dist3(target, m);
    lookAt(target.x, target.y + 1.5, target.z, false);
    if (d < 2.6 && Math.abs(target.y - m.y) < 2.5) {
      if (m.attackCooldown <= 0) {
        m.attackCooldown = 30; m.swing = 10;
        if (hurtTarget(game, m, target, 14, 'mob:listener')) { target.vy = Math.max(target.vy || 0, 0.4); }
        game.audio.mob('listener', 'attack', m.x, m.y, m.z);
      }
      return { tx: target.x, tz: target.z, ty: target.y, speed: 0, urgent: true };
    }
    // the sonic blast: a slow charge, then it goes straight through anything
    if (d < 15 && (m.boom || 0) >= 0) {
      m.boom = (m.boom || 0) + 1;
      if (m.boom === 1) game.audio.mob('listener', 'charge', m.x, m.y, m.z);
      if (m.boom >= 34) {
        m.boom = -60;
        const sx = m.x, sy = m.y + 2, sz = m.z, tx = target.x, ty = target.y + 1, tz = target.z;
        const n = Math.ceil(d * 1.5);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          game.particles.add({ x: sx + (tx - sx) * t, y: sy + (ty - sy) * t, z: sz + (tz - sz) * t, vx: 0, vy: 0, vz: 0, size: 0.35 + t * 0.2, layer: TEX.p_sonic, life: 0.6, gravity: 0, fullbright: true, collide: false, shrink: true });
        }
        hurtTarget(game, m, target, 10, 'sonic');
        const l = Math.hypot(tx - sx, tz - sz) || 1;
        target.vx = (target.vx || 0) + ((tx - sx) / l) * 1.2; target.vz = (target.vz || 0) + ((tz - sz) / l) * 1.2; target.vy = 0.5;
        game.audio.mob('listener', 'boom', m.x, m.y, m.z);
      }
      return { tx: target.x, tz: target.z, ty: target.y, speed: 0.05, urgent: true };
    }
    if (m.boom < 0) m.boom++;
    return { tx: target.x, tz: target.z, ty: target.y, speed: 0.085, urgent: true };
  }
  if (m.boom < 0) m.boom++; else m.boom = 0;
  // otherwise it goes to look at whatever it last heard
  if (m.heard) {
    const h = m.heard;
    if (Math.hypot(h.x - m.x, h.z - m.z) < 1.5) { m.heard = null; m.listening = 40; }
    else return { tx: h.x, tz: h.z, ty: h.y, speed: 0.045, urgent: true };
  }
  if (m.listening > 0) { m.listening--; return { tx: null, tz: null, speed: 0 }; }
  return null;
}

export const DEEP_TYPES = {
  listener: {
    model: 'listener', health: 250, wander: 0.025, chase: 0.085, xp: 5, sound: 'listener', noPanic: true, heavy: true, noFall: true, fireproof: true,
    drops: () => [[B.sculk_catalyst, 1]], ai: listenerAI,
  },
};

// Hit by someone: it now knows exactly where they are.
export function listenerHurt(m, attacker) {
  if (!attacker || m.type !== 'listener') return;
  m.anger = m.anger || new Map();
  m.anger.set(attacker, Math.min(150, (m.anger.get(attacker) || 0) + 35));
}
void I; void SOLID;
