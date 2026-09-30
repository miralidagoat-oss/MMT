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
];
const ANIM_NAMES = ['water', 'lava'];

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
]);

// ---------------------------------------------------------------------------
export const RENDER = { NONE: 0, CUBE: 1, CROSS: 2, TORCH: 3, LIQUID: 4, CACTUS: 5, LADDER: 6 };
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
  };
  BLOCKS[id] = d; B[name] = id;
  OPAQUE[id] = d.opaque && d.render === RENDER.CUBE ? 1 : 0;
  SOLID[id] = d.solid ? 1 : 0;
  RENDER_TYPE[id] = d.render;
  RENDER_PASS[id] = d.pass;
  EMIT[id] = d.light;
  OPACITY[id] = d.opacity;
  TINT[id] = d.tint;
  WAVE[id] = d.wave;
  SELF_CULL[id] = d.selfCull ? 1 : 0;
  REPLACEABLE[id] = d.replaceable ? 1 : 0;
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
def(27, 'tall_grass', plant({ tint: 1, replaceable: true, drops: () => [] }));
def(28, 'fern', plant({ tint: 1, replaceable: true, drops: () => [] }));
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
def(47, 'chest', woodLike({ hardness: 2.5, orient: 'facing', faces: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side', front: 'chest_front' } }));
def(48, 'lamp', { hardness: 0.3, light: 15, sound: 'glass', display: 'Glow Lamp' });
const WOOL = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black'];
WOOL.forEach((c, i) => def(49 + i, c + '_wool', { hardness: 0.8, sound: 'cloth', flammable: true, tool: 'shears' }));
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
  sound: 'wood', support: 'wall', orient: 'wall',
});
def(70, 'brown_mushroom', plant({ wave: 0, light: 1 }));
def(71, 'red_mushroom', plant({ wave: 0 }));
def(72, 'tnt', { display: 'Blast Crate', hardness: 0, sound: 'grass', faces: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' } });

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
  return FACE_TEX[id * 6 + face];
}

// Liquid helpers. meta: 0 = source, 1..7 = flowing distance, bit 8 = falling.
export const isLiquid = (id) => id === 12 || id === 13;
export const WATER = 12, LAVA = 13;
