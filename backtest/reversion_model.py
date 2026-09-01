#!/usr/bin/env python3
"""Short-term mean reversion on the Nasdaq — daily mark-to-market backtest.

Evaluated on a DAILY equity curve (flat days included), not per trade, so
variable-holding-period models cannot flatter their own Sharpe and everything
is directly comparable with buy & hold.

The rule under test, fixed before tuning:
    ENTRY  at the close, when the session closed weak
           (N consecutive lower closes, and/or a close in the bottom part of
           the day's range)
    EXIT   at the close of the first day that closes higher than the previous
           one (or after a maximum holding period)
No shorts: the mirror test (shorting strong closes) lost money on both indices,
which is what you would expect in an instrument with positive drift.
"""
import csv
import statistics as st
import sys

COST = 0.0002          # ~2 bps round turn


def load(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append(dict(t=int(r["time"]), o=float(r["open"]), h=float(r["high"]),
                             l=float(r["low"]), c=float(r["close"])))
    return rows


def ibs(b):
    rng = b["h"] - b["l"]
    return 0.5 if rng <= 0 else (b["c"] - b["l"]) / rng


def backtest(bars, ibs_thr=0.3, ndown=0, entry_mode="open", exit_mode="firstup",
             max_hold=5, lo=0.0, hi=1.0, cost=None):
    """Daily mark-to-market backtest.

    entry_mode "close" enters on the signal bar's close (carries the overnight
    gap); "open" enters at the next session's open, which testing showed costs
    almost nothing and removes that gap entirely.
    exit_mode  "firstup" exits at the close of the first session that closes
    higher than the one before it; "sameday" exits at the close of the entry
    session, making the model purely intraday.
    """
    cost = COST if cost is None else cost
    n = len(bars)
    a, b = max(5, int(n * lo)), int(n * hi)
    daily, trades = [], []
    pos = 0
    entry_px = None
    hold = 0
    armed = False

    for i in range(a, b):
        prev = bars[i - 1]
        cur = bars[i]
        ret = 0.0

        if pos:
            # carried a position into today
            ret = cur["c"] / prev["c"] - 1
            hold += 1

        # --- entry that was signalled yesterday and fills at today's open ---
        if not pos and armed:
            entry_px = cur["o"]
            pos = 1
            hold = 0
            ret = cur["c"] / cur["o"] - 1 - cost / 2
            armed = False

        # --- exit decision at today's close ---
        if pos:
            closed_up = cur["c"] > prev["c"]
            done = (exit_mode == "sameday" and hold >= 0 and entry_px is not None) or \
                   (exit_mode == "firstup" and (closed_up or hold >= max_hold))
            if exit_mode == "sameday":
                done = True
            if done:
                trades.append(cur["c"] / entry_px - 1 - cost)
                pos = 0
                ret -= cost / 2
                entry_px = None

        # --- signal for tomorrow ---
        if not pos:
            down_ok = True
            for k in range(ndown):
                if not bars[i - k]["c"] < bars[i - k - 1]["c"]:
                    down_ok = False
                    break
            if down_ok and ibs(cur) < ibs_thr:
                if entry_mode == "open":
                    armed = True
                else:
                    pos = 1
                    hold = 0
                    entry_px = cur["c"]
                    ret -= cost / 2
        daily.append(ret)
    return daily, trades


def report(daily, trades, label, exposure_days=None):
    if not daily:
        return
    m, sd = st.mean(daily), st.pstdev(daily)
    ann = m * 252
    sharpe = (m / sd) * (252 ** 0.5) if sd else 0
    tstat = m / (sd / len(daily) ** 0.5) if sd else 0
    eq = pk = 1.0
    dd = 0.0
    for r in daily:
        eq *= 1 + r
        pk = max(pk, eq)
        dd = max(dd, 1 - eq / pk)
    exposure = sum(1 for r in daily if r != 0) / len(daily)
    win = sum(1 for x in trades if x > 0) / len(trades) if trades else 0
    print(f"   {label:38s} {ann*100:+6.1f}%/yr  Sharpe {sharpe:5.2f}  t={tstat:+5.2f}  "
          f"maxDD {dd:5.1%}  expo {exposure:4.0%}  trades {len(trades):4d}  win {win:4.0%}")
    return dict(ann=ann, sharpe=sharpe, t=tstat, dd=dd)


def buyhold(bars, lo=0.0, hi=1.0):
    n = len(bars)
    a, b = max(5, int(n * lo)), int(n * hi)
    return [bars[i]["c"] / bars[i - 1]["c"] - 1 for i in range(a, b)]


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "../ictdata"
    for sym in ("QQQ", "SPY", "NQ", "ES", "MNQ"):
        try:
            bars = load(f"{data}/{sym}_1d.csv")
        except FileNotFoundError:
            continue
        yrs = (bars[-1]["t"] - bars[0]["t"]) / 86400 / 365.25
        print(f"\n=== {sym}: {len(bars)} sessions, {yrs:.1f} years ===")
        report(buyhold(bars), [], "buy & hold")
        for nd, thr, both in [(2, None, False), (0, 0.3, False), (1, 0.3, True), (2, 0.3, True)]:
            d, tr = backtest(bars, ndown=nd, ibs_thr=thr, require_both=both)
            name = ("%d lower closes" % nd if thr is None else
                    "IBS<0.3" if nd == 0 else "%d lower close%s + IBS<0.3" % (nd, "s" if nd > 1 else ""))
            report(d, tr, name)
