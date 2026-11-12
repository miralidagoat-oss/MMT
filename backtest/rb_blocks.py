#!/usr/bin/env python3
"""Reversal Blocks: backtest of indicators/mnq_reversal_blocks.pine on real
1-minute data, graded the way the blocks are meant to be read.

A BLOCK is a wide zone drawn around a level that is known in advance:
    PD   prior trade day's high / low            (drawn at the 18:00 ET open)
    AS   Asia session high / low, 18:00-03:00 ET (drawn at 03:00)
    GO   the 18:00 open price                    (drawn at 03:00)
    LO   London session high / low, 03:00-09:30  (drawn at 09:30)
    OR   opening range high / low, 09:30-10:00   (drawn at 10:00)
    RO   the 09:30 open price                    (drawn at 10:00)
    PW   prior week's high / low                 (off by default)
GO and RO are support when price is above them and resistance when below.
A block starts at the level and extends `width` points beyond it. A block is
only drawn if price is still outside it, and not if it would overlap a live
block on the same side.

Grading, on chart candles (default 5-minute):
    TOUCH   a candle trades into the block
    HIT     after the touch, price reverses `hit` points (default 45) from
            the extreme it made at the block
    100+    it goes on to reverse `target` points (default 100)
    BROKEN  a candle CLOSES beyond the far side of the block before the hit
            (a wick through the block is not a break; a candle that closes
            beyond the block breaks it whatever its wick did)
    OPEN    neither by the end of the next trade day
Hit rate = HIT / (HIT + BROKEN).

Two more numbers keep the hit rate honest:
    chance  the same blocks on direction-scrambled copies of the data
            (rz_null.py): what block size alone gives, with no skill
    hit trade  sell / buy the first touch of the block's front edge, take
            `hit` points, exit when a candle closes beyond the far side:
            win rate and average points per block

The shipped configuration is the default: blocks 60 points deep, a hit = a
45-point reversal, tracked on to 100 points, and STRICT grading (a block
breaks when any chart candle closes beyond it). --scale keeps the sizes at
the same % of price through a long history. --brk and --hold reproduce the
first version (a block breaks only on a longer candle's close; depth
calculated for a target hold rate), which overstated the result.

  python3 rb_blocks.py run   --duka data/nq --start 20221109 --null 8
  python3 rb_blocks.py run   --duka data/nq --start 20161110 --scale
  python3 rb_blocks.py run   --duka data/nq --start 20221109 --tf 1
  python3 rb_blocks.py sweep --duka data/nq --start 20221109 --tfs 5 15 60
  python3 rb_blocks.py run   --csv data/yahoo/MNQ_5m.csv
"""
import argparse
import os
import pickle
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd

import rz_data
import rz_null

import rz_tiers

FAMS = ("PD", "AS", "LO", "OR", "GO", "RO")          # "PW" is available but off: it held least in every sample


def prep(df1m, tf):
    """1-minute frame -> candle arrays + session clocks (America/New_York)."""
    d = rz_data.resample(df1m, tf) if tf > 1 else df1m
    et = d.index.tz_convert("America/New_York")
    mod = (et.hour * 60 + et.minute).values
    day = (et + pd.Timedelta(hours=6)).normalize()          # 18:00 ET starts the next trade day
    td = (day.tz_localize(None).values.astype("datetime64[D]")).astype(np.int64)
    wk = (td + 3) // 7                                      # weeks start on Monday's trade day
    last = pd.Series(d.close.values, index=td).groupby(level=0).last()       # trade-day closes
    _, _, r2 = rz_tiers.wilder(last.values, 2)
    down = np.r_[False, np.diff(last.values) < 0]
    streak = np.zeros(len(last), int)
    for k in range(1, len(last)):
        streak[k] = streak[k - 1] + 1 if down[k] else 0
    exh = (r2 < rz_tiers.RSI_STD) | (streak >= rz_tiers.STREAK)              # standard exhaustion close
    bounce = dict(zip(last.index[1:], exh[:-1]))                             # the session after it
    return dict(o=d.open.values, h=d.high.values, l=d.low.values, c=d.close.values, v=d.volume.values, mod=mod, td=td, wk=wk,
                index=d.index, bounce=bounce, tf=tf, target=100.0)


def run(B, width=60.0, front=0.0, target=100.0, fams=FAMS, ref=0.0, dyn=0.0, brk=0, hold=0.0, slack=0.55, hit=45.0):
    """Returns one record per TOUCHED block and the number of blocks drawn.
    ref > 0 scales width and target by (prior close / ref): the same move in
    percent of price on every day of the history. dyn > 0 sizes each day's
    blocks from volatility instead: dyn x the 14-day average daily range,
    kept inside 10-60 points. brk > candle size: a block breaks only when a
    candle of `brk` minutes closes beyond it (candles counted from the 18:00
    ET open, as TradingView builds them); everything else stays on the
    chart candles."""
    o, h, l, c, mod, td, wk = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"], B["wk"]
    n = len(o)
    last = np.ones(n, bool)                                 # candles that complete a break-timeframe candle
    if brk > B["tf"]:
        bucket = ((mod - 1080) % 1440) // brk
        last[:-1] = (bucket[1:] != bucket[:-1]) | (td[1:] != td[:-1])
    vol = {}                                                # average break-candle range, prior 5 trade days
    if hold > 0:
        bk = max(brk, B["tf"])
        g = pd.DataFrame({"td": td, "b": ((mod - 1080) % 1440) // bk, "h": h, "l": l}).groupby(["td", "b"]).agg(h=("h", "max"), l=("l", "min"))
        d = (g.h - g.l).groupby(level=0).agg(["sum", "count"]).rolling(5).sum().shift(1)
        vol = (d["sum"] / d["count"]).dropna().to_dict()
    live, out = [], []
    drawn = 0
    dH = dL = pdH = pdL = wH = wL = pwH = pwL = np.nan
    asH = asL = loH = loL = orH = orL = dC = dO = rO = np.nan
    as_done = lo_done = or_done = True
    k = 1.0
    wd = width
    rng = []

    def add(level, side, fam, i):
        nonlocal drawn
        near = level - side * front * wd
        far = level + side * (1.0 - front) * wd
        if side * (o[i] - near) >= 0:                       # price is already at or inside the block
            return
        lo, hi = min(near, far), max(near, far)
        for b in live:
            if not b["res"] and b["side"] == side and min(b["near"], b["far"]) <= hi and max(b["near"], b["far"]) >= lo:
                return                                      # overlaps a live block on the same side
        drawn += 1
        live.append(dict(side=side, fam=fam, near=near, far=far, born=i, touch=-1, turn=np.nan, days=0, tg=target * k, w=wd,
                         res="", res_i=-1, entry=np.nan, pnl=np.nan, tres="", best=0.0,
                         hg=hit * k, tres2="", pnl2=np.nan))

    def located(level, fam, i):                             # support if price is above the level, resistance if below
        if not np.isnan(level) and o[i] != level:
            add(level, 1 if o[i] < level else -1, fam, i)

    for i in range(n):
        if i == 0 or td[i] != td[i - 1]:                    # ── new trade day
            keep = []
            for b in live:
                if b["touch"] < 0:
                    continue                                # untouched blocks are redrawn from fresh levels
                b["days"] += 1
                if b["days"] >= 2:                          # touched, unresolved through the next trade day
                    if not b["res"]:
                        b["res"], b["res_i"] = "open", i - 1
                    if not b["tres"]:
                        b["tres"], b["pnl"] = "open", b["side"] * (b["entry"] - c[i - 1])
                    if not b["tres2"]:
                        b["tres2"], b["pnl2"] = "open", b["side"] * (b["entry"] - c[i - 1])
                    out.append(b)
                else:
                    keep.append(b)
            live = keep
            if i > 0:
                pdH, pdL = dH, dL
                if wk[i] != wk[i - 1]:
                    pwH, pwL = wH, wL
                    wH = wL = np.nan
            if ref > 0 and not np.isnan(dC):
                k = dC / ref
            if not np.isnan(dH):
                rng.append(dH - dL)
            wd = width * k
            if dyn > 0 and len(rng) >= 5:
                wd = min(max(dyn * float(np.mean(rng[-14:])), 10.0 * k), 60.0 * k)
            if hold > 0 and td[i] in vol:                   # depth needed for the target hold rate, capped
                wd = min(max(-target * k * np.log(1.0 - hold) - slack * vol[td[i]], 10.0 * k), 60.0 * k)
            dH = dL = np.nan
            dO, rO = o[i], np.nan
            asH = asL = loH = loL = orH = orL = np.nan
            as_done = lo_done = or_done = False
            if "PD" in fams and not np.isnan(pdH):
                add(pdH, 1, "PD", i)
                add(pdL, -1, "PD", i)
            if "PW" in fams and not np.isnan(pwH):
                add(pwH, 1, "PW", i)
                add(pwL, -1, "PW", i)
        m = mod[i]
        rth = 570 <= m < 1020
        if 180 <= m < 1020 and not as_done:                 # ── 03:00: Asia range is complete
            as_done = True
            if "AS" in fams and not np.isnan(asH):
                add(asH, 1, "AS", i)
                add(asL, -1, "AS", i)
            if "GO" in fams:
                located(dO, "GO", i)
        if rth and not lo_done:                             # ── 09:30: London range is complete
            lo_done = True
            rO = o[i]
            if "LO" in fams and not np.isnan(loH):
                add(loH, 1, "LO", i)
                add(loL, -1, "LO", i)
        if rth and m >= 600 and not or_done:                # ── 10:00: opening range is complete
            or_done = True
            if "OR" in fams and not np.isnan(orH):
                add(orH, 1, "OR", i)
                add(orL, -1, "OR", i)
            if "RO" in fams:
                located(rO, "RO", i)

        keep = []
        for b in live:                                      # ── grade
            s, tgt = b["side"], b["tg"]
            ext, opp = (h[i], l[i]) if s > 0 else (l[i], h[i])
            first = False
            if b["touch"] < 0:
                if s * (ext - b["near"]) < 0:
                    keep.append(b)
                    continue
                b["touch"], b["turn"], first = i, ext, True
                b["entry"] = b["near"] if s * (o[i] - b["near"]) < 0 else o[i]
            broke = last[i] and s * (c[i] - b["far"]) > 0
            if not b["res"]:                                # the block itself: reversal from the turn
                newturn = ext if s * (ext - b["turn"]) > 0 else b["turn"]
                if broke:                                   # a close beyond the block ends it, whatever the wick did
                    b["res"], b["res_i"] = "broken", i
                else:
                    if not first:                           # the extreme was made on an earlier candle
                        b["best"] = max(b["best"], s * (b["turn"] - opp))
                    if s * (c[i] - b["far"]) <= 0:          # this candle's own extreme, confirmed by its close
                        b["best"] = max(b["best"], s * (newturn - c[i]))
                    if b["best"] >= tgt:
                        b["res"], b["res_i"] = "held", i
                b["turn"] = newturn
            if not b["tres"]:                               # the edge trade: +tgt from the front edge
                if not first and s * (b["entry"] - opp) >= tgt:
                    b["tres"], b["pnl"] = "win", tgt
                elif broke:
                    b["tres"], b["pnl"] = "loss", s * (b["entry"] - c[i])
                elif s * (b["entry"] - c[i]) >= tgt:
                    b["tres"], b["pnl"] = "win", tgt
            if not b["tres2"]:                              # the hit trade: +hit size from the front edge
                if not first and s * (b["entry"] - opp) >= b["hg"]:
                    b["tres2"], b["pnl2"] = "win", b["hg"]
                elif broke:
                    b["tres2"], b["pnl2"] = "loss", s * (b["entry"] - c[i])
                elif s * (b["entry"] - c[i]) >= b["hg"]:
                    b["tres2"], b["pnl2"] = "win", b["hg"]
            if b["res"] and b["tres"] and b["tres2"]:
                out.append(b)
            else:
                keep.append(b)
        live = keep

        dH = h[i] if np.isnan(dH) else max(dH, h[i])        # ── levels, updated after the bar
        dL = l[i] if np.isnan(dL) else min(dL, l[i])
        wH = h[i] if np.isnan(wH) else max(wH, h[i])
        wL = l[i] if np.isnan(wL) else min(wL, l[i])
        dC = c[i]
        if m >= 1080 or m < 180:
            asH = h[i] if np.isnan(asH) else max(asH, h[i])
            asL = l[i] if np.isnan(asL) else min(asL, l[i])
        if 180 <= m < 570:
            loH = h[i] if np.isnan(loH) else max(loH, h[i])
            loL = l[i] if np.isnan(loL) else min(loL, l[i])
        if 570 <= m < 600:
            orH = h[i] if np.isnan(orH) else max(orH, h[i])
            orL = l[i] if np.isnan(orL) else min(orL, l[i])
    return out, drawn


def frame(recs, B):
    if not recs:
        return pd.DataFrame(columns=["side", "fam", "res", "tres", "pnl", "t", "year", "mins"])
    f = pd.DataFrame(recs)
    f["t"] = B["index"][f.touch.values]
    f["year"] = f.t.dt.tz_convert("America/New_York").dt.year
    f["mins"] = (B["index"][f.res_i.values] - f.t).dt.total_seconds() / 60.0
    f["tg0"] = B.get("target", 100.0)
    f["bounce"] = [bool(B["bounce"].get(x, False)) for x in B["td"][f.touch.values]]
    f["pnl"] = f.pnl * target_scale(f)
    f["pnl2"] = f.pnl2 * target_scale(f)
    return f


def target_scale(f):
    """Points per block are reported in units of a 100-point target, so scaled histories stay comparable."""
    return 100.0 / f.tg


def stats(f):
    """HIT = the block gave a reversal of the hit size before any break candle closed beyond it.
    BROKEN = a break candle closed beyond it first. 100+ = it went on to the full target."""
    hit = f.best >= f.hg - 1e-9
    broken = (f.res == "broken") & ~hit
    opn = (f.res == "open") & ~hit
    graded = max(int(hit.sum() + broken.sum()), 1)
    return dict(n=len(f), hit=int(hit.sum()), broken=int(broken.sum()), open=int(opn.sum()),
                rate=100.0 * hit.sum() / graded, big=100.0 * (f.res == "held").sum() / graded,
                win=100.0 * (f.tres2 == "win").sum() / max((f.tres2 != "open").sum(), 1),
                pts=f.pnl2.mean() if len(f) else np.nan)


def rate_at(f, x):
    """Hit rate if the hit were a reversal of x points (x at the reference price in scaled runs)."""
    need = x * f.tg / f.tg0
    hit = f.best >= need - 1e-9
    broken = (f.res == "broken") & ~hit
    return 100.0 * hit.sum() / max(int(hit.sum() + broken.sum()), 1)


def load(args):
    if args.csv:
        df, _ = rz_data.clean_yahoo(rz_data.load_csv(args.csv))
        return df
    if args.cache and os.path.exists(args.cache):
        df = pickle.load(open(args.cache, "rb"))
    else:
        df = rz_data.load_duka(args.duka, args.start, args.end)
        if args.cache:
            pickle.dump(df, open(args.cache, "wb"))
    if args.start:
        df = df[df.index >= pd.Timestamp(args.start, tz="UTC")]
    if args.end:
        df = df[df.index < pd.Timestamp(args.end, tz="UTC")]
    return df


def groups_of(f, cut):
    g = [("ALL", f), ("LAST 4 YEARS", f[f.t >= cut]), ("EARLIER", f[f.t < cut]),
         ("resistance blocks (tops)", f[f.side > 0]), ("support blocks (bottoms)", f[f.side < 0]),
         ("support, bounce session", f[(f.side < 0) & f.bounce]), ("resistance, bounce session", f[(f.side > 0) & f.bounce])]
    g += [(f"  {k} blocks", f[f.fam == k]) for k in sorted(f.fam.unique())] + [(f"  {y}", f[f.year == y]) for y in sorted(f.year.unique())]
    return g


def null_stats(df, args, cut):
    """The same blocks on direction-scrambled copies: one {group: stats} per copy."""
    rows = []
    for s in range(args.null):
        Bn = prep(rz_null.scramble(df, 500 + s), args.tf)
        fn = frame(run(Bn, args.width, args.front, args.target, ref=ref_of(Bn, args), dyn=args.dyn, brk=args.brk, hold=args.hold, slack=args.slack, fams=tuple(args.fams), hit=args.hit)[0], Bn)
        rows.append({name: stats(g) for name, g in groups_of(fn, cut) if len(g)})
    return rows


def ref_of(B, args):
    return float(B["c"][-1]) if args.scale else 0.0


def cmd_run(args):
    df = load(args)
    B = prep(df, args.tf)
    recs, drawn = run(B, args.width, args.front, args.target, ref=ref_of(B, args), dyn=args.dyn, brk=args.brk, hold=args.hold, slack=args.slack, fams=tuple(args.fams), hit=args.hit)
    f = frame(recs, B)
    if args.dyn:
        print(f"AUTO SIZE: {args.dyn:.2f} x the 14-day average daily range, kept inside 10-60 points")
    if args.hold:
        print(f"CALCULATED DEPTH: -reversal x ln(1 - {args.hold:.2f}) - {args.slack:.2f} x average break-candle range, kept inside 10-60 points")
    if args.scale:
        print(f"SCALED: depth and reversal are {args.width:.0f} / {args.target:.0f} points at {B['c'][-1]:,.0f} and the same % of price before")
    days = len(np.unique(B["td"]))
    cut = pd.Timestamp(df.index[-1]) - pd.DateOffset(years=4)
    print(f"{df.index[0].date()} -> {df.index[-1].date()}: {days} trade days, {args.tf}-minute candles, "
          f"blocks {f.w.mean() if len(recs) else args.width:.0f} pts deep on average, reversal = {args.target:.0f} pts; "
          f"'last 4 years' starts {cut.date()}")
    print(f"blocks drawn {drawn} ({drawn / days:.1f} a day), touched {len(f)} ({len(f) / days:.1f} a day); "
          f"a break = a {max(args.brk, args.tf)}-minute candle closing beyond the block")
    nulls = null_stats(df, args, cut) if args.null else []
    print(f"HIT = a reversal of {args.hit:.0f} pts from the extreme made at the block, before any break candle closes beyond it")
    print(f"\n{'':30s} {'touched':>7s} {'hit':>6s} {'broken':>6s} {'open':>5s} {'HIT RATE':>10s} {'chance':>8s} {'z':>5s} {'to ' + format(args.target, '.0f') + '+':>8s}   {'hit trade: win':>15s} {'pts / block':>12s}")
    for name, g in groups_of(f, cut):
        if not len(g):
            continue
        s = stats(g)
        se = g.pnl2.std(ddof=1) / np.sqrt(len(g)) if len(g) > 1 else np.nan
        r = np.array([x[name]["rate"] for x in nulls if name in x])
        ch = f"{r.mean():7.1f}% {(s['rate'] - r.mean()) / r.std():+5.1f}" if len(r) > 1 and r.std() > 0 else f"{'':8s} {'':5s}"
        print(f"{name:30s} {s['n']:7d} {s['hit']:6d} {s['broken']:6d} {s['open']:5d} {s['rate']:9.1f}% {ch} {s['big']:7.1f}%   {s['win']:14.1f}% "
              f"{s['pts']:+8.1f} ±{se:4.1f}")
    if nulls:
        p = np.array([x["ALL"]["pts"] for x in nulls])
        w = np.array([x["ALL"]["win"] for x in nulls])
        print(f"\nchance = the same blocks on {len(nulls)} direction-scrambled copies; hit trade on those: win {w.mean():.1f}%, "
              f"{p.mean():+.1f} ± {p.std():.1f} pts / block")
    if len(f):
        print("\nhit rate if the hit were a reversal of at least ... points:  "
              + "   ".join(f"{x:.0f}: {rate_at(f, x):.1f}%" for x in args.ladder))
        done = f[f.res != "open"]
        frac = np.minimum(done.best / done.tg, 1.0) * args.target
        print(f"7 in 10 blocks reversed at least {np.percentile(frac, 30):.0f} pts before a close through")
        loss = f[f.tres2 == "loss"]
        if len(loss):
            print(f"the hit trade (fade the first touch of the block's edge for {args.hit:.0f} pts, exit on the break close): "
                  f"a loss averages {-loss.pnl2.mean():.0f} pts")
    if args.save:
        f.drop(columns=["turn"]).to_csv(args.save, index=False)


def cmd_sweep(args):
    df = load(args)
    days = None
    print(f"{df.index[0].date()} -> {df.index[-1].date()}, reversal = {args.target:.0f} pts")
    print(f"{'tf':>3s} {'size':>9s} {'front':>6s} {'drawn/day':>9s} {'touched/day':>11s} {'HIT RATE':>10s} {'trade win':>9s} {'pts/block':>10s}")
    for tf in args.tfs:
        B = prep(df, tf)
        days = len(np.unique(B["td"]))
        cells = [(w, fr, 0.0) for w in args.widths for fr in args.fronts] + [(0.0, fr, d) for d in args.dyns for fr in args.fronts]
        for width, front, dyn in cells:
            recs, drawn = run(B, width or 60.0, front, args.target, ref=ref_of(B, args), dyn=dyn, brk=args.brk, hold=args.hold, slack=args.slack, fams=tuple(args.fams), hit=args.hit)
            g = frame(recs, B)
            s = stats(g)
            name = f"{width:.0f}" if not dyn else f"auto {dyn:.2f}"
            print(f"{tf:3d} {name:>9s} {front:6.2f} {drawn / days:9.1f} {s['n'] / days:11.1f} {s['rate']:9.1f}% {s['win']:8.1f}% {s['pts']:+10.1f}"
                  + (f"   (average size {g.w.mean():.0f})" if dyn else ""), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["run", "sweep"])
    ap.add_argument("--duka", help="directory of Dukascopy 1-minute day files")
    ap.add_argument("--csv", help="a Yahoo 1-minute CSV (real MNQ=F)")
    ap.add_argument("--cache", help="pickle of the decoded 1-minute frame")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--tf", type=int, default=5, help="candle size in minutes")
    ap.add_argument("--width", type=float, default=60.0)
    ap.add_argument("--front", type=float, default=0.0)
    ap.add_argument("--dyn", type=float, default=0.0, help="auto size: this x the 14-day average daily range, inside 10-60")
    ap.add_argument("--widths", type=float, nargs="+", default=[10, 20, 30, 40, 50, 60])
    ap.add_argument("--fronts", type=float, nargs="+", default=[0.0, 0.5])
    ap.add_argument("--dyns", type=float, nargs="+", default=[0.10, 0.15, 0.20])
    ap.add_argument("--target", type=float, default=100.0, help="the full reversal a block is tracked to")
    ap.add_argument("--hit", type=float, default=45.0, help="the reversal that counts as a hit")
    ap.add_argument("--ladder", type=float, nargs="+", default=[40, 45, 50, 55, 60, 75, 100])
    ap.add_argument("--brk", type=int, default=0, help="break candle in minutes (0 = the chart candle)")
    ap.add_argument("--hold", type=float, default=0.0, help="calculated depth: target hold rate, e.g. 0.70 (0 = off)")
    ap.add_argument("--slack", type=float, default=0.55, help="calculated depth: share of the break candle's average range that wicks absorb")
    ap.add_argument("--fams", nargs="+", default=list(FAMS), help="block types to draw")
    ap.add_argument("--null", type=int, default=0)
    ap.add_argument("--scale", action="store_true", help="scale width and target with price (same % move all history)")
    ap.add_argument("--save")
    ap.add_argument("--tfs", type=int, nargs="+", default=[5, 15], help="candle sizes for the sweep")
    args = ap.parse_args()
    if not (args.duka or args.csv or args.cache):
        ap.error("need --duka, --cache or --csv")
    globals()[f"cmd_{args.command}"](args)


if __name__ == "__main__":
    main()
