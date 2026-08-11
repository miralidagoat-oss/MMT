#!/usr/bin/env python3
"""Pre-registered test: the v3.2 sweep-rejection engine with its rolling
12-bar extremes replaced by the day's structural liquidity levels.

Hypothesis (fixed BEFORE running, zero tuning): on sub-hourly MNQ the
rolling-extreme engine is breakeven because 12-bar extremes are arbitrary
prices; the same bar-quality gates applied to sweeps of the session's REAL
stop-pools — prior-day high/low (PDH/PDL), overnight high/low (ONH/ONL) and
the 30-minute opening range (ORH/ORL) — should carry the 1H edge down to
intraday timeframes.

Everything else is the shipped MNQ preset, verbatim: body<=0.33, wick>=0.35,
close-pos>=0.7, range>=1.0x avg, volume participation>=0.8x, sweep depth
>=0.75 sigma, stop 1.5 sigma beyond the wick, RR 4, limit at wick midpoint,
validity 24 bars, cooldown 10 bars, RTH-only signals, BE at +1R. New (and
required for a day-trade engine): everything goes flat at the session close,
booked at the last RTH close in fractional R; each level signals at most
once per day.

Fill model: the house pessimistic rules (fill only after the signal bar,
stop wins every ambiguity, TP never on the fill bar, BE arms after checks).
Costs are charged per round trip in index points, converted to R per trade.

Usage: python3 level_study.py <mnq_dir> <nq_dir> <es_dir>
"""
import csv
import datetime
import math
import os
import sys
import zoneinfo

ET = zoneinfo.ZoneInfo("America/New_York")
TICK = 0.25
COST_PTS = {"MNQ": 1.5, "NQ": 0.75, "ES": 0.6}
DOLLARS_PER_PT = {"MNQ": 2.0, "NQ": 20.0, "ES": 50.0}

P = dict(body_thresh=0.33, min_wick=0.35, min_close_pos=0.7, sweep_sigma=0.75,
         range_exp=1.0, vol_mult=0.8, lam=0.94, seed_len=20, stop_sigma=1.5,
         rr=4.0, validity=24, cooldown=10, be_trigger=1.0, or_min=30,
         last_entry_min=930,   # no new signals after 15:30 ET
         eod_flat=True)        # False = hold across sessions like the 1H engine


def load(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append((int(r["time"]), float(r["open"]), float(r["high"]),
                         float(r["low"]), float(r["close"]), float(r["volume"])))
    return rows


def run(rows, cost_pts, bar_min):
    """Continuous simulation over the full series; signals RTH-only at the
    day's structural levels. Returns closed trades:
    (date, dir, level, r_gross, r_net, pts_net, risk, reason)."""
    n = len(rows)
    t = [r[0] for r in rows]
    o = [r[1] for r in rows]
    h = [r[2] for r in rows]
    l = [r[3] for r in rows]
    c = [r[4] for r in rows]
    v = [r[5] for r in rows]

    # EWMA variance of log returns over the CONTINUOUS series
    ewma = [None] * n
    logret = [0.0] * n
    for i in range(1, n):
        logret[i] = math.log(c[i] / c[i - 1])
    for i in range(n):
        prev = ewma[i - 1] if i else None
        if prev is None:
            if i >= P["seed_len"] - 1:
                win = logret[i - P["seed_len"] + 1: i + 1]
                m = sum(win) / P["seed_len"]
                ewma[i] = sum((x - m) ** 2 for x in win) / P["seed_len"]
        else:
            ewma[i] = P["lam"] * prev + (1 - P["lam"]) * logret[i] ** 2

    # ET decomposition per bar
    et = [datetime.datetime.fromtimestamp(x, ET) for x in t]
    mins = [d.hour * 60 + d.minute for d in et]
    dates = [d.date() for d in et]
    in_rth = [570 <= m < 960 for m in mins]

    # session structure state, updated as we walk the series
    day_levels = {}        # active levels for the current RTH day
    cur_day = None
    rth_hi = rth_lo = None         # building current RTH extremes
    prev_rth = None                # (pdh, pdl) from last completed RTH
    on_hi = on_lo = None           # building overnight extremes
    or_hi = or_lo = None
    or_done = False

    trades = []
    closed = []
    last_sig = {1: -10 ** 9, -1: -10 ** 9}

    def book(tr, r_gross, reason, day):
        r_net = r_gross - cost_pts / tr["risk"]
        pts = r_gross * tr["risk"] - cost_pts
        closed.append((day, tr["dir"], tr["level"], r_gross, r_net, pts,
                       tr["risk"], reason))

    rng = [h[i] - l[i] for i in range(n)]

    for i in range(n):
        d, m = dates[i], mins[i]

        # ── session bookkeeping ──
        if in_rth[i]:
            if cur_day != d:
                # new RTH day begins
                cur_day = d
                pdh = prev_rth[0] if prev_rth else None
                pdl = prev_rth[1] if prev_rth else None
                day_levels = {"PDH": pdh, "PDL": pdl,
                              "ONH": on_hi, "ONL": on_lo,
                              "ORH": None, "ORL": None}
                rth_hi, rth_lo = h[i], l[i]
                or_hi, or_lo = h[i], l[i]
                or_done = False
                used = set()
                if P["eod_flat"]:
                    # kill anything left over from a previous day (safety)
                    for tr in trades:
                        if tr["state"] in ("pending", "filled"):
                            tr["state"] = "dead"
            else:
                rth_hi, rth_lo = max(rth_hi, h[i]), min(rth_lo, l[i])
            if not or_done:
                if m < 570 + P["or_min"]:
                    or_hi, or_lo = max(or_hi, h[i]), min(or_lo, l[i])
                else:
                    day_levels["ORH"], day_levels["ORL"] = or_hi, or_lo
                    or_done = True
        else:
            if rth_hi is not None:
                prev_rth = (rth_hi, rth_lo)
                rth_hi = rth_lo = None
                on_hi, on_lo = h[i], l[i]      # overnight build starts
            elif on_hi is not None:
                on_hi, on_lo = max(on_hi, h[i]), min(on_lo, l[i])

        # ── manage open setups (created strictly earlier) ──
        if in_rth[i] or not P["eod_flat"]:
            eod = (P["eod_flat"] and in_rth[i]
                   and ((i + 1 >= n) or not in_rth[i + 1] or dates[i + 1] != d))
            for tr in trades:
                if tr["state"] not in ("pending", "filled") or tr["created"] >= i:
                    continue
                bull = tr["dir"] == 1
                if tr["state"] == "pending":
                    if (l[i] <= tr["entry"]) if bull else (h[i] >= tr["entry"]):
                        tr["state"] = "filled"
                        tr["filled_bar"] = i
                        if (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"]):
                            tr["state"] = "done"
                            book(tr, -1.0, "stop", d)
                    elif i - tr["created"] >= P["validity"] or eod:
                        tr["state"] = "expired"
                else:
                    stop_hit = (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"])
                    tp_hit = (i > tr["filled_bar"]
                              and ((h[i] >= tr["tp"]) if bull else (l[i] <= tr["tp"])))
                    if stop_hit:
                        tr["state"] = "done"
                        book(tr, 0.0 if tr["be"] else -1.0,
                             "be" if tr["be"] else "stop", d)
                    elif tp_hit:
                        tr["state"] = "done"
                        book(tr, P["rr"], "target", d)
                    else:
                        if P["be_trigger"] > 0 and not tr["be"]:
                            trig = tr["entry"] + tr["dir"] * P["be_trigger"] * tr["risk"]
                            if (h[i] >= trig) if bull else (l[i] <= trig):
                                tr["stop"] = tr["entry"]
                                tr["be"] = True
                        if eod and tr["state"] == "filled":
                            tr["state"] = "done"
                            book(tr, tr["dir"] * (c[i] - tr["entry"]) / tr["risk"],
                                 "eod", d)

        # ── signal detection ──
        if not in_rth[i] or m >= P["last_entry_min"] or ewma[i] is None or i < 20:
            continue
        bar_rng = rng[i]
        if bar_rng <= 0:
            continue
        vol_sma = sum(v[i - 19: i + 1]) / 20
        rng_sma = sum(rng[i - 19: i + 1]) / 20
        body = abs(c[i] - o[i])
        top_w = h[i] - max(c[i], o[i])
        bot_w = min(c[i], o[i]) - l[i]
        vp = math.sqrt(max(ewma[i], 0.0)) * c[i]
        small = body <= bar_rng * P["body_thresh"]
        rok = bar_rng >= rng_sma * P["range_exp"]

        for dirn, names in ((1, ("PDL", "ONL", "ORL")), (-1, ("PDH", "ONH", "ORH"))):
            if i - last_sig[dirn] < P["cooldown"]:
                continue
            wick = bot_w if dirn == 1 else top_w
            close_pos = (c[i] - l[i]) if dirn == 1 else (h[i] - c[i])
            if not (small and rok and wick / bar_rng >= P["min_wick"]
                    and close_pos / bar_rng >= P["min_close_pos"]
                    and v[i] * (wick / bar_rng) >= vol_sma * P["vol_mult"]):
                continue
            for name in names:
                lv = day_levels.get(name)
                if lv is None or (d, name) in used:
                    continue
                if dirn == 1:
                    swept = l[i] < lv and c[i] > lv and (lv - l[i]) >= P["sweep_sigma"] * vp
                else:
                    swept = h[i] > lv and c[i] < lv and (h[i] - lv) >= P["sweep_sigma"] * vp
                if not swept:
                    continue
                if dirn == 1:
                    entry = l[i] + (min(o[i], c[i]) - l[i]) / 2.0
                    stop = l[i] - vp * P["stop_sigma"]
                else:
                    entry = h[i] - (h[i] - max(o[i], c[i])) / 2.0
                    stop = h[i] + vp * P["stop_sigma"]
                risk = abs(entry - stop)
                if risk <= TICK:
                    continue
                trades.append({"dir": dirn, "entry": entry, "stop": stop,
                               "risk": risk, "tp": entry + dirn * risk * P["rr"],
                               "created": i, "state": "pending", "be": False,
                               "filled_bar": -1, "level": name})
                used.add((d, name))
                last_sig[dirn] = i
                break     # one signal per bar per direction
    return closed


# ── reporting ────────────────────────────────────────────────────────────────

def stats(cl):
    n = len(cl)
    w = sum(1 for x in cl if x[3] > 0.05)
    lo = sum(1 for x in cl if x[3] < -0.05)
    s = n - w - lo
    net = sum(x[4] for x in cl)
    gw = sum(x[4] for x in cl if x[4] > 0)
    gl = -sum(x[4] for x in cl if x[4] < 0)
    pts = sum(x[5] for x in cl)
    eq = peak = dd = 0.0
    for x in cl:
        eq += x[4]
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return n, w, lo, s, net, gw / gl if gl else float("inf"), pts, dd


def fmt(label, cl, sym="MNQ"):
    n, w, lo, s, net, pf, pts, dd = stats(cl)
    wr = 100.0 * w / (w + lo) if w + lo else 0.0
    usd = pts * DOLLARS_PER_PT.get(sym, 2.0)
    print(f"{label:<26} n={n:<4} W={w:<3} L={lo:<3} BE={s:<3} WR={wr:5.1f}% "
          f"PF={pf:5.2f} netR={net:+7.1f} expR={net / n if n else 0:+6.3f} "
          f"maxDD={dd:5.1f}R pts={pts:+8.1f} (${usd:+,.0f}/ct)")


def main(mnq_dir, nq_dir, es_dir):
    print("Pre-registered config:", P, "\n")
    sets = [
        ("MNQ 5m  (60d)", os.path.join(mnq_dir, "MNQ_5m.csv"), "MNQ", 5),
        ("MNQ 15m (60d)", os.path.join(mnq_dir, "MNQ_15m.csv"), "MNQ", 15),
        ("MNQ 30m (60d)", os.path.join(mnq_dir, "MNQ_30m.csv"), "MNQ", 30),
        ("NQ  5m  (60d)", os.path.join(nq_dir, "NQ_5m.csv"), "NQ", 5),
        ("NQ  15m (60d)", os.path.join(nq_dir, "NQ_15m.csv"), "NQ", 15),
        ("ES  5m  (60d)", os.path.join(es_dir, "ES_5m.csv"), "ES", 5),
        ("MNQ 1h  (2y)", os.path.join(mnq_dir, "MNQ_1h.csv"), "MNQ", 60),
        ("NQ  1h  (2y)", os.path.join(nq_dir, "NQ_1h.csv"), "NQ", 60),
        ("ES  1h  (2y)", os.path.join(es_dir, "ES_1h.csv"), "ES", 60),
    ]
    results = {}
    for label, path, sym, bm in sets:
        cl = run(load(path), COST_PTS[sym], bm)
        results[label] = (cl, sym)
        fmt(label, cl, sym)

    print("\n── attribution, MNQ 5m ──")
    cl, sym = results["MNQ 5m  (60d)"]
    fmt("longs", [x for x in cl if x[1] == 1], sym)
    fmt("shorts", [x for x in cl if x[1] == -1], sym)
    for lvl in ("PDH", "PDL", "ONH", "ONL", "ORH", "ORL"):
        sub = [x for x in cl if x[2] == lvl]
        if sub:
            fmt(f"level {lvl}", sub, sym)

    print("\n── attribution, MNQ 1h 2y ──")
    cl, sym = results["MNQ 1h  (2y)"]
    days = sorted({x[0] for x in cl})
    if days:
        cutd = days[len(days) // 2]
        fmt("year 1", [x for x in cl if x[0] < cutd], sym)
        fmt("year 2", [x for x in cl if x[0] >= cutd], sym)
    fmt("longs", [x for x in cl if x[1] == 1], sym)
    fmt("shorts", [x for x in cl if x[1] == -1], sym)
    for lvl in ("PDH", "PDL", "ONH", "ONL", "ORH", "ORL"):
        sub = [x for x in cl if x[2] == lvl]
        if sub:
            fmt(f"level {lvl}", sub, sym)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
