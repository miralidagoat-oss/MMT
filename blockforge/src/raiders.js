// Raiders and raids. Marauders (axes) and rangers (bows) garrison the
// outposts under a captain; brutes join them on the march. Defeat a captain
// and an Ill Omen follows you: walk into a village with it and the raiders
// come in waves. Win and the village honours you.
import { I } from './items.js';
import { B, SOLID, BLOCKS } from './blocks.js';
import { addEffect } from './effects.js';
import { alive, dist3 } from './creatures.js';
import { nearestOf } from './wildlife.js';

const pick = (r, n) => Math.floor(r() * n);
const RAIDER_TYPES_SET = new Set(['marauder', 'ranger', 'brute', 'hexer']);
export const isRaider = (e) => !!e && e.isMob && RAIDER_TYPES_SET.has(e.type) && (e.type !== 'hexer' || e.raid);

// Raiders go for players, then settlers, sentinels and tame hounds; on a raid
// with nothing in reach they march on the village centre.
function raiderAI(m, game, p, pdist, lookAt) {
  if (m.celebrating) {
    m.target = null;
    if (m.onGround && Math.random() < 0.08) m.vy = 0.42;
    if (m.age % 40 === 0) game.audio.mob(m.def.sound, 'idle', m.x, m.y, m.z);
    return { tx: null, tz: null, speed: 0 };
  }
  if (m.target && m.target.isMob && (!alive(m.target) || dist3(m.target, m) > 32)) m.target = null;
  if (!m.target || m.target.isMob) {
    if (m.wantsTarget(game, p, pdist)) m.target = p;
    else if (!m.target && (m.age + m.id) % 20 === 0) {
      m.target = nearestOf(game, m, m.raid ? 40 : 14, (e) => e.def.villager || e.type === 'sentinel' || (e.tamed && e.type === 'hound'));
    }
  }
  const R = game.raid;
  if (!m.target && m.raid && R && R.state === 'fighting') {
    const d = Math.hypot(R.x - m.x, R.z - m.z);
    if (d > 6) return { tx: R.x, tz: R.z, ty: R.y, speed: m.def.chase * 0.85, urgent: true };
  }
  if (!m.target && m.home && Math.hypot(m.home.x - m.x, m.home.z - m.z) > 14) return { tx: m.home.x, tz: m.home.z, ty: m.home.y, speed: m.def.wander * 1.5 };
  if (m.type === 'brute' && m.target) {
    // a brute tramples crops and tears through leaves in its way
    if (m.age % 5 === 0) {
      const fx = Math.floor(m.x + Math.sin(m.bodyYaw) * 1.4), fz = Math.floor(m.z - Math.cos(m.bodyYaw) * 1.4);
      for (let dy = 0; dy <= 2; dy++) {
        const id = game.world.getBlock(fx, Math.floor(m.y) + dy, fz);
        if (id && (/leaves$/.test(BLOCKS[id].name) || id === B.wheat || id === B.carrots || id === B.potatoes || id === B.berry_bush)) game.breakBlock(fx, Math.floor(m.y) + dy, fz, true);
      }
    }
  }
  return null; // the shared hostile behaviour fights the target
}

export const RAIDER_TYPES = {
  marauder: {
    model: 'marauder', health: 24, wander: 0.035, chase: 0.075, hostile: true, damage: 5, xp: 6, sound: 'marauder',
    drops: (r, m) => [...(r() < 0.25 ? [[I.emerald, 1]] : []), ...(r() < 0.06 ? [[I.iron_axe, 1]] : []), ...(m.variant === 'captain' ? [[I.white_banner, 1]] : [])],
    ai: raiderAI,
  },
  ranger: {
    model: 'marauder', health: 24, wander: 0.035, chase: 0.065, hostile: true, ranged: true, damage: 3, xp: 6, sound: 'marauder',
    drops: (r) => [[I.arrow, pick(r, 4)], ...(r() < 0.25 ? [[I.emerald, 1]] : []), ...(r() < 0.08 ? [[I.bow, 1]] : [])],
    ai: raiderAI,
  },
  brute: {
    model: 'brute', health: 100, wander: 0.03, chase: 0.068, hostile: true, damage: 9, xp: 20, sound: 'brute', heavy: true, noFall: true,
    drops: (r) => [[I.leather, 2 + pick(r, 3)], [I.raw_beef, 1 + pick(r, 3)]],
    ai: raiderAI,
  },
};

// ---------------------------------------------------------------------------
// The raid: waves of raiders against a village.
const WAVES = [
  [['marauder', 3], ['ranger', 1]],
  [['marauder', 3], ['ranger', 2]],
  [['marauder', 3], ['ranger', 2], ['brute', 1]],
  [['marauder', 4], ['ranger', 2], ['hexer', 1]],
  [['marauder', 4], ['ranger', 3], ['brute', 1], ['hexer', 1]],
  [['marauder', 5], ['ranger', 3], ['brute', 2], ['hexer', 1]],
];

export function installRaids(Game, Mob) {
  Object.assign(Game.prototype, {
    // Ill omen + a village = a raid.
    tickRaids() {
      if (this.dim !== 'overworld' || (this.net && this.net.isGuest) || this.demo) return;
      const p = this.player;
      const R = this.raid;
      if (!R) {
        if (this.tickCount % 20 !== 0 || !p.effects.ill_omen || p.creative || p.spectator) return;
        const vs = this.world.gen.villages;
        const v = vs && vs.locate(p.x, p.z, 1);
        if (!v || p.x < v.bx0 - 4 || p.x > v.bx1 + 4 || p.z < v.bz0 - 4 || p.z > v.bz1 + 4) return;
        const level = p.effects.ill_omen.amp + 1;
        delete p.effects.ill_omen;
        this.raid = { x: v.x + 0.5, y: v.h + 1, z: v.z + 0.5, wave: 0, waves: Math.min(WAVES.length, 2 + level), state: 'pending', timer: 300, total: 0, ids: [] };
        this.ui.message('A raid is coming! Defend the village.', '#e86a4a');
        this.audio.play('horn', p.x, p.y + 1, p.z);
        return;
      }
      if (this.tickCount % 10 !== 0) return;
      const raiders = this.entities.filter((e) => e.raid && !e.dead && !e.removed && e.isMob);
      R.left = raiders.length;
      // too far away for too long and the raid is abandoned
      if (Math.hypot(p.x - R.x, p.z - R.z) > 160) { R.away = (R.away || 0) + 10; if (R.away > 2400) { this.endRaid('lost'); return; } } else R.away = 0;
      if (R.state === 'pending' || R.state === 'between') {
        R.timer -= 10;
        if (R.timer <= 0) this.spawnWave();
        return;
      }
      if (R.state === 'fighting') {
        const settlers = this.entities.filter((e) => e.def && e.def.villager && !e.dead && Math.hypot(e.x - R.x, e.z - R.z) < 72);
        if (!settlers.length && R.wave > 0 && R.hadSettlers) { this.endRaid('lost'); return; }
        if (settlers.length) R.hadSettlers = true;
        if (!raiders.length) {
          if (R.wave >= R.waves) { this.endRaid('won'); return; }
          R.state = 'between'; R.timer = 300;
          this.ui.message(`Wave ${R.wave} beaten — more raiders are coming…`, '#e8c86a');
        }
      }
      if (R.state === 'over') {
        R.timer -= 10;
        if (R.timer <= 0) { for (const e of raiders) e.celebrating = false; this.raid = null; }
      }
    },

    spawnWave() {
      const R = this.raid, w = this.world;
      const wave = WAVES[Math.min(R.wave, WAVES.length - 1)];
      // gather at a spot out beyond the houses
      let sx = R.x, sz = R.z, sy = R.y;
      for (let k = 0; k < 16; k++) {
        const a = Math.random() * Math.PI * 2, d = 34 + Math.random() * 10;
        const x = Math.floor(R.x + Math.cos(a) * d), z = Math.floor(R.z + Math.sin(a) * d);
        if (!w.chunkReady(x >> 4, z >> 4)) continue;
        const y = w.surfaceY(x, z);
        if (!SOLID[w.getBlock(x, y - 1, z)]) continue;
        sx = x + 0.5; sz = z + 0.5; sy = y; break;
      }
      R.wave++;
      R.state = 'fighting';
      let n = 0;
      for (const [type, count] of wave) {
        for (let i = 0; i < count; i++) {
          const m = new Mob(type, sx + (Math.random() - 0.5) * 4, sy, sz + (Math.random() - 0.5) * 4, { persistent: true });
          m.raid = true;
          if (type === 'marauder' && i === 0 && R.wave === R.waves) m.variant = 'captain';
          this.entities.push(m);
          n++;
        }
      }
      R.total = n;
      this.audio.play('horn', sx, sy + 1, sz);
      this.ui.message(`Raid — wave ${R.wave} of ${R.waves}`, '#e86a4a');
    },

    endRaid(result) {
      const R = this.raid, p = this.player;
      if (!R) return;
      R.state = 'over'; R.result = result; R.timer = 200;
      if (result === 'won') {
        addEffect(p, 'village_hero', 0, 48000);
        this.advance('raid');
        this.ui.message('Victory! The village is safe — and grateful.', '#7ee08a');
        for (let i = 0; i < 6; i++) this.particles.firework && this.particles.firework(R.x + (Math.random() - 0.5) * 20, R.y + 12 + Math.random() * 8, R.z + (Math.random() - 0.5) * 20);
        this.audio.play('levelup_big', p.x, p.y + 1, p.z);
      } else {
        this.ui.message('The raid was lost.', '#e86a4a');
        for (const e of this.entities) if (e.raid && !e.dead) e.celebrating = true;
      }
    },

    // A raid captain's fall brings an ill omen on the one who felled it.
    onMobKilled5(mob) {
      if (mob.type === 'marauder' && mob.variant === 'captain' && mob.lastHitBy === 'player' && !mob.raid) {
        const p = this.player;
        const cur = p.effects.ill_omen ? p.effects.ill_omen.amp + 1 : 0;
        addEffect(p, 'ill_omen', Math.min(4, cur), 120000);
        this.ui.message('You feel an ill omen…', '#8aa86a');
      }
    },

    // Shown in the HUD while a raid is on.
    raidBar() {
      const R = this.raid;
      if (!R) return null;
      if (R.state === 'over') return { name: R.result === 'won' ? 'Raid — Victory' : 'Raid — Defeat', f: R.result === 'won' ? 0 : 1 };
      if (R.state !== 'fighting') return { name: `Raid — wave ${R.wave + 1} of ${R.waves} approaching`, f: 1 };
      return { name: `Raid — wave ${R.wave} of ${R.waves} · ${R.left ?? R.total} raiders`, f: R.total ? (R.left ?? R.total) / R.total : 0 };
    },
  });
}
void dist3; void B;
