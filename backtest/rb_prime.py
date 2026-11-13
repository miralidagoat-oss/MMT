#!/usr/bin/env python3
"""Where the PRIME rule of indicators/mnq_reversal_blocks.pine comes from, and
how much it depends on its two sizes.

PRIME: the day after a strong day with the daily trend (yesterday's close at
least 0.75 average daily ranges from the close before it, in the direction of
the trend), a block on the trend's side at an overnight level (Asia / London
session high or low, the 18:00 open, the midnight open) within 0.40 average
daily ranges of yesterday's close, first touched in the cash session
(09:30-16:00 ET). Everything is known before price gets there.

All numbers except `families` come from the real engine (rb_blocks.run): the
blocks the indicator draws, one per level, no overlaps, graded strictly (a
candle closing beyond the block breaks it). "100+" is the share of graded
blocks whose reversal reached the full target with no close beyond the block.
Each line shows the whole history and, in brackets, the part before and the
part after --split.

Commands
  landscape  the 100+ rate by yesterday's move (with / against the trend), for
             blocks on and against the trend's side, overnight and cash-made
             levels, touched in and outside the cash session
  grid       the two sizes of the rule swept, on each candle size in --tfs
  where      PRIME-day overnight blocks by where the level sits against
             yesterday's close, by the hour of the touch, by block type, year
             and side
  families   about ninety kinds of level (rb_hunt.events, each graded on its
             own) on PRIME days: is it the overnight levels, or any level near
             yesterday's close? Arbitrary levels are the control.

  python3 rb_prime.py landscape --duka data/nq --start 20170301 --warm 110 --scale
  python3 rb_prime.py grid      --duka data/nq --start 20170301 --warm 110 --scale --tfs 5 1 15
  python3 rb_prime.py where     --duka data/nq --start 20170301 --warm 110 --scale
  python3 rb_prime.py families  --duka data/nq --start 20170301 --warm 110 --scale
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

OVN = list(rb_blocks.PRIME_FAMS)
FROM, TO = rb_blocks.PRIME_FROM, rb_blocks.PRIME_TO


def engine_frame(df, tf, args):
    """Every graded block of the engine (trend filter off, so both sides are there), with what was known about its day."""
    B = rb_blocks.prep(df, tf)
    recs, _ = rb_blocks.run(B, ref=float(B["c"][-1]) if args.scale else 0.0, trend=False)
    f = rb_blocks.frame(recs, B)
    f = f[f.t >= rb_blocks.since(args, df)].copy()
    f["hit"] = f.best >= f.hg - 1e-9
    f["big"] = f.res == "held"
    f = f[f.hit | (f.res == "broken")].copy()
    f["cash"] = (f.tmod >= FROM) & (f.tmod < TO)            # first touch 09:30-16:00 ET
    f["ovn"] = f.fam.isin(OVN)
    return f


def cell(g, mid):
    a, b = g[g.t < mid], g[g.t >= mid]
    if not len(g):
        return f"{0:5d}"
    return (f"{len(g):5d}  hit {100 * g.hit.mean():5.1f}%  100+ {100 * g.big.mean():5.1f}%  "
            f"[{100 * a.big.mean() if len(a) else np.nan:5.1f}% n{len(a):4d} | {100 * b.big.mean() if len(b) else np.nan:5.1f}% n{len(b):4d}]")


def cmd_landscape(args, df, mid):
    f = engine_frame(df, args.tfs[0], args)
    print(f"{args.tfs[0]}-minute candles, {len(f)} graded blocks; brackets: before | after {mid.date()}")
    print("all blocks                                 ", cell(f, mid))
    print("on the trend's side                        ", cell(f[f.wt == 1], mid))
    edges = [-9, -0.75, -0.4, 0.0, 0.4, 0.75, 1.0, 1.5, 9]
    for name, m in (("ON the trend's side, overnight levels, first touched in the cash session", (f.wt == 1) & f.ovn & f.cash),
                    ("ON the trend's side, overnight levels, first touched BEFORE 09:30", (f.wt == 1) & f.ovn & (f.tmod < FROM)),
                    ("ON the trend's side, levels made in the cash session (OR, 09:30 open, IB)", (f.wt == 1) & ~f.ovn),
                    ("AGAINST the trend's side, overnight levels, first touched in the cash session", (f.wt == -1) & f.ovn & f.cash)):
        print(f"\n{name}\n  yesterday's move in average daily ranges (+ = with the trend)")
        for a, b in zip(edges[:-1], edges[1:]):
            print(f"  {a:5.2f} .. {b:5.2f}   {cell(f[m & (f.ymv > a) & (f.ymv <= b)], mid)}")
    print("\nthe same, level within 0.40 ranges of yesterday's close (overnight levels on the trend's side, cash session)")
    m = (f.wt == 1) & f.ovn & f.cash & (f.lvn.abs() <= 0.40)
    for a, b in zip(edges[:-1], edges[1:]):
        print(f"  {a:5.2f} .. {b:5.2f}   {cell(f[m & (f.ymv > a) & (f.ymv <= b)], mid)}")


def cmd_grid(args, df, mid):
    F = {tf: engine_frame(df, tf, args) for tf in args.tfs}
    print("PRIME with other sizes: yesterday's move with the trend >= MOVE, level within NEAR of yesterday's close")
    print("cells: blocks, went on to 100+ [before | after " + str(mid.date()) + "]")
    print(f"{'MOVE':>5s} {'NEAR':>5s}   " + "   ".join(f"{str(tf) + '-minute candles':^26s}" for tf in F))
    for mv in (0.5, 0.6, 0.75, 0.9, 1.0, 1.25):
        for nr in (0.25, 0.4, 0.5, 0.6, 99.0):
            row = []
            for f in F.values():
                g = f[(f.wt == 1) & f.ovn & f.cash & (f.ymv >= mv) & (f.lvn.abs() <= nr)]
                a, b = g[g.t < mid], g[g.t >= mid]
                row.append(f"n{len(g):4d} {100 * g.big.mean():5.1f}% [{100 * a.big.mean():4.0f} |{100 * b.big.mean():4.0f} ]")
            print(f"{mv:5.2f} {'none' if nr > 9 else format(nr, '.2f'):>5s}   " + "   ".join(row))
        print()
    print("first touch between 09:30 and ... (MOVE 0.75, NEAR 0.40)")
    for end in (660, 720, 840, 960, 1020):
        row = []
        for f in F.values():
            g = f[(f.wt == 1) & f.ovn & (f.tmod >= FROM) & (f.tmod < end) & (f.ymv >= 0.75) & (f.lvn.abs() <= 0.40)]
            row.append(f"n{len(g):4d} {100 * g.big.mean():5.1f}%{'':13s}")
        print(f"      {end // 60:02d}:{end % 60:02d}   " + "   ".join(row))


def cmd_where(args, df, mid):
    f = engine_frame(df, args.tfs[0], args)
    day = f[(f.wt == 1) & f.ovn & f.cash & (f.ymv >= rb_blocks.PRIME_MOVE)]
    p = day[day.lvn.abs() <= rb_blocks.PRIME_NEAR]
    print(f"{args.tfs[0]}-minute candles. PRIME days, overnight blocks on the trend's side, first touched in the cash session:")
    print("  all of them                 ", cell(day, mid))
    print("  PRIME (level within 0.40)   ", cell(p, mid))
    print("\nby where the level sits against yesterday's close, in average daily ranges")
    print("(+ = beyond the close in the direction the block fades: below it for support, above it for resistance)")
    edges = [-9, -0.25, 0.0, 0.1, 0.25, 0.4, 0.6, 9]
    for a, b in zip(edges[:-1], edges[1:]):
        print(f"  {a:5.2f} .. {b:5.2f}   {cell(day[(day.lvn > a) & (day.lvn <= b)], mid)}")
    print("\nPRIME by the hour of the first touch")
    for a, b in ((570, 600), (600, 660), (660, 720), (720, 840), (840, 960)):
        print(f"  {a // 60:02d}:{a % 60:02d}-{b // 60:02d}:{b % 60:02d}   {cell(p[(p.tmod >= a) & (p.tmod < b)], mid)}")
    print("\nPRIME by block type")
    for k, g in p.groupby("fam"):
        print(f"  {k:12s}  {cell(g, mid)}")
    print("\nPRIME by side")
    for k, g in p.groupby("side"):
        print(f"  {'resistance' if k > 0 else 'support':12s}  {cell(g, mid)}")
    print("\nPRIME by year: " + "  ".join(f"{y}: {100 * g.big.mean():.0f}% (n{len(g)})" for y, g in p.groupby("year")))
    days = p.t.dt.tz_convert("America/New_York").dt.date
    print(f"{len(p)} PRIME blocks on {days.nunique()} days")
    print("\ncontrols (overnight levels within 0.40 of yesterday's close, first touched in the cash session)")
    near = f.ovn & f.cash & (f.lvn.abs() <= rb_blocks.PRIME_NEAR)
    print("  AGAINST the trend's side, same days             ", cell(f[near & (f.wt == -1) & (f.ymv >= rb_blocks.PRIME_MOVE)], mid))
    print("  on the trend's side, quiet yesterday (< 0.4)    ", cell(f[near & (f.wt == 1) & (f.ymv.abs() < 0.4)], mid))
    print("  on the trend's side, yesterday 0.75+ AGAINST it ", cell(f[near & (f.wt == 1) & (f.ymv <= -rb_blocks.PRIME_MOVE)], mid))
    print("  PRIME-day overnight blocks touched BEFORE 09:30 ", cell(f[f.ovn & (f.tmod < FROM) & (f.wt == 1) & (f.ymv >= rb_blocks.PRIME_MOVE)
                                                                      & (f.lvn.abs() <= rb_blocks.PRIME_NEAR)], mid))


def cmd_families(args, df, mid):
    B = rb_blocks.prep(df, args.tfs[0])
    o, h, l, c, mod, td = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"]
    fams, ev, fam, T = rb_hunt.events(B, args.width, args.target, float(c[-1]) if args.scale else 0.0, None)
    res, ti, hi, ri, dep = rb_deep.grade2(o, h, l, c, td, ev[0], ev[1], ev[2], ev[3], ev[4], ev[4] * args.hit / args.target, ev[5])
    didx = T["didx"]
    H, L = T["DAY"]
    C = pd.Series(T["C"])
    adr = (pd.Series(H) - pd.Series(L)).shift(1).rolling(14).mean().values
    pc, pc2, sma50 = C.shift(1).values, C.shift(2).values, C.shift(1).rolling(50).mean().values
    ok = ti >= 0
    i, s, lv = ti[ok], ev[2][ok], ev[1][ok]
    d = didx[i]
    born = np.minimum(ev[0][ok], len(mod) - 1)
    X = pd.DataFrame({"t": B["index"][i], "fam": np.array(fams)[fam[ok]], "hit": hi[ok] >= 0, "big": res[ok] == 1,
                      "brk": (res[ok] == 2) & (hi[ok] < 0), "mod": mod[i], "sameday": didx[born] == d,
                      "pre": (mod[born] >= 1080) | (mod[born] < FROM),               # the level existed before the cash open
                      "wt": -s * np.sign(pc[d] - sma50[d]), "ymv": -s * (pc[d] - pc2[d]) / adr[d], "lvn": s * (lv - pc[d]) / adr[d]})
    X = X[(X.hit | X.brk) & (X.t >= rb_blocks.since(args, df))]
    m = (X.wt == 1) & (X["mod"] >= FROM) & (X["mod"] < TO) & X.sameday & (X.lvn.abs() <= rb_blocks.PRIME_NEAR)
    day, quiet = m & (X.ymv >= rb_blocks.PRIME_MOVE), m & (X.ymv.abs() < 0.4)
    print(f"{args.tfs[0]}-minute candles. Every level family graded on its own (not one block per level), on the trend's side, first touched")
    print("in the cash session, level within 0.40 ranges of yesterday's close.   PRIME days   |   quiet days (yesterday moved < 0.4)")
    print("  all families pooled               ", cell(X[day], mid), "  |  ", cell(X[quiet], mid))
    print("  levels that existed before 09:30  ", cell(X[day & X.pre], mid), "  |  ", cell(X[quiet & X.pre], mid))
    print("  levels made after 09:30           ", cell(X[day & ~X.pre], mid), "  |  ", cell(X[quiet & ~X.pre], mid))
    rows = [(100 * g.big.mean(), k, g) for k, g in X[day].groupby("fam") if len(g) >= args.min]
    print()
    for _, k, g in sorted(rows, key=lambda z: -z[0]):
        print(f"  {k:8s} {cell(g, mid)}  |  {cell(X[quiet & (X.fam == k)], mid)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["landscape", "grid", "where", "families"])
    ap.add_argument("--duka", help="directory of Dukascopy 1-minute day files")
    ap.add_argument("--cache", help="pickle of the decoded 1-minute frame")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--warm", type=int, default=110, help="days of data loaded before --start (for the 50-day average)")
    ap.add_argument("--tfs", type=int, nargs="+", default=[5], help="candle sizes in minutes (grid uses all, the others the first)")
    ap.add_argument("--scale", action="store_true", help="scale depth and reversal with price (same % move all history)")
    ap.add_argument("--split", default="20220101", help="the bracketed figures are before | after this date")
    ap.add_argument("--width", type=float, default=60.0)
    ap.add_argument("--target", type=float, default=100.0)
    ap.add_argument("--hit", type=float, default=45.0)
    ap.add_argument("--min", type=int, default=40, help="families: smallest family shown")
    args = ap.parse_args()
    if not (args.duka or args.cache):
        ap.error("need --duka or --cache")
    args.csv = None
    df = rb_blocks.load(args)
    globals()[f"cmd_{args.command}"](args, df, pd.Timestamp(args.split, tz="UTC"))


if __name__ == "__main__":
    main()
