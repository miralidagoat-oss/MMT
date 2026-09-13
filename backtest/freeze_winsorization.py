#!/usr/bin/env python3
"""Compute and FREEZE winsorization constants from DEVELOPMENT BURN-IN only.

Computes event-time features for burn-in events. NO forward return, NO MFE,
NO MAE, NO outcome of any kind is calculated or read.
"""
import csv, datetime as dt, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE

BURN_START, BURN_END = dt.date(2022, 9, 9), dt.date(2023, 8, 31)
MIN_VALID = 100
QL, QU = 0.005, 0.995

lo, hi = S.span_epoch(BURN_START, BURN_END)
bars = FE.load_raw(V.RAW_BASIS, lo, hi)
print(f"burn-in bars {len(bars['t']):,}  {BURN_START} .. {BURN_END}")
# volume column for VWAP
vol = []
with open(V.RAW_BASIS) as f:
    r = csv.reader(f); next(r)
    for x in r:
        ts = int(x[0])
        if lo <= ts < hi:
            vol.append(float(x[5]))
bars["v"] = vol

st = FE.build_state(bars)
stream = FE.iter_levels(bars, st)
vwap, vsig, vnbar = FE.session_vwap(bars, st)
agg15, new15 = FE.htf_aggregates(bars, st, 900)
agg1h, new1h = FE.htf_aggregates(bars, st, 3600)
rows = FE.event_time_features(bars, st, stream, vwap, vsig, vnbar,
                              agg15, new15, agg1h, new1h)
print(f"burn-in events {len(rows):,}   trade dates "
      f"{len({r['trade_date'] for r in rows})}")

out = {"source_period": f"{BURN_START}..{BURN_END}",
       "basis": V.RAW_BASIS, "quantile_algorithm": "type-7 linear",
       "lower_quantile": QL, "upper_quantile": QU,
       "min_valid_observations": MIN_VALID,
       "burn_in_events": len(rows), "features": {}}
halt = []
for name in FE.WINSORIZED:
    vals = [r[name] for r in rows if r.get(name) is not None]
    vals = [v for v in vals if v == v]
    nmiss = len(rows) - len(vals)
    if len(vals) < MIN_VALID:
        halt.append((name, len(vals)))
        out["features"][name] = {"valid_n": len(vals), "missing_n": nmiss,
                                 "frozen_lower": None, "frozen_upper": None,
                                 "status": "INSUFFICIENT"}
        continue
    sv = sorted(vals)
    out["features"][name] = {
        "valid_n": len(vals), "missing_n": nmiss,
        "missing_pct": round(100*nmiss/len(rows), 2),
        "lower_quantile": QL, "upper_quantile": QU,
        "frozen_lower": FE.quantile(sv, QL), "frozen_upper": FE.quantile(sv, QU),
        "status": "FROZEN"}
    f = out["features"][name]
    print(f"  {name:<30} n={f['valid_n']:>7,}  miss={f['missing_pct']:>5.2f}%  "
          f"[{f['frozen_lower']:+.6g}, {f['frozen_upper']:+.6g}]")

if halt:
    print(f"\nHALT: {len(halt)} feature(s) below {MIN_VALID} valid burn-in "
          f"observations: {halt}")
    json.dump(out, open("research/WINSORIZATION_FREEZE.json", "w"), indent=2, default=str)
    sys.exit(1)
json.dump(out, open("research/WINSORIZATION_FREEZE.json", "w"), indent=2, default=str)
print(f"\n-> research/WINSORIZATION_FREEZE.json  ({len(FE.WINSORIZED)} features frozen)")
