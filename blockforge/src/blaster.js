// The Photon Blaster (a laser gun that runs on energy cells) and sky rockets
// (fireworks that also boost a glider in flight).
import { Entity, Projectile } from './entities.js';
import { I } from './items.js';
import { moveBox } from './physics.js';
export { laserTrail, laserImpact, laserHitBlock } from './laser.js';

export const BLASTER_CAP = 48;       // shots per energy cell
const FIRE_DELAY = 5;                // ticks between shots while held
const RELOAD_TICKS = 26;
const BOLT_SPEED = 2.6;

export const blasterCharge = (stack) => (stack.charge === undefined ? BLASTER_CAP : stack.charge);

// ---------------------------------------------------------------------------
// Sky rockets: fly up, burst into coloured sparks.
const PALETTES = [
  [[255, 70, 70], [255, 200, 80]], [[80, 200, 255], [220, 250, 255]], [[140, 255, 120], [255, 255, 160]],
  [[230, 110, 255], [120, 160, 255]], [[255, 160, 60], [255, 240, 200]], [[255, 255, 255], [255, 220, 120]],
];

export class SkyRocket extends Entity {
  constructor(x, y, z, seed = Math.random()) {
    super(x, y, z, 0.12, 0.4);
    this.isRocket = true;
    this.seed = seed;
    this.fuse = 22 + Math.floor(seed * 12);
    this.vx = (seed - 0.5) * 0.04; this.vz = (((seed * 7) % 1) - 0.5) * 0.04; this.vy = 0.25;
  }

  tick(game) {
    this.savePrev();
    this.age++;
    this.vy = Math.min(0.9, this.vy + 0.045);
    this.vx *= 1.02; this.vz *= 1.02;
    const r = moveBox(game.world, this, this.vx, this.vy, this.vz);
    if (r.hitY) this.fuse = Math.min(this.fuse, this.age);
    game.particles.rocketTrail(this.x, this.y, this.z);
    if (this.age >= this.fuse) { this.removed = true; burst(game, this.x, this.y, this.z, this.seed); }
  }
}

export function burst(game, x, y, z, seed) {
  const pal = PALETTES[Math.floor(seed * PALETTES.length) % PALETTES.length];
  const shape = Math.floor(seed * 97) % 3; // 0 ball, 1 ring, 2 star
  const n = 120;
  for (let i = 0; i < n; i++) {
    let dx, dy, dz;
    if (shape === 1) { const a = (i / n) * Math.PI * 2; dx = Math.cos(a); dy = (Math.random() - 0.5) * 0.15; dz = Math.sin(a); }
    else {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      dx = s * Math.cos(a); dy = u; dz = s * Math.sin(a);
    }
    const sp = shape === 2 ? (i % 5 === 0 ? 9 : 5) : 6 + Math.random();
    const c = pal[i % 2];
    game.particles.spark(x, y, z, dx * sp, dy * sp, dz * sp, c);
  }
  game.audio.play('firework', x, y, z);
  if (game.net) game.net.effect('fw', x, y, z, { s: Math.round(seed * 1000) / 1000 });
}

// ---------------------------------------------------------------------------
export function installBlaster(Game) {
  const methods = {
    // Called every tick from tickInteraction. Returns true when the blaster
    // used the right mouse button this tick.
    tickBlaster(held, rightDown, rightClick, interactive) {
      const p = this.player;
      if (this.blasterKick > 0) this.blasterKick = Math.max(0, this.blasterKick - 0.25);
      if (this.blasterCooldown > 0) this.blasterCooldown--;
      if (!held || held.id !== I.photon_blaster) { this.blasterReload = 0; return false; }
      if (this.blasterReload > 0) {
        this.blasterReload--;
        if (this.blasterReload === 0) {
          held.charge = BLASTER_CAP;
          this.audio.play('blaster_ready', p.x, p.y + 1.5, p.z, 0.6);
        }
        return rightDown && !interactive;
      }
      if (interactive || !(rightDown || rightClick)) return false;
      if (this.blasterCooldown > 0 && !rightClick) return true;
      if (this.blasterCooldown > 0) return true;
      const charge = blasterCharge(held);
      if (charge <= 0 && !p.creative) { this.reloadBlaster(held); return true; }
      this.fireBlaster(held);
      const rapid = held.ench && held.ench.rapid_fire ? held.ench.rapid_fire : 0;
      this.blasterCooldown = FIRE_DELAY - rapid;
      return true;
    },

    reloadBlaster(held) {
      const p = this.player;
      const i = p.inventory.slots.findIndex((s, k) => k < 36 && s && s.id === I.energy_cell);
      if (i < 0) {
        if (!this.blasterEmptyWarned || this.tickCount - this.blasterEmptyWarned > 40) {
          this.audio.play('blaster_empty', p.x, p.y + 1.5, p.z, 0.6);
          this.ui.message('The blaster is empty. Craft energy cells to recharge it.', '#9fe7ff');
          this.blasterEmptyWarned = this.tickCount;
        }
        return;
      }
      const s = p.inventory.slots[i];
      s.count--; if (s.count <= 0) p.inventory.set(i, null);
      this.blasterReload = RELOAD_TICKS;
      this.audio.play('blaster_reload', p.x, p.y + 1.5, p.z, 0.6);
      void held;
    },

    fireBlaster(held) {
      const p = this.player;
      const [ex, ey, ez] = this.eyePos();
      const [dx, dy, dz] = this.lookDir();
      // from just right of and below the eye, aimed at what the crosshair is on
      const rx = Math.cos(p.yaw), rz = Math.sin(p.yaw);
      const sx = ex + dx * 0.6 + rx * 0.22, sy = ey - 0.16 + dy * 0.6, sz = ez + dz * 0.6 + rz * 0.22;
      let tx = ex + dx * 64, ty = ey + dy * 64, tz = ez + dz * 64;
      if (this.target) { tx = ex + dx * this.target.dist; ty = ey + dy * this.target.dist; tz = ez + dz * this.target.dist; }
      let vx = tx - sx, vy = ty - sy, vz = tz - sz;
      const l = Math.hypot(vx, vy, vz) || 1;
      vx = (vx / l) * BOLT_SPEED; vy = (vy / l) * BOLT_SPEED; vz = (vz / l) * BOLT_SPEED;
      const power = held.ench && held.ench.power ? held.ench.power : 0;
      const bolt = new Projectile('laser', sx, sy, sz, vx, vy, vz, p, 5 + power * 1.25);
      bolt.pickup = false;
      this.entities.push(bolt);
      if (!p.creative) {
        const unb = held.ench && held.ench.unbreaking ? held.ench.unbreaking : 0;
        if (Math.random() >= unb / (unb + 1)) held.charge = blasterCharge(held) - 1;
      }
      this.blasterKick = 1;
      this.blasterFlash = 2;
      this.swingCount++;
      this.audio.play('laser', p.x, p.y + 1.5, p.z, 0.7);
      for (let i = 0; i < 4; i++) this.particles.laser(sx + vx * 0.1, sy + vy * 0.1, sz + vz * 0.1, 0.6);
      this.advance('blaster');
      if (blasterCharge(held) <= 0 && !p.creative) this.reloadBlaster(held);
    },

    // Right-click with a sky rocket: boost a glide, or launch it from a block.
    useRocket(held, hit) {
      const p = this.player;
      if (p.gliding) {
        p.rocketBoost = 30;
        this.audio.play('rocket', p.x, p.y, p.z, 0.8);
        if (!p.creative) p.inventory.useHeld();
        return true;
      }
      if (!hit) return true;
      const n = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][hit.face] || [0, 1, 0];
      const r = new SkyRocket(hit.x + 0.5 + n[0] * 0.6, hit.y + (n[1] > 0 ? 1.05 : 0.5 + n[1] * 0.6), hit.z + 0.5 + n[2] * 0.6, Math.random());
      this.entities.push(r);
      this.audio.play('rocket', r.x, r.y, r.z, 0.7);
      if (!p.creative) p.inventory.useHeld();
      this.startSwing();
      return true;
    },
  };
  for (const [k, v] of Object.entries(methods)) Game.prototype[k] = v;
}

export function isBlaster(id) { return id === I.photon_blaster; }
