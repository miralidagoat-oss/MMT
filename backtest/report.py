#!/usr/bin/env python3
"""Produce the published tables for one timeframe.

Usage:
  python3 backtest/report.py <tf> <cost_ticks> <preset_json> <dir:syms> [dir:syms ...]

Each panel is a directory plus a comma-separated symbol list, so a run can mix
the long CFD history used for tuning with the real futures series held back for
validation. Prints per-panel stats, the pooled result with a Wilson interval on
the win rate against the breakeven rate, the trade geometry in price points,
and a matched-random placebo for every panel group.
"""
import json
import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from evaluate import CANDIDATE, TICK  # noqa: E402
from study_po3 import wilson  # noqa: E402
from control import manage  # noqa: E402


def hdr(title):
    print(f"\n{title}")
    print(f"{'panel':<22} {'n':>5} {'W':>4} {'L':>4} {'BE':>4} {'WR%':>6} "
          f"{'CI':>13} {'PF':>6} {'netR':>8} {'expR':>7} {'DD':>6} {'tick%':>5}")
    print("-" * 104)


def row(label, r):
    d = r.wins + r.losses
    if d < 5:
        print(f"{label:<22} {d:>5}   (too few trades)")
        return
    lo, hi = wilson(r.wins, d)
    print(f"{label:<22} {len(r.exits):>5} {r.wins:>4} {r.losses:>4} {r.scratches:>4} "
          f"{r.wr:>6.1f} [{lo * 100:4.1f},{hi * 100:4.1f}] {r.pf:>6.2f} "
          f"{r.net_r:>8.1f} {r.expectancy:>+7.3f} {r.max_dd:>6.1f} "
          f"{r.extreme_hit_rate:>5.0f}")


def load_panel(spec, tf):
    d, syms = spec.split(":")
    out = []
    for sym in syms.split(","):
        path = os.path.join(d, f"{sym}_{tf}.csv")
        if os.path.exists(path):
            bars = E.load_csv(path)
            out.append((sym, bars, E.build_context(bars)))
    return out


def geometry(panels, p):
    """Risk and reward in price points - what the trade actually looks like."""
    print("\nTrade geometry (price points, per market)")
    print(f"{'market':<10} {'n':>5} {'1R p25':>8} {'1R med':>8} {'1R p75':>8} "
          f"{f'{p.rr:g}R med':>9} {'ATR med':>8}  target < 30 pts")
    for sym, bars, ctx in panels:
        ev = []
        E.run(bars, ctx, replace(p, tick=TICK.get(sym, 0.25)), 0, len(bars["c"]),
              collector=ev.append)
        rs = []
        atrs = []
        for e in ev:
            a = e["atr"]
            if not a:
                continue
            d = e["dir"]
            stop = (e["extreme"] - p.stop_buf_atr * a) if d == 1 else \
                   (e["extreme"] + p.stop_buf_atr * a)
            risk = abs(e["close"] - stop)
            if risk > 0:
                rs.append(risk)
                atrs.append(a)
        if len(rs) < 20:
            continue
        rs.sort()
        atrs.sort()
        def q(f):
            return rs[int(len(rs) * f)]
        small = sum(1 for r in rs if p.rr * r < 30)
        print(f"{sym:<10} {len(rs):>5} {q(.25):>8.1f} {q(.50):>8.1f} {q(.75):>8.1f} "
              f"{p.rr * q(.50):>9.1f} {atrs[len(atrs) // 2]:>8.1f}"
              f"  {small}/{len(rs)} = {100 * small / len(rs):.1f}%")


def placebo(panels, p, cost, k=5):
    import random
    rng = random.Random(23)
    print("\nPlacebo: same direction and risk, replanted at random bars")
    for sym, bars, ctx in panels:
        pp = replace(p, tick=TICK.get(sym, 0.25), cost_ticks=cost)
        ev = []
        E.run(bars, ctx, pp, 0, len(bars["c"]), collector=ev.append)
        real = E.run(bars, ctx, pp, 0, len(bars["c"]))
        atr = ctx["atr"]
        n = len(bars["c"])
        ctrl = []
        for e in ev:
            a = e["atr"]
            if not a:
                continue
            d = e["dir"]
            stop = (e["extreme"] - p.stop_buf_atr * a) if d == 1 else \
                   (e["extreme"] + p.stop_buf_atr * a)
            risk_atr = abs(e["close"] - stop) / a
            for _ in range(k):
                j = rng.randrange(60, n - 5)
                if not atr[j]:
                    continue
                ctrl.append(manage(bars, j, d, bars["c"][j], risk_atr * atr[j], pp))
        got = [x for x in ctrl if x is not None]
        w = sum(1 for x in got if x > 0)
        losses = sum(1 for x in got if x < 0)
        gw = sum(x for x in got if x > 0)
        gl = -sum(x for x in got if x < 0)
        cpf = gw / gl if gl else 0.0
        print(f"  {sym:<8} real PF {real.pf:5.2f} exp {real.expectancy:+.3f}   |   "
              f"control PF {cpf:5.2f} exp {sum(got) / len(got):+.3f}  (n={len(got)})")


def main():
    tf = sys.argv[1]
    cost = float(sys.argv[2])
    over = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else {}
    p = replace(CANDIDATE, **over)
    print(f"Timeframe {tf}, cost {cost} ticks round trip")
    print(f"Config: {p}")
    for spec in sys.argv[4:]:
        panels = load_panel(spec, tf)
        if not panels:
            continue
        hdr(f"### {spec}")
        pooled = E.Result()
        for sym, bars, ctx in panels:
            pp = replace(p, tick=TICK.get(sym, 0.25), cost_ticks=cost)
            n = len(bars["c"])
            if len(panels) == 1:
                row(f"{sym} IS (first 60%)", E.run(bars, ctx, pp, 0, int(n * .6)))
                row(f"{sym} OOS (last 40%)", E.run(bars, ctx, pp, int(n * .6), n))
            r = E.run(bars, ctx, pp, 0, n)
            row(f"{sym} full", r)
            pooled.merge(r)
        if len(panels) > 1:
            print("-" * 104)
            row("POOLED", pooled)
            d = pooled.wins + pooled.losses
            if d:
                lo, hi = wilson(pooled.wins, d)
                be = 100.0 / (1.0 + p.rr)
                verdict = ("edge significant at 95%" if lo * 100 > be else
                           "NOT significant - CI includes breakeven")
                print(f"   breakeven WR at 1:{p.rr:g} = {be:.1f}%   "
                      f"CI [{lo * 100:.1f}, {hi * 100:.1f}]  ->  {verdict}")
        geometry(panels, p)
        placebo(panels, p, cost)


if __name__ == "__main__":
    main()
