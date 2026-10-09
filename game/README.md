# Tidewake

An original 1–4 player co-op ocean-island survival game. You wash up on a scatter
of procedurally generated islands. Find water, make fire, build a home, hunt and farm,
then sail out to salvage deep wrecks for the parts to call a ship home.

Runs in any modern desktop browser with WebGL2.

## Play on the web

The game is published as a web page (built with `npm run build:web`, output in
`dist/web`). Open the link and play: no install and no server.

* **Single-player:** the world runs in your browser. It autosaves to the browser,
  and to your private cloud saves when you are signed in with edit access, so it
  follows you to other devices. Use **Load Game → Export** for a save file and
  **Import Save File** to bring it back anywhere.
* **Online co-op (up to 4 players):** choose **Play with Friends → Host a New World**
  (or **Host a Saved World**), or press Esc in any game and choose **Invite
  Friends**. Share the page link with your friends. They open it signed in, choose
  **Play with Friends**, and pick your game from **Open games** or type your
  6-character code. The host's browser runs the world (keep the tab open), and the
  world is saved in the host's worlds. Players who drop out can rejoin as the same
  survivor.

Online play travels over the page's live room channel (see ARCHITECTURE.md,
"Web co-op relay"). The Node server below remains available for self-hosting.

## Self-hosting with the Node server

```bash
cd game
npm install
npm run build        # builds the browser client into dist/client
npm start            # build + start a server on :7777 that also serves the client
```

Open **http://localhost:7777**. Choose **New Game** for single-player (the world runs
locally in your browser and saves to browser storage), or **Multiplayer → Join**
`localhost:7777` to play on the server.

### Hosting for friends (2–4 players)

```bash
npm run build
npx tsx src/server/main.ts --serve-client --port 7777 --world island
```

Friends open `http://YOUR-IP:7777` (or enter `YOUR-IP:7777` under Multiplayer).
Server options:

| flag | meaning |
|---|---|
| `--port 7777` | listen port |
| `--world name` | save slot name (files in `./saves/name.tws` + 3 backups) |
| `--seed text` | world seed for a new world |
| `--difficulty relaxed\|normal\|hard` | difficulty for a new world |
| `--cheats` | enable host commands (`/time`, `/weather`, `/give`, `/tp`, `/heal`, `/spawn`, `/event`) |
| `--serve-client` | also serve the built browser client |
| `--lag ms --jitter ms --loss 0.05` | network conditioner for testing |

The server autosaves every 5 minutes and when stopped with Ctrl+C.
`GET /api/info` returns server status (used by the in-game server browser).

### Development

```bash
npm run dev          # Vite dev server for the client (single-player works standalone)
npm run server       # dedicated server (no client serving)
npm test             # unit + integration + full acceptance scenario
npm run build:web    # the hosted web page (dist/web)
npm run test:e2e:web # 4 browsers: hosted page, co-op relay, cloud saves, export (needs build:web)
npm run typecheck
npx tsx tools/e2e-smoke.ts   # headless Chromium end-to-end test (needs npm run build)
npx tsx tools/shot.ts day dusk night storm underwater fire base   # visual QA screenshots
npx tsx tools/profile-sim.ts # server performance profile
```

## Controls (rebindable in Settings → Controls)

| | |
|---|---|
| Move / sprint / jump / crouch | WASD · Shift · Space · C or Ctrl |
| Swim up / dive | Space / C |
| Use tool / attack / cast / place | Left mouse |
| Aim bow, spyglass zoom, cancel build | Right mouse |
| Interact / gather / pick up / board | E |
| Eat · drink · use held item · upgrade/repair | F |
| Inventory · Crafting · Build menu | Tab · Q · B (holding the Builder's Mallet) |
| Map · Journal · Players | M · J · P |
| Rotate blueprint · sail (on a boat) | R |
| Waypoint · dismantle (with mallet) | X |
| Drop held item · Chat · Pause | G · Enter · Esc |
| Network/perf overlay | F3 |

Gamepads are supported in game and in menus.

## Graphics options

Quality presets (Low → Insane), internal resolution presets (720p to 4K or native),
render scale (50–200%, supersampling above 100%), dynamic resolution, FPS cap (30 to
240 or unlimited), V-Sync, fullscreen, FOV, brightness, shadow quality, view distance,
terrain detail, vegetation and grass density, water quality, water reflections
(off, half or full resolution; on by default from High), anti-aliasing
(FXAA/SMAA/MSAA), GTAO ambient occlusion, bloom, god rays, anisotropic filtering, and
an FPS counter.

See `ARCHITECTURE.md` for the technical design, `PROJECT_STATUS.md` for what is done
and tested, and `TODO.md` for remaining work.
