import { describe, it, expect } from 'vitest';
import { newSim, give, act, seconds, ticks, flatLand, place } from './helpers';
import { countItem } from '../src/shared/systems/inventory';
import { NODES } from '../src/shared/defs/nodes';
import { STRUCTURES } from '../src/shared/defs/structures';
import { computePlacement } from '../src/shared/systems/building';
import { TIME, SURVIVAL } from '../src/shared/config';

describe('crafting', () => {
  it('crafts a starter recipe over time and consumes inputs', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-crafter-1', 'A');
    give(p, 'fiber', 6);
    expect(act(sim, p, { a: 'craft', recipe: 'rope', count: 2 }).ok).toBe(true);
    expect(countItem(p.inventory.slots, 'fiber')).toBe(0);
    seconds(sim, 5);
    expect(countItem(p.inventory.slots, 'rope')).toBe(2);
  });

  it('rejects missing ingredients, unknown and locked recipes', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-crafter-2', 'B');
    expect(act(sim, p, { a: 'craft', recipe: 'rope', count: 1 }).ok).toBe(false);
    expect(act(sim, p, { a: 'craft', recipe: 'nope', count: 1 }).ok).toBe(false);
    give(p, 'metal_ingot', 2); give(p, 'plank', 1);
    // leather not discovered => metal_axe locked
    const r = act(sim, p, { a: 'craft', recipe: 'metal_axe', count: 1 });
    expect(r.ok).toBe(false);
  });

  it('requires a station nearby and refunds on cancel', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-crafter-3', 'C');
    give(p, 'log', 1);
    expect(act(sim, p, { a: 'craft', recipe: 'plank', count: 1 }).reason).toMatch(/workbench/);
    const spot = flatLand(sim);
    place(p, spot);
    give(p, 'build_hammer');
    give(p, 'stick', 4); give(p, 'rope', 4); give(p, 'log', 2);
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'build_hammer');
    const pl = computePlacement({ structures: sim.world.structures, col: sim.col, gen: sim.gen, waterLevel: sim.waterLevel }, 'workbench', { x: spot.x + 2, y: spot.y, z: spot.z }, 0);
    expect(pl.valid).toBe(true);
    expect(act(sim, p, { a: 'build', structure: 'workbench', x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw }).ok).toBe(true);
    expect(act(sim, p, { a: 'craft', recipe: 'plank', count: 1 }).ok).toBe(true);
    expect(act(sim, p, { a: 'craft_cancel', index: 0 }).ok).toBe(true);
    expect(countItem(p.inventory.slots, 'log')).toBe(1);
  });
});

describe('harvesting', () => {
  it('fells a palm with an axe and respects tool requirements', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-harvest', 'H');
    const palm = sim.gen.nodesInRadius(0, 0, 200).find((n) => n.type === 'palm')!;
    place(p, { x: palm.x + 1.2, y: palm.y, z: palm.z });
    // bare hands can't chop
    let r = act(sim, p, { a: 'use', target: { kind: 'node', id: palm.id }, yaw: 0, pitch: 0 });
    expect(r.ok).toBe(false);
    give(p, 'stone_axe');
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'stone_axe');
    let swings = 0;
    while (!sim.isNodeDepleted(palm.id) && swings < 20) {
      seconds(sim, 1);
      p.stamina = 100;
      r = act(sim, p, { a: 'use', target: { kind: 'node', id: palm.id }, yaw: 0, pitch: 0 });
      expect(r.ok).toBe(true);
      swings++;
    }
    expect(sim.isNodeDepleted(palm.id)).toBe(true);
    expect(countItem(p.inventory.slots, 'log')).toBeGreaterThanOrEqual(2);
    expect(swings).toBe(Math.ceil(NODES.palm!.hp / 18));
    // respawns later
    sim.world.time += NODES.palm!.respawnSeconds + 5;
    ticks(sim, 25);
    expect(sim.isNodeDepleted(palm.id)).toBe(false);
  });

  it('gathers bare-hand nodes and rejects far targets', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-gather', 'G');
    const bush = sim.gen.nodesInRadius(0, 0, 200).find((n) => n.type === 'fiber_bush')!;
    place(p, { x: bush.x + 30, y: bush.y, z: bush.z });
    expect(act(sim, p, { a: 'gather', nodeId: bush.id }).ok).toBe(false);
    place(p, { x: bush.x + 1, y: bush.y, z: bush.z });
    expect(act(sim, p, { a: 'gather', nodeId: bush.id }).ok).toBe(true);
    expect(countItem(p.inventory.slots, 'fiber')).toBeGreaterThanOrEqual(2);
    expect(act(sim, p, { a: 'gather', nodeId: bush.id }).ok).toBe(false); // depleted
  });
});

describe('building', () => {
  function builder() {
    const sim = newSim();
    const p = sim.addPlayer('tok-builder', 'Bob');
    const spot = flatLand(sim);
    place(p, spot);
    give(p, 'build_hammer');
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'build_hammer');
    give(p, 'stick', 30); give(p, 'palm_frond', 30); give(p, 'rope', 30);
    const ctx = { structures: sim.world.structures, col: sim.col, gen: sim.gen, waterLevel: sim.waterLevel };
    return { sim, p, spot, ctx };
  }

  it('places foundation, snaps walls, roof gives shelter, demolish cascades', () => {
    const { sim, p, spot, ctx } = builder();
    const f = computePlacement(ctx, 'thatch_foundation', { x: spot.x + 3, y: spot.y, z: spot.z }, 0);
    expect(f.valid).toBe(true);
    expect(act(sim, p, { a: 'build', structure: 'thatch_foundation', x: f.x, y: f.y, z: f.z, yaw: f.yaw }).ok).toBe(true);
    const fid = Object.keys(sim.world.structures)[0]!;
    const fnd = sim.world.structures[fid]!;
    // wall aimed near +Z edge
    const w = computePlacement(ctx, 'thatch_wall', { x: fnd.x, y: fnd.y + 1, z: fnd.z + 1.4 }, 0);
    expect(w.valid).toBe(true);
    expect(w.snapped).toBe(true);
    expect(w.y).toBeCloseTo(fnd.y + 0.4);
    expect(act(sim, p, { a: 'build', structure: 'thatch_wall', x: w.x, y: w.y, z: w.z, yaw: w.yaw }).ok).toBe(true);
    // a second wall in the same place is rejected
    expect(act(sim, p, { a: 'build', structure: 'thatch_wall', x: w.x, y: w.y, z: w.z, yaw: w.yaw }).ok).toBe(false);
    // floating wall rejected
    expect(act(sim, p, { a: 'build', structure: 'thatch_wall', x: spot.x - 4, y: spot.y + 5, z: spot.z, yaw: 0 }).ok).toBe(false);
    // roof over the wall
    const roof = computePlacement(ctx, 'thatch_roof', { x: fnd.x, y: fnd.y + 3.4, z: fnd.z }, 0);
    expect(roof.valid).toBe(true);
    expect(act(sim, p, { a: 'build', structure: 'thatch_roof', x: roof.x, y: roof.y, z: roof.z, yaw: roof.yaw }).ok).toBe(true);
    expect(sim.isSheltered(fnd.x, fnd.y + 0.4, fnd.z)).toBe(true);
    // demolishing the foundation collapses wall and roof
    expect(act(sim, p, { a: 'demolish', id: fid }).ok).toBe(true);
    expect(Object.keys(sim.world.structures).length).toBe(0);
  });

  it('rejects building without materials, without hammer, and out of range', () => {
    const { sim, p, spot } = builder();
    expect(act(sim, p, { a: 'build', structure: 'stone_foundation', x: spot.x + 3, y: spot.y, z: spot.z, yaw: 0 }).reason).toMatch(/Missing/);
    expect(act(sim, p, { a: 'build', structure: 'thatch_foundation', x: spot.x + 80, y: spot.y, z: spot.z, yaw: 0 }).reason).toMatch(/far/);
    p.hotbar = 7;
    expect(act(sim, p, { a: 'build', structure: 'thatch_foundation', x: spot.x + 3, y: spot.y, z: spot.z, yaw: 0 }).reason).toMatch(/Mallet/);
  });

  it('builds a campfire, fuels, ignites, cooks and burns food', () => {
    const { sim, p, spot } = builder();
    give(p, 'stone', 4);
    expect(act(sim, p, { a: 'build', structure: 'campfire', x: spot.x + 2, y: sim.gen.heightAt(spot.x + 2, spot.z), z: spot.z, yaw: 0 }).ok).toBe(true);
    const fire = Object.values(sim.world.structures).find((s) => s.type === 'campfire')!;
    const box = sim.world.containers[fire.containerId!]!;
    give(p, 'log', 2); give(p, 'fish_raw', 2); give(p, 'torch');
    p.openContainer = null;
    expect(act(sim, p, { a: 'interact', kind: 'container', id: box.id }).ok).toBe(true);
    const logSlot = p.inventory.slots.findIndex((s) => s?.id === 'log');
    const fishSlot = p.inventory.slots.findIndex((s) => s?.id === 'fish_raw');
    expect(act(sim, p, { a: 'move', from: { c: 'inv', i: fishSlot }, to: { c: 'box', id: box.id, i: 0 } }).ok).toBe(false); // fish isn't fuel
    expect(act(sim, p, { a: 'move', from: { c: 'inv', i: logSlot }, to: { c: 'box', id: box.id, i: 0 } }).ok).toBe(true);
    expect(act(sim, p, { a: 'move', from: { c: 'inv', i: fishSlot }, to: { c: 'box', id: box.id, i: 1 } }).ok).toBe(true);
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'torch');
    expect(act(sim, p, { a: 'ignite', id: fire.id }).ok).toBe(true);
    seconds(sim, 22);
    expect(box.slots[1]?.id).toBe('fish_cooked');
    seconds(sim, 32);
    expect(box.slots[1]?.id).toBe('burnt_food');
    expect(fire.on).toBe(true);
  });
});

describe('survival', () => {
  it('hunger and thirst drain with time and cause damage at zero', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-surv', 'S');
    const h0 = p.hunger, t0 = p.thirst;
    seconds(sim, TIME.dayLengthSeconds / 24); // one game hour
    expect(p.hunger).toBeLessThan(h0);
    expect(p.thirst).toBeLessThan(t0);
    expect(h0 - p.hunger).toBeCloseTo(SURVIVAL.hungerPerHour, 0);
    p.thirst = 0;
    const hp = p.health;
    seconds(sim, 10);
    expect(p.health).toBeLessThan(hp);
  });

  it('drinking sea water worsens thirst, coconut helps', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-drink', 'D');
    give(p, 'coconut', 1);
    p.thirst = 40;
    const slot = p.inventory.slots.findIndex((s) => s?.id === 'coconut');
    expect(act(sim, p, { a: 'consume', from: { c: 'inv', i: slot } }).ok).toBe(true);
    expect(p.thirst).toBeGreaterThan(55);
    give(p, 'coconut_flask', 1);
    const fslot = p.inventory.slots.findIndex((s) => s?.id === 'coconut_flask');
    p.inventory.slots[fslot]!.water = 3; p.inventory.slots[fslot]!.quality = 'salt';
    const before = p.thirst;
    expect(act(sim, p, { a: 'consume', from: { c: 'inv', i: fslot } }).ok).toBe(true);
    expect(p.thirst).toBeLessThan(before);
    expect(p.effects.nausea).toBeGreaterThan(0);
  });

  it('player drowns underwater, dies, leaves a grave, and respawns', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-drown', 'Diver');
    give(p, 'stone', 5);
    // find deep water
    let pos = { x: 0, y: 0, z: 0 };
    for (let x = 300; x < 1000; x += 10) { if (sim.gen.heightAt(x, 0) < -20) { pos = { x, y: -15, z: 0 }; break; } }
    place(p, pos);
    p.underwater = true; p.swimming = true; p.oxygen = 1;
    // hold position underwater by feeding dive input
    let seq = 1;
    for (let i = 0; i < 60 * 20 && !p.dead; i++) {
      sim.queueInputs(p.id, [{ seq: seq++, mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: true }, { seq: seq++, mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: true }, { seq: seq++, mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: true }]);
      sim.tick();
    }
    expect(p.dead).toBe(true);
    const grave = Object.values(sim.world.containers).find((c) => c.kind === 'grave');
    expect(grave).toBeTruthy();
    expect(countItem(grave!.slots, 'stone')).toBe(5);
    expect(countItem(p.inventory.slots, 'stone')).toBe(0);
    expect(act(sim, p, { a: 'respawn', at: 'beach' }).ok).toBe(true);
    expect(p.dead).toBe(false);
    expect(sim.gen.heightAt(p.pos.x, p.pos.z)).toBeGreaterThan(0);
  });

  it('co-op: a player is downed and can be revived', () => {
    const sim = newSim();
    const a = sim.addPlayer('tok-coop-a', 'A');
    const b = sim.addPlayer('tok-coop-b', 'B');
    place(b, { ...a.pos });
    a.health = 5;
    a.invulnUntil = 0;
    sim.kill; // noop
    // shark-style damage
    import('../src/shared/sim/survival').then(() => {});
    const { applyDamage } = require_survival();
    applyDamage(sim, a, 20, 'test');
    expect(a.downed).toBeGreaterThan(0);
    expect(a.dead).toBe(false);
    expect(act(sim, b, { a: 'revive', id: a.id }).ok).toBe(true);
    expect(a.downed).toBe(0);
    expect(a.health).toBeGreaterThan(0);
  });
});

import * as survivalMod from '../src/shared/sim/survival';
function require_survival() { return survivalMod; }

describe('fishing', () => {
  it('cast, wait for bite, reel in time', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-fish', 'F');
    give(p, 'fishing_rod');
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'fishing_rod');
    // walk from the spawn beach to the waterline, then look for fishable water in rod range
    const sp = sim.gen.spawnPoint(0);
    let target = null as null | { x: number; z: number };
    for (let a = 0; a < Math.PI * 2 && !target; a += 0.1) {
      let shore = null as null | { x: number; z: number };
      for (let d = 0; d < 80; d += 0.5) { const x = sp.x + Math.cos(a) * d, z = sp.z + Math.sin(a) * d; if (sim.gen.heightAt(x, z) < 0.1) { shore = { x, z }; break; } }
      if (!shore) continue;
      for (let d = 2; d < 17; d++) { const x = shore.x + Math.cos(a) * d, z = shore.z + Math.sin(a) * d; if (sim.gen.heightAt(x, z) < -1.0) { target = { x, z }; place(p, { x: shore.x, y: sim.gen.heightAt(shore.x, shore.z), z: shore.z }); break; } }
    }
    expect(target).toBeTruthy();
    expect(act(sim, p, { a: 'fish_cast', x: target!.x, z: target!.z }).ok).toBe(true);
    let n = 0;
    while (p.fishing?.phase !== 'bite' && n++ < 400) sim.tick();
    expect(p.fishing?.phase).toBe('bite');
    expect(act(sim, p, { a: 'fish_reel' }).ok).toBe(true);
    expect(countItem(p.inventory.slots, 'fish_raw')).toBeGreaterThanOrEqual(1);
  });
});

describe('structures catalogue', () => {
  it('every structure has a valid cost and size', () => {
    for (const s of Object.values(STRUCTURES)) {
      expect(s.size.every((v) => v > 0)).toBe(true);
      expect(s.cost.length).toBeGreaterThan(0);
    }
  });
});

describe('defense & structure damage', () => {
  it('spike barricades hurt creatures and enraged animals batter walls', async () => {
    const { damageStructure } = await import('../src/shared/sim/wildlife');
    const sim = newSim();
    const p = sim.addPlayer('tok-defense', 'Def');
    const spot = flatLand(sim);
    place(p, spot);
    // a spike barricade next to a boar
    sim.addStructure({ id: 'spk', type: 'spike_barricade', x: spot.x + 4, y: spot.y, z: spot.z, yaw: 0, hp: 250, owner: p.id, builtAt: 0 });
    const boar = { id: 'testboar', kind: 'boar' as const, zone: 'none', x: spot.x + 4.5, y: spot.y, z: spot.z, yaw: 0, speed: 0, hp: 90, mode: 'idle' as 'idle', target: null, tx: 0, tz: 0, ty: 0, modeUntil: 1e9, nextAttackAt: 0, rng: 7, diedAt: 0, butchered: false, lastHitBy: null, bleed: 0 };
    sim.world.creatures[boar.id] = boar;
    ticks(sim, 21);
    expect(sim.world.creatures[boar.id]!.hp).toBeLessThan(90);
    // structure damage collapses supported pieces
    give(p, 'build_hammer'); give(p, 'stick', 20); give(p, 'palm_frond', 20); give(p, 'rope', 10);
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'build_hammer');
    const ctx = { structures: sim.world.structures, col: sim.col, gen: sim.gen, waterLevel: sim.waterLevel };
    const f = computePlacement(ctx, 'thatch_foundation', { x: spot.x - 4, y: spot.y, z: spot.z }, 0);
    expect(act(sim, p, { a: 'build', structure: 'thatch_foundation', x: f.x, y: f.y, z: f.z, yaw: f.yaw }).ok).toBe(true);
    const fnd = Object.values(sim.world.structures).find((s) => s.type === 'thatch_foundation')!;
    const w = computePlacement(ctx, 'thatch_wall', { x: fnd.x, y: fnd.y + 1, z: fnd.z + 1.4 }, 0);
    expect(act(sim, p, { a: 'build', structure: 'thatch_wall', x: w.x, y: w.y, z: w.z, yaw: w.yaw }).ok).toBe(true);
    damageStructure(sim, fnd, 10000, 'boar');
    expect(Object.values(sim.world.structures).some((s) => s.type === 'thatch_wall')).toBe(false);
  });
});
