#!/usr/bin/env python3
"""Replay the banked gamma keys against price. The experiment the archive exists for.

Waits until tools/archive_key.py has banked enough sessions, then runs the SAME engine
used everywhere else in this repo over the actual gamma levels and compares them to
the null. This is the only test that can tell you whether QT KEY's gamma weighting
does anything, because its levels sit on a strike grid already measured as carrying
no edge (25-pt grid 26.7%, null 25.9%).

It will refuse to draw a conclusion on a thin archive rather than produce a number
that looks like one.

    python3 tools/test_gamma_levels.py
    python3 tools/test_gamma_levels.py --min 40     # lower the bar, knowingly

The key is in CASH index points and intraday data is futures, so each session's
levels are shifted by that session's basis, estimated from the cash-vs-futures daily
closes on the anchor date. Same translation the indicator does live.
"""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import find_reversal_zones as F  # noqa: E402
import yahoo  # noqa: E402

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "keys", "archive.jsonl")
FUT = {"ES": "ES=F", "NQ": "NQ=F"}
CASH = {"ES": "^GSPC", "NQ": "^NDX"}


def load(tag):
    if not os.path.exists(ARCHIVE):
        return []
    out = []
    with open(ARCHIVE) as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                r = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if r.get("tag") == tag:
                out.append(r)
    return {r["session"]: r for r in out}      # dedupe, last wins


def basis_by_date(tag):
    """futures close - cash close, per date. The key is cash; the chart is not."""
    fb = yahoo.daily_bars(FUT[tag], start="2026-01-01")
    cb = yahoo.daily_bars(CASH[tag], start="2026-01-01")
    c = {dt.datetime.utcfromtimestamp(r[0]).date(): r[4] for r in cb}
    return {dt.datetime.utcfromtimestamp(r[0]).date(): r[4] - c[dt.datetime.utcfromtimestamp(r[0]).date()]
            for r in fb if dt.datetime.utcfromtimestamp(r[0]).date() in c}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", default="15m")
    ap.add_argument("--range", default="60d")
    ap.add_argument("--min", type=int, default=60, help="sessions required before concluding")
    a_ = ap.parse_args()

    for tag in ("ES", "NQ"):
        arc = load(tag)
        print("=" * 70)
        print("%s  %d sessions banked" % (tag, len(arc)))
        if len(arc) < a_.min:
            print("  NOT ENOUGH. Need %d, have %d. Keep running tools/archive_key.py daily."
                  % (a_.min, len(arc)))
            print("  Refusing to print a hit rate that would be noise dressed as a result.")
            continue

        b = F.bars(FUT[tag], a_.tf, a_.range)
        a = F.atr_series(b)
        days = F.sessionize(b)
        bas = basis_by_date(tag)

        lv = {}
        for d in days:
            key = arc.get(d.strftime("%Y%m%d"))
            if not key or not days[d]["rth"]:
                continue
            off = bas.get(d - dt.timedelta(days=1), 0.0)     # basis as of the anchor
            lv[d] = [("G%d" % l["grade"], l["px"] + off, days[d]["rth"][0])
                     for l in key["levels"]]
        recs = F.run(b, a, days, lv)
        nu = F.run(b, a, days, F.build_levels(b, days, "NULL", a))
        if not recs:
            print("  no touches in the intraday window -- widen --range")
            continue
        cg = sum(1 for x in recs if x["clean"]) / len(recs)
        cn = sum(1 for x in nu if x["clean"]) / len(nu)
        print("  gamma levels   %5.1f%% clean  (n=%d)" % (100 * cg, len(recs)))
        print("  null           %5.1f%% clean  (n=%d)" % (100 * cn, len(nu)))
        print("  EDGE           %+5.1f pp" % (100 * (cg - cn)))
        print("\n  by grade (does the ranking mean anything?):")
        for g in (5, 4, 3, 2, 1):
            sub = [x for x in recs if x["name"] == "G%d" % g]
            if len(sub) < 15:
                print("    %d/5  n=%-4d  too thin" % (g, len(sub)))
            else:
                c = sum(1 for x in sub if x["clean"]) / len(sub)
                print("    %d/5  n=%-4d  %5.1f%%  (%+5.1f pp)" % (g, len(sub), 100 * c, 100 * (c - cn)))


if __name__ == "__main__":
    main()
