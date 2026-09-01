#!/usr/bin/env python3
"""Test the ONE combination the conditional study pointed at, on every 5m
series available, and read the MFE/MAE profile that should size the trade.

Condition: take the 5m sweep->MSS only when the 30m AND 1h structures agree
with it (the two HTF horizons that separated the groups on all three markets),
and skip the NY PM session (consistently the worst slice).
"""
import statistics as st
import sys

from ict_conditions import htf_state, tstat
from ict_edge import excursion, find_events, fwd
from ict_engine import Config, KILLZONES, load, prepare


def profile(path, sym, cfg, horizon, label):
    d = prepare(load(path), cfg)
    h30, h1h, h15 = htf_state(d, 6), htf_state(d, 12), htf_state(d, 3)
    ev = find_events(d, cfg)
    kz = KILLZONES["rth"]
    pm = KILLZONES["nypm"][0]
    rows = []
    for i, s in ev:
        m = d["minute"][i]
        if not any(a <= m < b for a, b in kz):
            continue
        aligned = (h30[i] == s) and (h1h[i] == s)
        in_pm = pm[0] <= m < pm[1]
        r = fwd(d, i, s, horizon)
        e = excursion(d, i, s, horizon)
        if r is None or e is None:
            continue
        rows.append((aligned, in_pm, r, e[0], e[1]))
    if len(rows) < 30:
        print(f"{label}: {len(rows)} events, skipped")
        return
    grp = {
        "ALL":              [x for x in rows],
        "aligned+not PM":   [x for x in rows if x[0] and not x[1]],
        "aligned":          [x for x in rows if x[0]],
        "counter-trend":    [x for x in rows if not x[0]],
    }
    print(f"\n{label}  (forward {horizon} bars)")
    for name, g in grp.items():
        if len(g) < 12:
            print(f"   {name:16s} n={len(g):3d}  too few")
            continue
        r = [x[2] for x in g]
        mfe = [x[3] for x in g]
        mae = [x[4] for x in g]
        # what fraction reach 1R/2R before giving back 1R, for a 1-ATR stop
        hit = sum(1 for x in g if x[3] >= 1.0) / len(g)
        hit2 = sum(1 for x in g if x[3] >= 2.0) / len(g)
        print(f"   {name:16s} n={len(g):3d}  fwd {st.mean(r):+.3f} ATR (t={tstat(r):+5.2f})"
              f"  MFE {st.mean(mfe):.2f} / MAE {st.mean(mae):.2f}"
              f"  reach 1ATR {hit:.0%}  2ATR {hit2:.0%}")


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "../ictdata"
    cfg = Config(pivot_len=1, disp_atr=0.25, mss_window=6, killzone="rth")
    for sym in ("MNQ", "NQ", "ES", "MES", "QQQ", "SPY"):
        profile(f"{data}/{sym}_5m.csv", sym, cfg, 12, f"{sym} 5m")
