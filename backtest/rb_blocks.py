#!/usr/bin/env python3
"""Reversal Blocks: backtest of indicators/mnq_reversal_blocks.pine on real
1-minute data, graded the way the blocks are meant to be read.

A BLOCK is a zone 60 points deep that starts at a level known in advance:
    AS   Asia session high / low, 18:00-03:00 ET (drawn at 03:00)
    GO   the 18:00 open price                    (drawn at 03:00)
    MO   the midnight open price                 (drawn at 03:00)
    LO   London session high / low, 03:00-09:30  (drawn at 09:30)
    OR   opening range high / low, 09:30-10:00   (drawn at 10:00)
    RO   the 09:30 open price                    (drawn at 10:00)
    IB   first-hour high / low, 09:30-10:30      (drawn at 10:30)
    PD / PW   prior day / prior week high and low (off by default)
The opens are support when price is above them and resistance when below.
A block is only drawn if price is still outside it, and not if it would
overlap a live block on the same side.

--trend    a block is drawn only with the daily trend behind it: support
           when the prior close is above its 50-day average, resistance when
           below (the shipped default of the indicator)

PRIME      the one kind of block that goes on to 100 points far more often
           than block size alone explains. All four things are known before
           price gets there:
             1. yesterday closed at least 0.75 average daily ranges away from
                the close before it, in the direction of the daily trend
                (a strong day with the trend)
             2. the block is on the trend's side and its level was made
                overnight: Asia or London session high / low, the 18:00 open
                or the midnight open
             3. that level is within 0.40 average daily ranges of yesterday's
                close
             4. the block is first touched in the cash session, 09:30-16:00 ET
           A block that meets 1-3 is a PRIME candidate from the moment it is
           drawn; it is graded as PRIME if its first touch comes in the cash
           session and as a standard block otherwise. rb_prime.py shows
           where the rule comes from and how it moves with its two sizes.

--skips    a block touched while fading the overnight gap (> 0.3 average
           daily ranges), a fast move (> 2 sigma over the last hour of
           5-minute candles) or an RSI(14) past 75 is skipped and graded
           separately (off by default in the indicator)

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
            win rate and average points per block (no costs)

The shipped configuration: the block types above, --trend, blocks 60 points
deep, a hit = a 45-point reversal, tracked on to 100 points, and STRICT
grading (a block breaks when any chart candle closes beyond it). --warm loads
that many days before --start so the 50-day average exists from the first
reported day. --scale keeps the sizes at the same % of price through a long
history. --brk and --hold reproduce the first version (a block breaks only on
a longer candle's close), which overstated the result.

  python3 rb_blocks.py run --duka data/nq --start 20221109 --warm 120 --trend --null 8
  python3 rb_blocks.py run --duka data/nq --start 20170301 --warm 110 --trend --scale
  python3 rb_blocks.py run --duka data/nq --start 20221109 --warm 120 --trend --tf 1
  python3 rb_blocks.py run --duka data/nq --start 20221109 --warm 120 --trend --skips
  python3 rb_blocks.py run --csv data/yahoo/MNQ_5m.csv --daily data/yahoo/MNQ_1d.csv --trend
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

FAMS = ("AS", "GO", "MO", "LO", "OR", "RO", "IB")    # "PD" and "PW" are available but off: they held least in every sample


def prep(df1m, tf, daily=None):
    """1-minute frame -> candle arrays, session clocks (America/New_York) and
    everything the indicator knows before a candle opens:
      trend   per trade day, (prior day's close, 50-day average of the closes
              through the prior day); `daily` (closes indexed by trade-day
              number) replaces the closes of the intraday data when the
              intraday history is too short for a 50-day average
      spd     the move over the last hour of completed 5-minute candles,
              in units of (average 5-minute range x sqrt(12))
      rsi     RSI(14) of completed 5-minute closes
    On charts above 5 minutes the chart's own candles are used for spd / rsi."""
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
    closes = last if daily is None else daily
    prev, avg = closes.shift(1), closes.shift(1).rolling(50).mean()
    trend = {int(k): (prev[k], avg[k]) for k in closes.index}
    prev2 = {int(k): v for k, v in closes.shift(2).items()}                  # the close before the prior close
    f = rz_data.resample(df1m, 5) if tf <= 5 else d                          # the feature candles
    hour = 12 if tf <= 5 else max(1, round(60 / tf))
    fc = f.close
    mv = (fc - fc.shift(hour)).shift(1).values
    ar = (f.high - f.low).rolling(100).mean().shift(1).values
    rs = pd.Series(rz_tiers.wilder(fc.values, 14)[2]).shift(1).values
    k = np.searchsorted(f.index.values, d.index.values, side="right") - 1    # the feature candle each chart candle sits in
    with np.errstate(divide="ignore", invalid="ignore"):
        spd = np.where(k >= 0, mv[k] / (ar[k] * np.sqrt(hour)), np.nan)
    rsi = np.where(k >= 0, rs[k], np.nan)
    return dict(o=d.open.values, h=d.high.values, l=d.low.values, c=d.close.values, v=d.volume.values, mod=mod, td=td, wk=wk,
                index=d.index, bounce=bounce, tf=tf, target=100.0, trend=trend, prev2=prev2, spd=spd, rsi=rsi)


GAP_ADR, FAST_SIGMA, RSI_HOT = 0.3, 2.0, 75.0               # the three skip conditions
PRIME_MOVE, PRIME_NEAR = 0.75, 0.40                         # yesterday's move with the trend / level to yesterday's close, in average daily ranges
PRIME_FAMS = ("AS", "GO", "MO", "LO")                       # levels made before the cash session opens
PRIME_FROM, PRIME_TO = 570, 960                             # first touch 09:30-16:00 New York


def run(B, width=60.0, front=0.0, target=100.0, fams=FAMS, ref=0.0, dyn=0.0, brk=0, hold=0.0, slack=0.55, hit=45.0,
        trend=False, skips=False, prime_move=PRIME_MOVE, prime_near=PRIME_NEAR, log=None):
    """Returns one record per TOUCHED block and the candle each drawn block was born on.
    ref > 0 scales width and target by (prior close / ref): the same move in
    percent of price on every day of the history. trend: a block is drawn
    only with the daily trend behind it (support when the prior close is above
    its 50-day average, resistance when below). skips: a block touched while
    fading the overnight gap, a fast move or a stretched RSI is marked skipped
    (it is still graded, separately). prime_move / prime_near: the two sizes
    of the PRIME rule (see the module text); `cand` marks a block that was a
    PRIME candidate when it was drawn, `prime` one whose first touch then came
    in the cash session. Every record also carries ymv (yesterday's move in
    average daily ranges, + = with the trend), lvn (the level's distance from
    yesterday's close in the same unit, + = beyond the close in the direction
    being faded), wt (+1 with the trend, -1 against) and tmod (minute of the
    touch). log: a dict that receives `cand`, the candle on which every PRIME
    candidate was drawn (touched or not). dyn / brk / hold / slack reproduce
    the earlier versions (volatility-sized depth, a longer break candle)."""
    o, h, l, c, mod, td, wk = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"], B["wk"]
    spd, rsi = B["spd"], B["rsi"]
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
    live, out, born = [], [], []
    dH = dL = pdH = pdL = wH = wL = pwH = pwL = np.nan
    asH = asL = loH = loL = orH = orL = ibH = ibL = dC = dO = rO = mO = np.nan
    as_done = lo_done = or_done = ib_done = True
    k = 1.0
    wd = width
    rng = []
    bias = 0                                                # +1 prior close above its 50-day average, -1 below, 0 unknown
    gap = np.nan                                            # (09:30 open - prior close) / average daily range, from 09:30 on
    ypc = adr = ymv = np.nan                                # prior close, average daily range, yesterday's move in daily ranges (+ = with the trend)

    def add(level, side, fam, i):
        if trend and (bias == 0 or side * bias > 0):        # with the trend: support in an uptrend, resistance in a downtrend
            return
        near = level - side * front * wd
        far = level + side * (1.0 - front) * wd
        if side * (o[i] - near) >= 0:                       # price is already at or inside the block
            return
        lo, hi = min(near, far), max(near, far)
        for b in live:
            if not b["res"] and b["side"] == side and min(b["near"], b["far"]) <= hi and max(b["near"], b["far"]) >= lo:
                return                                      # overlaps a live block on the same side
        born.append(i)
        cand = bool(ymv == ymv and ymv >= prime_move and fam in PRIME_FAMS and side * bias < 0
                    and abs(level - ypc) <= prime_near * adr)                       # a PRIME candidate, known as it is drawn
        if cand and log is not None:
            log.setdefault("cand", []).append(i)
        live.append(dict(side=side, fam=fam, near=near, far=far, born=i, touch=-1, turn=np.nan, days=0, tg=target * k, w=wd,
                         res="", res_i=-1, entry=np.nan, pnl=np.nan, tres="", best=0.0,
                         hg=hit * k, tres2="", pnl2=np.nan, skip="", dep=np.nan, hit_i=-1,
                         ymv=ymv, wt=-side * bias, lvn=side * (level - ypc) / adr if adr == adr and adr > 0 else np.nan,
                         tmod=-1, cand=cand, prime=False))

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
            pc, av = B["trend"].get(int(td[i]), (np.nan, np.nan))
            bias = 0 if np.isnan(pc) or np.isnan(av) or pc == av else (1 if pc > av else -1)
            gap = np.nan
            pc2 = B["prev2"].get(int(td[i]), np.nan)
            ypc = pc
            adr = float(np.mean(rng[-14:])) if len(rng) >= 14 else np.nan
            ymv = bias * (pc - pc2) / adr if bias != 0 and adr == adr and adr > 0 and pc2 == pc2 else np.nan
            dH = dL = np.nan
            dO, rO, mO = o[i], np.nan, np.nan
            asH = asL = loH = loL = orH = orL = ibH = ibL = np.nan
            as_done = lo_done = or_done = ib_done = False
            if "PD" in fams and not np.isnan(pdH):
                add(pdH, 1, "PD", i)
                add(pdL, -1, "PD", i)
            if "PW" in fams and not np.isnan(pwH):
                add(pwH, 1, "PW", i)
                add(pwL, -1, "PW", i)
        m = mod[i]
        rth = 570 <= m < 1020
        if m < 180 and np.isnan(mO):                        # the first candle after midnight
            mO = o[i]
        if 180 <= m < 1020 and not as_done:                 # ── 03:00: Asia range is complete
            as_done = True
            if "AS" in fams and not np.isnan(asH):
                add(asH, 1, "AS", i)
                add(asL, -1, "AS", i)
            if "GO" in fams:
                located(dO, "GO", i)
            if "MO" in fams:
                located(mO, "MO", i)
        if rth and not lo_done:                             # ── 09:30: London range is complete, the gap is known
            lo_done = True
            rO = o[i]
            pc = B["trend"].get(int(td[i]), (np.nan, np.nan))[0]
            if len(rng) >= 5 and not np.isnan(pc):
                gap = (rO - pc) / float(np.mean(rng[-14:]))
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
        if rth and m >= 630 and not ib_done:                # ── 10:30: the first hour is complete
            ib_done = True
            if "IB" in fams and not np.isnan(ibH):
                add(ibH, 1, "IB", i)
                add(ibL, -1, "IB", i)

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
                b["tmod"] = int(m)
                b["prime"] = bool(b["cand"] and PRIME_FROM <= m < PRIME_TO)         # first touch in the cash session
                b["entry"] = b["near"] if s * (o[i] - b["near"]) < 0 else o[i]
                if skips:                                   # judged on what was known before this candle
                    if s * gap > GAP_ADR:
                        b["skip"] = "gap"
                    elif s * spd[i] > FAST_SIGMA:
                        b["skip"] = "fast"
                    elif (rsi[i] if s > 0 else 100.0 - rsi[i]) >= RSI_HOT:
                        b["skip"] = "rsi"
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
                    if np.isnan(b["dep"]) and b["best"] >= b["hg"]:     # the hit: when, and how deep into the block the extreme is
                        b["dep"], b["hit_i"] = s * (newturn - b["near"]), i
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
        if 570 <= m < 630:
            ibH = h[i] if np.isnan(ibH) else max(ibH, h[i])
            ibL = l[i] if np.isnan(ibL) else min(ibL, l[i])
    return out, born


def frame(recs, B):
    if not recs:
        return pd.DataFrame(columns=["side", "fam", "res", "tres", "tres2", "pnl", "pnl2", "t", "year", "mins", "best", "tg", "hg",
                                     "tg0", "w", "bounce", "skip", "dep", "hit_i", "hmins", "ymv", "wt", "lvn", "tmod", "cand", "prime"])
    f = pd.DataFrame(recs)
    f["t"] = B["index"][f.touch.values]
    f["year"] = f.t.dt.tz_convert("America/New_York").dt.year
    f["mins"] = (B["index"][f.res_i.values] - f.t).dt.total_seconds() / 60.0
    f["hmins"] = np.where(f.hit_i.values >= 0, (f.hit_i.values - f.touch.values) * B["tf"], np.nan)
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
    BROKEN = a break candle closed beyond it first. 100+ = it went on to the full target.
    win / pts: the hit trade (fade the edge for the hit size); win100 / pts100: the
    same trade held for the full target. Both exit on the break close."""
    hit = f.best >= f.hg - 1e-9
    broken = (f.res == "broken") & ~hit
    opn = (f.res == "open") & ~hit
    big = f.res == "held"
    graded = max(int(hit.sum() + broken.sum()), 1)
    return dict(n=len(f), hit=int(hit.sum()), broken=int(broken.sum()), open=int(opn.sum()), graded=int(hit.sum() + broken.sum()),
                bign=int(big.sum()), rate=100.0 * hit.sum() / graded, big=100.0 * big.sum() / graded,
                hbig=100.0 * (big & hit).sum() / max(int(hit.sum()), 1),
                win=100.0 * (f.tres2 == "win").sum() / max((f.tres2 != "open").sum(), 1),
                pts=f.pnl2.mean() if len(f) else np.nan,
                win100=100.0 * (f.tres == "win").sum() / max((f.tres != "open").sum(), 1),
                pts100=f.pnl.mean() if len(f) else np.nan)


def rate_at(f, x):
    """Hit rate if the hit were a reversal of x points (x at the reference price in scaled runs)."""
    need = x * f.tg / f.tg0
    hit = f.best >= need - 1e-9
    broken = (f.res == "broken") & ~hit
    return 100.0 * hit.sum() / max(int(hit.sum() + broken.sum()), 1)


def load(args):
    """The 1-minute frame, starting `--warm` days before --start so the 50-day average exists on the first reported day."""
    warm = getattr(args, "warm", 0)
    if args.csv:
        df, _ = rz_data.clean_yahoo(rz_data.load_csv(args.csv))
        return df
    if args.cache and os.path.exists(args.cache):
        df = pickle.load(open(args.cache, "rb"))
    else:
        first = (pd.Timestamp(args.start) - pd.Timedelta(days=warm)).strftime("%Y%m%d") if args.start else None
        df = rz_data.load_duka(args.duka, first, args.end)
        if args.cache:
            pickle.dump(df, open(args.cache, "wb"))
    if args.start:
        df = df[df.index >= pd.Timestamp(args.start, tz="UTC") - pd.Timedelta(days=warm)]
    if args.end:
        df = df[df.index < pd.Timestamp(args.end, tz="UTC")]
    return df


SKIP_NAMES = {"gap": "fading the overnight gap", "fast": "fading a fast move", "rsi": "RSI stretched into the block"}


def groups_of(fa, cut):
    """Graded blocks (not skipped) by period, side, type and year; then the blocks skipped at the touch."""
    f = fa[fa["skip"] == ""]
    g = [("ALL", f), ("LAST 4 YEARS", f[f.t >= cut]), ("EARLIER", f[f.t < cut]),
         ("resistance blocks (tops)", f[f.side > 0]), ("support blocks (bottoms)", f[f.side < 0]),
         ("support, bounce session", f[(f.side < 0) & f.bounce]), ("resistance, bounce session", f[(f.side > 0) & f.bounce])]
    g += [(f"  {k} blocks", f[f.fam == k]) for k in sorted(f.fam.unique())] + [(f"  {y}", f[f.year == y]) for y in sorted(f.year.unique())]
    g += prime_groups(f, cut)
    sk = fa[fa["skip"] != ""]
    if len(sk):
        g += [("SKIPPED at the touch", sk)] + [(f"  {SKIP_NAMES[k]}", sk[sk["skip"] == k]) for k in ("gap", "fast", "rsi")]
    return g


def prime_groups(f, cut):
    """PRIME blocks by period, side and year, and everything that is not PRIME."""
    p = f[f.prime.astype(bool)]
    g = [("PRIME blocks", p), ("PRIME, last 4 years", p[p.t >= cut]), ("PRIME, earlier", p[p.t < cut]),
         ("PRIME resistance (tops)", p[p.side > 0]), ("PRIME support (bottoms)", p[p.side < 0])]
    g += [(f"  PRIME {y}", p[p.year == y]) for y in sorted(p.year.unique())]
    return g + [("standard blocks (not PRIME)", f[~f.prime.astype(bool)])]


def null_stats(df, args, cut):
    """The same blocks on direction-scrambled copies: one {group: stats} per copy."""
    rows = []
    for s in range(args.null):
        Bn = prep(rz_null.scramble(df, 500 + s), args.tf)
        fn = frame(run(Bn, **run_args(Bn, args))[0], Bn)
        fn = fn[fn.t >= since(args, df)]
        rows.append({name: stats(g) for name, g in groups_of(fn, cut) if len(g)})
    return rows


def ref_of(B, args):
    return float(B["c"][-1]) if args.scale else 0.0


def run_args(B, args, **over):
    kw = dict(width=args.width, front=args.front, target=args.target, ref=ref_of(B, args), dyn=args.dyn, brk=args.brk, hold=args.hold,
              slack=args.slack, fams=tuple(args.fams), hit=args.hit, trend=args.trend, skips=args.skips,
              prime_move=args.prime_move, prime_near=args.prime_near)
    kw.update(over)
    return kw


def since(args, df):
    """First reported moment: --start (the data before it is warm-up)."""
    return pd.Timestamp(args.start, tz="UTC") if args.start and not args.csv else df.index[0]


def daily_closes(path):
    """Closes of a Yahoo daily CSV indexed by trade-day number (for the 50-day average when the intraday file is short)."""
    x = pd.read_csv(path)
    days = pd.to_datetime(x.time, unit="s").dt.normalize().values.astype("datetime64[D]").astype(np.int64)
    return pd.Series(x.close.values, index=days).groupby(level=0).last()


def cmd_run(args):
    df = load(args)
    B = prep(df, args.tf, daily_closes(args.daily) if args.daily else None)
    log = {}
    recs, born = run(B, log=log, **run_args(B, args))
    t0 = since(args, df)
    fa = frame(recs, B)
    fa = fa[fa.t >= t0]
    f = fa[fa["skip"] == ""]
    drawn = int((B["index"][born] >= t0).sum()) if len(born) else 0
    cands = int((B["index"][log.get("cand", [])] >= t0).sum()) if log.get("cand") else 0
    if args.trend:
        print("TREND: a block is drawn only with the daily trend behind it (support above the 50-day average, resistance below)")
    if args.skips:
        print(f"SKIPS: a block touched while fading the overnight gap (> {GAP_ADR} daily ranges), a fast move (> {FAST_SIGMA:.0f} sigma in the last "
              f"hour) or an RSI(14) past {RSI_HOT:.0f} is skipped and graded separately")
    if args.dyn:
        print(f"AUTO SIZE: {args.dyn:.2f} x the 14-day average daily range, kept inside 10-60 points")
    if args.hold:
        print(f"CALCULATED DEPTH: -reversal x ln(1 - {args.hold:.2f}) - {args.slack:.2f} x average break-candle range, kept inside 10-60 points")
    if args.scale:
        print(f"SCALED: depth and reversal are {args.width:.0f} / {args.target:.0f} points at {B['c'][-1]:,.0f} and the same % of price before")
    days = len(np.unique(B["td"][np.asarray(B["index"] >= t0)]))
    cut = pd.Timestamp(df.index[-1]) - pd.DateOffset(years=4)
    print(f"{t0.date()} -> {df.index[-1].date()}: {days} trade days, {args.tf}-minute candles, "
          f"blocks {fa.w.mean() if len(fa) else args.width:.0f} pts deep on average, reversal = {args.target:.0f} pts; "
          f"'last 4 years' starts {cut.date()}")
    print(f"blocks drawn {drawn} ({drawn / days:.1f} a day), touched {len(fa)} ({len(fa) / days:.1f} a day), "
          f"of which skipped at the touch {len(fa) - len(f)}; a break = a {max(args.brk, args.tf)}-minute candle closing beyond the block")
    npr = int(fa.prime.astype(bool).sum()) if len(fa) else 0
    print(f"PRIME: yesterday moved {args.prime_move:.2f}+ average daily ranges with the daily trend; a block on the trend's side at an overnight level "
          f"(AS, LO, 18:00 open, midnight open) within {args.prime_near:.2f} ranges of yesterday's close; first touch 09:30-16:00 ET")
    print(f"PRIME candidates drawn {cands} ({cands * 252.0 / days:.0f} a year), of which first touched in the cash session {npr} "
          f"({npr * 252.0 / days:.0f} a year)")
    nulls = null_stats(df, args, cut) if args.null else []
    print(f"HIT = a reversal of {args.hit:.0f} pts from the extreme made at the block, before any break candle closes beyond it")
    print(f"\n{'':30s} {'touched':>7s} {'hit':>6s} {'broken':>6s} {'open':>5s} {'HIT RATE':>10s} {'chance':>8s} {'z':>5s} {'to ' + format(args.target, '.0f') + '+':>8s}   {'hit trade: win':>15s} {'pts / block':>12s}")
    for name, g in groups_of(fa, cut):
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
        tg = f"{args.target:.0f}+"
        print(f"\nWENT ON TO {tg} (share of graded blocks), and two simple fades of the block's edge: take {args.hit:.0f} or {args.target:.0f} pts, "
              f"exit when a candle closes beyond the block (no costs)")
        print(f"{'':30s} {'graded':>7s} {'to ' + tg:>8s} {'chance':>8s} {'z':>5s}   {'for ' + format(args.hit, '.0f') + ': win':>12s} {'pts / block':>13s}   "
              f"{'for ' + format(args.target, '.0f') + ': win':>13s} {'pts / block':>13s}")
        for name, g in groups_of(fa, cut):
            if not len(g) or not (name in ("ALL", "LAST 4 YEARS", "EARLIER") or "PRIME" in name):
                continue
            s = stats(g)
            num = sum(x[name]["bign"] for x in nulls if name in x)
            den = sum(x[name]["graded"] for x in nulls if name in x)
            r = np.array([x[name]["big"] for x in nulls if name in x and x[name]["graded"] > 0])
            ch = (f"{100.0 * num / den:7.1f}% {(s['big'] - 100.0 * num / den) / r.std():+5.1f}" if den > 0 and len(r) > 1 and r.std() > 0
                  else f"{'':8s} {'':5s}")
            se2 = g.pnl2.std(ddof=1) / np.sqrt(len(g)) if len(g) > 1 else np.nan
            se1 = g.pnl.std(ddof=1) / np.sqrt(len(g)) if len(g) > 1 else np.nan
            print(f"{name:30s} {s['graded']:7d} {s['big']:7.1f}% {ch}   {s['win']:11.1f}% {s['pts']:+8.1f} ±{se2:4.1f}   "
                  f"{s['win100']:12.1f}% {s['pts100']:+8.1f} ±{se1:4.1f}")
        if nulls:
            print(f"chance = the same rule on {len(nulls)} direction-scrambled copies (all copies pooled); z = distance from chance in "
                  f"standard deviations of one copy")
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
            recs, born = run(B, **run_args(B, args, width=width or 60.0, front=front, dyn=dyn))
            drawn = len(born)
            g = frame(recs, B)
            g = g[g["skip"] == ""]
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
    ap.add_argument("--prime-move", type=float, default=PRIME_MOVE, help="PRIME: yesterday's move with the trend, in average daily ranges")
    ap.add_argument("--prime-near", type=float, default=PRIME_NEAR, help="PRIME: the level's distance from yesterday's close, in average daily ranges")
    ap.add_argument("--ladder", type=float, nargs="+", default=[40, 45, 50, 55, 60, 75, 100])
    ap.add_argument("--brk", type=int, default=0, help="break candle in minutes (0 = the chart candle)")
    ap.add_argument("--hold", type=float, default=0.0, help="calculated depth: target hold rate, e.g. 0.70 (0 = off)")
    ap.add_argument("--slack", type=float, default=0.55, help="calculated depth: share of the break candle's average range that wicks absorb")
    ap.add_argument("--fams", nargs="+", default=list(FAMS), help="block types to draw: PD PW AS GO MO LO OR RO IB")
    ap.add_argument("--trend", action="store_true", help="draw a block only with the daily trend behind it")
    ap.add_argument("--skips", action="store_true", help="skip blocks touched while fading the gap, a fast move or a stretched RSI")
    ap.add_argument("--warm", type=int, default=0, help="days of data loaded before --start (for the 50-day average)")
    ap.add_argument("--daily", help="Yahoo daily CSV whose closes give the 50-day average (short intraday files)")
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
