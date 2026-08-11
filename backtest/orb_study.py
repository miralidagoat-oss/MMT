#!/usr/bin/env python3
"""NY-open Opening Range Breakout (ORB) study for MNQ intraday timeframes.

Strategy family under test: after the 09:30 ET RTH open, the first N minutes
define an opening range (OR). Stop orders rest one tick beyond the OR high
(long) and OR low (short); the first side hit is the day's trade. Exits are a
fixed-R target and/or a mandatory end-of-day flat before the 16:00 ET close,
with optional breakeven management and an optional second-chance entry on the
opposite side after a first-trade stopout.

Fill model — same deliberately pessimistic rules as backtest.py:
  - the entry stop triggers on the bar whose high/low trades through it;
    if that same bar also trades through the protective stop, the trade
    books as an immediate loss
  - the target is never credited on the entry bar
  - if stop and target both print inside one bar, the stop wins
  - the breakeven trigger arms only after stop/target checks, so the moved
    stop takes effect on the NEXT bar
  - EOD exits book at the last RTH bar's close in fractional R

Costs are charged per round trip in index points (commission + exchange fees
+ one tick of slippage per side) and converted to R per trade, so tiny-range
days are penalized naturally instead of hidden.

Usage:
  python3 orb_study.py sweep   <mnq_dir>                    # IS grid sweep
  python3 orb_study.py validate <mnq_dir> <nq_dir> <es_dir> # full report
"""
import csv
import datetime
import itertools
import os
import sys
import zoneinfo

ET = zoneinfo.ZoneInfo("America/New_York")
TICK = 0.25

# round-trip friction per contract, in index points:
#   commission+fees ($ RT) / $-per-point  +  2 ticks slippage (1 per side)
COST_PTS = {"MNQ": 1.5, "NQ": 0.75, "ES": 0.6}   # conservative
DOLLARS_PER_PT = {"MNQ": 2.0, "NQ": 20.0, "ES": 50.0}


def load(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append((int(r["time"]), float(r["open"]), float(r["high"]),
                         float(r["low"]), float(r["close"]), float(r["volume"])))
    return rows


def sessions(rows):
    """Group bars into ET RTH sessions (09:30 <= t < 16:00), keyed by date."""
    out = {}
    for t, o, h, l, c, v in rows:
        dt = datetime.datetime.fromtimestamp(t, ET)
        mins = dt.hour * 60 + dt.minute
        if 570 <= mins < 960:
            out.setdefault(dt.date(), []).append((mins, o, h, l, c, v))
    return {d: sorted(b) for d, b in out.items() if any(m == 570 for m, *_ in b)}


# ── simulation ───────────────────────────────────────────────────────────────

def run_day(bars, p, cost_pts):
    """Simulate one RTH session. Returns list of closed trades:
    (dir, r_gross, r_net, pts_net, risk_pts, exit_reason)."""
    or_end = 570 + p["or_min"]
    or_bars = [b for b in bars if b[0] < or_end]
    if len(or_bars) < p["or_min"] // p["bar_min"]:
        return []
    orh = max(b[2] for b in or_bars)
    orl = min(b[3] for b in or_bars)
    or_dir = 1 if or_bars[-1][4] > or_bars[0][1] else -1 if or_bars[-1][4] < or_bars[0][1] else 0

    allowed = (1, -1)
    if p["dir_filter"] == "or_dir":
        if or_dir == 0:
            return []
        allowed = (or_dir,)

    entry_l = orh + TICK
    entry_s = orl - TICK
    if p["stop_mode"] == "opposite":
        stop_l, stop_s = orl, orh
    else:  # half: OR midpoint
        mid = (orh + orl) / 2.0
        stop_l, stop_s = mid, mid

    trades = []
    open_tr = None
    closed = []
    armed = {1: 1 in allowed, -1: -1 in allowed}
    last_exit_bar = -1

    def book(tr, r_gross, reason):
        r_net = r_gross - cost_pts / tr["risk"]
        pts = r_gross * tr["risk"] - cost_pts
        closed.append((tr["dir"], r_gross, r_net, pts, tr["risk"], reason))

    for i, (m, o, h, l, c, v) in enumerate(bars):
        if m < or_end:
            continue
        # manage the open trade first
        if open_tr is not None:
            tr = open_tr
            bull = tr["dir"] == 1
            stop_hit = l <= tr["stop"] if bull else h >= tr["stop"]
            tp_hit = (tr["tp"] is not None and i > tr["entry_bar"]
                      and (h >= tr["tp"] if bull else l <= tr["tp"]))
            if stop_hit:
                book(tr, 0.0 if tr["be"] else -1.0, "be" if tr["be"] else "stop")
                open_tr, last_exit_bar = None, i
            elif tp_hit:
                book(tr, p["rr"], "target")
                open_tr, last_exit_bar = None, i
            elif p["be_trigger"] > 0 and not tr["be"]:
                trig = tr["entry"] + tr["dir"] * p["be_trigger"] * tr["risk"]
                if (h >= trig) if bull else (l <= trig):
                    tr["stop"] = tr["entry"]
                    tr["be"] = True
        # try entries (never on the bar a previous trade exited)
        if open_tr is None and m < p["cutoff"] and i > last_exit_bar - 1:
            if len(trades) >= (2 if p["second"] else 1):
                pass
            else:
                for d, ep, sp in ((1, entry_l, stop_l), (-1, entry_s, stop_s)):
                    if not armed[d]:
                        continue
                    hit = h >= ep if d == 1 else l <= ep
                    if not hit or i <= last_exit_bar:
                        continue
                    risk = (ep - sp) if d == 1 else (sp - ep)
                    if risk <= TICK:
                        armed[d] = False
                        continue
                    tr = {"dir": d, "entry": ep, "stop": sp, "risk": risk,
                          "tp": ep + d * risk * p["rr"] if p["rr"] else None,
                          "be": False, "entry_bar": i}
                    armed[d] = False
                    if not p["second"]:
                        armed[-d] = False
                    trades.append(tr)
                    # pessimistic: same-bar stop = instant loss
                    if (l <= sp) if d == 1 else (h >= sp):
                        book(tr, -1.0, "stop")
                        last_exit_bar = i
                    else:
                        open_tr = tr
                    break
    if open_tr is not None:
        tr = open_tr
        last_c = bars[-1][4]
        r = tr["dir"] * (last_c - tr["entry"]) / tr["risk"]
        book(tr, r, "eod")
    return closed


def run(sess, p, cost_pts):
    out = []
    for d in sorted(sess):
        for tr in run_day(sess[d], p, cost_pts):
            out.append((d,) + tr)
    return out


# ── fade variant: failed-breakout (sweep-and-reclaim) of the OR extremes ─────

def run_day_fade(bars, p, cost_pts):
    """Fade a failed OR breakout. A 'poke' trades beyond the OR extreme by at
    least min_poke x OR width; when a bar then CLOSES back inside the range,
    enter at that close targeting mid/opposite/R-multiple, stop beyond the
    poke extreme. Same pessimistic ordering: stop first, target never on the
    entry bar, BE arms after checks. Max one fade per side per day."""
    or_end = 570 + p["or_min"]
    or_bars = [b for b in bars if b[0] < or_end]
    if len(or_bars) < p["or_min"] // p["bar_min"]:
        return []
    orh = max(b[2] for b in or_bars)
    orl = min(b[3] for b in or_bars)
    orw = orh - orl
    if orw <= 4 * TICK:
        return []
    mid = (orh + orl) / 2.0

    closed = []
    open_tr = None
    done = {1: False, -1: False}          # one fade per side per day
    poke_hi, poke_lo = None, None          # running poke extremes

    def book(tr, r_gross, reason):
        r_net = r_gross - cost_pts / tr["risk"]
        pts = r_gross * tr["risk"] - cost_pts
        closed.append((tr["dir"], r_gross, r_net, pts, tr["risk"], reason))

    for i, (m, o, h, l, c, v) in enumerate(bars):
        if m < or_end:
            continue
        if open_tr is not None:
            tr = open_tr
            bull = tr["dir"] == 1
            if i > tr["entry_bar"]:
                stop_hit = l <= tr["stop"] if bull else h >= tr["stop"]
                tp_hit = h >= tr["tp"] if bull else l <= tr["tp"]
                if stop_hit:
                    book(tr, 0.0 if tr["be"] else -1.0, "be" if tr["be"] else "stop")
                    open_tr = None
                elif tp_hit:
                    book(tr, tr["rr_book"], "target")
                    open_tr = None
                elif p["be_trigger"] > 0 and not tr["be"]:
                    trig = tr["entry"] + tr["dir"] * p["be_trigger"] * tr["risk"]
                    if (h >= trig) if bull else (l <= trig):
                        tr["stop"] = tr["entry"]
                        tr["be"] = True
        # track pokes beyond the OR (uses the live bar's extremes)
        if h > orh + p["min_poke"] * orw:
            poke_hi = h if poke_hi is None else max(poke_hi, h)
        if l < orl - p["min_poke"] * orw:
            poke_lo = l if poke_lo is None else min(poke_lo, l)
        # reclaim close back inside the range -> fade entry at this close
        if open_tr is None and m < p["cutoff"]:
            sig = None
            if poke_hi is not None and not done[-1] and c < orh:
                sig = (-1, poke_hi)
            elif poke_lo is not None and not done[1] and c > orl:
                sig = (1, poke_lo)
            if sig:
                d, extreme = sig
                stop = extreme + (2 * TICK if d == -1 else -2 * TICK)
                entry = c
                risk = (stop - entry) if d == -1 else (entry - stop)
                if p["target"] == "mid":
                    tp = mid
                elif p["target"] == "opposite":
                    tp = orl if d == -1 else orh
                else:                      # R-multiple of risk
                    tp = entry + d * risk * p["target"]
                room = (entry - tp) if d == -1 else (tp - entry)
                done[d] = True             # one attempt per side regardless
                if d == -1:
                    poke_hi = None
                else:
                    poke_lo = None
                if risk <= TICK or room <= 0 or room / risk < p["min_rr"]:
                    continue
                open_tr = {"dir": d, "entry": entry, "stop": stop, "risk": risk,
                           "tp": tp, "be": False, "entry_bar": i,
                           "rr_book": room / risk}
    if open_tr is not None:
        tr = open_tr
        last_c = bars[-1][4]
        book(tr, tr["dir"] * (last_c - tr["entry"]) / tr["risk"], "eod")
    return closed


def run_fade(sess, p, cost_pts):
    out = []
    for d in sorted(sess):
        for tr in run_day_fade(sess[d], p, cost_pts):
            out.append((d,) + tr)
    return out


def run_fade_hourly(sess, p, cost_pts):
    q = dict(p)
    q["or_min"] = 60
    q["bar_min"] = 60
    out = []
    for d in sorted(sess):
        bars = [(m + 30, o, h, l, c, v) for m, o, h, l, c, v in sess[d]]
        for tr in run_day_fade(bars, q, cost_pts):
            out.append((d,) + tr)
    return out


FADE_GRID = {
    "or_min": [15, 30, 60],
    "min_poke": [0.0, 0.1, 0.25],
    "target": ["mid", "opposite", 1.0, 1.5, 2.0],
    "be_trigger": [0.0, 1.0],
    "min_rr": [0.0, 0.5, 1.0],
    "cutoff": [780, 930],
}


def fade_params():
    keys = list(FADE_GRID)
    for combo in itertools.product(*FADE_GRID.values()):
        p = dict(zip(keys, combo))
        p["bar_min"] = 5
        yield p


def fade_structural(mnq_dir, nq_dir):
    """Rank fade structures on the 2-year HOURLY data (600 sessions of real
    statistical power), demanding both years positive on MNQ and NQ."""
    hs_mnq = hourly_sessions(load(os.path.join(mnq_dir, "MNQ_1h.csv")))
    hs_nq = hourly_sessions(load(os.path.join(nq_dir, "NQ_1h.csv")))
    days = sorted(hs_mnq)
    cutd = days[len(days) // 2]
    rows = []
    for p in fade_params():
        if p["or_min"] != 60:
            continue                       # hourly OR is fixed at 60m
        c_m = run_fade_hourly(hs_mnq, p, COST_PTS["MNQ"])
        st = stats(c_m)
        if st["n"] < 80:
            continue
        y1 = stats([x for x in c_m if x[0] < cutd])
        y2 = stats([x for x in c_m if x[0] >= cutd])
        c_n = run_fade_hourly(hs_nq, p, COST_PTS["NQ"])
        sn = stats(c_n)
        both_years = y1["net_r"] > 0 and y2["net_r"] > 0
        rows.append((both_years and sn["net_r"] > 0, st["exp"], st["pf"],
                     st["wr"], st["n"], st["net_r"], y1["net_r"], y2["net_r"],
                     sn["pf"], p))
    rows.sort(key=lambda r: (r[0], r[1]), reverse=True)
    print(f"{'ok':>2} {'expR':>7} {'PF':>5} {'WR%':>5} {'n':>4} {'netR':>7} "
          f"{'y1R':>6} {'y2R':>6} {'nqPF':>5}  params")
    for ok, exp, pf, wr, n, net, y1, y2, nqpf, p in rows[:30]:
        ps = {k: v for k, v in p.items() if k not in ("bar_min", "or_min")}
        print(f"{'Y' if ok else '.':>2} {exp:7.3f} {pf:5.2f} {wr:5.1f} {n:4d} "
              f"{net:7.1f} {y1:6.1f} {y2:6.1f} {nqpf:5.2f}  {ps}")


# ── metrics ──────────────────────────────────────────────────────────────────

def stats(closed):
    n = len(closed)
    if not n:
        return dict(n=0, wr=0, pf=0, net_r=0, exp=0, dd=0, pts=0, w=0, l=0, s=0)
    w = sum(1 for x in closed if x[2] > 0.05)
    l = sum(1 for x in closed if x[2] < -0.05)
    s = n - w - l
    gw = sum(x[3] for x in closed if x[3] > 0)
    gl = -sum(x[3] for x in closed if x[3] < 0)
    net_r = sum(x[3] for x in closed)
    pts = sum(x[4] for x in closed)
    eq = peak = dd = 0.0
    for x in closed:
        eq += x[3]
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return dict(n=n, w=w, l=l, s=s, wr=100.0 * w / (w + l) if w + l else 0,
                pf=gw / gl if gl else float("inf"), net_r=net_r,
                exp=net_r / n, dd=dd, pts=pts)


def fmt(label, closed, sym="MNQ"):
    st = stats(closed)
    usd = st["pts"] * DOLLARS_PER_PT.get(sym, 2.0)
    print(f"{label:<30} n={st['n']:<4} W={st['w']:<3} L={st['l']:<3} BE={st['s']:<3} "
          f"WR={st['wr']:5.1f}% PF={st['pf']:5.2f} netR={st['net_r']:+7.1f} "
          f"expR={st['exp']:+6.3f} maxDD={st['dd']:5.1f}R pts={st['pts']:+8.1f} "
          f"(${usd:+,.0f}/contract)")
    return st


# grid: r_gross values use rr=None for EOD-only exit
GRID = {
    "or_min": [5, 15, 30],
    "dir_filter": ["none", "or_dir"],
    "stop_mode": ["opposite", "half"],
    "rr": [1.5, 2.0, 3.0, 5.0, None],
    "be_trigger": [0.0, 1.0],
    "second": [False, True],
    "cutoff": [660, 780, 930],   # 11:00, 13:00, 15:30 ET last-entry
}


def all_params():
    keys = list(GRID)
    for combo in itertools.product(*GRID.values()):
        p = dict(zip(keys, combo))
        p["bar_min"] = 5
        # rr=None means EOD exit only: BE still meaningful, target absent
        yield p


def split_sessions(sess, frac=0.6):
    days = sorted(sess)
    cut = int(len(days) * frac)
    return ({d: sess[d] for d in days[:cut]}, {d: sess[d] for d in days[cut:]})


def sweep(mnq_dir):
    sess = sessions(load(os.path.join(mnq_dir, "MNQ_5m.csv")))
    is_s, oos_s = split_sessions(sess)
    print(f"MNQ 5m sessions: {len(sess)} total -> {len(is_s)} in-sample, "
          f"{len(oos_s)} out-of-sample (untouched)")
    rows = []
    for p in all_params():
        closed = run(is_s, p, COST_PTS["MNQ"])
        st = stats(closed)
        if st["n"] < 12:
            continue
        rows.append((st["exp"], st["pf"], st["wr"], st["n"], st["net_r"],
                     st["dd"], p))
    rows.sort(key=lambda r: (r[0], r[1], r[3]), reverse=True)
    print(f"{'expR':>7} {'PF':>5} {'WR%':>5} {'n':>4} {'netR':>7} {'maxDD':>6}  params")
    for exp, pf, wr, n, net, dd, p in rows[:30]:
        ps = {k: v for k, v in p.items() if k != "bar_min"}
        print(f"{exp:7.3f} {pf:5.2f} {wr:5.1f} {n:4d} {net:7.1f} {dd:6.1f}  {ps}")
    return rows


# ── hourly 2-year proxy: first-hour (09:00-10:00 ET bar) breakout ────────────

def hourly_sessions(rows):
    out = {}
    for t, o, h, l, c, v in rows:
        dt = datetime.datetime.fromtimestamp(t, ET)
        if 9 <= dt.hour <= 15:
            out.setdefault(dt.date(), []).append((dt.hour * 60, o, h, l, c, v))
    return {d: sorted(b) for d, b in out.items()
            if any(m == 540 for m, *_ in b) and len(b) >= 4}


def run_hourly(sess, p, cost_pts):
    q = dict(p)
    q["or_min"] = 60          # the 09:00-10:00 bar is the OR
    q["bar_min"] = 60
    out = []
    for d in sorted(sess):
        # shift +30 so the 09:00 bar (540) lands inside the 570-based OR
        # window and the 10:00 bar (630) is the first tradeable bar
        bars = [(m + 30, o, h, l, c, v) for m, o, h, l, c, v in sess[d]]
        for tr in run_day(bars, q, cost_pts):
            out.append((d,) + tr)
    return out


def validate(mnq_dir, nq_dir, es_dir, chosen):
    print("═" * 78)
    print("VALIDATION REPORT — chosen config:", {k: v for k, v in chosen.items() if k != "bar_min"})
    print("═" * 78)

    mnq5 = sessions(load(os.path.join(mnq_dir, "MNQ_5m.csv")))
    is_s, oos_s = split_sessions(mnq5)
    print("\n── A. MNQ 5m walk-forward (tuned on IS only; OOS untouched)")
    fmt("MNQ 5m in-sample", run(is_s, chosen, COST_PTS["MNQ"]))
    fmt("MNQ 5m OUT-OF-SAMPLE", run(oos_s, chosen, COST_PTS["MNQ"]))
    full = run(mnq5, chosen, COST_PTS["MNQ"])
    fmt("MNQ 5m full 60d", full)

    print("\n── B. cross-symbol (same config, zero re-tuning)")
    nq5 = sessions(load(os.path.join(nq_dir, "NQ_5m.csv")))
    es5 = sessions(load(os.path.join(es_dir, "ES_5m.csv")))
    fmt("NQ  5m full 60d", run(nq5, chosen, COST_PTS["NQ"]), "NQ")
    fmt("ES  5m full 60d", run(es5, chosen, COST_PTS["ES"]), "ES")

    print("\n── C. 2-year hourly proxy (first-hour-bar breakout, same rules)")
    for tag, ddir, sym in (("MNQ", mnq_dir, "MNQ"), ("NQ", nq_dir, "NQ"),
                           ("ES", es_dir, "ES")):
        hs = hourly_sessions(load(os.path.join(ddir, f"{tag}_1h.csv")))
        hcfg = dict(chosen)
        hcfg["cutoff"] = 780
        closed = run_hourly(hs, hcfg, COST_PTS[sym])
        h1, h2 = {}, {}
        days = sorted(hs)
        cutd = days[len(days) // 2]
        fmt(f"{tag} 1h 2y   ({len(hs)} sessions)", closed, sym)
        fmt(f"{tag} 1h  year 1", [x for x in closed if x[0] < cutd], sym)
        fmt(f"{tag} 1h  year 2", [x for x in closed if x[0] >= cutd], sym)

    print("\n── D. attribution on MNQ 5m full sample")
    fmt("longs", [x for x in full if x[1] == 1])
    fmt("shorts", [x for x in full if x[1] == -1])
    for wd, name in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri"]):
        fmt(name, [x for x in full if x[0].weekday() == wd])
    from collections import Counter
    reasons = Counter(x[6] for x in full)
    print("exit reasons:", dict(reasons))

    print("\n── E. parameter-neighborhood stability (MNQ 5m full, vary one knob)")
    for key, vals in (("rr", [1.5, 2.0, 3.0, 5.0, None]),
                      ("or_min", [5, 15, 30]),
                      ("stop_mode", ["opposite", "half"]),
                      ("be_trigger", [0.0, 1.0]),
                      ("cutoff", [660, 780, 930]),
                      ("second", [False, True]),
                      ("dir_filter", ["none", "or_dir"])):
        for v in vals:
            q = dict(chosen)
            q[key] = v
            mark = " <== chosen" if v == chosen[key] else ""
            fmt(f"  {key}={v}{mark}", run(mnq5, q, COST_PTS["MNQ"]))

    print("\n── F. 1m-granularity fill check (last 7 days, same config on 1m bars)")
    m1 = load(os.path.join(mnq_dir, "MNQ_1m.csv"))
    s1 = sessions(m1)
    q = dict(chosen)
    q["bar_min"] = 1
    c1 = run(s1, q, COST_PTS["MNQ"])
    c5 = [x for x in full if x[0] in s1]
    fmt("same days on 1m bars", c1)
    fmt("same days on 5m bars", c5)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "sweep":
        sweep(sys.argv[2])
    elif mode == "fade-structural":
        fade_structural(sys.argv[2], sys.argv[3])
    else:
        import json
        chosen = dict(or_min=15, dir_filter="none", stop_mode="opposite",
                      rr=3.0, be_trigger=1.0, second=False, cutoff=780,
                      bar_min=5)
        if len(sys.argv) > 5:
            chosen.update(json.loads(sys.argv[5]))
            if "rr" in chosen and chosen["rr"] == 0:
                chosen["rr"] = None
        validate(sys.argv[2], sys.argv[3], sys.argv[4], chosen)
