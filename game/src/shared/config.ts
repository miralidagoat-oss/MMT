/**
 * Central tunables. Gameplay code must read numbers from here (or from data
 * definitions in ./defs) instead of embedding magic numbers.
 */
export const GAME_NAME = 'Tidewake';
export const PROTOCOL_VERSION = 3;
export const WORLDGEN_VERSION = 2;
export const SAVE_VERSION = 3;

export const SIM = {
  tickRate: 20,
  get dt() { return 1 / this.tickRate; },
  /** fixed movement sub-step used identically by client prediction and server */
  moveStep: 1 / 60,
  maxPlayers: 4,
  /** inputs older than this many frames are discarded (anti-speedhack buffer cap) */
  maxBufferedInputs: 30,
  /** snapshot send rate (Hz) */
  snapshotRate: 20,
  interestRadius: 260,
  creatureActiveRadius: 180,
  creatureThinkInterval: 4, // ticks between AI decisions (5 Hz at 20 Hz)
  autosaveSeconds: 300,
  disconnectGraceSeconds: 120,
};

export const WORLD = {
  size: 5200, // meters, world spans [-size/2, size/2]
  seaLevel: 0,
  oceanFloor: -48,
  chunkSize: 64,
  islandCount: 13,
  islandMinSpacing: 520,
  startIslandRadius: 230,
};

export const TIME = {
  /** real seconds for a full in-game day (24h) */
  dayLengthSeconds: 30 * 60,
  startHour: 8,
};

export const PLAYER = {
  height: 1.75,
  eyeHeight: 1.62,
  crouchHeight: 1.1,
  radius: 0.35,
  walkSpeed: 3.6,
  sprintSpeed: 6.2,
  crouchSpeed: 1.8,
  swimSpeed: 2.6,
  swimSprintSpeed: 3.9,
  diveSpeed: 2.4,
  jumpVelocity: 5.4,
  gravity: 19.6,
  groundAccel: 50,
  airAccel: 8,
  waterAccel: 8,
  stepHeight: 0.55,
  maxSlope: 0.72, // normal.y below this = too steep to walk
  fallDamageMinSpeed: 11.5,
  fallDamagePerMs: 9,
  interactRange: 3.2,
  reviveSeconds: 4,
  downedSeconds: 40,
  inventorySlots: 24,
  hotbarSlots: 8,
  baseCarryWeight: 40,
  backpackCarryBonus: 25,
  respawnInvulnSeconds: 5,
};

export const SURVIVAL = {
  maxHealth: 100,
  maxStamina: 100,
  maxHunger: 100,
  maxThirst: 100,
  maxOxygen: 100,
  /** points per in-game hour at rest */
  hungerPerHour: 2.6,
  thirstPerHour: 4.4,
  sprintThirstMul: 2.0,
  heatThirstMul: 1.6,
  staminaRegen: 16, // per sec
  staminaRegenDelay: 1.1,
  sprintStaminaCost: 11,
  swimStaminaCost: 4,
  swimSprintStaminaCost: 12,
  jumpStaminaCost: 8,
  oxygenDrainPerSec: 4.5,
  oxygenRegenPerSec: 25,
  drownDamagePerSec: 9,
  starveDamagePerSec: 0.35,
  dehydrateDamagePerSec: 0.6,
  regenPerSecWellFed: 0.35,
  wellFedThreshold: 60,
  bleedDamagePerSec: 0.8,
  poisonDamagePerSec: 0.45,
  bodyTempNormal: 37,
  bodyTempHypo: 35.2,
  bodyTempHyper: 39.2,
  coldDamagePerSec: 0.4,
  heatDamagePerSec: 0.3,
  tempResponse: 0.0045, // body temp approach rate per sec
  wetDrySecondsInSun: 140,
  wetDrySecondsAtFire: 30,
  fireWarmRadius: 5,
  fireWarmth: 14, // ambient-degrees added near fire
  saltWaterThirst: -14,
  saltWaterNauseaSeconds: 40,
};

export const AMBIENT = {
  dayTemp: 30,
  nightTemp: 19,
  waterTempDelta: -6,
  wetTempDelta: -6,
  rainTempDelta: -4,
  stormTempDelta: -6,
  windChillPerMs: 0.35,
  shadeTempDelta: -3,
  shelterTempDelta: 4,
  deepWaterDepth: 18,
};

export const BUILD = {
  grid: 3, // meters per foundation cell
  wallHeight: 3,
  maxFoundationSlope: 1.6, // max terrain height delta across foundation footprint
  maxFoundationWaterDepth: 0.4,
  stiltMaxWaterDepth: 3.5,
  placeRange: 8,
  refundFraction: 0.5,
  maxStructuresPerWorld: 4000,
  snapDistance: 1.2,
};

export const FIRE = {
  maxFuelSeconds: 1200,
  rainFuelDrainMul: 3,
  stormExtinguishChancePerSec: 0.01,
  cookSlots: 3,
  lightRadius: 12,
};

export const FARM = {
  waterDrainPerHour: 6,
  rainWaterPerSec: 0.05,
  witherHoursDry: 36,
};

export const VEHICLE = {
  maxPassengers: 4,
  boardRange: 4,
  repairHpPerAction: 25,
};

export const NET = {
  /** recent action ids remembered per player for duplicate rejection */
  actionDedupeWindow: 256,
  interpolationDelayMs: 110,
  maxMessageBytes: 256 * 1024,
  maxActionsPerSecond: 40,
  heartbeatMs: 2000,
  timeoutMs: 15000,
};
