"""Validate the overnight / regime strategy across train, validation and test.

Pass 3 found the only real edge in 15y of NDX data: the index's entire drift
accrues overnight, and the effect is strongest in a middling VIX regime. This
script turns that into an executable rule and walks it forward.

Costs are charged in POINTS, not basis points, which matters a great deal here:
an MNQ tick is 0.25pt regardless of index level, so the same 0.75pt round trip
was 5bp of notional in 2005 (NDX 1500) and is under 0.4bp today (NDX 20000+).
A percentage cost model would badly misstate this strategy.
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, "backtest/of")
import features as F  # noqa: E402
from explore3 import sessions  # noqa: E402

POINT_VALUE = 2.0      # MNQ, $ per index point
COST_POINTS = 0.75     # round trip: ~1 tick spread + commission

SPLITS = {
    "train 2005-2014": (None, pd.Timestamp("2015-01-01").date()),
    "val   2015-2017": (pd.Timestamp("2015-01-01").date(), pd.Timestamp("2018-01-01").date()),
    "TEST  2018-2020": (pd.Timestamp("2018-01-01").date(), None),
}


def build(m1, vix):
    day = sessions(m1)
    v = vix.copy().sort_values("date")
    v["vix_prev"] = v["vix_close"].shift(1)          # lag: only prior close is known
    v["vix_z"] = ((v["vix_close"] - v["vix_close"].rolling(252).mean())
                  / v["vix_close"].rolling(252).std(ddof=0)).shift(1)
    d = day.merge(v[["date", "vix_prev", "vix_z"]], on="date", how="left")
    d["dt"] = pd.to_datetime(d["date"])
    d["dow"] = d["dt"].dt.dayofweek
    d["is_opex"] = d["dt"].dt.day.between(14, 20) & (d["dow"] == 4)
    # realised P&L in points for one MNQ contract held overnight
    d["on_points"] = d["rth_open"] - d["prev_close"]
    d["id_points"] = d["rth_close"] - d["rth_open"]
    return d.dropna(subset=["vix_prev"])


def evaluate(d, mask, points_col, name, cost=COST_POINTS, sign=1):
    x = d.loc[mask].copy()
    if len(x) < 20:
        print(f"  {name:<42} n too small ({len(x)})")
        return None
    pts = sign * x[points_col] - cost
    usd = pts * POINT_VALUE
    wins, losses = pts[pts > 0], pts[pts < 0]
    pf = wins.sum() / -losses.sum() if len(losses) and losses.sum() != 0 else np.inf
    eq = usd.cumsum()
    dd = (eq.cummax() - eq).max()
    yrs = max((x["dt"].max() - x["dt"].min()).days / 365.25, 1e-9)
    sharpe = pts.mean() / pts.std(ddof=1) * np.sqrt(len(pts) / yrs) if pts.std(ddof=1) > 0 else 0
    t = pts.mean() / (pts.std(ddof=1) / np.sqrt(len(pts)))
    print(f"  {name:<42} n={len(x):>5,}  WR={ (pts>0).mean()*100:5.1f}%  "
          f"PF={pf:5.2f}  t={t:+5.2f}  Sharpe={sharpe:5.2f}  "
          f"${usd.sum():>9,.0f}  maxDD=${dd:>7,.0f}")
    return {"n": len(x), "wr": (pts > 0).mean() * 100, "pf": pf, "t": t,
            "sharpe": sharpe, "usd": usd.sum(), "dd": dd}


def main():
    m1 = pd.read_parquet("/workspace/data/prepared/nas100_m1.parquet")
    vix = pd.read_parquet("/workspace/data/prepared/vix_daily.parquet")
    d = build(m1, vix)

    print("=" * 108)
    print("OVERNIGHT STRATEGY -- 1 MNQ contract, cost $1.50 round trip (0.75pt)")
    print("=" * 108)

    for label, (lo, hi) in SPLITS.items():
        s = d
        if lo is not None:
            s = s[s["date"] >= lo]
        if hi is not None:
            s = s[s["date"] < hi]
        print(f"\n--- {label}   ({len(s):,} sessions, "
              f"NDX {s['rth_close'].iloc[0]:.0f} -> {s['rth_close'].iloc[-1]:.0f}) ---")

        all_ = pd.Series(True, index=s.index)
        evaluate(s, all_, "on_points", "A) overnight, every day")
        gate = (s["vix_prev"] >= 13) & (s["vix_prev"] < 22)
        evaluate(s, gate, "on_points", "B) overnight, VIX 13-22 gate")
        evaluate(s, all_, "id_points", "C) intraday long, every day (control)")
        evaluate(s, s["is_opex"], "id_points", "D) intraday SHORT on OPEX Fri", sign=-1)
        evaluate(s, gate & ~s["is_opex"], "on_points",
                 "E) overnight, VIX gate, skip OPEX")

    # combined equity curve on the final rule, whole sample
    print("\n" + "=" * 108)
    print("RULE B (overnight + VIX 13-22 gate) -- year by year, whole sample")
    print("=" * 108)
    g = d[(d["vix_prev"] >= 13) & (d["vix_prev"] < 22)].copy()
    g["pts"] = g["on_points"] - COST_POINTS
    g["usd"] = g["pts"] * POINT_VALUE
    g["yr"] = g["dt"].dt.year
    yr = g.groupby("yr").agg(trades=("usd", "size"), usd=("usd", "sum"),
                             wr=("pts", lambda x: (x > 0).mean() * 100))
    yr["cum"] = yr["usd"].cumsum()
    print(yr.round(1).to_string())


if __name__ == "__main__":
    main()
