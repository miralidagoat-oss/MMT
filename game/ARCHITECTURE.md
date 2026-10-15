# Tidewake — Technical Architecture

Tidewake is an original 1–4 player co-op ocean-island survival game. It is written
in TypeScript end to end:

| Layer | Tech | Location |
|---|---|---|
| Authoritative simulation | Pure TypeScript, no I/O, deterministic world gen | `src/shared/` |
| Dedicated / listen server | Node.js + `ws` WebSockets, filesystem saves | `src/server/` |
| Single-player host | The **same** simulation inside a Web Worker, IndexedDB saves | `src/client/net/local-worker.ts` |
| Client | Three.js (WebGL2) renderer, DOM UI, WebAudio | `src/client/` |
| Wire format | msgpack (`msgpackr`) | `src/shared/net/codec.ts` |
| Tests | Vitest (unit, integration, acceptance), Playwright (browser E2E) | `tests/`, `tools/` |

Single-player is not a separate code path: the client always talks to a `GameHost`
through a `Transport`. In single-player the host runs in a worker; in multiplayer it
runs in the Node server. Everything below the transport is identical.

```
 ┌────────────── client (browser) ───────────────┐        ┌──────── host (Node server or Web Worker) ────────┐
 │ Input → Game ──intents──▶ ClientSession ──────┼─msgpack▶ GameHost ─▶ Simulation.submitAction / inputs  │
 │   ▲        │  prediction (shared movement)    │        │     │            │ tick @ 20 Hz                  │
 │   │        ▼                                  │        │     │            ▼                               │
 │ HUD/UI ◀─ replicated world ◀─ snapshots/deltas┼◀───────┤ replication (snapshots, reliable deltas, fx)     │
 │ Renderer ◀─ interpolation buffers             │        │ SaveStore (fs / IndexedDB, versioned + CRC)      │
 └───────────────────────────────────────────────┘        └──────────────────────────────────────────────────┘
```

## 1. Core systems (`src/shared`)

* `config.ts` — every tunable (tick rate, speeds, survival rates, build grid,
  network limits). Gameplay code reads numbers from here or from `defs/`.
* `defs/` — all content as data: items, recipes, structures, creatures, resource
  nodes, crops, vehicles, loot tables. Adding content means adding data.
* `state.ts` — the serializable `WorldState` (everything that is saved).
* `sim/simulation.ts` — the `Simulation` class: owns `WorldState`, the world
  generator, the collision world and the RNG; runs subsystems in a fixed order each
  tick and emits an output record (dirty keys, FX, notifications, action results).
* `sim/*` — subsystem modules operating on the simulation: `actions` (intent
  validation + dispatch), `survival`, `crafting`, `stations` (fires, cooking, water,
  drying, farming, lights, beacon), `wildlife`, `vehicles`, `combat`, `fishing`,
  `events`, `world-init`.
* `systems/*` — pure logic shared with the client: `movement` (player physics),
  `inventory`, `building` (snapping + validation + stability), `weather` (time/sky).
* `world/*` — `worldgen` (islands, terrain, biomes, nodes, wrecks, caves, spawn
  zones), `collision` (terrain + structures + nodes + cave rocks), `ocean` (the
  analytic wave function).

### Data flow per server tick (20 Hz)
1. Weather/time advance.
2. Each player's queued input frames are simulated (max frames per tick =
   real-time budget, so a client cannot move faster by sending more frames).
3. Survival → crafting → stations → wildlife → vehicles → projectiles → world events
   → dropped items → node respawn → sleep check.
4. The tick returns `SimOutput`; `GameHost` turns it into reliable deltas, results,
   notifications, FX and (every tick) per-client snapshots.

### Determinism
* All randomness flows through `math/rng.ts` (sfc32, serializable state) or integer
  hashing (`hashInts`, `hash01`). `Math.random` is never used by the simulation.
* World generation is a pure function of `(seed, WORLDGEN_VERSION)`. Clients verify a
  world fingerprint on join and refuse to play on a mismatch.
* Creature AI decisions use `hash01(creatureSeed, tick, k)`.
* The simulation runs at a fixed timestep; movement sub-steps at 1/60 s.

## 2. Networking model

* **Server-authoritative.** Clients send *intents* only: input frames and actions
  (`shared/net/protocol.ts`). The server validates range, possession, tool tier,
  cooldowns, stamina, station proximity, placement rules and container access.
  Clients can never create, move or delete items directly.
* **Prediction & reconciliation** (`client/net/session.ts`): the local player runs
  the shared `stepMovement` at 60 Hz against a client-side `CollisionWorld` built from
  the same seed + replicated structures. Each snapshot carries the last processed
  input sequence; the client rewinds to the authoritative state, replays unacknowledged
  inputs, and hides small errors with a decaying visual offset.
* **Inputs** are batched at ~30 Hz with the last 3 frames resent redundantly so an
  occasional dropped packet costs nothing. The server deduplicates by sequence.
* **Actions** carry a client id; the server keeps a sliding window of seen ids per
  player (duplicate packets are ignored) and rate-limits actions per second.
* **Snapshots** (20 Hz): self state for the owner, all teammates (for map markers),
  and creatures/vehicles/projectiles inside a 260 m interest radius. Per-client
  delta compression: an entity is re-sent only when its quantized state changes or as
  a 1 s keep-alive; distant creatures update at 5 Hz. Clients interpolate remote
  entities 110 ms in the past.
* **Reliable deltas** carry structures, containers, node depletion, dropped items,
  waypoints, events, progression and the owner's private inventory.
* **Late join / reconnect:** the `welcome` message contains the full replicated world.
  Players are identified by a persistent per-browser token; reconnecting restores the
  same survivor (position, inventory, stats). A stale socket for the same identity is
  replaced. The client auto-reconnects with exponential backoff.
* **Disconnect:** the player leaves the world (seat released, container closed); their
  state persists in the world and in saves.
* **Host migration:** not supported. A dedicated server is the authority; for listen
  play the host's machine runs the server. The world save is portable, so any player
  can host the same world later.
* **Network conditioner:** `ConditionedTransport` (client) and `--lag/--jitter/--loss`
  (server) inject latency, jitter and loss of unreliable traffic for testing.

### Web co-op relay (hosted page)

The hosted web page cannot open sockets or WebRTC, so online co-op rides the
page's live **room** channel. The host still runs the authoritative `GameHost`
(in its Web Worker); only the transport changes.

* **Lobby** (`client/net/room.ts`): a hosting page advertises its game in its lobby
  presence (`tw.ad`: code, host name, world, players, day, protocol). Other pages
  list these as "Open games". To join, a page announces `tw.join = code` plus a random
  request id, and both sides join the private named room `tw-<code>-<rid>`.
* **Link** (`shared/net/presence-link.ts`): presence is latest-value-wins (up to
  4 KiB, about 30 updates/s per page across all rooms), so each side publishes its
  whole link state. Reliable frames are split into numbered base64 chunks, and every
  state carries the unacknowledged window, so skipped intermediate states lose
  nothing. Cumulative acks free the window. One "latest" unreliable frame (snapshot
  or input batch) rides alongside it and is deduplicated by a counter. Epochs detect a
  restarted peer. States are bounded by `maxBytes` (3800) and parsed defensively.
* **Pacing:** the host builds a snapshot for a relayed peer only once the previous
  one has gone out (`Peer.wantsSnapshot`), so delta snapshots stay consistent.
  Clients use `RELAY_TUNING`: 12 Hz input batches with 10 redundant frames and a
  280 ms interpolation delay.
* **Routing** (`client/main.ts`, `net/local-worker.ts`): the main thread owns the
  room links. The worker exposes `peer-open`, `peer-frame`, `peer-ready` and
  `peer-close`, and emits `peer-out` and `peer-kick`. The world is opened to
  friends with `open` (cap 4). While it is open, the host's pause menu does not stop
  the simulation.
* **Platform rules the link follows:** every presence state stays under 4 KiB and
  every string in it under 1 KiB (reliable chunks are 720 raw bytes, and snapshots
  are split into ≤1000-character pieces). The page shares one budget of about 40
  updates a second, so the host spaces its links accordingly (`LinkPump`). The
  platform marks a player's other tabs and devices as `isMe`; those are real
  partners, so only the current page (`sameTab`) and agent peers are ignored.
  Partners missing for less than 15 s (routine reconnects) are kept.
* **Background tabs:** browsers throttle main-thread timers in hidden tabs, so the
  link pump, peer polling and the joiner's keep-alive run off a tick from a tiny
  blob-URL worker (`client/net/ticker.ts`). The host's own player is exempt from
  the idle timeout.
* **Identity:** a signed-in player's account id becomes the survivor identity and
  is remembered locally. Each page load also sends a tab id: a reconnect from the
  same page takes over the stale connection, while the same account in another tab
  or on another device gets its own survivor (`token#2`, …) instead of kicking the
  first one.
* **Host handoff:** when the host chooses Save & Quit while friends are connected,
  the world is frozen and saved, and the save (gzip, about 30 KB) goes over the
  reliable lane as a `handoff` message to the friend who joined first. That friend
  stores it, loads it and opens it to friends under the **same game code**. The
  others receive a non-fatal notice and reconnect by code on their own, waiting up
  to 90 s for the new host. Survivors carry over because identities are tokens, not
  hosts. The departing host waits until everything has been acknowledged (or its
  partners have left, at most 30 s), and links linger 1.5 s on close so final acks
  get through.
* **Tab-close takeover** (`client/net/succession.ts`): a host can also vanish without
  warning (tab closed, browser crashed, network gone). While friends play, the host
  keeps a **rolling backup** with each of them: about every 30 s (and a few seconds
  after someone joins) the worker serializes the world without storing it, the page
  gzips it (about 30 KB) and streams it in 1380-byte `backup` parts, at most four
  relay chunks in flight (`PresenceLink.sentSeq/ackedSeq`), so gameplay traffic is
  never crowded out. A friend's backup counts once every part was acknowledged. The
  host then sends each friend a `succession` message: the takeover order (friends
  holding a complete backup, earliest joiner first) and the friend's own rank.
  When the host's link goes quiet (its page left the room for 15 s, or the
  best-effort `host-gone` sent on `pagehide` arrives), the friend at rank *r* waits
  *r* × 30 s, then checks the lobby (`checkHost`): an ad for the code with a newer
  generation means someone already took over (join them); the old host's ad still
  being refreshed (its `beat` changes) means the friend's own connection was the
  problem (reconnect); otherwise the friend claims the code at once (an ad with
  generation + 1), reopens the backup as its own world and opens it to friends under
  the same code. Everyone else keeps reconnecting by code and lands on the new host.
  The decision is never made on a lobby the friend is not connected to.
* **Generations:** every hosting of a code carries `gen` (0 for the first host, +1
  per handoff or takeover). A host that sees a newer hosting of its own code (it was
  away while a friend took over) **yields**: it tells any remaining friends the world
  moved, saves its own copy to its saves, and joins the new host as a player. Two
  hosts of the same generation agree on the lexicographically smaller peer id. The
  open-games list shows only the newest hosting of each code.
* **Priorities on the link:** reliable chunks normally go first, but a snapshot that
  already missed one publish gets its room first in the next, so a long reliable
  transfer delays snapshots by at most one publish. While more than 12 reliable
  chunks are queued (a joiner's welcome state), the host holds new snapshots back so
  the transfer finishes sooner.
* **Consent:** the hosted page asks for all of its capabilities in one dialog after
  start-up (`client/net/permissions.ts`). If online play is declined, the
  multiplayer screen says so and opens the Permissions panel.
* **Trust:** ads are clamped and stripped of control characters. A private room binds
  to the first peer that published link state, and everyone else is ignored. Frames
  go through the same validation, rate limits and dedupe as any client.
* **Tests:** `tests/relay.test.ts` covers the link over a simulated latest-wins
  relay, and 4 players plus a refused 5th through a 4 KiB, 30 Hz presence model.
  `tests/succession.test.ts` covers backup streaming while the game runs, the
  takeover order, the takeover decision and generation yielding.
  `tools/e2e-coop.ts` runs up to 6 real browsers against `tools/mock` (a local
  stand-in for the platform, with a hook that drops a page's connection), including
  a host closing its tab and a host whose connection drops and comes back.

### Saves on the web

The worker saves to IndexedDB with a rotating backup and posts each save to the
main thread. There, `client/net/cloud.ts` uploads it to the signed-in player's
private document area (`data/users/<id>/saves/...`), throttled to one upload every
2 minutes per world plus forced uploads on manual save, quit and tab hide. A save is
split into 200 KB parts written under a new generation, and the index document is
switched last, so an interrupted upload never replaces a good copy. Loading pulls
the newer of the device and cloud copies. `client/net/worlds.ts` adds file
export/import (the CRC-checked envelope is the file format).

## 3. Save architecture (`shared/save.ts`)

* Envelope: `{format, version, game, savedAt, name, seed, day, players, checksum, payload}`.
  `checksum` is CRC32 of the JSON payload; mismatches are rejected as corruption.
* `MIGRATIONS[n]` upgrades a version-n payload to n+1; loading applies every step.
* `sanitizeWorld` drops references to content that no longer exists.
* Server store (`server/savestore.ts`): atomic write (tmp + rename), three rotating
  backups, automatic fall back to the newest valid backup. Autosave every 5 minutes and
  on shutdown (SIGINT/SIGTERM/crash).
* Single-player store (`client/net/idb.ts`): IndexedDB with a backup slot; autosave
  every 5 minutes, on quit and on page unload.
* Saved: seed, time, weather, RNG state, players (position, inventory, stats,
  progression, respawn point, explored map), node depletion, structures, containers,
  dropped items, creatures, vehicles, spawn zones, events, waypoints, progression.

## 4. World generation (`shared/world/worldgen.ts`)

* 13 islands in a 5.2 km sea: a start island at the origin plus guaranteed
  archetypes (sandbar, atoll with lagoon, rocky, jungle, volcanic); nearer islands are
  placed within raft range.
* Terrain height = max over island profiles (warped radial falloff + fbm/ridged
  noise, berm, reef shelf, drop-off) and an ocean floor. Biomes come from height,
  slope, archetype and noise.
* Resource nodes are placed per 64 m chunk on a jittered 4 m grid with
  biome/archetype densities. Node ids encode their chunk so any machine can look
  them up. Generation is lazy and cached.
* Shipwrecks (shallow and deep; deep wrecks always contain the beacon electronics),
  sea caves built from overlapping rock spheres, and creature spawn zones.
* **Caves** on rocky, volcanic and jungle islands are a 14 m tunnel with a closed
  roof. Each holds six glowcap clusters along the walls, a guano heap under the
  roost, a smuggler's cache (`cave_cache` loot) and a bat colony (spawn zone
  `zb<island>`). Cave life is listed in the chunk each node stands in and looked up by
  its `cave<island>.*` id. It is drawn from a separate random stream, so the rocks of
  older worlds keep their places; procedural nodes inside a tunnel are skipped but
  still use up their id, so every other node keeps its id. `caveDepth(x, y, z)` tells
  how deep inside a cave a point is (0 at the mouth, 1 about 4 m in).

## 5. Player architecture

* Authoritative state: `PlayerState` (`state.ts`).
* Movement: `systems/movement.ts` — walking, sprinting, crouching, jumping, step-up,
  slope limits, wading drag, swimming with buoyancy that rides the wave surface,
  diving, fall damage. Shared by server and prediction.
* Local presentation (`client/game/game.ts`): camera, head bob, view model,
  targeting (analytic node raycasts + three.js raycasts against replicated entities),
  interaction prompts.

## 6. Inventory architecture (`systems/inventory.ts`)

Slot arrays with stack rules (`canMerge`: same id, stackable, no per-instance state),
durability, water contents and quality, spoil timestamps (weighted-average merge),
weight and carry capacity, equipment slots (head/body/back/feet). Every mutation goes
through validated helpers; the server resolves slot references only for the player's
own inventory or the container they have open and are in range of.

## 7. Crafting architecture (`sim/crafting.ts`)

Recipes are data. A recipe is known when it is a starter recipe or when every unlock
item has been *discovered* (held at least once). Crafting requires a nearby station
(lit for fire stations), consumes inputs atomically at queue time, runs on a
per-player queue (max 8) that pauses when you walk away from the station, and refunds
on cancel. Progression: hand → workbench → kiln → forge → beacon core.

## 8. Building architecture (`systems/building.ts`)

* `computePlacement` (used by the client ghost) snaps by type: foundation grid,
  wall edges, floors/roofs on wall tops, doors in doorways, boats on water, free-place
  props on terrain or floors.
* `validateGeometry` (server and client): terrain slope, water depth (stilts allowed
  deeper), burial, OBB overlap against structures, solid nodes, duplicates, minimum
  altitude (beacon) and **support** rules.
* `findUnsupported` cascades collapses when a supporting piece is demolished.
* Upgrade in place (thatch → timber → brick), repair, and partial refunds.

## 9. AI architecture (`sim/wildlife.ts`)

Per-species finite state machines (idle / wander / feed / flee / chase / attack /
circle / return / dead). Creatures far from every player sleep. Decisions run at
5 Hz, staggered; movement runs every tick. Detection combines sight range, hearing
scaled by player noise (sprinting / crouching / swimming), night modifiers and
terrain line of sight. Habitat constraints keep fish and sharks in water and crabs on
beaches. Carcasses are butchered with cutting tools. Zones respawn creatures when no
player is watching. Sharks circle swimmers before striking and harass rafts.
Bats have their own small machine (`tickBat`): each hangs at its own spot under the
roof by day, the colony streams out through the mouth at dusk to hunt over the shore
and returns at dawn, and anyone right under them, or a light carried within 7 m,
sends them into a few seconds of frantic flight around the tunnel. Dead fliers drop
to the ground.

## 10. UI architecture (`client/ui`)

A framework-free DOM layer over the canvas: `menus` (main, new/load world,
multiplayer + server browser, settings, pause, loading, errors), `hud` (vitals,
effects, hotbar, compass, clock, prompts, notifications, chat, objectives, markers,
boat and fishing indicators), `inventory` (drag and drop, split, context menu,
equipment, containers, station panels, crafting), `panels` (build menu, map with fog
of war and waypoints, journal). Items have procedural icons (`ui/icons.ts`). Keyboard,
mouse and gamepad are supported; menus can be navigated with a controller.

## 11. Rendering architecture (`client/render`)

* `renderer.ts` orchestrates systems, resolution presets, render scale and dynamic
  resolution.
* `sky.ts` — custom analytic sky with art-directed palettes keyed on sun elevation
  (dawn, golden hour, sunset, twilight, night), sun/moon lighting, stars, an animated
  cloud dome, fog, and a PMREM environment probe rebuilt every 3 s.
* `terrain.ts` — per-island far meshes plus streamed 64 m near chunks with distance
  LOD and skirts, a splat shader (sand / wet sand / grass / dirt / triplanar rock) with
  underwater caustics and absorption, and a camera-centred height texture used by the
  ocean.
* `ocean.ts` — a radial grid displaced by the same wave function as the simulation;
  depth-based absorption, shore foam, crest foam, PMREM reflections, sun glitter,
  subsurface scattering and a Snell's-window underside.
* `vegetation.ts` — instanced nodes (bark / triplanar rock / foliage materials) with
  wind sway, plus dense instanced grass around the camera.
* `entities.ts` — structures, items, containers, wrecks, caves (rock shell plus a
  rocky floor that fades out at the mouth), animated remote players with name tags,
  creatures (hanging bats fold their wings), boats, projectiles, and a pooled
  point-light budget for fires, torches, lamps and cold blue glow (each nearby cave's
  remaining glowcaps, held glowcap jars).
* Caves are dark: as the camera goes in, the sky's hemisphere light and environment
  intensity fade (`EnvState.enclosed`, smoothed like eyes adjusting), so torches,
  jars and the glowcaps (a self-lit, slowly pulsing material that blooms) carry the
  scene.
* `particles.ts` — pooled particle system (fire, smoke, sparks, splashes, chips,
  blood, bubbles) and rain.
* `post.ts` — HDR scene target → optional GTAO → bloom → grading (god rays, underwater
  distortion, damage and low-health vignette, cold tint, sleep fade) → ACES output →
  SMAA, FXAA or MSAA.
* `textures.ts`, `models.ts`, `structure-models.ts` are the **asset replacement
  points**: all art is procedurally generated at startup and can be swapped for
  authored assets without touching gameplay code.

## 12. Audio architecture (`client/audio/audio.ts`)

A WebAudio graph: master → {music, sfx, ambient, ui} buses, an underwater low-pass on
world sound, a compressor, and HRTF panners for positional one-shots. Every sound is
synthesized (noise and oscillator recipes). Ambience mixes surf, wind, rain, birds by
day, crickets by night, fire crackle and underwater rumble from the listener's
environment; generative music plays occasionally. Registering an `AudioBuffer` under a
sound id in `audio.buffers` replaces any synthesized sound with recorded audio.

## 13. Testing architecture

* `tests/*.test.ts` (Vitest):
  * `worldgen` — determinism, layout guarantees, node lookup.
  * `inventory` — stacking, splitting, swapping, removal order, wear, weight.
  * `gameplay` — crafting, stations, harvesting, building, fire and cooking,
    survival, drowning and death, graves, respawn, co-op revive, fishing.
  * `multiplayer` — 4-player join, full-server reject, independent movement,
    authority checks (fabrication, duplicate action ids, input flooding), replication,
    disconnect and reconnect, version reject, consistency under 80–150 ms lag with
    5–15% loss.
  * `acceptance` — the full scenario from the design brief over a lossy link, ending
    with save → relaunch → load → rejoin.
* `tools/e2e-smoke.ts` — real Chromium (SwiftShader WebGL): menu, single-player,
  every UI screen, death screen and a 2-client multiplayer session; fails on any
  page or console error.
* `tools/shot.ts` — scripted visual QA scenes (day, dusk, night, storm, underwater,
  fire, base).
* `tools/profile-sim.ts` — server tick cost, bandwidth and memory profile.
