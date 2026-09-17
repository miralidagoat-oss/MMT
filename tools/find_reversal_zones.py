#!/usr/bin/env python3
"""Hunt for intraday NQ levels that actually reverse price, and measure them honestly.

The question this answers is NOT "do these levels work" -- every level "works"
sometimes. It is "do they work better than a level chosen with no information in
it", which is the only version of the question that can be wrong.

The null comes from tools/calibrate_outcome.py, which runs this same engine over
levels placed at prior_close +/- k*ATR. Anything here has to beat that.

Candidates, all computable from information available BEFORE the touch:
    PDH / PDL / PDC   prior RTH session high, low, close
    ONH / ONL         overnight (18:00 ET prev -> 09:30 ET) high and low
    IBH / IBL         initial balance: first 60 min of RTH, tested only after it closes
    ROUND             nearest round numbers (100s / 250s) around the open
    NULL              the baseline: prior close +/- k*ATR, no information

Two metrics per level type:
    score       the indicator's own: (excursion away - excursion through) / ATR
    clean rev   MFE >= 1.0 ATR in the reversal direction AND MAE <= 0.3 ATR through it
                -- a reversal you could actually have traded, not merely a wiggle

Stdlib only.
"""
import argparse
import datetime as dt
import os
import sys
import urllib.parse
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yahoo  # noqa: E402

ET = ZoneInfo("America/New_York")

EVAL_BARS = 5          # identical to the indicator and to the null
COOL_BARS = 10
HALF_W_ATR = 0.075
EV_CLAMP = 1.5
MFE_MIN = 1.0          # "clean reversal" thresholds, in ATR
MAE_MAX = 0.3


def bars(symbol, interval, rng):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol) + "?interval=" + interval + "&range=" + rng)
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


def et(epoch):
    return dt.datetime.fromtimestamp(epoch, ET)


def sessionize(b):
    """Group bar indices by ET trading date, split into overnight and RTH."""
    days = {}
    for i, r in enumerate(b):
        t = et(r[0])
        mins = t.hour * 60 + t.minute
        if mins >= 18 * 60:                 # 18:00 ET belongs to the NEXT day's session
            d = (t.date() + dt.timedelta(days=1))
        else:
            d = t.date()
        while d.weekday() >= 5:
            d += dt.timedelta(days=1)
        rec = days.setdefault(d, {"on": [], "rth": []})
        rec["rth" if 9 * 60 + 30 <= mins < 16 * 60 else "on"].append(i)
    return days


def hl(b, idx):
    if not idx:
        return None, None
    return max(b[i][2] for i in idx), min(b[i][3] for i in idx)


def build_levels(b, days, kind, a_glob=None):
    """{date: [(name, price, first_testable_bar_index), ...]} -- never lookahead."""
    out = {}
    ds = sorted(days)
    for n, d in enumerate(ds):
        rth = days[d]["rth"]
        if not rth:
            continue
        start = rth[0]
        lv = []
        if kind in ("PDH/PDL", "PDC"):
            if n == 0:
                continue
            prth = days[ds[n - 1]]["rth"]
            if not prth:
                continue
            ph, pl = hl(b, prth)
            if kind == "PDH/PDL":
                lv = [("PDH", ph, start), ("PDL", pl, start)]
            else:
                lv = [("PDC", b[prth[-1]][4], start)]
        elif kind == "ONH/ONL":
            oh, ol = hl(b, days[d]["on"])
            if oh is None:
                continue
            lv = [("ONH", oh, start), ("ONL", ol, start)]
        elif kind == "IBH/IBL":
            ib = [i for i in rth if (et(b[i][0]).hour * 60 + et(b[i][0]).minute) < 10 * 60 + 30]
            if len(ib) < 2:
                continue
            ih, il = hl(b, ib)
            after = ib[-1] + 1                      # only testable once the IB has closed
            lv = [("IBH", ih, after), ("IBL", il, after)]
        elif kind == "NULL":
            # the baseline: prior close +/- k*ATR. No information in it whatsoever.
            if n == 0:
                continue
            prth = days[ds[n - 1]]["rth"]
            if not prth or a_glob[start - 1] is None or a_glob[start - 1] <= 0:
                continue
            pc, at = b[prth[-1]][4], a_glob[start - 1]
            lv = [("N%+.1f" % k, pc + k * at, start)
                  for k in (-1.5, -1.0, -0.6, -0.3, 0.3, 0.6, 1.0, 1.5)]
        elif kind == "ROUND":
            op = b[start][1]
            step = 100.0
            base = round(op / step) * step
            lv = [("R%+d" % k, base + k * step, start) for k in (-2, -1, 0, 1, 2)]
        out[d] = [(nm, px, fb) for nm, px, fb in lv if px]
    return out


def run(b, a, days, levels):
    """The indicator's engine, restricted to RTH bars. One record per scored touch."""
    recs = []
    for d, lv in levels.items():
        rth = days[d]["rth"]
        if not rth:
            continue
        st = {nm: {"px": px, "fb": fb, "in": False, "last": -9999, "due": -1,
                   "dir": 0, "away": 0.0, "thru": 0.0} for nm, px, fb in lv}
        for i in rth:
            if a[i - 1] is None or a[i - 1] <= 0 or i < 1:
                continue
            atr = a[i - 1]
            hw = max(1e-9, HALF_W_ATR * atr)
            hi_b, lo_b, cl = b[i][2], b[i][3], b[i][4]
            for nm, s in st.items():
                if i < s["fb"]:
                    continue
                p = s["px"]
                lo, hi = p - hw, p + hw
                inz = lo_b <= hi and hi_b >= lo
                if inz and not s["in"] and (i - s["last"]) > COOL_BARS:
                    dd = 1 if b[i - 1][4] > hi else (-1 if b[i - 1][4] < lo else (1 if cl > p else -1))
                    s.update(last=i, due=i + EVAL_BARS, dir=dd, away=0.0, thru=0.0)
                if s["due"] > 0 and i > s["last"] and i <= s["due"]:
                    dd = s["dir"]
                    aw = (hi_b - p) if dd == 1 else (p - lo_b)
                    th = (p - lo_b) if dd == 1 else (hi_b - p)
                    s["away"] = max(s["away"], aw)
                    s["thru"] = max(s["thru"], th)
                if s["due"] > 0 and i == s["due"]:
                    aw, th = s["away"], s["thru"]
                    unit = max(atr, hw)
                    raw = (aw - th) / unit
                    recs.append({
                        "day": d, "name": nm,
                        "score": max(-EV_CLAMP, min(EV_CLAMP, raw)),
                        "mfe": aw / atr, "mae": th / atr,
                        "clean": (aw / atr) >= MFE_MIN and (th / atr) <= MAE_MAX,
                    })
                    s["due"] = -1
                s["in"] = inz
    return recs


def q(xs, p):
    if not xs:
        return float("nan")
    s = sorted(xs)
    f = p * (len(s) - 1)
    lo = int(f)
    return s[lo] + (s[min(lo + 1, len(s) - 1)] - s[lo]) * (f - lo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="NQ=F")
    ap.add_argument("--tf", default="5m")
    ap.add_argument("--range", default="60d")
    a_ = ap.parse_args()

    b = bars(a_.symbol, a_.tf, a_.range)
    a = atr_series(b)
    days = sessionize(b)
    nses = sum(1 for d in days if days[d]["rth"])
    print("%s %s over %s -- %d bars, %d RTH sessions (%s .. %s)"
          % (a_.symbol, a_.tf, a_.range, len(b), nses,
             min(days), max(days)))
    print("\nclean reversal = MFE >= %.1f ATR in the reversal direction AND MAE <= %.1f ATR through it"
          % (MFE_MIN, MAE_MAX))
    print("null (from calibrate_outcome.py, arbitrary levels): median score +0.21, p70 +1.16\n")
    print("  %-10s %7s %8s %9s %9s %9s %10s"
          % ("level", "n", "median", "rev rate", "CLEAN", "sess:touch", "sess:clean"))

    kinds = ["NULL", "PDH/PDL", "PDC", "ONH/ONL", "IBH/IBL", "ROUND"]
    for k in kinds:
        lv = build_levels(b, days, k, a)
        recs = run(b, a, days, lv)
        if not recs:
            print("  %-10s  no touches" % k)
            continue
        sc = [r["score"] for r in recs]
        rev = sum(1 for r in recs if r["score"] > 0) / len(recs)
        cln = sum(1 for r in recs if r["clean"]) / len(recs)
        dd = len({r["day"] for r in recs if r["clean"]})
        td = len({r["day"] for r in recs})
        print("  %-10s %7d %8.3f %8.1f%% %8.1f%% %8.1f%% %9.1f%%"
              % (k, len(recs), q(sc, .5), 100 * rev, 100 * cln,
                 100 * td / max(1, nses), 100 * dd / max(1, nses)))

    # per-name breakdown for the two most promising families
    print("\n  per-level detail:")
    for k in ("ONH/ONL", "IBH/IBL", "PDH/PDL"):
        lv = build_levels(b, days, k, a)
        recs = run(b, a, days, lv)
        for nm in sorted({r["name"] for r in recs}):
            sub = [r for r in recs if r["name"] == nm]
            sc = [r["score"] for r in sub]
            cln = sum(1 for r in sub if r["clean"]) / len(sub)
            print("    %-6s n=%-5d median %+.3f   clean %.1f%%"
                  % (nm, len(sub), q(sc, .5), 100 * cln))


if __name__ == "__main__":
    main()
