#!/usr/bin/env python3
"""Staged NQ acquisition with a hard billable guard.

    plan             offline, no key, no network
    price-discovery  metadata only -> cost of the definition request, STOP
    fetch-discovery  needs DATABENTO_CONFIRM_DISCOVERY=yes
    price-volume     metadata only -> cost of the 1-hour volume request, STOP
    fetch-volume     needs DATABENTO_CONFIRM_VOLUME=yes
    price-minute     metadata only -> cost of the final 1-minute plan, STOP
    fetch-minute     needs DATABENTO_CONFIRM_MINUTE=yes

BILLABLE GUARD. Databento bills historical time-series; metadata and symbology
are control-plane. `_meta()` refuses any path outside metadata./symbology., and
`_data()` raises unless a fetch command has explicitly unlocked billing for that
step. A `price-*` command therefore cannot issue a billable request even by
programming mistake - backtest/test_acquisition.py proves this without a key.

RANGE SEMANTICS. Databento `end` is EXCLUSIVE. Every inclusive research date is
converted with `_excl()`, which adds one day. A request written [A, B) that is
meant to include B would silently drop B's bars.

WHY NOT symbology.resolve(parent -> raw_symbol): that combination is not the
documented parent workflow. Definitions are the authoritative source for the
outright universe, and they also carry the expiration/activation/class fields
the roll engine and the invariants need.
"""
import base64, csv, datetime as dt, gzip, io, json, os, re, sys
import urllib.error, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nq_universe as U

HOST = "https://hist.databento.com/v0"
DATASET = "GLBX.MDP3"
PARENT = "NQ.FUT"
VOL_LOOKBACK_DAYS = 180     # per-contract window that must cover its crossover
WARMUP_DAYS = 30            # PROTOCOL.md causal feature warm-up
SANITY_RX = re.compile(r"^NQ[A-Z]\d{1,2}$")   # SECONDARY check only

_UNLOCKED = set()           # steps a fetch command has explicitly unlocked


def _excl(d):
    """Databento end is exclusive; make an inclusive date inclusive."""
    return (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()


def api_key():
    k = os.environ.get("DATABENTO_API_KEY", "").strip()
    if not k:
        sys.exit("DATABENTO_API_KEY is not set in the environment.\n"
                 "  export DATABENTO_API_KEY=...   (never paste it into a prompt)")
    return k


def _request(path, fields, k, raw):
    body = urllib.parse.urlencode(fields, doseq=True).encode()
    req = urllib.request.Request(f"{HOST}/{path}", data=body, method="POST")
    req.add_header("Authorization",
                   "Basic " + base64.b64encode(f"{k}:".encode()).decode())
    req.add_header("Accept-Encoding", "gzip")
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            out = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                out = gzip.decompress(out)
            return out if raw else json.loads(out or b"null")
    except urllib.error.HTTPError as e:
        d = e.read()[:500].decode("utf-8", "replace")
        d = re.sub(r"db-[A-Za-z0-9]{16,}", "db-***REDACTED***", d)
        if k:
            d = d.replace(k, "***REDACTED***")
        sys.exit(f"Databento HTTP {e.code} on {path}: {d}")


def _meta(path, fields, k):
    """Control-plane only. Never billable."""
    if not path.startswith(("metadata.", "symbology.")):
        raise RuntimeError(f"_meta refuses non-metadata path: {path}")
    return _request(path, fields, k, raw=False)


def _data(path, fields, k, step):
    """Billable. Refuses unless the matching fetch command unlocked this step."""
    if step not in _UNLOCKED:
        raise RuntimeError(
            f"BILLABLE GUARD: refused {path} for step '{step}'. A price-* "
            f"command may not download data. Run the matching fetch-* command "
            f"with its confirmation variable set.")
    return _request(path, fields, k, raw=True)


def _cost(k, **f):
    v = _meta("metadata.get_cost",
              dict(dataset=DATASET, mode="historical-streaming", **f), k)
    return float(v) if not isinstance(v, dict) else float(v.get("total", 0))


def _ns(x):
    return dt.datetime.fromtimestamp(int(x) / 1e9, tz=dt.timezone.utc) if x else None


# ── STEP 1/2 - discovery ───────────────────────────────────────────────────
def def_fields(start, end):
    return dict(dataset=DATASET, symbols=PARENT, stype_in="parent",
                schema="definition", start=start, end=_excl(end))


def price_discovery(start, end, k):
    c = _cost(k, **{x: y for x, y in def_fields(start, end).items() if x != "dataset"})
    print(f"  definition / discovery request  {start} -> {_excl(end)} (end exclusive)")
    print(f"  estimated cost: ${c:,.2f}")
    return c


def fetch_discovery(start, end, k):
    raw = _data("timeseries.get_range",
                dict(**def_fields(start, end), encoding="csv"), k, "discovery")
    os.makedirs("data_nq_deep", exist_ok=True)
    open("data_nq_deep/definitions.csv", "wb").write(raw)
    rows = []
    for r in csv.DictReader(io.StringIO(raw.decode("utf-8", "replace"))):
        rows.append(dict(asset=r.get("asset"), instrument_class=r.get("instrument_class"),
                         raw_symbol=r.get("raw_symbol"),
                         instrument_id=r.get("instrument_id"),
                         expiration=_ns(r.get("expiration")),
                         activation=_ns(r.get("activation")),
                         ts_recv=_ns(r.get("ts_recv") or r.get("ts_event"))))
    uni, rej = U.build_universe(rows)
    seq = U.ordered(uni)
    print(f"  definition records returned : {len(rows)}")
    print(f"  rejected - wrong asset      : {rej['asset']}")
    print(f"  rejected - not FUTURE class : {rej['class']}  (calendar spreads etc.)")
    print(f"  rejected - no expiration    : {rej['no_expiry']}")
    print(f"  unique outright contracts   : {len(seq)}")
    if seq:
        print(f"  earliest expiration         : {seq[0]['expiration'].astimezone(U.ET).date()}")
        print(f"  latest expiration           : {seq[-1]['expiration'].astimezone(U.ET).date()}")
    odd = [c["research_id"] for c in seq
           if not any(SANITY_RX.match(m["raw_symbol"]) for m in c["raw_symbols"])]
    print(f"  secondary regex sanity check: {len(odd)} unusual symbol(s)"
          f"{'' if not odd else '  ' + str(odd[:5])}")
    if not seq:
        sys.exit("HALT: discovery returned no outright contracts.")
    json.dump({r: dict(c, expiration=c["expiration"].isoformat(),
                       activation=c["activation"].isoformat() if c["activation"] else None,
                       raw_symbols=[dict(m, first_seen=_iso(m["first_seen"]),
                                         last_seen=_iso(m["last_seen"])) for m in c["raw_symbols"]],
                       instrument_ids=[dict(m, first_seen=_iso(m["first_seen"]),
                                            last_seen=_iso(m["last_seen"])) for m in c["instrument_ids"]])
               for r, c in uni.items()},
              open("research/universe.json", "w"), indent=2)
    print("  -> research/universe.json")
    return uni


def _iso(x):
    return x.isoformat() if x else None


# ── STEP 4/5 - session volume ──────────────────────────────────────────────
def vol_windows(uni, start, end):
    w = []
    for c in U.ordered(uni):
        e = c["expiration"].astimezone(U.ET).date()
        s = max(e - dt.timedelta(days=VOL_LOOKBACK_DAYS), dt.date(1990, 1, 1))
        if e < dt.date.fromisoformat(start) - dt.timedelta(days=VOL_LOOKBACK_DAYS):
            continue
        if s > dt.date.fromisoformat(end):
            continue
        w.append(dict(research_id=c["research_id"],
                      raw_symbol=U.symbol_at(c, c["expiration"]),
                      start=s.isoformat(), end=_excl(min(e, dt.date.fromisoformat(end)).isoformat())))
    return w


def price_volume(uni, start, end, k):
    w = vol_windows(uni, start, end)
    tot = sum(_cost(k, symbols=[x["raw_symbol"]], stype_in="raw_symbol",
                    schema="ohlcv-1h", start=x["start"], end=x["end"]) for x in w)
    print(f"  1-hour volume, {len(w)} contract windows of {VOL_LOOKBACK_DAYS}d each")
    print(f"  estimated cost: ${tot:,.2f}")
    return tot


def fetch_volume(uni, start, end, k):
    rows = []
    for x in vol_windows(uni, start, end):
        raw = _data("timeseries.get_range",
                    dict(dataset=DATASET, symbols=[x["raw_symbol"]], stype_in="raw_symbol",
                         schema="ohlcv-1h", start=x["start"], end=x["end"],
                         encoding="csv"), k, "volume")
        for r in csv.DictReader(io.StringIO(raw.decode("utf-8", "replace"))):
            rows.append(dict(ts_event=_ns(r["ts_event"]), volume=r.get("volume"),
                             research_id=x["research_id"]))
    sv = U.aggregate_session_volume(rows)
    rstart = dt.date.fromisoformat(start)
    tbl, events, ok = U.run_roll(sv, uni, rstart)
    intervals = U.active_intervals(tbl)
    bad = U.check_invariants(uni, tbl, events, intervals, rstart, WARMUP_DAYS)
    print(f"  hourly bars {len(rows)} -> {len(sv)} contract-sessions")
    print(f"  roll table {len(tbl)} sessions, {sum(1 for e in events if e['kind']=='roll')} rolls")
    print(f"  causally initialised before {start}: {ok}")
    for b in bad:
        print(f"  INVARIANT FAIL: {b}")
    json.dump(dict(sessions=tbl, events=events, intervals=intervals),
              open("research/roll_table.json", "w"), indent=2)
    if bad:
        sys.exit("HALT: invariants failed. Nothing further is priced or bought.")
    print("  all invariants passed -> research/roll_table.json")
    return intervals


# ── STEP 7/8 - minute data ─────────────────────────────────────────────────
def minute_windows(uni, intervals):
    out = []
    for iv in intervals:
        c = uni[iv["research_id"]]
        a0 = dt.date.fromisoformat(iv["active_start"])
        out.append(dict(research_id=iv["research_id"],
                        raw_symbol=U.symbol_at(c, c["expiration"]),
                        start=(a0 - dt.timedelta(days=WARMUP_DAYS)).isoformat(),
                        end=_excl(iv["active_end"]),
                        active_start=iv["active_start"], active_end=iv["active_end"]))
    return out


def price_minute(uni, intervals, k):
    w = minute_windows(uni, intervals)
    tot = sum(_cost(k, symbols=[x["raw_symbol"]], stype_in="raw_symbol",
                    schema="ohlcv-1m", start=x["start"], end=x["end"]) for x in w)
    print(f"  1-minute, {len(w)} contracts (active + {WARMUP_DAYS}d own pre-roll warm-up)")
    print(f"  estimated cost: ${tot:,.2f}")
    json.dump(w, open("research/minute_request_plan.json", "w"), indent=2)
    return tot


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "plan"
    start = sys.argv[2] if len(sys.argv) > 2 else "2019-01-01"
    end = sys.argv[3] if len(sys.argv) > 3 else "2026-09-01"
    os.makedirs("research", exist_ok=True)
    if cmd == "plan":
        print(f"OFFLINE. Inclusive research range {start}..{end}; API end "
              f"{_excl(end)} (exclusive). No network, no key, no spend.")
        sys.exit(0)
    k = api_key()
    if cmd == "price-discovery":
        price_discovery(start, end, k)
        sys.exit("\nPRICED ONLY. Nothing downloaded. Next: fetch-discovery "
                 "with DATABENTO_CONFIRM_DISCOVERY=yes")
    if cmd == "fetch-discovery":
        if os.environ.get("DATABENTO_CONFIRM_DISCOVERY") != "yes":
            sys.exit("DATABENTO_CONFIRM_DISCOVERY=yes not set. Nothing downloaded.")
        _UNLOCKED.add("discovery"); fetch_discovery(start, end, k)
        sys.exit("\nDiscovery complete. Next: price-volume")
    uni = None
    if os.path.exists("research/universe.json"):
        j = json.load(open("research/universe.json"))
        uni = {r: dict(c, expiration=dt.datetime.fromisoformat(c["expiration"]),
                       activation=dt.datetime.fromisoformat(c["activation"]) if c["activation"] else None)
               for r, c in j.items()}
    if cmd in ("price-volume", "fetch-volume", "price-minute", "fetch-minute") and not uni:
        sys.exit("research/universe.json missing - run fetch-discovery first.")
    if cmd == "price-volume":
        price_volume(uni, start, end, k)
        sys.exit("\nPRICED ONLY. Next: fetch-volume with DATABENTO_CONFIRM_VOLUME=yes")
    if cmd == "fetch-volume":
        if os.environ.get("DATABENTO_CONFIRM_VOLUME") != "yes":
            sys.exit("DATABENTO_CONFIRM_VOLUME=yes not set. Nothing downloaded.")
        _UNLOCKED.add("volume"); fetch_volume(uni, start, end, k)
        sys.exit("\nRoll table frozen. Next: price-minute")
    iv = json.load(open("research/roll_table.json"))["intervals"] \
        if os.path.exists("research/roll_table.json") else None
    if cmd in ("price-minute", "fetch-minute") and not iv:
        sys.exit("research/roll_table.json missing - run fetch-volume first.")
    if cmd == "price-minute":
        price_minute(uni, iv, k)
        sys.exit("\nPRICED ONLY. Next: fetch-minute with DATABENTO_CONFIRM_MINUTE=yes")
    if cmd == "fetch-minute":
        if os.environ.get("DATABENTO_CONFIRM_MINUTE") != "yes":
            sys.exit("DATABENTO_CONFIRM_MINUTE=yes not set. Nothing downloaded.")
        _UNLOCKED.add("minute")
        for x in minute_windows(uni, iv):
            raw = _data("timeseries.get_range",
                        dict(dataset=DATASET, symbols=[x["raw_symbol"]], stype_in="raw_symbol",
                             schema="ohlcv-1m", start=x["start"], end=x["end"],
                             encoding="csv"), k, "minute")
            open(f"data_nq_deep/{x['research_id']}_1m.csv", "wb").write(raw)
            print(f"  {x['research_id']} ({x['raw_symbol']})  {len(raw)/1e6:.1f} MB")
        sys.exit(0)
    sys.exit(f"unknown command {cmd!r}")
