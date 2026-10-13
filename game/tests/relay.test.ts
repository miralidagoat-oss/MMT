import { describe, it, expect } from 'vitest';
import { PresenceLink, parseState, DEFAULT_LINK } from '../src/shared/net/presence-link';
import { makeHost, run, waitFor, idle } from './nethelpers';
import { connectRelayClient } from './relayhelpers';
import { GameHost } from '../src/shared/net/host';
import { PROTOCOL_VERSION } from '../src/shared/config';

describe('presence link', () => {
  it('delivers every reliable frame in order and the latest unreliable frame through a lossy latest-wins relay', () => {
    const got: { a: number[]; b: number[]; bu: number[] } = { a: [], b: [], bu: [] };
    let aState: unknown = null, bState: unknown = null;
    const A = new PresenceLink((s) => { aState = JSON.parse(JSON.stringify(s)); }, (f) => got.a.push(f[0]! | (f[1]! << 8)));
    const B = new PresenceLink((s) => { bState = JSON.parse(JSON.stringify(s)); }, (f, rel) => (rel ? got.b : got.bu).push(f[0]! | (f[1]! << 8)));
    // big and small frames
    for (let i = 0; i < 60; i++) {
      const size = i % 7 === 0 ? 9000 : 40;
      const f = new Uint8Array(size); f[0] = i & 255; f[1] = i >> 8;
      A.sendReliable(f);
    }
    let now = 0;
    let extra = 150;
    for (let step = 0; step < 6000 && (got.b.length < 60 || extra-- > 0); step++) {
      now += 20;
      if (step % 5 === 0) { const u = new Uint8Array(1200); u[0] = step & 255; u[1] = step >> 8; A.sendUnreliable(u); }
      A.flush(now); B.flush(now);
      // the relay skips intermediate states at random
      if (Math.random() < 0.6 && aState) B.receive(aState);
      if (Math.random() < 0.6 && bState) A.receive(bState);
      expect(JSON.stringify(aState ?? {}).length).toBeLessThanOrEqual(DEFAULT_LINK.maxBytes);
      // the platform bounds every string in presence to 1 KiB
      const st = aState as { r?: string[]; u?: string[] } | null;
      for (const c of [...(st?.r ?? []), ...(st?.u ?? [])]) expect(c.length).toBeLessThanOrEqual(1001);
    }
    expect(got.b).toEqual([...Array(60).keys()]);
    expect(got.bu.length).toBeGreaterThan(10);
    for (let i = 1; i < got.bu.length; i++) expect(got.bu[i]!).toBeGreaterThan(got.bu[i - 1]!);
    expect(A.backlog).toBe(0);
  });

  it('rejects malformed remote state', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState({ e: 'x', a: 0, s: 1, r: ['?abc'], n: 0 })).toBeNull();
    expect(parseState({ e: 'x', a: 0, s: 1, r: ['!<script>'], n: 0 })).toBeNull();
    expect(parseState({ e: 'x', a: 0.5, s: 1, r: [], n: 0 })).toBeNull();
    expect(parseState({ e: 'x', a: 0, s: 1, r: ['!AAAA'], n: 0 })).not.toBeNull();
    expect(parseState({ e: 'x', a: 0, s: 1, r: [], n: 1, u: ['AAAA', 'AA=='] })).not.toBeNull();
    expect(parseState({ e: 'x', a: 0, s: 1, r: [], n: 1, u: 'AAAA' })).toBeNull();
    expect(parseState({ e: 'x', a: 0, s: 1, r: [], n: 1, u: ['AA==', 'AAAA'] })).toBeNull();
    expect(parseState({ e: 'x', a: 0, s: 1, r: ['!' + 'A'.repeat(1200)], n: 0 })).toBeNull();
  });

  it('detects a restarted peer', () => {
    let resets = 0;
    const A = new PresenceLink(() => {}, () => {}, DEFAULT_LINK, () => resets++);
    A.receive({ e: 'one', a: 0, s: 1, r: [], n: 0 });
    A.receive({ e: 'two', a: 0, s: 1, r: [], n: 0 });
    expect(resets).toBe(1);
  });
});

describe('online co-op over the room relay', () => {
  it('4 players (host + 3 relay clients) join, move, act and stay in sync', async () => {
    const { sim, host } = makeHost(3131);
    host.start();
    try {
      const clients = [0, 1, 2, 3].map((i) => connectRelayClient(host, `R${i}`, `relaytoken${i}`, { latencyMs: 50 + i * 20, jitterMs: 40 }));
      const sessions = clients.map((c) => c.session);
      await waitFor(() => sessions.every((s) => s.connected && s.self !== null), 15000, 'relay clients welcomed');
      expect(Object.values(sim.world.players).filter((p) => p.connected).length).toBe(4);
      // a 5th is refused (cap 4)
      const extra = connectRelayClient(host, 'R4', 'relaytoken4');
      let reason = '';
      extra.session.on.reject = (r) => { reason = r; };
      await waitFor(() => /full/i.test(reason), 10000, 'fifth player rejected');

      // everyone walks forward; positions converge with the server
      await run(sessions, 2500, (_c, i) => ({ ...idle, mz: 1, yaw: i * 1.5 }));
      await run(sessions, 1200);
      for (const c of clients) {
        const sp = sim.world.players[c.session.playerId]!.pos;
        const p = c.session.viewPosition();
        expect(Math.hypot(p.x - sp.x, p.z - sp.z)).toBeLessThan(0.6);
      }
      // each sees the others
      await waitFor(() => sessions.every((s) => s.remotePlayers().length === 3), 5000, 'remote players visible');

      // a reliable action round-trips (chat)
      const r = await sessions[2]!.act({ a: 'chat', text: 'hello from the relay' });
      expect(r.ok).toBe(true);
      await waitFor(() => sim.world.players[sessions[2]!.playerId] !== undefined, 1000);

      // bandwidth stays inside the relay budget: every published state under 4 KiB
      for (const c of clients) expect(c.pair.sides[0]!.maxBytes).toBeLessThanOrEqual(4096);
      // and snapshots keep flowing at a useful rate
      const before = sessions[0]!.snapshotsReceived;
      await run(sessions, 2000);
      expect(sessions[0]!.snapshotsReceived - before).toBeGreaterThan(12);

      // a client leaves and the others keep playing
      clients[3]!.session.close();
      await waitFor(() => !sim.world.players[sessions[3]!.playerId]?.connected, 8000, 'leaver removed');
      expect(sessions.slice(0, 3).every((s) => s.connected)).toBe(true);
      for (const c of clients) c.session.close();
    } finally {
      host.stop();
    }
  }, 60000);
});

describe('same account in two tabs', () => {
  it('a second tab of the same account gets its own survivor; a reconnect from the same tab keeps it', async () => {
    const { sim, host } = makeHost(4141);
    const msgs: { id: number; t: string; reason?: string; pid?: string }[] = [];
    const connect = (tag: number) => host.connect((m) => msgs.push({ id: tag, t: m.t, reason: (m as { reason?: string }).reason, pid: (m as { playerId?: string }).playerId }), () => {});
    const hello = (tab: string) => ({ t: 'hello' as const, protocol: PROTOCOL_VERSION, name: 'Ana', token: 'account-token-ana', tab });
    const a = connect(1);
    host.handle(a, hello('tab-one'));
    const b = connect(2);
    host.handle(b, hello('tab-two'));
    const pidA = a.playerId, pidB = b.playerId;
    expect(pidA).toBeTruthy();
    expect(pidB).toBeTruthy();
    expect(pidB).not.toBe(pidA);
    expect(host.peers.has(a.id)).toBe(true); // the first tab was not kicked
    expect(Object.values(sim.world.players).filter((p) => p.connected).length).toBe(2);
    // the second tab drops and reconnects from the same page: same survivor, stale link replaced
    const b2 = connect(3);
    host.handle(b2, hello('tab-two'));
    expect(b2.playerId).toBe(pidB);
    expect(host.peers.has(b.id)).toBe(false);
    expect(host.peers.has(a.id)).toBe(true);
    // once the second tab is gone, it comes back as the same second survivor
    host.disconnect(b2, 'left');
    const b3 = connect(4);
    host.handle(b3, hello('tab-two'));
    expect(b3.playerId).toBe(pidB);
    expect(a.playerId).toBe(pidA);
  });

  it('the host player never times out while its tab is hidden', () => {
    let now = 0;
    const { sim } = makeHost(4242);
    const host = new GameHost(sim, { log: () => {}, now: () => now });
    const local = host.connect(() => {}, () => {});
    local.noTimeout = true;
    host.handle(local, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Host', token: 'host-token-123', tab: 'h' });
    const remote = host.connect(() => {}, () => {});
    host.handle(remote, { t: 'hello', protocol: PROTOCOL_VERSION, name: 'Guest', token: 'guest-token-123', tab: 'g' });
    now = 60_000;
    host.step();
    expect(host.peers.has(local.id)).toBe(true);
    expect(host.peers.has(remote.id)).toBe(false);
  });
});
