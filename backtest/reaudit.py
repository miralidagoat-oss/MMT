#!/usr/bin/env python3
"""Adversarial re-audit of the shipped v3.2 sweep/rejection system.

What this checks that the original study did not:

 1. COSTS. The original reported everything in R units with zero fees,
    slippage or spread. At 5m the stop distance is small in index points, so
    cost as a FRACTION OF R is the number that decides viability. This script
    reports it directly and books every trade net of cost.

 2. DST. The original `et_hour()` used a fixed UTC-4 offset, so its "RTH"
    window was shifted by one hour for roughly 40% of the calendar. This uses
    a proper US-Eastern conversion.

 3. SAMPLE. The original 5m verdict rested on 60 days / 75 trades. This runs
    the identical rules over ~3 years of independent data.

 4. SELECTION. The MNQ preset (sweep 0.75s, stop 1.5s, vol 0.8x, range 1.0x)
    was chosen after looking at MNQ. Re-running those exact frozen values on
    data they were never fitted to is the only honest test of them.

Usage: python3 reaudit.py <csv> <label> [timeframe_minutes]
"""
import math
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import (load, is_rth, mean, stdev, pct,        # noqa: E402
                   MNQ_POINT_VALUE, RTH_OPEN, RTH_CLOSE)

# frozen v3.2 "Index Futures (MNQ/NQ)" preset
PRESET = dict(rb_lookback=12, body_thresh=0.33, min_wick=0.35,
              min_close_pos=0.7, sweep_sigma=0.75, range_exp=1.0,
              vol_mult=0.8, lam=0.94, seed_len=20, stop_sigma=1.5,
              rr=4.0, validity=24, cooldown=10)


def run(b, p, rth_only=True, be_trigger=1.0, cost_pts=1.5):
    n = b.n
    c, o, h, l, v = b.c, b.o, b.h, b.l, b.v

    logret = [0.0] + [math.log(c[i] / c[i - 1]) if c[i - 1] > 0 else 0.0
                      for i in range(1, n)]
    ewma = [None] * n
    for i in range(n):
        if (ewma[i - 1] is None) if i else True:
            if i >= p["seed_len"] - 1:
                w = logret[i - p["seed_len"] + 1: i + 1]
                m = sum(w) / p["seed_len"]
                ewma[i] = sum((x - m) ** 2 for x in w) / p["seed_len"]
        else:
            ewma[i] = p["lam"] * ewma[i - 1] + (1 - p["lam"]) * logret[i] ** 2

    rng = [h[i] - l[i] for i in range(n)]

    def sma(series, length, i):
        return None if i + 1 < length else sum(series[i - length + 1:i + 1]) / length

    trades, closed, risks = [], [], []
    last = {1: -10 ** 9, -1: -10 ** 9}
    n_signals = n_fills = n_expired = 0

    for i in range(1, n):
        for tr in trades:
            if tr["state"] not in ("pending", "filled") or tr["created"] >= i:
                continue
            bull = tr["dir"] == 1
            if tr["state"] == "pending":
                if (l[i] <= tr["entry"]) if bull else (h[i] >= tr["entry"]):
                    tr["state"] = "filled"
                    n_fills += 1
                    if (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"]):
                        tr["state"] = "done"
                        closed.append((-1.0, tr["risk"], tr["created"]))
                elif i - tr["created"] >= p["validity"]:
                    tr["state"] = "done"
                    n_expired += 1
            else:
                stop_hit = (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"])
                tp_hit = (h[i] >= tr["tp"]) if bull else (l[i] <= tr["tp"])
                if stop_hit:
                    closed.append((0.0 if tr["be"] else -1.0, tr["risk"], tr["created"]))
                    tr["state"] = "done"
                elif tp_hit:
                    closed.append((p["rr"], tr["risk"], tr["created"]))
                    tr["state"] = "done"
                elif be_trigger > 0 and not tr["be"]:
                    trig = (tr["entry"] + be_trigger * tr["risk"]) if bull \
                        else (tr["entry"] - be_trigger * tr["risk"])
                    if (h[i] >= trig) if bull else (l[i] <= trig):
                        tr["stop"] = tr["entry"]
                        tr["be"] = True

        if i < max(p["rb_lookback"], 20) or ewma[i] is None:
            continue
        if rth_only and not is_rth(b.t[i]):
            continue
        vol_sma = sma(v, 20, i)
        rng_sma = sma(rng, 20, i)
        if vol_sma is None or rng_sma is None or rng[i] <= 0:
            continue

        prev_hh = max(h[i - p["rb_lookback"]:i])
        prev_ll = min(l[i - p["rb_lookback"]:i])
        body = abs(c[i] - o[i])
        top_w = h[i] - max(c[i], o[i])
        bot_w = min(c[i], o[i]) - l[i]
        volp = math.sqrt(max(ewma[i], 0.0)) * c[i]
        small = body <= rng[i] * p["body_thresh"]
        rok = rng[i] >= rng_sma * p["range_exp"]
        # Dukascopy index volume is a broker liquidity proxy, not CME volume;
        # the gate is kept identical in FORM so the rule set is unchanged.
        vgate_ok = vol_sma > 0

        bull = (l[i] < prev_ll and c[i] > prev_ll and small and rok
                and bot_w / rng[i] >= p["min_wick"]
                and (c[i] - l[i]) / rng[i] >= p["min_close_pos"]
                and (prev_ll - l[i]) >= p["sweep_sigma"] * volp
                and vgate_ok and v[i] * (bot_w / rng[i]) >= vol_sma * p["vol_mult"]
                and i - last[1] >= p["cooldown"])
        bear = (h[i] > prev_hh and c[i] < prev_hh and small and rok
                and top_w / rng[i] >= p["min_wick"]
                and (h[i] - c[i]) / rng[i] >= p["min_close_pos"]
                and (h[i] - prev_hh) >= p["sweep_sigma"] * volp
                and vgate_ok and v[i] * (top_w / rng[i]) >= vol_sma * p["vol_mult"]
                and i - last[-1] >= p["cooldown"])

        for d, cond in ((1, bull), (-1, bear)):
            if not cond:
                continue
            if d == 1:
                entry = l[i] + (min(o[i], c[i]) - l[i]) / 2.0
                stop = l[i] - volp * p["stop_sigma"]
                risk = entry - stop
                tp = entry + risk * p["rr"]
            else:
                entry = h[i] - (h[i] - max(o[i], c[i])) / 2.0
                stop = h[i] + volp * p["stop_sigma"]
                risk = stop - entry
                tp = entry - risk * p["rr"]
            if risk <= 0:
                continue
            trades.append(dict(dir=d, entry=entry, stop=stop, tp=tp, risk=risk,
                               created=i, state="pending", be=False))
            risks.append(risk)
            n_signals += 1
            last[d] = i

    return closed, risks, n_signals, n_fills, n_expired


def summarise(label, closed, risks, nsig, nfill, nexp, cost_pts=1.5):
    if not closed:
        print(f"{label:<34} no closed trades")
        return
    rs = [r for r, _, _ in closed]
    # cost in R units differs per trade because R (stop distance) varies
    net_rs = [r - cost_pts / risk for r, risk, _ in closed]
    wins = sum(1 for r in rs if r > 0)
    losses = sum(1 for r in rs if r < 0)
    scr = sum(1 for r in rs if r == 0)
    gw = sum(r for r in rs if r > 0)
    gl = -sum(r for r in rs if r < 0)
    pf = gw / gl if gl else float("inf")
    ngw = sum(r for r in net_rs if r > 0)
    ngl = -sum(r for r in net_rs if r < 0)
    npf = ngw / ngl if ngl else float("inf")
    mR = mean(risks)
    cost_frac = 100.0 * cost_pts / mR
    print(f"{label:<34}{len(closed):>6}{wins:>5}{losses:>5}{scr:>5}"
          f"{100*wins/max(wins+losses,1):>7.1f}{pf:>7.2f}{sum(rs):>8.1f}"
          f"{npf:>7.2f}{sum(net_rs):>9.1f}{mR:>8.1f}{cost_frac:>7.1f}%")


def main():
    path, label = sys.argv[1], sys.argv[2]
    b = load(path)
    print(f"\n### {label}   ({b.n} bars)")
    hdr = (f"{'config':<34}{'n':>6}{'W':>5}{'L':>5}{'BE':>5}{'WR%':>7}"
           f"{'PF':>7}{'netR':>8}{'PF_c':>7}{'netR_c':>9}{'meanR':>8}{'cost/R':>8}")
    print(hdr)
    print("-" * len(hdr))
    for rth in (True, False):
        for be in (1.0, 0.0):
            tag = f"{'RTH' if rth else '24h'}, BE@{be:g}R" if be else \
                  f"{'RTH' if rth else '24h'}, no BE"
            closed, risks, s, f, e = run(b, PRESET, rth_only=rth, be_trigger=be)
            summarise(tag, closed, risks, s, f, e)
    print("\n  netR   = R booked with ZERO costs (the original study's metric)")
    print("  netR_c = same trades charged 1.5 index points round turn")
    print("  cost/R = 1.5 pts as a percentage of the average stop distance")


if __name__ == "__main__":
    main()
