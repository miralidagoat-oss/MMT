// Game state and rules: ticking, interaction, block updates, creatures,
// time and weather, saving. Rendering and UI are driven from here.
import { TICK_MS, DAY_TICKS, HEIGHT, SEA_LEVEL } from './constants.js';
import {
  B, BLOCKS, SOLID, OPAQUE, REPLACEABLE, isLiquid, RENDER_TYPE, RENDER, TEX, faceTexture,
} from './blocks.js';
import { ITEMS, I, SMELTING, fuelValue, isBlockItem, findItem, maxStack, itemName, BANNER_COLORS } from './items.js';
import { World, STATE } from './world.js';
import { Player } from './player.js';
import { Mob, ItemEntity, FallingBlock, PrimedCrate, MOB_TYPES, Projectile, XpOrb, Lightning, BABY_AGE } from './entities.js';
import { rollLoot, makeTrades, ENCHANTS, enchantLabel, applicableEnchants } from './loot.js';
import { tryLightPortal, riftValid, findRift, buildPortal, portalLimits } from './portal.js';
import { DIRS, DOOR_OPEN, DOOR_UPPER, DOOR_RIGHT, BED_HEAD } from './shapes.js';
import { raycast, rayBox, selectionBoxAt, boxFree } from './physics.js';
import { Particles } from './particles.js';
import { Fluids } from './fluids.js';
import { computeEnv, daylight } from './env.js';
import { hashSeed, rng } from './noise.js';
import { ADVANCEMENTS } from './advancements.js';
import { newFurnace, newChest, Container } from './inventory.js';
import { WorldGen, BIOME } from './worldgen.js';
import { LANDMARKS } from './landmarks.js';
import { Circuits } from './circuits.js';
import { installNet } from './net.js';
import { installBlaster } from './blaster.js';
import { installFeatures, solidTop } from './features.js';
import { isRail, Minecart, Boat } from './vehicles.js';
import { potionEffect, EFFECTS, addEffect } from './effects.js';
import { DIM_NAMES } from './dims.js';

const REACH_SURVIVAL = 4.5, REACH_CREATIVE = 5;
const DIR6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const GRASS_OK = new Set([2, 3, 34, 74]);
// experience from mining ores: [min, max]
const ORE_XP = { 14: [0, 2], 18: [3, 7], 19: [3, 7], 93: [2, 5], 94: [0, 1] };

export class Game {
  constructor({ renderer, scene, audio, input, ui, storage, settings }) {
    this.renderer = renderer; this.scene = scene; this.audio = audio; this.input = input; this.ui = ui;
    this.storage = storage; this.settings = settings;
    this.world = null; this.player = null;
    this.entities = []; this.items = [];
    this.particles = new Particles(null);
    this.fluids = new Fluids(this);
    this.state = 'title'; // title | loading | playing | paused | screen | dead
    this.tickCount = 0; this.dayTime = 1000; this.day = 0;
    this.rain = 0; this.rainTarget = 0; this.rainTime = 12000;
    this.acc = 0; this.last = performance.now();
    this.perspective = 0; this.hideHud = false; this.showDebug = false;
    this.env = {};
    this.target = null; this.targetEntity = null;
    this.breaking = null; this.breakCooldown = 0; this.placeCooldown = 0;
    this.swing = 0; this.pswing = 0; this.swingTicks = 0;
    this.equip = 0; this.pequip = 0; this.lastHeldId = -1;
    this.eatTicks = 0;
    this.fps = 0; this.frames = 0; this.fpsTime = 0; this.frameMs = 0;
    this.fovCur = settings.fov;
    this.keepInventory = false;
    this.meta = null;
    this.craft2 = new Container(4);
    this.craft3 = new Container(9);
    this.enchantSlot = new Container(1);
    this.anvilSlots = new Container(2); this.loomSlots = new Container(2); this.beaconSlot = new Container(1);
    this.flicker = 1;
    this.shake = 0;
    this.caveSoundTimer = 600;
    this.torchCache = []; this.torchScanTick = 0;
    this.demo = false;
    this.dim = 'overworld';
    this.orbs = [];
    this.bowDraw = 0;
    this.thunder = 0; this.flash = 0;
    this.tradingWith = null;
    this.pendingPortal = null;
    this.texWhite = TEX.white;
    this.circuits = new Circuits(this);
    this.wyrm = null;
    this.net = null; // shared-world session (see net.js)
    this.swingCount = 0;
  }

  // Saved state for one dimension (older saves kept it at the top level).
  dimState(meta, dim) {
    if (meta.dims && meta.dims[dim]) return meta.dims[dim];
    if (dim === 'overworld') return { populated: meta.populated, blockEntities: meta.blockEntities, mobs: meta.mobs };
    return {};
  }

  // ---------------------------------------------------------------------------
  // World lifecycle
  async startWorld(meta, { demo = false, dim = null, keepPlayer = false } = {}) {
    if (this.world) this.world.dispose();
    this.demo = demo;
    this.meta = meta;
    const seed = meta.seed;
    const d = dim || (meta.player && meta.player.dim) || 'overworld';
    this.dim = d;
    this.world = new World({
      seed, worldId: demo ? null : meta.id, storage: demo ? null : this.storage, renderer: this.renderer, dim: d,
      hooks: {
        onBlockChanged: (...a) => this.onBlockChanged(...a),
        onChunkGenerated: (c, spawns, chests, spawners) => this.onChunkGenerated(c, spawns, chests, spawners),
        onAnyChange: (...a) => { if (this.net) this.net.onWorldChange(...a); if (!this.demo && !(this.net && this.net.isGuest)) this.circuits.observe(a[0], a[1], a[2]); },
        onChunkReady: (c) => { if (this.net && this.net.isGuest) this.net.onChunkReady(c); },
        onBaseline: (msg) => { if (this.net && this.net.isHost) this.net.onBaseline(msg); },
      },
    });
    this.particles.setWorld(this.world);
    this.fluids.clear();
    this.circuits.clear();
    this._fires = new Set(); this._maps = new Map();
    this.wyrm = null;
    if (this.player) { this.player.vehicle = null; this.player.fishing = null; }
    this.entities = []; this.items = []; this.orbs = [];
    this.torchCache.length = 0;
    this.tickCount = meta.time || 0;
    this.dayTime = meta.dayTime ?? 1000;
    this.day = meta.day || 0;
    this.rain = this.rainTarget = meta.rain || 0;
    this.thunder = meta.thunder || 0;
    this.rainTime = meta.rainTime ?? 12000 + Math.floor(Math.random() * 40000);
    const ds = this.dimState(meta, d);
    this.world.populated = new Set(ds.populated || []);
    this.world.blockEntities = new Map(ds.blockEntities || []);
    if (!keepPlayer || !this.player) {
      this.player = new Player(0, 80, 0);
      this.player.mode = meta.mode || 'survival';
    }
    this.craft2 = new Container(4); this.craft3 = new Container(9);
    this.breaking = null; this.target = null; this.eatTicks = 0; this.bowDraw = 0;
    this.advancements = new Set(meta.advancements || []);
    await this.world.start();
    if (keepPlayer) {
      this.spawnKnown = true;
    } else if (meta.player) {
      this.player.load(meta.player);
      this.spawnKnown = true;
    } else {
      const gen = new WorldGen(seed);
      const s = gen.findSpawn();
      this.player.x = this.player.px = s.x; this.player.z = this.player.pz = s.z; this.player.y = this.player.py = s.h + 1;
      this.player.spawn = null;
      this.spawnKnown = false;
    }
    this.player.dim = d;
    for (const m of ds.mobs || []) {
      if (!MOB_TYPES[m.type]) continue;
      this.entities.push(Mob.load(m));
    }
    this.loadObjects(ds.objects);
    this.spawnVoidBoss();
    this.lastHeldId = -1;
  }

  // Place a new player safely on the surface once the spawn chunk exists.
  resolveSpawn() {
    const p = this.player;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    if (!this.world.chunkReady(x >> 4, z >> 4)) return false;
    if (this.pendingPortal) return this.resolvePortal();
    if (!this.spawnKnown) {
      // prefer open ground: skip columns covered by trees or water
      const w = this.world;
      const ground = (gx, gz) => {
        const top = w.surfaceY(gx, gz);
        if (top < 1) return -1;
        const id = w.getBlock(gx, top - 1, gz);
        if (!OPAQUE[id] || BLOCKS[id].name.endsWith('leaves') || BLOCKS[id].name.endsWith('log')) return -1;
        return top;
      };
      let best = null;
      for (let r = 0; r <= 10 && !best; r++) {
        for (let dz = -r; dz <= r && !best; dz++) for (let dx = -r; dx <= r && !best; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!w.chunkReady((x + dx) >> 4, (z + dz) >> 4)) continue;
          const y = ground(x + dx, z + dz);
          if (y > 0) best = [x + dx + 0.5, y, z + dz + 0.5];
        }
      }
      if (!best) best = [p.x, Math.max(1, w.surfaceY(x, z)) || SEA_LEVEL + 1, p.z];
      p.x = p.px = best[0]; p.y = p.py = best[1]; p.z = p.pz = best[2];
      p.spawn = { x: p.x, y: p.y, z: p.z };
      p.worldSpawn = { ...p.spawn };
      this.spawnKnown = true;
    }
    // never start inside blocks
    let guard = 0;
    while (!boxFree(this.world, p.x, p.y, p.z, p.w, p.h) && guard++ < 256) { p.y += 1; p.py = p.y; }
    return true;
  }

  serialize() {
    const mobs = this.entities.filter((e) => e instanceof Mob && !e.dead && (!e.hostile || e.persistent)).map((m) => m.serialize());
    const dims = { ...(this.meta.dims || {}) };
    if (!this.meta.dims && this.meta.populated && this.dim !== 'overworld') dims.overworld = this.dimState(this.meta, 'overworld');
    dims[this.dim] = { populated: [...this.world.populated], blockEntities: [...this.world.blockEntities.entries()], mobs, objects: this.serializeObjects() };
    this.saveMaps();
    if (this.wyrm && !this.wyrm.removed) this.meta.voidWyrmHealth = this.wyrm.health;
    const out = {
      ...this.meta,
      lastPlayed: Date.now(),
      time: this.tickCount, dayTime: this.dayTime, day: this.day,
      rain: this.rainTarget, rainTime: this.rainTime, thunder: this.thunder,
      mode: this.player.mode,
      player: this.player.toJSON(),
      advancements: [...this.advancements],
      dims,
    };
    delete out.populated; delete out.blockEntities; delete out.mobs;
    return out;
  }

  async save() {
    if (!this.world || this.demo || !this.meta) return;
    if (this.net && this.net.isGuest) { this.net.saveState(); return; }
    this.returnCraftingItems();
    const chunks = this.world.collectSaves();
    this.meta = this.serialize();
    await this.storage.saveWorld(this.meta);
    await this.storage.saveChunks(this.world.worldId, chunks);
  }

  // ---------------------------------------------------------------------------
  // Main loop pieces
  frame(now) {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.frames++; this.fpsTime += dt;
    if (this.fpsTime >= 0.5) { this.fps = Math.round(this.frames / this.fpsTime); this.frames = 0; this.fpsTime = 0; }
    if (!this.world) return;
    const playing = this.state === 'playing';
    // a shared world keeps running while its players look at menus
    const simulate = this.state === 'playing' || this.state === 'screen' || this.state === 'dead' || this.demo || (this.state === 'paused' && !!this.net);

    if (playing) this.look(dt);
    if (simulate && this.state !== 'loading') {
      this.acc += dt * 1000;
      let n = 0;
      while (this.acc >= TICK_MS && n < 8) { this.tick(); this.acc -= TICK_MS; n++; }
      if (n === 8) this.acc = 0;
    }
    const alpha = this.state === 'paused' || this.state === 'loading' ? 1 : Math.min(1, this.acc / TICK_MS);
    const p = this.player;
    const camX = this.demo ? this.demoCam.x : p.x, camZ = this.demo ? this.demoCam.z : p.z;
    this.world.update(camX, camZ, this.demo ? Math.min(8, this.settings.renderDistance) : this.settings.renderDistance, this.state === 'loading' ? 12 : 5);
    if (simulate && this.state !== 'loading') this.particles.update(dt);
    if (playing || this.state === 'screen') this.updateTarget(alpha);
    this.render(alpha, dt);
    this.audio.update(dt, this.settings.music > 0 && (playing || this.demo));
  }

  look(dt) {
    const s = this.settings;
    const [dx, dy] = this.input.consumeLook();
    const sens = 0.0022 * (s.sensitivity / 100) * 1.6;
    const p = this.player;
    p.yaw += dx * sens;
    p.pitch -= dy * sens * (s.invertMouse ? -1 : 1);
    // arrow keys look as well
    const k = this.input.keys;
    const ks = 2.2 * dt;
    if (k.has('ArrowLeft')) p.yaw -= ks;
    if (k.has('ArrowRight')) p.yaw += ks;
    if (k.has('ArrowUp')) p.pitch += ks;
    if (k.has('ArrowDown')) p.pitch -= ks;
    p.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, p.pitch));
    const w = this.input.consumeWheel();
    if (w) {
      const inv = p.inventory;
      inv.selected = ((inv.selected + w) % 9 + 9) % 9;
    }
  }

  isDay() { return daylight(this.dayTime, this.rain) > 0.5; }

  tick() {
    this.tickCount++;
    const p = this.player;
    this.pswing = this.swing; this.pequip = this.equip;
    if (this.demo) { this.tickTime(); this.tickEntities(); this.fluids.tick(this.tickCount); return; }

    // player
    const playing = this.state === 'playing';
    let input = playing ? this.input.movement() : { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    if (playing && this.input.consumeDoubleTap('forward')) input.sprint = true;
    if (playing && this.input.consumeDoubleTap('jump') && (p.creative || p.spectator)) {
      p.flying = !p.flying;
      if (p.flying) p.vy = 0;
    }
    if (p.sprinting && input.forward > 0) input.sprint = true;
    if (p.sleeping) { this.tickSleep(); input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false }; }
    if (this.bowDraw > 0) { input.sprint = false; input.forward *= 0.3; input.strafe *= 0.3; }
    const chunkHere = this.world.chunkReady(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4);
    if (p.vehicle && (p.vehicle.removed || p.vehicle.dead || p.dead)) this.dismount();
    if (p.vehicle) {
      p.rideTick(this);
      p.vehicle.riderInput = input;
      if (playing && input.sneak) this.dismount();
    } else if (chunkHere && !p.sleeping) p.tick(this, input);
    else p.savePrev();
    this.audio.setListener(p.x, p.y + p.eye, p.z, p.yaw);

    // interaction
    if (playing && !p.sleeping) this.tickInteraction();
    else { this.breaking = null; this.eatTicks = 0; this.bowDraw = 0; }
    this.tickSwing();
    this.tickPortal();
    this.tickVoidTravel();

    this.tickEntities();
    if (p.vehicle) this.syncRider();
    this.tickMaps();
    if (this.net && this.net.isGuest) {
      // the host runs circuits, fluids, growth, spawning and the weather
      this.tickTime();
      this.tickAmbient();
      this.net.tick();
      if (this.tickCount % 600 === 0) this.save();
      return;
    }
    this.circuits.tick();
    this.tickBrewing();
    this.tickHoppers();
    this.tickBeacons();
    this.tickCauldrons();
    this.tickFires();
    this.fluids.tick(this.tickCount);
    this.randomTicks();
    this.tickSpawning();
    this.tickExplorer();
    this.tickSpawners();
    this.tickFurnaces();
    this.tickTime();
    this.tickWeather();
    this.tickAmbient();
    if (this.net) this.net.tick();
    // autosave, but not while a screen holds items in its crafting slots
    if (this.tickCount % 600 === 0 && this.state !== 'screen') this.save();
  }

  tickTime() {
    if (this.settings.daylightCycle !== false) {
      this.dayTime++;
      if (this.dayTime >= DAY_TICKS) { this.dayTime -= DAY_TICKS; this.day++; }
    }
    if (--this.rainTime <= 0) {
      this.rainTarget = this.rainTarget > 0 ? 0 : 1;
      this.rainTime = this.rainTarget ? 12000 + Math.floor(Math.random() * 12000) : 12000 + Math.floor(Math.random() * 168000);
    }
    this.rain += Math.sign(this.rainTarget - this.rain) * Math.min(Math.abs(this.rainTarget - this.rain), 0.01);
    this.flicker = 0.93 + Math.random() * 0.07 * 0.8 + 0.03;
  }

  tickSwing() {
    if (this.swingTicks > 0) {
      this.swingTicks++;
      if (this.swingTicks > 6) { this.swingTicks = 0; }
    }
    this.swing = this.swingTicks > 0 ? this.swingTicks / 6 : 0;
    const held = this.player.inventory.held;
    const hid = held ? held.id : 0;
    if (hid !== this.lastHeldId) { this.equip = 1; this.lastHeldId = hid; this.eatTicks = 0; }
    this.equip = Math.max(0, this.equip - 0.25);
  }

  startSwing() { if (this.swingTicks === 0 || this.swingTicks > 3) { this.swingTicks = 1; this.swingCount++; } }
  swingProgress(alpha) {
    if (this.swingTicks === 0) return 0;
    return Math.min(1, (this.swingTicks - 1 + alpha) / 6);
  }
  equipProgress(alpha) { return this.pequip + (this.equip - this.pequip) * alpha; }
  eatingProgress(alpha) { return this.eatTicks > 0 ? (this.eatTicks + alpha) / 32 : 0; }

  // ---------------------------------------------------------------------------
  // Targeting
  eyePos(alpha = 1) {
    const p = this.player;
    const [x, y, z] = p.lerpPos(alpha);
    return [x, y + p.peye + (p.eye - p.peye) * alpha, z];
  }

  lookDir() {
    const p = this.player;
    const cp = Math.cos(p.pitch);
    return [Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp];
  }

  updateTarget(alpha) {
    const p = this.player;
    if (p.dead || p.spectator) { this.target = null; this.targetEntity = null; return; }
    const [ex, ey, ez] = this.eyePos(alpha);
    const [dx, dy, dz] = this.lookDir();
    const reach = p.creative ? REACH_CREATIVE : REACH_SURVIVAL;
    const hit = raycast(this.world, ex, ey, ez, dx, dy, dz, reach);
    let best = hit ? hit.dist : reach;
    let ent = null;
    const maxE = 3.5 + (p.creative ? 1.5 : 0);
    for (const e of this.entities) {
      if (!e.targetable || e === p.vehicle) continue;
      for (const b of e.hitBoxes ? e.hitBoxes() : [[e.x - e.w, e.y, e.z - e.w, e.x + e.w, e.y + e.h, e.z + e.w]]) {
        const r = rayBox(ex, ey, ez, dx, dy, dz, b[0], b[1], b[2], b[3], b[4], b[5]);
        if (r && r.t < best && r.t <= (e.isWyrm ? 7 : maxE)) { best = r.t; ent = e; }
      }
    }
    if (this.remotePlayers) for (const rp of this.remotePlayers()) {
      const r = rayBox(ex, ey, ez, dx, dy, dz, rp.x - 0.3, rp.y, rp.z - 0.3, rp.x + 0.3, rp.y + 1.8, rp.z + 0.3);
      if (r && r.t < best && r.t <= maxE) { best = r.t; ent = rp; }
    }
    this.targetEntity = ent;
    this.target = ent ? null : hit;
  }

  canSee(a, b) {
    const ax = a.x, ay = a.y + a.h * 0.85, az = a.z;
    const bx = b.x, by = b.y + (b.eye || b.h * 0.85), bz = b.z;
    const d = Math.hypot(bx - ax, by - ay, bz - az);
    const steps = Math.ceil(d * 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (OPAQUE[this.world.getBlock(Math.floor(ax + (bx - ax) * t), Math.floor(ay + (by - ay) * t), Math.floor(az + (bz - az) * t))]) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Interaction
  tickInteraction() {
    const p = this.player;
    const inp = this.input;
    const clicks = inp.consumeClicks();
    if (p.dead) return;
    if (this.breakCooldown > 0) this.breakCooldown--;
    if (this.placeCooldown > 0) this.placeCooldown--;
    const held = p.inventory.held;

    if (clicks.middle) this.pickBlock();

    // attack / mine
    if (clicks.left && this.targetEntity) {
      this.attack(this.targetEntity);
      this.startSwing();
    } else if (inp.mouse.left && !p.spectator) {
      if (this.target) this.mine(this.target);
      else { if (clicks.left) this.startSwing(); this.breaking = null; }
    } else this.breaking = null;

    const def = held && ITEMS[held.id];
    const te = this.targetEntity;
    const interactive = (this.target && this.isInteractive(this.target) && !p.sneaking) || (te && ((te.def && te.def.villager) || te.vehicle));
    // the photon blaster fires while the right button is held
    if (this.tickBlaster(held, inp.mouse.right, clicks.right, interactive)) { this.eatTicks = 0; p.eating = 0; return; }
    // a raised shield
    p.blocking = !!(held && held.id === I.shield && inp.mouse.right && !interactive);
    if (p.blocking) { this.eatTicks = 0; p.eating = 0; return; }

    // draw and release a bow
    if (held && held.id === I.bow && !interactive) {
      const hasArrow = p.creative || p.inventory.count(I.arrow) > 0;
      if (inp.mouse.right && hasArrow) { this.bowDraw++; if (this.bowDraw === 1) this.audio.play('bow_draw', p.x, p.y + 1.5, p.z, 0.5); return; }
      if (this.bowDraw > 0) { this.releaseBow(); this.bowDraw = 0; }
      if (inp.mouse.right) return;
    } else this.bowDraw = 0;

    // eating
    const canEat = def && ((def.food && (p.food < 20 || p.creative || def.always)) || def.drink);
    if (inp.mouse.right && canEat && !interactive) {
      this.eatTicks++;
      if (this.eatTicks % 4 === 0) this.audio.play(def.drink ? 'drink' : 'eat', p.x, p.y + 1.5, p.z, 0.6);
      if (this.eatTicks >= 32) {
        this.eatTicks = 0;
        if (def.drink) this.finishDrink(held);
        else {
          if (!p.creative) {
            p.eat(held);
            this.afterEat(held);
            if (def.leaves) this.replaceHeld({ id: I[def.leaves], count: 1 }); else p.inventory.useHeld();
          } else this.afterEat(held);
          this.audio.play('burp', p.x, p.y + 1.5, p.z, 0.5);
        }
      }
      p.eating = this.eatTicks;
      return;
    }
    this.eatTicks = 0; p.eating = 0;
    if (clicks.right || (inp.mouse.right && this.placeCooldown === 0)) {
      if (!clicks.right && this.placeCooldown > 0) return;
      this.placeCooldown = 4;
      this.use();
    }
  }

  // Fire an arrow from a fully or partly drawn bow.
  releaseBow() {
    const p = this.player;
    const f = this.bowDraw / 20;
    const power = Math.min(1, (f * f + f * 2) / 3);
    if (power < 0.1) return;
    const held = p.inventory.held;
    const [dx, dy, dz] = this.lookDir();
    const [ex, ey, ez] = this.eyePos();
    const speed = power * 3;
    const pw = held.ench && held.ench.power ? held.ench.power : 0;
    const a = new Projectile('arrow', ex + dx * 0.3, ey - 0.1 + dy * 0.3, ez + dz * 0.3, dx * speed, dy * speed, dz * speed, p, 2 + (pw ? pw * 0.5 + 0.5 : 0));
    a.crit = power >= 1;
    this.entities.push(a);
    if (!p.creative) {
      const i = p.inventory.slots.findIndex((s, k) => k < 36 && s && s.id === I.arrow);
      if (i >= 0) { p.inventory.slots[i].count--; if (!p.inventory.slots[i].count) p.inventory.set(i, null); }
      this.damageTool(1);
    }
    this.audio.play('bow', p.x, p.y + 1.5, p.z);
  }

  // Creature archers aim at a point with some spread.
  shootArrow(owner, tx, ty, tz, speed, spread) {
    const sx = owner.x, sy = owner.y + owner.h * 0.8, sz = owner.z;
    const dx = tx - sx, dz = tz - sz, h = Math.hypot(dx, dz);
    const dy = ty - sy + h * 0.2;
    const l = Math.hypot(dx, dy, dz) || 1;
    const jit = () => (Math.random() - 0.5) * spread * 0.0075 * 2;
    const vx = (dx / l + jit()) * speed, vy = (dy / l + jit()) * speed, vz = (dz / l + jit()) * speed;
    this.entities.push(new Projectile('arrow', sx + (dx / l) * 0.5, sy, sz + (dz / l) * 0.5, vx, vy, vz, owner, 2));
    this.audio.play('bow', sx, sy, sz, 0.8);
  }

  isInteractive(hit) {
    const id = hit.id;
    return id === B.crafting_table || id === B.furnace || id === B.furnace_lit || id === B.chest || id === B.tnt ||
      id === B.oak_door || id === B.oak_fence_gate || id === B.bed || id === B.enchanting_table ||
      id === B.lever || id === B.stone_button || id === B.oak_button || id === B.repeater || id === B.note_block ||
      id === B.oak_trapdoor || id === B.brewing_stand || id === B.dispenser || id === B.hopper || id === B.cake ||
      id === B.oak_sign || id === B.oak_wall_sign || id === B.comparator || id === B.dropper || id === B.anvil ||
      id === B.loom || id === B.beacon || id === B.void_chest || id === B.cauldron;
  }

  breakSpeed(id) {
    const p = this.player;
    const b = BLOCKS[id];
    const held = p.inventory.held;
    const tool = held && ITEMS[held.id] && ITEMS[held.id].tool;
    let speed = 1;
    let correct = false;
    if (tool) {
      if (tool.type === b.tool) { correct = true; speed = tool.speed; }
      if (tool.type === 'shears' && (b.name.endsWith('leaves'))) { correct = true; speed = 15; }
      if (tool.type === 'shears' && b.name.endsWith('wool')) { correct = true; speed = 5; }
      if (tool.type === 'sword' && b.name.endsWith('leaves')) speed = 1.5;
    }
    const canHarvest = !b.requiresTool || (correct && tool.tier >= b.level && tool.type !== 'shears') || (correct && tool.type === 'shears');
    if (correct && held.ench && held.ench.efficiency) speed += held.ench.efficiency * held.ench.efficiency + 1;
    if (p.eyesInWater) speed /= 5;
    if (!p.onGround && !p.flying) speed /= 5;
    return { rate: speed / b.hardness / (canHarvest ? 30 : 100), canHarvest, tool: correct ? tool : null };
  }

  mine(hit) {
    const p = this.player;
    const b = BLOCKS[hit.id];
    this.startSwing();
    if (p.creative) {
      if (this.breakCooldown > 0) return;
      this.breakBlock(hit.x, hit.y, hit.z, false);
      this.breakCooldown = 5;
      return;
    }
    if (b.hardness < 0) { this.breaking = null; return; }
    if (this.breakCooldown > 0) return;
    const br = this.breaking;
    if (!br || br.x !== hit.x || br.y !== hit.y || br.z !== hit.z || br.id !== hit.id) {
      this.breaking = { x: hit.x, y: hit.y, z: hit.z, id: hit.id, progress: 0, ticks: 0 };
    }
    const cur = this.breaking;
    const sp = b.hardness === 0 ? { rate: 1, canHarvest: true } : this.breakSpeed(hit.id);
    cur.progress += sp.rate;
    cur.ticks++;
    if (cur.ticks % 4 === 1) {
      this.audio.blockSound(hit.id, 'hit', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      this.particles.blockHit(hit.x, hit.y, hit.z, hit.id, this.world.getMeta(hit.x, hit.y, hit.z), hit.face);
    }
    if (cur.progress >= 1) {
      this.breakBlock(hit.x, hit.y, hit.z, sp.canHarvest);
      this.breaking = null;
      this.breakCooldown = 5;
      p.addExhaustion(0.005);
      const held = p.inventory.held;
      if (held && ITEMS[held.id].tool && b.hardness > 0) this.damageTool(ITEMS[held.id].tool.type === 'sword' ? 2 : 1);
    }
  }

  damageTool(n) {
    const p = this.player;
    if (p.creative) return;
    const held = p.inventory.held;
    if (!held) return;
    const def = ITEMS[held.id];
    if (!def.durability) return;
    const u = held.ench && held.ench.unbreaking ? held.ench.unbreaking : 0;
    if (u && Math.random() > 1 / (u + 1)) return;
    held.dur = (held.dur || 0) + n;
    if (held.dur >= def.durability) {
      p.inventory.held = null;
      this.audio.play('crit', p.x, p.y + 1, p.z);
      this.audio.material('metal', 'break', p.x, p.y + 1, p.z);
    }
  }

  // Remove a block, spawning its drops (when harvested) and effects.
  breakBlock(x, y, z, harvest, silent = false) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (!id) return;
    const meta = w.getMeta(x, y, z);
    const b = BLOCKS[id];
    // container contents spill out
    const be = w.blockEntities.get(`${x},${y},${z}`);
    if (be) {
      if (be.slots) for (const s of be.slots) if (s) this.dropItem(x + 0.5, y + 0.5, z + 0.5, s, true);
      // a banner keeps its colour and patterns
      if (be.type === 'banner' && !this.player.creative) this.dropItem(x + 0.5, y + 0.5, z + 0.5, { id: I[`${BANNER_COLORS[be.base] || 'white'}_banner`], count: 1, ...(be.bn && be.bn.length ? { bn: be.bn } : {}) }, true);
      w.blockEntities.delete(`${x},${y},${z}`);
      this.ui.onBlockEntityRemoved(`${x},${y},${z}`);
    }
    let replacement = 0;
    if (id === B.ice && !this.player.creative) {
      const below = w.getBlock(x, y - 1, z);
      if (SOLID[below] || isLiquid(below)) replacement = B.water;
    }
    // pistons and their heads come apart together
    if ((id === B.piston || id === B.sticky_piston) && (meta & 8)) {
      const [hx, hy, hz] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][meta & 7];
      if (w.getBlock(x + hx, y + hy, z + hz) === B.piston_head) w.setBlock(x + hx, y + hy, z + hz, 0, 0, { notify: false });
    } else if (id === B.piston_head) {
      const [hx, hy, hz] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][meta & 7];
      const base = w.getBlock(x - hx, y - hy, z - hz);
      if (base === B.piston || base === B.sticky_piston) { w.setBlock(x, y, z, 0, 0, { notify: false }); this.breakBlock(x - hx, y - hy, z - hz, harvest); return; }
    }
    // two-block pieces come apart together
    if (id === B.oak_door) {
      const oy = meta & DOOR_UPPER ? y - 1 : y + 1;
      if (w.getBlock(x, oy, z) === B.oak_door) w.setBlock(x, oy, z, 0, 0, { notify: false });
    } else if (id === B.bed) {
      const [dx, dz] = DIRS[meta & 3];
      const s = meta & BED_HEAD ? -1 : 1;
      if (w.getBlock(x + dx * s, y, z + dz * s) === B.bed) w.setBlock(x + dx * s, y, z + dz * s, 0, 0, { notify: false });
    }
    w.setBlock(x, y, z, replacement, 0);
    if (!silent) {
      this.audio.blockSound(id, 'break', x + 0.5, y + 0.5, z + 0.5);
      this.particles.blockBreak(x, y, z, id, meta);
    }
    if (harvest && !this.player.creative) {
      const held = this.player.inventory.held;
      const shears = held && held.id === I.shears;
      let drops;
      if (shears && (b.name.endsWith('leaves') || id === B.tall_grass || id === B.fern || id === B.dead_bush)) drops = [[id, 1]];
      else drops = b.drops ? b.drops(Math.random, meta) : (b.item ? [[id, 1]] : []);
      const fortune = held && held.ench && held.ench.fortune ? held.ench.fortune : 0;
      const ore = ORE_XP[id];
      for (const [did, n] of drops) {
        if (n <= 0 || !ITEMS[did]) continue;
        let c = n;
        if (fortune && ore) c *= 1 + Math.max(0, Math.floor(Math.random() * (fortune + 2)) - 1);
        this.dropItem(x + 0.5, y + 0.3, z + 0.5, { id: did, count: c }, true);
      }
      if (ore) this.spawnXp(x + 0.5, y + 0.5, z + 0.5, ore[0] + Math.floor(Math.random() * (ore[1] - ore[0] + 1)));
    }
  }

  // Break a block without a tool (support loss, water flow): always drops.
  breakNaturally(x, y, z, silent = false) {
    const id = this.world.getBlock(x, y, z);
    if (!id) return;
    const b = BLOCKS[id];
    const meta = this.world.getMeta(x, y, z);
    this.world.setBlock(x, y, z, 0, 0);
    if (!silent) { this.particles.blockBreak(x, y, z, id, meta); this.audio.blockSound(id, 'break', x + 0.5, y + 0.5, z + 0.5); }
    if (id === B.oak_door && (meta & DOOR_UPPER)) return; // the lower half drops the item
    if (id === B.bed && !(meta & BED_HEAD)) return;
    const drops = b.drops ? b.drops(Math.random, meta) : (b.item ? [[id, 1]] : []);
    for (const [did, n] of drops) if (n > 0 && ITEMS[did]) this.dropItem(x + 0.5, y + 0.3, z + 0.5, { id: did, count: n }, true);
  }

  // Names that tie tamed creatures to players.
  localName() { return this.settings.playerName || 'Player'; }
  nameOf(pl) { return pl === this.player ? this.localName() : pl && pl.name; }
  ownerOf(name) {
    if (!name) return null;
    if (name === this.localName()) return this.player;
    if (this.net) for (const rp of this.net.remotePlayers()) if (rp.name === name) return rp;
    return null;
  }

  // A creature throws something (snowballs, splash potions) at a point.
  // A mob lobs something at (tx, ty, tz): solve for the vertical speed that
  // lands it there under gravity 0.03/tick with 1% drag.
  mobThrow(owner, kind, tx, ty, tz, speed, extra = {}) {
    const sx = owner.x, sy = owner.y + owner.h * 0.8, sz = owner.z;
    const dx = tx - sx, dz = tz - sz, h = Math.hypot(dx, dz) || 0.01;
    const hx = (dx / h) * 0.5, hz = (dz / h) * 0.5;
    const t = Math.max(1, (h - 0.5) / (speed * 0.95));
    const vy = (ty - sy) / t + 0.5 * 0.03 * t;
    const pr = new Projectile(kind, sx + hx, sy, sz + hz, (dx / h) * speed, vy, (dz / h) * speed, owner, 0);
    Object.assign(pr, extra);
    this.entities.push(pr);
    this.audio.play('throw', sx, sy, sz, 0.5);
    return pr;
  }

  attack(mob) {
    const p = this.player;
    this.lastAttackTarget = mob;
    const held = p.inventory.held;
    const def = held && ITEMS[held.id];
    let dmg = def && def.damage ? def.damage : 1;
    if (held && held.ench && held.ench.sharpness) dmg += held.ench.sharpness * 0.5 + 0.5;
    if (p.effects.strength) dmg += 3 * (p.effects.strength.amp + 1);
    if (p.effects.weakness) dmg = Math.max(0, dmg - 4);
    if (mob.isRemote) { if (this.net) this.net.hitRemote(mob, dmg, 'player', p.x, p.z); this.startSwing(); return; }
    if (mob.mirror && this.net && this.net.isGuest) {
      const crit = p.vy < 0 && !p.onGround && !p.inWater && !p.onLadder && !p.flying;
      if (crit) { dmg *= 1.5; this.audio.play('crit', mob.x, mob.y + 1, mob.z); for (let i = 0; i < 8; i++) this.particles.crit(mob.x + (Math.random() - 0.5) * 0.6, mob.y + mob.h * Math.random(), mob.z + (Math.random() - 0.5) * 0.6); }
      const kb = (p.sprinting ? 1 : 0) + (held && held.ench && held.ench.knockback ? held.ench.knockback : 0);
      this.net.hitMirror(mob, dmg, kb, crit);
      if (mob instanceof Mob) { this.audio.mob(mob.def.sound, 'hurt', mob.x, mob.y, mob.z); mob.hurtTime = 10; }
      p.addExhaustion(0.1); p.sprinting = false;
      if (def && def.tool) this.damageTool(def.tool.type === 'sword' ? 1 : 2);
      return;
    }
    if (!(mob instanceof Mob)) {
      if (mob.hit) mob.hit(this, dmg, 'player');
      p.addExhaustion(0.1);
      return;
    }
    const crit = p.vy < 0 && !p.onGround && !p.inWater && !p.onLadder && !p.flying;
    if (crit) {
      dmg *= 1.5;
      this.audio.play('crit', mob.x, mob.y + 1, mob.z);
      for (let i = 0; i < 8; i++) this.particles.crit(mob.x + (Math.random() - 0.5) * 0.6, mob.y + mob.h * Math.random(), mob.z + (Math.random() - 0.5) * 0.6);
    }
    if (mob.hurt(this, dmg, p.x, p.z, 'player')) {
      const kb = (p.sprinting ? 1 : 0) + (held && held.ench && held.ench.knockback ? held.ench.knockback : 0);
      if (kb) { mob.vx += Math.sin(p.yaw) * 0.5 * kb; mob.vz -= Math.cos(p.yaw) * 0.5 * kb; p.sprinting = false; }
      p.addExhaustion(0.1);
      if (def && def.tool) this.damageTool(def.tool.type === 'sword' ? 1 : 2);
    }
  }

  facingIndex() {
    const p = this.player;
    const lx = Math.sin(p.yaw), lz = -Math.cos(p.yaw);
    if (Math.abs(lx) > Math.abs(lz)) return lx > 0 ? 1 : 3;
    return lz > 0 ? 2 : 0;
  }

  use() {
    const p = this.player, w = this.world;
    const held = p.inventory.held;
    const def = held && ITEMS[held.id];

    if (this.targetEntity) {
      if (this.targetEntity.mirror && this.net && this.net.isGuest && this.net.useMirror(this.targetEntity, held)) { this.startSwing(); return; }
      const res = this.targetEntity.interact(this, held);
      if (res) {
        this.startSwing();
        if (res === 'damage_tool') this.damageTool(1);
        if (res === 'consume' && !p.creative) p.inventory.useHeld();
        return;
      }
    }
    const hit = this.target;
    // workstations, containers, doors, beds
    if (hit && !p.sneaking && this.useBlock(hit, held)) return;
    if (!held) return;
    if (this.useItemFirst(held, hit)) return;

    // wear armor
    if (def.armor) {
      const slot = 36 + def.armor.slot;
      const cur = p.inventory.get(slot);
      p.inventory.set(slot, held);
      p.inventory.held = cur;
      this.audio.material('metal', 'place', p.x, p.y + 1, p.z);
      this.advance('armor');
      return;
    }
    // throwables
    if (held.id === I.egg || held.id === I.snowball) {
      const [dx, dy, dz] = this.lookDir();
      const [ex, ey, ez] = this.eyePos();
      this.entities.push(new Projectile(held.id === I.egg ? 'egg' : 'snowball', ex + dx * 0.3, ey - 0.1, ez + dz * 0.3, dx * 1.5, dy * 1.5 + 0.1, dz * 1.5, p, 0));
      if (!p.creative) p.inventory.useHeld();
      this.audio.play('throw', p.x, p.y + 1.5, p.z, 0.6);
      this.startSwing();
      return;
    }
    // buckets
    if (held.id === I.bucket) {
      const [ex, ey, ez] = this.eyePos();
      const [dx, dy, dz] = this.lookDir();
      const lh = raycast(w, ex, ey, ez, dx, dy, dz, p.creative ? REACH_CREATIVE : REACH_SURVIVAL, { liquids: true });
      if (lh && isLiquid(lh.id) && (w.getMeta(lh.x, lh.y, lh.z) & 15) === 0) {
        w.setBlock(lh.x, lh.y, lh.z, 0, 0);
        this.audio.play(lh.id === B.water ? 'splash' : 'fizz', lh.x + 0.5, lh.y + 0.5, lh.z + 0.5, 0.5);
        if (!p.creative) this.replaceHeld({ id: lh.id === B.water ? I.water_bucket : I.lava_bucket, count: 1 });
        this.startSwing();
      }
      return;
    }
    if (!hit) return;

    const tool = def.tool;
    // till soil and make paths
    if (tool && (tool.type === 'hoe' || tool.type === 'shovel') && hit.face !== 1) {
      const above = w.getBlock(hit.x, hit.y + 1, hit.z);
      if (!above || REPLACEABLE[above] && !isLiquid(above)) {
        let to = 0;
        if (tool.type === 'hoe' && (hit.id === B.grass || hit.id === B.dirt || hit.id === B.dirt_path || hit.id === B.snowy_grass)) to = B.farmland;
        if (tool.type === 'shovel' && (hit.id === B.grass || hit.id === B.snowy_grass || hit.id === B.dirt)) to = B.dirt_path;
        if (to) {
          if (above) w.setBlock(hit.x, hit.y + 1, hit.z, 0, 0);
          w.setBlock(hit.x, hit.y, hit.z, to, 0);
          this.audio.blockSound(B.dirt, 'place', hit.x + 0.5, hit.y + 1, hit.z + 0.5);
          this.damageTool(1); this.startSwing();
          return;
        }
      }
    }
    // plant crops
    if (def.plants && hit.id === B.farmland && hit.face === 0 && !w.getBlock(hit.x, hit.y + 1, hit.z)) {
      w.setBlock(hit.x, hit.y + 1, hit.z, def.plants, 0);
      this.audio.blockSound(B.grass, 'place', hit.x + 0.5, hit.y + 1, hit.z + 0.5);
      if (!p.creative) p.inventory.useHeld();
      this.startSwing();
      this.advance('farm');
      return;
    }
    // bone meal speeds growth
    if (held.id === I.bone_meal && this.bonemeal(hit)) {
      if (!p.creative) p.inventory.useHeld();
      this.startSwing();
      return;
    }
    // light a rift portal or a blast crate
    if (held.id === I.flint_and_steel) {
      const cx = hit.x + hit.nx, cy = hit.y + hit.ny, cz = hit.z + hit.nz;
      if (tryLightPortal(w, cx, cy, cz)) {
        this.audio.play('portal', cx + 0.5, cy + 0.5, cz + 0.5);
        this.damageTool(1); this.startSwing();
      } else {
        if (!this.placeFire(cx, cy, cz)) this.audio.play('ignite', cx + 0.5, cy + 0.5, cz + 0.5, 0.6);
        this.damageTool(1); this.startSwing();
      }
      return;
    }

    // placement position: into a replaceable target, or against the hit face
    let tx = hit.x, ty = hit.y, tz = hit.z;
    const targetId = hit.id;
    let into = REPLACEABLE[targetId] && !isLiquid(targetId);
    // stacking a slab onto a matching slab makes a full block
    if (isBlockItem(held.id) && BLOCKS[held.id].orient === 'slab') {
      const full = { [B.oak_slab]: B.oak_planks, [B.cobblestone_slab]: B.cobblestone, [B.stone_slab]: B.stone }[held.id];
      const m = w.getMeta(hit.x, hit.y, hit.z);
      if (targetId === held.id && ((hit.face === 0 && !(m & 1)) || (hit.face === 1 && (m & 1)))) {
        w.setBlock(hit.x, hit.y, hit.z, full, 0);
        this.audio.blockSound(full, 'place', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        if (!p.creative) p.inventory.useHeld();
        this.startSwing();
        return;
      }
      const nx = hit.x + hit.nx, ny = hit.y + hit.ny, nz = hit.z + hit.nz;
      if (w.getBlock(nx, ny, nz) === held.id) {
        w.setBlock(nx, ny, nz, full, 0);
        if (!p.creative) p.inventory.useHeld();
        this.startSwing();
        return;
      }
    }
    if (!into) { tx += hit.nx; ty += hit.ny; tz += hit.nz; }
    if (ty < 0 || ty >= HEIGHT) return;
    const cur = w.getBlock(tx, ty, tz);
    if (cur && !REPLACEABLE[cur]) return;

    if (def.places !== undefined) {
      // water / lava bucket
      if (this.dim === 'underworld' && def.places === B.water) {
        this.audio.play('fizz', tx + 0.5, ty + 0.5, tz + 0.5);
        for (let i = 0; i < 8; i++) this.particles.smoke(tx + Math.random(), ty + Math.random(), tz + Math.random());
      } else {
        w.setBlock(tx, ty, tz, def.places, 0);
        this.fluids.schedule(tx, ty, tz, this.tickCount);
        this.audio.play('splash', tx + 0.5, ty + 0.5, tz + 0.5, 0.4);
      }
      if (!p.creative) this.replaceHeld({ id: I.bucket, count: 1 });
      this.startSwing();
      return;
    }
    if (this.placeSpecial(held, hit, tx, ty, tz)) return;
    if (!isBlockItem(held.id)) return;
    const id = held.id;
    if (id === B.oak_door || id === B.bed) { if (this.placeDouble(id, tx, ty, tz)) { if (!p.creative) p.inventory.useHeld(); this.startSwing(); } return; }
    const meta = this.placementMeta(id, hit, tx, ty, tz);
    if (meta < 0) return;
    if (!this.canSurvive(id, meta, tx, ty, tz)) return;
    if (SOLID[id] && !this.spaceFree(tx, ty, tz, 1)) return;
    w.setBlock(tx, ty, tz, id, meta);
    this.audio.blockSound(id, 'place', tx + 0.5, ty + 0.5, tz + 0.5);
    this.startSwing();
    if (!p.creative) p.inventory.useHeld();
    if (id === B.carved_pumpkin || id === B.jack_o_lantern) this.tryBuildGolem(tx, ty, tz);
  }

  // Is the block space free of the player and creatures?
  spaceFree(x, y, z, h) {
    const p = this.player;
    const bb = [x, y, z, x + 1, y + h, z + 1];
    if (p.intersects(...bb) && !p.spectator) return false;
    for (const e of this.entities) if (e instanceof Mob && !e.dead && e.intersects(...bb)) return false;
    return true;
  }

  // Doors and beds take two blocks.
  placeDouble(id, x, y, z) {
    const w = this.world;
    const f = this.facingIndex();
    const free = (bx, by, bz) => { const c = w.getBlock(bx, by, bz); return !c || (REPLACEABLE[c] && !isLiquid(c)); };
    if (id === B.oak_door) {
      if (!free(x, y + 1, z) || !OPAQUE[w.getBlock(x, y - 1, z)]) return false;
      if (!this.spaceFree(x, y, z, 2)) return false;
      // hinge on the right when a door already stands to the left
      const [lx, lz] = DIRS[(f + 3) % 4];
      const hinge = w.getBlock(x + lx, y, z + lz) === B.oak_door ? DOOR_RIGHT : 0;
      w.setBlock(x, y, z, B.oak_door, f | hinge);
      w.setBlock(x, y + 1, z, B.oak_door, f | hinge | DOOR_UPPER);
      this.audio.blockSound(id, 'place', x + 0.5, y + 0.5, z + 0.5);
      return true;
    }
    const [dx, dz] = DIRS[f];
    const hx = x + dx, hz = z + dz;
    if (!free(hx, y, hz) || !SOLID[w.getBlock(x, y - 1, z)] || !SOLID[w.getBlock(hx, y - 1, hz)]) return false;
    if (!this.spaceFree(x, y, z, 1) || !this.spaceFree(hx, y, hz, 1)) return false;
    w.setBlock(x, y, z, B.bed, f);
    w.setBlock(hx, y, hz, B.bed, f | BED_HEAD);
    this.audio.blockSound(id, 'place', x + 0.5, y + 0.5, z + 0.5);
    return true;
  }

  // Right-click behaviour of interactive blocks; true when handled.
  useBlock(hit, held) {
    const w = this.world, p = this.player;
    const key = `${hit.x},${hit.y},${hit.z}`;
    switch (hit.id) {
      case B.crafting_table: this.ui.openScreen('crafting'); return true;
      case B.furnace: case B.furnace_lit:
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newFurnace());
        this.ui.openScreen('furnace', { key, be: w.blockEntities.get(key) });
        return true;
      case B.chest:
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newChest());
        this.audio.play('chest_open', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        this.ui.openScreen('chest', { key, be: w.blockEntities.get(key) });
        return true;
      case B.enchanting_table:
        this.ui.openScreen('enchant', { x: hit.x, y: hit.y, z: hit.z, shelves: this.countShelves(hit.x, hit.y, hit.z) });
        return true;
      case B.tnt:
        if (held && held.id === I.flint_and_steel) {
          w.setBlock(hit.x, hit.y, hit.z, 0, 0);
          this.entities.push(new PrimedCrate(hit.x, hit.y, hit.z));
          this.audio.play('fuse', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
          this.damageTool(1); this.startSwing();
          return true;
        }
        return false;
      case B.oak_door: {
        const m = w.getMeta(hit.x, hit.y, hit.z);
        const oy = m & DOOR_UPPER ? hit.y - 1 : hit.y + 1;
        const nm = m ^ DOOR_OPEN;
        w.setBlock(hit.x, hit.y, hit.z, B.oak_door, nm, { notify: false });
        if (w.getBlock(hit.x, oy, hit.z) === B.oak_door) w.setBlock(hit.x, oy, hit.z, B.oak_door, w.getMeta(hit.x, oy, hit.z) ^ DOOR_OPEN, { notify: false });
        this.audio.play(nm & DOOR_OPEN ? 'door_open' : 'door_close', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        return true;
      }
      case B.oak_fence_gate: {
        let m = w.getMeta(hit.x, hit.y, hit.z) ^ 4;
        // open away from the player
        if (m & 4) m = (m & ~3) | this.facingIndex();
        w.setBlock(hit.x, hit.y, hit.z, B.oak_fence_gate, m, { notify: false });
        this.audio.play(m & 4 ? 'door_open' : 'door_close', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.7);
        return true;
      }
      case B.bed:
        this.sleepInBed(hit.x, hit.y, hit.z);
        return true;
      default:
        return this.useBlockExtra(hit, held);
    }
  }

  countShelves(x, y, z) {
    let n = 0;
    for (let dy = 0; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
      if (this.world.getBlock(x + dx, y + dy, z + dz) === B.bookshelf) n++;
    }
    return n;
  }

  bonemeal(hit) {
    const w = this.world;
    const id = hit.id;
    const puff = (x, y, z) => { for (let i = 0; i < 8; i++) this.particles.add({ x: x + Math.random(), y: y + Math.random() * 0.8, z: z + Math.random(), vx: 0, vy: 0.4, vz: 0, size: 0.07, layer: TEX.p_spark, r: 0.5, g: 1, b: 0.5, life: 0.8, fullbright: true, collide: false }); };
    if (id === B.wheat || id === B.carrots || id === B.potatoes) {
      const m = w.getMeta(hit.x, hit.y, hit.z);
      if ((m & 7) >= 7) return false;
      w.setBlock(hit.x, hit.y, hit.z, id, Math.min(7, (m & 7) + 2 + Math.floor(Math.random() * 4)));
      puff(hit.x, hit.y, hit.z);
      return true;
    }
    if (id === B.oak_sapling || id === B.birch_sapling || id === B.spruce_sapling) {
      puff(hit.x, hit.y, hit.z);
      if (Math.random() < 0.45) this.growTree(hit.x, hit.y, hit.z, id);
      return true;
    }
    if (id === B.grass && hit.face === 0) {
      for (let i = 0; i < 24; i++) {
        const x = hit.x + Math.floor(Math.random() * 7) - 3, z = hit.z + Math.floor(Math.random() * 7) - 3;
        for (let y = hit.y + 2; y >= hit.y - 2; y--) {
          if (w.getBlock(x, y, z) === B.grass && !w.getBlock(x, y + 1, z)) {
            const r = Math.random();
            w.setBlock(x, y + 1, z, r < 0.8 ? B.tall_grass : r < 0.9 ? B.dandelion : B.poppy, 0);
            break;
          }
        }
      }
      puff(hit.x, hit.y + 1, hit.z);
      return true;
    }
    return false;
  }

  replaceHeld(stack) {
    const p = this.player;
    const held = p.inventory.held;
    if (held.count > 1) {
      held.count--;
      const left = p.inventory.give(stack);
      if (left) this.dropItem(p.x, p.y + 1.2, p.z, { ...stack, count: left });
    } else p.inventory.held = stack;
  }

  // Orientation metadata for a block being placed, or -1 if impossible.
  placementMeta(id, hit, x, y, z) {
    const b = BLOCKS[id];
    const face = REPLACEABLE[hit.id] && !isLiquid(hit.id) ? 0 : hit.face;
    const frac = hit.hy - Math.floor(hit.hy);
    const upper = face === 1 || (face >= 2 && frac > 0.5);
    const extra = this.placementMetaExtra(b, hit, face);
    if (extra !== undefined) return extra;
    if (b.orient === 'axis') return face === 2 || face === 3 ? 1 : face === 4 || face === 5 ? 2 : 0;
    if (b.orient === 'facing') {
      // front faces the player
      const f = this.facingIndex();
      return [4, 3, 5, 2][f];
    }
    if (b.orient === 'stairs') return this.facingIndex() | (upper ? 4 : 0);
    if (b.orient === 'slab') return upper ? 1 : 0;
    if (b.orient === 'facing4') return this.facingIndex();
    if (b.orient === 'torch') {
      if (face === 0) return 0;
      if (face === 1) return -1;
      return { 2: 1, 3: 2, 4: 3, 5: 4 }[face];
    }
    if (b.orient === 'wall') {
      if (face < 2) {
        return [3, 2, 4, 1][this.facingIndex()];
      }
      return { 2: 1, 3: 2, 4: 3, 5: 4 }[face];
    }
    if (b.name.endsWith('leaves')) return 1; // player-placed leaves never decay
    return 0;
  }

  // Support rules for plants, torches, ladders, cacti, sugar cane and crops.
  canSurvive(id, meta, x, y, z) {
    const w = this.world;
    const b = BLOCKS[id];
    const below = w.getBlock(x, y - 1, z);
    const extra = this.canSurviveExtra(b, meta, x, y, z);
    if (extra !== undefined) return extra;
    switch (b.support) {
      case 'ground':
        if (id === B.brown_mushroom || id === B.red_mushroom) return OPAQUE[below] === 1;
        return GRASS_OK.has(below);
      case 'farmland': return below === B.farmland;
      case 'underworld': return below === B.scorchstone || below === B.cinder_sand || below === B.magma_rock || below === B.ember_bricks || GRASS_OK.has(below);
      case 'sand': return below === B.sand || GRASS_OK.has(below);
      case 'cane': {
        if (below === B.sugar_cane) return true;
        if (!(GRASS_OK.has(below) || below === B.sand)) return false;
        for (const [dx, , dz] of DIR6) if ((dx || dz) && w.getBlock(x + dx, y - 1, z + dz) === B.water) return true;
        return false;
      }
      case 'cactus': {
        if (below !== B.cactus && below !== B.sand) return false;
        for (const [dx, , dz] of DIR6) if ((dx || dz) && SOLID[w.getBlock(x + dx, y, z + dz)]) return false;
        return true;
      }
      case 'torch': {
        const m = meta & 7;
        if (m === 0) return SOLID[below] === 1 && (RENDER_TYPE[below] === RENDER.CUBE || below === B.oak_fence || below === B.cobblestone_slab || below === B.stone_slab || below === B.oak_slab);
        const [dx, dz] = [[-1, 0], [1, 0], [0, -1], [0, 1]][m - 1];
        return OPAQUE[w.getBlock(x + dx, y, z + dz)] === 1;
      }
      case 'wall': {
        const m = (meta & 7) || 1;
        const [dx, dz] = [[-1, 0], [1, 0], [0, -1], [0, 1]][m - 1];
        return OPAQUE[w.getBlock(x + dx, y, z + dz)] === 1;
      }
      default: return true;
    }
  }

  pickBlock() {
    const hit = this.target;
    if (!hit) return;
    let id = hit.id;
    if (id === B.furnace_lit) id = B.furnace;
    if (!ITEMS[id]) return;
    const inv = this.player.inventory;
    for (let i = 0; i < 9; i++) if (inv.get(i) && inv.get(i).id === id) { inv.selected = i; return; }
    if (this.player.creative) {
      let slot = inv.selected;
      if (inv.get(slot)) for (let i = 0; i < 9; i++) if (!inv.get(i)) { slot = i; break; }
      inv.set(slot, { id, count: maxStack(id) });
      inv.selected = slot;
      return;
    }
    for (let i = 9; i < 36; i++) {
      if (inv.get(i) && inv.get(i).id === id) {
        const t = inv.get(inv.selected);
        inv.set(inv.selected, inv.get(i));
        inv.set(i, t);
        return;
      }
    }
  }

  dropHeld(all) {
    const p = this.player;
    const held = p.inventory.held;
    if (!held || p.dead) return;
    const n = all ? held.count : 1;
    const stack = { ...held, count: n };
    held.count -= n;
    if (held.count <= 0) p.inventory.held = null;
    this.throwStack(stack);
    this.startSwing();
  }

  throwStack(stack) {
    const p = this.player;
    const [dx, dy, dz] = this.lookDir();
    const it = this.dropItem(p.x, p.y + p.eye - 0.3, p.z, stack);
    it.vx = dx * 0.3 + (Math.random() - 0.5) * 0.02; it.vy = dy * 0.3 + 0.1; it.vz = dz * 0.3 + (Math.random() - 0.5) * 0.02;
    it.pickupDelay = 40;
  }

  dropItem(x, y, z, stack, scatter = false) {
    const it = new ItemEntity(x, y, z, { ...stack });
    if (scatter) {
      it.vx = (Math.random() - 0.5) * 0.2; it.vy = 0.2; it.vz = (Math.random() - 0.5) * 0.2;
      it.x += (Math.random() - 0.5) * 0.3; it.z += (Math.random() - 0.5) * 0.3;
    }
    this.items.push(it);
    return it;
  }

  // ---------------------------------------------------------------------------
  tickEntities() {
    const p = this.player;
    const net = this.net;
    if (net && net.isGuest) net.tickMirrors();
    for (const e of this.entities) {
      if (e.mirror && !e.claimed) continue;
      if (net && net.isHost && net.controlled.has(e.id)) continue; // a guest is driving it
      const far = (net ? this.nearestPlayerDist(e.x, e.z) : Math.hypot(e.x - p.x, e.z - p.z)) > 110;
      if (far && !e.hostile && !e.isWyrm) { e.savePrev(); continue; }
      // the wyrm flies on over unloaded land; everything else waits for its chunk
      if (!e.isWyrm && !this.world.chunkReady(Math.floor(e.x) >> 4, Math.floor(e.z) >> 4)) { e.savePrev(); continue; }
      e.tick(this);
      if (e instanceof Mob && !e.dead && this.world.getBlock(Math.floor(e.x), Math.floor(e.y + 0.1), Math.floor(e.z)) === B.fire && !e.def.fireproof) e.fire = Math.max(e.fire, 160);
    }
    for (const it of this.items) {
      if (it.mirror) continue;
      if (!this.world.chunkReady(Math.floor(it.x) >> 4, Math.floor(it.z) >> 4)) { it.savePrev(); continue; }
      it.tick(this);
      if (!it.removed && !it.pickedBy && it.pickupDelay === 0 && !p.dead && !p.spectator &&
        Math.abs(it.x - p.x) < 1.3 && it.y > p.y - 0.8 && it.y < p.y + 2.3 && Math.abs(it.z - p.z) < 1.3) {
        const before = it.stack.count;
        const left = p.inventory.give(it.stack);
        if (left < before) {
          this.audio.play('pop', it.x, it.y, it.z, 0.4);
          this.onPickup(it.stack.id);
          if (left === 0) { it.pickedBy = p; it.pickupTick = 0; }
          else it.stack.count = left;
        }
      }
    }
    for (const o of this.orbs) o.tick(this);
    if (net && net.isHost) net.hostPickups();
    this.entities = this.entities.filter((e) => !e.removed);
    this.items = this.items.filter((e) => !e.removed);
    this.orbs = this.orbs.filter((e) => !e.removed);
  }

  // ---------------------------------------------------------------------------
  onChunkGenerated(c, spawns, chests = [], spawners = []) {
    if (this.demo || (this.net && this.net.isGuest)) return;
    for (const s of spawns) {
      if (s.type === 'pylon') { if (this.meta.voidBoss !== 'dead') this.spawnPylon(s); continue; }
      if (this.entities.length > 220) break;
      const home = s.type === 'settler' || s.home ? { x: s.x, y: s.y, z: s.z } : null;
      const mob = new Mob(s.type, s.x, s.y, s.z, { profession: s.profession, home, persistent: !!s.persistent });
      if (!boxFree(this.world, mob.x, mob.y, mob.z, mob.w, mob.h) && mob.h > 2) mob.y = Math.ceil(mob.y);
      this.entities.push(mob);
    }
    const w = this.world;
    for (const ch of chests) {
      const key = `${ch.x},${ch.y},${ch.z}`;
      if (w.blockEntities.has(key)) continue;
      if (ch.loot === 'trap') { // an arrow trap's dispenser
        const be = { type: 'dispenser', slots: new Array(9).fill(null) };
        be.slots[0] = { id: I.arrow, count: 16 + Math.floor(Math.random() * 16) };
        w.blockEntities.set(key, be);
      } else w.blockEntities.set(key, { type: 'chest', slots: rollLoot(ch.loot) });
    }
    for (const sp of spawners) {
      const key = `${sp.x},${sp.y},${sp.z}`;
      if (!w.blockEntities.has(key)) w.blockEntities.set(key, { type: 'spawner', mob: sp.mob, delay: 60 });
    }
  }

  // Milestones for reaching the new biomes and a tide citadel.
  tickExplorer() {
    if (this.tickCount % 40 !== 7 || this.dim !== 'overworld' || !this.world.gen.biomeAt) return;
    const p = this.player, g = this.world.gen;
    const bio = g.biomeAt(Math.floor(p.x), Math.floor(p.z));
    if (bio === BIOME.JUNGLE || bio === BIOME.BADLANDS || bio === BIOME.MUSHROOM_FIELDS) this.advance('biome');
    if (this.tickCount % 200 === 7 && g.landmarks && (bio === BIOME.DEEP_OCEAN || bio === BIOME.OCEAN)) {
      const c = g.landmarks.locate('tide_citadel', p.x, p.z, 1);
      if (c && Math.hypot(c.x - p.x, c.z - p.z) < 40) this.advance('citadel');
    }
  }

  tickSpawning() {
    if (this.tickCount % 20 !== 0) return;
    // spawn around a random player; despawn far from all of them
    const all = this.players();
    const p = all[Math.floor(Math.random() * all.length)];
    for (const e of this.entities) {
      if (!e.hostile || e.persistent) continue;
      const d = this.net ? this.nearestPlayerDist(e.x, e.z) : Math.hypot(e.x - p.x, e.z - p.z);
      if (d > 128 || (d > 40 && Math.random() < 0.02)) e.removed = true;
    }
    if (this.settings.peaceful) { for (const e of this.entities) if (e.hostile) e.removed = true; return; }
    const hostile = this.entities.reduce((n, e) => n + (e.hostile ? 1 : 0), 0);
    const under = this.dim === 'underworld';
    if (this.dim === 'void') { this.spawnVoidMobs(hostile); return; }
    if (hostile >= (under ? 14 : 18)) return;
    const dayL = under ? 0 : daylight(this.dayTime, this.rain);
    const darken = Math.round((1 - dayL) * 11);
    const w = this.world;
    for (let attempt = 0; attempt < 4; attempt++) {
      const a = Math.random() * Math.PI * 2, d = 24 + Math.random() * 40;
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      let y;
      if (under) {
        y = 33 + Math.floor(Math.random() * 80);
        while (y > 32 && !SOLID[w.getBlock(x, y - 1, z)]) y--;
      } else if (Math.random() < 0.5) y = w.surfaceY(x, z);
      else {
        y = 5 + Math.floor(Math.random() * Math.max(1, w.surfaceY(x, z) - 8));
        while (y > 1 && !SOLID[w.getBlock(x, y - 1, z)]) y--;
      }
      if (y < 1) continue;
      const below = w.getBlock(x, y - 1, z);
      if (!SOLID[below] || !OPAQUE[below] || below === B.bedrock) continue;
      if (SOLID[w.getBlock(x, y, z)] || SOLID[w.getBlock(x, y + 1, z)] || isLiquid(w.getBlock(x, y, z))) continue;
      const l = w.getLight(x, y, z);
      const sky = l >> 4, bl = l & 15;
      if (under ? bl > 11 : (bl > 0 || sky - darken > 4)) continue;
      if (Math.hypot(x + 0.5 - p.x, y - p.y, z + 0.5 - p.z) < 24) continue;
      if (this.net && this.nearestPlayerDist(x + 0.5, z + 0.5) < 24) continue;
      const r = Math.random();
      let type = under ? (r < 0.75 ? 'imp' : 'archer') : (r < 0.47 ? 'ghoul' : r < 0.74 ? 'archer' : r < 0.97 ? 'crawler' : 'gloamer');
      if (!under && y >= w.surfaceY(x, z) - 1) {
        const bio = w.gen.biomeAt(x, z);
        if (bio === BIOME.MUSHROOM_FIELDS) continue; // the mushroom fields are peaceful
        if (Math.random() < 0.3 && bio === BIOME.SWAMP) type = 'hexer';
      }
      const opts = {};
      if ((type === 'ghoul' || type === 'archer') && Math.random() < 0.06) opts.armor = [Math.random() < 0.5 ? I.iron_helmet : I.leather_helmet, Math.random() < 0.3 ? I.iron_chestplate : null, null, null];
      const mob = new Mob(type, x + 0.5, y, z + 0.5, opts);
      if (!boxFree(w, mob.x, mob.y, mob.z, mob.w, mob.h)) continue;
      this.entities.push(mob);
    }
  }

  // The Void: gloamers wander the duskstone.
  spawnVoidMobs(count) {
    if (count >= 12) return;
    const p = this.player, w = this.world;
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = Math.random() * Math.PI * 2, d = 24 + Math.random() * 40;
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      const y = w.surfaceY(x, z);
      if (y < 2 || w.getBlock(x, y - 1, z) !== B.duskstone) continue;
      const mob = new Mob('gloamer', x + 0.5, y, z + 0.5);
      if (!boxFree(w, mob.x, mob.y, mob.z, mob.w, mob.h)) continue;
      this.entities.push(mob);
    }
  }

  // Dungeon spawners release creatures while the player is near.
  tickSpawners() {
    const p = this.player, w = this.world;
    for (const [key, be] of w.blockEntities) {
      if (be.type !== 'spawner') continue;
      const [x, y, z] = key.split(',').map(Number);
      if (Math.abs(x - p.x) > 16 || Math.abs(y - p.y) > 16 || Math.abs(z - p.z) > 16) continue;
      if (w.getBlock(x, y, z) !== B.spawner) { w.blockEntities.delete(key); continue; }
      if (Math.random() < 0.3) { this.particles.flame(x + Math.random(), y + Math.random(), z + Math.random()); this.particles.smoke(x + Math.random(), y + 1, z + Math.random()); }
      if (--be.delay > 0 || this.settings.peaceful) continue;
      be.delay = 200 + Math.floor(Math.random() * 600);
      const near = this.entities.filter((e) => e.type === be.mob && Math.abs(e.x - x) < 9 && Math.abs(e.z - z) < 9).length;
      if (near >= 6) continue;
      const n = 1 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const sx = x + 0.5 + (Math.random() - 0.5) * 8, sz = z + 0.5 + (Math.random() - 0.5) * 8, sy = y + Math.floor(Math.random() * 3) - 1;
        if (!SOLID[w.getBlock(Math.floor(sx), sy - 1, Math.floor(sz))]) continue;
        const mob = new Mob(be.mob, sx, sy, sz);
        if (!boxFree(w, mob.x, mob.y, mob.z, mob.w, mob.h)) continue;
        this.entities.push(mob);
        this.particles.poof(sx, sy, sz, 0.3, 1);
      }
    }
  }

  // Thunderstorms and lightning.
  tickWeather() {
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.08);
    if (this.dim !== 'overworld' || this.rain < 0.8 || !this.thunder) return;
    if (Math.random() > 1 / 260) return;
    const p = this.player;
    const x = Math.floor(p.x + (Math.random() - 0.5) * 96), z = Math.floor(p.z + (Math.random() - 0.5) * 96);
    const y = this.world.rainHeight(x, z);
    if (y < 0) return;
    this.strike(x + 0.5, y + 1, z + 0.5);
  }

  strike(x, y, z) {
    const p = this.player;
    this.entities.push(new Lightning(x, y, z));
    this.flash = 1;
    if (Math.random() < 0.5) this.placeFire(Math.floor(x), Math.floor(y), Math.floor(z));
    const d = Math.hypot(p.x - x, p.z - z);
    setTimeout(() => this.audio.play('thunder', p.x + (x - p.x) * 0.2, p.y, p.z + (z - p.z) * 0.2, Math.max(0.3, 1 - d / 200)), Math.min(3000, d * 8));
    for (const e of [p, ...this.entities]) {
      if (!(e instanceof Mob) && e !== p) continue;
      if (Math.hypot(e.x - x, e.y - y, e.z - z) < 3) {
        if (e === p) { p.damage(this, 5, 'lightning'); p.fireTicks = 80; } else { e.hurt(this, 5, undefined, undefined, 'lightning'); e.fire = 100; }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Portals between dimensions
  tickPortal() {
    const p = this.player;
    if (p.portalCooldown > 0) p.portalCooldown--;
    if (p.dead || this.state !== 'playing') return;
    if (this.net && this.net.isGuest) {
      if (p.touching(this.world, B.rift) && this.tickCount % 60 === 0) this.ui.message('Only the host can travel between worlds. Everyone follows them.', '#c8b8f0');
      return;
    }
    const inRift = p.touching(this.world, B.rift);
    if (inRift) {
      p.portalTicks++;
      if (p.portalTicks % 20 === 1) this.audio.play('portal_hum', p.x, p.y + 1, p.z, 0.6);
      if (p.portalCooldown > 0) { p.portalTicks = 0; p.portalCooldown = 20; return; }
      if (p.portalTicks >= (p.creative ? 2 : 80)) {
        p.portalTicks = 0;
        p.portalCooldown = 100;
        const to = this.dim === 'overworld' ? 'underworld' : 'overworld';
        const k = to === 'underworld' ? 1 / 8 : 8;
        this.travel(to, p.x * k, p.y, p.z * k, true);
      }
    } else p.portalTicks = Math.max(0, p.portalTicks - 4);
  }

  get portalProgress() { return Math.min(1, this.player.portalTicks / (this.player.creative ? 2 : 80)); }

  async travel(to, x, y, z, viaPortal) {
    await this.save();
    const p = this.player;
    this.state = 'loading';
    this.ui.closeScreen && this.ui.screen && this.ui.closeScreen(true);
    const text = to === 'overworld' ? 'Returning to the Overworld' : `Entering ${DIM_NAMES[to]}`;
    this.ui.showLoading(text, 0);
    this.ui.lastLoadingText = text;
    if (p.vehicle) this.dismount();
    if (this.net && this.net.isHost) this.net.hostTravel(to);
    this.input.exitLock();
    await this.startWorld(this.meta, { dim: to, keepPlayer: true });
    const [lo, hi] = portalLimits(to);
    p.x = p.px = x; p.z = p.pz = z; p.y = p.py = Math.max(lo, Math.min(hi, y));
    p.vx = p.vy = p.vz = 0; p.fallDistance = 0; p.dim = to;
    this.pendingPortal = viaPortal ? { x, y: p.y, z, mode: viaPortal === 'platform' ? 'platform' : 'rift' } : null;
    if (!viaPortal) this.spawnKnown = true;
    if (to === 'underworld') this.advance('underworld');
    if (to === 'void') this.advance('void');
  }

  // Once the destination is loaded, stand in an existing rift or build one.
  resolvePortal() {
    const p = this.player, w = this.world;
    const t = this.pendingPortal;
    if (t.mode === 'platform') {
      if (!w.chunkReady(Math.floor(t.x) >> 4, Math.floor(t.z) >> 4)) return false;
      this.buildVoidPlatform();
      p.x = p.px = 100.5; p.y = p.py = 49; p.z = p.pz = 0.5; p.yaw = Math.PI / 2;
      this.pendingPortal = null; this.spawnKnown = true;
      return true;
    }
    const [lo, hi] = portalLimits(this.dim);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!w.chunkReady((Math.floor(t.x) >> 4) + dx, (Math.floor(t.z) >> 4) + dz)) return false;
    let at = findRift(w, t.x, t.z, 16, this.dim === 'underworld' ? 126 : HEIGHT - 1);
    if (at) at = [at[0] + 0.5, at[1], at[2] + 0.5];
    else at = buildPortal(w, t.x, t.y, t.z, lo, hi);
    p.x = p.px = at[0]; p.y = p.py = at[1]; p.z = p.pz = at[2];
    p.portalCooldown = 100; p.portalTicks = 0;
    this.pendingPortal = null;
    this.spawnKnown = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Sleeping
  isNight() { return (this.dayTime >= 12541 && this.dayTime <= 23458) || this.thunder && this.rain > 0.8; }

  sleepInBed(x, y, z) {
    const w = this.world, p = this.player;
    if (this.dim !== 'overworld') {
      w.setBlock(x, y, z, 0, 0);
      this.explode(x + 0.5, y + 0.5, z + 0.5, 5);
      return;
    }
    const m = w.getMeta(x, y, z);
    // find the head part
    let hx = x, hz = z;
    if (!(m & BED_HEAD)) { const [dx, dz] = DIRS[m & 3]; hx += dx; hz += dz; }
    p.spawn = { x: hx + 0.5, y: y + 0.6, z: hz + 0.5 };
    p.bed = { x: hx, y, z: hz };
    if (!this.isNight()) { this.ui.message('You can only sleep at night. Respawn point set.', '#e8d48a'); return; }
    if (Math.hypot(p.x - hx - 0.5, p.z - hz - 0.5) > 3) { this.ui.message('You are too far away from the bed.', '#e8d48a'); return; }
    for (const e of this.entities) {
      if (e instanceof Mob && e.hostile && !e.dead && Math.abs(e.x - hx) < 8 && Math.abs(e.y - y) < 5 && Math.abs(e.z - hz) < 8) {
        this.ui.message('You may not rest now; there are monsters nearby.', '#ff9a8a');
        return;
      }
    }
    p.sleeping = 1;
    p.sleepYaw = [Math.PI, Math.PI * 1.5, 0, Math.PI / 2][m & 3];
    p.x = p.px = hx + 0.5; p.z = p.pz = hz + 0.5; p.y = p.py = y + 0.5625;
    p.vx = p.vy = p.vz = 0;
    this.ui.showSleep(true);
  }

  tickSleep() {
    const p = this.player;
    p.sleeping++;
    if (this.net && this.net.isGuest) {
      if (p.sleeping >= 100 && !this.isNight()) this.wakeUp();
      return;
    }
    if (this.net && p.sleeping >= 100 && this.isNight() && this.remotePlayers().some((rp) => !rp.sleeping && !rp.dead)) {
      if (p.sleeping === 100) this.ui.message('Waiting for the other players to sleep…', '#e8d48a');
      return;
    }
    if (p.sleeping >= 100 && this.isNight()) {
      this.dayTime = 0; this.day++;
      this.rainTarget = 0; this.rain = 0; this.thunder = 0;
      this.rainTime = 12000 + Math.floor(Math.random() * 168000);
      this.advance('sleep');
      this.wakeUp();
    } else if (p.sleeping >= 100) this.wakeUp();
  }

  wakeUp() {
    const p = this.player;
    if (!p.sleeping) return;
    p.sleeping = 0;
    if (p.bed) { p.y = p.py = p.bed.y + 0.6; }
    let guard = 0;
    while (!boxFree(this.world, p.x, p.y, p.z, p.w, p.h) && guard++ < 8) { p.y += 1; p.py = p.y; }
    this.ui.showSleep(false);
  }

  // ---------------------------------------------------------------------------
  // Experience, breeding, trading, milestones
  spawnXp(x, y, z, total) {
    while (total > 0) {
      const v = total >= 37 ? 37 : total >= 17 ? 17 : total >= 7 ? 7 : total >= 3 ? 3 : 1;
      total -= v;
      this.orbs.push(new XpOrb(x + (Math.random() - 0.5) * 0.5, y, z + (Math.random() - 0.5) * 0.5, v));
    }
  }

  onMobKilled(mob) {
    if (mob.hostile && mob.lastHitBy === 'player') this.advance('hostile');
  }

  breed(a, b) {
    a.love = b.love = 0;
    a.breedCooldown = b.breedCooldown = 6000;
    const baby = new Mob(a.type, (a.x + b.x) / 2, Math.max(a.y, b.y), (a.z + b.z) / 2, { baby: true });
    baby.growth = BABY_AGE;
    this.entities.push(baby);
    for (let i = 0; i < 7; i++) this.particles.heart(baby.x + (Math.random() - 0.5), baby.y + 0.6 + Math.random() * 0.5, baby.z + (Math.random() - 0.5));
    this.spawnXp(baby.x, baby.y + 0.5, baby.z, 1 + Math.floor(Math.random() * 7));
    this.advance('breed');
  }

  openTrading(mob) {
    if (!mob.trades) mob.trades = makeTrades(mob.profession);
    this.tradingWith = mob;
    this.ui.openScreen('trade', { mob });
    this.audio.mob('settler', 'idle', mob.x, mob.y, mob.z);
  }

  advance(key) {
    if (!this.advancements || this.advancements.has(key) || this.demo) return;
    if (key === 'level' && this.player.xpLevel < 5) return;
    const a = ADVANCEMENTS[key];
    if (!a) return;
    this.advancements.add(key);
    this.ui.toast(a[0], a[1]);
    this.audio.play('advance');
  }

  onPickup(id) {
    if (id === B.oak_log || id === B.birch_log || id === B.spruce_log) this.advance('log');
    else if (id === I.diamond) this.advance('diamond');
  }

  // Taking smelted items out of a furnace gives a little experience.
  onSmelted(id, n) {
    if (n <= 0 || this.demo) return;
    if (id === I.iron_ingot) this.advance('iron');
    const rate = id === I.gold_ingot || id === I.diamond ? 1 : id === I.iron_ingot ? 0.7 : id === I.emerald ? 1 : (ITEMS[id] && ITEMS[id].food) ? 0.35 : 0.15;
    let xp = Math.floor(n * rate);
    if (Math.random() < n * rate - xp) xp++;
    const p = this.player;
    if (xp > 0) this.spawnXp(p.x, p.y + 0.5, p.z, xp);
  }

  onCrafted(id) {
    const n = ITEMS[id] && ITEMS[id].name;
    if (id === B.crafting_table) this.advance('crafting_table');
    else if (n && n.endsWith('_pickaxe')) this.advance('pickaxe');
    else if (id === B.furnace) this.advance('furnace');
    else if (id === I.bread) this.advance('bread');
  }

  // ---------------------------------------------------------------------------
  // Block updates
  onBlockChanged(x, y, z, old, id) {
    if (this.demo || (this.net && this.net.isGuest)) return;
    const w = this.world;
    this.circuits.onBlockChanged(x, y, z, old, id);
    if (id === B.fire) this.fires.add(`${x},${y},${z}`);
    if (isLiquid(id)) this.fluids.schedule(x, y, z, this.tickCount);
    for (const [dx, dy, dz] of DIR6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const nid = w.getBlock(nx, ny, nz);
      if (!nid) continue;
      if (isLiquid(nid)) this.fluids.schedule(nx, ny, nz, this.tickCount);
      if (nid === B.rift) { if (!riftValid(w, nx, ny, nz)) w.setBlock(nx, ny, nz, 0, 0); continue; }
      if (nid === B.oak_door) {
        const m = w.getMeta(nx, ny, nz);
        const partner = w.getBlock(nx, m & DOOR_UPPER ? ny - 1 : ny + 1, nz);
        if (partner !== B.oak_door) { this.breakNaturally(nx, ny, nz); continue; }
        if (!(m & DOOR_UPPER) && !SOLID[w.getBlock(nx, ny - 1, nz)]) this.breakNaturally(nx, ny, nz);
        continue;
      }
      if (nid === B.bed) {
        const m = w.getMeta(nx, ny, nz);
        const [fx, fz] = DIRS[m & 3];
        const sgn = m & BED_HEAD ? -1 : 1;
        if (w.getBlock(nx + fx * sgn, ny, nz + fz * sgn) !== B.bed) { w.setBlock(nx, ny, nz, 0, 0); if (m & BED_HEAD) this.dropItem(nx + 0.5, ny + 0.5, nz + 0.5, { id: B.bed, count: 1 }); }
        continue;
      }
      if (nid === B.farmland && dy === -1 && SOLID[id] && OPAQUE[id]) { w.setBlock(nx, ny, nz, B.dirt, 0); continue; }
      const nb = BLOCKS[nid];
      if (nb.support && !this.canSurvive(nid, w.getMeta(nx, ny, nz), nx, ny, nz)) this.breakNaturally(nx, ny, nz);
    }
    const above = w.getBlock(x, y + 1, z);
    if (BLOCKS[above] && BLOCKS[above].gravity && (id === 0 || REPLACEABLE[id] || isLiquid(id))) this.startFall(x, y + 1, z);
    if (BLOCKS[id] && BLOCKS[id].gravity) {
      const below = w.getBlock(x, y - 1, z);
      if (y > 0 && (below === 0 || isLiquid(below) || (REPLACEABLE[below] && !SOLID[below]))) this.startFall(x, y, z);
    }
    if (old === B.oak_log || old === B.birch_log || old === B.spruce_log) {
      for (let i = 0; i < 12; i++) this.decayQueue.push([x + Math.floor(Math.random() * 9) - 4, y + Math.floor(Math.random() * 7) - 2, z + Math.floor(Math.random() * 9) - 4, this.tickCount + 20 + Math.floor(Math.random() * 200)]);
    }
  }

  startFall(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const meta = this.world.getMeta(x, y, z);
    this.world.setBlock(x, y, z, 0, 0);
    this.entities.push(new FallingBlock(x, y, z, id, meta));
  }

  get decayQueue() { return this._decay || (this._decay = []); }

  randomTicks() {
    const w = this.world;
    const R = 5;
    const done = new Set();
    for (const p of this.players()) {
      const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const c = w.getChunk(pcx + dx, pcz + dz);
        if (!c || c.state !== STATE.READY || done.has(c.key)) continue;
        done.add(c.key);
        const sections = (c.maxY >> 4) + 1;
        for (let s = 0; s < sections; s++) {
          for (let k = 0; k < 3; k++) {
            const r = (Math.random() * 4096) | 0;
            const lx = r & 15, lz = (r >> 4) & 15, ly = (s << 4) | (r >> 8);
            const id = c.blocks[(ly << 8) | (lz << 4) | lx];
            if (id === 0 || id === B.stone) continue;
            this.randomTick(c.cx * 16 + lx, ly, c.cz * 16 + lz, id);
          }
        }
      }
    }
    // scheduled leaf-decay checks
    const q = this.decayQueue;
    if (q.length) {
      let j = 0;
      for (let i = 0; i < q.length; i++) {
        const e = q[i];
        if (e[3] <= this.tickCount) this.checkLeafDecay(e[0], e[1], e[2]);
        else q[j++] = e;
      }
      q.length = j;
    }
  }

  randomTick(x, y, z, id) {
    const w = this.world;
    switch (id) {
      case B.farmland: {
        let wet = false;
        for (let dx = -4; dx <= 4 && !wet; dx++) for (let dz = -4; dz <= 4 && !wet; dz++) for (let dy = 0; dy <= 1; dy++) if (w.getBlock(x + dx, y + dy, z + dz) === B.water) { wet = true; break; }
        const m = w.getMeta(x, y, z);
        if (wet || this.rain > 0.5 && w.rainHeight(x, z) <= y + 1) { if (m !== 7) w.setBlock(x, y, z, B.farmland, 7, { urgent: false }); }
        else if (m > 0) w.setBlock(x, y, z, B.farmland, m - 1, { urgent: false });
        else if (!w.getBlock(x, y + 1, z)) w.setBlock(x, y, z, B.dirt, 0, { urgent: false });
        return;
      }
      case B.wheat: case B.carrots: case B.potatoes: {
        const m = w.getMeta(x, y, z);
        if ((m & 7) >= 7) return;
        const l = w.getLight(x, y, z);
        if ((l >> 4) < 9 && (l & 15) < 9) return;
        const moist = w.getMeta(x, y - 1, z) > 0;
        if (Math.random() < (moist ? 0.34 : 0.15)) w.setBlock(x, y, z, id, (m & 7) + 1, { urgent: false });
        return;
      }
      case B.grass: {
        const above = w.getBlock(x, y + 1, z);
        if (OPAQUE[above] || isLiquid(above)) { w.setBlock(x, y, z, B.dirt, 0, { urgent: false }); return; }
        const tx = x + Math.floor(Math.random() * 3) - 1, ty = y + Math.floor(Math.random() * 5) - 3, tz = z + Math.floor(Math.random() * 3) - 1;
        if (w.getBlock(tx, ty, tz) === B.dirt) {
          const ab = w.getBlock(tx, ty + 1, tz);
          const l = w.getLight(tx, ty + 1, tz);
          if (!OPAQUE[ab] && !isLiquid(ab) && ((l >> 4) >= 9 || (l & 15) >= 9)) w.setBlock(tx, ty, tz, B.grass, 0, { urgent: false });
        }
        return;
      }
      case B.oak_sapling: case B.birch_sapling: case B.spruce_sapling: {
        if (Math.random() > 0.12) return;
        const l = w.getLight(x, y, z);
        if ((l >> 4) < 9 && (l & 15) < 9) return;
        this.growTree(x, y, z, id);
        return;
      }
      case B.sugar_cane: case B.cactus: {
        if (Math.random() > 0.08) return;
        let h = 1;
        while (w.getBlock(x, y - h, z) === id) h++;
        if (h < 3 && w.getBlock(x, y + 1, z) === 0 && this.canSurvive(id, 0, x, y + 1, z)) w.setBlock(x, y + 1, z, id, 0, { urgent: false });
        return;
      }
      case B.oak_leaves: case B.birch_leaves: case B.spruce_leaves: case B.jungle_leaves: case B.dark_oak_leaves:
        if (w.getMeta(x, y, z) === 0 && Math.random() < 0.3) this.checkLeafDecay(x, y, z);
        return;
      case B.ice: {
        const l = w.getLight(x, y, z);
        if ((l & 15) > 11) w.setBlock(x, y, z, B.water, 0);
        return;
      }
      case B.fire: this.fires.add(`${x},${y},${z}`); return;
      case B.lava: {
        // lava sets fire to flammable things around it
        if (Math.random() > 0.3) return;
        const tx = x + Math.floor(Math.random() * 3) - 1, ty = y + 1 + Math.floor(Math.random() * 2), tz = z + Math.floor(Math.random() * 3) - 1;
        if (w.getBlock(tx, ty, tz) === 0) {
          for (const [dx, dy, dz] of DIR6) if (BLOCKS[w.getBlock(tx + dx, ty + dy, tz + dz)].burn > 0) { this.placeFire(tx, ty, tz); break; }
        }
        return;
      }
      case B.daylight_sensor: this.circuits.sensors.add(`${x},${y},${z}`); return;
      default:
        if (BLOCKS[id] && BLOCKS[id].spark) this.circuits.mark(x, y, z);
    }
  }

  checkLeafDecay(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    const LEAVES = [B.oak_leaves, B.birch_leaves, B.spruce_leaves, B.jungle_leaves, B.dark_oak_leaves];
    const LOGS = [B.oak_log, B.birch_log, B.spruce_log, B.jungle_log, B.dark_oak_log];
    if (!LEAVES.includes(id) || w.getMeta(x, y, z) !== 0) return;
    // search through leaves for a log within 6 steps
    const seen = new Set([`${x},${y},${z}`]);
    let frontier = [[x, y, z]];
    for (let d = 0; d < 6; d++) {
      const next = [];
      for (const [cx, cy, cz] of frontier) {
        for (const [dx, dy, dz] of DIR6) {
          const nx = cx + dx, ny = cy + dy, nz = cz + dz;
          const k = `${nx},${ny},${nz}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const nid = w.getBlock(nx, ny, nz);
          if (LOGS.includes(nid)) return;
          if (LEAVES.includes(nid)) next.push([nx, ny, nz]);
        }
      }
      frontier = next;
    }
    this.breakNaturally(x, y, z, true);
    this.particles.blockBreak(x, y, z, id, 0);
  }

  growTree(x, y, z, sapling) {
    const w = this.world;
    const kind = sapling === B.birch_sapling ? 'birch' : sapling === B.spruce_sapling ? 'spruce' : 'oak';
    const hgt = kind === 'spruce' ? 9 : 7;
    for (let dy = 1; dy <= hgt; dy++) {
      const id = w.getBlock(x, y + dy, z);
      if (id && !REPLACEABLE[id] && !BLOCKS[id].name.endsWith('leaves')) return;
    }
    w.setBlock(x, y, z, 0, 0, { notify: false });
    const r = rng(hashSeed(`${x},${y},${z},${this.tickCount}`));
    const ctx = {
      get: (bx, by, bz) => w.getBlock(bx, by, bz),
      set: (bx, by, bz, id, m) => { if (by < HEIGHT && w.chunkReady(bx >> 4, bz >> 4)) w.setBlock(bx, by, bz, id, m, { notify: false }); },
    };
    w.gen.placeTree(ctx, x, y, z, kind, r);
  }

  // ---------------------------------------------------------------------------
  tickFurnaces() {
    const w = this.world;
    for (const [key, be] of w.blockEntities) {
      if (be.type !== 'furnace') continue;
      const [x, y, z] = key.split(',').map(Number);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      const [input, fuel, out] = be.slots;
      const result = input ? SMELTING.get(input.id) : undefined;
      const canSmelt = result !== undefined && (!out || (out.id === result && out.count < maxStack(result)));
      const wasBurning = be.burn > 0;
      if (be.burn > 0) be.burn--;
      if (be.burn === 0 && canSmelt && fuel && fuelValue(fuel.id)) {
        be.burn = be.burnMax = fuelValue(fuel.id);
        if (fuel.id === I.lava_bucket) be.slots[1] = { id: I.bucket, count: 1 };
        else { fuel.count--; if (fuel.count <= 0) be.slots[1] = null; }
      }
      if (be.burn > 0 && canSmelt) {
        be.cook++;
        if (be.cook >= 200) {
          be.cook = 0;
          input.count--; if (input.count <= 0) be.slots[0] = null;
          if (out) out.count++; else be.slots[2] = { id: result, count: 1 };
        }
      } else if (be.cook > 0) be.cook = Math.max(0, be.cook - 2);
      const burning = be.burn > 0;
      if (burning !== wasBurning) {
        const id = w.getBlock(x, y, z);
        if (id === B.furnace || id === B.furnace_lit) w.setBlock(x, y, z, burning ? B.furnace_lit : B.furnace, w.getMeta(x, y, z), { keepEntity: true, notify: false });
      }
      if (burning && Math.random() < 0.1) {
        const m = w.getMeta(x, y, z) || 4;
        const o = [null, null, [1.05, 0], [-0.05, 0], [0, 1.05], [0, -0.05]][m] || [0, 1.05];
        const fx = x + (o[0] || 0.5 + (Math.random() - 0.5) * 0.6), fz = z + (o[1] || 0.5 + (Math.random() - 0.5) * 0.6);
        this.particles.flame(o[0] ? x + o[0] : fx, y + 0.3 + Math.random() * 0.3, o[1] ? z + o[1] : fz);
        if (Math.random() < 0.1) this.audio.play('furnace', x + 0.5, y + 0.5, z + 0.5, 0.5);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Explosions: rays through the blocks with resistance, then damage.
  explode(x, y, z, power, opts = {}) {
    const w = this.world;
    this.particles.explosion(x, y, z);
    this.audio.play('explode', x, y, z);
    const p = this.player;
    const pd = Math.hypot(p.x - x, p.y - y, p.z - z);
    this.shake = Math.max(this.shake, Math.max(0, 1 - pd / 24));
    const destroyed = new Set();
    const resistance = (id) => {
      if (id === B.water || id === B.lava) return 100;
      const h = BLOCKS[id].hardness;
      if (h < 0) return 1e9;
      if (h >= 50) return 1200;
      return h * 4;
    };
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) for (let k = 0; k < 16; k++) {
      if (opts.noBlocks) break;
      if (i && i < 15 && j && j < 15 && k && k < 15) continue;
      let dx = i / 15 * 2 - 1, dy = j / 15 * 2 - 1, dz = k / 15 * 2 - 1;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      let strength = power * (0.7 + Math.random() * 0.6);
      let px = x, py = y, pz = z;
      while (strength > 0) {
        const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
        const id = w.getBlock(bx, by, bz);
        if (id) strength -= (resistance(id) + 0.3) * 0.3;
        if (strength > 0 && id && !isLiquid(id)) destroyed.add(`${bx},${by},${bz}`);
        px += dx * 0.3; py += dy * 0.3; pz += dz * 0.3;
        strength -= 0.225;
      }
    }
    for (const key of destroyed) {
      const [bx, by, bz] = key.split(',').map(Number);
      const id = w.getBlock(bx, by, bz);
      if (!id) continue;
      if (id === B.tnt) {
        w.setBlock(bx, by, bz, 0, 0);
        const pc = new PrimedCrate(bx, by, bz, 10 + Math.floor(Math.random() * 20));
        this.entities.push(pc);
        continue;
      }
      const b = BLOCKS[id];
      w.setBlock(bx, by, bz, 0, 0);
      if (Math.random() < 1 / power) {
        const drops = b.drops ? b.drops(Math.random) : (b.item ? [[id, 1]] : []);
        for (const [did, n] of drops) if (n > 0 && ITEMS[did]) this.dropItem(bx + 0.5, by + 0.5, bz + 0.5, { id: did, count: n }, true);
      }
    }
    // damage and knock back creatures and the player
    const R = power * 2;
    const hurtEnt = (e, isPlayer) => {
      const ex = e.x, ey = e.y + e.h / 2, ez = e.z;
      const d = Math.hypot(ex - x, ey - y, ez - z);
      if (d > R) return;
      const impact = 1 - d / R;
      const dmg = Math.floor((impact * impact + impact) / 2 * 7 * R + 1);
      const l = d || 1;
      e.vx += (ex - x) / l * impact * 1.2; e.vy += (ey - y) / l * impact * 1.2 + 0.2; e.vz += (ez - z) / l * impact * 1.2;
      if (isPlayer) e.damage(this, dmg, 'explosion');
      else if (e.hurt) e.hurt(this, dmg);
    };
    if (!p.dead) hurtEnt(p, true);
    if (this.net) {
      this.net.effect('boom', x, y, z);
      for (const rp of this.remotePlayers()) {
        const d = Math.hypot(rp.x - x, rp.y + 0.9 - y, rp.z - z);
        if (d > R || rp.dead) continue;
        const impact = 1 - d / R;
        rp.damage(this, Math.floor((impact * impact + impact) / 2 * 7 * R + 1), 'explosion', x, z);
      }
    }
    for (const e of this.entities) if (e instanceof Mob) hurtEnt(e, false);
    for (const e of this.entities) if ((e.isCart || e.isBoat) && Math.hypot(e.x - x, e.y - y, e.z - z) < power) e.hit(this, 40);
    for (const e of this.entities) if (e.isPylon && !e.removed && Math.hypot(e.x - x, e.y - y, e.z - z) < power * 1.5) e.hit(this);
    for (const it of this.items) { const d = Math.hypot(it.x - x, it.y - y, it.z - z); if (d < 3) it.removed = true; }
  }

  // ---------------------------------------------------------------------------
  tickAmbient() {
    const p = this.player, w = this.world;
    // torch and lava particles near the player
    if (this.tickCount % 40 === 0) {
      this.torchCache.length = 0;
      const R = 14, px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
      for (let y = py - 8; y <= py + 8; y++) for (let z = pz - R; z <= pz + R; z++) for (let x = px - R; x <= px + R; x++) {
        const id = w.getBlock(x, y, z);
        if (id === B.torch) this.torchCache.push([x, y, z, w.getMeta(x, y, z) & 7]);
        else if (id === B.lava && w.getBlock(x, y + 1, z) === 0 && this.torchCache.length < 600) this.torchCache.push([x, y, z, -1]);
      }
    }
    for (const [x, y, z, m] of this.torchCache) {
      if (m === -1) {
        if (Math.random() < 0.01) {
          this.particles.add({ x: x + Math.random(), y: y + 1, z: z + Math.random(), vx: (Math.random() - 0.5) * 2, vy: 3 + Math.random() * 2, vz: (Math.random() - 0.5) * 2, size: 0.07, layer: TEX.p_flame, life: 1.2, gravity: 9, fullbright: true });
          if (Math.random() < 0.3) this.audio.play('lava_pop', x + 0.5, y + 1, z + 0.5, 0.5);
        }
        continue;
      }
      if (Math.random() > 0.35) continue;
      let fx = x + 0.5, fy = y + 0.72, fz = z + 0.5;
      if (m >= 1 && m <= 4) {
        const [dx, dz] = [[-1, 0], [1, 0], [0, -1], [0, 1]][m - 1];
        fx += dx * 0.27; fz += dz * 0.27; fy += 0.2;
      }
      this.particles.flame(fx, fy, fz);
      if (Math.random() < 0.3) this.particles.smoke(fx, fy + 0.05, fz);
    }
    // rain and snow around the player
    if (this.rain > 0.05 && !p.eyesInWater) {
      const n = Math.floor(this.rain * 14);
      let exposed = 0;
      for (let i = 0; i < n; i++) {
        const rx = p.x + (Math.random() - 0.5) * 24, rz = p.z + (Math.random() - 0.5) * 24;
        const top = w.rainHeight(Math.floor(rx), Math.floor(rz));
        const bio = w.gen.biomeAt(Math.floor(rx), Math.floor(rz));
        const cold = [2, 4, 9, 10, 15, 17].includes(bio) || top > 120;
        if (top < 0) continue;
        const sy = Math.max(top + 1, p.y + 8 + Math.random() * 6);
        if (top + 1 > p.y + 18) continue;
        if (Math.abs(rx - p.x) < 5 && Math.abs(rz - p.z) < 5 && top < p.y + 2) exposed++;
        this.particles.rain(rx, sy, rz, cold);
      }
      this.audio.setRain(this.rain * Math.min(1, 0.3 + exposed * 0.3));
    } else this.audio.setRain(0);
    // occasional cave ambience when deep underground
    if (--this.caveSoundTimer <= 0) {
      this.caveSoundTimer = 1200 + Math.floor(Math.random() * 2400);
      const l = w.getLight(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z));
      if ((l >> 4) === 0 && (l & 15) < 5) this.audio.play('cave', p.x + (Math.random() - 0.5) * 8, p.y, p.z + (Math.random() - 0.5) * 8, 0.8);
    }
    // bubbles while submerged
    if (p.eyesInWater && Math.random() < 0.1) this.particles.bubble(p.x, p.y + p.eye - 0.2, p.z);
    // splash when entering water
    if (p.inWater && !this.wasInWater && p.vy < -0.1) {
      this.particles.splash(p.x, Math.floor(p.y) + 1, p.z, 16);
      this.audio.play('splash', p.x, p.y, p.z, Math.min(1, -p.vy * 2));
    }
    this.wasInWater = p.inWater;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.05);
  }

  sprintParticles(p) {
    const id = this.world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.2), Math.floor(p.z));
    if (!id) return;
    const pt = this.particles.debris(p.x + (Math.random() - 0.5) * 0.5, p.y + 0.1, p.z + (Math.random() - 0.5) * 0.5, -p.vx * 0.2, 0.05, -p.vz * 0.2, BLOCKS[id] ? this.faceLayer(id) : 0, this.particles.tintFor(id, Math.floor(p.x), Math.floor(p.z)));
    pt.size *= 0.7;
  }

  landParticles(p, id, n) {
    for (let i = 0; i < n; i++) {
      const pt = this.particles.debris(p.x + (Math.random() - 0.5) * 0.8, p.y + 0.05, p.z + (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.15, 0.08 + Math.random() * 0.05, (Math.random() - 0.5) * 0.15, this.faceLayer(id), this.particles.tintFor(id, Math.floor(p.x), Math.floor(p.z)));
      pt.size *= 0.8;
    }
  }

  faceLayer(id) { return faceTexture(id, 0, 0); }

  onPlayerDeath() {
    this.ui.showDeath(this.deathMessage());
  }

  deathMessage() {
    const s = this.player.lastDamageSource || '';
    const MOBS = { ghoul: 'a Ghoul', archer: 'a Bone Archer', crawler: 'a Cave Crawler', imp: 'a Cinder Imp', gloamer: 'a Gloamer', wyrm: 'the Void Wyrm' };
    if (s.startsWith('player:')) return `You were slain by ${s.slice(7) || 'another player'}`;
    if (s.startsWith('mob:')) return `You were slain by ${MOBS[s.slice(4)] || 'a creature'}`;
    return {
      fall: 'You hit the ground too hard', drown: 'You drowned', lava: 'You tried to swim in lava',
      fire: 'You burned to death', starve: 'You starved to death', cactus: 'You were pricked to death',
      explosion: 'You were blown up', void: 'You fell out of the world', magma: 'You discovered the floor was hot',
      arrow: 'You were shot by a Bone Archer', lightning: 'You were struck by lightning', kill: 'You died',
      magic: 'You were killed by magic', fly_into_wall: 'You experienced kinetic energy', thrown: 'You were hit by something thrown',
    }[s] || 'You died';
  }

  respawn() {
    const p = this.player;
    // a missing bed means back to the world spawn
    if (p.bed && this.dim === 'overworld' && this.world.getBlock(p.bed.x, p.bed.y, p.bed.z) !== B.bed) {
      p.bed = null;
      this.ui.message('Your bed was missing or blocked.', '#e8d48a');
      if (p.worldSpawn) p.spawn = { ...p.worldSpawn };
    }
    const s = p.spawn || p.worldSpawn || { x: p.x, y: 80, z: p.z };
    p.respawn(s.x, s.y, s.z);
    if (this.dim !== 'overworld') {
      this.travel('overworld', s.x, s.y, s.z, false);
      return;
    }
    this.spawnKnown = true;
    let guard = 0;
    while (!boxFree(this.world, p.x, p.y, p.z, p.w, p.h) && guard++ < 256) p.y += 1;
    p.py = p.y;
  }

  returnCraftingItems() {
    const p = this.player;
    for (const c of [this.craft2, this.craft3, this.enchantSlot, this.anvilSlots, this.loomSlots, this.beaconSlot]) {
      for (let i = 0; i < c.size; i++) {
        const s = c.get(i);
        if (!s) continue;
        const left = p.inventory.give(s);
        if (left) this.dropItem(p.x, p.y + 1.2, p.z, { ...s, count: left });
        c.set(i, null);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Commands typed into chat
  runCommand(text) {
    const [cmd, ...args] = text.trim().replace(/^\//, '').split(/\s+/);
    const p = this.player;
    const num = (v, base) => {
      if (v === undefined) return NaN;
      if (v.startsWith('~')) return base + (v.length > 1 ? parseFloat(v.slice(1)) : 0);
      return parseFloat(v);
    };
    switch ((cmd || '').toLowerCase()) {
      case 'help':
        return `Commands: /time set <day|noon|night|midnight|ticks>, /time add <ticks>, /gamemode <survival|creative>, /tp <x> <y> <z>, /give <item> [count], /summon <${Object.keys(MOB_TYPES).join('|')}>, /weather <clear|rain|thunder>, /xp <amount>[L], /enchant <name> [level], /locate <village|observatory|spire|mineshaft|temple|shrine|hut|citadel|manor>, /dimension <overworld|underworld|void>, /effect <give|clear> [effect] [seconds] [level], /seed, /spawnpoint, /kill, /heal, /clear, /difficulty <peaceful|normal>`;
      case 'time': {
        const named = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };
        if (args[0] === 'set') {
          const v = named[args[1]] ?? parseInt(args[1], 10);
          if (Number.isNaN(v)) return 'Usage: /time set <day|noon|night|midnight|ticks>';
          this.dayTime = ((v % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
          return `Set the time to ${this.dayTime}`;
        }
        if (args[0] === 'add') {
          const v = parseInt(args[1], 10);
          if (Number.isNaN(v)) return 'Usage: /time add <ticks>';
          this.dayTime = (((this.dayTime + v) % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
          return `Added ${v} to the time`;
        }
        return `The time is ${this.dayTime} (day ${this.day})`;
      }
      case 'gamemode': case 'gm': {
        const m = { survival: 'survival', s: 'survival', 0: 'survival', creative: 'creative', c: 'creative', 1: 'creative' }[args[0]];
        if (!m) return 'Usage: /gamemode <survival|creative>';
        p.mode = m;
        if (m === 'survival') p.flying = false;
        return `Game mode set to ${m[0].toUpperCase() + m.slice(1)}`;
      }
      case 'tp': case 'teleport': {
        const x = num(args[0], p.x), y = num(args[1], p.y), z = num(args[2], p.z);
        if ([x, y, z].some(Number.isNaN)) return 'Usage: /tp <x> <y> <z>';
        p.x = p.px = x; p.y = p.py = y; p.z = p.pz = z; p.vx = p.vy = p.vz = 0; p.fallDistance = 0;
        return `Teleported to ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
      }
      case 'give': {
        const id = findItem(args[0]);
        if (id === undefined) return `Unknown item: ${args[0] || ''}`;
        const n = Math.max(1, Math.min(64 * 36, parseInt(args[1] || '1', 10) || 1));
        let left = n;
        while (left > 0) {
          const c = Math.min(left, maxStack(id));
          const rem = p.inventory.give({ id, count: c });
          if (rem) { this.dropItem(p.x, p.y + 1, p.z, { id, count: rem }); }
          left -= c;
        }
        return `Gave ${n} ${itemName(id)}`;
      }
      case 'summon': {
        const t = (args[0] || '').toLowerCase();
        const [dx, , dz] = this.lookDir();
        if (t === 'minecart' || t === 'boat') {
          const V = t === 'minecart' ? Minecart : Boat;
          this.entities.push(new V(p.x + dx * 2, p.y, p.z + dz * 2));
          return `Summoned a ${t}`;
        }
        if (t === 'wyrm') {
          if (this.dim !== 'void') return 'The Void Wyrm only lives in the Void';
          this.meta.voidBoss = 'alive'; this.meta.voidWyrmHealth = 0; this.spawnVoidBoss();
          return 'The Void Wyrm rises';
        }
        if (!MOB_TYPES[t]) return `Usage: /summon <${[...Object.keys(MOB_TYPES), 'minecart', 'boat', 'wyrm'].join('|')}>`;
        const opts = t === 'settler' ? { profession: args[1] || ['farmer', 'smith', 'shepherd', 'scholar'][Math.floor(Math.random() * 4)] } : {};
        this.entities.push(new Mob(t, p.x + dx * 2, p.y, p.z + dz * 2, opts));
        return `Summoned a ${t}`;
      }
      case 'weather':
        if (args[0] === 'clear') { this.rainTarget = 0; this.rainTime = 24000 + Math.floor(Math.random() * 100000); return 'Weather set to clear'; }
        if (args[0] === 'rain') { this.rainTarget = 1; this.rainTime = 12000; this.thunder = 0; return 'Weather set to rain'; }
        if (args[0] === 'thunder') { this.rainTarget = 1; this.rainTime = 12000; this.thunder = 1; return 'Weather set to rain and thunder'; }
        return 'Usage: /weather <clear|rain|thunder>';
      case 'xp': case 'experience': {
        const m = /^(-?\d+)(l?)$/i.exec(args[0] === 'add' ? args[1] || '' : args[0] || '');
        if (!m) return 'Usage: /xp <amount> or /xp <levels>L';
        const n = parseInt(m[1], 10);
        if (m[2]) { p.xpLevel = Math.max(0, p.xpLevel + n); this.advance('level'); return `Gave ${n} experience levels`; }
        p.addXp(this, Math.max(0, n));
        return `Gave ${n} experience points`;
      }
      case 'enchant': {
        const held = p.inventory.held;
        if (!held) return 'Hold an item to enchant it';
        const key = (args[0] || '').toLowerCase();
        if (!ENCHANTS[key]) return `Usage: /enchant <${Object.keys(ENCHANTS).join('|')}> [level]`;
        if (!applicableEnchants(held.id).includes(key)) return `${ENCHANTS[key].name} cannot be applied to ${itemName(held.id)}`;
        const lvl = Math.max(1, Math.min(ENCHANTS[key].max, parseInt(args[1] || '1', 10) || 1));
        held.ench = { ...(held.ench || {}), [key]: lvl };
        return `Applied ${enchantLabel(key, lvl)} to ${itemName(held.id)}`;
      }
      case 'effect': {
        if (args[0] === 'clear') { p.effects = {}; p.absorption = 0; return 'Cleared all effects'; }
        if (args[0] !== 'give' || !args[1]) return `Usage: /effect give <${Object.keys(EFFECTS).join('|')}> [seconds] [level] or /effect clear`;
        const name = args[1].toLowerCase();
        if (!EFFECTS[name]) return `Unknown effect: ${name}`;
        const secs = Math.max(1, Math.min(100000, parseInt(args[2] || '30', 10) || 30));
        const lvl = Math.max(1, Math.min(4, parseInt(args[3] || '1', 10) || 1));
        if (EFFECTS[name].instant) p.applyPotion(this, { effect: name, amp: lvl - 1, ticks: 0 });
        else addEffect(p, name, lvl - 1, secs * 20);
        return `Applied ${EFFECTS[name].name} ${lvl > 1 ? lvl : ''} for ${secs}s`;
      }
      case 'locate': {
        const what = (args[0] || 'village').toLowerCase();
        if (what === 'observatory') {
          const os = this.world.gen.observatories;
          if (!os) return 'There are no observatories in this dimension';
          const o = os.locate(p.x, p.z, 4);
          return o ? `The nearest observatory is at ${o.x}, ${o.y}, ${o.z} (${Math.round(Math.hypot(o.x - p.x, o.z - p.z))} blocks away)` : 'No observatory found nearby';
        }
        if (what === 'spire') {
          const g = this.world.gen;
          if (!g.locateSpire) return 'Spires are only found in the Void';
          const sp = g.locateSpire(p.x, p.z, 5);
          return sp ? `The nearest spire is at ${sp.x}, ${sp.y}, ${sp.z} (${Math.round(Math.hypot(sp.x - p.x, sp.z - p.z))} blocks away)` : 'No spire found nearby';
        }
        const LM = { mineshaft: 'mineshaft', temple: 'sun_temple', sun_temple: 'sun_temple', shrine: 'jungle_shrine', jungle_shrine: 'jungle_shrine', hut: 'swamp_hut', swamp_hut: 'swamp_hut', citadel: 'tide_citadel', tide_citadel: 'tide_citadel', manor: 'manor' };
        if (LM[what]) {
          const lm = this.world.gen.landmarks;
          if (!lm) return 'Nothing like that in this dimension';
          const s = lm.locate(LM[what], p.x, p.z, 8);
          if (!s) return `No ${LANDMARKS[LM[what]].name.toLowerCase()} found nearby`;
          return `The nearest ${LANDMARKS[LM[what]].name.toLowerCase()} is at ${s.x}, ${s.y}, ${s.z} (${Math.round(Math.hypot(s.x - p.x, s.z - p.z))} blocks away)`;
        }
        if (what !== 'village') return 'Usage: /locate <village|observatory|spire|mineshaft|temple|shrine|hut|citadel|manor>';
        const vs = this.world.gen.villages;
        if (!vs) return 'There are no villages in this dimension';
        const v = vs.locate(p.x, p.z, 8);
        if (!v) return 'No village found nearby';
        return `The nearest village is at ${v.x}, ~, ${v.z} (${Math.round(Math.hypot(v.x - p.x, v.z - p.z))} blocks away)`;
      }
      case 'dimension': case 'dim': {
        const to = (args[0] || '').toLowerCase();
        if (!['overworld', 'underworld', 'void'].includes(to)) return 'Usage: /dimension <overworld|underworld|void>';
        if (to === this.dim) return `Already in ${DIM_NAMES[to]}`;
        if (to === 'void') { this.travel('void', 100.5, 50, 0.5, 'platform'); return ''; }
        if (this.dim === 'void') { const sp = p.spawn || p.worldSpawn || { x: 0, y: 80, z: 0 }; this.travel('overworld', sp.x, sp.y, sp.z, false); return ''; }
        const f = to === 'underworld' ? 1 / 8 : 8;
        this.travel(to, p.x * f, to === 'underworld' ? 64 : p.y, p.z * f, true);
        return '';
      }
      case 'seed': return `Seed: ${this.meta.seedText ?? this.meta.seed}`;
      case 'spawnpoint': p.spawn = { x: p.x, y: p.y, z: p.z }; return 'Spawn point set';
      case 'kill': p.damage(this, 1000, 'kill'); return '';
      case 'heal': p.health = 20; p.food = 20; p.saturation = 5; return 'Healed';
      case 'clear': for (let i = 0; i < 36; i++) p.inventory.set(i, null); return 'Inventory cleared';
      case 'difficulty':
        if (args[0] === 'peaceful') { this.settings.peaceful = true; return 'Difficulty set to Peaceful'; }
        if (args[0] === 'normal') { this.settings.peaceful = false; return 'Difficulty set to Normal'; }
        return 'Usage: /difficulty <peaceful|normal>';
      default:
        return `Unknown command: ${cmd}. Type /help`;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  camera(alpha) {
    const p = this.player;
    const s = this.settings;
    const cam = this.cam || (this.cam = {});
    if (this.demo) {
      const t = performance.now() / 1000;
      cam.x = this.demoCam.x; cam.y = this.demoCam.y; cam.z = this.demoCam.z;
      cam.yaw = t * 0.04; cam.pitch = -0.12; cam.roll = 0; cam.fov = 75;
      return cam;
    }
    const [ex, ey, ez] = this.eyePos(alpha);
    cam.x = ex; cam.y = ey; cam.z = ez;
    cam.yaw = p.yaw; cam.pitch = p.pitch; cam.roll = 0;
    if (p.gliding) cam.roll = Math.max(-0.5, Math.min(0.5, (p.yaw - (p.pyaw ?? p.yaw)) * 6));
    if (p.sleeping) {
      // lying in bed, looking up past the headboard
      cam.y = p.y + 0.15; cam.yaw = p.sleepYaw || 0; cam.pitch = 0.9; cam.fov = s.fov;
      return cam;
    }
    if (s.bobbing && this.perspective === 0) {
      const walk = (p.pWalkDist + (p.walkDist - p.pWalkDist) * alpha) * Math.PI;
      const bob = p.pbob + (p.bob - p.pbob) * alpha;
      const rx = Math.cos(p.yaw), rz = Math.sin(p.yaw);
      const side = Math.sin(walk) * bob * 0.5;
      cam.x += rx * side; cam.z += rz * side;
      cam.y -= Math.abs(Math.cos(walk) * bob);
      cam.roll = Math.sin(walk) * bob * 3 * Math.PI / 180;
      cam.pitch -= Math.abs(Math.cos(walk - 0.2) * bob) * 5 * Math.PI / 180;
    }
    if (p.hurtTime > 0 && !p.dead) {
      const h = (p.hurtTime - alpha) / 10;
      cam.roll += Math.sin(h * h * h * h * Math.PI) * 14 * Math.PI / 180 * (s.bobbing ? 1 : 0.4);
    }
    if (p.dead) cam.roll = Math.min(1, (this.deadTicks || 0) / 20) * 40 * Math.PI / 180;
    if (this.shake > 0) { cam.yaw += (Math.random() - 0.5) * this.shake * 0.02; cam.pitch += (Math.random() - 0.5) * this.shake * 0.02; }
    // field of view: sprinting widens, water narrows
    let fov = s.fov;
    if (p.sprinting) fov *= 1.12;
    if (p.eyesInWater) fov *= 0.88;
    if (this.bowDraw > 0) fov *= 1 - Math.min(1, this.bowDraw / 20) ** 2 * 0.15;
    if (p.effects.speed) fov *= 1 + 0.05 * (p.effects.speed.amp + 1);
    if (p.effects.slowness) fov *= 0.94;
    if (p.gliding) fov *= 1 + Math.min(0.25, Math.hypot(p.vx, p.vy, p.vz) * 0.12);
    this.fovCur += (fov - this.fovCur) * 0.18;
    cam.fov = this.fovCur;
    if (this.perspective !== 0) {
      // third person: pull back along the view ray until something blocks it
      const [dx, dy, dz] = this.lookDir();
      const dir = this.perspective === 1 ? -1 : 1;
      let dist = 4;
      for (const [ox, oy, oz] of [[0, 0, 0], [0.1, 0.1, 0.1], [-0.1, -0.1, 0.1], [0.1, -0.1, -0.1], [-0.1, 0.1, -0.1]]) {
        const h = raycast(this.world, ex + ox, ey + oy, ez + oz, dx * dir, dy * dir, dz * dir, 4);
        if (h && h.dist - 0.2 < dist) dist = Math.max(0.3, h.dist - 0.2);
      }
      cam.x = ex + dx * dir * dist; cam.y = ey + dy * dir * dist; cam.z = ez + dz * dir * dist;
      if (this.perspective === 2) { cam.yaw = p.yaw + Math.PI; cam.pitch = -p.pitch; }
    }
    return cam;
  }

  render(alpha, dt) {
    const p = this.player;
    const cam = this.camera(alpha);
    const underwater = !this.demo && this.world.getBlock(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z)) === B.water;
    const inLava = !this.demo && this.world.getBlock(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z)) === B.lava;
    const s = this.settings;
    computeEnv(this.env, {
      dayTime: this.dayTime + (this.state === 'playing' ? alpha : 0), day: this.day, rain: this.dim === 'overworld' ? this.rain : 0,
      underwater, inLava, renderDist: this.demo ? Math.min(8, s.renderDistance) : s.renderDistance,
      gamma: s.brightness / 100, flicker: this.flicker, dim: this.dim, flash: this.flash,
      nightVision: p && p.effects.night_vision ? Math.min(1, p.effects.night_vision.time / 100) : 0,
    });
    const scene = {
      cam, env: this.env, chunks: this.world.chunks.values(), renderDist: this.demo ? Math.min(8, s.renderDistance) : s.renderDistance,
      time: { seconds: performance.now() / 1000, ticks: this.tickCount, cloudScroll: (this.tickCount + alpha) * 0.03 },
      clouds: s.clouds && this.dim === 'overworld',
      sky: this.dim === 'overworld',
      particles: this.particles.build(this.env.skyBright, this.orbs, alpha),
      selection: null, breaking: null,
    };
    if (!this.demo) {
      if (this.target && !this.hideHud && this.state !== 'dead') scene.selection = { x: this.target.x, y: this.target.y, z: this.target.z, box: this.target.box };
      if (this.breaking && this.breaking.progress > 0) {
        const b = this.breaking;
        const box = selectionBoxAt(this.world, b.x, b.y, b.z, b.id, this.world.getMeta(b.x, b.y, b.z)) || [0, 0, 0, 1, 1, 1];
        scene.breaking = { x: b.x, y: b.y, z: b.z, stage: Math.min(9, Math.floor(b.progress * 10)), box };
      }
      scene.drawModels = () => this.scene.drawEntities(this, cam, this.env, alpha);
      scene.drawHand = () => this.scene.drawHand(this, this.env, alpha);
    }
    const t0 = performance.now();
    this.renderer.render(scene);
    this.frameMs = performance.now() - t0;
    if (this.screenshotPending) {
      this.screenshotPending = false;
      this.ui.screenshotTaken(this.renderer.capture());
    }
    this.ui.frame(dt, {
      underwater, inLava, portal: this.portalProgress, sleep: p && p.sleeping ? Math.min(1, p.sleeping / 60) : 0,
      boss: this.wyrm && !this.wyrm.removed && Math.hypot(this.wyrm.x - p.x, this.wyrm.z - p.z) < 200 ? { name: 'Void Wyrm', f: this.wyrm.health / this.wyrm.maxHealth } : null,
    });
    if (p && p.dead) this.deadTicks = (this.deadTicks || 0) + dt * 20; else this.deadTicks = 0;
  }
}

installFeatures(Game);
installNet(Game);
installBlaster(Game);
