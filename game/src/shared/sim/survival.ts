/**
 * Interconnected survival model: hunger, thirst, stamina, oxygen, body temperature,
 * wetness and status effects all feed into each other and into health.
 */
import { SURVIVAL, AMBIENT, TIME, PLAYER } from '../config';
import { clamp } from '../math/vec';
import { ITEMS } from '../defs/items';
import { STRUCTURES } from '../defs/structures';
import { ambientTemp, daylight, weatherTemp } from '../systems/weather';
import type { PlayerState } from '../state';
import type { Simulation } from './simulation';
import { tickFishing } from './fishing';

const PER_HOUR = 24 / TIME.dayLengthSeconds; // converts "per game hour" to per sim-second

function difficultyMul(sim: Simulation): number {
  const d = sim.world.settings.difficulty;
  return (d === 'relaxed' ? 0.6 : d === 'hard' ? 1.35 : 1) * sim.world.settings.survivalDrainMul;
}

function equipSum(p: PlayerState, key: 'insulation' | 'heatProtection' | 'armor' | 'oxygenBonus' | 'underwaterVision'): number {
  let s = 0;
  for (const k of ['head', 'body', 'back', 'feet'] as const) {
    const e = p.inventory.equip[k];
    if (e) s += ITEMS[e.id]?.equip?.[key] ?? 0;
  }
  return s;
}

/** Environmental temperature the player feels, before clothing. */
export function environmentTemp(sim: Simulation, p: PlayerState, sheltered: boolean): number {
  const w = sim.world.weather;
  const hour = sim.hour;
  let t = ambientTemp(hour, w);
  if (p.swimming) {
    t = 24 + weatherTemp(w) * 0.3 + AMBIENT.waterTempDelta;
    if (-sim.gen.heightAt(p.pos.x, p.pos.z) > AMBIENT.deepWaterDepth) t -= 3;
  } else {
    t += p.wetness * AMBIENT.wetTempDelta;
    if (!sheltered) t -= w.wind * 10 * AMBIENT.windChillPerMs;
    if (sheltered) t += daylight(hour) > 0.5 ? AMBIENT.shadeTempDelta : AMBIENT.shelterTempDelta;
  }
  // nearby fires
  for (const s of Object.values(sim.world.structures)) {
    if (!s.on) continue;
    const def = STRUCTURES[s.type];
    if (!def?.fire) continue;
    const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z, (s.y - p.pos.y) * 0.5);
    if (d < SURVIVAL.fireWarmRadius * 1.6) t += def.fire.warmth * clamp(1 - d / (SURVIVAL.fireWarmRadius * 1.6), 0, 1);
  }
  return t;
}

export function nearFire(sim: Simulation, p: PlayerState): boolean {
  for (const s of Object.values(sim.world.structures)) {
    if (s.on && STRUCTURES[s.type]?.fire && Math.hypot(s.x - p.pos.x, s.z - p.pos.z) < SURVIVAL.fireWarmRadius) return true;
  }
  return false;
}

export function tickSurvival(sim: Simulation, dt: number): void {
  const diff = difficultyMul(sim);
  const hour = sim.hour;
  const w = sim.world.weather;
  const slow = sim.world.tick % 10 === 0; // 2 Hz work
  for (const p of Object.values(sim.world.players)) {
    if (!p.connected || p.dead) continue;
    if (p.downed > 0) {
      p.downed -= dt;
      if (p.downed <= 0) killPlayer(sim, p, 'bled out');
      sim.markPlayer(p.id);
      continue;
    }

    const sheltered = slow ? sim.isSheltered(p.pos.x, p.pos.y, p.pos.z) : (p.effects.sheltered ?? 0) > 0;
    if (slow) { if (sheltered) p.effects.sheltered = 1e9; else delete p.effects.sheltered; }

    // ---- wetness
    if (p.swimming || p.underwater) p.wetness = 1;
    else {
      if (w.rain > 0.1 && !sheltered) p.wetness = Math.min(1, p.wetness + w.rain * 0.03 * dt);
      const fire = slow ? nearFire(sim, p) : (p.effects.warm ?? 0) > 0;
      if (slow) { if (fire) p.effects.warm = 1e9; else delete p.effects.warm; }
      const dry = fire ? 1 / SURVIVAL.wetDrySecondsAtFire : (daylight(hour) * (1 - w.rain)) / SURVIVAL.wetDrySecondsInSun;
      p.wetness = Math.max(0, p.wetness - dry * dt);
    }

    // ---- temperature
    if (slow) p.lastEnvTemp = environmentTemp(sim, p, sheltered);
    let env = p.lastEnvTemp;
    const ins = equipSum(p, 'insulation');
    const heatP = equipSum(p, 'heatProtection');
    if (env < 24) env = Math.min(24, env + ins);
    if (env > 30) env = Math.max(30, env - heatP - (sheltered ? 2 : 0));
    const target = SURVIVAL.bodyTempNormal + (env - 25) * 0.17;
    p.bodyTemp += (target - p.bodyTemp) * Math.min(1, SURVIVAL.tempResponse * dt * 10);

    // ---- hunger / thirst
    let thirstMul = 1;
    if (p.sprinting) thirstMul *= SURVIVAL.sprintThirstMul;
    if (p.bodyTemp > 38) thirstMul *= SURVIVAL.heatThirstMul;
    let hungerMul = 1;
    if (p.bodyTemp < 36) hungerMul *= 1.4; // burning calories to stay warm
    if (p.effects.nausea) thirstMul *= 1.5;
    p.hunger = Math.max(0, p.hunger - SURVIVAL.hungerPerHour * PER_HOUR * dt * diff * hungerMul);
    p.thirst = Math.max(0, p.thirst - SURVIVAL.thirstPerHour * PER_HOUR * dt * diff * thirstMul);

    // ---- stamina
    if (p.staminaDelay > 0) p.staminaDelay -= dt;
    else {
      let regen = SURVIVAL.staminaRegen;
      if (p.hunger < 15) regen *= 0.5;
      if (p.thirst < 15) regen *= 0.5;
      if (p.bodyTemp < SURVIVAL.bodyTempHypo) regen *= 0.6;
      if (p.swimming) regen *= 0.35;
      p.stamina = Math.min(SURVIVAL.maxStamina, p.stamina + regen * dt);
    }
    if (p.stamina <= 0.5 && !p.effects.exhausted) { p.effects.exhausted = 4; p.staminaDelay = 2; }

    // ---- oxygen
    if (p.underwater) {
      const bonus = equipSum(p, 'oxygenBonus');
      p.oxygen = Math.max(0, p.oxygen - SURVIVAL.oxygenDrainPerSec * (1 - bonus) * (p.sprinting ? 1.5 : 1) * dt);
      if (p.oxygen <= 0) applyDamage(sim, p, SURVIVAL.drownDamagePerSec * dt, 'drowned', undefined, true);
    } else p.oxygen = Math.min(SURVIVAL.maxOxygen, p.oxygen + SURVIVAL.oxygenRegenPerSec * dt);

    // ---- damage over time
    let dot = 0;
    if (p.hunger <= 0) dot += SURVIVAL.starveDamagePerSec;
    if (p.thirst <= 0) dot += SURVIVAL.dehydrateDamagePerSec;
    if (p.effects.bleeding) dot += SURVIVAL.bleedDamagePerSec;
    if (p.effects.poisoned) dot += SURVIVAL.poisonDamagePerSec;
    if (p.bodyTemp < SURVIVAL.bodyTempHypo) dot += SURVIVAL.coldDamagePerSec * (SURVIVAL.bodyTempHypo - p.bodyTemp + 0.5);
    if (p.bodyTemp > SURVIVAL.bodyTempHyper) dot += SURVIVAL.heatDamagePerSec * (p.bodyTemp - SURVIVAL.bodyTempHyper + 0.5);
    if (dot > 0) applyDamage(sim, p, dot * dt, p.thirst <= 0 ? 'dehydration' : p.hunger <= 0 ? 'starvation' : p.effects.bleeding ? 'blood loss' : p.effects.poisoned ? 'poison' : 'exposure', undefined, true);

    // ---- regeneration
    const healthy = p.hunger > SURVIVAL.wellFedThreshold && p.thirst > SURVIVAL.wellFedThreshold && !p.effects.bleeding && !p.effects.poisoned
      && p.bodyTemp > SURVIVAL.bodyTempHypo && p.bodyTemp < SURVIVAL.bodyTempHyper;
    if (healthy && p.health < SURVIVAL.maxHealth) p.health = Math.min(SURVIVAL.maxHealth, p.health + SURVIVAL.regenPerSecWellFed * dt * (p.sleeping ? 3 : 1));

    // ---- status effect timers & derived indicators
    for (const k of Object.keys(p.effects)) {
      if (k === 'sheltered' || k === 'warm') continue;
      const v = p.effects[k]!;
      if (v < 1e8) { p.effects[k] = v - dt; if (p.effects[k]! <= 0) delete p.effects[k]; }
    }
    setFlag(p, 'starving', p.hunger <= 10);
    setFlag(p, 'dehydrated', p.thirst <= 10);
    setFlag(p, 'cold', p.bodyTemp < 36);
    setFlag(p, 'hot', p.bodyTemp > 38.3);
    setFlag(p, 'wet', p.wetness > 0.3);
    setFlag(p, 'wellfed', healthy && p.hunger > 75);

    if (slow) {
      tickHeldItems(sim, p);
      if (sim.world.tick % 40 === 0) tickSpoilage(sim, p);
    }
    tickFishing(sim, p);
  }
  // days survived
  if (sim.world.tick % (20 * 10) === 0) {
    const day = Math.floor((sim.world.time + sim.world.dayOffset) / TIME.dayLengthSeconds);
    for (const p of Object.values(sim.world.players)) {
      if (p.connected && !p.dead && day > p.stats.daysSurvived) { p.stats.daysSurvived = day; sim.markPlayer(p.id); }
    }
  }
}

function setFlag(p: PlayerState, k: string, on: boolean) {
  if (on) p.effects[k] = 1e9; else if (p.effects[k] !== undefined && p.effects[k]! > 1e8) delete p.effects[k];
}

function tickHeldItems(sim: Simulation, p: PlayerState): void {
  const held = p.inventory.slots[p.hotbar];
  if (!held) return;
  const def = ITEMS[held.id];
  if (!def?.burnsWhileHeld) return;
  if (held.id === 'torch' && (p.underwater || (sim.world.weather.rain > 0.7 && !p.effects.sheltered && sim.rng.chance(0.02)))) {
    if (p.underwater) { p.inventory.slots[p.hotbar] = { id: 'stick', qty: 1 }; sim.notify(p.id, 'Your torch hissed out.', 'warn'); sim.markPlayer(p.id); return; }
  }
  if (held.dur !== undefined) {
    held.dur -= 0.5; // slow tick runs at 2 Hz
    if (held.dur <= 0) {
      p.inventory.slots[p.hotbar] = null;
      sim.notify(p.id, `Your ${def.name.toLowerCase()} burned out.`, 'warn');
    }
    if (Math.floor(held.dur) % 10 === 0) sim.markPlayer(p.id);
  }
}

function tickSpoilage(sim: Simulation, p: PlayerState): void {
  let changed = false;
  const slots = p.inventory.slots;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || s.spoilAt === undefined || s.spoilAt > sim.now) continue;
    const to = ITEMS[s.id]?.food?.spoilsTo;
    slots[i] = to ? { id: to, qty: s.qty } : null;
    changed = true;
  }
  if (changed) { sim.markPlayer(p.id); sim.notify(p.id, 'Some of your food has spoiled.', 'warn'); }
}

/** Single entry point for all player damage. */
export function applyDamage(sim: Simulation, p: PlayerState, amount: number, cause: string, sourceId?: string, silent = false): void {
  if (p.dead || amount <= 0) return;
  if (sim.now < p.invulnUntil) return;
  if (!silent) {
    const armor = Math.min(0.6, equipSum(p, 'armor'));
    amount *= 1 - armor;
    // wear body armor
    const body = p.inventory.equip.body;
    if (body && body.dur !== undefined) { body.dur -= 1; if (body.dur <= 0) p.inventory.equip.body = null; }
  }
  if (p.downed > 0) {
    p.downed = Math.max(0, p.downed - amount * 0.5);
    if (p.downed <= 0) killPlayer(sim, p, cause);
    return;
  }
  p.health -= amount;
  if (!silent) sim.fx('hurt', p.pos.x, p.pos.y + 1, p.pos.z, cause, amount, p.id);
  if (p.health <= 0) {
    // co-op: get downed instead of dying outright when a teammate could revive
    const helpers = Object.values(sim.world.players).filter((o) => o.id !== p.id && o.connected && !o.dead && o.downed <= 0);
    const drowning = cause === 'drowned';
    if (helpers.length > 0 && !drowning && !p.swimming) {
      p.health = 1;
      p.downed = PLAYER.downedSeconds;
      p.fishing = null;
      sim.notify(null, `${p.name} is down! Get to them to revive.`, 'bad');
      sim.fx('downed', p.pos.x, p.pos.y, p.pos.z, undefined, undefined, p.id);
    } else killPlayer(sim, p, cause);
  }
  sim.markPlayer(p.id);
}

export function killPlayer(sim: Simulation, p: PlayerState, cause: string): void {
  if (p.dead) return;
  p.dead = true;
  p.downed = 0;
  p.health = 0;
  p.deathAt = sim.now;
  p.stats.deaths++;
  p.fishing = null;
  p.craftQueue = [];
  p.openContainer = null;
  if (p.vehicleId) sim.leaveVehicle(p);
  if (!sim.world.settings.keepInventoryOnDeath) {
    const items = [...p.inventory.slots, ...Object.values(p.inventory.equip)].filter((s) => s);
    if (items.length) {
      const grave = sim.createContainer('grave', Math.max(items.length, 1), p.pos.x, Math.max(p.pos.y, sim.gen.heightAt(p.pos.x, p.pos.z)), p.pos.z, {
        transient: true, label: `${p.name}'s belongings`,
      });
      items.forEach((s, i) => { grave.slots[i] = s; });
      p.inventory.slots = p.inventory.slots.map(() => null);
      p.inventory.equip = { head: null, body: null, back: null, feet: null };
      sim.notify(p.id, 'Your belongings lie where you fell. Recover them!', 'warn');
    }
  }
  sim.notify(null, `${p.name} died (${cause}).`, 'bad');
  sim.fx('death', p.pos.x, p.pos.y, p.pos.z, cause, undefined, p.id);
  sim.markPlayer(p.id);
  sim.log(`${p.name} died: ${cause}`);
}
