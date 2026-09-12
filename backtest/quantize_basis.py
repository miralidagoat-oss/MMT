#!/usr/bin/env python3
"""Quantize the CFD basis onto the NQ tick grid (PROTOCOL v1.3 §12).

Why this exists
---------------
`USATECHIDXUSD` quotes to three decimals - observed increments around 0.002
index points. NQ trades on a 0.25-point tick. Research run at the feed's native
precision can find edges that cannot exist on the instrument we would actually
trade:

  * the engine's `min_risk = 2 * tick` gate, which rejects untradeable stops,
    becomes 0.004 points instead of 0.50 and stops gating anything;
  * a liquidity sweep is a price EXCEEDING a level. At 0.002 resolution a level
    is pierced by amounts no NQ order could ever express, so sweep counts
    inflate against an instrument that cannot register them;
  * stop distances land between ticks, so R-multiples are computed off risk that
    is unfillable in practice.

None of that is a modelling nicety. Each one silently manufactures edge. The
raw files stay untouched and faithful to the source; research reads these.

Method: round O/H/L/C to the nearest 0.25, then repair the OHLC invariant by
re-deriving high and low as the extremes of the rounded four. Nearest-grid is
unbiased - rounding highs down and lows up would shrink every range and bias
sweep detection in the opposite direction, which is no more honest for being
conservative.
"""
import csv
import os
import sys

GRID = float(sys.argv[3]) if len(sys.argv) > 3 else 0.25
SRC = sys.argv[1] if len(sys.argv) > 1 else "data_ndx"
DST = sys.argv[2] if len(sys.argv) > 2 else "data_ndx_q"


def q(x):
    return round(x / GRID) * GRID


def convert(name):
    with open(os.path.join(SRC, name)) as f:
        r = csv.reader(f)
        head = next(r)
        rows = list(r)
    out = []
    moved = 0
    rng_before = rng_after = 0.0
    for t, o, h, l, c, v in rows:
        o, h, l, c = float(o), float(h), float(l), float(c)
        rng_before += h - l
        qo, qh, ql, qc = q(o), q(h), q(l), q(c)
        # repair the invariant: the rounded extremes must still bracket O and C
        hi = max(qo, qh, ql, qc)
        lo = min(qo, qh, ql, qc)
        rng_after += hi - lo
        if (hi, lo) != (qh, ql):
            moved += 1
        out.append([t, f"{qo:.2f}", f"{hi:.2f}", f"{lo:.2f}", f"{qc:.2f}", v])
    with open(os.path.join(DST, name), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(head)
        w.writerows(out)
    n = len(rows)
    print(f"  {name:<16} {n:>9,} bars   invariant repaired on {moved:,} "
          f"({100*moved/max(n,1):.2f}%)   mean range "
          f"{rng_before/max(n,1):.3f} -> {rng_after/max(n,1):.3f} pts")
    return n


if __name__ == "__main__":
    os.makedirs(DST, exist_ok=True)
    print(f"Quantizing {SRC} -> {DST} on a {GRID} grid (NQ tick)")
    names = sorted(x for x in os.listdir(SRC) if x.endswith(".csv"))
    if not names:
        sys.exit(f"HALT: no CSV files in {SRC}")
    for nm in names:
        convert(nm)
    src_prov = os.path.join(SRC, "PROVENANCE.json")
    if os.path.exists(src_prov):
        import json
        with open(src_prov) as f:
            p = json.load(f)
        p["quantization"] = (f"rounded to a {GRID} index-point grid (NQ tick) by "
                             "quantize_basis.py; OHLC invariant re-derived from "
                             "the rounded values. Raw files retained in " + SRC)
        p["derived_from"] = SRC
        with open(os.path.join(DST, "PROVENANCE.json"), "w") as f:
            json.dump(p, f, indent=2)
        print(f"  PROVENANCE.json carried forward with the quantization noted")
