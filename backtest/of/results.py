"""Definitive results table. Everything reported in the README comes from here.

Run: python3 backtest/of/results.py
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, "backtest/of")
import features as F        # noqa: E402
import strategies as S      # noqa: E402
from engine import Config, run  # noqa: E402
from explore import split   # noqa: E402
from explore3 import sessions  # noqa: E402
from overnight import build, POINT_VALUE, COST_POINTS  # noqa: E402

HOLD = {"5min": 24, "15min": 12, "30min": 8, "60min": 6}


def random_baseline(bars, n_iter=30, seed=11):
    """What the engine returns for signals with zero information."""
    rng = np.random.default_rng(seed)
    pfs = []
    for _ in range(n_iter):
        s = pd.Series(rng.choice([0, 1, -1], size=len(bars), p=[0.94, 0.03, 0.03]),
                      index=bars.index, dtype=float)
        r = run(bars, s, Config(stop_atr=1.0, target_atr=2.0,
                                max_hold=HOLD["60min"], cost_points=COST_POINTS))
        if r.n > 20:
            pfs.append(r.summary()["profit_factor"])
    a = np.array(pfs)
    return a.mean(), a.std()


def main():
    m1 = pd.read_parquet("/workspace/data/prepared/nas100_m1.parquet")
    vix = pd.read_parquet("/workspace/data/prepared/vix_daily.parquet")

    print("#" * 100)
    print("# 1. INTRADAY ORDER-FLOW STRATEGIES vs RANDOM BASELINE")
    print("#   stop 1.0 ATR / target 2.0 ATR, cost 0.75 MNQ pts round trip")
    print("#" * 100)

    rows = []
    for tf in ["5min", "15min", "60min"]:
        f = F.assemble(m1, vix, tf=tf)
        parts = dict(zip(["train", "val", "TEST"], split(f)))
        base = random_baseline(parts["train"].reset_index(drop=True)) if tf == "60min" else None
        for name in ["vwap_reversion", "vwap_reversion_flow", "sweep_fade",
                     "sweep_fade_flow", "momentum_flow", "regime_adaptive"]:
            rec = {"tf": tf, "strategy": name}
            for pname, part in parts.items():
                part = part.reset_index(drop=True)
                res = run(part, S.REGISTRY[name](part),
                          Config(stop_atr=1.0, target_atr=2.0,
                                 max_hold=HOLD[tf], cost_points=COST_POINTS))
                s = res.summary()
                rec[f"{pname}_PF"] = s.get("profit_factor", np.nan)
                rec[f"{pname}_n"] = s.get("trades", 0)
                rec[f"{pname}_WR"] = s.get("win_rate", np.nan)
            rows.append(rec)
        if base:
            print(f"\n  random-signal baseline on 60min train: "
                  f"PF {base[0]:.3f} +/- {base[1]:.3f}")

    df = pd.DataFrame(rows)
    pd.set_option("display.width", 220)
    print()
    print(df.round(3).to_string(index=False))

    print("\n" + "#" * 100)
    print("# 2. OVERNIGHT vs INTRADAY DECOMPOSITION (bp/day)")
    print("#" * 100)
    day = sessions(m1)
    day["dt"] = pd.to_datetime(day["date"])
    for label, lo, hi in [("train 2005-2014", None, "2015-01-01"),
                          ("val   2015-2017", "2015-01-01", "2018-01-01"),
                          ("TEST  2018-2020", "2018-01-01", None)]:
        s = day
        if lo:
            s = s[s["dt"] >= lo]
        if hi:
            s = s[s["dt"] < hi]
        for col in ["overnight", "intraday"]:
            x = s[col].dropna()
            t = x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))
            print(f"  {label}  {col:<10} {x.mean():+7.2f} bp/day  "
                  f"t={t:+6.2f}  n={len(x):>5,}")

    print("\n" + "#" * 100)
    print("# 3. OVERNIGHT STRATEGY, 1 MNQ CONTRACT, $1.50 round-trip cost")
    print("#" * 100)
    d = build(m1, vix)
    for label, lo, hi in [("train 2005-2014", None, "2015-01-01"),
                          ("val   2015-2017", "2015-01-01", "2018-01-01"),
                          ("TEST  2018-2020", "2018-01-01", None)]:
        s = d
        if lo:
            s = s[s["dt"] >= lo]
        if hi:
            s = s[s["dt"] < hi]
        pts = s["on_points"] - COST_POINTS
        usd = pts * POINT_VALUE
        pf = pts[pts > 0].sum() / -pts[pts < 0].sum()
        t = pts.mean() / (pts.std(ddof=1) / np.sqrt(len(pts)))
        eq = usd.cumsum()
        print(f"  {label}  n={len(s):>5,}  WR={(pts>0).mean()*100:5.1f}%  "
              f"PF={pf:5.3f}  t={t:+5.2f}  net=${usd.sum():>8,.0f}  "
              f"maxDD=${(eq.cummax()-eq).max():>8,.0f}")


if __name__ == "__main__":
    main()
