#!/usr/bin/env python3
"""Is 2026 genuinely a different market, and can it be detected LIVE?

Two independent signal families (5m short-horizon reversal, 15m initial-
balance breakout) both show their entire edge concentrated in 2026. Either:

  (a) coincidence — two lucky draws from the same noisy grid, or
  (b) a real change in intraday market character that both families pick up.

If (b), the practical question is whether the change is detectable from data
available AT THE TIME, because a system that needs hindsight to know which
regime it is in is untradeable.

This script:
  1. measures per-year market character (realised vol, trend persistence,
     variance ratio, intraday range) to see WHAT changed;
  2. tests whether a CAUSAL regime filter — computable live — separates the
     good periods from the bad across BOTH families;
  3. checks whether the filter would have kept you out of 2023-2025 and in
     during 2026, without being told the year.

A filter that only works because it was built after seeing which years were
good is worthless. The test is whether one simple, pre-specified variable
does the job for both families at once.
"""
import datetime as dt
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, mean, stdev, pct                     # noqa: E402
from engine import Feat, FAMILIES, execute, summarise, INSTRUMENTS  # noqa: E402

S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
     "/scratchpad")


def year_of(ts):
    return dt.datetime.utcfromtimestamp(ts).year


def variance_ratio(rets, q):
    """VR(q) = Var(q-period return) / (q * Var(1-period)). >1 trending, <1 reverting."""
    if len(rets) < q * 30:
        return float("nan")
    v1 = stdev(rets) ** 2
    agg = [sum(rets[i:i + q]) for i in range(0, len(rets) - q, q)]
    if len(agg) < 10 or v1 <= 0:
        return float("nan")
    return (stdev(agg) ** 2) / (q * v1)


def main():
    b5 = load(f"{S}/mtf/USATECHIDXUSD_5m.csv")
    F5 = Feat(b5, 78)

    # ---------- 1. what changed, year by year ----------
    print("=" * 92)
    print("MARKET CHARACTER BY YEAR — Nasdaq-100, 5m RTH bars")
    print("=" * 92)
    byyr = defaultdict(list)
    rngyr = defaultdict(list)
    for i in range(1, b5.n):
        if F5.sess_id[i] is None:
            continue
        byyr[year_of(b5.t[i])].append(F5.logret[i] * 1e4)
        if F5.rng_sma[i]:
            rngyr[year_of(b5.t[i])].append(F5.rng[i] / b5.c[i] * 1e4)
    print(f"  {'year':<6}{'bars':>8}{'sd(5m ret) bp':>15}{'mean range bp':>15}"
          f"{'VR(6)':>9}{'VR(12)':>9}   interpretation")
    print("  " + "-" * 86)
    for y in sorted(byyr):
        r = byyr[y]
        vr6, vr12 = variance_ratio(r, 6), variance_ratio(r, 12)
        interp = ("mean-reverting" if vr12 < 0.95 else
                  "trending" if vr12 > 1.05 else "random-walk")
        print(f"  {y:<6}{len(r):>8}{stdev(r):>15.2f}{mean(rngyr[y]):>15.2f}"
              f"{vr6:>9.3f}{vr12:>9.3f}   {interp}")

    # ---------- 2. does a causal filter separate good from bad? ----------
    print("\n" + "=" * 92)
    print("CAUSAL REGIME FILTER — realised vol above its own trailing baseline")
    print("(pre-specified, computable live, identical for both families)")
    print("=" * 92)

    b15 = load(f"{S}/mtf/USATECHIDXUSD_15m.csv")
    F15 = Feat(b15, 26)
    COST = INSTRUMENTS["MNQ"]["cost_pts"]

    setups = [
        ("5m sweep RR4",     F5,  "sweep",    4.0, 24, dict(cooldown=10)),
        ("15m ib_break RR3", F15, "ib_break", 3.0, 8,  dict(cooldown=3)),
        ("15m momentum RR4", F15, "momentum", 4.0, 8,  dict(cooldown=3)),
    ]
    for name, F, fam, rr, val, p in setups:
        sigs = FAMILIES[fam](F, p)
        print(f"\n  {name}")
        print(f"    {'panel':<22}{'n':>6}{'WR%':>7}{'expR':>9}{'PF':>7}{'netR':>9}")
        print("    " + "-" * 58)
        for gate, tag in ((False, "all signals"), (True, "vol-gate ON only")):
            tr = execute(F, sigs, rr, COST, validity=val, be_trigger=1.0,
                         regime_gate=gate)
            s = summarise(tr)
            print(f"    {tag:<22}{s['n']:>6}{s['wr']:>7.1f}{s['exp']:>9.3f}"
                  f"{s['pf']:>7.2f}{s['net']:>9.1f}")
        # per-year with the gate on
        tr = execute(F, sigs, rr, COST, validity=val, be_trigger=1.0,
                     regime_gate=True)
        yr = defaultdict(list)
        for r_net, _, _, bar in tr:
            yr[year_of(F.b.t[bar])].append(r_net)
        cells = []
        for y in sorted(yr):
            cells.append(f"{y}:n{len(yr[y])}/exp{mean(yr[y]):+.2f}")
        print(f"    gated per-year: " + "  ".join(cells))

    # ---------- 3. the honest test ----------
    print("\n" + "=" * 92)
    print("VERDICT TEST")
    print("=" * 92)
    print("  A regime filter is only useful if it turns the BAD years")
    print("  non-negative WITHOUT being told which years were bad.")
    print("  Read the gated per-year rows above: if 2023-2025 are still")
    print("  negative after gating, the filter has not found the regime —")
    print("  it has only thinned the sample, and 2026 remains unexplained.")


if __name__ == "__main__":
    main()
