/**
 * Acceptance scenario (see PROJECT_STATUS.md): a complete multiplayer session
 * exercised through the real network stack (GameHost + 4 ClientSessions over a
 * lossy, laggy link), then saved, "relaunched" from the save and verified.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Simulation } from '../src/shared/sim/simulation';
import { GameHost } from '../src/shared/net/host';
import { serializeWorld, deserializeWorld } from '../src/shared/save';
import { computePlacement } from '../src/shared/systems/building';
import { countItem, makeStack, addStack } from '../src/shared/systems/inventory';
import { NODES } from '../src/shared/defs/nodes';
import { TIME, SIM } from '../src/shared/config';
import { dayNumber } from '../src/shared/systems/weather';
import { connectClient, waitFor, run, idle, sleep } from './nethelpers';
import type { ClientSession } from '../src/client/net/session';
import type { PlayerState } from '../src/shared/state';

const LAG = { lagMs: 60, jitterMs: 30, loss: 0.05 };
const hosts: GameHost[] = [];
afterAll(() => { for (const h of hosts) h.stop(); });

function giveP(p: PlayerState, id: string, qty: number) {
  let left = qty;
  while (left > 0) { const st = makeStack(id, left); left -= st.qty; addStack(p.inventory.slots, st); }
  if (!p.discovered.includes(id)) p.discovered.push(id);
}

/** Walk a client toward a target using real inputs until within `reach` (prediction + server authority). */
async function walkTo(c: ClientSession, tx: number, tz: number, reach = 1.2, maxMs = 25000) {
  const t0 = Date.now();
  let last = performance.now();
  let lastProgress = Date.now(), best = Infinity, sidestep = 0, side = 1;
  while (Date.now() - t0 < maxMs) {
    const p = c.viewPosition();
    const d = Math.hypot(tx - p.x, tz - p.z);
    if (d < reach) return true;
    if (d < best - 0.3) { best = d; lastProgress = Date.now(); }
    else if (Date.now() - lastProgress > 700 && sidestep <= 0) { sidestep = 0.6; side = -side; lastProgress = Date.now(); }
    const yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
    await sleep(16);
    const now = performance.now();
    const dt = (now - last) / 1000;
    sidestep -= dt;
    c.update(dt, { ...idle, mz: sidestep > 0 ? 0.3 : 1, mx: sidestep > 0 ? side : 0, yaw, sprint: d > 6, jump: sidestep > 0.4 });
    last = now;
  }
  return false;
}

describe('acceptance: full co-op survival loop', () => {
  it('runs the complete scenario', async () => {
    // ---------------------------------------------------------------- new world, 4 players
    const sim = new Simulation({ seed: 20261003, name: 'Acceptance' });
    const host = new GameHost(sim, { log: () => {} });
    host.start();
    hosts.push(host);
    const clients = [0, 1, 2, 3].map((i) => connectClient(host, `Survivor${i}`, `accept-token-${i}-abc`, LAG));
    await waitFor(() => clients.every((c) => c.session.connected && c.session.self && c.session.me), 8000, '4 players connected');
    const sess = clients.map((c) => c.session);
    const P = sess.map((s) => sim.world.players[s.playerId]!);
    expect(P.every((p) => p.connected)).toBe(true);
    // all spawned on dry land of the start island
    for (const p of P) expect(sim.gen.heightAt(p.pos.x, p.pos.z)).toBeGreaterThan(-0.5);

    // ---------------------------------------------------------------- independent movement + visibility
    const starts = P.map((p) => ({ ...p.pos }));
    await run(sess, 1500, (_c, i) => ({ ...idle, mz: 1, yaw: i * (Math.PI / 2) }));
    await run(sess, 600);
    P.forEach((p, i) => expect(Math.hypot(p.pos.x - starts[i]!.x, p.pos.z - starts[i]!.z)).toBeGreaterThan(1.5));
    for (const s of sess) expect(s.remotePlayers().length).toBe(3);

    // ---------------------------------------------------------------- collect resources (real gathering through the network)
    const a = sess[0]!, pa = P[0]!;
    const pickups = sim.gen.nodesInRadius(pa.pos.x, pa.pos.z, 80).filter((n) => NODES[n.type]!.action === 'gather' && ['fiber_bush', 'loose_stick', 'loose_stone', 'wild_flax'].includes(n.type)).slice(0, 6);
    expect(pickups.length).toBeGreaterThan(2);
    let gathered = 0;
    for (const n of pickups) {
      expect(await walkTo(a, n.x, n.z, 1.6)).toBe(true);
      await run([a], 150);
      const r = await a.act({ a: 'gather', nodeId: n.id });
      if (r.ok) gathered++;
    }
    expect(gathered).toBeGreaterThan(2);
    // inventory replicated to the owning client only
    await waitFor(() => (a.me?.inventory.slots.filter(Boolean).length ?? 0) > 0, 3000, 'inventory sync');

    // top up materials for the long build session (simulates a few minutes of foraging)
    giveP(pa, 'stick', 20); giveP(pa, 'stone', 20); giveP(pa, 'fiber', 30); giveP(pa, 'palm_frond', 20);
    sim.markPlayer(pa.id);

    // ---------------------------------------------------------------- craft tools
    // the crafting queue holds 8 jobs, so craft in two batches
    for (const batch of [[['rope', 3], ['rope', 3]], [['stone_axe', 1], ['build_hammer', 1], ['hand_drill', 1]]] as const) {
      for (const [recipe, count] of batch) {
        const r = await a.act({ a: 'craft', recipe, count });
        expect(r.ok, `${recipe}: ${r.reason}`).toBe(true);
      }
      await waitFor(() => pa.craftQueue.length === 0, 40000, 'craft batch');
    }
    await waitFor(() => countItem(pa.inventory.slots, 'build_hammer') > 0 && countItem(pa.inventory.slots, 'hand_drill') > 0, 30000, 'crafting done');
    expect(countItem(pa.inventory.slots, 'stone_axe')).toBe(1);

    // fell a palm with the axe for logs
    const palm = sim.gen.nodesInRadius(pa.pos.x, pa.pos.z, 120).filter((n) => n.type === 'palm' && !sim.isNodeDepleted(n.id) && n.y > 0.3)
      .sort((x, y) => Math.hypot(x.x - pa.pos.x, x.z - pa.pos.z) - Math.hypot(y.x - pa.pos.x, y.z - pa.pos.z))[0]!;
    expect(await walkTo(a, palm.x, palm.z, 1.5)).toBe(true);
    await a.act({ a: 'hotbar', index: pa.inventory.slots.findIndex((s) => s?.id === 'stone_axe') });
    for (let i = 0; i < 12 && !sim.isNodeDepleted(palm.id); i++) {
      pa.stamina = 100;
      await a.act({ a: 'use', target: { kind: 'node', id: palm.id }, yaw: 0, pitch: 0 });
      await sleep(850);
    }
    expect(sim.isNodeDepleted(palm.id)).toBe(true);
    expect(countItem(pa.inventory.slots, 'log')).toBeGreaterThanOrEqual(2);
    await waitFor(() => sess[2]!.isNodeDepleted(palm.id), 3000, 'tree depletion seen by other players');

    // ---------------------------------------------------------------- build a shelter on flat ground
    giveP(pa, 'log', 12); giveP(pa, 'rope', 20); giveP(pa, 'stick', 20); giveP(pa, 'palm_frond', 20); giveP(pa, 'stone', 8);
    await a.act({ a: 'hotbar', index: pa.inventory.slots.findIndex((s) => s?.id === 'build_hammer') });
    const flat = findFlat(sim);
    pa.pos = { ...flat }; pa.vel = { x: 0, y: 0, z: 0 };
    await run([a], 500);
    const ctx = { structures: sim.world.structures, col: sim.col, gen: sim.gen, waterLevel: sim.waterLevel };
    const f = computePlacement(ctx, 'thatch_foundation', { x: flat.x + 3.5, y: flat.y, z: flat.z }, 0);
    expect(f.valid, f.reason).toBe(true);
    okAct(await a.act({ a: 'build', structure: 'thatch_foundation', x: f.x, y: f.y, z: f.z, yaw: f.yaw }));
    const fnd = Object.values(sim.world.structures).find((s) => s.type === 'thatch_foundation')!;
    for (const [lx, lz] of [[0, 1.4], [1.4, 0], [-1.4, 0]] as const) {
      const w = computePlacement(ctx, 'thatch_wall', { x: fnd.x + lx, y: fnd.y + 1, z: fnd.z + lz }, 0);
      okAct(await a.act({ a: 'build', structure: 'thatch_wall', x: w.x, y: w.y, z: w.z, yaw: w.yaw }));
    }
    const roof = computePlacement(ctx, 'thatch_roof', { x: fnd.x, y: fnd.y + 3.4, z: fnd.z }, 0);
    okAct(await a.act({ a: 'build', structure: 'thatch_roof', x: roof.x, y: roof.y, z: roof.z, yaw: roof.yaw }));
    expect(sim.isSheltered(fnd.x, fnd.y + 0.4, fnd.z)).toBe(true);
    // lean-to bed sets respawn
    okAct(await a.act({ a: 'build', structure: 'lean_to', x: flat.x - 2, y: sim.gen.heightAt(flat.x - 2, flat.z - 3), z: flat.z - 3, yaw: 0 }));
    const bed = Object.values(sim.world.structures).find((s) => s.type === 'lean_to')!;
    pa.pos = { x: bed.x + 1, y: sim.gen.heightAt(bed.x + 1, bed.z + 1), z: bed.z + 1 };
    okAct(await a.act({ a: 'sleep', id: bed.id }));
    expect(pa.respawn?.structureId).toBe(bed.id);
    await waitFor(() => Object.keys(sess[3]!.structures).length === Object.keys(sim.world.structures).length, 3000, 'structures replicated');

    // ---------------------------------------------------------------- fire + cooking
    const fx = flat.x - 1, fz = flat.z + 2;
    okAct(await a.act({ a: 'build', structure: 'campfire', x: fx, y: sim.gen.heightAt(fx, fz), z: fz, yaw: 0 }));
    const fire = Object.values(sim.world.structures).find((s) => s.type === 'campfire')!;
    pa.pos = { x: fire.x + 1.5, y: sim.gen.heightAt(fire.x + 1.5, fire.z), z: fire.z };
    okAct(await a.act({ a: 'interact', kind: 'structure', id: fire.id, verb: 'open' }));
    giveP(pa, 'crab_raw', 2);
    const logSlot = pa.inventory.slots.findIndex((s) => s?.id === 'log');
    okAct(await a.act({ a: 'move', from: { c: 'inv', i: logSlot }, to: { c: 'box', id: fire.containerId!, i: 0 }, qty: 2 }));
    const crabSlot = pa.inventory.slots.findIndex((s) => s?.id === 'crab_raw');
    okAct(await a.act({ a: 'move', from: { c: 'inv', i: crabSlot }, to: { c: 'box', id: fire.containerId!, i: 1 } }));
    let lit = false, why = '';
    for (let i = 0; i < 40 && !lit; i++) {
      if (countItem(pa.inventory.slots, 'hand_drill') === 0) giveP(pa, 'hand_drill', 1); // hand drills wear out quickly
      const r = await a.act({ a: 'ignite', id: fire.id });
      lit = r.ok; why = r.reason ?? '';
      await sleep(30);
    }
    expect(lit, why).toBe(true);
    fastForward(sim, 17);
    expect(sim.world.containers[fire.containerId!]!.slots[1]?.id).toBe('crab_cooked');
    // take the food and eat it
    okAct(await a.act({ a: 'quick_move', from: { c: 'box', id: fire.containerId!, i: 1 } }));
    pa.hunger = 40;
    const cooked = pa.inventory.slots.findIndex((s) => s?.id === 'crab_cooked');
    okAct(await a.act({ a: 'consume', from: { c: 'inv', i: cooked } }));
    expect(pa.hunger).toBeGreaterThan(50);
    await a.act({ a: 'close_container' });

    // ---------------------------------------------------------------- water: sea water -> clay pot on the fire -> clean
    giveP(pa, 'clay_pot', 1);
    const potSlot = pa.inventory.slots.findIndex((s) => s?.id === 'clay_pot');
    pa.inventory.slots[potSlot]!.water = 2; pa.inventory.slots[potSlot]!.quality = 'salt';
    await a.act({ a: 'interact', kind: 'structure', id: fire.id, verb: 'open' });
    okAct(await a.act({ a: 'move', from: { c: 'inv', i: potSlot }, to: { c: 'box', id: fire.containerId!, i: 2 } }));
    fire.fuel = 600;
    fastForward(sim, 42);
    expect(sim.world.containers[fire.containerId!]!.slots[2]?.quality).toBe('clean');
    okAct(await a.act({ a: 'quick_move', from: { c: 'box', id: fire.containerId!, i: 2 } }));
    pa.thirst = 30;
    const pot = pa.inventory.slots.findIndex((s) => s?.id === 'clay_pot');
    okAct(await a.act({ a: 'consume', from: { c: 'inv', i: pot } }));
    expect(pa.thirst).toBeGreaterThan(40);
    await a.act({ a: 'close_container' });

    // ---------------------------------------------------------------- swim + dive (player B)
    const b = sess[1]!, pb = P[1]!;
    const sea = seaPoint(sim, 6);
    pb.pos = { x: sea.x, y: -0.5, z: sea.z };
    await run([b], 1200);
    expect(pb.swimming).toBe(true);
    await run([b], 2000, () => ({ ...idle, crouch: true }));
    expect(pb.underwater).toBe(true);
    expect(pb.oxygen).toBeLessThan(100);
    await run([b], 2500, () => ({ ...idle, jump: true }));
    expect(pb.underwater).toBe(false);

    // ---------------------------------------------------------------- wildlife interaction (player C hunts a crab)
    const c = sess[2]!, pc = P[2]!;
    const crab = Object.values(sim.world.creatures).find((cr) => cr.kind === 'crab' && cr.mode !== 'dead' && sim.gen.islandAt(cr.x, cr.z)?.id === 0)!;
    expect(crab).toBeTruthy();
    giveP(pc, 'crude_spear', 1);
    await c.act({ a: 'hotbar', index: pc.inventory.slots.findIndex((s) => s?.id === 'crude_spear') });
    pc.pos = { x: crab.x + 1, y: crab.y, z: crab.z };
    await run([c], 300);
    for (let i = 0; i < 6 && sim.world.creatures[crab.id] && sim.world.creatures[crab.id]!.mode !== 'dead'; i++) {
      pc.pos = { x: crab.x + 1, y: sim.gen.heightAt(crab.x + 1, crab.z), z: crab.z };
      pc.stamina = 100;
      await c.act({ a: 'use', target: { kind: 'creature', id: crab.id }, yaw: 0, pitch: 0 });
      await sleep(800);
    }
    expect(countItem(pc.inventory.slots, 'crab_raw')).toBeGreaterThanOrEqual(1);

    // ---------------------------------------------------------------- watercraft + navigate to another island (player A drives, D rides)
    giveP(pa, 'log', 8); giveP(pa, 'rope', 6); giveP(pa, 'stick', 4);
    await a.act({ a: 'hotbar', index: pa.inventory.slots.findIndex((s) => s?.id === 'build_hammer') });
    const raftAt = seaPoint(sim, 5);
    pa.pos = { x: raftAt.x + 3, y: sim.waterLevel(raftAt.x + 3, raftAt.z) - 1.4, z: raftAt.z };
    okAct(await a.act({ a: 'build', structure: 'log_raft', x: raftAt.x, y: 0, z: raftAt.z, yaw: 0 }));
    const raft = Object.values(sim.world.vehicles)[0]!;
    okAct(await a.act({ a: 'board', id: raft.id }));
    const d = sess[3]!, pd = P[3]!;
    pd.pos = { x: raft.x + 1, y: raft.y, z: raft.z };
    okAct(await d.act({ a: 'board', id: raft.id }));
    expect(raft.seats[0]).toBe(pa.id);
    expect(raft.seats.filter(Boolean).length).toBe(2);
    // steer toward the nearest other island using real driver inputs, then take the long haul by teleporting the raft
    const target = sim.gen.islands.filter((i) => i.id !== 0).sort((x, y) => Math.hypot(x.x, x.z) - Math.hypot(y.x, y.z))[0]!;
    const before = { x: raft.x, z: raft.z };
    await run([a, d], 3000, (cl) => (cl === a ? { ...idle, mz: 1, yaw: Math.atan2(-(target.x - raft.x), -(target.z - raft.z)) } : idle));
    expect(Math.hypot(raft.x - before.x, raft.z - before.z)).toBeGreaterThan(1.5);
    // sail across open water (simulated quickly): move the raft near the target island's shelf
    const dir = Math.atan2(target.z - raft.z, target.x - raft.x);
    let tx = target.x - Math.cos(dir) * target.radius * 1.35, tz = target.z - Math.sin(dir) * target.radius * 1.35;
    for (let k = 0; k < 40 && -sim.gen.heightAt(tx, tz) < 1.2; k++) { tx -= Math.cos(dir) * 5; tz -= Math.sin(dir) * 5; }
    raft.x = tx; raft.z = tz; raft.vx = 0; raft.vz = 0;
    await run([a, d], 800);
    expect(Math.hypot(pd.pos.x - raft.x, pd.pos.z - raft.z)).toBeLessThan(4); // passenger carried
    // disembark and wade ashore -> island discovered
    await run([a], 300, () => ({ ...idle, jump: true }));
    expect(pa.vehicleId).toBeNull();
    pa.pos = { x: target.x + (tx - target.x) * 0.5, y: 0, z: target.z + (tz - target.z) * 0.5 };
    for (let k = 0; k < 60 && sim.gen.heightAt(pa.pos.x, pa.pos.z) < 1; k++) { pa.pos.x += (target.x - pa.pos.x) * 0.1; pa.pos.z += (target.z - pa.pos.z) * 0.1; }
    pa.pos.y = sim.gen.heightAt(pa.pos.x, pa.pos.z);
    await run([a], 800, () => ({ ...idle, mz: 0.3 }));
    expect(sim.world.progression.discoveredIslands, JSON.stringify({ pos: pa.pos, h: sim.gen.heightAt(pa.pos.x, pa.pos.z), isl: sim.gen.islandAt(pa.pos.x, pa.pos.z)?.id, target: target.id, dead: pa.dead, veh: pa.vehicleId, conn: pa.connected })).toContain(target.id);

    // ---------------------------------------------------------------- time + weather progress
    const day0 = dayNumber(sim.world);
    const kind0 = sim.world.weather.kind;
    fastForward(sim, TIME.dayLengthSeconds * 0.6);
    expect(dayNumber(sim.world)).toBeGreaterThanOrEqual(day0);
    expect(sim.world.time).toBeGreaterThan(TIME.dayLengthSeconds * 0.6);
    // weather is a Markov chain: over a long period it must change at least once
    const seen = new Set([kind0]);
    for (let i = 0; i < 40 && seen.size < 2; i++) { fastForward(sim, TIME.dayLengthSeconds * 0.1); seen.add(sim.world.weather.kind); }
    expect(seen.size).toBeGreaterThan(1);
    // survival stats changed over time (days passed without eating)
    expect(P.every((p) => p.dead || p.hunger < 80)).toBe(true);
    // everyone eats and anyone who starved during the skip respawns
    for (const p of P) { if (p.dead) sim.respawnPlayer(p, 'beach'); p.hunger = 90; p.thirst = 90; p.health = 100; }

    // ---------------------------------------------------------------- death + respawn (player C), others stay in sync
    pc.invulnUntil = 0;
    pc.health = 1;
    sim.kill(pc, 'test');
    await waitFor(() => !!c.self?.dead, 3000, 'death replicated');
    expect(Object.values(sim.world.containers).some((x) => x.kind === 'grave')).toBe(true);
    okAct(await c.act({ a: 'respawn', at: 'beach' }));
    await waitFor(() => c.self?.dead === false, 3000, 'respawn replicated');
    await run(sess, 600);
    for (const s of sess) expect(s.remotePlayers().length).toBe(3);

    // ---------------------------------------------------------------- disconnect, others continue, reconnect
    const dTokenName = 'Survivor3';
    clients[3]!.drop();
    await sleep(200);
    expect(pd.connected).toBe(false);
    const tickBefore = sim.world.tick;
    await run(sess.slice(0, 3), 800, () => ({ ...idle, mz: 0.5 }));
    expect(sim.world.tick).toBeGreaterThan(tickBefore);
    const d2 = connectClient(host, dTokenName, 'accept-token-3-abc', LAG);
    await waitFor(() => d2.session.connected && !!d2.session.me, 5000, 'reconnect');
    expect(d2.session.playerId).toBe(pd.id);
    expect(pd.connected).toBe(true);

    // ---------------------------------------------------------------- farming: garden plot, plant, water, grow
    giveP(pa, 'plank', 4); giveP(pa, 'clay', 2); giveP(pa, 'taro_seed', 2); giveP(pa, 'coconut_flask', 1);
    if (countItem(pa.inventory.slots, 'build_hammer') === 0) giveP(pa, 'build_hammer', 1); // lost to a grave if A starved in the time skip
    if (countItem(pa.inventory.slots, 'stone_axe') === 0) giveP(pa, 'stone_axe', 1);
    pa.pos = { ...flat }; pa.vel = { x: 0, y: 0, z: 0 };
    await a.act({ a: 'hotbar', index: pa.inventory.slots.findIndex((s) => s?.id === 'build_hammer') });
    const gx = flat.x + 3.5, gz = flat.z - 5;
    const gp = computePlacement(ctx, 'garden_plot', { x: gx, y: sim.gen.heightAt(gx, gz), z: gz }, 0);
    expect(gp.valid, gp.reason).toBe(true);
    okAct(await a.act({ a: 'build', structure: 'garden_plot', x: gp.x, y: gp.y, z: gp.z, yaw: gp.yaw }));
    const plot = Object.values(sim.world.structures).find((s) => s.type === 'garden_plot')!;
    pa.pos = { x: plot.x + 1.5, y: sim.gen.heightAt(plot.x + 1.5, plot.z), z: plot.z };
    const seedSlot = pa.inventory.slots.findIndex((s) => s?.id === 'taro_seed');
    okAct(await a.act({ a: 'plant', id: plot.id, plot: 0, from: { c: 'inv', i: seedSlot } }));
    const flask = pa.inventory.slots.findIndex((s) => s?.id === 'coconut_flask');
    pa.inventory.slots[flask]!.water = 3; pa.inventory.slots[flask]!.quality = 'clean';
    okAct(await a.act({ a: 'water_crop', id: plot.id, from: { c: 'inv', i: flask } }));
    fastForward(sim, TIME.dayLengthSeconds / 24 * 4);
    const crop0 = plot.crops![0]!;
    expect(crop0.growth).toBeGreaterThan(0.05);

    // ---------------------------------------------------------------- save, "close", relaunch, load, verify
    host.stop();
    const text = serializeWorld(sim.world, dayNumber(sim.world));
    const counts = {
      structures: Object.keys(sim.world.structures).length,
      vehicles: Object.keys(sim.world.vehicles).length,
      time: sim.world.time,
      inv: countItem(pa.inventory.slots, 'stone_axe'),
      discovered: sim.world.progression.discoveredIslands.length,
      milestones: pa.milestones.length,
    };
    expect(counts.structures).toBeGreaterThanOrEqual(6);
    const relaunched = new Simulation({ world: deserializeWorld(text) });
    expect(Object.keys(relaunched.world.structures).length).toBe(counts.structures);
    expect(Object.keys(relaunched.world.vehicles).length).toBe(counts.vehicles);
    expect(relaunched.world.time).toBeCloseTo(counts.time);
    expect(relaunched.world.progression.discoveredIslands.length).toBe(counts.discovered);
    const pa2 = relaunched.world.players[pa.id]!;
    expect(countItem(pa2.inventory.slots, 'stone_axe')).toBe(counts.inv);
    expect(pa2.milestones.length).toBe(counts.milestones);
    expect(pa2.respawn?.structureId).toBe(bed.id);
    expect(relaunched.isSheltered(fnd.x, fnd.y + 0.4, fnd.z)).toBe(true); // collision/structure index rebuilt
    expect(relaunched.world.structures[plot.id]!.crops![0]!.growth).toBeCloseTo(crop0.growth);
    expect(relaunched.world.vehicles[raft.id]!.hp).toBe(raft.hp);
    expect(Object.values(relaunched.world.players).every((p) => !p.connected)).toBe(true);
    // the relaunched world accepts the same players again
    const host2 = new GameHost(relaunched, { log: () => {} });
    host2.start();
    hosts.push(host2);
    const back = connectClient(host2, 'Survivor0', 'accept-token-0-abc');
    await waitFor(() => back.session.connected && !!back.session.me, 5000, 'rejoin after relaunch');
    expect(back.session.playerId).toBe(pa.id);
    expect(Object.keys(back.session.structures).length).toBe(counts.structures);
    void SIM;
  }, 180000);
});

function okAct(r: { ok: boolean; reason?: string }) {
  expect(r.ok, r.reason).toBe(true);
}

function fastForward(sim: Simulation, seconds: number) {
  const n = Math.round(seconds * SIM.tickRate);
  for (let i = 0; i < n; i++) sim.tick();
}

function findFlat(sim: Simulation) {
  for (let r = 30; r < 220; r += 4) for (let a = 0; a < Math.PI * 2; a += 0.15) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = sim.gen.heightAt(x, z);
    if (h < 3 || h > 10) continue;
    let ok = true;
    for (const [dx, dz] of [[-4, -4], [8, -4], [-4, 4], [8, 4], [0, 0], [4, 0], [-3, -3], [0, -5]]) if (Math.abs(sim.gen.heightAt(x + dx!, z + dz!) - h) > 0.9) { ok = false; break; }
    if (ok && !sim.col.solidNodeNear(x + 3.5, z, 4) && !sim.col.solidNodeNear(x - 2, z - 3, 2.5) && !sim.col.solidNodeNear(x - 1, z + 2, 2)) return { x, y: h, z };
  }
  throw new Error('no flat land');
}

/** A point in open water near the start island with at least `depth` metres of water. */
function seaPoint(sim: Simulation, depth: number) {
  const isl = sim.gen.islands[0]!;
  for (let a = 0; a < Math.PI * 2; a += 0.05) for (let d = isl.radius * 0.8; d < isl.radius * 2; d += 3) {
    const x = isl.x + Math.cos(a) * d, z = isl.z + Math.sin(a) * d;
    if (-sim.gen.heightAt(x, z) > depth && -sim.gen.heightAt(x, z) < depth + 6) return { x, z };
  }
  throw new Error('no sea point');
}
