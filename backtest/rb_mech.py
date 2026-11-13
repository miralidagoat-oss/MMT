#!/usr/bin/env python3
"""Mechanisms: what puts price-contingent buying or selling at a level BEFORE
price gets there, and does it make a 60-point block go on to 100 points?

A reversal that can be seen in advance needs order flow that is tied to price
and known beforehand. The candidates, and the data each needs:

  dealer gamma hedging   option dealers who are long gamma sell rallies and
                         buy dips by formula; short gamma, the opposite.
                         Tested with the public daily S&P 500 dealer gamma
                         series (SqueezeMetrics GEX, 2011 ->) and with the
                         VIX term structure as a stand-in.
  dark-pool buying       SqueezeMetrics DIX, same file.
  option strikes         open interest sits at round strikes of QQQ; blocks
                         at the $5 and $10 strikes, on all days, on Fridays
                         and on monthly expiry days.
  leveraged-ETF          3x funds must trade in the direction of the day's
  rebalancing            move into the close; the push should fade after it.
  overnight inventory    dealers who absorbed selling at the close unload when
                         Europe opens (Boyarchenko, Larsen, Whelan 2020).
  expiry days            pinning near strikes on expiry.

Same strict rules as everywhere: 60-point block, HIT = 45, 100+ = 100, a
candle closing beyond the block ends it. `chance` is the same test on
direction-scrambled copies of the price data.

  python3 rb_mech.py gamma   --duka data/nq --start 20221109 --gex data/mech/DIX.csv --yahoo data/yahoo --null 4
  python3 rb_mech.py flows   --duka data/nq --start 20221109 --null 4
  python3 rb_mech.py strikes --duka data/nq --start 20221109 --yahoo data/yahoo --null 4
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd

import rb_blocks
import rb_deep
import rb_hunt
import rz_null


def daily(path):
    x = pd.read_csv(path)
    return pd.Series(x.close.values, index=pd.to_datetime(x.time, unit="s").dt.normalize()).groupby(level=0).last()


def before(series, dates):
    """For each trade date, the last value published BEFORE that date."""
    pos = series.index.searchsorted(pd.DatetimeIndex(dates), side="left") - 1
    return np.where(pos >= 0, series.values[np.maximum(pos, 0)], np.nan)


def rows(X, nulls, label, masks, min_n):
    print(f"-- {label}")
    mid = X.t.iloc[0] + (X.t.iloc[-1] - X.t.iloc[0]) / 2
    for name, fn in masks:
        m = fn(X)
        g = X[m]
        if len(g) < min_n:
            continue
        ch = np.array([100 * Z[fn(Z)].hit.mean() for Z in nulls])
        cb = np.array([100 * Z[fn(Z)].big.mean() for Z in nulls])
        z = (100 * g.big.mean() - cb.mean()) / cb.std() if len(cb) > 1 and cb.std() > 0 else np.nan
        print(f"   {name:56s} {len(g):6d} {100 * g.hit.mean():5.1f}% {ch.mean() if len(ch) else np.nan:6.1f}% {100 * g.big.mean():5.1f}% "
              f"{cb.mean() if len(cb) else np.nan:6.1f}% {z:+5.1f}   {100 * g[g.t < mid].big.mean():7.1f}% {100 * g[g.t >= mid].big.mean():7.1f}%")


def head(X, args):
    print(f"{X.t.iloc[0].date()} -> {X.t.iloc[-1].date()}, {args.tf}-minute candles{' (scaled to price)' if args.scale else ''}: {len(X)} graded "
          f"session-level blocks, hit {100 * X.hit.mean():.1f}%, went on to 100+ {100 * X.big.mean():.1f}%")
    print(f"{'':59s} {'graded':>6s} {'HIT':>6s} {'chance':>7s} {'100+':>6s} {'chance':>7s} {'z':>5s}   {'100+ 1st':>8s} {'100+ 2nd':>8s}")


def frames(args):
    args.csv = None
    df = rb_blocks.load(args)
    vxn = daily(os.path.join(args.yahoo, "VXN_1d.csv")) if args.yahoo else None
    X = rb_deep.build(rb_blocks.prep(df, args.tf), args, vxn)
    nulls = [rb_deep.build(rb_blocks.prep(rz_null.scramble(df, 900 + k), args.tf), args, vxn) for k in range(args.null)]
    return df, X, nulls


def cmd_gamma(args):
    df, X, nulls = frames(args)
    g = pd.read_csv(args.gex, parse_dates=["date"]).set_index("date")
    g["gex_pct"] = g.gex.rolling(252, min_periods=120).rank(pct=True)
    g["dix_pct"] = g.dix.rolling(252, min_periods=120).rank(pct=True)
    vix, vix3 = daily(os.path.join(args.yahoo, "VIX_1d.csv")), daily(os.path.join(args.yahoo, "VIX3M_1d.csv"))
    ts = (vix / vix3).dropna()
    for Z in [X] + nulls:
        Z["gex"] = before(g.gex, Z.date)
        Z["gex_pct"] = before(g.gex_pct, Z.date)
        dp = before(g.dix_pct, Z.date)
        Z["dix_for"] = np.where(Z.side < 0, dp, 1 - dp)        # high = dark-pool buying supports the reversal being looked for
        Z["ts"] = before(ts, Z.date)
        Z["vix"] = before(vix, Z.date)
    head(X, args)
    rows(X, nulls, "DEALER GAMMA the day before (S&P 500 GEX): long gamma should mean reversals, short gamma trends", [
        ("negative (dealers short gamma)", lambda Z: (Z.gex < 0).values),
        ("positive, lowest third of the past year", lambda Z: ((Z.gex >= 0) & (Z.gex_pct <= 1 / 3)).values),
        ("middle third", lambda Z: ((Z.gex >= 0) & (Z.gex_pct > 1 / 3) & (Z.gex_pct <= 2 / 3)).values),
        ("highest third (dealers very long gamma)", lambda Z: (Z.gex_pct > 2 / 3).values),
        ("top tenth of the past year", lambda Z: (Z.gex_pct > 0.9).values)], args.min_n)
    rows(X, nulls, "DARK-POOL BUYING the day before (DIX), on the side of the reversal", [
        ("lowest fifth (flow against the reversal)", lambda Z: (Z.dix_for <= 0.2).values),
        ("middle", lambda Z: ((Z.dix_for > 0.2) & (Z.dix_for <= 0.8)).values),
        ("highest fifth (flow with the reversal)", lambda Z: (Z.dix_for > 0.8).values)], args.min_n)
    rows(X, nulls, "VIX TERM STRUCTURE the day before (VIX / 3-month VIX): above 1 = stress, a stand-in for short gamma", [
        ("above 1.0 (backwardation)", lambda Z: (Z.ts > 1.0).values),
        ("0.9 - 1.0", lambda Z: ((Z.ts > 0.9) & (Z.ts <= 1.0)).values),
        ("0.8 - 0.9", lambda Z: ((Z.ts > 0.8) & (Z.ts <= 0.9)).values),
        ("below 0.8 (calm, steep)", lambda Z: (Z.ts <= 0.8).values)], args.min_n)
    rows(X, nulls, "VIX the day before", [
        ("below 14", lambda Z: (Z.vix < 14).values), ("14 - 18", lambda Z: ((Z.vix >= 14) & (Z.vix < 18)).values),
        ("18 - 24", lambda Z: ((Z.vix >= 18) & (Z.vix < 24)).values), ("24 and above", lambda Z: (Z.vix >= 24).values)], args.min_n)
    rows(X, nulls, "LONG GAMMA + everything else that helped (with the daily trend, rotational day, level left far behind)", [
        ("highest third of gamma, with the daily trend", lambda Z: ((Z.gex_pct > 2 / 3) & (Z.trend50 <= 0)).values),
        ("... and a rotational day (efficiency -0.05 to 0.05)", lambda Z: ((Z.gex_pct > 2 / 3) & (Z.trend50 <= 0) & (Z.er.abs() <= 0.05)).values),
        ("short gamma, against the daily trend", lambda Z: ((Z.gex < 0) & (Z.trend50 > 0)).values)], args.min_n)


def third_friday(dates):
    d = pd.DatetimeIndex(dates)
    return (d.dayofweek == 4) & (d.day >= 15) & (d.day <= 21)


def cmd_flows(args):
    df, X, nulls = frames(args)
    head(X, args)
    late = lambda Z: (Z["mod"] >= 900) & (Z["mod"] < 960)
    rows(X, nulls, "LEVERAGED-ETF REBALANCING: 3x funds must trade WITH the day's move into the close (15:00-16:00 touches)", [
        ("fading a day that is already up / down 1%+ (against the flow)", lambda Z: (late(Z) & (Z.today >= 1.0)).values),
        ("fading a day that has moved less than 1%", lambda Z: (late(Z) & (Z.today.abs() < 1.0)).values),
        ("block on the side the flow is pushing from (day moved 1%+ the other way)", lambda Z: (late(Z) & (Z.today <= -1.0)).values)], args.min_n)
    rows(X, nulls, "THE DAY AFTER: fading yesterday's move (the close was pushed by the rebalancing, so it should give back)", [
        ("yesterday moved 1.5%+ in the direction being faded", lambda Z: (Z.r1 >= 1.5).values),
        ("0.5 - 1.5%", lambda Z: ((Z.r1 >= 0.5) & (Z.r1 < 1.5)).values),
        ("yesterday flat (within 0.5%)", lambda Z: (Z.r1.abs() < 0.5).values),
        ("yesterday moved 0.5 - 1.5% the other way", lambda Z: ((Z.r1 <= -0.5) & (Z.r1 > -1.5)).values),
        ("yesterday moved 1.5%+ the other way", lambda Z: (Z.r1 <= -1.5).values)], args.min_n)
    night = lambda Z: (Z["mod"] >= 1080) | (Z["mod"] < 180)
    rows(X, nulls, "OVERNIGHT DEALER INVENTORY: selling absorbed at the close is unloaded when Europe opens", [
        ("support, 18:00-03:00, after a day down 1%+", lambda Z: (night(Z) & (Z.side < 0) & (Z.r1 >= 1.0)).values),
        ("support, 18:00-03:00, other days", lambda Z: (night(Z) & (Z.side < 0) & (Z.r1 < 1.0)).values),
        ("resistance, 18:00-03:00, after a day up 1%+", lambda Z: (night(Z) & (Z.side > 0) & (Z.r1 >= 1.0)).values),
        ("support, 02:00-04:00 (Europe opens), any day", lambda Z: ((Z["mod"] >= 120) & (Z["mod"] < 240) & (Z.side < 0)).values)], args.min_n)
    rows(X, nulls, "EXPIRY DAYS: pinning", [
        ("monthly expiry (third Friday)", lambda Z: third_friday(Z.date)),
        ("other Fridays", lambda Z: (pd.DatetimeIndex(Z.date).dayofweek == 4) & ~third_friday(Z.date)),
        ("Monday - Thursday", lambda Z: pd.DatetimeIndex(Z.date).dayofweek < 4)], args.min_n)


def strike_table(B, args, qqq):
    o, h, l, c, mod, td = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"]
    T = rb_hunt.days_of(B)
    starts, D, didx = T["starts"], T["D"], T["didx"]
    cash = pd.Series(c[(mod >= 570) & (mod < 960)], index=didx[(mod >= 570) & (mod < 960)]).groupby(level=0).last().reindex(range(D)).values
    q = qqq.reindex(pd.DatetimeIndex(T["dates"])).values
    ev = []
    for d in range(1, D):
        if np.isnan(cash[d - 1]) or np.isnan(q[d - 1]):
            continue
        ratio = cash[d - 1] / q[d - 1]                       # index points per QQQ dollar at yesterday's 16:00
        a = starts[d]
        px = o[a] / ratio
        for step, fam in ((5.0, 0), (10.0, 1)):
            up, dn = np.ceil(px / step) * step, np.floor(px / step) * step
            if up == px:
                up += step
            if dn == px:
                dn -= step
            ev.append((a, up * ratio, 1, fam))
            ev.append((a, dn * ratio, -1, fam))
    i = np.array([e[0] for e in ev], np.int64)
    side = np.array([e[2] for e in ev], np.int64)
    one = np.ones(len(ev))
    res, ti, hi, ri, dep = rb_deep.grade2(o, h, l, c, td, i, np.array([e[1] for e in ev]), side, args.width * one, args.target * one,
                                          args.hit * one, np.zeros(len(ev), np.int64))
    ok = ti >= 0
    X = pd.DataFrame({"fam": np.array([e[3] for e in ev])[ok], "date": T["dates"][didx[ti[ok]]], "hit": hi[ok] >= 0, "big": res[ok] == 1,
                      "graded": (hi[ok] >= 0) | (res[ok] == 2), "t": B["index"][ti[ok]]})
    return X[X.graded].reset_index(drop=True)


def cmd_strikes(args):
    args.csv = None
    df = rb_blocks.load(args)
    qqq = daily(os.path.join(args.yahoo, "QQQ_1d.csv"))
    X = strike_table(rb_blocks.prep(df, args.tf), args, qqq)
    nulls = [strike_table(rb_blocks.prep(rz_null.scramble(df, 900 + k), args.tf), args, qqq) for k in range(args.null)]
    print(f"{X.t.iloc[0].date()} -> {X.t.iloc[-1].date()}, {args.tf}-minute candles: blocks at the QQQ option strikes nearest above and below the 18:00 open,"
          f" carried to index points at yesterday's 16:00 ratio")
    print(f"{'':59s} {'graded':>6s} {'HIT':>6s} {'chance':>7s} {'100+':>6s} {'chance':>7s} {'z':>5s}   {'100+ 1st':>8s} {'100+ 2nd':>8s}")
    fri = lambda Z: pd.DatetimeIndex(Z.date).dayofweek == 4
    for fam, name in ((0, "QQQ $5 strikes"), (1, "QQQ $10 strikes")):
        rows(X, nulls, name, [
            ("all days", lambda Z, f=fam: (Z.fam == f).values),
            ("Fridays", lambda Z, f=fam: (Z.fam == f).values & fri(Z)),
            ("monthly expiry (third Friday)", lambda Z, f=fam: (Z.fam == f).values & third_friday(Z.date)),
            ("Monday - Thursday", lambda Z, f=fam: (Z.fam == f).values & ~fri(Z))], args.min_n)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["gamma", "flows", "strikes"])
    ap.add_argument("--duka")
    ap.add_argument("--cache")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--gex", help="SqueezeMetrics DIX.csv (date, price, dix, gex)")
    ap.add_argument("--yahoo", help="directory of Yahoo daily CSVs (VIX, VIX3M, VXN, QQQ)")
    ap.add_argument("--tf", type=int, default=5)
    ap.add_argument("--width", type=float, default=60.0)
    ap.add_argument("--hit", type=float, default=45.0)
    ap.add_argument("--target", type=float, default=100.0)
    ap.add_argument("--scale", action="store_true")
    ap.add_argument("--null", type=int, default=4)
    ap.add_argument("--min-n", dest="min_n", type=int, default=100)
    args = ap.parse_args()
    globals()[f"cmd_{args.command}"](args)


if __name__ == "__main__":
    main()
