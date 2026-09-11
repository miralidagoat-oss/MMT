#!/usr/bin/env python3
"""Prove the strategy build's SIGNAL ENGINE is byte-identical to the indicator's.

The strategy was written by replacing the indicator's simulated trade tracker
with real TradingView orders. Everything that decides WHETHER a trade is taken
- the liquidity map, the sweep/reclaim trigger, the PO3 gate, the presets, the
entry/stop/target arithmetic - must be the same text in both files, or the
Strategy Tester is grading a different system from the one the research
validated. Re-typing is exactly how such a drift happens, so this diffs the
shared regions character by character rather than trusting that it did not.
"""
import difflib
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IND = os.path.join(HERE, "indicators", "po3_vwap_liquidity_sweep.pine")
STR = os.path.join(HERE, "indicators", "arashi_strategy.pine")

# (name, start marker, end marker). The end marker is exclusive, so it is the
# first line that legitimately differs between the two builds.
REGIONS = [
    ("preset selector + resolution of which preset is active",
     'string preset = input.string(', 'string tz = input.string('),
    ("liquidity map / signal / PO3 / VWAP / trade-construction inputs",
     'string tz = input.string(', 'int   inMaxHold',
     '\n// ── strategy-only controls'),
    ("preset -> parameter resolution",
     '// ── resolve the preset', '// ─────────────────────────────────────────────────────────────'),
    ("signal-timeframe plumbing, trade-day clock, sessions, PO3 open, VWAP",
     '// SIGNAL TIMEFRAME',
     '// ─────────────────────────────────────────────────────────────\n// STATE'),
    ("live raid state (one raid per side)",
     '// one live raid per side;', '// running period extremes'),
    ("running period extremes",
     '// running period extremes',
     '// ─────────────────────────────────────────────────────────────\n// HELPERS'),
    ("pool helpers (colour, filter, erase, add, named levels, pruning)",
     'f_poolColor(int side) =>', '\nf_closeDraw(Setup s) =>',
     '\n// Direction of whatever is currently open'),
    ("block 2 - period and session rolls",
     '    // ── 2. roll periods', '    // ── 3. fractal pivots'),
    ("block 3 - fractal pivots",
     '    // ── 3. fractal pivots', '    // ── 4. mark swept'),
    ("block 4 - sweeps and raid tracking",
     '    // ── 4. mark swept', '    // ── 5. the reclaim'),
    ("block 5 LONG - every condition gating a long signal",
     '            bool ok = depth >= minSweepAtr * atrVal',
     '                if riskPx >= 2 * syminfo.mintick'),
    ("block 5 SHORT - every condition gating a short signal",
     '            bool okS = depthS >= minSweepAtr * atrVal',
     '                if riskPxS >= 2 * syminfo.mintick'),
    ("block 6 - raid-extreme diagnostic",
     '    // ── 6. diagnostic', '    // ── 7.', '\n// ── cosmetic only'),
    ("right-edge redraw of live levels",
     '// ── cosmetic only', '// PO3 period open, drawn as'),
]


def grab(src, start, end):
    i = src.find(start)
    if i < 0:
        return None, f"start marker not found: {start!r}"
    j = src.find(end, i + len(start))
    if j < 0:
        return None, f"end marker not found: {end!r}"
    return src[i:j].rstrip(), None


def main():
    ind = open(IND, encoding="utf-8").read()
    stg = open(STR, encoding="utf-8").read()
    print("Shared-logic parity: strategy build vs indicator\n")
    bad = 0
    for spec in REGIONS:
        name, start, end_i = spec[0], spec[1], spec[2]
        end_s = spec[3] if len(spec) > 3 else spec[2]
        a, ea = grab(ind, start, end_i)
        b, eb = grab(stg, start, end_s)
        if ea or eb:
            bad += 1
            print(f"  MARKER FAIL  {name}\n               indicator: {ea or 'ok'}"
                  f"\n               strategy : {eb or 'ok'}")
            continue
        if a == b:
            print(f"  IDENTICAL  {len(a.splitlines()):>4} lines   {name}")
        else:
            bad += 1
            print(f"  DIFFERS    {name}")
            for ln in list(difflib.unified_diff(
                    a.splitlines(), b.splitlines(),
                    "indicator", "strategy", lineterm="", n=1))[:24]:
                print("      " + ln)
    print()
    if bad:
        print(f"{bad} REGION(S) DIVERGED - the strategy is not the validated system")
    else:
        print("ALL SHARED REGIONS IDENTICAL - the strategy takes exactly the "
              "trades the indicator signals")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
