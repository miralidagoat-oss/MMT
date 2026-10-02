/** Rod fishing: cast -> wait for bite -> reel within the strike window. Server-timed. */
import { ITEMS } from '../defs/items';
import { wear } from '../systems/inventory';
import type { PlayerState } from '../state';
import type { Simulation } from './simulation';

const STRIKE_WINDOW = 1.6;

export function startFishing(sim: Simulation, p: PlayerState, x: number, z: number): { ok: boolean; reason?: string } {
  const held = sim.heldItem(p);
  if (!held || !ITEMS[held.id]?.tool?.actions.includes('fish') || held.id !== 'fishing_rod') return { ok: false, reason: 'Hold a fishing rod' };
  if (p.swimming) return { ok: false, reason: 'You cannot cast while swimming' };
  const range = ITEMS[held.id]!.tool!.range;
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x - p.pos.x, z - p.pos.z) > range + 1) return { ok: false, reason: 'Too far' };
  const depth = -sim.gen.heightAt(x, z);
  if (depth < 0.8) return { ok: false, reason: 'Cast into deeper water' };
  let wait = sim.rng.range(4, 13);
  const h = sim.hour;
  if ((h > 5 && h < 8) || (h > 17 && h < 20)) wait *= 0.7; // fish bite at dawn and dusk
  if (sim.world.events.some((e) => e.kind === 'fish_run' && Math.hypot(e.x - x, e.z - z) < 300)) wait *= 0.4;
  p.fishing = { phase: 'cast', x, z, biteAt: sim.now + wait, windowEnd: 0 };
  sim.fx('cast', x, sim.waterLevel(x, z), z, undefined, undefined, p.id);
  sim.markPlayer(p.id);
  return { ok: true };
}

export function reel(sim: Simulation, p: PlayerState): { ok: boolean; reason?: string } {
  const f = p.fishing;
  if (!f) return { ok: false, reason: 'Not fishing' };
  p.fishing = null;
  sim.markPlayer(p.id);
  if (f.phase === 'bite' && sim.now <= f.windowEnd) {
    const depth = -sim.gen.heightAt(f.x, f.z);
    const qty = depth > 8 && sim.rng.chance(0.4) ? 2 : 1;
    sim.give(p, 'fish_raw', qty);
    if (sim.rng.chance(0.05)) sim.give(p, 'kelp', 1);
    if (wear(p.inventory.slots, p.hotbar, 1)) sim.notify(p.id, 'Your fishing rod snapped.', 'warn');
    sim.fx('catch', f.x, sim.waterLevel(f.x, f.z), f.z, 'fish_raw', qty, p.id);
    sim.milestone(p, 'caught_fish', 'Caught a fish!');
    p.stats.harvested += qty;
    return { ok: true };
  }
  return { ok: true, reason: f.phase === 'bite' ? 'Too slow — it got away' : 'Reeled in' };
}

export function tickFishing(sim: Simulation, p: PlayerState): void {
  const f = p.fishing;
  if (!f) return;
  const held = sim.heldItem(p);
  if (!held || held.id !== 'fishing_rod' || p.swimming) { p.fishing = null; sim.markPlayer(p.id); return; }
  if (f.phase === 'cast' && sim.now >= f.biteAt) {
    f.phase = 'bite';
    f.windowEnd = sim.now + STRIKE_WINDOW;
    sim.fx('bite', f.x, sim.waterLevel(f.x, f.z), f.z, undefined, undefined, p.id);
    sim.markPlayer(p.id);
  } else if (f.phase === 'bite' && sim.now > f.windowEnd) {
    f.phase = 'cast';
    f.biteAt = sim.now + sim.rng.range(5, 12);
    sim.notify(p.id, 'The fish slipped the hook.', 'info');
    sim.markPlayer(p.id);
  }
}
