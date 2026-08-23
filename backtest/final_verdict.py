#!/usr/bin/env python3
"""Definitive test of the SHIPPED configuration, per year and across RR.

The 384-cell grid found nothing that beats the system already shipped. This
runs the exact shipped rule set (reaudit.PRESET: sweep + rejection + volume
gate + RTH + breakeven at 1R) and answers the two questions that decide
whether it is usable:

  1. Is it positive in EVERY calendar year, or is it another 2026 artifact?
  2. What does the win-rate / risk-reward frontier actually look like on the
     real system, so the WR-vs-expectancy tradeoff is explicit?

The RR sweep is the direct answer to "I need a high win rate". Breakeven win
rate at a given RR is 1/(1+RR): 67% at 1:0.5, 50% at 1:1, 33% at 1:2, 20% at
1:4. Any row whose WR sits below its breakeven column is a losing system no
matter how good the hit rate feels.
"""
import datetime as dt
import math
import random
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, mean, stdev, pct                    # noqa: E402
from reaudit import run, PRESET                             # noqa: E402
from engine import Feat                                     # noqa: E402

random.seed(20260823)
S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
     "/scratchpad")
COST = 1.5


def stats(rs):
    if not rs:
        return dict(n=0, wr=float("nan"), exp=float("nan"), pf=float("nan"),
                    t=float("nan"), net=0.0)
    w = sum(1 for r in rs if r > 0)
    l = sum(1 for r in rs if r < 0)
    gw = sum(r for r in rs if r > 0)
    gl = -sum(r for r in rs if r < 0)
    sd = stdev(rs) if len(rs) > 1 else float("nan")
    return dict(n=len(rs), wr=100.0 * w / max(w + l, 1), exp=mean(rs),
                pf=(gw / gl if gl else float("inf")),
                t=(mean(rs) / (sd / math.sqrt(len(rs))) if sd else float("nan")),
                net=sum(rs))


def boot_ci(xs, iters=4000):
    n = len(xs)
    if n < 20:
        return float("nan"), float("nan")
    ms = [sum(xs[random.randrange(n)] for _ in range(n)) / n for _ in range(iters)]
    ms.sort()
    return pct(ms, 0.025), pct(ms, 0.975)


def gated(F, closed):
    """Apply the validated realised-volatility regime gate to closed trades."""
    out = []
    for r, risk, bar in closed:
        if F.rv[bar] is None or F.rv_base[bar] is None:
            continue
        if F.rv[bar] > F.rv_base[bar]:
            out.append((r, risk, bar))
    return out


def main():
    b = load(f"{S}/mtf/USATECHIDXUSD_5m.csv")
    F = Feat(b, 78)

    print("=" * 94)
    print("SHIPPED CONFIGURATION — 5m sweep + volume gate + RTH + BE@1R")
    print("=" * 94)

    print("\n  WIN-RATE / RISK-REWARD FRONTIER  (net of 1.5 pts round turn)")
    print(f"  {'RR':>6}{'breakeven WR':>14}{'actual WR':>11}{'margin':>9}"
          f"{'trades':>8}{'expR':>9}{'PF':>7}{'t':>7}   verdict")
    print("  " + "-" * 88)
    rows = []
    for rr in (0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0):
        p = dict(PRESET)
        p["rr"] = rr
        closed, _, _, _, _ = run(b, p, rth_only=True, be_trigger=1.0)
        g = gated(F, closed)
        rs = [r - COST / risk for r, risk, _ in g]
        s = stats(rs)
        be_wr = 100.0 / (1.0 + rr)
        margin = s["wr"] - be_wr
        verdict = "profitable" if s["exp"] > 0 else "LOSES MONEY"
        rows.append((rr, s, be_wr))
        print(f"  {rr:>6.2f}{be_wr:>13.1f}%{s['wr']:>10.1f}%{margin:>+8.1f}pp"
              f"{s['n']:>8}{s['exp']:>9.3f}{s['pf']:>7.2f}{s['t']:>7.2f}   {verdict}")

    print("\n  The two columns move in opposite directions by construction.")
    print("  Raising the win rate lowers the payoff faster than it raises the")
    print("  hit rate, which is why every low-RR row loses.")

    best = max(rows, key=lambda r: r[1]["exp"])
    rr = best[0]
    print(f"\n{'='*94}\nPER-YEAR STABILITY at RR {rr:g} (expectancy-maximising row)\n{'='*94}")
    p = dict(PRESET)
    p["rr"] = rr
    closed, _, _, _, _ = run(b, p, rth_only=True, be_trigger=1.0)
    for tag, sel in (("ungated", closed), ("vol-gated", gated(F, closed))):
        yr = defaultdict(list)
        for r, risk, bar in sel:
            yr[dt.datetime.utcfromtimestamp(b.t[bar]).year].append(r - COST / risk)
        allr = [x for v in yr.values() for x in v]
        s = stats(allr)
        lo, hi = boot_ci(allr)
        print(f"\n  {tag}:  n={s['n']}  WR {s['wr']:.1f}%  exp {s['exp']:+.3f} R"
              f"  PF {s['pf']:.2f}  t {s['t']:+.2f}")
        print(f"    bootstrap 95% CI [{lo:+.3f}, {hi:+.3f}] "
              f"-> {'EXCLUDES ZERO' if lo > 0 else 'includes zero'}")
        pos = 0
        for y in sorted(yr):
            sy = stats(yr[y])
            pos += 1 if sy["exp"] > 0 else 0
            print(f"    {y}  n={sy['n']:>4}  WR {sy['wr']:>5.1f}%  "
                  f"exp {sy['exp']:+.3f} R  PF {sy['pf']:>5.2f}  net {sy['net']:+7.1f} R")
        print(f"    -> positive in {pos}/{len(yr)} calendar years")

    nsess = len({d for d in F.sess_id if d is not None})
    g = gated(F, closed)
    print(f"\n  frequency: {len(g)} trades over {nsess} sessions "
          f"= {len(g)/nsess:.2f}/day, about {len(g)/(nsess/252):.0f}/year")


if __name__ == "__main__":
    main()
