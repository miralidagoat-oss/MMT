// Entities: creatures, settlers, projectiles, experience orbs, dropped items,
// falling blocks and primed blast crates.
import { moveBox, moveStep, blockFriction, boxFree, raycast, rayBox, surfaceSlow } from './physics.js';
import { B, SOLID, isLiquid, REPLACEABLE, BLOCKS } from './blocks.js';
import { I, ITEMS, maxStack } from './items.js';
import { MODELS } from './models.js';
import { potionEffect, addEffect, EFFECTS } from './effects.js';

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
      if ((this.hitX || this.hitZ) && boxFree(world, this.x + this.vx, this.y + 0.6 + this.vy, this.z + this.vz, this.w, this.h)) this.vy = 0.3;
      this.fallDistance = 0;
      return r;
    }
    const f = this.onGround ? blockFriction(world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z))) * 0.91 : 0.91;
    this.vx += ax; this.vz += az;
    const slow = this.onGround ? surfaceSlow(world, this) : 1;
    const r = moveStep(world, this, this.vx * slow, this.vy, this.vz * slow, opts.step ?? 0.6);
    this.applyHits(r);
    if (opts.climb && (this.hitX || this.hitZ)) { this.vy = 0.2; this.fallDistance = 0; }
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
const pick = (r, n) => Math.floor(r() * n);
export const MOB_TYPES = {
  pig: { model: 'pig', health: 10, wander: 0.04, panic: 0.085, food: [I.carrot, I.potato], xp: 2, drops: (r) => [[I.raw_pork, 1 + pick(r, 3)]], sound: 'pig' },
  cow: { model: 'cow', health: 10, wander: 0.035, panic: 0.08, food: [I.wheat], xp: 2, drops: (r) => [[I.raw_beef, 1 + pick(r, 3)], [I.leather, pick(r, 3)]], sound: 'cow' },
  sheep: { model: 'sheep', health: 8, wander: 0.038, panic: 0.085, food: [I.wheat], xp: 2, drops: (r, m) => [[I.raw_mutton, 1 + pick(r, 2)], ...(m.sheared ? [] : [[B.white_wool, 1]])], sound: 'sheep' },
  chicken: { model: 'chicken', health: 4, wander: 0.035, panic: 0.08, food: [I.wheat_seeds], xp: 1, drops: (r) => [[I.raw_chicken, 1], [I.feather, pick(r, 3)]], sound: 'chicken' },
  settler: { model: 'settler', health: 20, wander: 0.03, panic: 0.07, xp: 0, drops: () => [], sound: 'settler', villager: true },
  ghoul: { model: 'ghoul', health: 20, wander: 0.03, chase: 0.058, hostile: true, damage: 3, burns: true, xp: 5, drops: (r) => [[I.tainted_flesh, pick(r, 3)], ...(r() < 0.04 ? [[I.iron_ingot, 1]] : []), ...(r() < 0.03 ? [[I.carrot, 1]] : [])], sound: 'ghoul' },
  archer: { model: 'archer', health: 20, wander: 0.03, chase: 0.05, hostile: true, ranged: true, damage: 2, burns: true, xp: 5, drops: (r) => [[I.bone, pick(r, 3)], [I.arrow, pick(r, 3)]], sound: 'archer' },
  crawler: { model: 'crawler', health: 16, wander: 0.035, chase: 0.07, hostile: true, nightOnly: true, climb: true, damage: 2, xp: 5, drops: (r) => [[I.string, pick(r, 3)]], sound: 'crawler' },
  imp: { model: 'imp', health: 14, wander: 0.04, chase: 0.072, hostile: true, fireproof: true, ignites: true, damage: 3, xp: 6, drops: (r) => [[I.ember_dust, pick(r, 3)], [I.gold_nugget, pick(r, 2)], ...(r() < 0.3 ? [[I.imp_horn, 1]] : [])], sound: 'imp' },
  gloamer: { model: 'gloamer', health: 40, wander: 0.03, chase: 0.1, hostile: true, neutral: true, teleports: true, damage: 6, xp: 5, drops: (r) => (r() < 0.5 ? [[I.void_pearl, 1]] : []), sound: 'gloamer' },
};
// Creatures that are harmed by healing and healed by harming.
export const UNDEAD = new Set(['ghoul', 'archer']);

export const BABY_AGE = -24000;

export class Mob extends Entity {
  constructor(type, x, y, z, opts = {}) {
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
    this.growth = opts.baby ? BABY_AGE : 0;
    this.love = 0; this.breedCooldown = 0;
    this.eggTimer = 6000 + Math.floor(Math.random() * 6000);
    this.profession = opts.profession || null;
    this.home = opts.home || (this.def.villager ? { x, y, z } : null);
    this.trades = opts.trades || null;
    this.armor = opts.armor || null; // [helmet, chest, legs, boots] item ids
    this.aim = 0;
    this.lastHitBy = null;
    this.leapCooldown = 0;
    if (this.baby) this.resize();
  }

  get hostile() { return !!this.def.hostile; }
  get isMob() { return true; }
  get targetable() { return !this.dead; }
  hitBoxes() { return [[this.x - this.w, this.y, this.z - this.w, this.x + this.w, this.y + this.h, this.z + this.w]]; }

  // Blink to a random spot nearby (gloamers).
  teleport(game) {
    const w = game.world;
    for (let i = 0; i < 16; i++) {
      const x = Math.floor(this.x + (Math.random() - 0.5) * 32), z = Math.floor(this.z + (Math.random() - 0.5) * 32);
      let y = Math.floor(this.y + (Math.random() - 0.5) * 16);
      while (y > 1 && !SOLID[w.getBlock(x, y - 1, z)]) y--;
      if (!SOLID[w.getBlock(x, y - 1, z)] || isLiquid(w.getBlock(x, y, z))) continue;
      if (!boxFree(w, x + 0.5, y, z + 0.5, this.w, this.h)) continue;
      for (let k = 0; k < 16; k++) game.particles.portal(this.x + (Math.random() - 0.5), this.y + Math.random() * this.h, this.z + (Math.random() - 0.5));
      this.x = this.px = x + 0.5; this.y = this.py = y; this.z = this.pz = z + 0.5;
      this.vx = this.vy = this.vz = 0;
      game.audio.play('teleport', this.x, this.y, this.z);
      return true;
    }
    return false;
  }
  get baby() { return this.growth < 0; }

  resize() {
    const m = MODELS[this.def.model];
    const s = this.baby ? 0.5 : 1;
    this.w = (m.width / 2) * s; this.h = m.height * s;
  }

  hurt(game, dmg, fromX, fromZ, source) {
    if (this.dead || this.invuln > 0) return false;
    if (this.def.fireproof && (source === 'fire' || source === 'lava')) return false;
    if (this.def.teleports && (source === 'arrow_player' || source === 'arrow') && this.teleport(game)) return false;
    if (this.def.neutral && (source === 'player' || source === 'arrow_player')) this.angry = 600;
    this.health -= dmg;
    this.hurtTime = 10; this.invuln = 10;
    this.lastHitBy = source;
    if (fromX !== undefined) {
      const dx = this.x - fromX, dz = this.z - fromZ, l = Math.hypot(dx, dz) || 1;
      this.vx += (dx / l) * 0.4; this.vz += (dz / l) * 0.4; this.vy = Math.max(this.vy, 0.36);
    }
    if (!this.hostile) { this.panic = 60 + Math.floor(Math.random() * 40); this.love = 0; }
    if (this.hostile && source === 'player') this.target = game.player;
    game.audio.mob(this.def.sound, 'hurt', this.x, this.y, this.z);
    if (this.health <= 0) {
      this.dead = true; this.deathTime = 0;
      game.audio.mob(this.def.sound, 'death', this.x, this.y, this.z);
    } else if (this.def.teleports && Math.random() < 0.4) this.teleport(game);
    return true;
  }

  // Potion effects on creatures: instant ones, poison and slowness.
  applyPotion(game, fx, scale = 1) {
    if (!fx) return;
    const undead = UNDEAD.has(this.type);
    if (fx.effect === 'instant_health' || fx.effect === 'instant_damage') {
      const amt = Math.round(6 * (1 << fx.amp) * scale);
      const harm = (fx.effect === 'instant_damage') !== undead;
      if (harm) this.hurt(game, amt, undefined, undefined, 'magic');
      else this.health = Math.min(this.def.health, this.health + amt * 0.67);
      return;
    }
    if (fx.effect === 'poison' && undead) return;
    addEffect(this, fx.effect, fx.amp, Math.round(fx.ticks * scale));
  }

  // Can this hostile see (and so target) the player right now?
  wantsTarget(game, p, pdist) {
    if (p.dead || p.creative || p.spectator || pdist > 20) return false;
    if (this.def.neutral && !(this.angry > 0)) return false;
    if (p.effects && p.effects.invisibility && pdist > 3) return false;
    if (this.def.nightOnly && this.lastHitBy !== 'player') {
      const l = game.world.getLight(Math.floor(this.x), Math.floor(this.y + 0.5), Math.floor(this.z));
      if (game.isDay() && (l >> 4) > 9) return false;
    }
    return game.canSee(this, p);
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
        if (!this.baby) {
          const r = Math.random;
          for (const [id, n] of this.def.drops(r, this)) if (n > 0) game.dropItem(this.x, this.y + 0.5, this.z, { id, count: n });
          if (this.lastHitBy === 'player' && this.def.xp) game.spawnXp(this.x, this.y + 0.5, this.z, this.def.xp + Math.floor(Math.random() * 3));
        }
        game.onMobKilled(this);
      }
      return;
    }
    if (this.growth < 0) { this.growth++; if (this.growth === 0) this.resize(); }
    if (this.angry > 0) this.angry--;
    if (this.effects) {
      for (const [name, e] of Object.entries(this.effects)) {
        if (name === 'poison' && this.age % Math.max(1, 25 >> e.amp) === 0 && this.health > 1) this.hurt(game, 1, undefined, undefined, 'magic');
        if (name === 'regeneration' && this.age % Math.max(1, 50 >> e.amp) === 0) this.health = Math.min(this.def.health, this.health + 1);
        if (--e.time <= 0) delete this.effects[name];
      }
    }
    // gloamers hate water
    if (this.def.teleports && (this.inWater || (game.rain > 0.5 && game.dim === 'overworld' && world.rainHeight(Math.floor(this.x), Math.floor(this.z)) < this.y))) {
      if (this.age % 20 === 0) { this.hurt(game, 1, undefined, undefined, 'drown'); this.teleport(game); }
    }
    if (this.love > 0) {
      this.love--;
      if (this.age % 10 === 0) game.particles.heart(this.x, this.y + this.h + 0.2, this.z);
    }
    if (this.breedCooldown > 0) this.breedCooldown--;

    let ax = 0, az = 0, speed = 0;
    const p = game.player;
    const pdx = p.x - this.x, pdz = p.z - this.z, pdist = Math.hypot(pdx, pdz, p.y - this.y);

    if (this.hostile) {
      if (this.target && (p.dead || p.creative || p.spectator || pdist > 40)) this.target = null;
      if (!this.target && this.wantsTarget(game, p, pdist)) this.target = p;
      if (this.target && this.def.nightOnly && this.lastHitBy !== 'player' && game.isDay() && Math.random() < 0.01) this.target = null;
      if (this.def.burns && game.isDay() && !this.inWater && !(this.armor && this.armor[0])) {
        const light = world.getLight(Math.floor(this.x), Math.floor(this.y + this.h), Math.floor(this.z));
        if ((light >> 4) >= 15 && Math.random() < 0.3) this.fire = Math.max(this.fire, 160);
      }
    }
    if (this.fire > 0) {
      this.fire--;
      if (this.inWater || this.def.fireproof) this.fire = 0;
      if (this.fire % 20 === 0) this.hurt(game, 1, undefined, undefined, 'fire');
      if (Math.random() < 0.5) game.particles.flame(this.x + (Math.random() - 0.5) * this.w * 2, this.y + Math.random() * this.h, this.z + (Math.random() - 0.5) * this.w * 2);
    }
    if (this.inLava && !this.def.fireproof) { this.fire = 300; if (this.age % 10 === 0) this.hurt(game, 4, undefined, undefined, 'lava'); }

    let tx = null, tz = null;
    const lookAt = (x, y, z, turnBody = false) => {
      const dx = x - this.x, dz = z - this.z;
      const want = Math.atan2(dx, -dz);
      if (turnBody) { this.bodyYaw += wrap(want - this.bodyYaw) * 0.5; this.headYaw = 0; }
      else this.headYaw += (Math.max(-1.2, Math.min(1.2, wrap(want - this.bodyYaw))) - this.headYaw) * 0.25;
      this.headPitch = Math.max(-0.7, Math.min(0.7, -Math.atan2(y - (this.y + this.h * 0.85), Math.hypot(dx, dz))));
    };

    if (this.target && this.def.ranged) {
      // keep a middle distance and shoot
      const d = Math.hypot(pdx, pdz);
      const see = game.canSee(this, p);
      lookAt(p.x, p.y + 1.5, p.z, true);
      if (d > 11 || !see) { tx = p.x; tz = p.z; speed = this.def.chase; }
      else if (d < 5) { tx = this.x - pdx; tz = this.z - pdz; speed = this.def.chase; }
      else { const s = Math.sin(this.age / 30) > 0 ? 1 : -1; tx = this.x - pdz * s; tz = this.z + pdx * s; speed = this.def.wander; }
      if (see && d < 16) {
        this.aim++;
        if (this.aim >= 30 && this.attackCooldown <= 0) {
          this.attackCooldown = 20 + Math.floor(Math.random() * 20);
          this.aim = 0;
          game.shootArrow(this, p.x, p.y + p.h * 0.6, p.z, 1.6, 6);
        }
      } else this.aim = 0;
    } else if (this.target) {
      tx = p.x; tz = p.z; speed = this.def.chase;
      lookAt(p.x, p.y + 1.5, p.z, false);
      if (this.def.climb && pdist < 3.5 && pdist > 1.2 && this.onGround && this.leapCooldown <= 0) {
        const l = Math.hypot(pdx, pdz) || 1;
        this.vx += (pdx / l) * 0.35; this.vz += (pdz / l) * 0.35; this.vy = 0.36;
        this.leapCooldown = 30;
      }
      const reach = this.def.climb ? 1.8 : 1.6;
      if (pdist < reach && Math.abs(p.y - this.y) < 1.5 && this.attackCooldown <= 0) {
        this.attackCooldown = 20;
        this.swing = 10;
        if (game.player.damage(game, this.def.damage, 'mob:' + this.type, this.x, this.z) && this.def.ignites) game.player.fireTicks = Math.max(game.player.fireTicks, 80);
      }
    } else if (this.panic > 0) {
      this.panic--;
      if (this.wanderTimer-- <= 0 || this.wx == null) {
        const a = Math.random() * Math.PI * 2;
        this.wx = this.x + Math.cos(a) * 8; this.wz = this.z + Math.sin(a) * 8; this.wanderTimer = 20;
      }
      tx = this.wx; tz = this.wz; speed = this.def.panic;
    } else {
      // breeding partners walk to each other
      let mate = null;
      if (this.love > 0 && !this.baby) {
        for (const e of game.entities) {
          if (e !== this && e instanceof Mob && e.type === this.type && e.love > 0 && !e.baby && !e.dead && Math.hypot(e.x - this.x, e.z - this.z) < 8) { mate = e; break; }
        }
      }
      if (mate) {
        tx = mate.x; tz = mate.z; speed = this.def.wander * 1.4;
        if (Math.hypot(mate.x - this.x, mate.z - this.z) < 1.4) game.breed(this, mate);
      } else if (this.def.villager) {
        this.villagerAI(game, p, pdist);
        if (this.wx != null) { tx = this.wx; tz = this.wz; speed = this.def.wander; }
      } else {
        // tempted by food held nearby
        const held = p.inventory.held;
        if (this.def.food && held && this.def.food.includes(held.id) && pdist < 8 && !p.dead) {
          tx = p.x; tz = p.z; speed = this.def.wander * 1.2;
          if (Math.hypot(pdx, pdz) < 2) { tx = null; }
          lookAt(p.x, p.y + 1.5, p.z);
        } else {
          if (this.wanderTimer-- <= 0) {
            if (Math.random() < 0.4) {
              const a = Math.random() * Math.PI * 2, d = 3 + Math.random() * 7;
              this.wx = this.x + Math.cos(a) * d; this.wz = this.z + Math.sin(a) * d;
            } else this.wx = null;
            this.wanderTimer = 60 + Math.floor(Math.random() * 120);
          }
          if (this.wx != null) { tx = this.wx; tz = this.wz; speed = this.def.wander * (this.baby ? 1.3 : 1); }
          if (pdist < 8 && !p.dead) lookAt(p.x, p.y + 1.5, p.z);
          else { this.headYaw *= 0.9; this.headPitch *= 0.9; }
        }
      }
    }
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.leapCooldown > 0) this.leapCooldown--;
    if (this.swing > 0) this.swing--;

    if (tx != null) {
      const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
      if (d > 0.6) {
        const want = Math.atan2(dx, -dz);
        if (!(this.target && this.def.ranged)) this.bodyYaw += wrap(want - this.bodyYaw) * 0.3;
        const mv = this.target && this.def.ranged ? want : this.bodyYaw;
        ax = Math.sin(mv) * speed; az = -Math.cos(mv) * speed;
        // don't walk off ledges higher than 3 blocks unless chasing
        if (!this.target && this.onGround) {
          const fx = Math.floor(this.x + Math.sin(mv) * 0.8), fz = Math.floor(this.z - Math.cos(mv) * 0.8);
          let drop = 0;
          for (let y = Math.floor(this.y) - 1; y > Math.floor(this.y) - 5; y--) { const id = world.getBlock(fx, y, fz); if (SOLID[id] || isLiquid(id)) break; drop++; }
          const ahead = world.getBlock(fx, Math.floor(this.y), fz), below = world.getBlock(fx, Math.floor(this.y) - 1, fz);
          if (drop >= 3 || ahead === B.lava || below === B.lava || (below === B.magma_rock && !this.def.fireproof)) { ax = 0; az = 0; this.wx = null; }
        }
      } else if (!this.target) this.wx = null;
    }
    this.yaw = this.bodyYaw;
    if (!this.onGround && !this.inWater) { ax *= 0.2; az *= 0.2; }
    if (this.effects && this.effects.slowness) { const f = Math.max(0, 1 - 0.15 * (this.effects.slowness.amp + 1)); ax *= f; az *= f; }

    const isChicken = this.type === 'chicken';
    this.physics(world, ax, az, { maxFall: isChicken ? 0.12 : 0, climb: this.def.climb && this.target });
    if (isChicken) {
      this.wingFlap = this.onGround ? this.wingFlap * 0.7 : this.wingFlap + 0.6;
      if (!this.baby && --this.eggTimer <= 0) {
        this.eggTimer = 6000 + Math.floor(Math.random() * 6000);
        game.dropItem(this.x, this.y + 0.3, this.z, { id: I.egg, count: 1 });
        game.audio.play('pop', this.x, this.y, this.z, 0.5);
      }
    }
    // jump over obstacles (step assist handles half blocks)
    if ((this.hitX || this.hitZ) && this.onGround && (ax || az) && !this.def.climb) this.vy = 0.42;
    if (this.inWater && this.eyesInWater) this.vy += 0.045;
    else if (this.inWater) this.vy += 0.02;
    if (this.inLava && this.def.fireproof) this.vy += 0.05;

    if (this.onGround) {
      if (this.fallDistance > 3 && !isChicken) this.hurt(game, Math.ceil(this.fallDistance - 3), undefined, undefined, 'fall');
      this.fallDistance = 0;
    }
    if (this.y < -64) this.hurt(game, 100);

    const moved = Math.hypot(this.x - this.px, this.z - this.pz);
    this.limbAmount += (Math.min(1, moved * 4) - this.limbAmount) * 0.4;
    this.limbSwing += moved * 2.4;

    if (--this.idleSound <= 0) {
      this.idleSound = 120 + Math.floor(Math.random() * 300);
      if (pdist < 20) game.audio.mob(this.def.sound, 'idle', this.x, this.y, this.z);
    }
  }

  // Settlers stroll around their home, keep away from hostiles and stay
  // closer to home at night.
  villagerAI(game, p, pdist) {
    let threat = null;
    for (const e of game.entities) {
      if (e instanceof Mob && e.hostile && !e.dead && Math.hypot(e.x - this.x, e.z - this.z) < 8) { threat = e; break; }
    }
    if (threat) {
      this.wx = this.x + (this.x - threat.x) * 2; this.wz = this.z + (this.z - threat.z) * 2;
      this.wanderTimer = 20;
      return;
    }
    if (game.tradingWith === this) { this.wx = null; this.lookAtPlayer(p); return; }
    // settlers restock their wares a couple of times a day
    if (this.trades && game.isDay() && (game.tickCount + this.id * 97) % 6000 === 0) {
      for (const t of this.trades) t.uses = 0;
    }
    if (this.wanderTimer-- <= 0) {
      const night = !game.isDay();
      const h = this.home || this;
      const range = night ? 3 : 14;
      if (Math.random() < (night ? 0.2 : 0.5)) {
        this.wx = h.x + (Math.random() - 0.5) * range * 2; this.wz = h.z + (Math.random() - 0.5) * range * 2;
      } else this.wx = null;
      this.wanderTimer = 60 + Math.floor(Math.random() * 140);
    }
    if (pdist < 6 && !p.dead) this.lookAtPlayer(p);
    else { this.headYaw *= 0.9; this.headPitch *= 0.9; }
  }

  lookAtPlayer(p) {
    const dx = p.x - this.x, dz = p.z - this.z;
    const want = Math.atan2(dx, -dz);
    this.headYaw += (Math.max(-1.2, Math.min(1.2, wrap(want - this.bodyYaw))) - this.headYaw) * 0.25;
    this.headPitch = Math.max(-0.7, Math.min(0.7, -Math.atan2(p.y + 1.5 - (this.y + this.h * 0.85), Math.hypot(dx, dz))));
  }

  interact(game, stack) {
    if (this.dead) return false;
    if (this.type === 'cow' && !this.baby && stack && stack.id === I.bucket) {
      game.replaceHeld({ id: I.milk_bucket, count: 1 });
      game.audio.play('milk', this.x, this.y + 1, this.z);
      return 'milked';
    }
    if (this.type === 'sheep' && !this.sheared && !this.baby && stack && stack.id === I.shears) {
      this.sheared = true;
      const n = 1 + Math.floor(Math.random() * 3);
      game.dropItem(this.x, this.y + 1, this.z, { id: B.white_wool, count: n });
      game.audio.play('shear', this.x, this.y, this.z);
      return 'damage_tool';
    }
    if (this.def.villager && !this.baby) { game.openTrading(this); return 'trade'; }
    if (this.def.food && stack && this.def.food.includes(stack.id)) {
      if (this.baby) { this.growth = Math.min(0, this.growth + 2400); if (!this.growth) this.resize(); return 'consume'; }
      if (this.love > 0 || this.breedCooldown > 0) return false;
      this.love = 600;
      return 'consume';
    }
    return false;
  }

  serialize() {
    return {
      type: this.type, x: this.x, y: this.y, z: this.z, health: this.health, sheared: this.sheared, yaw: this.yaw,
      growth: this.growth, profession: this.profession, home: this.home, trades: this.trades, armor: this.armor,
    };
  }

  static load(m) {
    const mob = new Mob(m.type, m.x, m.y, m.z, { profession: m.profession, home: m.home, trades: m.trades, armor: m.armor, baby: (m.growth || 0) < 0 });
    mob.health = m.health ?? mob.health; mob.sheared = !!m.sheared; mob.bodyYaw = mob.yaw = m.yaw || 0;
    if (m.growth) { mob.growth = m.growth; mob.resize(); }
    return mob;
  }
}

export const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

// ---------------------------------------------------------------------------
// Arrows, eggs and snowballs.
export class Projectile extends Entity {
  constructor(kind, x, y, z, vx, vy, vz, owner, damage = 2) {
    super(x, y, z, 0.1, 0.2);
    this.kind = kind; this.vx = vx; this.vy = vy; this.vz = vz;
    this.owner = owner; this.damage = damage;
    this.stuck = false; this.stuckTicks = 0;
    this.pitch = 0;
    this.crit = false;
    this.pickup = owner && owner.isPlayer && !owner.creative;
    this.updateAngles();
  }

  updateAngles() {
    const h = Math.hypot(this.vx, this.vz);
    this.yaw = Math.atan2(this.vx, -this.vz);
    this.pitch = Math.atan2(this.vy, h);
  }

  tick(game) {
    this.savePrev();
    this.age++;
    const world = game.world;
    if (this.stuck) {
      this.stuckTicks++;
      if (this.stuckTicks > 1200) this.removed = true;
      // arrows fall out if their block disappears
      if (!SOLID[world.getBlock(Math.floor(this.sx), Math.floor(this.sy), Math.floor(this.sz))]) { this.stuck = false; this.vx = this.vy = this.vz = 0; }
      const p = game.player;
      if (this.pickup && this.stuckTicks > 5 && !p.dead && Math.abs(p.x - this.x) < 1.2 && Math.abs(p.z - this.z) < 1.2 && this.y > p.y - 0.8 && this.y < p.y + 2.2) {
        if (p.inventory.give({ id: I.arrow, count: 1 }) === 0) { this.removed = true; game.audio.play('pop', this.x, this.y, this.z, 0.4); }
      }
      return;
    }
    const sp = Math.hypot(this.vx, this.vy, this.vz);
    if (sp > 1e-4) {
      const dx = this.vx / sp, dy = this.vy / sp, dz = this.vz / sp;
      const bh = raycast(world, this.x, this.y, this.z, dx, dy, dz, sp);
      let best = bh ? bh.dist : sp, target = null;
      const consider = (e) => {
        if (e === this.owner && this.age < 5) return;
        if (e.dead || (e.isPlayer && (e.creative || e.spectator))) return;
        const r = rayBox(this.x, this.y, this.z, dx, dy, dz, e.x - e.w - 0.1, e.y - 0.1, e.z - e.w - 0.1, e.x + e.w + 0.1, e.y + e.h + 0.1, e.z + e.w + 0.1);
        if (r && r.t <= best) { best = r.t; target = e; }
      };
      const considerBoxes = (e) => {
        if (e === this.owner && this.age < 5) return;
        for (const b of e.hitBoxes()) {
          const r = rayBox(this.x, this.y, this.z, dx, dy, dz, b[0] - 0.1, b[1] - 0.1, b[2] - 0.1, b[3] + 0.1, b[4] + 0.1, b[5] + 0.1);
          if (r && r.t <= best) { best = r.t; target = e; }
        }
      };
      for (const e of game.entities) {
        if (e instanceof Mob) consider(e);
        else if (e.targetable && e.hitBoxes && e !== this) considerBoxes(e);
      }
      consider(game.player);
      if (game.remotePlayers) for (const rp of game.remotePlayers()) if (rp !== this.owner) consider(rp);
      if (target) {
        this.hitEntity(game, target, sp);
        return;
      }
      if (bh) {
        this.x += dx * bh.dist; this.y += dy * bh.dist; this.z += dz * bh.dist;
        this.hitBlock(game, bh);
        return;
      }
      this.x += this.vx; this.y += this.vy; this.z += this.vz;
    }
    this.checkFluids(world);
    const drag = this.inWater ? 0.6 : 0.99;
    this.vx *= drag; this.vy *= drag; this.vz *= drag;
    this.vy -= this.kind === 'arrow' ? 0.05 : 0.03;
    this.updateAngles();
    if (this.crit && this.age % 2 === 0) game.particles.crit(this.x, this.y, this.z);
    if (this.age > 1200 || this.y < -64) this.removed = true;
  }

  hitEntity(game, e, speed) {
    this.removed = true;
    if (this.kind === 'arrow') {
      let dmg = Math.ceil(speed * this.damage);
      if (this.crit) dmg += Math.floor(Math.random() * (dmg / 2 + 2));
      const src = this.owner && this.owner.isPlayer ? 'arrow_player' : 'arrow';
      if (e.isRemote) game.net && game.net.hitRemote(e, dmg, 'arrow', this.x - this.vx, this.z - this.vz);
      else if (e.isPlayer) e.damage(game, dmg, 'arrow', this.x - this.vx, this.z - this.vz);
      else if (e instanceof Mob) {
        if (e.hurt(game, dmg, this.x - this.vx, this.z - this.vz, src) || !e.def.teleports) game.audio.play('arrow_hit', this.x, this.y, this.z);
        else this.removed = false; // dodged: keep flying
        return;
      } else if (e.hit) e.hit(game, dmg, src);
      game.audio.play('arrow_hit', this.x, this.y, this.z);
    } else if (this.kind === 'pearl' || this.kind === 'potion') {
      this.land(game);
    } else {
      if (e.isPlayer) e.damage(game, 0, 'thrown', this.x - this.vx, this.z - this.vz);
      else e.hurt(game, 0, this.x - this.vx, this.z - this.vz, 'player');
      this.shatter(game);
    }
  }

  // Void pearls carry their thrower; splash potions burst over an area.
  land(game) {
    this.removed = true;
    if (this.kind === 'pearl') {
      const o = this.owner;
      for (let i = 0; i < 20; i++) game.particles.portal(this.x + (Math.random() - 0.5), this.y + Math.random(), this.z + (Math.random() - 0.5));
      if (o && o.isPlayer && !o.dead) {
        if (o.vehicle) game.dismount();
        o.x = o.px = this.x; o.y = o.py = this.y + 0.1; o.z = o.pz = this.z;
        o.vx = o.vy = o.vz = 0; o.fallDistance = 0;
        let guard = 0;
        while (!boxFree(game.world, o.x, o.y, o.z, o.w, o.h) && guard++ < 4) o.y += 1;
        o.py = o.y;
        o.damage(game, 5, 'fall');
        game.audio.play('teleport', o.x, o.y, o.z);
      }
      return;
    }
    // splash potion
    const fx = potionEffect({ id: this.item, pot: this.pot });
    const col = fx ? EFFECTS[fx.effect].color : [120, 140, 255];
    game.audio.play('glass_break', this.x, this.y, this.z);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
      game.particles.effect(this.x, this.y + 0.2, this.z, col, Math.cos(a) * s, Math.random() * 2, Math.sin(a) * s);
    }
    if (!fx) return;
    const hitOne = (e) => {
      const d = Math.hypot(e.x - this.x, e.y + e.h / 2 - this.y, e.z - this.z);
      if (d > 4) return;
      const scale = 1 - d / 4 * 0.75;
      if (e.isPlayer) e.applyPotion(game, fx, scale);
      else if (e.applyPotion) e.applyPotion(game, fx, scale);
    };
    const p = game.player;
    if (p && !p.dead) hitOne(p);
    for (const e of game.entities) if (e instanceof Mob && !e.dead) hitOne(e);
  }

  hitBlock(game, hit) {
    if (this.kind === 'pearl' || this.kind === 'potion') {
      this.x -= this.vx * 0.05; this.y -= this.vy * 0.05; this.z -= this.vz * 0.05;
      this.land(game);
      return;
    }
    if (this.kind === 'arrow') {
      this.stuck = true; this.sx = hit.x + 0.5; this.sy = hit.y + 0.5; this.sz = hit.z + 0.5;
      this.x -= this.vx * 0.05; this.y -= this.vy * 0.05; this.z -= this.vz * 0.05;
      game.audio.play('arrow_hit', this.x, this.y, this.z, 0.6);
      if (hit.id === B.tnt && this.fire) { game.world.setBlock(hit.x, hit.y, hit.z, 0, 0); game.entities.push(new PrimedCrate(hit.x, hit.y, hit.z)); }
      return;
    }
    this.removed = true;
    this.shatter(game);
  }

  shatter(game) {
    for (let i = 0; i < 6; i++) game.particles.add({ x: this.x, y: this.y, z: this.z, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 3, size: 0.06, layer: game.texWhite, life: 0.4, gravity: 12, lit: true, r: 0.95, g: 0.9, b: 0.8 });
    if (this.kind === 'egg' && Math.random() < 0.125) {
      const n = Math.random() < 1 / 32 ? 4 : 1;
      for (let i = 0; i < n; i++) game.entities.push(new Mob('chicken', this.x, this.y, this.z, { baby: true }));
    }
  }
}

// ---------------------------------------------------------------------------
export class XpOrb extends Entity {
  constructor(x, y, z, value) {
    super(x, y, z, 0.125, 0.25);
    this.value = value;
    this.vx = (Math.random() - 0.5) * 0.2; this.vy = Math.random() * 0.2 + 0.1; this.vz = (Math.random() - 0.5) * 0.2;
    this.delay = 10;
  }

  tick(game) {
    this.savePrev();
    this.age++;
    if (this.delay > 0) this.delay--;
    const p = game.player;
    const dx = p.x - this.x, dy = p.y + 0.9 - this.y, dz = p.z - this.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 8 && !p.dead && !p.spectator) {
      const pull = (1 - d / 8) ** 2 * 0.1;
      this.vx += (dx / d) * pull; this.vy += (dy / d) * pull; this.vz += (dz / d) * pull;
    }
    this.vy -= 0.03;
    const r = moveBox(game.world, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    this.vx *= 0.9; this.vz *= 0.9; this.vy *= 0.98;
    if (d < 1.1 && this.delay === 0 && !p.dead && !p.spectator) {
      this.removed = true;
      p.addXp(game, this.value);
    }
    if (this.age > 6000) this.removed = true;
  }
}

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
    if (SOLID[world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z))]) this.vy = 0.1;
    if (world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z)) === B.fire) { this.removed = true; game.particles.smoke(this.x, this.y, this.z); return; }
    const r = moveBox(world, this, this.vx, this.vy, this.vz);
    this.applyHits(r);
    const f = this.onGround ? blockFriction(world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z))) * 0.98 : 0.98;
    this.vx *= f; this.vz *= f; this.vy *= 0.98;
    if (this.onGround && this.vy < 0) this.vy *= -0.5;
    if (this.age > 6000) this.removed = true;
    if (this.age % 10 === 0) {
      for (const o of game.items) {
        if (o === this || o.removed || o.pickedBy || o.stack.id !== this.stack.id || o.stack.dur || o.stack.ench || this.stack.ench) continue;
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
    this.physics(game.world, 0, 0, { gravity: 0.04, step: 0 });
    if (Math.random() < 0.5) game.particles.smoke(this.x, this.y + 1.05, this.z);
    if (--this.fuse <= 0) {
      this.removed = true;
      game.explode(this.x, this.y + 0.5, this.z, 4);
    }
  }
}

// ---------------------------------------------------------------------------
// Lightning bolt (visual plus damage on strike).
export class Lightning extends Entity {
  constructor(x, y, z) {
    super(x, y, z, 0, 0);
    this.life = 8;
    this.seed = Math.floor(Math.random() * 1e9);
  }
  tick() { this.savePrev(); this.age++; if (--this.life <= 0) this.removed = true; }
}

export function isBlockEntityFree(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return id === 0 || REPLACEABLE[id] || !BLOCKS[id];
}
