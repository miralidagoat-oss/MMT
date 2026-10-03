/**
 * Converts authoritative simulation state into network messages:
 * welcome (full sync for late joiners), per-tick snapshots with interest
 * management, and reliable world deltas built from the sim's dirty set.
 */
import { SIM, PROTOCOL_VERSION, WORLDGEN_VERSION } from '../config';
import { q } from '../math/vec';
import type { Simulation, SimOutput } from '../sim/simulation';
import type { PlayerState } from '../state';
import { FLAG, type NetCreature, type NetPlayer, type NetVehicle, type PrivatePlayer, type SelfState, type Snapshot, type WelcomeMsg, type WorldDelta } from './protocol';

export function privateOf(p: PlayerState): PrivatePlayer {
  return {
    inventory: p.inventory, hotbar: p.hotbar, discovered: p.discovered, milestones: p.milestones,
    respawn: p.respawn, explored: p.explored, stats: p.stats,
  };
}

export function roster(sim: Simulation) {
  return Object.values(sim.world.players).map((p) => ({ id: p.id, name: p.name, color: p.color, connected: p.connected }));
}

export function fullDelta(sim: Simulation, playerId: string): WorldDelta {
  const w = sim.world;
  return {
    t: 'delta',
    structures: { ...w.structures },
    containers: { ...w.containers },
    nodes: { ...w.nodes },
    items: { ...w.items },
    waypoints: w.waypoints,
    progression: w.progression,
    events: w.events,
    me: w.players[playerId] ? privateOf(w.players[playerId]!) : undefined,
  };
}

export function buildWelcome(sim: Simulation, playerId: string): WelcomeMsg {
  return {
    t: 'welcome', playerId, seed: sim.world.seed, worldName: sim.world.name, fingerprint: sim.gen.fingerprint(),
    worldgenVersion: WORLDGEN_VERSION, tickRate: SIM.tickRate, settings: sim.world.settings,
    full: fullDelta(sim, playerId), roster: roster(sim),
  };
}
void PROTOCOL_VERSION;

function netPlayer(sim: Simulation, p: PlayerState): NetPlayer {
  let f = 0;
  if (p.onGround) f |= FLAG.ground;
  if (p.crouching) f |= FLAG.crouch;
  if (p.sprinting) f |= FLAG.sprint;
  if (p.swimming) f |= FLAG.swim;
  if (p.underwater) f |= FLAG.underwater;
  if (p.downed > 0) f |= FLAG.downed;
  if (p.dead) f |= FLAG.dead;
  if (p.sleeping) f |= FLAG.sleeping;
  if (sim.now - p.lastUseAt < 0.35) f |= FLAG.using;
  return {
    id: p.id, n: p.name, c: p.color, x: q(p.pos.x), y: q(p.pos.y), z: q(p.pos.z), yaw: q(p.yaw, 0.001), pitch: q(p.pitch, 0.001),
    f, h: Math.round(p.health), it: p.inventory.slots[p.hotbar]?.id ?? '', v: p.vehicleId, s: p.seat,
  };
}

function selfState(sim: Simulation, p: PlayerState): SelfState {
  return {
    seq: p.lastInputSeq, x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
    og: p.onGround, cr: p.crouching, sw: p.swimming, uw: p.underwater,
    health: q(p.health, 0.1), stamina: q(p.stamina, 0.1), hunger: q(p.hunger, 0.1), thirst: q(p.thirst, 0.1), oxygen: q(p.oxygen, 0.1),
    bodyTemp: q(p.bodyTemp, 0.01), wetness: q(p.wetness, 0.01), envTemp: q(p.lastEnvTemp, 0.1), effects: roundEffects(p.effects),
    downed: q(p.downed, 0.1), dead: p.dead, sleeping: p.sleeping, vehicleId: p.vehicleId, seat: p.seat,
    fishing: p.fishing ? { phase: p.fishing.phase, x: p.fishing.x, z: p.fishing.z } : null,
    craftQueue: p.craftQueue.map((j) => ({ recipeId: j.recipeId, remaining: q(j.remaining, 0.1), total: j.total })),
    openContainer: p.openContainer, sheltered: !!p.effects.sheltered,
  };
}

function roundEffects(e: Record<string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k in e) o[k] = e[k]! > 1e8 ? -1 : Math.ceil(e[k]!);
  return o;
}

/**
 * Per-client snapshot memory: an entity is only re-sent when its quantized state
 * changed, or as a keep-alive once per KEEPALIVE_TICKS (clients prune entities
 * they have not heard about for a few seconds).
 */
export interface SnapshotCache { sent: Map<string, { sig: string; tick: number }> }
export const KEEPALIVE_TICKS = 20;
export function newSnapshotCache(): SnapshotCache { return { sent: new Map() }; }

function shouldSend(cache: SnapshotCache | undefined, id: string, sig: string, tick: number): boolean {
  if (!cache) return true;
  const prev = cache.sent.get(id);
  if (prev && prev.sig === sig && tick - prev.tick < KEEPALIVE_TICKS) return false;
  cache.sent.set(id, { sig, tick });
  return true;
}

export function buildSnapshot(sim: Simulation, playerId: string, cache?: SnapshotCache): Snapshot {
  const me = sim.world.players[playerId];
  const cx = me?.pos.x ?? 0, cz = me?.pos.z ?? 0;
  const R2 = SIM.interestRadius ** 2;
  const tick = sim.world.tick;
  const inRange = (x: number, z: number) => (x - cx) ** 2 + (z - cz) ** 2 <= R2;
  const players: NetPlayer[] = [];
  for (const p of Object.values(sim.world.players)) {
    if (!p.connected || p.id === playerId) continue;
    players.push(netPlayer(sim, p)); // teammates are always replicated (map markers)
  }
  const creatures: NetCreature[] = [];
  for (const c of Object.values(sim.world.creatures)) {
    if (!inRange(c.x, c.z)) continue;
    if (c.mode === 'dead' && c.butchered) continue;
    const nc: NetCreature = { id: c.id, k: c.kind, x: q(c.x, 0.02), y: q(c.y, 0.02), z: q(c.z, 0.02), yaw: q(c.yaw, 0.01), m: c.mode, h: Math.ceil(c.hp), sp: q(c.speed, 0.1) };
    // distant creatures update at a reduced rate
    const far = (c.x - cx) ** 2 + (c.z - cz) ** 2 > 120 * 120;
    if (far && (tick + c.id.length) % 4 !== 0 && cache?.sent.has(c.id)) continue;
    if (shouldSend(cache, c.id, `${nc.x}|${nc.y}|${nc.z}|${nc.yaw}|${nc.m}|${nc.h}|${nc.sp}`, tick)) creatures.push(nc);
  }
  const vehicles: NetVehicle[] = [];
  for (const v of Object.values(sim.world.vehicles)) {
    if (!inRange(v.x, v.z) && !(me && me.vehicleId === v.id)) continue;
    const nv: NetVehicle = {
      id: v.id, k: v.type, x: q(v.x), y: q(v.y), z: q(v.z), yaw: q(v.yaw, 0.001), p: q(v.pitch, 0.001), r: q(v.roll, 0.001),
      vx: q(v.vx), vz: q(v.vz), h: Math.ceil(v.hp), an: v.anchored, sl: v.sail, seats: v.seats, cid: v.containerId,
    };
    if (shouldSend(cache, v.id, JSON.stringify(nv), tick)) vehicles.push(nv);
  }
  const projectiles = [...sim.projectiles.values()].filter((p) => inRange(p.x, p.z))
    .map((p) => ({ id: p.id, x: q(p.x), y: q(p.y), z: q(p.z), vx: q(p.vx), vy: q(p.vy), vz: q(p.vz) }));
  const w = sim.world.weather;
  return {
    t: 'snap', tick: sim.world.tick, time: sim.world.time, dayOffset: sim.world.dayOffset,
    weather: { cloud: q(w.cloud, 0.001), rain: q(w.rain, 0.001), wind: q(w.wind, 0.001), waves: q(w.waves, 0.001), fog: q(w.fog, 0.001), windDir: q(w.windDir, 0.0001), lightningAt: w.lightningAt, kind: w.kind, next: w.next, blend: q(w.blend, 0.001) },
    players, creatures, vehicles, projectiles,
    self: me ? selfState(sim, me) : null,
  };
}

/** Shared portion of the reliable delta (identical for every client). */
export function buildSharedDelta(sim: Simulation, out: SimOutput): WorldDelta | null {
  const d: WorldDelta = { t: 'delta' };
  let any = false;
  const w = sim.world;
  for (const key of out.dirty) {
    const kind = key[0], id = key.slice(2);
    switch (kind) {
      case 's': (d.structures ??= {})[id] = w.structures[id] ?? null; any = true; break;
      case 'c': (d.containers ??= {})[id] = w.containers[id] ?? null; any = true; break;
      case 'n': (d.nodes ??= {})[id] = w.nodes[id] ?? null; any = true; break;
      case 'i': (d.items ??= {})[id] = w.items[id] ?? null; any = true; break;
      case 'w': d.waypoints = w.waypoints; any = true; break;
      case 'g': d.progression = w.progression; any = true; break;
      case 'e': d.events = w.events; any = true; break;
    }
  }
  return any ? d : null;
}

export function dirtyPlayers(out: SimOutput): string[] {
  const ids: string[] = [];
  for (const k of out.dirty) if (k.startsWith('p:')) ids.push(k.slice(2));
  return ids;
}
