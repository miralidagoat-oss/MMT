#!/usr/bin/env python3
"""Where does the cost barrier break? Same setups, every timeframe.

The 5-minute result is dominated by one number: an MNQ round turn costs about
1.0 index point, while the median 5m ATR is only ~8 points. Every trade
therefore hands over 12-50% of its risk before the setup has done anything.

Transaction cost per trade is roughly *constant* across timeframes - it is set
by the spread and commission, not the bar size - while ATR grows roughly with
the square root of bar duration. So cost-as-a-fraction-of-risk falls as the
timeframe rises. This script resamples one source series to 5m/15m/30m/1h/2h/4h
and re-runs the identical family screen on each, which isolates the effect of
the timeframe from every other choice.

Usage:
    python3 tf_study.py <ndx_5m.csv> [out_json]
"""
import json
import sys

import numpy as np
import pandas as pd

from features import build_features, build_triggers
from qlib import load_bars
from search import build_trades
from validate import matched_random_trigger, trade_sharpe

TFS = [(1, "5m"), (3, "15m"), (6, "30m"), (12, "1h"), (24, "2h"), (48, "4h")]
STOPS = (1.0, 1.5, 2.0, 3.0)
RRS = (1.0, 1.5, 2.0, 3.0)


def resample(df, factor):
    """Aggregate `factor` consecutive 5m bars into one bar."""
    if factor == 1:
        return df
    rule = f"{5 * factor}min"
    out = df.resample(rule).agg({"open": "first", "high": "max", "low": "min",
                                 "close": "last", "volume": "sum"}).dropna()
    et = out.index.tz_convert("America/New_York")
    out["et_min"] = et.hour * 60 + et.minute
    out["dow"] = et.dayofweek
    d = et.normalize()
    out["session"] = ((d - d[0]).days).astype(np.int64)
    return out


def screen(df, label):
    f = build_features(df)
    T = build_triggers(f)
    med_atr = float(np.nanmedian(f["atr14"]))
    rows = []
    pooled_g, pooled_n, pooled_c = [], [], []
    for name, d, m in T:
        for s in STOPS:
            for rr in RRS:
                g = build_trades(f, m, d, s, rr, 72, cost=0.0)
                n = build_trades(f, m, d, s, rr, 72)
                if g is None or n is None or len(n["r"]) < 200:
                    continue
                pooled_g.append(g["r"])
                pooled_n.append(n["r"])
                pooled_c.append(n["cost_r"])
                r = n["r"]
                rows.append(dict(name=name, dir=int(d), stop=s, rr=rr,
                                 n=len(r), exp=float(r.mean()),
                                 t=float(trade_sharpe(r) * np.sqrt(len(r)))))
    G = np.concatenate(pooled_g)
    N = np.concatenate(pooled_n)
    C = np.concatenate(pooled_c)

    # Drift control: random entries, same directional mix, same exits. Any
    # "edge" a signal shares with a coin flip is beta, not alpha.
    rng = np.random.default_rng(3)
    valid = np.isfinite(f["atr14"]) & np.isfinite(f["ema200"])
    valid[:500] = False
    rand = {}
    for d in (+1, -1):
        idx = np.flatnonzero(valid)
        take = rng.choice(idx, size=min(60000, len(idx)), replace=False)
        m = np.zeros(len(valid), bool)
        m[take] = True
        g = build_trades(f, m, d, 2.0, 2.0, 72, cost=0.0)
        rand[d] = float(g["r"].mean()) if g is not None else float("nan")

    best = max(rows, key=lambda r: r["t"]) if rows else None
    n_tests = len(rows)
    noise = float(np.sqrt(2 * np.log(max(n_tests, 2))))
    return dict(
        tf=label, bars=len(df), median_atr=med_atr,
        cost_frac_R=float(C.mean()),
        gross_exp=float(G.mean()), net_exp=float(N.mean()),
        gross_pf=float(G[G > 0].sum() / max(-G[G < 0].sum(), 1e-9)),
        net_pf=float(N[N > 0].sum() / max(-N[N < 0].sum(), 1e-9)),
        n_tests=n_tests, best_t=float(best["t"]) if best else 0.0,
        best_name=best["name"] if best else "", best_n=best["n"] if best else 0,
        best_exp=float(best["exp"]) if best else 0.0,
        noise_threshold=noise,
        frac_positive=float(np.mean([r["exp"] > 0 for r in rows])) if rows else 0.0,
        rand_long=rand[+1], rand_short=rand[-1])


def main(path, out_json=None):
    base = load_bars(path)
    print(f"source: {len(base):,} 5m bars "
          f"{base.index[0]:%Y-%m-%d} -> {base.index[-1]:%Y-%m-%d}\n")
    print(f"{'tf':>4s} {'bars':>9s} {'ATR':>7s} {'cost/R':>7s} {'gross_exp':>10s} "
          f"{'net_exp':>9s} {'gross_pf':>9s} {'net_pf':>7s} {'frac+':>6s} "
          f"{'best_t':>7s} {'noise':>6s}")
    res = []
    for factor, label in TFS:
        df = resample(base, factor)
        if len(df) < 3000:
            continue
        r = screen(df, label)
        res.append(r)
        print(f"{label:>4s} {r['bars']:9,d} {r['median_atr']:7.1f} "
              f"{r['cost_frac_R']:7.3f} {r['gross_exp']:+10.4f} "
              f"{r['net_exp']:+9.4f} {r['gross_pf']:9.3f} {r['net_pf']:7.3f} "
              f"{r['frac_positive']:6.2f} {r['best_t']:+7.2f} "
              f"{r['noise_threshold']:6.2f}")
    print("\nrandom-entry drift control (gross expectancy, 2atr/rr2):")
    for r in res:
        print(f"  {r['tf']:>4s}  random long {r['rand_long']:+.4f}   "
              f"random short {r['rand_short']:+.4f}")
    if out_json:
        with open(out_json, "w") as fh:
            json.dump(res, fh, indent=2)
    return res


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
