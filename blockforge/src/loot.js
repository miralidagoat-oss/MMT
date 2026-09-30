// Loot tables, settler trades and enchantments.
import { I, ITEMS } from './items.js';
import { B } from './blocks.js';

const rint = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// Each entry: [itemId, min, max, weight]
const TABLES = {
  dungeon: { rolls: [3, 7], items: [[I.bread, 1, 3, 12], [I.wheat, 1, 4, 10], [I.iron_ingot, 1, 4, 10], [I.gold_ingot, 1, 3, 5], [I.string, 1, 4, 10], [I.bone, 1, 6, 10], [I.tainted_flesh, 1, 5, 10], [I.coal, 3, 8, 8], [I.apple, 1, 3, 6], [I.bucket, 1, 1, 4], [I.diamond, 1, 2, 2], [I.emerald, 1, 3, 3], [I.arrow, 2, 8, 6], [I.bow, 1, 1, 2], [I.iron_helmet, 1, 1, 2], [I.golden_chestplate, 1, 1, 2], [B.oak_sapling, 1, 2, 3]] },
  village_smith: { rolls: [3, 7], items: [[I.iron_ingot, 1, 5, 12], [I.bread, 1, 3, 12], [I.apple, 1, 3, 10], [I.iron_pickaxe, 1, 1, 5], [I.iron_sword, 1, 1, 5], [I.iron_chestplate, 1, 1, 4], [I.iron_helmet, 1, 1, 4], [I.iron_leggings, 1, 1, 4], [I.iron_boots, 1, 1, 4], [B.obsidian, 3, 7, 4], [B.oak_sapling, 3, 7, 5], [I.gold_ingot, 1, 3, 3], [I.diamond, 1, 3, 1], [I.emerald, 1, 2, 3]] },
  village_house: { rolls: [2, 5], items: [[I.bread, 1, 4, 12], [I.wheat, 2, 7, 10], [I.wheat_seeds, 2, 6, 10], [I.carrot, 1, 4, 8], [I.potato, 1, 4, 8], [I.apple, 1, 3, 8], [I.emerald, 1, 1, 3], [B.torch, 2, 6, 6], [I.paper, 1, 5, 4], [I.book, 1, 1, 2]] },
  underworld: { rolls: [3, 6], items: [[I.gold_ingot, 2, 6, 10], [I.gold_nugget, 4, 12, 10], [I.quartz, 3, 9, 10], [B.obsidian, 1, 4, 6], [I.flint_and_steel, 1, 1, 5], [I.iron_ingot, 1, 5, 8], [I.diamond, 1, 3, 3], [I.golden_sword, 1, 1, 4], [I.golden_helmet, 1, 1, 3], [I.ember_dust, 2, 8, 8], [I.emerald, 1, 3, 3]] },
};

export function rollLoot(table, r = Math.random) {
  const t = TABLES[table];
  if (!t) return [];
  const total = t.items.reduce((a, e) => a + e[3], 0);
  const out = [];
  const n = rint(r, t.rolls[0], t.rolls[1]);
  for (let i = 0; i < n; i++) {
    let x = r() * total;
    for (const [id, min, max, w] of t.items) {
      x -= w;
      if (x <= 0) {
        if (ITEMS[id]) {
          const s = { id, count: rint(r, min, max) };
          if (r() < 0.12 && ITEMS[id].durability) s.ench = randomEnchant(id, 10 + Math.floor(r() * 20), r);
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
  ],
  scholar: [
    () => ({ give: [S(I.paper, 24)], get: E(1) }),
    () => ({ give: [S(I.book, 4)], get: E(1) }),
    () => ({ give: [E(1)], get: S(B.bookshelf) }),
    () => ({ give: [E(4)], get: S(I.compass) }),
    () => ({ give: [E(5)], get: S(I.clock) }),
    () => ({ give: [E(2)], get: S(B.lamp, 2) }),
    () => ({ give: [E(1)], get: S(B.glass, 4) }),
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
  unbreaking: { name: 'Unbreaking', max: 3, for: ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'bow', 'armor', 'shears'] },
  protection: { name: 'Protection', max: 4, for: ['armor'] },
  feather_falling: { name: 'Feather Falling', max: 4, for: ['boots'] },
  power: { name: 'Power', max: 5, for: ['bow'] },
  fortune: { name: 'Fortune', max: 3, for: ['pickaxe'] },
  knockback: { name: 'Knockback', max: 2, for: ['sword'] },
};
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export const enchantLabel = (key, lvl) => `${ENCHANTS[key].name} ${ROMAN[lvl] || lvl}`;

export function itemKind(id) {
  const d = ITEMS[id];
  if (!d) return null;
  if (d.tool) return d.tool.type;
  if (d.armor) return d.armor.slot === 3 ? 'boots' : 'armor';
  if (id === I.bow) return 'bow';
  return null;
}

export function applicableEnchants(id) {
  const kind = itemKind(id);
  if (!kind) return [];
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
