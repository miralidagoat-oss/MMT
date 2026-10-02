import { describe, it, expect } from 'vitest';
import { WorldGen } from '../src/shared/world/worldgen';
import { WORLD } from '../src/shared/config';

describe('world generation', () => {
  it('is deterministic for a seed', () => {
    const a = new WorldGen(777), b = new WorldGen(777);
    expect(a.fingerprint()).toBe(b.fingerprint());
    expect(a.islands.map((i) => [i.x, i.z, i.archetype])).toEqual(b.islands.map((i) => [i.x, i.z, i.archetype]));
    for (let i = 0; i < 200; i++) {
      const x = (i * 37.3) % 3000 - 1500, z = (i * 91.7) % 3000 - 1500;
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
    }
    expect(a.nodesInChunk(1, 1)).toEqual(b.nodesInChunk(1, 1));
  });

  it('differs between seeds', () => {
    expect(new WorldGen(1).fingerprint()).not.toBe(new WorldGen(2).fingerprint());
  });

  it('produces a playable world layout', () => {
    for (const seed of [1, 99, 12345, 0xdeadbeef]) {
      const g = new WorldGen(seed);
      expect(g.islands.length).toBeGreaterThanOrEqual(WORLD.islandCount - 2);
      const kinds = new Set(g.islands.map((i) => i.archetype));
      for (const k of ['start', 'sandbar', 'atoll', 'rocky', 'jungle', 'volcanic']) expect(kinds.has(k as never)).toBe(true);
      expect(g.heightAt(0, 0)).toBeGreaterThan(5); // start island has land
      expect(g.heightAt(2000, 2000)).toBeLessThan(-10); // open ocean is deep (usually)
      const sp = g.spawnPoint(0);
      expect(g.heightAt(sp.x, sp.z)).toBeGreaterThan(0);
      expect(g.wrecks.filter((w) => w.kind === 'deep').length).toBeGreaterThanOrEqual(2);
      expect(g.spawnZones.some((z) => z.kind === 'shark')).toBe(true);
      // nearest neighbour island is reachable by raft (< 1400 m from start)
      const nearest = Math.min(...g.islands.filter((i) => i.id !== 0).map((i) => Math.hypot(i.x, i.z) - i.radius - 230));
      expect(nearest).toBeLessThan(1400);
    }
  });

  it('node lookup by id round-trips', () => {
    const g = new WorldGen(5);
    const nodes = g.nodesInRadius(0, 0, 150);
    expect(nodes.length).toBeGreaterThan(100);
    for (const n of nodes.slice(0, 50)) expect(g.nodeById(n.id)).toEqual(n);
  });
});
