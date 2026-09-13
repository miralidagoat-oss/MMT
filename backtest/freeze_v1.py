#!/usr/bin/env python3
"""Freeze V1 as a permanent negative result.

Re-runs each configuration that defines a hypothesis's conclusion and records
the full statistical block, including max drawdown, which the H1-H6 artifacts
did not carry. Re-running is reproduction, not modification: the engine is
deterministic and the post-restart sanity check reproduced n=1978, +0.0136R
exactly.

Emits research/V1_FROZEN.json and research/V1_RESULTS.md, stamped with the
commit SHA and a per-configuration hash so any row can be regenerated.
"""
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import replace, asdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_h1_h6 as H
import report_result as R
from evaluate import CANDIDATE

C = CANDIDATE


def cfg_hash(p):
    """Stable hash of the full parameter set, so a row can be traced to the
    exact configuration that produced it."""
    d = {k: (list(v) if isinstance(v, tuple) else v)
         for k, v in sorted(asdict(p).items())}
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:16]


def drawdown_r(rs):
    """Max peak-to-trough of the cumulative R curve, in R."""
    peak = cum = 0.0
    dd = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return dd


# The configuration that DEFINES each hypothesis's conclusion. Grids live in
# research/results/*.json; this is the row each conclusion rests on.
ROWS = [
    ("baseline", "CANDIDATE as shipped", C,
     "CI spans zero; negative at stressed friction"),
    ("H1", "cooldown argmax 8 (40min)", replace(C, cooldown=8),
     "surface flat - whole grid spans 0.51 SE; argmax is not distinguishable"),
    ("H1", "validity 48 (240min)", replace(C, validity=48),
     "INERT - market entry never consults limit lifetime; spread exactly 0.0000R"),
    ("H2", "max_event_bars argmax 11 (55min)", replace(C, reclaim_bars=24, max_event_bars=11),
     "CI spans zero; no window beats the unconstrained model"),
    ("H3", "anchor day (Globex 18:00 ET)", replace(C, po3_period="day"),
     "negative; best of the three sanctioned anchors"),
    ("H3", "anchor midnight (00:00 ET)", replace(C, po3_period="midnight"),
     "negative"),
    ("H3", "anchor cash (09:30 ET)", replace(C, po3_period="cash"),
     "negative"),
    ("H4", "min_range_atr argmax 0.75", replace(C, min_range_atr=0.75),
     "§5 plateau FAILS - needle, longest run within 1 SE is 4 of 5 required"),
    ("H5", "drop T1 prior+session", replace(C, pools=("ibh", "ibl", "pivot")),
     "T1 adds value in only 1 of 3 sub-windows - fails the §5 tier test"),
    ("H5", "drop T3/T4 swing pivots", replace(C, pools=("pdh", "pdl", "pwh", "pwl",
                                                        "asiah", "asial", "lonh",
                                                        "lonl", "ibh", "ibl")),
     "removing pivots collapses the model to -0.0767R - they carry it, but to zero"),
    ("H6", "5m+15m", replace(C, htf_confirm=(900,)),
     "negative; removes 83% of trades; fails the §11 frequency floor"),
    ("H6", "5m+1H", replace(C, htf_confirm=(3600,)),
     "negative; fails the §11 frequency floor"),
    ("H6", "5m+15m+1H", replace(C, htf_confirm=(900, 3600)),
     "negative; removes 95% of trades; fails the §11 frequency floor"),
]


def main():
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    bars, countable_from = H.bars_for()
    countable_days = len({R.trade_day(x) for x in bars["t"] if x >= countable_from})
    span_days = len({R.trade_day(x) for x in bars["t"]})

    out = {"commit": sha,
           "basis": H.BASIS,
           "partition": H.PART,
           "cost_headline_points": H.FRICTION,
           "cost_headline_usd_rt": H.FRICTION * 20,
           "cost_stressed_usd_rt": H.STRESSED * 20,
           "cost_application": "friction_points / initial risk in points, per "
                               "trade - identical to $14 / (risk_points x $20)",
           "frequency_denominator_used": span_days,
           "frequency_denominator_correct": countable_days,
           "frequency_defect": ("reported trades/day used the loaded span "
                                f"({span_days} trade days, warm-up included) "
                                f"rather than countable days ({countable_days}); "
                                "every frequency figure is understated by ~3%"),
           "rows": []}

    for hyp, label, params, why in ROWS:
        log, _ = H.raw(params)
        s = R.summarize(log, bars, label)
        rs = [x["r"] for x in log]
        out["rows"].append({
            "hypothesis": hyp, "config": label, "config_hash": cfg_hash(params),
            "n": s["n"], "mean_r": s["mean_r"], "pf": s["pf"],
            "win_rate": s["win_rate"], "sd": s["sd"],
            "max_drawdown_r": drawdown_r(rs),
            "freq_reported": s["freq_per_trade_day"],
            "freq_corrected": s["n"] / countable_days,
            "headline_ci": s["headline_ci"], "headline_scale": s["headline_scale"],
            "significant": s["significant"],
            "all_scales": s["scales"],
            "failure_reason": why,
            "params": {k: (list(v) if isinstance(v, tuple) else v)
                       for k, v in sorted(asdict(params).items())},
        })
        print(f"  {hyp:<9} {label:<34} n={s['n']:>5}  {s['mean_r']:+.4f}R  "
              f"PF {s['pf']:.3f}  DD {drawdown_r(rs):.1f}R  "
              f"{s['freq_per_trade_day']:.2f}/day")

    os.makedirs("research", exist_ok=True)
    with open("research/V1_FROZEN.json", "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\n-> research/V1_FROZEN.json   commit {sha[:12]}")
    return out


if __name__ == "__main__":
    main()
