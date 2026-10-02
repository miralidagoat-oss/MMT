// Loot tables, settler trades and enchantments.
import { I, ITEMS } from './items.js';
import { B } from './blocks.js';

const rint = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// Each entry: [itemId, min, max, weight]
const TABLES = {
  dungeon: { rolls: [3, 7], items: [[I.spark_dust, 2, 8, 8], [I.minecart, 1, 1, 3], [B.rail, 3, 9, 4], [I.blast_powder, 1, 4, 8], [I.glass_bottle, 1, 2, 4], [I.bread, 1, 3, 12], [I.wheat, 1, 4, 10], [I.iron_ingot, 1, 4, 10], [I.gold_ingot, 1, 3, 5], [I.string, 1, 4, 10], [I.bone, 1, 6, 10], [I.tainted_flesh, 1, 5, 10], [I.coal, 3, 8, 8], [I.apple, 1, 3, 6], [I.bucket, 1, 1, 4], [I.diamond, 1, 2, 2], [I.emerald, 1, 3, 3], [I.arrow, 2, 8, 6], [I.bow, 1, 1, 2], [I.iron_helmet, 1, 1, 2], [I.golden_chestplate, 1, 1, 2], [B.oak_sapling, 1, 2, 3], [I.enchanted_book, 1, 1, 4]] },
  village_smith: { rolls: [3, 7], items: [[I.iron_ingot, 1, 5, 12], [I.bread, 1, 3, 12], [I.apple, 1, 3, 10], [I.iron_pickaxe, 1, 1, 5], [I.iron_sword, 1, 1, 5], [I.iron_chestplate, 1, 1, 4], [I.iron_helmet, 1, 1, 4], [I.iron_leggings, 1, 1, 4], [I.iron_boots, 1, 1, 4], [B.obsidian, 3, 7, 4], [B.oak_sapling, 3, 7, 5], [I.gold_ingot, 1, 3, 3], [I.diamond, 1, 3, 1], [I.emerald, 1, 2, 3]] },
  village_house: { rolls: [2, 5], items: [[I.bread, 1, 4, 12], [I.wheat, 2, 7, 10], [I.wheat_seeds, 2, 6, 10], [I.carrot, 1, 4, 8], [I.potato, 1, 4, 8], [I.apple, 1, 3, 8], [I.emerald, 1, 1, 3], [B.torch, 2, 6, 6], [I.paper, 1, 5, 4], [I.book, 1, 1, 2]] },
  observatory: { rolls: [3, 6], items: [[I.void_pearl, 1, 2, 8], [I.iron_ingot, 1, 5, 10], [I.gold_ingot, 1, 3, 5], [I.bread, 1, 3, 12], [I.apple, 1, 3, 12], [I.spark_dust, 4, 9, 8], [I.diamond, 1, 3, 3], [I.iron_pickaxe, 1, 1, 5], [I.iron_sword, 1, 1, 5], [I.iron_chestplate, 1, 1, 4], [I.golden_apple, 1, 1, 2], [I.star_eye, 1, 1, 2], [B.rail, 4, 12, 6]] },
  observatory_library: { rolls: [2, 6], items: [[I.book, 1, 3, 20], [I.paper, 2, 7, 20], [I.empty_map, 1, 1, 6], [I.compass, 1, 1, 6], [I.glass_bottle, 1, 3, 6], [I.clock, 1, 1, 4], [I.star_eye, 1, 1, 3]] },
  spire: { rolls: [3, 7], items: [[I.diamond, 2, 7, 5], [I.iron_ingot, 4, 8, 10], [I.gold_ingot, 2, 7, 10], [I.emerald, 2, 6, 6], [I.diamond_sword, 1, 1, 3], [I.diamond_chestplate, 1, 1, 3], [I.diamond_pickaxe, 1, 1, 3], [I.iron_helmet, 1, 1, 3], [I.void_pearl, 1, 3, 6], [I.popped_void_fruit, 2, 6, 6], [I.golden_apple, 1, 1, 2], [I.photon_blaster, 1, 1, 3], [I.energy_cell, 1, 4, 6]] },
  spire_glider: { rolls: [2, 4], always: [[I.glider, 1]], items: [[I.diamond, 1, 4, 5], [I.gold_ingot, 2, 6, 10], [I.void_pearl, 1, 3, 6], [I.emerald, 1, 4, 6]] },
  mineshaft: { rolls: [3, 7], items: [[B.rail, 4, 12, 12], [B.powered_rail, 1, 4, 5], [B.torch, 3, 12, 8], [I.bread, 1, 3, 10], [I.coal, 3, 9, 10], [I.iron_ingot, 1, 5, 10], [I.gold_ingot, 1, 3, 5], [I.spark_dust, 4, 9, 5], [I.diamond, 1, 2, 3], [I.iron_pickaxe, 1, 1, 2], [I.name_tag, 1, 1, 3], [I.minecart, 1, 1, 2]] },
  temple: { rolls: [3, 7], items: [[I.bone, 4, 8, 14], [I.tainted_flesh, 3, 7, 14], [I.gold_ingot, 2, 7, 12], [I.iron_ingot, 1, 5, 12], [I.emerald, 1, 3, 10], [I.diamond, 1, 3, 4], [I.saddle, 1, 1, 6], [I.golden_apple, 1, 1, 2], [I.blast_powder, 1, 5, 8], [I.book, 1, 1, 6], [I.name_tag, 1, 1, 4], [I.enchanted_book, 1, 1, 5]] },
  shrine: { rolls: [2, 6], items: [[I.bone, 4, 6, 14], [I.tainted_flesh, 3, 7, 12], [I.gold_ingot, 2, 7, 12], [I.iron_ingot, 1, 5, 10], [I.emerald, 1, 3, 8], [I.diamond, 1, 3, 4], [I.saddle, 1, 1, 5], [I.book, 1, 1, 4], [I.photon_blaster, 1, 1, 1], [I.energy_cell, 1, 3, 3]] },
  hut: { rolls: [2, 4], items: [[I.glass_bottle, 1, 3, 10], [I.sugar, 1, 4, 8], [I.spark_dust, 1, 4, 8], [I.potion_awkward, 1, 1, 6], [I.splash_potion_healing, 1, 1, 3], [I.potion_night_vision, 1, 1, 3], [I.string, 1, 3, 6], [B.red_mushroom, 1, 3, 6], [B.brown_mushroom, 1, 3, 6]] },
  citadel: { rolls: [4, 8], items: [[I.tide_shard, 3, 9, 14], [I.tide_crystal, 2, 6, 12], [I.gold_ingot, 3, 8, 12], [B.gold_block, 1, 2, 4], [I.diamond, 1, 4, 5], [I.emerald, 2, 5, 6], [I.potion_water_breathing, 1, 2, 6], [I.raw_silverfin, 2, 5, 8], [I.diamond_chestplate, 1, 1, 2], [I.sky_rocket, 2, 6, 5]] },
  manor: { rolls: [3, 7], items: [[I.bread, 2, 5, 10], [I.apple, 2, 5, 10], [I.iron_ingot, 2, 6, 10], [I.gold_ingot, 1, 4, 6], [I.diamond, 1, 3, 4], [I.emerald, 2, 6, 6], [I.book, 1, 3, 8], [I.enchanted_book, 1, 1, 5], [I.painting, 1, 2, 6], [I.item_frame, 1, 3, 6], [I.name_tag, 1, 1, 4], [I.diamond_sword, 1, 1, 2], [I.iron_chestplate, 1, 1, 4], [I.golden_apple, 1, 1, 2], [I.photon_blaster, 1, 1, 2], [I.energy_cell, 1, 3, 4]] },
  outpost: { rolls: [3, 6], items: [[I.arrow, 4, 12, 12], [I.wheat, 3, 6, 10], [I.potato, 2, 5, 10], [I.carrot, 2, 5, 10], [I.string, 1, 6, 8], [I.bow, 1, 1, 6], [I.iron_ingot, 1, 3, 6], [I.iron_axe, 1, 1, 3], [I.enchanted_book, 1, 1, 3], [B.dark_oak_log, 2, 6, 6], [I.emerald, 1, 3, 4], [I.sky_rocket, 1, 3, 3]] },
  igloo: { rolls: [2, 5], items: [[I.apple, 1, 3, 12], [I.coal, 1, 4, 12], [I.gold_nugget, 1, 3, 10], [I.wheat, 2, 4, 8], [I.emerald, 1, 1, 4], [I.stone_axe, 1, 1, 4], [I.golden_apple, 1, 1, 2], [I.snowball, 4, 12, 6], [I.potion_slowness, 1, 1, 3]] },
  shipwreck: { rolls: [3, 7], items: [[I.paper, 2, 7, 10], [I.potato, 2, 6, 8], [I.carrot, 2, 6, 8], [I.wheat, 4, 10, 8], [I.coal, 2, 6, 8], [I.feather, 1, 5, 6], [I.leather, 1, 4, 6], [I.emerald, 1, 3, 4], [I.empty_map, 1, 1, 4], [I.clock, 1, 1, 2], [I.compass, 1, 1, 3], [I.leather_helmet, 1, 1, 3], [I.iron_ingot, 1, 3, 4], [I.raw_silverfin, 2, 5, 6]] },
  shipwreck_treasure: { rolls: [4, 8], items: [[I.iron_ingot, 2, 8, 12], [I.gold_ingot, 2, 6, 10], [I.gold_nugget, 4, 12, 10], [I.emerald, 2, 6, 10], [I.diamond, 1, 3, 5], [I.tide_shard, 2, 6, 6], [I.enchanted_book, 1, 1, 4], [I.spark_dust, 3, 8, 6], [I.sky_rocket, 1, 4, 4]] },
  underworld: { rolls: [3, 6], items: [[I.gold_ingot, 2, 6, 10], [I.gold_nugget, 4, 12, 10], [I.quartz, 3, 9, 10], [B.obsidian, 1, 4, 6], [I.flint_and_steel, 1, 1, 5], [I.iron_ingot, 1, 5, 8], [I.diamond, 1, 3, 3], [I.golden_sword, 1, 1, 4], [I.golden_helmet, 1, 1, 3], [I.ember_dust, 2, 8, 8], [I.emerald, 1, 3, 3]] },
};

export function rollLoot(table, r = Math.random) {
  const t = TABLES[table];
  if (!t) return [];
  const total = t.items.reduce((a, e) => a + e[3], 0);
  const out = [];
  for (const [id, count] of t.always || []) out.push({ id, count });
  const n = rint(r, t.rolls[0], t.rolls[1]);
  for (let i = 0; i < n; i++) {
    let x = r() * total;
    for (const [id, min, max, w] of t.items) {
      x -= w;
      if (x <= 0) {
        if (ITEMS[id]) {
          const s = { id, count: rint(r, min, max) };
          if (r() < 0.12 && ITEMS[id].durability) s.ench = randomEnchant(id, 10 + Math.floor(r() * 20), r);
          if (id === I.enchanted_book) { s.count = 1; s.ench = randomEnchant(I.book, 8 + Math.floor(r() * 22), r); }
          out.push(s);
        }
        break;
      }
    }
  }
  // spread over the 27 slots
  const slots = new Array(27).fill(null);
  for (const s of out) {
    let k = Math.floor(r() * 27), guard = 0;
    while (slots[k] && guard++ < 27) k = (k + 1) % 27;
    slots[k] = s;
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Settler trades: { give: [stack, stack?], get: stack, uses, max, xp }
const E = (n) => ({ id: I.emerald, count: n });
const S = (id, n = 1) => ({ id, count: n });
const OFFERS = {
  farmer: [
    () => ({ give: [S(I.wheat, 20)], get: E(1) }),
    () => ({ give: [S(I.sweet_berries, 16)], get: E(1) }),
    () => ({ give: [E(2)], get: S(I.honey_bottle, 2) }),
    () => ({ give: [S(I.carrot, 22)], get: E(1) }),
    () => ({ give: [S(I.potato, 24)], get: E(1) }),
    () => ({ give: [E(1)], get: S(I.bread, 6) }),
    () => ({ give: [E(1)], get: S(I.apple, 4) }),
    () => ({ give: [E(2)], get: S(B.hay_bale, 3) }),
    () => ({ give: [E(1)], get: S(B.melon, 2) }),
  ],
  smith: [
    () => ({ give: [S(I.coal, 15)], get: E(1) }),
    () => ({ give: [S(I.iron_ingot, 4)], get: E(1) }),
    () => ({ give: [E(3)], get: S(I.iron_pickaxe) }),
    () => ({ give: [E(4)], get: S(I.iron_sword) }),
    () => ({ give: [E(2)], get: S(B.grindstone) }),
    () => ({ give: [E(3)], get: S(B.smithing_table) }),
    () => ({ give: [E(5)], get: S(I.iron_chestplate) }),
    () => ({ give: [E(2)], get: S(I.iron_helmet) }),
    () => ({ give: [E(3)], get: S(I.iron_boots) }),
    () => ({ give: [E(12), S(I.book)], get: { id: I.diamond_pickaxe, count: 1, ench: { efficiency: 2, unbreaking: 1 } } }),
  ],
  shepherd: [
    () => ({ give: [S(B.white_wool, 18)], get: E(1) }),
    () => ({ give: [E(1)], get: S(I.shears) }),
    () => ({ give: [E(1)], get: S(B.red_wool, 2) }),
    () => ({ give: [E(1)], get: S(B.blue_wool, 2) }),
    () => ({ give: [E(1)], get: S(B.yellow_wool, 2) }),
    () => ({ give: [E(3)], get: S(B.bed) }),
    () => ({ give: [S(I.red_dye, 12)], get: E(1) }),
    () => ({ give: [E(1)], get: S(I.purple_dye, 3) }),
    () => ({ give: [E(2)], get: S(B.loom) }),
  ],
  scholar: [
    () => ({ give: [S(I.paper, 24)], get: E(1) }),
    () => ({ give: [S(I.book, 4)], get: E(1) }),
    () => ({ give: [E(1)], get: S(B.bookshelf) }),
    () => ({ give: [E(4)], get: S(I.compass) }),
    () => ({ give: [E(5)], get: S(I.clock) }),
    () => ({ give: [E(2)], get: S(B.lamp, 2) }),
    () => ({ give: [E(1)], get: S(B.glass, 4) }),
    () => ({ give: [E(6), S(I.book)], get: { id: I.enchanted_book, count: 1, ench: randomEnchant(I.book, 10 + Math.floor(Math.random() * 20)) } }),
    () => ({ give: [E(3)], get: S(B.lectern) }),
  ],
};

export function makeTrades(profession, r = Math.random) {
  const pool = (OFFERS[profession] || OFFERS.farmer).slice();
  const n = Math.min(pool.length, 4 + Math.floor(r() * 2));
  const out = [];
  // always one way to earn emeralds first
  out.push({ ...pool.shift()(), uses: 0, max: 12, xp: 3 });
  for (let i = 1; i < n; i++) {
    const k = Math.floor(r() * pool.length);
    out.push({ ...pool.splice(k, 1)[0](), uses: 0, max: 8 + Math.floor(r() * 5), xp: 5 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enchantments
export const ENCHANTS = {
  efficiency: { name: 'Efficiency', max: 5, for: ['pickaxe', 'axe', 'shovel', 'hoe', 'shears'] },
  sharpness: { name: 'Sharpness', max: 5, for: ['sword', 'axe'] },
  unbreaking: { name: 'Unbreaking', max: 3, for: ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'bow', 'armor', 'shears', 'blaster'] },
  protection: { name: 'Protection', max: 4, for: ['armor'] },
  feather_falling: { name: 'Feather Falling', max: 4, for: ['boots'] },
  power: { name: 'Power', max: 5, for: ['bow', 'blaster'] },
  rapid_fire: { name: 'Rapid Fire', max: 2, for: ['blaster'] },
  fortune: { name: 'Fortune', max: 3, for: ['pickaxe'] },
  knockback: { name: 'Knockback', max: 2, for: ['sword'] },
};
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export const enchantLabel = (key, lvl) => `${ENCHANTS[key].name} ${ROMAN[lvl] || lvl}`;

export function itemKind(id) {
  const d = ITEMS[id];
  if (!d) return null;
  if (id === I.book || id === I.enchanted_book) return 'book';
  if (d.tool) return d.tool.type;
  if (d.armor) return d.armor.slot === 3 ? 'boots' : 'armor';
  if (id === I.bow) return 'bow';
  if (ITEMS[id].blaster) return 'blaster';
  return null;
}

export function applicableEnchants(id) {
  const kind = itemKind(id);
  if (!kind) return [];
  if (kind === 'book') return Object.keys(ENCHANTS); // a book takes any enchantment
  return Object.keys(ENCHANTS).filter((k) => {
    const f = ENCHANTS[k].for;
    return f.includes(kind) || (kind === 'boots' && f.includes('armor'));
  });
}

// Pick one to three enchantments whose strength scales with the level cost.
export function randomEnchant(id, cost, r = Math.random) {
  const keys = applicableEnchants(id);
  if (!keys.length) return null;
  const out = {};
  const count = 1 + (r() < cost / 50 ? 1 : 0) + (r() < cost / 100 ? 1 : 0);
  const pool = keys.slice();
  for (let i = 0; i < count && pool.length; i++) {
    const k = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const max = ENCHANTS[k].max;
    out[k] = Math.max(1, Math.min(max, Math.round((cost / 30) * max * (0.6 + r() * 0.6))));
  }
  return out;
}

// The three enchanting-table options for an item: [{ cost, ench }]
export function enchantOptions(id, shelves, seed) {
  let s = seed | 0;
  const r = () => { s = (s * 1103515245 + 12345) | 0; return ((s >>> 8) & 0xffff) / 65536; };
  if (!applicableEnchants(id).length) return [];
  const sh = Math.min(15, shelves);
  const base = 1 + Math.floor(r() * 8) + Math.floor(sh / 2) + Math.floor(r() * (sh + 1));
  const costs = [Math.max(Math.floor(base / 3), 1), Math.floor((base * 2) / 3) + 1, Math.max(base, sh * 2)];
  return costs.map((cost) => ({ cost, ench: randomEnchant(id, cost, r) }));
}
