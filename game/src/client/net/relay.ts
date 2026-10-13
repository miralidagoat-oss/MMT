/**
 * Online co-op over a presence relay (the hosted web build's live room channel).
 * A `PresencePipe` is one private two-party room: each side publishes its whole
 * link state and hears the other side's latest state.
 */
import { encode, decode } from '../../shared/net/codec';
import { PresenceLink, DEFAULT_LINK, type LinkState, type LinkOptions } from '../../shared/net/presence-link';
import type { ClientMsg, ServerMsg } from '../../shared/net/protocol';
import type { Transport, TransportTuning } from './transport';
import { onTick } from './ticker';

export interface PresencePipe {
  publish(state: LinkState): void;
  /** register the handler for the other side's latest state */
  onRemote(cb: (state: unknown) => void): void;
  /** register the handler for "the other side left / the room ended" */
  onGone(cb: (reason: string) => void): void;
  close(): void;
}

export const RELAY_TUNING: TransportTuning = { inputHz: 12, inputRedundancy: 10, interpDelayMs: 280 };

/**
 * Runs flushes for a set of links on one background-safe tick, and shares the
 * page's presence budget (about 40 updates a second across all rooms) between
 * them: one link may publish every 80 ms, three links every 95 ms each.
 */
export class LinkPump {
  private links = new Set<PresenceLink>();
  private off: (() => void) | null = null;
  add(l: PresenceLink) { this.links.add(l); this.rebalance(); if (!this.off) this.off = onTick(() => this.pump()); }
  remove(l: PresenceLink) { this.links.delete(l); this.rebalance(); if (!this.links.size && this.off) { this.off(); this.off = null; } }
  private rebalance() { const ms = Math.max(DEFAULT_LINK.minIntervalMs, Math.ceil((1000 * this.links.size) / 32)); for (const l of this.links) l.setMinInterval(ms); }
  pump() { const now = performance.now(); for (const l of this.links) if (l.wantsFlush) l.flush(now); }
}
export const pump = new LinkPump();

/** Client side: a Transport whose far end is the host's relay peer. */
export class RelayTransport implements Transport {
  onMessage: (msg: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  onOpen: () => void = () => {};
  readonly kind = 'relay';
  readonly tuning = RELAY_TUNING;
  readonly link: PresenceLink;
  private opened = false;
  private closed = false;
  private lastSend = 0;
  private stopBeat: (() => void) | null = null;

  constructor(private pipe: PresencePipe, opts: LinkOptions = DEFAULT_LINK, private pumper: LinkPump = pump) {
    this.link = new PresenceLink((s) => pipe.publish(s), (frame) => {
      try { this.onMessage(decode<ServerMsg>(frame)); } catch (e) { console.warn('bad relay packet', e); }
    }, opts, () => this.shut('The host restarted the game'));
    pipe.onRemote((st) => {
      if (this.closed) return;
      this.link.receive(st);
      if (!this.opened) { this.opened = true; this.onOpen(); }
      if (this.link.broken) this.shut(`Connection failed: ${this.link.broken}`);
    });
    pipe.onGone((r) => this.shut(r));
    this.pumper.add(this.link);
    this.link.flush(performance.now()); // announce ourselves so the host can answer
    // keep-alive that survives background-tab timer throttling (the session's own
    // heartbeat slows to once a minute in a long-hidden tab and the host would drop us)
    this.stopBeat = onTick(() => {
      const now = performance.now();
      if (this.opened && !this.closed && now - this.lastSend > 2500) this.send({ t: 'ping', c: now });
    });
  }

  send(msg: ClientMsg): void {
    if (this.closed) return;
    this.lastSend = performance.now();
    const d = encode(msg);
    if (msg.t !== 'input' || !this.link.sendUnreliable(d)) this.link.sendReliable(d);
  }

  private shut(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.stopBeat?.();
    this.pumper.remove(this.link);
    this.pipe.close();
    this.onClose(reason);
  }

  close(): void {
    if (this.closed) return;
    // let a final 'bye' go out before leaving the room
    this.link.flush(performance.now() + 1e6);
    this.closed = true;
    this.stopBeat?.();
    this.pumper.remove(this.link);
    // linger so the final state (acks, 'bye') reaches the other side before leaving the room
    setTimeout(() => this.pipe.close(), 1500);
  }
}

/**
 * Host side of one remote player: frames from the link go to `toHost`, host
 * messages come in through `send`. Snapshots ride the unreliable lane; the host
 * should only build a new snapshot when `wantsSnapshot` is true.
 */
export class RelayPeerLink {
  readonly link: PresenceLink;
  private closed = false;
  private awaitingIdle = false;
  /** called when the snapshot lane frees up after a snapshot was queued */
  onSnapshotIdle: () => void = () => {};
  constructor(private pipe: PresencePipe, toHost: (frame: Uint8Array) => void, private onEnd: (reason: string) => void, opts: LinkOptions = DEFAULT_LINK, private pumper: LinkPump = pump) {
    this.link = new PresenceLink((s) => {
      pipe.publish(s);
      if (this.awaitingIdle && this.link.unreliableIdle) { this.awaitingIdle = false; this.onSnapshotIdle(); }
    }, (frame) => toHost(frame), opts, () => this.end('player reloaded'));
    pipe.onRemote((st) => { if (!this.closed) { this.link.receive(st); if (this.link.broken) this.end(this.link.broken); } });
    pipe.onGone((r) => this.end(r));
    this.pumper.add(this.link);
  }
  get wantsSnapshot(): boolean { return this.link.unreliableIdle; }
  /** frame: encoded ServerMsg; snap: whether it is a snapshot */
  send(frame: Uint8Array, snap: boolean): void {
    if (this.closed) return;
    if (snap && this.link.sendUnreliable(frame)) { this.awaitingIdle = true; return; }
    this.link.sendReliable(frame);
    if (snap) this.onSnapshotIdle();
  }
  /** true once this link has ended (either side) */
  get ended(): boolean { return this.closed; }

  end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.pumper.remove(this.link);
    this.link.flush(performance.now() + 1e6);
    // linger so the final state (acks, 'bye') reaches the other side before leaving the room
    setTimeout(() => this.pipe.close(), 1500);
    this.onEnd(reason);
  }
}
