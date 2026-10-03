/** Main-thread side of the single-player worker host. */
import { PortTransport } from './transport';
import { saveStore } from './idb';
import { readEnvelope } from '../../shared/save';
import type { GameSettings } from '../../shared/state';

export interface LocalWorld { slot: string; name: string; day: number; savedAt: number; seed: number; corrupted?: boolean }

export class LocalHost {
  worker: Worker;
  transport: PortTransport;
  onLog: (t: string) => void = (t) => console.log('[sp]', t);

  constructor() {
    this.worker = new Worker(new URL('./local-worker.ts', import.meta.url), { type: 'module' });
    this.transport = new PortTransport((data) => this.worker.postMessage({ type: 'frame', data }, [data.buffer as ArrayBuffer]), 'worker');
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'frame') this.transport.receive(m.data);
      else if (m.type === 'log') this.onLog(m.text);
    };
  }

  start(opts: { mode: 'new' | 'load'; slot: string; name?: string; seed?: string; settings?: Partial<GameSettings> }): Promise<void> {
    return new Promise((resolve, reject) => {
      const prev = this.worker.onmessage;
      this.worker.onmessage = (ev) => {
        if (ev.data.type === 'ready') { this.worker.onmessage = prev; resolve(); }
        else if (ev.data.type === 'error') { this.worker.onmessage = prev; reject(new Error(ev.data.text)); }
        else prev?.call(this.worker, ev);
      };
      this.worker.postMessage({ type: 'init', ...opts });
    });
  }

  setPaused(paused: boolean) { this.worker.postMessage({ type: 'pause', paused }); }

  save(): Promise<boolean> {
    return new Promise((resolve) => {
      const prev = this.worker.onmessage;
      this.worker.onmessage = (ev) => { if (ev.data.type === 'saved') { this.worker.onmessage = prev; resolve(ev.data.ok); } else prev?.call(this.worker, ev); };
      this.worker.postMessage({ type: 'save' });
    });
  }

  async quit(): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      this.worker.onmessage = (ev) => { if (ev.data.type === 'quit-done') { clearTimeout(t); resolve(); } };
      this.worker.postMessage({ type: 'quit' });
    });
    this.worker.terminate();
  }

  static async listWorlds(): Promise<LocalWorld[]> {
    const keys = (await saveStore.keys()).filter((k) => k.startsWith('world:'));
    const out: LocalWorld[] = [];
    for (const k of keys) {
      const slot = k.slice(6);
      const text = await saveStore.get(k);
      if (!text) continue;
      try {
        const env = readEnvelope(text);
        out.push({ slot, name: env.name, day: env.day, savedAt: env.savedAt, seed: env.seed });
      } catch {
        out.push({ slot, name: slot, day: 0, savedAt: 0, seed: 0, corrupted: true });
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  static async deleteWorld(slot: string) {
    await saveStore.del(`world:${slot}`);
    await saveStore.del(`backup:${slot}`);
  }
}
