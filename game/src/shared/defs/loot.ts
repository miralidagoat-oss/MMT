/** Loot tables for wreck crates, supply drops and graves. */
export interface LootEntry { item: string; min: number; max: number; chance: number; durability?: boolean }
export const LOOT_TABLES: Record<string, { rolls: [number, number]; entries: LootEntry[] }> = {
  wreck_shallow: {
    rolls: [3, 5],
    entries: [
      { item: 'cloth', min: 1, max: 3, chance: 0.7 },
      { item: 'scrap_metal', min: 1, max: 3, chance: 0.7 },
      { item: 'rope', min: 2, max: 4, chance: 0.5 },
      { item: 'ration_can', min: 1, max: 2, chance: 0.4 },
      { item: 'bandage', min: 1, max: 2, chance: 0.4 },
      { item: 'copper_wire', min: 1, max: 2, chance: 0.25 },
      { item: 'waterskin', min: 1, max: 1, chance: 0.08 },
      { item: 'compass', min: 1, max: 1, chance: 0.06 },
      { item: 'flint_striker', min: 1, max: 1, chance: 0.06 },
    ],
  },
  wreck_deep: {
    rolls: [3, 5],
    entries: [
      { item: 'circuit_board', min: 1, max: 1, chance: 0.75 },
      { item: 'battery_cell', min: 1, max: 1, chance: 0.75 },
      { item: 'metal_ingot', min: 1, max: 3, chance: 0.5 },
      { item: 'copper_wire', min: 2, max: 4, chance: 0.5 },
      { item: 'ration_can', min: 1, max: 3, chance: 0.4 },
      { item: 'cloth', min: 2, max: 4, chance: 0.4 },
      { item: 'chart', min: 1, max: 1, chance: 0.1 },
    ],
  },
  supply_drop: {
    rolls: [3, 4],
    entries: [
      { item: 'ration_can', min: 1, max: 3, chance: 0.8 },
      { item: 'bandage', min: 2, max: 3, chance: 0.6 },
      { item: 'cloth', min: 2, max: 4, chance: 0.5 },
      { item: 'metal_ingot', min: 1, max: 2, chance: 0.35 },
      { item: 'rope', min: 3, max: 6, chance: 0.5 },
      { item: 'waterskin', min: 1, max: 1, chance: 0.15 },
      { item: 'flint_striker', min: 1, max: 1, chance: 0.15 },
      { item: 'battery_cell', min: 1, max: 1, chance: 0.1 },
    ],
  },
};
