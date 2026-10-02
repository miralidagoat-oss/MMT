import type { ItemDef } from './types';

const R = (id: string, name: string, description: string, shape: string, color: string, weight = 0.5, maxStack = 20, extra: Partial<ItemDef> = {}): ItemDef =>
  ({ id, name, description, category: 'resource', maxStack, weight, icon: { shape, color }, ...extra });

import { TIME } from '../config';

const HOUR = TIME.dayLengthSeconds / 24; // one in-game hour, in simulation seconds
const DAY = HOUR * 24;

export const ITEM_LIST: ItemDef[] = [
  // ---------------------------------------------------------------- raw resources
  R('stick', 'Stick', 'A sturdy length of wood. The backbone of early tools.', 'stick', '#9a6b3c', 0.3, 30, { fuelSeconds: 40, tags: ['fuel'] }),
  R('log', 'Log', 'A heavy section of trunk. Split into planks or burn as fuel.', 'log', '#7a4f2a', 3, 10, { fuelSeconds: 180, tags: ['fuel'] }),
  R('plank', 'Plank', 'Hand-split timber for proper construction.', 'plank', '#c08a52', 1.2, 20, { fuelSeconds: 90, tags: ['fuel'] }),
  R('palm_frond', 'Palm Frond', 'Broad leaves for thatching and kindling.', 'leaf', '#5f9e3a', 0.2, 30, { fuelSeconds: 15, tags: ['fuel'] }),
  R('fiber', 'Plant Fiber', 'Stringy fibers stripped from shrubs.', 'fiber', '#a9c26b', 0.05, 50, { fuelSeconds: 5 }),
  R('rope', 'Cordage', 'Twisted fiber rope. Binds everything together.', 'rope', '#d1b277', 0.1, 30),
  R('stone', 'Stone', 'A fist-sized stone.', 'stone', '#8d8d86', 1, 30),
  R('flint', 'Flint', 'Glassy stone that holds a sharp edge and throws sparks.', 'shard', '#4d5160', 0.4, 30),
  R('clay', 'Clay', 'Wet, workable clay dug from riverbanks and hollows.', 'blob', '#b56a45', 1, 20),
  R('brick', 'Fired Brick', 'Kiln-hardened clay brick.', 'brick', '#a1452e', 1.5, 20),
  R('charcoal', 'Charcoal', 'Burns hot and clean. Essential for smelting.', 'stone', '#262626', 0.3, 30, { fuelSeconds: 300, tags: ['fuel'] }),
  R('resin', 'Tree Resin', 'Sticky sap. Waterproofs, glues and burns.', 'drop', '#d99a2b', 0.1, 30, { fuelSeconds: 60, tags: ['fuel'] }),
  R('shell', 'Seashell', 'A hard, curved shell.', 'shell', '#efe2c9', 0.1, 30),
  R('coral', 'Coral Fragment', 'Brittle reef coral. Ground into lime for mortar.', 'coral', '#f0806a', 0.3, 30),
  R('kelp', 'Kelp', 'Rubbery seaweed. Edible in a pinch, useful as fiber.', 'leaf', '#2f6b3d', 0.1, 30, { food: { nutrition: 4, hydration: 2, spoilSeconds: DAY * 2, spoilsTo: 'spoiled_food', cooksTo: 'dried_kelp', cookSeconds: 20 } , category: 'food' }),
  R('scrap_metal', 'Scrap Metal', 'Corroded salvage from wrecks. Can be smelted.', 'scrap', '#7c8a91', 1, 20),
  R('iron_ore', 'Iron Ore', 'Rust-red ore found in rocky outcrops.', 'stone', '#8c4a35', 2, 20),
  R('metal_ingot', 'Metal Ingot', 'Smelted metal ready for the forge.', 'ingot', '#b9c4cc', 1.5, 20),
  R('copper_wire', 'Copper Wire', 'Salvaged wiring, carefully straightened.', 'rope', '#d27d3a', 0.1, 30),
  R('cloth', 'Cloth', 'Sailcloth and canvas torn from wrecks.', 'cloth', '#d8d2c0', 0.2, 20),
  R('hide', 'Raw Hide', 'An animal hide. Needs drying into leather.', 'hide', '#8a6142', 1, 10),
  R('leather', 'Leather', 'Dried and worked hide.', 'hide', '#6b4527', 0.6, 20),
  R('bone', 'Bone', 'Hard bone, good for hooks and blades.', 'bone', '#e8e1cf', 0.3, 20),
  R('shark_tooth', 'Shark Tooth', 'Serrated and wickedly sharp.', 'tooth', '#f5f2e6', 0.05, 30),
  R('animal_fat', 'Animal Fat', 'Rendered fat. Lamp fuel and waterproofing.', 'blob', '#efe1a0', 0.2, 20, { fuelSeconds: 240, tags: ['fuel', 'lampfuel'] }),
  R('salt', 'Sea Salt', 'Crystals left behind by evaporation. Preserves food.', 'powder', '#f4f4f4', 0.1, 50),
  R('pearl', 'Pearl', 'A rare lustrous pearl. Valued in fine instruments.', 'pearl', '#f7f1ff', 0.02, 20),
  R('obsidian', 'Obsidian', 'Volcanic glass from the black isles.', 'shard', '#1b1530', 0.4, 20),
  // ---------------------------------------------------------------- quest / rare
  R('circuit_board', 'Circuit Board', 'Water-damaged electronics from a sunken vessel. Still salvageable.', 'chip', '#2f8f4e', 0.2, 5, { category: 'quest' }),
  R('battery_cell', 'Battery Cell', 'A sealed marine battery cell with some charge left.', 'battery', '#e0c341', 1, 5, { category: 'quest' }),
  R('antenna', 'Antenna Assembly', 'A forged antenna mast with copper windings.', 'antenna', '#c3c9cf', 2, 2, { category: 'quest' }),
  R('beacon_core', 'Beacon Core', 'The heart of a distress transmitter. Install it in a signal beacon.', 'core', '#5ad1ff', 3, 1, { category: 'quest' }),

  // ---------------------------------------------------------------- tools
  {
    id: 'sharp_stone', name: 'Sharp Stone', description: 'A knapped edge. Cuts fiber, butchers game.', category: 'tool',
    maxStack: 1, weight: 0.5, icon: { shape: 'shard', color: '#9a9a90' }, durability: 60,
    tool: { actions: ['cut'], tier: 0, power: 8, cooldown: 0.6, staminaCost: 2, range: 2.2, damage: 6, bleedChance: 0.15 },
  },
  {
    id: 'stone_axe', name: 'Stone Axe', description: 'A lashed stone head on a stick. Fells palms.', category: 'tool',
    maxStack: 1, weight: 1.5, icon: { shape: 'axe', color: '#8d8d86', accent: '#9a6b3c' }, durability: 120,
    tool: { actions: ['chop', 'cut'], tier: 1, power: 18, cooldown: 0.8, staminaCost: 5, range: 2.6, damage: 12 },
  },
  {
    id: 'stone_pick', name: 'Stone Pick', description: 'Breaks rock, coral and clay.', category: 'tool',
    maxStack: 1, weight: 1.8, icon: { shape: 'pick', color: '#8d8d86', accent: '#9a6b3c' }, durability: 120,
    tool: { actions: ['mine', 'dig'], tier: 1, power: 18, cooldown: 0.85, staminaCost: 5, range: 2.6, damage: 10 },
  },
  {
    id: 'metal_axe', name: 'Forged Axe', description: 'A balanced metal axe. Bites deep into any trunk.', category: 'tool',
    maxStack: 1, weight: 2, icon: { shape: 'axe', color: '#c3c9cf', accent: '#6b4527' }, durability: 400,
    tool: { actions: ['chop', 'cut'], tier: 2, power: 38, cooldown: 0.7, staminaCost: 4, range: 2.7, damage: 20 },
  },
  {
    id: 'metal_pick', name: 'Forged Pick', description: 'Shatters ore veins and boulders.', category: 'tool',
    maxStack: 1, weight: 2.4, icon: { shape: 'pick', color: '#c3c9cf', accent: '#6b4527' }, durability: 400,
    tool: { actions: ['mine', 'dig'], tier: 2, power: 38, cooldown: 0.75, staminaCost: 4, range: 2.7, damage: 16 },
  },
  {
    id: 'machete', name: 'Machete', description: 'Clears brush and fends off beasts.', category: 'weapon',
    maxStack: 1, weight: 1.2, icon: { shape: 'blade', color: '#c3c9cf', accent: '#6b4527' }, durability: 350,
    tool: { actions: ['cut', 'chop', 'hunt'], tier: 2, power: 22, cooldown: 0.5, staminaCost: 3, range: 2.4, damage: 26, bleedChance: 0.35 },
  },
  {
    id: 'bone_knife', name: 'Bone Knife', description: 'A keen knife for butchering and fibers.', category: 'tool',
    maxStack: 1, weight: 0.3, icon: { shape: 'blade', color: '#e8e1cf', accent: '#d1b277' }, durability: 160,
    tool: { actions: ['cut'], tier: 1, power: 14, cooldown: 0.45, staminaCost: 2, range: 2.2, damage: 11, bleedChance: 0.3 },
  },
  {
    id: 'crude_spear', name: 'Crude Spear', description: 'Stab fish underwater or keep boars at bay.', category: 'weapon',
    maxStack: 1, weight: 1.2, icon: { shape: 'spear', color: '#9a6b3c', accent: '#8d8d86' }, durability: 90,
    tool: { actions: ['hunt', 'fish'], tier: 1, power: 6, cooldown: 0.75, staminaCost: 5, range: 3.4, damage: 22, bleedChance: 0.25 },
  },
  {
    id: 'harpoon', name: 'Harpoon', description: 'Barbed metal spear built for big fish — and sharks.', category: 'weapon',
    maxStack: 1, weight: 1.8, icon: { shape: 'spear', color: '#c3c9cf', accent: '#9a6b3c' }, durability: 300,
    tool: { actions: ['hunt', 'fish'], tier: 2, power: 8, cooldown: 0.7, staminaCost: 5, range: 3.8, damage: 42, bleedChance: 0.45 },
  },
  {
    id: 'bow', name: 'Short Bow', description: 'Fires arrows. Draw with primary, release to shoot.', category: 'weapon',
    maxStack: 1, weight: 1, icon: { shape: 'bow', color: '#a77a45', accent: '#d1b277' }, durability: 200,
    tool: { actions: ['hunt'], tier: 1, power: 0, cooldown: 0.9, staminaCost: 4, range: 60, damage: 0, projectile: { ammo: 'arrow', speed: 46, damage: 30 } },
  },
  R('arrow', 'Arrow', 'Flint-tipped arrow.', 'arrow', '#9a6b3c', 0.05, 40, { category: 'ammo', ammo: true }),
  {
    id: 'fishing_rod', name: 'Fishing Rod', description: 'Cast into water, wait for a bite, then reel in at the right moment.', category: 'tool',
    maxStack: 1, weight: 0.8, icon: { shape: 'rod', color: '#9a6b3c', accent: '#e8e1cf' }, durability: 140,
    tool: { actions: ['fish'], tier: 1, power: 0, cooldown: 0.5, staminaCost: 1, range: 18 },
  },
  {
    id: 'build_hammer', name: 'Builder\'s Mallet', description: 'Place, upgrade, repair and dismantle structures. Press the build key to choose a blueprint.', category: 'tool',
    maxStack: 1, weight: 1, icon: { shape: 'hammer', color: '#8d8d86', accent: '#9a6b3c' }, durability: 300,
    tool: { actions: ['build'], tier: 1, power: 0, cooldown: 0.4, staminaCost: 1, range: 8 },
  },
  {
    id: 'hand_drill', name: 'Hand Drill', description: 'Spin to coax an ember. Lights fires (slowly).', category: 'tool',
    maxStack: 1, weight: 0.3, icon: { shape: 'stick', color: '#c08a52', accent: '#ff8a2a' }, durability: 12,
    tool: { actions: ['ignite'], tier: 0, power: 0, cooldown: 1.5, staminaCost: 6, range: 2.5 },
  },
  {
    id: 'flint_striker', name: 'Flint Striker', description: 'Steel on flint. Lights fires reliably.', category: 'tool',
    maxStack: 1, weight: 0.3, icon: { shape: 'shard', color: '#4d5160', accent: '#ffcc33' }, durability: 80,
    tool: { actions: ['ignite'], tier: 1, power: 0, cooldown: 0.5, staminaCost: 1, range: 2.5 },
  },
  {
    id: 'torch', name: 'Torch', description: 'Burning brand. Light in the dark, lights fires, burns down over time.', category: 'tool',
    maxStack: 1, weight: 0.5, icon: { shape: 'torch', color: '#9a6b3c', accent: '#ff9a2a' }, durability: 600,
    burnsWhileHeld: true, lightRadius: 11,
    tool: { actions: ['light', 'ignite'], tier: 0, power: 0, cooldown: 0.6, staminaCost: 1, range: 2.5, damage: 5 },
  },
  {
    id: 'lantern', name: 'Oil Lantern', description: 'A steady, rain-proof light. Burns animal fat.', category: 'tool',
    maxStack: 1, weight: 1, icon: { shape: 'lantern', color: '#c3c9cf', accent: '#ffd36b' }, durability: 1800,
    burnsWhileHeld: true, lightRadius: 16,
    tool: { actions: ['light', 'ignite'], tier: 1, power: 0, cooldown: 0.6, staminaCost: 0, range: 2.5 },
  },
  {
    id: 'watering_can', name: 'Clay Watering Pot', description: 'Carries water to crops. Fill at a rain catcher, still, or the sea (salt water harms crops).', category: 'tool',
    maxStack: 1, weight: 1.4, icon: { shape: 'pot', color: '#b56a45', accent: '#4fa6d8' },
    water: { capacity: 8, hydrationPerUnit: 0 },
    tool: { actions: ['water'], tier: 0, power: 0, cooldown: 0.6, staminaCost: 1, range: 3 },
  },
  {
    id: 'compass', name: 'Compass', description: 'A magnetized needle in a shell housing. Shows heading and bearing to waypoints.', category: 'tool',
    maxStack: 1, weight: 0.2, icon: { shape: 'compass', color: '#efe2c9', accent: '#d64545' },
    tool: { actions: ['navigate'], tier: 0, power: 0, cooldown: 0.5, staminaCost: 0, range: 0 },
  },
  {
    id: 'chart', name: 'Sea Chart', description: 'A leather chart. Fills in as you explore. Open with the map key.', category: 'tool',
    maxStack: 1, weight: 0.3, icon: { shape: 'map', color: '#d8c9a0', accent: '#6b4527' },
    tool: { actions: ['map'], tier: 0, power: 0, cooldown: 0.5, staminaCost: 0, range: 0 },
  },
  {
    id: 'spyglass', name: 'Spyglass', description: 'Hold secondary to zoom. Spot islands and wrecks from afar.', category: 'tool',
    maxStack: 1, weight: 0.6, icon: { shape: 'spyglass', color: '#c9a646', accent: '#6b4527' },
    tool: { actions: ['navigate'], tier: 1, power: 0, cooldown: 0.5, staminaCost: 0, range: 0 },
  },

  // ---------------------------------------------------------------- water containers
  {
    id: 'coconut_flask', name: 'Coconut Flask', description: 'Hollowed coconut. Holds 3 drinks. Fill from clean sources — sea water will make you sicker.', category: 'drink',
    maxStack: 1, weight: 0.4, icon: { shape: 'coconut', color: '#6e4a2a', accent: '#4fa6d8' },
    water: { capacity: 3, hydrationPerUnit: 18 },
  },
  {
    id: 'waterskin', name: 'Waterskin', description: 'Leather bladder. Holds 6 drinks.', category: 'drink',
    maxStack: 1, weight: 0.5, icon: { shape: 'skin', color: '#6b4527', accent: '#4fa6d8' },
    water: { capacity: 6, hydrationPerUnit: 18 },
  },
  {
    id: 'clay_pot', name: 'Clay Pot', description: 'Fire-proof pot. Put it on a campfire with sea water to distill a little fresh water.', category: 'misc',
    maxStack: 4, weight: 1.2, icon: { shape: 'pot', color: '#a1452e' },
    water: { capacity: 2, hydrationPerUnit: 18 },
  },

  // ---------------------------------------------------------------- food
  {
    id: 'coconut', name: 'Coconut', description: 'Crack it open for sweet water and flesh.', category: 'food',
    maxStack: 10, weight: 0.8, icon: { shape: 'coconut', color: '#6e4a2a' },
    food: { nutrition: 8, hydration: 22 }, fuelSeconds: 20,
  },
  R('berries', 'Island Berries', 'Tart red berries. A small snack.', 'berry', '#c2324a', 0.05, 30, { category: 'food', food: { nutrition: 5, hydration: 3, spoilSeconds: DAY * 2, spoilsTo: 'spoiled_food', dryTo: 'dried_berries', drySeconds: HOUR * 6 } }),
  R('dried_berries', 'Dried Berries', 'Chewy and long-lasting.', 'berry', '#7d1e30', 0.04, 30, { category: 'food', food: { nutrition: 6, hydration: 0 } }),
  R('taro_raw', 'Raw Taro', 'Starchy root. Mildly toxic raw — cook it.', 'root', '#8d6aa8', 0.4, 10, { category: 'food', food: { nutrition: 6, hydration: 0, poisonChance: 0.5, spoilSeconds: DAY * 6, spoilsTo: 'spoiled_food', cooksTo: 'taro_cooked', cookSeconds: 25 } }),
  R('taro_cooked', 'Roasted Taro', 'Filling and safe.', 'root', '#c99d6b', 0.4, 10, { category: 'food', food: { nutrition: 28, hydration: 2, spoilSeconds: DAY * 3, spoilsTo: 'spoiled_food', cooksTo: 'burnt_food', cookSeconds: 30 } }),
  R('crab_raw', 'Raw Crab Meat', 'Delicate meat. Cook it.', 'meat', '#e7a28b', 0.2, 10, { category: 'food', food: { nutrition: 6, hydration: 1, poisonChance: 0.35, spoilSeconds: DAY, spoilsTo: 'spoiled_food', cooksTo: 'crab_cooked', cookSeconds: 15 } }),
  R('crab_cooked', 'Cooked Crab', 'Sweet, flaky crab.', 'meat', '#e05a3a', 0.2, 10, { category: 'food', food: { nutrition: 18, hydration: 2, spoilSeconds: DAY * 2, spoilsTo: 'spoiled_food', cooksTo: 'burnt_food', cookSeconds: 25 } }),
  R('fish_raw', 'Raw Fish', 'A fresh reef fish.', 'fish', '#8fb6c9', 0.5, 10, { category: 'food', food: { nutrition: 8, hydration: 2, poisonChance: 0.25, spoilSeconds: DAY, spoilsTo: 'spoiled_food', cooksTo: 'fish_cooked', cookSeconds: 20, dryTo: 'fish_jerky', drySeconds: HOUR * 8 } }),
  R('fish_cooked', 'Grilled Fish', 'Smoky and satisfying.', 'fish', '#c88a4f', 0.5, 10, { category: 'food', food: { nutrition: 26, hydration: 4, spoilSeconds: DAY * 2, spoilsTo: 'spoiled_food', cooksTo: 'burnt_food', cookSeconds: 30 } }),
  R('fish_jerky', 'Fish Jerky', 'Salted and sun-dried. Keeps forever.', 'fish', '#8a5a33', 0.2, 20, { category: 'food', food: { nutrition: 20, hydration: -4 } }),
  R('meat_raw', 'Raw Meat', 'Red meat from game. Must be cooked.', 'meat', '#b8343a', 0.6, 10, { category: 'food', food: { nutrition: 10, hydration: 0, poisonChance: 0.6, spoilSeconds: DAY, spoilsTo: 'spoiled_food', cooksTo: 'meat_cooked', cookSeconds: 30, dryTo: 'meat_jerky', drySeconds: HOUR * 10 } }),
  R('meat_cooked', 'Roast Meat', 'A hearty meal.', 'meat', '#7a3b22', 0.6, 10, { category: 'food', food: { nutrition: 40, hydration: 0, health: 5, spoilSeconds: DAY * 2, spoilsTo: 'spoiled_food', cooksTo: 'burnt_food', cookSeconds: 40 } }),
  R('meat_jerky', 'Jerky', 'Tough, salty, eternal.', 'meat', '#5e2d1a', 0.25, 20, { category: 'food', food: { nutrition: 30, hydration: -6 } }),
  R('shark_raw', 'Raw Shark Steak', 'Dense meat. Smells of ammonia raw.', 'meat', '#d7c7c0', 0.8, 10, { category: 'food', food: { nutrition: 12, hydration: 0, poisonChance: 0.7, spoilSeconds: DAY, spoilsTo: 'spoiled_food', cooksTo: 'shark_cooked', cookSeconds: 40 } }),
  R('shark_cooked', 'Seared Shark', 'A feast fit for a castaway king.', 'meat', '#9b6f52', 0.8, 10, { category: 'food', food: { nutrition: 55, hydration: 0, health: 10, spoilSeconds: DAY * 2, spoilsTo: 'spoiled_food', cooksTo: 'burnt_food', cookSeconds: 45 } }),
  R('dried_kelp', 'Toasted Kelp', 'Crispy, salty sheets.', 'leaf', '#1f4a2a', 0.05, 30, { category: 'food', food: { nutrition: 8, hydration: -2 } }),
  R('ration_can', 'Ration Tin', 'A dented tin of preserved stew from a wreck.', 'can', '#9aa6ad', 0.5, 10, { category: 'food', food: { nutrition: 45, hydration: 8, health: 5 } }),
  R('burnt_food', 'Charred Remains', 'You left it on too long. Barely edible.', 'blob', '#1d1a18', 0.2, 20, { category: 'food', food: { nutrition: 2, hydration: -2 }, fuelSeconds: 20 }),
  R('spoiled_food', 'Spoiled Food', 'Rotten. Eating this is a gamble. Good compost.', 'blob', '#5a6b2a', 0.2, 20, { category: 'food', food: { nutrition: 2, hydration: 0, poisonChance: 0.9 } }),
  R('aloe', 'Aloe Leaf', 'Soothing gel. Heals minor wounds.', 'leaf', '#6fbf8a', 0.1, 20, { category: 'medical', medical: { heal: 8, cures: ['burn'] } }),

  // ---------------------------------------------------------------- medical
  R('bandage', 'Bandage', 'Stops bleeding and patches small wounds.', 'bandage', '#efe9dc', 0.05, 10, { category: 'medical', medical: { heal: 12, cures: ['bleeding'] } }),
  R('poultice', 'Herbal Poultice', 'Aloe and fiber. Cures poisoning and heals.', 'bandage', '#6fbf8a', 0.1, 10, { category: 'medical', medical: { heal: 20, cures: ['poisoned', 'bleeding', 'nausea'] } }),
  R('splint', 'Splint', 'Sets a fractured bone.', 'splint', '#c08a52', 0.3, 5, { category: 'medical', medical: { heal: 5, cures: ['fracture'] } }),

  // ---------------------------------------------------------------- seeds
  R('taro_seed', 'Taro Corm', 'Plant in a garden plot.', 'seed', '#8d6aa8', 0.05, 30, { category: 'seed', seedOf: 'taro' }),
  R('aloe_seed', 'Aloe Cutting', 'Plant in a garden plot.', 'seed', '#6fbf8a', 0.05, 30, { category: 'seed', seedOf: 'aloe' }),
  R('flax_seed', 'Flax Seed', 'Plant for a fiber crop.', 'seed', '#c9c26b', 0.02, 30, { category: 'seed', seedOf: 'flax' }),
  R('berry_seed', 'Berry Seed', 'Plant to grow a berry bush.', 'seed', '#c2324a', 0.02, 30, { category: 'seed', seedOf: 'berry' }),

  // ---------------------------------------------------------------- equipment
  { id: 'leaf_hat', name: 'Woven Leaf Hat', description: 'Keeps the brutal sun off your head.', category: 'equipment', maxStack: 1, weight: 0.3, icon: { shape: 'hat', color: '#9ec46a' }, durability: 600, equip: { slot: 'head', heatProtection: 4 } },
  { id: 'dive_goggles', name: 'Dive Goggles', description: 'Resin-sealed shell lenses. Clearer vision underwater and calmer breathing.', category: 'equipment', maxStack: 1, weight: 0.3, icon: { shape: 'goggles', color: '#5ad1ff', accent: '#6b4527' }, durability: 900, equip: { slot: 'head', underwaterVision: 0.6, oxygenBonus: 0.25 } },
  { id: 'hide_vest', name: 'Hide Vest', description: 'Warm when the night winds bite. Takes the edge off claws.', category: 'equipment', maxStack: 1, weight: 1.5, icon: { shape: 'vest', color: '#6b4527' }, durability: 800, equip: { slot: 'body', insulation: 5, armor: 0.15 } },
  { id: 'sharkskin_suit', name: 'Sharkskin Suit', description: 'Tough and slick. Warm in water and resists bites.', category: 'equipment', maxStack: 1, weight: 2, icon: { shape: 'vest', color: '#5b6b78' }, durability: 1200, equip: { slot: 'body', insulation: 8, armor: 0.3, swimSpeedMul: 1.1 } },
  { id: 'backpack', name: 'Leather Pack', description: 'Carry far more before you tire.', category: 'equipment', maxStack: 1, weight: 1, icon: { shape: 'pack', color: '#7a5233' }, equip: { slot: 'back', carryBonus: 25 } },
  { id: 'flippers', name: 'Flippers', description: 'Swim faster and spend less stamina in the water.', category: 'equipment', maxStack: 1, weight: 0.8, icon: { shape: 'flippers', color: '#2f6b8f' }, durability: 900, equip: { slot: 'feet', swimSpeedMul: 1.35 } },
  { id: 'sandals', name: 'Bark Sandals', description: 'Protects feet from coral and hot sand.', category: 'equipment', maxStack: 1, weight: 0.3, icon: { shape: 'flippers', color: '#9a6b3c' }, durability: 600, equip: { slot: 'feet', heatProtection: 1, armor: 0.05 } },
];

export const ITEMS: Readonly<Record<string, ItemDef>> = Object.fromEntries(ITEM_LIST.map((i) => [i.id, i]));

export function itemDef(id: string): ItemDef {
  const d = ITEMS[id];
  if (!d) throw new Error(`Unknown item '${id}'`);
  return d;
}

export const GAME_HOUR_SECONDS = HOUR;
export const GAME_DAY_SECONDS = DAY;
