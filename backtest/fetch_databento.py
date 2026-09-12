#!/usr/bin/env python3
"""Staged NQ acquisition. Nothing is downloaded until cost has been shown and
DATABENTO_CONFIRM=yes is set explicitly.

    export DATABENTO_API_KEY=...          # never passed as an argument
    python3 backtest/fetch_databento.py plan     # offline, no key, no spend
    python3 backtest/fetch_databento.py price    # Stages A/B/E, metadata only
    DATABENTO_CONFIRM=yes python3 backtest/fetch_databento.py fetch

WHY STAGED (this is the whole point):
  A parent request - NQ.FUT with stype_in=parent - resolves to every child
  instrument, which for a CME futures root includes CALENDAR SPREADS and other
  non-outright instruments, not just the quarterly outrights. Buying seven years
  of minute bars for that entire universe would purchase a large amount of
  spread data this research will never read, and would make any size estimate
  based on outright volume wrong.

  A  discover outright contracts only        (symbology.resolve + a 1-day
                                              definition probe; metadata-cheap)
  B  daily volume for those outrights        (ohlcv-1d; tiny)
  C  build active-contract intervals         (local, from the frozen roll policy)
  D  plan per-contract minute windows        (active + contract-specific warm-up)
  E  price exactly that, then stop           (metadata.get_cost per contract)

The API key is read only from the environment, never logged, never written to
disk, never placed in PROVENANCE or any report, and scrubbed from error bodies.
"""
import base64, csv, datetime as dt, gzip, json, os, re, sys
import urllib.error, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nq_contracts as NC

HOST = "https://hist.databento.com/v0"
DATASET = "GLBX.MDP3"
PARENT = "NQ.FUT"
OUTRIGHT = re.compile(r"^NQ[HMUZ]\d{2}$")      # NQZ25 - excludes NQH6-NQM6 spreads
BYTES_PER_OHLCV = 56                            # DBN OhlcvMsg: 16B hdr + 4x8B + 8B


def api_key():
    k = os.environ.get("DATABENTO_API_KEY", "").strip()
    if not k:
        sys.exit("DATABENTO_API_KEY is not set in the environment.\n"
                 "  export DATABENTO_API_KEY=...   (do not paste it into a prompt)\n"
                 "Only this script reads it. It is never written anywhere.")
    return k


def post(path, fields, k, raw=False):
    body = urllib.parse.urlencode(fields, doseq=True).encode()
    req = urllib.request.Request(f"{HOST}/{path}", data=body, method="POST")
    req.add_header("Authorization",
                   "Basic " + base64.b64encode(f"{k}:".encode()).decode())
    req.add_header("Accept-Encoding", "gzip")
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
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


# ── STAGE A ────────────────────────────────────────────────────────────────
def stage_a(start, end, k):
    """Outright quarterly contracts only. Spreads and non-futures excluded."""
    res = post("symbology.resolve", dict(
        dataset=DATASET, symbols=PARENT, stype_in="parent",
        stype_out="raw_symbol", start_date=start, end_date=end), k)
    seen = set()
    for sym, spans in (res.get("result") or {}).items():
        for sp in spans:
            seen.add(sp.get("s") or sym)
    allsyms = sorted(x for x in seen if x)
    outright = sorted(x for x in allsyms if OUTRIGHT.match(x))
    other = [x for x in allsyms if x not in set(outright)]
    print(f"  parent resolved to {len(allsyms)} child symbols")
    print(f"    outright quarterly futures : {len(outright)}")
    print(f"    excluded (spreads/other)   : {len(other)}"
          f"   e.g. {other[:4] if other else '-'}")
    # cheap verification that the regex agrees with the exchange's own class flag
    probe = post("timeseries.get_range", dict(
        dataset=DATASET, symbols=PARENT, stype_in="parent", schema="definition",
        start=end, end=end, encoding="csv", limit=5000), k, raw=True)
    cls = {}
    rd = csv.DictReader(probe.decode("utf-8", "replace").splitlines())
    for row in rd:
        rs = row.get("raw_symbol")
        if rs:
            cls[rs] = row.get("instrument_class", "?")
    bad = [s for s in outright if s in cls and cls[s] != "F"]
    print(f"    definition probe on {end}: {len(cls)} instruments classified"
          f"{'' if not bad else '  MISMATCH: ' + str(bad[:5])}")
    if bad:
        sys.exit("Regex/class disagreement - halt and inspect before spending.")
    return outright


# ── STAGE B/C ──────────────────────────────────────────────────────────────
def stage_b_c(outright, start, end, k):
    """Daily volume -> frozen roll policy -> active intervals."""
    raw = post("timeseries.get_range", dict(
        dataset=DATASET, symbols=outright, stype_in="raw_symbol",
        schema="ohlcv-1d", start=start, end=end, encoding="csv"), k, raw=True)
    open("research/nq_daily_volume.csv", "wb").write(raw)
    vol = {}
    for row in csv.DictReader(raw.decode("utf-8", "replace").splitlines()):
        d = dt.datetime.utcfromtimestamp(int(row["ts_event"]) / 1e9).date()
        vol.setdefault(d, {})[row["symbol"]] = float(row.get("volume") or 0)
    table, active, streak, cur = [], [], 0, None
    for d in sorted(vol):
        live = sorted(s for s in vol[d] if s in set(outright))
        if not live:
            continue
        if cur is None:
            cur = max(live, key=lambda s: vol[d][s])
        nxt = next((s for s in live if s > cur), None)
        fv, nv = vol[d].get(cur, 0.0), (vol[d].get(nxt, 0.0) if nxt else 0.0)
        streak = streak + 1 if (nxt and nv > fv) else 0
        switched = streak >= 2
        table.append(dict(date=d.isoformat(), front=cur, front_volume=fv,
                          next=nxt, next_volume=nv, crossover_streak=streak,
                          switch_signalled=switched, active=cur,
                          fallback_used=False))
        if switched:
            cur, streak = nxt, 0
    json.dump(table, open("research/roll_table.json", "w"), indent=2)
    for r in table:
        if not active or active[-1]["symbol"] != r["active"]:
            if active:
                active[-1]["active_end"] = r["date"]
            active.append(dict(symbol=r["active"], active_start=r["date"]))
    if active:
        active[-1]["active_end"] = table[-1]["date"]
    print(f"  roll table: {len(table)} sessions -> {len(active)} active intervals")
    print(f"  -> research/roll_table.json, research/nq_daily_volume.csv")
    return active


# ── STAGE D ────────────────────────────────────────────────────────────────
def stage_d(active):
    """Active interval + contract-specific pre-roll warm-up.

    The incoming contract may use its OWN pre-roll history to warm ATR, VWAP,
    volatility and structure. That is not cross-contract level carryover: no
    level formed on the expiring contract is ever transplanted."""
    plan = []
    for a in active:
        a0 = dt.date.fromisoformat(a["active_start"])
        plan.append(dict(symbol=a["symbol"],
                         request_start=(a0 - dt.timedelta(days=NC.WARMUP_DAYS)).isoformat(),
                         active_start=a["active_start"], active_end=a["active_end"]))
    json.dump(plan, open("research/minute_request_plan.json", "w"), indent=2)
    return plan


# ── STAGE E ────────────────────────────────────────────────────────────────
def stage_e(plan, start, end, outright, k):
    print("\n  cost by stage (USD, from metadata.get_cost on your account):")
    total = 0.0

    def cost(**f):
        v = post("metadata.get_cost", dict(dataset=DATASET, mode="historical-streaming", **f), k)
        return float(v) if not isinstance(v, dict) else float(v.get("total", 0))

    c_def = cost(symbols=PARENT, stype_in="parent", schema="definition", start=end, end=end)
    print(f"    1. definition / reference (1-day probe) : ${c_def:,.2f}")
    c_day = cost(symbols=outright, stype_in="raw_symbol", schema="ohlcv-1d",
                 start=start, end=end)
    print(f"    2. daily volume, {len(outright)} outrights          : ${c_day:,.2f}")
    c_min = 0.0
    for p in plan:
        c_min += cost(symbols=[p["symbol"]], stype_in="raw_symbol", schema="ohlcv-1m",
                      start=p["request_start"], end=p["active_end"])
    print(f"    3. filtered outright 1-minute           : ${c_min:,.2f}")
    total = c_def + c_day + c_min
    print(f"    {'TOTAL':<39} : ${total:,.2f}")
    return total


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "plan"
    start = sys.argv[2] if len(sys.argv) > 2 else "2019-01-01"
    end = sys.argv[3] if len(sys.argv) > 3 else "2026-09-01"
    os.makedirs("research", exist_ok=True)
    if mode == "plan":
        rows = NC.calendar(dt.date.fromisoformat(start), dt.date.fromisoformat(end))
        print(f"OFFLINE PLAN (calendar fallback windows; Stage B replaces these)")
        print(f"  contracts {len(rows)}  range {start} -> {end}")
        sys.exit(0)
    k = api_key()
    print(f"STAGE A - discover outright contracts  {start} -> {end}")
    outright = stage_a(start, end, k)
    print(f"\nSTAGE B/C - daily volume -> frozen roll policy")
    active = stage_b_c(outright, start, end, k)
    print(f"\nSTAGE D - per-contract minute windows (active + {NC.WARMUP_DAYS}d warm-up)")
    plan = stage_d(active)
    print(f"  {len(plan)} contract requests -> research/minute_request_plan.json")
    print(f"\nSTAGE E - price exactly what would be downloaded")
    stage_e(plan, start, end, outright, k)
    if mode != "fetch":
        sys.exit("\nPriced only. Re-run with `fetch` and DATABENTO_CONFIRM=yes to download.")
    if os.environ.get("DATABENTO_CONFIRM") != "yes":
        sys.exit("\nDATABENTO_CONFIRM=yes not set. Nothing downloaded.")
    os.makedirs("data_nq_deep", exist_ok=True)
    for p in plan:
        raw = post("timeseries.get_range", dict(
            dataset=DATASET, symbols=[p["symbol"]], stype_in="raw_symbol",
            schema="ohlcv-1m", start=p["request_start"], end=p["active_end"],
            encoding="csv"), k, raw=True)
        open(f"data_nq_deep/{p['symbol']}_1m.csv", "wb").write(raw)
        print(f"  {p['symbol']}  {len(raw)/1e6:.1f} MB")
    json.dump(dict(source="Databento Historical API", dataset=DATASET,
                   universe="outright NQ quarterly futures only (spreads excluded)",
                   contracts=[p["symbol"] for p in plan], start=start, end=end,
                   adjustment="none - raw individual contracts",
                   roll="research/roll_table.json per ROLL_POLICY.md v1.2",
                   warmup_days=NC.WARMUP_DAYS),
              open("data_nq_deep/PROVENANCE.json", "w"), indent=2)
