"""Exploratory edge analysis -- TRAIN SLICE ONLY.

Nothing here is allowed to touch validation or test data. The point is to find
out whether the dealer-gamma thesis survives contact with 10 years of data
before a single line of strategy code gets written.
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, "backtest/of")
import features as F  # noqa: E402

TRAIN_END = pd.Timestamp("2015-01-01").date()
VAL_END = pd.Timestamp("2018-01-01").date()


def load(tf="5min"):
    m1 = pd.read_parquet("/workspace/data/prepared/nas100_m1.parquet")
    vix = pd.read_parquet("/workspace/data/prepared/vix_daily.parquet")
    return F.assemble(m1, vix, tf=tf)


def split(f):
    tr = f[f["date"] < TRAIN_END]
    va = f[(f["date"] >= TRAIN_END) & (f["date"] < VAL_END)]
    te = f[f["date"] >= VAL_END]
    return tr, va, te


def fwd_return(f, horizon):
    """Forward log return over `horizon` bars, in basis points."""
    return (np.log(f["close"].shift(-horizon) / f["close"]) * 1e4)


def bucket_table(f, col, target, nbins=5, label=""):
    """Mean forward return by feature quintile."""
    d = pd.DataFrame({"x": f[col], "y": target}).dropna()
    if len(d) < 1000:
        return
    d["q"] = pd.qcut(d["x"], nbins, labels=False, duplicates="drop")
    g = d.groupby("q")["y"].agg(["mean", "count"])
    print(f"\n  {label or col} -> fwd return (bps) by quintile")
    for q, row in g.iterrows():
        print(f"    q{int(q)+1}  mean {row['mean']:+7.2f}  n={int(row['count']):>7,}")
    lo, hi = g["mean"].iloc[0], g["mean"].iloc[-1]
    print(f"    spread q5-q1 = {hi - lo:+.2f} bps")


def reversion_by_regime(f, horizon=6):
    """THE central test.

    Take stretched-from-VWAP bars and ask: does price revert? Then split that
    same question by the options-flow regime. If the dealer-gamma thesis is
    right, reversion should be strong when VRP is high (dealers long gamma,
    suppressing vol) and weak or inverted when VRP is low/negative.
    """
    y = fwd_return(f, horizon)
    d = pd.DataFrame({
        "vwap_z": f["vwap_z"], "vrp_z": f["vrp_z"], "vr": f["vr"],
        "vix_z": f["vix_z"], "y": y,
    }).dropna()

    # signed reversion payoff: shorting when stretched up, buying when down
    d["rev_pnl"] = -np.sign(d["vwap_z"]) * d["y"]
    stretched = d[d["vwap_z"].abs() > 1.5]

    print(f"\n{'='*74}")
    print(f"CENTRAL TEST: mean-reversion payoff on stretched bars (|vwap_z|>1.5)")
    print(f"horizon = {horizon} bars, n = {len(stretched):,}")
    print(f"{'='*74}")
    print(f"  unconditional reversion payoff: {stretched['rev_pnl'].mean():+.2f} bps")

    for name, col in [("VRP z-score", "vrp_z"), ("variance ratio", "vr"),
                      ("VIX z-score", "vix_z")]:
        s = stretched.dropna(subset=[col]).copy()
        s["q"] = pd.qcut(s[col], 5, labels=False, duplicates="drop")
        g = s.groupby("q")["rev_pnl"].agg(["mean", "count", "sem"])
        print(f"\n  reversion payoff by {name}:")
        for q, row in g.iterrows():
            t = row["mean"] / row["sem"] if row["sem"] > 0 else 0
            flag = "  <-- " + ("MEAN REVERT" if row["mean"] > 0 else "TRENDS") if abs(t) > 2 else ""
            print(f"    q{int(q)+1}  {row['mean']:+7.2f} bps  "
                  f"t={t:+5.2f}  n={int(row['count']):>6,}{flag}")


def orderflow_tests(f, horizon=6):
    """Does order flow predict, and does the regime flip its sign too?"""
    y = fwd_return(f, horizon)
    print(f"\n{'='*74}")
    print("ORDER FLOW predictive power (train)")
    print(f"{'='*74}")
    for col, label in [("imbalance", "delta imbalance (delta/volume)"),
                       ("delta_z", "delta z-score"),
                       ("rel_vol", "relative volume"),
                       ("close_pos", "close position in bar"),
                       ("absorption", "absorption (delta per unit range)")]:
        bucket_table(f, col, y, label=label)


def main():
    tf = sys.argv[1] if len(sys.argv) > 1 else "5min"
    horizon = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    print(f"loading features ({tf}) ...")
    f = load(tf)
    tr, va, te = split(f)
    print(f"  train {tr['date'].min()} .. {tr['date'].max()}  ({len(tr):,} bars)")
    print(f"  val   {va['date'].min()} .. {va['date'].max()}  ({len(va):,} bars)")
    print(f"  test  {te['date'].min()} .. {te['date'].max()}  ({len(te):,} bars)  [LOCKED]")

    reversion_by_regime(tr, horizon)
    orderflow_tests(tr, horizon)


if __name__ == "__main__":
    main()
