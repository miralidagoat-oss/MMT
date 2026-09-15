#!/usr/bin/env python3
"""Is a FORWARD-LOOKING volatility scale better than the backward-looking ATR?

The complaint is fair: ATR14 is a mean of the last 14 true ranges, so it describes
the volatility that has already happened. Implied volatility is the opposite --
it is the market's PRICED expectation of movement that has not happened yet, which
is the closest thing to a forward-looking number that exists without cheating.

This settles it by measurement rather than argument. Identical reach model, identical
train/holdout split, identical labels. The ONLY thing that changes is what scales the
distance:

    ATR      Wilder ATR14 through the prior session      backward-looking
    IV       prior close x (VXN or VIX / 100) / sqrt(252)  forward-looking
    BLEND    the average of the two

All three are known before the open, so none of them leak. Whichever calibrates
better on 1,600+ holdout sessions it has never seen, wins on the evidence.

    python3 tools/compare_scales.py
"""
import datetime as dt
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yahoo  # noqa: E402

GRID = [round(0.1 * i, 2) for i in range(1, 31)]
TRAIN_END = 2019
TD = math.sqrt(252.0)

PAIRS = [("ES", "^GSPC", "^VIX"), ("NQ", "^NDX", "^VXN")]


def wilder_atr(bars, n=14):
    tr = [None] * len(bars)
    for i in range(1, len(bars)):
        pc = bars[i - 1][4]
        tr[i] = max(bars[i][2] - bars[i][3], abs(bars[i][2] - pc), abs(bars[i][3] - pc))
    a = [None] * len(bars)
    if len(bars) <= n:
        return a
    a[n] = sum(tr[1:n + 1]) / n
    for i in range(n + 1, len(bars)):
        a[i] = (a[i - 1] * (n - 1) + tr[i]) / n
    return a


def tally(rows, scale_key, years):
    """rows: list of dicts with close_prev, high, low, the scales, and year."""
    uh = [0] * len(GRID); un = [0] * len(GRID)
    dh = [0] * len(GRID); dn = [0] * len(GRID)
    used = 0
    for r in rows:
        s = r[scale_key]
        if s is None or s <= 0 or not years(r["year"]):
            continue
        used += 1
        c, hi, lo = r["cprev"], r["high"], r["low"]
        for j, u in enumerate(GRID):
            d = u * s
            un[j] += 1; dn[j] += 1
            if hi >= c + d:
                uh[j] += 1
            if lo <= c - d:
                dh[j] += 1
    return used, (uh, un), (dh, dn)


def logloss(h, n, s, k):
    ll = 0.0
    for j, u in enumerate(GRID):
        p = min(1 - 1e-12, max(1e-12, math.exp(-((u / s) ** k))))
        ll -= h[j] * math.log(p) + (n[j] - h[j]) * math.log(1 - p)
    return ll


def fit(h, n):
    best = (None, None, float("inf"))
    ls, hs, lk, hk = 0.20, 4.0, 0.40, 4.0
    for _ in range(6):
        for i in range(41):
            s = ls + (hs - ls) * i / 40.0
            if s <= 0:
                continue
            for j in range(41):
                k = lk + (hk - lk) * j / 40.0
                if k <= 0:
                    continue
                v = logloss(h, n, s, k)
                if v < best[2]:
                    best = (s, k, v)
        s, k, _ = best
        ws, wk = (hs - ls) / 8.0, (hk - lk) / 8.0
        ls, hs = max(.01, s - ws), s + ws
        lk, hk = max(.01, k - wk), k + wk
    return best[0], best[1]


def mae(h, n, s, k, lo=0.0):
    e = []
    for j, u in enumerate(GRID):
        if u < lo:
            continue
        e.append(abs(100.0 * h[j] / max(1, n[j]) - 100.0 * math.exp(-((u / s) ** k))))
    return sum(e) / len(e)


def main():
    print("FORWARD-LOOKING (implied vol) vs BACKWARD-LOOKING (ATR14) as the distance scale.")
    print("Same model, same labels, same split. Only the scale changes.\n")
    for tag, idx, vix in PAIRS:
        ib = yahoo.daily_bars(idx, start="2001-01-01")
        vb = yahoo.daily_bars(vix, start="2001-01-01")
        vmap = {dt.datetime.utcfromtimestamp(r[0]).date(): r[4] for r in vb}
        atr = wilder_atr(ib)

        rows = []
        for i in range(1, len(ib)):
            d = dt.datetime.utcfromtimestamp(ib[i][0]).date()
            dp = dt.datetime.utcfromtimestamp(ib[i - 1][0]).date()
            a = atr[i - 1]
            v = vmap.get(dp)                      # PRIOR session's close of the vol index
            cp = ib[i - 1][4]
            iv = (cp * (v / 100.0) / TD) if v else None
            rows.append({"year": d.year, "cprev": cp, "high": ib[i][2], "low": ib[i][3],
                         "ATR": a, "IV": iv,
                         "BLEND": (0.5 * (a + iv)) if (a and iv) else None})

        print("=" * 72)
        print("%s   %s scaled by %s   %d sessions" % (tag, idx, vix, len(rows)))
        print("=" * 72)
        print("  %-7s %-6s %9s %9s %11s %11s"
              % ("scale", "side", "s", "k", "holdMAE", "holdMAE>=0.4"))
        res = {}
        for sk in ("ATR", "IV", "BLEND"):
            tot = 0.0; tot4 = 0.0
            for side in (0, 1):
                ntr, up_tr, dn_tr = tally(rows, sk, lambda y: y <= TRAIN_END)
                nho, up_ho, dn_ho = tally(rows, sk, lambda y: y > TRAIN_END)
                h_tr, n_tr = (up_tr if side == 0 else dn_tr)
                h_ho, n_ho = (up_ho if side == 0 else dn_ho)
                s, k = fit(h_tr, n_tr)
                m = mae(h_ho, n_ho, s, k)
                m4 = mae(h_ho, n_ho, s, k, lo=0.4)
                tot += m; tot4 += m4
                print("  %-7s %-6s %9.4f %9.4f %10.2fpp %10.2fpp"
                      % (sk, "up" if side == 0 else "down", s, k, m, m4))
            res[sk] = (tot / 2, tot4 / 2)
        print("  ----")
        for sk in ("ATR", "IV", "BLEND"):
            print("  %-7s mean holdout MAE %6.2fpp    (levels >= 0.4 scale: %5.2fpp)"
                  % (sk, res[sk][0], res[sk][1]))
        win = min(res, key=lambda x: res[x][1])
        print("  >>> best on the holdout it never saw: %s" % win)
        print()


if __name__ == "__main__":
    main()
