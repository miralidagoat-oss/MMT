#!/usr/bin/env python3
"""Compute and FREEZE winsorization constants from DEVELOPMENT BURN-IN only.

Computes event-time features for burn-in events. NO forward return, NO MFE,
NO MAE, NO outcome of any kind is calculated or read.
"""
import datetime as dt, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE

BURN_START, BURN_END = dt.date(2022, 9, 9), dt.date(2023, 8, 31)
MIN_VALID = 100
OUT = "research/WINSORIZATION_FREEZE_V2.json"
QL, QU = 0.005, 0.995

lo, hi = S.span_epoch(BURN_START, BURN_END)
bars = FE.load_raw(V.RAW_BASIS, lo, hi)          # canonical loader, incl. volume
print(f"burn-in bars {len(bars['t']):,}  {BURN_START} .. {BURN_END}")
rows = FE.compute_events(bars)                   # THE canonical engine
print(f"burn-in events {len(rows):,}   trade dates "
      f"{len({r['trade_date'] for r in rows})}")

out = {"source_period": f"{BURN_START}..{BURN_END}",
       "basis": V.RAW_BASIS, "quantile_algorithm": "type-7 linear",
       "lower_quantile": QL, "upper_quantile": QU,
       "min_valid_observations": MIN_VALID,
       "burn_in_events": len(rows), "engine": "backtest/v2_features.py compute_events()",
       "supersedes": "research/WINSORIZATION_FREEZE.json", "features": {}}
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
    json.dump(out, open(OUT, "w"), indent=2, default=str)
    sys.exit(1)
json.dump(out, open(OUT, "w"), indent=2, default=str)
print(f"\n-> {OUT}  ({len(FE.WINSORIZED)} features frozen)")
