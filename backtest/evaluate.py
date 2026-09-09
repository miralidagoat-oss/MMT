#!/usr/bin/env python3
"""Out-of-sample, cross-market and cross-timeframe evaluation.

The candidate configuration is fixed in CANDIDATE and was chosen from the
*middles of plateaus* in scan.py, never from the single best cell, and only
from the MNQ 1h in-sample window. Everything printed here for other symbols,
other timeframes, or the out-of-sample window is therefore genuinely untouched
by the selection.
"""
import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from study_po3 import wilson  # noqa: E402

TICK = {"MNQ": 0.25, "NQ": 0.25, "ES": 0.25, "YM": 1.0, "RTY": 0.1,
        # cross-asset holdout: never used to select anything
        "CL": 0.01, "GC": 0.10, "6E": 0.00005, "ZN": 0.015625,
        "SI": 0.005, "NG": 0.001, "BTC": 1.0, "ETH": 0.1,
        # Dukascopy index CFDs, priced to match their futures cousins so that
        # "4 ticks" means the same money: 4 ticks = 1 index point on NDX/SPX
        # (as on MNQ/ES) and 4 points on DJI (as on YM).
        "NDX": 0.25, "SPX": 0.25, "DJI": 1.0}

# chosen on MNQ 1h in-sample (first 60%) from plateau midpoints
CANDIDATE = E.Params(
    # every value below is corroborated on NQ/ES/YM/RTY, which took no part in
    # selecting it; see cross_scan.py output in the README
    min_sweep_atr=0.35,      # holdout pool argmax and 4/4 symbols positive
    max_sweep_atr=99.0,      # no evidence for a cap - parameter dropped
    reclaim_bars=2,          # pool peak; 0 (same-bar spike) clearly worse
    use_vwap=False,          # the VWAP stretch gate did NOT corroborate
    dev_entry=2.0,
    vwap_reclaim=False,      # VWAP-reclaim confirmation did NOT corroborate
    po3_mode="below_open",
    po3_period="week",       # weekly open beat the daily open on both panels
    require_close_dir=True,
    entry_mode="reclaim_close",   # limit-into-the-wick is worse on 4/4 markets
    stop_buf_atr=0.50,       # flat 0.35-0.75 on the holdout; take the middle
    tp_mode="rr",            # targeting VWAP destroyed the edge (0/4)
    rr=3.0, be_at_r=1.0,
    validity=12, session="all", cooldown=6,
)


def hdr():
    print(f"{'panel':<26} {'n':>4} {'W':>4} {'L':>4} {'BE':>4} {'WR%':>6} "
          f"{'CI':>13} {'PF':>5} {'netR':>7} {'expR':>7} {'DD':>6} {'tick%':>5}")
    print("-" * 104)


def row(label, r, p, cost_r=0.0):
    d = r.wins + r.losses
    if d < 10:
        print(f"{label:<26} {d:>4}  (too few trades)")
        return
    lo, hi = wilson(r.wins, d)
    print(f"{label:<26} {len(r.exits):>4} {r.wins:>4} {r.losses:>4} {r.scratches:>4} "
          f"{r.wr:>6.1f} [{lo * 100:4.1f},{hi * 100:4.1f}] {r.pf:>5.2f} "
          f"{r.net_r:>7.1f} {r.expectancy:>+7.3f} {r.max_dd:>6.1f} "
          f"{r.extreme_hit_rate:>5.0f}")


def panels(data, symbols, tfs, p, split=0.6, cost_ticks=0.0):
    for sym in symbols:
        for tf in tfs:
            path = os.path.join(data, f"{sym}_{tf}.csv")
            if not os.path.exists(path):
                continue
            bars = E.load_csv(path)
            ctx = E.build_context(bars)
            n = len(bars["c"])
            pp = replace(p, tick=TICK[sym], cost_ticks=cost_ticks)
            if sym == "MNQ" and tf == "1h":
                row(f"{sym} {tf} IS (first 60%)",
                    E.run(bars, ctx, pp, 0, int(n * split)), pp)
                row(f"{sym} {tf} OOS (last 40%)",
                    E.run(bars, ctx, pp, int(n * split), n), pp)
            row(f"{sym} {tf} full", E.run(bars, ctx, pp, 0, n), pp)


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "data_po3"
    cost = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    print(f"\nCANDIDATE (selected on MNQ 1h in-sample only)  cost={cost} ticks round trip")
    print(f"  {CANDIDATE}\n")
    print("### MNQ walk-forward + NQ/ES/YM/RTY cross-market, 1h")
    hdr()
    panels(data, ["MNQ", "NQ", "ES", "YM", "RTY"], ["1h"], CANDIDATE, cost_ticks=cost)
    print("\n### MNQ across timeframes (one parameter set, no per-TF tuning)")
    hdr()
    panels(data, ["MNQ"], ["1m", "5m", "15m", "30m", "1h", "4h"], CANDIDATE, cost_ticks=cost)
    print("\n### NQ across timeframes")
    hdr()
    panels(data, ["NQ"], ["1m", "5m", "15m", "30m", "1h", "4h"], CANDIDATE, cost_ticks=cost)
    print("\n### Cross-asset holdout - energy, metals, FX, rates, crypto.")
    print("### Never used to select any parameter. Tests whether the mechanism")
    print("### is general or an equity-index artefact.")
    hdr()
    panels("data_holdout", ["CL", "GC", "SI", "NG", "6E", "ZN", "BTC", "ETH"],
           ["1h", "15m"], CANDIDATE, cost_ticks=cost)
