// Player movement and survival stats. Movement follows the classic voxel
// sandbox feel: 20 ticks/s, ground friction, air control, sprint jumping.
import { Entity } from './entities.js';
import { moveBox, boxFree, blockFriction } from './physics.js';
import { B, SOLID } from './blocks.js';
import { PlayerInventory } from './inventory.js';
import { ITEMS } from './items.js';

export const EYE = 1.62, EYE_SNEAK = 1.32;

export class Player extends Entity {
  constructor(x, y, z) {
    super(x, y, z, 0.3, 1.8);
    this.pitch = 0; this.ppitch = 0;
    this.inventory = new PlayerInventory();
    this.health = 20; this.food = 20; this.saturation = 5; this.exhaustion = 0;
    this.air = 300;
    this.hurtTime = 0; this.invuln = 0;
    this.dead = false;
    this.mode = 'survival';
    this.flying = false;
    this.sneaking = false; this.sprinting = false;
    this.eye = EYE; this.peye = EYE;
    this.walkDist = 0; this.pWalkDist = 0; this.bob = 0; this.pbob = 0;
    this.spawn = null;
    this.onLadder = false;
    this.regenTimer = 0; this.starveTimer = 0;
    this.eating = 0;
    this.lastDamageSource = '';
    this.jumpCooldown = 0;
    this.stepDist = 0;
    this.sprintJumped = false;
    this.fireTicks = 0;
    this.hurtDir = 0;
  }

  get creative() { return this.mode === 'creative'; }
  get spectator() { return this.mode === 'spectator'; }

  savePrev() {
    super.savePrev();
    this.ppitch = this.pitch; this.peye = this.eye;
    this.pWalkDist = this.walkDist; this.pbob = this.bob;
  }

  addExhaustion(v) { if (!this.creative) this.exhaustion = Math.min(40, this.exhaustion + v); }

  // input: { forward, strafe, jump, sneak, sprint }
  tick(game, input) {
    this.savePrev();
    this.age++;
    if (this.dead) return;
    const world = game.world;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invuln > 0) this.invuln--;
    if (this.jumpCooldown > 0) this.jumpCooldown--;

    this.sneaking = !!input.sneak && !this.flying;
    const targetEye = this.sneaking ? EYE_SNEAK : EYE;
    this.eye += (targetEye - this.eye) * 0.5;

    // Sprint rules
    const canSprint = this.creative || this.food > 6;
    if (input.sprint && input.forward > 0 && canSprint && !this.sneaking && !this.eating) this.sprinting = true;
    if (input.forward <= 0 || this.sneaking || !canSprint || this.hitX || this.hitZ) this.sprinting = false;

    let fwd = input.forward, str = input.strafe;
    const len = Math.hypot(fwd, str);
    if (len > 1) { fwd /= len; str /= len; }
    fwd *= 0.98; str *= 0.98;
    if (this.sneaking) { fwd *= 0.3; str *= 0.3; }
    if (this.eating) { fwd *= 0.2; str *= 0.2; }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const dirX = str * cy + fwd * sy, dirZ = str * sy - fwd * cy;

    this.checkFluids(world);
    const feet = world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z));
    this.onLadder = feet === B.ladder || world.getBlock(Math.floor(this.x), Math.floor(this.y + 1), Math.floor(this.z)) === B.ladder;

    const x0 = this.x, z0 = this.z;
    if (this.flying) {
      const acc = input.sprint ? 0.1 : 0.05;
      this.vx += dirX * acc; this.vz += dirZ * acc;
      if (input.jump) this.vy += 0.15;
      if (input.sneak) this.vy -= 0.15;
      const r = moveBox(world, this, this.vx, this.vy, this.vz);
      this.applyHits(r);
      if (r.onGround && this.mode !== 'spectator' && !this.creative) this.flying = false;
      if (r.onGround && this.creative) this.flying = false;
      this.vy *= 0.6; this.vx *= 0.91; this.vz *= 0.91;
      this.sprinting = input.sprint && input.forward > 0;
      this.fallDistance = 0;
    } else if (this.inWater || this.inLava) {
      const acc = 0.02;
      this.vx += dirX * acc; this.vz += dirZ * acc;
      if (input.jump) this.vy += 0.04;
      else if (input.sneak) this.vy -= 0.02;
      const r = moveBox(world, this, this.vx, this.vy, this.vz);
      this.applyHits(r);
      const drag = this.inWater ? 0.8 : 0.5;
      this.vx *= drag; this.vy *= drag; this.vz *= drag;
      this.vy -= 0.02;
      // climb out onto a ledge
      if ((this.hitX || this.hitZ) && boxFree(world, this.x + this.vx, this.y + 0.6 + this.vy, this.z + this.vz, this.w, this.h)) this.vy = 0.3;
      this.fallDistance = 0;
    } else {
      const below = world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z));
      const slip = this.onGround ? blockFriction(below) * 0.91 : 0.91;
      let acc;
      if (this.onGround) acc = (this.sprinting ? 0.13 : 0.1) * (0.16277136 / (slip * slip * slip));
      else acc = this.sprinting ? 0.026 : 0.02;
      this.vx += dirX * acc; this.vz += dirZ * acc;
      if (input.jump && this.onGround && this.jumpCooldown === 0) {
        this.vy = 0.42;
        this.jumpCooldown = 10;
        if (this.sprinting) {
          this.vx += sy * 0.2; this.vz -= cy * 0.2;
          this.addExhaustion(0.2);
        } else this.addExhaustion(0.05);
      }
      if (this.onLadder) {
        this.vx = Math.max(-0.15, Math.min(0.15, this.vx));
        this.vz = Math.max(-0.15, Math.min(0.15, this.vz));
        this.fallDistance = 0;
        if (this.vy < -0.15) this.vy = -0.15;
        if (this.sneaking && this.vy < 0) this.vy = 0;
      }
      let mx = this.vx, mz = this.vz;
      // sneaking keeps you from walking off edges
      if (this.sneaking && this.onGround) {
        const step = 0.05;
        const free = (dx, dz) => boxFree(world, this.x + dx, this.y - 1.0, this.z + dz, this.w, 1.0);
        while (mx !== 0 && free(mx, 0)) mx = Math.abs(mx) < step ? 0 : mx - Math.sign(mx) * step;
        while (mz !== 0 && free(0, mz)) mz = Math.abs(mz) < step ? 0 : mz - Math.sign(mz) * step;
        while (mx !== 0 && mz !== 0 && free(mx, mz)) {
          mx = Math.abs(mx) < step ? 0 : mx - Math.sign(mx) * step;
          mz = Math.abs(mz) < step ? 0 : mz - Math.sign(mz) * step;
        }
        this.vx = mx; this.vz = mz;
      }
      const wasOnGround = this.onGround;
      const r = moveBox(world, this, this.vx, this.vy, this.vz);
      this.applyHits(r);
      if (this.onLadder && (this.hitX || this.hitZ)) this.vy = 0.2;
      if (!r.onGround && r.dy < 0) this.fallDistance -= r.dy;
      if (r.onGround) {
        if (this.fallDistance > 0) this.land(game, this.fallDistance, wasOnGround);
        this.fallDistance = 0;
      }
      this.vy = (this.vy - 0.08) * 0.98;
      this.vx *= slip; this.vz *= slip;
    }

    // Walking bookkeeping for footsteps and camera bob.
    const moved = Math.hypot(this.x - x0, this.z - z0);
    if (this.onGround || this.onLadder) {
      this.walkDist += moved * 0.6;
      this.stepDist += moved;
      if (this.stepDist > (this.sprinting ? 1.9 : 1.6) && !this.sneaking) {
        this.stepDist = 0;
        const under = world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z));
        if (under) game.audio.blockSound(under, 'step', this.x, this.y, this.z);
      }
      if (this.sprinting) {
        this.addExhaustion(moved * 0.1);
        if (Math.random() < 0.4) game.sprintParticles(this);
      }
    } else if (this.inWater && moved > 0.01 && this.age % 12 === 0) game.audio.play('swim', this.x, this.y, this.z, 0.6);
    const hs = Math.min(0.1, Math.hypot(this.vx, this.vz));
    this.bob += ((this.onGround && !this.flying ? hs : 0) - this.bob) * 0.4;

    if (!this.creative && !this.spectator) this.survival(game);
    else { this.health = 20; this.air = 300; this.fireTicks = 0; }
    if (this.y < -64) this.damage(game, 4, 'void');
  }

  land(game, dist, wasOnGround) {
    if (wasOnGround) return;
    const under = game.world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z));
    if (dist > 3 && !this.creative) {
      this.damage(game, Math.ceil(dist - 3), 'fall');
      game.audio.play('land', this.x, this.y, this.z, Math.min(1, dist / 10));
    }
    if (dist > 1.5 && under) {
      game.audio.blockSound(under, 'step', this.x, this.y, this.z);
      game.landParticles(this, under, Math.min(30, Math.floor(dist * 3)));
    }
  }

  survival(game) {
    const world = game.world;
    // air
    if (this.eyesInWaterAt(world)) {
      this.air--;
      if (this.air <= -20) {
        this.air = 0;
        this.damage(game, 2, 'drown');
        for (let i = 0; i < 6; i++) game.particles.bubble(this.x + (Math.random() - 0.5) * 0.6, this.y + this.eye, this.z + (Math.random() - 0.5) * 0.6);
      }
    } else if (this.air < 300) this.air = Math.min(300, this.air + 4);

    // hunger
    if (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.food = Math.max(0, this.food - 1);
    }
    if (this.food >= 18 && this.health < 20) {
      if (++this.regenTimer >= (this.food >= 20 && this.saturation > 0 ? 10 : 80)) {
        this.regenTimer = 0;
        this.health = Math.min(20, this.health + 1);
        this.addExhaustion(6);
      }
    } else if (this.food <= 0) {
      if (++this.starveTimer >= 80) {
        this.starveTimer = 0;
        if (this.health > 1) this.damage(game, 1, 'starve');
      }
    } else { this.regenTimer = 0; this.starveTimer = 0; }

    // fire and lava
    if (this.inLava) { this.fireTicks = 300; if (this.age % 10 === 0) this.damage(game, 4, 'lava'); }
    if (this.inWater) this.fireTicks = 0;
    if (this.fireTicks > 0) {
      this.fireTicks--;
      if (this.fireTicks % 20 === 0) this.damage(game, 1, 'fire');
    }
    // cactus contact
    if (this.touching(world, B.cactus)) this.damage(game, 1, 'cactus');
  }

  eyesInWaterAt(world) {
    return world.getBlock(Math.floor(this.x), Math.floor(this.y + this.eye), Math.floor(this.z)) === B.water;
  }

  touching(world, id) {
    const e = 0.02;
    for (let y = Math.floor(this.y - e); y <= Math.floor(this.y + this.h); y++)
      for (let z = Math.floor(this.z - this.w - e); z <= Math.floor(this.z + this.w + e); z++)
        for (let x = Math.floor(this.x - this.w - e); x <= Math.floor(this.x + this.w + e); x++)
          if (world.getBlock(x, y, z) === id) return true;
    return false;
  }

  damage(game, amount, source, fromX, fromZ) {
    if (this.dead || this.creative || this.spectator) {
      if (source !== 'kill') return false;
    }
    if (this.invuln > 0 && source !== 'kill' && source !== 'void') return false;
    this.health -= amount;
    this.hurtTime = 10; this.invuln = 10;
    this.lastDamageSource = source;
    this.addExhaustion(0.1);
    if (fromX !== undefined) {
      const dx = this.x - fromX, dz = this.z - fromZ, l = Math.hypot(dx, dz) || 1;
      this.vx += (dx / l) * 0.4; this.vz += (dz / l) * 0.4; this.vy = Math.max(this.vy, 0.35);
      this.hurtDir = Math.atan2(dz, dx);
    }
    game.audio.play('hurt');
    if (this.health <= 0) { this.health = 0; this.die(game); }
    return true;
  }

  die(game) {
    this.dead = true;
    this.eating = 0;
    if (!game.keepInventory) {
      const inv = this.inventory;
      for (let i = 0; i < inv.size; i++) {
        const s = inv.get(i);
        if (s) {
          const it = game.dropItem(this.x, this.y + 1, this.z, s);
          it.vx = (Math.random() - 0.5) * 0.4; it.vz = (Math.random() - 0.5) * 0.4; it.vy = 0.2 + Math.random() * 0.2;
          inv.set(i, null);
        }
      }
    }
    game.onPlayerDeath();
  }

  respawn(x, y, z) {
    this.x = this.px = x; this.y = this.py = y; this.z = this.pz = z;
    this.vx = this.vy = this.vz = 0;
    this.health = 20; this.food = 20; this.saturation = 5; this.exhaustion = 0; this.air = 300;
    this.dead = false; this.fallDistance = 0; this.fireTicks = 0; this.hurtTime = 0;
  }

  eat(stack) {
    const f = ITEMS[stack.id].food;
    this.food = Math.min(20, this.food + f[0]);
    this.saturation = Math.min(this.food, this.saturation + f[1]);
  }

  toJSON() {
    return {
      x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch,
      health: this.health, food: this.food, saturation: this.saturation, exhaustion: this.exhaustion, air: this.air,
      mode: this.mode, flying: this.flying, spawn: this.spawn,
      inventory: this.inventory.toJSON(), selected: this.inventory.selected, dead: this.dead,
    };
  }

  load(d) {
    Object.assign(this, {
      x: d.x, y: d.y, z: d.z, px: d.x, py: d.y, pz: d.z, yaw: d.yaw || 0, pitch: d.pitch || 0,
      health: d.health ?? 20, food: d.food ?? 20, saturation: d.saturation ?? 5, exhaustion: d.exhaustion ?? 0,
      air: d.air ?? 300, mode: d.mode || 'survival', flying: !!d.flying, spawn: d.spawn || null,
    });
    this.inventory.load(d.inventory);
    this.inventory.selected = d.selected || 0;
    this.dead = false;
    if (d.dead || this.health <= 0) this.health = 20;
  }

  isSolidAbove(world) { return SOLID[world.getBlock(Math.floor(this.x), Math.floor(this.y + this.h + 0.1), Math.floor(this.z))]; }
}
