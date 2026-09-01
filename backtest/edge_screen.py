#!/usr/bin/env python3
"""Pre-registered screen of simple index models on 10 years of daily data.

The ICT study failed for a reason worth not repeating: it searched a large
parameter space on a small sample. This screen does the opposite — a short list
of hypotheses fixed IN ADVANCE, each with at most two parameters, tested on
~2,500 sessions, reported whether they work or not.

Every model is close-to-something, so returns are simple and unambiguous; no
intrabar path assumptions are involved. Costs are applied as a per-trade
fraction so the comparison stays honest.
"""
import csv
import datetime
import statistics as st
import sys

COST = 0.0002        # 2 bps round turn: ~1 tick + commission on a micro future


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


def stats(rets, label, n_days):
    if len(rets) < 20:
        return None
    m, sd = st.mean(rets), st.pstdev(rets)
    tstat = m / (sd / len(rets) ** 0.5) if sd else 0
    # annualise by exposure: trades per year, not calendar days
    per_yr = len(rets) / (n_days / 252)
    ann = m * per_yr
    sharpe = (m / sd) * (per_yr ** 0.5) if sd else 0
    eq = pk = 1.0
    dd = 0.0
    for r in rets:
        eq *= 1 + r
        pk = max(pk, eq)
        dd = max(dd, 1 - eq / pk)
    win = sum(1 for r in rets if r > 0) / len(rets)
    return dict(label=label, n=len(rets), ann=ann, sharpe=sharpe, t=tstat,
                dd=dd, win=win, total=eq - 1)


def show(s):
    if s is None:
        print("      (too few trades)")
        return
    print(f"   {s['label']:34s} n={s['n']:5d}  {s['ann']*100:+6.1f}%/yr  "
          f"Sharpe {s['sharpe']:5.2f}  t={s['t']:+5.2f}  maxDD {s['dd']:5.1%}  "
          f"win {s['win']:4.0%}")


# ── the hypotheses, fixed before looking ────────────────────────────────────

def m_overnight(bars, **kw):
    return [(bars[i]["o"] / bars[i - 1]["c"] - 1) - COST for i in range(1, len(bars))]


def m_rth(bars, **kw):
    return [(bars[i]["c"] / bars[i]["o"] - 1) - COST for i in range(len(bars))]


def m_buyhold(bars, **kw):
    return [bars[i]["c"] / bars[i - 1]["c"] - 1 for i in range(1, len(bars))]


def m_ibs_to_close(bars, thr=0.2, **kw):
    """Buy the close when the day finished near its low; exit the next close."""
    out = []
    for i in range(1, len(bars) - 1):
        if ibs(bars[i]) < thr:
            out.append((bars[i + 1]["c"] / bars[i]["c"] - 1) - COST)
    return out


def m_ibs_to_open(bars, thr=0.2, **kw):
    """Same trigger, but exit at the next OPEN — overnight only."""
    out = []
    for i in range(1, len(bars) - 1):
        if ibs(bars[i]) < thr:
            out.append((bars[i + 1]["o"] / bars[i]["c"] - 1) - COST)
    return out


def m_overnight_after_down(bars, **kw):
    """Overnight, but only after a down day."""
    out = []
    for i in range(1, len(bars) - 1):
        if bars[i]["c"] < bars[i - 1]["c"]:
            out.append((bars[i + 1]["o"] / bars[i]["c"] - 1) - COST)
    return out


def m_overnight_after_up(bars, **kw):
    out = []
    for i in range(1, len(bars) - 1):
        if bars[i]["c"] >= bars[i - 1]["c"]:
            out.append((bars[i + 1]["o"] / bars[i]["c"] - 1) - COST)
    return out


def m_gap_fade(bars, thr=0.003, **kw):
    """Fade a large opening gap: short an up-gap / buy a down-gap, exit at close."""
    out = []
    for i in range(1, len(bars)):
        gap = bars[i]["o"] / bars[i - 1]["c"] - 1
        if abs(gap) > thr:
            d = -1 if gap > 0 else 1
            out.append(d * (bars[i]["c"] / bars[i]["o"] - 1) - COST)
    return out


def m_gap_go(bars, thr=0.003, **kw):
    out = []
    for i in range(1, len(bars)):
        gap = bars[i]["o"] / bars[i - 1]["c"] - 1
        if abs(gap) > thr:
            d = 1 if gap > 0 else -1
            out.append(d * (bars[i]["c"] / bars[i]["o"] - 1) - COST)
    return out


def m_three_down(bars, **kw):
    """Buy the close after three consecutive lower closes, exit next close."""
    out = []
    for i in range(3, len(bars) - 1):
        if bars[i]["c"] < bars[i-1]["c"] < bars[i-2]["c"]:
            out.append((bars[i + 1]["c"] / bars[i]["c"] - 1) - COST)
    return out


def m_ibs_high_short(bars, thr=0.9, **kw):
    """Mirror test: short the close when the day finished near its high."""
    out = []
    for i in range(1, len(bars) - 1):
        if ibs(bars[i]) > thr:
            out.append(-(bars[i + 1]["c"] / bars[i]["c"] - 1) - COST)
    return out


MODELS = [
    ("buy & hold (benchmark)", m_buyhold),
    ("overnight only", m_overnight),
    ("RTH only (day trading)", m_rth),
    ("overnight after a down day", m_overnight_after_down),
    ("overnight after an up day", m_overnight_after_up),
    ("IBS<0.2 -> next close", m_ibs_to_close),
    ("IBS<0.2 -> next open", m_ibs_to_open),
    ("IBS>0.9 short -> next close", m_ibs_high_short),
    ("gap >0.3% fade to close", m_gap_fade),
    ("gap >0.3% continue to close", m_gap_go),
    ("3 lower closes -> next close", m_three_down),
]


def main(data="../ictdata", symbols=("QQQ", "SPY")):
    for sym in symbols:
        bars = load(f"{data}/{sym}_1d.csv")
        span = (bars[-1]["t"] - bars[0]["t"]) / 86400
        print(f"\n=== {sym}: {len(bars)} sessions, {span/365.25:.1f} years ===")
        for label, fn in MODELS:
            show(stats(fn(bars), label, span))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../ictdata")
