/**
 * Wire protocol. All messages are msgpack-encoded objects with a `t` discriminator.
 * Client -> server messages carry *intents* only; the server validates everything.
 */
import type { InputFrame } from '../systems/movement';
import type { SlotRef } from '../systems/inventory';
import type {
  ContainerState, DroppedItem, GameSettings, PlayerState, Progression, StructureState, Waypoint, WeatherState, WorldEvent,
} from '../state';

// ------------------------------------------------------------------ actions (client intents)
export type Action =
  | { a: 'use'; target?: { kind: 'node' | 'creature' | 'structure' | 'vehicle'; id: string }; yaw: number; pitch: number }
  | { a: 'gather'; nodeId: string }
  | { a: 'pickup'; itemId: string }
  | { a: 'interact'; kind: 'structure' | 'container' | 'vehicle' | 'player' | 'creature'; id: string; verb?: string; slot?: number }
  | { a: 'close_container' }
  | { a: 'move'; from: SlotRef; to: SlotRef; qty?: number }
  | { a: 'quick_move'; from: SlotRef }
  | { a: 'drop'; from: SlotRef; qty?: number }
  | { a: 'consume'; from: SlotRef }
  | { a: 'equip'; from: SlotRef }
  | { a: 'hotbar'; index: number }
  | { a: 'craft'; recipe: string; count: number }
  | { a: 'craft_cancel'; index: number }
  | { a: 'build'; structure: string; x: number; y: number; z: number; yaw: number }
  | { a: 'demolish'; id: string }
  | { a: 'upgrade'; id: string }
  | { a: 'repair'; id: string }
  | { a: 'fill'; from: SlotRef; source: 'sea' | 'structure'; id?: string }
  | { a: 'drink_source'; source: 'sea' | 'structure'; id?: string }
  | { a: 'fish_cast'; x: number; z: number }
  | { a: 'fish_reel' }
  | { a: 'shoot'; yaw: number; pitch: number; charge: number }
  | { a: 'board'; id: string }
  | { a: 'leave_vehicle' }
  | { a: 'anchor'; id: string }
  | { a: 'sail'; id: string }
  | { a: 'respawn'; at: 'bed' | 'beach' }
  | { a: 'revive'; id: string }
  | { a: 'sleep'; id: string }
  | { a: 'wake' }
  | { a: 'waypoint_add'; x: number; z: number; label: string }
  | { a: 'waypoint_remove'; id: string }
  | { a: 'plant'; id: string; plot: number; from: SlotRef }
  | { a: 'harvest_crop'; id: string; plot: number }
  | { a: 'water_crop'; id: string; from: SlotRef }
  | { a: 'ignite'; id: string }
  | { a: 'beacon'; id: string }
  | { a: 'chat'; text: string };

export type ActionName = Action['a'];

// ------------------------------------------------------------------ client -> server
export type ClientMsg =
  | { t: 'hello'; protocol: number; name: string; token: string; color?: string }
  | { t: 'input'; frames: InputFrame[] }
  | { t: 'act'; id: number; action: Action }
  | { t: 'ping'; c: number }
  | { t: 'save' }
  | { t: 'bye' };

// ------------------------------------------------------------------ server -> client
/** compact replicated entity in snapshots */
export interface NetPlayer {
  id: string; n: string; c: string;
  x: number; y: number; z: number; yaw: number; pitch: number;
  f: number; // flags bitfield: 1 ground 2 crouch 4 sprint 8 swim 16 underwater 32 downed 64 dead 128 sleeping 256 using
  h: number; // health
  it: string; // held item id
  v: string | null; // vehicle
  s: number; // seat
}
export interface NetCreature { id: string; k: string; x: number; y: number; z: number; yaw: number; m: string; h: number; sp: number }
export interface NetVehicle {
  id: string; k: string; x: number; y: number; z: number; yaw: number; p: number; r: number; vx: number; vz: number;
  h: number; an: boolean; sl: boolean; seats: (string | null)[]; cid: string;
}
export interface NetProjectile { id: string; x: number; y: number; z: number; vx: number; vy: number; vz: number }

/** private state only the owning player receives */
export interface SelfState {
  seq: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  og: boolean; cr: boolean; sw: boolean; uw: boolean;
  health: number; stamina: number; hunger: number; thirst: number; oxygen: number; bodyTemp: number; wetness: number;
  envTemp: number;
  effects: Record<string, number>;
  downed: number; dead: boolean; sleeping: boolean;
  vehicleId: string | null; seat: number;
  fishing: { phase: 'cast' | 'bite'; x: number; z: number } | null;
  craftQueue: { recipeId: string; remaining: number; total: number }[];
  openContainer: string | null;
  sheltered: boolean;
}

export interface Snapshot {
  t: 'snap';
  tick: number;
  time: number;
  dayOffset: number;
  weather: Pick<WeatherState, 'cloud' | 'rain' | 'wind' | 'waves' | 'fog' | 'windDir' | 'lightningAt' | 'kind' | 'next' | 'blend'>;
  players: NetPlayer[];
  creatures: NetCreature[];
  vehicles: NetVehicle[];
  projectiles: NetProjectile[];
  self: SelfState | null;
}

export interface PrivatePlayer {
  inventory: PlayerState['inventory'];
  hotbar: number;
  discovered: string[];
  milestones: string[];
  respawn: PlayerState['respawn'];
  explored: string[];
  stats: PlayerState['stats'];
}

/** Reliable world delta: value null = removed */
export interface WorldDelta {
  t: 'delta';
  structures?: Record<string, StructureState | null>;
  containers?: Record<string, ContainerState | null>;
  nodes?: Record<string, { hp?: number; respawnAt?: number } | null>;
  items?: Record<string, DroppedItem | null>;
  waypoints?: Waypoint[];
  progression?: Progression;
  events?: WorldEvent[];
  me?: PrivatePlayer;
}

export interface FxEvent { k: string; x: number; y: number; z: number; a?: string; b?: number; p?: string }

export interface WelcomeMsg {
  t: 'welcome';
  playerId: string;
  seed: number;
  worldName: string;
  fingerprint: number;
  worldgenVersion: number;
  tickRate: number;
  settings: GameSettings;
  full: WorldDelta;
  roster: { id: string; name: string; color: string; connected: boolean }[];
}

export type ServerMsg =
  | WelcomeMsg
  | Snapshot
  | WorldDelta
  | { t: 'fx'; list: FxEvent[] }
  | { t: 'result'; id: number; ok: boolean; reason?: string }
  | { t: 'notify'; text: string; level: 'info' | 'good' | 'warn' | 'bad' }
  | { t: 'chat'; from: string; name: string; text: string }
  | { t: 'roster'; list: { id: string; name: string; color: string; connected: boolean }[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'reject'; reason: string }
  | { t: 'saved'; ok: boolean; at: number };

export const FLAG = { ground: 1, crouch: 2, sprint: 4, swim: 8, underwater: 16, downed: 32, dead: 64, sleeping: 128, using: 256 } as const;
