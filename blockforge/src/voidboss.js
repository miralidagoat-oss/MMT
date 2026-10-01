// The Void's guardian (a long flying serpent called the Void Wyrm), the
// pylons on the obsidian pillars that heal it, star eyes that fly toward the
// nearest observatory, and the wyrm's void orbs.
import { Entity } from './entities.js';
import { I } from './items.js';
import { B, SOLID } from './blocks.js';
import { raycast } from './physics.js';

export const WYRM_HEALTH = 200;
const SEGMENTS = 12;

export class Pylon extends Entity {
  constructor(x, y, z) {
    super(x, y, z, 0.6, 1.4);
    this.isPylon = true;
    this.spin = Math.random() * 6;
  }
  get targetable() { return true; }
  hitBoxes() { return [[this.x - 0.7, this.y, this.z - 0.7, this.x + 0.7, this.y + 1.6, this.z + 0.7]]; }
  tick() { this.savePrev(); this.age++; }
  hit(game) {
    if (this.removed) return;
    this.removed = true;
    game.explode(this.x, this.y + 0.6, this.z, 6, { noBlocks: true });
    if (game.wyrm) game.wyrm.pylonLost(this, game);
  }
  serialize() { return { kind: 'pylon', x: this.x, y: this.y, z: this.z }; }
}

export class Wyrm extends Entity {
  constructor(x, y, z, health = WYRM_HEALTH) {
    super(x, y, z, 1.4, 1.6);
    this.isWyrm = true;
    this.health = health;
    this.maxHealth = WYRM_HEALTH;
    this.trail = [];
    for (let i = 0; i < SEGMENTS * 3 + 2; i++) this.trail.push([x, y, z]);
    this.segs = [];
    for (let i = 0; i < SEGMENTS; i++) this.segs.push({ x, y, z, px: x, py: y, pz: z, yaw: 0, pitch: 0 });
    this.mode = 'circle';
    this.modeTime = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.healing = null;
    this.hurtTime = 0;
    this.dying = 0;
    this.pitch = 0;
    this.orbTimer = 120;
  }

  get targetable() { return !this.dying; }
  get dead() { return this.dying > 0; }

  hitBoxes() {
    const out = [[this.x - 1.6, this.y - 0.6, this.z - 1.6, this.x + 1.6, this.y + 1.4, this.z + 1.6]];
    for (let i = 1; i < this.segs.length; i += 2) {
      const s = this.segs[i], r = 1.2 - i * 0.05;
      out.push([s.x - r, s.y - r * 0.6, s.z - r, s.x + r, s.y + r, s.z + r]);
    }
    return out;
  }

  hit(game, dmg, source) {
    if (this.dying || this.hurtTime > 0) return false;
    this.health -= dmg;
    this.hurtTime = 10;
    game.audio.mob('wyrm', 'hurt', this.x, this.y, this.z);
    if (this.mode === 'circle' && Math.random() < 0.5) this.setMode('dive');
    if (this.health <= 0) { this.health = 0; this.dying = 1; game.audio.mob('wyrm', 'death', this.x, this.y, this.z); }
    void source;
    return true;
  }

  pylonLost(p, game) {
    if (this.healing === p) { this.healing = null; this.hit(game, 10, 'explosion'); }
  }

  setMode(m) { this.mode = m; this.modeTime = 0; }

  tick(game) {
    this.savePrev();
    for (const s of this.segs) { s.px = s.x; s.py = s.y; s.pz = s.z; }
    this.age++;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.dying) { this.tickDeath(game); return; }
    this.modeTime++;
    const p = game.player;
    let tx, ty, tz, speed = 0.75;
    const near = p && !p.dead && !p.creative && Math.hypot(p.x - this.x, p.z - this.z) < 160;
    if (this.mode === 'circle') {
      this.angle += 0.008;
      const r = 55 + Math.sin(this.age / 300) * 12;
      tx = Math.cos(this.angle) * r; tz = Math.sin(this.angle) * r; ty = 82 + Math.sin(this.age / 90) * 8;
      if (near && this.modeTime > 400 && Math.random() < 0.006) this.setMode('dive');
      if (this.health < this.maxHealth && this.modeTime > 200 && Math.random() < 0.004) this.setMode('rest');
    } else if (this.mode === 'dive') {
      if (!near) { this.setMode('circle'); return; }
      tx = p.x; ty = p.y + 1; tz = p.z; speed = 1.0;
      if (Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z) < 3 || this.modeTime > 160) this.setMode('climb');
    } else if (this.mode === 'climb') {
      const a = Math.atan2(this.z, this.x);
      tx = Math.cos(a) * 70; tz = Math.sin(a) * 70; ty = 95; speed = 0.8;
      if (this.modeTime > 80) this.setMode('circle');
    } else if (this.mode === 'rest') {
      // hover near the fountain while a pylon pours life into it
      tx = Math.cos(this.age / 40) * 8; tz = Math.sin(this.age / 40) * 8; ty = 72; speed = 0.4;
      if (this.modeTime > 300 || this.health >= this.maxHealth) this.setMode('circle');
    }
    // steer: turn toward the target smoothly
    const dx = tx - this.x, dy = ty - this.y, dz = tz - this.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const want = [dx / d * speed, dy / d * speed, dz / d * speed];
    const k = this.mode === 'dive' ? 0.08 : 0.04;
    this.vx += (want[0] - this.vx) * k; this.vy += (want[1] - this.vy) * k; this.vz += (want[2] - this.vz) * k;
    this.x += this.vx; this.y += this.vy; this.z += this.vz;
    if (this.y < 40) this.vy += 0.05;
    this.yaw = Math.atan2(this.vx, -this.vz);
    this.pitch = Math.atan2(this.vy, Math.hypot(this.vx, this.vz));
    // the body follows the head along its path
    this.trail.unshift([this.x, this.y, this.z]);
    this.trail.length = SEGMENTS * 3 + 2;
    for (let i = 0; i < SEGMENTS; i++) {
      const a = this.trail[(i + 1) * 3], b = this.trail[(i + 1) * 3 - 1];
      const s = this.segs[i];
      s.x = a[0]; s.y = a[1]; s.z = a[2];
      s.yaw = Math.atan2(b[0] - a[0], -(b[2] - a[2]));
      s.pitch = Math.atan2(b[1] - a[1], Math.hypot(b[0] - a[0], b[2] - a[2]));
    }
    // healing from the nearest pylon
    if (!this.healing || this.healing.removed || Math.hypot(this.healing.x - this.x, this.healing.z - this.z) > 40) {
      this.healing = null;
      if (this.age % 10 === 0) {
        let best = null, bd = 32;
        for (const e of game.entities) if (e.isPylon && !e.removed) { const dd = Math.hypot(e.x - this.x, e.y - this.y, e.z - this.z); if (dd < bd) { bd = dd; best = e; } }
        this.healing = best;
      }
    }
    if (this.healing && this.age % 10 === 0 && this.health < this.maxHealth) this.health = Math.min(this.maxHealth, this.health + 1);
    // void orbs at the player
    if (near && --this.orbTimer <= 0) {
      this.orbTimer = 100 + Math.floor(Math.random() * 120);
      if (Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z) < 64) {
        const ox = this.x, oy = this.y, oz = this.z;
        const ddx = p.x - ox, ddy = p.y + 1 - oy, ddz = p.z - oz, l = Math.hypot(ddx, ddy, ddz);
        game.entities.push(new VoidOrb(ox, oy, oz, ddx / l * 0.9, ddy / l * 0.9, ddz / l * 0.9));
        game.audio.mob('wyrm', 'idle', ox, oy, oz);
      }
    }
    // touching the head or body hurts
    if (p && !p.dead) {
      for (const b of this.hitBoxes()) {
        if (p.x + p.w > b[0] && p.x - p.w < b[3] && p.y + p.h > b[1] && p.y < b[4] && p.z + p.w > b[2] && p.z - p.w < b[5]) {
          if (p.damage(game, b === this.hitBoxes()[0] ? 8 : 4, 'mob:wyrm', this.x, this.z)) { p.vy = 0.6; }
          break;
        }
      }
    }
    // it carves through the island when it dives
    if (this.mode === 'dive' && this.age % 2 === 0) {
      const w = game.world;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const bx = Math.floor(this.x) + ox, by = Math.floor(this.y) + oy, bz = Math.floor(this.z) + oz;
        const id = w.getBlock(bx, by, bz);
        if (id && id !== B.obsidian && id !== B.bedrock && id !== B.iron_bars && SOLID[id]) w.setBlock(bx, by, bz, 0, 0);
      }
    }
    if (this.age % 60 === 0) game.audio.mob('wyrm', 'idle', this.x, this.y, this.z);
  }

  tickDeath(game) {
    this.dying++;
    this.y += 0.12;
    this.yaw += 0.05;
    if (this.dying % 2 === 0) for (let i = 0; i < 6; i++) game.particles.voidSpark(this.x + (Math.random() - 0.5) * 4, this.y + (Math.random() - 0.5) * 3, this.z + (Math.random() - 0.5) * 4);
    if (this.dying % 20 === 0) game.spawnXp(this.x, this.y, this.z, 60);
    if (this.dying >= 200) {
      this.removed = true;
      game.onWyrmDefeated();
    }
  }

  serialize() { return { kind: 'wyrm', x: this.x, y: this.y, z: this.z, health: this.health }; }
}

// The wyrm's breath: a slow orb that bursts on contact.
export class VoidOrb extends Entity {
  constructor(x, y, z, vx, vy, vz) {
    super(x, y, z, 0.3, 0.6);
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.isOrb = true;
  }
  tick(game) {
    this.savePrev();
    this.age++;
    const sp = Math.hypot(this.vx, this.vy, this.vz);
    const hit = raycast(game.world, this.x, this.y, this.z, this.vx / sp, this.vy / sp, this.vz / sp, sp);
    const p = game.player;
    const hitPlayer = p && !p.dead && Math.hypot(p.x - this.x, p.y + 1 - this.y, p.z - this.z) < 1.2;
    if (hit || hitPlayer || this.age > 200) { this.burst(game); return; }
    this.x += this.vx; this.y += this.vy; this.z += this.vz;
    if (this.age % 2 === 0) game.particles.voidSpark(this.x, this.y, this.z);
  }
  burst(game) {
    this.removed = true;
    for (let i = 0; i < 30; i++) game.particles.voidSpark(this.x + (Math.random() - 0.5) * 3, this.y + (Math.random() - 0.5) * 2, this.z + (Math.random() - 0.5) * 3);
    game.audio.play('void_burst', this.x, this.y, this.z);
    const p = game.player;
    if (p && Math.hypot(p.x - this.x, p.y + 1 - this.y, p.z - this.z) < 3) p.damage(game, 6, 'magic');
  }
}

// A thrown eye of stars: rises and drifts toward the nearest observatory.
export class StarEye extends Entity {
  constructor(x, y, z, tx, tz) {
    super(x, y, z, 0.125, 0.25);
    this.tx = tx; this.tz = tz;
    const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz) || 1;
    const go = Math.min(12, d);
    this.gx = x + dx / d * go; this.gz = z + dz / d * go;
    this.gy = y + 8;
    this.isStarEye = true;
  }
  tick(game) {
    this.savePrev();
    this.age++;
    const k = 0.06;
    this.x += (this.gx - this.x) * k; this.z += (this.gz - this.z) * k;
    this.y += (this.gy - this.y) * k * 0.8;
    if (this.age % 2 === 0) game.particles.portal(this.x, this.y, this.z);
    if (this.age > 60) {
      this.removed = true;
      if (Math.random() < 0.8) game.dropItem(this.x, this.y, this.z, { id: I.star_eye, count: 1 });
      else { game.audio.play('glass_break', this.x, this.y, this.z); for (let i = 0; i < 10; i++) game.particles.voidSpark(this.x, this.y, this.z); }
    }
  }
}
