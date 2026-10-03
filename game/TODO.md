# Tidewake — TODO

Concrete remaining work, roughly in priority order. Items are only removed when they
pass their acceptance criteria (see PROJECT_STATUS.md).

## Gameplay depth
- [ ] Walkable boat decks: players are currently seated while aboard (driver + 3
      passenger seats); walking around a moving deck is not supported.
- [ ] Throwable spear / harpoon line; aimed spear-fishing minigame underwater.
- [ ] Hunger/thirst UI feedback when eating (nutrition preview in tooltips exists).
- [ ] More late-game content after rescue: a second boat tier with an engine, metal
      buildings, map table with shared annotations.
- [ ] Caves: interior loot and creatures (bats, eels); currently a rock arch shell with
      one cache crate.
- [ ] Taming or animal husbandry (chickens/goats) for renewable food.

## Multiplayer
- [ ] Host migration (out of scope for the dedicated/listen-server architecture; the
      portable save lets any player re-host instead).
- [ ] Player-hosted games straight from the browser via WebRTC (currently hosting
      requires running the Node server, which also serves the client).
- [ ] Optional server password and kick/ban commands.
- [ ] Lag-compensated melee hit validation (current validation is range/angle
      tolerant rather than rewound).

## Presentation
- [ ] Authored art to replace the procedural placeholders (asset replacement points:
      `client/render/textures.ts`, `models.ts`, `structure-models.ts`, `ui/icons.ts`,
      `audio/audio.ts` → `buffers`).
- [ ] Skinned character models and animation blending (current avatars use
      procedural limb animation).
- [ ] Screen-space reflections or planar reflections on calm water (Ultra/Insane).
- [ ] Volumetric clouds; currently a 2-layer animated cloud dome.
- [ ] Footprints in sand, wet-surface rain ripples, wake trails behind boats.
- [ ] Localisation (all UI strings are English and inline).

## Engineering
- [ ] Move world-gen chunk node generation and terrain meshing into a worker pool
      (main-thread budgets keep frames smooth, but loading is slower on low-end CPUs).
- [ ] Binary snapshot encoding with bit-packing (msgpack + delta snapshots currently
      use about 17–30 KiB/s per player).
- [ ] Desktop packaging (Electron/Tauri wrapper that bundles the server for one-click
      hosting).
- [ ] Server-side spatial index for structures used by `isSheltered` and fire-warmth
      checks (linear scans today; fine below ~2000 structures).
