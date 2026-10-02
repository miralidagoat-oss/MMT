import { Simulation } from '../src/shared/sim/simulation';
import { makeStack, addStack } from '../src/shared/systems/inventory';
import type { PlayerState } from '../src/shared/state';
import type { Action } from '../src/shared/net/protocol';
import { SIM } from '../src/shared/config';

export const SEED = 424242;

export function newSim(seed = SEED) {
  return new Simulation({ seed, name: 'Test' });
}

export function give(p: PlayerState, id: string, qty = 1) {
  let left = qty;
  while (left > 0) { const s = makeStack(id, left); left -= s.qty; addStack(p.inventory.slots, s); }
  if (!p.discovered.includes(id)) p.discovered.push(id);
}

let actId = 1;
export function act(sim: Simulation, p: PlayerState, action: Action) {
  const id = actId++;
  sim.submitAction(p.id, id, action);
  // results are flushed on tick; read from current output
  const r = sim.out.results.find((x) => x.id === id);
  return r ?? { ok: false, reason: 'no result' };
}

export function ticks(sim: Simulation, n: number) {
  for (let i = 0; i < n; i++) sim.tick();
}

export function seconds(sim: Simulation, s: number) { ticks(sim, Math.round(s * SIM.tickRate)); }

/** Find a flat dry land position on the start island. */
export function flatLand(sim: Simulation, minH = 3, maxH = 10): { x: number; y: number; z: number } {
  for (let r = 20; r < 220; r += 4) {
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = sim.gen.heightAt(x, z);
      if (h < minH || h > maxH) continue;
      let ok = true;
      for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, 0], [-6, 0], [6, 0], [0, 6], [0, -6]]) {
        if (Math.abs(sim.gen.heightAt(x + dx!, z + dz!) - h) > 0.7) { ok = false; break; }
      }
      if (ok && !sim.col.solidNodeNear(x, z, 9)) return { x, y: h, z };
    }
  }
  throw new Error('no flat land');
}

export function place(p: PlayerState, pos: { x: number; y: number; z: number }) {
  p.pos = { ...pos };
  p.vel = { x: 0, y: 0, z: 0 };
}
