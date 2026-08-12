#!/usr/bin/env python3
"""Backtest one explicitly-specified indicator configuration, end to end.

Written to answer "what do THESE settings actually do?" rather than to search
for settings. Everything is one position at a time, costs charged, and the same
engine that `pine_parity.py` proves the indicator reproduces trade-for-trade.

A note on the v1 preset trap this script exists partly to expose: in
`mnq_expansion_breakout.pine` the stop, target and breakeven inputs are
overridden whenever the preset is anything other than "Custom":

    beR = preset == "Max profit factor" ? 1.0 : preset == "Custom" ? beTrigger : 0.0

so selecting "Balanced" and typing 1.0 into the breakeven box silently gets you
no breakeven at all. Both readings are reported below.

Usage:
    python3 eval_config.py <ndx.csv> <mnq.csv> <nq.csv>
"""
import sys
from dataclasses import replace

import numpy as np

from features import build_features
from improve import (Cfg, MIN_N, add_regime_series, by_year, bootstrap,
                     random_entry_null, run)
from qlib import load_bars


def line(label, st, extra=""):
    if st is None or st["n"] == 0:
        print(f"{label:>34s} |   no trades")
        return
    print(f"{label:>34s} | {st['n']:5d} {st['per_yr']:5.0f}/yr {st['wr']:6.1f}% "
          f"{st['pf']:6.2f} {st['exp']:+8.4f} {st['net']:+8.1f}R {st['maxdd']:6.1f}R"
          f"  {extra}")


def header(t):
    print("\n" + "=" * 108)
    print(t)
    print("=" * 108)


def cols():
    print(f"{'configuration':>34s} | {'n':>5s} {'rate':>8s} {'WR':>7s} "
          f"{'PF':>6s} {'exp':>8s} {'netR':>9s} {'maxDD':>7s}")


def main(ndx_path, mnq_path, nq_path):
    ndx = load_bars(ndx_path)
    f = add_regime_series(build_features(ndx))
    print(f"research set: {len(ndx):,} 5m bars  "
          f"{ndx.index[0]:%Y-%m-%d} -> {ndx.index[-1]:%Y-%m-%d}")

    # ---- the requested settings ------------------------------------------
    # preset Balanced, lookback 10, ATR pct 500 / >66, VWAP filter OFF,
    # outside prior-day ON, stop 2.5 ATR, target 1.5R, BE 1R, hold 65, ATR 14,
    # round-turn cost 1.0 index points flat.
    asked = Cfg(lookback=10, atr_rank_min=0.66, vwap_min=0.0, outside_pd=True,
                stop=2.5, rr=1.5, hold=65, be=1.0, trail=0.0,
                session="all", regime="none")
    as_balanced = replace(asked, be=0.0)     # what v1 "Balanced" really runs
    shipped = Cfg()                          # v1 default: lookback 12, VWAP 1.5

    header("1. YOUR SETTINGS — the preset trap first")
    print("v1 overrides stop/target/breakeven unless the preset is 'Custom'.")
    print("With preset='Balanced' your stop 2.5 and target 1.5 happen to match "
          "the\npreset's own values, but your breakeven at 1R is DISCARDED.\n")
    print("Flat 1.00 pt round turn, as the v1 cost input specifies:")
    cols()
    line("as v1 runs it (Balanced, BE off)", run(f, as_balanced, cost=1.0)[0])
    line("as you intended (Custom, BE 1R)", run(f, asked, cost=1.0)[0])
    line("v1 shipped default, for reference", run(f, shipped, cost=1.0)[0])

    header("2. THE SAME SETTINGS WITH REALISTIC COSTS")
    print("A round turn is ~1.00 index point in RTH but ~1.75 overnight, where "
          "the\nbook is thinner. This config trades 24h, so the flat 1.00 above "
          "understates\nwhat it would actually pay.\n")
    cols()
    line("as v1 runs it (Balanced, BE off)", run(f, as_balanced)[0])
    line("as you intended (Custom, BE 1R)", run(f, asked)[0])
    print("\n  cost actually charged per trade: "
          f"{100 * run(f, asked)[0]['cost_r']:.1f}% of risk "
          f"(vs {100 * run(f, asked, cost=1.0)[0]['cost_r']:.1f}% at a flat 1.00 pt)")

    # ---- what each of your changes did ------------------------------------
    header("3. WHAT EACH OF YOUR CHANGES DID (realistic costs, one at a time)")
    print("Starting from the v1 shipped default and applying your edits "
          "individually,\nso the effect of each is separable.\n")
    cols()
    line("v1 default (lookback 12, VWAP 1.5)", run(f, shipped)[0])
    line("+ lookback 12 -> 10", run(f, replace(shipped, lookback=10))[0])
    line("+ VWAP filter off", run(f, replace(shipped, vwap_min=0.0))[0])
    line("+ time stop 72 -> 65", run(f, replace(shipped, hold=65))[0])
    line("+ breakeven at 1R", run(f, replace(shipped, be=1.0))[0])
    line("ALL of the above (= your config)", run(f, asked)[0])

    header("4. IS THE VWAP FILTER WORTH KEEPING?")
    print("You switched it off. It was the second-biggest contributor in the "
          "original\nstudy, so this is the change most worth checking.\n")
    cols()
    for v in (0.0, 0.5, 1.0, 1.5, 2.0):
        line(f"VWAP gate >= {v} ATR", run(f, replace(asked, vwap_min=v))[0])

    header("5. LOOKBACK SENSITIVITY (is 10 a plateau or a spike?)")
    cols()
    for lb in (6, 8, 10, 12, 16, 24, 48):
        line(f"lookback {lb}", run(f, replace(asked, lookback=lb))[0])

    header("6. TIME STOP SENSITIVITY (you chose 65)")
    cols()
    for h in (24, 48, 65, 72, 96, 144):
        line(f"time stop {h} bars", run(f, replace(asked, hold=h))[0])

    header("7. PER CALENDAR YEAR — your config, realistic costs")
    print(f"{'year':>6s} {'n':>6s} {'WR':>7s} {'PF':>7s} {'netR':>9s}")
    for r in by_year(f, asked, ndx.index):
        print(f"{r['year']:6d} {r['n']:6d} {r['wr']:7.1f} {r['pf']:7.2f} "
              f"{r['net']:+9.1f}")

    header("8. IS IT BETTER THAN RANDOM? (matched-entry null)")
    print("'vs session'    = random entries anywhere in the trading window.")
    print("'vs conditions' = random entries among bars already passing every "
          "gate\n                  except the breakout itself — the test a "
          "trend or volatility\n                  filter cannot pass on drift "
          "alone.\n")
    for nm, cfg in (("your config", asked), ("v1 default", shipped)):
        a = random_entry_null(f, cfg, n_iter=200, pool_mode="session")
        b = random_entry_null(f, cfg, n_iter=200, pool_mode="conditions")
        if a and b:
            print(f"  {nm:>12s}: exp {a['signal_exp']:+.4f} | vs session "
                  f"{a['null_mean']:+.4f} t={a['t']:+5.2f} | vs conditions "
                  f"{b['null_mean']:+.4f} t={b['t']:+5.2f}")

    header("9. CONFIDENCE INTERVAL (block bootstrap, your config)")
    _st, tr = run(f, asked)
    ci = bootstrap(tr)
    if ci:
        print(f"  PF  95% CI [{ci['pf_lo']:.2f}, {ci['pf_hi']:.2f}]")
        print(f"  exp 95% CI [{ci['exp_lo']:+.4f}, {ci['exp_hi']:+.4f}]")
        print(f"  probability the true expectancy is <= 0 : {ci['p_exp_le0']:.4f}")

    header("10. HELD-OUT REAL FUTURES (never used to choose anything)")
    cols()
    for nm, path in (("MNQ", mnq_path), ("NQ", nq_path)):
        d = load_bars(path)
        ff = add_regime_series(build_features(d))
        line(f"{nm} — your config", run(ff, asked)[0])
        line(f"{nm} — v1 default", run(ff, shipped)[0])

    header("11. OVERLAP — why these numbers are lower than a naive backtest")
    ov, _ = run(f, asked, sequential=False)
    sq, _ = run(f, asked, sequential=True)
    print(f"  letting trades overlap : PF {ov['pf']:.2f} at "
          f"{ov['per_yr']:.0f} trades/yr  ({ov['n']:,} trades)")
    print(f"  one position at a time : PF {sq['pf']:.2f} at "
          f"{sq['per_yr']:.0f} trades/yr  ({sq['n']:,} trades)")
    print(f"  -> {ov['n'] / max(sq['n'], 1):.1f}x inflation if you count "
          "signals instead of positions.")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
