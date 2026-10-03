/**
 * Stateful structures: fires (campfire/kiln/forge) with fuel + cooking,
 * rain catchers, solar stills, drying racks, lights, garden plots, the beacon.
 */
import { FIRE, FARM, TIME } from '../config';
import { ITEMS } from '../defs/items';
import { STRUCTURES } from '../defs/structures';
import { CROPS } from '../defs/crops';
import { daylight, ambientTemp } from '../systems/weather';
import type { StructureState } from '../state';
import { damageStructure } from './wildlife';
import type { Simulation } from './simulation';

const STEP = 5; // run every 5 ticks (4 Hz)
const PER_HOUR = 24 / TIME.dayLengthSeconds;

/** Slot layout for fire containers: [fuel, cook1..cookN] */
export function stationSlots(type: string): number {
  const def = STRUCTURES[type]!;
  if (def.fire) return 1 + def.fire.cookSlots;
  if (def.dryingRack) return def.dryingRack.slots;
  return def.container?.slots ?? 0;
}

export function tickStations(sim: Simulation, dtTick: number): void {
  if (sim.world.tick % STEP !== 0) return;
  const dt = dtTick * STEP;
  const w = sim.world.weather;
  const hour = sim.hour;
  const sun = daylight(hour);
  for (const s of Object.values(sim.world.structures)) {
    const def = STRUCTURES[s.type];
    if (!def) continue;
    if (def.fire) tickFire(sim, s, dt);
    if (def.rainCatcher && w.rain > 0.05) {
      const before = s.water ?? 0;
      s.water = Math.min(def.rainCatcher.capacity, before + def.rainCatcher.perSecond * w.rain * dt * 10);
      if (Math.floor(before) !== Math.floor(s.water)) sim.markStructure(s.id);
    }
    if (def.still && (s.saltWater ?? 0) > 0) {
      const rate = (1 / def.still.secondsPerUnit) * (0.25 + 0.75 * sun) * (1 - w.cloud * 0.4);
      const made = Math.min(rate * dt, s.saltWater ?? 0, def.still.capacity - (s.water ?? 0));
      if (made > 0) {
        const before = s.water ?? 0;
        s.water = before + made;
        s.saltWater = (s.saltWater ?? 0) - made;
        if (Math.floor(before) !== Math.floor(s.water)) sim.markStructure(s.id);
      }
    }
    if (def.dryingRack) tickDrying(sim, s, dt, sun);
    if (def.light?.fuelSeconds && s.on) {
      const rainy = w.rain > 0.5 && !sim.isSheltered(s.x, s.y, s.z);
      s.fuel = (s.fuel ?? 0) - dt * (rainy ? 2 : 1);
      if (s.fuel <= 0) { s.fuel = 0; s.on = false; sim.markStructure(s.id); sim.fx('fire_out', s.x, s.y + 1.5, s.z); }
    }
    if (def.light && !def.light.fuelSeconds) {
      const want = sun < 0.35;
      if (!!s.on !== want) { s.on = want; sim.markStructure(s.id); }
    }
    if (def.planter) tickPlanter(sim, s, dt, hour);
    // violent storms slowly tear thatch apart (repair with the mallet)
    if (w.rain > 0.85 && w.wind > 0.8 && def.tier === 0 && def.category !== 'vehicle') {
      s.hp -= def.maxHp * 0.0025 * dt;
      if (sim.world.tick % 100 === 0) sim.markStructure(s.id);
      if (s.hp <= 0) damageStructure(sim, s, 1, 'storm');
    }
  }
  tickBeacon(sim);
}

function tickFire(sim: Simulation, s: StructureState, dt: number): void {
  const def = STRUCTURES[s.type]!;
  const box = s.containerId ? sim.world.containers[s.containerId] : undefined;
  if (!s.on) {
    if (s.progress?.some((v) => v > 0)) { s.progress = s.progress.map(() => 0); }
    return;
  }
  const w = sim.world.weather;
  const exposed = w.rain > 0.1 && !sim.isSheltered(s.x, s.y, s.z);
  s.fuel = (s.fuel ?? 0) - dt * (exposed ? 1 + (FIRE.rainFuelDrainMul - 1) * w.rain : 1);
  if (exposed && w.rain > 0.9 && sim.rng.chance(FIRE.stormExtinguishChancePerSec * dt)) {
    s.on = false;
    sim.fx('fire_out', s.x, s.y, s.z);
    sim.notify(null, 'The storm put out a fire.', 'warn');
    sim.markStructure(s.id);
    return;
  }
  if (s.fuel <= 0) {
    // pull fuel from the fuel slot
    const fuelStack = box?.slots[0];
    const fs = fuelStack ? ITEMS[fuelStack.id]?.fuelSeconds : undefined;
    if (box && fuelStack && fs) {
      fuelStack.qty--;
      if (fuelStack.qty <= 0) box.slots[0] = null;
      s.fuel += fs;
      sim.markContainer(box.id);
    } else {
      s.fuel = 0;
      s.on = false;
      sim.fx('fire_out', s.x, s.y, s.z);
      sim.markStructure(s.id);
      return;
    }
  }
  if (sim.world.tick % 40 === 0) sim.markStructure(s.id);
  if (!box || !def.fire?.cookSlots) return;
  if (!s.progress || s.progress.length !== box.slots.length) s.progress = new Array(box.slots.length).fill(0);
  for (let i = 1; i < box.slots.length; i++) {
    const st = box.slots[i];
    if (!st) { s.progress[i] = 0; continue; }
    const idef = ITEMS[st.id];
    let target = idef?.food?.cookSeconds;
    let result = idef?.food?.cooksTo;
    // distilling sea water in a clay pot
    if (idef?.water && st.id === 'clay_pot' && st.quality === 'salt' && (st.water ?? 0) > 0) { target = 40; result = undefined; }
    if (!target) { s.progress[i] = 0; continue; }
    s.progress[i]! += dt;
    if (s.progress[i]! >= target) {
      s.progress[i] = 0;
      if (result) {
        const rdef = ITEMS[result]!;
        box.slots[i] = { id: result, qty: st.qty, ...(rdef.food?.spoilSeconds ? { spoilAt: sim.now + rdef.food.spoilSeconds } : {}) };
        sim.fx(result === 'burnt_food' ? 'burnt' : 'cooked', s.x, s.y + 0.5, s.z, result);
        for (const p of sim.playersNear(s.x, s.z, 12)) sim.discover(p, result);
      } else {
        st.quality = 'clean';
        sim.fx('cooked', s.x, s.y + 0.5, s.z, 'clean_water');
      }
      sim.markContainer(box.id);
    }
  }
}

function tickDrying(sim: Simulation, s: StructureState, dt: number, sun: number): void {
  const box = s.containerId ? sim.world.containers[s.containerId] : undefined;
  if (!box) return;
  if (!s.progress || s.progress.length !== box.slots.length) s.progress = new Array(box.slots.length).fill(0);
  const w = sim.world.weather;
  const wet = w.rain > 0.2 && !sim.isSheltered(s.x, s.y, s.z);
  const rate = wet ? 0 : 0.35 + 0.65 * sun + w.wind * 0.3;
  for (let i = 0; i < box.slots.length; i++) {
    const st = box.slots[i];
    const f = st ? ITEMS[st.id]?.food : undefined;
    if (!st || !f?.dryTo || !f.drySeconds) { s.progress[i] = 0; continue; }
    // drying pauses spoilage
    if (st.spoilAt !== undefined) st.spoilAt += dt;
    s.progress[i]! += dt * rate;
    if (s.progress[i]! >= f.drySeconds) {
      box.slots[i] = { id: f.dryTo, qty: st.qty };
      s.progress[i] = 0;
      sim.markContainer(box.id);
      sim.fx('dried', s.x, s.y + 1, s.z, f.dryTo);
    }
  }
  if (sim.world.tick % 100 === 0) sim.markStructure(s.id);
}

function tickPlanter(sim: Simulation, s: StructureState, dt: number, hour: number): void {
  if (!s.crops) return;
  const w = sim.world.weather;
  const temp = ambientTemp(hour, w);
  const hours = dt * PER_HOUR;
  let changed = false;
  for (const c of s.crops) {
    if (!c || c.withered) continue;
    const def = CROPS[c.crop];
    if (!def) continue;
    if (w.rain > 0.05) c.water = Math.min(1, c.water + FARM.rainWaterPerSec * w.rain * dt);
    const before = Math.floor(c.growth * def.stages);
    if (c.water > 0) {
      c.water = Math.max(0, c.water - (def.waterNeed / 100) * hours * (temp > 30 ? 1.4 : 1));
      c.dryHours = 0;
      const tempOk = temp >= def.minTemp && temp <= def.maxTemp;
      if (c.growth < 1) c.growth = Math.min(1, c.growth + (hours / def.growHours) * (tempOk ? 1 : 0.35));
    } else {
      c.dryHours += hours;
      if (c.dryHours > FARM.witherHoursDry) { c.withered = true; changed = true; }
    }
    if (Math.floor(c.growth * def.stages) !== before) changed = true;
  }
  if (changed || sim.world.tick % 200 === 0) sim.markStructure(s.id);
}

function tickBeacon(sim: Simulation): void {
  const pr = sim.world.progression;
  if (!pr.beaconId || pr.rescued || !pr.rescueAt) return;
  const b = sim.world.structures[pr.beaconId];
  if (!b) return;
  if (sim.now >= pr.rescueAt) {
    pr.rescued = true;
    sim.out.dirty.add('g');
    const ev = { id: sim.newId('e'), kind: 'rescue' as const, startedAt: sim.now, endsAt: sim.now + TIME.dayLengthSeconds, x: b.x, z: b.z };
    sim.world.events.push(ev);
    sim.out.dirty.add('e');
    for (const p of Object.values(sim.world.players)) {
      if (p.connected && !p.dead) sim.milestone(p, 'rescued');
    }
    sim.notify(null, 'A ship answers the beacon! RESCUE ACHIEVED. The islands remain yours to explore.', 'good');
    sim.fx('rescue', b.x, b.y + 4, b.z);
  }
}

/** Light a fire/torch stand with the held ignition tool. */
export function ignite(sim: Simulation, s: StructureState, toolId: string | undefined): { ok: boolean; reason?: string } {
  const def = STRUCTURES[s.type];
  if (!def?.fire && !def?.light?.fuelSeconds) return { ok: false, reason: 'Nothing to light' };
  if (s.on) return { ok: false, reason: 'Already burning' };
  const tool = toolId ? ITEMS[toolId]?.tool : undefined;
  if (!tool || !tool.actions.includes('ignite')) return { ok: false, reason: 'You need a fire starter (hand drill, torch, flint striker)' };
  if (def.fire) {
    const box = s.containerId ? sim.world.containers[s.containerId] : undefined;
    const fuel = box?.slots[0];
    if ((s.fuel ?? 0) <= 0 && !(fuel && ITEMS[fuel.id]?.fuelSeconds)) return { ok: false, reason: 'Add fuel first (sticks, logs, fronds)' };
  } else if ((s.fuel ?? 0) <= 0) return { ok: false, reason: 'Out of fuel — add resin or fat' };
  if (sim.world.weather.rain > 0.6 && !sim.isSheltered(s.x, s.y, s.z) && sim.rng.chance(0.5)) return { ok: false, reason: 'Too wet — it won\'t catch. Build a roof over it.' };
  const chance = toolId === 'hand_drill' ? 0.4 : toolId === 'flint_striker' ? 0.9 : 1;
  if (!sim.rng.chance(chance)) { sim.fx('spark', s.x, s.y + 0.3, s.z); return { ok: false, reason: 'Just smoke… keep trying' }; }
  s.on = true;
  sim.markStructure(s.id);
  sim.fx('ignite', s.x, s.y + 0.3, s.z);
  return { ok: true };
}
