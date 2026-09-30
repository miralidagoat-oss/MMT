// Game state and rules: ticking, interaction, block updates, creatures,
// time and weather, saving. Rendering and UI are driven from here.
import { TICK_MS, DAY_TICKS, HEIGHT, SEA_LEVEL } from './constants.js';
import {
  B, BLOCKS, SOLID, OPAQUE, REPLACEABLE, isLiquid, RENDER_TYPE, RENDER, TEX, faceTexture,
} from './blocks.js';
import { ITEMS, I, SMELTING, fuelValue, isBlockItem, findItem, maxStack, itemName } from './items.js';
import { World, STATE } from './world.js';
import { Player } from './player.js';
import { Mob, ItemEntity, FallingBlock, PrimedCrate, MOB_TYPES } from './entities.js';
import { raycast, rayBox, selectionBox, boxFree } from './physics.js';
import { Particles } from './particles.js';
import { Fluids } from './fluids.js';
import { computeEnv, daylight } from './env.js';
import { hashSeed, rng } from './noise.js';
import { newFurnace, newChest, Container } from './inventory.js';
import { WorldGen } from './worldgen.js';

const REACH_SURVIVAL = 4.5, REACH_CREATIVE = 5;
const DIR6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const GRASS_OK = new Set([2, 3, 34]);

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
    this.flicker = 1;
    this.shake = 0;
    this.caveSoundTimer = 600;
    this.torchCache = []; this.torchScanTick = 0;
    this.demo = false;
  }

  // ---------------------------------------------------------------------------
  // World lifecycle
  async startWorld(meta, { demo = false } = {}) {
    if (this.world) this.world.dispose();
    this.demo = demo;
    this.meta = meta;
    const seed = meta.seed;
    this.world = new World({
      seed, worldId: demo ? null : meta.id, storage: demo ? null : this.storage, renderer: this.renderer,
      hooks: {
        onBlockChanged: (...a) => this.onBlockChanged(...a),
        onChunkGenerated: (c, spawns) => this.onChunkGenerated(c, spawns),
      },
    });
    this.particles.setWorld(this.world);
    this.fluids.clear();
    this.entities = []; this.items = [];
    this.tickCount = meta.time || 0;
    this.dayTime = meta.dayTime ?? 1000;
    this.day = meta.day || 0;
    this.rain = this.rainTarget = meta.rain || 0;
    this.rainTime = meta.rainTime ?? 12000 + Math.floor(Math.random() * 40000);
    this.world.populated = new Set(meta.populated || []);
    this.world.blockEntities = new Map(meta.blockEntities || []);
    this.player = new Player(0, 80, 0);
    this.player.mode = meta.mode || 'survival';
    this.craft2 = new Container(4); this.craft3 = new Container(9);
    this.breaking = null; this.target = null; this.eatTicks = 0;
    await this.world.start();
    if (meta.player) {
      this.player.load(meta.player);
      this.spawnKnown = true;
    } else {
      const gen = new WorldGen(seed);
      const s = gen.findSpawn();
      this.player.x = this.player.px = s.x; this.player.z = this.player.pz = s.z; this.player.y = this.player.py = s.h + 1;
      this.player.spawn = null;
      this.spawnKnown = false;
    }
    for (const m of meta.mobs || []) {
      if (!MOB_TYPES[m.type]) continue;
      const mob = new Mob(m.type, m.x, m.y, m.z);
      mob.health = m.health ?? mob.health; mob.sheared = !!m.sheared; mob.bodyYaw = mob.yaw = m.yaw || 0;
      this.entities.push(mob);
    }
    this.lastHeldId = -1;
  }

  // Place a new player safely on the surface once the spawn chunk exists.
  resolveSpawn() {
    const p = this.player;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    if (!this.world.chunkReady(x >> 4, z >> 4)) return false;
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
      this.spawnKnown = true;
    }
    // never start inside blocks
    let guard = 0;
    while (!boxFree(this.world, p.x, p.y, p.z, p.w, p.h) && guard++ < 256) { p.y += 1; p.py = p.y; }
    return true;
  }

  serialize() {
    const mobs = this.entities.filter((e) => e instanceof Mob && !e.dead && !e.hostile)
      .map((m) => ({ type: m.type, x: m.x, y: m.y, z: m.z, health: m.health, sheared: m.sheared, yaw: m.yaw }));
    return {
      ...this.meta,
      lastPlayed: Date.now(),
      time: this.tickCount, dayTime: this.dayTime, day: this.day,
      rain: this.rainTarget, rainTime: this.rainTime,
      mode: this.player.mode,
      player: this.player.toJSON(),
      populated: [...this.world.populated],
      blockEntities: [...this.world.blockEntities.entries()],
      mobs,
    };
  }

  async save() {
    if (!this.world || this.demo || !this.meta) return;
    this.returnCraftingItems();
    const chunks = this.world.collectSaves();
    this.meta = this.serialize();
    await this.storage.saveWorld(this.meta);
    await this.storage.saveChunks(this.meta.id, chunks);
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
    const simulate = this.state === 'playing' || this.state === 'screen' || this.state === 'dead' || this.demo;

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
    const input = playing ? this.input.movement() : { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    if (playing && this.input.consumeDoubleTap('forward')) input.sprint = true;
    if (playing && this.input.consumeDoubleTap('jump') && (p.creative || p.spectator)) {
      p.flying = !p.flying;
      if (p.flying) p.vy = 0;
    }
    if (p.sprinting && input.forward > 0) input.sprint = true;
    const chunkHere = this.world.chunkReady(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4);
    if (chunkHere) p.tick(this, input);
    else p.savePrev();
    this.audio.setListener(p.x, p.y + p.eye, p.z, p.yaw);

    // interaction
    if (playing) this.tickInteraction();
    else { this.breaking = null; this.eatTicks = 0; }
    this.tickSwing();

    this.tickEntities();
    this.fluids.tick(this.tickCount);
    this.randomTicks();
    this.tickSpawning();
    this.tickFurnaces();
    this.tickTime();
    this.tickAmbient();
    if (this.tickCount % 600 === 0) this.save();
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

  startSwing() { if (this.swingTicks === 0 || this.swingTicks > 3) this.swingTicks = 1; }
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
    for (const e of this.entities) {
      if (!(e instanceof Mob) || e.dead) continue;
      const r = rayBox(ex, ey, ez, dx, dy, dz, e.x - e.w, e.y, e.z - e.w, e.x + e.w, e.y + e.h, e.z + e.w);
      if (r && r.t < best && r.t <= 3.5 + (p.creative ? 1.5 : 0)) { best = r.t; ent = e; }
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

    // use / place / eat
    const def = held && ITEMS[held.id];
    const canEat = def && def.food && (p.food < 20 || p.creative);
    if (inp.mouse.right && canEat && !(this.target && this.isInteractive(this.target) && !p.sneaking)) {
      this.eatTicks++;
      if (this.eatTicks % 4 === 0) this.audio.play('eat', p.x, p.y + 1.5, p.z, 0.6);
      if (this.eatTicks >= 32) {
        this.eatTicks = 0;
        if (!p.creative) { p.eat(held); p.inventory.useHeld(); }
        this.audio.play('burp', p.x, p.y + 1.5, p.z, 0.5);
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

  isInteractive(hit) {
    const id = hit.id;
    return id === B.crafting_table || id === B.furnace || id === B.furnace_lit || id === B.chest || id === B.tnt;
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
      for (const s of be.slots) if (s) this.dropItem(x + 0.5, y + 0.5, z + 0.5, s, true);
      w.blockEntities.delete(`${x},${y},${z}`);
      this.ui.onBlockEntityRemoved(`${x},${y},${z}`);
    }
    let replacement = 0;
    if (id === B.ice && !this.player.creative) {
      const below = w.getBlock(x, y - 1, z);
      if (SOLID[below] || isLiquid(below)) replacement = B.water;
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
      else drops = b.drops ? b.drops(Math.random) : (b.item ? [[id, 1]] : []);
      for (const [did, n] of drops) if (n > 0 && ITEMS[did]) this.dropItem(x + 0.5, y + 0.3, z + 0.5, { id: did, count: n }, true);
    }
  }

  // Break a block without a tool (support loss, water flow): always drops.
  breakNaturally(x, y, z, silent = false) {
    const id = this.world.getBlock(x, y, z);
    if (!id) return;
    const b = BLOCKS[id];
    this.world.setBlock(x, y, z, 0, 0);
    if (!silent) { this.particles.blockBreak(x, y, z, id, 0); this.audio.blockSound(id, 'break', x + 0.5, y + 0.5, z + 0.5); }
    const drops = b.drops ? b.drops(Math.random) : (b.item ? [[id, 1]] : []);
    for (const [did, n] of drops) if (n > 0 && ITEMS[did]) this.dropItem(x + 0.5, y + 0.3, z + 0.5, { id: did, count: n }, true);
  }

  attack(mob) {
    const p = this.player;
    const held = p.inventory.held;
    const def = held && ITEMS[held.id];
    let dmg = def && def.damage ? def.damage : 1;
    const crit = p.vy < 0 && !p.onGround && !p.inWater && !p.onLadder && !p.flying;
    if (crit) { dmg *= 1.5; this.audio.play('crit', mob.x, mob.y + 1, mob.z); for (let i = 0; i < 8; i++) this.particles.add({ x: mob.x + (Math.random() - 0.5) * 0.6, y: mob.y + mob.h * Math.random(), z: mob.z + (Math.random() - 0.5) * 0.6, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3, vz: (Math.random() - 0.5) * 3, size: 0.08, layer: TEX.p_spark, life: 0.5, gravity: 8, fullbright: true }); }
    if (mob.hurt(this, dmg, p.x, p.z, 'player')) {
      if (p.sprinting) { mob.vx += Math.sin(p.yaw) * 0.5; mob.vz -= Math.cos(p.yaw) * 0.5; p.sprinting = false; }
      p.addExhaustion(0.1);
      if (def && def.tool) this.damageTool(def.tool.type === 'sword' ? 1 : 2);
    }
  }

  use() {
    const p = this.player, w = this.world;
    const held = p.inventory.held;
    const def = held && ITEMS[held.id];

    if (this.targetEntity) {
      const res = this.targetEntity.interact(this, held);
      if (res) { this.startSwing(); if (res === 'damage_tool') this.damageTool(1); return; }
    }
    const hit = this.target;
    // containers and workstations
    if (hit && !p.sneaking) {
      const key = `${hit.x},${hit.y},${hit.z}`;
      if (hit.id === B.crafting_table) { this.ui.openScreen('crafting'); return; }
      if (hit.id === B.furnace || hit.id === B.furnace_lit) {
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newFurnace());
        this.ui.openScreen('furnace', { key, be: w.blockEntities.get(key) });
        return;
      }
      if (hit.id === B.chest) {
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newChest());
        this.audio.play('chest_open', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        this.ui.openScreen('chest', { key, be: w.blockEntities.get(key) });
        return;
      }
      if (hit.id === B.tnt && held && held.id === I.flint_and_steel) {
        w.setBlock(hit.x, hit.y, hit.z, 0, 0);
        this.entities.push(new PrimedCrate(hit.x, hit.y, hit.z));
        this.audio.play('fuse', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        this.damageTool(1); this.startSwing();
        return;
      }
    }
    if (!held) return;

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

    // placement position: into a replaceable target, or against the hit face
    let tx = hit.x, ty = hit.y, tz = hit.z;
    const targetId = hit.id;
    if (!(REPLACEABLE[targetId] && !isLiquid(targetId))) { tx += hit.nx; ty += hit.ny; tz += hit.nz; }
    if (ty < 0 || ty >= HEIGHT) return;
    const cur = w.getBlock(tx, ty, tz);
    if (cur && !REPLACEABLE[cur]) return;

    if (def.places !== undefined) {
      // water / lava bucket
      w.setBlock(tx, ty, tz, def.places, 0);
      this.fluids.schedule(tx, ty, tz, this.tickCount);
      this.audio.play('splash', tx + 0.5, ty + 0.5, tz + 0.5, 0.4);
      if (!p.creative) this.replaceHeld({ id: I.bucket, count: 1 });
      this.startSwing();
      return;
    }
    if (held.id === I.flint_and_steel) return;
    if (!isBlockItem(held.id)) return;
    const id = held.id;
    const meta = this.placementMeta(id, hit, tx, ty, tz);
    if (meta < 0) return;
    if (!this.canSurvive(id, meta, tx, ty, tz)) return;
    if (SOLID[id]) {
      // do not place inside creatures or the player
      const bb = [tx, ty, tz, tx + 1, ty + 1, tz + 1];
      if (p.intersects(...bb) && !p.spectator) return;
      for (const e of this.entities) if (e instanceof Mob && !e.dead && e.intersects(...bb)) return;
    }
    w.setBlock(tx, ty, tz, id, meta);
    this.audio.blockSound(id, 'place', tx + 0.5, ty + 0.5, tz + 0.5);
    this.startSwing();
    if (!p.creative) p.inventory.useHeld();
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
    const p = this.player;
    const face = REPLACEABLE[hit.id] && !isLiquid(hit.id) ? 0 : hit.face;
    if (b.orient === 'axis') return face === 2 || face === 3 ? 1 : face === 4 || face === 5 ? 2 : 0;
    if (b.orient === 'facing') {
      const lx = Math.sin(p.yaw), lz = -Math.cos(p.yaw);
      if (Math.abs(lx) > Math.abs(lz)) return lx > 0 ? 3 : 2;
      return lz > 0 ? 5 : 4;
    }
    if (b.orient === 'torch') {
      if (face === 0) return 0;
      if (face === 1) return -1;
      return { 2: 1, 3: 2, 4: 3, 5: 4 }[face];
    }
    if (b.orient === 'wall') {
      if (face < 2) {
        // pick the wall the player faces
        const lx = Math.sin(p.yaw), lz = -Math.cos(p.yaw);
        if (Math.abs(lx) > Math.abs(lz)) return lx > 0 ? 2 : 1;
        return lz > 0 ? 4 : 3;
      }
      return { 2: 1, 3: 2, 4: 3, 5: 4 }[face];
    }
    if (b.name.endsWith('leaves')) return 1; // player-placed leaves never decay
    return 0;
  }

  // Support rules for plants, torches, ladders, cacti and sugar cane.
  canSurvive(id, meta, x, y, z) {
    const w = this.world;
    const b = BLOCKS[id];
    const below = w.getBlock(x, y - 1, z);
    switch (b.support) {
      case 'ground':
        if (id === B.brown_mushroom || id === B.red_mushroom) return OPAQUE[below] === 1;
        return GRASS_OK.has(below);
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
        if (m === 0) return SOLID[below] === 1 && RENDER_TYPE[below] === RENDER.CUBE;
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
    for (const e of this.entities) {
      const dx = e.x - p.x, dz = e.z - p.z;
      const far = dx * dx + dz * dz > 110 * 110;
      if (far && !e.hostile) { e.savePrev(); continue; }
      if (!this.world.chunkReady(Math.floor(e.x) >> 4, Math.floor(e.z) >> 4)) { e.savePrev(); continue; }
      e.tick(this);
    }
    for (const it of this.items) {
      if (!this.world.chunkReady(Math.floor(it.x) >> 4, Math.floor(it.z) >> 4)) { it.savePrev(); continue; }
      it.tick(this);
      if (!it.removed && !it.pickedBy && it.pickupDelay === 0 && !p.dead && !p.spectator &&
        Math.abs(it.x - p.x) < 1.3 && it.y > p.y - 0.8 && it.y < p.y + 2.3 && Math.abs(it.z - p.z) < 1.3) {
        const before = it.stack.count;
        const left = p.inventory.give(it.stack);
        if (left < before) {
          this.audio.play('pop', it.x, it.y, it.z, 0.4);
          if (left === 0) { it.pickedBy = p; it.pickupTick = 0; }
          else it.stack.count = left;
        }
      }
    }
    this.entities = this.entities.filter((e) => !e.removed);
    this.items = this.items.filter((e) => !e.removed);
  }

  // ---------------------------------------------------------------------------
  onChunkGenerated(c, spawns) {
    if (this.demo) return;
    for (const s of spawns) {
      if (this.entities.length > 200) break;
      this.entities.push(new Mob(s.type, s.x, s.y, s.z));
    }
  }

  tickSpawning() {
    const p = this.player;
    if (this.tickCount % 20 !== 0) return;
    // despawn distant hostiles
    for (const e of this.entities) {
      if (!e.hostile) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > 128 || (d > 40 && Math.random() < 0.02)) e.removed = true;
    }
    if (this.settings.peaceful) { for (const e of this.entities) if (e.hostile) e.removed = true; return; }
    const hostile = this.entities.reduce((n, e) => n + (e.hostile ? 1 : 0), 0);
    if (hostile >= 16) return;
    const dayL = daylight(this.dayTime, this.rain);
    const darken = Math.round((1 - dayL) * 11);
    for (let attempt = 0; attempt < 4; attempt++) {
      const a = Math.random() * Math.PI * 2, d = 24 + Math.random() * 40;
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      if (!this.world.chunkReady(x >> 4, z >> 4)) continue;
      // pick either the surface or a random cave floor
      let y;
      if (Math.random() < 0.5) y = this.world.surfaceY(x, z);
      else {
        y = 5 + Math.floor(Math.random() * Math.max(1, this.world.surfaceY(x, z) - 8));
        while (y > 1 && !SOLID[this.world.getBlock(x, y - 1, z)]) y--;
      }
      if (y < 1) continue;
      const below = this.world.getBlock(x, y - 1, z);
      if (!SOLID[below] || !OPAQUE[below] || below === B.bedrock) continue;
      if (SOLID[this.world.getBlock(x, y, z)] || SOLID[this.world.getBlock(x, y + 1, z)] || isLiquid(this.world.getBlock(x, y, z))) continue;
      const l = this.world.getLight(x, y, z);
      const sky = l >> 4, bl = l & 15;
      if (bl > 0 || sky - darken > 4) continue;
      if (Math.hypot(x + 0.5 - p.x, y - p.y, z + 0.5 - p.z) < 24) continue;
      const mob = new Mob('ghoul', x + 0.5, y, z + 0.5);
      if (!boxFree(this.world, mob.x, mob.y, mob.z, mob.w, mob.h)) continue;
      this.entities.push(mob);
    }
  }

  // ---------------------------------------------------------------------------
  // Block updates
  onBlockChanged(x, y, z, old, id) {
    if (this.demo) return;
    const w = this.world;
    // fluids react to any nearby change
    if (isLiquid(id)) this.fluids.schedule(x, y, z, this.tickCount);
    for (const [dx, dy, dz] of DIR6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const nid = w.getBlock(nx, ny, nz);
      if (!nid) continue;
      if (isLiquid(nid)) this.fluids.schedule(nx, ny, nz, this.tickCount);
      const nb = BLOCKS[nid];
      if (nb.support && !this.canSurvive(nid, w.getMeta(nx, ny, nz), nx, ny, nz)) {
        this.breakNaturally(nx, ny, nz);
      }
    }
    // the placed block itself may be unsupported (e.g. flowing water replaced its soil)
    // gravity blocks fall
    const above = w.getBlock(x, y + 1, z);
    if (BLOCKS[above] && BLOCKS[above].gravity && (id === 0 || REPLACEABLE[id] || isLiquid(id))) this.startFall(x, y + 1, z);
    if (BLOCKS[id] && BLOCKS[id].gravity) {
      const below = w.getBlock(x, y - 1, z);
      if (y > 0 && (below === 0 || isLiquid(below) || (REPLACEABLE[below] && !SOLID[below]))) this.startFall(x, y, z);
    }
    // leaves may decay once their tree loses its logs
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
    const w = this.world, p = this.player;
    const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
    const R = 5;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const c = w.getChunk(pcx + dx, pcz + dz);
      if (!c || c.state !== STATE.READY) continue;
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
      case B.oak_leaves: case B.birch_leaves: case B.spruce_leaves:
        if (w.getMeta(x, y, z) === 0 && Math.random() < 0.3) this.checkLeafDecay(x, y, z);
        return;
      case B.ice: {
        const l = w.getLight(x, y, z);
        if ((l & 15) > 11) w.setBlock(x, y, z, B.water, 0);
        return;
      }
      default:
    }
  }

  checkLeafDecay(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (!(id === B.oak_leaves || id === B.birch_leaves || id === B.spruce_leaves) || w.getMeta(x, y, z) !== 0) return;
    // search through leaves for a log within 4 steps
    const seen = new Set([`${x},${y},${z}`]);
    let frontier = [[x, y, z]];
    for (let d = 0; d < 4; d++) {
      const next = [];
      for (const [cx, cy, cz] of frontier) {
        for (const [dx, dy, dz] of DIR6) {
          const nx = cx + dx, ny = cy + dy, nz = cz + dz;
          const k = `${nx},${ny},${nz}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const nid = w.getBlock(nx, ny, nz);
          if (nid === B.oak_log || nid === B.birch_log || nid === B.spruce_log) return;
          if (nid === B.oak_leaves || nid === B.birch_leaves || nid === B.spruce_leaves) next.push([nx, ny, nz]);
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
  explode(x, y, z, power) {
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
    for (const e of this.entities) if (e instanceof Mob) hurtEnt(e, false);
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
    const s = this.player.lastDamageSource;
    return {
      fall: 'You hit the ground too hard', drown: 'You drowned', lava: 'You tried to swim in lava',
      fire: 'You burned to death', starve: 'You starved to death', cactus: 'You were pricked to death',
      mob: 'You were slain by a Ghoul', explosion: 'You were blown up', void: 'You fell out of the world',
      kill: 'You died',
    }[s] || 'You died';
  }

  respawn() {
    const p = this.player;
    const s = p.spawn || { x: p.x, y: 80, z: p.z };
    p.respawn(s.x, s.y, s.z);
    this.spawnKnown = true;
    let guard = 0;
    while (!boxFree(this.world, p.x, p.y, p.z, p.w, p.h) && guard++ < 256) p.y += 1;
    p.py = p.y;
  }

  returnCraftingItems() {
    const p = this.player;
    for (const c of [this.craft2, this.craft3]) {
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
        return 'Commands: /time set <day|noon|night|midnight|ticks>, /time add <ticks>, /gamemode <survival|creative>, /tp <x> <y> <z>, /give <item> [count], /summon <pig|cow|sheep|chicken|ghoul>, /weather <clear|rain>, /seed, /spawnpoint, /kill, /heal, /clear, /difficulty <peaceful|normal>';
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
        if (!MOB_TYPES[t]) return 'Usage: /summon <pig|cow|sheep|chicken|ghoul>';
        const [dx, , dz] = this.lookDir();
        this.entities.push(new Mob(t, p.x + dx * 2, p.y, p.z + dz * 2));
        return `Summoned a ${t}`;
      }
      case 'weather':
        if (args[0] === 'clear') { this.rainTarget = 0; this.rainTime = 24000 + Math.floor(Math.random() * 100000); return 'Weather set to clear'; }
        if (args[0] === 'rain') { this.rainTarget = 1; this.rainTime = 12000; return 'Weather set to rain'; }
        return 'Usage: /weather <clear|rain>';
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
      dayTime: this.dayTime + (this.state === 'playing' ? alpha : 0), day: this.day, rain: this.rain,
      underwater, inLava, renderDist: this.demo ? Math.min(8, s.renderDistance) : s.renderDistance,
      gamma: s.brightness / 100, flicker: this.flicker,
    });
    const scene = {
      cam, env: this.env, chunks: this.world.chunks.values(), renderDist: this.demo ? Math.min(8, s.renderDistance) : s.renderDistance,
      time: { seconds: performance.now() / 1000, ticks: this.tickCount, cloudScroll: (this.tickCount + alpha) * 0.03 },
      clouds: s.clouds,
      particles: this.particles.build(this.env.skyBright),
      selection: null, breaking: null,
    };
    if (!this.demo) {
      if (this.target && !this.hideHud && this.state !== 'dead') scene.selection = { x: this.target.x, y: this.target.y, z: this.target.z, box: this.target.box };
      if (this.breaking && this.breaking.progress > 0) {
        const b = this.breaking;
        const box = selectionBox(b.id, this.world.getMeta(b.x, b.y, b.z)) || [0, 0, 0, 1, 1, 1];
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
    this.ui.frame(dt, { underwater, inLava });
    if (p && p.dead) this.deadTicks = (this.deadTicks || 0) + dt * 20; else this.deadTicks = 0;
  }
}

