#!/usr/bin/env python3
"""Fit and validate P(price reaches a level today), the first factor in the QT KEY score.

THE LABEL IS EXACT. A level sitting `u` ATRs above the prior close is reached by
today's session if and only if today's high clears it. Daily O/H/L answers that
with no path model and therefore no estimation error in the label itself -- which
is the whole reason this factor is fittable and the "does it reject once reached"
factor is not.

    anchor  = prior session close          (known before the open)
    scale   = Wilder ATR14 through the prior session   (known before the open)
    level   = anchor +/- u * scale
    hit_up  = high_t >= anchor + u*scale
    hit_dn  = low_t  <= anchor - u*scale

Both inputs are known before the open, so nothing here can leak. Up and down are
fitted SEPARATELY -- index drift and the asymmetry of volatility make a symmetric
fit measurably worse, and the script prints both curves so you can see it.

Model: Weibull survival  P(u) = exp(-(u/s)**k), fitted by binomial log-loss on the
train window and scored on a holdout window it never saw.

    python3 tools/calibrate_reach.py                 # both instruments
    python3 tools/calibrate_reach.py --json out.json # machine-readable

Stdlib only. Yahoo daily index data (^GSPC for ES, ^NDX for NQ).
"""
import argparse
import datetime as dt
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yahoo  # noqa: E402

GRID = [round(0.1 * i, 2) for i in range(1, 31)]     # 0.1 .. 3.0 ATR
TRAIN_END = 2019                                      # train <= this year, holdout after
EPS = 1e-9


def wilder_atr(bars, n=14):
    """ATR[i] uses bars 0..i inclusive. Consumers must read index i-1 for session i."""
    tr = [None] * len(bars)
    for i in range(1, len(bars)):
        _, _, h, l, _ = bars[i][0], bars[i][1], bars[i][2], bars[i][3], bars[i][4]
        pc = bars[i - 1][4]
        tr[i] = max(h - l, abs(h - pc), abs(l - pc))
    atr = [None] * len(bars)
    if len(bars) <= n:
        return atr
    seed = sum(tr[1:n + 1]) / n
    atr[n] = seed
    for i in range(n + 1, len(bars)):
        atr[i] = (atr[i - 1] * (n - 1) + tr[i]) / n
    return atr


def tally(bars, years=None):
    """Hit/total counts per grid point, up and down, over the selected sessions."""
    atr = wilder_atr(bars)
    up_h = [0] * len(GRID); up_n = [0] * len(GRID)
    dn_h = [0] * len(GRID); dn_n = [0] * len(GRID)
    used = 0
    for i in range(1, len(bars)):
        a = atr[i - 1]
        if a is None or a <= 0:
            continue
        y = dt.datetime.utcfromtimestamp(bars[i][0]).year
        if years is not None and not years(y):
            continue
        c = bars[i - 1][4]
        hi, lo = bars[i][2], bars[i][3]
        used += 1
        for j, u in enumerate(GRID):
            d = u * a
            up_n[j] += 1; dn_n[j] += 1
            if hi >= c + d:
                up_h[j] += 1
            if lo <= c - d:
                dn_h[j] += 1
    return {"sessions": used, "up": (up_h, up_n), "dn": (dn_h, dn_n)}


def logloss(hits, tots, s, k):
    ll = 0.0
    for j, u in enumerate(GRID):
        p = math.exp(-((u / s) ** k))
        p = min(1.0 - 1e-12, max(1e-12, p))
        ll -= hits[j] * math.log(p) + (tots[j] - hits[j]) * math.log(1.0 - p)
    return ll


def fit(hits, tots):
    """Coarse-to-fine grid on (s, k). Two params, a smooth surface -- no optimiser needed."""
    best = (None, None, float("inf"))
    lo_s, hi_s, lo_k, hi_k = 0.20, 4.00, 0.40, 4.00
    for _ in range(6):
        ss = [lo_s + (hi_s - lo_s) * i / 40.0 for i in range(41)]
        ks = [lo_k + (hi_k - lo_k) * i / 40.0 for i in range(41)]
        for s in ss:
            if s <= 0:
                continue
            for k in ks:
                if k <= 0:
                    continue
                v = logloss(hits, tots, s, k)
                if v < best[2]:
                    best = (s, k, v)
        s, k, _ = best
        ws, wk = (hi_s - lo_s) / 8.0, (hi_k - lo_k) / 8.0
        lo_s, hi_s = max(0.01, s - ws), s + ws
        lo_k, hi_k = max(0.01, k - wk), k + wk
    return best[0], best[1]


def score(hits, tots, s, k):
    """Calibration error on a window the fit never saw, in percentage points."""
    errs, rows = [], []
    for j, u in enumerate(GRID):
        emp = 100.0 * hits[j] / max(1, tots[j])
        pred = 100.0 * math.exp(-((u / s) ** k))
        errs.append(abs(emp - pred))
        rows.append((u, emp, pred, pred - emp))
    return {"mae_pp": sum(errs) / len(errs), "max_pp": max(errs), "rows": rows}


def run(name, symbol):
    bars = yahoo.daily_bars(symbol, start="2000-01-01")
    d0 = dt.datetime.utcfromtimestamp(bars[0][0]).date()
    d1 = dt.datetime.utcfromtimestamp(bars[-1][0]).date()
    tr = tally(bars, years=lambda y: y <= TRAIN_END)
    ho = tally(bars, years=lambda y: y > TRAIN_END)

    out = {"instrument": name, "symbol": symbol, "bars": len(bars),
           "first": str(d0), "last": str(d1),
           "train_sessions": tr["sessions"], "holdout_sessions": ho["sessions"],
           "train_years": "2000-%d" % TRAIN_END,
           "holdout_years": "%d-%s" % (TRAIN_END + 1, d1.year), "sides": {}}

    print("\n" + "=" * 74)
    print("%s   %s   %d daily bars   %s .. %s" % (name, symbol, len(bars), d0, d1))
    print("train %d sessions (2000-%d)   holdout %d sessions (%d-%d)"
          % (tr["sessions"], TRAIN_END, ho["sessions"], TRAIN_END + 1, d1.year))
    print("=" * 74)

    for side in ("up", "dn"):
        h_tr, n_tr = tr[side]
        h_ho, n_ho = ho[side]
        s, k = fit(h_tr, n_tr)
        sc_tr = score(h_tr, n_tr, s, k)
        sc_ho = score(h_ho, n_ho, s, k)
        out["sides"][side] = {"s": s, "k": k,
                              "train_mae_pp": sc_tr["mae_pp"],
                              "holdout_mae_pp": sc_ho["mae_pp"],
                              "holdout_max_pp": sc_ho["max_pp"],
                              "holdout_rows": sc_ho["rows"]}
        label = "ABOVE the prior close" if side == "up" else "BELOW the prior close"
        print("\n  %s      P(u) = exp(-(u/%.4f)^%.4f)" % (label, s, k))
        print("    train  MAE %.2f pp        holdout  MAE %.2f pp   worst %.2f pp"
              % (sc_tr["mae_pp"], sc_ho["mae_pp"], sc_ho["max_pp"]))
        print("      u ATR    holdout emp    model     err")
        for u, emp, pred, err in sc_ho["rows"]:
            if abs(u * 10 - round(u * 10)) < 1e-9 and round(u * 10) % 5 == 0:
                print("      %5.1f      %6.2f%%     %6.2f%%   %+6.2f" % (u, emp, pred, err))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="write the fitted parameters here")
    a = ap.parse_args()
    res = [run("ES", "^GSPC"), run("NQ", "^NDX")]
    print("\n" + "=" * 74)
    print("HEADLINE (what the indicator is allowed to claim):")
    for r in res:
        worst = max(r["sides"][s]["holdout_mae_pp"] for s in ("up", "dn"))
        print("  %s  %d train + %d holdout sessions   holdout MAE <= %.2f pp"
              % (r["instrument"], r["train_sessions"], r["holdout_sessions"], worst))
    print("=" * 74)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=2)
        print("wrote %s" % a.json)


if __name__ == "__main__":
    main()
