/** One-time population of authoritative containers that come from world generation. */
import type { Simulation } from './simulation';

export function initWorldContainers(sim: Simulation): void {
  for (const w of sim.gen.wrecks) {
    for (const c of w.crates) {
      sim.createContainer('crate', 8, c.x, c.y, c.z, { id: c.id, loot: w.kind === 'deep' ? 'wreck_deep' : 'wreck_shallow', label: w.kind === 'deep' ? 'Sunken Strongbox' : 'Wreck Crate' });
    }
  }
  for (const cave of sim.gen.caves) {
    const c = cave.crate;
    sim.createContainer('crate', 8, c.x, c.y, c.z, { id: c.id, loot: 'wreck_shallow', label: 'Smuggler\'s Cache' });
  }
}
