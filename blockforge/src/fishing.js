// Fishing: a cast bobber floats, waits for a bite and is reeled in with a catch.
import { Entity, ItemEntity } from './entities.js';
import { B } from './blocks.js';
import { I, ITEMS } from './items.js';
import { moveBox } from './physics.js';

export class Bobber extends Entity {
  constructor(owner, x, y, z, vx, vy, vz) {
    super(x, y, z, 0.125, 0.25);
    this.owner = owner;
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.isBobber = true;
    this.floating = false;
    this.wait = 100 + Math.floor(Math.random() * 400);
    this.bite = 0;
    this.dip = 0;
  }

  waterTop(world) {
    const x = Math.floor(this.x), z = Math.floor(this.z);
    let y = Math.floor(this.y);
    if (world.getBlock(x, y, z) !== B.water) { if (world.getBlock(x, y - 1, z) === B.water) y--; else return null; }
    while (world.getBlock(x, y + 1, z) === B.water) y++;
    return y + 0.9;
  }

  tick(game) {
    this.savePrev();
    this.age++;
    const o = this.owner, w = game.world;
    const held = o && o.inventory && o.inventory.held;
    if (!o || o.dead || !held || held.id !== I.fishing_rod || Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z) > 32) {
      this.removed = true;
      if (o) o.fishing = null;
      return;
    }
    const top = this.waterTop(w);
    if (top !== null) {
      if (!this.floating) { this.floating = true; game.particles.splash(this.x, top, this.z, 6); game.audio.play('splash', this.x, top, this.z, 0.3); }
      const target = top - 0.15 - this.dip;
      this.vy += (target - this.y) * 0.25; this.vy *= 0.6;
      this.vx *= 0.88; this.vz *= 0.88;
      // waiting for a bite; rain helps
      const open = w.rainHeight(Math.floor(this.x), Math.floor(this.z)) <= Math.floor(top);
      if (this.bite > 0) {
        this.bite--;
        this.dip = this.bite > 12 ? 0.25 : 0.1;
        if (this.bite === 0) { this.wait = 100 + Math.floor(Math.random() * 500); this.dip = 0; }
      } else {
        this.wait -= game.rain > 0.5 && open ? 2 : 1;
        if (this.wait < 50 && this.wait > 0 && this.age % 4 === 0) {
          // a fish swims in: bubbles closing on the bobber
          const d = this.wait / 50 * 3;
          const a = this.age * 0.3;
          game.particles.bubble(this.x + Math.cos(a) * d, top - 0.1, this.z + Math.sin(a) * d);
        }
        if (this.wait <= 0) {
          this.bite = 20;
          game.particles.splash(this.x, top, this.z, 10);
          game.audio.play('fish_bite', this.x, top, this.z);
        }
      }
    } else {
      this.floating = false;
      this.vy -= 0.04;
    }
    const r = moveBox(w, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    if (this.onGround) { this.vx *= 0.5; this.vz *= 0.5; }
    this.vx *= 0.97; this.vz *= 0.97;
  }

  // Reel in. Returns how much rod durability to spend.
  reel(game) {
    this.removed = true;
    const o = this.owner;
    if (o) o.fishing = null;
    game.audio.play('fish_reel', this.x, this.y, this.z, 0.6);
    if (this.bite > 0) {
      const stack = fishLoot();
      const it = new ItemEntity(this.x, this.y + 0.2, this.z, stack);
      const dx = o.x - this.x, dy = o.y + 1 - this.y, dz = o.z - this.z;
      it.vx = dx * 0.1; it.vy = dy * 0.1 + Math.sqrt(Math.hypot(dx, dy, dz)) * 0.08; it.vz = dz * 0.1;
      game.items.push(it);
      game.spawnXp(o.x, o.y + 0.5, o.z, 1 + Math.floor(Math.random() * 6));
      game.advance('fish');
      return 1;
    }
    return this.onGround ? 2 : 0;
  }
}

function fishLoot() {
  const r = Math.random();
  if (r < 0.85) {
    const f = Math.random();
    const id = f < 0.6 ? I.raw_silverfin : f < 0.85 ? I.raw_rosefin : f < 0.98 ? I.pufferfish : I.glimmerfish;
    return { id, count: 1 };
  }
  if (r < 0.95) {
    const junk = [I.stick, I.string, I.bone, I.bowl, I.leather, I.tainted_flesh, I.leather_boots, I.glass_bottle];
    const id = junk[Math.floor(Math.random() * junk.length)];
    const s = { id, count: 1 };
    if (ITEMS[id].durability) s.dur = Math.floor(ITEMS[id].durability * (0.3 + Math.random() * 0.6));
    return s;
  }
  const treasure = [
    { id: I.bow, count: 1, ench: { power: 2, unbreaking: 1 } }, { id: I.fishing_rod, count: 1, ench: { unbreaking: 2 } },
    { id: I.emerald, count: 2 }, { id: I.diamond, count: 1 }, { id: I.golden_apple, count: 1 }, { id: I.void_pearl, count: 1 },
  ];
  return { ...treasure[Math.floor(Math.random() * treasure.length)] };
}
