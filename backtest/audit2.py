#!/usr/bin/env python3
"""AUDIT PART 2 — data integrity and data-mining correction.

Part 1 stress-tested the strategy. This part stress-tests the DATA and the
SEARCH PROCESS that produced the strategy, which is where most backtests
actually die.

  A. Is the "NQ cross-validation" independent?  (spoiler: check the prices)
  B. Contract-roll gaps in a Yahoo continuous series - do they manufacture
     fake sweep signals?
  C. Volume-filter integrity on zero-volume bars.
  D. Fixed Monte Carlo: bootstrap terminal wealth (shuffling cannot change
     a sum - part 1's ending-equity block was degenerate by construction).
  E. Drop-the-best-quarter / jackknife robustness.
  F. Data-mining correction: how many configurations were searched, and what
     is the best PF you would expect from PURE NOISE after that many looks?

Usage: python3 audit2.py <mnq_dir> <nq_dir>
"""
import csv
import datetime
import itertools
import math
import os
import random
import statistics
import sys
import zoneinfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit import load, run, summarize, line, pf_of, BASE, DOLLARS_PER_PT  # noqa: E402

ET = zoneinfo.ZoneInfo("America/New_York")
random.seed(20260811)


def hr():
    print("─" * 100)


# ── A. independence of the NQ "cross-validation" ─────────────────────────────

def test_independence(mnq, nq):
    print("\n" + "=" * 100)
    print("TEST A — IS THE 'NQ CROSS-VALIDATION' ACTUALLY INDEPENDENT?")
    print("=" * 100)
    m = {r[0]: r for r in mnq}
    q = {r[0]: r for r in nq}
    common = sorted(set(m) & set(q))
    print(f"   MNQ bars {len(mnq)}, NQ bars {len(nq)}, shared timestamps {len(common)}")
    if not common:
        print("   no overlap")
        return
    diffs = [abs(m[t][4] - q[t][4]) for t in common]
    rel = [abs(m[t][4] - q[t][4]) / q[t][4] for t in common]
    ident = sum(1 for d in diffs if d < 1e-9)
    within_tick = sum(1 for d in diffs if d <= 0.5)
    print(f"   mean |close difference| = {statistics.mean(diffs):.4f} pts "
          f"({100*statistics.mean(rel):.6f}%)")
    print(f"   bars identical to the cent      : {ident:,} / {len(common):,} "
          f"({100*ident/len(common):.1f}%)")
    print(f"   bars within half a point        : {within_tick:,} / {len(common):,} "
          f"({100*within_tick/len(common):.1f}%)")
    # correlation of returns
    mr, qr = [], []
    for a, b in zip(common[:-1], common[1:]):
        mr.append(math.log(m[b][4] / m[a][4]))
        qr.append(math.log(q[b][4] / q[a][4]))
    mm, qm = statistics.mean(mr), statistics.mean(qr)
    cov = sum((x - mm) * (y - qm) for x, y in zip(mr, qr))
    sx = math.sqrt(sum((x - mm) ** 2 for x in mr))
    sy = math.sqrt(sum((y - qm) ** 2 for y in qr))
    corr = cov / (sx * sy) if sx and sy else 0
    print(f"   return correlation MNQ vs NQ    : {corr:.6f}")
    print()
    if corr > 0.90 or within_tick / len(common) > 0.5:
        print("   *** VERDICT: NOT AN INDEPENDENT TEST. ***")
        print("   MNQ and NQ are the same underlying index (Nasdaq-100) and this")
        print("   data source returns effectively the SAME price series for both.")
        print("   The 'NQ cross-validation' re-tested the identical price path with")
        print("   different cost assumptions. It confirms nothing about robustness.")
        print("   Genuine out-of-sample would require a DIFFERENT market or a")
        print("   DIFFERENT time period, not a different ticker on the same index.")
    hr()


# ── B. contract-roll gaps ────────────────────────────────────────────────────

def test_rolls(mnq):
    print("\n" + "=" * 100)
    print("TEST B — CONTRACT-ROLL GAPS IN THE CONTINUOUS SERIES")
    print("=" * 100)
    gaps = []
    for i in range(1, len(mnq)):
        prev_c = mnq[i - 1][4]
        gap = abs(mnq[i][1] - prev_c)
        if prev_c > 0:
            gaps.append((gap / prev_c, i, gap))
    gaps.sort(reverse=True)
    print("   largest bar-to-bar gaps (open vs prior close):")
    for pct, i, g in gaps[:10]:
        d = datetime.datetime.fromtimestamp(mnq[i][0], ET)
        print(f"      {d:%Y-%m-%d %H:%M}  gap {g:8.2f} pts ({100*pct:.2f}%)")
    big = [x for x in gaps if x[0] > 0.005]
    print(f"\n   gaps > 0.5%: {len(big)}")
    print("   A continuous futures series splices quarterly contracts together.")
    print("   Those splice points are NOT tradeable price moves, but the sweep")
    print("   detector treats them as real breaks of the 12-bar extreme.")

    # how many signals fire within 3 bars of a big gap?
    cl = run(mnq)
    gap_bars = {x[1] for x in big}
    near = 0
    for x in cl:
        if any(abs(x[0] - gb) <= 3 for gb in gap_bars):
            near += 1
    print(f"\n   trades signalled within 3 bars of a >0.5% gap: {near} / {len(cl)}")
    hr()


# ── C. volume integrity ──────────────────────────────────────────────────────

def test_volume(mnq):
    print("\n" + "=" * 100)
    print("TEST C — VOLUME-FILTER INTEGRITY")
    print("=" * 100)
    z = sum(1 for r in mnq if r[5] == 0)
    print(f"   zero-volume bars: {z:,} / {len(mnq):,} ({100*z/len(mnq):.1f}%)")
    print("   The gate is  volume * wickFrac >= SMA(volume,20) * 0.8")
    print("   On a zero-volume bar the left side is 0, so the gate ALWAYS fails")
    print("   -> real signals are silently discarded whenever the feed drops volume.")
    base = run(mnq)
    novol = run(mnq, {"vol_mult": 0.0})
    line("with volume gate (0.8x)", base)
    line("volume gate disabled", novol)
    print(f"\n   the gate removes {summarize(novol)['n'] - summarize(base)['n']} trades "
          f"and changes netR by {summarize(base)['net'] - summarize(novol)['net']:+.1f}R")
    hr()


# ── D. corrected Monte Carlo ─────────────────────────────────────────────────

def test_mc_fixed(cl, acct=25000.0, iters=20000):
    print("\n" + "=" * 100)
    print(f"TEST D — CORRECTED MONTE CARLO (bootstrap, not shuffle) ${acct:,.0f}, 1 contract")
    print("=" * 100)
    dollars = [x[4] * x[5] * DOLLARS_PER_PT["MNQ"] for x in cl]
    n = len(dollars)
    ends, dds = [], []
    for _ in range(iters):
        eq = acct
        peak = acct
        dd = 0.0
        for _ in range(n):
            eq += dollars[random.randrange(n)]
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
        ends.append(eq)
        dds.append(dd)
    ends.sort(); dds.sort()

    def q(a, x):
        return a[min(len(a) - 1, int(len(a) * x))]

    print(f"   simulating {n} trades (~2.4 years of signals) 20,000 times:\n")
    print(f"   ending equity:  p05 ${q(ends,0.05):>8,.0f}   p25 ${q(ends,0.25):>8,.0f}   "
          f"median ${q(ends,0.50):>8,.0f}")
    print(f"                   p75 ${q(ends,0.75):>8,.0f}   p95 ${q(ends,0.95):>8,.0f}")
    print(f"   max drawdown:   median ${q(dds,0.50):>7,.0f}  p95 ${q(dds,0.95):>7,.0f}  "
          f"p99 ${q(dds,0.99):>7,.0f}")
    below = 100.0 * sum(1 for e in ends if e < acct) / len(ends)
    print(f"\n   P(you finish 2.4 years BELOW where you started) = {below:.1f}%")
    print(f"   P(you finish down more than 10%)               = "
          f"{100.0*sum(1 for e in ends if e < acct*0.9)/len(ends):.1f}%")
    hr()


# ── E. jackknife ─────────────────────────────────────────────────────────────

def test_jackknife(cl):
    print("\n" + "=" * 100)
    print("TEST E — JACKKNIFE: HOW CONCENTRATED IS THE PROFIT?")
    print("=" * 100)
    rs = sorted([x[4] for x in cl], reverse=True)
    tot = sum(rs)
    print(f"   total netR {tot:+.1f} from {len(rs)} trades")
    for k in (1, 2, 3, 5):
        print(f"   remove the {k} best trade(s): netR {tot - sum(rs[:k]):+7.1f}   "
              f"PF {pf_of(rs[k:]):.2f}")
    wins = [r for r in rs if r > 0]
    print(f"\n   {len(wins)} winning trades carry the entire result.")
    print(f"   top winner alone = {100*rs[0]/tot if tot else 0:.0f}% of total profit.")
    # quarterly jackknife
    print("\n   drop-one-quarter:")
    buckets = {}
    for x in cl:
        d = datetime.datetime.fromtimestamp(x[1], ET)
        buckets.setdefault(f"{d.year}-Q{(d.month-1)//3+1}", []).append(x[4])
    for k in sorted(buckets):
        rest = [v for kk, vv in buckets.items() if kk != k for v in vv]
        print(f"      without {k}: netR {sum(rest):+6.1f}  PF {pf_of(rest):.2f}")
    hr()


# ── F. data-mining correction ────────────────────────────────────────────────

def test_datamining(mnq, iters=2000):
    print("\n" + "=" * 100)
    print("TEST F — DATA-MINING CORRECTION")
    print("=" * 100)
    grid = dict(
        rb_lookback=[8, 10, 12, 14, 16, 20],
        body_thresh=[0.25, 0.30, 0.33, 0.38, 0.45],
        min_close_pos=[0.60, 0.65, 0.70, 0.75, 0.80],
        sweep_sigma=[0.25, 0.50, 0.75, 1.00, 1.25],
        stop_sigma=[1.0, 1.25, 1.5, 1.75, 2.0],
        rr=[2.0, 3.0, 4.0, 5.0, 6.0],
        be_trigger=[0.0, 0.5, 1.0, 1.5, 2.0],
    )
    total = 1
    for v in grid.values():
        total *= len(v)
    print(f"   the parameter space explored across this project is >= {total:,} "
          f"configurations")
    print("   (plus 720 ORB configs, plus the level-sweep family, plus 6 timeframes,")
    print("    plus 3 tickers -> the true number of 'looks' at this data is in the")
    print("    tens of thousands)\n")

    keys = list(grid)
    best = []
    for _ in range(iters):
        p = {k: random.choice(grid[k]) for k in keys}
        s = summarize(run(mnq, p))
        if s["n"] >= 20:
            best.append((s["pf"] if s["pf"] != float("inf") else 9.9, s["net"], p))
    best.sort(key=lambda x: (x[0], x[1]), reverse=True)
    print(f"   random search over {iters:,} configurations (n>=20 trades):")
    for pf, net, p in best[:5]:
        short = " ".join(f"{k}={v}" for k, v in p.items())
        print(f"      PF {pf:5.2f}  netR {net:+6.1f}   {short}")
    pfs = [b[0] for b in best]
    print(f"\n   {sum(1 for x in pfs if x > 1.4)} of {len(pfs)} random configs "
          f"({100*sum(1 for x in pfs if x>1.4)/len(pfs):.0f}%) beat PF 1.40")
    print(f"   {sum(1 for x in pfs if x > 2.0)} of {len(pfs)} "
          f"({100*sum(1 for x in pfs if x>2.0)/len(pfs):.0f}%) beat PF 2.00")
    print(f"   median PF across the whole space: {statistics.median(pfs):.2f}")
    print("\n   *** If a large share of ARBITRARY configurations 'beat' the shipped one,")
    print("   the shipped one was selected by noise, not by edge. ***")
    hr()


def main(mnq_dir, nq_dir):
    mnq = load(os.path.join(mnq_dir, "MNQ_1h.csv"))
    nq = load(os.path.join(nq_dir, "NQ_1h.csv"))
    base = run(mnq)
    print("=" * 100)
    print("AUDIT PART 2 — DATA INTEGRITY & DATA-MINING CORRECTION")
    print("=" * 100)
    line("BASELINE MNQ 1H (true ET, costed)", base)
    test_independence(mnq, nq)
    test_rolls(mnq)
    test_volume(mnq)
    test_mc_fixed(base)
    test_jackknife(base)
    test_datamining(mnq)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
