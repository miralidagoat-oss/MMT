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
import statistics  # noqa: E402

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


def basis_by_session(tag, tf, rng):
    """futures minus cash, measured INTRADAY, per session. The key is cash; the chart
    is not, so every level has to be shifted by the offset that was in force.

    THIS MUST NOT USE DAILY CLOSES. Yahoo's daily continuous series is adjusted on a
    different convention from its intraday series, and the two disagree enormously:
    on 2026-09-16 the daily close difference said +18 while the intraday RTH median
    said +307. Taking the daily figure put every archived level ~290 points from
    where it belonged and turned a session with five zone touches into one with none
    -- a clean-looking null produced entirely by the measurement.

    Matching 5-minute bars during RTH and taking the median is what the indicator
    itself does, and it survives the contract roll: NQ=F rolled on 2026-09-14 and the
    basis stepped from +21 to +307 between two sessions, which a per-session median
    reports faithfully and a smoothed series would have smeared across both.
    """
    fb = bars_for(FUT[tag], tf, rng)
    cb = bars_for(CASH[tag], tf, rng)
    cm = {r[0]: r[4] for r in cb}
    by = {}
    for r in fb:
        if r[0] not in cm:
            continue
        t = dt.datetime.utcfromtimestamp(r[0])
        mins = t.hour * 60 + t.minute
        if 13 * 60 + 30 <= mins < 20 * 60:          # RTH in UTC, where cash is ticking
            by.setdefault(F.et(r[0]).date(), []).append(r[4] - cm[r[0]])
    return {d: statistics.median(v) for d, v in by.items() if len(v) >= 20}


def bars_for(sym, tf, rng):
    return F.bars(sym, tf, rng)


def frozen_basis(bas, d):
    """The offset in force for session d: measured on the PREVIOUS session that had a
    measurement, never on d itself and never defaulted to zero. A calendar d-1 lookup
    silently returns nothing every Monday, and a zero default is the exact failure the
    indicator refuses to make -- a missing basis draws nothing rather than drawing the
    cash frame and calling it the chart's."""
    prev = [x for x in sorted(bas) if x < d]
    return bas[prev[-1]] if prev else None


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
        bas = basis_by_session(tag, a_.tf, a_.range)

        lv = {}
        skipped = 0
        for d in days:
            key = arc.get(d.strftime("%Y%m%d"))
            if not key or not days[d]["rth"]:
                continue
            off = frozen_basis(bas, d)
            if off is None:                      # no measurement: draw nothing
                skipped += 1
                continue
            lv[d] = [("G%d" % l["grade"], l["px"] + off, days[d]["rth"][0])
                     for l in key["levels"]]
        if skipped:
            print("  %d archived session(s) skipped: no prior-session basis" % skipped)
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
