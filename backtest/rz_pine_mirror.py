#!/usr/bin/env python3
"""Parity check: a statement-by-statement transliteration of
indicators/mnq_reversal_zones.pine, compared against rz_engine.py.

Pine cannot be compiled outside TradingView, so this file exists to prove the
indicator's LOGIC is the logic that was backtested: it walks the same bars
with the Pine script's own variable names, block order and scorecard
counters, and must reproduce the engine's tap / reclaim counts exactly.

Usage:
  python3 rz_pine_mirror.py duka <day_file_dir> [--start YYYYMMDD] [--end YYYYMMDD]
                                               [--trend-daily FILE] [--tf MIN]
  python3 rz_pine_mirror.py csv <bars.csv> --daily FILE [--trend-daily FILE]
"""
import argparse
import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # works under `python3 -I` too
import rz_data  # noqa: E402
import rz_engine  # noqa: E402

NA = float("nan")


def na(x):
    return x is None or (isinstance(x, float) and math.isnan(x))


class Zone:   # mirrors `type Zone` in the Pine script
    def __init__(self, fam, name, side, level, depth, target, adr, bornBar):
        self.fam, self.name, self.side, self.level = fam, name, side, level
        self.depth, self.target, self.adr, self.bornBar = depth, target, adr, bornBar
        self.tapBar, self.tapPrice, self.state = -1, NA, 0
        self.ext, self.rcState, self.rcBar, self.rcPrice, self.rcStop = NA, 0, -1, NA, NA


def pine(df, ctx, tf_sec=60, targetPts=100.0, depthAdr=0.06, maxMinutes=600, rcWindowMin=30,
         sweepMaxAdr=0.20, stopBufAdr=0.01, swingAdr=0.20, swingMaxMin=1440):
    GLOBEX_OPEN, ASIA_END, RTH_OPEN, OR_END, IB_END, AM_END, RTH_CLOSE = 1080, 180, 570, 600, 630, 720, 960
    O, H, L, C = (df[x].values.astype(float) for x in ("open", "high", "low", "close"))
    mins = df.mins.values.astype(int)
    td = df.trade_date.values
    maxBars = max(1, math.ceil(maxMinutes * 60.0 / tf_sec))
    winBars = max(1, math.ceil(rcWindowMin * 60.0 / tf_sec))
    swingAgeBars = max(1, math.ceil(swingMaxMin * 60.0 / tf_sec))

    live = []
    sN, sHit, sFail, sCh = [0] * 4, [0] * 4, [0] * 4, [0.0] * 4
    asH = asL = loH = loL = rthH = rthL = pdH = pdL = adr = NA
    trend = 0
    didAsia = didOpen = didOr = didIb = didAm = False
    dayCount = 0
    zzDir, zzHi, zzLo, zzHiBar, zzLoBar = 0, NA, NA, -1, -1
    pendSide, pendPrice = 0, NA
    events = []
    prevKey = None

    for bar_index in range(len(df)):
        open_, high, low, close = O[bar_index], H[bar_index], L[bar_index], C[bar_index]
        etMin = mins[bar_index]
        tradeKey = td[bar_index]
        newTradeDate = (prevKey is not None and tradeKey != prevKey) or bar_index == 0
        prevKey = tradeKey
        inAsia = etMin >= GLOBEX_OPEN or etMin < ASIA_END
        inLondon = ASIA_END <= etMin < RTH_OPEN
        inRth = RTH_OPEN <= etMin < RTH_CLOSE
        dayPart = etMin < GLOBEX_OPEN
        key = pd.Timestamp(tradeKey)
        row = ctx.loc[key] if key in ctx.index else None       # what request.security returns on this bar
        dAdr = float(row.adr) if row is not None else NA
        d5h = float(row.x5h) if row is not None else NA
        d5l = float(row.x5l) if row is not None else NA
        wHigh = float(row.pwh) if row is not None else NA
        wLow = float(row.pwl) if row is not None else NA
        dTrend = int(row.trend) if row is not None and not na(float(row.trend)) else 0

        def f_newZone(fam, name, side, level):
            ahead = (open_ < level) if side > 0 else (open_ > level)
            seen = dayCount >= (2 if fam == 3 else 1)
            dup = False
            for q in live:
                if q.state == 0 and q.side == side and q.level == level:
                    dup = True
                    break
            if seen and not dup and not na(level) and not na(adr) and ahead:
                live.append(Zone(fam, name, side, level, depthAdr * adr, targetPts, adr, bar_index))

        # 1) new trade date
        if newTradeDate:
            for i in range(len(live) - 1, -1, -1):
                z = live[i]
                if z.state == 0 and z.fam != 9:
                    live.pop(i)
            if bar_index > 0:
                dayCount += 1
            pdH, pdL = rthH, rthL
            asH = asL = loH = loL = rthH = rthL = NA
            didAsia = didOpen = didOr = didIb = didAm = False
            adr = dAdr
            trend = dTrend
            f_newZone(3, "PDH", 1, pdH)
            f_newZone(3, "PDL", -1, pdL)
            f_newZone(4, "5DH", 1, d5h)
            f_newZone(4, "5DL", -1, d5l)
            f_newZone(5, "PWH", 1, wHigh)
            f_newZone(5, "PWL", -1, wLow)

        # 2) session boundaries
        if not didAsia and not inAsia:
            didAsia = True
            f_newZone(2, "ASH", 1, asH)
            f_newZone(2, "ASL", -1, asL)
        if not didOpen and dayPart and etMin >= RTH_OPEN:
            didOpen = True
            onH = loH if na(asH) else asH if na(loH) else max(asH, loH)
            onL = loL if na(asL) else asL if na(loL) else min(asL, loL)
            f_newZone(0, "ONH", 1, onH)
            f_newZone(0, "ONL", -1, onL)
            f_newZone(1, "LOH", 1, loH)
            f_newZone(1, "LOL", -1, loL)
        if not didOr and dayPart and etMin >= OR_END:
            didOr = True
            f_newZone(6, "ORH", 1, rthH)
            f_newZone(6, "ORL", -1, rthL)
        if not didIb and dayPart and etMin >= IB_END:
            didIb = True
            f_newZone(7, "IBH", 1, rthH)
            f_newZone(7, "IBL", -1, rthL)
        if not didAm and dayPart and etMin >= AM_END:
            didAm = True
            f_newZone(8, "AMH", 1, rthH)
            f_newZone(8, "AML", -1, rthL)
        if pendSide != 0:
            f_newZone(9, "SWH" if pendSide > 0 else "SWL", pendSide, pendPrice)
            pendSide = 0

        # 3) zone engine
        for i in range(len(live) - 1, -1, -1):
            z = live[i]
            s = z.side
            far = z.level + s * z.depth
            beyondFar = (high > far) if s > 0 else (low < far)
            closedIn = (close < z.level) if s > 0 else (close > z.level)     # barstate.isconfirmed on history
            prevState, prevRc = z.state, z.rcState
            drop = False
            if z.state == 0:
                if z.fam == 9 and bar_index - z.bornBar > swingAgeBars:
                    drop = True
                else:
                    touched = (high >= z.level) if s > 0 else (low <= z.level)
                    if touched:
                        gapped = (open_ > z.level) if s > 0 else (open_ < z.level)
                        z.tapBar = bar_index
                        z.tapPrice = open_ if gapped else z.level
                        z.state = 3 if beyondFar else 1
                        z.ext = high if s > 0 else low
                        z.rcState = 6 if (s * (z.ext - z.level) > sweepMaxAdr * z.adr or closedIn) else 1
                        sN[0 if s > 0 else 1] += 1
            else:
                if z.state == 1:
                    fav = (z.tapPrice - low) if s > 0 else (high - z.tapPrice)
                    if beyondFar:
                        z.state = 3
                    elif fav >= z.target:
                        z.state = 2
                    elif bar_index - z.tapBar >= maxBars:
                        z.state = 4
                if z.rcState == 1:
                    z.ext = max(z.ext, high) if s > 0 else min(z.ext, low)
                    if bar_index - z.tapBar > winBars or s * (z.ext - z.level) > sweepMaxAdr * z.adr:
                        z.rcState = 6
                    elif closedIn:
                        z.rcState = 2
                        z.rcBar = bar_index
                        z.rcPrice = close
                        z.rcStop = z.ext + s * stopBufAdr * z.adr
                        sN[3 if s > 0 else 2] += 1
                        events.append(("reclaim", bar_index, z.name, s, z.rcPrice, z.rcStop))
                elif z.rcState == 2:
                    stopped = (high >= z.rcStop) if s > 0 else (low <= z.rcStop)
                    fav2 = (z.rcPrice - low) if s > 0 else (high - z.rcPrice)
                    if stopped:
                        z.rcState = 4
                    elif fav2 >= z.target:
                        z.rcState = 3
                    elif bar_index - z.rcBar >= maxBars:
                        z.rcState = 5
            if prevState <= 1 and z.state >= 2:
                r = 0 if s > 0 else 1
                if z.state == 2:
                    sHit[r] += 1
                    sCh[r] += z.depth / (z.target + z.depth)
                elif z.state == 3:
                    sFail[r] += 1
                    sCh[r] += z.depth / (z.target + z.depth)
            if prevRc == 2 and 3 <= z.rcState <= 5:
                rr = 3 if s > 0 else 2
                risk = abs(z.rcStop - z.rcPrice)
                if z.rcState == 3:
                    sHit[rr] += 1
                    sCh[rr] += risk / (z.target + risk)
                elif z.rcState == 4:
                    sFail[rr] += 1
                    sCh[rr] += risk / (z.target + risk)
            alive = z.state <= 1 or z.rcState == 1 or z.rcState == 2
            if drop or not alive:
                live.pop(i)

        # 4) session trackers
        if inAsia:
            asH = high if na(asH) else max(asH, high)
            asL = low if na(asL) else min(asL, low)
        elif inLondon:
            loH = high if na(loH) else max(loH, high)
            loL = low if na(loL) else min(loL, low)
        elif inRth:
            rthH = high if na(rthH) else max(rthH, high)
            rthL = low if na(rthL) else min(rthL, low)

        # 5) causal zigzag
        if not na(adr):
            thr = swingAdr * adr
            if zzHiBar < 0:
                zzHi, zzLo, zzHiBar, zzLoBar = high, low, bar_index, bar_index
            else:
                if zzDir >= 0 and high > zzHi:
                    zzHi, zzHiBar = high, bar_index
                if zzDir <= 0 and low < zzLo:
                    zzLo, zzLoBar = low, bar_index
                if zzDir >= 0 and zzHiBar < bar_index and zzHi - low >= thr:
                    pendSide, pendPrice, zzDir, zzLo, zzLoBar = 1, zzHi, -1, low, bar_index
                elif zzDir <= 0 and zzLoBar < bar_index and high - zzLo >= thr:
                    pendSide, pendPrice, zzDir, zzHi, zzHiBar = -1, zzLo, 1, high, bar_index
    return {"n": sN, "hit": sHit, "fail": sFail, "chance_sum": sCh, "events": events}


def engine_counts(df, ctx_kwargs, p, tf_min):
    fr = rz_engine.taps_frame(rz_engine.run(df, p, tf_min=tf_min, **ctx_kwargs), df)
    n, hit, fail = [0] * 4, [0] * 4, [0] * 4
    for r, (tier, side) in enumerate((("tap", 1), ("tap", -1), ("rc", -1), ("rc", 1))):
        f = fr[fr.side == side]
        if tier == "tap":
            n[r], hit[r], fail[r] = len(f), int((f.tap_result == "win").sum()), int((f.tap_result == "fail").sum())
        else:
            f = f[f.rc]
            n[r], hit[r], fail[r] = len(f), int((f.rc_result == "win").sum()), int((f.rc_result == "fail").sum())
    return {"n": n, "hit": hit, "fail": fail}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", choices=["duka", "csv"])
    ap.add_argument("path")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--daily")
    ap.add_argument("--trend-daily")
    ap.add_argument("--tf", type=int, default=1)
    a = ap.parse_args()
    if a.source == "duka":
        df = rz_data.load_duka(a.path, start=a.start, end=a.end)
    else:
        df, _ = rz_data.clean_yahoo(rz_data.load_csv(a.path))
    if a.tf > 1:
        df = rz_data.resample(df, a.tf)
    df = rz_engine.session_cols(df)
    p = rz_engine.Params()
    daily = rz_data.load_daily(a.daily) if a.daily else None
    trend = rz_engine.trend_from_closes(rz_data.load_daily(a.trend_daily).c, p.trend_len) if a.trend_daily else None
    ctx = rz_engine.daily_context(df, p.adr_len, daily, trend, p.trend_len)
    m = pine(df, ctx, tf_sec=60 * a.tf)
    e = engine_counts(df, {"daily": daily, "trend": trend}, p, a.tf)
    rows = ["taps top", "taps bottom", "reclaims bottom", "reclaims top"]
    print(f"bars {len(df):,}  trade dates {df.trade_date.nunique()}  tf {a.tf}m")
    print(f"{'':18s} {'pine n':>8s} {'eng n':>8s} {'pine ✓':>8s} {'eng ✓':>8s} {'pine ✗':>8s} {'eng ✗':>8s}")
    ok = True
    for r, name in enumerate(rows):
        same = m["n"][r] == e["n"][r] and m["hit"][r] == e["hit"][r] and m["fail"][r] == e["fail"][r]
        ok &= same
        print(f"{name:18s} {m['n'][r]:8d} {e['n'][r]:8d} {m['hit'][r]:8d} {e['hit'][r]:8d} {m['fail'][r]:8d} {e['fail'][r]:8d}"
              f"   {'match' if same else 'MISMATCH'}")
    print("PARITY OK - the Pine logic reproduces the backtested engine exactly" if ok else "PARITY FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
