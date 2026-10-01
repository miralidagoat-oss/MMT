// Player movement and survival stats. Movement follows the classic voxel
// sandbox feel: 20 ticks/s, ground friction, air control, sprint jumping.
import { Entity } from './entities.js';
import { moveBox, moveStep, boxFree, blockFriction, surfaceSlow } from './physics.js';
import { B, SOLID } from './blocks.js';
import { PlayerInventory } from './inventory.js';
import { ITEMS, I } from './items.js';
import { addEffect, EFFECTS } from './effects.js';

export const EYE = 1.62, EYE_SNEAK = 1.32;
const BYPASS_ARMOR = new Set(['void', 'kill', 'starve', 'drown', 'magic']);
const FIRE_SOURCES = new Set(['fire', 'lava', 'magma']);

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
    this.isPlayer = true;
    this.xpLevel = 0; this.xpPoints = 0;
    this.sleeping = 0; this.bed = null;
    this.enchantSeed = (Math.random() * 0x7fffffff) | 0;
    this.portalTicks = 0; this.portalCooldown = 0;
    this.dim = 'overworld';
    this.effects = {};
    this.absorption = 0;
    this.vehicle = null;
    this.gliding = false;
    this.blocking = false;
    this.jumpWasDown = false;
  }

  // Effect strength (0-based amplifier) or -1 when absent.
  amp(name) { return this.effects[name] ? this.effects[name].amp : -1; }

  applyPotion(game, fx, scale = 1) {
    if (!fx) return;
    if (fx.effect === 'instant_health') { this.health = Math.min(20, this.health + Math.round(4 * (1 << fx.amp) * scale)); return; }
    if (fx.effect === 'instant_damage') { this.damage(game, Math.round(6 * (1 << fx.amp) * scale), 'magic'); return; }
    addEffect(this, fx.effect, fx.amp, Math.max(20, Math.round(fx.ticks * scale)));
  }

  tickEffects(game) {
    for (const [name, e] of Object.entries(this.effects)) {
      if (!EFFECTS[name]) { delete this.effects[name]; continue; }
      if (name === 'regeneration' && this.age % Math.max(1, 50 >> e.amp) === 0 && this.health < 20) this.health = Math.min(20, this.health + 1);
      if (name === 'poison' && this.age % Math.max(1, 25 >> e.amp) === 0 && this.health > 1) this.damage(game, 1, 'magic');
      if (--e.time <= 0) {
        delete this.effects[name];
        if (name === 'absorption') this.absorption = 0;
      }
    }
    // swirling particles in the effect colours (seen in third person and by others)
    const names = Object.keys(this.effects);
    if (names.length && this.age % 6 === 0 && !(this.effects.invisibility)) {
      const c = EFFECTS[names[this.age % names.length]].color;
      game.particles.effect(this.x + (Math.random() - 0.5) * 0.6, this.y + Math.random() * 1.8, this.z + (Math.random() - 0.5) * 0.6, c, 0, 0.6, 0);
    }
  }

  // While riding: the vehicle moves us; survival still ticks.
  rideTick(game) {
    this.savePrev();
    this.age++;
    if (this.dead) return;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invuln > 0) this.invuln--;
    this.eye += (EYE - this.eye) * 0.5;
    this.sneaking = false; this.sprinting = false;
    this.fallDistance = 0;
    this.bob *= 0.6;
    this.tickEffects(game);
    if (!this.creative && !this.spectator) this.survival(game);
  }

  static xpToNext(level) { return level <= 15 ? 2 * level + 7 : level <= 30 ? 5 * level - 38 : 9 * level - 158; }

  addXp(game, n) {
    this.xpPoints += n;
    let leveled = false;
    while (this.xpPoints >= Player.xpToNext(this.xpLevel)) {
      this.xpPoints -= Player.xpToNext(this.xpLevel);
      this.xpLevel++;
      leveled = true;
    }
    game.audio.play('orb', this.x, this.y + 1, this.z, 0.5);
    if (leveled) { game.audio.play(this.xpLevel % 5 === 0 ? 'levelup_big' : 'levelup', this.x, this.y + 1, this.z); game.advance('level'); }
  }

  get xpProgress() { return this.xpPoints / Player.xpToNext(this.xpLevel); }

  // Armor points and toughness from worn pieces (slots 36-39).
  armorStats() {
    let points = 0, tough = 0, prot = 0, feather = 0;
    for (let i = 36; i < 40; i++) {
      const s = this.inventory.get(i);
      const a = s && ITEMS[s.id] && ITEMS[s.id].armor;
      if (!a) continue;
      points += a.points; tough += a.tough;
      if (s.ench) { prot += s.ench.protection || 0; feather += s.ench.feather_falling || 0; }
    }
    return { points, tough, prot, feather };
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

    this.tickEffects(game);
    this.sneaking = !!input.sneak && !this.flying && !this.gliding;
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
    const head = world.getBlock(Math.floor(this.x), Math.floor(this.y + 1), Math.floor(this.z));
    this.onLadder = feet === B.ladder || head === B.ladder || feet === B.vines || head === B.vines;

    const x0 = this.x, z0 = this.z;
    // start gliding: jump again while falling with a glider on
    const wings = this.inventory.get(37);
    const canGlide = wings && wings.id === I.glider && (wings.dur || 0) < ITEMS[I.glider].durability - 1;
    if (input.jump && !this.jumpWasDown && !this.onGround && !this.flying && !this.inWater && !this.onLadder && this.vy < 0 && canGlide) { this.gliding = true; game.advance('glider'); }
    this.jumpWasDown = !!input.jump;
    if (this.gliding && (this.onGround || this.inWater || this.flying || !canGlide)) this.gliding = false;
    const speedMul = (1 + 0.2 * (this.amp('speed') + 1)) * Math.max(0.1, 1 - 0.15 * (this.amp('slowness') + 1));
    if (this.gliding) {
      this.glide(game);
    } else if (this.flying) {
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
      acc *= speedMul;
      if (this.blocking) acc *= 0.3;
      this.vx += dirX * acc; this.vz += dirZ * acc;
      if (input.jump && this.onGround && this.jumpCooldown === 0) {
        this.vy = 0.42 + 0.1 * (this.amp('jump_boost') + 1);
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
      const slow = this.onGround ? surfaceSlow(world, this) : 1;
      const r = moveStep(world, this, this.vx * slow, this.vy, this.vz * slow, 0.6);
      this.applyHits(r);
      if (this.onLadder && (this.hitX || this.hitZ)) this.vy = 0.2;
      if (!r.onGround && r.dy < 0) this.fallDistance -= r.dy;
      if (r.onGround) {
        if (this.fallDistance > 0) this.land(game, this.fallDistance, wasOnGround);
        this.fallDistance = 0;
      }
      this.vy = (this.vy - 0.08) * 0.98;
      this.vx *= slip; this.vz *= slip;
      if (this.effects.slow_falling && this.vy < -0.06) { this.vy = -0.06; this.fallDistance = 0; }
      if (this.touching(world, B.cobweb)) { this.vy *= 0.05; this.vx *= 0.25; this.vz *= 0.25; this.fallDistance = 0; }
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

  // Glider flight: lift from forward speed, dive to gain speed, climb to trade it.
  glide(game) {
    const world = game.world;
    const cp = Math.cos(this.pitch);
    const lx = Math.sin(this.yaw) * cp, ly = Math.sin(this.pitch), lz = -Math.cos(this.yaw) * cp;
    const down = -this.pitch; // positive when looking down
    const horiz = Math.hypot(lx, lz);
    const speed = Math.hypot(this.vx, this.vz);
    let f = Math.cos(down); f = f * f;
    this.vy += -0.08 + f * 0.06;
    if (this.vy < 0 && horiz > 0) {
      const lift = this.vy * -0.1 * f;
      this.vy += lift; this.vx += lx * lift / horiz; this.vz += lz * lift / horiz;
    }
    if (down < 0 && horiz > 0) {
      const climb = speed * -Math.sin(down) * 0.04;
      this.vy += climb * 3.2; this.vx -= lx * climb / horiz; this.vz -= lz * climb / horiz;
    }
    if (horiz > 0) { this.vx += (lx / horiz * speed - this.vx) * 0.1; this.vz += (lz / horiz * speed - this.vz) * 0.1; }
    // a sky rocket pushes the glider along the look direction
    if (this.rocketBoost > 0) {
      this.rocketBoost--;
      this.vx += lx * 0.1 + (lx * 1.5 - this.vx) * 0.5;
      this.vy += ly * 0.1 + (ly * 1.5 - this.vy) * 0.5;
      this.vz += lz * 0.1 + (lz * 1.5 - this.vz) * 0.5;
      game.particles.rocketTrail(this.x - lx * 0.6, this.y + 0.6, this.z - lz * 0.6);
      if (this.rocketBoost === 29) game.advance('rocket');
    }
    this.vx *= 0.99; this.vy *= 0.98; this.vz *= 0.99;
    void ly;
    const before = Math.hypot(this.vx, this.vz);
    const r = moveBox(world, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    if ((r.hitX || r.hitZ) && before > 0.6) this.damage(game, Math.floor((before - 0.5) * 10), 'fly_into_wall');
    this.fallDistance = 0;
    if (this.age % 20 === 0 && !this.creative) {
      const w = this.inventory.get(37);
      if (w) { w.dur = (w.dur || 0) + 1; if (w.dur >= ITEMS[w.id].durability - 1) game.audio.material('cloth', 'break', this.x, this.y, this.z); }
    }
    if (r.onGround) { this.gliding = false; this.rocketBoost = 0; }
  }

  land(game, dist, wasOnGround) {
    if (wasOnGround) return;
    const under = game.world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z));
    if (under === B.farmland && dist > 0.75) {
      const fx = Math.floor(this.x), fy = Math.floor(this.y - 0.2), fz = Math.floor(this.z);
      game.world.setBlock(fx, fy, fz, B.dirt, 0);
    }
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
    if (this.eyesInWaterAt(world) && !this.effects.water_breathing) {
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
    if (this.effects.fire_resistance) this.fireTicks = 0;
    if (!this.inWater && this.touching(world, B.fire)) { this.fireTicks = Math.max(this.fireTicks, 160); if (this.age % 10 === 0) this.damage(game, 1, 'fire'); }
    if (this.inWater) this.fireTicks = 0;
    if (this.fireTicks > 0) {
      this.fireTicks--;
      if (this.fireTicks % 20 === 0) this.damage(game, 1, 'fire');
    }
    // cactus contact and hot magma rock underfoot
    if (this.touching(world, B.cactus)) this.damage(game, 1, 'cactus');
    if (this.onGround && !this.sneaking && world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.1), Math.floor(this.z)) === B.magma_rock && this.age % 10 === 0) this.damage(game, 1, 'magma');
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
    if (this.effects.fire_resistance && FIRE_SOURCES.has(source)) return false;
    // a raised shield stops hits from the front
    if (this.blocking && fromX !== undefined && (source.startsWith('mob:') || source === 'arrow' || source === 'explosion')) {
      const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const dx = fromX - this.x, dz = fromZ - this.z, l = Math.hypot(dx, dz) || 1;
      if ((dx * fx + dz * fz) / l > 0) {
        game.audio.play('shield_block', this.x, this.y + 1, this.z);
        game.damageShield(Math.ceil(amount));
        const kx = -dx / l, kz = -dz / l;
        this.vx += kx * 0.2; this.vz += kz * 0.2;
        return false;
      }
    }
    if (this.sleeping) game.wakeUp();
    const raw = amount;
    if (amount > 0 && !BYPASS_ARMOR.has(source)) {
      const a = this.armorStats();
      if (source !== 'fall' && a.points > 0) {
        amount *= 1 - Math.min(20, Math.max(a.points / 5, a.points - amount / (2 + a.tough / 4))) / 25;
        // armor wears down
        for (let i = 36; i < 40; i++) {
          const s = this.inventory.get(i);
          const d = s && ITEMS[s.id];
          if (!d || !d.armor) continue;
          const u = s.ench && s.ench.unbreaking ? s.ench.unbreaking : 0;
          if (Math.random() < 1 / (u + 1)) s.dur = (s.dur || 0) + Math.max(1, Math.floor(raw / 4));
          if (s.dur >= d.durability) { this.inventory.set(i, null); game.audio.material('metal', 'break', this.x, this.y + 1, this.z); }
        }
      }
      const epf = Math.min(20, a.prot + (source === 'fall' ? a.feather * 3 : 0));
      amount *= 1 - epf * 0.04;
    }
    if (this.absorption > 0) { const take = Math.min(this.absorption, amount); this.absorption -= take; amount -= take; }
    this.health -= amount;
    this.health = Math.round(this.health * 100) / 100;
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
      if (this.xpLevel > 0 || this.xpPoints > 0) game.spawnXp(this.x, this.y + 1, this.z, Math.min(100, this.xpLevel * 7));
      this.xpLevel = 0; this.xpPoints = 0;
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
    this.effects = {}; this.absorption = 0; this.gliding = false;
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
      effects: this.effects, absorption: this.absorption,
      xpLevel: this.xpLevel, xpPoints: this.xpPoints, enchantSeed: this.enchantSeed, bed: this.bed, dim: this.dim, worldSpawn: this.worldSpawn || null,
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
    this.xpLevel = d.xpLevel || 0; this.xpPoints = d.xpPoints || 0;
    if (d.enchantSeed) this.enchantSeed = d.enchantSeed;
    this.effects = d.effects && typeof d.effects === 'object' ? d.effects : {};
    this.absorption = d.absorption || 0;
    this.bed = d.bed || null; this.dim = d.dim || 'overworld';
    this.worldSpawn = d.worldSpawn || (d.bed ? null : d.spawn) || null;
    this.dead = false;
    if (d.dead || this.health <= 0) this.health = 20;
  }

  isSolidAbove(world) { return SOLID[world.getBlock(Math.floor(this.x), Math.floor(this.y + this.h + 0.1), Math.floor(this.z))]; }
}
