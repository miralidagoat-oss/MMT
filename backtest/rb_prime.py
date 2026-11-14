#!/usr/bin/env python3
"""Where the PRIME rule of indicators/mnq_reversal_blocks.pine comes from, and
how much it depends on its sizes.

PRIME: the day after a strong day with the daily trend (yesterday's close at
least 0.75 average daily ranges from the close before it, in the direction of
the trend), a block on the trend's side at an overnight level (Asia / London
session high or low, the 18:00 open, the midnight open) that sits on the FAR
side of yesterday's close by no more than 0.40 average daily ranges (below it
for support, above it for resistance), first touched in the cash session
(09:30-16:00 ET). Everything is known before price gets there. Grade A is a
PRIME block first touched 09:30-10:00, grade B one first touched later.

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
  grid       the sizes of the rule swept, on each candle size in --tfs
  where      PRIME-day overnight blocks by where the level sits against
             yesterday's close (near side, far side, how far), by the hour of
             the touch, by block type, year and side, and the controls
  charts     the rule on each candle size in --tfs: the break rule is "a
             candle of the chart closes beyond the block", so the chart matters
  families   about ninety kinds of level (rb_hunt.events, each graded on its
             own) on PRIME days: is it the overnight levels, or any level in
             that place? Arbitrary levels are the control. Also the near side
             against the far side of yesterday's close, and whether a bigger
             move yesterday adds anything, on this wider population.

  python3 rb_prime.py landscape --duka data/nq --start 20170301 --warm 110 --scale
  python3 rb_prime.py grid      --duka data/nq --start 20170301 --warm 110 --scale --tfs 5 1 15
  python3 rb_prime.py where     --duka data/nq --start 20170301 --warm 110 --scale
  python3 rb_prime.py charts    --duka data/nq --start 20170301 --warm 110 --scale --tfs 1 3 5 10 15 30 60
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
FROM, TO, A_TO = rb_blocks.PRIME_FROM, rb_blocks.PRIME_TO, rb_blocks.PRIME_A_TO
MOVE, NEAR = rb_blocks.PRIME_MOVE, rb_blocks.PRIME_NEAR


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


def place(f, move=MOVE, near=NEAR):
    """The PRIME rule as a mask on an engine frame."""
    return (f.wt == 1) & f.ovn & f.cash & (f.ymv >= move) & (f.lvn > 0) & (f.lvn <= near)


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
    for name, m in (("the PRIME place: overnight level on the trend's side, on the far side of yesterday's close by 0 .. 0.40, cash session",
                     (f.wt == 1) & f.ovn & f.cash & (f.lvn > 0) & (f.lvn <= NEAR)),
                    ("the same on the NEAR side of yesterday's close (0 .. 0.40)", (f.wt == 1) & f.ovn & f.cash & (f.lvn <= 0) & (f.lvn >= -NEAR))):
        print(f"\n{name}\n  yesterday's move in average daily ranges (+ = with the trend)")
        for a, b in zip(edges[:-1], edges[1:]):
            print(f"  {a:5.2f} .. {b:5.2f}   {cell(f[m & (f.ymv > a) & (f.ymv <= b)], mid)}")


def cmd_grid(args, df, mid):
    F = {tf: engine_frame(df, tf, args) for tf in args.tfs}
    print("PRIME with other sizes: yesterday's move with the trend >= MOVE, level on the far side of yesterday's close by 0 .. NEAR")
    print("cells: blocks, went on to 100+ [before | after " + str(mid.date()) + "]")
    print(f"{'MOVE':>5s} {'NEAR':>5s}   " + "   ".join(f"{str(tf) + '-minute candles':^26s}" for tf in F))
    for mv in (0.5, 0.6, 0.75, 0.9, 1.0, 1.25):
        for nr in (0.25, 0.3, 0.4, 0.5, 0.6, 99.0):
            row = []
            for f in F.values():
                g = f[place(f, mv, nr)]
                a, b = g[g.t < mid], g[g.t >= mid]
                row.append(f"n{len(g):4d} {100 * g.big.mean():5.1f}% [{100 * a.big.mean():4.0f} |{100 * b.big.mean():4.0f} ]")
            print(f"{mv:5.2f} {'none' if nr > 9 else format(nr, '.2f'):>5s}   " + "   ".join(row))
        print()
    print("the near side included as well (level within NEAR of yesterday's close on either side), MOVE 0.75")
    for nr in (0.25, 0.4, 0.6):
        row = []
        for f in F.values():
            g = f[(f.wt == 1) & f.ovn & f.cash & (f.ymv >= MOVE) & (f.lvn.abs() <= nr)]
            a, b = g[g.t < mid], g[g.t >= mid]
            row.append(f"n{len(g):4d} {100 * g.big.mean():5.1f}% [{100 * a.big.mean():4.0f} |{100 * b.big.mean():4.0f} ]")
        print(f"{'':5s} {nr:5.2f}   " + "   ".join(row))
    print("\nfirst touch between 09:30 and ... (MOVE 0.75, NEAR 0.40)")
    for end in (660, 720, 840, 960, 1020):
        row = []
        for f in F.values():
            g = f[(f.wt == 1) & f.ovn & (f.tmod >= FROM) & (f.tmod < end) & (f.ymv >= MOVE) & (f.lvn > 0) & (f.lvn <= NEAR)]
            row.append(f"n{len(g):4d} {100 * g.big.mean():5.1f}%{'':13s}")
        print(f"      {end // 60:02d}:{end % 60:02d}   " + "   ".join(row))


def cmd_where(args, df, mid):
    f = engine_frame(df, args.tfs[0], args)
    day = f[(f.wt == 1) & f.ovn & f.cash & (f.ymv >= MOVE)]
    p = f[place(f)]
    print(f"{args.tfs[0]}-minute candles. PRIME days, overnight blocks on the trend's side, first touched in the cash session:")
    print("  all of them                              ", cell(day, mid))
    print("  PRIME (far side of the close, 0 .. 0.40) ", cell(p, mid))
    print("\nby where the level sits against yesterday's close, in average daily ranges")
    print("(+ = the far side: below the close for support, above it for resistance; - = the near side)")
    edges = [-9, -0.4, -0.2, 0.0, 0.1, 0.25, 0.4, 0.6, 9]
    for a, b in zip(edges[:-1], edges[1:]):
        print(f"  {a:5.2f} .. {b:5.2f}   {cell(day[(day.lvn > a) & (day.lvn <= b)], mid)}")
    print("\nPRIME by the hour of the first touch")
    for a, b in ((570, 600), (600, 660), (660, 720), (720, 840), (840, 960)):
        print(f"  {a // 60:02d}:{a % 60:02d}-{b // 60:02d}:{b % 60:02d}   {cell(p[(p.tmod >= a) & (p.tmod < b)], mid)}")
    a, b = p[p.tmod < A_TO], p[p.tmod >= A_TO]
    print("\ngrade A (first touch 09:30-10:00)   ", cell(a, mid))
    print("grade B (first touch 10:00-16:00)   ", cell(b, mid))
    print("grade A by year: " + "  ".join(f"{y}: {100 * g.big.mean():.0f}% (n{len(g)})" for y, g in a.groupby("year")))
    print("first touch before ...  " + "   ".join(f"{e // 60:02d}:{e % 60:02d}: {100 * p[p.tmod < e].big.mean():.1f}% (n{(p.tmod < e).sum()})"
                                                  for e in (585, 600, 615, 630, 660, 720)))
    print("\nPRIME by block type")
    for k, g in p.groupby("fam"):
        print(f"  {k:12s}  {cell(g, mid)}   grade A: {cell(g[g.tmod < A_TO], mid)}")
    print("\nPRIME by side")
    for k, g in p.groupby("side"):
        print(f"  {'resistance' if k > 0 else 'support':12s}  {cell(g, mid)}   grade A: {cell(g[g.tmod < A_TO], mid)}")
    print("\nPRIME by year: " + "  ".join(f"{y}: {100 * g.big.mean():.0f}% (n{len(g)})" for y, g in p.groupby("year")))
    days = p.t.dt.tz_convert("America/New_York").dt.date
    print(f"{len(p)} PRIME blocks on {days.nunique()} days")
    print("\ncontrols (overnight levels, first touched in the cash session unless said otherwise)")
    far = f.ovn & f.cash & (f.lvn > 0) & (f.lvn <= NEAR)
    near = f.ovn & f.cash & (f.wt == 1) & (f.ymv >= MOVE) & (f.lvn <= 0) & (f.lvn >= -NEAR)
    print("  PRIME days, trend's side, NEAR side of the close (0 .. 0.40)       ", cell(f[near], mid))
    print("     ... first touched 09:30-10:00                                   ", cell(f[near & (f.tmod < A_TO)], mid))
    print("     ... first touched 10:00-16:00                                   ", cell(f[near & (f.tmod >= A_TO)], mid))
    print("  every overnight block on the trend's side, any day, 09:30-10:00    ", cell(f[f.ovn & f.cash & (f.wt == 1) & (f.tmod < A_TO)], mid))
    print("  every overnight block on the trend's side, any day, 10:00-16:00    ", cell(f[f.ovn & f.cash & (f.wt == 1) & (f.tmod >= A_TO)], mid))
    print("  PRIME days, trend's side, further than 0.40 beyond the close       ",
          cell(f[f.ovn & f.cash & (f.wt == 1) & (f.ymv >= MOVE) & (f.lvn > NEAR)], mid))
    print("  PRIME place, block AGAINST the trend's side, same days             ", cell(f[far & (f.wt == -1) & (f.ymv >= MOVE)], mid))
    print("  PRIME place, trend's side, quiet yesterday (< 0.4 either way)      ", cell(f[far & (f.wt == 1) & (f.ymv.abs() < 0.4)], mid))
    print("  PRIME place, trend's side, yesterday 0.4 - 0.75 with the trend     ", cell(f[far & (f.wt == 1) & (f.ymv >= 0.4) & (f.ymv < MOVE)], mid))
    print("  PRIME place, trend's side, yesterday 0.75+ AGAINST the trend       ", cell(f[far & (f.wt == 1) & (f.ymv <= -MOVE)], mid))
    print("  PRIME candidates first touched BEFORE 09:30                        ",
          cell(f[f.ovn & (f.tmod < FROM) & (f.wt == 1) & (f.ymv >= MOVE) & (f.lvn > 0) & (f.lvn <= NEAR)], mid))
    print("  PRIME days, levels made in the cash session (OR, 09:30 open, IB)   ", cell(f[~f.ovn & (f.wt == 1) & (f.ymv >= MOVE)], mid))
    print("  every block on the trend's side that is not PRIME                  ", cell(f[(f.wt == 1) & ~place(f)], mid))


def cmd_charts(args, df, mid):
    print("the same rule on different chart candles (a block breaks when a candle of the chart closes beyond it)")
    print("PRIME / grade A / grade B: blocks, hit rate, went on to 100+ [before | after the split]; then the simple fade of a grade A edge")
    for tf in args.tfs:
        f = engine_frame(df, tf, args)
        allb, p = f[f.wt == 1], f[place(f)]
        a, b = p[p.tmod < A_TO], p[p.tmod >= A_TO]
        done = a[a.tres2 != "open"]
        loss = a[a.tres2 == "loss"]
        print(f"{tf:3d}-min  all blocks on the trend's side {len(allb):5d} {100 * allb.big.mean():5.1f}%")
        print(f"         PRIME    {cell(p, mid)}")
        print(f"         grade A  {cell(a, mid)}   take 45 pts from the edge, exit on the break close: win {100 * (done.tres2 == 'win').mean():5.1f}%  "
              f"{a.pnl2.mean():+6.1f} ±{a.pnl2.std(ddof=1) / np.sqrt(len(a)):4.1f} pts a block, a loss averages {-loss.pnl2.mean():4.0f}")
        print(f"         grade B  {cell(b, mid)}")


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
    X = X[(X.hit | X.brk) & (X.t >= rb_blocks.since(args, df))].copy()
    X["day"] = X.t.dt.tz_convert("America/New_York").dt.date
    side = (X.wt == 1) & (X["mod"] >= FROM) & (X["mod"] < TO) & X.sameday
    m = side & (X.lvn > 0) & (X.lvn <= NEAR)
    day, quiet = m & (X.ymv >= MOVE), m & (X.ymv.abs() < 0.4)
    print(f"{args.tfs[0]}-minute candles. Every level family graded on its own (not one block per level), on the trend's side, first touched")
    print("in the cash session, level on the far side of yesterday's close by 0 .. 0.40.   PRIME days   |   quiet days (yesterday moved < 0.4)")
    print("  all families pooled               ", cell(X[day], mid), "  |  ", cell(X[quiet], mid))
    print("  levels that existed before 09:30  ", cell(X[day & X.pre], mid), "  |  ", cell(X[quiet & X.pre], mid))
    print("  levels made after 09:30           ", cell(X[day & ~X.pre], mid), "  |  ", cell(X[quiet & ~X.pre], mid))
    rows = [(100 * g.big.mean(), k, g) for k, g in X[day].groupby("fam") if len(g) >= args.min]
    print()
    for _, k, g in sorted(rows, key=lambda z: -z[0]):
        print(f"  {k:8s} {cell(g, mid)}  |  {cell(X[quiet & (X.fam == k)], mid)}")
    P = X[side & X.pre]
    print("\nlevels that existed before 09:30, by where the level sits against yesterday's close (+ = far side)")
    print(f"{'':20s} {'PRIME days (0.75+)':52s} | quiet days")
    for a, b in ((-0.4, -0.2), (-0.2, 0.0), (0.0, 0.1), (0.1, 0.2), (0.2, 0.3), (0.3, 0.4), (0.4, 0.6), (0.6, 9)):
        band = (P.lvn > a) & (P.lvn <= b)
        print(f"  {a:5.2f} .. {b:5.2f}     {cell(P[band & (P.ymv >= MOVE)], mid):52s} | {cell(P[band & (P.ymv.abs() < 0.4)], mid)}")
    print(f"  near side 0 .. 0.40  {cell(P[(P.lvn <= 0) & (P.lvn >= -NEAR) & (P.ymv >= MOVE)], mid)}")
    print(f"  far side 0 .. 0.40   {cell(P[(P.lvn > 0) & (P.lvn <= NEAR) & (P.ymv >= MOVE)], mid)}")
    print("\nlevels that existed before 09:30 on PRIME days: the opening half hour against the rest of the session")
    print("(events, and one vote per day: the first of those levels touched that day in that window)")
    D, Q = P[P.ymv >= MOVE], P[P.ymv.abs() < 0.4]
    for sn, lo, hi in (("far side 0 .. 0.40 ", 0.0, NEAR), ("near side 0 .. 0.40", -NEAR - 1e-12, 0.0), ("beyond 0.40        ", NEAR, 99.0)):
        for tn, t0, t1 in (("09:30-10:00", FROM, A_TO), ("10:00-16:00", A_TO, TO)):
            g = D[(D.lvn > lo) & (D.lvn <= hi) & (D["mod"] >= t0) & (D["mod"] < t1)]
            q = Q[(Q.lvn > lo) & (Q.lvn <= hi) & (Q["mod"] >= t0) & (Q["mod"] < t1)]
            first = g.sort_values("t").groupby("day").big.first()
            print(f"  {sn}  {tn}   {cell(g, mid)}   first level: {len(first):4d} days, {100 * first.mean():5.1f}%   |   quiet days: "
                  f"{len(q):5d}  100+ {100 * q.big.mean():5.1f}%")
    print("\nfar side 0 .. 0.40, levels that existed before 09:30: does a bigger move yesterday add more?")
    print("(events, and one vote per day: the first of those levels touched that day)")
    G = P[(P.lvn > 0) & (P.lvn <= NEAR)]
    for x in (0.5, 0.6, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5):
        g = G[G.ymv >= x]
        first = g.sort_values("t").groupby("day").big.first()
        print(f"  {x:4.2f}+   {cell(g, mid)}   first level of the day: {len(first):4d} days, {100 * first.mean():5.1f}%")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["landscape", "grid", "where", "charts", "families"])
    ap.add_argument("--duka", help="directory of Dukascopy 1-minute day files")
    ap.add_argument("--cache", help="pickle of the decoded 1-minute frame")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--warm", type=int, default=110, help="days of data loaded before --start (for the 50-day average)")
    ap.add_argument("--tfs", type=int, nargs="+", default=[5], help="candle sizes in minutes (grid and charts use all, the others the first)")
    ap.add_argument("--scale", action="store_true", help="scale depth and reversal with price (same % move all history)")
    ap.add_argument("--split", default="20221109", help="the bracketed figures are before | after this date")
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
