import { BUILD } from '../config';
import type { StructureDef, Ingredient } from './types';

const c = (...pairs: [string, number][]): Ingredient[] => pairs.map(([item, qty]) => ({ item, qty }));
const G = BUILD.grid / 2; // half cell
const H = BUILD.wallHeight;

type Tier = { key: string; label: string; tier: number; hp: number; cost: (n: number) => Ingredient[] };
const TIERS: Tier[] = [
  { key: 'thatch', label: 'Thatch', tier: 0, hp: 120, cost: (n) => c(['stick', 2 * n], ['palm_frond', 2 * n], ['rope', n]) },
  { key: 'wood', label: 'Timber', tier: 1, hp: 350, cost: (n) => c(['plank', 3 * n], ['rope', n]) },
  { key: 'stone', label: 'Brick', tier: 2, hp: 900, cost: (n) => c(['brick', 4 * n], ['clay', n]) },
];

const pieces: StructureDef[] = [];
for (let i = 0; i < TIERS.length; i++) {
  const t = TIERS[i]!;
  const next = TIERS[i + 1];
  const up = (base: string) => (next ? `${next.key}_${base}` : undefined);
  pieces.push(
    {
      id: `${t.key}_foundation`, name: `${t.label} Foundation`, description: 'Level base for a building. Snaps to neighbouring foundations.',
      category: 'foundation', cost: t.cost(2), maxHp: t.hp * 1.5, size: [G, 0.4, G], snap: 'grid', tier: t.tier, upgradesTo: up('foundation'),
      needsSupport: false, solid: true, walkable: true,
    },
    {
      id: `${t.key}_wall`, name: `${t.label} Wall`, description: 'A full wall. Snaps to foundation and floor edges.',
      category: 'wall', cost: t.cost(1), maxHp: t.hp, size: [G, H, 0.12], snap: 'edge', tier: t.tier, upgradesTo: up('wall'),
      needsSupport: true, solid: true,
    },
    {
      id: `${t.key}_doorway`, name: `${t.label} Doorway`, description: 'Wall with an opening. Fit a door into it.',
      category: 'wall', cost: t.cost(1), maxHp: t.hp, size: [G, H, 0.12], snap: 'edge', tier: t.tier, upgradesTo: up('doorway'),
      needsSupport: true, solid: true,
      colliders: [[-1.05, H / 2, 0, 0.45, H / 2, 0.12], [1.05, H / 2, 0, 0.45, H / 2, 0.12], [0, H - 0.4, 0, 0.6, 0.4, 0.12]],
    },
    {
      id: `${t.key}_window`, name: `${t.label} Window Wall`, description: 'Wall with a window opening for light and a view.',
      category: 'wall', cost: t.cost(1), maxHp: t.hp * 0.9, size: [G, H, 0.12], snap: 'edge', tier: t.tier, upgradesTo: up('window'),
      needsSupport: true, solid: true,
    },
    {
      id: `${t.key}_floor`, name: `${t.label} Floor`, description: 'Ceiling for the room below, floor for the room above.',
      category: 'floor', cost: t.cost(2), maxHp: t.hp, size: [G, 0.15, G], snap: 'top', tier: t.tier, upgradesTo: up('floor'),
      needsSupport: true, solid: true, walkable: true, providesShelter: true,
    },
    {
      id: `${t.key}_roof`, name: `${t.label} Roof`, description: 'Sheds rain. Anything under a roof counts as sheltered.',
      category: 'roof', cost: t.cost(2), maxHp: t.hp, size: [G, 1.2, G], snap: 'top', tier: t.tier, upgradesTo: up('roof'),
      needsSupport: true, solid: true, providesShelter: true,
      colliders: [[0, 0.6, 0, G, 0.12, G]],
    },
    {
      id: `${t.key}_stairs`, name: `${t.label} Stairs`, description: 'Climb to the next storey.',
      category: 'stairs', cost: t.cost(2), maxHp: t.hp, size: [G * 0.66, H, G], snap: 'grid', tier: t.tier, upgradesTo: up('stairs'),
      needsSupport: true, solid: true, walkable: true, ramp: true,
    },
  );
}

const UTIL: StructureDef[] = [
  {
    id: 'wood_door', name: 'Timber Door', description: 'Fits a doorway. Interact to open or close.', category: 'door',
    cost: c(['plank', 4], ['rope', 1]), maxHp: 300, size: [0.6, 2.4, 0.08], snap: 'doorway', tier: 1, needsSupport: true, solid: true, door: true,
  },
  {
    id: 'stilt_platform', name: 'Stilt Platform', description: 'A deck on stilts. Can be built in shallow water — build docks and sea-homes.', category: 'foundation',
    cost: c(['log', 4], ['plank', 4], ['rope', 3]), maxHp: 400, size: [G, 0.3, G], snap: 'grid', tier: 1, needsSupport: false, solid: true, walkable: true, allowWater: true,
  },
  {
    id: 'fence', name: 'Stick Fence', description: 'Keeps boars and crabs out of your garden.', category: 'defense',
    cost: c(['stick', 6], ['rope', 2]), maxHp: 150, size: [G, 1.2, 0.08], snap: 'edge', tier: 0, needsSupport: false, solid: true,
  },
  {
    id: 'spike_barricade', name: 'Spike Barricade', description: 'Sharpened stakes. Hurts anything that charges into it.', category: 'defense',
    cost: c(['stick', 8], ['rope', 3]), maxHp: 250, size: [1.4, 1.0, 0.5], snap: 'free', tier: 1, needsSupport: false, solid: true, damageOnTouch: 8,
  },
  {
    id: 'campfire', name: 'Campfire', description: 'Cook food, boil water, keep warm and light the night. Needs fuel and a fire starter.', category: 'station',
    cost: c(['stick', 4], ['stone', 4]), maxHp: 100, size: [0.7, 0.4, 0.7], snap: 'free', tier: 0, needsSupport: false, solid: false,
    station: 'campfire', fire: { cookSlots: 3, warmth: 14, light: 12 }, container: { slots: 3 }, needsHammer: false,
  },
  {
    id: 'workbench', name: 'Workbench', description: 'Unlocks woodworking, leatherwork and tools.', category: 'station',
    cost: c(['log', 2], ['stick', 4], ['rope', 4]), maxHp: 250, size: [1.0, 0.9, 0.55], snap: 'free', tier: 0, needsSupport: false, solid: true, station: 'workbench',
  },
  {
    id: 'kiln', name: 'Clay Kiln', description: 'Fires clay, makes charcoal and smelts metal.', category: 'station',
    cost: c(['clay', 10], ['stone', 6]), maxHp: 500, size: [0.8, 1.6, 0.8], snap: 'free', tier: 1, needsSupport: false, solid: true, station: 'kiln',
    fire: { cookSlots: 0, warmth: 10, light: 6 },
  },
  {
    id: 'forge', name: 'Forge & Anvil', description: 'Metalworking: forged tools, wire, and the distress beacon.', category: 'station',
    cost: c(['brick', 12], ['metal_ingot', 3], ['log', 2]), maxHp: 900, size: [1.2, 1.3, 0.8], snap: 'free', tier: 2, needsSupport: false, solid: true, station: 'forge',
    fire: { cookSlots: 0, warmth: 12, light: 8 },
  },
  {
    id: 'storage_crate', name: 'Storage Crate', description: 'Holds 12 stacks. Shared with your crew.', category: 'storage',
    cost: c(['plank', 6], ['rope', 2]), maxHp: 250, size: [0.55, 0.7, 0.4], snap: 'free', tier: 1, needsSupport: false, solid: true, container: { slots: 12 },
  },
  {
    id: 'large_chest', name: 'Banded Chest', description: 'Holds 24 stacks.', category: 'storage',
    cost: c(['plank', 10], ['metal_ingot', 2]), maxHp: 500, size: [0.75, 0.8, 0.45], snap: 'free', tier: 2, needsSupport: false, solid: true, container: { slots: 24 },
  },
  {
    id: 'rain_catcher', name: 'Rain Catcher', description: 'Collects fresh water when it rains. Fill containers from it.', category: 'utility',
    cost: c(['stick', 4], ['palm_frond', 4], ['rope', 2]), maxHp: 120, size: [0.8, 1.4, 0.8], snap: 'free', tier: 0, needsSupport: false, solid: true,
    rainCatcher: { capacity: 12, perSecond: 0.02 },
  },
  {
    id: 'water_still', name: 'Solar Still', description: 'Slowly turns sea water into fresh water. Faster in sunlight; pour salt water in, draw fresh water out.', category: 'utility',
    cost: c(['clay_pot', 1], ['brick', 4], ['plank', 2], ['resin', 2]), maxHp: 300, size: [0.9, 1.1, 0.9], snap: 'free', tier: 1, needsSupport: false, solid: true,
    still: { capacity: 10, secondsPerUnit: 45 },
  },
  {
    id: 'garden_plot', name: 'Garden Plot', description: 'Raised soil bed for 4 crops. Keep it watered.', category: 'farming',
    cost: c(['plank', 4], ['clay', 2]), maxHp: 200, size: [1.4, 0.4, 1.4], snap: 'free', tier: 1, needsSupport: false, solid: false, walkable: false,
    planter: { plots: 4 },
  },
  {
    id: 'drying_rack', name: 'Drying Rack', description: 'Dries meat, fish and berries into food that never spoils.', category: 'utility',
    cost: c(['stick', 6], ['rope', 3]), maxHp: 120, size: [0.9, 1.6, 0.4], snap: 'free', tier: 0, needsSupport: false, solid: true,
    dryingRack: { slots: 4 },
  },
  {
    id: 'torch_stand', name: 'Torch Stand', description: 'Lights the area. Burns for most of a night; refuel with resin or fat.', category: 'light',
    cost: c(['stick', 3], ['torch', 1]), maxHp: 60, size: [0.15, 1.6, 0.15], snap: 'free', tier: 0, needsSupport: false, solid: false,
    light: { radius: 10, fuelSeconds: 700 },
  },
  {
    id: 'lantern_post', name: 'Lantern Post', description: 'A bright, weatherproof lamp.', category: 'light',
    cost: c(['plank', 2], ['lantern', 1]), maxHp: 200, size: [0.15, 2.2, 0.15], snap: 'free', tier: 2, needsSupport: false, solid: false,
    light: { radius: 16 },
  },
  {
    id: 'lean_to', name: 'Lean-to Shelter', description: 'Rest here to set your respawn point. Keeps the rain off.', category: 'furniture',
    cost: c(['stick', 6], ['palm_frond', 6], ['rope', 2]), maxHp: 150, size: [1.2, 1.6, 1.0], snap: 'free', tier: 0, needsSupport: false, solid: false,
    providesShelter: true, bed: true,
  },
  {
    id: 'bed', name: 'Hammock Bed', description: 'Sets respawn. If every survivor rests at night, time skips to dawn.', category: 'furniture',
    cost: c(['plank', 4], ['cloth', 3], ['rope', 3]), maxHp: 200, size: [1.0, 0.6, 0.5], snap: 'free', tier: 1, needsSupport: false, solid: false, bed: true,
  },
  {
    id: 'signal_beacon', name: 'Distress Beacon', description: 'Install a beacon core and power it from a high peak. Keep it running until rescue arrives.', category: 'special',
    cost: c(['beacon_core', 1], ['metal_ingot', 6], ['plank', 8], ['copper_wire', 4]), maxHp: 1200, size: [0.9, 4.5, 0.9], snap: 'free', tier: 2,
    needsSupport: false, solid: true, beacon: true, minAltitude: 12,
  },
  // vehicles are built with the mallet in water
  {
    id: 'log_raft', name: 'Log Raft', description: 'A paddled raft with a small cargo lashing. Build it in water.', category: 'vehicle',
    cost: c(['log', 8], ['rope', 6], ['stick', 4]), maxHp: 300, size: [1.6, 0.5, 2.2], snap: 'water', tier: 0, needsSupport: false, solid: false, vehicle: 'log_raft',
  },
  {
    id: 'outrigger', name: 'Outrigger Sailboat', description: 'Fast, sail-driven, with a proper cargo hold. Uses the wind.', category: 'vehicle',
    cost: c(['plank', 16], ['rope', 10], ['cloth', 4], ['metal_ingot', 2]), maxHp: 700, size: [1.6, 0.6, 3.4], snap: 'water', tier: 1, needsSupport: false, solid: false, vehicle: 'outrigger',
  },
];

export const STRUCTURE_LIST: StructureDef[] = [...pieces, ...UTIL];
export const STRUCTURES: Readonly<Record<string, StructureDef>> = Object.fromEntries(STRUCTURE_LIST.map((s) => [s.id, s]));
export function structureDef(id: string): StructureDef {
  const d = STRUCTURES[id];
  if (!d) throw new Error(`Unknown structure '${id}'`);
  return d;
}
