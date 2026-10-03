import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newSim, give, act, seconds, flatLand, place } from './helpers';
import { startEvent } from '../src/shared/sim/events';
import { FsSaveStore } from '../src/server/savestore';
import { serializeWorld, deserializeWorld, SaveError } from '../src/shared/save';
import { TIME, SAVE_VERSION } from '../src/shared/config';
import { countItem } from '../src/shared/systems/inventory';
import { GAME_HOUR_SECONDS } from '../src/shared/defs/items';

describe('world events', () => {
  it('supply drops spawn a loot crate that drifts toward land; storms force weather', () => {
    const sim = newSim();
    sim.addPlayer('tok-events', 'E');
    const e = startEvent(sim, 'supply_drop')!;
    const box = sim.world.containers[String(e.data!.container)]!;
    expect(box.loot).toBe('supply_drop');
    const isl = sim.gen.nearestIsland(box.x, box.z).island;
    const d0 = Math.hypot(box.x - isl.x, box.z - isl.z);
    seconds(sim, 30);
    expect(Math.hypot(box.x - isl.x, box.z - isl.z)).toBeLessThan(d0);
    startEvent(sim, 'storm_front');
    seconds(sim, 60);
    expect(sim.world.weather.next).toBe('storm');
    expect(sim.world.weather.rain).toBeGreaterThan(0.3);
  });
});

describe('endgame', () => {
  it('beacon on a peak triggers a rescue after 12 hours', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-beacon', 'B');
    // find high ground on the start island
    let peak = { x: 0, y: 0, z: 0 };
    for (let x = -150; x <= 150; x += 5) for (let z = -150; z <= 150; z += 5) { const h = sim.gen.heightAt(x, z); if (h > peak.y) peak = { x, y: h, z }; }
    expect(peak.y).toBeGreaterThan(12);
    place(p, peak);
    give(p, 'build_hammer'); give(p, 'beacon_core'); give(p, 'metal_ingot', 6); give(p, 'plank', 8); give(p, 'copper_wire', 4);
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'build_hammer');
    let built = false;
    for (let a = 0; a < Math.PI * 2 && !built; a += 0.4) {
      const x = peak.x + Math.cos(a) * 3, z = peak.z + Math.sin(a) * 3;
      built = act(sim, p, { a: 'build', structure: 'signal_beacon', x, y: sim.gen.heightAt(x, z), z, yaw: 0 }).ok;
    }
    expect(built).toBe(true);
    const beacon = Object.values(sim.world.structures).find((s) => s.type === 'signal_beacon')!;
    expect(act(sim, p, { a: 'beacon', id: beacon.id }).ok).toBe(true);
    expect(sim.world.progression.beaconId).toBe(beacon.id);
    p.hunger = 100; p.thirst = 100;
    seconds(sim, TIME.dayLengthSeconds * 0.5 + 2);
    expect(sim.world.progression.rescued).toBe(true);
    expect(p.milestones).toContain('rescued');
    expect(sim.world.events.some((e) => e.kind === 'rescue')).toBe(true);
  });

  it('a beacon cannot be built at sea level', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-beacon2', 'B2');
    const sp = sim.gen.spawnPoint(0);
    place(p, sp);
    give(p, 'build_hammer'); give(p, 'beacon_core'); give(p, 'metal_ingot', 6); give(p, 'plank', 8); give(p, 'copper_wire', 4);
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'build_hammer');
    const r = act(sim, p, { a: 'build', structure: 'signal_beacon', x: sp.x + 2, y: sim.gen.heightAt(sp.x + 2, sp.z), z: sp.z, yaw: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/above the sea|uneven|Blocked|tree/);
  });
});

describe('drying rack', () => {
  it('dries raw fish into jerky that never spoils', () => {
    const sim = newSim();
    const p = sim.addPlayer('tok-dry', 'D');
    const spot = flatLand(sim);
    place(p, spot);
    give(p, 'build_hammer'); give(p, 'stick', 6); give(p, 'rope', 3); give(p, 'fish_raw', 2);
    p.hotbar = p.inventory.slots.findIndex((s) => s?.id === 'build_hammer');
    expect(act(sim, p, { a: 'build', structure: 'drying_rack', x: spot.x + 2, y: sim.gen.heightAt(spot.x + 2, spot.z), z: spot.z, yaw: 0 }).ok).toBe(true);
    const rack = Object.values(sim.world.structures).find((s) => s.type === 'drying_rack')!;
    expect(act(sim, p, { a: 'interact', kind: 'structure', id: rack.id, verb: 'open' }).ok).toBe(true);
    const fish = p.inventory.slots.findIndex((s) => s?.id === 'fish_raw');
    expect(act(sim, p, { a: 'move', from: { c: 'inv', i: fish }, to: { c: 'box', id: rack.containerId!, i: 0 } }).ok).toBe(true);
    sim.world.weather.rain = 0;
    seconds(sim, GAME_HOUR_SECONDS * 8 * 1.6);
    expect(sim.world.containers[rack.containerId!]!.slots[0]?.id).toBe('fish_jerky');
    expect(sim.world.containers[rack.containerId!]!.slots[0]?.spoilAt).toBeUndefined();
  });
});

describe('save robustness', () => {
  it('detects corruption, falls back to backups, and migrates old versions', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-save-'));
    const logs: string[] = [];
    const store = new FsSaveStore(dir, (m) => logs.push(m));
    const sim = newSim();
    const p = sim.addPlayer('tok-save', 'S');
    give(p, 'stone', 7);
    await store.save('w', sim.world, 1);
    give(p, 'stone', 3);
    await store.save('w', sim.world, 1); // previous save becomes .bak1
    // corrupt the main file
    const main = path.join(dir, 'w.tws');
    writeFileSync(main, readFileSync(main, 'utf8').slice(0, 500));
    const loaded = await store.load('w');
    expect(loaded).not.toBeNull();
    expect(countItem(loaded!.players[p.id]!.inventory.slots, 'stone')).toBe(7); // from backup
    expect(logs.some((l) => /recovered/.test(l))).toBe(true);
    // tampered payload -> checksum error
    const text = serializeWorld(sim.world, 1);
    const env = JSON.parse(text);
    env.payload = env.payload.replace('"stone"', '"STONE"');
    expect(() => deserializeWorld(JSON.stringify(env))).toThrow(SaveError);
    // newer-version saves are refused
    const fut = JSON.parse(text);
    fut.version = SAVE_VERSION + 1;
    expect(() => deserializeWorld(JSON.stringify(fut))).toThrow(/newer/);
    // v1 saves migrate (no waypoints/events/progression)
    const old = JSON.parse(text);
    const payload = JSON.parse(old.payload);
    delete payload.waypoints; delete payload.events; delete payload.progression;
    old.version = 1;
    old.payload = JSON.stringify(payload);
    const { crc32 } = await import('../src/shared/math/vec');
    old.checksum = crc32(old.payload);
    const migrated = deserializeWorld(JSON.stringify(old));
    expect(migrated.waypoints).toEqual([]);
    expect(migrated.progression.discoveredIslands).toEqual([0]);
  });
});
