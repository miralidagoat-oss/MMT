#!/usr/bin/env python3
"""The indicator's plan on Topstep's 25K account (Topstep Labs "$25K Static Trading Combine"), next to Lucid's 25K.

usage: topstep25k.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR      (CFD_DATA_DIR "-": futures only)
Topstep's rules (help.topstep.com, Topstep Labs article and the XFA / payout / DLL articles, read Nov 20 2026):
  Combine: $75 one time (no monthly fee, no resets: a new one is bought), expires 90 days after purchase; profit target
  $2,000; maximum loss $1,000 STATIC (the floor never moves); mandatory daily loss limit $500 (hit: flattened, no new
  trades until 5 PM CT, not a violation); best day <= 55% of the profit; at most 20 micros; up to 5 bought a month;
  funded activation free.
  XFA: maximum loss $1,000 static, $0 (the start balance) after the first payout; mandatory $500 daily loss limit; at
  most 20 micros, no scaling; payout cap $4,000; Standard or Consistency path. The 25K page states no other payout rule,
  so Topstep's general XFA rules are assumed: Standard = 5 winning days of $150+, Consistency = 3 traded days with the
  best day <= 40% of the profit since the last payout; 50% of the balance up to the cap; 90% to the trader. Up to 5 XFAs.
The plan as at 50K (topstep_sim.py): 5 XFAs + 5 Combines, one new Combine a session (here at most 5 a month), the
indicator's 25K settings (every $ limit x max loss / $1,000 = x1), the eval's day target capped at 50% of the profit
target, payouts asked for once an account is $1,000 up. The daily loss limit is met by keeping each day's planned risk
inside $500: the Combine's stop (commission included) and the funded book's day budget are capped at $500 (at 25K they
would otherwise be $600). Funded legs at most 6 micros (three legs inside 20).
Not modelled: Topstep's discretionary call-up to a live account (it closes every XFA).
Runs: 12 start dates in each window (the MNQ file, last 5 years and from Dec 20 2019; with a CFD_DATA_DIR, as before
Nov 23 2026, the Nasdaq-100 CFD from Feb 15 2011).
Checks: the worst day of any Combine or XFA (accounts started every 5 sessions over the last 5 years, traded alone)
against the $500 limit.
Writes labs25k.csv (one row per window and payout path, topstep.csv's columns), labs25k_years.csv, runs.json.
"""
import json
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402
from account import EvalAccount, FundedAccount  # noqa: E402

LABS25 = dict(target=2000.0, mll=1000.0, qday=150.0, evalmax=20, fundmax=6)
PRICE, DLL, LIFE, PER_MONTH, CAP = 75.0, 500.0, 90, 5, 4000.0
PATH_LABEL = {"standard": "Standard payouts (5 days of $150)", "consistency": "Consistency payouts (40%)"}


def ek():
    return dict(R4.E_KW, cons=0.5, rules=LABS25, lock=-LABS25["mll"], pass_cons=0.55, dll=DLL, max_days=LIFE)


def fk(path):
    return dict(R4.F_KW, rules=dict(LABS25, paycap=CAP), lock=-LABS25["mll"], lock_after_pay=0.0, pay_min=T.PAY_MIN,
                pay_path="days" if path == "standard" else "consistency", pay_cons=0.4, pay_days=3, max_pay=10 ** 9,
                day_budget=DLL)


def month_gate(S, per_month):
    """At most per_month Combines bought in a calendar month (sim_pool buys right after the gate says yes)."""
    n = {}

    def gate(k):
        m = T.iso(S, k)[:7]
        if n.get(m, 0) >= per_month:
            return False
        n[m] = n.get(m, 0) + 1
        return True
    return gate


def _job(args):
    window, off, path, per_month = args
    S = T._S["S"]
    k0 = T.start_k(S, window, off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek(), fk(path), gate=month_gate(S, per_month) if per_month else None)
    cash = T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=PRICE)  # $75 a Combine, no monthly fee, no activation
    lab, a, b, fy = T.WINDOWS[(T._S["kind"], window)]
    res = T.summarise_run(S, k0, cash, ev, [(lab, a, b)], {lab: fy})
    buys = {}
    for k, kind, _, _ in ev:
        if kind == "buy":
            buys[T.iso(S, k)[:7]] = buys.get(T.iso(S, k)[:7], 0) + 1
    res["capped_months"] = sum(v >= PER_MONTH for v in buys.values())
    res["months"] = len({T.iso(S, k)[:7] for k in range(k0, len(S.days))})
    return (T._S["kind"], window, off, path, per_month), res


def worst_days(S, k0):
    """Combines and XFAs started every 5 sessions over the last 5 years, each traded alone: their worst day."""
    worst, below, days = 0.0, 0, 0
    for ks in range(k0, len(S.days) - 60, 5):
        e = EvalAccount(S, **ek())
        for k in range(ks, len(S.days)):
            p0 = e.pnl
            res = e.step(S.days[k])
            if res == "dead":
                break
            d = e.pnl - p0
            worst, below, days = min(worst, d), below + (d < -DLL - 1e-9), days + 1
            if res is not None:
                break
        for path in ("standard", "consistency"):
            f = FundedAccount(S, **fk(path))
            for k in range(ks, len(S.days)):
                p0 = f.pnl
                evn, amt = f.step(S.days[k])
                d = f.pnl + amt - p0
                if evn == "dead":
                    break
                worst, below, days = min(worst, d), below + (d < -DLL - 1e-9), days + 1
                if evn is not None:
                    break
    return worst, below, days


def main(fd, dd, out):
    os.makedirs(out, exist_ok=True)
    S = T.load("fut", fd)
    k5 = int(np.searchsorted(S.days, np.datetime64(T.START5).astype(int)))
    w, b, n = worst_days(S, k5)
    print(f"daily loss limit check: worst day ${w:,.2f} over {n:,} account-days; days below -${DLL:,.0f}: {b}", flush=True)
    res = {}
    for kind, data, windows in (("fut", fd, ("5y", "all")),) + ((("cfd", dd, ("all",)),) if dd != "-" else ()):
        jobs = [(win, o, p, PER_MONTH) for win in windows for p in ("standard", "consistency") for o in T.OFF]
        if kind == "fut":  # the purchase limit's effect: the same runs without it, last 5 years
            jobs += [("5y", o, p, 0) for p in ("standard", "consistency") for o in T.OFF]
        with Pool(4, initializer=T._init, initargs=(kind, data)) as pool:
            res.update(dict(pool.map(_job, jobs, chunksize=2)))
        print(f"{kind}: {len(jobs)} runs", flush=True)
    json.dump({"|".join(map(str, k)): v for k, v in res.items()}, open(os.path.join(out, "runs.json"), "w"))
    rows, yrows = [], []
    for (kind, window), (lab, _, _, _) in T.WINDOWS.items():
        if kind == "cfd" and dd == "-":
            continue  # futures only (the user's MNQ file)
        for per_month in ((PER_MONTH, 0) if (kind, window) == ("fut", "5y") else (PER_MONTH,)):
            for path in ("standard", "consistency"):
                R = [res[(kind, window, o, path, per_month)] for o in T.OFF]
                g = lambda key: float(np.mean([r["periods"][lab][key] for r in R]))  # noqa: E731
                ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
                fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
                tag = "" if per_month else "-nolimit"
                rows.append(dict(id=f"{T.WIN_ID[lab]}-25-{path}{tag}", window_id=T.WIN_ID[lab], window=T.WIN_LABEL[lab],
                                 payout_path=PATH_LABEL[path], purchase_limit=f"{per_month} a month" if per_month else "none",
                                 net_per_year_usd=round(g("M")), worst_full_year_usd=round(g("W")), losing_full_years=round(g("L"), 2),
                                 deepest_drop_usd=round(g("D")), worst_12_months_usd=round(g("worst12")),
                                 longest_gap_months=round(g("gap"), 1), months_with_payout_pct=round(g("months_paid"), 1),
                                 evals_per_year=round(g("evals_yr"), 1), most_cash_out_usd=round(float(np.mean([r["cash_low"] for r in R]))),
                                 eval_pass_pct=round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                                 funded_with_payout_pct=round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1),
                                 payouts=round(fu("payouts"), 1), average_payout_usd=round(fu("payouts_usd") / max(fu("payouts"), 1e-9)),
                                 months_at_purchase_limit_pct=round(100 * float(np.mean([r["capped_months"] / r["months"] for r in R])), 1)))
                if per_month:
                    years = sorted({y for r in R for y in r["years"]})
                    for y in years:
                        v = [r["years"][y] for r in R if y in r["years"]]
                        yl = y + (f" ({T.FIRST[lab]})" if y == years[0] else f" ({T.LAST[lab]})" if y == years[-1] else "")
                        yrows.append(dict(window_id=T.WIN_ID[lab], payout_path=PATH_LABEL[path], year=y, year_label=yl,
                                          net_median_usd=round(float(np.median(v))), net_low_usd=round(min(v)), net_high_usd=round(max(v))))
    T.write_csv(out, "labs25k.csv", rows)
    T.write_csv(out, "labs25k_years.csv", yrows)
    for r in rows:
        print(f"{r['id']:28s} net ${r['net_per_year_usd']:>7,}/yr | worst yr ${r['worst_full_year_usd']:>7,} | worst 12m ${r['worst_12_months_usd']:>7,}"
              f" | drop ${r['deepest_drop_usd']:>7,} | cash out ${r['most_cash_out_usd']:>6,} | pass {r['eval_pass_pct']}% | Combines {r['evals_per_year']}/yr"
              f" | at limit {r['months_at_purchase_limit_pct']}% of months | payouts {r['payouts']} avg ${r['average_payout_usd']:,}", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
