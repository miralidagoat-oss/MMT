/**
 * Serializable authoritative world state. Everything in WorldState is persisted
 * in saves and owned by the server simulation. Clients hold replicated copies.
 */
import type { EquipSlot, WaterQuality, CreatureKind } from './defs/types';
import type { Vec3 } from './math/vec';

export interface ItemStack {
  id: string;
  qty: number;
  /** remaining durability (uses) for tools/equipment */
  dur?: number;
  /** water units held (water containers) */
  water?: number;
  quality?: WaterQuality;
  /** absolute world time at which this stack spoils */
  spoilAt?: number;
}

export type Slots = (ItemStack | null)[];

export interface Inventory {
  slots: Slots;
  equip: Record<EquipSlot, ItemStack | null>;
}

export interface CraftJob { recipeId: string; remaining: number; total: number }

export interface FishingState {
  phase: 'cast' | 'bite';
  x: number;
  z: number;
  biteAt: number;
  windowEnd: number;
}

export interface Waypoint { id: string; x: number; z: number; label: string; color: string; owner: string }

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  crouching: boolean;
  sprinting: boolean;
  swimming: boolean;
  underwater: boolean; // head below surface
  vehicleId: string | null;
  seat: number;
  health: number;
  stamina: number;
  hunger: number;
  thirst: number;
  oxygen: number;
  bodyTemp: number;
  wetness: number; // 0..1
  /** status effect -> remaining seconds (Infinity-like large values persist until cured) */
  effects: Record<string, number>;
  inventory: Inventory;
  hotbar: number;
  discovered: string[];
  craftQueue: CraftJob[];
  respawn: { x: number; y: number; z: number; structureId: string | null } | null;
  downed: number; // seconds remaining while downed; 0 = not downed
  dead: boolean;
  deathAt: number;
  invulnUntil: number;
  lastInputSeq: number;
  staminaDelay: number;
  lastUseAt: number;
  fishing: FishingState | null;
  sleeping: boolean;
  /** coarse explored-map bitmask (one char per 128m cell, '1' = revealed) as sparse list of cell keys */
  explored: string[];
  /** tutorial / journal milestone ids */
  milestones: string[];
  stats: { deaths: number; crafted: number; harvested: number; distance: number; daysSurvived: number };
  openContainer: string | null;
  lastEnvTemp: number;
}

export interface StructureState {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  owner: string;
  builtAt: number;
  /** door open, fire lit, beacon active ... */
  on?: boolean;
  /** fire/light fuel in seconds */
  fuel?: number;
  /** water units (rain catcher / still output) */
  water?: number;
  /** still input salt water units */
  saltWater?: number;
  /** progress accumulators keyed by slot index */
  progress?: number[];
  crops?: (CropState | null)[];
  containerId?: string;
}

export interface CropState { crop: string; growth: number; water: number; dryHours: number; withered: boolean }

export interface ContainerState {
  id: string;
  kind: 'storage' | 'crate' | 'grave' | 'supply' | 'cargo' | 'station' | 'carcass';
  slots: Slots;
  /** loot table to roll on first open (lazy) */
  loot?: string;
  x: number;
  y: number;
  z: number;
  /** auto-delete when empty (graves, supply drops, carcasses) */
  transient?: boolean;
  label?: string;
}

export interface DroppedItem {
  id: string;
  stack: ItemStack;
  x: number;
  y: number;
  z: number;
  vy: number;
  floating: boolean;
  despawnAt: number;
}

export type CreatureMode = 'idle' | 'wander' | 'feed' | 'flee' | 'chase' | 'attack' | 'circle' | 'dead' | 'return';

export interface CreatureState {
  id: string;
  kind: CreatureKind;
  zone: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  hp: number;
  mode: CreatureMode;
  target: string | null;
  tx: number;
  tz: number;
  ty: number;
  modeUntil: number;
  nextAttackAt: number;
  rng: number;
  diedAt: number;
  butchered: boolean;
  lastHitBy: string | null;
  bleed: number;
}

export interface VehicleState {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vz: number;
  yawRate: number;
  hp: number;
  anchored: boolean;
  sail: boolean;
  seats: (string | null)[];
  containerId: string;
  grounded: boolean;
  owner: string;
}

export interface Projectile {
  id: string;
  owner: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  damage: number;
  dieAt: number;
  item: string;
}

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog';

export interface WeatherState {
  kind: WeatherKind;
  next: WeatherKind;
  /** 0..1 blend from kind -> next */
  blend: number;
  changeAt: number;
  transitionSeconds: number;
  windDir: number;
  windTarget: number;
  /** derived, blended values (replicated) */
  cloud: number;
  rain: number;
  wind: number;
  waves: number;
  fog: number;
  lightningAt: number;
}

export interface WorldEvent {
  id: string;
  kind: 'supply_drop' | 'storm_front' | 'shark_frenzy' | 'fish_run' | 'rescue';
  startedAt: number;
  endsAt: number;
  x: number;
  z: number;
  data?: Record<string, number | string>;
}

export interface GameSettings {
  difficulty: 'relaxed' | 'normal' | 'hard';
  keepInventoryOnDeath: boolean;
  friendlyFire: boolean;
  resourceRespawnMul: number;
  creatureDamageMul: number;
  survivalDrainMul: number;
}

export interface Progression {
  beaconId: string | null;
  beaconStartedAt: number;
  rescueAt: number;
  rescued: boolean;
  /** world milestones (first fire, first raft, discovered islands, etc.) */
  milestones: string[];
  discoveredIslands: number[];
}

export interface WorldState {
  seed: number;
  name: string;
  tick: number;
  time: number; // simulation seconds since world creation
  dayOffset: number; // seconds added to time for clock (start hour, sleep skips)
  settings: GameSettings;
  weather: WeatherState;
  rng: [number, number, number, number];
  nextId: number;
  players: Record<string, PlayerState>;
  nodes: Record<string, { hp?: number; respawnAt?: number }>;
  structures: Record<string, StructureState>;
  containers: Record<string, ContainerState>;
  items: Record<string, DroppedItem>;
  creatures: Record<string, CreatureState>;
  vehicles: Record<string, VehicleState>;
  zones: Record<string, { nextSpawnAt: number }>;
  events: WorldEvent[];
  nextEventAt: number;
  waypoints: Waypoint[];
  progression: Progression;
}

export const DEFAULT_SETTINGS: GameSettings = {
  difficulty: 'normal',
  keepInventoryOnDeath: false,
  friendlyFire: false,
  resourceRespawnMul: 1,
  creatureDamageMul: 1,
  survivalDrainMul: 1,
};
