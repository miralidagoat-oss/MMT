#!/usr/bin/env python3
"""Pre-registered research tests for the ONR Book (2026-11-17). Hypotheses and rules were fixed before running;
"validated" = positive with t >= 2 in BOTH 2011-18 and 2019-26 (MNQ $2/pt, $1 commission, no slippage), and still
positive in 2019-26 with 1 tick slippage per side. Every test is printed, pass or fail.

usage: research.py DATA_DIR legs|accounts

legs:
  L1  last-half-hour momentum (Gao, Han, Li, Zhou 2018 JFE): sign of the return from the previous RTH close to 10:00
      -> hold 15:30-16:00 in that direction.
  L2  noise-area intraday momentum (Zarattini, Aziz, Barbon 2024): boundaries max/min(open, prev close) x (1 +/- sigma),
      sigma = 14-day average |move from open| at that minute; act at :00/:30 from 10:00; trailing exit at
      max(boundary, average price) (TWAP stands in for VWAP: the CFD has no volume); flat at 16:00.
  L3  5-minute opening-range breakout (Zarattini, Aziz 2023): first 5-minute candle's direction at 09:35, stop at its
      opposite extreme, target 10R, exit 16:00 - against the book's own 09:35 pyramid.
  M1  overnight leg, buy vs sell signals (overnight-drift literature: sells fight the drift).
  M2  pyramid / IB edge by volatility regime (ADR14 / ADR100 terciles fixed on 2011-18).
accounts: Lucid Flex 25K / 50K / 100K / 150K and payout policies (see account_sizes()).
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import PV, TK, Sessions, funded_on, ib_breakout, load_npz, pyramid  # noqa: E402

COMM = 1.0


def year(d):
    return int(str(np.datetime64(int(d), "D"))[:4])


def tstat(x):
    x = np.asarray(x, float)
    return x.mean() / (x.std(ddof=1) / np.sqrt(len(x))) if len(x) > 2 else np.nan


def halves(vals, unit=""):
    out = []
    for lab, a, b in (("2011-18", 2011, 2018), ("2019-26", 2019, 2026)):
        x = [v for d, v in vals if a <= year(d) <= b]
        out.append(f"{lab} {np.mean(x):+.3f}{unit} (t {tstat(x):4.1f}, n {len(x):4d})" if len(x) > 2 else f"{lab} n/a")
    return " | ".join(out)


def verdict(vals, vals_slip=None):
    ok = all(len(x) > 2 and np.mean(x) > 0 and tstat(x) >= 2 for x in
             ([v for d, v in vals if year(d) <= 2018], [v for d, v in vals if year(d) >= 2019]))
    if ok and vals_slip is not None:
        ok = np.mean([v for d, v in vals_slip if year(d) >= 2019]) > 0
    return "VALIDATED" if ok else "not validated"


def rth_minutes(S, d):
    """RTH 1-minute bars of session d as arrays indexed by minute 0..389 from 09:30 (NaN where missing)."""
    r = S.S[d]
    o, h, l, c, t = r["rng"]
    i0, i1 = r["i0"], r["i1"]
    s = ((t[i0:i1] % 1440) - 1080) % 1440
    m = s - 930
    k = (m >= 0) & (m < 390)
    out = np.full((4, 390), np.nan)
    idx = m[k]
    for j, arr in enumerate((o, h, l, c)):
        out[j, idx] = arr[i0:i1][k]
    return out


def price_at(M, minute):
    """Price at a clock minute (minutes after 09:30) = close of the bar that ends there."""
    v = M[3, :minute][~np.isnan(M[3, :minute])]
    return v[-1] if len(v) else np.nan


def prev_rth_close(S, keys, d):
    i = np.searchsorted(keys, d) - 1
    return S.rth[keys[i]]["c"] if i >= 0 else np.nan


def test_L1(S, slip=0.0):
    keys = np.array(sorted(S.rth))
    vals, by_mag = [], []
    for d in S.days:
        A = S.S[d]["adr"]
        if np.isnan(A) or d not in S.rth or S.rth[d]["nb"] < 13:
            continue
        M = rth_minutes(S, d)
        pc = prev_rth_close(S, keys, d)
        p10, p1530, p16 = price_at(M, 30), price_at(M, 360), price_at(M, 390)
        if np.isnan([pc, p10, p1530, p16]).any() or p10 == pc:
            continue
        side = 1 if p10 > pc else -1
        pnl = (p16 - p1530) * side - 2 * slip
        vals.append((d, (pnl * PV - COMM) / (A * PV)))
        by_mag.append((d, abs(p10 / pc - 1), (pnl * PV - COMM) / (A * PV)))
    return vals, by_mag


def test_L3(S, slip=0.0):
    vals = []
    for d in S.days:
        A = S.S[d]["adr"]
        if np.isnan(A) or d not in S.rth or S.rth[d]["nb"] < 13:
            continue
        M = rth_minutes(S, d)
        if np.isnan(M[:, :5]).any():
            continue
        o0, c5, hi, lo = M[0, 0], M[3, 4], M[1, :5].max(), M[2, :5].min()
        if c5 == o0:
            continue
        side = 1 if c5 > o0 else -1
        E = c5 + side * slip
        stop = lo if side == 1 else hi
        R = abs(E - stop)
        if R < TK:
            continue
        tgt = E + side * 10 * R
        px = np.nan
        for j in range(5, 390):
            if np.isnan(M[0, j]):
                continue
            if (side == 1 and M[2, j] <= stop) or (side == -1 and M[1, j] >= stop):
                op = M[0, j]
                px = (op if (side == 1 and op <= stop) or (side == -1 and op >= stop) else stop) - side * slip
                break
            if (side == 1 and M[1, j] >= tgt + TK) or (side == -1 and M[2, j] <= tgt - TK):
                px = tgt
                break
        if np.isnan(px):
            px = price_at(M, 390) - side * slip
        vals.append((d, ((px - E) * side * PV - COMM) / (R * PV)))
    return vals


def test_L2(S, slip=0.0):
    """Noise-area strategy, 1 unit, P&L per day in ADR units."""
    days = [d for d in S.days if d in S.rth and S.rth[d]["nb"] >= 13]
    keys = np.array(sorted(S.rth))
    moves, out = [], []
    for d in days:
        M = rth_minutes(S, d)
        O = M[0, 0]
        A = S.S[d]["adr"]
        if np.isnan(O):
            continue
        mv = np.abs(M[3] / O - 1.0)
        if len(moves) >= 14 and not np.isnan(A):
            sig = np.nanmean(np.array(moves[-14:]), axis=0)
            pc = prev_rth_close(S, keys, d)
            up_ref, lo_ref = max(O, pc), min(O, pc)
            pos, ent, day = 0, 0.0, 0.0
            closes = M[3]
            for m in range(30, 391, 30):
                P = price_at(M, m)
                if np.isnan(P):
                    continue
                if m == 390:
                    if pos:
                        day += ((P - pos * slip - ent) * pos * PV - COMM)
                    break
                twap = np.nanmean(closes[:m])
                UB, LB = up_ref * (1 + sig[m - 1]), lo_ref * (1 - sig[m - 1])
                if pos == 1 and P < max(UB, twap):
                    day += ((P - slip - ent) * PV - COMM)
                    pos = 0
                elif pos == -1 and P > min(LB, twap):
                    day += ((ent - P - slip) * PV - COMM)
                    pos = 0
                if pos == 0 and m <= 360:
                    if P > UB:
                        pos, ent = 1, P + slip
                    elif P < LB:
                        pos, ent = -1, P - slip
            out.append((d, day / (A * PV)))
        moves.append(mv)
    return out


def leg_vals(S, which, slip=0.0):
    out = []
    for d in S.days:
        r = S.S[d]
        A = r["adr"]
        if np.isnan(A):
            continue
        if which in ("on_buy", "on_sell", "on_buy_nostop", "on_sell_nostop"):
            s = S.on_side(d)
            if not s or (which.startswith("on_buy") and s < 0) or (which.startswith("on_sell") and s > 0):
                continue
            if which.endswith("nostop"):
                out.append((d, (r["on"]["w"].xc - r["on"]["E"]) * s / A))
            else:
                out.append((d, funded_on(S, d, s, slip)[0] / (0.5 * A * PV)))
        elif which == "pyr":
            s = S.od_side(d)
            if s:
                out.append((d, pyramid(S, d, s, slip)[0] / (0.35 * A * PV)))
        elif which == "ib":
            res = ib_breakout(S, d, slip, only_side=S.od_side(d))
            if res and res[1] != "both-skip":
                out.append((d, res[0] / (0.25 * A * PV)))
    return out


def adr100(S):
    full = [d for d in sorted(S.rth) if S.rth[d]["nb"] >= 13]
    rng = np.array([S.rth[d]["h"] - S.rth[d]["l"] for d in full])
    res = {}
    k = 0
    for X in S.days:
        while k < len(full) and full[k] < X:
            k += 1
        res[X] = rng[k - 100:k].mean() if k >= 100 else np.nan
    return res


def legs(dd):
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    print("== L1 last-half-hour momentum (prior close -> 10:00 sign; hold 15:30-16:00), ADR units per trade")
    v, mag = test_L1(S)
    vs, _ = test_L1(S, slip=TK)
    print("  ", halves(v, " ADR"), "->", verdict(v, vs))
    q = np.quantile([m for d, m, _ in mag if year(d) <= 2018], [1 / 3, 2 / 3])
    for lab, lo, hi in (("small first move", -1, q[0]), ("medium", q[0], q[1]), ("large first move", q[1], 9)):
        print(f"     {lab:17s}", halves([(d, x) for d, m, x in mag if lo < m <= hi], " ADR"))
    print("== L2 noise-area intraday momentum (published rules, TWAP for VWAP), P&L per day in ADR units")
    v, vs = test_L2(S), test_L2(S, slip=TK)
    print("  ", halves(v, " ADR"), "->", verdict(v, vs))
    print("== L3 5-minute ORB (first-candle direction, stop at its extreme, 10R target), R per trade")
    v, vs = test_L3(S), test_L3(S, slip=TK)
    print("  ", halves(v, "R"), "->", verdict(v, vs))
    print("   (book's own 09:35 pyramid, R per trade):", halves(leg_vals(S, "pyr"), "R"))
    print("== M1 overnight leg by signal side")
    for w in ("on_buy_nostop", "on_sell_nostop"):
        print(f"   {w:16s} (ADR, no stop) ", halves(leg_vals(S, w), " ADR"))
    for w in ("on_buy", "on_sell"):
        print(f"   {w:16s} (R, 0.5 ADR stop)", halves(leg_vals(S, w), "R"))
    print("== M2 momentum legs by volatility regime (ADR14 / ADR100; terciles fixed on 2011-18)")
    a100 = adr100(S)
    ratio = {d: S.S[d]["adr"] / a100[d] for d in S.days if not np.isnan(a100[d]) and not np.isnan(S.S[d]["adr"])}
    q = np.quantile([v for d, v in ratio.items() if year(d) <= 2018], [1 / 3, 2 / 3])
    for leg in ("pyr", "ib"):
        lv = leg_vals(S, leg)
        for lab, lo, hi in (("low vol", -1, q[0]), ("mid vol", q[0], q[1]), ("high vol", q[1], 99)):
            sel = [(d, x) for d, x in lv if d in ratio and lo < ratio[d] <= hi]
            print(f"   {leg:3s} {lab:8s}", halves(sel, "R"))


_S = None
_DD = None


def _init(dd):
    global _S, _DD
    _DD = dd
    _S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)


def _acct_job(args):
    from account import RULES
    from portfolio import pool, portfolio, summarize
    name, ek, fk, structure, a, b, offsets = args
    S = _S
    fee = RULES[fk.get("size", 25)]["price"]
    fn = (lambda **kw: portfolio(S, lanes=1, **kw)) if structure == "1 account" else (lambda **kw: pool(S, **kw))
    rs = [summarize(S, fn(k_start=a + off, k_stop=b, eval_kw=ek, funded_kw=fk), a + off, b, fee=fee)
          for off in offsets]
    g = lambda k, f=np.mean: f([r[k] for r in rs])  # noqa: E731
    return name, structure, (a, b), (g("net_yr"), g("payouts_yr"), g("months_with_payout"), g("longest_gap_mo"),
                                g("worst_12m", np.min), g("evals_yr"))


def account_configs():
    base_e = dict(improved=True)
    base_f = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True)
    cfg = [("BASE v2.1 25K, $500 payouts", base_e, base_f),
           ("M1 long-only overnight", dict(base_e, on_long_only=True), dict(base_f, on_long_only=True)),
           ("A2 max-allowed payouts", base_e, dict(base_f, payout_max=True))]
    for size in (50, 100, 150):
        for pm in (False, True):
            cfg.append((f"A1 {size}K, {'max-allowed' if pm else '$500'} payouts", dict(base_e, size=size),
                        dict(base_f, size=size, payout_max=pm)))
    return cfg


def accounts(dd, configs=None, periods=None, offsets=range(0, 252, 42)):
    """periods: list of (label, first session date 'YYYY-MM-DD', end date or None). Default: 2011-18 and 2019-26."""
    from multiprocessing import Pool as MP
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    days = S.days
    k0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in days]))

    def kof(date):
        return int(np.searchsorted(days, np.datetime64(date).astype(int)))
    if periods is None:
        P = [("2011-18", k0, kof("2019-01-01")), ("2019-26", kof("2019-01-01"), len(days))]
    else:
        P = [(lab, kof(a), kof(b) if b else len(days)) for lab, a, b in periods]
    cfg = configs or account_configs()
    jobs = [(n, e, f, st, a, b, tuple(offsets)) for n, e, f in cfg for st in ("1 account", "5 funded + eval pool")
            for _, a, b in P]
    with MP(4, initializer=_init, initargs=(dd,)) as mp:
        res = mp.map(_acct_job, jobs)
    labs = " | ".join(lab for lab, _, _ in P)
    print(f"net = payouts x 90% - evals x list price; {len(offsets)} start dates per period; {labs}")
    for st in ("1 account", "5 funded + eval pool"):
        print(f"-- {st}")
        for n, _, _ in cfg:
            r = [{ab: v for nn, s_, ab, v in res if nn == n and s_ == st}[(a, b)] for _, a, b in P]
            j = lambda i, fmt: " | ".join(fmt.format(x[i]) for x in r)  # noqa: E731
            print(f"  {n:34s} net {j(0, '${:7,.0f}')}  payouts/yr {j(1, '{:5.1f}')}  months paid {j(2, '{:4.1f}%')}  "
                  f"longest gap {j(3, '{:4.1f}')} mo  worst 12m {j(4, '${:7,.0f}')}  evals/yr {j(5, '{:5.1f}')}", flush=True)


def followup(dd):
    """Pre-registered after the first account run: M1b (long-only overnight in the FUNDED account only), and stress tests of
    the two winners (A2 max-allowed payouts on 25K, and 50K with max-allowed payouts) under 2x commission + 1 tick."""
    be = dict(improved=True)
    bf = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True)
    cost = dict(comm=2.0, slip=0.25)
    accounts(dd, [("M1b funded long-only, $500", be, dict(bf, on_long_only=True)),
                  ("M1b + A2 (max-allowed payouts)", be, dict(bf, on_long_only=True, payout_max=True)),
                  ("A2 25K max, costs x2 + 1 tick", dict(be, **cost), dict(bf, payout_max=True, **cost)),
                  ("50K max, costs x2 + 1 tick", dict(be, size=50, **cost), dict(bf, size=50, payout_max=True, **cost))])


def final(dd):
    """Recommended setups at a realistic all-in MNQ cost of $1.34 per round turn (prop-firm schedules: $1.24-$1.42)."""
    be = dict(improved=True, comm=1.34)
    bf = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=1.34)
    accounts(dd, [("v2.1 25K, $500 payouts", be, bf),
                  ("v2.2 25K, max-allowed payouts", be, dict(bf, payout_max=True)),
                  ("v2.2 50K, max-allowed payouts", dict(be, size=50), dict(bf, size=50, payout_max=True)),
                  ("v2.2 150K, max-allowed payouts", dict(be, size=150), dict(bf, size=150, payout_max=True))])


def recent(dd, start="2022-11-14", mid="2024-11-14", only_accounts=False):
    """Only the trailing 4 years (the user's reliability window): leg edges (also per 2-year half), literature tests,
    eval pass rates, account results at $1.34 per MNQ round turn, year by year, and a cost stress test."""
    from account import run_eval
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    days = S.days
    d0, dm = np.datetime64(start).astype(int), np.datetime64(mid).astype(int)
    d1 = days[-1] + 1

    def st(vals, a, b, unit):
        x = [v for d, v in vals if a <= d < b]
        return f"{np.mean(x):+.3f}{unit} (t {tstat(x):4.1f}, n {len(x):3d})" if len(x) > 2 else "n/a"

    if only_accounts:
        return recent_accounts(dd, start, mid)

    def show(name, vals, unit):
        print(f"  {name:38s} 4y {st(vals, d0, d1, unit)} | first 2y {st(vals, d0, dm, unit)} | last 2y {st(vals, dm, d1, unit)}",
              flush=True)
    print(f"== Legs, {start} -> {np.datetime64(int(days[-1]), 'D')} (MNQ, $1 commission, Pine fills)")
    show("overnight BUY signals, no stop", leg_vals(S, "on_buy_nostop"), " ADR")
    show("overnight SELL signals, no stop", leg_vals(S, "on_sell_nostop"), " ADR")
    show("overnight BUY, 0.5 ADR stop (funded)", leg_vals(S, "on_buy"), "R")
    show("overnight SELL, 0.5 ADR stop (funded)", leg_vals(S, "on_sell"), "R")
    drift = [(d, (S.S[d]["on"]["w"].xc - S.S[d]["on"]["E"]) / S.S[d]["adr"]) for d in days
             if "on" in S.S[d] and not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"])]
    show("long every night (overnight drift)", drift, " ADR")
    show("opening-drive pyramid", leg_vals(S, "pyr"), "R")
    ib_all = []
    for d in days:
        A = S.S[d]["adr"]
        if np.isnan(A):
            continue
        res = ib_breakout(S, d)
        if res and res[1] != "both-skip":
            od = S.od_side(d)
            ib_all.append((d, res[0] / (0.25 * A * PV), 0 if not od else (1 if res[2] == od else -1)))
    show("IB breakout with the 09:35 drive", [(d, x) for d, x, k in ib_all if k == 1], "R")
    show("IB breakout against the drive", [(d, x) for d, x, k in ib_all if k == -1], "R")
    show("IB breakout, no drive that day", [(d, x) for d, x, k in ib_all if k == 0], "R")
    show("L1 last-half-hour momentum", test_L1(S)[0], " ADR")
    show("L2 noise-area momentum (per day)", test_L2(S), " ADR")
    show("L3 5-minute ORB", test_L3(S), "R")
    print("== Eval pass rate, evals started on every session of the window")
    ks = [k for k in range(len(days)) if days[k] >= d0]
    for name, kw in (("25K v2.2", dict(improved=True, comm=1.34)), ("50K v2.2", dict(improved=True, comm=1.34, size=50)),
                     ("150K v2.2", dict(improved=True, comm=1.34, size=150))):
        r = [run_eval(S, k, **kw) for k in ks]
        done = [x for x in r if x["result"] != "open"]
        ps = [x["days"] for x in done if x["result"] == "pass"]
        print(f"  {name:10s} pass {100 * len(ps) / len(done):4.1f}% of {len(done)} | median {np.median(ps):.0f} sessions to pass",
              flush=True)
    rs = []
    for seed in range(10):
        g = np.random.default_rng(seed)
        flip = {(d, leg): int(g.choice([-1, 1])) for d in days for leg in ("on", "od")}
        r = [run_eval(S, k, improved=True, comm=1.34, side_override=lambda d, leg, f=flip: f[(d, leg)]) for k in ks]
        done = [x for x in r if x["result"] != "open"]
        rs.append(100 * np.mean([x["result"] == "pass" for x in done]))
    print(f"  25K coin-flip sides x10: mean {np.mean(rs):.1f}%, best {np.max(rs):.1f}%", flush=True)
    recent_accounts(dd, start, mid)


def recent_accounts(dd, start="2022-11-14", mid="2024-11-14"):
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    days = S.days
    d0 = np.datetime64(start).astype(int)
    be = dict(improved=True, comm=1.34)
    bf = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=1.34)
    cost = dict(comm=2.0, slip=0.25)
    print("== Accounts, $1.34 per MNQ round turn")
    accounts(dd, [("v2.1 25K, $500 payouts", be, bf),
                  ("v2.2 25K, max-allowed payouts", be, dict(bf, payout_max=True)),
                  ("v2.2 50K, max-allowed payouts", dict(be, size=50), dict(bf, size=50, payout_max=True)),
                  ("v2.2 100K, max-allowed payouts", dict(be, size=100), dict(bf, size=100, payout_max=True)),
                  ("v2.2 150K, max-allowed payouts", dict(be, size=150), dict(bf, size=150, payout_max=True)),
                  ("25K max + long-only overnight", dict(be, on_long_only=True), dict(bf, payout_max=True, on_long_only=True)),
                  ("50K max + long-only overnight", dict(be, size=50, on_long_only=True),
                   dict(bf, size=50, payout_max=True, on_long_only=True)),
                  ("25K max, 2x costs + 1 tick", dict(be, **cost), dict(bf, payout_max=True, **cost)),
                  ("50K max, 2x costs + 1 tick", dict(be, size=50, **cost), dict(bf, size=50, payout_max=True, **cost))],
             periods=[("last 4y", start, None), ("first 2y", start, mid), ("last 2y", mid, None)],
             offsets=range(0, 126, 21))
    print("== Year by year (net), 5 funded + eval pool started on the window's first session")
    from account import RULES
    from portfolio import pool, summarize
    kw0 = int(np.searchsorted(days, d0))
    for name, size in (("25K max-allowed", 25), ("50K max-allowed", 50), ("150K max-allowed", 150)):
        r = summarize(S, pool(S, k_start=kw0, eval_kw=dict(be, size=size), funded_kw=dict(bf, size=size, payout_max=True)),
                      kw0, len(days), fee=RULES[size]["price"])
        by = {}
        for i, v in enumerate(r["by_month"]):
            by[(r["m0"] + i) // 12] = by.get((r["m0"] + i) // 12, 0.0) + v
        print(f"  {name:17s} " + " ".join(f"{y}:${v:,.0f}" for y, v in sorted(by.items())) +
              f" | longest gap {r['longest_gap_mo']:.1f} mo | months with a payout {r['months_with_payout']:.0f}%", flush=True)


if __name__ == "__main__":
    {"legs": legs, "accounts": accounts, "followup": followup, "final": final, "recent": recent,
     "recent_accounts": recent_accounts}[sys.argv[2]](sys.argv[1])
