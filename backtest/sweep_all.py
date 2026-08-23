#!/usr/bin/env python3
"""Full grid: 6 signal families x 4 timeframes x 2 instruments x RR grid.

Reports, for every cell, the three numbers that actually decide a system:
    trades/day   (how often you get to act)
    win rate     (the thing the user asked to maximise)
    net expectancy in R, AFTER per-instrument transaction cost

The point of laying it out this way is that WR and expectancy move in
OPPOSITE directions as RR changes, and only expectancy pays. A cell with 80%
WR and negative expectancy is a losing system that feels good.

Split is chronological 60/40 with no refitting: parameters are frozen a
priori for every family.

Usage: python3 sweep_all.py [families...]
"""
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, mean                                # noqa: E402
from engine import (Feat, FAMILIES, execute, summarise,     # noqa: E402
                    INSTRUMENTS)

S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
     "/scratchpad")

# Dukascopy proxy -> the futures contract it stands in for
PROXY = {
    "MNQ": "USATECHIDXUSD",
    "MES": "USA500IDXUSD",
}
BARS_PER_SESSION = {"1m": 390, "3m": 130, "5m": 78, "15m": 26}
# scale the 5m-tuned cooldown/validity to each timeframe so the rules mean the
# same thing in clock time rather than in bars
TF_SCALE = {"1m": 5.0, "3m": 5.0 / 3.0, "5m": 1.0, "15m": 1.0 / 3.0}
RRS = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0]


def cost_bp(inst, px):
    return INSTRUMENTS[inst]["cost_pts"] / px * 1e4


def main():
    want = sys.argv[1:] or list(FAMILIES)
    print("=" * 118)
    print("FULL GRID — 3 years of Nasdaq-100 / S&P-500 index data, RTH only")
    print("cost: MNQ 1.50 index pts round turn | MES 0.80 index pts round turn"
          "   (both from CME tick specs)")
    print("=" * 118)

    best = []
    for inst in ("MNQ", "MES"):
        for tf in ("1m", "3m", "5m", "15m"):
            path = f"{S}/mtf/{PROXY[inst]}_{tf}.csv"
            b = load(path)
            F = Feat(b, BARS_PER_SESSION[tf])
            px = mean([b.c[i] for i in range(0, b.n, max(1, b.n // 500))])
            cb = cost_bp(inst, px)
            sessions = len({d for d in F.sess_id if d is not None})
            scale = TF_SCALE[tf]
            print(f"\n{'='*118}\n{inst}  {tf}   {b.n} bars   {sessions} sessions"
                  f"   index ~{px:.0f}   cost {INSTRUMENTS[inst]['cost_pts']} pts "
                  f"= {cb:.3f} bp\n{'='*118}")
            hdr = (f"  {'family':<11}{'RR':>5}{'trades':>8}{'t/day':>7}"
                   f"{'WR%':>7}{'expR':>8}{'PF':>7}{'t':>7}"
                   f"{'| OOS n':>8}{'OOS WR%':>9}{'OOS expR':>10}{'OOS PF':>8}")
            print(hdr)
            print("  " + "-" * 114)
            for fam in want:
                p = dict(cooldown=max(1, int(round(10 * scale))))
                sigs = FAMILIES[fam](F, p)
                if len(sigs) < 20:
                    print(f"  {fam:<11}{'— too few signals (' + str(len(sigs)) + ')':>40}")
                    continue
                cut = int(F.n * 0.6)
                for rr in RRS:
                    tr = execute(F, sigs, rr, INSTRUMENTS[inst]["cost_pts"],
                                 validity=max(2, int(round(24 * scale))),
                                 be_trigger=1.0)
                    if len(tr) < 25:
                        continue
                    s = summarise(tr)
                    tr_oos = [x for x in tr if x[3] >= cut]
                    o = summarise(tr_oos)
                    tpd = s["n"] / max(sessions, 1)
                    flag = ""
                    if s["exp"] > 0 and o["exp"] > 0 and o["n"] >= 25:
                        flag = "  <<"
                        best.append((o["exp"], inst, tf, fam, rr, s, o, tpd))
                    print(f"  {fam:<11}{rr:>5.2f}{s['n']:>8}{tpd:>7.2f}"
                          f"{s['wr']:>7.1f}{s['exp']:>8.3f}{s['pf']:>7.2f}"
                          f"{s['t']:>7.2f}{o['n']:>8}{o['wr']:>9.1f}"
                          f"{o['exp']:>10.3f}{o['pf']:>8.2f}{flag}")

    print(f"\n{'='*118}\nCELLS POSITIVE IN BOTH PANELS (ranked by out-of-sample expectancy)\n{'='*118}")
    best.sort(reverse=True, key=lambda x: x[0])
    print(f"  {'inst':<5}{'tf':>5}{'family':>11}{'RR':>6}{'trades':>8}{'t/day':>7}"
          f"{'WR%':>7}{'expR':>8}{'PF':>7}{'t':>7}{'| OOS expR':>11}{'OOS PF':>8}")
    print("  " + "-" * 100)
    for e, inst, tf, fam, rr, s, o, tpd in best[:30]:
        print(f"  {inst:<5}{tf:>5}{fam:>11}{rr:>6.2f}{s['n']:>8}{tpd:>7.2f}"
              f"{s['wr']:>7.1f}{s['exp']:>8.3f}{s['pf']:>7.2f}{s['t']:>7.2f}"
              f"{o['exp']:>11.3f}{o['pf']:>8.2f}")
    if not best:
        print("  NONE — no cell was positive in both panels.")


if __name__ == "__main__":
    main()
