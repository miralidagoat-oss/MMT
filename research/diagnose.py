#!/usr/bin/env python3
"""Final diagnostics on the walk-forward OOS ledger: is +0.043R real, and is
it big enough to survive its own transaction costs?"""
import numpy as np

import core, engine, orb, validate
from core import POINT_VALUE, TICK
from edge_search import build_panel, features


def main():
    m1 = core.load_1m()
    P = build_panel(m1)
    F, scale = features(P)
    grid = orb.default_grid()
    led, picks = orb.wf_orb(P, scale, grid, n_folds=8)
    r = led["r_net"]
    s = engine.stats(led)
    print(engine.fmt(s, "OOS (walk-forward)"))
    print(engine.fmt(engine.stats(led, "r_gross"), "OOS gross (no costs)"))

    # ---- cost sensitivity: the edge vs the friction that pays for it -------
    print("\n== cost sensitivity ==")
    avg_risk = led["risk"].mean()
    print(f"average risk per trade: {avg_risk:.1f} index points "
          f"(= ${avg_risk*POINT_VALUE:,.0f} on MNQ, ${avg_risk*POINT_VALUE*10:,.0f} on NQ)")
    for label, comm_usd, slip_t, pv in (
            ("MNQ, modelled (base)", 1.20, 1.0, 2.0),
            ("MNQ, 2-tick slippage", 1.20, 2.0, 2.0),
            ("MNQ, cheap broker", 0.80, 1.0, 2.0),
            ("NQ  (10x contract)", 4.20, 1.0, 20.0)):
        cost_pts = comm_usd / pv + 2 * slip_t * TICK
        # re-express: gross R minus this cost in R
        exp = float((led["r_gross"] - cost_pts / led["risk"]).mean())
        print(f"  {label:<24} cost={cost_pts:>5.2f}pt = {cost_pts/avg_risk:>5.3f}R"
              f"   ->  exp {exp:>+6.3f}R/trade")

    # ---- significance -----------------------------------------------------
    print("\n== significance ==")
    n_trials = len(grid) * 8
    sr, sr0, psr = validate.deflated_sharpe(r, n_trials)
    print(f"per-trade Sharpe {sr:.4f} | null threshold from {n_trials} searched "
          f"configs {sr0:.4f} | deflated PSR {psr:.3f}")
    print(f"  {'PASSES' if psr > 0.95 else 'FAILS'} the 0.95 bar for "
          f"'better than the best of {n_trials} coin flips'")
    b = validate.bootstrap(r)
    print(f"block bootstrap: exp {b['exp_mean']:+.3f}R "
          f"[5%..95%: {b['exp_p05']:+.3f} .. {b['exp_p95']:+.3f}]  "
          f"P(profitable)={b['p_profitable']:.3f}")
    print(f"  drawdown: median {b['dd_med']:.1f}R, 95th pct {b['dd_p95']:.1f}R")
    t = r.mean() / (r.std(ddof=1) / np.sqrt(len(r)))
    print(f"t-stat on {len(r)} OOS trades: {t:+.2f}")

    # ---- per-year OOS -----------------------------------------------------
    print("\n== OOS by year (1 contract, 1R risk normalised) ==")
    yr = led["t_exit"].astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    print(f"{'year':>6} {'n':>5} {'net R':>8} {'WR%':>6} {'PF':>6}")
    tot = 0
    for y in np.unique(yr):
        sel = led[yr == y]
        st = engine.stats(sel)
        tot += st["net_r"]
        print(f"{y:>6} {st['n']:>5} {st['net_r']:>+8.1f} {st['wr']:>6.1f} {st['pf']:>6.2f}")

    # ---- what the same money does buying and holding ----------------------
    print("\n== benchmark ==")
    C = P["C"]
    bh = (C[:, 385] - P["O"][:, 0]) - 1.20 / POINT_VALUE
    ok = np.isfinite(bh)
    print(f"long every session 09:30->15:55: {np.nansum(bh[ok]):+,.0f} pts over "
          f"{ok.sum()} days  (${np.nansum(bh[ok])*POINT_VALUE:+,.0f} on 1 MNQ)")
    print(f"ORB OOS total: {s['net_r']:+.1f}R  (${s['usd']:+,.0f} on 1 MNQ, "
          f"unsized)")


if __name__ == "__main__":
    main()
