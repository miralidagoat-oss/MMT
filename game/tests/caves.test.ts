import { describe, it, expect } from 'vitest';
import { newSim, give, act, seconds, place } from './helpers';
import { TIME } from '../src/shared/config';
import { countItem, addStack, makeStack } from '../src/shared/systems/inventory';
import type { Simulation } from '../src/shared/sim/simulation';
import type { Cave } from '../src/shared/world/worldgen';
import type { CreatureState, StructureState } from '../src/shared/state';
import { damageCreature } from '../src/shared/sim/wildlife';
import { LOOT_TABLES } from '../src/shared/defs/loot';
import { ITEMS } from '../src/shared/defs/items';
import { RECIPE_LIST } from '../src/shared/defs/recipes';

function setHour(sim: Simulation, hour: number) {
  const day = TIME.dayLengthSeconds;
  const now = (sim.world.time + sim.world.dayOffset) % day;
  sim.world.dayOffset += ((hour / 24) * day - now + day) % day;
}

const inside = (c: Cave, x: number, z: number) => {
  const dx = x - c.x, dz = z - c.z, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  return cs * dx + sn * dz < 0.5;
};

function caveWithBats(sim: Simulation) {
  const cave = sim.gen.caves[0]!;
  const bats = () => Object.values(sim.world.creatures).filter((c) => c.kind === 'bat' && c.zone === `zb${cave.islandId}`) as CreatureState[];
  return { cave, bats };
}

describe('caves', () => {
  it('every cave holds glowcaps, a guano heap and a bat colony; nothing else grows in the tunnel', () => {
    const sim = newSim();
    expect(sim.gen.caves.length).toBeGreaterThan(0);
    for (const c of sim.gen.caves) {
      expect(c.life.filter((n) => n.type === 'glowcap').length).toBe(6);
      expect(c.life.filter((n) => n.type === 'guano_pile').length).toBe(1);
      expect(sim.gen.spawnZones.some((z) => z.kind === 'bat' && z.cave === c.id)).toBe(true);
      for (const n of c.life) {
        // findable by id and by area (gathering looks nodes up both ways)
        expect(sim.gen.nodeById(n.id)).toEqual(n);
        expect(sim.gen.nodesInRadius(n.x, n.z, 1).some((m) => m.id === n.id)).toBe(true);
        expect(sim.gen.caveDepth(n.x, n.y + 1, n.z).cave?.id).toBe(c.id);
      }
      const deep = c.life.find((n) => n.type === 'guano_pile')!;
      expect(sim.gen.caveDepth(deep.x, deep.y + 1, deep.z).depth).toBe(1);
      expect(sim.gen.caveDepth(c.mouth.x, c.mouth.y, c.mouth.z).depth).toBe(0);
      const trees = sim.gen.nodesInRadius(deep.x, deep.z, 6).filter((n) => !n.id.startsWith(c.id) && (n.type === 'palm' || n.type === 'hardwood' || n.type === 'rock'));
      expect(trees.filter((n) => sim.gen.caveDepth(n.x, n.y + 1, n.z).depth > 0.5)).toEqual([]);
    }
  });

  it('bats roost by day, fly out at dusk, return at dawn, and scatter from a torch', () => {
    const sim = newSim();
    const { cave, bats } = caveWithBats(sim);
    const p = sim.addPlayer('tok-bats', 'Watcher');
    p.hunger = 100; p.thirst = 100;
    // watch from just outside the mouth (bats only move near players)
    place(p, { x: cave.mouth.x, y: cave.mouth.y - 1.6, z: cave.mouth.z });
    setHour(sim, 12);
    seconds(sim, 2);
    expect(bats().length).toBe(5);
    expect(bats().every((b) => b.mode === 'idle' && inside(cave, b.x, b.z))).toBe(true);
    // dusk: the colony streams out
    setHour(sim, 19.5);
    seconds(sim, 20);
    const outside = bats().filter((b) => !inside(cave, b.x, b.z));
    expect(outside.length).toBeGreaterThanOrEqual(3);
    expect(outside.every((b) => b.y > sim.gen.heightAt(b.x, b.z) + 0.5)).toBe(true);
    // dawn: back under the roof
    setHour(sim, 7);
    seconds(sim, 40);
    expect(bats().filter((b) => b.mode === 'idle' && inside(cave, b.x, b.z)).length).toBe(5);
    // a torch carried under the roost sets them off
    give(p, 'torch');
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'torch');
    const roost = cave.roost;
    place(p, { x: roost.x, y: sim.gen.heightAt(roost.x, roost.z), z: roost.z });
    seconds(sim, 2);
    expect(bats().filter((b) => b.mode === 'flee').length).toBeGreaterThanOrEqual(3);
  });

  it('a shot bat drops to the floor', () => {
    const sim = newSim();
    const { cave, bats } = caveWithBats(sim);
    const p = sim.addPlayer('tok-bat-hunt', 'Hunter');
    place(p, { x: cave.mouth.x, y: cave.mouth.y - 1.6, z: cave.mouth.z });
    seconds(sim, 1);
    const b = bats()[0]!;
    expect(b.y).toBeGreaterThan(sim.gen.heightAt(b.x, b.z) + 1.5);
    damageCreature(sim, b, 10, p.id);
    expect(b.mode).toBe('dead');
    expect(b.y).toBeLessThan(sim.gen.heightAt(b.x, b.z) + 0.2);
  });

  it('glowcaps are gathered, eaten, and sealed into a jar of cold light', () => {
    const sim = newSim();
    const cave = sim.gen.caves[0]!;
    const p = sim.addPlayer('tok-glow', 'Spelunker');
    const cap = cave.life.find((n) => n.type === 'glowcap')!;
    place(p, { x: cap.x + 0.6, y: cap.y, z: cap.z });
    seconds(sim, 0.5);
    expect(act(sim, p, { a: 'gather', nodeId: cap.id }).ok).toBe(true);
    expect(countItem(p.inventory.slots, 'glowcap')).toBeGreaterThanOrEqual(1);
    expect(sim.world.nodes[cap.id]?.respawnAt).toBeGreaterThan(sim.now);
    // standing in the cave (the player's own movement updates drive exploration)
    for (let i = 0; i < 12; i++) { sim.queueInputs(p.id, [{ seq: 100 + i, mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false }]); sim.tick(); }
    expect(p.milestones).toContain('cave');
    give(p, 'glowcap', 4); give(p, 'shell'); give(p, 'resin');
    expect(act(sim, p, { a: 'craft', recipe: 'glow_jar', count: 1 }).ok).toBe(true);
    seconds(sim, 6);
    expect(countItem(p.inventory.slots, 'glow_jar')).toBe(1);
    // the guano heap
    const heap = cave.life.find((n) => n.type === 'guano_pile')!;
    place(p, { x: heap.x + 0.8, y: heap.y, z: heap.z });
    seconds(sim, 0.5);
    expect(act(sim, p, { a: 'gather', nodeId: heap.id }).ok).toBe(true);
    expect(countItem(p.inventory.slots, 'guano')).toBeGreaterThanOrEqual(2);
  });

  it('guano makes crops grow much faster for a day', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-farm', 'Farmer');
    p.hunger = 100; p.thirst = 100;
    const mk = (id: string, x: number): StructureState => {
      const s: StructureState = { id, type: 'garden_plot', x, y: sim.gen.heightAt(x, 40), z: 40, yaw: 0, hp: 100, owner: p.id, builtAt: 0, crops: [null, null, null, null] };
      sim.addStructure(s);
      return s;
    };
    const a = mk('plotA', 30), b = mk('plotB', 33);
    place(p, { x: 31.5, y: sim.gen.heightAt(31.5, 41), z: 41 });
    for (const s of [a, b]) s.crops![0] = { crop: 'flax', growth: 0, water: 1, dryHours: 0, withered: false };
    addStack(p.inventory.slots, makeStack('guano', 3));
    const slot = p.inventory.slots.findIndex((s) => s?.id === 'guano');
    expect(act(sim, p, { a: 'fertilize', id: 'plotA', from: { c: 'inv', i: slot } }).ok).toBe(true);
    expect(countItem(p.inventory.slots, 'guano')).toBe(2);
    expect(a.crops![0]!.fert).toBeGreaterThan(0);
    // an empty plot has nothing to feed: no guano is used up
    const c = mk('plotC', 36);
    expect(act(sim, p, { a: 'fertilize', id: c.id, from: { c: 'inv', i: slot } }).ok).toBe(false);
    expect(countItem(p.inventory.slots, 'guano')).toBe(2);
    const hours = (h: number) => seconds(sim, (TIME.dayLengthSeconds / 24) * h);
    for (let i = 0; i < 6; i++) { for (const s of [a, b]) s.crops![0]!.water = 1; hours(1); }
    const ga = a.crops![0]!.growth, gb = b.crops![0]!.growth;
    expect(gb).toBeGreaterThan(0);
    expect(ga / gb).toBeGreaterThan(1.6);
    expect(ga / gb).toBeLessThan(2);
  });

  it('loot tables and recipes only name real items; caches hold cave supplies', () => {
    for (const [name, t] of Object.entries(LOOT_TABLES)) for (const e of t.entries) expect(ITEMS[e.item], `${name}: ${e.item}`).toBeDefined();
    for (const r of RECIPE_LIST) for (const i of [...r.inputs, r.output]) expect(ITEMS[i.item], `${r.id}: ${i.item}`).toBeDefined();
    const sim = newSim();
    const cache = sim.world.containers[sim.gen.caves[0]!.crate.id]!;
    expect(cache.loot).toBe('cave_cache');
  });
});
