/**
 * Authoritative simulation. Pure TypeScript with no I/O: the dedicated server
 * and the single-player worker both run this class. All gameplay state changes
 * happen here; clients only send intents (inputs/actions).
 */
import { SIM, TIME, PLAYER, SURVIVAL, NET } from '../config';
import { Rng, hashString } from '../math/rng';
import { WorldGen } from '../world/worldgen';
import { CollisionWorld } from '../world/collision';
import { waveHeight, shoreDamping } from '../world/ocean';
import { initialWeather, tickWeather, seaState, hourOf } from '../systems/weather';
import { stepMovement, sanitizeInput, moveStateFrom, movementStaminaCost, type InputFrame, type MoveEnv } from '../systems/movement';
import { emptyInventory, makeStack, addStack, totalWeight, carryCapacity } from '../systems/inventory';
import { ITEMS } from '../defs/items';
import { STRUCTURES } from '../defs/structures';
import type { Action, FxEvent } from '../net/protocol';
import { DEFAULT_SETTINGS, type ContainerState, type DroppedItem, type ItemStack, type PlayerState, type StructureState, type WorldState } from '../state';
import { tickSurvival, applyDamage, killPlayer } from './survival';
import { tickCrafting } from './crafting';
import { tickStations } from './stations';
import { tickWildlife, initZones } from './wildlife';
import { tickVehicles } from './vehicles';
import { tickWorldEvents } from './events';
import { tickProjectiles } from './combat';
import { handleAction } from './actions';
import { initWorldContainers } from './world-init';

export interface SimOutput {
  /** reliable dirty keys: s:<id> structure, c:<id> container, n:<id> node, i:<id> item, p:<playerId> private, w waypoints, g progression, e events */
  dirty: Set<string>;
  fx: FxEvent[];
  notify: { to: string | null; text: string; level: 'info' | 'good' | 'warn' | 'bad' }[];
  results: { to: string; id: number; ok: boolean; reason?: string }[];
  chat: { from: string; name: string; text: string }[];
  roster: boolean;
}

const COLORS = ['#ff6b4a', '#4ad2ff', '#ffd23f', '#7cff6b', '#c77dff', '#ff9ff3'];

export class Simulation {
  world: WorldState;
  readonly gen: WorldGen;
  readonly col: CollisionWorld;
  rng: Rng;
  out: SimOutput = Simulation.emptyOutput();
  private pendingInputs = new Map<string, InputFrame[]>();
  private recentActions = new Map<string, Set<number>>();
  private actionBudget = new Map<string, number>();
  /** transient, not saved */
  projectiles = new Map<string, import('../state').Projectile>();
  /** latest driver input per vehicle (transient) */
  vehicleInputs = new Map<string, InputFrame>();
  readonly log: (msg: string) => void;

  static emptyOutput(): SimOutput {
    return { dirty: new Set(), fx: [], notify: [], results: [], chat: [], roster: false };
  }

  constructor(opts: { seed?: number | string; world?: WorldState; name?: string; log?: (msg: string) => void; settings?: Partial<WorldState['settings']> }) {
    this.log = opts.log ?? (() => {});
    if (opts.world) {
      this.world = opts.world;
    } else {
      const seed = typeof opts.seed === 'string' ? hashString(opts.seed) : (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
      const rng = new Rng(seed ^ 0x51ed);
      this.world = {
        seed, name: opts.name ?? 'New World', tick: 0, time: 0,
        dayOffset: (TIME.startHour / 24) * TIME.dayLengthSeconds,
        settings: { ...DEFAULT_SETTINGS, ...opts.settings },
        weather: initialWeather(rng), rng: rng.getState(), nextId: 1,
        players: {}, nodes: {}, structures: {}, containers: {}, items: {}, creatures: {}, vehicles: {}, zones: {},
        events: [], nextEventAt: TIME.dayLengthSeconds * 0.5, waypoints: [],
        progression: { beaconId: null, beaconStartedAt: 0, rescueAt: 0, rescued: false, milestones: [], discoveredIslands: [0] },
      };
    }
    this.rng = Rng.fromState(this.world.rng);
    this.gen = new WorldGen(this.world.seed);
    this.col = new CollisionWorld(this.gen, (id) => this.isNodeDepleted(id));
    for (const s of Object.values(this.world.structures)) this.col.addStructure(s, !!(STRUCTURES[s.type]?.door && s.on));
    if (!opts.world) {
      initWorldContainers(this);
      initZones(this);
    }
    // players loaded from a save start disconnected
    for (const p of Object.values(this.world.players)) { p.connected = false; p.openContainer = null; p.sleeping = false; p.fishing = null; }
  }

  // ------------------------------------------------------------------ ids / helpers
  newId(prefix: string): string { return `${prefix}${(this.world.nextId++).toString(36)}`; }
  get now(): number { return this.world.time; }
  get hour(): number { return hourOf(this.world); }

  isNodeDepleted(id: string): boolean {
    const n = this.world.nodes[id];
    return !!n && n.respawnAt !== undefined && n.respawnAt > this.world.time;
  }

  waterLevel = (x: number, z: number): number => {
    const depth = -this.gen.heightAt(x, z);
    return waveHeight(x, z, this.world.time, seaState(this.world.weather)) * shoreDamping(depth);
  };

  fx(k: string, x: number, y: number, z: number, a?: string, b?: number, p?: string): void {
    this.out.fx.push({ k, x, y, z, a, b, p });
  }

  notify(to: string | null, text: string, level: 'info' | 'good' | 'warn' | 'bad' = 'info'): void {
    this.out.notify.push({ to, text, level });
  }

  markPlayer(id: string): void { this.out.dirty.add(`p:${id}`); }
  markStructure(id: string): void { this.out.dirty.add(`s:${id}`); }
  markContainer(id: string): void { this.out.dirty.add(`c:${id}`); }

  // ------------------------------------------------------------------ players
  /** Join or rejoin. `token` is a stable client identity (persisted locally by the client). */
  addPlayer(token: string, name: string, color?: string): PlayerState {
    const id = 'p' + (hashString(token) >>> 0).toString(36);
    let p = this.world.players[id];
    const online = Object.values(this.world.players).filter((x) => x.connected).length;
    if (!p) {
      const idx = Object.keys(this.world.players).length;
      const sp = this.gen.spawnPoint(online);
      p = this.newPlayer(id, name, color ?? COLORS[idx % COLORS.length]!, sp);
      this.world.players[id] = p;
      this.notify(null, `${name} washed ashore.`, 'info');
      this.log(`player ${name} (${id}) created`);
    } else {
      p.name = name.slice(0, 24) || p.name;
      this.notify(null, `${p.name} rejoined.`, 'info');
      this.log(`player ${p.name} (${id}) rejoined`);
    }
    p.connected = true;
    p.lastInputSeq = 0;
    this.pendingInputs.set(id, []);
    this.recentActions.set(id, new Set());
    this.out.roster = true;
    this.markPlayer(id);
    return p;
  }

  newPlayer(id: string, name: string, color: string, sp: { x: number; y: number; z: number }): PlayerState {
    const inv = emptyInventory();
    return {
      id, name: name.slice(0, 24) || 'Survivor', color, connected: false,
      pos: { ...sp }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, crouching: false, sprinting: false, swimming: false, underwater: false,
      vehicleId: null, seat: -1,
      health: SURVIVAL.maxHealth, stamina: SURVIVAL.maxStamina, hunger: 80, thirst: 80, oxygen: SURVIVAL.maxOxygen,
      bodyTemp: SURVIVAL.bodyTempNormal, wetness: 0.6, effects: {}, inventory: inv, hotbar: 0, discovered: [],
      craftQueue: [], respawn: null, downed: 0, dead: false, deathAt: 0, invulnUntil: 0, lastInputSeq: 0, staminaDelay: 0,
      lastUseAt: 0, fishing: null, sleeping: false, explored: [], milestones: [],
      stats: { deaths: 0, crafted: 0, harvested: 0, distance: 0, daysSurvived: 0 }, openContainer: null, lastEnvTemp: 28,
    };
  }

  removePlayer(id: string): void {
    const p = this.world.players[id];
    if (!p) return;
    p.connected = false;
    p.openContainer = null;
    p.fishing = null;
    p.sleeping = false;
    if (p.vehicleId) this.leaveVehicle(p);
    this.pendingInputs.delete(id);
    this.recentActions.delete(id);
    this.notify(null, `${p.name} left the island.`, 'info');
    this.out.roster = true;
    this.log(`player ${p.name} (${id}) disconnected`);
  }

  leaveVehicle(p: PlayerState): void {
    const v = p.vehicleId ? this.world.vehicles[p.vehicleId] : undefined;
    if (v) {
      const i = v.seats.indexOf(p.id);
      if (i >= 0) v.seats[i] = null;
      // step off to the side
      const side = Math.cos(v.yaw) * 2.4, sideZ = -Math.sin(v.yaw) * 2.4;
      p.pos.x = v.x + side; p.pos.z = v.z + sideZ;
      p.pos.y = Math.max(this.gen.heightAt(p.pos.x, p.pos.z), this.waterLevel(p.pos.x, p.pos.z) - 1.4);
    }
    p.vehicleId = null;
    p.seat = -1;
  }

  queueInputs(playerId: string, frames: InputFrame[]): void {
    const q = this.pendingInputs.get(playerId);
    const p = this.world.players[playerId];
    if (!q || !p || !Array.isArray(frames)) return;
    for (const raw of frames.slice(0, SIM.maxBufferedInputs)) {
      const f = sanitizeInput(raw);
      if (f.seq <= p.lastInputSeq) continue; // duplicate / redundant resend
      if (q.length && f.seq <= q[q.length - 1]!.seq) continue;
      q.push(f);
    }
    // anti-speedhack: never allow more than the cap to accumulate
    if (q.length > SIM.maxBufferedInputs) q.splice(0, q.length - SIM.maxBufferedInputs);
  }

  /** Validate + dedupe + rate-limit, then dispatch. */
  submitAction(playerId: string, actionId: number, action: Action): void {
    const p = this.world.players[playerId];
    if (!p || !p.connected) return;
    const seen = this.recentActions.get(playerId)!;
    if (seen.has(actionId)) return; // duplicate packet: ignore silently (already answered)
    seen.add(actionId);
    if (seen.size > NET.actionDedupeWindow) seen.delete(seen.values().next().value!);
    const budget = this.actionBudget.get(playerId) ?? NET.maxActionsPerSecond;
    if (budget <= 0) { this.out.results.push({ to: playerId, id: actionId, ok: false, reason: 'Too many actions' }); return; }
    this.actionBudget.set(playerId, budget - 1);
    let res: { ok: boolean; reason?: string };
    try {
      res = handleAction(this, p, action);
    } catch (e) {
      this.log(`action error ${(action as { a?: string })?.a}: ${(e as Error).message}`);
      res = { ok: false, reason: 'Invalid action' };
    }
    this.out.results.push({ to: playerId, id: actionId, ok: res.ok, reason: res.reason });
  }

  // ------------------------------------------------------------------ world items / containers
  spawnItem(stack: ItemStack, x: number, y: number, z: number): DroppedItem {
    const id = this.newId('i');
    const it: DroppedItem = { id, stack, x, y: y + 0.3, z, vy: 1.5, floating: false, despawnAt: this.now + TIME.dayLengthSeconds * 2 };
    this.world.items[id] = it;
    this.out.dirty.add(`i:${id}`);
    return it;
  }

  /** Give items to a player; overflow drops at their feet. */
  give(p: PlayerState, id: string, qty: number, extra?: Partial<ItemStack>): number {
    let left = qty;
    while (left > 0) {
      const st = makeStack(id, left, this.now);
      if (extra) Object.assign(st, extra);
      const n = st.qty;
      addStack(p.inventory.slots, st);
      if (st.qty > 0) this.spawnItem(st, p.pos.x, p.pos.y + 0.5, p.pos.z);
      left -= n;
    }
    this.discover(p, id);
    this.markPlayer(p.id);
    return qty;
  }

  discover(p: PlayerState, id: string): void {
    if (!p.discovered.includes(id)) {
      p.discovered.push(id);
      this.markPlayer(p.id);
    }
  }

  milestone(p: PlayerState | null, id: string, text?: string): void {
    if (p && !p.milestones.includes(id)) {
      p.milestones.push(id);
      this.markPlayer(p.id);
      if (text) this.notify(p.id, text, 'good');
    }
    if (!this.world.progression.milestones.includes(id)) {
      this.world.progression.milestones.push(id);
      this.out.dirty.add('g');
    }
  }

  createContainer(kind: ContainerState['kind'], slots: number, x: number, y: number, z: number, opts: Partial<ContainerState> = {}): ContainerState {
    const id = opts.id ?? this.newId('c');
    const c: ContainerState = { id, kind, slots: new Array(slots).fill(null), x, y, z, ...opts };
    this.world.containers[id] = c;
    this.markContainer(id);
    return c;
  }

  removeContainer(id: string, dropContents: boolean): void {
    const c = this.world.containers[id];
    if (!c) return;
    if (dropContents) for (const s of c.slots) if (s) this.spawnItem(s, c.x, c.y, c.z);
    delete this.world.containers[id];
    for (const p of Object.values(this.world.players)) if (p.openContainer === id) { p.openContainer = null; this.markPlayer(p.id); }
    this.out.dirty.add(`c:${id}`);
  }

  addStructure(s: StructureState): void {
    this.world.structures[s.id] = s;
    this.col.addStructure(s, !!(STRUCTURES[s.type]?.door && s.on));
    this.markStructure(s.id);
  }

  removeStructure(id: string): void {
    const s = this.world.structures[id];
    if (!s) return;
    if (s.containerId) this.removeContainer(s.containerId, true);
    delete this.world.structures[id];
    this.col.removeStructure(id);
    this.markStructure(id);
    for (const p of Object.values(this.world.players)) if (p.respawn?.structureId === id) { p.respawn = null; this.markPlayer(p.id); }
    if (this.world.progression.beaconId === id) { this.world.progression.beaconId = null; this.world.progression.rescueAt = 0; this.out.dirty.add('g'); }
  }

  /** Is the point covered by a roof/floor/shelter structure? */
  isSheltered(x: number, y: number, z: number): boolean {
    const hit = this.col.raycastStructures(x, y + 1.0, z, 0, 1, 0, 12);
    if (hit) {
      const s = this.world.structures[hit.id];
      if (s && STRUCTURES[s.type]?.providesShelter) return true;
    }
    // lean-tos are not solid: check proximity
    for (const s of Object.values(this.world.structures)) {
      if (s.type !== 'lean_to') continue;
      if (Math.abs(s.x - x) < 1.4 && Math.abs(s.z - z) < 1.4 && Math.abs(s.y - y) < 2) return true;
    }
    return false;
  }

  heldItem(p: PlayerState): ItemStack | null {
    return p.inventory.slots[p.hotbar] ?? null;
  }

  // ------------------------------------------------------------------ main tick
  tick(): SimOutput {
    const dt = SIM.dt;
    const w = this.world;
    w.tick++;
    w.time += dt;
    for (const id of this.actionBudget.keys()) this.actionBudget.set(id, Math.min(NET.maxActionsPerSecond, (this.actionBudget.get(id) ?? 0) + NET.maxActionsPerSecond * dt));

    tickWeather(w.weather, w.time, dt, this.rng, () => this.fx('lightning', 0, 0, 0));
    this.tickPlayersMovement();
    tickSurvival(this, dt);
    tickCrafting(this, dt);
    tickStations(this, dt);
    tickWildlife(this, dt);
    tickVehicles(this, dt);
    tickProjectiles(this, dt);
    tickWorldEvents(this, dt);
    this.tickItems(dt);
    this.tickNodes();
    this.tickSleep();
    w.rng = this.rng.getState();
    const out = this.out;
    this.out = Simulation.emptyOutput();
    return out;
  }

  private moveEnv(p: PlayerState): MoveEnv {
    const weight = totalWeight(p.inventory);
    const cap = carryCapacity(p.inventory);
    const over = Math.max(0, weight - cap) / cap;
    let speedMul = 1 - Math.min(0.6, over * 1.2);
    if (p.effects.fracture) speedMul *= 0.6;
    if (p.effects.exhausted) speedMul *= 0.8;
    let swimMul = 1;
    for (const k of ['head', 'body', 'back', 'feet'] as const) {
      const e = p.inventory.equip[k];
      if (e) swimMul *= ITEMS[e.id]?.equip?.swimSpeedMul ?? 1;
    }
    return {
      col: this.col, waterLevel: this.waterLevel, speedMul, swimMul,
      canSprint: p.stamina > 5 && !p.effects.exhausted && !p.effects.fracture && over < 0.5,
      canJump: p.stamina > SURVIVAL.jumpStaminaCost && !p.effects.fracture,
    };
  }

  private tickPlayersMovement(): void {
    for (const p of Object.values(this.world.players)) {
      if (!p.connected) continue;
      const q = this.pendingInputs.get(p.id);
      if (!q) continue;
      // Process at most the frames that fit into this tick (+ catch-up allowance);
      // excess frames stay queued so a client cannot move faster than real time.
      const maxFrames = Math.ceil(SIM.dt / SIM.moveStep) + 3;
      const frames = q.splice(0, maxFrames);
      if (p.dead || p.downed > 0 || p.sleeping) {
        if (frames.length) p.lastInputSeq = frames[frames.length - 1]!.seq;
        if (frames.length) { const f = frames[frames.length - 1]!; p.yaw = f.yaw; p.pitch = f.pitch; }
        continue;
      }
      if (p.vehicleId) {
        // seated: inputs drive the vehicle if we are the driver
        const v = this.world.vehicles[p.vehicleId];
        const last = frames[frames.length - 1];
        if (last) {
          p.yaw = last.yaw; p.pitch = last.pitch; p.lastInputSeq = last.seq;
          if (v && v.seats[0] === p.id) this.vehicleInputs.set(v.id, last);
          if (last.jump && frames.some((f) => f.jump)) this.leaveVehicle(p);
        }
        continue;
      }
      const env = this.moveEnv(p);
      const ms = moveStateFrom(p);
      for (const f of frames) {
        const ox = ms.x, oz = ms.z;
        const wasGround = ms.onGround;
        stepMovement(ms, f, env, SIM.moveStep);
        p.stats.distance += Math.hypot(ms.x - ox, ms.z - oz);
        if (f.jump && wasGround && !ms.onGround && ms.vy > 0) { p.stamina -= SURVIVAL.jumpStaminaCost; p.staminaDelay = SURVIVAL.staminaRegenDelay; }
        const cost = movementStaminaCost(ms) * SIM.moveStep;
        if (cost > 0) { p.stamina = Math.max(0, p.stamina - cost); p.staminaDelay = SURVIVAL.staminaRegenDelay; }
        if (ms.landingSpeed > PLAYER.fallDamageMinSpeed) {
          const dmg = (ms.landingSpeed - PLAYER.fallDamageMinSpeed) * PLAYER.fallDamagePerMs;
          applyDamage(this, p, dmg, 'fall');
          if (dmg > 25 && this.rng.chance(0.5)) { p.effects.fracture = 1e9; this.notify(p.id, 'You hear a crack. Your leg is fractured — craft a splint.', 'bad'); }
          this.fx('land_hard', ms.x, ms.y, ms.z);
        }
        p.lastInputSeq = f.seq;
        // world bounds
        const lim = this.gen.half - 5;
        ms.x = Math.max(-lim, Math.min(lim, ms.x));
        ms.z = Math.max(-lim, Math.min(lim, ms.z));
        env.canSprint = env.canSprint && p.stamina > 0;
      }
      if (frames.length) {
        p.pos.x = ms.x; p.pos.y = ms.y; p.pos.z = ms.z;
        p.vel.x = ms.vx; p.vel.y = ms.vy; p.vel.z = ms.vz;
        p.yaw = ms.yaw; p.pitch = ms.pitch;
        p.onGround = ms.onGround; p.crouching = ms.crouching; p.sprinting = ms.sprinting;
        p.swimming = ms.swimming; p.underwater = ms.underwater;
        if (p.fishing && Math.hypot(ms.vx, ms.vz) > 2.5) { p.fishing = null; this.notify(p.id, 'Your line went slack.', 'info'); }
        this.trackExploration(p);
      }
    }
  }

  private trackExploration(p: PlayerState): void {
    const key = `${Math.floor(p.pos.x / 128)},${Math.floor(p.pos.z / 128)}`;
    if (!p.explored.includes(key)) {
      // reveal a 3x3 neighbourhood (you can see further than you stand)
      const cx = Math.floor(p.pos.x / 128), cz = Math.floor(p.pos.z / 128);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const k = `${cx + dx},${cz + dz}`;
        if (!p.explored.includes(k)) p.explored.push(k);
      }
      this.markPlayer(p.id);
      const isl = this.gen.islandAt(p.pos.x, p.pos.z);
      if (isl && this.gen.heightAt(p.pos.x, p.pos.z) > 0 && !this.world.progression.discoveredIslands.includes(isl.id)) {
        this.world.progression.discoveredIslands.push(isl.id);
        this.out.dirty.add('g');
        this.notify(null, `${p.name} discovered ${isl.name}.`, 'good');
        this.milestone(p, 'new_island');
      }
    }
  }

  private tickItems(dt: number): void {
    for (const it of Object.values(this.world.items)) {
      if (this.now > it.despawnAt) { delete this.world.items[it.id]; this.out.dirty.add(`i:${it.id}`); continue; }
      const ground = this.gen.heightAt(it.x, it.z);
      const water = this.waterLevel(it.x, it.z);
      const floats = (ITEMS[it.stack.id]?.weight ?? 1) < 1.6 && water > ground + 0.2;
      let moved = false;
      if (floats) {
        const target = water - 0.05;
        if (Math.abs(it.y - target) > 0.05 || !it.floating) {
          it.y += (target - it.y) * Math.min(1, dt * 3);
          it.floating = true;
          moved = Math.abs(it.y - target) > 0.25;
        }
        // drift with wind slowly
        const w = this.world.weather;
        it.x += Math.cos(w.windDir) * w.wind * 0.15 * dt;
        it.z += Math.sin(w.windDir) * w.wind * 0.15 * dt;
        if (this.world.tick % 40 === 0) moved = true;
      } else if (it.y > ground + 0.05 || it.vy !== 0) {
        it.vy -= 9.8 * dt;
        it.y += it.vy * dt;
        if (it.y <= ground + 0.05) { it.y = ground + 0.05; it.vy = 0; moved = true; }
      }
      if (moved) this.out.dirty.add(`i:${it.id}`);
    }
  }

  private tickNodes(): void {
    if (this.world.tick % 20 !== 0) return;
    for (const [id, n] of Object.entries(this.world.nodes)) {
      if (n.respawnAt !== undefined && n.respawnAt <= this.now) {
        delete this.world.nodes[id];
        this.out.dirty.add(`n:${id}`);
      }
    }
  }

  private tickSleep(): void {
    const online = Object.values(this.world.players).filter((p) => p.connected && !p.dead);
    if (!online.length) return;
    if (online.every((p) => p.sleeping)) {
      const h = this.hour;
      if (h > 19 || h < 6) {
        const hoursToDawn = h > 19 ? 24 - h + 6.5 : 6.5 - h;
        const skip = (hoursToDawn / 24) * TIME.dayLengthSeconds;
        this.world.dayOffset += skip;
        for (const p of online) {
          p.sleeping = false;
          p.hunger = Math.max(0, p.hunger - hoursToDawn * 1.2);
          p.thirst = Math.max(0, p.thirst - hoursToDawn * 1.8);
          p.health = Math.min(SURVIVAL.maxHealth, p.health + hoursToDawn * 3);
          p.stamina = SURVIVAL.maxStamina;
          this.markPlayer(p.id);
        }
        this.notify(null, 'Everyone rests through the night. Dawn breaks.', 'good');
      }
    }
  }

  // ------------------------------------------------------------------ queries used by many systems
  playersNear(x: number, z: number, r: number): PlayerState[] {
    const out: PlayerState[] = [];
    for (const p of Object.values(this.world.players)) {
      if (!p.connected || p.dead) continue;
      if ((p.pos.x - x) ** 2 + (p.pos.z - z) ** 2 <= r * r) out.push(p);
    }
    return out;
  }

  respawnPlayer(p: PlayerState, at: 'bed' | 'beach'): boolean {
    if (!p.dead) return false;
    let pos = this.gen.spawnPoint(0);
    if (at === 'bed' && p.respawn) {
      const s = p.respawn.structureId ? this.world.structures[p.respawn.structureId] : null;
      if (s) pos = { x: s.x, y: s.y + 0.6, z: s.z + 1.2 };
      else { this.notify(p.id, 'Your bed was destroyed. Respawning on the beach.', 'warn'); }
    }
    pos.y = Math.max(pos.y, this.gen.heightAt(pos.x, pos.z) + 0.05);
    p.pos = { ...pos };
    p.vel = { x: 0, y: 0, z: 0 };
    p.dead = false;
    p.downed = 0;
    const easy = this.world.settings.difficulty === 'relaxed';
    p.health = easy ? 100 : 70;
    p.stamina = SURVIVAL.maxStamina;
    p.hunger = Math.max(p.hunger, easy ? 70 : 50);
    p.thirst = Math.max(p.thirst, easy ? 70 : 50);
    p.oxygen = SURVIVAL.maxOxygen;
    p.bodyTemp = SURVIVAL.bodyTempNormal;
    p.effects = {};
    p.invulnUntil = this.now + PLAYER.respawnInvulnSeconds;
    this.markPlayer(p.id);
    this.fx('respawn', pos.x, pos.y, pos.z, undefined, undefined, p.id);
    this.notify(null, `${p.name} is back on their feet.`, 'info');
    return true;
  }

  kill(p: PlayerState, cause: string): void { killPlayer(this, p, cause); }
}
