#!/usr/bin/env python3
"""Complete backtest report for the SHIPPED v5 configuration.

Config under test (identical to indicators/mnq_5m_sweep_v5.pine defaults):
    instrument   MNQ (researched on Nasdaq-100 5m, 3 years)
    timeframe    5 minutes
    session      RTH 09:30-16:00 America/New_York
    signal       liquidity sweep of a 12-bar extreme, rejected in-bar
    sweep depth  0.25 EWMA sigma beyond the prior extreme
    wick         >= 35% of bar range on the rejection side
    close        >= 70% of range in the rejection direction
    range        >= 1.0x the 20-bar average range
    volume       vol * wick-share >= 0.8x the 20-bar average
    cooldown     10 bars per direction
    entry        LIMIT at the midpoint of the rejection wick
    stop         1.5 sigma beyond the swept extreme
    target       6.0 R  (Target mode: "Max expectancy")
    management   stop to breakeven at +1R
    regime gate  OFF (Version A) — see REGIME GATE CONTRIBUTION at the end
    expiry       unfilled limit cancelled after 24 bars
    cost         1.5 index points round turn, charged per trade

Reports every metric in the original mandate's backtest section, plus a
dollar equity curve for one contract.
"""
import datetime as dt
import math
import random
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, is_rth, mean, stdev, pct, et_parts   # noqa: E402
from engine import Feat                                      # noqa: E402

random.seed(20260823)
S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
     "/scratchpad")

CFG = dict(rb_lookback=12, body_thresh=0.33, min_wick=0.35, min_close_pos=0.70,
           sweep_sigma=0.25, range_exp=1.0, vol_mult=0.8, stop_sigma=1.5,
           rr=6.0, validity=24, cooldown=10, be_trigger=1.0)
COST_PTS = 1.5
POINT_VALUE = 2.0          # MNQ, $ per index point


def run_full(b, F, p, cost_pts=COST_PTS, regime_gate=True):
    """Return full trade records: dict per closed trade."""
    n, c, o, h, l, v = b.n, b.c, b.o, b.h, b.l, b.v
    rng = [h[i] - l[i] for i in range(n)]

    def sma(series, length, i):
        return None if i + 1 < length else sum(series[i - length + 1:i + 1]) / length

    live, closed = [], []
    last = {1: -10 ** 9, -1: -10 ** 9}
    nsig = nfill = nexp = 0

    for i in range(1, n):
        for tr in live:
            if tr["state"] not in ("pending", "filled") or tr["created"] >= i:
                continue
            bull = tr["dir"] == 1
            if tr["state"] == "pending":
                if (l[i] <= tr["entry"]) if bull else (h[i] >= tr["entry"]):
                    tr["state"] = "filled"
                    tr["fill_bar"] = i
                    nfill += 1
                    if (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"]):
                        tr["state"] = "done"
                        tr["exit_bar"] = i
                        tr["r"] = -1.0
                        tr["kind"] = "stop-on-fill"
                        closed.append(tr)
                elif i - tr["created"] >= p["validity"]:
                    tr["state"] = "expired"
                    nexp += 1
            else:
                stop_hit = (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"])
                tp_hit = (h[i] >= tr["tp"]) if bull else (l[i] <= tr["tp"])
                if stop_hit:
                    tr["state"] = "done"
                    tr["exit_bar"] = i
                    tr["r"] = 0.0 if tr["be"] else -1.0
                    tr["kind"] = "breakeven" if tr["be"] else "stop"
                    closed.append(tr)
                elif tp_hit:
                    tr["state"] = "done"
                    tr["exit_bar"] = i
                    tr["r"] = p["rr"]
                    tr["kind"] = "target"
                    closed.append(tr)
                elif p["be_trigger"] > 0 and not tr["be"]:
                    trig = (tr["entry"] + p["be_trigger"] * tr["risk"]) if bull \
                        else (tr["entry"] - p["be_trigger"] * tr["risk"])
                    if (h[i] >= trig) if bull else (l[i] <= trig):
                        tr["stop"] = tr["entry"]
                        tr["be"] = True

        if i < max(p["rb_lookback"], 25) or F.sigma[i] is None:
            continue
        if not is_rth(b.t[i]):
            continue
        if regime_gate:
            if F.rv[i] is None or F.rv_base[i] is None or F.rv[i] <= F.rv_base[i]:
                continue
        vs, rs = sma(v, 20, i), sma(rng, 20, i)
        if vs is None or rs is None or rng[i] <= 0:
            continue
        hh, ll = max(h[i - p["rb_lookback"]:i]), min(l[i - p["rb_lookback"]:i])
        body = abs(c[i] - o[i])
        tw = h[i] - max(c[i], o[i])
        bw = min(c[i], o[i]) - l[i]
        sg = F.sigma[i]
        small = body <= rng[i] * p["body_thresh"]
        rok = rng[i] >= rs * p["range_exp"]

        bull = (l[i] < ll and c[i] > ll and small and rok
                and bw / rng[i] >= p["min_wick"]
                and (c[i] - l[i]) / rng[i] >= p["min_close_pos"]
                and (ll - l[i]) >= p["sweep_sigma"] * sg
                and vs > 0 and v[i] * (bw / rng[i]) >= vs * p["vol_mult"]
                and i - last[1] >= p["cooldown"])
        bear = (h[i] > hh and c[i] < hh and small and rok
                and tw / rng[i] >= p["min_wick"]
                and (h[i] - c[i]) / rng[i] >= p["min_close_pos"]
                and (h[i] - hh) >= p["sweep_sigma"] * sg
                and vs > 0 and v[i] * (tw / rng[i]) >= vs * p["vol_mult"]
                and i - last[-1] >= p["cooldown"])

        for d, cond in ((1, bull), (-1, bear)):
            if not cond:
                continue
            if d == 1:
                entry = l[i] + (min(o[i], c[i]) - l[i]) / 2.0
                stop = l[i] - sg * p["stop_sigma"]
                risk = entry - stop
            else:
                entry = h[i] - (h[i] - max(o[i], c[i])) / 2.0
                stop = h[i] + sg * p["stop_sigma"]
                risk = stop - entry
            if risk <= 0:
                continue
            live.append(dict(dir=d, entry=entry, stop=stop, risk=risk,
                             tp=entry + d * risk * p["rr"], created=i,
                             state="pending", be=False, fill_bar=None,
                             exit_bar=None, r=None, kind=None))
            nsig += 1
            last[d] = i

    for tr in closed:
        tr["r_net"] = tr["r"] - cost_pts / tr["risk"]
        tr["usd"] = tr["r_net"] * tr["risk"] * POINT_VALUE
        tr["ts"] = b.t[tr["created"]]
    return closed, nsig, nfill, nexp


def block(title):
    print(f"\n{'='*84}\n{title}\n{'='*84}")


def main():
    b = load(f"{S}/mtf/USATECHIDXUSD_5m.csv")
    F = Feat(b, 78)
    tr, nsig, nfill, nexp = run_full(b, F, CFG, regime_gate=False)
    tr.sort(key=lambda x: x["created"])

    nets = [t["r_net"] for t in tr]
    grosses = [t["r"] for t in tr]
    wins = [t for t in tr if t["r_net"] > 0]
    losses = [t for t in tr if t["r_net"] < 0]
    sessions = sorted({d for d in F.sess_id if d is not None})
    years = (b.t[-1] - b.t[0]) / (365.25 * 86400)

    block("MNQ 5m LIQUIDITY SWEEP v5 — COMPLETE BACKTEST")
    d0 = dt.datetime.utcfromtimestamp(b.t[0]).date()
    d1 = dt.datetime.utcfromtimestamp(b.t[-1]).date()
    print(f"  data      Nasdaq-100 5m (Dukascopy), {d0} .. {d1}")
    print(f"            {b.n:,} bars, {len(sessions)} RTH sessions, {years:.2f} years")
    print(f"  costs     {COST_PTS} index points round turn charged on every trade")
    print(f"  target    RR {CFG['rr']:g}  (Target mode: Max expectancy)")

    block("HEADLINE")
    gw = sum(t["r_net"] for t in wins)
    gl = -sum(t["r_net"] for t in losses)
    pf = gw / gl if gl else float("inf")
    sd = stdev(nets)
    tstat = mean(nets) / (sd / math.sqrt(len(nets)))
    ms = sorted(sum(nets[random.randrange(len(nets))] for _ in range(len(nets))) / len(nets)
                for _ in range(5000))
    lo, hi = pct(ms, .025), pct(ms, .975)
    print(f"  signals generated          {nsig}")
    print(f"  limits filled              {nfill}   ({100*nfill/nsig:.1f}% fill rate)")
    print(f"  expired unfilled           {nexp}")
    print(f"  CLOSED TRADES              {len(tr)}")
    print(f"  trades per session         {len(tr)/len(sessions):.3f}   (~{len(tr)/years:.0f}/year)")
    print(f"  win rate (net of cost)     {100*len(wins)/len(tr):.1f}%")
    print(f"  expectancy per trade       {mean(nets):+.3f} R")
    print(f"  profit factor              {pf:.2f}")
    print(f"  t-statistic                {tstat:+.2f}")
    print(f"  bootstrap 95% CI           [{lo:+.3f}, {hi:+.3f}] R  "
          f"-> {'EXCLUDES ZERO' if lo > 0 else 'includes zero'}")
    print(f"  net result                 {sum(nets):+.1f} R")

    block("WIN / LOSS ANATOMY")
    kinds = defaultdict(int)
    for t in tr:
        kinds[t["kind"]] += 1
    for k in ("target", "stop", "stop-on-fill", "breakeven"):
        if kinds[k]:
            print(f"  exits by {k:<14} {kinds[k]:>4}  ({100*kinds[k]/len(tr):>4.1f}%)")
    print(f"\n  average win                {mean([t['r_net'] for t in wins]):+.3f} R")
    print(f"  average loss               {mean([t['r_net'] for t in losses]):+.3f} R")
    print(f"  largest win                {max(nets):+.3f} R")
    print(f"  largest loss               {min(nets):+.3f} R")
    print(f"  win/loss size ratio        "
          f"{abs(mean([t['r_net'] for t in wins])/mean([t['r_net'] for t in losses])):.2f}x")
    print(f"  median R                   {pct(sorted(nets), .5):+.3f} R")
    hold = [t["exit_bar"] - t["fill_bar"] for t in tr if t["fill_bar"]]
    print(f"  avg bars held (after fill) {mean(hold):.1f}  = {mean(hold)*5:.0f} minutes")
    print(f"  avg risk per trade         {mean([t['risk'] for t in tr]):.1f} index points "
          f"(${mean([t['risk'] for t in tr])*POINT_VALUE:.0f} on 1 contract)")
    print(f"  cost as share of avg R     {100*COST_PTS/mean([t['risk'] for t in tr]):.1f}%")

    block("RISK / DRAWDOWN  (equity in R, 1 unit risked per trade)")
    eq = peak = 0.0
    mdd = 0.0
    dd_start = dd_len = cur_len = 0
    curve = []
    for t in tr:
        eq += t["r_net"]
        curve.append(eq)
        if eq > peak:
            peak = eq
            cur_len = 0
        else:
            cur_len += 1
            dd_len = max(dd_len, cur_len)
        mdd = max(mdd, peak - eq)
    print(f"  max drawdown               {mdd:.1f} R")
    print(f"  net / max drawdown         {sum(nets)/mdd:.2f}")
    print(f"  longest drawdown           {dd_len} trades")
    ann = sum(nets) / years
    print(f"  return per year            {ann:+.1f} R")
    per_trade_sharpe = mean(nets) / sd
    tpy = len(tr) / years
    print(f"  Sharpe (annualised)        {per_trade_sharpe*math.sqrt(tpy):.2f}")
    dn = [x for x in nets if x < 0]
    dsd = math.sqrt(sum(x * x for x in dn) / len(nets))
    print(f"  Sortino (annualised)       {(mean(nets)/dsd)*math.sqrt(tpy):.2f}")
    streak = best = worst = 0
    for t in tr:
        if t["r_net"] > 0:
            streak = streak + 1 if streak > 0 else 1
            best = max(best, streak)
        else:
            streak = streak - 1 if streak < 0 else -1
            worst = min(worst, streak)
    print(f"  max consecutive wins       {best}")
    print(f"  max consecutive losses     {abs(worst)}")

    block("DOLLAR P&L — 1 MNQ CONTRACT, FIXED 1 CONTRACT PER TRADE")
    usd = [t["usd"] for t in tr]
    eq = peak = 0.0
    mddu = 0.0
    for u in usd:
        eq += u
        peak = max(peak, eq)
        mddu = max(mddu, peak - eq)
    print(f"  net P&L                    ${sum(usd):+,.0f}  over {years:.2f} years")
    print(f"  per year                   ${sum(usd)/years:+,.0f}")
    print(f"  max drawdown               ${mddu:,.0f}")
    print(f"  average trade              ${mean(usd):+,.0f}")
    print("  NOTE: fixed 1 contract means risk per trade VARIES with the stop")
    print("  distance. Sizing to constant risk would change these dollars.")

    block("LONG vs SHORT")
    for d, name in ((1, "LONG "), (-1, "SHORT")):
        sub = [t for t in tr if t["dir"] == d]
        if not sub:
            continue
        sn = [t["r_net"] for t in sub]
        w = sum(1 for x in sn if x > 0)
        g1 = sum(x for x in sn if x > 0)
        g2 = -sum(x for x in sn if x < 0)
        print(f"  {name}  n={len(sub):>4}  WR {100*w/len(sub):>5.1f}%  "
              f"exp {mean(sn):+.3f} R  PF {(g1/g2 if g2 else float('inf')):>5.2f}  "
              f"net {sum(sn):+7.1f} R")

    block("PER CALENDAR YEAR")
    yr = defaultdict(list)
    for t in tr:
        yr[dt.datetime.utcfromtimestamp(t["ts"]).year].append(t["r_net"])
    for y in sorted(yr):
        s = yr[y]
        w = sum(1 for x in s if x > 0)
        g1 = sum(x for x in s if x > 0)
        g2 = -sum(x for x in s if x < 0)
        print(f"  {y}   n={len(s):>4}  WR {100*w/len(s):>5.1f}%  exp {mean(s):+.3f} R  "
              f"PF {(g1/g2 if g2 else float('inf')):>5.2f}  net {sum(s):+7.1f} R")
    print(f"  -> positive in {sum(1 for v in yr.values() if mean(v) > 0)}/{len(yr)} years")

    block("BY SESSION BLOCK (ET)")
    blocks = [(570, 660, "09:30-11:00 open"), (660, 780, "11:00-13:00 midday"),
              (780, 900, "13:00-15:00 afternoon"), (900, 960, "15:00-16:00 close")]
    for lo_m, hi_m, name in blocks:
        sub = [t["r_net"] for t in tr if lo_m <= et_parts(t["ts"])[4] < hi_m]
        if len(sub) < 5:
            print(f"  {name:<22} n={len(sub):<4} (too few to read)")
            continue
        w = sum(1 for x in sub if x > 0)
        print(f"  {name:<22} n={len(sub):>4}  WR {100*w/len(sub):>5.1f}%  "
              f"exp {mean(sub):+.3f} R  net {sum(sub):+7.1f} R")
    print("  NOTE: session conditioning FAILED out-of-sample in earlier testing")
    print("  (sign flipped between panels). Shown for information, not as a filter.")

    block("COST SENSITIVITY — the assumption that matters most")
    for cp in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0):
        t2, _, _, _ = run_full(b, F, CFG, cost_pts=cp, regime_gate=False)
        s2 = [x["r_net"] for x in t2]
        g1 = sum(x for x in s2 if x > 0)
        g2 = -sum(x for x in s2 if x < 0)
        sd2 = stdev(s2)
        print(f"  round turn {cp:>4.1f} pts  ->  exp {mean(s2):+.3f} R   "
              f"PF {(g1/g2 if g2 else float('inf')):>5.2f}   "
              f"t {mean(s2)/(sd2/math.sqrt(len(s2))):+.2f}   "
              f"{'profitable' if mean(s2) > 0 else 'LOSES'}")

    block("REGIME GATE CONTRIBUTION")
    t2, _, _, _ = run_full(b, F, CFG, regime_gate=True)
    s2 = [x["r_net"] for x in t2]
    g1 = sum(x for x in s2 if x > 0)
    g2 = -sum(x for x in s2 if x < 0)
    print(f"  gate ON    n={len(s2):>4}  exp {mean(s2):+.3f} R  "
          f"PF {(g1/g2 if g2 else float('inf')):.2f}")
    print(f"  gate OFF   n={len(tr):>4}  exp {mean(nets):+.3f} R  PF {pf:.2f}   <- shipped")
    print("  The gate helped at the old 0.75 sigma sweep depth. At 0.25 it")
    print("  cuts trades, lowers expectancy and raises drawdown, so it is off.")


if __name__ == "__main__":
    main()
