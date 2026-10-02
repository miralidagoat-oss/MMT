/** Scheduled world events that keep the world dynamic. */
import { TIME } from '../config';
import { forceWeather } from '../systems/weather';
import type { WorldEvent } from '../state';
import type { Simulation } from './simulation';

const KINDS: { value: WorldEvent['kind']; weight: number }[] = [
  { value: 'supply_drop', weight: 4 },
  { value: 'storm_front', weight: 2 },
  { value: 'shark_frenzy', weight: 1.5 },
  { value: 'fish_run', weight: 2 },
];

export function tickWorldEvents(sim: Simulation, dt: number): void {
  const w = sim.world;
  // expire
  const before = w.events.length;
  w.events = w.events.filter((e) => {
    if (sim.now < e.endsAt) return true;
    if (e.kind === 'supply_drop' && e.data?.container) {
      const c = w.containers[String(e.data.container)];
      if (c && c.slots.every((s) => !s)) sim.removeContainer(c.id, false);
    }
    return false;
  });
  if (w.events.length !== before) sim.out.dirty.add('e');
  // drifting supply crates
  for (const e of w.events) {
    if (e.kind !== 'supply_drop' || !e.data?.container) continue;
    const c = w.containers[String(e.data.container)];
    if (!c) continue;
    const ground = sim.gen.heightAt(c.x, c.z);
    if (ground < -0.3) {
      const isl = sim.gen.nearestIsland(c.x, c.z).island;
      const dx = isl.x - c.x, dz = isl.z - c.z, d = Math.hypot(dx, dz) || 1;
      c.x += (dx / d) * 0.6 * dt; c.z += (dz / d) * 0.6 * dt;
      c.y = sim.waterLevel(c.x, c.z) - 0.1;
      e.x = c.x; e.z = c.z;
      if (w.tick % 20 === 0) sim.markContainer(c.id);
    }
  }
  if (!Object.values(w.players).some((p) => p.connected)) return;
  if (sim.now < w.nextEventAt) return;
  w.nextEventAt = sim.now + TIME.dayLengthSeconds * sim.rng.range(0.4, 0.9);
  startEvent(sim, sim.rng.weighted(KINDS));
}

export function startEvent(sim: Simulation, kind: WorldEvent['kind']): WorldEvent | null {
  const w = sim.world;
  const known = w.progression.discoveredIslands.map((id) => sim.gen.islands[id]!).filter(Boolean);
  const isl = known.length ? sim.rng.pick(known) : sim.gen.islands[0]!;
  const ang = sim.rng.range(0, Math.PI * 2);
  let x = isl.x + Math.cos(ang) * isl.radius * 1.9, z = isl.z + Math.sin(ang) * isl.radius * 1.9;
  const e: WorldEvent = { id: sim.newId('e'), kind, startedAt: sim.now, endsAt: sim.now + TIME.dayLengthSeconds * 0.4, x, z };
  switch (kind) {
    case 'supply_drop': {
      e.endsAt = sim.now + TIME.dayLengthSeconds * 1.5;
      const box = sim.createContainer('supply', 8, x, 0, z, { loot: 'supply_drop', transient: true, label: 'Supply Crate' });
      e.data = { container: box.id };
      sim.notify(null, `A supply crate was spotted drifting toward ${isl.name}.`, 'good');
      break;
    }
    case 'storm_front':
      forceWeather(w.weather, 'storm', sim.now, sim.rng);
      e.endsAt = w.weather.changeAt;
      sim.notify(null, 'The sky darkens. A storm front is rolling in — secure your boats and find shelter.', 'warn');
      break;
    case 'shark_frenzy': {
      const wreck = sim.rng.pick(sim.gen.wrecks);
      x = wreck.x; z = wreck.z; e.x = x; e.z = z;
      sim.notify(null, 'Blood in the water… sharks are gathering near a wreck.', 'warn');
      break;
    }
    case 'fish_run':
      sim.notify(null, `Fish are running near ${isl.name}. Good time to cast a line.`, 'info');
      break;
    case 'rescue':
      break;
  }
  w.events.push(e);
  sim.out.dirty.add('e');
  sim.log(`world event ${kind} at ${x.toFixed(0)},${z.toFixed(0)}`);
  return e;
}
