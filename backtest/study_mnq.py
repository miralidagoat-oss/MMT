#!/usr/bin/env python3
"""Deep-dive on the MNQ 1h edge: session-of-day attribution, long/short
asymmetry, and breakeven-stop management. Same pessimistic fill model as
backtest.py, extended with signal timestamps, a direction filter, an
ET-session filter, and an optional move-stop-to-entry rule.

ET hours are approximated as UTC-4 (DST drift of 1h across the sample is
accepted and noted in the report)."""
import csv
import itertools
import math
import os
import sys


def load_t(path):
    t, o, h, l, c, v = [], [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            t.append(int(row["time"]))
            o.append(float(row["open"]))
            h.append(float(row["high"]))
            l.append(float(row["low"]))
            c.append(float(row["close"]))
            v.append(float(row["volume"]))
    return t, o, h, l, c, v


P = dict(rb_lookback=12, body_thresh=0.33, min_wick=0.35, min_close_pos=0.7,
         sweep_sigma=0.75, range_exp=1.0, vol_mult=0.8, lam=0.94, seed_len=20,
         stop_sigma=1.5, rr=4.0, validity=24, cooldown=10)


def et_hour(ts):
    return (ts // 3600 - 4) % 24


def run_ext(bars, rr=None, dirs=(1, -1), hours=None, be_trigger=0.0, p=None):
    p = dict(P, **(p or {}))
    if rr is not None:
        p["rr"] = rr
    t, o, h, l, c, v = bars
    n = len(c)

    logret = [0.0] + [math.log(c[i] / c[i - 1]) for i in range(1, n)]
    ewma = [None] * n
    for i in range(n):
        if (ewma[i - 1] is None) if i else True:
            if i >= p["seed_len"] - 1:
                win = logret[i - p["seed_len"] + 1: i + 1]
                m = sum(win) / p["seed_len"]
                ewma[i] = sum((x - m) ** 2 for x in win) / p["seed_len"]
        else:
            ewma[i] = p["lam"] * ewma[i - 1] + (1 - p["lam"]) * logret[i] ** 2

    rng = [h[i] - l[i] for i in range(n)]
    trades = []
    last = {1: -10**9, -1: -10**9}
    closed = []  # (dir, hour, r)

    for i in range(1, n):
        for tr in trades:
            if tr["state"] not in ("pending", "filled") or tr["created"] >= i:
                continue
            bull = tr["dir"] == 1
            if tr["state"] == "pending":
                if (l[i] <= tr["entry"]) if bull else (h[i] >= tr["entry"]):
                    tr["state"] = "filled"
                    if (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"]):
                        tr["state"] = "done"
                        closed.append((tr["dir"], tr["hour"], -1.0))
                elif i - tr["created"] >= p["validity"]:
                    tr["state"] = "done"
            else:
                stop_hit = (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"])
                tp_hit = (h[i] >= tr["tp"]) if bull else (l[i] <= tr["tp"])
                if stop_hit:
                    r = 0.0 if tr["be"] else -1.0
                    tr["state"] = "done"
                    closed.append((tr["dir"], tr["hour"], r))
                elif tp_hit:
                    tr["state"] = "done"
                    closed.append((tr["dir"], tr["hour"], p["rr"]))
                elif be_trigger > 0 and not tr["be"]:
                    trig = (tr["entry"] + be_trigger * tr["risk"]) if bull else (tr["entry"] - be_trigger * tr["risk"])
                    if (h[i] >= trig) if bull else (l[i] <= trig):
                        tr["stop"] = tr["entry"]
                        tr["be"] = True

        if i < p["rb_lookback"] or ewma[i] is None or i < 20:
            continue
        vol_sma = sum(v[i - 19: i + 1]) / 20
        rng_sma = sum(rng[i - 19: i + 1]) / 20
        prev_hh = max(h[i - p["rb_lookback"]: i])
        prev_ll = min(l[i - p["rb_lookback"]: i])
        bar_rng = rng[i]
        if bar_rng <= 0:
            continue
        body = abs(c[i] - o[i])
        top_w = h[i] - max(c[i], o[i])
        bot_w = min(c[i], o[i]) - l[i]
        vp = math.sqrt(max(ewma[i], 0.0)) * c[i]
        small = body <= bar_rng * p["body_thresh"]
        rok = bar_rng >= rng_sma * p["range_exp"]
        hr = et_hour(t[i])
        h_ok = hours is None or hr in hours

        for d, wick, close_pos, sweep in (
                (1, bot_w, c[i] - l[i], prev_ll - l[i]),
                (-1, top_w, h[i] - c[i], h[i] - prev_hh)):
            if d not in dirs or not h_ok:
                continue
            sweep_cond = (l[i] < prev_ll and c[i] > prev_ll) if d == 1 else (h[i] > prev_hh and c[i] < prev_hh)
            if not (sweep_cond and small and rok
                    and wick / bar_rng >= p["min_wick"]
                    and close_pos / bar_rng >= p["min_close_pos"]
                    and sweep >= p["sweep_sigma"] * vp
                    and v[i] * (wick / bar_rng) >= vol_sma * p["vol_mult"]
                    and i - last[d] >= p["cooldown"]):
                continue
            if d == 1:
                entry = l[i] + (min(o[i], c[i]) - l[i]) / 2.0
                stop = l[i] - vp * p["stop_sigma"]
            else:
                entry = h[i] - (h[i] - max(o[i], c[i])) / 2.0
                stop = h[i] + vp * p["stop_sigma"]
            risk = abs(entry - stop)
            if risk <= 0:
                continue
            trades.append({"dir": d, "entry": entry, "stop": stop, "risk": risk,
                           "tp": entry + d * risk * p["rr"], "created": i,
                           "state": "pending", "hour": hr, "be": False})
            last[d] = i
    return closed


def stats(closed, rr):
    w = sum(1 for *_, r in closed if r > 0)
    losses = sum(1 for *_, r in closed if r < 0)
    sc = sum(1 for *_, r in closed if r == 0)
    net = sum(r for *_, r in closed)
    gw = sum(r for *_, r in closed if r > 0)
    gl = -sum(r for *_, r in closed if r < 0)
    pf = gw / gl if gl else float("inf")
    n = len(closed)
    return w, losses, sc, net, pf, (net / n if n else 0), n


def fmt(label, closed, rr):
    w, losses, sc, net, pf, exp, n = stats(closed, rr)
    d = w + losses
    wr = 100 * w / d if d else 0
    print(f"{label:<28} n={n:<4} W={w:<3} L={losses:<3} BE={sc:<3} "
          f"WR={wr:5.1f}% PF={pf:5.2f} netR={net:+7.1f} expR={exp:+6.3f}")


def main(mnq_dir, nq_dir):
    mnq = load_t(os.path.join(mnq_dir, "MNQ_1h.csv"))
    nq = load_t(os.path.join(nq_dir, "NQ_1h.csv"))

    print("═══ A. baseline (tuned MNQ params, 1h, 2y) ═══")
    base = run_ext(mnq)
    fmt("MNQ all", base, 4)
    fmt("NQ  all", run_ext(nq), 4)

    print("\n═══ B. direction split ═══")
    fmt("MNQ longs only", [x for x in base if x[0] == 1], 4)
    fmt("MNQ shorts only", [x for x in base if x[0] == -1], 4)
    nqb = run_ext(nq)
    fmt("NQ  longs only", [x for x in nqb if x[0] == 1], 4)
    fmt("NQ  shorts only", [x for x in nqb if x[0] == -1], 4)

    print("\n═══ C. R by ET signal-hour bucket (MNQ+NQ pooled) ═══")
    pool = base + nqb
    buckets = {"00-06 overnight": range(0, 6), "06-09 premkt": range(6, 9),
               "09-12 open": range(9, 12), "12-16 pm/close": range(12, 16),
               "16-24 globex eve": range(16, 24)}
    for name, hrs in buckets.items():
        fmt(name, [x for x in pool if x[1] in hrs], 4)

    print("\n═══ D. breakeven-stop grid (MNQ, all hours) ═══")
    for rr in (3.0, 4.0):
        for bet in (0.0, 1.0, 1.5, 2.0):
            fmt(f"rr={rr} beTrig={bet}", run_ext(mnq, rr=rr, be_trigger=bet), rr)

    print("\n═══ E. candidate combos, MNQ walk-forward (60/40) + NQ ═══")
    n = len(mnq[0])
    cut = int(n * 0.6)
    mnq_is = tuple(s[:cut] for s in mnq)
    mnq_oos = tuple(s[cut:] for s in mnq)
    rth = set(range(9, 16))
    combos = [
        ("all hrs, no BE", dict()),
        ("RTH 09-16", dict(hours=rth)),
        ("BE@1.5R", dict(be_trigger=1.5)),
        ("RTH + BE@1.5R", dict(hours=rth, be_trigger=1.5)),
        ("RTH + BE@1R", dict(hours=rth, be_trigger=1.0)),
    ]
    for name, kw in combos:
        print(f"── {name}")
        fmt("  MNQ in-sample", run_ext(mnq_is, **kw), 4)
        fmt("  MNQ out-of-sample", run_ext(mnq_oos, **kw), 4)
        fmt("  NQ  full", run_ext(nq, **kw), 4)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
