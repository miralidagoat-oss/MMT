import { describe, it, expect, afterEach } from 'vitest';
import { makeHost, connectClient, waitFor, run, idle, sleep } from './nethelpers';
import { countItem } from '../src/shared/systems/inventory';
import { makeStack, addStack } from '../src/shared/systems/inventory';
import { SIM, PROTOCOL_VERSION } from '../src/shared/config';
import type { GameHost } from '../src/shared/net/host';

let hosts: GameHost[] = [];
afterEach(() => { for (const h of hosts) h.stop(); hosts = []; });

function start(seed?: number) {
  const r = makeHost(seed);
  r.host.start();
  hosts.push(r.host);
  return r;
}

describe('multiplayer', () => {
  it('four players join, spawn, see each other and a fifth is rejected', async () => {
    const { sim, host } = start();
    const cs = [0, 1, 2, 3].map((i) => connectClient(host, `P${i}`, `token-player-${i}`));
    await waitFor(() => cs.every((c) => c.session.connected && c.session.self), 3000, 'welcome+self');
    expect(Object.values(sim.world.players).filter((p) => p.connected).length).toBe(4);
    await run(cs.map((c) => c.session), 400);
    for (const c of cs) {
      expect(c.session.remotePlayers().length).toBe(3);
      expect(c.session.gen!.heightAt(c.session.self!.x, c.session.self!.z)).toBeGreaterThan(-1);
    }
    let rejected = '';
    const fifth = connectClient(host, 'P5', 'token-player-5');
    fifth.session.on.reject = (r) => { rejected = r; };
    await waitFor(() => !!rejected, 2000, 'reject');
    expect(rejected).toMatch(/full/);
  });

  it('players move independently; remote view converges to server truth', async () => {
    const { sim, host } = start();
    const a = connectClient(host, 'A', 'token-move-aaaa');
    const b = connectClient(host, 'B', 'token-move-bbbb');
    await waitFor(() => a.session.self !== null && b.session.self !== null);
    const start0 = { ...sim.world.players[a.session.playerId]!.pos };
    await run([a.session, b.session], 1500, (c) => (c === a.session ? { ...idle, mz: 1, yaw: 0.3 } : idle));
    await run([a.session, b.session], 500);
    const pa = sim.world.players[a.session.playerId]!;
    const moved = Math.hypot(pa.pos.x - start0.x, pa.pos.z - start0.z);
    expect(moved).toBeGreaterThan(2);
    // B didn't move
    const pb = sim.world.players[b.session.playerId]!;
    expect(Math.hypot(pb.vel.x, pb.vel.z)).toBeLessThan(0.1);
    // A's prediction agrees with server
    const v = a.session.viewPosition();
    expect(Math.hypot(v.x - pa.pos.x, v.z - pa.pos.z)).toBeLessThan(0.25);
    // B sees A at the right place
    const seen = b.session.remotePlayers().find((p) => p.id === pa.id)!;
    expect(Math.hypot(seen.x - pa.pos.x, seen.z - pa.pos.z)).toBeLessThan(0.5);
  });

  it('server authority: clients cannot fabricate items or reuse action ids', async () => {
    const { sim, host } = start();
    const a = connectClient(host, 'A', 'token-auth-aaaa');
    await waitFor(() => a.session.connected);
    // try to craft without items
    expect((await a.session.act({ a: 'craft', recipe: 'stone_axe', count: 1 })).ok).toBe(false);
    // move from a slot that doesn't exist / container not opened
    expect((await a.session.act({ a: 'move', from: { c: 'inv', i: 99 }, to: { c: 'inv', i: 0 } })).ok).toBe(false);
    expect((await a.session.act({ a: 'move', from: { c: 'box', id: 'wreck0.crate0', i: 0 }, to: { c: 'inv', i: 0 } })).ok).toBe(false);
    // duplicate action id: give fiber, craft rope with id 777 twice -> only one craft
    const p = sim.world.players[a.session.playerId]!;
    addStack(p.inventory.slots, makeStack('fiber', 6));
    p.discovered.push('fiber');
    a.session.rawAct(777, { a: 'craft', recipe: 'rope', count: 1 });
    a.session.rawAct(777, { a: 'craft', recipe: 'rope', count: 1 });
    await sleep(300);
    expect(countItem(p.inventory.slots, 'fiber')).toBe(3);
    // speedhack: flood inputs claiming to sprint far -> bounded by real time
    const p0 = { ...p.pos };
    const frames = Array.from({ length: 500 }, (_, i) => ({ seq: 100000 + i, mx: 0, mz: 1, yaw: 0, pitch: 0, jump: false, sprint: true, crouch: false }));
    a.peer && host.handle(a.peer, { t: 'input', frames });
    await sleep(200);
    expect(Math.hypot(p.pos.x - p0.x, p.pos.z - p0.z)).toBeLessThan(8);
  });

  it('inventory and world changes replicate to all clients', async () => {
    const { sim, host } = start();
    const a = connectClient(host, 'A', 'token-repl-aaaa');
    const b = connectClient(host, 'B', 'token-repl-bbbb');
    await waitFor(() => a.session.connected && b.session.connected && !!a.session.me);
    const pa = sim.world.players[a.session.playerId]!;
    const bush = sim.gen.nodesInRadius(pa.pos.x, pa.pos.z, 60).find((n) => n.type === 'fiber_bush' || n.type === 'loose_stick' || n.type === 'beach_shell' || n.type === 'loose_stone')!;
    pa.pos = { x: bush.x + 0.8, y: bush.y, z: bush.z };
    expect((await a.session.act({ a: 'gather', nodeId: bush.id })).ok).toBe(true);
    await waitFor(() => b.session.isNodeDepleted(bush.id), 2000, 'node depletion replicated');
    await waitFor(() => (a.session.me?.inventory.slots.some((s) => s) ?? false), 2000, 'inventory replicated');
    // drop an item; B sees it
    const slot = a.session.me!.inventory.slots.findIndex((s) => s);
    expect((await a.session.act({ a: 'drop', from: { c: 'inv', i: slot } })).ok).toBe(true);
    await waitFor(() => Object.keys(b.session.items).length > 0, 2000, 'item replicated');
  });

  it('disconnect, others continue, reconnect restores state', async () => {
    const { sim, host } = start();
    const a = connectClient(host, 'A', 'token-recon-aaaa');
    const b = connectClient(host, 'B', 'token-recon-bbbb');
    await waitFor(() => a.session.connected && b.session.connected);
    const pa = sim.world.players[a.session.playerId]!;
    addStack(pa.inventory.slots, makeStack('stone', 7));
    a.drop();
    await sleep(100);
    expect(pa.connected).toBe(false);
    await waitFor(() => b.session.roster.some((r) => r.id === pa.id && !r.connected), 2000, 'roster update');
    const tick0 = sim.world.tick;
    await run([b.session], 300, () => ({ ...idle, mz: 1 }));
    expect(sim.world.tick).toBeGreaterThan(tick0);
    const a2 = connectClient(host, 'A', 'token-recon-aaaa');
    await waitFor(() => a2.session.connected && !!a2.session.me);
    expect(a2.session.playerId).toBe(pa.id);
    expect(countItem(a2.session.me!.inventory.slots, 'stone')).toBe(7);
  });

  it('rejects wrong protocol versions', async () => {
    const { host } = start();
    let reason = '';
    const peer = host.connect((m) => { if (m.t === 'reject') reason = m.reason; }, () => {});
    host.handle(peer, { t: 'hello', protocol: PROTOCOL_VERSION + 1, name: 'x', token: 'abcdefghij' });
    expect(reason).toMatch(/Version/);
  });

  for (const cfg of [{ lagMs: 80, jitterMs: 40, loss: 0.05 }, { lagMs: 150, jitterMs: 60, loss: 0.15 }]) {
    it(`stays consistent under ${cfg.lagMs}ms lag / ${cfg.loss * 100}% loss`, async () => {
      const { sim, host } = start();
      const cs = [0, 1, 2, 3].map((i) => connectClient(host, `L${i}`, `token-lag-${i}-xyz`, cfg));
      await waitFor(() => cs.every((c) => c.session.connected && c.session.self), 5000, 'connected');
      await run(cs.map((c) => c.session), 2500, (_c, i) => ({ ...idle, mz: i % 2 ? 1 : 0.6, mx: i === 3 ? 0.5 : 0, yaw: i * 1.3 }));
      await run(cs.map((c) => c.session), 1200);
      for (const c of cs) {
        const sp = sim.world.players[c.session.playerId]!;
        const v = c.session.viewPosition();
        expect(Math.hypot(v.x - sp.pos.x, v.z - sp.pos.z)).toBeLessThan(0.35);
        for (const other of c.session.remotePlayers()) {
          const truth = sim.world.players[other.id]!;
          expect(Math.hypot(other.x - truth.pos.x, other.z - truth.pos.z)).toBeLessThan(0.6);
        }
      }
      // actions still work and results arrive
      const r = await cs[0]!.session.act({ a: 'hotbar', index: 2 });
      expect(r.ok).toBe(true);
      expect(SIM.tickRate).toBe(20);
    }, 20000);
  }
});
