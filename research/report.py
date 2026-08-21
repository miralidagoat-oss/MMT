#!/usr/bin/env python3
"""Regenerate the headline table: WR and PF by year for MMT-N, out-of-sample."""
import numpy as np

import core, validate
from core import POINT_VALUE
from edge_search import build_panel, features
from validate_night import wf_trend, stats_of


def main():
    m1 = core.load_1m()
    P = build_panel(m1)
    F, scale = features(P)
    oos, picks = wf_trend(P, scale)
    yr = (P["days"] * 86400).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970

    print("MMT-N — overnight, walk-forward out-of-sample, MNQ costs charged")
    print(f"filter length re-picked each year: "
          f"{', '.join(f'{y}:SMA{L}' for y, L in picks)}\n")
    print(f"{'year':>6}{'nights':>8}{'WR%':>8}{'PF':>8}{'net pts':>11}{'$ 1 MNQ':>11}")
    print("-" * 52)
    for y in np.unique(yr):
        v = oos[(yr == y) & np.isfinite(oos)]
        if len(v) < 5:
            continue
        w, l = v[v > 0], v[v < 0]
        pf = w.sum() / -l.sum() if len(l) and l.sum() < 0 else np.inf
        print(f"{y:>6}{len(v):>8}{100*len(w)/len(v):>8.1f}{pf:>8.2f}"
              f"{v.sum():>11,.0f}{v.sum()*POINT_VALUE:>11,.0f}")
    print("-" * 52)
    v = stats_of(oos, "ALL YEARS")
    sr, sr0, psr = validate.deflated_sharpe(v, 40)
    print(f"\ndeflated Sharpe: observed {sr:.4f} vs null {sr0:.4f} for a "
          f"40-config search -> PSR {psr:.3f}")
    b = validate.bootstrap(v, block=5)
    print(f"bootstrap: {b['exp_mean']:+.2f}pt/night "
          f"[{b['exp_p05']:+.2f} .. {b['exp_p95']:+.2f}], "
          f"P(profitable) {b['p_profitable']:.3f}, "
          f"95th-pct drawdown {b['dd_p95']:,.0f}pt "
          f"(${b['dd_p95']*POINT_VALUE:,.0f} on 1 MNQ)")


if __name__ == "__main__":
    main()
