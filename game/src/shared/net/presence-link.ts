/**
 * A duplex message link carried over "presence" state: a per-sender JSON object
 * that a relay delivers to the other side as latest-value-wins (intermediate
 * values may be skipped, the latest one always arrives). This is what the
 * hosted web build's live room channel offers, so online co-op rides on it.
 *
 * Two lanes:
 *  - reliable: frames are split into numbered chunks; every published state
 *    carries the window of chunks the other side has not acknowledged yet, so
 *    skipping intermediate states loses nothing. Cumulative acks free the window.
 *  - unreliable: one "latest" frame (snapshots, input batches). A newer frame
 *    replaces an unsent older one; the receiver dedupes by a counter.
 *
 * Pure and transport-agnostic so it can be tested with a simulated relay.
 */

export interface LinkState {
  /** sender epoch (random per link instance) */
  e: string;
  /** highest contiguous reliable chunk received from the other side */
  a: number;
  /** seq of r[0] */
  s: number;
  /** reliable chunks; first char '!' = last chunk of a frame, '.' = more follows */
  r: string[];
  /** latest unreliable frame (base64) */
  u?: string;
  /** unreliable frame counter */
  n: number;
}

export interface LinkOptions {
  /** max JSON bytes of one published state */
  maxBytes: number;
  /** raw bytes per reliable chunk */
  chunkBytes: number;
  /** minimum ms between publishes */
  minIntervalMs: number;
  /** cap on queued reliable chunks before the link is declared broken */
  maxBacklogChunks: number;
}

export const DEFAULT_LINK: LinkOptions = { maxBytes: 3800, chunkBytes: 1100, minIntervalMs: 80, maxBacklogChunks: 4000 };

export function toB64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class PresenceLink {
  readonly epoch = Math.random().toString(36).slice(2, 10);
  private out: { seq: number; data: string }[] = [];
  private nextSeq = 1;
  private recvSeq = 0;
  private partial: Uint8Array[] = [];
  private remoteEpoch: string | null = null;
  private lastRemoteN = -1;
  private pendingU: string | null = null;
  private lastU: string | null = null;
  private n = 0;
  private dirty = true;
  private lastPublish = -Infinity;
  private lastPublishedAck = -1;
  broken: string | null = null;
  stats = { publishes: 0, reliableIn: 0, unreliableIn: 0, bytesOut: 0 };

  constructor(
    private publish: (state: LinkState) => void,
    private deliver: (frame: Uint8Array, reliable: boolean) => void,
    private opts: LinkOptions = DEFAULT_LINK,
    /** called when the other side restarted (new epoch) after we had heard from it */
    private onReset: () => void = () => {},
  ) {}

  /** Largest unreliable frame (raw bytes) that can travel alongside the state header. */
  get maxUnreliableBytes(): number { return Math.floor((this.opts.maxBytes - 120) * 3 / 4); }

  /** True when the last unreliable frame has been published (the lane is free). */
  get unreliableIdle(): boolean { return this.pendingU === null; }

  get backlog(): number { return this.out.length; }

  sendReliable(frame: Uint8Array): void {
    if (this.broken) return;
    const size = this.opts.chunkBytes;
    for (let i = 0; i < frame.length || i === 0; i += size) {
      const last = i + size >= frame.length;
      this.out.push({ seq: this.nextSeq++, data: (last ? '!' : '.') + toB64(frame.subarray(i, i + size)) });
      if (last) break;
    }
    if (this.out.length > this.opts.maxBacklogChunks) this.broken = 'link backlog overflow';
    this.dirty = true;
  }

  /** Queue the latest unreliable frame. Returns false when it is too big (send it reliably instead). */
  sendUnreliable(frame: Uint8Array): boolean {
    if (frame.length > this.maxUnreliableBytes) return false;
    this.pendingU = toB64(frame);
    this.dirty = true;
    return true;
  }

  /** Feed the other side's latest published state. */
  receive(raw: unknown): void {
    const st = parseState(raw);
    if (!st) return;
    if (this.remoteEpoch !== st.e) {
      const had = this.remoteEpoch !== null;
      this.remoteEpoch = st.e;
      this.recvSeq = 0;
      this.partial = [];
      this.lastRemoteN = -1;
      if (had) { this.onReset(); return; }
    }
    // acks free our window
    if (st.a > 0) {
      let k = 0;
      while (k < this.out.length && this.out[k]!.seq <= st.a) k++;
      if (k) { this.out.splice(0, k); this.dirty = true; }
    }
    // reliable chunks in order
    for (let i = 0; i < st.r.length; i++) {
      const seq = st.s + i;
      if (seq <= this.recvSeq) continue;
      if (seq !== this.recvSeq + 1) break; // gap: wait for the sender to include it
      const c = st.r[i]!;
      this.recvSeq = seq;
      this.dirty = true;
      this.partial.push(fromB64(c.slice(1)));
      if (c[0] === '!') {
        const frame = concat(this.partial);
        this.partial = [];
        this.stats.reliableIn++;
        this.deliver(frame, true);
      }
    }
    // unreliable latest
    if (st.u !== undefined && st.n !== this.lastRemoteN) {
      this.lastRemoteN = st.n;
      this.stats.unreliableIn++;
      this.deliver(fromB64(st.u), false);
    }
  }

  /** Publish the current state if anything changed and the rate limit allows. Returns true if published. */
  flush(now: number): boolean {
    if (this.broken || !this.dirty || now - this.lastPublish < this.opts.minIntervalMs) return false;
    const st: LinkState = { e: this.epoch, a: this.recvSeq, s: this.out[0]?.seq ?? this.nextSeq, r: [], n: this.n };
    let bytes = JSON.stringify(st).length + 16;
    for (const c of this.out) {
      if (bytes + c.data.length + 3 > this.opts.maxBytes) break;
      st.r.push(c.data);
      bytes += c.data.length + 3;
    }
    const u = this.pendingU ?? this.lastU;
    if (u !== null && bytes + u.length + 16 <= this.opts.maxBytes) {
      if (this.pendingU !== null) { this.n++; this.lastU = this.pendingU; this.pendingU = null; }
      st.n = this.n;
      st.u = this.lastU!;
      bytes += u.length + 16;
    }
    this.lastPublish = now;
    this.lastPublishedAck = this.recvSeq;
    // stays dirty while a newer unreliable frame is still waiting for room
    this.dirty = this.pendingU !== null;
    this.stats.publishes++;
    this.stats.bytesOut += bytes;
    this.publish(st);
    return true;
  }

  /** Whether a flush would publish something new (used to schedule flushes). */
  get wantsFlush(): boolean { return !this.broken && (this.dirty || this.lastPublishedAck !== this.recvSeq); }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Validate untrusted remote state. */
export function parseState(raw: unknown): LinkState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.e !== 'string' || o.e.length > 16) return null;
  if (!Number.isSafeInteger(o.a) || !Number.isSafeInteger(o.s) || !Number.isSafeInteger(o.n)) return null;
  if (!Array.isArray(o.r) || o.r.length > 64) return null;
  for (const c of o.r) if (typeof c !== 'string' || (c[0] !== '!' && c[0] !== '.') || !B64_RE.test(c.slice(1))) return null;
  if (o.u !== undefined && (typeof o.u !== 'string' || !B64_RE.test(o.u))) return null;
  return o as unknown as LinkState;
}
