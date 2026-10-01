// Block registry: ids, rendering properties, physics, tools and drops.
// Shared by the main thread and the generation/meshing workers, so it must
// stay free of DOM access.

// ---------------------------------------------------------------------------
// Texture layers of the block texture array. Order defines layer indices.
// Animated textures reserve FRAMES consecutive layers.
export const ANIM_FRAMES = 16;
const TEX_NAMES = [
  'stone', 'cobblestone', 'mossy_cobblestone', 'stone_bricks', 'dirt', 'grass_top', 'grass_side',
  'snowy_grass_side', 'snow', 'sand', 'sandstone_top', 'sandstone_side', 'sandstone_bottom', 'gravel',
  'clay', 'bedrock', 'oak_log', 'oak_log_top', 'birch_log', 'birch_log_top', 'spruce_log',
  'spruce_log_top', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_leaves', 'birch_leaves',
  'spruce_leaves', 'glass', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore',
  'emerald_ore', 'cactus_side', 'cactus_top', 'cactus_bottom', 'tall_grass', 'fern', 'dandelion',
  'poppy', 'cornflower', 'dead_bush', 'sugar_cane', 'ice', 'obsidian', 'bricks', 'bookshelf',
  'crafting_table_top', 'crafting_table_side', 'crafting_table_front', 'furnace_front',
  'furnace_front_lit', 'furnace_side', 'furnace_top', 'chest_top', 'chest_side', 'chest_front',
  'torch', 'torch_top', 'lamp', 'white_wool', 'red_wool', 'orange_wool', 'yellow_wool', 'green_wool',
  'blue_wool', 'purple_wool', 'black_wool', 'iron_block', 'gold_block', 'diamond_block', 'coal_block',
  'copper_block', 'emerald_block', 'pumpkin_top', 'pumpkin_side', 'melon_top', 'melon_side',
  'oak_sapling', 'birch_sapling', 'spruce_sapling', 'ladder', 'brown_mushroom', 'red_mushroom',
  'tnt_top', 'tnt_side', 'tnt_bottom',
  'crack0', 'crack1', 'crack2', 'crack3', 'crack4', 'crack5', 'crack6', 'crack7', 'crack8', 'crack9',
  'p_flame', 'p_smoke0', 'p_smoke1', 'p_smoke2', 'p_smoke3', 'p_bubble', 'p_splash', 'p_rain',
  'p_snow', 'p_spark', 'p_explosion', 'white',
  'dirt_path_top', 'dirt_path_side', 'farmland', 'farmland_wet',
  'wheat0', 'wheat1', 'wheat2', 'wheat3', 'wheat4', 'wheat5', 'wheat6', 'wheat7',
  'carrots0', 'carrots1', 'carrots2', 'carrots3', 'potatoes0', 'potatoes1', 'potatoes2', 'potatoes3',
  'oak_door_top', 'oak_door_bottom', 'bed_head_top', 'bed_foot_top', 'bed_head_side', 'bed_foot_side',
  'bed_head_end', 'bed_foot_end', 'scorchstone', 'cinder_sand', 'ember_crystal', 'magma_rock',
  'quartz_ore', 'ember_gold_ore', 'glowcap', 'ashen_shrub', 'ember_bricks', 'spawner',
  'enchanting_table_top', 'enchanting_table_side', 'enchanting_table_bottom', 'hay_side', 'hay_top',
  'quartz_block', 'p_portal', 'p_xp', 'p_heart', 'p_glyph', 'p_crit',
  // spark circuits
  'spark_ore', 'spark_line', 'spark_dot', 'spark_torch', 'spark_torch_off', 'spark_torch_top', 'spark_torch_top_off',
  'lever', 'repeater', 'repeater_on', 'spark_lamp', 'spark_lamp_on', 'piston_top', 'piston_top_sticky',
  'piston_side', 'piston_bottom', 'piston_inner', 'note_block', 'daylight_top', 'daylight_side', 'spark_block',
  'oak_trapdoor', 'dispenser_front', 'dispenser_front_v', 'hopper_top', 'hopper_side',
  // rails and brewing
  'rail', 'rail_corner', 'powered_rail', 'powered_rail_on', 'detector_rail', 'detector_rail_on',
  'brewing_base', 'brewing_rod',
  // the void
  'duskstone', 'duskstone_bricks', 'star_frame_top', 'star_frame_side', 'star_frame_eye', 'void_stalk',
  'void_bloom', 'astral_bricks', 'astral_pillar', 'astral_pillar_top', 'glow_rod', 'wyrm_egg',
  // everything else
  'cobweb', 'iron_bars', 'lantern', 'cake_top', 'cake_side', 'cake_inner', 'cake_bottom', 'chain',
  'p_effect', 'p_note', 'p_spark_dust', 'p_void', 'p_fish',
];
const ANIM_NAMES = ['water', 'lava', 'rift', 'fire', 'void_gate'];

export const TEX = {};
export const TEXTURE_LIST = []; // [{name, frame}] per layer
for (const n of TEX_NAMES) { TEX[n] = TEXTURE_LIST.length; TEXTURE_LIST.push({ name: n, frame: 0 }); }
for (const n of ANIM_NAMES) {
  TEX[n] = TEXTURE_LIST.length;
  for (let f = 0; f < ANIM_FRAMES; f++) TEXTURE_LIST.push({ name: n, frame: f });
}
export const TEXTURE_COUNT = TEXTURE_LIST.length;

// Textures whose alpha channel is transparency (cutout/translucent) rather
// than a biome-tint mask. Used for mipmap generation.
export const ALPHA_TEXTURES = new Set([
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'glass', 'tall_grass', 'fern', 'dandelion', 'poppy',
  'cornflower', 'dead_bush', 'sugar_cane', 'torch', 'torch_top', 'oak_sapling', 'birch_sapling',
  'spruce_sapling', 'ladder', 'brown_mushroom', 'red_mushroom', 'ice', 'water',
  'p_flame', 'p_smoke0', 'p_smoke1', 'p_smoke2', 'p_smoke3', 'p_bubble', 'p_splash', 'p_rain',
  'p_snow', 'p_spark', 'p_explosion', 'cactus_side', 'cactus_top', 'cactus_bottom',
  'wheat0', 'wheat1', 'wheat2', 'wheat3', 'wheat4', 'wheat5', 'wheat6', 'wheat7',
  'carrots0', 'carrots1', 'carrots2', 'carrots3', 'potatoes0', 'potatoes1', 'potatoes2', 'potatoes3',
  'oak_door_top', 'oak_door_bottom', 'glowcap', 'ashen_shrub', 'spawner', 'rift',
  'p_portal', 'p_xp', 'p_heart', 'p_glyph', 'p_crit',
  'spark_line', 'spark_dot', 'spark_torch', 'spark_torch_off', 'spark_torch_top', 'spark_torch_top_off', 'lever',
  'rail', 'rail_corner', 'powered_rail', 'powered_rail_on', 'detector_rail', 'detector_rail_on', 'brewing_rod',
  'void_stalk', 'glow_rod', 'cobweb', 'iron_bars', 'lantern', 'chain', 'fire', 'oak_trapdoor', 'hopper_top',
  'p_effect', 'p_note', 'p_spark_dust', 'p_void', 'p_fish',
]);

// ---------------------------------------------------------------------------
export const RENDER = {
  NONE: 0, CUBE: 1, CROSS: 2, TORCH: 3, LIQUID: 4, CACTUS: 5, LADDER: 6, SHAPE: 7, CROP: 8, PORTAL: 9,
  WIRE: 10, RAIL: 11, FIRE: 12, VOIDGATE: 13,
};
export const PASS = { OPAQUE: 0, CUTOUT: 1, TRANSLUCENT: 2 };

export const B = {}; // name -> id
export const BLOCKS = []; // id -> definition

const MAX = 256;
export const OPAQUE = new Uint8Array(MAX);     // full opaque cube (culls neighbours, casts AO)
export const SOLID = new Uint8Array(MAX);      // has collision
export const RENDER_TYPE = new Uint8Array(MAX);
export const RENDER_PASS = new Uint8Array(MAX);
export const EMIT = new Uint8Array(MAX);       // light emission 0..15
export const OPACITY = new Uint8Array(MAX);    // light attenuation 0..15
export const TINT = new Uint8Array(MAX);       // 0 none, 1 grass, 2 foliage, 3 water, 4 birch, 5 spruce
export const WAVE = new Uint8Array(MAX);       // 1 leaves, 2 plants
export const SELF_CULL = new Uint8Array(MAX);  // faces between two blocks of the same id are hidden
export const REPLACEABLE = new Uint8Array(MAX);
export const FACE_TEX = new Uint16Array(MAX * 6);
export const SHAPE_KIND = new Uint8Array(MAX); // shapes.js SHAPE for RENDER.SHAPE blocks

const TOOL_NONE = null;

function def(id, name, o = {}) {
  const d = {
    id, name,
    display: o.display || name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
    render: o.render ?? RENDER.CUBE,
    pass: o.pass ?? PASS.OPAQUE,
    opaque: o.opaque ?? true,
    solid: o.solid ?? true,
    light: o.light ?? 0,
    opacity: o.opacity ?? (o.opaque === false ? 0 : 15),
    hardness: o.hardness ?? 1,
    tool: o.tool ?? TOOL_NONE,
    level: o.level ?? 0,
    requiresTool: o.requiresTool ?? false,
    drops: o.drops, // function(rand, toolInfo) -> [[id,count],...] | undefined = self
    sound: o.sound || 'stone',
    tint: o.tint || 0,
    wave: o.wave || 0,
    selfCull: o.selfCull ?? false,
    replaceable: o.replaceable ?? false,
    gravity: o.gravity ?? false,
    friction: o.friction ?? 0.6,
    support: o.support || null, // 'ground' | 'wall' | 'sand' | 'cane' | 'cactus'
    orient: o.orient || null,   // 'axis' | 'facing' | 'torch' | 'wall'
    faces: o.faces,
    item: o.item ?? true,       // obtainable as an inventory item
    flammable: o.flammable ?? false,
    creative: o.creative ?? true,
    shape: o.shape || 0,
    slow: o.slow || 0,
    icon: o.icon || null,
    iconMeta: o.iconMeta || 0,       // 'cube' draws a cube icon for a shaped block; any other string names an item sprite
    spark: o.spark || null,     // role in spark circuits
    burn: o.burn ?? (o.flammable ? 0.3 : 0), // chance per fire tick of catching fire
  };
  BLOCKS[id] = d; B[name] = id;
  OPAQUE[id] = d.opaque && d.render === RENDER.CUBE && d.pass === PASS.OPAQUE ? 1 : 0;
  SOLID[id] = d.solid ? 1 : 0;
  RENDER_TYPE[id] = d.render;
  RENDER_PASS[id] = d.pass;
  EMIT[id] = d.light;
  OPACITY[id] = d.opacity;
  TINT[id] = d.tint;
  WAVE[id] = d.wave;
  SELF_CULL[id] = d.selfCull ? 1 : 0;
  REPLACEABLE[id] = d.replaceable ? 1 : 0;
  SHAPE_KIND[id] = d.shape;
  // faces: string (all), or {top,bottom,side,front}
  const f = o.faces ?? name;
  const t = (n) => {
    if (TEX[n] === undefined) throw new Error('missing texture ' + n);
    return TEX[n];
  };
  let arr;
  if (typeof f === 'string') arr = [f, f, f, f, f, f];
  else {
    const side = f.side ?? f.all;
    arr = [f.top ?? f.all ?? side, f.bottom ?? f.top ?? f.all ?? side, side, side, side, side];
  }
  for (let i = 0; i < 6; i++) FACE_TEX[id * 6 + i] = t(arr[i]);
  if (o.faces && o.faces.front) d.frontTex = t(o.faces.front);
  if (o.faces && o.faces.frontLit) d.frontLitTex = t(o.faces.frontLit);
  return d;
}

// Shorthands
const stoneLike = (o = {}) => ({ hardness: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'stone', ...o });
const plant = (o = {}) => ({
  render: RENDER.CROSS, pass: PASS.CUTOUT, opaque: false, solid: false, hardness: 0,
  sound: 'grass', replaceable: false, support: 'ground', wave: 2, ...o,
});
const woodLike = (o = {}) => ({ hardness: 2, tool: 'axe', sound: 'wood', flammable: true, ...o });
const one = (id, n = 1) => () => [[id, n]];

def(0, 'air', { render: RENDER.NONE, opaque: false, solid: false, replaceable: true, faces: 'white', item: false, creative: false, hardness: 0 });
def(1, 'stone', stoneLike({ drops: () => [[B.cobblestone, 1]] }));
def(2, 'grass', { display: 'Grass Block', hardness: 0.6, tool: 'shovel', sound: 'grass', tint: 1, faces: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, drops: () => [[B.dirt, 1]] });
def(3, 'dirt', { hardness: 0.5, tool: 'shovel', sound: 'gravel' });
def(4, 'cobblestone', stoneLike({ hardness: 2 }));
def(5, 'oak_planks', woodLike());
def(6, 'bedrock', { hardness: -1, sound: 'stone', creative: true });
def(7, 'sand', { hardness: 0.5, tool: 'shovel', sound: 'sand', gravity: true });
def(8, 'gravel', {
  hardness: 0.6, tool: 'shovel', sound: 'gravel', gravity: true,
  drops: (r) => (r() < 0.1 ? [[I_('flint'), 1]] : [[B.gravel, 1]]),
});
def(9, 'oak_log', woodLike({ orient: 'axis', faces: { top: 'oak_log_top', side: 'oak_log' } }));
def(10, 'oak_leaves', {
  pass: PASS.CUTOUT, opaque: false, opacity: 1, hardness: 0.2, tool: 'shears', sound: 'grass',
  tint: 2, wave: 1, flammable: true,
  drops: (r) => {
    const out = [];
    if (r() < 0.05) out.push([B.oak_sapling, 1]);
    if (r() < 0.02) out.push([I_('apple'), 1]);
    return out;
  },
});
def(11, 'glass', { pass: PASS.CUTOUT, opaque: false, opacity: 0, hardness: 0.3, sound: 'glass', selfCull: true, drops: () => [] });
def(12, 'water', {
  render: RENDER.LIQUID, pass: PASS.TRANSLUCENT, opaque: false, solid: false, opacity: 1,
  hardness: -1, replaceable: true, tint: 3, item: false, creative: false, faces: 'water',
});
def(13, 'lava', {
  render: RENDER.LIQUID, pass: PASS.OPAQUE, opaque: false, solid: false, opacity: 0, light: 15,
  hardness: -1, replaceable: true, item: false, creative: false, faces: 'lava',
});
def(14, 'coal_ore', stoneLike({ hardness: 3, drops: () => [[I_('coal'), 1]] }));
def(15, 'iron_ore', stoneLike({ hardness: 3, level: 1 }));
def(16, 'copper_ore', stoneLike({ hardness: 3, level: 1 }));
def(17, 'gold_ore', stoneLike({ hardness: 3, level: 2 }));
def(18, 'diamond_ore', stoneLike({ hardness: 3, level: 2, drops: () => [[I_('diamond'), 1]] }));
def(19, 'emerald_ore', stoneLike({ hardness: 3, level: 2, drops: () => [[I_('emerald'), 1]] }));
def(20, 'birch_log', woodLike({ orient: 'axis', faces: { top: 'birch_log_top', side: 'birch_log' } }));
def(21, 'birch_leaves', {
  pass: PASS.CUTOUT, opaque: false, opacity: 1, hardness: 0.2, tool: 'shears', sound: 'grass',
  tint: 4, wave: 1, flammable: true, drops: (r) => (r() < 0.05 ? [[B.birch_sapling, 1]] : []),
});
def(22, 'spruce_log', woodLike({ orient: 'axis', faces: { top: 'spruce_log_top', side: 'spruce_log' } }));
def(23, 'spruce_leaves', {
  pass: PASS.CUTOUT, opaque: false, opacity: 1, hardness: 0.2, tool: 'shears', sound: 'grass',
  tint: 5, wave: 1, flammable: true, drops: (r) => (r() < 0.05 ? [[B.spruce_sapling, 1]] : []),
});
def(24, 'birch_planks', woodLike());
def(25, 'spruce_planks', woodLike());
def(26, 'cactus', {
  render: RENDER.CACTUS, pass: PASS.CUTOUT, opaque: false, opacity: 0, hardness: 0.4, sound: 'cloth',
  support: 'cactus', faces: { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' },
});
def(27, 'tall_grass', plant({ tint: 1, replaceable: true, flammable: true, burn: 0.6, drops: () => [] }));
def(28, 'fern', plant({ tint: 1, replaceable: true, flammable: true, burn: 0.6, drops: () => [] }));
def(29, 'dandelion', plant({ wave: 2 }));
def(30, 'poppy', plant({ wave: 2 }));
def(31, 'cornflower', plant({ wave: 2 }));
def(32, 'dead_bush', plant({ support: 'sand', wave: 0, replaceable: true, drops: (r) => [[I_('stick'), Math.floor(r() * 3)]] }));
def(33, 'sugar_cane', plant({ support: 'cane', wave: 0 }));
def(34, 'snowy_grass', {
  display: 'Snowy Grass Block', hardness: 0.6, tool: 'shovel', sound: 'snow',
  faces: { top: 'snow', bottom: 'dirt', side: 'snowy_grass_side' }, drops: () => [[B.dirt, 1]],
});
def(35, 'snow_block', { display: 'Snow Block', hardness: 0.2, tool: 'shovel', requiresTool: true, sound: 'snow', faces: 'snow', drops: () => [[I_('snowball'), 4]] });
def(36, 'ice', { pass: PASS.TRANSLUCENT, opaque: false, opacity: 1, hardness: 0.5, tool: 'pickaxe', sound: 'glass', selfCull: true, friction: 0.98, drops: () => [] });
def(37, 'clay', { hardness: 0.6, tool: 'shovel', sound: 'gravel', drops: () => [[I_('clay_ball'), 4]] });
def(38, 'sandstone', stoneLike({ hardness: 0.8, faces: { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone_side' } }));
def(39, 'bricks', stoneLike({ hardness: 2 }));
def(40, 'bookshelf', woodLike({ hardness: 1.5, faces: { top: 'oak_planks', side: 'bookshelf' } }));
def(41, 'mossy_cobblestone', stoneLike({ hardness: 2 }));
def(42, 'obsidian', stoneLike({ hardness: 50, level: 3 }));
def(43, 'torch', {
  render: RENDER.TORCH, pass: PASS.CUTOUT, opaque: false, solid: false, light: 14, hardness: 0,
  sound: 'wood', support: 'torch', orient: 'torch', faces: { top: 'torch_top', bottom: 'torch', side: 'torch' },
});
def(44, 'crafting_table', woodLike({ hardness: 2.5, faces: { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side', front: 'crafting_table_front' }, orient: 'facing' }));
def(45, 'furnace', stoneLike({ hardness: 3.5, orient: 'facing', faces: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front' } }));
def(46, 'furnace_lit', stoneLike({ display: 'Furnace', hardness: 3.5, orient: 'facing', light: 13, item: false, creative: false, faces: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front_lit' }, drops: () => [[B.furnace, 1]] }));
def(47, 'chest', woodLike({ flammable: false, burn: 0, hardness: 2.5, orient: 'facing', faces: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side', front: 'chest_front' } }));
def(48, 'lamp', { hardness: 0.3, light: 15, sound: 'glass', display: 'Glow Lamp' });
const WOOL = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black'];
WOOL.forEach((c, i) => def(49 + i, c + '_wool', { hardness: 0.8, sound: 'cloth', flammable: true, burn: 0.6, tool: 'shears' }));
def(57, 'iron_block', stoneLike({ display: 'Block of Iron', hardness: 5, level: 1, sound: 'metal' }));
def(58, 'gold_block', stoneLike({ display: 'Block of Gold', hardness: 3, level: 2, sound: 'metal' }));
def(59, 'diamond_block', stoneLike({ display: 'Block of Diamond', hardness: 5, level: 2, sound: 'metal' }));
def(60, 'coal_block', stoneLike({ display: 'Block of Coal', hardness: 5 }));
def(61, 'copper_block', stoneLike({ display: 'Block of Copper', hardness: 3, level: 1, sound: 'metal' }));
def(62, 'emerald_block', stoneLike({ display: 'Block of Emerald', hardness: 5, level: 2, sound: 'metal' }));
def(63, 'stone_bricks', stoneLike());
def(64, 'pumpkin', { hardness: 1, tool: 'axe', sound: 'wood', faces: { top: 'pumpkin_top', side: 'pumpkin_side' } });
def(65, 'melon', { hardness: 1, tool: 'axe', sound: 'wood', faces: { top: 'melon_top', side: 'melon_side' }, drops: (r) => [[I_('melon_slice'), 3 + Math.floor(r() * 5)]] });
def(66, 'oak_sapling', plant({ wave: 2 }));
def(67, 'birch_sapling', plant({ wave: 2 }));
def(68, 'spruce_sapling', plant({ wave: 2 }));
def(69, 'ladder', {
  render: RENDER.LADDER, pass: PASS.CUTOUT, opaque: false, solid: false, hardness: 0.4, tool: 'axe',
  sound: 'wood', support: 'wall', orient: 'wall', flammable: true,
});
def(70, 'brown_mushroom', plant({ wave: 0, light: 1 }));
def(71, 'red_mushroom', plant({ wave: 0 }));
def(72, 'tnt', { display: 'Blast Crate', hardness: 0, sound: 'grass', flammable: true, burn: 0.8, spark: 'tnt', faces: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' } });

// Shaped blocks (see shapes.js)
const shaped = (shape, o = {}) => ({ render: RENDER.SHAPE, opaque: false, opacity: 0, shape, ...o });
def(73, 'dirt_path', shaped(7, { hardness: 0.65, tool: 'shovel', sound: 'gravel', faces: { top: 'dirt_path_top', bottom: 'dirt', side: 'dirt_path_side' }, drops: () => [[B.dirt, 1]] }));
def(74, 'farmland', shaped(7, { hardness: 0.6, tool: 'shovel', sound: 'gravel', faces: { top: 'farmland', bottom: 'dirt', side: 'dirt' }, drops: () => [[B.dirt, 1]] }));
const crop = (o) => ({ render: RENDER.CROP, pass: PASS.CUTOUT, opaque: false, solid: false, hardness: 0, sound: 'grass', support: 'farmland', item: false, creative: false, ...o });
def(75, 'wheat', crop({ faces: 'wheat0', drops: (r, m) => ((m & 7) === 7 ? [[I_('wheat'), 1], [I_('wheat_seeds'), Math.floor(r() * 4)]] : [[I_('wheat_seeds'), 1]]) }));
def(76, 'carrots', crop({ faces: 'carrots0', drops: (r, m) => [[I_('carrot'), (m & 7) === 7 ? 2 + Math.floor(r() * 3) : 1]] }));
def(77, 'potatoes', crop({ faces: 'potatoes0', drops: (r, m) => [[I_('potato'), (m & 7) === 7 ? 2 + Math.floor(r() * 3) : 1]] }));
def(78, 'oak_door', shaped(5, { pass: PASS.CUTOUT, hardness: 3, tool: 'axe', sound: 'wood', faces: 'oak_door_bottom', display: 'Oak Door', flammable: true, spark: 'door', drops: () => [[B.oak_door, 1]] }));
def(79, 'oak_fence', shaped(3, { hardness: 2, tool: 'axe', sound: 'wood', faces: 'oak_planks', flammable: true }));
def(80, 'oak_fence_gate', shaped(4, { hardness: 2, tool: 'axe', sound: 'wood', faces: 'oak_planks', orient: 'facing4', flammable: true, spark: 'gate' }));
def(81, 'oak_stairs', shaped(2, { hardness: 2, tool: 'axe', sound: 'wood', faces: 'oak_planks', orient: 'stairs', flammable: true }));
def(82, 'cobblestone_stairs', shaped(2, { ...stoneLike({ hardness: 2 }), faces: 'cobblestone', orient: 'stairs' }));
def(83, 'stone_brick_stairs', shaped(2, { ...stoneLike(), faces: 'stone_bricks', orient: 'stairs' }));
def(84, 'oak_slab', shaped(1, { hardness: 2, tool: 'axe', sound: 'wood', faces: 'oak_planks', orient: 'slab', flammable: true }));
def(85, 'cobblestone_slab', shaped(1, { ...stoneLike({ hardness: 2 }), faces: 'cobblestone', orient: 'slab' }));
def(86, 'stone_slab', shaped(1, { ...stoneLike({ hardness: 2 }), faces: 'stone', orient: 'slab' }));
def(87, 'bed', shaped(6, { hardness: 0.2, sound: 'cloth', faces: 'bed_head_top', display: 'Bed', drops: () => [[B.bed, 1]] }));
def(88, 'rift', {
  render: RENDER.PORTAL, pass: PASS.TRANSLUCENT, opaque: false, solid: false, light: 11, hardness: -1,
  sound: 'glass', faces: 'rift', item: false, creative: false, display: 'Rift',
});
def(89, 'scorchstone', stoneLike({ hardness: 0.4 }));
def(90, 'cinder_sand', { hardness: 0.5, tool: 'shovel', sound: 'sand', shape: 9, slow: 0.4 });
def(91, 'ember_crystal', { hardness: 0.3, light: 15, sound: 'glass', drops: (r) => [[I_('ember_dust'), 2 + Math.floor(r() * 3)]] });
def(92, 'magma_rock', stoneLike({ hardness: 0.5, light: 3 }));
def(93, 'quartz_ore', stoneLike({ hardness: 3, drops: () => [[I_('quartz'), 1]] }));
def(94, 'ember_gold_ore', stoneLike({ hardness: 3, drops: (r) => [[I_('gold_nugget'), 2 + Math.floor(r() * 5)]] }));
def(95, 'glowcap', plant({ wave: 0, light: 8, support: 'underworld' }));
def(96, 'ashen_shrub', plant({ wave: 0, support: 'underworld', replaceable: true, drops: (r) => (r() < 0.3 ? [[I_('stick'), 1]] : []) }));
def(97, 'ember_bricks', stoneLike({ hardness: 2 }));
def(98, 'spawner', { pass: PASS.CUTOUT, opaque: false, opacity: 1, hardness: 5, tool: 'pickaxe', sound: 'metal', drops: () => [], display: 'Creature Spawner', creative: false });
def(99, 'enchanting_table', shaped(8, { ...stoneLike({ hardness: 5 }), light: 7, faces: { top: 'enchanting_table_top', bottom: 'enchanting_table_bottom', side: 'enchanting_table_side' } }));
def(100, 'hay_bale', { hardness: 0.5, sound: 'grass', orient: 'axis', flammable: true, burn: 0.6, faces: { top: 'hay_top', side: 'hay_side' } });
def(101, 'quartz_block', stoneLike({ hardness: 0.8, display: 'Block of Quartz' }));

// --- Spark circuits -----------------------------------------------------------
// Attach codes for levers and buttons: 0 floor, 1 wall at -X, 2 wall at +X,
// 3 wall at -Z, 4 wall at +Z, 5 ceiling.
const flat = { opaque: false, solid: false, opacity: 0, pass: PASS.CUTOUT };
def(102, 'spark_ore', stoneLike({ hardness: 3, level: 2, drops: (r) => [[I_('spark_dust'), 4 + Math.floor(r() * 2)]] }));
def(103, 'spark_wire', { ...flat, render: RENDER.WIRE, hardness: 0, sound: 'stone', faces: 'spark_dot', item: false, creative: false, support: 'wire', spark: 'wire', display: 'Spark Dust', drops: () => [[I_('spark_dust'), 1]] });
def(104, 'spark_torch', {
  render: RENDER.TORCH, pass: PASS.CUTOUT, opaque: false, solid: false, light: 7, hardness: 0, sound: 'wood',
  support: 'torch', orient: 'torch', spark: 'torch', faces: { top: 'spark_torch_top', bottom: 'spark_torch', side: 'spark_torch' },
});
def(105, 'spark_torch_off', {
  render: RENDER.TORCH, pass: PASS.CUTOUT, opaque: false, solid: false, hardness: 0, sound: 'wood', display: 'Spark Torch',
  support: 'torch', orient: 'torch', spark: 'torch', item: false, creative: false, drops: () => [[B.spark_torch, 1]],
  faces: { top: 'spark_torch_top_off', bottom: 'spark_torch_off', side: 'spark_torch_off' },
});
const shaped0 = (shape, o = {}) => ({ render: RENDER.SHAPE, opaque: false, opacity: 0, shape, ...o });
def(106, 'lever', shaped0(16, { ...flat, render: RENDER.SHAPE, hardness: 0.5, sound: 'stone', faces: 'cobblestone', orient: 'attach', support: 'attach', spark: 'lever', icon: 'lever' }));
def(107, 'stone_button', shaped0(10, { ...flat, render: RENDER.SHAPE, hardness: 0.5, sound: 'stone', faces: 'stone', orient: 'attach', support: 'attach', spark: 'button', icon: 'stone_button' }));
def(108, 'oak_button', shaped0(10, { ...flat, render: RENDER.SHAPE, hardness: 0.5, sound: 'wood', faces: 'oak_planks', orient: 'attach', support: 'attach', spark: 'button', icon: 'oak_button' }));
def(109, 'stone_pressure_plate', shaped0(11, { ...flat, render: RENDER.SHAPE, hardness: 0.5, tool: 'pickaxe', sound: 'stone', faces: 'stone', support: 'plate', spark: 'plate', icon: 'stone_pressure_plate' }));
def(110, 'oak_pressure_plate', shaped0(11, { ...flat, render: RENDER.SHAPE, hardness: 0.5, tool: 'axe', sound: 'wood', faces: 'oak_planks', support: 'plate', spark: 'plate', icon: 'oak_pressure_plate' }));
def(111, 'repeater', shaped0(12, { pass: PASS.CUTOUT, hardness: 0, sound: 'stone', faces: { top: 'repeater', bottom: 'stone', side: 'stone' }, orient: 'facing4', support: 'repeater', spark: 'repeater', display: 'Spark Repeater', icon: 'repeater' }));
def(112, 'spark_lamp', { hardness: 0.3, sound: 'glass', spark: 'lamp' });
def(113, 'spark_lamp_on', { hardness: 0.3, sound: 'glass', light: 15, spark: 'lamp', item: false, creative: false, display: 'Spark Lamp', drops: () => [[B.spark_lamp, 1]] });
def(114, 'piston', shaped0(14, { hardness: 0.5, sound: 'stone', orient: 'facing6', spark: 'piston', icon: 'cube', faces: { top: 'piston_top', bottom: 'piston_bottom', side: 'piston_side' } }));
def(115, 'sticky_piston', shaped0(14, { hardness: 0.5, sound: 'stone', orient: 'facing6', spark: 'piston', icon: 'cube', faces: { top: 'piston_top_sticky', bottom: 'piston_bottom', side: 'piston_side' } }));
def(116, 'piston_head', shaped0(15, { hardness: 0.5, sound: 'stone', item: false, creative: false, faces: { top: 'piston_top', bottom: 'piston_top', side: 'piston_side' }, drops: () => [] }));
def(117, 'note_block', woodLike({ hardness: 0.8, spark: 'note', faces: 'note_block' }));
def(118, 'daylight_sensor', shaped0(18, { hardness: 0.2, tool: 'axe', sound: 'wood', spark: 'sensor', icon: 'cube', faces: { top: 'daylight_top', bottom: 'oak_planks', side: 'daylight_side' } }));
def(119, 'spark_block', stoneLike({ hardness: 5, sound: 'metal', spark: 'block', display: 'Block of Spark' }));
def(120, 'oak_trapdoor', shaped0(13, { pass: PASS.CUTOUT, hardness: 3, tool: 'axe', sound: 'wood', faces: 'oak_trapdoor', orient: 'trapdoor', flammable: true, spark: 'trapdoor' }));
def(121, 'dispenser', stoneLike({ hardness: 3.5, orient: 'facing6', iconMeta: 4, spark: 'dispenser', faces: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'dispenser_front' } }));
def(122, 'hopper', shaped0(25, { ...stoneLike({ hardness: 3, sound: 'metal' }), pass: PASS.CUTOUT, orient: 'hopper', spark: 'hopper', icon: 'hopper', faces: { top: 'hopper_top', bottom: 'hopper_side', side: 'hopper_side' } }));
// rails: meta 0-9 shape (0 N-S, 1 E-W, 2-5 ascending E/W/N/S, 6-9 curves SE/SW/NW/NE); bit 3 powered/pressed on the straight kinds
def(123, 'rail', { ...flat, render: RENDER.RAIL, hardness: 0.7, tool: 'pickaxe', sound: 'metal', support: 'rail', faces: 'rail' });
def(124, 'powered_rail', { ...flat, render: RENDER.RAIL, hardness: 0.7, tool: 'pickaxe', sound: 'metal', support: 'rail', faces: 'powered_rail', spark: 'powered_rail' });
def(125, 'detector_rail', { ...flat, render: RENDER.RAIL, hardness: 0.7, tool: 'pickaxe', sound: 'metal', support: 'rail', faces: 'detector_rail', spark: 'detector' });
def(126, 'brewing_stand', shaped0(17, { pass: PASS.CUTOUT, hardness: 0.5, tool: 'pickaxe', sound: 'metal', light: 1, faces: { top: 'brewing_base', bottom: 'brewing_base', side: 'brewing_base' }, icon: 'brewing_stand' }));

// --- The Void -----------------------------------------------------------------
def(127, 'duskstone', stoneLike({ hardness: 3 }));
def(128, 'duskstone_bricks', stoneLike({ hardness: 3 }));
def(129, 'star_frame', shaped0(19, { hardness: -1, sound: 'glass', light: 1, faces: { top: 'star_frame_top', bottom: 'duskstone', side: 'star_frame_side' }, creative: true, icon: 'cube', display: 'Star Gate Frame' }));
def(130, 'void_gate', { render: RENDER.VOIDGATE, pass: PASS.OPAQUE, opaque: false, solid: false, light: 15, hardness: -1, sound: 'glass', faces: 'void_gate', item: false, creative: false, display: 'Void Gate' });
def(131, 'void_stalk', shaped0(21, { hardness: 0.4, tool: 'axe', sound: 'wood', faces: 'void_stalk', support: 'stalk', pass: PASS.CUTOUT, drops: (r) => (r() < 0.5 ? [[I_('void_fruit'), 1]] : []) }));
def(132, 'void_bloom', { hardness: 0.4, tool: 'axe', sound: 'wood', light: 6, support: 'stalk', drops: () => [[B.void_bloom, 1]] });
def(133, 'astral_bricks', stoneLike({ hardness: 1.5 }));
def(134, 'astral_pillar', stoneLike({ hardness: 1.5, orient: 'axis', faces: { top: 'astral_pillar_top', side: 'astral_pillar' } }));
def(135, 'glow_rod', shaped0(26, { pass: PASS.CUTOUT, hardness: 0, sound: 'glass', light: 14, faces: 'glow_rod', orient: 'facing6', solid: false }));
def(136, 'wyrm_egg', shaped0(27, { hardness: 3, sound: 'stone', light: 1, faces: 'wyrm_egg', gravity: true, icon: 'cube' }));
def(137, 'void_gateway', { render: RENDER.VOIDGATE, pass: PASS.OPAQUE, opaque: false, solid: false, light: 15, hardness: -1, sound: 'glass', faces: 'void_gate', item: false, creative: false, display: 'Void Gateway' });

// --- Fire, signs and other additions ----------------------------------------------
def(138, 'fire', { render: RENDER.FIRE, pass: PASS.CUTOUT, opaque: false, solid: false, light: 15, hardness: 0, replaceable: true, sound: 'cloth', faces: 'fire', item: false, creative: false, support: 'fire', drops: () => [] });
def(139, 'oak_sign', shaped0(24, { ...flat, render: RENDER.SHAPE, hardness: 1, tool: 'axe', sound: 'wood', faces: 'oak_planks', orient: 'sign', support: 'sign', flammable: true, display: 'Oak Sign', icon: 'oak_sign' }));
def(140, 'oak_wall_sign', shaped0(24, { ...flat, render: RENDER.SHAPE, hardness: 1, tool: 'axe', sound: 'wood', faces: 'oak_planks', support: 'wall_sign', flammable: true, item: false, creative: false, display: 'Oak Sign', drops: () => [[B.oak_sign, 1]] }));
def(141, 'cobweb', { render: RENDER.CROSS, pass: PASS.CUTOUT, opaque: false, solid: false, opacity: 1, hardness: 4, tool: 'sword', sound: 'cloth', slow: 0.12, drops: () => [[I_('string'), 1]] });
def(142, 'glass_pane', shaped0(20, { pass: PASS.CUTOUT, hardness: 0.3, sound: 'glass', faces: 'glass', drops: () => [] }));
def(143, 'iron_bars', shaped0(20, { pass: PASS.CUTOUT, hardness: 5, tool: 'pickaxe', sound: 'metal', faces: 'iron_bars' }));
def(144, 'lantern', shaped0(23, { pass: PASS.CUTOUT, hardness: 3.5, tool: 'pickaxe', sound: 'metal', light: 15, faces: 'lantern', support: 'lantern', icon: 'lantern' }));
def(145, 'cake', shaped0(22, { hardness: 0.5, sound: 'cloth', faces: { top: 'cake_top', bottom: 'cake_bottom', side: 'cake_side' }, support: 'plate', drops: () => [], icon: 'cake' }));

export const BLOCK_COUNT = BLOCKS.length;

// Item ids are resolved lazily (items.js registers them) so blocks.js has no
// import cycle. I_ is replaced by the real lookup once items are loaded.
let itemLookup = null;
export function setItemLookup(fn) { itemLookup = fn; }
function I_(name) {
  if (!itemLookup) throw new Error('item lookup not ready');
  return itemLookup(name);
}

// ---------------------------------------------------------------------------
// Orientation-aware face texture lookup. Faces: 0 +Y, 1 -Y, 2 +X, 3 -X, 4 +Z, 5 -Z.
// Returns layer; sets ROT[0] = 1 when the texture should be rotated 90°.
export const ROT = new Uint8Array(1);
export function faceTexture(id, face, meta) {
  ROT[0] = 0;
  const d = BLOCKS[id];
  if (id === 74 && face === 0 && (meta & 7)) return TEX.farmland_wet;
  if (id === 78) return meta & 8 ? TEX.oak_door_top : TEX.oak_door_bottom;
  if (d.orient === 'axis' && meta) {
    // meta 1: log along X, 2: along Z
    const endFaces = meta === 1 ? [2, 3] : [4, 5];
    if (face === endFaces[0] || face === endFaces[1]) return FACE_TEX[id * 6];
    const side = FACE_TEX[id * 6 + 2];
    // bark on the faces perpendicular to the axis runs sideways
    if (meta === 1) { ROT[0] = face === 0 || face === 1 || face === 4 || face === 5 ? 1 : 0; }
    else { ROT[0] = face === 2 || face === 3 ? 1 : 0; }
    return side;
  }
  if (d.orient === 'facing' && d.frontTex !== undefined && face >= 2) {
    const front = (meta & 7) || 4; // default facing +Z
    if (face === front) return d.frontTex;
  }
  if (d.orient === 'facing6' && d.frontTex !== undefined && face === (meta & 7)) {
    return face < 2 && id === B.dispenser ? TEX.dispenser_front_v : d.frontTex;
  }
  if (id === B.spark_lamp_on) return TEX.spark_lamp_on;
  return FACE_TEX[id * 6 + face];
}

// Context object for shapes.js.
export const FENCE_IDS = new Set([79, 80]);
export const SHAPE_CTX = {
  shape: SHAPE_KIND,
  fences: FENCE_IDS,
  opaque: OPAQUE,
  tex: (n) => TEX[n],
  id: (n) => B[n],
  stalk: new Set([131, 132]),
  doorTex: (id, meta) => {
    const l = meta & 8 ? TEX.oak_door_top : TEX.oak_door_bottom;
    return [l, l, l, l, l, l];
  },
  // Bed textures by part and facing: faces order +Y, -Y, +X, -X, +Z, -Z.
  bedTex: (head, f) => {
    const top = head ? TEX.bed_head_top : TEX.bed_foot_top;
    const side = head ? TEX.bed_head_side : TEX.bed_foot_side;
    const end = head ? TEX.bed_head_end : TEX.bed_foot_end;
    const faces = [top, TEX.oak_planks, side, side, side, side];
    // the outer end: toward the head for the head part, away from it for the foot
    const endFace = [5, 2, 4, 3][head ? f : (f + 2) % 4];
    faces[endFace] = end;
    const r = [f, 0, 0, 0, 0, 0];
    return { faces, rot: r };
  },
};

// Liquid helpers. meta: 0 = source, 1..7 = flowing distance, bit 8 = falling.
export const isLiquid = (id) => id === 12 || id === 13;
export const WATER = 12, LAVA = 13;
