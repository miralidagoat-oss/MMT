import { Simulation } from '../src/shared/sim/simulation';
import { GameHost, type Peer } from '../src/shared/net/host';
import { encode, decode } from '../src/shared/net/codec';
import { ClientSession, type InputSample } from '../src/client/net/session';
import { PortTransport, ConditionedTransport, type Transport } from '../src/client/net/transport';
import type { ClientMsg, ServerMsg } from '../src/shared/net/protocol';

export interface NetCfg { lagMs: number; jitterMs: number; loss: number }

export function makeHost(seed = 9001) {
  const sim = new Simulation({ seed, name: 'NetTest' });
  const host = new GameHost(sim, { log: () => {} });
  return { sim, host };
}

/** Connect a client session to the host through an in-memory, msgpack-serialized link. */
export function connectClient(host: GameHost, name: string, token: string, cfg?: NetCfg) {
  let peer: Peer | null = null;
  let open = true;
  const port = new PortTransport((data) => {
    if (!open || !peer) return;
    host.handle(peer, decode<ClientMsg>(data));
  }, 'loop');
  peer = host.connect((msg: ServerMsg) => { if (open) port.receive(encode(msg)); }, () => { open = false; port.onClose('server closed'); });
  const transport: Transport = cfg ? new ConditionedTransport(port, cfg) : port;
  const session = new ClientSession(transport, { name, token });
  const notes: string[] = [];
  session.on.notify = (t) => notes.push(t);
  queueMicrotask(() => session.hello());
  return {
    session, notes,
    get peer() { return peer!; },
    /** simulate an abrupt network drop */
    drop() { open = false; host.disconnect(peer!, 'dropped'); },
  };
}

export const idle: InputSample = { mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false };

export async function waitFor(cond: () => boolean, ms = 5000, label = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(10);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drive client prediction loops in real time for `ms`. */
export async function run(clients: ClientSession[], ms: number, input: (c: ClientSession, i: number) => InputSample = () => idle) {
  const t0 = performance.now();
  let last = t0;
  while (performance.now() - t0 < ms) {
    await sleep(16);
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    clients.forEach((c, i) => c.update(dt, input(c, i)));
  }
}
