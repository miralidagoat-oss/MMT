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


def raw(params, part=PART, friction=FRICTION):
    """Countable trade log plus the bars it refers to."""
    bars, countable_from = bars_for(part)
    ctx = E.build_context(bars)
    log = []
    E.run(bars, ctx, replace(params, friction_points=friction,
                             cost_ticks=0.0, tick=0.25), outcome_log=log)
    return P.countable(log, bars, countable_from), bars


def run(params, part=PART, friction=FRICTION, label=""):
    log, bars = raw(params, part, friction)
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


# ── H2: multi-bar manipulation event model ────────────────────────────────
def h2():
    print("H2 - manipulation event duration\n")
    print("§10 requires the EMPIRICAL duration distribution to be examined")
    print("before any candidate window is declared. So the first pass runs a")
    print("deliberately permissive reclaim window and just looks.\n")
    print("The engine already records `lag`: bars from the first bar of the")
    print("raid to the reclaim bar - penetration begins -> reclaim.\n")

    PERMISSIVE = 24                      # 2 hours; wide enough not to censor
    log, bars = raw(replace(CANDIDATE, reclaim_bars=PERMISSIVE))
    lags = [x["lag"] for x in log]
    n = len(lags)
    print(f"── observed distribution (reclaim_bars={PERMISSIVE} = "
          f"{PERMISSIVE*BAR_MIN}min cap, n={n:,})")
    by = {}
    for x in log:
        by.setdefault(x["lag"], []).append(x["r"])
    cum = 0
    dist = []
    for lag in sorted(by):
        k = len(by[lag])
        cum += k
        m = sum(by[lag]) / k
        dist.append({"lag": lag, "minutes": lag * BAR_MIN, "n": k,
                     "share": k / n, "cum_share": cum / n, "mean_r": m})
        bar = "#" * int(60 * k / max(len(v) for v in by.values()))
        print(f"   lag {lag:>2} ({lag*BAR_MIN:>3}min)  n={k:>5}  "
              f"{100*k/n:5.1f}%  cum {100*cum/n:5.1f}%  "
              f"mean {m:+.4f}R  {bar}")

    # windows are declared FROM the distribution just printed, in coarse
    # economically reasonable ranges - not swept to find a winner
    q = {}
    cum = 0
    for d in dist:
        cum += d["n"]
        for pct in (50, 80, 90, 95):
            if pct not in q and cum / n >= pct / 100:
                q[pct] = d["lag"]
    print(f"\n   mass: 50% within {q.get(50)} bars, 80% within {q.get(80)}, "
          f"90% within {q.get(90)}, 95% within {q.get(95)}")

    # The window must cap TOTAL event duration, which is what the distribution
    # above measures. reclaim_bars caps something else - bars since the raid
    # last extended - so a raid that keeps extending runs far past it, which is
    # why lags of 146 appear under a 24-bar reclaim cap. max_event_bars is the
    # gate that corresponds to this distribution.
    windows = sorted({q.get(50, 3), q.get(80, 11), q.get(90, 20),
                      q.get(95, 30), 60})
    print(f"\n── candidate windows declared from the distribution: {windows}")
    print("   applied to max_event_bars (total duration), NOT reclaim_bars\n")
    rows = sweep("h2", "max_event_bars",
                 windows, base=replace(CANDIDATE, reclaim_bars=PERMISSIVE))
    ses = [r["se"] for r in rows]
    means = [r["mean"] for r in rows]
    vac, why = PL.vacuous(means, ses)
    best = max(range(len(rows)), key=lambda i: means[i])
    print(f"\n  argmax window {windows[best]} "
          f"({windows[best]*BAR_MIN}min, {means[best]:+.4f}R)")
    print(f"  vacuity: {'VACUOUS - ' + why if vac else 'informative surface'}")
    save("h2_duration", {"permissive_cap": PERMISSIVE, "gate": "max_event_bars",
                         "distribution": dist,
                         "quantiles": q, "windows": windows, "rows": rows,
                         "vacuous": vac, "vacuity_detail": why})


CMDS = {"baseline": baseline, "h1": h1, "h2": h2}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        sys.exit(f"usage: run_h1_h6.py [{'|'.join(CMDS)}]")
    CMDS[sys.argv[1]]()
