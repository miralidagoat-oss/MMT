/**
 * Transport-agnostic authoritative game host. Owns a Simulation, a set of peers
 * (each with a `send` function), runs the fixed tick and fans out replication.
 * Used by the Node dedicated/listen server AND the single-player web worker.
 */
import { SIM, PROTOCOL_VERSION, NET } from '../config';
import { Simulation } from '../sim/simulation';
import type { ClientMsg, ServerMsg, FxEvent } from './protocol';
import { buildSnapshot, buildWelcome, buildSharedDelta, dirtyPlayers, privateOf, roster, newSnapshotCache, type SnapshotCache } from './replication';

export interface Peer {
  id: number;
  playerId: string | null;
  send: (msg: ServerMsg) => void;
  close: (reason: string) => void;
  lastSeen: number;
  bytesOut: number;
  snapCache: SnapshotCache;
}

export interface HostOptions {
  log?: (m: string) => void;
  onSaveRequest?: () => Promise<boolean>;
  maxPlayers?: number;
  now?: () => number;
}

export class GameHost {
  peers = new Map<number, Peer>();
  private nextPeer = 1;
  private log: (m: string) => void;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private accumulator = 0;
  private lastTime = 0;
  stats = { ticks: 0, tickMsTotal: 0, tickMsMax: 0, bytesOut: 0 };

  constructor(public sim: Simulation, private opts: HostOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => performance.now());
  }

  connect(send: (msg: ServerMsg) => void, close: (reason: string) => void): Peer {
    const peer: Peer = { id: this.nextPeer++, playerId: null, send, close, lastSeen: this.now(), bytesOut: 0, snapCache: newSnapshotCache() };
    this.peers.set(peer.id, peer);
    return peer;
  }

  disconnect(peer: Peer, reason = 'disconnected'): void {
    if (!this.peers.has(peer.id)) return;
    this.peers.delete(peer.id);
    if (peer.playerId) {
      // only remove the player if no other peer is bound to it (reconnect race)
      const still = [...this.peers.values()].some((p) => p.playerId === peer.playerId);
      if (!still) this.sim.removePlayer(peer.playerId);
    }
    this.log(`peer ${peer.id} ${reason}`);
    this.broadcast({ t: 'roster', list: roster(this.sim) });
  }

  handle(peer: Peer, msg: ClientMsg): void {
    peer.lastSeen = this.now();
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        if (msg.protocol !== PROTOCOL_VERSION) { peer.send({ t: 'reject', reason: `Version mismatch (server ${PROTOCOL_VERSION}, client ${msg.protocol})` }); peer.close('version'); return; }
        const token = String(msg.token ?? '').slice(0, 64);
        if (token.length < 8) { peer.send({ t: 'reject', reason: 'Bad identity token' }); peer.close('token'); return; }
        const online = Object.values(this.sim.world.players).filter((p) => p.connected);
        const pid = 'p' + hashTok(token);
        const already = online.find((p) => p.id === pid);
        if (!already && online.length >= (this.opts.maxPlayers ?? SIM.maxPlayers)) { peer.send({ t: 'reject', reason: 'Server is full' }); peer.close('full'); return; }
        if (already) {
          // a stale connection for the same identity: drop it (reconnect)
          for (const other of this.peers.values()) if (other !== peer && other.playerId === pid) { other.playerId = null; this.peers.delete(other.id); other.close('replaced'); }
        }
        const p = this.sim.addPlayer(token, String(msg.name ?? 'Survivor'), msg.color);
        peer.playerId = p.id;
        peer.snapCache = newSnapshotCache();
        peer.send(buildWelcome(this.sim, p.id));
        this.broadcast({ t: 'roster', list: roster(this.sim) });
        return;
      }
      case 'ping': peer.send({ t: 'pong', c: msg.c, s: this.sim.world.time }); return;
      case 'bye': this.disconnect(peer, 'left'); peer.close('bye'); return;
    }
    if (!peer.playerId) return;
    switch (msg.t) {
      case 'input': this.sim.queueInputs(peer.playerId, msg.frames); break;
      case 'act': if (Number.isFinite(msg.id)) this.sim.submitAction(peer.playerId, msg.id, msg.action); break;
      case 'save':
        if (this.opts.onSaveRequest) this.opts.onSaveRequest().then((ok) => peer.send({ t: 'saved', ok, at: Date.now() })).catch(() => peer.send({ t: 'saved', ok: false, at: Date.now() }));
        break;
    }
  }

  broadcast(msg: ServerMsg): void {
    for (const p of this.peers.values()) if (p.playerId) p.send(msg);
  }

  /** Run one authoritative tick and replicate. */
  step(): void {
    const t0 = this.now();
    const out = this.sim.tick();
    // reliable deltas
    const shared = buildSharedDelta(this.sim, out);
    const dirty = new Set(dirtyPlayers(out));
    for (const peer of this.peers.values()) {
      if (!peer.playerId) continue;
      const pid = peer.playerId;
      const me = dirty.has(pid) ? this.sim.world.players[pid] : undefined;
      if (shared || me) peer.send({ ...(shared ?? { t: 'delta' }), ...(me ? { me: privateOf(me) } : {}) });
    }
    // per-player results / notifications / fx
    for (const r of out.results) {
      for (const peer of this.peers.values()) if (peer.playerId === r.to) peer.send({ t: 'result', id: r.id, ok: r.ok, reason: r.reason });
    }
    for (const n of out.notify) {
      for (const peer of this.peers.values()) if (peer.playerId && (n.to === null || n.to === peer.playerId)) peer.send({ t: 'notify', text: n.text, level: n.level });
    }
    for (const c of out.chat) this.broadcast({ t: 'chat', from: c.from, name: c.name, text: c.text });
    if (out.roster) this.broadcast({ t: 'roster', list: roster(this.sim) });
    if (out.fx.length) {
      for (const peer of this.peers.values()) {
        const me = peer.playerId ? this.sim.world.players[peer.playerId] : undefined;
        if (!me) continue;
        const list: FxEvent[] = out.fx.filter((f) => f.k === 'lightning' || f.k === 'rescue' || f.p === me.id || (f.x - me.pos.x) ** 2 + (f.z - me.pos.z) ** 2 < 120 * 120);
        if (list.length) peer.send({ t: 'fx', list });
      }
    }
    // snapshots
    const every = Math.max(1, Math.round(SIM.tickRate / SIM.snapshotRate));
    if (this.sim.world.tick % every === 0) {
      for (const peer of this.peers.values()) if (peer.playerId) peer.send(buildSnapshot(this.sim, peer.playerId, peer.snapCache));
    }
    // timeouts
    const now = this.now();
    for (const peer of [...this.peers.values()]) {
      if (now - peer.lastSeen > NET.timeoutMs) { this.disconnect(peer, 'timed out'); peer.close('timeout'); }
    }
    const ms = this.now() - t0;
    this.stats.ticks++;
    this.stats.tickMsTotal += ms;
    this.stats.tickMsMax = Math.max(this.stats.tickMsMax, ms);
  }

  /** Real-time fixed-step loop driver. */
  start(): void {
    if (this.timer) return;
    this.lastTime = this.now();
    const stepMs = 1000 / SIM.tickRate;
    this.timer = setInterval(() => {
      const t = this.now();
      this.accumulator += t - this.lastTime;
      this.lastTime = t;
      let n = 0;
      while (this.accumulator >= stepMs && n < 5) { this.step(); this.accumulator -= stepMs; n++; }
      if (this.accumulator > stepMs * 5) this.accumulator = 0; // drop time after long stalls instead of spiralling
    }, Math.floor(stepMs / 2));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function hashTok(token: string): string {
  // must match Simulation.addPlayer id derivation
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
