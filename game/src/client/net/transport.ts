/** Client transports. All carry msgpack frames; the session never sees the transport type. */
import { encode, decode } from '../../shared/net/codec';
import type { ClientMsg, ServerMsg } from '../../shared/net/protocol';

export interface Transport {
  send(msg: ClientMsg): void;
  onMessage: (msg: ServerMsg) => void;
  onClose: (reason: string) => void;
  onOpen: () => void;
  close(): void;
  readonly kind: string;
  /** Per-transport netcode tuning (slower relays send input less often and buffer more). */
  readonly tuning?: TransportTuning;
}

export interface TransportTuning { inputHz: number; inputRedundancy: number; interpDelayMs: number }

/** WebSocket transport (works with browser WebSocket or the `ws` package in Node). */
export class WsTransport implements Transport {
  onMessage: (msg: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  onOpen: () => void = () => {};
  readonly kind = 'ws';
  private ws: WebSocket;
  private closed = false;

  constructor(url: string, WS: typeof WebSocket = WebSocket) {
    this.ws = new WS(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (ev) => {
      try { this.onMessage(decode<ServerMsg>(ev.data as ArrayBuffer)); } catch (e) { console.warn('bad server packet', e); }
    };
    this.ws.onclose = (ev) => { if (!this.closed) { this.closed = true; this.onClose(ev.reason || `connection closed (${ev.code})`); } };
    this.ws.onerror = () => { /* onclose follows */ };
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === 1) this.ws.send(encode(msg) as Uint8Array<ArrayBuffer>);
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** Generic "port" transport (Web Worker / MessagePort / in-process loopback). */
export class PortTransport implements Transport {
  onMessage: (msg: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  onOpen: () => void = () => {};
  constructor(private post: (data: Uint8Array) => void, readonly kind = 'port') {}
  /** call with raw frames coming from the host */
  receive(data: Uint8Array | ArrayBuffer): void {
    try { this.onMessage(decode<ServerMsg>(data)); } catch (e) { console.warn('bad packet', e); }
  }
  send(msg: ClientMsg): void { this.post(encode(msg)); }
  close(): void { this.onClose('closed'); }
}

/**
 * Network conditioner for testing: adds latency/jitter and drops *unreliable*
 * traffic (inputs are redundantly resent, snapshots superseded) with probability `loss`.
 * Reliable messages are delayed but never dropped (TCP/ordered semantics).
 */
export class ConditionedTransport implements Transport {
  onMessage: (msg: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  onOpen: () => void = () => {};
  readonly kind: string;
  get tuning() { return this.inner.tuning; }
  private lastDeliverUp = 0;
  private lastDeliverDown = 0;

  constructor(private inner: Transport, public cfg: { lagMs: number; jitterMs: number; loss: number; rand?: () => number; schedule?: (fn: () => void, ms: number) => void }) {
    this.kind = `${inner.kind}+cond`;
    inner.onOpen = () => this.onOpen();
    inner.onClose = (r) => this.onClose(r);
    inner.onMessage = (m) => {
      if (m.t === 'snap' && this.rand() < cfg.loss) return;
      const at = Math.max(this.now() + this.delay(), this.lastDeliverDown); // keep order (TCP-like)
      this.lastDeliverDown = at;
      this.sched(() => this.onMessage(m), at - this.now());
    };
  }

  private rand() { return this.cfg.rand ? this.cfg.rand() : Math.random(); }
  private now() { return performance.now(); }
  private delay() { return this.cfg.lagMs + this.rand() * this.cfg.jitterMs; }
  private sched(fn: () => void, ms: number) { (this.cfg.schedule ?? ((f, t) => setTimeout(f, t)))(fn, Math.max(0, ms)); }

  send(msg: ClientMsg): void {
    if (msg.t === 'input' && this.rand() < this.cfg.loss) return;
    const at = Math.max(this.now() + this.delay(), this.lastDeliverUp);
    this.lastDeliverUp = at;
    this.sched(() => this.inner.send(msg), at - this.now());
  }

  close(): void { this.inner.close(); }
}
