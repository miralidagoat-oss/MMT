#!/usr/bin/env python3
"""Statement-by-statement Python transliteration of
indicators/mnq_reversal_blocks.pine, written from the Pine source and not
from rb_blocks.py, then compared block by block with the backtest engine.

Pine cannot be run here, so this is the check that the script's logic - the
order of its sections, every condition, every counter - grades each block
exactly as the backtest does. A mismatch means one of the two is wrong.

  python3 rb_pine_mirror.py --duka data/nq --start 20221109 --warm 120
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd

import rb_blocks

GAP_ADR, FAST_SIGMA, RSI_HOT = 0.3, 2.0, 75.0


class Block:
    def __init__(self, side, near, far, name, born):
        self.side, self.near, self.far, self.name, self.born = side, near, far, name, born
        self.state, self.turn, self.best, self.days, self.skip = 0, np.nan, 0.0, 0, False
        self.touch, self.hit, self.broken, self.big, self.expired = -1, False, False, False, False


def mirror(B, blockPts=60.0, hitPts=45.0, bigPts=100.0, trendOnly=True, useSkips=False,
           useAS=True, useGO=True, useMO=True, useLO=True, useOR=True, useRO=True, useIB=True, usePD=False, usePW=False):
    open_, high, low, close, mod_, td, wk = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"], B["wk"]
    n = len(open_)
    bigUse = max(bigPts, hitPts)

    # ── request.security(..., "D" / "W", x[1], lookahead_on): completed bars only
    starts = np.flatnonzero(np.r_[True, td[1:] != td[:-1]])
    ends = np.r_[starts[1:], n]
    didx = np.repeat(np.arange(len(starts)), ends - starts)
    H = np.array([high[a:b].max() for a, b in zip(starts, ends)])
    L = np.array([low[a:b].min() for a, b in zip(starts, ends)])
    C = np.array([close[b - 1] for b in ends])
    D = len(starts)
    pdH = np.r_[np.nan, H[:-1]]
    pdL = np.r_[np.nan, L[:-1]]
    pdC = np.r_[np.nan, C[:-1]]
    sma50 = pd.Series(C).rolling(50).mean().shift(1).values             # ta.sma(close, 50)[1]
    adr = pd.Series(H - L).rolling(14).mean().shift(1).values            # ta.sma(high - low, 14)[1]
    wkd = wk[starts]
    pwH, pwL = np.full(D, np.nan), np.full(D, np.nan)
    wH = wL = pH = pL = np.nan
    for d in range(D):
        if d > 0 and wkd[d] != wkd[d - 1]:
            pH, pL, wH, wL = wH, wL, np.nan, np.nan
        pwH[d], pwL[d] = pH, pL
        wH = H[d] if np.isnan(wH) else max(wH, H[d])
        wL = L[d] if np.isnan(wL) else min(wL, L[d])
    spd, fRsi = B["spd"], B["rsi"]                                        # the 5-minute features, as known before the candle

    live, done = [], []
    tl = dict(touched=0, hit=0, broken=0, expired=0, big=0, tTop=0, hTop=0, bTop=0, tBot=0, hBot=0, bBot=0,
              sTouched=0, sHit=0, sBroken=0, drawn=0)
    bests = []
    asH = asL = loH = loL = orH = orL = ibH = ibL = np.nan
    asDone = loDone = orDone = ibDone = True
    dayOpen = midOpen = rthOpen = gapADR = np.nan

    for i in range(n):
        d = didx[i]
        open, hi, lo, cl, mod = open_[i], high[i], low[i], close[i], mod_[i]
        bias = 0 if np.isnan(pdC[d]) or np.isnan(sma50[d]) or pdC[d] == sma50[d] else (1 if pdC[d] > sma50[d] else -1)
        newDay = i == 0 or td[i] != td[i - 1]
        rth = 570 <= mod < 1020

        def f_add(level, side, name):
            far = level + side * blockPts
            ok = (not np.isnan(level)) and side * (open - level) < 0 and not (trendOnly and (bias == 0 or side * bias > 0))
            if ok and len(live) > 0:
                for b in live:
                    if b.side == side and min(b.near, b.far) <= max(level, far) and max(b.near, b.far) >= min(level, far):
                        ok = False
            if ok:
                live.append(Block(side, level, far, name, i))
                tl["drawn"] += 1

        def f_addAuto(level, name):
            if not np.isnan(level) and open != level:
                f_add(level, 1 if open < level else -1, name)

        def f_why(s):
            ex = fRsi[i] if s > 0 else 100.0 - fRsi[i]
            if not useSkips:
                return ""
            if not np.isnan(gapADR) and s * gapADR > GAP_ADR:
                return "gap fade"
            if not np.isnan(spd[i]) and s * spd[i] > FAST_SIGMA:
                return "fast move"
            if not np.isnan(ex) and ex >= RSI_HOT:
                return "RSI stretched"
            return ""

        # ── 1. NEW TRADE DAY
        if newDay:
            for j in range(len(live) - 1, -1, -1):
                b = live[j]
                waiting = b.state == 0
                if not waiting:
                    b.days += 1
                expire = (not waiting) and b.days >= 2
                if expire and b.state == 1 and not b.skip:
                    tl["expired"] += 1
                    b.expired = True
                if expire and b.state == 2 and not b.skip:
                    bests.append(min(b.best, bigUse))
                if waiting or expire:
                    done.append(live.pop(j))
            asH = asL = loH = loL = orH = orL = ibH = ibL = np.nan
            asDone = loDone = orDone = ibDone = False
            dayOpen, midOpen, rthOpen, gapADR = open, np.nan, np.nan, np.nan
            if usePD:
                f_add(pdH[d], 1, "PD high")
                f_add(pdL[d], -1, "PD low")
            if usePW:
                f_add(pwH[d], 1, "PW high")
                f_add(pwL[d], -1, "PW low")

        # ── 2. SESSION BLOCKS
        if mod < 180 and np.isnan(midOpen):
            midOpen = open
        if 180 <= mod < 1020 and not asDone:
            asDone = True
            if useAS:
                f_add(asH, 1, "AS high")
                f_add(asL, -1, "AS low")
            if useGO:
                f_addAuto(dayOpen, "18:00 open")
            if useMO:
                f_addAuto(midOpen, "midnight open")
        if rth and not loDone:
            loDone = True
            rthOpen = open
            gapADR = np.nan if np.isnan(pdC[d]) or np.isnan(adr[d]) or adr[d] <= 0 else (open - pdC[d]) / adr[d]
            if useLO:
                f_add(loH, 1, "LO high")
                f_add(loL, -1, "LO low")
        if rth and mod >= 600 and not orDone:
            orDone = True
            if useOR:
                f_add(orH, 1, "OR high")
                f_add(orL, -1, "OR low")
            if useRO:
                f_addAuto(rthOpen, "09:30 open")
        if rth and mod >= 630 and not ibDone:
            ibDone = True
            if useIB:
                f_add(ibH, 1, "IB high")
                f_add(ibL, -1, "IB low")

        # ── 3. GRADE (every historical candle is confirmed)
        for j in range(len(live) - 1, -1, -1):
            b = live[j]
            s = b.side
            ext = hi if s > 0 else lo
            opp = lo if s > 0 else hi
            inside = s * (ext - b.near) >= 0
            why = f_why(s) if b.state == 0 and inside else ""
            first = False
            if b.state == 0 and inside:
                b.state, b.turn, first, b.touch = 1, ext, True, i
                if why == "":
                    tl["touched"] += 1
                    tl["tTop"] += 1 if s > 0 else 0
                    tl["tBot"] += 1 if s < 0 else 0
                if why != "":
                    b.skip = True
                    tl["sTouched"] += 1
            if b.state >= 1:
                beyond = s * (cl - b.far) > 0
                gone = False
                graded = not b.skip
                if beyond and b.state == 1 and graded:
                    tl["broken"] += 1
                    tl["bTop"] += 1 if s > 0 else 0
                    tl["bBot"] += 1 if s < 0 else 0
                if beyond and b.state == 1 and not graded:
                    tl["sBroken"] += 1
                if beyond and b.state == 1:
                    b.broken = True
                if beyond:
                    gone = True
                if not beyond:
                    newturn = ext if s * (ext - b.turn) > 0 else b.turn
                    if not first:
                        b.best = max(b.best, s * (b.turn - opp))
                    b.best = max(b.best, s * (newturn - cl))
                    b.turn = newturn
                    nowHit = b.state == 1 and b.best >= hitPts
                    nowBig = b.best >= bigUse
                    if nowHit:
                        b.state = 2
                        b.hit = True
                    if nowHit and graded:
                        tl["hit"] += 1
                        tl["hTop"] += 1 if s > 0 else 0
                        tl["hBot"] += 1 if s < 0 else 0
                    if nowHit and not graded:
                        tl["sHit"] += 1
                    if nowBig:
                        gone = True
                        b.big = True
                    if nowBig and graded:
                        tl["big"] += 1
                if gone and graded:
                    bests.append(min(b.best, bigUse))
                if gone:
                    done.append(live.pop(j))

        # ── 4. SESSION RANGES
        if mod >= 1080 or mod < 180:
            asH = hi if np.isnan(asH) else max(asH, hi)
            asL = lo if np.isnan(asL) else min(asL, lo)
        if 180 <= mod < 570:
            loH = hi if np.isnan(loH) else max(loH, hi)
            loL = lo if np.isnan(loL) else min(loL, lo)
        if 570 <= mod < 600:
            orH = hi if np.isnan(orH) else max(orH, hi)
            orL = lo if np.isnan(orL) else min(orL, lo)
        if 570 <= mod < 630:
            ibH = hi if np.isnan(ibH) else max(ibH, hi)
            ibL = lo if np.isnan(ibL) else min(ibL, lo)
    return done, tl, bests


def compare(B, trend, skips, t0, t1):
    """Every block touched in [t0, t1): outcome in the Pine mirror against the engine."""
    done, tl, _ = mirror(B, trendOnly=trend, useSkips=skips)
    recs, _ = rb_blocks.run(B, trend=trend, skips=skips)
    idx = B["index"]
    pine = {(b.touch, b.side, round(b.near, 4)): (b.hit, b.broken, b.big, b.skip) for b in done
            if b.touch >= 0 and t0 <= idx[b.touch] < t1}
    eng = {}
    for r in recs:
        if t0 <= idx[r["touch"]] < t1:
            hit = r["best"] >= r["hg"] - 1e-9
            eng[(r["touch"], r["side"], round(r["near"], 4))] = (hit, r["res"] == "broken" and not hit, r["res"] == "held", r["skip"] != "")
    both = set(pine) & set(eng)
    diff = [k for k in both if pine[k] != eng[k]]
    hits = sum(1 for k in both if pine[k][0] and not pine[k][3])
    broken = sum(1 for k in both if pine[k][1] and not pine[k][3])
    print(f"  trend {'on ' if trend else 'off'} skips {'on ' if skips else 'off'}: blocks in the Pine mirror {len(pine):5d}, in the engine {len(eng):5d}, "
          f"only in one {len(set(pine) ^ set(eng)):3d}, different outcome {len(diff):3d}   "
          f"(graded: {hits} hit, {broken} broken = {100.0 * hits / max(hits + broken, 1):.1f}%)")
    return len(set(pine) ^ set(eng)) + len(diff)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--duka")
    ap.add_argument("--cache")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--warm", type=int, default=120)
    ap.add_argument("--tfs", type=int, nargs="+", default=[5, 1])
    args = ap.parse_args()
    args.csv = None
    df = rb_blocks.load(args)
    t0 = pd.Timestamp(args.start, tz="UTC")
    t1 = df.index[-1] - pd.Timedelta(days=5)                 # blocks still live at the end of the data are in neither list
    bad = 0
    for tf in args.tfs:
        B = rb_blocks.prep(df, tf)
        print(f"{tf}-minute candles, blocks touched {t0.date()} -> {t1.date()}:")
        for trend, skips in ((True, False), (True, True), (False, False), (False, True)):
            bad += compare(B, trend, skips, t0, t1)
    print("PARITY OK: the Pine logic and the backtest engine grade every block identically" if bad == 0 else f"MISMATCHES: {bad}")


if __name__ == "__main__":
    main()
