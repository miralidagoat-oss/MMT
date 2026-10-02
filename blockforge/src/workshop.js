// Workstations with their own rules: the anvil (repair, combine, rename),
// the loom (patterns on banners) and the beacon (a pyramid's blessing).
import { B, BLOCKS } from './blocks.js';
import { ITEMS, I, BANNER_COLORS } from './items.js';
import { ENCHANTS, applicableEnchants } from './loot.js';
import { BANNER_PATTERNS } from './decor.js';

// ---------------------------------------------------------------------------
// Anvil
export const ANVIL_LIMIT = 39; // survival players cannot pay more than this

// The material that mends an item at the anvil.
export function repairMaterial(id) {
  const d = ITEMS[id];
  if (!d || !d.durability) return 0;
  const n = d.name || '';
  if (n.startsWith('wooden_')) return B.oak_planks;
  if (n.startsWith('stone_')) return B.cobblestone;
  if (n.startsWith('iron_') || n === 'shears' || n === 'flint_and_steel' || n === 'shield') return I.iron_ingot;
  if (n.startsWith('golden_')) return I.gold_ingot;
  if (n.startsWith('diamond_')) return I.diamond;
  if (n.startsWith('leather_') || n === 'glider') return I.leather;
  if (n === 'bow' || n === 'fishing_rod') return I.string;
  if (d.blaster) return I.energy_cell;
  return 0;
}

// What the anvil makes from the left and right stacks, renamed to `name`
// (undefined: keep the name). Returns { out, cost, used } or null; `used` is
// how many of the right stack it takes.
export function anvilResult(a, b, name) {
  if (!a) return null;
  const d = ITEMS[a.id];
  if (!d) return null;
  const out = JSON.parse(JSON.stringify(a));
  let cost = 0, used = 0, changed = false;
  if (b) {
    const material = repairMaterial(a.id);
    if (b.id === a.id && d.durability && a.count === 1) {
      // two of the same: durability adds up (with a bonus), enchantments merge
      const remA = d.durability - (a.dur || 0), remB = d.durability - (b.dur || 0);
      const rem = Math.min(d.durability, remA + remB + Math.floor(d.durability * 0.12));
      out.dur = d.durability - rem;
      if (!out.dur) delete out.dur;
      if (a.dur) cost += 2;
      used = 1; changed = true;
      cost += mergeEnchants(out, b.ench, a.id);
    } else if (b.id === I.enchanted_book && b.ench) {
      // an enchanted book passes its enchantments on (books combine with books too)
      const before = JSON.stringify(out.ench || {});
      if (a.id === I.enchanted_book) {
        out.ench = out.ench || {};
        for (const [k, lvl] of Object.entries(b.ench)) {
          const cur = out.ench[k] || 0;
          out.ench[k] = cur === lvl ? Math.min(ENCHANTS[k].max, lvl + 1) : Math.max(cur, lvl);
          cost += out.ench[k] * 2;
        }
      } else cost += mergeEnchants(out, b.ench, a.id);
      if (JSON.stringify(out.ench || {}) === before) return null;
      used = 1; changed = true;
    } else if (material && b.id === material && a.dur) {
      const per = Math.ceil(d.durability / 4);
      used = Math.min(b.count, Math.ceil(a.dur / per));
      out.dur = Math.max(0, a.dur - used * per);
      if (!out.dur) delete out.dur;
      cost += used; changed = true;
    } else return null;
  }
  if (name !== undefined) {
    const nm = String(name).trim().slice(0, 30);
    if (nm !== (a.label || '')) {
      if (nm) out.label = nm; else delete out.label;
      cost += 1; changed = true;
    }
  }
  if (!changed) return null;
  // every trip to the anvil makes the next one dearer
  const work = a.work || 0;
  cost += (1 << work) - 1;
  out.work = work + 1;
  return { out, cost: Math.max(1, cost), used };
}

// Merge enchantments from `ench` into stack `out`: equal levels step up one,
// otherwise the higher one wins. Returns the extra level cost.
function mergeEnchants(out, ench, id) {
  if (!ench) return 0;
  const ok = applicableEnchants(id);
  let cost = 0;
  out.ench = out.ench || {};
  for (const [k, lvl] of Object.entries(ench)) {
    if (!ok.includes(k)) continue;
    const cur = out.ench[k] || 0;
    const next = cur === lvl ? Math.min(ENCHANTS[k].max, lvl + 1) : Math.max(cur, lvl);
    if (next !== cur) { out.ench[k] = next; cost += next * 2; }
  }
  if (!Object.keys(out.ench).length) delete out.ench;
  return cost;
}

// Anvils wear out: intact -> chipped -> damaged -> gone.
export function wearAnvil(world, x, y, z) {
  if (Math.random() >= 0.12) return 'ok';
  const m = world.getMeta(x, y, z);
  const wear = (m >> 2) & 3;
  if (wear >= 2) { world.setBlock(x, y, z, 0, 0); return 'broke'; }
  world.setBlock(x, y, z, B.anvil, (m & 3) | ((wear + 1) << 2));
  return 'worn';
}

// ---------------------------------------------------------------------------
// Loom: a banner, a wool of the pattern's colour, and a chosen pattern.
// The loom takes a wool or a dye of the pattern's colour.
export const WOOL_COLOR = () => Object.fromEntries([
  ...BANNER_COLORS.map((c, i) => [B[`${c}_wool`], i]), ...BANNER_COLORS.map((c, i) => [I[`${c}_dye`], i]),
].filter(([id]) => id));
export const MAX_PATTERNS = 6;

export function loomResult(banner, wool, pattern) {
  if (!banner || !wool || pattern < 0) return null;
  const d = ITEMS[banner.id];
  if (!d || d.banner === undefined) return null;
  const color = WOOL_COLOR()[wool.id];
  if (color === undefined) return null;
  const bn = (banner.bn || []).slice();
  if (bn.length >= MAX_PATTERNS) return null;
  bn.push([BANNER_PATTERNS[pattern], color]);
  return { ...banner, count: 1, bn };
}

// ---------------------------------------------------------------------------
// Beacon: the pyramid of metal blocks under it sets how strong it is.
const BEACON_BASE = () => new Set([B.iron_block, B.gold_block, B.diamond_block, B.emerald_block]);
export const BEACON_PAYMENT = () => [I.iron_ingot, I.gold_ingot, I.diamond, I.emerald];

export function beaconLevel(world, x, y, z) {
  const base = BEACON_BASE();
  let level = 0;
  for (let l = 1; l <= 4; l++) {
    const yy = y - l;
    for (let dx = -l; dx <= l; dx++) for (let dz = -l; dz <= l; dz++) {
      if (!base.has(world.getBlock(x + dx, yy, z + dz))) return level;
    }
    level = l;
  }
  return level;
}

// Powers by the level needed to choose them.
export const BEACON_POWERS = [
  { effect: 'speed', name: 'Speed', level: 1 },
  { effect: 'jump_boost', name: 'Jump Boost', level: 1 },
  { effect: 'fire_resistance', name: 'Fire Resistance', level: 2 },
  { effect: 'night_vision', name: 'Night Vision', level: 2 },
  { effect: 'strength', name: 'Strength', level: 3 },
];

// Does the beacon see the sky (its beam can rise)?
export function beaconClear(world, x, y, z) {
  for (let yy = y + 1; yy < 256; yy++) {
    const id = world.getBlock(x, yy, z);
    if (!id) continue;
    if (id === B.beacon || /glass|pane/.test((BLOCKS[id] && BLOCKS[id].name) || '')) continue;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Grindstone: strips enchantments (paying back some experience) and joins two
// worn items of the same kind into one.
export function grindstoneResult(a, b) {
  if (!a && !b) return null;
  if (a && b && a.id !== b.id) return null;
  const one = a || b;
  const d = ITEMS[one.id];
  if (!d) return null;
  if (one.id === I.enchanted_book) return a && b ? null : { out: { id: I.book, count: 1 }, xp: xpOf(one.ench) };
  if (!d.durability && !(one.ench)) return null;
  const out = { id: one.id, count: 1 };
  if (one.label) out.label = one.label;
  let xp = xpOf(a && a.ench) + xpOf(b && b.ench);
  if (a && b && d.durability) {
    const rem = Math.min(d.durability, (d.durability - (a.dur || 0)) + (d.durability - (b.dur || 0)) + Math.floor(d.durability * 0.05));
    const dur = d.durability - rem;
    if (dur > 0) out.dur = dur;
  } else if (one.dur) out.dur = one.dur;
  if (!xp && !(a && b)) return null; // nothing to grind off
  return { out, xp };
}
function xpOf(ench) {
  if (!ench) return 0;
  let x = 0;
  for (const lvl of Object.values(ench)) x += lvl * 3;
  return x;
}

// Smithing table: diamond gear plus a starsteel ingot becomes starsteel gear,
// keeping its enchantments, name and wear.
export function smithingResult(base, ingot) {
  if (!base || !ingot || ingot.id !== I.starsteel_ingot) return null;
  const d = ITEMS[base.id];
  if (!d || !d.name.startsWith('diamond_')) return null;
  const to = I['starsteel_' + d.name.slice(8)];
  if (to === undefined) return null;
  const out = { ...JSON.parse(JSON.stringify(base)), id: to, count: 1 };
  if (base.dur) out.dur = Math.round((base.dur / d.durability) * ITEMS[to].durability);
  return out;
}

// Composter: chance that an item raises the fill level.
export const COMPOST_CHANCE = () => {
  const m = new Map();
  const add = (p, ...names) => { for (const n of names) if (I[n] !== undefined) m.set(I[n], p); };
  add(0.3, 'wheat_seeds', 'sweet_berries', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'dark_oak_leaves', 'blossom_leaves',
    'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'dark_oak_sapling', 'blossom_sapling', 'tall_grass', 'fern', 'petals', 'vines');
  add(0.5, 'melon_slice', 'cactus', 'sugar_cane', 'dead_bush');
  add(0.65, 'wheat', 'carrot', 'potato', 'apple', 'dandelion', 'poppy', 'cornflower', 'pumpkin', 'melon', 'brown_mushroom', 'red_mushroom', 'glowcap');
  add(0.85, 'bread', 'baked_potato', 'hay_bale', 'red_mushroom_block', 'brown_mushroom_block');
  add(1, 'cake');
  return m;
};
