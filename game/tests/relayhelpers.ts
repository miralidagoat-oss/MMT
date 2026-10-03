import { GameHost } from '../src/shared/net/host';
import { encode, decode } from '../src/shared/net/codec';
import { ClientSession } from '../src/client/net/session';
import { RelayTransport, RelayPeerLink, type PresencePipe } from '../src/client/net/relay';
import type { ClientMsg } from '../src/shared/net/protocol';

/**
 * In-memory model of the room channel's presence semantics: each side's state is
 * coalesced (latest wins) and sent at most ~30 times a second, must stay under
 * 4 KiB of JSON, and arrives after latency + jitter, in order.
 */
export function pipePair(cfg: { latencyMs: number; jitterMs: number; hz?: number }) {
  const hz = cfg.hz ?? 30;
  const sides = [0, 1].map(() => ({ latest: null as string | null, sent: null as string | null, remote: null as ((s: unknown) => void) | null, gone: null as ((r: string) => void) | null, lastArrive: 0, closed: false, maxBytes: 0, sends: 0 }));
  const timer = setInterval(() => {
    for (let i = 0; i < 2; i++) {
      const s = sides[i]!, o = sides[1 - i]!;
      if (s.closed || s.latest === null || s.latest === s.sent) continue;
      s.sent = s.latest;
      s.sends++;
      const text = s.latest;
      const at = Math.max(Date.now() + cfg.latencyMs + Math.random() * cfg.jitterMs, s.lastArrive);
      s.lastArrive = at;
      setTimeout(() => { if (!o.closed) o.remote?.(JSON.parse(text)); }, at - Date.now());
    }
  }, 1000 / hz);
  const make = (i: number): PresencePipe => ({
    publish(state) {
      const text = JSON.stringify(state);
      const bytes = new TextEncoder().encode(text).length;
      sides[i]!.maxBytes = Math.max(sides[i]!.maxBytes, bytes);
      if (bytes > 4096) throw new Error(`presence over 4 KiB: ${bytes}`);
      sides[i]!.latest = text;
    },
    onRemote(cb) { sides[i]!.remote = cb; },
    onGone(cb) { sides[i]!.gone = cb; },
    close() {
      sides[i]!.closed = true;
      const o = sides[1 - i]!;
      setTimeout(() => { if (!o.closed) o.gone?.('left'); }, cfg.latencyMs);
      if (sides[0]!.closed && sides[1]!.closed) clearInterval(timer);
    },
  });
  return { host: make(0), client: make(1), sides, stop: () => clearInterval(timer) };
}

/** Connect a client session to the host over a simulated presence relay. */
export function connectRelayClient(host: GameHost, name: string, token: string, cfg = { latencyMs: 60, jitterMs: 40 }) {
  const pair = pipePair(cfg);
  const peer = host.connect((msg) => peerLink.send(encode(msg), msg.t === 'snap'), () => peerLink.end('kicked'));
  const peerLink: RelayPeerLink = new RelayPeerLink(pair.host, (frame) => host.handle(peer, decode<ClientMsg>(frame)), () => host.disconnect(peer, 'relay closed'));
  peer.wantsSnapshot = () => peerLink.wantsSnapshot;
  const transport = new RelayTransport(pair.client);
  const session = new ClientSession(transport, { name, token });
  return { session, transport, peerLink, peer, pair };
}
