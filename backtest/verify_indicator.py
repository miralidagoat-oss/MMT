#!/usr/bin/env python3
"""Faithful transcription of indicators/ict_mnq_model.pine, run on real data.

A syntax checker cannot tell you whether the logic never fires, fires on every
bar, or puts the stop on the wrong side of the entry. This re-implements the
indicator's exact decision path in Python and asserts the invariants that must
hold, so the Pine can be trusted before it ever touches a chart.

Transcribed exactly, including the fiddly parts:
  - HTF structure via the same offsets the script requests: with "use only
    closed HTF candles" ON, the comparison is close[j-1] vs the highest high of
    HTF candles j-4..j-2, so nothing unformed is ever read.
  - Pivots confirmed pivotLen bars late (ta.pivothigh semantics).
  - Pools removed the moment price trades through them.
  - Signals only on confirmed bars, long-only default, max 2/day, session gate.
"""
import csv
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

# defaults, matching the indicator's inputs exactly
P = dict(pivotLen=1, poolBars=120, minSweepAtr=0.0, maxSweepAtr=3.0, mssWindow=6,
         dispAtr=0.25, atrLen=14, stopAtr=1.0, capBySweep=True, rrTarget=2.0,
         maxPerDay=2, longOnly=True, shortOnly=False, htfLook=3, useHTF=True,
         sessStart=570, sessEnd=810, flatStart=955, flatEnd=960)
HTF1, HTF2 = 6, 12          # 30m and 60m, in 5-minute bars


def load(path):
    bars = []
    with open(path) as f:
        for r in csv.DictReader(f):
            ts = int(r["time"])
            d = datetime.fromtimestamp(ts, ET)
            bars.append(dict(t=ts, dt=d, hm=d.hour * 60 + d.minute, date=d.date(),
                             o=float(r["open"]), h=float(r["high"]),
                             l=float(r["low"]), c=float(r["close"])))
    return bars


def htf_state(bars, mult, look):
    """close[j-1] vs highest high of candles j-4..j-2, exactly as requested."""
    n = len(bars)
    blocks = []
    for i in range(0, n - mult + 1, mult):
        seg = bars[i:i + mult]
        blocks.append(dict(end=i + mult - 1, h=max(x["h"] for x in seg),
                           l=min(x["l"] for x in seg), c=seg[-1]["c"]))
    out = [0] * n
    state, j = 0, 0
    for i in range(n):
        while j < len(blocks) and blocks[j]["end"] <= i:
            j += 1
        # j is the index of the currently-forming block
        if j >= look + 1:
            cl = blocks[j - 1]["c"]
            window = blocks[j - 1 - look:j - 1]
            if window:
                hh = max(b["h"] for b in window)
                ll = min(b["l"] for b in window)
                if cl > hh:
                    state = 1
                elif cl < ll:
                    state = -1
        out[i] = state
    return out


def run(bars, p=None):
    p = dict(P, **(p or {}))
    n = len(bars)
    h = [b["h"] for b in bars]
    l = [b["l"] for b in bars]
    c = [b["c"] for b in bars]
    o = [b["o"] for b in bars]

    tr = [h[0] - l[0]] * n
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    atr = [None] * n
    if n > p["atrLen"]:
        atr[p["atrLen"]] = sum(tr[1:p["atrLen"] + 1]) / p["atrLen"]
        k = 1.0 / p["atrLen"]
        for i in range(p["atrLen"] + 1, n):
            atr[i] = atr[i - 1] * (1 - k) + tr[i] * k

    b1 = htf_state(bars, HTF1, p["htfLook"])
    b2 = htf_state(bars, HTF2, p["htfLook"])

    k = p["pivotLen"]
    sell, buy = [], []          # (price, bar)
    pivHi, pivLo = [], []
    swLo = swHi = None
    sigsToday, curDay = 0, None
    signals = []
    trade = None
    wins = losses = flats = 0
    day_hi, day_lo = {}, {}
    asia = {}
    lon = {}

    for i in range(n):
        b = bars[i]
        d = b["date"]
        day_hi[d] = max(day_hi.get(d, b["h"]), b["h"])
        day_lo[d] = min(day_lo.get(d, b["l"]), b["l"])
        if b["hm"] >= 1080 or b["hm"] < 120:
            asia[d] = (max(asia.get(d, (b["h"], b["l"]))[0], b["h"]),
                       min(asia.get(d, (b["h"], b["l"]))[1], b["l"]))
        elif b["hm"] < 480:
            lon[d] = (max(lon.get(d, (b["h"], b["l"]))[0], b["h"]),
                      min(lon.get(d, (b["h"], b["l"]))[1], b["l"]))

        if curDay != d:
            curDay = d
            sigsToday = 0
            prev = bars[i - 1]["date"] if i else None
            if prev in day_hi:
                buy.append((day_hi[prev], i))
                sell.append((day_lo[prev], i))
            if prev in asia:
                buy.append((asia[prev][0], i))
                sell.append((asia[prev][1], i))
            if prev in lon:
                buy.append((lon[prev][0], i))
                sell.append((lon[prev][1], i))

        # pivots confirmed k bars late
        pv = i - k
        if pv - k >= 0 and pv + k < n and pv + k == i:
            if h[pv] > h[pv - k] and h[pv] > h[pv + k]:
                pivHi.append(h[pv])
                buy.append((h[pv], pv))
            if l[pv] < l[pv - k] and l[pv] < l[pv + k]:
                pivLo.append(l[pv])
                sell.append((l[pv], pv))
        pivHi[:] = pivHi[-60:]
        pivLo[:] = pivLo[-60:]

        a = atr[i]

        # manage an open virtual trade (pessimistic: stop wins ties)
        if trade and i > trade["bar"]:
            bull = trade["dir"] > 0
            if (l[i] <= trade["stop"]) if bull else (h[i] >= trade["stop"]):
                losses += 1
                trade = None
            elif (h[i] >= trade["tp"]) if bull else (l[i] <= trade["tp"]):
                wins += 1
                trade = None
            elif p["flatStart"] <= b["hm"] < p["flatEnd"]:
                flats += 1
                trade = None

        # sweep detection: raid a live pool, close back inside
        sweptSell = sweptBuy = None
        keep = []
        for px, br in sell:
            if l[i] < px:
                if c[i] > px and (sweptSell is None or px > sweptSell):
                    sweptSell = px
            elif i - br <= p["poolBars"]:
                keep.append((px, br))
        sell = keep
        keep = []
        for px, br in buy:
            if h[i] > px:
                if c[i] < px and (sweptBuy is None or px < sweptBuy):
                    sweptBuy = px
            elif i - br <= p["poolBars"]:
                keep.append((px, br))
        buy = keep

        if a:
            if sweptSell is not None and p["minSweepAtr"] * a <= sweptSell - l[i] <= p["maxSweepAtr"] * a:
                tg = next((x for x in reversed(pivHi) if x > c[i]), None)
                if tg is not None:
                    swLo = dict(bar=i, px=l[i], trig=tg)
            if sweptBuy is not None and p["minSweepAtr"] * a <= h[i] - sweptBuy <= p["maxSweepAtr"] * a:
                tg = next((x for x in reversed(pivLo) if x < c[i]), None)
                if tg is not None:
                    swHi = dict(bar=i, px=h[i], trig=tg)

        if swLo and (i - swLo["bar"] > p["mssWindow"] or (l[i] < swLo["px"] and i > swLo["bar"])):
            swLo = None
        if swHi and (i - swHi["bar"] > p["mssWindow"] or (h[i] > swHi["px"] and i > swHi["bar"])):
            swHi = None

        if not a:
            continue
        dispOk = abs(c[i] - o[i]) >= p["dispAtr"] * a
        mssL = swLo is not None and i > swLo["bar"] and c[i] > swLo["trig"] and dispOk
        mssS = swHi is not None and i > swHi["bar"] and c[i] < swHi["trig"] and dispOk

        inSess = p["sessStart"] <= b["hm"] < p["sessEnd"]
        inFlat = p["flatStart"] <= b["hm"] < p["flatEnd"]
        canArm = inSess and not inFlat and sigsToday < p["maxPerDay"] and trade is None
        allowL = not p["shortOnly"]
        allowS = not p["longOnly"]
        htfL = (not p["useHTF"]) or (b1[i] == 1 and b2[i] == 1)
        htfS = (not p["useHTF"]) or (b1[i] == -1 and b2[i] == -1)
        sigL = canArm and mssL and htfL and allowL
        sigS = canArm and mssS and htfS and allowS

        if sigL or sigS:
            sd = 1 if sigL else -1
            atrStop = c[i] - sd * p["stopAtr"] * a
            ref = (swLo["px"] - 0.1 * a) if sd > 0 else (swHi["px"] + 0.1 * a)
            if p["capBySweep"]:
                if sd > 0:
                    stop = max(atrStop, min(ref, c[i] - 0.5 * a))
                else:
                    stop = min(atrStop, max(ref, c[i] + 0.5 * a))
            else:
                stop = atrStop
            risk = abs(c[i] - stop)
            if risk > 0:
                trade = dict(dir=sd, entry=c[i], stop=stop,
                             tp=c[i] + sd * p["rrTarget"] * risk, bar=i, risk=risk)
                sigsToday += 1
                signals.append(dict(dt=b["dt"], dir=sd, entry=c[i], stop=stop,
                                    tp=trade["tp"], risk=risk, atr=a, hm=b["hm"]))
                if sd > 0:
                    swLo = None
                else:
                    swHi = None
    return signals, wins, losses, flats


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "../ictdata"
    ok = True
    for sym in ("MNQ", "NQ", "ES"):
        bars = load(f"{data}/{sym}_5m.csv")
        sigs, w, lo, fl = run(bars)
        days = len({b["date"] for b in bars})
        print(f"\n=== {sym} 5m — {len(bars)} bars, {days} sessions ===")
        print(f"  signals: {len(sigs)}  ({len(sigs)/days:.2f}/session)   "
              f"graded W/L/flat: {w}/{lo}/{fl}")
        if not sigs:
            print("  *** NO SIGNALS — logic is dead ***")
            ok = False
            continue
        longs = sum(1 for s in sigs if s["dir"] > 0)
        risks = [s["risk"] for s in sigs]
        ratios = [s["risk"] / s["atr"] for s in sigs]
        print(f"  direction: {longs} long / {len(sigs)-longs} short")
        print(f"  risk: min {min(risks):.1f}  med {sorted(risks)[len(risks)//2]:.1f}  "
              f"max {max(risks):.1f} pts   ({min(ratios):.2f}-{max(ratios):.2f} x ATR)")
        print(f"  entry times: {min(s['hm'] for s in sigs)//60:02d}:"
              f"{min(s['hm'] for s in sigs)%60:02d} - "
              f"{max(s['hm'] for s in sigs)//60:02d}:{max(s['hm'] for s in sigs)%60:02d} ET")

        # ── invariants that must hold ──
        checks = []
        checks.append(("long-only respected", all(s["dir"] > 0 for s in sigs)))
        checks.append(("stop on correct side", all(
            (s["stop"] < s["entry"]) if s["dir"] > 0 else (s["stop"] > s["entry"]) for s in sigs)))
        checks.append(("target on correct side", all(
            (s["tp"] > s["entry"]) if s["dir"] > 0 else (s["tp"] < s["entry"]) for s in sigs)))
        checks.append(("target is exactly 2R", all(
            abs(abs(s["tp"] - s["entry"]) / s["risk"] - 2.0) < 1e-9 for s in sigs)))
        checks.append(("risk within 0.5-1.0 ATR", all(
            0.499 <= s["risk"] / s["atr"] <= 1.001 for s in sigs)))
        checks.append(("all entries inside 09:30-13:30", all(
            570 <= s["hm"] < 810 for s in sigs)))
        per_day = {}
        for s in sigs:
            per_day[s["dt"].date()] = per_day.get(s["dt"].date(), 0) + 1
        checks.append(("max 2 signals/session", max(per_day.values()) <= 2))
        checks.append(("no duplicate timestamps", len({s["dt"] for s in sigs}) == len(sigs)))
        for name, passed in checks:
            print(f"    [{'PASS' if passed else 'FAIL'}] {name}")
            ok = ok and passed
    print("\n" + ("ALL INVARIANTS PASS" if ok else "*** INVARIANT FAILURE ***"))
    sys.exit(0 if ok else 1)
