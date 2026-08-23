#!/usr/bin/env python3
"""Final configuration test: baseline + rolling volatility-regime gate.

The ladder found exactly one conditioning that held in both panels with the
same sign: take the sweep signal only when realised volatility is above its
median. But that test used a median computed once on the training period,
which a live chart cannot do.

This script re-tests the gate the way Pine would actually compute it — a
ROLLING median of realised volatility over a trailing window — and checks the
result is not an artefact of the fixed-threshold version. It also sweeps the
window length, because a gate that only works at one magic lookback is
overfitted.

realised vol  = SMA(|log return|, 78 bars)          (one RTH session)
gate          = rv > rolling_median(rv, W)          (W swept)
"""
import math
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, mean, stdev, pct              # noqa: E402
from reaudit import run, PRESET                       # noqa: E402

S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
     "/scratchpad")
COST = 1.5


def stats(rs):
    if not rs:
        return dict(n=0, exp=float("nan"), t=float("nan"), pf=float("nan"), net=0.0)
    gw = sum(r for r in rs if r > 0)
    gl = -sum(r for r in rs if r < 0)
    sd = stdev(rs) if len(rs) > 1 else float("nan")
    return dict(n=len(rs), exp=mean(rs),
                t=(mean(rs) / (sd / math.sqrt(len(rs))) if sd else float("nan")),
                pf=(gw / gl if gl else float("inf")), net=sum(rs))


def main():
    b = load(f"{S}/data5m/USATECHIDXUSD_5m.csv")
    closed, _, _, _, _ = run(b, PRESET, rth_only=True, be_trigger=1.0)

    n = b.n
    absr = [0.0] + [abs(math.log(b.c[i] / b.c[i - 1])) * 1e4
                    for i in range(1, n)]
    # trailing realised vol, one session
    rv = [None] * n
    run_sum = 0.0
    for i in range(n):
        run_sum += absr[i]
        if i >= 78:
            run_sum -= absr[i - 78]
        if i >= 78:
            rv[i] = run_sum / 78.0

    trades = [dict(r=r - COST / risk, bar=bar) for r, risk, bar in closed]
    trades.sort(key=lambda x: x["bar"])
    base = stats([t["r"] for t in trades])

    print("=" * 88)
    print("ROLLING VOLATILITY GATE — does the one surviving filter work live?")
    print("=" * 88)
    print(f"  {'configuration':<44}{'n':>5}{'expR':>9}{'t':>7}{'PF':>7}{'netR':>9}")
    print("  " + "-" * 81)
    print(f"  {'MODEL 1 baseline (no gate)':<44}{base['n']:>5}"
          f"{base['exp']:>9.3f}{base['t']:>7.2f}{base['pf']:>7.2f}{base['net']:>9.1f}")

    for W in (500, 1000, 2000, 3000, 5000):
        kept, dropped = [], []
        for t in trades:
            i = t["bar"]
            lo = max(0, i - W)
            hist = [x for x in rv[lo:i] if x is not None]
            if len(hist) < 50 or rv[i] is None:
                dropped.append(t["r"])
                continue
            med = pct(sorted(hist), 0.5)
            (kept if rv[i] > med else dropped).append(t["r"])
        k, dr = stats(kept), stats(dropped)
        tag = f"MODEL 4 gate: rv > rolling median (W={W})"
        print(f"  {tag:<44}{k['n']:>5}{k['exp']:>9.3f}{k['t']:>7.2f}"
              f"{k['pf']:>7.2f}{k['net']:>9.1f}   | dropped n={dr['n']:<4}"
              f" exp {dr['exp']:+.3f}")

    # chronological halves at the chosen window
    W = 2000
    kept, dropped = [], []
    for t in trades:
        i = t["bar"]
        hist = [x for x in rv[max(0, i - W):i] if x is not None]
        if len(hist) < 50 or rv[i] is None:
            continue
        (kept if rv[i] > pct(sorted(hist), 0.5) else dropped).append(t)
    kept.sort(key=lambda x: x["bar"])
    half = len(kept) // 2
    print(f"\n  W=2000 gate, chronological split (no refitting):")
    for tag, sub in (("first half", kept[:half]), ("second half", kept[half:])):
        s = stats([t["r"] for t in sub])
        print(f"    {tag:<14}n={s['n']:>4}  exp {s['exp']:+.3f} R  t {s['t']:+.2f}"
              f"  PF {s['pf']:.2f}  net {s['net']:+.1f} R")

    s = stats([t["r"] for t in kept])
    print(f"\n  POOLED gated result: n={s['n']}  exp {s['exp']:+.3f} R  "
          f"t {s['t']:+.2f}  PF {s['pf']:.2f}  net {s['net']:+.1f} R")
    print(f"  trades per year ~{s['n']/3.0:.0f}; expected {s['exp']*s['n']/3.0:+.1f} R/yr")
    need = (2.0 * stdev([t['r'] for t in kept]) / s['exp']) ** 2 if s['exp'] > 0 else float('nan')
    print(f"  trades needed for t=2 at this expectancy: {need:.0f} "
          f"(~{need/(s['n']/3.0):.1f} years)")


if __name__ == "__main__":
    main()
