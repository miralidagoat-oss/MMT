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
let slot = '';
let autosave: ReturnType<typeof setInterval> | null = null;

async function save(): Promise<boolean> {
  if (!host) return false;
  try {
    const text = serializeWorld(host.sim.world, dayNumber(host.sim.world));
    const prev = await saveStore.get(`world:${slot}`);
    if (prev) await saveStore.put(`backup:${slot}`, prev);
    await saveStore.put(`world:${slot}`, text);
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
        host = new GameHost(sim, { log, onSaveRequest: save, maxPlayers: 1 });
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
