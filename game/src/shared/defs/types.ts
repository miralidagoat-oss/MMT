/** Data-definition types. All content is declared as data in this folder. */

export type ItemCategory =
  | 'resource' | 'tool' | 'weapon' | 'food' | 'drink' | 'medical'
  | 'equipment' | 'seed' | 'ammo' | 'fuel' | 'quest' | 'misc';

export type ToolAction = 'chop' | 'mine' | 'cut' | 'dig' | 'fish' | 'hunt' | 'build' | 'water' | 'ignite' | 'light' | 'navigate' | 'map';

export type EquipSlot = 'head' | 'body' | 'back' | 'feet';

export type WaterQuality = 'salt' | 'clean';

export interface ToolDef {
  actions: ToolAction[];
  tier: number;
  /** damage applied to resource nodes / creatures per swing */
  power: number;
  /** seconds between swings */
  cooldown: number;
  staminaCost: number;
  range: number;
  /** damage dealt to creatures (if weapon) */
  damage?: number;
  /** for ranged weapons */
  projectile?: { ammo: string; speed: number; damage: number };
  /** applies bleeding on hit */
  bleedChance?: number;
}

export interface FoodDef {
  nutrition: number;
  hydration: number;
  health?: number;
  /** seconds (game time) until spoiled; undefined = never spoils */
  spoilSeconds?: number;
  spoilsTo?: string;
  cooksTo?: string;
  cookSeconds?: number;
  /** chance (0..1) of food poisoning when eaten */
  poisonChance?: number;
  dryTo?: string;
  drySeconds?: number;
  cures?: string[];
}

export interface WaterContainerDef {
  capacity: number; // units (1 unit = one drink)
  hydrationPerUnit: number;
}

export interface EquipmentDef {
  slot: EquipSlot;
  insulation?: number; // degrees C of cold protection
  heatProtection?: number;
  carryBonus?: number;
  swimSpeedMul?: number;
  underwaterVision?: number; // 0..1 fog reduction
  oxygenBonus?: number;
  armor?: number; // 0..1 damage reduction
}

export interface IconSpec {
  shape: string;
  color: string;
  accent?: string;
}

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  category: ItemCategory;
  maxStack: number;
  weight: number;
  icon: IconSpec;
  durability?: number;
  tool?: ToolDef;
  food?: FoodDef;
  water?: WaterContainerDef;
  equip?: EquipmentDef;
  medical?: { heal?: number; cures?: string[]; applies?: string };
  fuelSeconds?: number;
  /** torch-like items burn their durability over time while held */
  burnsWhileHeld?: boolean;
  lightRadius?: number;
  seedOf?: string;
  /** tags used for recipe matching (e.g. "fuel", "rope") */
  tags?: string[];
  /** used as ammunition */
  ammo?: boolean;
}

export interface Ingredient { item: string; qty: number }

export type StationKind = 'workbench' | 'kiln' | 'forge' | 'campfire';

export interface RecipeDef {
  id: string;
  output: Ingredient;
  inputs: Ingredient[];
  station: StationKind | null;
  seconds: number;
  /** recipe becomes known once the player has discovered all of these items (defaults to inputs) */
  unlockBy?: string[];
  /** explicitly known from game start */
  starter?: boolean;
  category: 'basics' | 'tools' | 'weapons' | 'survival' | 'materials' | 'equipment' | 'medical' | 'navigation' | 'advanced';
}

export type StructureCategory = 'foundation' | 'wall' | 'floor' | 'roof' | 'stairs' | 'door' | 'utility' | 'storage' | 'station' | 'light' | 'defense' | 'farming' | 'furniture' | 'vehicle' | 'special';

export type SnapKind = 'grid' | 'edge' | 'top' | 'free' | 'doorway' | 'water';

export interface StructureDef {
  id: string;
  name: string;
  description: string;
  category: StructureCategory;
  cost: Ingredient[];
  maxHp: number;
  /** half-extents of collision box (x,y,z) in local space; y is measured up from the origin */
  size: [number, number, number];
  snap: SnapKind;
  tier: number;
  /** id of the piece this one can be upgraded to in-place */
  upgradesTo?: string;
  /** needs to be adjacent/supported by another piece or terrain */
  needsSupport: boolean;
  /** counts as roof/shelter for occupants below */
  providesShelter?: boolean;
  solid: boolean;
  walkable?: boolean;
  container?: { slots: number };
  station?: StationKind;
  fire?: { cookSlots: number; warmth: number; light: number };
  rainCatcher?: { capacity: number; perSecond: number };
  still?: { capacity: number; secondsPerUnit: number };
  planter?: { plots: number };
  dryingRack?: { slots: number };
  light?: { radius: number; fuelSeconds?: number };
  bed?: boolean;
  door?: boolean;
  beacon?: boolean;
  damageOnTouch?: number;
  /** may be placed in water (stilts / docks) */
  allowWater?: boolean;
  /** placement requires min terrain altitude (beacon) */
  minAltitude?: number;
  /** explicit collision boxes in local space: [cx, cy, cz, hx, hy, hz]; defaults to one box from size */
  colliders?: [number, number, number, number, number, number][];
  /** walkable ramp rising along local -Z by size[1] */
  ramp?: boolean;
  /** vehicle spawned by this blueprint */
  vehicle?: string;
  /** cannot be built without a building tool equipped (default true) */
  needsHammer?: boolean;
}

export type CreatureKind = 'crab' | 'boar' | 'snake' | 'fish' | 'shark' | 'ray' | 'gull';

export interface CreatureDef {
  id: CreatureKind;
  name: string;
  habitat: 'beach' | 'land' | 'jungle' | 'shallows' | 'deep' | 'air';
  maxHp: number;
  speed: number;
  runSpeed: number;
  aggression: 'passive' | 'defensive' | 'territorial' | 'predator';
  sightRange: number;
  hearingRange: number;
  attackRange: number;
  attackDamage: number;
  attackCooldown: number;
  bleedChance?: number;
  poisonChance?: number;
  fleeHealthFraction: number;
  loot: { item: string; min: number; max: number; chance?: number }[];
  /** creature carcass requires a cutting tool to harvest */
  butcherTool?: 'cut';
  radius: number;
  aquatic: boolean;
  nocturnalBoost?: number; // multiplier to aggression/range at night
  respawnSeconds: number;
}

export type NodeKind = string;

export interface ResourceNodeDef {
  id: NodeKind;
  name: string;
  /** required tool action, or null for bare-hand gathering */
  action: 'chop' | 'mine' | 'dig' | 'gather';
  minTier: number;
  hp: number;
  yields: { item: string; min: number; max: number; chance?: number }[];
  /** extra yields granted per swing (e.g. chips) */
  perHit?: { item: string; qty: number; chance: number }[];
  respawnSeconds: number;
  radius: number;
  height: number;
  underwater?: boolean;
  /** blocks movement */
  solid: boolean;
}

export interface CropDef {
  id: string;
  name: string;
  seed: string;
  growHours: number;
  stages: number;
  harvest: { item: string; min: number; max: number }[];
  seedReturn: { min: number; max: number };
  minTemp: number;
  maxTemp: number;
  waterNeed: number; // per hour
}
