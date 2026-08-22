#!/usr/bin/env python3
"""The frequency/quality frontier: the best VALIDATED configuration at each
trade-count level, rather than a single winner.

More trades is only worth having if expectancy survives, and expectancy is
harder to keep at high frequency because commission and slippage are paid on
every round trip. This prints the trade-off explicitly so the choice is yours.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ict_of_backtest import P0, load, prep, primary_csv          # noqa: E402
import ict_search as S                                           # noqa: E402
import ict_search_report as R                                    # noqa: E402

BUCKETS = [(150, 250), (250, 400), (400, 700), (700, 10 ** 9)]
SESSIONS = 48.0          # trading days in the 72-calendar-day sample


def main(d):
    res = json.load(open(os.path.join(d, "search_results.json")))
    real, null, top = res["real"], res["null"], res["top"]
    cfgs = {int(k): v for k, v in res["cfgs"].items()}

    print("=" * 88)
    print("  NOISE BAR FOR THIS FREQUENCY SPACE")
    print("=" * 88)
    if null:
        nb_t = max(r["t"] for r in null)
        nb_pf = max(r["pf"] for r in null)
        print(f"  best of {len(null)} configs on the structureless null: PF {nb_pf:.2f}, t {nb_t:.2f}")
    else:
        nb_t = 99
        print("  no null configs cleared the trade-count filter")
    if real:
        print(f"  best of {len(real)} configs on real MNQ:            "
              f"PF {max(r['pf'] for r in real):.2f}, t {max(r['t'] for r in real):.2f}")
        beat = sum(1 for r in real if r["t"] > nb_t)
        print(f"  real configs beating the best null config: {beat} / {len(real)}")

    print("\n" + "=" * 88)
    print("  FREQUENCY / QUALITY FRONTIER   (validated on 5 untouched index futures)")
    print("=" * 88)
    withoos = [r for r in top if r.get("oos")]
    print(f"  {'trades':>12} {'/day':>6} {'WR%':>6} {'PF':>6} {'avgR':>7} {'t':>6} | "
          f"{'OOS n':>6} {'OOS WR%':>8} {'OOS PF':>7} {'OOS avgR':>9}")
    picks = []
    for lo, hi in BUCKETS:
        cand = [r for r in withoos if lo <= r["n"] < hi
                and r["oos"]["avgR"] > 0 and r["h1"] > 0 and r["h2"] > 0]
        if not cand:
            cand_any = [r for r in withoos if lo <= r["n"] < hi]
            lbl = f"{lo}-{hi if hi < 10**9 else '+'}"
            if cand_any:
                print(f"  {lbl:>12}   -- none passed out-of-sample "
                      f"({len(cand_any)} in band, best OOS avgR "
                      f"{max(x['oos']['avgR'] for x in cand_any):+.3f})")
            else:
                print(f"  {lbl:>12}   -- no configurations in this band")
            continue
        cand.sort(key=lambda r: -(r["oos"]["avgR"] * math.sqrt(r["oos"]["n"])))
        b = cand[0]
        o = b["oos"]
        print(f"  {b['n']:>12} {b['n']/SESSIONS:>6.1f} {b['wr']:>6.1f} {b['pf']:>6.2f} "
              f"{b['avgR']:>7.3f} {b['t']:>6.2f} | {o['n']:>6} {o['wr']:>8.1f} "
              f"{o['pf']:>7.2f} {o['avgR']:>9.3f}")
        picks.append((f"{lo}-{hi if hi < 10**9 else '+'}", b))
    return res, picks, cfgs


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "data"
    S.RAW["MNQ"] = load(primary_csv(d))
    for sym in S.MARKETS:
        p = os.path.join(d, f"{sym}_5m.csv")
        if os.path.exists(p):
            S.RAW[sym] = load(p)
    _res, _picks, _cfgs = main(d)
    if _picks:
        import ict_to_tradingview as TV
        lbl, best = max(_picks, key=lambda kv: kv[1]["n"])
        cfg = _cfgs[best["idx"]]
        print("\n" + "=" * 88)
        print(f"  HIGHEST-FREQUENCY CONFIGURATION THAT STILL VALIDATES  ({lbl} trades)")
        print("=" * 88)
        fp = R.full_picture(cfg)
        print(f"  clean-room re-run: MNQ n={fp['n']} WR={fp['wr']:.1f}% PF={fp['pf']:.2f} "
              f"avgR={fp['avgR']:+.3f} | OOS n={fp['oos_n']} PF={fp['oos_pf']:.2f} "
              f"avgR={fp['oos_avgR']:+.3f}")
        ok = abs(fp["n"] - best["n"]) <= 1
        print(f"  REPRODUCIBILITY: {'PASS' if ok else 'FAIL - search said n=' + str(best['n'])}")
        print()
        print(TV.render(cfg, "HIGH-FREQUENCY CONFIGURATION"))
        json.dump(cfg, open(os.path.join(d, "best_freq_config.json"), "w"), default=str)
