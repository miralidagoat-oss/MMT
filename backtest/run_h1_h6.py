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


# ── H5: liquidity hierarchy ablated by tier ───────────────────────────────
# §10 tiers mapped onto the pools the engine actually implements:
TIERS = {
    "T1_prior_and_session": ("pdh", "pdl", "pwh", "pwl",
                             "asiah", "asial", "lonh", "lonl"),
    "T2_opening_range":     ("ibh", "ibl"),
    "T3_T4_swing_pivots":   ("pivot",),
}
# NOTE, recorded rather than glossed: §10 separates T3 (significant dynamic
# swing liquidity) from T4 (minor local pivots). The engine has ONE pivot class
# whose significance is set globally by pivot_len, so the two cannot be ablated
# independently without an engine change. They are tested as one tier and the
# limitation is reported. §10 also places equal-highs/lows in T2; that is the
# global eq_only flag rather than a pool kind, so it is tested as its own switch.


def _by_subwindow(log, bars, k=3):
    """Split a development run into k chronological sub-windows by trade date.

    Splitting one continuous run is preferable to running k separate
    partitions: the engine's causal state (pools, VWAP, HTF) stays continuous
    across the seams, so no sub-window starts cold.
    """
    t = bars["t"]
    rows = sorted(((R.trade_day(t[x["bar"]]), x["r"]) for x in log),
                  key=lambda z: z[0])
    days = sorted({d for d, _ in rows})
    if len(days) < k:
        return []
    cut = [days[len(days) * i // k] for i in range(1, k)]
    out = [[] for _ in range(k)]
    for d, r in rows:
        w = sum(1 for c in cut if d >= c)
        out[w].append(r)
    return out


def h5():
    print("H5 - liquidity hierarchy ablated by tier\n")
    print("§5 tiers: a retained tier must show incremental value in >=2 of 3")
    print("development sub-windows. Ablation is leave-one-tier-out.\n")

    full = tuple(x for tier in TIERS.values() for x in tier)
    base = replace(CANDIDATE, pools=full)
    s_full = run(base, label="all tiers")
    R.render(s_full)
    log_full, bars = raw(base)
    w_full = _by_subwindow(log_full, bars)
    means_full = [sum(w) / len(w) if w else 0.0 for w in w_full]
    print(f"\n  sub-window means with all tiers: "
          f"{['%+.4f' % m for m in means_full]}\n")

    res = {"full": s_full, "subwindow_means_full": means_full, "tiers": {}}
    for name, members in TIERS.items():
        kept = tuple(x for x in full if x not in members)
        if not kept:
            continue
        print(f"── drop {name} {members}")
        s = run(replace(base, pools=kept), label=f"without {name}")
        log_w, _ = raw(replace(base, pools=kept))
        w_wo = _by_subwindow(log_w, bars)
        means_wo = [sum(w) / len(w) if w else 0.0 for w in w_wo]
        ok, detail = PL.tiers(name, means_full, means_wo)
        print(f"   with    n={s_full['n']:>5}  mean {s_full['mean_r']:+.4f}R")
        print(f"   without n={s['n']:>5}  mean {s['mean_r']:+.4f}R   "
              f"delta {s_full['mean_r'] - s['mean_r']:+.4f}R")
        print(f"   sub-window means without: {['%+.4f' % m for m in means_wo]}")
        print(f"   §5 tier test: {'KEEP' if ok else 'DROP'} - {detail}\n")
        res["tiers"][name] = {"members": members, "without": s,
                              "subwindow_means_without": means_wo,
                              "keep": ok, "detail": detail}

    print("── equal-highs/lows switch (a §10 T2 element, global flag)")
    s_eq = run(replace(base, eq_only=True), label="eq_only pivots")
    print(f"   eq_only=False n={s_full['n']:>5}  mean {s_full['mean_r']:+.4f}R")
    print(f"   eq_only=True  n={s_eq['n']:>5}  mean {s_eq['mean_r']:+.4f}R")
    res["eq_only"] = s_eq
    save("h5_tiers", res)


# ── H3: session-anchored PO3 ──────────────────────────────────────────────
# §10 sanctions exactly three anchors and no other start times.
H3_ANCHORS = {"day": "Globex trade-day open 18:00 ET",
              "midnight": "NY midnight 00:00 ET",
              "cash": "09:30 ET cash open"}


def h3():
    print("H3 - session-anchored PO3, three sanctioned anchors\n")
    print("§10: Globex trade-day open, NY midnight, 09:30 cash open. No other")
    print("start times. CANDIDATE currently uses po3_period='week', which is")
    print("NOT one of the three - so the shipped config is outside H3's own")
    print("constraint and 'week' is carried here only as a reference column.\n")
    print("§5 categorical: rank stability across >=3 development sub-windows;")
    print("the winner must not depend on one window.\n")

    _, bars = raw(CANDIDATE)
    per_window = [{} for _ in range(3)]
    res = {}
    for anchor, desc in list(H3_ANCHORS.items()) + [("week", "NOT sanctioned")]:
        s_a = run(replace(CANDIDATE, po3_period=anchor), label=f"po3={anchor}")
        log_a, _ = raw(replace(CANDIDATE, po3_period=anchor))
        wins = _by_subwindow(log_a, bars)
        means = [sum(w) / len(w) if w else 0.0 for w in wins]
        if anchor != "week":
            for k, m in enumerate(means):
                per_window[k][anchor] = m
        print(f"  {anchor:<9} {desc:<28} n={s_a['n']:>5}  "
              f"mean {s_a['mean_r']:+.4f}R  "
              f"CI [{s_a['headline_ci'][0]:+.4f},{s_a['headline_ci'][1]:+.4f}]  "
              f"freq {s_a['freq_per_trade_day']:.2f}/day")
        print(f"  {'':<9} sub-windows {['%+.4f' % m for m in means]}")
        res[anchor] = {"desc": desc, "summary": s_a, "subwindows": means}

    opts = list(H3_ANCHORS)
    best = max(opts, key=lambda a: res[a]["summary"]["mean_r"])
    ok, detail = PL.categorical(opts, per_window, best)
    print(f"\n  best sanctioned anchor: {best} ({H3_ANCHORS[best]})")
    print(f"  §5 categorical: {'PASS' if ok else 'FAIL'} - {detail}")
    sig = [a for a in opts if res[a]["summary"]["significant"]]
    print(f"  anchors with an interval excluding zero: {sig or 'NONE'}")
    save("h3_anchors", {"results": res, "best": best,
                        "categorical_ok": ok, "categorical_detail": detail,
                        "significant": sig})


# ── H4: displacement ──────────────────────────────────────────────────────
def _buckets(rows, key, k=5):
    """Equal-count buckets on one feature. Returns (edges, [(lo,hi,n,mean)])."""
    vals = sorted(x[key] for x in rows if x.get(key) is not None)
    if len(vals) < k * 20:
        return None, []
    edges = [vals[len(vals) * i // k] for i in range(1, k)]
    out = [[] for _ in range(k)]
    for x in rows:
        if x.get(key) is None:
            continue
        b = sum(1 for e in edges if x[key] >= e)
        out[b].append(x["r"])
    spans = [vals[0]] + edges + [vals[-1]]
    return edges, [(spans[i], spans[i + 1], len(out[i]),
                    sum(out[i]) / len(out[i]) if out[i] else 0.0)
                   for i in range(k)]


def h4():
    print("H4 - displacement, continuous before binary\n")
    print("§10 requires displacement tested both as a binary permission filter")
    print("and as a continuous contribution, with marginal value assessed AFTER")
    print("controlling for sweep quality.\n")
    print("The continuous test runs first on purpose: if displacement carries no")
    print("gradient across trades the model already takes, a binary filter that")
    print("merely removes some of them cannot manufacture one.\n")

    log, bars = raw(CANDIDATE)
    res = {}
    for feat, desc in (("range_atr", "reclaim bar range / ATR"),
                       ("reclaim_atr", "distance reclaimed past the level / ATR")):
        print(f"── {feat}  ({desc})")
        _, bs = _buckets(log, feat)
        for lo, hi, n, m in bs:
            print(f"   [{lo:6.2f},{hi:6.2f})  n={n:>5}  mean {m:+.4f}R")
        if bs:
            grad = bs[-1][3] - bs[0][3]
            print(f"   top-minus-bottom quintile: {grad:+.4f}R\n")
            res[feat] = {"buckets": bs, "gradient": grad}

    # control for sweep quality: displacement within each depth tercile
    print("── displacement gradient WITHIN sweep-quality terciles")
    print("   (controls for depth_atr, so the gradient is not just deeper sweeps)")
    depths = sorted(x["depth_atr"] for x in log)
    d1, d2 = depths[len(depths) // 3], depths[2 * len(depths) // 3]
    res["controlled"] = {}
    for name, lo, hi in (("shallow", -1e9, d1), ("mid", d1, d2), ("deep", d2, 1e9)):
        sub = [x for x in log if lo <= x["depth_atr"] < hi]
        _, bs = _buckets(sub, "range_atr", k=3)
        if not bs:
            continue
        grad = bs[-1][3] - bs[0][3]
        cells = "  ".join(f"{m:+.4f}({n})" for _, _, n, m in bs)
        print(f"   depth {name:<8} n={len(sub):>5}  low->high displacement: "
              f"{cells}   gradient {grad:+.4f}R")
        res["controlled"][name] = {"n": len(sub), "buckets": bs, "gradient": grad}

    print("\n── binary permission filter")
    print("   Applied as min_range_atr on the reclaim bar.")
    rows = sweep("h4", "min_range_atr", [0.0, 0.5, 0.75, 1.0, 1.25, 1.5], unit="atr")
    res["binary"] = rows
    save("h4_displacement", res)


CMDS = {"baseline": baseline, "h1": h1, "h2": h2, "h3": h3, "h4": h4, "h5": h5}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        sys.exit(f"usage: run_h1_h6.py [{'|'.join(CMDS)}]")
    CMDS[sys.argv[1]]()
