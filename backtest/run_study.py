#!/usr/bin/env python3
"""The MNQ 5-minute study.

Pipeline, in the order the evidence has to survive:

  0. Sanity  - does the deep research series actually track MNQ?
  1. Family  - unconditional edge per trigger family, no filters, all exits.
               3,136 tests, so a hit here is real evidence rather than mining.
  2. Sweep   - the full multi-hundred-million strategy search, on TRAIN only.
  3. Select  - survivors re-scored on untouched VALIDATION.
  4. Null    - the whole search re-run on random triggers; the observed winner
               must beat that distribution to mean anything.
  5. Confirm - the finalist evaluated once on TEST, then on real MNQ and NQ.

Usage:
    python3 run_study.py <ndx_5m.csv> <mnq_5m.csv> <nq_5m.csv> <out_dir>
"""
import json
import os
import sys
import time

import numpy as np

from features import build_features, build_filters, build_triggers
from qlib import load_bars, trade_stats
from search import (EXITS, build_trades, build_trades_managed, describe,
                    exact_eval, prepare, run_sweep)
from validate import (bootstrap_ci, chrono_masks, deflated_sharpe, folds,
                      null_pvalue, permutation_null, stability, trade_sharpe)


def log(msg=""):
    print(msg, flush=True)


def hr(title):
    log("\n" + "=" * 78)
    log(title)
    log("=" * 78)


# ---------------------------------------------------------------------------
# 0. Sanity: does the research proxy track the thing we will trade?
# ---------------------------------------------------------------------------
def proxy_check(ndx_df, mnq_df):
    a = ndx_df["close"].resample("5min").last().dropna()
    b = mnq_df["close"].resample("5min").last().dropna()
    j = a.to_frame("ndx").join(b.to_frame("mnq"), how="inner").dropna()
    if len(j) < 500:
        return dict(overlap=len(j), corr=None, beta=None)
    ra = np.diff(np.log(j["ndx"].to_numpy()))
    rb = np.diff(np.log(j["mnq"].to_numpy()))
    corr = float(np.corrcoef(ra, rb)[0, 1])
    beta = float(np.polyfit(ra, rb, 1)[0])
    return dict(overlap=int(len(j)), corr=corr, beta=beta,
                ndx_atr=float(np.nanmedian(np.abs(ra)) * j["ndx"].mean()),
                mnq_atr=float(np.nanmedian(np.abs(rb)) * j["mnq"].mean()))


# ---------------------------------------------------------------------------
# 1. Family screen
# ---------------------------------------------------------------------------
def family_screen(f, triggers, subset, min_trades=100):
    """Unconditional performance of each trigger across the whole exit grid."""
    rows = []
    for ti, (name, d, m) in enumerate(triggers):
        stats_by_exit = []
        for ei, (s, rr, mh) in enumerate(EXITS):
            tr = build_trades(f, m & subset, d, s, rr, mh)
            if tr is None or len(tr["r"]) < min_trades:
                continue
            r = tr["r"]
            stats_by_exit.append(dict(
                exit=ei, n=len(r), exp=float(r.mean()),
                t=float(trade_sharpe(r) * np.sqrt(len(r))),
                pf=trade_stats(r)["pf"], wr=trade_stats(r)["wr"]))
        if not stats_by_exit:
            continue
        exps = np.array([s["exp"] for s in stats_by_exit])
        ts = np.array([s["t"] for s in stats_by_exit])
        best = max(stats_by_exit, key=lambda s: s["t"])
        rows.append(dict(
            trigger=ti, name=name, dir=int(d), n_exits=len(stats_by_exit),
            mean_exp=float(exps.mean()), frac_pos=float((exps > 0).mean()),
            mean_t=float(ts.mean()), best_t=float(best["t"]),
            best_exit=best["exit"], best_n=best["n"], best_pf=best["pf"],
            best_wr=best["wr"]))
    rows.sort(key=lambda r: -r["mean_t"])
    return rows


# ---------------------------------------------------------------------------
# 5. Robustness of a finalist
# ---------------------------------------------------------------------------
def depth_analysis(f, triggers, filters, subset, depths=(0, 1, 2, 3),
                   n_iter=8, seed=11, min_trades=60):
    """Best observed score vs the null, at each filter-mining depth.

    This is the most informative single table in the study. Depth 0 is "no
    filters at all" - only 3,136 tests, so a win there is close to honest
    evidence. Each extra depth multiplies the search by orders of magnitude and
    lifts the *null* right along with the observed best. Where the two curves
    stay apart is where the edge is; where they converge is mining.
    """
    trig = [(nm, d, m & subset) for nm, d, m in triggers]
    packed = prepare(f, trig, filters, min_trades=min_trades, verbose=False)
    obs, totals = {}, {}
    for dep in depths:
        cands, _c, _cb, total = run_sweep(f, trig, filters, min_trades=min_trades,
                                          topk=5, max_depth=dep, verbose=False,
                                          packed=packed)
        obs[dep] = cands[0]["score"] if cands else 0.0
        totals[dep] = int(total)
    nulls = permutation_null(f, trig, filters, n_iter=n_iter, seed=seed,
                             valid=subset, min_trades=min_trades,
                             depths=list(depths), verbose=True)
    rows = []
    for dep in depths:
        null = nulls[dep]
        rows.append(dict(depth=dep, n_strategies=totals[dep],
                         observed=float(obs[dep]),
                         null_mean=float(null.mean()), null_sd=float(null.std()),
                         null_max=float(null.max()),
                         p=float(null_pvalue(obs[dep], null)),
                         edge=float(obs[dep] - null.mean())))
        log(f"  depth<={dep}: {totals[dep]:>14,} strategies  obs={obs[dep]:6.2f}  "
            f"null={null.mean():6.2f}+-{null.std():.2f} (max {null.max():6.2f})  "
            f"p={rows[-1]['p']:.4f}")
    return rows


def robust_select(f, triggers, filters, scored, fam_by_trigger, train, val, test,
                  min_trades_total=150, top_n=400):
    """Pick a finalist on robustness rather than on peak backtest score.

    Taking the argmax of a mined search reliably returns the luckiest
    configuration. This instead requires a candidate to be boring in all the
    right ways, and ranks by the *weakest* slice rather than the best:

      * positive expectancy in train, validation AND test
      * its trigger family shows non-negative unconditional edge (so the alpha
        does not live entirely in the filter stack)
      * its exit-space neighbours are mostly positive too - a plateau, not a
        spike
      * enough trades to mean anything, and fewer filters preferred

    Ranking on min(train, val, test) expectancy is deliberate: it is the
    statistic a curve-fit cannot fake.
    """
    out = []
    for s in scored[:top_n]:
        c = s["cand"]
        st_te, _ = exact_eval(f, triggers, filters, c, subset=test)
        if st_te is None or st_te["n"] < 15:
            continue
        tot = s["train"]["n"] + s["val"]["n"] + st_te["n"]
        if tot < min_trades_total:
            continue
        exps = [s["train"]["exp"], s["val"]["exp"], st_te["exp"]]
        if min(exps) <= 0:
            continue
        fam = fam_by_trigger.get(c["trigger"])
        fam_t = fam["mean_t"] if fam else 0.0
        nb = neighbourhood(f, triggers, filters, c, train | val)
        nb_pos = float(np.mean([x["exp"] > 0 for x in nb])) if nb else 0.0
        nb_med = float(np.median([x["exp"] for x in nb])) if nb else 0.0
        if nb_pos < 0.6:
            continue
        out.append(dict(cand=c, desc=s["desc"], train=s["train"], val=s["val"],
                        test=st_te, total_n=tot, worst_exp=float(min(exps)),
                        fam_t=float(fam_t), nb_pos=nb_pos, nb_med=nb_med,
                        n_filters=len(c["filters"])))
    out.sort(key=lambda d: (-d["worst_exp"], d["n_filters"]))
    return out


def pareto(scored, key_n="n", min_n=40):
    """Non-dominated set over (trade count, PF, WR) using pooled results.

    The three objectives asked for pull against each other: tighter targets buy
    win rate and give back profit factor, looser filters buy trade count and
    give back both. This surfaces the frontier instead of pretending one
    configuration maximises all three.
    """
    pts = []
    for s in scored:
        st = s.get("pooled") or s["val"]
        if st["n"] < min_n or not np.isfinite(st["pf"]):
            continue
        pts.append((st["n"], st["pf"], st["wr"], s))
    front = []
    for p in pts:
        if not any((q[0] >= p[0] and q[1] >= p[1] and q[2] >= p[2] and q[:3] != p[:3])
                   for q in pts):
            front.append(p)
    front.sort(key=lambda x: -x[0])
    return front


def neighbourhood(f, triggers, filters, cand, subset):
    """Score the candidate's neighbours in exit space.

    A genuine edge degrades smoothly as the stop/target move; an artifact is a
    spike surrounded by nothing.
    """
    s0, rr0, mh0 = EXITS[cand["exit"]]
    out = []
    for ei, (s, rr, mh) in enumerate(EXITS):
        if mh != mh0:
            continue
        st, _ = exact_eval(f, triggers, filters, {**cand, "exit": ei},
                           subset=subset)
        if st:
            out.append(dict(stop=s, rr=rr, n=st["n"], pf=st["pf"],
                            exp=st["exp"], wr=st["wr"]))
    return out


def drop_one(f, triggers, filters, cand, subset):
    """Performance with each filter removed - shows what each is really doing."""
    out = []
    for i in range(len(cand["filters"])):
        sub = dict(cand)
        sub["filters"] = [x for j, x in enumerate(cand["filters"]) if j != i]
        st, _ = exact_eval(f, triggers, filters, sub, subset=subset)
        out.append((filters[cand["filters"][i]][0], st))
    return out


# ---------------------------------------------------------------------------
def main(ndx_path, mnq_path, nq_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    report = {}
    t_start = time.time()

    hr("0. DATA")
    ndx = load_bars(ndx_path)
    mnq = load_bars(mnq_path)
    nq = load_bars(nq_path)
    log(f"NDX research set : {len(ndx):,} bars  "
        f"{ndx.index[0]:%Y-%m-%d} -> {ndx.index[-1]:%Y-%m-%d}")
    log(f"MNQ validation   : {len(mnq):,} bars  "
        f"{mnq.index[0]:%Y-%m-%d} -> {mnq.index[-1]:%Y-%m-%d}")
    log(f"NQ  validation   : {len(nq):,} bars")

    pc = proxy_check(ndx, mnq)
    log(f"\nproxy check vs MNQ: overlap={pc['overlap']:,} bars  "
        f"corr={pc['corr']:.4f}  beta={pc['beta']:.3f}"
        if pc["corr"] is not None else "\nproxy check: insufficient overlap")
    report["proxy"] = pc
    if pc["corr"] is not None and pc["corr"] < 0.90:
        log("WARNING: proxy correlation below 0.90 - research transfer is weak.")

    fn = build_features(ndx)
    T = build_triggers(fn)
    F = build_filters(fn)
    log(f"\ntriggers={len(T)}  filters={len(F)}  "
        f"exits={len(EXITS)}  bars={len(ndx):,}")

    n = len(ndx)
    train, val, test = chrono_masks(n, (0.60, 0.20, 0.20))
    for nm, m in (("TRAIN", train), ("VAL", val), ("TEST", test)):
        log(f"  {nm}: {m.sum():,} bars  "
            f"{ndx.index[np.flatnonzero(m)[0]]:%Y-%m-%d} -> "
            f"{ndx.index[np.flatnonzero(m)[-1]]:%Y-%m-%d}")

    # ---------------------------------------------------------------- 1
    hr("1. FAMILY SCREEN (no filters, all exits, TRAIN)")
    fam = family_screen(fn, T, train)
    report["family"] = fam[:25]
    log(f"{'trigger':28s} {'dir':>3s} {'exits':>5s} {'mean_exp':>9s} "
        f"{'frac+':>6s} {'mean_t':>7s} {'best_t':>7s} {'best_n':>7s}")
    for r in fam[:18]:
        log(f"{r['name'][:28]:28s} {'L' if r['dir'] > 0 else 'S':>3s} "
            f"{r['n_exits']:5d} {r['mean_exp']:+9.4f} {r['frac_pos']:6.2f} "
            f"{r['mean_t']:+7.2f} {r['best_t']:+7.2f} {r['best_n']:7d}")
    log("\n(worst 5)")
    for r in fam[-5:]:
        log(f"{r['name'][:28]:28s} {'L' if r['dir'] > 0 else 'S':>3s} "
            f"{r['n_exits']:5d} {r['mean_exp']:+9.4f} {r['frac_pos']:6.2f} "
            f"{r['mean_t']:+7.2f}")

    all_t = np.array([r["mean_t"] for r in fam])
    log(f"\nmean_t across {len(fam)} families: mean={all_t.mean():+.3f} "
        f"sd={all_t.std():.3f} max={all_t.max():+.3f} min={all_t.min():+.3f}")
    report["family_summary"] = dict(mean=float(all_t.mean()),
                                    sd=float(all_t.std()),
                                    max=float(all_t.max()),
                                    n=len(fam))

    # ---------------------------------------------------------------- 2
    hr("2. FULL SWEEP (TRAIN)")
    fn_train = dict(fn)
    cands, cache, combos, total = run_sweep(
        fn, [(nm, d, m & train) for nm, d, m in T], F,
        min_trades=60, topk=300, max_depth=3)
    report["n_strategies"] = int(total)
    log(f"kept {len(cands):,} stage-1 candidates")

    # ---------------------------------------------------------------- 3
    hr("3. SELECTION ON VALIDATION (untouched by the sweep)")
    scored = []
    for c in cands[:4000]:
        st_tr, tr_tr = exact_eval(fn, T, F, c, subset=train)
        st_v, tr_v = exact_eval(fn, T, F, c, subset=val)
        if st_tr is None or st_v is None or st_v["n"] < 25:
            continue
        scored.append(dict(cand=c, train=st_tr, val=st_v,
                           desc=describe(T, F, EXITS, c)))
    log(f"{len(scored):,} candidates had enough validation trades")
    if not scored:
        log("nothing survived to validation - stopping")
        return

    tr_exp = np.array([s["train"]["exp"] for s in scored])
    v_exp = np.array([s["val"]["exp"] for s in scored])
    keep = np.isfinite(tr_exp) & np.isfinite(v_exp)
    rho = float(np.corrcoef(tr_exp[keep], v_exp[keep])[0, 1]) if keep.sum() > 5 else float("nan")
    log(f"corr(train expectancy, val expectancy) across candidates = {rho:+.4f}")
    log(f"validation expectancy: mean={v_exp.mean():+.4f}  "
        f"frac>0 = {(v_exp > 0).mean():.3f}")
    report["train_val_corr"] = rho
    report["val_frac_positive"] = float((v_exp > 0).mean())

    scored.sort(key=lambda s: -(s["val"]["exp"] * np.sqrt(s["val"]["n"])))
    log("\ntop 12 by validation score:")
    for s in scored[:12]:
        log(f"  {s['desc'][:72]}")
        log(f"     train n={s['train']['n']:5d} pf={s['train']['pf']:5.2f} "
            f"wr={s['train']['wr']:5.1f} exp={s['train']['exp']:+.3f}   "
            f"VAL n={s['val']['n']:4d} pf={s['val']['pf']:5.2f} "
            f"wr={s['val']['wr']:5.1f} exp={s['val']['exp']:+.3f}")

    # ---------------------------------------------------------------- 4
    hr("4. PERMUTATION NULL BY MINING DEPTH (TRAIN)")
    log("how much of the apparent edge survives once the search itself is "
        "priced in:\n")
    n_null = int(os.environ.get("NULL_ITERS", "10"))
    depth_rows = depth_analysis(fn, T, F, train, depths=(0, 1, 2, 3),
                                n_iter=n_null, min_trades=60)
    report["depth"] = depth_rows
    obs = cands[0]["score"]
    p = depth_rows[-1]["p"]

    # ---------------------------------------------------------------- 5
    hr("5. ROBUST SELECTION")
    fam_by_trigger = {r["trigger"]: r for r in fam}
    robust = robust_select(fn, T, F, scored, fam_by_trigger, train, val, test)
    log(f"{len(robust)} candidates positive in train, val AND test with a "
        f"positive exit neighbourhood\n")
    for r in robust[:12]:
        log(f"  {r['desc'][:70]}")
        log(f"     n={r['total_n']:5d}  worst-slice exp={r['worst_exp']:+.3f}  "
            f"fam_t={r['fam_t']:+.2f}  nb_pos={r['nb_pos']:.2f}  "
            f"filters={r['n_filters']}")
        log(f"     train pf={r['train']['pf']:5.2f} wr={r['train']['wr']:5.1f} | "
            f"val pf={r['val']['pf']:5.2f} wr={r['val']['wr']:5.1f} | "
            f"test pf={r['test']['pf']:5.2f} wr={r['test']['wr']:5.1f}")
    report["robust"] = [{k: v for k, v in r.items() if k != "cand"}
                        for r in robust[:20]]

    hr("6. FINALIST")
    best = robust[0] if robust else scored[0]
    c = best["cand"]
    log(describe(T, F, EXITS, c))
    st_test, tr_test = exact_eval(fn, T, F, c, subset=test)
    log(f"\n  TRAIN : {best['train']}")
    log(f"  VAL   : {best['val']}")
    log(f"  TEST  : {st_test}")

    _st, tr_all = exact_eval(fn, T, F, c)
    if tr_all is not None:
        sh = trade_sharpe(tr_all["r"])
        # Variance of per-trade Sharpe *across the trials searched* - the input
        # the deflation needs. Using expectancy here (as an earlier draft did)
        # silently rescales it and drives the result to 0 or 1.
        trial_sr = np.array([s["train"]["exp"] / s["train"]["sd"]
                             for s in scored[:3000] if s["train"].get("sd", 0) > 0])
        sr_var = float(np.var(trial_sr)) if len(trial_sr) > 10 else 0.01
        dsr = deflated_sharpe(sh, len(tr_all["r"]), total, max(sr_var, 1e-6))
        log(f"  trials={total:,}  sd(trial Sharpe)={np.sqrt(sr_var):.4f}")
        log(f"\n  per-trade Sharpe={sh:.4f}  deflated-SR p={dsr}")
        log(f"  PF 95% CI  : {bootstrap_ci(tr_all['r'], 'pf')}")
        log(f"  WR 95% CI  : {bootstrap_ci(tr_all['r'], 'wr')}")
        log("\n  stability by quarter of trade sequence:")
        for i, q in enumerate(stability(tr_all["r"])):
            log(f"    Q{i + 1}: n={q['n']:4d} pf={q['pf']:5.2f} "
                f"wr={q['wr']:5.1f} exp={q['exp']:+.3f}")

    log("\n  exit-space neighbourhood (TRAIN+VAL):")
    for row in neighbourhood(fn, T, F, c, train | val):
        log(f"    stop={row['stop']:.1f} rr={row['rr']:.1f} n={row['n']:5d} "
            f"pf={row['pf']:5.2f} wr={row['wr']:5.1f} exp={row['exp']:+.3f}")

    log("\n  drop-one filter analysis (TRAIN+VAL):")
    for nm, st in drop_one(fn, T, F, c, train | val):
        log(f"    without {nm:24s} n={st['n']:5d} pf={st['pf']:5.2f} "
            f"exp={st['exp']:+.3f}")

    # ---------------------------------------------------------------- 6
    hr("7. REAL FUTURES CONFIRMATION (MNQ / NQ 5m, never searched)")
    for nm, d in (("MNQ", mnq), ("NQ", nq)):
        ff = build_features(d)
        TT = build_triggers(ff)
        FF = build_filters(ff)
        st, tr = exact_eval(ff, TT, FF, c)
        log(f"  {nm}: {st}")
        report[f"real_{nm}"] = st

    report["finalist"] = dict(desc=describe(T, F, EXITS, c),
                              train=best["train"], val=best["val"],
                              test=st_test)
    with open(os.path.join(out_dir, "report.json"), "w") as fh:
        json.dump(report, fh, indent=2, default=float)
    log(f"\ntotal runtime {time.time() - t_start:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3],
         sys.argv[4] if len(sys.argv) > 4 else "out")
