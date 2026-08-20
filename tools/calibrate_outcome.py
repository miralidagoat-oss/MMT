#!/usr/bin/env python3
"""Measure what the decay engine's own outcome score looks like at an ARBITRARY level.

The engine scores a touch as

    score = (best excursion AWAY from the level - worst excursion THROUGH it) / unit

and v5 labelled a level "holding" above +0.5 and "failing" below -0.5. Those two
numbers were picked by eye. A score means nothing without knowing what an
uninformative level scores, so this measures exactly that: it runs the engine's
state machine, unmodified, over levels placed where real levels sit -- at
prior_close +/- k*ATR -- but chosen with NO information in them.

Whatever comes out is the null. A gamma level only earns the word "holding" if it
beats it, and the thresholds the indicator ships with are read off this table
rather than guessed.

    python3 tools/calibrate_outcome.py
    python3 tools/calibrate_outcome.py --json tools/outcome_params.json

The engine logic below is a line-by-line mirror of the Pine. If you change one,
change the other -- a baseline measured against a different state machine is worse
than no baseline, because it looks like it applies.

Stdlib only.
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yahoo  # noqa: E402

# Pine defaults, mirrored. tolATR 0.15 -> halfW = atr * 0.15 * 0.5
EVAL_BARS = 5
COOL_BARS = 10
HALF_W_ATR = 0.075
BRK_X = 2.0
EV_CLAMP = 1.5          # the engine clamps each test before accumulating; the null must too
LEVEL_KS = (-1.5, -1.0, -0.6, -0.3, 0.3, 0.6, 1.0, 1.5)


def bars(symbol, interval, rng):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol)
           + "?interval=" + interval + "&range=" + rng)
    res = yahoo._get(url)["chart"]["result"][0]
    ts, q = res["timestamp"], res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        out.append((int(t), float(o), float(h), float(l), float(c)))
    out.sort(key=lambda r: r[0])
    return out


def atr_series(b, n=14):
    tr = [None] * len(b)
    for i in range(1, len(b)):
        tr[i] = max(b[i][2] - b[i][3], abs(b[i][2] - b[i - 1][4]), abs(b[i][3] - b[i - 1][4]))
    a = [None] * len(b)
    if len(b) <= n + 1:
        return a
    a[n] = sum(tr[1:n + 1]) / n
    for i in range(n + 1, len(b)):
        a[i] = (a[i - 1] * (n - 1) + tr[i]) / n
    return a


def session_of(epoch):
    """+6h shift, exactly as the Pine does, so an 18:00 ET roll lands on midnight."""
    return (dt.datetime.utcfromtimestamp(epoch) + dt.timedelta(hours=6 - 4)).date()


def run_engine(b, a, levels_for_session):
    """The Pine decay engine, mirrored. Yields one record per SCORED touch."""
    out = []
    cur, lv = None, []
    for i in range(1, len(b)):
        if a[i - 1] is None or a[i - 1] <= 0:
            continue
        ses = session_of(b[i][0])
        if ses != cur:                                    # new session: reset everything
            cur = ses
            lv = levels_for_session(b, a, i)
        atr = a[i - 1]
        hw = max(1e-9, HALF_W_ATR * atr)
        hi_b, lo_b, cl = b[i][2], b[i][3], b[i][4]
        for st in lv:
            p = st["px"]
            lo, hi = p - hw, p + hw
            inz = lo_b <= hi and hi_b >= lo
            # ── new touch
            if inz and not st["in"] and (i - st["last"]) > COOL_BARS:
                d = 1 if b[i - 1][4] > hi else (-1 if b[i - 1][4] < lo else (1 if cl > p else -1))
                st.update(last=i, due=i + EVAL_BARS, dir=d, away=0.0, thru=0.0)
            # ── accumulate, strictly from the bar AFTER the touch
            if st["due"] > 0 and i > st["last"] and i <= st["due"]:
                d = st["dir"]
                aw = (hi_b - p) if d == 1 else (p - lo_b)
                th = (p - lo_b) if d == 1 else (hi_b - p)
                st["away"] = max(st["away"], aw)
                st["thru"] = max(st["thru"], th)
            # ── score once the window closes
            if st["due"] > 0 and i == st["due"]:
                aw, th = st["away"], st["thru"]
                unit = max(atr, hw)
                raw = (aw - th) / unit
                out.append({"score": max(-EV_CLAMP, min(EV_CLAMP, raw)),
                            "raw": raw,
                            "broke": th > hw * BRK_X and th > aw})
                st["due"] = -1
            st["in"] = inz
    return out


def arbitrary_levels(b, a, i):
    """Levels carrying NO information: prior close +/- k*ATR, where real levels sit."""
    anchor, atr = b[i - 1][4], a[i - 1]
    return [{"px": anchor + k * atr, "in": False, "last": -9999,
             "due": -1, "dir": 0, "away": 0.0, "thru": 0.0} for k in LEVEL_KS]


def quantile(xs, q):
    if not xs:
        return float("nan")
    s = sorted(xs)
    f = q * (len(s) - 1)
    lo = int(f)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (f - lo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="write measured thresholds here")
    a_ = ap.parse_args()

    combos = [("ES", "ES=F", "60m", "730d"), ("ES", "ES=F", "15m", "60d"),
              ("ES", "ES=F", "5m", "60d"),
              ("NQ", "NQ=F", "60m", "730d"), ("NQ", "NQ=F", "15m", "60d"),
              ("NQ", "NQ=F", "5m", "60d")]
    print("BASELINE: the engine's score at levels chosen with no information in them.")
    print("Scores are CLAMPED at +/-%.1f, exactly as the engine clamps them before it" % EV_CLAMP)
    print("accumulates -- a null measured on unclamped scores would not be this engine's null.")
    print("Levels at prior_close +/- {%s} x ATR14, halfW=%.3f x ATR, eval=%d bars.\n"
          % (", ".join(str(k) for k in LEVEL_KS), HALF_W_ATR, EVAL_BARS))
    print("  %-4s %-5s %8s %8s %8s %8s %8s %8s %8s"
          % ("inst", "tf", "n", "p10", "p25", "median", "p75", "p90", "brokeR"))
    allsc, rows = [], []
    for tag, sym, iv, rg in combos:
        try:
            b = bars(sym, iv, rg)
            a = atr_series(b)
            recs = run_engine(b, a, arbitrary_levels)
        except Exception as e:                            # noqa: BLE001
            print("  %-4s %-5s  FAILED %s" % (tag, iv, e), file=sys.stderr)
            continue
        sc = [r["score"] for r in recs]
        br = sum(1 for r in recs if r["broke"]) / max(1, len(recs))
        allsc += sc
        rows.append({"instrument": tag, "tf": iv, "n": len(sc),
                     "median": quantile(sc, .5), "p75": quantile(sc, .75),
                     "p25": quantile(sc, .25), "broke_rate": br})
        print("  %-4s %-5s %8d %8.3f %8.3f %8.3f %8.3f %8.3f %7.1f%%"
              % (tag, iv, len(sc), quantile(sc, .10), quantile(sc, .25),
                 quantile(sc, .50), quantile(sc, .75), quantile(sc, .90), 100 * br))

    med = quantile(allsc, .50)
    p70, p30 = quantile(allsc, .70), quantile(allsc, .30)
    spread = max(r["median"] for r in rows) - min(r["median"] for r in rows)
    print("\n  pooled n=%d   median %.3f   p30 %.3f   p70 %.3f" % (len(allsc), med, p30, p70))
    print("  median spread across the six instrument/timeframe cells: %.3f" % spread)
    print("\nREAD: the score is normalised by ATR, so if that normalisation works the")
    print("median should sit near the same place on every row above. The spread is how")
    print("well it actually holds. A level earns 'holding' above p70 of this null and")
    print("'failing' below p30 -- measured, not chosen.")
    if a_.json:
        with open(a_.json, "w") as f:
            json.dump({"pooled_median": med, "hold_threshold": p70,
                       "fail_threshold": p30, "n": len(allsc), "cells": rows}, f, indent=2)
        print("\nwrote %s" % a_.json)


if __name__ == "__main__":
    main()
