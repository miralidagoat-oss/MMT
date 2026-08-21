#!/usr/bin/env python3
"""Put MMT-N through the same gauntlet that killed everything else."""
import numpy as np

import core, validate, overnight
from core import POINT_VALUE, TICK
from edge_search import build_panel, features
from overnight import NightCfg, evaluate, build, FLAT_M, COMMISSION_PTS, SLIP_PTS


def wf_trend(P, scale, lens=(50, 100, 150, 200, 250), vt=0.15):
    """Walk-forward the filter length: pick it on prior years only.

    The SMA200 headline was chosen after seeing all 12 years. This re-picks the
    lookback every year using only what was known then, which is the number an
    actual account would have earned.
    """
    yr = (P["days"] * 86400).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    years = np.unique(yr)
    nets = {L: evaluate(P, scale, NightCfg(trend_len=L, vol_target=vt))["net"]
            for L in lens}
    oos = np.full(len(P["C"]), np.nan)
    picks = []
    for Y in years:
        tr, te = yr < Y, yr == Y
        if tr.sum() < 500:
            continue
        best, bs = None, -1e18
        for L in lens:
            v = nets[L][tr & np.isfinite(nets[L])]
            if len(v) < 200:
                continue
            sc = v.mean() / max(v.std(ddof=1), 1e-9)
            if sc > bs:
                bs, best = sc, L
        if best is None:
            continue
        sel = te & np.isfinite(nets[best])
        oos[sel] = nets[best][sel]
        picks.append((int(Y), best))
    return oos, picks


def stats_of(v, label):
    v = v[np.isfinite(v)]
    w, l = v[v > 0], v[v < 0]
    pf = w.sum() / -l.sum() if len(l) and l.sum() < 0 else np.inf
    eq = np.cumsum(v)
    dd = float(np.max(np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]))
    t = v.mean() / (v.std(ddof=1) / np.sqrt(len(v)))
    sh = v.mean() / v.std(ddof=1) * np.sqrt(252)
    print(f"{label:<36} n={len(v):>5} WR={100*len(w)/len(v):>5.1f}% PF={pf:>5.2f} "
          f"net={v.sum():>+8,.0f}pt t={t:>+5.2f} SR={sh:>5.2f} DD={dd:>6,.0f}pt "
          f"${v.sum()*POINT_VALUE:>+9,.0f}")
    return v


def main():
    m1 = core.load_1m()
    P = build_panel(m1)
    F, scale = features(P)
    nd = len(P["C"])
    yrs = nd / 252.0

    print("== honest walk-forward: filter length chosen on prior years only ==")
    oos, picks = wf_trend(P, scale)
    print("  picks:", ", ".join(f"{y}:SMA{L}" for y, L in picks))
    v = stats_of(oos, "MMT-N walk-forward OOS")

    print("\n== fixed SMA200 (the headline) for comparison ==")
    fixed = evaluate(P, scale, NightCfg(trend_len=200, vol_target=0.15))
    stats_of(fixed["net"], "MMT-N fixed SMA200 + vt15")
    base = evaluate(P, scale, NightCfg(trend_len=0))
    stats_of(base["net"], "baseline: every night, 1 lot")

    print("\n== significance ==")
    n_trials = 8 * 5          # variants tried x filter lengths
    sr, sr0, psr = validate.deflated_sharpe(v, n_trials)
    print(f"per-night Sharpe {sr:.4f} | null threshold for {n_trials} configs "
          f"{sr0:.4f} | deflated PSR {psr:.3f}  -> "
          f"{'PASSES' if psr > 0.95 else 'FAILS'}")
    b = validate.bootstrap(v, block=5)
    print(f"block bootstrap: mean {b['exp_mean']:+.2f}pt/night "
          f"[5%..95%: {b['exp_p05']:+.2f} .. {b['exp_p95']:+.2f}]  "
          f"P(profitable)={b['p_profitable']:.3f}")
    print(f"  drawdown: median {b['dd_med']:,.0f}pt, 95th pct {b['dd_p95']:,.0f}pt "
          f"(${b['dd_p95']*POINT_VALUE:,.0f} on 1 MNQ)")

    print("\n== where the return sits ==")
    wd = (P["days"] + 3) % 7
    net = fixed["net"]
    for k, nm in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri(->Mon)"]):
        vv = net[(wd == k) & np.isfinite(net)]
        if len(vv) > 20:
            print(f"  night starting {nm:<11} n={len(vv):>4} "
                  f"mean={vv.mean():>+6.2f}pt  total={vv.sum():>+8,.0f}pt")

    print("\n== tail risk: the worst nights ==")
    worst = np.sort(net[np.isfinite(net)])[:8]
    print("  8 worst nights (pts, 1 unit): " + ", ".join(f"{x:,.0f}" for x in worst))
    print(f"  worst = ${worst[0]*POINT_VALUE:,.0f} on 1 MNQ, "
          f"${worst[0]*POINT_VALUE*10:,.0f} on 1 NQ")
    print("  MNQ trades overnight, so a protective stop is available -- but a")
    print("  gap through it on a geopolitical print is the real risk here.")

    print("\n== by year, walk-forward OOS ==")
    yr = (P["days"] * 86400).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    print(f"{'year':>6}{'nights':>8}{'WR%':>7}{'PF':>7}{'net pts':>10}{'$ 1 MNQ':>11}")
    for y in np.unique(yr):
        vv = oos[(yr == y) & np.isfinite(oos)]
        if len(vv) < 5:
            continue
        w, l = vv[vv > 0], vv[vv < 0]
        pf = w.sum() / -l.sum() if len(l) and l.sum() < 0 else np.inf
        print(f"{y:>6}{len(vv):>8}{100*len(w)/len(vv):>7.1f}{pf:>7.2f}"
              f"{vv.sum():>10,.0f}{vv.sum()*POINT_VALUE:>11,.0f}")


if __name__ == "__main__":
    main()
