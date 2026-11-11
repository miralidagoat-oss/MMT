#!/usr/bin/env python3
"""Backtest of the reversal-zone indicator on real data, with a null model.

Runs the exact engine the Pine script implements (rz_engine.py) over real
bars, then runs the identical rules over N direction-scrambled copies of the
same bars (rz_null.py). Three numbers are printed for every row:

    hit%     what the real market did
    null%    what the same zones do when direction is a coin flip
    chance%  the textbook driftless probability, risk / (target + risk)

`lift` = hit% - null% is the only thing that can honestly be called an edge;
`z` is that lift in binomial standard errors.

Usage:
  python3 rz_backtest.py duka <day_file_dir> [options]
  python3 rz_backtest.py csv  <bars.csv> [options]        (Yahoo-style CSV)

Options:
  --start YYYYMMDD  --end YYYYMMDD     evaluation window (ADR warm-up is loaded before it)
  --daily FILE      real daily bars for ADR / 5-session / weekly context
  --trend-daily F   real daily bars whose closes define the 200-session trend
                    (needed when the intraday history is shorter than ~220 sessions)
  --tf MIN          resample 1-minute bars to an N-minute chart first
  --null N          number of surrogate runs (default 8)
  --set k=v,...     engine parameter overrides, e.g. --set target_pts=150,depth_adr=0.08
  --by-year         add a per-year breakdown
"""
import argparse
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # works under `python3 -I` too
import rz_data  # noqa: E402
import rz_engine  # noqa: E402
import rz_null  # noqa: E402


def load(args):
    if args.source == "duka":
        warm = (pd.Timestamp(args.start) - pd.Timedelta(days=45)).strftime("%Y%m%d") if args.start else None
        df = rz_data.load_duka(args.path, start=warm, end=args.end)
    else:
        df, fixed = rz_data.clean_yahoo(rz_data.load_csv(args.path))
        print(f"repaired {fixed} glitched bar extreme(s) in the Yahoo feed")
    if args.tf > 1:
        df = rz_data.resample(df, args.tf)
    return rz_engine.session_cols(df)


def evaluate(df, p, daily, tf, start, trend=None):
    fr = rz_engine.taps_frame(rz_engine.run(df, p, daily=daily, tf_min=tf, trend=trend), df)
    if start is not None and len(fr):
        fr = fr[fr.date >= pd.Timestamp(start)]
    return fr


def table(real, nulls, tier, by=None):
    r = rz_engine.score(real, tier, by)
    if len(r) == 0:
        return r
    nh = pd.concat([rz_engine.score(x, tier, by)["hit%"] for x in nulls], axis=1) if nulls else None
    if nh is not None:
        r["null%"] = nh.mean(axis=1)
        r["lift"] = r["hit%"] - r["null%"]
        dec = (r.hit + r.fail).clip(lower=1)
        r["z"] = r.lift / (100.0 * np.sqrt((r["null%"] / 100.0) * (1 - r["null%"] / 100.0) / dec))
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", choices=["duka", "csv"])
    ap.add_argument("path")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--daily")
    ap.add_argument("--trend-daily")
    ap.add_argument("--tf", type=int, default=1)
    ap.add_argument("--null", type=int, default=8)
    ap.add_argument("--set", default="")
    ap.add_argument("--by-year", action="store_true")
    ap.add_argument("--save")
    args = ap.parse_args()

    p = rz_engine.Params()
    for kv in filter(None, args.set.split(",")):
        k, v = kv.split("=")
        cur = getattr(p, k)
        setattr(p, k, type(cur)(float(v)) if not isinstance(cur, (str, tuple)) else v)
    df = load(args)
    daily = rz_data.load_daily(args.daily) if args.daily else None
    trend = None
    if args.trend_daily:
        trend = rz_engine.trend_from_closes(rz_data.load_daily(args.trend_daily).c, p.trend_len)
    print(f"bars {len(df):,}  {df.index[0]} -> {df.index[-1]}  trade dates {df.trade_date.nunique()}  tf {args.tf}m")
    print(f"params {p}\n")

    real = evaluate(df, p, daily, args.tf, args.start, trend)
    nulls = [evaluate(rz_null.scramble(df, 31000 + s), p, daily, args.tf, args.start, trend) for s in range(args.null)]
    if args.save:
        real.to_csv(args.save, index=False)
    pd.set_option("display.width", 220)
    pd.set_option("display.float_format", lambda x: f"{x:,.2f}")

    days = real.date.nunique() if len(real) else 0
    print(f"== TIER 1 - TAPS (zero lag): {len(real):,} taps on {days} days ==")
    print(table(real, nulls, "tap", "fam").to_string())
    print(table(real, nulls, "tap").to_string(header=False))
    real["sd"] = np.where(real.side > 0, "top", "bottom")
    for x in nulls:
        x["sd"] = np.where(x.side > 0, "top", "bottom")
    rc = real[real.rc]
    print(f"\n== TIER 2 - RECLAIMS (confirmed failed breakouts): {len(rc):,} ==")
    if len(rc):
        print(f"marker prints a median {rc.rc_lag.median():.1f} pts behind the sweep extreme; "
              f"median stop distance {rc.rc_stop_dist.median():.1f} pts; median dwell {rc.rc_dwell.median():.0f} bars")
        print(table(real, nulls, "reclaim", "sd").to_string())
        print(table(real, nulls, "reclaim").to_string(header=False))
        real["tr"] = np.where(real.rc_trend == 0, "trend unknown", np.where(real.rc_with_trend, "with 200d trend", "against trend"))
        for x in nulls:
            x["tr"] = np.where(x.rc_trend == 0, "trend unknown", np.where(x.rc_with_trend, "with 200d trend", "against trend"))
        print(table(real, nulls, "reclaim", "tr").to_string())
        grp = {"ON": "overnight", "LO": "overnight", "AS": "overnight", "PD": "prior-day/multi-day",
               "X5": "prior-day/multi-day", "PW": "prior-day/multi-day", "OR": "RTH structure",
               "IB": "RTH structure", "AM": "RTH structure", "SW": "intraday swing"}
        real["grp"] = real.fam.map(grp)
        for x in nulls:
            x["grp"] = x.fam.map(grp)
        print(table(real, nulls, "reclaim", "grp").to_string())
    if args.by_year and len(real):
        real["yr"] = real.date.dt.year
        for x in nulls:
            x["yr"] = x.date.dt.year
        print("\n== by year: taps ==")
        print(table(real, nulls, "tap", "yr").to_string())
        print("\n== by year: reclaims ==")
        print(table(real, nulls, "reclaim", "yr").to_string())


if __name__ == "__main__":
    sys.exit(main())
