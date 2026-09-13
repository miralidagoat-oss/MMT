#!/usr/bin/env python3
"""H1-H6 on the development partition (PROTOCOL v1.3c §10).

Run one hypothesis at a time:  python3 run_h1_h6.py baseline|h1|h2|h5 ...

Everything reads the development partition through partitions.load(), so the
holdout cannot be touched by omission. Headline statistics come from
report_result (§6/§7) and plateau decisions from plateau (§5); neither is
reimplemented here, so the rules cannot drift between hypotheses.
"""
import json
import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E
import partitions as P
import plateau as PL
import report_result as R
from evaluate import CANDIDATE

BASIS = "data_ndx_q/NDX_5m.csv"
PART = "development"
FRICTION = 0.70          # §3 headline, $14 RT / $20 per point
STRESSED = 1.20          # §3 stressed, $24 RT
BAR_MIN = 5              # this basis is 5-minute
OUT = "research/results"

_cache = {}


def bars_for(part=PART):
    if part not in _cache:
        _cache[part] = P.load(BASIS, part)
    return _cache[part]


def run(params, part=PART, friction=FRICTION, label=""):
    bars, countable_from = bars_for(part)
    ctx = E.build_context(bars)
    log = []
    E.run(bars, ctx, replace(params, friction_points=friction,
                             cost_ticks=0.0, tick=0.25), outcome_log=log)
    log = P.countable(log, bars, countable_from)
    return R.summarize(log, bars, label or part)


def sweep(name, field, values, base=None, unit="bars"):
    """One parameter, everything else held at base. Returns the rows plus the
    index of the CANDIDATE value, so the plateau test asks about the value we
    would actually ship rather than the argmax."""
    base = base or CANDIDATE
    rows = []
    for v in values:
        s = run(replace(base, **{field: v}), label=f"{name}={v}")
        se = (s["sd"] / (s["n"] ** 0.5)) if s["n"] > 1 else float("inf")
        rows.append({"value": v, "n": s["n"], "mean": s["mean_r"], "se": se,
                     "freq": s["freq_per_trade_day"],
                     "ci": s["headline_ci"], "scale": s["headline_scale"],
                     "sig": s["significant"]})
        m = f"{v * BAR_MIN} min" if unit == "bars" else f"{v}"
        print(f"  {field}={v:<5} ({m:>8})  n={s['n']:>5}  "
              f"mean {s['mean_r']:+.4f}R  se {se:.4f}  "
              f"freq {s['freq_per_trade_day']:.2f}/day  "
              f"CI [{s['headline_ci'][0]:+.4f},{s['headline_ci'][1]:+.4f}]")
    return rows


def save(name, obj):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{name}.json"), "w") as f:
        json.dump(obj, f, indent=2, default=str)
    print(f"  -> {OUT}/{name}.json")


# ── baseline ───────────────────────────────────────────────────────────────
def baseline():
    print("BASELINE - CANDIDATE as shipped, on development\n")
    print("CANDIDATE was selected on MNQ 1h. Its temporal parameters are BAR")
    print("counts, so on a 5-minute basis they mean something entirely")
    print(f"different: reclaim_bars=2 -> {2*BAR_MIN}min (was 2h), "
          f"cooldown=6 -> {6*BAR_MIN}min (was 6h),")
    print(f"validity=12 -> {12*BAR_MIN}min (was 12h). That is H1's thesis.\n")
    s = run(CANDIDATE)
    R.render(s)
    print()
    st = run(CANDIDATE, friction=STRESSED, label="stressed friction $24 RT")
    R.render(st)
    v, why = R.verdict(s, st)
    print(f"\n§11 verdict: {v}")
    for w in why:
        print(f"  - {w}")
    save("baseline", {"headline": s, "stressed": st, "verdict": v, "why": why})


# ── H1: temporal re-normalisation ──────────────────────────────────────────
def h1():
    print("H1 - temporal parameters re-normalised to ELAPSED MINUTES\n")
    print("Each is swept on its own grid with everything else at CANDIDATE.")
    print("§5 temporal: a contiguous stable region spanning at least 2x.\n")
    res = {}
    grids = {
        "cooldown":     [1, 2, 3, 4, 6, 8, 12, 18, 24, 36],
        "reclaim_bars": [1, 2, 3, 4, 6, 8, 12],
        "validity":     [3, 6, 12, 18, 24, 36, 48],
    }
    for field, vals in grids.items():
        print(f"── {field} " + "─" * 50)
        rows = sweep("h1", field, vals)
        chosen = getattr(CANDIDATE, field)
        idx = vals.index(chosen)
        minutes = [v * BAR_MIN for v in vals]
        ok, detail = PL.temporal(minutes, [r["mean"] for r in rows],
                                 [r["se"] for r in rows], idx)
        best = max(range(len(rows)), key=lambda i: rows[i]["mean"])
        print(f"  CANDIDATE {field}={chosen} ({chosen*BAR_MIN}min)  "
              f"argmax {field}={vals[best]} ({minutes[best]}min, "
              f"{rows[best]['mean']:+.4f}R)")
        print(f"  §5 temporal plateau at CANDIDATE: "
              f"{'PASS' if ok else 'FAIL'} - {detail}\n")
        res[field] = {"grid": vals, "minutes": minutes, "rows": rows,
                      "candidate": chosen, "plateau_ok": ok,
                      "plateau_detail": detail, "argmax": vals[best]}
    save("h1_temporal", res)


CMDS = {"baseline": baseline, "h1": h1}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        sys.exit(f"usage: run_h1_h6.py [{'|'.join(CMDS)}]")
    CMDS[sys.argv[1]]()
