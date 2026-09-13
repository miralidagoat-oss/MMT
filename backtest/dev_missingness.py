#!/usr/bin/env python3
"""Pre-outcome missingness and coverage on the DEVELOPMENT EVALUABLE window.

The frozen gate (PROTOCOL_V2_CANONICAL section 10) reads: "Every univariate
result reports eligible events before missingness ... percent missing.
>20% missing -> the feature stays descriptive and cannot be promoted." A
univariate result is computed on the development population, so that is where
the gate is measured. Burn-in missingness is reported too, but it CANNOT
govern the four 252-day percentile features: burn-in is precisely the 252 days
that build their comparators, so they are 100% missing there BY CONSTRUCTION -
which the spec itself anticipates ("no 252-day percentile ever needs a constant
from a period in which it is not yet eligible").

Availability only. NO outcome is computed.
"""
import datetime as dt, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE

BURN_START = dt.date(2022, 9, 9)
EVAL_START, EVAL_END = dt.date(2023, 9, 1), dt.date(2025, 5, 5)
OUT = "research/COVERAGE_AUDIT_V2.json"

lo, _ = S.span_epoch(BURN_START, BURN_START)
_, hi = S.span_epoch(EVAL_END, EVAL_END)
bars = FE.load_raw(V.RAW_BASIS, lo, hi)
print(f"bars {len(bars['t']):,}  {BURN_START} .. {EVAL_END}")
rows = FE.compute_events(bars)
ev = [r for r in rows if r["trade_date"] >= EVAL_START]
print(f"all events {len(rows):,}   development-evaluable {len(ev):,}"
      f"   trade dates {len({r['trade_date'] for r in ev})}")

S_ = json.load(open("research/FEATURE_SPEC_V2.json"))
decl = sorted(S_["event_time_features"])
fam = set(S_["confirmatory_family"])
out = {"scope": "development evaluable window", "start": str(EVAL_START),
       "end": str(EVAL_END), "events": len(ev),
       "trade_dates": len({r["trade_date"] for r in ev}),
       "engine": "backtest/v2_features.py compute_events()",
       "gate": "PROTOCOL_V2_CANONICAL section 10: >20% missing -> descriptive only",
       "note": "AVAILABILITY ONLY - no outcome, no return, no performance.",
       "features": {}}
for f in decl:
    miss = sum(1 for r in ev if r.get(f) is None)
    pct = 100.0 * miss / len(ev) if ev else 100.0
    out["features"][f] = {
        "valid_n": len(ev) - miss, "missing_n": miss,
        "missing_pct": round(pct, 2),
        "in_confirmatory_family": f in fam,
        "promotion_status": (None if f not in fam else
                             ("NON_PROMOTABLE" if pct > 20.0 else "PROMOTABLE"))}
json.dump(out, open(OUT, "w"), indent=2)
print(f"\n{'feature':<30} {'miss%':>7}  {'family':>6}  status")
for f in decl:
    v = out["features"][f]
    print(f"  {f:<28} {v['missing_pct']:>6.2f}%  "
          f"{'YES' if v['in_confirmatory_family'] else '  -':>6}  "
          f"{v['promotion_status'] or ''}")
print(f"\n-> {OUT}")
