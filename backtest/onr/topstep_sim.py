#!/usr/bin/env python3
"""The indicator's plan at Topstep: every Trading Combine / Express Funded Account configuration.

usage: topstep_sim.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
Topstep's rules (help.topstep.com, read Nov 20 2026), sizes 50K / 100K / 150K:
  Trading Combine: target $3,000 / $6,000 / $9,000; end-of-day trailing Maximum Loss Limit $2,000 / $3,000 / $4,500
  that locks at the starting balance; at most 50 / 100 / 150 micros; best day <= 55% of the total profit (above it the
  target rises to best day / 0.55); price per month, and per reset, $49 / $99 / $199 on the Standard path and
  $95 / $149 / $229 on the No Activation Fee path.
  Express Funded Account (XFA): starts at $0; MLL -$2,000 / -$3,000 / -$4,500 trailing end of day, locking at $0, and
  $0 after any payout; activation $149 on the Standard path, $0 on the No Activation Fee path; up to 5 at once; 90%
  split; minimum payout $125; no payout-count limit stated. Payout path, chosen at activation:
    Standard: 5 winning days of $150+ since the last payout; 50% of the balance up to $2,000 / $3,000 / $5,000.
    Consistency: 3 traded days, largest day <= 40% of the net profit since the last payout; 50% up to $3,000 /
    $4,000 / $6,000.
The plan: the indicator's trades at its 50K / 100K / 150K settings (every $ limit scaled by max loss / $1,000; the
eval's daily target capped at 50% of the target, the indicator's 50% setting, under Topstep's 55%), 5 funded accounts
with 5 Combines running behind them, one new Combine a session. Accounts are not closed after a set number of
payouts: Topstep has no payout limit. Its discretionary call-up to a live account, which closes every XFA, cannot be
modelled.
Not modelled: the optional Daily Loss Limit and its limited-time doubled caps, the monthly reset credit, and the
Scaling Plan tiers (its table could not be read). Each funded leg is capped at 6 / 10 / 10 micros, so three legs fit
the tiers we believe start at 20 / 30 / 30 micros: an assumption. It binds only when NQ's daily range is below about
108 / 100 / 150 points: over the last 5 years never at 50K and 100K and on a few 2023-24 days at 150K, but often in
2019-2020 and in every CFD year before 2018, so the windows reaching back there are conservative.
Payout requests: as the indicator's panel says, once an account is $1,000 up, half the profit up to Topstep's cap
(Topstep's own minimum is $125: ONR_TS_PAYMIN=125 tests requesting that early).
Costs: each Combine attempt pays the month's price when it starts and again every 30 days while it is open; each XFA
pays the activation fee on the Standard path.
Runs: 12 start dates (research4.OFFSETS) in each window: real NQ futures over the last 5 years and from Aug 30 2019,
and the Nasdaq-100 CFD from Feb 2011. Lucid's plan (results_scale_sizes) is the reference.
Writes topstep.csv (mean of the 12 start dates per window, size, payout path and fee path) and runs.json.
"""
import csv
import datetime as dt
import json
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402

SIZES = (50, 100, 150)
TS = {50: dict(target=3000.0, mll=2000.0, qday=150.0, evalmax=50, fundmax=6),
      100: dict(target=6000.0, mll=3000.0, qday=150.0, evalmax=100, fundmax=10),
      150: dict(target=9000.0, mll=4500.0, qday=150.0, evalmax=150, fundmax=10)}
CAP = {"standard": {50: 2000.0, 100: 3000.0, 150: 5000.0}, "consistency": {50: 3000.0, 100: 4000.0, 150: 6000.0}}
PRICE = {"standard": {50: 49.0, 100: 99.0, 150: 199.0}, "noact": {50: 95.0, 100: 149.0, 150: 229.0}}
ACTIVATION = {"standard": 149.0, "noact": 0.0}
FEE_LABEL = {"standard": "Standard path ($/month + $149 activation)", "noact": "No Activation Fee path"}
PAY_LABEL = {"standard": "Standard payouts (5 days of $150)", "consistency": "Consistency payouts (40%)"}
SPLIT, OFF = 0.9, R4.OFFSETS
# payout requests follow the indicator's panel: once an account is $1,000 up (a payout of at least $500), half the
# profit up to Topstep's cap. ONR_TS_PAYMIN=125 requests as soon as Topstep allows ($125 minimum, $250 of profit).
PAY_MIN = float(os.environ.get("ONR_TS_PAYMIN", "500"))
START5 = "2021-11-15"
_S = {}


def ek(size):
    return dict(R4.E_KW, cons=0.5, rules=TS[size], lock=0.0, pass_cons=0.55)


def fk(size, path):
    return dict(R4.F_KW, rules=dict(TS[size], paycap=CAP[path][size]), lock=0.0, pay_min=PAY_MIN,
                pay_path="days" if path == "standard" else "consistency", pay_cons=0.4, pay_days=3, max_pay=10 ** 9)


def load(kind, dd):
    if kind == "fut":
        return Sessions(load_npz(os.path.join(dd, "NQFUT.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5)
    return Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)


def first_tradable(S):
    return int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))


def iso(S, k):
    return str(np.datetime64(int(S.days[k]), "D"))


def cash_flows(S, k0, ev, fee_path, size, fee_per_buy=None):
    """Daily cash from sim_pool events: 90% of payouts, Combine prices (at the start and every 30 days open) and
    activation fees. fee_per_buy: a flat price per eval instead (the check against research5.metrics)."""
    n = len(S.days) - k0
    cash = np.zeros(n)
    end = {aid: k for k, kind, aid, _ in ev if kind in ("pass", "fail")}
    for k, kind, aid, v in ev:
        if kind == "payout":
            cash[k - k0] += SPLIT * v
        elif kind == "buy":
            if fee_per_buy is not None:
                cash[k - k0] -= fee_per_buy
                continue
            ke = end.get(aid, len(S.days) - 1)
            d0, j = int(S.days[k]), 0
            while d0 + 30 * j <= int(S.days[ke]):
                kc = int(np.searchsorted(S.days, d0 + 30 * j))
                cash[min(kc, ke) - k0] -= PRICE[fee_path][size]
                j += 1
        elif kind == "fund" and fee_per_buy is None:
            cash[k - k0] -= ACTIVATION[fee_path]
    return cash


def summarise_run(S, k0, cash, ev, periods, full_years):
    """research5.metrics' definitions on a daily cash array (checked equal to it for flat eval prices)."""
    cal = [iso(S, k) for k in range(k0, len(S.days))]
    yrs = {}
    for i, d in enumerate(cal):
        yrs[d[:4]] = yrs.get(d[:4], 0.0) + cash[i]
    pays = sorted({k - k0 for k, kind, _, _ in ev if kind == "payout"})
    run = np.cumsum(cash)
    fund = {aid for _, kind, aid, _ in ev if kind == "fund"}
    paid = {aid for _, kind, aid, _ in ev if kind == "payout"}
    passes = [v for _, kind, _, v in ev if kind == "pass"]
    out = dict(years=yrs, cash_low=float(run.min()), total=float(run[-1]),
               evals=dict(bought=sum(kind == "buy" for _, kind, _, _ in ev), passed=len(passes),
                          failed=sum(kind == "fail" for _, kind, _, _ in ev)),
               funded=dict(started=len(fund), with_payout=len(paid & fund),
                           payouts=sum(kind == "payout" for _, kind, _, _ in ev),
                           payouts_usd=float(sum(v for _, kind, _, v in ev if kind == "payout"))))
    per = {}
    for lab, a, b in periods:
        idx = [i for i, d in enumerate(cal) if a <= d <= b]
        if not idx:
            continue
        i0, i1 = idx[0], idx[-1]
        pn = cash[i0:i1 + 1]
        span = (dt.date.fromisoformat(cal[i1]) - dt.date.fromisoformat(cal[i0])).days / 365.25
        prun = np.cumsum(pn)
        drop = float((prun - np.maximum.accumulate(np.r_[0.0, prun])[1:]).min())
        months = {}
        for i in range(i0, i1 + 1):
            months[cal[i][:7]] = months.get(cal[i][:7], 0.0) + cash[i]
        mv = np.array([months[m] for m in sorted(months)])
        roll = np.array([mv[j:j + 12].sum() for j in range(len(mv) - 11)]) if len(mv) >= 12 else np.array([mv.sum()])
        pd_ = sorted(cal[i] for i in pays if i0 <= i <= i1)
        pts = [dt.date.fromisoformat(cal[i0])] + [dt.date.fromisoformat(x) for x in pd_] + [dt.date.fromisoformat(cal[i1])]
        gap = max((pts[j + 1] - pts[j]).days for j in range(len(pts) - 1)) / 30.44
        fy = [yrs[y] for y in full_years[lab] if y in yrs]
        per[lab] = dict(M=float(pn.sum() / span), W=float(min(fy)), L=float(sum(x < 0 for x in fy)), D=drop,
                        worst12=float(roll.min()), gap=gap, months_paid=100.0 * len({x[:7] for x in pd_}) / len(months),
                        evals_yr=sum(1 for k, kind, _, _ in ev if kind == "buy" and cal[i0] <= iso(S, k) <= cal[i1]) / span)
    out["periods"] = per
    return out


WINDOWS = {("fut", "5y"): ("last 5y", START5, "2026-12-31", [str(y) for y in range(2022, 2026)]),
           ("fut", "all"): ("2019-26", "2019-01-01", "2026-12-31", [str(y) for y in range(2020, 2026)]),
           ("cfd", "all"): ("all years", "2011-01-01", "2026-12-31", [str(y) for y in range(2012, 2026)])}


def start_k(S, window, off):
    return (first_tradable(S) if window == "all" else int(np.searchsorted(S.days, np.datetime64(START5).astype(int)))) + off


def _init(kind, dd):
    _S["kind"], _S["S"] = kind, load(kind, dd)


def _job(args):
    window, off, size, path = args
    S = _S["S"]
    k0 = start_k(S, window, off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek(size), fk(size, path))
    lab, a, b, fy = WINDOWS[(_S["kind"], window)]
    res = {}
    for fee_path in ("standard", "noact"):
        cash = cash_flows(S, k0, ev, fee_path, size)
        res[fee_path] = summarise_run(S, k0, cash, ev, [(lab, a, b)], {lab: fy})
    return (_S["kind"], window, off, size, path), res


def check(S):
    """summarise_run on a flat eval price equals research5.metrics for Lucid's plan (one start date)."""
    k0 = start_k(S, "5y", 0)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), dict(R4.E_KW, cons=0.5), dict(R4.F_KW, max_pay=4))
    mine = summarise_run(S, k0, cash_flows(S, k0, ev, "standard", 50, fee_per_buy=90.5), ev,
                         R5.P_5Y, {"last 5y": R5.FULL5["last 5y"]})["periods"]["last 5y"]
    ref = R5.metrics([("nq", S, k0, ev)], R5.FULL5, R5.P_5Y, 90.5)["periods"]["last 5y"]
    for key in ("M", "W", "L", "D", "worst12", "gap", "months_paid", "evals_yr"):
        assert abs(mine[key] - ref[key]) < 1e-6, (key, mine[key], ref[key])
    print(f"check passed: the summary equals research5.metrics on Lucid's plan (${ref['M']:,.0f} a year from {iso(S, k0)})", flush=True)


def main(fd, dd, out):
    os.makedirs(out, exist_ok=True)
    res = {}
    for kind, data, windows in (("fut", fd, ("5y", "all")), ("cfd", dd, ("all",))):
        if kind == "fut":
            check(load("fut", data))
        jobs = [(w, o, s, p) for w in windows for s in SIZES for p in ("standard", "consistency") for o in OFF]
        with Pool(4, initializer=_init, initargs=(kind, data)) as pool:
            res.update(dict(pool.map(_job, jobs, chunksize=2)))
        print(f"{kind}: {len(jobs)} runs", flush=True)
    json.dump({"|".join(map(str, k)): v for k, v in res.items()}, open(os.path.join(out, "runs.json"), "w"))
    rows = []
    for (kind, window), (lab, _, _, _) in WINDOWS.items():
        label = {"last 5y": "futures, last 5 years", "2019-26": "futures, from Aug 30 2019", "all years": "CFD, from Feb 2011"}[lab]
        for size in SIZES:
            for path in ("standard", "consistency"):
                for fee_path in ("standard", "noact"):
                    R = [res[(kind, window, o, size, path)][fee_path] for o in OFF]
                    g = lambda key: float(np.mean([r["periods"][lab][key] for r in R]))  # noqa: E731
                    ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
                    fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
                    rows.append(dict(window=label, size=f"{size}K", payout_path=PAY_LABEL[path], fee_path=FEE_LABEL[fee_path],
                                     net_per_year_usd=round(g("M")), worst_full_year_usd=round(g("W")),
                                     losing_full_years=round(g("L"), 2), deepest_drop_usd=round(g("D")),
                                     worst_12_months_usd=round(g("worst12")), longest_gap_months=round(g("gap"), 1),
                                     months_with_payout_pct=round(g("months_paid"), 1), evals_per_year=round(g("evals_yr"), 1),
                                     most_cash_out_usd=round(float(np.mean([r["cash_low"] for r in R]))),
                                     eval_pass_pct=round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                                     funded_with_payout_pct=round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1),
                                     payouts=round(fu("payouts"), 1),
                                     average_payout_usd=round(fu("payouts_usd") / max(fu("payouts"), 1e-9))))
    with open(os.path.join(out, "topstep.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    for r in rows:
        print(f"{r['window']:26s} {r['size']:>5s} {r['payout_path'][:11]:11s} {r['fee_path'][:13]:13s} net ${r['net_per_year_usd']:>8,}/yr "
              f"worst yr ${r['worst_full_year_usd']:>8,} worst 12m ${r['worst_12_months_usd']:>8,} drop ${r['deepest_drop_usd']:>8,} "
              f"cash out ${r['most_cash_out_usd']:>7,} pass {r['eval_pass_pct']}% avg payout ${r['average_payout_usd']:,}", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
