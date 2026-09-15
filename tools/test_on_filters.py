#!/usr/bin/env python3
"""Can the overnight-edge reversal be sharpened, or is 41% all there is?

The ON first touch clean-reverses 37-41% against a null of 21-26%. That is the only
measured edge in this repo. The question here is whether it splits: is there a
subset of sessions where it is materially better, and a subset where it is not worth
taking?

Two candidate filters, both computable at the RTH open with no lookahead:

    ON WIDTH   the overnight range, in ATR. A tight overnight into a session that
               expands is a different animal from a wide one that has already moved.
    OPEN GAP   where the session opens relative to the range: above it, inside it,
               below it. An edge approached from outside was already broken once.

Buckets are terciles of the SAME sample, so nothing is being selected on outcome.
Every bucket prints its n, because a 55% hit rate on n=18 is not a finding.

    python3 tools/test_on_filters.py --tf 60m --range 730d
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import find_reversal_zones as F  # noqa: E402


def run_tagged(b, a, days, kind):
    """ON engine, carrying the session context each touch happened under."""
    out = []
    lv = F.build_levels(b, days, kind, a)
    for d, L in lv.items():
        rth = days[d]["rth"]
        if not rth:
            continue
        i0 = rth[0]
        if i0 < 1 or a[i0 - 1] is None or a[i0 - 1] <= 0:
            continue
        oh, ol = F.hl(b, days[d]["on"])
        if oh is None or ol is None:
            continue
        atr0 = a[i0 - 1]
        width = (oh - ol) / atr0                      # ON range in ATR, known at the open
        op = b[i0][1]
        gap = "above" if op > oh else ("below" if op < ol else "inside")
        st = {nm: {"px": px, "fb": fb, "in": False, "last": -9999, "due": -1,
                   "dir": 0, "away": 0.0, "thru": 0.0} for nm, px, fb in L}
        for i in rth:
            if i < 1 or a[i - 1] is None or a[i - 1] <= 0:
                continue
            atr = a[i - 1]
            hw = max(1e-9, F.HALF_W_ATR * atr)
            hb, lb, cl = b[i][2], b[i][3], b[i][4]
            for nm, s in st.items():
                if i < s["fb"]:
                    continue
                p = s["px"]
                lo, hi = p - hw, p + hw
                inz = lb <= hi and hb >= lo
                if inz and not s["in"] and (i - s["last"]) > F.COOL_BARS:
                    dr = 1 if b[i - 1][4] > hi else (-1 if b[i - 1][4] < lo else (1 if cl > p else -1))
                    s.update(last=i, due=i + F.EVAL_BARS, dir=dr, away=0.0, thru=0.0)
                if s["due"] > 0 and i > s["last"] and i <= s["due"]:
                    dr = s["dir"]
                    s["away"] = max(s["away"], (hb - p) if dr == 1 else (p - lb))
                    s["thru"] = max(s["thru"], (p - lb) if dr == 1 else (hb - p))
                if s["due"] > 0 and i == s["due"]:
                    aw, th = s["away"], s["thru"]
                    out.append({"day": d, "name": nm, "width": width, "gap": gap,
                                "clean": (aw / atr) >= F.MFE_MIN and (th / atr) <= F.MAE_MAX})
                    s["due"] = -1
                s["in"] = inz
    return out


def rate(r):
    return (sum(1 for x in r if x["clean"]) / len(r), len(r)) if r else (float("nan"), 0)


def show(label, sub, base):
    c, n = rate(sub)
    if n < 15:
        print("    %-22s n=%-5d  %5.1f%%   -- too thin to read" % (label, n, 100 * c))
    else:
        print("    %-22s n=%-5d  %5.1f%%   vs null %.1f%%   edge %+5.1f pp"
              % (label, n, 100 * c, 100 * base, 100 * (c - base)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", default="60m")
    ap.add_argument("--range", default="730d")
    ap.add_argument("--symbol", default="NQ=F")
    a_ = ap.parse_args()

    b = F.bars(a_.symbol, a_.tf, a_.range)
    a = F.atr_series(b)
    days = F.sessionize(b)
    nses = sum(1 for d in days if days[d]["rth"])

    on = run_tagged(b, a, days, "ONH/ONL")
    nu = F.run(b, a, days, F.build_levels(b, days, "NULL", a))
    base, nn = rate(nu)
    ov, no = rate(on)
    print("%s %s/%s  %d sessions" % (a_.symbol, a_.tf, a_.range, nses))
    print("  baseline:  null %.1f%% (n=%d)   ON overall %.1f%% (n=%d)   edge %+.1f pp\n"
          % (100 * base, nn, 100 * ov, no, 100 * (ov - base)))

    ws = sorted(x["width"] for x in on)
    q1, q2 = ws[len(ws) // 3], ws[2 * len(ws) // 3]
    print("  FILTER 1 — overnight range width, in ATR (terciles: <%.2f, %.2f-%.2f, >%.2f)"
          % (q1, q1, q2, q2))
    show("narrow ON", [x for x in on if x["width"] < q1], base)
    show("mid ON", [x for x in on if q1 <= x["width"] <= q2], base)
    show("wide ON", [x for x in on if x["width"] > q2], base)

    print("\n  FILTER 2 — where the session opened relative to the ON range")
    for g in ("above", "inside", "below"):
        show("opened %s" % g, [x for x in on if x["gap"] == g], base)

    print("\n  FILTER 3 — the edge, crossed with the open")
    for nm in ("ONH", "ONL"):
        for g in ("above", "inside", "below"):
            show("%s, opened %s" % (nm, g), [x for x in on if x["name"] == nm and x["gap"] == g], base)

    print("\n  FILTER 4 — width crossed with edge")
    for nm in ("ONH", "ONL"):
        show("%s, narrow ON" % nm, [x for x in on if x["name"] == nm and x["width"] < q1], base)
        show("%s, wide ON" % nm, [x for x in on if x["name"] == nm and x["width"] > q2], base)


if __name__ == "__main__":
    main()
