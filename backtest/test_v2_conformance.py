#!/usr/bin/env python3
"""Conformance tests A-U: the executable engine vs the frozen specification.

Computes NO outcome: no Y, no MFE, no MAE, no correlation, no p-value.
"""
import ast, datetime as dt, json, math, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE
import v2_reference as REF

FAILS = []
def ok(c, m):
    print(("  PASS  " if c else "  FAIL  ") + m)
    if not c: FAILS.append(m)

FS = json.load(open("research/FEATURE_SPEC_V2.json"))
BAR = V.BAR_SECONDS
PEN = V.PROXY_SWEEP_PENETRATION_POINTS


def synth(days=6, seed=7, start=dt.date(2023, 3, 1), vol=3.0):
    """Random-walk 5m bars across whole CME trade days."""
    rnd = random.Random(seed)
    b = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
    px = 15000.0
    d = start
    for _ in range(days):
        op, cl = S.session_bounds(d)
        ts = int(op.timestamp())
        while ts < int(cl.timestamp()):
            o_ = px
            px = px + rnd.gauss(0, vol)
            hi = max(o_, px) + abs(rnd.gauss(0, vol))
            lo = min(o_, px) - abs(rnd.gauss(0, vol))
            b["t"].append(ts); b["o"].append(o_); b["h"].append(hi)
            b["l"].append(lo); b["c"].append(px)
            b["v"].append(50.0 + abs(rnd.gauss(0, 20)))
            ts += BAR
        d += dt.timedelta(days=1)
        while d.weekday() >= 5:
            d += dt.timedelta(days=1)
    return b


print("A. 29/29 declared event-time features have implementation mappings")
CM = json.load(open("research/CONFORMANCE_MATRIX_V2.json"))
decl = set(FS["event_time_features"])
ok(len(decl) == 29, f"spec declares 29 event-time features ({len(decl)})")
ok(set(CM["features"]) == decl, "the matrix covers exactly the declared set")
unimpl = [f for f, v in CM["features"].items() if not v["implemented"]]
ok(not unimpl, f"every declared feature is implemented {unimpl}")
notest = [f for f, v in CM["features"].items() if not v["unit_test_id"]]
ok(not notest, f"every declared feature names a unit test {notest}")
emitted = set(FE.EVENT_FIELDS) - {"level_id", "t0", "trade_date", "bucket"}
ok(emitted == decl, f"the engine emits exactly the declared set "
   f"{sorted(emitted ^ decl)}")

print("\nB. 22/22 confirmatory features are emitted or causally missing")
fam = set(FS["confirmatory_family"])
ok(len(fam) == 22, f"family size 22 ({len(fam)})")
ok(fam <= emitted, f"all 22 are in the event row {sorted(fam - emitted)}")
rows = FE.compute_events(synth(8))
ok(rows, f"the fixture produced events ({len(rows)})")
missing_keys = [f for f in decl if any(f not in r for r in rows)]
ok(not missing_keys, f"no field is silently omitted from any row {missing_keys}")
ph = [f for f in fam if all(r.get(f) == 0 for r in rows) and
      f not in ("touch_count",)]
ok(not ph, f"no confirmatory feature is a constant-zero placeholder {ph}")

print("\nC. level_prominence uses pre-availability MEDIAN and ATR-at-availability")
src = open("backtest/v2_features.py").read()
ok("prominence_reference_median" in src and "atr_at_availability" in src,
   "availability-time metadata is stored on the level")
# hand-built fixture. The four quantities are deliberately far apart:
#   median of the 20 pre-availability closes = 14990
#   mean   of the same 20                    = 15000.5   (skewed by one outlier)
#   mean of the 20 pre-SWEEP closes          = 15400
#   ATR at availability vs ATR at sweep      = ~3 vs ~73
b = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
op, _ = S.session_bounds(dt.date(2023, 3, 1))
t0 = int(op.timestamp())
closes = [14990.0]*19 + [15200.0] + [15400.0]*30
for k, cv in enumerate(closes):
    b["t"].append(t0 + k*BAR); b["o"].append(cv); b["c"].append(cv)
    b["h"].append(cv + (40.0 if k >= 20 else 1.0))
    b["l"].append(cv - (40.0 if k >= 20 else 1.0))
    b["v"].append(10.0)
atr = FE.wilder_atr(b)
pre_avail = closes[:20]
med_avail, mean_avail = FE.median(pre_avail), sum(pre_avail)/20
mean_sweep = sum(closes[26:46])/20
lv = FE.new_level("X", "pdl", 1, 15100.0, t0, b["t"][20])
FE._attach_prominence(lv, b, atr, 19)
ok(abs(med_avail - 14990.0) < 1e-9 and abs(mean_avail - 15000.5) < 1e-9
   and abs(mean_sweep - 15400.0) < 1e-9,
   f"fixture separates the candidates: median {med_avail}, mean {mean_avail}, "
   f"pre-sweep mean {mean_sweep}")
ok(abs(lv["prominence_reference_median"] - med_avail) < 1e-9,
   f"reference is the pre-availability MEDIAN ({lv['prominence_reference_median']})")
ok(abs(lv["prominence_reference_median"] - mean_avail) > 10,
   "it is NOT the pre-availability mean")
ok(abs(lv["prominence_reference_median"] - mean_sweep) > 100,
   "it is NOT the pre-sweep mean the old engine used")
ok(abs(lv["atr_at_availability"] - atr[19]) < 1e-12,
   "ATR is the value known AT AVAILABILITY")
ok(abs(atr[45] - atr[19]) > 1.0,
   f"the two ATRs are materially different ({atr[19]:.2f} vs {atr[45]:.2f})")
hand = abs(15100.0 - 14990.0) / atr[19]
ok(abs(abs(lv["price"]-lv["prominence_reference_median"])/lv["atr_at_availability"]
       - hand) < 1e-12, f"hand-computed prominence = {hand:.4f}")

print("\nD. Same-bar sweep+reclaim emits BEFORE structural retirement")
# a real fractal pivot low, then one bar that penetrates it AND closes back
fx = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
op, _ = S.session_bounds(dt.date(2023, 3, 1))
ts = int(op.timestamp())
for k in range(80):
    lo_k = 14990.0 if k == 30 else 14999.0
    fx["t"].append(ts + k*BAR); fx["o"].append(15000.0); fx["c"].append(15000.0)
    fx["h"].append(15001.0); fx["l"].append(lo_k); fx["v"].append(10.0)
fx["l"][50] = 14990.0 - PEN - 1.0          # penetrates the pivot
fx["c"][50] = 15005.0                       # and closes back above it
tr = {}
ev = FE.compute_events(fx, trace=tr)
pid = f"PIVOT_L-{fx['t'][30]}"
piv = [x for x in tr["levels"] if x["level_id"] == pid]
ok(len(piv) == 1, f"the fractal pivot was created once ({pid})")
mine = [r for r in ev if r["level_id"] == pid]
ok(len(mine) == 1, f"EXACTLY ONE sweep event from the pivot ({len(mine)})")
ok(mine and mine[0]["t0"] == fx["t"][50] + BAR,
   "emitted on the sweep+reclaim bar itself")
ok(piv[0]["has_emitted_sweep"] is True, "its event-generation state is consumed")
ok(piv[0]["alive"] is False,
   "and it is structurally retired from the next bar's economic set")
fx2 = {k: list(v) for k, v in fx.items()}
fx2["c"][50] = 14985.0                      # penetration WITHOUT reclaim
tr2 = {}
ev2 = FE.compute_events(fx2, trace=tr2)
p2_ = [x for x in tr2["levels"] if x["level_id"] == pid][0]
ok(len([r for r in ev2 if r["level_id"] == pid]) == 1,
   "penetration without reclaim also emits exactly one event")
ok(p2_["alive"] is True, "without reclaim the pivot stays economically alive")
ok(p2_["has_emitted_sweep"] is True,
   "but it cannot emit again - its event state is consumed")
src_order = src[src.index("# \u2500\u2500 B/C/D."):src.index("# \u2500\u2500 G.")]
ok(src_order.index("rows.append") < src_order.index("structural invalidation"),
   "emission precedes structural invalidation in the bar loop")
ok(src_order.index('touch_count"] += 1') > src_order.index("rows.append"),
   "touch updates also follow emission")

print("\nE/F. Immutable level_id survives reordering and pruning")
ok(all("level_id" in r for r in rows), "every event row carries level_id")
ids = [r["level_id"] for r in rows]
ok(len(set(ids)) == len(ids), f"one event per identity ({len(set(ids))}/{len(ids)})")
ok(not any(x.startswith("pivot0") or x.startswith("pivot1") for x in ids),
   "no identity is a view position like pivot0/pivot1")
eng = FE._SortedLevels()
a = FE.new_level("A", "pivot", 1, 100.0, 0, 0)
bb = FE.new_level("B", "pivot", 1, 50.0, 0, 0)
cc = FE.new_level("C", "pivot", 1, 75.0, 0, 0)
for x in (a, bb, cc): eng.add(x)
ok([x["level_id"] for x in eng.between(0, 1000)] == ["B", "C", "A"],
   "the sorted view reorders by price")
eng.remove(cc)
ok([x["level_id"] for x in eng.between(0, 1000)] == ["B", "A"]
   and a["level_id"] == "A" and bb["level_id"] == "B",
   "pruning a neighbour changes no surviving identity")
ok(json.loads(json.dumps(a, default=str))["level_id"] == "A",
   "level_id survives serialization")

print("\nG. Duplicate pivots merge on the frozen rule")
older = {"level_id": "PIVOT_L-100", "price": 10.0, "formation_ts": 90,
         "available_ts": 100, "touch_count": 3}
newer = {"level_id": "PIVOT_L-200", "price": 10.2, "formation_ts": 190,
         "available_ts": 200, "touch_count": 4}
mg = V.merge_duplicate_pivots(older, newer)
ok(mg["level_id"] == "PIVOT_L-100" and mg["price"] == 10.0,
   "the OLDER availability supplies id and price")
ok(mg["formation_ts"] == 90 and mg["available_ts"] == 100,
   "older formation and availability survive")
ok(mg["touch_count"] == 7, "touch counts sum")
ok(mg["merged_from"] == ["PIVOT_L-100", "PIVOT_L-200"], "sources retained")
ok("merged_from" in src and "PROXY_PIVOT_DUP_TOLERANCE_PTS" in src,
   "the streaming engine performs the merge, not just the helper")
DUP = V.PROXY_PIVOT_DUP_TOLERANCE_PTS
ok(abs(DUP - 0.25) < 1e-12, f"tolerance is the frozen constant ({DUP})")

print("\nH. touch_count excludes the sweep bar")
ok("touch_count" in FE.EVENT_FIELDS, "touch_count is emitted")
ok(src.index('lv["has_emitted_sweep"] = True') <
   src.index('lv["touch_count"] += 1'),
   "the sweep bar's touch update cannot reach an already-emitted level")
ok(all(r["touch_count"] >= 0 for r in rows), "counts are non-negative")
ok(any(r["touch_count"] > 0 for r in rows),
   "the counter actually accumulates on real fixtures")

print("\nI. True formation timestamps, never invented")
ok("formation=o_ - 1" not in src and "formation=t[i] - 1" not in src,
   "the synthetic 'availability - 1' stamps are gone")
lag = [r["level_formation_lag_min"] for r in rows]
ok(all(x >= 0 for x in lag), "formation never follows availability")
ok(max(lag) > 1.0, f"lags are real durations, not a fixed 1 second ({max(lag):.1f} min)")
ok(not any(abs(x - 1/60) < 1e-9 for x in lag),
   "no lag equals the old invented one-second value")

print("\nJ/K. Canonical loader carries broker volume; VWAP fails closed")
lo_, hi_ = S.span_epoch(dt.date(2023, 3, 1), dt.date(2023, 3, 2))
rb = FE.load_raw(V.RAW_BASIS, lo_, hi_)
ok(set(rb) == {"t", "o", "h", "l", "c", "v"}, f"loader returns OHLCV {sorted(rb)}")
ok(len(rb["v"]) == len(rb["t"]) and any(x > 0 for x in rb["v"]),
   "volume is populated in the same pass")
ok('or [1.0] * ' not in src, "the equal-weight fallback is deleted")
bs = synth(2)
st = FE.build_state(bs)
for bad, why in ((None, "absent"), (bs["v"][:-3], "mis-sized"),
                 ([float("nan")]*len(bs["t"]), "non-finite")):
    probe = dict(bs); probe["v"] = bad
    try:
        FE.session_vwap(probe, st); ok(False, f"{why} volume should HALT")
    except FE.VolumeUnavailable:
        ok(True, f"{why} volume HALTS instead of equal-weighting")

print("\nL. VWAP slope cannot cross a session reset")
ok("vnbar[i] >= 13" in src, "13 observations required, not 12")
ok("vsid[i] == vsid[i-12]" in src, "t and t-12 must share a VWAP session")
bs = synth(4)
st = FE.build_state(bs)
vw, vs, vn, vsid = FE.session_vwap(bs, st)
resets = [i for i in range(1, len(bs["t"])) if vsid[i] != vsid[i-1]]
ok(resets, "the fixture contains session resets")
r0 = resets[0]
for k, exp in ((11, False), (12, False), (13, True)):
    i = r0 + k - 1
    have = (i >= 12 and vn[i] >= 13 and vsid[i] == vsid[i-12])
    ok(have == exp, f"{k} observations since the anchor -> "
       f"{'computable' if exp else 'missing'}")

print("\nM. 15m compression uses TRUE RANGE, not high-low")
ok('x["tr"] for x in w' in src, "the 15m window sums true range")
ok('agg15[x][1]-agg15[x][2]' not in src, "the high-low version is gone")
gap = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
op, _ = S.session_bounds(dt.date(2023, 3, 1))
ts = int(op.timestamp())
for k in range(300):
    base = 15000.0 + (500.0 if k >= 150 else 0.0)      # a hard gap at k=150
    gap["t"].append(ts + k*BAR); gap["o"].append(base); gap["c"].append(base)
    gap["h"].append(base + 1.0); gap["l"].append(base - 1.0); gap["v"].append(9.0)
ser = FE.htf_series(gap, 900)
j = next(i for i, x in enumerate(ser) if x["tr"] > 100)
ok(ser[j]["tr"] > ser[j]["h"] - ser[j]["l"],
   f"across the gap TR ({ser[j]['tr']:.1f}) exceeds high-low "
   f"({ser[j]['h']-ser[j]['l']:.1f})")

print("\nN. htf_1h_dist_ref_atr uses ACTUAL 1H Wilder ATR(14)")
ok("12 ** 0.5" not in src and "12**0.5" not in src,
   "the sqrt(12) approximation is deleted")
ok("atr1h = wilder_rma" in src, "a real 1H Wilder RMA is computed")
bs = synth(30, seed=11, vol=6.0)
st = FE.build_state(bs)
s1h = FE.htf_series(bs, 3600)
a1h = FE.wilder_rma([x["tr"] for x in s1h])
approx = [st["atr"][i] * math.sqrt(12) for i in range(len(bs["t"]))
          if st["atr"][i]]
real = [x for x in a1h if x]
ok(real and approx, "both series exist on the fixture")
rel = abs(sum(real)/len(real) - sum(approx)/len(approx)) / (sum(real)/len(real))
ok(rel > 0.02, f"the approximation differs materially from real 1H ATR "
   f"({100*rel:.1f}%)")

print("\nO/P/Q/R/S. The six previously-absent confirmatory features")
for f in ("htf_1h_range_pctile", "htf_1h_vol_state", "atr_percentile",
          "realized_vol_state", "session_location", "touch_count"):
    ok(f in emitted, f"{f} is emitted in the event row")
    ok(CM["features"][f]["implemented"], f"{f} maps to an implementation")
ok(all(r["session_location"] in
       [x[0] for x in FE.SESSION_BUCKETS] or r["session_location"] is None
       for r in rows), "session_location uses only the frozen buckets")
ok(FE.MIN_COMPARATORS == 252, "252 comparators required")
t0 = 1_700_000_000
hist = [(None, 7, t0-86400*i, float(i)) for i in range(300, 0, -1)]
for f, nm in ((FE.same_bucket_percentile, "same-bucket percentile"),):
    ok(f(150.0, hist, t0) is not None, f"{nm}: 252 prior -> computed")
    ok(f(150.0, hist[:251], t0) is None, f"{nm}: 251 prior -> missing")
    ok(f(1.0, [(None, 7, t0+i, float(i)) for i in range(300)], t0) is None,
       f"{nm}: future comparators are rejected")

print("\nT. Optimized and reference engines agree on synthetic fixtures")
KEYS = ("level_id", "t0", "trade_date", "liquidity_class", "direction",
        "touch_count", "penetration_pts", "level_prominence_atr",
        "level_age_min", "level_formation_lag_min", "session_location")
agree = True
for seed in (1, 2, 3, 5, 8):
    fx = synth(7, seed=seed)
    a = FE.compute_events(fx)
    r = REF.reference_events(fx)
    if len(a) != len(r):
        ok(False, f"seed {seed}: event COUNT differs {len(a)} vs {len(r)}")
        agree = False; continue
    bad = []
    for x, y in zip(a, r):
        for k in KEYS:
            u, v_ = x.get(k), y.get(k)
            if isinstance(u, float) and isinstance(v_, float):
                if abs(u - v_) > 1e-9: bad.append((k, u, v_))
            elif u != v_:
                bad.append((k, u, v_))
    ok(not bad, f"seed {seed}: {len(a)} events agree on every compared field"
       + (f" - first diff {bad[0]}" if bad else ""))
    if bad: agree = False
ok(agree, "optimized == reference across all fixtures")

print("\nU. No outcome code executes anywhere in the freeze path")
_OUT = ("y_5", "y_15", "y_30", "y_60", "mfe", "mae", "forward_return")
for mod in ("v2_features.py", "v2_reference.py", "freeze_winsorization.py"):
    tree = ast.parse(open(f"backtest/{mod}").read())
    hit = set()
    for nd in ast.walk(tree):
        if isinstance(nd, ast.Name) and nd.id.lower() in _OUT: hit.add(nd.id)
        if (isinstance(nd, ast.Subscript) and isinstance(nd.slice, ast.Constant)
                and isinstance(nd.slice.value, str)
                and nd.slice.value.lower() in _OUT): hit.add(nd.slice.value)
    ok(not hit, f"{mod} binds no outcome symbol {sorted(hit)}")
ok(not os.path.exists("research/V2_RESULTS.json"), "no V2 results artifact exists")

print()
if FAILS:
    print(f"CONFORMANCE TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - " + f)
    sys.exit(1)
print("CONFORMANCE TESTS PASSED (spec vs engine; no outcome computed).")
