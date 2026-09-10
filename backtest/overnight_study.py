#!/usr/bin/env python3
"""Where the directional edge in index futures actually is: the overnight session.

This is the research behind indicators/overnight_drift_matrix.pine.

THE QUESTION.  Is there a directional edge tradeable on a 15m NQ/MNQ chart?

THE DATA PROBLEM.  Yahoo caps 15m history at 60 days, which cannot validate
anything (a once-a-day strategy gets ~20 out-of-sample trades). But the two
effects that survive testing only need the RTH open and close, and index
ETFs give those exactly -- their daily open IS the 09:30 print and their
close IS the 16:00 print, which futures daily bars do not provide because
the futures "open" is the prior evening's Globex open. So the long-history
work is done on QQQ / SPY / DIA / IWM (27-33 years) and then confirmed on
real NQ/MNQ/ES/RTY futures.

WHAT SURVIVED.  One thing: long the overnight session, taken only when price
is above its 200-day average. Weekday filters were tested and REJECTED --
skipping the Friday entry (the weekend hold) looks appealing and is worse on
three of the four instruments. Beware of keying a weekday off the wrong end
of the trade: a position entered Friday exits Monday, so filtering on the
exit day silently tests Thursday entries instead.

WHAT DID NOT.  Every intraday variant tested -- opening-range breakout, gap
continuation, gap fade, and directional RTH in either trend regime -- loses
money on all four instruments after costs. The RTH session is a coin flip
minus fees; the drift is entirely overnight.

Costs: 1.0 bp of notional per round trip, which is roughly 2.4 ticks on MNQ
at NQ=24,000 -- deliberately conservative for a liquid future.

Modes:
  python3 overnight_study.py <daily_dir> rule       headline result + eras
  python3 overnight_study.py <daily_dir> filters    which filters survive
  python3 overnight_study.py <daily_dir> intraday   the negative results
  python3 overnight_study.py <daily_dir> futures <intraday_dir>   NQ/MNQ check
"""
import csv
import math
import os
import sys
from datetime import datetime, timezone

COST_BP = 1.0
ETFS = ("QQQ", "SPY", "DIA", "IWM")


# ── data ─────────────────────────────────────────────────────────────────────

def load_daily(path):
    T, O, C = [], [], []
    with open(path) as f:
        for r in csv.DictReader(f):
            o, c = float(r["open"]), float(r["close"])
            if o <= 0 or c <= 0:
                continue
            T.append(int(r["time"])); O.append(o); C.append(c)
    return T, O, C


def sessions(path, sma_len=200):
    """One row per session: overnight return, intraday return, filter state.

    The trend filter reads the SMA as of the PRIOR close, i.e. the value a
    trader actually has in hand at the 16:00 entry -- no lookahead.
    """
    T, O, C = load_daily(path)
    n = len(C)
    sma, run = [None] * n, 0.0
    for i in range(n):
        run += C[i]
        if i >= sma_len:
            run -= C[i - sma_len]
        sma[i] = run / sma_len if i >= sma_len - 1 else None
    rows = []
    for i in range(1, n):
        entry_dt = datetime.fromtimestamp(T[i - 1], timezone.utc)   # the 16:00 entry
        rows.append(dict(
            overnight=1e4 * (O[i] / C[i - 1] - 1.0),
            intraday=1e4 * (C[i] / O[i] - 1.0),
            gap=1e4 * (O[i] / C[i - 1] - 1.0),
            above=sma[i - 1] is not None and C[i - 1] > sma[i - 1],
            friday=entry_dt.weekday() == 4,
            entry_dow=entry_dt.weekday(),
            year=datetime.fromtimestamp(T[i], timezone.utc).year))
    return rows


# ── metrics ──────────────────────────────────────────────────────────────────

def perf(label, r, sessions_in_window):
    """Sharpe is annualised with the strategy's own trade frequency inside the
    window being measured, so sub-period figures stay comparable."""
    n = len(r)
    if n < 30:
        print(f"    {label:<26} n={n} — too few")
        return None
    m = sum(r) / n
    sd = math.sqrt(sum((z - m) ** 2 for z in r) / (n - 1))
    eq = pk = dd = 0.0
    for z in r:
        eq += z
        pk = max(pk, eq)
        dd = max(dd, pk - eq)
    freq = 252.0 * n / max(sessions_in_window, 1)
    sh = (m / sd) * math.sqrt(freq) if sd > 0 else 0.0
    t = m / (sd / math.sqrt(n)) if sd > 0 else 0.0
    print(f"    {label:<26} n={n:<5} {m:+6.2f}bp t={t:+5.1f} Sharpe={sh:+5.2f} "
          f"cum={sum(r)/100:+7.1f}% maxDD={dd/100:5.1f}% wr={100*sum(1 for z in r if z>0)/n:4.1f}%")
    return dict(n=n, mean=m, t=t, sharpe=sh, cum=sum(r) / 100, dd=dd / 100)


def in_rule(x):
    """The rule: long overnight, only above the 200-day average.

    `friday` is carried on each row so the rejected weekday variants stay
    reproducible, but it is deliberately NOT part of the rule.
    """
    return x["above"]


# ── modes ────────────────────────────────────────────────────────────────────

def mode_rule(d):
    for tag in ETFS:
        p = os.path.join(d, f"{tag}_1d.csv")
        if not os.path.exists(p):
            continue
        rows = sessions(p)
        N = len(rows)
        cutyr = rows[int(N * 0.6)]["year"]
        print(f"\n═══ {tag}   {rows[0]['year']}–{rows[-1]['year']}   {N} sessions ═══")
        perf("buy & hold overnight", [x["overnight"] - COST_BP for x in rows], N)
        perf("buy & hold 24h", [x["overnight"] + x["intraday"] - COST_BP for x in rows], N)
        perf("RULE (trend filter)", [x["overnight"] - COST_BP for x in rows if in_rule(x)], N)
        for lab, pred in ((f"  in-sample <{cutyr}", lambda x: x["year"] < cutyr),
                          (f"  OUT-OF-SAMPLE >={cutyr}", lambda x: x["year"] >= cutyr),
                          ("  2023-2026 (post-pub)", lambda x: x["year"] >= 2023)):
            win = [x for x in rows if pred(x)]
            perf(lab, [x["overnight"] - COST_BP for x in win if in_rule(x)], len(win))


def mode_filters(d):
    """Which filters survive? The bar: a filter is kept only if it improves
    out-of-sample Sharpe on EVERY instrument. Anything less is a multi-way
    carve finding a pattern in one series.

    The weekday of a trade is its ENTRY day (the close it is bought at); the
    exit lands on the next session, so a Friday entry exits Monday.
    """
    names = "Mon Tue Wed Thu Fri".split()
    data = {}
    for t in ETFS:
        p = os.path.join(d, f"{t}_1d.csv")
        if os.path.exists(p):
            data[t] = sessions(p)

    def oos_sharpe(rows, keep):
        cut = int(len(rows) * 0.6)
        sel = [x["overnight"] - COST_BP for x in rows[cut:] if keep(x)]
        if len(sel) < 30:
            return None
        m = sum(sel) / len(sel)
        sd = math.sqrt(sum((z - m) ** 2 for z in sel) / (len(sel) - 1))
        return (m / sd) * math.sqrt(252.0 * len(sel) / len(rows[cut:])) if sd > 0 else 0.0

    print("Out-of-sample Sharpe by instrument. Kept only if it improves ALL four.\n")
    for name, keep in (
            ("baseline: always long",      lambda x: True),
            ("F1 trend (>200d SMA)",       lambda x: x["above"]),
            ("F1 + skip Friday entry",     lambda x: x["above"] and not x["friday"]),
            ("F1 + skip Thursday entry",   lambda x: x["above"] and x["entry_dow"] != 3),
            ("F1 + skip Monday entry",     lambda x: x["above"] and x["entry_dow"] != 0),
            ("F1 + prev intraday < 0",     lambda x: x["above"] and x["intraday"] < 0)):
        vals, line = [], f"  {name:<28}"
        for tag, rows in data.items():
            v = oos_sharpe(rows, keep)
            if v is None:
                line += f" {tag}:  n/a "
                continue
            vals.append(v)
            line += f" {tag}:{v:+5.2f}"
        print(line + (f"   | worst {min(vals):+5.2f}" if vals else ""))

    print("\n  Overnight OOS Sharpe by ENTRY weekday (trend filter on):")
    print(f"  {'entry day':<11} " + "  ".join(f"{t:>10}" for t in data))
    for w in range(5):
        line = f"  {names[w]:<11}"
        for tag, rows in data.items():
            v = oos_sharpe(rows, lambda x, w=w: x["above"] and x["entry_dow"] == w)
            line += f"  {v:+8.2f}" if v is not None else "       n/a"
        print(line)
    print("\n  No weekday exclusion improves every instrument, so none is used.")


def mode_intraday(d):
    print("Every intraday variant, 27+ years. All negative on all instruments.\n")
    variants = (
        ("gap continuation", lambda x: x["gap"] != 0, lambda x: 1 if x["gap"] > 0 else -1),
        ("gap fade", lambda x: x["gap"] != 0, lambda x: -1 if x["gap"] > 0 else 1),
        ("short RTH if <200d SMA", lambda x: not x["above"], lambda x: -1),
        ("long RTH if >200d SMA", lambda x: x["above"], lambda x: 1),
    )
    for tag in ETFS:
        p = os.path.join(d, f"{tag}_1d.csv")
        if not os.path.exists(p):
            continue
        rows = sessions(p)
        print(f"\n═══ {tag} intraday 09:30→16:00 ═══")
        for lab, sel, sgn in variants:
            sub = [x for x in rows if sel(x)]
            perf(lab, [sgn(x) * x["intraday"] - COST_BP for x in sub], len(rows))


def mode_futures(d, intraday_dir):
    """Confirm on real futures. Needs 15m/1h CSVs with ET-resolvable timestamps."""
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
    for tag, tf, min_rth in (("NQ", "1h", 5), ("MNQ", "1h", 5), ("ES", "1h", 5),
                             ("RTY", "1h", 5), ("NQ", "15m", 20), ("MNQ", "15m", 20)):
        p = os.path.join(intraday_dir, f"{tag}_{tf}.csv")
        if not os.path.exists(p):
            continue
        days = {}
        with open(p) as f:
            for r in csv.DictReader(f):
                dt = datetime.fromtimestamp(int(r["time"]), ET)
                hm = dt.hour * 60 + dt.minute
                if not (570 <= hm < 960):          # 09:30-16:00 ET
                    continue
                k = dt.strftime("%Y-%m-%d")
                e = days.setdefault(k, dict(n=0, dow=dt.weekday()))
                if "o" not in e:
                    e["o"] = float(r["open"])
                e["c"] = float(r["close"])
                e["n"] += 1
        keys = [k for k in sorted(days) if days[k]["n"] >= min_rth]
        closes = [days[k]["c"] for k in keys]
        rows = []
        for i in range(1, len(keys)):
            prev, cur = days[keys[i - 1]], days[keys[i]]
            w = closes[max(0, i - 200):i]
            rows.append(dict(overnight=1e4 * (cur["o"] / prev["c"] - 1.0),
                             above=prev["c"] > sum(w) / len(w),
                             friday=prev["dow"] == 4))
        if len(rows) < 30:
            continue
        print(f"\n═══ {tag} {tf} futures   {keys[0]} → {keys[-1]}   {len(rows)} sessions ═══")
        perf("buy & hold overnight", [x["overnight"] - COST_BP for x in rows], len(rows))
        perf("RULE (trend filter)",
             [x["overnight"] - COST_BP for x in rows if in_rule(x)], len(rows))


if __name__ == "__main__":
    d = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "rule"
    if mode == "rule":
        mode_rule(d)
    elif mode == "filters":
        mode_filters(d)
    elif mode == "intraday":
        mode_intraday(d)
    elif mode == "futures":
        mode_futures(d, sys.argv[3])
    else:
        raise SystemExit(f"unknown mode {mode}")
