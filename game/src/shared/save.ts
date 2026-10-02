/**
 * Versioned, checksummed save format with forward migrations and corruption
 * detection. Storage backends (fs / IndexedDB) live in server/ and client/.
 */
import { SAVE_VERSION, GAME_NAME } from './config';
import { crc32 } from './math/vec';
import { DEFAULT_SETTINGS, type WorldState } from './state';
import { ITEMS } from './defs/items';
import { STRUCTURES } from './defs/structures';

export interface SaveEnvelope {
  format: 'tidewake-save';
  version: number;
  game: string;
  savedAt: number;
  name: string;
  seed: number;
  day: number;
  players: string[];
  checksum: number;
  payload: string;
}

export class SaveError extends Error {}

type Migration = (w: Record<string, unknown>) => void;

/** migrations[n] upgrades a world from version n to n+1 */
const MIGRATIONS: Record<number, Migration> = {
  1: (w) => {
    // v1 had no waypoints / events
    w.waypoints ??= [];
    w.events ??= [];
  },
  2: (w) => {
    // v2 -> v3: progression block and per-player explored map
    w.progression ??= { beaconId: null, beaconStartedAt: 0, rescueAt: 0, rescued: false, milestones: [], discoveredIslands: [0] };
    const players = (w.players ?? {}) as Record<string, Record<string, unknown>>;
    for (const p of Object.values(players)) { p.explored ??= []; p.milestones ??= []; }
  },
};

export function serializeWorld(world: WorldState, day: number): string {
  const payload = JSON.stringify(world);
  const env: SaveEnvelope = {
    format: 'tidewake-save', version: SAVE_VERSION, game: GAME_NAME, savedAt: Date.now(), name: world.name, seed: world.seed, day,
    players: Object.values(world.players).map((p) => p.name), checksum: crc32(payload), payload,
  };
  return JSON.stringify(env);
}

export function readEnvelope(text: string): SaveEnvelope {
  let env: SaveEnvelope;
  try { env = JSON.parse(text); } catch { throw new SaveError('Save file is not valid JSON (corrupted)'); }
  if (!env || env.format !== 'tidewake-save' || typeof env.payload !== 'string') throw new SaveError('Not a Tidewake save');
  if (crc32(env.payload) !== env.checksum) throw new SaveError('Save checksum mismatch (corrupted)');
  if (env.version > SAVE_VERSION) throw new SaveError(`Save is from a newer version (${env.version})`);
  return env;
}

export function deserializeWorld(text: string): WorldState {
  const env = readEnvelope(text);
  let w: Record<string, unknown>;
  try { w = JSON.parse(env.payload); } catch { throw new SaveError('Save payload corrupted'); }
  for (let v = env.version; v < SAVE_VERSION; v++) {
    const m = MIGRATIONS[v];
    if (m) m(w);
  }
  return sanitizeWorld(w as unknown as WorldState);
}

/** Defensive validation: drop references to content that no longer exists. */
export function sanitizeWorld(w: WorldState): WorldState {
  if (typeof w.seed !== 'number') throw new SaveError('Save has no seed');
  w.settings = { ...DEFAULT_SETTINGS, ...(w.settings ?? {}) };
  w.structures ??= {}; w.containers ??= {}; w.nodes ??= {}; w.items ??= {}; w.creatures ??= {}; w.vehicles ??= {};
  w.zones ??= {}; w.players ??= {}; w.waypoints ??= []; w.events ??= [];
  for (const [id, s] of Object.entries(w.structures)) if (!STRUCTURES[s.type]) delete w.structures[id];
  const fixSlots = (slots: ({ id: string } | null)[]) => slots.map((s) => (s && ITEMS[s.id] ? s : null));
  for (const c of Object.values(w.containers)) c.slots = fixSlots(c.slots) as typeof c.slots;
  for (const [id, it] of Object.entries(w.items)) if (!ITEMS[it.stack?.id]) delete w.items[id];
  for (const p of Object.values(w.players)) {
    p.inventory.slots = fixSlots(p.inventory.slots) as typeof p.inventory.slots;
    for (const k of Object.keys(p.inventory.equip) as (keyof typeof p.inventory.equip)[]) {
      const e = p.inventory.equip[k];
      if (e && !ITEMS[e.id]) p.inventory.equip[k] = null;
    }
    p.connected = false;
  }
  return w;
}
