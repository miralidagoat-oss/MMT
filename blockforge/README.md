# Blockforge

An open-world voxel sandbox that runs in the browser. It has infinite
procedural terrain with 25 biomes, villages, mineshafts, temples, shrines,
swamp huts, undersea citadels, manors, raider outposts, igloos, shipwrecks,
dungeons and observatories, a fiery second dimension (the Underworld)
reached through rift portals, a third (the Void) with a boss to defeat,
village raids, spark circuits with comparators, observers and crafters,
rails, minecarts and boats, brewing and potions, a photon blaster laser gun
and fireworks, tameable hounds, cats, parrots and alpacas, rideable steeds,
foxes, bees, dolphins, rabbits, goats, turtles, squid and frogs, leads,
journals and lecterns, buildable sentinels, anvils, grindstones and
smithing tables, looms, dyes and banners, item frames and paintings,
beacons, creatures that find their way with pathfinding, survival and creative
modes, mining, building, crafting, smelting, farming, armor, bows, beds,
trading, experience and enchanting, fishing, maps, day/night, thunderstorms,
flowing water and lava, saved worlds, shared multiplayer worlds, HD textures
with relief lighting and graphics presets from Performance to Ultra.

Everything is original and generated in code: block and item textures,
creature models and skins, sound effects and the ambient music. There are no
asset files.

## Play

Open **`dist/blockforge.html`** in Chrome, Edge, Firefox or Safari. It is one
self-contained file (~980 KB), so it works from disk or from any static host.
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
| Right click | Place block · use (crafting table, furnace, chest, brewing stand, hopper, dispenser, dropper, crafter, enchanting table, anvil, grindstone, smithing table, loom, beacon, void chest, cauldron, composter, lectern, beehive, berry bush, fence (to tie or untie leads), doors, trapdoors, gates, levers, buttons, comparators, beds, signs) · eat and drink · write in or read journals · blow a goat horn · buckets · trade with settlers · hold to draw a bow, raise a shield or fire the blaster · wear armor · ride minecarts, boats and steeds · feed, tame, sit or saddle animals (sneak-use a packed alpaca to open its pack) · dye sheep · hang item frames, paintings and banners · cast a fishing line |
| Shift (riding) | Get out of a minecart or boat, or off a steed |
| Jump while falling | Open a glider worn in the chest slot |
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
`/tp x y z` (supports `~`), `/give <item> [count]`,
`/summon <creature> [variant]|minecart|boat|wyrm`, `/weather clear|rain|thunder`,
`/xp <points>` or `/xp <levels>L`, `/enchant <name> [level]`,
`/effect give <effect> [seconds] [level]` · `/effect clear`,
`/locate village|observatory|spire|mineshaft|temple|shrine|hut|citadel|manor|outpost|igloo|shipwreck`,
`/dimension overworld|underworld|void`,
`/seed`, `/spawnpoint`, `/kill`, `/heal`, `/clear`, `/difficulty peaceful|normal`.

### Graphics settings

Options › Video has four presets and every setting on its own:

| Preset | What it turns on |
| --- | --- |
| Performance | 5-chunk view at 70% resolution, smooth 32px textures, no shadows or post effects, fewer particles |
| Balanced | 8 chunks, HD 64px textures with relief lighting, bloom on glowing blocks, colour grading, FXAA, water reflections, entity shadows |
| Fancy | 12 chunks, sun shadows (2048 map), 4x MSAA |
| Ultra | 18 chunks, sharper and wider sun shadows (4096 map) |

**Texture detail** chooses how textures are painted: Classic (the original
16-pixel art), Smooth (32px) or HD (64px). Every texture is still drawn in
code: at higher detail noise is sampled per pixel, the art's random speckle
blends smoothly, shapes are smoothed, leaves, grass blades and cracks get
dedicated high-resolution painters, item icons get clean bevels and outlines,
and creature skins are upscaled face by face. **Relief lighting** adds
per-pixel normal maps (bricks, cobbles, bark and stone catch the light) with a
glint on metal, ore and ice.

You can also set render distance, resolution scale (50–200%), a frame-rate cap,
brightness, shadows (off/low/high/ultra), anti-aliasing (off/FXAA/MSAA 4x),
particles, bloom, colour grading, water reflections, clouds, entity shadows,
waving plants and view bobbing. Changing one setting switches to Custom. On
first run the game picks Performance for software renderers and small
devices and Balanced otherwise.

### Multiplayer

One player hosts a world and friends join it:

1. Open one of your worlds, press **Esc** and choose **Open to Friends**, then
   **Start Sharing**. The menu shows a **room code** like `ysqn-kz9h`.
2. Friends choose **Multiplayer** on the title screen, type the code and press
   **Join**. Case and the dash don't matter; the code itself says which kind of
   connection to use, so there is nothing else to pick.

Ways to connect (chosen when you start sharing):
- **Online — friends anywhere** (the default): each friend's browser connects
  straight to the host's (WebRTC data channels; the host's page passes
  messages between everyone). To find each other with the code, both games
  briefly meet on public MQTT brokers (EMQX, HiveMQ, Mosquitto test brokers).
  The code derives both the meeting topic and an AES-GCM key (PBKDF2), so the
  brokers only ever see ciphertext on a topic that doesn't reveal the code;
  nothing is sent through them once you're connected.
  - **Join with a Request** works with no server at all, for when the brokers
    can't be reached (the sharing menu says so): the friend chooses
    Multiplayer → Join with a Request and sends the host the request text; the
    host pastes it under "A friend can't get in with the code?" in Open to
    Friends and sends back the reply; the friend pastes the reply and
    connects.
  - Direct connections use public STUN servers and no TURN relay, so a few
    network pairs (some strict school/work firewalls, some mobile carriers)
    can't connect; the game says so, and a relay server or another network
    works around it.
- **People viewing this claude.ai page**: when the game runs as a claude.ai
  artifact, signed-in people the page is shared with (members of the owner's
  organization, or invited guests) can use the page's own room. People opening
  a public link can't use this room; they use Online instead.
- **Other tabs in this browser**: handy for trying it out.
- **Relay server**: run `node tools/relay.mjs` (no dependencies) on one
  computer. It prints addresses like `http://192.168.1.20:8787/`, where
  everyone on the network can open the game, and `ws://192.168.1.20:8787` to
  enter under Multiplayer → Relay Server….

The host's game runs the world: creatures, crops, fluids, circuits, weather and
time. Everyone generates the same terrain from the seed, so only changes
travel: block edits, each chunk's differences from the generated terrain,
creature and item snapshots, damage, pickups and chat. Guests see each other
with name tags; they mine, build, fight, ride, trade (from the host's own
settlers, who count the trades), open containers, hang frames and paintings,
keep their own void chest and pick up items; when the host goes through a
portal everyone follows. If the host's tab goes to the background the world
keeps ticking for the guests. The world and each guest's inventory are saved
in the host's browser.

## What's in it

**World**
- Infinite terrain streamed in 16×16×256 chunks, generated on worker threads.
- Continents, oceans, rivers, beaches, mountains with snowy peaks and 25 biomes
  (plains, meadow, forest, birch forest, dark forest, taiga, snowy plains and
  taiga, ice spikes, desert, badlands with terraced terracotta mesas, savanna,
  jungle, swamp, mushroom fields, the pink-blossomed Blossom Grove and more),
  with smoothly blended grass, foliage and water colours.
- Worm tunnels and large caverns, lava lakes deep down, ore veins (coal, iron,
  copper, gold, diamond, emerald in mountains), gravel/dirt/clay pockets, bedrock.
- Oak, big oak, birch, spruce, swamp, jungle (some with 2×2 trunks, hung with
  vines), jungle bush, dark oak and forked blossom trees; giant red and brown
  mushrooms; packed-ice spikes; tall grass, ferns, flowers, fallen petals,
  berry bushes, cacti, sugar cane, melons, dead bushes, pumpkins, mushrooms;
  bee nests hanging from trees in meadows, plains and the blossom grove.
- Mineshafts (propped tunnels with rails, lanterns, cobwebs, chests and a
  crawler spawner), sun temples in the desert (two towers and a treasure room
  guarded by a pressure plate over blast crates), jungle shrines (an arrow
  trap and two caches), swamp huts on stilts where a hexer lives, tide
  citadels on the deep sea floor (gold and treasure, guarded by tide
  wardens) and woodland manors in dark forests (library, dining room,
  bedrooms, strongroom, kept by hexers and archers).
- Raider outposts: a four-storey dark-wood watchtower with a lookout, loot
  and the raiders' banner, tents and a caged alpaca, held by marauders,
  rangers and their captain. Igloos in the snow (bed, stove, workbench; half
  of them hide a laboratory under a trapdoor) and shipwrecks on the sea floor
  or run aground, with supply and treasure chests.
- Villages in four styles (oak, spruce, birch, sandstone) with a well, dirt
  paths, lamp posts, houses with beds, doors, windows and stair roofs, a
  smithy, fenced animal pens, irrigated crop fields and loot chests. Settlers
  (farmers, smiths, shepherds and scholars) live in them.
- Underground dungeons: mossy rooms with a creature spawner and loot chests.
- Observatories underground with a library, store rooms, a creature spawner
  and a ring of twelve star gate frames.
- **The Underworld**: a 128-block-tall cavern dimension with a lava sea,
  scorchstone, cinder sand that slows you down, glowing ember crystals,
  glowcaps, quartz and gold ores, rare fallen starsteel, magma rock that burns, ruined ember-brick
  outposts with loot, and three regions (Glowing Grove, Cinder Flats, Ashen
  Wastes). Distances there count eight times over.
- **The Void**: reached by filling all twelve star gate frames with eyes of
  stars (void pearl plus ember dust; thrown, an eye flies toward the nearest
  observatory). A floating duskstone island with eight obsidian pillars
  crowned by healing pylons, guarded by the **Void Wyrm**, a 200-health flying
  serpent that circles, dives and spits void orbs. Defeating it opens the
  fountain home, leaves an egg and opens a gateway to the outer islands, with
  void stalks and blooms and astral spires holding loot and a **glider**.
  Gloamers (tall teleporting creatures that hate water) roam it and appear
  rarely in the Overworld at night.

**Rendering**
- WebGL 2 at native device pixel ratio, with a 50–200% resolution scale
  (above 100% supersamples).
- Sun (and moonlight) shadow maps with soft filtering, an HDR target with
  bloom on lamps, torches, lava and fire, tone mapping and colour grading,
  FXAA or 4x MSAA, rippled water that reflects the sky with a sun glint, and
  round shadows under creatures.
- Flood-filled sky and block light with smooth lighting and ambient occlusion,
  computed exactly across chunk borders.
- Day/night cycle with sun, moon phases, rotating stars, sunrise/sunset glow,
  fog tinted toward the sun, rain and snow, and volumetric-style clouds.
- Animated water and lava, waving leaves and plants, translucent water with
  sloped flowing surfaces, underwater and lava fog.
- HD procedural textures (64px per block, 256px creature skins) with
  anisotropic filtering and per-pixel relief lighting; Classic 16px on demand.
- Particles for mining debris, torches, smoke, bubbles, splashes, rain,
  explosions, laser sparks and fireworks.
- Banners with swaying patterned cloth, a dozen original paintings painted at
  run time, item frames showing their item, and beacon beams.
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
- **Spark circuits**: spark dust wire (power fades over 15 blocks), spark
  torches (inverters), levers, stone and wooden buttons, pressure plates,
  repeaters with four delays, comparators (compare or subtract; they read how
  full a container is, a cauldron or a cake), observers that pulse when the
  block they watch changes, lamps, pistons and sticky pistons (push up to
  12 blocks), note blocks, daylight sensors, dispensers, droppers, hoppers,
  blast crates, doors, trapdoors and fence gates that open with power.
- **The Photon Blaster**: a laser gun (iron, glass, spark dust) that fires
  glowing bolts, hold for rapid fire; 48 shots per energy cell with a reload,
  enchantable with Power, Unbreaking and Rapid Fire. Bolts set targets
  alight, prime blast crates and shatter glass. **Sky rockets** burst into
  coloured fireworks, or boost a glider in flight.
- **Workstations**: the anvil repairs (with materials or a second item),
  merges enchantments (and applies enchanted books) and renames for a level
  cost, and wears out; the grindstone strips enchantments for experience and
  joins worn tools; the smithing table upgrades diamond gear to starsteel
  (scrap from the Underworld, smelted and alloyed with gold), keeping its
  enchantments; the composter turns plant matter into bone meal; a lectern
  holds a book whose page a comparator reads; the crafter crafts its 3×3
  pattern each time it is powered (slots can be blocked off); the loom
  adds up to six patterns (12 designs, coloured with wool or dye) to banners; a
  beacon on an iron, gold, diamond or emerald pyramid sends up a beam and,
  paid with an ingot or gem, grants Speed, Jump Boost, Fire Resistance,
  Night Vision or Strength (plus Regeneration at full size) to players
  nearby; void chests share one inventory per player everywhere; cauldrons
  hold water for buckets and bottles and fill in the rain.
- **Rails and vehicles**: rails that curve and climb, powered rails (boost,
  brake, launch from rest) and detector rails; minecarts with slopes and
  momentum; boats you row and steer on water.
- **Brewing and potions**: brewing stands fuelled with ember dust. Glowcap
  makes awkward potions; ingredients give Swiftness, Strength, Healing,
  Poison, Regeneration, Night Vision, Water Breathing, Fire Resistance, Slow
  Falling and Leaping; a fermented crawler eye corrupts them (Slowness,
  Harming, Weakness, Invisibility); spark dust lengthens, ember crystal
  strengthens, blast powder makes splash potions. Effects show on the HUD,
  milk clears them, golden apples give absorption hearts.
- Fire that spreads and burns out, flint and steel, lanterns, signs you can
  write on, glass panes, iron bars, cobwebs, cake, a shield that blocks
  attacks, fishing rods with bites and treasure, and maps that fill in as you
  explore.
- Experience orbs from mining, smelting, breeding, trading and fighting;
  levels shown on the XP bar. Spend them at an enchanting table (more power
  with bookshelves around it): Efficiency, Sharpness, Unbreaking, Protection,
  Feather Falling, Power, Fortune and Knockback. Enchant a book to carry an
  enchantment to anything at the anvil; books turn up in loot and trades.
- Dyes from flowers, bone meal, coal and cactus (mixed for orange and
  purple) colour wool, sheep (which then grow coloured wool) and banners.
- Trading with settlers: each profession has its own offers, which sell out
  and restock.
- Animals breed when fed and grow up from babies; chickens lay eggs.
- Pigs, cows, sheep (shearable) and chickens that wander, look at you and
  panic when hit. Hounds roam forests and taiga: tame one with bones, tell it
  to sit, feed it meat; it follows you (and catches up) and fights what you
  fight. Steeds graze on plains and savanna: mount one until it trusts you,
  saddle it and ride with WASD and jumps. Iron sentinels guard villages, and
  you can build one (four iron blocks and a carved pumpkin) or a frost
  sentinel (two snow blocks) that pelts creatures with snowballs. Shroom cows
  on mycelium give mushroom stew. Name tags name creatures.
- Foxes (red, or white in the snow) are shy, doze by day, hunt chickens at
  night and carry what they find in their mouths; foxes you breed trust you.
  Stray cats live in villages: win one over with fish and it sits, follows,
  keeps crawlers away and leaves you presents after you sleep. Parrots flit
  through the jungle, dance to note blocks, mimic the creatures they hear and,
  once tamed with seeds, ride on your shoulder. Bees gather pollen, help
  crops grow and fill their nests with honey (bottle it, or shear honeycomb
  for beehives; a fire beneath keeps them calm, otherwise they sting).
  Alpacas in the hills are won over with wheat or hay, carry a chest of your
  things and spit at what threatens them. Dolphins swim in pods, need air,
  leap from the waves, lend swimmers Sea Grace and, fed a fish, lead the way
  to sunken treasure. Sweet berries grow on bushes in the taiga.
- Rabbits (brown, white in the snow, gold in the desert) hop about and raid
  carrot fields; their hide makes leather and a lucky foot brews leaping.
  Goats leap about the peaks, now and then lower their heads and ram
  whatever stands near, and a charge into rock can knock off a horn that
  sounds one of four calls. Turtles plod along beaches and shed a scute as
  they grow; five make a turtle shell that lends ten seconds of breath after
  each dip. Squid pulse through oceans and rivers and squirt ink when hurt
  (ink sacs make black dye and journals). Frogs (three colours) hop and swim
  in swamps and croak at night.
- Leads (string and leather) tie a creature to you; it follows, can be tied
  to a fence post and taken off again, and the lead snaps if pulled too far.
- Journals: write in a journal and quill (pages you can add, then sign with
  a title); read signed journals in hand or on a lectern, whose page a
  comparator reads.
- The living landscape: petals drift down from blossom trees, fireflies glow
  over swamps, meadows, plains and forests on warm nights, and full hives
  drip honey.
- Creatures find their way with pathfinding: around walls, up steps, down
  safe drops and away from lava and cacti; settlers open doors and close
  them behind them.
- Hostile creatures: ghouls that burn in daylight, bone archers that shoot
  arrows, wall-climbing cave crawlers that leap, cinder imps in the
  Underworld, hexers in swamps that throw slowing, poisoning and harming
  potions and drink healing ones, and tide wardens that charge a beam at
  swimmers around the citadels. Some wear armor. Raiders: axe-wielding
  marauders, rangers with bows and the brutes that march with them.
- **Raids**: defeat an outpost's captain and an Ill Omen follows you; walk
  into a village with it and the raiders come in waves (three or more, with
  a war horn and a progress bar). Beat every wave and you are the Village
  Hero, with better prices from its settlers; lose the villagers and the
  raiders celebrate.
- Thunderstorms with lightning strikes, a clock and a compass, milestone
  toasts for firsts (first timber, iron, diamonds, the Underworld and more).
- Worlds (both dimensions), inventories, experience, block containers,
  animals and settlers with their trades are saved in the browser (IndexedDB)
  with autosave every 30 seconds.

**Not included (yet)**: compared with the game that inspired it, there are
still fewer biomes and structures (no deep dark, ancient cities, trial
chambers, ocean monuments' full interiors or end cities), no armor trims,
copper ageing, sculk, axolotls, camels, glow squid or turtle eggs (turtles
breed like other animals), and eight dye colours rather than sixteen.
Pathfinding is
bounded (a few hundred steps per search) and doesn't plan ladder climbs or
swims through deep water. Raids are not saved mid-wave. In multiplayer
everyone shares the host's dimension, guests can't open an alpaca's pack,
and the host's world lives in their browser (browsers may still slow a
hidden tab's timers). Frame rate depends on the device; the presets exist so
slower machines can trade detail for speed.

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
| `src/circuits.js` | Spark circuits: power, wire networks, pistons, timers |
| `src/vehicles.js`, `src/effects.js` | Rails, minecarts, boats; status effects, potions, brewing |
| `src/dims.js`, `src/voidlands.js`, `src/voidboss.js` | Dimensions; the Void's islands; the wyrm, pylons and star eyes |
| `src/features.js`, `src/fishing.js`, `src/maps.js` | Vehicles, brewing, hoppers, fire, signs, star gates; fishing; maps |
| `src/quality.js` | Graphics presets and settings |
| `src/blaster.js`, `src/laser.js` | The photon blaster, laser bolts and sky rockets |
| `src/creatures.js` | Hounds, steeds, sentinels, hexers, tide wardens, shroom cows |
| `src/wildlife.js`, `src/raiders.js` | Foxes, cats, parrots, bees, alpacas, dolphins; marauders, rangers, brutes and raids |
| `src/fauna.js` | Rabbits, goats, turtles, squid and frogs |
| `src/pathfind.js` | Bounded A* pathfinding over the block grid, doors |
| `src/features5.js` | Hives and honey, berry bushes, composter, lectern, crafter, sea life, treasure, leads, ambient life |
| `src/decor.js`, `src/workshop.js` | Banners, item frames, paintings; anvil, loom, beacon, grindstone, smithing and compost rules |
| `src/landmarks.js` | Mineshafts, temples, shrines, huts, citadels, manors, outposts, igloos and shipwrecks |
| `src/net.js`, `tools/relay.mjs` | Shared worlds and their transports; the relay server |
| `src/online.js`, `tools/broker.mjs` | Online play: WebRTC hub, encrypted matchmaking over MQTT, copy-paste requests; a tiny test broker |

Tests drive the built game in headless Chromium and save screenshots:

```
NODE_PATH=$(npm root -g) node tools/systems.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/play.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/features.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/gallery.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/round3.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/graphics.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/round4.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/round5.cjs file://$PWD/dist/blockforge.html /tmp/shots
NODE_PATH=$(npm root -g) node tools/round6.cjs file://$PWD/dist/blockforge.html /tmp/shots
node tools/relay.mjs 8799 &   # serves the game and relays messages
NODE_PATH=$(npm root -g) node tools/multiplayer.cjs http://localhost:8799/ /tmp/shots tabs
NODE_PATH=$(npm root -g) node tools/multiplayer.cjs http://localhost:8799/ /tmp/shots relay
node tools/broker.mjs 8899 &  # a minimal MQTT-over-WebSocket broker for the handshake
NODE_PATH=$(npm root -g) node tools/multiplayer.cjs http://localhost:8799/ /tmp/shots online ws://localhost:8899
NODE_PATH=$(npm root -g) node tools/multiplayer.cjs http://localhost:8799/ /tmp/shots manual
```

`tools/texture-sheet.mjs out.png [detail] [tile px] [filter]` renders the
textures (at any detail) into one PNG for review.
