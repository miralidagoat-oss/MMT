/**
 * Online co-op for the hosted web build, carried by the page's live "room"
 * channel (`claude.use('room')`). The lobby lists open games through presence;
 * each joining player and the host share a private named room whose presence
 * carries a PresenceLink (see shared/net/presence-link.ts).
 *
 * Everything heard here is untrusted: ads are validated and clamped, link state
 * is parsed defensively, and the host binds each private room to the first peer
 * that announced itself, ignoring anyone else who wanders in.
 */
import type { LinkState } from '../../shared/net/presence-link';
import type { PresencePipe } from './relay';
import { PROTOCOL_VERSION, SIM } from '../../shared/config';

// Minimal structural types for the platform API (only what we use).
interface Peer { peer: string; isMe: boolean; sameTab: boolean; presence: Readonly<Record<string, unknown>> }
interface PeersChange { peers: readonly Peer[]; joined: readonly Peer[]; left: readonly Peer[] }
interface RoomLike {
  presence(patch: Record<string, unknown>): Promise<void>;
  peers(): readonly Peer[];
  onPeers(h: (c: PeersChange) => void, onError?: (e: { code: string; message: string }) => void): () => void;
  connected(): boolean;
}
interface NamedRoom extends RoomLike { readonly name: string; leave(): Promise<void> }
interface LobbyRoom extends RoomLike { join(name: string): Promise<NamedRoom> }

interface ClaudeHost { use(name: string): Promise<unknown> }

export function claudeHost(): ClaudeHost | null {
  const c = (window as unknown as { claude?: ClaudeHost }).claude;
  return c && typeof c.use === 'function' ? c : null;
}

/** True when running as the hosted web page (inside the claude.ai viewer). */
export function isHostedPage(): boolean { return claudeHost() !== null; }

let roomPromise: Promise<LobbyRoom | null> | null = null;
export function getRoom(): Promise<LobbyRoom | null> {
  if (!roomPromise) {
    const c = claudeHost();
    roomPromise = c ? c.use('room').then((r) => (r as LobbyRoom | null) ?? null).catch(() => null) : Promise.resolve(null);
  }
  return roomPromise;
}

export interface GameAd { v: number; code: string; host: string; world: string; players: number; max: number; day: number }
export interface OpenGame extends GameAd { peer: string; mine: boolean }

const CODE_RE = /^[a-z0-9]{6}$/;
const RID_RE = /^[a-z0-9]{8}$/;
const clean = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯]/g, '').slice(0, n);
export const randomId = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

function readAd(p: Peer): OpenGame | null {
  const tw = p.presence?.tw as Record<string, unknown> | undefined;
  const ad = tw?.ad as Record<string, unknown> | undefined;
  if (!ad || typeof ad !== 'object' || typeof ad.code !== 'string' || !CODE_RE.test(ad.code)) return null;
  return {
    v: Number(ad.v) | 0, code: ad.code, host: clean(ad.host, 24) || 'Castaway', world: clean(ad.world, 40) || 'Island',
    players: Math.max(0, Math.min(SIM.maxPlayers, Number(ad.players) | 0)), max: SIM.maxPlayers, day: Math.max(0, Number(ad.day) | 0),
    peer: p.peer, mine: p.isMe && p.sameTab,
  };
}

/** Watches the room's peers without depending on animation frames (a host's tab may be throttled). */
function watchPeers(room: RoomLike, fn: (peers: readonly Peer[]) => void, onError?: (code: string) => void): () => void {
  let last: readonly Peer[] | null = null;
  const check = () => { const ps = room.peers(); if (ps !== last) { last = ps; fn(ps); } };
  const off = room.onPeers(() => check(), (e) => onError?.(e.code));
  const timer = setInterval(check, 25);
  return () => { off(); clearInterval(timer); };
}

/** One side of a private two-party room. */
class RoomPipe implements PresencePipe {
  private remoteCb: (s: unknown) => void = () => {};
  private goneCb: (r: string) => void = () => {};
  private bound: string | null;
  private lastPresence: unknown = null;
  private missingSince = 0;
  private stop: () => void;
  private closed = false;

  constructor(private room: NamedRoom, expectPeer: string | null) {
    this.bound = expectPeer;
    this.stop = watchPeers(room, (peers) => this.onPeers(peers), (code) => this.gone(code === 'revoked' ? 'Access to the game page was withdrawn' : 'The connection to the game room was lost'));
  }

  private onPeers(peers: readonly Peer[]) {
    const others = peers.filter((p) => !p.sameTab && !p.isMe);
    if (!this.bound) {
      // bind to the first peer that publishes link state
      const first = others.find((p) => p.presence && typeof p.presence.l === 'object');
      if (!first) return;
      this.bound = first.peer;
    }
    const peer = others.find((p) => p.peer === this.bound);
    if (!peer) {
      if (!this.missingSince) this.missingSince = performance.now();
      return;
    }
    this.missingSince = 0;
    const l = peer.presence?.l;
    if (l && l !== this.lastPresence) { this.lastPresence = l; this.remoteCb(l); }
  }

  /** called periodically by the owner: a bound peer missing for a while has left */
  checkGone(graceMs: number) {
    if (this.missingSince && performance.now() - this.missingSince > graceMs) this.gone('The other player left');
  }

  private gone(reason: string) {
    if (this.closed) return;
    this.goneCb(reason);
  }

  publish(state: LinkState): void {
    if (this.closed) return;
    this.room.presence({ l: state }).catch((e: { code?: string; message?: string }) => {
      if (e?.code === 'invalid_argument') console.warn('relay state rejected', e.message);
    });
  }
  onRemote(cb: (state: unknown) => void): void { this.remoteCb = cb; }
  onGone(cb: (reason: string) => void): void { this.goneCb = cb; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    void this.room.leave().catch(() => {});
  }
}

/** Lobby: list open games, advertise yours, and broker private rooms. */
export class CoopLobby {
  private stops: (() => void)[] = [];
  private gamesCb: ((g: OpenGame[]) => void) | null = null;
  private hosting: { code: string; seen: Map<string, { pipe: RoomPipe | null; at: number }>; onPlayer: (pipe: PresencePipe, rid: string) => void } | null = null;
  private pipes = new Set<RoomPipe>();
  private janitor: ReturnType<typeof setInterval>;

  constructor(private room: LobbyRoom) {
    this.stops.push(watchPeers(room, (peers) => this.onPeers(peers)));
    this.janitor = setInterval(() => { for (const p of this.pipes) p.checkGone(6000); }, 1000);
  }

  get connected(): boolean { return this.room.connected(); }

  games(): OpenGame[] {
    return this.room.peers().map(readAd).filter((g): g is OpenGame => g !== null);
  }

  onGames(cb: ((g: OpenGame[]) => void) | null) { this.gamesCb = cb; if (cb) cb(this.games()); }

  private onPeers(peers: readonly Peer[]) {
    this.gamesCb?.(peers.map(readAd).filter((g): g is OpenGame => g !== null));
    const h = this.hosting;
    if (!h) return;
    for (const p of peers) {
      if (p.sameTab) continue;
      const tw = p.presence?.tw as Record<string, unknown> | undefined;
      if (!tw || tw.join !== h.code || typeof tw.rid !== 'string' || !RID_RE.test(tw.rid)) continue;
      const rid = tw.rid;
      if (h.seen.has(rid)) continue;
      h.seen.set(rid, { pipe: null, at: Date.now() });
      void this.room.join(`tw-${h.code}-${rid}`).then((named) => {
        if (this.hosting !== h) { void named.leave(); return; }
        const pipe = new RoomPipe(named, p.peer);
        this.pipes.add(pipe);
        const entry = h.seen.get(rid);
        if (entry) entry.pipe = pipe;
        const origClose = pipe.close.bind(pipe);
        pipe.close = () => { this.pipes.delete(pipe); origClose(); setTimeout(() => h.seen.delete(rid), 5000); };
        h.onPlayer(pipe, rid);
      }).catch((e: { code?: string }) => { console.warn('could not open player room', e?.code); h.seen.delete(rid); });
    }
  }

  /** Start hosting: advertise and accept players. */
  host(code: string, ad: Omit<GameAd, 'v' | 'code' | 'max'>, onPlayer: (pipe: PresencePipe, rid: string) => void) {
    this.hosting = { code, seen: new Map(), onPlayer };
    this.advertise(code, ad);
    this.onPeers(this.room.peers());
  }

  advertise(code: string, ad: Omit<GameAd, 'v' | 'code' | 'max'>) {
    const full: GameAd = { v: PROTOCOL_VERSION, code, max: SIM.maxPlayers, host: clean(ad.host, 24), world: clean(ad.world, 40), players: ad.players, day: ad.day };
    void this.room.presence({ tw: { ad: full } }).catch(() => {});
  }

  /** Stop advertising and accepting players; `closeNow` also leaves the players' rooms. */
  stopHosting(closeNow = true) {
    if (!this.hosting) return;
    this.closing = [...this.hosting.seen.values()];
    this.hosting = null;
    void this.room.presence({ tw: null }).catch(() => {});
    if (closeNow) this.closeRooms();
  }

  closeRooms() {
    for (const e of this.closing) e.pipe?.close();
    this.closing = [];
  }
  private closing: { pipe: RoomPipe | null }[] = [];

  /** Join a game by code: announce a request and open the private room. */
  async connect(code: string): Promise<PresencePipe> {
    code = code.trim().toLowerCase();
    if (!CODE_RE.test(code)) throw new Error('Game codes are 6 letters or digits.');
    const rid = randomId(8);
    const named = await this.room.join(`tw-${code}-${rid}`);
    await this.room.presence({ tw: { join: code, rid } });
    const pipe = new RoomPipe(named, null);
    this.pipes.add(pipe);
    const origClose = pipe.close.bind(pipe);
    pipe.close = () => { this.pipes.delete(pipe); origClose(); void this.room.presence({ tw: null }).catch(() => {}); };
    return pipe;
  }

  dispose() {
    this.stopHosting();
    for (const s of this.stops) s();
    clearInterval(this.janitor);
  }
}

let lobby: CoopLobby | null = null;
export async function getLobby(): Promise<CoopLobby | null> {
  if (lobby) return lobby;
  const room = await getRoom();
  if (!room) return null;
  lobby = new CoopLobby(room);
  return lobby;
}
