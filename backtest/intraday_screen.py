#!/usr/bin/env python3
"""Screen for edges that fit inside a <=2 hour holding window.

Same discipline as edge_screen.py: hypotheses fixed in advance, each with at
most two parameters, tested on the largest sample available (875 days of 1h
data, ~600 RTH sessions per symbol) and pooled across six instruments.

Entry is always at the NEXT bar's open (never the signal bar's close), exit is
a fixed number of bars later, so the holding period is explicit and nothing
depends on intrabar path assumptions.
"""
import csv
import statistics as st
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
COST_BP = 1.0          # ~1bp round turn: MNQ commission + 1 tick, on ~29,500


def load(path):
    out = []
    with open(path) as f:
        for r in csv.DictReader(f):
            ts = int(r["time"])
            d = datetime.fromtimestamp(ts, ET)
            out.append(dict(t=ts, hm=d.hour * 60 + d.minute, date=d.date(),
                            o=float(r["open"]), h=float(r["high"]),
                            l=float(r["low"]), c=float(r["close"])))
    return out


def ibs(b):
    rng = b["h"] - b["l"]
    return 0.5 if rng <= 0 else (b["c"] - b["l"]) / rng


def tstat(xs):
    if len(xs) < 3:
        return 0.0
    sd = st.pstdev(xs) or 1e-9
    return st.mean(xs) / (sd / len(xs) ** 0.5)


def rth(b, lo=570, hi=960):
    return lo <= b["hm"] < hi


def trades(bars, signal, hold, rth_only=True, session_end=960):
    """signal(bars, i) -> +1 long / -1 short / 0 none, decided on bar i's close.
    Enter at open of i+1, exit at close of i+hold. Never crosses the session end."""
    out = []
    n = len(bars)
    for i in range(3, n - hold - 1):
        if rth_only and not rth(bars[i]):
            continue
        d = signal(bars, i)
        if not d:
            continue
        entry_bar = bars[i + 1]
        exit_bar = bars[i + hold]
        if entry_bar["date"] != bars[i]["date"] or exit_bar["date"] != bars[i]["date"]:
            continue                      # keep it inside one session
        if exit_bar["hm"] >= session_end:
            continue
        r = d * (exit_bar["c"] / entry_bar["o"] - 1) * 10000 - COST_BP
        out.append(r)
    return out


# ── hypotheses, fixed in advance ────────────────────────────────────────────
def s_rev_weak(b, i):    return 1 if ibs(b[i]) < 0.3 else 0
def s_rev_strong(b, i):  return -1 if ibs(b[i]) > 0.7 else 0
def s_mom_up(b, i):      return 1 if ibs(b[i]) > 0.7 else 0
def s_mom_down(b, i):    return -1 if ibs(b[i]) < 0.3 else 0
def s_down_bar(b, i):    return 1 if b[i]["c"] < b[i]["o"] else 0
def s_two_down(b, i):    return 1 if b[i]["c"] < b[i - 1]["c"] < b[i - 2]["c"] else 0
def s_two_up(b, i):      return -1 if b[i]["c"] > b[i - 1]["c"] > b[i - 2]["c"] else 0


MODELS = [
    ("reversion: buy weak close (IBS<0.3)", s_rev_weak),
    ("reversion: short strong close (IBS>0.7)", s_rev_strong),
    ("momentum: buy strong close (IBS>0.7)", s_mom_up),
    ("momentum: short weak close (IBS<0.3)", s_mom_down),
    ("reversion: buy any down bar", s_down_bar),
    ("reversion: buy after 2 lower closes", s_two_down),
    ("reversion: short after 2 higher closes", s_two_up),
]

if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "../ictdata"
    syms = ["MNQ", "NQ", "ES", "MES", "QQQ", "SPY"]
    series = {}
    for s in syms:
        try:
            series[s] = load(f"{data}/{s}_1h.csv")
        except FileNotFoundError:
            pass
    for hold in (1, 2):
        print(f"\n===== hold {hold} bar(s) = {hold} hour(s), RTH only, 1bp cost =====")
        print(f"{'model':42s} {'pooled n':>9s} {'mean bp':>8s} {'t':>6s} {'win':>5s}   per-symbol t")
        for label, fn in MODELS:
            pooled, per = [], []
            for s in syms:
                if s not in series:
                    continue
                tr = trades(series[s], fn, hold)
                pooled += tr
                per.append(f"{s}:{tstat(tr):+.1f}")
            if len(pooled) < 100:
                continue
            win = sum(1 for x in pooled if x > 0) / len(pooled)
            print(f"{label:42s} {len(pooled):9d} {st.mean(pooled):+8.2f} "
                  f"{tstat(pooled):+6.2f} {win:5.0%}   {' '.join(per)}")
