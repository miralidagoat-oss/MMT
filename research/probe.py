#!/usr/bin/env python3
"""Edge probe: does a sweep+reclaim actually predict anything?

Tuning entries and exits on a setup that has no forward edge is how you fit
noise for a week and call it a strategy. This measures the raw conditional
distribution of forward excursion after a signal, with NO entry model, NO exit
model and NO cost model, against a matched baseline of every other bar in the
same session window. Everything is normalised by that bar's sigma so the
2015 tape and the 2025 tape are comparable.

If conditional MFE/MAE is not materially better than baseline, the setup is
dead and no exit scheme can revive it.
"""
import numpy as np

import core
import strategy
from strategy import Params, RTH_OPEN


def forward_stats(m1, src_end, idx, dirs, sig, horizon_min):
    """MFE/MAE/terminal over the next `horizon_min` 1m bars, in sigma units."""
    n1 = len(m1)
    out = np.zeros((len(idx), 3))
    for k, (b, d) in enumerate(zip(idx, dirs)):
        i0 = src_end[b] + 1
        i1 = min(i0 + horizon_min, n1)
        if i0 >= n1 or i1 <= i0:
            out[k] = np.nan
            continue
        ref = m1.c[i0 - 1]
        hi = m1.h[i0:i1].max(); lo = m1.l[i0:i1].min(); last = m1.c[i1 - 1]
        s = sig[b]
        if not np.isfinite(s) or s <= 0:
            out[k] = np.nan
            continue
        if d == 1:
            out[k] = ((hi - ref) / s, (lo - ref) / s, (last - ref) / s)
        else:
            out[k] = ((ref - lo) / s, (ref - hi) / s, (ref - last) / s)
    return out


def probe(m1, tf, horizon_min, p=None, lv=None):
    p = (p or Params()).copy(tf=tf)
    agg, src_end = core.resample(m1, tf, anchor_min=RTH_OPEN)
    sig, warm = core.ewma_sigma(agg.c, p.lam, p.seed_len)
    lv = lv if lv is not None else strategy.liquidity_levels(m1, p.or_minutes)
    i1, d, e, s, tpx, tag = strategy.signals(m1, p, lv=lv)

    # map order-live index back to aggregate bar index
    bidx = np.searchsorted(src_end, i1 - 1)
    fs = forward_stats(m1, src_end, bidx, d, sig, horizon_min)

    # baseline: every bar in the same session window, both directions pooled
    et_min, _, wd = agg.et
    base_mask = ((et_min >= p.start_min) & (et_min <= p.end_min) & (wd < 5)
                 & np.isfinite(sig) & (sig > 0))
    base_mask[:warm] = False
    bidx_all = np.flatnonzero(base_mask)
    if len(bidx_all) > 6000:
        bidx_all = bidx_all[:: max(1, len(bidx_all) // 6000)]
    bl_long = forward_stats(m1, src_end, bidx_all, np.ones(len(bidx_all), int), sig, horizon_min)
    bl_short = forward_stats(m1, src_end, bidx_all, -np.ones(len(bidx_all), int), sig, horizon_min)
    bl = np.vstack([bl_long, bl_short])
    return fs, bl, d


def summarise(fs, label):
    fs = fs[np.isfinite(fs).all(axis=1)]
    if len(fs) < 20:
        return f"{label:<34} n={len(fs)} (too few)"
    mfe, mae, term = fs[:, 0], fs[:, 1], fs[:, 2]
    ratio = mfe.mean() / max(-mae.mean(), 1e-9)
    return (f"{label:<34} n={len(fs):>5}  MFE={mfe.mean():>5.2f}σ  "
            f"MAE={mae.mean():>6.2f}σ  MFE/MAE={ratio:>4.2f}  "
            f"term={term.mean():>+6.3f}σ  P(term>0)={100*(term>0).mean():>4.1f}%")


if __name__ == "__main__":
    m1 = core.load_1m()
    lv = strategy.liquidity_levels(m1, 30)
    print("Forward excursion after sweep+reclaim vs matched baseline")
    print("(σ = one aggregate-bar EWMA sigma; horizon = 8 bars of that tf)\n")
    for tf in (5, 15, 30, 60):
        fs, bl, d = probe(m1, tf, horizon_min=tf * 8, lv=lv)
        print(summarise(fs, f"tf={tf}m  SIGNAL (fade)"))
        print(summarise(fs * np.array([[-1, -1, -1]]) if False else
                        np.c_[-bl[:, 1], -bl[:, 0], -bl[:, 2]][:0], ""), end="")
        print(summarise(bl, f"tf={tf}m  baseline"))
        # continuation view: same bars, opposite direction
        print(summarise(np.c_[-fs[:, 1], -fs[:, 0], -fs[:, 2]],
                        f"tf={tf}m  SIGNAL (continuation)"))
        print()
