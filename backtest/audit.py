#!/usr/bin/env python3
"""ADVERSARIAL AUDIT of the MNQ 1H sweep-rejection edge.

The prior studies asked "does this configuration make money on the sample?"
This one asks the question that actually matters before risking capital:
"how much of that result could be luck, and what breaks it?"

Every test here is designed to KILL the strategy. What survives is real.

  1. DST correctness      - prior studies approximated ET as fixed UTC-4.
                            Re-run with true America/New_York.
  2. Bootstrap CI         - resample the trade sequence 20,000x. Where does
                            the 95% confidence interval on PF actually sit?
  3. Monte Carlo ruin     - shuffle trade order 20,000x on a $25k account.
                            Drawdown distribution and P(ruin).
  4. Parameter sensitivity- perturb each parameter one at a time. A real edge
                            sits on a plateau; an overfit sits on a spike.
  5. Cost sensitivity     - 1x / 1.5x / 2x / 3x round-trip costs.
  6. Fill realism         - require price to TRADE THROUGH the limit, not
                            merely touch it. Touching != filling.
  7. Regime stability     - quarterly P&L. Is it one lucky quarter?
  8. Null / shuffle test  - keep the trade count, randomize the entry bars.
                            If random entries score the same, there is no edge.
  9. Signal decay         - first half vs second half of the OOS window.

Usage: python3 audit.py <mnq_dir> <nq_dir> <es_dir>
"""
import csv
import datetime
import math
import os
import random
import statistics
import sys
import zoneinfo

ET = zoneinfo.ZoneInfo("America/New_York")
TICK = 0.25
COST_PTS = {"MNQ": 1.5, "NQ": 0.75, "ES": 0.6}
DOLLARS_PER_PT = {"MNQ": 2.0, "NQ": 20.0, "ES": 50.0}

BASE = dict(rb_lookback=12, body_thresh=0.33, min_wick=0.35, min_close_pos=0.7,
            sweep_sigma=0.75, range_exp=1.0, vol_mult=0.8, lam=0.94,
            seed_len=20, stop_sigma=1.5, rr=4.0, validity=24, cooldown=10,
            be_trigger=1.0)

random.seed(20260811)


def load(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append((int(r["time"]), float(r["open"]), float(r["high"]),
                         float(r["low"]), float(r["close"]), float(r["volume"])))
    return rows


# ── core engine ──────────────────────────────────────────────────────────────

def run(rows, p=None, cost_pts=1.5, rth=True, tz_mode="true",
        fill_through=False, force_bars=None):
    """Returns closed trades: (bar_idx, ts, dir, r_gross, r_net, risk_pts).

    tz_mode: 'true'  -> America/New_York with DST
             'utc-4' -> the old fixed-offset approximation
    fill_through: require price to exceed the limit by one tick to fill.
    force_bars: set of bar indices to signal on instead of the real detector
                (used by the null test).
    """
    p = dict(BASE, **(p or {}))
    n = len(rows)
    t = [r[0] for r in rows]
    o = [r[1] for r in rows]
    h = [r[2] for r in rows]
    l = [r[3] for r in rows]
    c = [r[4] for r in rows]
    v = [r[5] for r in rows]

    logret = [0.0] + [math.log(c[i] / c[i - 1]) for i in range(1, n)]
    ewma = [None] * n
    for i in range(n):
        prev = ewma[i - 1] if i else None
        if prev is None:
            if i >= p["seed_len"] - 1:
                win = logret[i - p["seed_len"] + 1: i + 1]
                m = sum(win) / p["seed_len"]
                ewma[i] = sum((x - m) ** 2 for x in win) / p["seed_len"]
        else:
            ewma[i] = p["lam"] * prev + (1 - p["lam"]) * logret[i] ** 2

    if tz_mode == "true":
        hours = [datetime.datetime.fromtimestamp(x, ET).hour for x in t]
        mins = [datetime.datetime.fromtimestamp(x, ET).minute for x in t]
        in_rth = [(hh * 60 + mm) >= 570 and (hh * 60 + mm) < 960
                  for hh, mm in zip(hours, mins)]
    else:
        hours = [(x // 3600 - 4) % 24 for x in t]
        in_rth = [9 <= hh < 16 for hh in hours]

    rng = [h[i] - l[i] for i in range(n)]
    trades = []
    closed = []
    last = {1: -10 ** 9, -1: -10 ** 9}

    def book(tr, r_gross):
        r_net = r_gross - cost_pts / tr["risk"]
        closed.append((tr["created"], t[tr["created"]], tr["dir"],
                       r_gross, r_net, tr["risk"]))

    for i in range(1, n):
        # ── manage live setups ──
        for tr in trades:
            if tr["state"] not in ("pending", "filled") or tr["created"] >= i:
                continue
            bull = tr["dir"] == 1
            if tr["state"] == "pending":
                if fill_through:
                    hit = (l[i] < tr["entry"] - TICK) if bull else (h[i] > tr["entry"] + TICK)
                else:
                    hit = (l[i] <= tr["entry"]) if bull else (h[i] >= tr["entry"])
                if hit:
                    tr["state"] = "filled"
                    tr["filled_bar"] = i
                    if (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"]):
                        tr["state"] = "done"
                        book(tr, -1.0)
                elif i - tr["created"] >= p["validity"]:
                    tr["state"] = "expired"
            else:
                stop_hit = (l[i] <= tr["stop"]) if bull else (h[i] >= tr["stop"])
                tp_hit = (i > tr["filled_bar"]
                          and ((h[i] >= tr["tp"]) if bull else (l[i] <= tr["tp"])))
                if stop_hit:
                    tr["state"] = "done"
                    book(tr, 0.0 if tr["be"] else -1.0)
                elif tp_hit:
                    tr["state"] = "done"
                    book(tr, p["rr"])
                elif p["be_trigger"] > 0 and not tr["be"]:
                    trig = tr["entry"] + tr["dir"] * p["be_trigger"] * tr["risk"]
                    if (h[i] >= trig) if bull else (l[i] <= trig):
                        tr["stop"] = tr["entry"]
                        tr["be"] = True

        # ── signal ──
        if ewma[i] is None or i < max(20, p["rb_lookback"]):
            continue
        if rth and not in_rth[i]:
            continue
        bar_rng = rng[i]
        if bar_rng <= 0:
            continue

        if force_bars is not None:
            if i not in force_bars:
                continue
            vp = math.sqrt(max(ewma[i], 0.0)) * c[i]
            d = 1 if (i % 2 == 0) else -1
            if d == 1:
                entry = l[i] + (min(o[i], c[i]) - l[i]) / 2.0
                stop = l[i] - vp * p["stop_sigma"]
            else:
                entry = h[i] - (h[i] - max(o[i], c[i])) / 2.0
                stop = h[i] + vp * p["stop_sigma"]
            risk = abs(entry - stop)
            if risk <= TICK:
                continue
            trades.append({"dir": d, "entry": entry, "stop": stop, "risk": risk,
                           "tp": entry + d * risk * p["rr"], "created": i,
                           "state": "pending", "be": False, "filled_bar": -1})
            continue

        vol_sma = sum(v[i - 19: i + 1]) / 20
        rng_sma = sum(rng[i - 19: i + 1]) / 20
        prev_hh = max(h[i - p["rb_lookback"]: i])
        prev_ll = min(l[i - p["rb_lookback"]: i])
        body = abs(c[i] - o[i])
        top_w = h[i] - max(c[i], o[i])
        bot_w = min(c[i], o[i]) - l[i]
        vp = math.sqrt(max(ewma[i], 0.0)) * c[i]
        small = body <= bar_rng * p["body_thresh"]
        rok = bar_rng >= rng_sma * p["range_exp"]

        for d, wick, close_pos, sweep in (
                (1, bot_w, c[i] - l[i], prev_ll - l[i]),
                (-1, top_w, h[i] - c[i], h[i] - prev_hh)):
            sweep_cond = ((l[i] < prev_ll and c[i] > prev_ll) if d == 1
                          else (h[i] > prev_hh and c[i] < prev_hh))
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
            if risk <= TICK:
                continue
            trades.append({"dir": d, "entry": entry, "stop": stop, "risk": risk,
                           "tp": entry + d * risk * p["rr"], "created": i,
                           "state": "pending", "be": False, "filled_bar": -1})
            last[d] = i
            break
    return closed


# ── metrics ──────────────────────────────────────────────────────────────────

def pf_of(rs):
    gw = sum(r for r in rs if r > 0)
    gl = -sum(r for r in rs if r < 0)
    return gw / gl if gl > 0 else float("inf")


def summarize(cl, idx=4):
    rs = [x[idx] for x in cl]
    n = len(rs)
    if n == 0:
        return dict(n=0, wr=0, pf=0, net=0, exp=0, dd=0)
    w = sum(1 for r in rs if r > 0.05)
    lo = sum(1 for r in rs if r < -0.05)
    eq = peak = dd = 0.0
    for r in rs:
        eq += r
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return dict(n=n, wr=100 * w / (w + lo) if w + lo else 0, pf=pf_of(rs),
                net=sum(rs), exp=sum(rs) / n, dd=dd, w=w, l=lo, be=n - w - lo)


def line(label, cl, idx=4):
    s = summarize(cl, idx)
    pf = s["pf"]
    pfs = "  inf" if pf == float("inf") else f"{pf:5.2f}"
    print(f"{label:<34} n={s['n']:<4} WR={s['wr']:5.1f}% PF={pfs} "
          f"netR={s['net']:+7.1f} expR={s['exp']:+6.3f} maxDD={s['dd']:5.1f}R")


def hr():
    print("─" * 100)


# ── tests ────────────────────────────────────────────────────────────────────

def test_dst(mnq, nq):
    print("\n" + "=" * 100)
    print("TEST 1 — DST CORRECTNESS  (prior studies hard-coded ET = UTC-4)")
    print("=" * 100)
    for name, rows, cost in (("MNQ", mnq, 1.5), ("NQ", nq, 0.75)):
        a = run(rows, cost_pts=cost, tz_mode="utc-4")
        b = run(rows, cost_pts=cost, tz_mode="true")
        line(f"{name} old fixed UTC-4 approx", a)
        line(f"{name} TRUE America/New_York", b)
        sa, sb = summarize(a), summarize(b)
        drift = sb["net"] - sa["net"]
        print(f"   -> trade-count delta {sb['n'] - sa['n']:+d}, netR delta {drift:+.1f}R")
    hr()


def test_bootstrap(cl, label, iters=20000):
    print("\n" + "=" * 100)
    print(f"TEST 2 — BOOTSTRAP CONFIDENCE INTERVAL  ({label}, {iters:,} resamples)")
    print("=" * 100)
    rs = [x[4] for x in cl]
    n = len(rs)
    if n < 5:
        print("   insufficient trades")
        return
    pfs, nets, wrs = [], [], []
    for _ in range(iters):
        samp = [rs[random.randrange(n)] for _ in range(n)]
        p = pf_of(samp)
        if p != float("inf"):
            pfs.append(p)
        nets.append(sum(samp))
        w = sum(1 for r in samp if r > 0.05)
        lo = sum(1 for r in samp if r < -0.05)
        wrs.append(100 * w / (w + lo) if w + lo else 0)
    pfs.sort(); nets.sort(); wrs.sort()

    def q(a, x):
        return a[min(len(a) - 1, int(len(a) * x))]

    print(f"   point estimate           PF={pf_of(rs):.2f}  netR={sum(rs):+.1f}  n={n}")
    print(f"   PF    95% CI   [{q(pfs,0.025):5.2f} , {q(pfs,0.975):5.2f}]   median {q(pfs,0.5):.2f}")
    print(f"   netR  95% CI   [{q(nets,0.025):+6.1f} , {q(nets,0.975):+6.1f}]   median {q(nets,0.5):+.1f}")
    print(f"   WR%   95% CI   [{q(wrs,0.025):5.1f} , {q(wrs,0.975):5.1f}]")
    p_lose = 100.0 * sum(1 for x in nets if x <= 0) / len(nets)
    p_pf1 = 100.0 * sum(1 for x in pfs if x < 1.0) / len(pfs)
    print(f"\n   P(this edge is actually flat-or-negative) = {p_lose:.1f}%")
    print(f"   P(true PF < 1.0)                          = {p_pf1:.1f}%")
    hr()
    return p_lose


def test_montecarlo(cl, acct=25000.0, iters=20000):
    print("\n" + "=" * 100)
    print(f"TEST 3 — MONTE CARLO PATH RISK  (${acct:,.0f}, 1 MNQ contract, {iters:,} shuffles)")
    print("=" * 100)
    dollars = [x[4] * x[5] * DOLLARS_PER_PT["MNQ"] for x in cl]
    n = len(dollars)
    if n < 5:
        print("   insufficient trades")
        return
    print(f"   per-trade $ : mean {statistics.mean(dollars):+.0f}  "
          f"median {statistics.median(dollars):+.0f}  "
          f"min {min(dollars):+.0f}  max {max(dollars):+.0f}")
    dds, ends, ruins, worst_streak = [], [], 0, []
    for _ in range(iters):
        seq = dollars[:]
        random.shuffle(seq)
        eq = acct
        peak = acct
        dd = 0.0
        streak = cur = 0
        ruined = False
        for d in seq:
            eq += d
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
            cur = cur + 1 if d < 0 else 0
            streak = max(streak, cur)
            if eq <= acct * 0.5:
                ruined = True
        dds.append(dd)
        ends.append(eq)
        worst_streak.append(streak)
        if ruined:
            ruins += 1
    dds.sort(); ends.sort()

    def q(a, x):
        return a[min(len(a) - 1, int(len(a) * x))]

    print(f"\n   max drawdown over one 2-year run of {n} trades:")
    print(f"      median  ${q(dds,0.50):>7,.0f}   ({100*q(dds,0.50)/acct:4.1f}% of account)")
    print(f"      p90     ${q(dds,0.90):>7,.0f}   ({100*q(dds,0.90)/acct:4.1f}%)")
    print(f"      p99     ${q(dds,0.99):>7,.0f}   ({100*q(dds,0.99)/acct:4.1f}%)")
    print(f"      worst   ${max(dds):>7,.0f}   ({100*max(dds)/acct:4.1f}%)")
    print(f"\n   ending equity after the full {n}-trade run:")
    print(f"      p05     ${q(ends,0.05):>8,.0f}")
    print(f"      median  ${q(ends,0.50):>8,.0f}")
    print(f"      p95     ${q(ends,0.95):>8,.0f}")
    print(f"      P(account below start) = {100.0*sum(1 for e in ends if e < acct)/len(ends):.1f}%")
    print(f"      P(50% drawdown / ruin) = {100.0*ruins/iters:.2f}%")
    print(f"   worst losing streak: median {statistics.median(worst_streak):.0f}, "
          f"max {max(worst_streak)}")
    hr()


def test_sensitivity(mnq):
    print("\n" + "=" * 100)
    print("TEST 4 — PARAMETER SENSITIVITY  (edge should sit on a PLATEAU, not a spike)")
    print("=" * 100)
    base = summarize(run(mnq))
    print(f"   baseline: PF {base['pf']:.2f}  netR {base['net']:+.1f}  n {base['n']}\n")
    grid = {
        "rb_lookback": [8, 10, 12, 14, 16, 20],
        "body_thresh": [0.25, 0.30, 0.33, 0.38, 0.45],
        "min_wick": [0.25, 0.30, 0.35, 0.40, 0.45],
        "min_close_pos": [0.60, 0.65, 0.70, 0.75, 0.80],
        "sweep_sigma": [0.25, 0.50, 0.75, 1.00, 1.25],
        "range_exp": [0.6, 0.8, 1.0, 1.2, 1.4],
        "stop_sigma": [1.0, 1.25, 1.5, 1.75, 2.0],
        "rr": [2.0, 3.0, 4.0, 5.0, 6.0],
        "cooldown": [0, 5, 10, 15, 20],
        "be_trigger": [0.0, 0.5, 1.0, 1.5, 2.0],
    }
    fragile = []
    for k, vals in grid.items():
        cells = []
        for val in vals:
            s = summarize(run(mnq, {k: val}))
            cells.append((val, s))
        txt = "  ".join(
            f"{v}:{'PF' if False else ''}{s['pf']:.2f}({s['n']})" for v, s in cells)
        pos = sum(1 for _, s in cells if s["pf"] > 1.0 and s["n"] >= 15)
        flag = "" if pos >= len(cells) - 1 else "   <-- FRAGILE"
        if flag:
            fragile.append(k)
        print(f"   {k:<16} {txt}{flag}")
    print(f"\n   parameters whose neighbours break the edge: "
          f"{', '.join(fragile) if fragile else 'NONE — plateau confirmed'}")
    hr()
    return fragile


def test_costs(mnq):
    print("\n" + "=" * 100)
    print("TEST 5 — COST SENSITIVITY  (how bad can your fills get before the edge dies?)")
    print("=" * 100)
    for mult in (0.0, 1.0, 1.5, 2.0, 3.0, 4.0):
        cl = run(mnq, cost_pts=COST_PTS["MNQ"] * mult)
        lab = f"{mult:.1f}x round trip ({COST_PTS['MNQ']*mult:.2f} pts)"
        line(lab, cl)
    print("\n   1.0x = $3.00/RT on MNQ. 2x is a realistic bad-broker / bad-fill day.")
    hr()


def test_fill_realism(mnq):
    print("\n" + "=" * 100)
    print("TEST 6 — FILL REALISM  (touching a limit is NOT the same as being filled)")
    print("=" * 100)
    line("optimistic: touch = fill", run(mnq))
    line("realistic: must trade through", run(mnq, fill_through=True))
    a = summarize(run(mnq))
    b = summarize(run(mnq, fill_through=True))
    print(f"\n   trades lost to non-fills: {a['n'] - b['n']}   "
          f"netR impact {b['net'] - a['net']:+.1f}R")
    hr()


def test_regime(mnq):
    print("\n" + "=" * 100)
    print("TEST 7 — REGIME STABILITY  (is it one lucky quarter?)")
    print("=" * 100)
    cl = run(mnq)
    buckets = {}
    for x in cl:
        d = datetime.datetime.fromtimestamp(x[1], ET)
        key = f"{d.year}-Q{(d.month - 1)//3 + 1}"
        buckets.setdefault(key, []).append(x)
    tot = summarize(cl)["net"]
    best = None
    for k in sorted(buckets):
        s = summarize(buckets[k])
        line(f"   {k}", buckets[k])
        if best is None or s["net"] > best[1]:
            best = (k, s["net"])
    print(f"\n   total netR {tot:+.1f}. Best quarter {best[0]} contributed "
          f"{best[1]:+.1f}R = {100*best[1]/tot if tot else 0:.0f}% of ALL profit.")
    pos = sum(1 for k in buckets if summarize(buckets[k])["net"] > 0)
    print(f"   profitable quarters: {pos}/{len(buckets)}")
    hr()
    return best, tot, pos, len(buckets)


def test_null(mnq, real_cl, iters=400):
    print("\n" + "=" * 100)
    print(f"TEST 8 — NULL HYPOTHESIS  (same trade count, RANDOM entry bars, {iters} runs)")
    print("=" * 100)
    n_real = len(real_cl)
    real_net = summarize(real_cl)["net"]
    real_pf = summarize(real_cl)["pf"]
    n = len(mnq)
    # candidate bars: RTH only, engine warm
    cand = []
    for i in range(40, n):
        d = datetime.datetime.fromtimestamp(mnq[i][0], ET)
        m = d.hour * 60 + d.minute
        if 570 <= m < 960:
            cand.append(i)
    nets, pfs = [], []
    for _ in range(iters):
        picks = set(random.sample(cand, min(n_real, len(cand))))
        cl = run(mnq, force_bars=picks)
        s = summarize(cl)
        if s["n"]:
            nets.append(s["net"])
            pfs.append(s["pf"] if s["pf"] != float("inf") else 10.0)
    nets.sort()
    mean_net = statistics.mean(nets)
    beat = sum(1 for x in nets if x >= real_net)
    pval = (beat + 1) / (len(nets) + 1)
    print(f"   real signal      netR {real_net:+.1f}   PF {real_pf:.2f}")
    print(f"   random entries   netR mean {mean_net:+.1f}  "
          f"median {statistics.median(nets):+.1f}  "
          f"p95 {nets[int(len(nets)*0.95)]:+.1f}  max {max(nets):+.1f}")
    print(f"   random PF mean   {statistics.mean(pfs):.2f}")
    print(f"\n   empirical p-value (random >= real) = {pval:.3f}")
    if pval < 0.05:
        print("   -> signal beats random entries at 5%. The filter carries information.")
    else:
        print("   -> CANNOT reject the null. The filter may be adding nothing "
              "over random RTH entries with the same stop/target geometry.")
    hr()
    return pval


def test_decay(mnq):
    print("\n" + "=" * 100)
    print("TEST 9 — WALK-FORWARD + DECAY")
    print("=" * 100)
    n = len(mnq)
    cut = int(n * 0.6)
    line("in-sample  (first 60%)", run(mnq[:cut]))
    oos = run(mnq[cut:])
    line("out-of-sample (last 40%)", oos)
    if len(oos) >= 8:
        half = len(oos) // 2
        line("   OOS first half", oos[:half])
        line("   OOS second half", oos[half:])
    hr()


def main(mnq_dir, nq_dir, es_dir):
    mnq = load(os.path.join(mnq_dir, "MNQ_1h.csv"))
    nq = load(os.path.join(nq_dir, "NQ_1h.csv"))

    print("=" * 100)
    print("ADVERSARIAL AUDIT — MNQ 1H SWEEP-REJECTION STRATEGY")
    print(f"bars: MNQ {len(mnq)}  NQ {len(nq)}   costs: MNQ {COST_PTS['MNQ']} pts RT")
    print("=" * 100)

    base = run(mnq, tz_mode="true")
    line("BASELINE MNQ 1H (true ET, costed)", base)

    test_dst(mnq, nq)
    test_bootstrap(base, "MNQ 1H full sample")
    test_montecarlo(base)
    test_sensitivity(mnq)
    test_costs(mnq)
    test_fill_realism(mnq)
    test_regime(mnq)
    test_null(mnq, base)
    test_decay(mnq)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
