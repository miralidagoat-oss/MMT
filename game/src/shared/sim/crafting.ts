/** Crafting: recipe knowledge, station checks, queued authoritative crafting. */
import { RECIPES, RECIPE_LIST } from '../defs/recipes';
import { STRUCTURES } from '../defs/structures';
import { hasItems, removeItem, addStack, makeStack, spaceFor } from '../systems/inventory';
import type { RecipeDef, StationKind } from '../defs/types';
import type { PlayerState } from '../state';
import type { Simulation } from './simulation';

const STATION_RANGE = 4;
const MAX_QUEUE = 8;

export function knowsRecipe(p: Pick<PlayerState, 'discovered'>, r: RecipeDef): boolean {
  if (r.starter) return true;
  const req = r.unlockBy ?? r.inputs.map((i) => i.item);
  return req.every((id) => p.discovered.includes(id));
}

export function knownRecipes(p: Pick<PlayerState, 'discovered'>): RecipeDef[] {
  return RECIPE_LIST.filter((r) => knowsRecipe(p, r));
}

/** Stations within range of a position (needs a lit fire for kiln/forge/campfire). */
export function stationsNear(sim: Pick<Simulation, 'world'>, x: number, y: number, z: number): Set<StationKind> {
  const out = new Set<StationKind>();
  for (const s of Object.values(sim.world.structures)) {
    const def = STRUCTURES[s.type];
    if (!def?.station) continue;
    if (Math.hypot(s.x - x, s.z - z) > STATION_RANGE || Math.abs(s.y - y) > 3) continue;
    if (def.fire && !s.on) continue;
    out.add(def.station);
  }
  return out;
}

export function canCraft(sim: Simulation, p: PlayerState, r: RecipeDef, count = 1): string | null {
  if (!knowsRecipe(p, r)) return 'Recipe not yet discovered';
  if (r.station && !stationsNear(sim, p.pos.x, p.pos.y, p.pos.z).has(r.station)) {
    const name = r.station === 'kiln' || r.station === 'forge' || r.station === 'campfire' ? `a lit ${r.station}` : `a ${r.station}`;
    return `Requires ${name} nearby`;
  }
  const req = r.inputs.map((i) => ({ item: i.item, qty: i.qty * count || 1 }));
  if (!hasItems(p.inventory.slots, req)) return 'Missing ingredients';
  return null;
}

export function startCraft(sim: Simulation, p: PlayerState, recipeId: string, countIn: number): { ok: boolean; reason?: string } {
  const r = RECIPES[recipeId];
  if (!r) return { ok: false, reason: 'Unknown recipe' };
  const count = Math.max(1, Math.min(10, Math.floor(Number(countIn) || 1)));
  if (p.craftQueue.length + count > MAX_QUEUE) return { ok: false, reason: 'Crafting queue is full' };
  if (p.dead || p.downed > 0) return { ok: false, reason: 'You cannot craft now' };
  const err = canCraft(sim, p, r, count);
  if (err) return { ok: false, reason: err };
  // consume inputs up front (atomic); qty 0 inputs are tools that are required but not consumed
  for (const i of r.inputs) if (i.qty > 0) removeItem(p.inventory.slots, i.item, i.qty * count);
  for (let k = 0; k < count; k++) p.craftQueue.push({ recipeId, remaining: r.seconds, total: r.seconds });
  sim.markPlayer(p.id);
  sim.fx('craft_start', p.pos.x, p.pos.y, p.pos.z, recipeId, undefined, p.id);
  return { ok: true };
}

export function cancelCraft(sim: Simulation, p: PlayerState, index: number): { ok: boolean; reason?: string } {
  const job = p.craftQueue[index];
  if (!job) return { ok: false, reason: 'Nothing to cancel' };
  p.craftQueue.splice(index, 1);
  const r = RECIPES[job.recipeId]!;
  for (const i of r.inputs) if (i.qty > 0) sim.give(p, i.item, i.qty);
  sim.markPlayer(p.id);
  return { ok: true };
}

export function tickCrafting(sim: Simulation, dt: number): void {
  for (const p of Object.values(sim.world.players)) {
    if (!p.connected || !p.craftQueue.length) continue;
    if (p.dead) { p.craftQueue = []; continue; }
    const job = p.craftQueue[0]!;
    const r = RECIPES[job.recipeId]!;
    // must stay at the station while it works
    if (r.station && sim.world.tick % 10 === 0 && !stationsNear(sim, p.pos.x, p.pos.y, p.pos.z).has(r.station)) {
      continue; // paused until back in range
    }
    job.remaining -= dt;
    if (sim.world.tick % 5 === 0) sim.markPlayer(p.id);
    if (job.remaining <= 0) {
      p.craftQueue.shift();
      const stack = makeStack(r.output.item, r.output.qty, sim.now);
      const room = spaceFor(p.inventory.slots, stack);
      addStack(p.inventory.slots, stack);
      if (stack.qty > 0) { sim.spawnItem(stack, p.pos.x, p.pos.y + 0.5, p.pos.z); sim.notify(p.id, 'Inventory full — item dropped.', 'warn'); }
      void room;
      sim.discover(p, r.output.item);
      p.stats.crafted++;
      sim.markPlayer(p.id);
      sim.fx('craft_done', p.pos.x, p.pos.y, p.pos.z, r.output.item, r.output.qty, p.id);
      sim.milestone(p, `craft_${r.output.item}`);
      if (r.output.item === 'stone_axe') sim.milestone(p, 'first_tool', 'First tool crafted. Fell a palm tree for logs.');
    }
  }
}
