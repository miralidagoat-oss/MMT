import type { RecipeDef } from './types';

const r = (id: string, out: [string, number], inputs: [string, number][], station: RecipeDef['station'], seconds: number, category: RecipeDef['category'], extra: Partial<RecipeDef> = {}): RecipeDef => ({
  id, output: { item: out[0], qty: out[1] }, inputs: inputs.map(([item, qty]) => ({ item, qty })), station, seconds, category, ...extra,
});

/**
 * Progression: hand crafting -> workbench -> kiln (clay/smelting) -> forge (metal) -> beacon.
 * Recipes unlock when the player has discovered (held) every input item, unless `starter`.
 */
export const RECIPE_LIST: RecipeDef[] = [
  // --- hand
  r('rope', ['rope', 1], [['fiber', 3]], null, 2, 'basics', { starter: true }),
  r('sharp_stone', ['sharp_stone', 1], [['stone', 2]], null, 2, 'tools', { starter: true }),
  r('stone_axe', ['stone_axe', 1], [['stick', 1], ['stone', 1], ['rope', 1]], null, 4, 'tools', { starter: true }),
  r('stone_pick', ['stone_pick', 1], [['stick', 1], ['stone', 2], ['rope', 1]], null, 4, 'tools', { starter: true }),
  r('build_hammer', ['build_hammer', 1], [['stick', 1], ['stone', 1], ['rope', 1]], null, 4, 'tools', { starter: true }),
  r('crude_spear', ['crude_spear', 1], [['stick', 2], ['sharp_stone', 1], ['rope', 1]], null, 5, 'weapons'),
  r('torch', ['torch', 1], [['stick', 1], ['palm_frond', 1], ['fiber', 2]], null, 3, 'survival', { starter: true }),
  r('hand_drill', ['hand_drill', 1], [['stick', 2], ['fiber', 1]], null, 3, 'survival', { starter: true }),
  r('coconut_flask', ['coconut_flask', 1], [['coconut', 1], ['sharp_stone', 0]], null, 4, 'survival', { unlockBy: ['coconut'] }),
  r('bandage', ['bandage', 1], [['fiber', 4]], null, 3, 'medical', { starter: true }),
  r('bandage_cloth', ['bandage', 2], [['cloth', 1]], null, 2, 'medical'),
  r('leaf_hat', ['leaf_hat', 1], [['palm_frond', 3], ['fiber', 2]], null, 5, 'equipment'),
  r('kelp_rope', ['rope', 1], [['kelp', 2]], null, 2, 'basics'),
  r('splint', ['splint', 1], [['stick', 2], ['fiber', 2]], null, 3, 'medical'),
  r('poultice', ['poultice', 1], [['aloe', 2], ['fiber', 1]], null, 3, 'medical'),
  r('sandals', ['sandals', 1], [['palm_frond', 2], ['rope', 1], ['plank', 1]], null, 5, 'equipment'),
  // --- workbench
  r('plank', ['plank', 2], [['log', 1]], 'workbench', 3, 'materials'),
  r('fishing_rod', ['fishing_rod', 1], [['stick', 2], ['rope', 2], ['bone', 1]], 'workbench', 6, 'tools'),
  r('fishing_rod_shell', ['fishing_rod', 1], [['stick', 2], ['rope', 2], ['shell', 2]], 'workbench', 6, 'tools'),
  r('bow', ['bow', 1], [['stick', 3], ['rope', 3], ['resin', 1]], 'workbench', 8, 'weapons'),
  r('arrow', ['arrow', 4], [['stick', 2], ['flint', 1], ['fiber', 1]], 'workbench', 4, 'weapons'),
  r('bone_knife', ['bone_knife', 1], [['bone', 2], ['rope', 1]], 'workbench', 5, 'tools'),
  r('leather', ['leather', 1], [['hide', 1], ['salt', 1]], 'workbench', 6, 'materials'),
  r('leather_plain', ['leather', 1], [['hide', 2]], 'workbench', 8, 'materials'),
  r('waterskin', ['waterskin', 1], [['leather', 2], ['rope', 1]], 'workbench', 6, 'survival'),
  r('backpack', ['backpack', 1], [['leather', 3], ['rope', 3]], 'workbench', 10, 'equipment'),
  r('hide_vest', ['hide_vest', 1], [['leather', 4], ['rope', 2]], 'workbench', 10, 'equipment'),
  r('dive_goggles', ['dive_goggles', 1], [['shell', 2], ['resin', 2], ['leather', 1]], 'workbench', 8, 'equipment'),
  r('flippers', ['flippers', 1], [['leather', 2], ['plank', 1], ['resin', 1]], 'workbench', 8, 'equipment'),
  r('compass', ['compass', 1], [['scrap_metal', 1], ['shell', 1], ['resin', 1]], 'workbench', 8, 'navigation'),
  r('chart', ['chart', 1], [['leather', 1], ['charcoal', 1]], 'workbench', 6, 'navigation'),
  r('sharkskin_suit', ['sharkskin_suit', 1], [['hide', 4], ['shark_tooth', 2], ['rope', 3], ['resin', 2]], 'workbench', 14, 'equipment', { unlockBy: ['shark_tooth'] }),
  // --- kiln
  r('brick', ['brick', 2], [['clay', 2]], 'kiln', 6, 'materials'),
  r('charcoal', ['charcoal', 2], [['log', 1]], 'kiln', 6, 'materials'),
  r('clay_pot', ['clay_pot', 1], [['clay', 3]], 'kiln', 6, 'survival'),
  r('watering_can', ['watering_can', 1], [['clay', 4]], 'kiln', 8, 'survival'),
  r('metal_ingot', ['metal_ingot', 1], [['scrap_metal', 2], ['charcoal', 1]], 'kiln', 10, 'materials'),
  r('metal_ingot_ore', ['metal_ingot', 1], [['iron_ore', 2], ['charcoal', 1]], 'kiln', 12, 'materials'),
  r('salt', ['salt', 2], [['coral', 1], ['kelp', 1]], 'kiln', 5, 'materials'),
  // --- forge
  r('metal_axe', ['metal_axe', 1], [['metal_ingot', 2], ['plank', 1], ['leather', 1]], 'forge', 12, 'tools'),
  r('metal_pick', ['metal_pick', 1], [['metal_ingot', 2], ['plank', 1], ['leather', 1]], 'forge', 12, 'tools'),
  r('machete', ['machete', 1], [['metal_ingot', 2], ['leather', 1]], 'forge', 12, 'weapons'),
  r('harpoon', ['harpoon', 1], [['metal_ingot', 1], ['plank', 1], ['rope', 2]], 'forge', 10, 'weapons'),
  r('flint_striker', ['flint_striker', 1], [['metal_ingot', 1], ['flint', 1]], 'forge', 6, 'survival'),
  r('lantern', ['lantern', 1], [['metal_ingot', 2], ['resin', 2], ['animal_fat', 1]], 'forge', 10, 'survival'),
  r('spyglass', ['spyglass', 1], [['metal_ingot', 2], ['pearl', 1], ['leather', 1]], 'forge', 12, 'navigation'),
  r('copper_wire', ['copper_wire', 2], [['scrap_metal', 2]], 'forge', 6, 'materials'),
  r('antenna', ['antenna', 1], [['metal_ingot', 3], ['copper_wire', 4]], 'forge', 16, 'advanced'),
  r('beacon_core', ['beacon_core', 1], [['circuit_board', 2], ['battery_cell', 2], ['antenna', 1], ['copper_wire', 4]], 'forge', 30, 'advanced', { unlockBy: ['circuit_board', 'battery_cell'] }),
];

export const RECIPES: Readonly<Record<string, RecipeDef>> = Object.fromEntries(RECIPE_LIST.map((x) => [x.id, x]));
