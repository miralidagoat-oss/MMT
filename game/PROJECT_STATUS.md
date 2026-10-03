# Tidewake — Project Status

_Last updated: 2026-10-03_

## Build status
| Check | Command | Result |
|---|---|---|
| Typecheck (strict) | `npm run typecheck` | ✅ clean |
| Production client build | `npx vite build` | ✅ (≈1 MB JS, 300 KB gzip + 180 KB worker) |
| Unit + integration + acceptance tests | `npm test` | ✅ 40 / 40 passing |
| Browser end-to-end (Chromium, SwiftShader WebGL) | `npx tsx tools/e2e-smoke.ts` | ✅ menu, single-player, all UI screens, mouse drag & drop, death screen, 2 browsers in multiplayer; no page or console errors |
| Server profile | `npx tsx tools/profile-sim.ts` | ✅ see Performance |

## Completed systems (implemented **and** tested)
| System | Notes | Tests |
|---|---|---|
| Engine/project foundation | TypeScript, Three.js, Vite, Node server, msgpack protocol | build, typecheck |
| Deterministic world generation | 13 islands, 6 archetypes, reefs, lagoons, wrecks, caves, spawn zones, world fingerprint | `worldgen.test.ts` |
| Player controller | walk, sprint, crouch, jump, step-up, slopes, wading, swimming (rides waves), diving, fall damage | gameplay, multiplayer, acceptance |
| Interaction & targeting | analytic node raycasts + entity raycasts, context prompts | e2e |
| Inventory | stacks, splitting, swapping, equipment, weight, durability, spoilage, containers, drag & drop | `inventory.test.ts`, e2e drag & drop |
| Resources | 20 node types, tool tiers, per-hit yields, respawn | gameplay, acceptance |
| Crafting | 49 data-driven recipes over 90 items, discovery unlocks, stations, queue, cancel with refund | gameplay, acceptance |
| Survival | hunger, thirst, stamina, oxygen, body temperature, wetness, bleeding, poison, nausea, fracture, starvation, exposure | gameplay, acceptance |
| Building | 7 modular pieces × 3 tiers (thatch/timber/brick) plus 21 doors, stations, storage, utilities, defenses, furniture, boats and the beacon; snapping, support, collision, terrain and water rules, upgrade, repair, demolish cascade | gameplay, acceptance |
| Fire & cooking | fuel, ignition (tool reliability), rain/storm, cook → burn, clay-pot distillation, warmth, light | gameplay, acceptance |
| Water | coconuts, flasks, waterskins, rain catchers, solar stills, distillation, salt-water penalties | gameplay, acceptance |
| Farming | 4 crops, garden plots, watering, growth, withering, harvest + seeds, persistence | acceptance |
| Drying rack | spoil-proof jerky and dried berries | `systems.test.ts` |
| Wildlife | crab, boar, snake, fish, ray, shark, gull FSMs; detection, LOS, hearing, attacks, bleed/poison, flee, butchering, respawn, sharks harass rafts, animals batter walls, barricades hurt animals | gameplay, acceptance |
| Ocean | shared analytic waves (sim + shader), buoyancy, oxygen, deep-water danger | acceptance |
| Boats | log raft and outrigger sailboat: build in water, seats, paddling, wind sailing, anchor, cargo, grounding damage, storms, repair, sinking | acceptance |
| Navigation | compass strip, map with fog of war, island names, wreck markers, waypoints, teammate markers, spyglass | e2e screenshots |
| Weather & day/night | Markov weather (clear/cloudy/rain/storm/fog), wind, waves, lightning; authoritative clock; sky palettes | acceptance, visual QA |
| World events | supply drops that drift ashore, storm fronts, shark frenzies, fish runs, rescue | `systems.test.ts` |
| Progression | 19-step objective chain → distress beacon (must be on high ground) → rescue ship | `systems.test.ts` (beacon → rescue) |
| Death & respawn | graves hold your gear, respawn at bed or beach, co-op downed/revive state | gameplay, acceptance |
| Multiplayer | server-authoritative, prediction/reconciliation, interpolation, delta snapshots, late join, reconnect, duplicate-action rejection, input-flood protection, 4-player cap, lag/loss conditioner | `multiplayer.test.ts`, acceptance, e2e |
| Save/load | versioned, CRC-checked, migrations, atomic writes, rotating backups, corruption fallback, IndexedDB single-player saves | acceptance (save → relaunch → rejoin), `systems.test.ts` (corruption, backups, migration) |
| UI | main/new/load/multiplayer/settings/pause/death/loading screens, HUD, inventory, crafting, stations, build menu, map, journal, chat, player list, controller navigation | e2e screenshots |
| Settings | resolution presets, render scale, dynamic resolution, FPS cap, V-Sync, fullscreen, 5 quality presets and per-feature graphics options, audio buses, rebindable keys, gameplay options | e2e screenshot |
| Audio | procedural SFX, ambience, music, spatial audio, underwater filter | manual (headless browser has no audio output) |
| Graphics | custom sky, PBR + PMREM, terrain splatting, caustics, ocean shader, instanced vegetation with wind, grass, shadows, GTAO, bloom, god rays, grading, SMAA/FXAA/MSAA | visual QA screenshots |

## Acceptance scenario (`tests/acceptance.test.ts`) — ✅ passing
Four clients connect through the real protocol over a link with 60 ms lag, 30 ms
jitter and 5% loss:

✅ 4 players connect and spawn on dry land · ✅ move independently and see each other ·
✅ gather resources (real walking + gather actions) · ✅ inventory sync ·
✅ craft tools (cordage, axe, mallet, hand drill) · ✅ fell a tree (depletion seen by
others) · ✅ build a foundation, walls and roof → sheltered · ✅ lean-to sets respawn ·
✅ build, fuel and light a fire · ✅ cook and eat · ✅ distill sea water in a clay pot and
drink it · ✅ swim · ✅ dive (oxygen drains) · ✅ surface · ✅ hunt a crab ·
✅ build a raft in the sea, board as driver + passenger, paddle with real inputs, cross
to another island, passenger carried · ✅ disembark and discover the island ·
✅ time passes, weather changes, survival stats drain · ✅ a player dies (grave
created) and respawns, others stay in sync · ✅ a player disconnects, others keep
playing, they reconnect as the same survivor · ✅ farming: plant, water, grow ·
✅ save → close → relaunch from the save → load → structures, vehicles, crops, time,
inventories, progression, respawn point and sheltering verified → players rejoin.

Multiplayer consistency is additionally tested at 80 ms / 5% loss and
150 ms / 15% loss with 4 clients (prediction error < 0.35 m; remote error < 0.6 m).

## Performance (tools/profile-sim.ts, 4 moving players)
* Server tick: **0.54 ms average**, p99 1.4 ms, worst 31 ms (first-touch node chunk
  generation), against a 50 ms budget.
* Bandwidth: **17–29 KiB/s per player** (snapshots), about 0.2 KiB/s reliable.
* Server memory: about 17 MiB heap, 116 MiB RSS.
* Client: frame time is dominated by GPU work. On SwiftShader (software rendering
  in CI) the High preset runs at about 14 fps at 1280×720; real GPUs are far faster.
  Use the preset, render-scale and dynamic-resolution options to tune.

## Known issues
* Graphics have only been verified on SwiftShader (headless software WebGL); no
  hardware-GPU testing in CI. MSAA + depth-texture combinations depend on driver
  support.
* Audio is verified by code paths only: the headless browser has no audio device.
* The first visit to a new area can cause a one-off server hitch of up to about
  30 ms while resource nodes for that chunk are generated (inside the tick budget).
* Water-quality changes apply on the next world load.

## Multiplayer issues
* No host migration (by design: dedicated or listen server; the save is portable).
* Browser-hosted multiplayer (WebRTC) is not implemented; hosting runs the Node
  server, which also serves the game.

## In progress / remaining
See `TODO.md`.
