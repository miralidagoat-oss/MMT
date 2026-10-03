/**
 * Wildlife AI: per-species finite state machines ticked only near players.
 * Decisions run at SIM.creatureThinkInterval (staggered), movement every tick.
 * Randomness is derived from (creature seed, tick) so it is deterministic.
 */
import { SIM, TIME } from '../config';
import { CREATURES } from '../defs/creatures';
import { STRUCTURES } from '../defs/structures';
import { hashInts, hash01 } from '../math/rng';
import { wrapAngle, clamp } from '../math/vec';
import { isNight } from '../systems/weather';
import type { CreatureDef, CreatureKind } from '../defs/types';
import type { CreatureMode, CreatureState, PlayerState, StructureState } from '../state';
import { findUnsupported } from '../systems/building';
import type { SpawnZone } from '../world/worldgen';
import type { Simulation } from './simulation';
import { applyDamage } from './survival';
import { damageVehicle } from './vehicles';

const CARCASS_SECONDS = TIME.dayLengthSeconds * 0.25;

export function initZones(sim: Simulation): void {
  for (const z of sim.gen.spawnZones) {
    sim.world.zones[z.id] = { nextSpawnAt: 0 };
    for (let i = 0; i < z.count; i++) spawnCreature(sim, z, i);
  }
}

function spawnCreature(sim: Simulation, z: SpawnZone, salt: number): CreatureState | null {
  const def = CREATURES[z.kind];
  for (let attempt = 0; attempt < 12; attempt++) {
    const h = hashInts(sim.world.seed, sim.world.nextId, salt, attempt);
    const a = hash01(h, 1) * Math.PI * 2, d = Math.sqrt(hash01(h, 2)) * z.radius;
    const x = z.x + Math.cos(a) * d, zz = z.z + Math.sin(a) * d;
    const ground = sim.gen.heightAt(x, zz);
    if (!habitatOk(def, ground)) continue;
    const id = sim.newId('a');
    const c: CreatureState = {
      id, kind: z.kind, zone: z.id, x, y: initialY(def, ground), z: zz, yaw: a, speed: 0, hp: def.maxHp, mode: 'idle', target: null,
      tx: x, tz: zz, ty: 0, modeUntil: 0, nextAttackAt: 0, rng: h, diedAt: 0, butchered: false, lastHitBy: null, bleed: 0,
    };
    sim.world.creatures[id] = c;
    return c;
  }
  return null;
}

function habitatOk(def: CreatureDef, ground: number): boolean {
  switch (def.habitat) {
    case 'beach': return ground > 0.15 && ground < 3.5;
    case 'land': case 'jungle': return ground > 1.5;
    case 'shallows': return ground < -1.4 && ground > -12;
    case 'deep': return ground < -6;
    case 'air': return true;
  }
}

function initialY(def: CreatureDef, ground: number): number {
  if (def.habitat === 'air') return Math.max(ground, 0) + 14;
  if (def.aquatic) return Math.min(-0.8, ground + 1.2);
  return ground;
}

function rand(c: CreatureState, tick: number, k: number): number { return hash01(c.rng, tick, k); }

function zoneOf(sim: Simulation, c: CreatureState): SpawnZone | undefined {
  return sim.gen.spawnZones.find((z) => z.id === c.zone);
}

export function tickWildlife(sim: Simulation, dt: number): void {
  const players = Object.values(sim.world.players).filter((p) => p.connected && !p.dead);
  const tick = sim.world.tick;
  const night = isNight(sim.hour);
  const R2 = SIM.creatureActiveRadius ** 2;
  // defensive structures that hurt on touch (spike barricades)
  const spikes = tick % 5 === 0 ? Object.values(sim.world.structures).filter((s) => STRUCTURES[s.type]?.damageOnTouch) : [];
  for (const c of Object.values(sim.world.creatures)) {
    if (c.mode !== 'dead' && spikes.length && !CREATURES[c.kind].aquatic && CREATURES[c.kind].habitat !== 'air') {
      for (const s of spikes) {
        if (Math.hypot(s.x - c.x, s.z - c.z) > 1.6 + CREATURES[c.kind].radius) continue;
        damageCreature(sim, c, STRUCTURES[s.type]!.damageOnTouch!, null, 0.3);
        if ((c.mode as string) !== 'dead') fleeFrom(c, null, sim.now, 3); // damage may have killed it
        break;
      }
    }
    if (c.mode === 'dead') {
      if (sim.now - c.diedAt > CARCASS_SECONDS || c.butchered) removeCreature(sim, c);
      continue;
    }
    // activation: only simulate creatures near someone
    let near = false;
    for (const p of players) if ((p.pos.x - c.x) ** 2 + (p.pos.z - c.z) ** 2 < R2) { near = true; break; }
    if (!near) continue;
    const def = CREATURES[c.kind];
    if (c.bleed > 0) { c.bleed -= dt; c.hp -= 1.2 * dt; if (c.hp <= 0) { killCreature(sim, c, c.lastHitBy); continue; } }
    if ((tick + (c.rng & 3)) % SIM.creatureThinkInterval === 0) think(sim, c, def, players, night);
    move(sim, c, def, dt);
    if (c.mode === 'attack' || c.mode === 'chase') tryAttack(sim, c, def);
  }
  // respawn depleted zones (only when no player is watching)
  if (tick % 100 === 0) respawnZones(sim, players);
}

function removeCreature(sim: Simulation, c: CreatureState) {
  delete sim.world.creatures[c.id];
  const z = sim.world.zones[c.zone];
  if (z) z.nextSpawnAt = Math.max(z.nextSpawnAt, sim.now + CREATURES[c.kind].respawnSeconds * sim.world.settings.resourceRespawnMul);
}

function respawnZones(sim: Simulation, players: PlayerState[]): void {
  const counts = new Map<string, number>();
  for (const c of Object.values(sim.world.creatures)) counts.set(c.zone, (counts.get(c.zone) ?? 0) + 1);
  for (const z of sim.gen.spawnZones) {
    const st = sim.world.zones[z.id] ?? (sim.world.zones[z.id] = { nextSpawnAt: 0 });
    let want = z.count;
    // frenzy events add sharks
    if (z.kind === 'shark' && sim.world.events.some((e) => e.kind === 'shark_frenzy' && Math.hypot(e.x - z.x, e.z - z.z) < 400)) want += 2;
    if (z.kind === 'fish' && sim.world.events.some((e) => e.kind === 'fish_run' && Math.hypot(e.x - z.x, e.z - z.z) < 400)) want += 4;
    if ((counts.get(z.id) ?? 0) >= want || sim.now < st.nextSpawnAt) continue;
    if (players.some((p) => Math.hypot(p.pos.x - z.x, p.pos.z - z.z) < 45)) continue;
    spawnCreature(sim, z, Math.floor(sim.now));
    st.nextSpawnAt = sim.now + 30;
  }
}

function setMode(c: CreatureState, mode: CreatureMode, until: number, target: string | null = c.target) {
  c.mode = mode;
  c.modeUntil = until;
  c.target = target;
}

/** Detection: sight cone-less range + hearing scaled by player noise; LOS for land animals. */
function detect(sim: Simulation, c: CreatureState, def: CreatureDef, players: PlayerState[], night: boolean): PlayerState | null {
  let best: PlayerState | null = null;
  let bd = Infinity;
  const boost = night ? def.nocturnalBoost ?? 1 : 1;
  for (const p of players) {
    if (p.downed > 0 && def.aggression !== 'predator') continue;
    const d = Math.hypot(p.pos.x - c.x, p.pos.y - c.y, p.pos.z - c.z);
    if (def.aquatic && !(p.swimming || p.pos.y < 0.2) && c.kind !== 'shark') continue;
    const noise = p.sprinting ? 1.6 : p.crouching ? 0.45 : p.swimming ? 1.2 : 1;
    const sight = def.sightRange * boost * (p.crouching ? 0.6 : 1) * (night && !def.nocturnalBoost ? 0.6 : 1);
    const hear = def.hearingRange * noise * boost;
    if (d > Math.max(sight, hear)) continue;
    if (d > hear && !def.aquatic && !sim.col.lineOfSight(c.x, c.y + 0.6, c.z, p.pos.x, p.pos.y + 1.4, p.pos.z)) continue;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function think(sim: Simulation, c: CreatureState, def: CreatureDef, players: PlayerState[], night: boolean): void {
  const tick = sim.world.tick;
  const now = sim.now;
  const zone = zoneOf(sim, c);
  const threat = detect(sim, c, def, players, night);
  const tgt = c.target ? sim.world.players[c.target] : undefined;
  const lowHp = c.hp < def.maxHp * def.fleeHealthFraction;

  // flee logic shared by most species
  if (lowHp && def.aggression !== 'passive' && c.mode !== 'flee') {
    fleeFrom(c, tgt ?? threat, now, 6);
    return;
  }
  if (c.mode === 'flee' && now < c.modeUntil) return;

  switch (def.aggression) {
    case 'passive': {
      if (threat && Math.hypot(threat.pos.x - c.x, threat.pos.z - c.z) < def.sightRange * 0.7) { fleeFrom(c, threat, now, 4); return; }
      break;
    }
    case 'defensive': {
      const provoked = c.lastHitBy && sim.world.players[c.lastHitBy] && now < c.modeUntil + 8;
      if (threat) {
        const d = Math.hypot(threat.pos.x - c.x, threat.pos.z - c.z);
        const strike = c.kind === 'snake' ? 3.2 : c.kind === 'ray' ? 2.2 : 1.6;
        if (d < strike || provoked) { setMode(c, 'chase', now + 4, threat.id); return; }
        if (c.kind === 'crab' && d < 5) { fleeFrom(c, threat, now, 3); return; }
      }
      break;
    }
    case 'territorial': {
      if (threat) {
        const d = Math.hypot(threat.pos.x - c.x, threat.pos.z - c.z);
        if (d < def.sightRange * 0.55 || c.lastHitBy === threat.id) { setMode(c, 'chase', now + 10, threat.id); return; }
        // warning posture: face the intruder
        c.yaw = Math.atan2(threat.pos.x - c.x, threat.pos.z - c.z);
        setMode(c, 'idle', now + 1.5, null);
        return;
      }
      break;
    }
    case 'predator': {
      // sharks: only hunt players in the water; harass rafts
      const swimmer = threat && (threat.swimming || threat.pos.y < -0.3) ? threat : null;
      const rafter = threat && threat.vehicleId ? threat : null;
      if (swimmer) {
        if (c.mode !== 'circle' && c.mode !== 'chase' && c.mode !== 'attack') { setMode(c, 'circle', now + 4 + rand(c, tick, 1) * 6, swimmer.id); return; }
        if (c.mode === 'circle' && now >= c.modeUntil) { setMode(c, 'chase', now + 8, swimmer.id); return; }
        if (c.mode === 'chase' || c.mode === 'circle') return;
      } else if (rafter && rand(c, tick, 7) < 0.02) {
        const v = sim.world.vehicles[rafter.vehicleId!];
        if (v && Math.hypot(v.x - c.x, v.z - c.z) < 6) { damageVehicle(sim, v, 12, 'shark'); sim.fx('shark_bump', v.x, 0, v.z); }
        setMode(c, 'circle', now + 6, rafter.id);
        return;
      }
      if (c.mode === 'chase' || c.mode === 'circle') { setMode(c, 'return', now + 6, null); }
      break;
    }
  }

  if (now < c.modeUntil && (c.mode === 'wander' || c.mode === 'idle' || c.mode === 'feed' || c.mode === 'return')) return;
  // idle / wander / feed cycle
  const r = rand(c, tick, 2);
  if (r < 0.35) setMode(c, 'idle', now + 2 + rand(c, tick, 3) * 5, null);
  else if (r < 0.5 && !def.aquatic && def.habitat !== 'air') setMode(c, 'feed', now + 3 + rand(c, tick, 4) * 4, null);
  else {
    const zx = zone?.x ?? c.x, zz = zone?.z ?? c.z, zr = zone?.radius ?? 20;
    for (let k = 0; k < 6; k++) {
      const a = rand(c, tick, 10 + k) * Math.PI * 2, d = Math.sqrt(rand(c, tick, 20 + k)) * zr;
      const tx = zx + Math.cos(a) * d, tz = zz + Math.sin(a) * d;
      if (habitatOk(def, sim.gen.heightAt(tx, tz))) {
        c.tx = tx; c.tz = tz;
        c.ty = def.aquatic ? clamp(sim.gen.heightAt(tx, tz) + 0.8 + rand(c, tick, 30) * 3, -40, -0.8) : 0;
        setMode(c, 'wander', now + 12, null);
        return;
      }
    }
    setMode(c, 'idle', now + 3, null);
  }
}

function fleeFrom(c: CreatureState, p: PlayerState | null | undefined, now: number, secs: number) {
  if (p) {
    const a = Math.atan2(c.x - p.pos.x, c.z - p.pos.z);
    c.tx = c.x + Math.sin(a) * 25;
    c.tz = c.z + Math.cos(a) * 25;
  }
  setMode(c, 'flee', now + secs, null);
}

function move(sim: Simulation, c: CreatureState, def: CreatureDef, dt: number): void {
  let tx = c.tx, tz = c.tz, ty = c.ty;
  let speed = 0;
  const tgt = c.target ? sim.world.players[c.target] : undefined;
  switch (c.mode) {
    case 'wander': case 'return': speed = def.speed; break;
    case 'flee': speed = def.runSpeed; break;
    case 'chase': case 'attack':
      if (tgt && !tgt.dead) { tx = tgt.pos.x; tz = tgt.pos.z; ty = tgt.pos.y + 0.6; speed = def.runSpeed; }
      else c.mode = 'idle';
      break;
    case 'circle':
      if (tgt) {
        const a = sim.now * 0.35 + (c.rng % 100);
        const r = 9;
        tx = tgt.pos.x + Math.cos(a) * r; tz = tgt.pos.z + Math.sin(a) * r; ty = Math.min(-1.2, tgt.pos.y);
        speed = def.speed * 1.3;
      }
      break;
    default: speed = 0;
  }
  const dx = tx - c.x, dz = tz - c.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.3 || speed === 0) { c.speed = 0; if (c.mode === 'wander') c.modeUntil = 0; return; }
  const want = Math.atan2(dx, dz);
  const turn = wrapAngle(want - c.yaw);
  c.yaw = wrapAngle(c.yaw + clamp(turn, -4 * dt, 4 * dt));
  const step = Math.min(dist, speed * dt);
  let nx = c.x + Math.sin(c.yaw) * step, nz = c.z + Math.cos(c.yaw) * step;
  const ground = sim.gen.heightAt(nx, nz);
  if (!habitatOk(def, ground) && !(def.aggression === 'territorial' && ground > 0)) {
    // blocked by habitat edge: pick a new goal next think
    c.modeUntil = 0;
    c.speed = 0;
    if (c.mode === 'flee' || c.mode === 'wander') c.mode = 'idle';
    return;
  }
  if (!def.aquatic && def.habitat !== 'air') {
    const res = sim.col.resolve(nx, ground, nz, def.radius, 1, 0.4);
    const blocked = Math.hypot(res.x - nx, res.z - nz) > 0.01;
    nx = res.x; nz = res.z;
    c.y = sim.gen.heightAt(nx, nz);
    // an enraged animal blocked by a building batters it
    if (blocked && (c.mode === 'chase' || c.mode === 'attack') && def.attackDamage > 0 && sim.now >= c.nextAttackAt) {
      const hit = nearestStructure(sim, nx, nz, def.radius + 1.2);
      if (hit) {
        c.nextAttackAt = sim.now + def.attackCooldown * 1.5;
        damageStructure(sim, hit, def.attackDamage * 0.6, def.name.toLowerCase());
      }
    }
  } else if (def.habitat === 'air') {
    c.y += (Math.max(ground, 0) + 12 - c.y) * dt;
  } else {
    const floor = sim.gen.heightAt(nx, nz) + 0.5;
    const surf = -0.7;
    const goal = clamp(ty || c.y, floor, surf);
    c.y += clamp(goal - c.y, -1.5 * dt, 1.5 * dt);
    c.y = clamp(c.y, floor, surf);
  }
  c.x = nx; c.z = nz;
  c.speed = speed;
}

function tryAttack(sim: Simulation, c: CreatureState, def: CreatureDef): void {
  if (!c.target || def.attackDamage <= 0) return;
  const p = sim.world.players[c.target];
  if (!p || p.dead) { c.target = null; c.mode = 'idle'; return; }
  const d = Math.hypot(p.pos.x - c.x, p.pos.y + 0.8 - c.y, p.pos.z - c.z);
  if (d > def.attackRange + 0.6) return;
  if (sim.now < c.nextAttackAt) return;
  c.nextAttackAt = sim.now + def.attackCooldown;
  const mul = sim.world.settings.creatureDamageMul * (sim.world.settings.difficulty === 'hard' ? 1.3 : sim.world.settings.difficulty === 'relaxed' ? 0.6 : 1);
  applyDamage(sim, p, def.attackDamage * mul, def.name.toLowerCase(), c.id);
  sim.fx('creature_attack', c.x, c.y, c.z, c.kind, undefined, p.id);
  const r = hash01(c.rng, sim.world.tick, 99);
  if (def.bleedChance && r < def.bleedChance) { p.effects.bleeding = 1e9; sim.notify(p.id, 'You are bleeding! Use a bandage.', 'bad'); }
  if (def.poisonChance && r < def.poisonChance) { p.effects.poisoned = 60; sim.notify(p.id, 'You have been poisoned.', 'bad'); }
  if (c.kind === 'shark' || c.kind === 'snake' || c.kind === 'ray') fleeFrom(c, p, sim.now, c.kind === 'shark' ? 5 : 3);
}

/** Damage a creature (from players/projectiles/barricades). */
export function damageCreature(sim: Simulation, c: CreatureState, amount: number, by: string | null, bleedChance = 0): void {
  if (c.mode === 'dead') return;
  const def = CREATURES[c.kind];
  c.hp -= amount;
  c.lastHitBy = by;
  sim.fx('creature_hit', c.x, c.y + 0.3, c.z, c.kind, amount);
  if (bleedChance && sim.rng.chance(bleedChance)) c.bleed = 10;
  if (c.hp <= 0) { killCreature(sim, c, by); return; }
  // reaction
  if (def.aggression === 'passive') fleeFrom(c, by ? sim.world.players[by] : null, sim.now, 5);
  else if (c.hp < def.maxHp * def.fleeHealthFraction) fleeFrom(c, by ? sim.world.players[by] : null, sim.now, 6);
  else if (by) setMode(c, 'chase', sim.now + 10, by);
}

export function killCreature(sim: Simulation, c: CreatureState, by: string | null): void {
  const def = CREATURES[c.kind];
  c.mode = 'dead';
  c.diedAt = sim.now;
  c.speed = 0;
  c.hp = 0;
  sim.fx('creature_die', c.x, c.y, c.z, c.kind);
  const killer = by ? sim.world.players[by] : undefined;
  if (killer) sim.milestone(killer, `kill_${c.kind}`, c.kind === 'shark' ? 'You killed a shark. The sea fears you a little more.' : undefined);
  if (!def.butcherTool) {
    // small creatures drop loot directly
    const target = killer ?? null;
    for (const l of def.loot) {
      const n = l.min + Math.floor(hash01(c.rng, 7, l.item.length) * (l.max - l.min + 1));
      if (n <= 0) continue;
      if (target && Math.hypot(target.pos.x - c.x, target.pos.z - c.z) < 6) sim.give(target, l.item, n);
      else sim.spawnItem({ id: l.item, qty: n }, c.x, c.y, c.z);
    }
    c.butchered = true;
  }
}

/** Harvest a carcass with a cutting tool. */
export function butcher(sim: Simulation, c: CreatureState, p: PlayerState): { ok: boolean; reason?: string } {
  if (c.mode !== 'dead' || c.butchered) return { ok: false, reason: 'Nothing to harvest' };
  const def = CREATURES[c.kind];
  for (const l of def.loot) {
    const n = l.min + Math.floor(sim.rng.next() * (l.max - l.min + 1));
    if (n > 0) sim.give(p, l.item, n);
  }
  c.butchered = true;
  sim.fx('butcher', c.x, c.y, c.z, c.kind, undefined, p.id);
  p.stats.harvested++;
  return { ok: true };
}

function nearestStructure(sim: Simulation, x: number, z: number, r: number): StructureState | null {
  let best: StructureState | null = null, bd = r;
  for (const s of Object.values(sim.world.structures)) {
    const d = Math.hypot(s.x - x, s.z - z) - Math.max(STRUCTURES[s.type]!.size[0], STRUCTURES[s.type]!.size[2]);
    if (d < bd && STRUCTURES[s.type]!.solid) { bd = d; best = s; }
  }
  return best;
}

/** Damage a structure; destroyed pieces collapse along with anything they supported. */
export function damageStructure(sim: Simulation, s: StructureState, amount: number, cause: string): void {
  s.hp -= amount;
  sim.fx('structure_hit', s.x, s.y + 1, s.z, cause, amount);
  sim.markStructure(s.id);
  if (s.hp > 0) return;
  const fallen = findUnsupported(sim.world.structures, s.id);
  sim.fx('collapse', s.x, s.y, s.z, s.type);
  sim.removeStructure(s.id);
  for (const f of fallen) sim.removeStructure(f);
  sim.notify(null, `A ${STRUCTURES[s.type]?.name ?? 'structure'} was destroyed by a ${cause}!`, 'warn');
}

export function creatureKinds(): CreatureKind[] { return Object.keys(CREATURES) as CreatureKind[]; }
