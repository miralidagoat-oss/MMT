# Blockforge

An open-world voxel sandbox that runs in the browser. It has infinite
procedural terrain with villages and dungeons, a fiery second dimension (the
Underworld) reached through rift portals, survival and creative modes, mining,
building, crafting, smelting, farming, armor, bows, beds, trading, experience
and enchanting, creatures, day/night, thunderstorms, flowing water and lava,
and saved worlds.

Everything is original and generated in code: block and item textures,
creature models and skins, sound effects and the ambient music. There are no
asset files.

## Play

Open **`dist/blockforge.html`** in Chrome, Edge, Firefox or Safari. It is one
self-contained file (~430 KB), so it works from disk or from any static host.
It needs WebGL 2.

Click the game view to capture the mouse. Press **Esc** to pause.

| Keys | Action |
| --- | --- |
| W A S D | Move |
| Space | Jump · swim up · double-tap to fly (Creative) |
| Shift | Sneak (keeps you from walking off edges) · fly down |
| Ctrl or double-tap W | Sprint |
| Mouse (or arrow keys) | Look |
| Left click | Break block · attack |
| Right click | Place block · use (crafting table, furnace, chest, enchanting table, doors, gates, beds) · eat · buckets · trade with settlers · hold to draw a bow · wear armor |
| Middle click | Pick block |
| 1–9 · mouse wheel | Choose hotbar slot |
| E | Inventory |
| Q · Ctrl+Q | Drop item · drop stack |
| T · / | Chat · commands (`/help`) |
| F1 · F2 · F3 · F5 | Hide HUD · screenshot · debug info · camera view |

Inventory: click to take or place a stack, right-click to split or place one,
shift-click to move between sections, drag to spread a stack, press 1–9 over a
slot to swap it with the hotbar. Touch screens get an on-screen stick and buttons.

Commands: `/time set day|night|<ticks>`, `/gamemode survival|creative`,
`/tp x y z` (supports `~`), `/give <item> [count]`, `/summon <creature>`,
`/weather clear|rain|thunder`, `/xp <points>` or `/xp <levels>L`,
`/enchant <name> [level]`, `/locate village`, `/dimension overworld|underworld`,
`/seed`, `/spawnpoint`, `/kill`, `/heal`, `/clear`, `/difficulty peaceful|normal`.

## What's in it

**World**
- Infinite terrain streamed in 16×16×256 chunks, generated on worker threads.
- Continents, oceans, rivers, beaches, mountains with snowy peaks and 19 biomes
  (plains, meadow, forest, birch forest, taiga, snowy plains and taiga, desert,
  savanna, swamp and more), with smoothly blended grass, foliage and water colours.
- Worm tunnels and large caverns, lava lakes deep down, ore veins (coal, iron,
  copper, gold, diamond, emerald in mountains), gravel/dirt/clay pockets, bedrock.
- Oak, big oak, birch, spruce and swamp trees; tall grass, ferns, flowers,
  cacti, sugar cane, dead bushes, pumpkins, mushrooms.
- Villages in four styles (oak, spruce, birch, sandstone) with a well, dirt
  paths, lamp posts, houses with beds, doors, windows and stair roofs, a
  smithy, fenced animal pens, irrigated crop fields and loot chests. Settlers
  (farmers, smiths, shepherds and scholars) live in them.
- Underground dungeons: mossy rooms with a creature spawner and loot chests.
- **The Underworld**: a 128-block-tall cavern dimension with a lava sea,
  scorchstone, cinder sand that slows you down, glowing ember crystals,
  glowcaps, quartz and gold ores, magma rock that burns, ruined ember-brick
  outposts with loot, and three regions (Glowing Grove, Cinder Flats, Ashen
  Wastes). Distances there count eight times over.

**Rendering**
- WebGL 2 at native device pixel ratio, with a 50–200% resolution scale
  (above 100% supersamples).
- Flood-filled sky and block light with smooth lighting and ambient occlusion,
  computed exactly across chunk borders.
- Day/night cycle with sun, moon phases, rotating stars, sunrise/sunset glow,
  fog tinted toward the sun, rain and snow, and volumetric-style clouds.
- Animated water and lava, waving leaves and plants, translucent water with
  sloped flowing surfaces, underwater and lava fog.
- Particles for mining debris, torches, smoke, bubbles, splashes, rain and explosions.
- First-person hand and held items with swing, equip, eating and view-bob
  animation; third-person views of the player model.

**Gameplay**
- Walking, sprinting, sprint-jumping, sneaking, swimming, ladders and creative
  flight on a 20-tick-per-second simulation, interpolated for smooth frames.
- Break times based on hardness, tool type and tier (hand, wooden, stone,
  iron, golden, diamond), with durability.
- Health, hunger, saturation, air, fall damage, drowning, fire and lava,
  cactus damage, starvation; death and respawn.
- 2×2 and 3×3 shaped and shapeless crafting (tools, torches, furnace, chest,
  storage blocks, lamps, ladders, buckets and more), furnace smelting with fuel.
- Chests, furnaces, buckets of water and lava, flint and steel, blast crates
  with chain explosions.
- Water and lava flow with infinite water sources; lava meeting water makes
  obsidian or cobblestone. Sand and gravel fall. Plants, torches and ladders pop
  off without support. Leaves decay, saplings grow, grass spreads, cane and
  cacti grow.
- Rift portals: build an obsidian frame (2×3 to 21×21 inside) and light it
  with flint and steel. Stand in the rift to cross; a matching portal is found
  or built on the other side.
- Farming: till dirt with a hoe, plant wheat, carrots and potatoes on
  farmland, which stays moist near water and dries out otherwise; bone meal
  speeds growth; trampling ruins farmland.
- Armor in leather, gold, iron and diamond with four slots, armor points,
  toughness and durability, drawn on the player and on creatures.
- Bows with draw strength, critical shots and arrows you can pick back up;
  eggs and snowballs to throw.
- Beds: sleep through the night (not with monsters nearby), set your respawn
  point. They are not safe in the Underworld.
- Doors, fence gates, fences, stairs, slabs, hay bales, quartz blocks and more.
- Experience orbs from mining, smelting, breeding, trading and fighting;
  levels shown on the XP bar. Spend them at an enchanting table (more power
  with bookshelves around it): Efficiency, Sharpness, Unbreaking, Protection,
  Feather Falling, Power, Fortune and Knockback.
- Trading with settlers: each profession has its own offers, which sell out
  and restock.
- Animals breed when fed and grow up from babies; chickens lay eggs.
- Pigs, cows, sheep (shearable) and chickens that wander, look at you and
  panic when hit. Hostile creatures: ghouls that burn in daylight, bone
  archers that shoot arrows, wall-climbing cave crawlers that leap, and cinder
  imps in the Underworld that set you alight. Some wear armor.
- Thunderstorms with lightning strikes, a clock and a compass, milestone
  toasts for firsts (first timber, iron, diamonds, the Underworld and more).
- Worlds (both dimensions), inventories, experience, block containers,
  animals and settlers with their trades are saved in the browser (IndexedDB)
  with autosave every 30 seconds.

**Not included yet**: a third "end" dimension and its boss, redstone-style
circuits, boats and minecarts, potions and brewing, signs, maps, fishing,
fire spread, multiplayer.

**Sound** – synthesised block sounds per material (stone, wood, grass, gravel,
sand, snow, glass, cloth, metal), footsteps, creature voices, splashes, rain,
cave ambience, explosions and generative ambient music.

## Develop

```
npm install
npm run serve      # then open http://localhost:8123/index.html
npm run build      # writes dist/blockforge.html and dist/artifact.html
```

`index.html` loads the ES modules in `src/` directly. The build bundles them
with esbuild into single files, embedding the worker so no extra requests are
needed.

| File | Role |
| --- | --- |
| `src/worldgen.js` | Terrain, biomes, caves, ores, trees, plants |
| `src/structures.js`, `src/underworld.js` | Villages and dungeons; Underworld terrain |
| `src/shapes.js` | Box shapes for doors, beds, stairs, slabs, fences (shared by mesher and physics) |
| `src/portal.js`, `src/loot.js`, `src/advancements.js` | Rift portals; loot, trades and enchantments; milestones |
| `src/mesher.js` | Light flood fill and chunk mesh building |
| `src/worker.js`, `src/workerpool.js`, `src/jobs.js` | Worker threads with a main-thread fallback |
| `src/world.js` | Chunk streaming, block access, remesh scheduling |
| `src/renderer.js`, `src/shaders.js` | WebGL 2 renderer |
| `src/scene.js`, `src/models.js` | Creature, player, item and hand rendering |
| `src/game.js` | Rules: interaction, block updates, spawning, time, weather, saving |
| `src/player.js`, `src/entities.js`, `src/physics.js` | Movement, creatures, collision, raycasts |
| `src/fluids.js`, `src/particles.js`, `src/env.js` | Fluid flow, particles, sky and fog |
| `src/ui.js`, `src/icons.js`, `src/style.css` | HUD, menus and inventory screens |
| `src/textures.js`, `src/audio.js` | Procedural textures and synthesised audio |

Tests drive the built game in headless Chromium and save screenshots:

```
NODE_PATH=$(npm root -g) node tools/systems.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/play.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/features.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/gallery.cjs file://$PWD/dist/blockforge.html /tmp/shots
```

`tools/texture-sheet.mjs` renders every texture into one PNG for review.
