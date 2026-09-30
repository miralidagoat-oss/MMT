// Entities: creatures, dropped items, falling blocks and primed blast crates.
import { moveBox, blockFriction, boxFree } from './physics.js';
import { B, SOLID, isLiquid, REPLACEABLE, BLOCKS } from './blocks.js';
import { I, maxStack } from './items.js';
import { MODELS } from './models.js';

let nextEntityId = 1;

export class Entity {
  constructor(x, y, z, w, h) {
    this.id = nextEntityId++;
    this.x = x; this.y = y; this.z = z;
    this.px = x; this.py = y; this.pz = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.w = w; this.h = h;
    this.yaw = 0; this.pyaw = 0;
    this.onGround = false; this.inWater = false; this.inLava = false; this.eyesInWater = false;
    this.fallDistance = 0;
    this.age = 0;
    this.removed = false;
    this.fire = 0;
    this.hitX = false; this.hitZ = false;
  }

  savePrev() { this.px = this.x; this.py = this.y; this.pz = this.z; this.pyaw = this.yaw; }

  checkFluids(world) {
    const x0 = Math.floor(this.x - this.w + 0.001), x1 = Math.floor(this.x + this.w - 0.001);
    const z0 = Math.floor(this.z - this.w + 0.001), z1 = Math.floor(this.z + this.w - 0.001);
    const y0 = Math.floor(this.y + 0.001), y1 = Math.floor(this.y + this.h * 0.6);
    let water = false, lava = false;
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const id = world.getBlock(x, y, z);
      if (id === B.water) water = true; else if (id === B.lava) lava = true;
    }
    this.inWater = water; this.inLava = lava;
    this.eyesInWater = world.getBlock(Math.floor(this.x), Math.floor(this.y + this.h * 0.85), Math.floor(this.z)) === B.water;
  }

  // Classic per-tick physics. ax/az is the input acceleration for this tick.
  physics(world, ax = 0, az = 0, opts = {}) {
    this.checkFluids(world);
    const gravity = opts.gravity ?? 0.08;
    if (this.inWater || this.inLava) {
      this.vx += ax * 0.2; this.vz += az * 0.2;
      const r = moveBox(world, this, this.vx, this.vy, this.vz);
      this.applyHits(r);
      const drag = this.inWater ? 0.8 : 0.5;
      this.vx *= drag; this.vz *= drag; this.vy *= drag;
      this.vy -= 0.02;
      if (this.hitX || this.hitZ) {
        if (boxFree(world, this.x + this.vx, this.y + 0.6 + this.vy, this.z + this.vz, this.w, this.h)) this.vy = 0.3;
      }
      this.fallDistance = 0;
      return r;
    }
    const f = this.onGround ? blockFriction(world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z))) * 0.91 : 0.91;
    this.vx += ax; this.vz += az;
    const r = moveBox(world, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    if (this.vy < 0 && !r.onGround) this.fallDistance -= r.dy;
    this.vy = (this.vy - gravity) * 0.98;
    if (opts.maxFall && this.vy < -opts.maxFall) this.vy = -opts.maxFall;
    this.vx *= f; this.vz *= f;
    return r;
  }

  applyHits(r) {
    this.hitX = r.hitX; this.hitZ = r.hitZ;
    if (r.hitX) this.vx = 0;
    if (r.hitZ) this.vz = 0;
    if (r.hitY) this.vy = 0;
    this.onGround = r.onGround;
  }

  lerpPos(t) {
    return [this.px + (this.x - this.px) * t, this.py + (this.y - this.py) * t, this.pz + (this.z - this.pz) * t];
  }

  intersects(x0, y0, z0, x1, y1, z1) {
    return this.x + this.w > x0 && this.x - this.w < x1 && this.y + this.h > y0 && this.y < y1 && this.z + this.w > z0 && this.z - this.w < z1;
  }
}

// ---------------------------------------------------------------------------
export const MOB_TYPES = {
  pig: { model: 'pig', health: 10, wander: 0.04, panic: 0.085, drops: (r) => [[I.raw_pork, 1 + Math.floor(r() * 3)]], sound: 'pig' },
  cow: { model: 'cow', health: 10, wander: 0.035, panic: 0.08, drops: (r) => [[I.raw_beef, 1 + Math.floor(r() * 3)], [I.leather, Math.floor(r() * 3)]], sound: 'cow' },
  sheep: { model: 'sheep', health: 8, wander: 0.038, panic: 0.085, drops: (r, m) => [[I.raw_mutton, 1 + Math.floor(r() * 2)], ...(m.sheared ? [] : [[B.white_wool, 1]])], sound: 'sheep' },
  chicken: { model: 'chicken', health: 4, wander: 0.035, panic: 0.08, drops: (r) => [[I.raw_chicken, 1], [I.feather, Math.floor(r() * 3)]], sound: 'chicken' },
  ghoul: { model: 'ghoul', health: 20, wander: 0.03, chase: 0.058, hostile: true, damage: 3, burns: true, drops: (r) => [[I.tainted_flesh, Math.floor(r() * 3)], ...(r() < 0.05 ? [[I.iron_ingot, 1]] : [])], sound: 'ghoul' },
};

export class Mob extends Entity {
  constructor(type, x, y, z) {
    const m = MODELS[MOB_TYPES[type].model];
    super(x, y, z, m.width / 2, m.height);
    this.type = type;
    this.def = MOB_TYPES[type];
    this.health = this.def.health;
    this.hurtTime = 0; this.invuln = 0; this.deathTime = 0; this.dead = false;
    this.bodyYaw = Math.random() * Math.PI * 2; this.yaw = this.bodyYaw; this.pyaw = this.yaw;
    this.headYaw = 0; this.headPitch = 0;
    this.limbSwing = 0; this.limbAmount = 0; this.pLimbAmount = 0;
    this.target = null; this.wanderTimer = 0; this.panic = 0; this.attackCooldown = 0;
    this.sheared = false; this.idleSound = 80 + Math.floor(Math.random() * 200);
    this.wingFlap = 0;
  }

  get hostile() { return !!this.def.hostile; }

  hurt(game, dmg, fromX, fromZ, source) {
    if (this.dead || this.invuln > 0) return false;
    this.health -= dmg;
    this.hurtTime = 10; this.invuln = 10;
    if (fromX !== undefined) {
      const dx = this.x - fromX, dz = this.z - fromZ, l = Math.hypot(dx, dz) || 1;
      this.vx += (dx / l) * 0.4; this.vz += (dz / l) * 0.4; this.vy = Math.max(this.vy, 0.36);
    }
    if (!this.hostile) this.panic = 60 + Math.floor(Math.random() * 40);
    if (this.hostile && source === 'player') this.target = game.player;
    game.audio.mob(this.def.sound, 'hurt', this.x, this.y, this.z);
    if (this.health <= 0) {
      this.dead = true; this.deathTime = 0;
      game.audio.mob(this.def.sound, 'death', this.x, this.y, this.z);
    }
    return true;
  }

  tick(game) {
    this.savePrev();
    this.pLimbAmount = this.limbAmount;
    this.age++;
    const world = game.world;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invuln > 0) this.invuln--;
    if (this.dead) {
      this.deathTime++;
      this.physics(world, 0, 0);
      if (this.deathTime >= 20) {
        this.removed = true;
        game.particles.poof(this.x, this.y, this.z, this.w, this.h);
        const r = Math.random;
        for (const [id, n] of this.def.drops(r, this)) if (n > 0) game.dropItem(this.x, this.y + 0.5, this.z, { id, count: n });
      }
      return;
    }

    let ax = 0, az = 0, speed = 0;
    const p = game.player;
    const pdx = p.x - this.x, pdz = p.z - this.z, pdist = Math.hypot(pdx, pdz, p.y - this.y);

    // Hostile: chase the player when close; burn in daylight.
    if (this.hostile) {
      if (this.target && (p.dead || p.creative || pdist > 40)) this.target = null;
      if (!this.target && !p.dead && !p.creative && pdist < 24 && game.canSee(this, p)) this.target = p;
      if (this.def.burns && game.isDay() && !this.inWater) {
        const light = world.getLight(Math.floor(this.x), Math.floor(this.y + this.h), Math.floor(this.z));
        if ((light >> 4) >= 15 && Math.random() < 0.3) this.fire = Math.max(this.fire, 160);
      }
    }
    if (this.fire > 0) {
      this.fire--;
      if (this.inWater) this.fire = 0;
      if (this.fire % 20 === 0) this.hurt(game, 1);
      if (Math.random() < 0.5) game.particles.flame(this.x + (Math.random() - 0.5) * this.w * 2, this.y + Math.random() * this.h, this.z + (Math.random() - 0.5) * this.w * 2);
    }
    if (this.inLava) { this.fire = 300; if (this.age % 10 === 0) this.hurt(game, 4); }

    let tx = null, tz = null;
    if (this.target) {
      tx = p.x; tz = p.z; speed = this.def.chase;
      this.headYaw = 0;
      if (pdist < 1.6 && Math.abs(p.y - this.y) < 1.5 && this.attackCooldown <= 0) {
        this.attackCooldown = 20;
        this.swing = 10;
        game.player.damage(game, this.def.damage, 'mob', this.x, this.z);
      }
    } else if (this.panic > 0) {
      this.panic--;
      if (this.wanderTimer-- <= 0 || !this.wx) {
        const a = Math.random() * Math.PI * 2;
        this.wx = this.x + Math.cos(a) * 8; this.wz = this.z + Math.sin(a) * 8; this.wanderTimer = 20;
      }
      tx = this.wx; tz = this.wz; speed = this.def.panic;
    } else {
      if (this.wanderTimer-- <= 0) {
        if (Math.random() < 0.4) {
          const a = Math.random() * Math.PI * 2, d = 3 + Math.random() * 7;
          this.wx = this.x + Math.cos(a) * d; this.wz = this.z + Math.sin(a) * d;
        } else this.wx = null;
        this.wanderTimer = 60 + Math.floor(Math.random() * 120);
      }
      if (this.wx != null) { tx = this.wx; tz = this.wz; speed = this.def.wander; }
      // passive mobs glance at a nearby player
      if (pdist < 8 && !p.dead) {
        const want = Math.atan2(pdx, -pdz) - this.bodyYaw;
        this.headYaw += (wrap(want) * 0.8 - this.headYaw) * 0.2;
        this.headPitch = Math.max(-0.6, Math.min(0.6, -Math.atan2(p.y + 1.5 - (this.y + this.h * 0.85), Math.hypot(pdx, pdz))));
      } else { this.headYaw *= 0.9; this.headPitch *= 0.9; }
    }
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.swing > 0) this.swing--;

    if (tx != null) {
      const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
      if (d > 0.6) {
        const want = Math.atan2(dx, -dz);
        this.bodyYaw += wrap(want - this.bodyYaw) * 0.3;
        ax = Math.sin(this.bodyYaw) * speed; az = -Math.cos(this.bodyYaw) * speed;
        // don't walk off ledges higher than 3 blocks unless chasing
        if (!this.target && this.onGround) {
          const fx = Math.floor(this.x + Math.sin(this.bodyYaw) * 0.8), fz = Math.floor(this.z - Math.cos(this.bodyYaw) * 0.8);
          let drop = 0;
          for (let y = Math.floor(this.y) - 1; y > Math.floor(this.y) - 5; y--) { if (SOLID[world.getBlock(fx, y, fz)] || isLiquid(world.getBlock(fx, y, fz))) break; drop++; }
          if (drop >= 3) { ax = 0; az = 0; this.wx = null; }
          if (world.getBlock(fx, Math.floor(this.y), fz) === B.lava || world.getBlock(fx, Math.floor(this.y) - 1, fz) === B.lava) { ax = 0; az = 0; this.wx = null; }
        }
      } else if (!this.target) this.wx = null;
    }
    this.yaw = this.bodyYaw;
    if (!this.onGround && !this.inWater) { ax *= 0.2; az *= 0.2; }

    const isChicken = this.type === 'chicken';
    this.physics(world, ax, az, isChicken ? { maxFall: 0.12 } : {});
    if (isChicken) this.wingFlap = this.onGround ? this.wingFlap * 0.7 : this.wingFlap + 0.6;
    // jump over obstacles
    if ((this.hitX || this.hitZ) && this.onGround && (ax || az)) this.vy = 0.42;
    // float in water
    if (this.inWater && this.eyesInWater) this.vy += 0.045;
    else if (this.inWater) this.vy += 0.02;

    // fall damage
    if (this.onGround) {
      if (this.fallDistance > 3 && !isChicken) this.hurt(game, Math.ceil(this.fallDistance - 3));
      this.fallDistance = 0;
    }
    if (this.y < -64) this.hurt(game, 100);

    // limb animation from distance moved
    const moved = Math.hypot(this.x - this.px, this.z - this.pz);
    this.limbAmount += (Math.min(1, moved * 4) - this.limbAmount) * 0.4;
    this.limbSwing += moved * 2.4;

    if (--this.idleSound <= 0) {
      this.idleSound = 120 + Math.floor(Math.random() * 300);
      if (pdist < 20) game.audio.mob(this.def.sound, 'idle', this.x, this.y, this.z);
    }
  }

  interact(game, stack) {
    if (this.type === 'sheep' && !this.sheared && stack && stack.id === I.shears) {
      this.sheared = true;
      const n = 1 + Math.floor(Math.random() * 3);
      game.dropItem(this.x, this.y + 1, this.z, { id: B.white_wool, count: n });
      game.audio.play('shear', this.x, this.y, this.z);
      return 'damage_tool';
    }
    return false;
  }
}

export const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

// ---------------------------------------------------------------------------
export class ItemEntity extends Entity {
  constructor(x, y, z, stack) {
    super(x, y, z, 0.125, 0.25);
    this.stack = stack;
    this.pickupDelay = 10;
    this.spin = Math.random() * Math.PI * 2;
    this.pickedBy = null; this.pickupTick = 0;
  }

  tick(game) {
    this.savePrev();
    this.age++;
    if (this.pickedBy) {
      this.pickupTick++;
      const p = this.pickedBy;
      const t = this.pickupTick / 3;
      this.x += (p.x - this.x) * t; this.y += (p.y + 0.8 - this.y) * t; this.z += (p.z - this.z) * t;
      if (this.pickupTick >= 3) this.removed = true;
      return;
    }
    if (this.pickupDelay > 0) this.pickupDelay--;
    const world = game.world;
    this.checkFluids(world);
    if (this.inWater) { this.vy += 0.005; this.vy *= 0.9; this.vx *= 0.95; this.vz *= 0.95; }
    else this.vy -= 0.04;
    if (this.inLava) { this.removed = true; game.particles.smoke(this.x, this.y, this.z); game.audio.play('fizz', this.x, this.y, this.z); return; }
    // push out of solid blocks
    if (SOLID[world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z))]) this.vy = 0.1;
    const r = moveBox(world, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    const f = this.onGround ? blockFriction(world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z))) * 0.98 : 0.98;
    this.vx *= f; this.vz *= f; this.vy *= 0.98;
    if (this.onGround && this.vy < 0) this.vy *= -0.5;
    if (this.age > 6000) this.removed = true;
    // merge with neighbours
    if (this.age % 10 === 0) {
      for (const o of game.items) {
        if (o === this || o.removed || o.pickedBy || o.stack.id !== this.stack.id || o.stack.dur) continue;
        if (Math.abs(o.x - this.x) > 0.6 || Math.abs(o.y - this.y) > 0.6 || Math.abs(o.z - this.z) > 0.6) continue;
        const room = maxStack(this.stack.id) - this.stack.count;
        if (room <= 0) break;
        const take = Math.min(room, o.stack.count);
        this.stack.count += take; o.stack.count -= take;
        if (o.stack.count <= 0) o.removed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
export class FallingBlock extends Entity {
  constructor(x, y, z, id, meta) {
    super(x + 0.5, y, z + 0.5, 0.49, 0.98);
    this.block = id; this.meta = meta;
  }

  tick(game) {
    this.savePrev();
    this.age++;
    const world = game.world;
    this.vy -= 0.04;
    const r = moveBox(world, this, 0, this.vy, 0);
    this.applyHits(r);
    this.vy *= 0.98;
    if (this.onGround || this.age > 600) {
      this.removed = true;
      const bx = Math.floor(this.x), by = Math.round(this.y), bz = Math.floor(this.z);
      const cur = world.getBlock(bx, by, bz);
      if ((cur === 0 || REPLACEABLE[cur]) && by < 256) {
        world.setBlock(bx, by, bz, this.block, this.meta);
        game.audio.blockSound(this.block, 'place', bx + 0.5, by + 0.5, bz + 0.5);
      } else game.dropItem(this.x, this.y + 0.5, this.z, { id: this.block, count: 1 });
    }
  }
}

// ---------------------------------------------------------------------------
export class PrimedCrate extends Entity {
  constructor(x, y, z, fuse = 80) {
    super(x + 0.5, y, z + 0.5, 0.49, 0.98);
    this.fuse = fuse;
    this.vy = 0.2;
    this.vx = (Math.random() - 0.5) * 0.04; this.vz = (Math.random() - 0.5) * 0.04;
  }

  tick(game) {
    this.savePrev();
    this.age++;
    this.physics(game.world, 0, 0, { gravity: 0.04 });
    if (Math.random() < 0.5) game.particles.smoke(this.x, this.y + 1.05, this.z);
    if (--this.fuse <= 0) {
      this.removed = true;
      game.explode(this.x, this.y + 0.5, this.z, 4);
    }
  }
}

export function isBlockEntityFree(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return id === 0 || REPLACEABLE[id] || !BLOCKS[id];
}
