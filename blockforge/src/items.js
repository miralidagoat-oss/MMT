// Item registry. Block items share their block id (< 256); other items start
// at 256 and use the item texture array.
import { BLOCKS, B, setItemLookup } from './blocks.js';

export const ITEMS = [];      // id -> definition
export const I = {};          // name -> id
export const ITEM_TEXTURES = []; // item texture names in layer order

const TIERS = {
  wooden: { tier: 0, speed: 2, durability: 59, dmg: 0 },
  stone: { tier: 1, speed: 4, durability: 131, dmg: 1 },
  iron: { tier: 2, speed: 6, durability: 250, dmg: 2 },
  golden: { tier: 0, speed: 12, durability: 32, dmg: 0 },
  diamond: { tier: 3, speed: 8, durability: 1561, dmg: 3 },
};
const TOOL_BASE_DMG = { sword: 4, axe: 3, pickaxe: 2, shovel: 2 };

// Register every obtainable block as an item.
for (const b of BLOCKS) {
  if (!b || !b.item) continue;
  ITEMS[b.id] = { id: b.id, name: b.name, display: b.display, block: b.id, maxStack: 64 };
  I[b.name] = b.id;
}
ITEMS[B.cake].maxStack = 1;
ITEMS[B.oak_sign].maxStack = 16;

let nextId = 256;
function item(name, o = {}) {
  const id = nextId++;
  const d = {
    id, name,
    display: o.display || name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
    maxStack: o.maxStack ?? 64,
    tex: ITEM_TEXTURES.length,
    ...o,
  };
  ITEM_TEXTURES.push(o.texName || name);
  ITEMS[id] = d; I[name] = id;
  return d;
}

item('stick', { fuel: 100 });
item('coal', { fuel: 1600 });
item('charcoal', { fuel: 1600 });
item('iron_ingot');
item('gold_ingot');
item('copper_ingot');
item('diamond');
item('emerald');
item('flint');
item('clay_ball');
item('brick');
item('string');
item('feather');
item('leather');
item('bone');
item('snowball', { maxStack: 16 });
item('apple', { food: [4, 2.4] });
item('melon_slice', { food: [2, 1.2] });
item('raw_pork', { display: 'Raw Porkchop', food: [3, 1.8] });
item('cooked_pork', { display: 'Cooked Porkchop', food: [8, 12.8] });
item('raw_beef', { food: [3, 1.8] });
item('cooked_beef', { display: 'Steak', food: [8, 12.8] });
item('raw_mutton', { food: [2, 1.2] });
item('cooked_mutton', { food: [6, 9.6] });
item('raw_chicken', { food: [2, 1.2] });
item('cooked_chicken', { food: [6, 7.2] });
item('tainted_flesh', { food: [4, 0.8] });
item('bucket', { maxStack: 16 });
item('water_bucket', { maxStack: 1, places: B.water, leaves: 'bucket' });
item('lava_bucket', { maxStack: 1, places: B.lava, leaves: 'bucket', fuel: 20000 });
item('shears', { maxStack: 1, durability: 238, tool: { type: 'shears', tier: 0, speed: 5 } });
item('flint_and_steel', { maxStack: 1, durability: 64 });

for (const mat of Object.keys(TIERS)) {
  for (const type of ['pickaxe', 'axe', 'shovel', 'sword']) {
    const t = TIERS[mat];
    item(`${mat}_${type}`, {
      maxStack: 1,
      durability: t.durability,
      tool: { type, tier: t.tier, speed: t.speed },
      damage: TOOL_BASE_DMG[type] + t.dmg,
      fuel: mat === 'wooden' ? 200 : undefined,
    });
  }
}

// --- added after the original set so saved item ids stay stable ---
item('wheat_seeds', { plants: 75 });
item('wheat');
item('bread', { food: [5, 6] });
item('carrot', { food: [3, 3.6], plants: 76 });
item('potato', { food: [1, 0.6], plants: 77 });
item('baked_potato', { food: [5, 6] });
item('bone_meal');
for (const mat of Object.keys(TIERS)) {
  const t = TIERS[mat];
  item(`${mat}_hoe`, { maxStack: 1, durability: t.durability, tool: { type: 'hoe', tier: t.tier, speed: t.speed }, damage: 1, fuel: mat === 'wooden' ? 200 : undefined });
}
item('bow', { maxStack: 1, durability: 384, fuel: 300 });
item('arrow');
export const ARMOR_MATS = {
  leather: { pts: [1, 3, 2, 1], tough: 0, dur: 5, color: [140, 88, 52] },
  golden: { pts: [2, 5, 3, 1], tough: 0, dur: 7, color: [246, 206, 58] },
  iron: { pts: [2, 6, 5, 2], tough: 0, dur: 15, color: [210, 212, 216] },
  diamond: { pts: [3, 8, 6, 3], tough: 2, dur: 33, color: [96, 224, 220] },
};
export const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
const ARMOR_BASE_DUR = [11, 16, 15, 13];
for (const [mat, m] of Object.entries(ARMOR_MATS)) {
  ARMOR_PIECES.forEach((piece, slot) => {
    item(`${mat}_${piece}`, { maxStack: 1, durability: ARMOR_BASE_DUR[slot] * m.dur, armor: { slot, points: m.pts[slot], tough: m.tough, mat } });
  });
}
item('paper');
item('book');
item('clock', { maxStack: 1 });
item('compass', { maxStack: 1 });
item('ember_dust');
item('quartz');
item('gold_nugget');
item('ember_brick');
item('egg', { maxStack: 16 });

// --- round three: circuits, vehicles, brewing, the void, fishing, maps ---
item('spark_dust', { places: 'wire' });
item('minecart', { maxStack: 1 });
item('boat', { maxStack: 1, display: 'Oak Boat', fuel: 1200 });
item('glass_bottle');
item('sugar');
item('glistering_melon', { display: 'Glistering Melon Slice' });
item('golden_carrot', { food: [6, 14.4] });
item('crawler_eye', { food: [2, 3.2], poison: true });
item('fermented_crawler_eye');
item('imp_horn');
item('blast_powder');
item('milk_bucket', { maxStack: 1, drink: true, leaves: 'bucket' });
item('golden_apple', { food: [4, 9.6], always: true });
item('resin');
item('iron_nugget');
// Potions: an item per effect for drinking and for throwing. Strength and
// duration upgrades live on the stack as { pot: { lvl, long } }.
export const POTION_KINDS = [
  'swiftness', 'slowness', 'strength', 'weakness', 'healing', 'harming', 'regeneration', 'poison',
  'fire_resistance', 'water_breathing', 'night_vision', 'invisibility', 'leaping', 'slow_falling',
];
item('potion_water', { maxStack: 1, drink: true, display: 'Water Bottle', potion: 'water', leaves: 'glass_bottle' });
item('potion_awkward', { maxStack: 1, drink: true, display: 'Awkward Potion', potion: 'awkward', leaves: 'glass_bottle' });
for (const k of POTION_KINDS) {
  const nice = k.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  item(`potion_${k}`, { maxStack: 1, drink: true, display: `Potion of ${nice}`, potion: k, leaves: 'glass_bottle' });
  item(`splash_potion_${k}`, { maxStack: 1, display: `Splash Potion of ${nice}`, potion: k, splash: true });
}
item('void_pearl', { maxStack: 16 });
item('star_eye', { display: 'Eye of Stars' });
item('void_fruit', { food: [4, 2.4], always: true });
item('popped_void_fruit');
item('glider', { maxStack: 1, durability: 432, armor: { slot: 1, points: 0, tough: 0, mat: 'glider' } });
item('fishing_rod', { maxStack: 1, durability: 64, fuel: 300 });
item('raw_silverfin', { food: [2, 0.4] });
item('cooked_silverfin', { food: [5, 6] });
item('raw_rosefin', { food: [2, 0.4] });
item('cooked_rosefin', { food: [6, 9.6] });
item('pufferfish', { food: [1, 0.2], poison: true });
item('glimmerfish', { food: [1, 0.2] });
item('empty_map');
item('filled_map', { maxStack: 1, display: 'Map' });
item('shield', { maxStack: 1, durability: 336 });
item('bowl');
item('mushroom_stew', { maxStack: 1, food: [6, 7.2], leaves: 'bowl' });

// --- round four ---
item('photon_blaster', { maxStack: 1, blaster: true, display: 'Photon Blaster' });
item('energy_cell', { maxStack: 16 });
item('sky_rocket', { display: 'Sky Rocket' });
item('saddle', { maxStack: 1 });
item('name_tag');
item('item_frame');
item('painting');
item('star_core', { display: 'Star Core' });
item('tide_shard');
item('tide_crystal');
export const BANNER_COLORS = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black'];
BANNER_COLORS.forEach((c, i) => item(`${c}_banner`, { maxStack: 16, banner: i }));

// --- round five ---
item('sweet_berries', { food: [2, 0.4], plantsOn: 'berry_bush' });
item('honeycomb');
item('honey_bottle', { maxStack: 16, food: [6, 1.2], drink: true, leaves: 'glass_bottle' });
BANNER_COLORS.forEach((c, i) => item(`${c}_dye`, { dye: i }));
item('enchanted_book', { maxStack: 1 });
item('starsteel_scrap');
item('starsteel_ingot');
for (const type of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) {
  item(`starsteel_${type}`, { maxStack: 1, durability: 2031, tool: { type, tier: 4, speed: 9 }, damage: type === 'hoe' ? 1 : TOOL_BASE_DMG[type] + 4, fireproof: true });
}
ARMOR_MATS.starsteel = { pts: [3, 8, 6, 3], tough: 3, dur: 37, color: [74, 64, 96] };
ARMOR_PIECES.forEach((piece, slot) => {
  item(`starsteel_${piece}`, { maxStack: 1, durability: ARMOR_BASE_DUR[slot] * 37, armor: { slot, points: ARMOR_MATS.starsteel.pts[slot], tough: 3, mat: 'starsteel' }, fireproof: true });
});

// --- round six ---
item('lead');
item('journal', { maxStack: 1, display: 'Journal and Quill' });
item('written_journal', { maxStack: 16, display: 'Written Journal' });
item('raw_rabbit', { food: [3, 1.8] });
item('cooked_rabbit', { food: [5, 6] });
item('rabbit_hide');
item('rabbit_foot', { display: "Rabbit's Foot" });
item('goat_horn', { maxStack: 1 });
item('scute');
ARMOR_MATS.turtle = { pts: [2, 0, 0, 0], tough: 0, dur: 25, color: [72, 140, 64] };
item('turtle_shell', { maxStack: 1, durability: 275, armor: { slot: 0, points: 2, tough: 0, mat: 'turtle' } });
item('ink_sac');

// Shaped blocks shown with their own sprite in the inventory and in hand.
for (const b of BLOCKS) {
  if (!b || !b.item || !b.icon || b.icon === 'cube' || !ITEMS[b.id]) continue;
  ITEMS[b.id].tex = ITEM_TEXTURES.length;
  ITEMS[b.id].sprite = true;
  ITEM_TEXTURES.push('block_' + b.icon);
}

setItemLookup((name) => {
  if (I[name] === undefined) throw new Error('unknown item ' + name);
  return I[name];
});

// Block fuel values (ticks).
const BLOCK_FUEL = {
  oak_planks: 300, birch_planks: 300, spruce_planks: 300, oak_log: 300, birch_log: 300,
  spruce_log: 300, crafting_table: 300, bookshelf: 300, chest: 300, ladder: 300,
  jungle_planks: 300, jungle_log: 300, dark_oak_planks: 300, dark_oak_log: 300, jungle_sapling: 100, dark_oak_sapling: 100, loom: 300,
  oak_sapling: 100, birch_sapling: 100, spruce_sapling: 100, coal_block: 16000,
  blossom_planks: 300, blossom_log: 300, blossom_sapling: 100, beehive: 300, composter: 300, lectern: 300, smithing_table: 300,
};
for (const [n, v] of Object.entries(BLOCK_FUEL)) ITEMS[B[n]].fuel = v;

export function itemDef(id) { return ITEMS[id]; }
export function maxStack(id) { return ITEMS[id] ? ITEMS[id].maxStack : 64; }
export function isBlockItem(id) { return id > 0 && id < 256; }
export function itemName(id) { return ITEMS[id] ? ITEMS[id].display : '?'; }
export function findItem(name) {
  if (!name) return undefined;
  const n = name.toLowerCase().replace(/^[a-z]+:/, '').replace(/\s+/g, '_');
  return I[n];
}

// ---------------------------------------------------------------------------
// Crafting recipes. Shaped patterns use single-character keys.
export const RECIPES = [];
function shaped(pattern, keys, result, count = 1) {
  const rows = pattern.map((r) => r.split(''));
  RECIPES.push({ shaped: true, w: rows[0].length, h: rows.length, rows, keys: resolveKeys(keys), result: I[result] ?? result, count });
}
function shapeless(ingredients, result, count = 1) {
  RECIPES.push({ shaped: false, ingredients: ingredients.map((n) => I[n] ?? n), result: I[result] ?? result, count });
}
function resolveKeys(keys) {
  const o = {};
  for (const k in keys) {
    const v = keys[k];
    o[k] = Array.isArray(v) ? v.map((n) => I[n]) : [I[v]];
    if (o[k].some((x) => x === undefined)) throw new Error('bad recipe key ' + v);
  }
  return o;
}

const PLANKS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'dark_oak_planks'];
shapeless(['oak_log'], 'oak_planks', 4);
shapeless(['birch_log'], 'birch_planks', 4);
shapeless(['spruce_log'], 'spruce_planks', 4);
shaped(['P', 'P'], { P: PLANKS }, 'stick', 4);
shaped(['PP', 'PP'], { P: PLANKS }, 'crafting_table');
shaped(['C', 'S'], { C: ['coal', 'charcoal'], S: 'stick' }, 'torch', 4);
shaped(['CCC', 'C C', 'CCC'], { C: 'cobblestone' }, 'furnace');
shaped(['PPP', 'P P', 'PPP'], { P: PLANKS }, 'chest');
shaped(['SS', 'SS'], { S: 'stone' }, 'stone_bricks', 4);
shaped(['SS', 'SS'], { S: 'sand' }, 'sandstone');
shaped(['BB', 'BB'], { B: 'brick' }, 'bricks');
shaped(['SS', 'SS'], { S: 'snowball' }, 'snow_block');
shaped(['SS', 'SS'], { S: 'string' }, 'white_wool');
shaped(['PPP', 'BBB', 'PPP'], { P: PLANKS, B: 'book' }, 'bookshelf');
shaped(['WWW'], { W: 'wheat' }, 'bread');
shaped(['WWW', 'WWW', 'WWW'], { W: 'wheat' }, 'hay_bale');
shapeless(['hay_bale'], 'wheat', 9);
shaped([' SX', 'S X', ' SX'], { S: 'stick', X: 'string' }, 'bow');
shaped(['F', 'S', 'E'], { F: 'flint', S: 'stick', E: 'feather' }, 'arrow', 4);
shaped(['CCC'], { C: 'sugar_cane' }, 'paper', 3);
shapeless(['paper', 'paper', 'paper', 'leather'], 'book');
shaped([' B ', 'DOD', 'OOO'], { B: 'book', D: 'diamond', O: 'obsidian' }, 'enchanting_table');
shaped(['WWW', 'PPP'], { W: ['white_wool', 'red_wool', 'orange_wool', 'yellow_wool', 'green_wool', 'blue_wool', 'purple_wool', 'black_wool'], P: PLANKS }, 'bed');
shaped(['PP', 'PP', 'PP'], { P: PLANKS }, 'oak_door', 3);
shaped(['PSP', 'PSP'], { P: PLANKS, S: 'stick' }, 'oak_fence', 3);
shaped(['SPS', 'SPS'], { P: PLANKS, S: 'stick' }, 'oak_fence_gate');
shaped(['M  ', 'MM ', 'MMM'], { M: PLANKS }, 'oak_stairs', 4);
shaped(['M  ', 'MM ', 'MMM'], { M: 'cobblestone' }, 'cobblestone_stairs', 4);
shaped(['M  ', 'MM ', 'MMM'], { M: 'stone_bricks' }, 'stone_brick_stairs', 4);
shaped(['MMM'], { M: PLANKS }, 'oak_slab', 6);
shaped(['MMM'], { M: 'cobblestone' }, 'cobblestone_slab', 6);
shaped(['MMM'], { M: 'stone' }, 'stone_slab', 6);
shaped([' G ', 'GCG', ' G '], { G: 'gold_ingot', C: 'copper_ingot' }, 'clock');
shaped([' I ', 'ICI', ' I '], { I: 'iron_ingot', C: 'copper_ingot' }, 'compass');
shapeless(['bone'], 'bone_meal', 3);
shaped(['QQ', 'QQ'], { Q: 'quartz' }, 'quartz_block');
shaped(['DD', 'DD'], { D: 'ember_dust' }, 'ember_crystal');
shaped(['BB', 'BB'], { B: 'ember_brick' }, 'ember_bricks');
shaped(['NNN', 'NNN', 'NNN'], { N: 'gold_nugget' }, 'gold_ingot');
shapeless(['gold_ingot'], 'gold_nugget', 9);
for (const [mat, key] of [['leather', 'leather'], ['golden', 'gold_ingot'], ['iron', 'iron_ingot'], ['diamond', 'diamond']]) {
  shaped(['MMM', 'M M'], { M: key }, `${mat}_helmet`);
  shaped(['M M', 'MMM', 'MMM'], { M: key }, `${mat}_chestplate`);
  shaped(['MMM', 'M M', 'M M'], { M: key }, `${mat}_leggings`);
  shaped(['M M', 'M M'], { M: key }, `${mat}_boots`);
}
shaped(['S S', 'SSS', 'S S'], { S: 'stick' }, 'ladder', 3);
shaped(['GGG', 'GTG', 'GGG'], { G: 'glass', T: 'torch' }, 'lamp');
shaped(['I I', ' I '], { I: 'iron_ingot' }, 'bucket');
shaped([' I', 'I '], { I: 'iron_ingot' }, 'shears');
shapeless(['iron_ingot', 'flint'], 'flint_and_steel');
shaped(['FSF', 'SFS', 'FSF'], { F: 'flint', S: 'sand' }, 'tnt');
shapeless(['white_wool', 'dandelion'], 'yellow_wool');
shapeless(['white_wool', 'poppy'], 'red_wool');
shapeless(['white_wool', 'cornflower'], 'blue_wool');
shapeless(['white_wool', 'coal'], 'black_wool');
shapeless(['white_wool', 'cactus'], 'green_wool');
shaped(['MMM', 'MMM', 'MMM'], { M: 'melon_slice' }, 'melon');

// Storage blocks
for (const [mat, blk] of [['iron_ingot', 'iron_block'], ['gold_ingot', 'gold_block'], ['diamond', 'diamond_block'], ['coal', 'coal_block'], ['copper_ingot', 'copper_block'], ['emerald', 'emerald_block']]) {
  shaped(['MMM', 'MMM', 'MMM'], { M: mat }, blk);
  shapeless([blk], mat, 9);
}

// Tools
const MATS = { wooden: PLANKS, stone: ['cobblestone'], iron: ['iron_ingot'], golden: ['gold_ingot'], diamond: ['diamond'] };
for (const [mat, keys] of Object.entries(MATS)) {
  shaped(['MMM', ' S ', ' S '], { M: keys, S: 'stick' }, `${mat}_pickaxe`);
  shaped(['MM', 'MS', ' S'], { M: keys, S: 'stick' }, `${mat}_axe`);
  shaped(['MM', 'SM', 'S '], { M: keys, S: 'stick' }, `${mat}_axe`);
  shaped(['M', 'S', 'S'], { M: keys, S: 'stick' }, `${mat}_shovel`);
  shaped(['M', 'M', 'S'], { M: keys, S: 'stick' }, `${mat}_sword`);
  shaped(['MM', ' S', ' S'], { M: keys, S: 'stick' }, `${mat}_hoe`);
}
shapeless(['cobblestone', 'fern'], 'mossy_cobblestone');

// Spark circuits
shaped(['D', 'S'], { D: 'spark_dust', S: 'stick' }, 'spark_torch');
shaped(['S', 'C'], { S: 'stick', C: 'cobblestone' }, 'lever');
shapeless(['stone'], 'stone_button');
shapeless(['oak_planks'], 'oak_button');
shaped(['SS'], { S: 'stone' }, 'stone_pressure_plate');
shaped(['PP'], { P: PLANKS }, 'oak_pressure_plate');
shaped(['TDT', 'SSS'], { T: 'spark_torch', D: 'spark_dust', S: 'stone' }, 'repeater');
shaped([' D ', 'DLD', ' D '], { D: 'spark_dust', L: 'lamp' }, 'spark_lamp');
shaped(['PPP', 'CIC', 'CDC'], { P: PLANKS, C: 'cobblestone', I: 'iron_ingot', D: 'spark_dust' }, 'piston');
shaped(['R', 'P'], { R: 'resin', P: 'piston' }, 'sticky_piston');
shaped(['PPP', 'PDP', 'PPP'], { P: PLANKS, D: 'spark_dust' }, 'note_block');
shaped(['GGG', 'QQQ', 'SSS'], { G: 'glass', Q: 'quartz', S: 'oak_slab' }, 'daylight_sensor');
shaped(['DDD', 'DDD', 'DDD'], { D: 'spark_dust' }, 'spark_block');
shapeless(['spark_block'], 'spark_dust', 9);
shaped(['PPP', 'PPP'], { P: PLANKS }, 'oak_trapdoor', 2);
shaped(['CCC', 'CBC', 'CDC'], { C: 'cobblestone', B: 'bow', D: 'spark_dust' }, 'dispenser');
shaped(['I I', 'ICI', ' I '], { I: 'iron_ingot', C: 'chest' }, 'hopper');
// Rails and vehicles
shaped(['I I', 'ISI', 'I I'], { I: 'iron_ingot', S: 'stick' }, 'rail', 16);
shaped(['G G', 'GSG', 'GDG'], { G: 'gold_ingot', S: 'stick', D: 'spark_dust' }, 'powered_rail', 6);
shaped(['I I', 'IPI', 'IDI'], { I: 'iron_ingot', P: 'stone_pressure_plate', D: 'spark_dust' }, 'detector_rail', 6);
shaped(['I I', 'III'], { I: 'iron_ingot' }, 'minecart');
shaped(['P P', 'PPP'], { P: PLANKS }, 'boat');
// Brewing
shaped([' H ', 'CCC'], { H: 'imp_horn', C: 'cobblestone' }, 'brewing_stand');
shaped(['G G', ' G '], { G: 'glass' }, 'glass_bottle', 3);
shapeless(['sugar_cane'], 'sugar');
shaped(['NNN', 'NMN', 'NNN'], { N: 'gold_nugget', M: 'melon_slice' }, 'glistering_melon');
shaped(['NNN', 'NCN', 'NNN'], { N: 'gold_nugget', C: 'carrot' }, 'golden_carrot');
shapeless(['crawler_eye', 'brown_mushroom', 'sugar'], 'fermented_crawler_eye');
shapeless(['flint', 'coal'], 'blast_powder', 2);
shapeless(['flint', 'charcoal'], 'blast_powder', 2);
shaped(['PSP', 'SPS', 'PSP'], { P: 'blast_powder', S: 'sand' }, 'tnt');
shaped(['GGG', 'GAG', 'GGG'], { G: 'gold_ingot', A: 'apple' }, 'golden_apple');
shaped(['MMM', 'SES', 'WWW'], { M: 'milk_bucket', S: 'sugar', E: 'egg', W: 'wheat' }, 'cake');
// The void
shapeless(['void_pearl', 'ember_dust'], 'star_eye');
shaped(['DD', 'DD'], { D: 'duskstone' }, 'duskstone_bricks', 4);
shaped(['PP', 'PP'], { P: 'popped_void_fruit' }, 'astral_bricks', 4);
shaped(['B', 'B'], { B: 'astral_bricks' }, 'astral_pillar', 2);
shaped(['P', 'H'], { P: 'popped_void_fruit', H: 'imp_horn' }, 'glow_rod', 4);
// Everything else
shaped(['PPP', 'PCP', 'PPP'], { P: 'paper', C: 'compass' }, 'empty_map');
shaped(['  S', ' SX', 'S X'], { S: 'stick', X: 'string' }, 'fishing_rod');
shaped(['PIP', 'PPP', ' P '], { P: PLANKS, I: 'iron_ingot' }, 'shield');
shaped(['PPP', 'PPP', ' S '], { P: PLANKS, S: 'stick' }, 'oak_sign', 3);
shaped(['GGG', 'GGG'], { G: 'glass' }, 'glass_pane', 16);
shaped(['III', 'III'], { I: 'iron_ingot' }, 'iron_bars', 16);
shapeless(['iron_ingot'], 'iron_nugget', 9);
shaped(['NNN', 'NNN', 'NNN'], { N: 'iron_nugget' }, 'iron_ingot');
shaped(['NNN', 'NTN', 'NNN'], { N: 'iron_nugget', T: 'torch' }, 'lantern');
shaped(['P P', ' P '], { P: PLANKS }, 'bowl', 4);
shapeless(['bowl', 'brown_mushroom', 'red_mushroom'], 'mushroom_stew');
shaped(['SS', 'SS'], { S: 'string' }, 'cobweb');
// Round four
shaped(['IIG', 'SDI', 'I  '], { I: 'iron_ingot', G: 'glass', S: 'spark_block', D: 'diamond' }, 'photon_blaster');
shaped(['NDN', 'DED', 'NDN'], { N: 'iron_nugget', D: 'spark_dust', E: 'ember_dust' }, 'energy_cell', 2);
shapeless(['paper', 'blast_powder'], 'sky_rocket', 3);
shaped(['ISI', 'S S', 'D D'], { I: 'iron_ingot', S: 'leather', D: 'string' }, 'saddle');
shaped(['SSS', 'SLS', 'SSS'], { S: 'stick', L: 'leather' }, 'item_frame');
shaped(['SSS', 'SWS', 'SSS'], { S: 'stick', W: ['white_wool', 'red_wool', 'orange_wool', 'yellow_wool', 'green_wool', 'blue_wool', 'purple_wool', 'black_wool'] }, 'painting');
shaped(['PDP', 'DED', 'PDP'], { P: 'void_pearl', D: 'diamond', E: 'ember_crystal' }, 'star_core');
shaped(['GGG', 'GSG', 'OOO'], { G: 'glass', S: 'star_core', O: 'obsidian' }, 'beacon');
shaped(['BBB', ' I ', 'III'], { B: 'iron_block', I: 'iron_ingot' }, 'anvil');
shaped(['OOO', 'OEO', 'OOO'], { O: 'obsidian', E: 'star_eye' }, 'void_chest');
shaped(['SS', 'PP'], { S: 'string', P: PLANKS }, 'loom');
shaped(['I I', 'I I', 'III'], { I: 'iron_ingot' }, 'cauldron');
shaped(['CCC', 'SDS', 'CCC'], { C: 'cobblestone', S: 'spark_torch', D: 'quartz' }, 'comparator');
shaped(['CCC', 'DDQ', 'CCC'], { C: 'cobblestone', D: 'spark_dust', Q: 'quartz' }, 'observer');
shaped(['CCC', 'C C', 'CDC'], { C: 'cobblestone', D: 'spark_dust' }, 'dropper');
shaped(['SS', 'SS'], { S: 'tide_shard' }, 'tidestone');
shaped(['SSS', 'SSS', 'SSS'], { S: 'tide_shard' }, 'tidestone_bricks');
shaped(['SSS', 'SBS', 'SSS'], { S: 'tide_shard', B: 'black_wool' }, 'dark_tidestone');
shaped(['SCS', 'CCC', 'SCS'], { S: 'tide_shard', C: 'tide_crystal' }, 'lumen_lantern');
shapeless(['jungle_log'], 'jungle_planks', 4);
shapeless(['dark_oak_log'], 'dark_oak_planks', 4);
shaped(['SS', 'SS'], { S: 'red_sand' }, 'sandstone');
shapeless(['carved_pumpkin', 'torch'], 'jack_o_lantern');
shaped(['SS', 'SS'], { S: 'snow_block' }, 'packed_ice');
shaped(['SS', 'SS'], { S: 'sandstone' }, 'chiseled_sandstone', 4);

for (const c of BANNER_COLORS) shaped(['WWW', 'WWW', ' S '], { W: `${c}_wool`, S: 'stick' }, `${c}_banner`);

// round five
const ALL_PLANKS = [...PLANKS, 'blossom_planks'];
shapeless(['blossom_log'], 'blossom_planks', 4);
shaped(['PPP', 'HHH', 'PPP'], { P: ALL_PLANKS, H: 'honeycomb' }, 'beehive');
shaped(['SCS', 'P P'], { S: 'stick', C: 'stone_slab', P: ALL_PLANKS }, 'grindstone');
shaped(['II', 'PP', 'PP'], { I: 'iron_ingot', P: ALL_PLANKS }, 'smithing_table');
shaped(['P P', 'P P', 'PPP'], { P: 'oak_slab' }, 'composter');
shaped(['SSS', ' B ', ' S '], { S: 'oak_slab', B: 'bookshelf' }, 'lectern');
shaped(['III', 'ICI', 'DRD'], { I: 'iron_ingot', C: 'crafting_table', D: 'spark_dust', R: 'dropper' }, 'crafter');
shaped(['SS', 'SS'], { S: 'starsteel_ingot' }, 'starsteel_block');
shaped(['SSS', 'SSS', 'SSS'], { S: 'starsteel_ingot' }, 'starsteel_block');
shapeless(['starsteel_block'], 'starsteel_ingot', 9);
shapeless(['starsteel_scrap', 'starsteel_scrap', 'starsteel_scrap', 'starsteel_scrap', 'gold_ingot', 'gold_ingot', 'gold_ingot', 'gold_ingot'], 'starsteel_ingot');
shapeless(['honey_bottle'], 'sugar', 3);
// dyes from flowers and the like, and mixed dyes
shapeless(['poppy'], 'red_dye');
shapeless(['dandelion'], 'yellow_dye', 2);
shapeless(['cornflower'], 'blue_dye');
shapeless(['bone_meal'], 'white_dye');
shapeless(['coal'], 'black_dye', 2);
shapeless(['charcoal'], 'black_dye', 2);
shapeless(['red_dye', 'yellow_dye'], 'orange_dye', 2);
shapeless(['red_dye', 'blue_dye'], 'purple_dye', 2);
shapeless(['petals'], 'red_dye');
shapeless(['ink_sac'], 'black_dye');
shaped(['SS ', 'SL ', '  S'], { S: 'string', L: 'leather' }, 'lead', 2);
shapeless(['book', 'feather', 'ink_sac'], 'journal');
shapeless(['book', 'feather', 'black_dye'], 'journal');
shaped(['HH', 'HH'], { H: 'rabbit_hide' }, 'leather');
shaped(['SSS', 'S S'], { S: 'scute' }, 'turtle_shell');
// wool takes any colour: one with a dye, or eight around one
for (const c of BANNER_COLORS) {
  const others = BANNER_COLORS.filter((o) => o !== c).map((o) => `${o}_wool`);
  shapeless(['white_wool', `${c}_dye`], `${c}_wool`);
  shaped(['WWW', 'WDW', 'WWW'], { W: ['white_wool', ...others], D: `${c}_dye` }, `${c}_wool`, 8);
}

// Match a crafting grid (array of item ids or 0, size n*n) against recipes.
export function matchRecipe(grid, n) {
  // bounding box of non-empty cells
  let x0 = n, y0 = n, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (grid[y * n + x]) { count++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  if (!count) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  for (const r of RECIPES) {
    if (r.shaped) {
      if (r.w !== w || r.h !== h) continue;
      for (const mirror of [false, true]) {
        let ok = true;
        for (let y = 0; y < h && ok; y++) for (let x = 0; x < w && ok; x++) {
          const rx = mirror ? w - 1 - x : x;
          const k = r.rows[y][rx];
          const g = grid[(y0 + y) * n + x0 + x];
          if (k === ' ') { if (g) ok = false; }
          else if (!g || !r.keys[k].includes(g)) ok = false;
        }
        if (ok) return { id: r.result, count: r.count };
      }
    } else {
      if (r.ingredients.length !== count) continue;
      const need = r.ingredients.slice();
      let ok = true;
      for (let i = 0; i < n * n && ok; i++) {
        const g = grid[i];
        if (!g) continue;
        const j = need.indexOf(g);
        if (j < 0) ok = false; else need.splice(j, 1);
      }
      if (ok && need.length === 0) return { id: r.result, count: r.count };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Furnace recipes: input -> output
export const SMELTING = new Map([
  [B.cobblestone, B.stone], [B.sand, B.glass], [B.iron_ore, I.iron_ingot], [B.gold_ore, I.gold_ingot],
  [B.copper_ore, I.copper_ingot], [B.clay, B.terracotta], [B.oak_log, I.charcoal], [B.birch_log, I.charcoal],
  [B.spruce_log, I.charcoal], [I.clay_ball, I.brick], [I.raw_pork, I.cooked_pork],
  [I.raw_beef, I.cooked_beef], [I.raw_mutton, I.cooked_mutton], [I.raw_chicken, I.cooked_chicken],
  [B.diamond_ore, I.diamond], [B.emerald_ore, I.emerald], [B.coal_ore, I.coal], [B.stone_bricks, B.cobblestone],
  [I.potato, I.baked_potato], [B.scorchstone, I.ember_brick], [B.quartz_ore, I.quartz], [B.ember_gold_ore, I.gold_ingot],
  [B.spark_ore, I.spark_dust], [I.raw_silverfin, I.cooked_silverfin], [I.raw_rosefin, I.cooked_rosefin],
  [I.void_fruit, I.popped_void_fruit], [B.jungle_log, I.charcoal], [B.dark_oak_log, I.charcoal],
  [B.red_sand, B.glass], [B.wet_sponge, B.sponge],
  [B.starsteel_ore, I.starsteel_scrap], [I.raw_rabbit, I.cooked_rabbit], [B.cactus, I.green_dye], [B.blossom_log, I.charcoal],
]);
export const fuelValue = (id) => (ITEMS[id] && ITEMS[id].fuel) || 0;
