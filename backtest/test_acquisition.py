#!/usr/bin/env python3
"""Proves the acquisition guarantees locally, with no API key and no network.
Each test maps to one of the eight claims that must hold before any spend."""
import datetime as dt, io, json, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nq_universe as U
import fetch_databento as F

ET = U.ET
FAILS = []
def ok(c, msg):
    print(("  PASS  " if c else "  FAIL  ") + msg)
    if not c: FAILS.append(msg)

# ── A. price-* cannot download billable data ───────────────────────────────
print("A. `price` cannot issue a billable timeseries request")
calls = []
def spy(path, fields, k, raw):
    calls.append(path)
    if path == "metadata.get_cost": return 1.23
    raise AssertionError(f"a price command reached billable path {path}")
F._request = spy
F._UNLOCKED.clear()
F.price_discovery("2019-01-01", "2026-09-01", "db-FAKE")
uni = {"NQ-2026-03": dict(research_id="NQ-2026-03",
                          expiration=dt.datetime(2026,3,20,tzinfo=dt.timezone.utc),
                          activation=dt.datetime(2025,3,20,tzinfo=dt.timezone.utc),
                          raw_symbols=[dict(raw_symbol="NQH6", first_seen=None, last_seen=None)],
                          instrument_ids=[])}
F.price_volume(uni, "2019-01-01", "2026-09-01", "db-FAKE")
F.price_minute(uni, [dict(research_id="NQ-2026-03", active_start="2025-12-16",
                          active_end="2026-03-16")], "db-FAKE")
ok(all(c == "metadata.get_cost" for c in calls),
   f"all {len(calls)} price-path calls were metadata.get_cost")
try:
    F._data("timeseries.get_range", {}, "db-FAKE", "discovery"); guarded = False
except RuntimeError: guarded = True
ok(guarded, "_data() refuses while the step is locked")
F._UNLOCKED.add("discovery")
try:
    F._data("timeseries.get_range", {}, "db-FAKE", "discovery"); unlocked = True
except RuntimeError: unlocked = False
except AssertionError: unlocked = True          # spy fired => the call was allowed through
ok(unlocked, "_data() permits the step once a fetch command unlocks it")
F._UNLOCKED.clear()
try:
    F._meta("timeseries.get_range", {}, "db-FAKE"); metaguard = False
except RuntimeError: metaguard = True
ok(metaguard, "_meta() refuses any non-metadata path")

# ── B. discovery does not depend on a two-digit ticker regex ───────────────
print("\nB. discovery works on real single-digit GLBX symbols")
defs = [dict(asset="NQ", instrument_class="F", raw_symbol="NQZ5",
             instrument_id=101, expiration=dt.datetime(2025,12,19,14,30,tzinfo=dt.timezone.utc),
             activation=dt.datetime(2024,12,20,tzinfo=dt.timezone.utc),
             ts_recv=dt.datetime(2025,6,1,tzinfo=dt.timezone.utc)),
        dict(asset="NQ", instrument_class="F", raw_symbol="NQH6",
             instrument_id=102, expiration=dt.datetime(2026,3,20,14,30,tzinfo=dt.timezone.utc),
             activation=dt.datetime(2025,3,21,tzinfo=dt.timezone.utc),
             ts_recv=dt.datetime(2025,6,1,tzinfo=dt.timezone.utc)),
        dict(asset="NQ", instrument_class="S", raw_symbol="NQZ5-NQH6",
             instrument_id=103, expiration=dt.datetime(2025,12,19,tzinfo=dt.timezone.utc),
             activation=None, ts_recv=dt.datetime(2025,6,1,tzinfo=dt.timezone.utc)),
        dict(asset="MNQ", instrument_class="F", raw_symbol="MNQZ5",
             instrument_id=104, expiration=dt.datetime(2025,12,19,tzinfo=dt.timezone.utc),
             activation=None, ts_recv=dt.datetime(2025,6,1,tzinfo=dt.timezone.utc))]
u2, rej = U.build_universe(defs)
ok(set(u2) == {"NQ-2025-12", "NQ-2026-03"}, f"universe from definitions = {sorted(u2)}")
ok(rej["class"] == 1, "calendar spread rejected by instrument_class, not by regex")
ok(rej["asset"] == 1, "MNQ rejected by asset field")
import re
ok(not re.match(r"^NQ[HMUZ]\d{2}$", "NQZ5"),
   "the old two-digit regex would have matched nothing - it is no longer authoritative")

# ── C. parent symbology uses the documented definition workflow ────────────
print("\nC. parent symbology follows the documented workflow")
# Inspect actual CALL SITES via AST - a docstring may legitimately mention the
# endpoint to explain why it is not used.
import ast
tree = ast.parse(open(os.path.join(os.path.dirname(__file__), "fetch_databento.py")).read())
paths = [n.args[0].value for n in ast.walk(tree)
         if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
         and n.func.id in ("_meta", "_data", "_request") and n.args
         and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str)]
ok(not any(p.startswith("symbology.") for p in paths),
   f"no symbology.* call site (endpoints called: {sorted(set(paths))})")
f = F.def_fields("2019-01-01", "2026-09-01")
ok(f["schema"] == "definition" and f["stype_in"] == "parent",
   f"discovery uses schema=definition, stype_in=parent")

# ── D. CME trade-day sessionisation, DST-correct ──────────────────────────
print("\nD. session volume uses CME trade days, not UTC calendar dates")
def et(y,m,d,H,M=0): return dt.datetime(y,m,d,H,M,tzinfo=ET).astimezone(dt.timezone.utc)
ok(U.cme_trade_day(et(2026,9,10,18)) == dt.date(2026,9,11), "18:00 ET belongs to the NEXT trade day")
ok(U.cme_trade_day(et(2026,9,11,16,59)) == dt.date(2026,9,11), "16:59 ET belongs to the same trade day")
ok(U.cme_trade_day(et(2026,9,11,9,30)) == dt.date(2026,9,11), "09:30 ET cash open maps correctly")
ok(U.cme_trade_day(et(2026,3,6,18)) == dt.date(2026,3,7), "EST evening maps forward")
ok(U.cme_trade_day(et(2026,3,9,18)) == dt.date(2026,3,10), "EDT evening maps forward across the DST change")
rows = [dict(ts_event=et(2026,9,10,18), volume=10, research_id="NQ-2026-09"),
        dict(ts_event=et(2026,9,11,10), volume=5,  research_id="NQ-2026-09")]
ok(U.aggregate_session_volume(rows) == {(dt.date(2026,9,11), "NQ-2026-09"): 15.0},
   "bars either side of midnight aggregate into ONE trade day")

# ── E. succession is by expiration, never lexicographic ───────────────────
print("\nE. next contract is expiration-ordered")
s = U.successor_map(u2)
ok(s["NQ-2025-12"] == "NQ-2026-03", "NQZ5 -> NQH6 (lexical sort would return None)")
ok([c["research_id"] for c in U.ordered(u2)] == ["NQ-2025-12", "NQ-2026-03"],
   "ordering is chronological")

# ── F. discovery spans the whole research period, end exclusive ───────────
print("\nF. definition discovery covers expired contracts")
ok(f["start"] == "2019-01-01" and f["end"] == "2026-09-02",
   f"range {f['start']} -> {f['end']} spans the period; end made exclusive (+1d)")
ok("limit" not in f, "no limit parameter that could silently truncate the universe")

# ── G. roll state initialises causally with pre-start history ─────────────
print("\nG. roll state has pre-research history")
w = F.vol_windows(u2, "2026-01-01", "2026-09-01")
ok(any(x["start"] < "2026-01-01" for x in w),
   f"volume windows begin before the research start (earliest {min(x['start'] for x in w)})")
bad = U.check_invariants(u2, [dict(trade_day="2026-01-02", active="NQ-2026-03")], [],
                         [dict(research_id="NQ-2026-03", active_start="2026-01-02",
                               active_end="2026-03-16")], dt.date(2026,1,1))
ok(any("pre-start" in b for b in bad), "invariant flags a roll table with no pre-start history")

# ── H. every roll carries an exact effective timestamp ────────────────────
print("\nH. rolls carry decision and effective timestamps")
sv = {}
for i, d in enumerate([dt.date(2025,12,10)+dt.timedelta(days=n) for n in range(6)]):
    sv[(d,"NQ-2025-12")] = 100 - i*20
    sv[(d,"NQ-2026-03")] = 10 + i*25
tbl, ev, init = U.run_roll(sv, u2, dt.date(2025,12,12))
rolls = [e for e in ev if e["kind"] == "roll"]
ok(len(rolls) == 1, f"exactly one roll fired ({len(rolls)})")
if rolls:
    r = rolls[0]
    dec = dt.datetime.fromisoformat(r["decision_timestamp_et"])
    eff = dt.datetime.fromisoformat(r["effective_timestamp_et"])
    ok(dec.hour == 17 and eff.hour == 18, f"decision {dec.time()} ET, effective {eff.time()} ET")
    ok((eff - dec) == dt.timedelta(hours=1), "effective is the next session open, one hour later")
    ok(dec.tzinfo is not None and "decision_timestamp_utc" in r, "timestamps are tz-aware and stored in UTC too")
    ok(r["old_contract"] == "NQ-2025-12" and r["new_contract"] == "NQ-2026-03",
       f"{r['old_contract']} -> {r['new_contract']}")

print("\n" + ("ALL ACQUISITION GUARANTEES PROVEN" if not FAILS
              else f"{len(FAILS)} FAILURE(S): " + "; ".join(FAILS)))
sys.exit(1 if FAILS else 0)
