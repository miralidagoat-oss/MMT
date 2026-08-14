"""Second-pass edge hunt: conditional setups, horizons, timeframes.

Pass 1 showed raw features carry <1bp of forward return -- below cost. So the
question is no longer "does feature X predict" but "is there a *configuration*
where the edge clears costs". Everything still train-only.

Cost reference: MNQ is $2/point. Round trip ~= 0.25pt spread + ~0.35pt
commission ~= 0.6-1.0 points. On NDX at 7000 that is roughly 1.0-1.4 bps.
An edge must clear ~1.5bp to be worth anything.
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, "backtest/of")
import features as F  # noqa: E402
from explore import TRAIN_END, split  # noqa: E402

COST_BPS = 1.4


def fwd(f, h):
    return np.log(f["close"].shift(-h) / f["close"]) * 1e4


def stat(x):
    x = x.dropna()
    if len(x) < 200:
        return None
    m, s = x.mean(), x.std(ddof=1)
    return m, m / (s / np.sqrt(len(x))), len(x), (x > 0).mean() * 100


def report(name, x, extra=""):
    r = stat(x)
    if r is None:
        print(f"    {name:<46} n too small")
        return None
    m, t, n, wr = r
    # net edge of trading the setup *as stated*. A negative gross edge is a
    # losing setup, not a hidden winner -- do not abs() it into looking good.
    net = m - COST_BPS
    flag = ""
    if abs(t) > 3 and net > 0.5:
        flag = "  *** TRADEABLE"
    elif abs(t) > 2.5:
        flag = "  *  signal"
    print(f"    {name:<46} {m:+6.2f}bp  t={t:+5.2f}  wr={wr:4.1f}%  "
          f"n={n:>6,}  net={net:+5.2f}{flag}{extra}")
    return m, t, n


def exhaustion_scan(f):
    """Exhaustion: price stretched from VWAP but order flow NOT confirming.

    The classic tape-reading setup. Price pushes to an extreme while cumulative
    delta fails to make a matching extreme -> the move is being sold into.
    """
    print(f"\n{'='*94}")
    print("EXHAUSTION SETUP: stretched from VWAP + order-flow divergence")
    print(f"{'='*94}")

    for h in (3, 6, 12, 24):
        y = fwd(f, h)
        print(f"\n  horizon {h} bars:")
        for zt in (1.5, 2.0, 2.5):
            up = f["vwap_z"] > zt
            dn = f["vwap_z"] < -zt
            # divergence: pushing up on negative delta (or down on positive)
            div_up = up & (f["imbalance"] < 0)
            div_dn = dn & (f["imbalance"] > 0)
            pnl = pd.concat([-y[div_up], y[div_dn]])
            report(f"|vwap_z|>{zt} + delta divergence", pnl)

            # plain stretch, for comparison
            plain = pd.concat([-y[up], y[dn]])
            report(f"|vwap_z|>{zt} (no flow filter)", plain)


def regime_conditioned(f):
    """Does the options-flow regime turn the setup on and off?"""
    print(f"\n{'='*94}")
    print("REGIME CONDITIONING of the exhaustion setup (horizon 12)")
    print(f"{'='*94}")
    y = fwd(f, 12)
    up = f["vwap_z"] > 2.0
    dn = f["vwap_z"] < -2.0
    base_up, base_dn = up & (f["imbalance"] < 0), dn & (f["imbalance"] > 0)

    for col, cuts in [("vix_close", [0, 13, 17, 22, 100]),
                      ("vrp_z", [-9, -0.5, 0.5, 9]),
                      ("rv_term", [0, 0.85, 1.15, 9]),
                      ("vr", [0, 0.9, 1.0, 9])]:
        print(f"\n  by {col}:")
        for lo, hi in zip(cuts[:-1], cuts[1:]):
            m = (f[col] >= lo) & (f[col] < hi)
            pnl = pd.concat([-y[base_up & m], y[base_dn & m]])
            report(f"{col} in [{lo},{hi})", pnl)


def sweep_scan(f):
    """Liquidity sweep + rejection, the setup the existing repo script trades."""
    print(f"\n{'='*94}")
    print("SWEEP / REJECTION setup")
    print(f"{'='*94}")
    for h in (6, 12, 24):
        y = fwd(f, h)
        print(f"\n  horizon {h}:")
        # fade the sweep
        pnl = pd.concat([-y[f["swept_hi"]], y[f["swept_lo"]]])
        report("sweep fade (all)", pnl)
        # with order-flow confirmation of the rejection
        cs = f["swept_hi"] & (f["imbalance"] < 0)
        cl = f["swept_lo"] & (f["imbalance"] > 0)
        report("sweep fade + delta confirms rejection", pd.concat([-y[cs], y[cl]]))
        # with volume
        hv = f["rel_vol"] > 1.5
        report("sweep fade + delta + high rel volume",
               pd.concat([-y[cs & hv], y[cl & hv]]))


def time_of_day(f):
    print(f"\n{'='*94}")
    print("TIME OF DAY: exhaustion setup edge by session block (horizon 12)")
    print(f"{'='*94}")
    y = fwd(f, 12)
    up = (f["vwap_z"] > 2.0) & (f["imbalance"] < 0)
    dn = (f["vwap_z"] < -2.0) & (f["imbalance"] > 0)
    for lo, hi, name in [(570, 600, "09:30-10:00"), (600, 660, "10:00-11:00"),
                         (660, 780, "11:00-13:00"), (780, 900, "13:00-15:00"),
                         (900, 960, "15:00-16:00")]:
        m = (f["tod"] >= lo) & (f["tod"] < hi)
        report(name, pd.concat([-y[up & m], y[dn & m]]))


def main():
    tf = sys.argv[1] if len(sys.argv) > 1 else "5min"
    m1 = pd.read_parquet("/workspace/data/prepared/nas100_m1.parquet")
    vix = pd.read_parquet("/workspace/data/prepared/vix_daily.parquet")
    f = F.assemble(m1, vix, tf=tf)
    tr, _, _ = split(f)
    tr = tr.reset_index(drop=True)
    print(f"timeframe {tf}   train bars {len(tr):,}   cost assumption {COST_BPS}bp")

    exhaustion_scan(tr)
    regime_conditioned(tr)
    sweep_scan(tr)
    time_of_day(tr)


if __name__ == "__main__":
    main()
