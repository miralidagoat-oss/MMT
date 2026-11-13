#!/usr/bin/env python3
"""What has the highest probability of a reversal? About eighty kinds of level
and a dozen conditions around the touch, all graded by the same STRICT rules
as indicators/mnq_reversal_blocks.pine on real 1-minute data:

    block   60 points deep, starting at the level
    HIT     price reverses 45 points from the extreme made at the block
    100+    it goes on to reverse 100 points
    BROKEN  a candle of the chart CLOSES beyond the far side before the hit

`chance` is the same level type on direction-scrambled copies of the data
(rz_null.py): what block depth, reversal size and candle size give with no
directional structure at all. A level type is only interesting if it beats
chance, in both halves of the sample.

Level types (beyond the prior day's high and low)
  extremes   D3 D5 D10 D20 (multi-day), PW CW (prior / current week), PM CM
             (month), RD (prior cash session), AS LO ON (Asia, London,
             overnight), OR5 OR15 OR30 IB (opening ranges), AM LUNCH
  opens      GO (18:00), MO (midnight), O830, RO (09:30), WO (week)
  closes / mids   PDC, PDM, ONM, IBM, PWM
  pivots     PP R1 R2 R3 (floor pivots, R = S mirrored), CAM3 CAM4 (Camarilla)
  fibs       F38 (the 38.2 / 61.8% retracements of the prior day), F79 (21.4 /
             78.6%), X27 X62 (extensions beyond the prior day's range)
  ranges     IBX05 IBX10, ORX10 (range extensions), ADR05 ... ADR15 (the 09:30
             open +/- 0.5 to 1.5 average daily ranges), GADR075 GADR10 GADR15
             (from the 18:00 open), CADR05 CADR10 CADR15 (from the prior
             close), WADR05 WADR10 (the week's open +/- average weekly
             ranges), EM05 EM10 (VXN-implied daily move from the prior close)
  averages   SMA20 SMA50 SMA200, BB (daily Bollinger band, 20 / 2)
  profile    TPOC TVAH TVAL (time at price, prior day), VPOC VVAH VVAL (volume)
  VWAP       VW1 VW2 VW3 (session VWAP +/- 1, 2, 3 sigma), RVW1 RVW2 RVW3
             (09:30-anchored), VWAP / RVWAP (return to VWAP from 1 sigma away)
  structure  SW1h SW2h SW4h (swing highs / lows), EQ (equal highs / lows),
             OTE62 OTE79 (retracement of the last swing leg), OB, OBF (order
             block whose displacement left a gap), FVG, SWOB SWFVG (order
             block / gap formed right after a sweep of the 24-hour high or
             low), RND100 ... RND1000
  RANDOM     arbitrary levels 0.2-1.0 average daily ranges from the open

  python3 rb_hunt.py levels     --duka data/nq --start 20221109 --null 6
  python3 rb_hunt.py conditions --duka data/nq --start 20221109 --null 6
  python3 rb_hunt.py combo      --duka data/nq --start 20161110 --scale --null 0
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from numba import njit

import rb_blocks
import rb_zoo
import rz_null

EXTREMES = ("PD", "RD", "D3", "D5", "D10", "D20", "PW", "CW", "PM", "CM", "AS", "LO", "ON", "OR5", "OR15", "OR30", "IB", "AM",
            "LUNCH", "GO", "MO", "O830", "RO", "WO")


@njit(cache=True)
def vwap_scan(o, h, l, c, w, td, mod, anchor, warm, cool):
    """Session VWAP and its sigma as known BEFORE each candle, plus touch events
    (index, level, side, kind): kind 0 = return to VWAP after closing 1 sigma
    away, kind k = first touch of the +/- k sigma band. anchor < 0: the 18:00
    open; otherwise the first candle at or after that minute of the day."""
    n = len(o)
    vw = np.full(n, np.nan)
    sd = np.full(n, np.nan)
    ei = np.empty(n * 4, np.int64)
    el = np.empty(n * 4)
    es = np.empty(n * 4, np.int64)
    ek = np.empty(n * 4, np.int64)
    m = 0
    sw = spw = sp2 = 0.0
    cnt = 0
    on = False
    arm_up = arm_dn = False
    last = np.full(8, -10 ** 9)
    for i in range(n):
        newday = i == 0 or td[i] != td[i - 1]
        if newday:
            on = anchor < 0
            sw = spw = sp2 = 0.0
            cnt = 0
            arm_up = arm_dn = False
        if anchor >= 0 and not on and anchor <= mod[i] < 1020:
            on = True
            sw = spw = sp2 = 0.0
            cnt = 0
            arm_up = arm_dn = False
        if on and cnt >= warm and sw > 0:
            a = spw / sw
            s = np.sqrt(max(sp2 / sw - a * a, 0.0))
            vw[i], sd[i] = a, s
            if s > 0:
                for k in range(1, 4):
                    ub, lb = a + k * s, a - k * s
                    if o[i] < ub <= h[i] and i - last[k] >= cool:
                        ei[m], el[m], es[m], ek[m] = i, ub, 1, k
                        m += 1
                        last[k] = i
                    if o[i] > lb >= l[i] and i - last[k + 3] >= cool:
                        ei[m], el[m], es[m], ek[m] = i, lb, -1, k
                        m += 1
                        last[k + 3] = i
                if arm_up and o[i] > a >= l[i]:
                    ei[m], el[m], es[m], ek[m] = i, a, -1, 0
                    m += 1
                    arm_up = False
                if arm_dn and o[i] < a <= h[i]:
                    ei[m], el[m], es[m], ek[m] = i, a, 1, 0
                    m += 1
                    arm_dn = False
        if on:
            tp = (h[i] + l[i] + c[i]) / 3.0
            sw += w[i]
            spw += w[i] * tp
            sp2 += w[i] * tp * tp
            cnt += 1
            if cnt >= warm and sw > 0:
                a = spw / sw
                s = np.sqrt(max(sp2 / sw - a * a, 0.0))
                if c[i] > a + s:
                    arm_up = True
                if c[i] < a - s:
                    arm_dn = True
    return vw, sd, ei[:m], el[:m], es[:m], ek[:m]


def profile(lo, hi, w, bs):
    """Price-by-weight profile of one day -> (point of control, value-area high, value-area low), 70% value area."""
    bs = abs(bs) if bs != 0 else 1.0                          # scrambled copies can wander below zero
    base = int(np.floor(lo.min() / bs))
    a = np.floor(lo / bs).astype(int) - base
    b = np.floor(hi / bs).astype(int) - base
    per = w / (b - a + 1)
    diff = np.zeros(b.max() + 2)
    np.add.at(diff, a, per)
    np.add.at(diff, b + 1, -per)
    prof = np.cumsum(diff)[:-1]
    poc = int(prof.argmax())
    lo_i = hi_i = poc
    got, total = prof[poc], prof.sum()
    while got < 0.7 * total and (lo_i > 0 or hi_i < len(prof) - 1):
        up = prof[hi_i + 1] if hi_i < len(prof) - 1 else -1.0
        dn = prof[lo_i - 1] if lo_i > 0 else -1.0
        if up >= dn:
            hi_i += 1
            got += up
        else:
            lo_i -= 1
            got += dn
    return (base + poc + 0.5) * bs, (base + hi_i + 1) * bs, (base + lo_i) * bs


def days_of(B):
    """Per-trade-day table: session extremes, opens, activation candles."""
    o, h, l, c, mod, td = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"]
    n = len(o)
    starts = np.flatnonzero(np.r_[True, td[1:] != td[:-1]])
    ends = np.r_[starts[1:], n]
    D = len(starts)
    didx = np.repeat(np.arange(D), ends - starts)
    f = pd.DataFrame({"d": didx, "h": h, "l": l})

    def hl(mask):
        g = f[mask].groupby("d")
        return g.h.max().reindex(range(D)).values, g.l.min().reindex(range(D)).values

    def first(mask):
        idx = np.flatnonzero(mask)
        return pd.Series(idx, index=didx[idx]).groupby(level=0).first().reindex(range(D)).fillna(-1).astype(int).values

    m = mod
    T = dict(starts=starts, ends=ends, didx=didx, D=D)
    for name, mask in (("AS", (m >= 1080) | (m < 180)), ("LO", (m >= 180) & (m < 570)), ("ON", (m >= 1080) | (m < 570)),
                       ("OR5", (m >= 570) & (m < 575)), ("OR15", (m >= 570) & (m < 585)), ("OR30", (m >= 570) & (m < 600)),
                       ("IB", (m >= 570) & (m < 630)), ("AM", (m >= 570) & (m < 720)), ("LUNCH", (m >= 720) & (m < 810)),
                       ("RD", (m >= 570) & (m < 960)), ("DAY", np.ones(n, bool))):
        T[name] = hl(mask)
    for name, t0 in (("i_as", 180), ("i_830", 510), ("i_rth", 570), ("i_or5", 575), ("i_or15", 585), ("i_or", 600), ("i_ib", 630),
                     ("i_noon", 720), ("i_pm", 810)):
        T[name] = first((m >= t0) & (m < 1020))
    T["i_mid"] = first(m < 180)
    T["C"] = pd.Series(c, index=didx).groupby(level=0).last().values
    dates = td[starts].astype("datetime64[D]")
    T["dates"], T["month"], T["week"] = dates, dates.astype("datetime64[M]").astype(int), B["wk"][starts]
    return T


def events(B, width, target, ref, vxn=None, seed=7):
    o, h, l, c, mod, td = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"]
    n = len(o)
    T = days_of(B)
    starts, ends, didx, D = T["starts"], T["ends"], T["didx"], T["D"]
    H, L = T["DAY"]
    C = T["C"]
    rng = np.random.default_rng(seed)
    ev = []                                                  # (candle, level, side, family, days it may wait)

    def both(i, hi, lo, fam, ttl=0):
        if i >= 0 and not (np.isnan(hi) or np.isnan(lo)):
            ev.append((i, hi, 1, fam, ttl))
            ev.append((i, lo, -1, fam, ttl))

    def located(i, lv, fam, ttl=0):                          # support if price is above the level, resistance if below
        if i >= 0 and not np.isnan(lv) and o[i] != lv:
            ev.append((i, lv, 1 if o[i] < lv else -1, fam, ttl))

    Hs, Ls, Cs = pd.Series(H), pd.Series(L), pd.Series(C)
    nday = {N: (Hs.shift(1).rolling(N).max().values, Ls.shift(1).rolling(N).min().values) for N in (3, 5, 10, 20)}
    adr = (Hs - Ls).shift(1).rolling(14, min_periods=5).mean().values
    sma = {N: Cs.shift(1).rolling(N).mean().values for N in (20, 50, 200)}
    sd20 = Cs.shift(1).rolling(20).std(ddof=0).values
    kday = np.ones(D)
    if ref > 0:
        kday[1:] = C[:-1] / ref
    em = np.full(D, np.nan)
    if vxn is not None:
        vx = vxn.reindex(pd.DatetimeIndex(T["dates"]), method="ffill").values
        em[1:] = C[:-1] * vx[:-1] / 100.0 / np.sqrt(252.0)
    wH = wL = pwH = pwL = mH = mL = pmH = pmL = wO = np.nan
    wk_rng = []
    for d in range(D):
        a, b = starts[d], ends[d]
        if d > 0 and T["week"][d] != T["week"][d - 1]:
            if not np.isnan(wH):
                wk_rng.append(wH - wL)
            pwH, pwL, wH, wL, wO = wH, wL, np.nan, np.nan, o[a]
        if d > 0 and T["month"][d] != T["month"][d - 1]:
            pmH, pmL, mH, mL = mH, mL, np.nan, np.nan
        if d > 0:
            pH, pL, pC = H[d - 1], L[d - 1], C[d - 1]
            r = pH - pL
            both(a, pH, pL, "PD")
            both(a, *T["RD"][0][d - 1:d], *T["RD"][1][d - 1:d], "RD") if not np.isnan(T["RD"][0][d - 1]) else None
            for N in (3, 5, 10, 20):
                both(a, nday[N][0][d], nday[N][1][d], f"D{N}")
            both(a, pwH, pwL, "PW")
            both(a, wH, wL, "CW")
            both(a, pmH, pmL, "PM")
            both(a, mH, mL, "CM")
            located(a, pC, "PDC")
            located(a, (pH + pL) / 2, "PDM")
            located(a, (pwH + pwL) / 2, "PWM")
            located(a, wO, "WO")
            pp = (pH + pL + pC) / 3
            located(a, pp, "PP")
            for fam, up, dn in (("R1", 2 * pp - pL, 2 * pp - pH), ("R2", pp + r, pp - r), ("R3", pH + 2 * (pp - pL), pL - 2 * (pH - pp)),
                                ("CAM3", pC + 1.1 * r / 4, pC - 1.1 * r / 4), ("CAM4", pC + 1.1 * r / 2, pC - 1.1 * r / 2),
                                ("F38", pH - 0.382 * r, pL + 0.382 * r), ("F79", pH - 0.786 * r, pL + 0.786 * r), ("X27", pH + 0.272 * r, pL - 0.272 * r),
                                ("X62", pH + 0.618 * r, pL - 0.618 * r)):
                located(a, up, fam)
                located(a, dn, fam)
            for mult, fam in ((0.5, "CADR05"), (1.0, "CADR10"), (1.5, "CADR15")):
                both(a, pC + mult * adr[d], pC - mult * adr[d], fam)
            for mult, fam in ((0.5, "EM05"), (1.0, "EM10")):
                both(a, pC + mult * em[d], pC - mult * em[d], fam)
            for N in (20, 50, 200):
                located(a, sma[N][d], f"SMA{N}")
            both(a, sma[20][d] + 2 * sd20[d], sma[20][d] - 2 * sd20[d], "BB")
            lo_, hi_, w_ = l[starts[d - 1]:ends[d - 1]], h[starts[d - 1]:ends[d - 1]], B["v"][starts[d - 1]:ends[d - 1]]
            bs = 5.0 * kday[d]
            for tag, wt in (("T", np.ones(len(lo_))), ("V", np.maximum(w_, 1e-9))):
                poc, vah, val = profile(lo_, hi_, wt, bs)
                located(a, poc, tag + "POC")
                located(a, vah, tag + "VAH")
                located(a, val, tag + "VAL")
            for step, fam in ((100.0, "RND100"), (250.0, "RND250"), (500.0, "RND500"), (1000.0, "RND1000")):
                st = step * kday[d]
                up = np.ceil(o[a] / st) * st
                both(a, up + (st if up == o[a] else 0), np.floor(o[a] / st) * st - (st if np.floor(o[a] / st) * st == o[a] else 0), fam)
            if not np.isnan(adr[d]):
                for _ in range(2):
                    u = rng.uniform(0.2, 1.0) * adr[d]
                    both(a, o[a] + u, o[a] - u, "RANDOM")
        i_as, i_rth, i_or, i_ib = T["i_as"][d], T["i_rth"][d], T["i_or"][d], T["i_ib"][d]
        both(i_as, T["AS"][0][d], T["AS"][1][d], "AS")
        located(i_as, o[a], "GO")
        if T["i_mid"][d] >= 0:
            located(i_as, o[T["i_mid"][d]], "MO")
        both(i_rth, T["LO"][0][d], T["LO"][1][d], "LO")
        both(i_rth, T["ON"][0][d], T["ON"][1][d], "ON")
        located(i_rth, (T["ON"][0][d] + T["ON"][1][d]) / 2, "ONM")
        if T["i_830"][d] >= 0:
            located(i_rth, o[T["i_830"][d]], "O830")
        if i_rth >= 0 and not np.isnan(adr[d]):
            for mult, fam in ((0.5, "ADR05"), (0.75, "ADR075"), (1.0, "ADR10"), (1.25, "ADR125"), (1.5, "ADR15")):
                both(i_rth, o[i_rth] + mult * adr[d], o[i_rth] - mult * adr[d], fam)
        if i_as >= 0 and not np.isnan(adr[d]):
            for mult, fam in ((0.75, "GADR075"), (1.0, "GADR10"), (1.5, "GADR15")):
                both(i_as, o[a] + mult * adr[d], o[a] - mult * adr[d], fam)
        if d > 0 and not np.isnan(wO) and len(wk_rng) >= 4:
            x = float(np.mean(wk_rng[-8:]))
            for mult, fam in ((0.5, "WADR05"), (1.0, "WADR10")):
                both(a, wO + mult * x, wO - mult * x, fam)
        both(T["i_or5"][d], T["OR5"][0][d], T["OR5"][1][d], "OR5")
        both(T["i_or15"][d], T["OR15"][0][d], T["OR15"][1][d], "OR15")
        both(i_or, T["OR30"][0][d], T["OR30"][1][d], "OR30")
        if i_or >= 0 and i_rth >= 0:
            located(i_or, o[i_rth], "RO")
            x = T["OR30"][0][d] - T["OR30"][1][d]
            both(i_or, T["OR30"][0][d] + x, T["OR30"][1][d] - x, "ORX10")
        both(i_ib, T["IB"][0][d], T["IB"][1][d], "IB")
        if i_ib >= 0:
            x = T["IB"][0][d] - T["IB"][1][d]
            located(i_ib, (T["IB"][0][d] + T["IB"][1][d]) / 2, "IBM")
            both(i_ib, T["IB"][0][d] + 0.5 * x, T["IB"][1][d] - 0.5 * x, "IBX05")
            both(i_ib, T["IB"][0][d] + x, T["IB"][1][d] - x, "IBX10")
        both(T["i_noon"][d], T["AM"][0][d], T["AM"][1][d], "AM")
        both(T["i_pm"][d], T["LUNCH"][0][d], T["LUNCH"][1][d], "LUNCH")
        wH = H[d] if np.isnan(wH) else max(wH, H[d])
        wL = L[d] if np.isnan(wL) else min(wL, L[d])
        mH = H[d] if np.isnan(mH) else max(mH, H[d])
        mL = L[d] if np.isnan(mL) else min(mL, L[d])

    hour = max(1, round(60 / B["tf"]))
    wts = B["v"] if np.nansum(B["v"]) > 0 else np.ones(n)
    for anchor, tag in ((-1, "VW"), (570, "RVW")):            # VWAP bands and returns to VWAP
        _, _, ei, el, es, ek = vwap_scan(o, h, l, c, np.maximum(wts, 1e-9), td, mod, anchor, 2 * hour, hour)
        for i, lv, s, k in zip(ei, el, es, ek):
            ev.append((int(i), float(lv), int(s), f"{tag}{k}" if k else f"{tag}AP", 0))
    atr = pd.Series(h - l).rolling(100, min_periods=30).mean().shift(1).values
    adr_b = adr[didx]
    piv = {}
    for K, fam in ((hour, "SW1h"), (2 * hour, "SW2h"), (4 * hour, "SW4h")):   # swing highs / lows, confirmed K candles later
        mx = pd.Series(h).rolling(2 * K + 1, center=True).max().values
        mn = pd.Series(l).rolling(2 * K + 1, center=True).min().values
        hi_j, lo_j = np.flatnonzero(h == mx), np.flatnonzero(l == mn)
        piv[fam] = (hi_j, lo_j, K)
        for j in hi_j:
            if j + K + 1 < n:
                ev.append((j + K + 1, h[j], 1, fam, 1))
        for j in lo_j:
            if j + K + 1 < n:
                ev.append((j + K + 1, l[j], -1, fam, 1))
    hi_j, lo_j, K = piv["SW1h"]                               # equal highs / lows: two swing points within 2% of a daily range
    for arr, px, side in ((hi_j, h, 1), (lo_j, l, -1)):
        for a_, b_ in zip(arr[:-1], arr[1:]):
            if b_ - a_ <= 24 * hour and b_ + K + 1 < n and abs(px[a_] - px[b_]) <= 0.02 * adr_b[b_]:
                ev.append((b_ + K + 1, max(px[a_], px[b_]) if side > 0 else min(px[a_], px[b_]), side, "EQ", 1))
    hi_j, lo_j, K = piv["SW2h"]                               # retracement of the last swing leg
    seq = sorted([(j, 1) for j in hi_j] + [(j, -1) for j in lo_j])
    for (j0, s0), (j1, s1) in zip(seq[:-1], seq[1:]):
        if s0 != s1 and j1 + K + 1 < n:
            leg = (h[j1] - l[j0]) if s1 > 0 else (h[j0] - l[j1])
            if leg >= 0.4 * adr_b[j1]:
                end = h[j1] if s1 > 0 else l[j1]
                for frac, fam in ((0.618, "OTE62"), (0.786, "OTE79")):
                    ev.append((j1 + K + 1, end - s1 * frac * leg, -s1, fam, 1))
    same = np.r_[False, False, td[2:] == td[:-2]]
    gap_up = np.r_[0, 0, l[2:] - h[:-2]]
    gap_dn = np.r_[0, 0, l[:-2] - h[2:]]
    day = 24 * hour                                           # a sweep: a new 24-hour extreme within the last 2 hours
    swept_hi = pd.Series(h).rolling(2 * hour).max().values >= pd.Series(h).rolling(day).max().shift(2 * hour).values
    swept_lo = pd.Series(l).rolling(2 * hour).min().values <= pd.Series(l).rolling(day).min().shift(2 * hour).values
    for j in np.flatnonzero(same & (gap_up >= 0.3 * atr)):
        if j + 1 < n:
            ev.append((j + 1, l[j], -1, "FVG", 1))
            if swept_lo[j]:
                ev.append((j + 1, l[j], -1, "SWFVG", 1))
    for j in np.flatnonzero(same & (gap_dn >= 0.3 * atr)):
        if j + 1 < n:
            ev.append((j + 1, h[j], 1, "FVG", 1))
            if swept_hi[j]:
                ev.append((j + 1, h[j], 1, "SWFVG", 1))
    hh = pd.Series(h).rolling(hour).max().shift(1).values
    ll = pd.Series(l).rolling(hour).min().shift(1).values
    body = c - o
    used = set()
    for sgn, cond in ((1, (c > hh) & (body >= atr)), (-1, (c < ll) & (-body >= atr))):
        for j in np.flatnonzero(cond):
            for q in range(j - 1, max(j - 6, 0), -1):
                if sgn * (c[q] - o[q]) < 0:
                    if (q, sgn) not in used and j + 2 < n:
                        used.add((q, sgn))
                        lv = h[q] if sgn > 0 else l[q]
                        ev.append((j + 1, lv, -sgn, "OB", 1))
                        if (swept_lo[j] if sgn > 0 else swept_hi[j]):
                            ev.append((j + 1, lv, -sgn, "SWOB", 1))
                        if (gap_up[j + 1] > 0 if sgn > 0 else gap_dn[j + 1] > 0) and td[j + 1] == td[j - 1]:
                            ev.append((j + 2, lv, -sgn, "OBF", 1))
                    break

    ev.sort(key=lambda e: e[0])
    fams = sorted({e[3] for e in ev})
    fid = {f: k for k, f in enumerate(fams)}
    i = np.array([e[0] for e in ev], np.int64)
    kk = kday[didx[np.minimum(i, n - 1)]]
    arr = (i, np.array([e[1] for e in ev], float), np.array([e[2] for e in ev], np.int64), width * kk, target * kk,
           np.array([e[4] for e in ev], np.int64))
    return fams, arr, np.array([fid[e[3]] for e in ev]), T


def graded(B, args, vxn):
    ref = float(B["c"][-1]) if args.scale else 0.0
    fams, arr, fam, T = events(B, args.width, args.target, ref, vxn)
    res, ti, best = rb_zoo.grade(B["o"], B["h"], B["l"], B["c"], B["td"], *arr)
    hit = best >= arr[4] * args.hit / args.target - 1e-9
    return fams, arr, fam, T, res, ti, hit


def rates(hit, res, m):
    hits, broken = int((hit & m).sum()), int(((res == 2) & ~hit & m).sum())
    g = max(hits + broken, 1)
    return hits + broken, 100.0 * hits / g, 100.0 * ((res == 1) & m).sum() / g


def cmd_levels(args, df, B, vxn):
    mid = df.index[0] + (df.index[-1] - df.index[0]) / 2

    def table(Bx):
        fams, arr, fam, T, res, ti, hit = graded(Bx, args, vxn)
        t = Bx["index"][np.maximum(ti, 0)]
        out = {}
        for k, name in enumerate(fams):
            m = (fam == k) & (ti >= 0)
            out[name] = rates(hit, res, m) + rates(hit, res, m & np.asarray(t < mid))[1:2] + rates(hit, res, m & np.asarray(t >= mid))[1:2]
        return out

    real = table(B)
    nulls = [table(rb_blocks.prep(rz_null.scramble(df, 900 + s), args.tf)) for s in range(args.null)]
    days = len(np.unique(B["td"]))
    print(f"{df.index[0].date()} -> {df.index[-1].date()}, {args.tf}-minute candles, blocks {args.width:.0f} deep, HIT = {args.hit:.0f}, "
          f"100+ = {args.target:.0f}{' (scaled to price)' if args.scale else ''}; halves split at {mid.date()}")
    print(f"{'level':8s} {'graded':>7s} {'/day':>5s} {'HIT':>7s} {'chance':>7s} {'z':>6s} {'100+':>7s} {'chance':>7s} {'z':>6s}   {'1st half':>8s} {'2nd half':>8s}")
    for name, r in sorted(real.items(), key=lambda kv: -kv[1][1]):
        if r[0] < args.min_n:
            continue
        ch = np.array([x[name][1] for x in nulls if name in x])
        cb = np.array([x[name][2] for x in nulls if name in x])
        z = (r[1] - ch.mean()) / ch.std() if len(ch) > 1 and ch.std() > 0 else np.nan
        zb = (r[2] - cb.mean()) / cb.std() if len(cb) > 1 and cb.std() > 0 else np.nan
        print(f"{name:8s} {r[0]:7d} {r[0] / days:5.1f} {r[1]:6.1f}% {ch.mean() if len(ch) else np.nan:6.1f}% {z:+6.1f} "
              f"{r[2]:6.1f}% {cb.mean() if len(cb) else np.nan:6.1f}% {zb:+6.1f}   {r[3]:7.1f}% {r[4]:7.1f}%")


def features(B, T, arr, fam, fams, ti, vxn):
    """What was known when each core block was touched (nothing from the touch candle except its open)."""
    o, h, l, c, mod, td = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"]
    didx, D = T["didx"], T["D"]
    core = np.isin(fam, [fams.index(x) for x in EXTREMES if x in fams]) & (ti >= 0)
    key = pd.DataFrame({"d": didx[np.maximum(ti, 0)], "s": arr[2], "lv": np.round(arr[1], 1), "core": core})
    keep = core & ~key.duplicated(["d", "s", "lv", "core"]).values      # the same level under two names counts once
    idx = np.flatnonzero(keep)
    i, s = ti[idx], arr[2][idx]
    d = didx[i]
    Cs = pd.Series(T["C"])
    H, L = T["DAY"]
    adr = (pd.Series(H) - pd.Series(L)).shift(1).rolling(14, min_periods=5).mean().values
    atr = pd.Series(h - l).rolling(100, min_periods=30).mean().shift(1).values
    hour = max(1, round(60 / B["tf"]))
    dopen = o[T["starts"]][d]
    dh = pd.Series(h).groupby(didx).cummax().shift(1).values
    dl = pd.Series(l).groupby(didx).cummin().shift(1).values
    delta = pd.Series(c).diff()
    up = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    dn = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    rsi = (100 - 100 / (1 + up / dn)).shift(1).values
    wts = np.maximum(B["v"] if np.nansum(B["v"]) > 0 else np.ones(len(o)), 1e-9)
    vw, sd, *_ = vwap_scan(o, h, l, c, wts, td, mod, -1, 2 * hour, hour)
    m = mod[i]
    F = pd.DataFrame(index=idx)
    F["time of day (ET)"] = np.select([(m >= 1080) | (m < 180), m < 510, m < 570, m < 630, m < 720, m < 840], ["18:00-03:00 Asia", "03:00-08:30 London", "08:30-09:30", "09:30-10:30", "10:30-12:00", "12:00-14:00"], "14:00-17:00")
    F["weekday"] = pd.DatetimeIndex(T["dates"][d]).day_name()
    F["side"] = np.where(s > 0, "resistance", "support")
    run = s * (o[i] - dopen) / adr[d]
    F["day so far vs the 18:00 open"] = np.select([run > 0.75, run > 0.25, run > -0.25], ["fading a move of > 0.75 ADR", "fading 0.25-0.75 ADR", "near the open"], "price on the other side of the open")
    sma50 = Cs.shift(1).rolling(50).mean().values
    F["daily trend (50-day average)"] = np.where(np.isnan(sma50[d]), "n/a", np.where(s * (T["C"][np.maximum(d - 1, 0)] - sma50[d]) > 0, "fading with price beyond the average", "fading toward the average"))
    r5 = (Cs.shift(1) / Cs.shift(6) - 1).values
    F["last 5 days"] = np.where(np.isnan(r5[d]), "n/a", np.where(s * r5[d] > 0, "fading the 5-day direction", "with the 5-day direction"))
    used = (dh[i] - dl[i]) / adr[d]
    F["day's range used before the touch"] = np.select([used < 0.4, used < 0.8, used < 1.2], ["< 40% of ADR", "40-80%", "80-120%"], "> 120% of ADR")
    spd = s * (c[np.maximum(i - 1, 0)] - c[np.maximum(i - 1 - hour, 0)]) / (atr[i] * np.sqrt(hour))
    F["approach over the last hour"] = np.select([spd > 2, spd > 1, spd > 0], ["fast (> 2 sigma)", "1-2 sigma", "slow"], "drifting away, then spiked in")
    ex = np.where(s > 0, rsi[i], 100 - rsi[i])
    F["RSI(14) into the block"] = np.select([ex >= 75, ex >= 65, ex >= 50], ["stretched (>= 75)", "65-75", "50-65"], "< 50")
    z = s * (o[i] - vw[i]) / sd[i]
    F["distance from session VWAP"] = np.select([np.isnan(z), z >= 2.5, z >= 1.5, z >= 0.5], ["n/a", ">= 2.5 sigma beyond", "1.5-2.5 sigma", "0.5-1.5 sigma"], "at or inside VWAP")
    if vxn is not None:
        vx = vxn.reindex(pd.DatetimeIndex(T["dates"]), method="ffill").shift(1).values[d]
        q1, q2 = np.nanquantile(vx, [1 / 3, 2 / 3])
        F["VXN (implied volatility)"] = np.select([np.isnan(vx), vx <= q1, vx <= q2], ["n/a", "low third", "middle third"], "high third")
    bounce = np.array([bool(B["bounce"].get(x, False)) for x in td[i]])
    F["after an exhaustion close"] = np.where(bounce, np.where(s < 0, "support, bounce session", "resistance, bounce session"), "other sessions")
    gap = np.full(D, np.nan)
    ok = T["i_rth"] >= 0
    gap[1:] = np.where(ok[1:], (o[np.maximum(T["i_rth"][1:], 0)] - T["C"][:-1]) / adr[1:], np.nan)
    g = s * gap[d]
    F["overnight gap at 09:30"] = np.select([np.isnan(g) | (m < 570), g > 0.3, g < -0.3], ["n/a (before 09:30)", "fading the gap direction", "with the gap direction"], "small gap")
    return F


def cmd_conditions(args, df, B, vxn):
    mid = df.index[0] + (df.index[-1] - df.index[0]) / 2

    def table(Bx):
        fams, arr, fam, T, res, ti, hit = graded(Bx, args, vxn)
        F = features(Bx, T, arr, fam, fams, ti, vxn)
        idx = F.index.values
        t = Bx["index"][ti[idx]]
        out = {("ALL", "all core blocks"): rates(hit[idx], res[idx], np.ones(len(idx), bool)) + (0, 0)}
        for col in F.columns:
            for val in sorted(F[col].unique()):
                m = (F[col] == val).values
                out[(col, val)] = (rates(hit[idx], res[idx], m) + rates(hit[idx], res[idx], m & np.asarray(t < mid))[1:2]
                                   + rates(hit[idx], res[idx], m & np.asarray(t >= mid))[1:2])
        return out

    real = table(B)
    nulls = [table(rb_blocks.prep(rz_null.scramble(df, 900 + s), args.tf)) for s in range(args.null)]
    print(f"{df.index[0].date()} -> {df.index[-1].date()}, {args.tf}-minute candles; core blocks = session / day / week extremes and opens, "
          f"each level once per day; halves split at {mid.date()}")
    print(f"{'condition at the touch':66s} {'graded':>6s} {'HIT':>7s} {'chance':>7s} {'z':>6s} {'100+':>7s} {'chance':>7s} {'z':>6s}   {'1st half':>8s} {'2nd half':>8s}")
    last = None
    for (col, val), r in real.items():
        if r[0] < args.min_n or val == "n/a":
            continue
        if col != last:
            print(f"-- {col}")
            last = col
        ch = np.array([x[(col, val)][1] for x in nulls if (col, val) in x])
        cb = np.array([x[(col, val)][2] for x in nulls if (col, val) in x])
        z = (r[1] - ch.mean()) / ch.std() if len(ch) > 1 and ch.std() > 0 else np.nan
        zb = (r[2] - cb.mean()) / cb.std() if len(cb) > 1 and cb.std() > 0 else np.nan
        print(f"   {val:63s} {r[0]:6d} {r[1]:6.1f}% {ch.mean() if len(ch) else np.nan:6.1f}% {z:+6.1f} {r[2]:6.1f}% "
              f"{cb.mean() if len(cb) else np.nan:6.1f}% {zb:+6.1f}   {r[3]:7.1f}% {r[4]:7.1f}%")


PROMINENT = ("PD", "RD", "D3", "D5", "D10", "D20", "PW", "CW", "PM", "CM")


def cmd_combo(args, df, B, vxn):
    """The conditions that helped or hurt in the last 4 years, combined, and checked on the years before them."""
    cut = pd.Timestamp(args.cut, tz="UTC")

    def table(Bx):
        fams, arr, fam, T, res, ti, hit = graded(Bx, args, vxn)
        F = features(Bx, T, arr, fam, fams, ti, vxn)
        idx = F.index.values
        t = Bx["index"][ti[idx]]
        prom = np.isin(fam[idx], [fams.index(x) for x in PROMINENT if x in fams])
        gap = (F["overnight gap at 09:30"] == "fading the gap direction").values
        fast = (F["approach over the last hour"] == "fast (> 2 sigma)").values
        hot = (F["RSI(14) into the block"] == "stretched (>= 75)").values
        trend = (F["daily trend (50-day average)"] == "fading toward the average").values
        groups = {"all core blocks": np.ones(len(idx), bool),
                  "prominent highs / lows (day, multi-day, week, month)": prom,
                  "session levels and opens (everything else)": ~prom,
                  "fading the gap, a fast move or a stretched RSI": gap | fast | hot,
                  "none of those three": ~(gap | fast | hot),
                  "FAVOURABLE: session level, with the daily trend, none of the three": ~prom & trend & ~(gap | fast | hot),
                  "UNFAVOURABLE: prominent high / low against the trend or one of the three": prom & (~trend | gap | fast | hot)}
        out = {}
        for name, m in groups.items():
            for tag, sel in (("before", np.asarray(t < cut)), ("after", np.asarray(t >= cut))):
                out[(name, tag)] = rates(hit[idx], res[idx], m & sel)
        k_adr = [fams.index(x) for x in ("ADR10", "CADR15") if x in fams]
        tt = Bx["index"][np.maximum(ti, 0)]
        for tag, sel in (("before", np.asarray(tt < cut)), ("after", np.asarray(tt >= cut))):
            out[("range exhaustion: 09:30 open +/- 1 ADR, prior close +/- 1.5 ADR", tag)] = rates(hit, res, np.isin(fam, k_adr) & (ti >= 0) & sel)
        return out

    real = table(B)
    nulls = [table(rb_blocks.prep(rz_null.scramble(df, 900 + s), args.tf)) for s in range(args.null)]
    print(f"{df.index[0].date()} -> {df.index[-1].date()}{' (scaled to price)' if args.scale else ''}; 'before' / 'after' split at {cut.date()}")
    print(f"{'group':76s} {'period':>7s} {'graded':>7s} {'HIT':>7s} {'chance':>7s} {'z':>6s} {'100+':>7s} {'chance':>7s} {'z':>6s}")
    for (name, tag), r in real.items():
        if r[0] < 30:
            continue
        ch = np.array([x[(name, tag)][1] for x in nulls])
        cb = np.array([x[(name, tag)][2] for x in nulls])
        z = (r[1] - ch.mean()) / ch.std() if len(ch) > 1 and ch.std() > 0 else np.nan
        zb = (r[2] - cb.mean()) / cb.std() if len(cb) > 1 and cb.std() > 0 else np.nan
        print(f"{name:76s} {tag:>7s} {r[0]:7d} {r[1]:6.1f}% {ch.mean() if len(ch) else np.nan:6.1f}% {z:+6.1f} {r[2]:6.1f}% "
              f"{cb.mean() if len(cb) else np.nan:6.1f}% {zb:+6.1f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["levels", "conditions", "combo"])
    ap.add_argument("--cut", default="2022-11-09", help="combo: date that separates the years the conditions were found in")
    ap.add_argument("--duka")
    ap.add_argument("--cache")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--vxn", help="Yahoo daily CSV of ^VXN (for the implied-move levels and the volatility split)")
    ap.add_argument("--tf", type=int, default=5)
    ap.add_argument("--width", type=float, default=60.0)
    ap.add_argument("--hit", type=float, default=45.0)
    ap.add_argument("--target", type=float, default=100.0)
    ap.add_argument("--scale", action="store_true")
    ap.add_argument("--null", type=int, default=6)
    ap.add_argument("--min-n", dest="min_n", type=int, default=100)
    args = ap.parse_args()
    args.csv = None
    df = rb_blocks.load(args)
    B = rb_blocks.prep(df, args.tf)
    vxn = None
    if args.vxn:
        x = pd.read_csv(args.vxn)
        vxn = pd.Series(x.close.values, index=pd.to_datetime(x.time, unit="s").dt.normalize()).groupby(level=0).last()
    globals()[f"cmd_{args.command}"](args, df, B, vxn)


if __name__ == "__main__":
    main()
