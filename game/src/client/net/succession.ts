/**
 * Keeping a co-op world alive when its host's page closes without warning.
 *
 * While friends play, the host streams a compressed copy of the world to each of
 * them in the background (a rolling backup, refreshed about every half minute,
 * paced so it never crowds out gameplay traffic). It also tells every friend the
 * takeover order: the players holding a complete backup, earliest joiner first.
 *
 * When the host vanishes, the first in that order reopens the world from its
 * backup under the same game code and everyone else reconnects to it. Before
 * taking over, a friend checks the lobby: if the old host is still advertising
 * (and its ad is still being refreshed), the friend's own connection was the
 * problem and it simply reconnects. Every hosting carries a generation number,
 * so a host that comes back after being replaced sees the newer one and yields.
 */
import type { PresenceLink } from '../../shared/net/presence-link';
import type { RelayMsg } from '../../shared/net/protocol';
import { encode } from '../../shared/net/codec';

/** raw bytes per backup part (with the message header it fills two relay chunks) */
export const BACKUP_PART = 1380;
/** biggest backup accepted (compressed) */
export const MAX_BACKUP_BYTES = 32 << 20;
/** reliable chunks a backup may keep in flight; gameplay messages share the same lane */
const MAX_IN_FLIGHT = 4;
/** time between backups while friends are playing */
export const BACKUP_INTERVAL_MS = 30000;
/** each further place in the takeover order waits this much longer before taking over */
export const TAKEOVER_STAGGER_MS = 30000;

export interface FriendLink { send(frame: Uint8Array, snap: boolean): void; readonly link: PresenceLink; readonly ended: boolean }

/** Streams one backup to one friend over the reliable lane, a few chunks at a time. */
export class BackupSender {
  readonly parts: number;
  private next = 0;
  private endSeq = -1;
  state: 'sending' | 'done' | 'failed' = 'sending';

  constructor(private friend: FriendLink, readonly id: number, private data: Uint8Array, private gz: boolean) {
    this.parts = Math.max(1, Math.ceil(data.length / BACKUP_PART));
  }

  /** Queue more parts when the lane has room; reports progress. */
  pump(): 'sending' | 'done' | 'failed' {
    if (this.state !== 'sending') return this.state;
    const lk = this.friend.link;
    if (this.friend.ended || lk.broken) return (this.state = 'failed');
    while (this.next < this.parts && lk.sentSeq - lk.ackedSeq < MAX_IN_FLIGHT) {
      const d = this.data.slice(this.next * BACKUP_PART, (this.next + 1) * BACKUP_PART);
      const msg: RelayMsg = { t: 'backup', id: this.id, i: this.next, n: this.parts, gz: this.gz, d };
      this.friend.send(encode(msg), false);
      this.next++;
      if (this.next === this.parts) this.endSeq = lk.sentSeq;
    }
    // delivered once the friend acknowledged the chunk carrying the last part
    if (this.next === this.parts && lk.ackedSeq >= this.endSeq) this.state = 'done';
    return this.state;
  }
}

export interface Backup { id: number; data: Uint8Array; gz: boolean; at: number }

/** Friend side: assembles backup parts; keeps the latest complete backup. */
export class BackupReceiver {
  latest: Backup | null = null;
  private cur: { id: number; n: number; gz: boolean; parts: (Uint8Array | null)[]; got: number; bytes: number } | null = null;

  /** Feed one part (untrusted). Returns true when it completed a backup. */
  receive(m: { id?: unknown; i?: unknown; n?: unknown; gz?: unknown; d?: unknown }): boolean {
    const id = Number(m.id), i = Number(m.i), n = Number(m.n);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(i) || !Number.isSafeInteger(n)) return false;
    if (n < 1 || n > Math.ceil(MAX_BACKUP_BYTES / BACKUP_PART) || i < 0 || i >= n) return false;
    if (!(m.d instanceof Uint8Array) || m.d.length > BACKUP_PART || (i < n - 1 && m.d.length !== BACKUP_PART)) return false;
    if (!this.cur || this.cur.id !== id || this.cur.n !== n) this.cur = { id, n, gz: m.gz === true, parts: new Array(n).fill(null), got: 0, bytes: 0 };
    const c = this.cur;
    if (c.parts[i]) return false;
    c.parts[i] = m.d.slice();
    c.got++;
    c.bytes += m.d.length;
    if (c.got < c.n) return false;
    const data = new Uint8Array(c.bytes);
    let o = 0;
    for (const p of c.parts) { data.set(p!, o); o += p!.length; }
    this.latest = { id, data, gz: c.gz, at: Date.now() };
    this.cur = null;
    return true;
  }

  /** forget a half-received backup (a new host numbers its backups afresh) */
  dropPartial() { this.cur = null; }
  reset() { this.latest = null; this.cur = null; }
}

/** What a friend knows about the takeover order of the game it plays in. */
export type SuccessionInfo = Extract<RelayMsg, { t: 'succession' }>;

interface FriendState { link: FriendLink; name: string | null; ready: boolean; sender: BackupSender | null; told: string }

/**
 * Host side: one per hosted co-op world. Runs backup cycles to every friend and
 * keeps each of them told the takeover order.
 */
export class HostSuccession {
  private friends = new Map<number, FriendState>();
  private phase: 'idle' | 'fetching' | 'sending' = 'idle';
  private cycleAt: number;
  private cycleStarted = 0;
  private soon = false;
  private nextId = (Math.random() * 0x3fffffff) | 0;
  lastBackupAt = 0;
  lastBackupBytes = 0;

  constructor(private o: {
    code: string; gen: number; host: () => string;
    /** the world, serialized and (if possible) compressed */
    getBackup: () => Promise<{ data: Uint8Array; gz: boolean } | null>;
    intervalMs?: number; now?: () => number;
  }) {
    this.cycleAt = this.now() + 3000;
  }

  private now() { return this.o.now ? this.o.now() : performance.now(); }
  get gen() { return this.o.gen; }

  add(id: number, link: FriendLink) { this.friends.set(id, { link, name: null, ready: false, sender: null, told: '' }); }

  /** the friend's player joined the world (its name is known) */
  named(id: number, name: string) {
    const f = this.friends.get(id);
    if (!f) return;
    f.name = name.slice(0, 24) || 'Castaway';
    // a newcomer should get a copy soon
    if (this.phase === 'idle') this.cycleAt = Math.min(this.cycleAt, this.now() + 3000);
    else this.soon = true;
    this.tell();
  }

  remove(id: number) {
    if (!this.friends.delete(id)) return;
    this.tell();
  }

  /** takeover order: friends holding a complete backup, earliest joiner first */
  private ranked(): number[] {
    return [...this.friends.entries()].filter(([, f]) => f.ready && f.name && !f.link.ended).map(([id]) => id).sort((a, b) => a - b);
  }

  /** names in takeover order */
  order(): string[] { return this.ranked().map((id) => this.friends.get(id)!.name!); }

  tick() {
    const now = this.now();
    let active = 0;
    for (const f of this.friends.values()) {
      if (!f.sender) continue;
      const st = f.sender.pump();
      if (st === 'done') { f.sender = null; f.ready = true; this.tell(); }
      else if (st === 'failed') f.sender = null;
      else active++;
    }
    if (this.phase === 'sending' && (!active || now - this.cycleStarted > 90000)) {
      for (const f of this.friends.values()) f.sender = null;
      this.phase = 'idle';
      this.cycleAt = now + (this.soon ? 3000 : this.o.intervalMs ?? BACKUP_INTERVAL_MS);
      this.soon = false;
    }
    if (this.phase === 'idle' && now >= this.cycleAt && [...this.friends.values()].some((f) => f.name && !f.link.ended)) {
      this.phase = 'fetching';
      this.o.getBackup().then((b) => {
        if (this.phase !== 'fetching') return;
        if (!b || b.data.length > MAX_BACKUP_BYTES) { this.phase = 'idle'; this.cycleAt = this.now() + 10000; return; }
        const id = (this.nextId = (this.nextId + 1) & 0x3fffffff);
        for (const f of this.friends.values()) if (f.name && !f.link.ended) f.sender = new BackupSender(f.link, id, b.data, b.gz);
        this.phase = 'sending';
        this.cycleStarted = this.now();
        this.lastBackupAt = Date.now();
        this.lastBackupBytes = b.data.length;
      }, () => { this.phase = 'idle'; this.cycleAt = this.now() + 10000; });
    }
  }

  /** Send each friend its place in the takeover order whenever that changes. */
  private tell() {
    const ids = this.ranked();
    const names = ids.map((id) => this.friends.get(id)!.name!);
    for (const [id, f] of this.friends) {
      if (!f.name || f.link.ended) continue;
      // by player, not by name: two friends may share a name
      const rank = ids.indexOf(id);
      const msg: RelayMsg = { t: 'succession', code: this.o.code, gen: this.o.gen, rank: rank >= 0 ? rank : null, names, host: this.o.host() };
      const key = JSON.stringify(msg);
      if (key === f.told) continue;
      f.told = key;
      f.link.send(encode(msg), false);
    }
  }

  /** stop all transfers (the world is closing or being handed over) */
  dispose() { for (const f of this.friends.values()) f.sender = null; this.friends.clear(); this.phase = 'idle'; }
}

/** An ad in the lobby, as the takeover check sees it. */
export interface AdSeen { code: string; gen: number; beat: number; peer: string; mine: boolean }

export type HostVerdict =
  /** someone already took the world over (or is loading it): join them */
  | 'taken'
  /** the old host is still there: our own connection was the problem, reconnect */
  | 'alive'
  /** nobody hosts the game any more: take it over */
  | 'free';

/**
 * Decide what to do after losing the host of game `code` (generation `lostGen`).
 * `gone`: the host itself said its page was closing. `ads()` reads the lobby;
 * `connected()` says whether our own lobby connection is up.
 */
export async function checkHost(o: {
  code: string; lostGen: number; gone: boolean;
  ads: () => AdSeen[]; connected: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** how long an ad must stay unrefreshed to count as a leftover */
  staleMs?: number;
}): Promise<HostVerdict> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // our own lobby connection must be up, or the lobby's view means nothing
  for (let i = 0; i < 60 && !o.connected(); i++) await sleep(500);
  if (!o.connected()) return 'alive';
  await sleep(800); // let the peer list settle after a reconnect
  const mine = () => o.ads().filter((a) => a.code === o.code && !a.mine);
  if (mine().some((a) => a.gen > o.lostGen)) return 'taken';
  const old = mine().find((a) => a.gen === o.lostGen);
  if (!old || o.gone) return 'free';
  // an ad from the old host is still listed: it counts only if the host keeps refreshing it
  const until = (o.staleMs ?? 10000) / 500;
  for (let i = 0; i < until; i++) {
    await sleep(500);
    const now = mine();
    if (now.some((a) => a.gen > o.lostGen)) return 'taken';
    const same = now.find((a) => a.peer === old.peer && a.gen === o.lostGen);
    if (!same) return 'free';
    if (same.beat !== old.beat) return 'alive';
  }
  return 'free';
}
