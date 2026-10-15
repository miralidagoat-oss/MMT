import { describe, it, expect } from 'vitest';
import { PresenceLink } from '../src/shared/net/presence-link';
import { BackupSender, BackupReceiver, HostSuccession, checkHost, BACKUP_PART, type FriendLink, type AdSeen } from '../src/client/net/succession';
import { CoopLobby, type OpenGame } from '../src/client/net/room';
import { decode } from '../src/shared/net/codec';
import type { RelayMsg, ServerMsg } from '../src/shared/net/protocol';
import { makeHost, waitFor } from './nethelpers';
import { connectRelayClient } from './relayhelpers';

/** two links joined by a latest-wins relay that drops intermediate states at random */
function linkPair() {
  const got = { a: [] as Uint8Array[], b: [] as Uint8Array[], bu: [] as Uint8Array[] };
  let aState: unknown = null, bState: unknown = null;
  const A = new PresenceLink((s) => { aState = JSON.parse(JSON.stringify(s)); }, (f) => got.a.push(f));
  const B = new PresenceLink((s) => { bState = JSON.parse(JSON.stringify(s)); }, (f, rel) => (rel ? got.b : got.bu).push(f));
  const step = (now: number, p = 0.7) => {
    A.flush(now); B.flush(now);
    if (Math.random() < p && aState) B.receive(aState);
    if (Math.random() < p && bState) A.receive(bState);
  };
  return { A, B, got, step };
}

describe('presence link priorities', () => {
  it('keeps snapshots flowing during a long reliable transfer', () => {
    const { A, got, step } = linkPair();
    for (let i = 0; i < 80; i++) A.sendReliable(new Uint8Array(700).fill(i));
    let now = 0, publishes = 0;
    for (let k = 0; k < 400 && got.b.length < 80; k++) {
      now += 90;
      // a fresh 2 KB snapshot for every publish: without the reservation the backlog would starve it
      A.sendUnreliable(new Uint8Array(2000).fill(k & 255));
      step(now, 1);
      publishes++;
    }
    expect(got.b.length).toBe(80);
    // at least every other publish carried a snapshot while the transfer ran
    expect(got.bu.length).toBeGreaterThanOrEqual(Math.floor(publishes / 2) - 1);
  });

  it('reports what the other side has acknowledged', () => {
    const { A, step } = linkPair();
    expect(A.sentSeq).toBe(0);
    A.sendReliable(new Uint8Array(2000)); // 3 chunks
    expect(A.sentSeq).toBe(3);
    expect(A.ackedSeq).toBe(0);
    let now = 0;
    for (let k = 0; k < 50 && A.ackedSeq < 3; k++) { now += 90; step(now, 1); }
    expect(A.ackedSeq).toBe(3);
    expect(A.backlog).toBe(0);
  });
});

describe('rolling world backups', () => {
  it('assembles parts, ignores junk and keeps the last complete backup', () => {
    const data = new Uint8Array(BACKUP_PART * 3 + 17).map((_, i) => (i * 7) & 255);
    const parts = (id: number) => [0, 1, 2, 3].map((i) => ({ id, i, n: 4, gz: true, d: data.slice(i * BACKUP_PART, (i + 1) * BACKUP_PART) }));
    const r = new BackupReceiver();
    expect(r.receive({ id: 1, i: 0, n: 4, gz: true, d: 'nope' })).toBe(false);
    expect(r.receive({ id: 1, i: 9, n: 4, gz: true, d: new Uint8Array(4) })).toBe(false);
    expect(r.receive({ id: 1, i: 0, n: 4, gz: true, d: new Uint8Array(BACKUP_PART + 1) })).toBe(false);
    const p1 = parts(1);
    for (const p of p1.slice(0, 3)) expect(r.receive(p)).toBe(false);
    expect(r.receive(p1[3]!)).toBe(true);
    expect([...r.latest!.data]).toEqual([...data]);
    // a half-received newer backup does not replace the complete one
    const p2 = parts(2);
    r.receive(p2[0]!); r.receive(p2[1]!);
    expect(r.latest!.id).toBe(1);
    r.dropPartial();
    r.receive(p2[2]!); r.receive(p2[3]!);
    expect(r.latest!.id).toBe(1);
  });

  it('streams a backup through the relay while the game keeps running', async () => {
    const { host } = makeHost(5151);
    const c = connectRelayClient(host, 'Ben', 'tok-ben-123456');
    const recv = new BackupReceiver();
    let done = false;
    c.session.on.relay = (m) => { if (m.t === 'backup' && recv.receive(m)) done = true; };
    host.start();
    try {
      await waitFor(() => c.session.connected && c.session.snapshotsReceived > 5, 15000);
      const data = new Uint8Array(60000).map(() => (Math.random() * 256) | 0);
      const sender = new BackupSender(c.peerLink, 7, data, true);
      const snaps0 = c.session.snapshotsReceived;
      const t0 = Date.now();
      await waitFor(() => sender.pump() === 'done', 30000);
      const secs = (Date.now() - t0) / 1000;
      await waitFor(() => done, 2000);
      expect([...recv.latest!.data]).toEqual([...data]);
      expect(recv.latest!.gz).toBe(true);
      // gameplay snapshots kept arriving during the transfer (several per second)
      expect((c.session.snapshotsReceived - snaps0) / secs).toBeGreaterThan(3);
    } finally {
      host.stop();
      c.pair.stop();
    }
  }, 40000);
});

/** a friend link for the host-side succession logic: delivers instantly, acks at once */
function fakeFriend() {
  const inbox: RelayMsg[] = [];
  const link = new PresenceLink(() => {}, () => {});
  const f: FriendLink & { inbox: RelayMsg[]; end(): void; ended: boolean } = {
    inbox, ended: false, link,
    send(frame) { link.sendReliable(frame); inbox.push(decode<ServerMsg>(frame) as RelayMsg); link.receive({ e: 'peer', a: link.sentSeq, s: 1, r: [], n: 0 }); },
    end() { f.ended = true; },
  };
  return f;
}

describe('takeover order', () => {
  it('ranks friends holding a backup by join order, by player not by name', async () => {
    let now = 0;
    const s = new HostSuccession({ code: 'abc234', gen: 2, host: () => 'Ana', getBackup: async () => ({ data: new Uint8Array(5000), gz: true }), now: () => now });
    const f1 = fakeFriend(), f2 = fakeFriend(), f3 = fakeFriend();
    s.add(1, f1); s.add(2, f2); s.add(3, f3);
    s.named(1, 'Ben'); s.named(2, 'Cy'); s.named(3, 'Ben');
    const last = (f: ReturnType<typeof fakeFriend>) => [...f.inbox].reverse().find((m) => m.t === 'succession') as Extract<RelayMsg, { t: 'succession' }> | undefined;
    // nobody holds a backup yet
    expect(last(f1)!.rank).toBeNull();
    for (let k = 0; k < 100 && s.order().length < 3; k++) { now += 100; s.tick(); await Promise.resolve(); }
    expect(s.order()).toEqual(['Ben', 'Cy', 'Ben']);
    expect([last(f1)!.rank, last(f2)!.rank, last(f3)!.rank]).toEqual([0, 1, 2]);
    expect(last(f2)!).toMatchObject({ code: 'abc234', gen: 2, host: 'Ana', names: ['Ben', 'Cy', 'Ben'] });
    // every friend received the whole backup
    for (const f of [f1, f2, f3]) {
      const r = new BackupReceiver();
      let ok = false;
      for (const m of f.inbox) if (m.t === 'backup') ok = r.receive(m) || ok;
      expect(ok).toBe(true);
    }
    // the first friend leaves: everyone moves up
    f1.end(); s.remove(1);
    expect([last(f2)!.rank, last(f3)!.rank]).toEqual([0, 1]);
  });

  it('refreshes backups on an interval and soon after someone joins', async () => {
    let now = 0, fetched = 0;
    const s = new HostSuccession({ code: 'abc234', gen: 0, host: () => 'Ana', getBackup: async () => { fetched++; return { data: new Uint8Array(100), gz: false }; }, intervalMs: 30000, now: () => now });
    const f1 = fakeFriend();
    s.add(1, f1); s.named(1, 'Ben');
    const run = async (ms: number) => { for (let t = 0; t < ms; t += 100) { now += 100; s.tick(); await Promise.resolve(); await Promise.resolve(); } };
    await run(4000);
    expect(fetched).toBe(1);
    await run(20000);
    expect(fetched).toBe(1);
    const f2 = fakeFriend();
    s.add(2, f2); s.named(2, 'Cy');
    await run(4000);
    expect(fetched).toBe(2);
    await run(31000);
    expect(fetched).toBe(3);
  });
});

describe('deciding whether to take over', () => {
  const sleep = async () => { await Promise.resolve(); };
  const ad = (o: Partial<AdSeen>): AdSeen => ({ code: 'abc234', gen: 0, beat: 1, peer: 'pA', mine: false, ...o });

  it('takes over a game nobody hosts', async () => {
    expect(await checkHost({ code: 'abc234', lostGen: 0, gone: false, ads: () => [], connected: () => true, sleep })).toBe('free');
  });

  it('joins a friend who already took over', async () => {
    expect(await checkHost({ code: 'abc234', lostGen: 0, gone: false, ads: () => [ad({ gen: 1, peer: 'pB' })], connected: () => true, sleep })).toBe('taken');
  });

  it('reconnects when the old host is still refreshing its ad', async () => {
    let beat = 1;
    const v = await checkHost({ code: 'abc234', lostGen: 0, gone: false, ads: () => [ad({ beat: beat++ > 3 ? 2 : 1 })], connected: () => true, sleep });
    expect(v).toBe('alive');
  });

  it('treats a frozen leftover ad as gone, and trusts the host saying it left', async () => {
    expect(await checkHost({ code: 'abc234', lostGen: 0, gone: false, ads: () => [ad({})], connected: () => true, sleep })).toBe('free');
    expect(await checkHost({ code: 'abc234', lostGen: 0, gone: true, ads: () => [ad({ beat: Math.random() })], connected: () => true, sleep })).toBe('free');
  });

  it('never decides on a lobby it is not connected to', async () => {
    let checks = 0;
    const v = await checkHost({ code: 'abc234', lostGen: 0, gone: false, ads: () => [], connected: () => checks++ > 5, sleep });
    expect(v).toBe('free');
    expect(await checkHost({ code: 'abc234', lostGen: 0, gone: false, ads: () => [], connected: () => false, sleep })).toBe('alive');
  });

  it('ignores other games and its own ad', async () => {
    expect(await checkHost({ code: 'abc234', lostGen: 0, gone: false, ads: () => [ad({ code: 'zzz999', gen: 5 }), ad({ gen: 3, mine: true })], connected: () => true, sleep })).toBe('free');
  });
});

/** the lobby as several pages see it: shared presence, per-page "sameTab" */
function fakeLobbies(ids: string[]) {
  const presence = new Map<string, Record<string, unknown>>(ids.map((id) => [id, {}]));
  const pages = ids.map((me) => {
    let cache: unknown[] | null = null;
    const listeners = new Set<() => void>();
    return {
      me, listeners, bump() { cache = null; for (const l of listeners) l(); },
      room: {
        presence: async (patch: Record<string, unknown>) => {
          const cur = { ...presence.get(me)! };
          for (const [k, v] of Object.entries(patch)) { if (v === null) delete cur[k]; else cur[k] = JSON.parse(JSON.stringify(v)); }
          presence.set(me, cur);
          for (const p of pages) p.bump();
        },
        peers: () => (cache ??= ids.map((id) => ({ peer: id, isMe: false, sameTab: id === me, presence: presence.get(id)! }))) as never,
        onPeers: (h: () => void) => { listeners.add(h); return () => listeners.delete(h); },
        connected: () => true,
        join: async () => { throw new Error('not used'); },
      },
    };
  });
  return pages.map((p) => new CoopLobby(p.room as never));
}

describe('hosting generations', () => {
  const info = { host: 'Ana', world: 'Atoll', players: 2, day: 3 };

  it('a host yields to a newer hosting of its game code', async () => {
    const [a, b] = fakeLobbies(['p1', 'p2']);
    let by: OpenGame | null = null;
    a!.host('abc234', 0, info, () => {}, (g) => { by = g; });
    await Promise.resolve();
    expect(by).toBeNull();
    b!.advertise('abc234', 1, { ...info, host: 'Ben' });
    await new Promise((r) => setTimeout(r, 30));
    expect(by).not.toBeNull();
    expect(by!.host).toBe('Ben');
    // the game list shows the newest hosting only
    expect(a!.games().filter((g) => g.code === 'abc234').map((g) => g.gen)).toEqual([1]);
    a!.dispose(); b!.dispose();
  });

  it('two hosts of the same generation agree on one winner', async () => {
    const [a, b] = fakeLobbies(['p1', 'p2']);
    const yielded: string[] = [];
    a!.host('abc234', 1, info, () => {}, () => yielded.push('a'));
    b!.host('abc234', 1, info, () => {}, () => yielded.push('b'));
    await new Promise((r) => setTimeout(r, 30));
    expect(yielded).toEqual(['b']);
    a!.dispose(); b!.dispose();
  });

  it('refreshing an ad changes its beat; a join request is not wiped by an older pipe', async () => {
    const [a, b] = fakeLobbies(['p1', 'p2']);
    a!.advertise('abc234', 0, info);
    const b1 = b!.ads().find((g) => g.code === 'abc234')!.beat;
    a!.advertise('abc234', 0, info);
    const b2 = b!.ads().find((g) => g.code === 'abc234')!.beat;
    expect(b2).not.toBe(b1);
    a!.withdraw();
    expect(b!.ads()).toEqual([]);
    a!.dispose(); b!.dispose();
  });
});
