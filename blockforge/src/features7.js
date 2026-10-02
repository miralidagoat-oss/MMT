// Gameplay for the seventh wave, mixed into Game: copper that weathers (and
// is waxed with honeycomb or scraped back with an axe), lightning rods, and
// the Deep Dark: vibrations, sculk sensors, shriekers, catalysts, darkness
// and the blind guardian the shriekers call.
import { B, BLOCKS, SOLID, OPAQUE, TEX } from './blocks.js';
import { ITEMS, I } from './items.js';
import { Mob } from './entities.js';
import { addEffect } from './effects.js';
import { boxFree } from './physics.js';

const K = (x, y, z) => `${x},${y},${z}`;
export const COPPER = () => [B.copper_block, B.exposed_copper, B.weathered_copper, B.oxidized_copper];
const WAXED = 8;
const SCULKY = () => new Set([B.sculk_sensor, B.sculk_shrieker]);

export function installFeatures7(Game) {
  Object.assign(Game.prototype, methods);
}

const methods = {
  // --- copper -------------------------------------------------------------------
  randomTick7(x, y, z, id) {
    const st = COPPER().indexOf(id);
    if (st >= 0 && st < 3) {
      const m = this.world.getMeta(x, y, z);
      if (!(m & WAXED) && Math.random() < 0.06) this.world.setBlock(x, y, z, COPPER()[st + 1], m, { urgent: false });
      return true;
    }
    return false;
  },

  // Honeycomb waxes copper (it stops ageing); an axe scrapes off wax or a stage of patina.
  useItem7(held, hit) {
    if (!hit) return false;
    const w = this.world, p = this.player;
    const st = COPPER().indexOf(hit.id);
    if (st < 0) return false;
    const m = w.getMeta(hit.x, hit.y, hit.z);
    const puff = (layer, col) => {
      for (let i = 0; i < 10; i++) this.particles.add({ x: hit.x + Math.random(), y: hit.y + Math.random(), z: hit.z + Math.random(), vx: (Math.random() - 0.5), vy: 0.6, vz: (Math.random() - 0.5), size: 0.06, layer, life: 0.8, gravity: 2, fullbright: true, r: col[0], g: col[1], b: col[2] });
    };
    if (held.id === I.honeycomb && !(m & WAXED)) {
      w.setBlock(hit.x, hit.y, hit.z, hit.id, m | WAXED);
      if (!p.creative) p.inventory.useHeld();
      puff(TEX.p_wax, [1, 0.8, 0.4]);
      this.audio.play('wax', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      this.startSwing();
      this.advance('wax');
      return true;
    }
    const tool = ITEMS[held.id] && ITEMS[held.id].tool;
    if (tool && tool.type === 'axe' && ((m & WAXED) || st > 0)) {
      if (m & WAXED) w.setBlock(hit.x, hit.y, hit.z, hit.id, m & ~WAXED);
      else w.setBlock(hit.x, hit.y, hit.z, COPPER()[st - 1], m);
      puff(TEX.p_spark, (m & WAXED) ? [1, 0.85, 0.5] : [0.5, 1, 0.85]);
      this.audio.play('scrape', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      this.damageTool(1);
      this.startSwing();
      return true;
    }
    return false;
  },

  // A spark pulse from a block with the 'pulse' role (rods, sensors).
  pulseBlock(x, y, z, level, ticks) {
    const w = this.world, id = w.getBlock(x, y, z), m = w.getMeta(x, y, z);
    w.setBlock(x, y, z, id, (m & 15) | (Math.max(1, Math.min(15, level)) << 4), { notify: false, keepEntity: true });
    this.circuits.markOut(x, y, z);
    this.circuits.schedule(x, y, z, ticks, 'unpulse');
  },

  // --- lightning rods ------------------------------------------------------------
  // Lightning near a rod strikes the rod instead.
  rodNear(x, z) {
    let best = null, bd = 48;
    for (const [key, be] of this.world.blockEntities) {
      if (be.type !== 'rod') continue;
      const [rx, ry, rz] = key.split(',').map(Number);
      const d = Math.hypot(rx + 0.5 - x, rz + 0.5 - z);
      if (d < bd && this.world.getBlock(rx, ry, rz) === B.lightning_rod) { bd = d; best = { x: rx, y: ry, z: rz }; }
    }
    return best;
  },
  rodStruck(r) {
    const w = this.world;
    this.pulseBlock(r.x, r.y, r.z, 15, 8);
    // the strike scours the patina off copper the rod stands on
    for (let dy = -1; dy >= -4; dy--) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const x = r.x + dx, y = r.y + dy, z = r.z + dz, id = w.getBlock(x, y, z);
      if (COPPER().indexOf(id) > 0 && !(w.getMeta(x, y, z) & WAXED)) w.setBlock(x, y, z, B.copper_block, w.getMeta(x, y, z));
    }
  },
  onBlockChange7(x, y, z, id) {
    const w = this.world, key = K(x, y, z);
    if (id === B.lightning_rod && !w.blockEntities.has(key)) w.blockEntities.set(key, { type: 'rod' });
    if (SCULKY().has(id) && !w.blockEntities.has(key)) { w.blockEntities.set(key, { type: 'sculk', cool: 0 }); this.sculks = null; }
  },

  // --- vibrations ----------------------------------------------------------------
  // Something moved, broke, landed or was hurt at (x, y, z). Sculk sensors
  // within eight blocks hear it; shriekers answer players.
  vibrate(x, y, z, src, kind = 'step') {
    if (this.demo || (this.net && this.net.isGuest)) return;
    if (src && src.isPlayer && (src.sneaking || src.creative || src.spectator) && kind === 'step') return;
    if (src && src.type === 'listener') return;
    if (!this.sculks) {
      this.sculks = [];
      for (const [key, be] of this.world.blockEntities) if (be.type === 'sculk') this.sculks.push(key);
    }
    if (!this.sculks.length) return;
    const w = this.world, now = this.tickCount;
    for (const key of this.sculks) {
      const be = w.blockEntities.get(key);
      if (!be) { this.sculks = null; return; }
      const [sx, sy, sz] = key.split(',').map(Number);
      const d = Math.hypot(sx + 0.5 - x, sy + 0.5 - y, sz + 0.5 - z);
      if (d > 8 || (be.cool || 0) > now) continue;
      const id = w.getBlock(sx, sy, sz);
      if (id === B.sculk_sensor) {
        be.cool = now + 40;
        this.pulseBlock(sx, sy, sz, 15 - Math.floor(d), 30);
        // a ripple travels from the source to the sensor
        const tt = 0.6;
        this.particles.add({ x, y: y + 0.3, z, vx: (sx + 0.5 - x) / tt, vy: (sy + 0.6 - y - 0.3) / tt, vz: (sz + 0.5 - z) / tt, size: 0.12, layer: TEX.p_vibration, life: tt, gravity: 0, drag: 1, fullbright: true, collide: false });
        this.audio.play('sculk_click', sx + 0.5, sy + 0.5, sz + 0.5);
        this.listenerHears(x, y, z, src);
      } else if (id === B.sculk_shrieker && src && src.isPlayer && !src.creative && !src.spectator) {
        be.cool = now + 200;
        this.shriek(sx, sy, sz, src);
      } else if (!SCULKY().has(id)) { w.blockEntities.delete(key); this.sculks = null; return; }
    }
  },

  shriek(x, y, z, who) {
    this.audio.play('shriek', x + 0.5, y + 1, z + 0.5);
    for (let i = 0; i < 12; i++) this.particles.add({ x: x + 0.5, y: y + 1, z: z + 0.5, vx: (Math.random() - 0.5) * 0.4, vy: 1.5 + Math.random(), vz: (Math.random() - 0.5) * 0.4, size: 0.18, layer: TEX.p_sonic, life: 1.4, gravity: 0, drag: 0.99, fullbright: true, collide: false, shrink: true });
    // darkness falls on everyone near, and the warning grows
    for (const pl of this.players ? this.players() : [this.player]) {
      if (Math.hypot(pl.x - x, pl.z - z) > 40) continue;
      if (pl.isRemote) { if (pl.applyPotion) pl.applyPotion(this, { effect: 'darkness', amp: 0, ticks: 260 }); } else addEffect(pl, 'darkness', 0, 260);
    }
    // each player carries their own warning, friends included
    const p = who && who.isPlayer ? who : this.player;
    p.warning = Math.min(4, (p.warning || 0) + 1);
    p.warningAt = this.tickCount;
    if (p.warning >= 4) {
      p.warning = 0;
      if (!this.entities.some((e) => e.type === 'listener' && !e.dead && Math.hypot(e.x - x, e.z - z) < 48)) this.summonListener(x, y, z, who);
    } else {
      const text = ['The shrieker screams…', 'Something stirs in the deep…', 'It is close. Move quietly.'][p.warning - 1];
      if (p.isRemote) { if (this.net) this.net.event(p.peer, { t: 'msg', text, color: '#7ec8d0' }); } else this.ui.message(text, '#7ec8d0');
    }
  },

  // The guardian rises out of the ground near a shrieker.
  summonListener(x, y, z, who) {
    const w = this.world;
    for (let k = 0; k < 20; k++) {
      const tx = x + Math.floor((Math.random() - 0.5) * 10), tz = z + Math.floor((Math.random() - 0.5) * 10);
      for (let ty = y + 3; ty >= y - 5; ty--) {
        if (!SOLID[w.getBlock(tx, ty - 1, tz)] || SOLID[w.getBlock(tx, ty, tz)]) continue;
        const m = new Mob('listener', tx + 0.5, ty, tz + 0.5, { persistent: true });
        if (!boxFree(w, m.x, m.y, m.z, m.w, m.h)) continue;
        m.emerging = 100;
        if (who) { m.anger = new Map([[who, 40]]); m.heard = { x: who.x, y: who.y, z: who.z }; }
        this.entities.push(m);
        this.audio.mob('listener', 'emerge', m.x, m.y, m.z);
        this.ui.message('The Listener has risen. Stay silent.', '#7ec8d0');
        if (this.net && this.net.isHost) this.net.send('ev', { t: 'msg', text: 'The Listener has risen. Stay silent.', color: '#7ec8d0' }, 0);
        // survive a minute near it and it counts
        this.listenerSince = this.tickCount;
        return m;
      }
    }
    return null;
  },

  // Listeners nearby take note of a vibration (and of who made it).
  listenerHears(x, y, z, src) {
    for (const e of this.entities) {
      if (e.type !== 'listener' || e.dead || Math.hypot(e.x - x, e.y - y, e.z - z) > 24) continue;
      e.heard = { x, y, z };
      if (src && (src.isPlayer || src.isMob) && src !== e) {
        e.anger = e.anger || new Map();
        e.anger.set(src, (e.anger.get(src) || 0) + (src.isPlayer ? 10 : 6));
      }
      e.calm = 0;
    }
  },

  // A catalyst spreads sculk where creatures die nearby.
  onMobKilled7(mob) {
    if (!mob.def.xp || mob.type === 'listener') return;
    const w = this.world;
    const mx = Math.floor(mob.x), my = Math.floor(mob.y), mz = Math.floor(mob.z);
    let cat = false;
    for (let dy = -4; dy <= 4 && !cat; dy++) for (let dz = -8; dz <= 8 && !cat; dz++) for (let dx = -8; dx <= 8; dx++) if (w.getBlock(mx + dx, my + dy, mz + dz) === B.sculk_catalyst) { cat = true; break; }
    if (!cat) return;
    let n = 3 + mob.def.xp * 2;
    for (let k = 0; k < 60 && n > 0; k++) {
      const x = mx + Math.round((Math.random() - 0.5) * 6), z = mz + Math.round((Math.random() - 0.5) * 6);
      for (let y = my + 1; y >= my - 2; y--) {
        const id = w.getBlock(x, y, z);
        if (!OPAQUE[id] || id === B.sculk || id === B.sculk_catalyst || BLOCKS[id].hardness < 0) continue;
        if (SOLID[w.getBlock(x, y + 1, z)]) continue;
        w.setBlock(x, y, z, B.sculk, 0); n--;
        if (Math.random() < 0.06 && !w.getBlock(x, y + 1, z)) w.setBlock(x, y + 1, z, B.sculk_sensor, 0);
        this.particles.add({ x: x + 0.5, y: y + 1.1, z: z + 0.5, vx: 0, vy: 0.6, vz: 0, size: 0.1, layer: TEX.p_sculk_soul, life: 0.9, gravity: 0, fullbright: true, collide: false });
        break;
      }
    }
    this.audio.play('sculk_spread', mob.x, mob.y, mob.z);
  },

  // How deep the darkness effect is this frame: it eases in, then throbs.
  darknessLevel(p) {
    const e = p && p.effects && p.effects.darkness;
    const target = e ? Math.min(1, e.time / 40) * (0.72 + 0.28 * Math.sin(performance.now() / 1000 * 2.4)) : 0;
    this._dark = (this._dark || 0) + (target - (this._dark || 0)) * 0.06;
    return this._dark < 0.004 ? 0 : this._dark;
  },

  // The warning a shrieker keeps fades with time.
  tickFeatures7() {
    const p = this.player;
    if (this.listenerSince && this.tickCount - this.listenerSince > 1200) {
      this.listenerSince = 0;
      if (!p.dead) this.advance('listener');
    }
    if (p.warning && this.tickCount - (p.warningAt || 0) > 12000) { p.warning--; p.warningAt = this.tickCount; }
  },
};
void ITEMS;
