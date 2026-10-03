/// <reference lib="webworker" />
/**
 * Single-player host: runs the exact same authoritative GameHost as the dedicated
 * server, inside a Web Worker. Saves go to IndexedDB with a rotating backup.
 */
import { Simulation } from '../../shared/sim/simulation';
import { GameHost, type Peer } from '../../shared/net/host';
import { encode, decode } from '../../shared/net/codec';
import { serializeWorld, deserializeWorld } from '../../shared/save';
import { dayNumber } from '../../shared/systems/weather';
import { SIM } from '../../shared/config';
import type { ClientMsg } from '../../shared/net/protocol';
import type { GameSettings } from '../../shared/state';
import { saveStore } from './idb';

declare const self: DedicatedWorkerGlobalScope;

let host: GameHost | null = null;
let peer: Peer | null = null;
/** remote co-op players (relayed by the main thread) */
const remote = new Map<number, { peer: Peer; ready: boolean }>();
let maxPlayers = 1;
let slot = '';
let autosave: ReturnType<typeof setInterval> | null = null;

async function save(): Promise<boolean> {
  if (!host) return false;
  try {
    const text = serializeWorld(host.sim.world, dayNumber(host.sim.world));
    const prev = await saveStore.get(`world:${slot}`);
    if (prev) await saveStore.put(`backup:${slot}`, prev);
    let stored = true;
    try { await saveStore.put(`world:${slot}`, text); } catch { stored = false; }
    // the main thread keeps a cloud copy (and stores it itself if IndexedDB failed here)
    self.postMessage({ type: 'saved-text', slot, text, stored });
    return true;
  } catch (e) {
    self.postMessage({ type: 'log', text: `save failed: ${(e as Error).message}` });
    return false;
  }
}

async function load(name: string) {
  const main = await saveStore.get(`world:${name}`);
  if (main) {
    try { return deserializeWorld(main); } catch (e) { self.postMessage({ type: 'log', text: `main save corrupted: ${(e as Error).message}; trying backup` }); }
  }
  const bak = await saveStore.get(`backup:${name}`);
  if (bak) return deserializeWorld(bak);
  throw new Error('Save not found or corrupted');
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { type: string; [k: string]: unknown };
  try {
    switch (m.type) {
      case 'init': {
        slot = String(m.slot);
        const log = (t: string) => self.postMessage({ type: 'log', text: t });
        let sim: Simulation;
        if (m.mode === 'load') sim = new Simulation({ world: await load(slot), log });
        else sim = new Simulation({ seed: m.seed as string | undefined, name: String(m.name ?? slot), log, settings: m.settings as Partial<GameSettings> });
        maxPlayers = m.coop ? 4 : 1;
        host = new GameHost(sim, { log, onSaveRequest: save, maxPlayers: 4 });
        // the cap is enforced here so a world can be opened to friends mid-game
        const handle = host.handle.bind(host);
        host.handle = (p, msg) => {
          if (msg && (msg as { t?: string }).t === 'hello' && p !== peer && [...remote.values()].filter((r) => r.peer !== p && r.peer.playerId).length >= maxPlayers - 1) { p.send({ t: 'reject', reason: maxPlayers > 1 ? 'Server is full' : 'This world is not open to friends right now' }); p.close('full'); return; }
          handle(p, msg);
        };
        peer = host.connect((msg) => { const d = encode(msg); self.postMessage({ type: 'frame', data: d }, [d.buffer as ArrayBuffer]); }, () => {});
        host.start();
        if (m.mode !== 'load') await save();
        autosave = setInterval(() => void save(), SIM.autosaveSeconds * 1000);
        self.postMessage({ type: 'ready', seed: sim.world.seed });
        break;
      }
      case 'frame':
        if (host && peer) host.handle(peer, decode<ClientMsg>(m.data as Uint8Array));
        break;
      case 'open':
        maxPlayers = m.open ? 4 : 1;
        if (!m.open) for (const [id, r] of remote) { r.peer.send({ t: 'reject', reason: 'The host closed the world to friends' }); host?.disconnect(r.peer, 'closed'); remote.delete(id); self.postMessage({ type: 'peer-kick', id }); }
        break;
      case 'peer-open': {
        if (!host) break;
        const id = Number(m.id);
        const p = host.connect((msg) => {
          const d = encode(msg);
          const snap = msg.t === 'snap';
          if (snap) r.ready = false;
          self.postMessage({ type: 'peer-out', id, data: d, snap }, [d.buffer as ArrayBuffer]);
        }, () => { remote.delete(id); self.postMessage({ type: 'peer-kick', id }); });
        const r = { peer: p, ready: true };
        p.wantsSnapshot = () => r.ready;
        remote.set(id, r);
        break;
      }
      case 'peer-frame': {
        const r = remote.get(Number(m.id));
        if (host && r) { try { host.handle(r.peer, decode<ClientMsg>(m.data as Uint8Array)); } catch { /* malformed packet from a remote player */ } }
        break;
      }
      case 'peer-ready': { const r = remote.get(Number(m.id)); if (r) r.ready = true; break; }
      case 'peer-close': {
        const r = remote.get(Number(m.id));
        if (host && r) { host.disconnect(r.peer, 'left'); remote.delete(Number(m.id)); }
        break;
      }
      case 'save': {
        const ok = await save();
        self.postMessage({ type: 'saved', ok });
        break;
      }
      case 'pause':
        if (m.paused) host?.stop(); else host?.start();
        break;
      case 'quit':
        if (autosave) clearInterval(autosave);
        host?.stop();
        await save();
        self.postMessage({ type: 'quit-done' });
        break;
    }
  } catch (e) {
    self.postMessage({ type: 'error', text: (e as Error).message });
  }
};
