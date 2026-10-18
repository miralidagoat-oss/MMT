# Resting Order Levels (DOM) — live order-book support/resistance for Tradovate

`domLevels.js` connects to Tradovate's market-data API, reads the live **Depth
of Market**, and labels support and resistance at prices where **large resting
limit orders stay in the book**. It watches each one until it either holds,
gets filled, or gets pulled.

It is the companion to the chart indicator in
[`../indicators/tradovate`](../indicators/tradovate). The chart indicator reads
resting orders that already **filled**, which is all a Tradovate chart
indicator can see. This tool reads resting orders that are **still waiting**,
which only the API provides. It runs on your computer and shows its levels in
its own window, because the API has no way to draw on a Tradovate chart.

## What it shows

```
RESISTANCE (resting offers)
  R2 21020.00 | 640 resting | 4m10s | held 1x
  R1 21014.50 | 310 resting | 45s | pulled here 1x before
SUPPORT (resting bids)
  S1 21005.00 | 512 resting | 2m03s | held 2x | 120 filled  << ABSORBING
  S2 20998.25 | out of view (last 400, 1m10s ago) | 9m12s

RECENT
  10:41:07  PULLED  offer 21012.00  (peak 280, 0 traded there)  cancelled, not traded
  10:40:52  FILLED  bid 21001.50  (peak 350, 300 traded there)
  10:40:31  HELD    bid 21005.00  (held 2x)
```

| Term | Meaning |
|---|---|
| **wall** | A price whose resting size is at least `wallMultiple` (3) × the median size on that side of the book |
| **level** | A wall that has **stayed** at least `persistSec` (10 s). Shorter flashes are ignored and only counted ("flashes ignored") |
| **S / R** | Resting **bids** are support and resting **offers** are resistance. S1 and R1 are the nearest to the last price |
| **held Nx** | Price traded within `touchTicks` of the level, then moved `holdTicks` away in the level's favor |
| **filled** | Contracts that traded at the level's price while it rested |
| **ABSORBING** | The level is trading right now: it is being hit, and it is holding |
| **FILLED** (event) | The level left the book mostly **by trading**. The orders were real and got hit |
| **PULLED** (event) | The level left the book **without trading**. It was cancelled, a spoof risk. The tool remembers the price ("pulled here 1x before") |
| **BROKEN** (event) | Price traded `breakTicks` through the level |
| **out of view** | Price moved far enough away that the level is outside the depth Tradovate sends. The last size seen is kept. The level is checked again when it comes back into view, and dropped after `staleMin` (30 min) |
| **EXPIRED** (event) | The level stayed out of view too long, or vanished while the connection was down. Neither case counts as filled or pulled |

All timing comes from Tradovate's message timestamps, so the rules behave the
same in Market Replay at any speed.

## What you need

- **Node.js 22 or newer** ([nodejs.org](https://nodejs.org)). Nothing else
  needs installing; the tool has no dependencies.
- **A Tradovate account with API Access**, plus an **API key** (`cid` and
  `secret`), which you create in the API Access part of Tradovate's settings.
  API Access is a paid add-on with its own requirements; check Tradovate's
  site. Most prop-firm accounts that run on Tradovate do not allow API access.
- **Real-time market data** for the contract on that account. Without it you
  will log in fine but see "no order book data yet".

You can try the tool **without any of the account requirements**:

```
node domLevels.js --simulate
```

This plays a made-up order book containing a real wall that holds, an offer
wall that gets filled, a spoof that gets pulled, and constant flashes. Open
http://127.0.0.1:8787 to watch it.

## Setup

1. Copy `domLevels.config.example.json` to `domLevels.config.json` in the same
   folder and fill in your username, password, `cid` and `secret`. The file is
   git-ignored. Keep it private.
2. Set `symbol` to the **full contract name**: `MNQZ6`, `NQZ6`, `ESZ6`, and so
   on. If the name is wrong, the tool lists the contracts that match.
3. Run:

   ```
   node domLevels.js
   ```

   The terminal shows the levels, and the dashboard is at
   http://127.0.0.1:8787. The dashboard is only reachable from your own
   computer.

The environment variables `TRADOVATE_USERNAME`, `TRADOVATE_PASSWORD`,
`TRADOVATE_CID` and `TRADOVATE_SECRET` work instead of the config file. Flags
override both: `node domLevels.js --symbol ESZ6`.

`--env demo` (the default) logs in through Tradovate's demo environment, which
carries the same real market data. Use `--env live` if your account has no
demo access.

## Market Replay

To test outside market hours, or to study a past session, use Tradovate's
Market Replay, if your account has it:

```
node domLevels.js --replay 2026-10-16T13:30:00Z --speed 100
```

- The time is in UTC, or give an offset such as `2026-10-16T09:30:00-04:00`.
- `--speed` is a percent: 100 is real time, 400 is 4×.
- If Tradovate adjusts the start time, the tool uses Tradovate's time and
  says so.
- Tradovate pauses idle replays. The tool resumes them automatically.

## Options

| Flag | Default | |
|---|---|---|
| `--symbol` | — | Full contract name |
| `--wall-multiple` | 3 | How many times the median size a wall must be |
| `--min-size` | 0 | Minimum wall size in contracts (for example 50 on NQ, 200 on ES) |
| `--persist-sec` | 10 | How long a wall must rest before it counts |
| `--fill-share` | 0.5 | Share of the size drop that must trade for "filled" instead of "pulled" |
| `--touch-ticks` / `--hold-ticks` / `--break-ticks` | 1 / 4 / 2 | Test, hold and break distances |
| `--levels-per-side` | 5 | How many levels to show per side |
| `--stale-min` | 30 | Minutes to keep a level that is out of view |
| `--log events.jsonl` | off | Append every level event (new, held, filled, pulled, broken) as one line of JSON, for later review |
| `--port` / `--no-web` / `--no-terminal` | 8787 | Output choices |
| `--help` | | Full list |

Engine settings can also go in `domLevels.config.json` under the same names in
camelCase (`wallMultiple`, `persistSec`, and so on).

## How it stays connected

- **Login.** Logs in with `/auth/accesstokenrequest`. If Tradovate returns a
  time-penalty ticket, the tool waits it out. It renews the session about 15
  minutes before it expires, and logs in again if renewal fails.
- **Contract.** Finds the contract with `/contract/find` and reads its tick
  size from the product. The tick size is inferred from the book if that
  lookup fails.
- **Stream.** Streams from `wss://md.tradovateapi.com/v1/websocket`, using the
  market-data token, with subscriptions to `md/subscribeDOM` and
  `md/subscribeQuote`.
- **Heartbeats and reconnects.** Sends a heartbeat every 2.5 s. It reconnects
  automatically after a drop or after 20 s of silence, backing off if the
  connection keeps dropping.
- **After a reconnect.** Volume traded during the gap is not counted as fills,
  and levels that vanished meanwhile are marked EXPIRED, not PULLED.
- **Shutdown.** Ctrl+C unsubscribes and closes cleanly.

## Limits — read these

- **Depth is limited** to what Tradovate sends, usually about 10 prices per
  side. Levels further away are only remembered, never seen live, and are
  labeled "out of view".
- **Resting orders are intentions, not commitments.** A wall can be pulled the
  instant before price arrives. Persistence, the pull history and the
  FILLED/PULLED record show you how much a level has earned your trust. They
  do not guarantee it holds.
- **Trades come from quote updates.** Volume is assigned to the last trade
  price of each quote update. Tradovate batches fast prints into one update,
  so fill counts during very fast moves are approximate.
- **Not yet run against a live Tradovate account.** The protocol code follows
  Tradovate's official API examples and specification. It was tested against
  a fake Tradovate server that speaks the same protocol. If anything misbehaves
  on your account, run with `--no-terminal` and send me the `[domLevels]`
  messages it prints.

## Tests

```
node --test tradovate-dom/test/domLevels.test.js
```

There are 40 tests covering:
- the level rules (persist, flash, pull, fill with late prints, hold, break,
  pulled-then-run-through,
  out of view, reconnect gaps);
- the WebSocket protocol (authorize handshake, request framing, heartbeats,
  watchdog, time-penalty retries, error replies);
- REST login (penalty and captcha handling, renewal);
- full app runs (subscribe, contract filtering, reconnect, token expiry,
  replay setup, replay auto-resume);
- config parsing and the dashboard server.
