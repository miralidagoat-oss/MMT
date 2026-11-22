#!/usr/bin/env python3
"""Why Topstep made more than Lucid at 50K: the Lucid plan turned into the Topstep plan one rule at a time.

usage: topstep_why.py FUT_DATA_DIR OUT_DIR
Last 5 years on futures prices (Nov 15 2021 - Nov 17 2026), 5 funded + 5 evals, one new eval a session, 12 start dates
(research4.OFFSETS), the same trades; topstep_sim.py's machinery and costs. Steps:
  A  Lucid plan: Lucid's rules, the 50% add-on, each funded account closed after its 4th payout, $90.50 an eval
  B  A without the payout limit (funded accounts keep paying until they fail; not allowed at Lucid: a 5th payout moves
     you live)
  C  B with Topstep's fees (Standard fee path: $49 a month per Combine, $149 per XFA activation)
  D  C with Topstep's account rules (max loss locks at $0, Combine pass at 55%, position limits, funded legs <= 6 MNQ):
     the Topstep plan
and each change alone from A: E = A with Topstep's fees, F = A with Topstep's account rules.
Checks: A equals the website's Lucid plan ($59,272) and D equals results_topstep (5y-50-standard-standard, $77,107).
Writes why.csv: per step, the mean over the 12 start dates of net a year and of payouts, fees and accounts a year.
"""
import csv
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402

LUCID_EK = dict(R4.E_KW, cons=0.5)
NOLIMIT = 10 ** 9
STEPS = {  # name: (eval rules, funded rules, fees: "lucid" = $90.50 an eval, "topstep" = Standard fee path)
    "A": (LUCID_EK, dict(R4.F_KW, max_pay=4), "lucid"),
    "B": (LUCID_EK, dict(R4.F_KW, max_pay=NOLIMIT), "lucid"),
    "C": (LUCID_EK, dict(R4.F_KW, max_pay=NOLIMIT), "topstep"),
    "D": (T.ek(50), T.fk(50, "standard"), "topstep"),
    "E": (LUCID_EK, dict(R4.F_KW, max_pay=4), "topstep"),
    "F": (T.ek(50), dict(T.fk(50, "standard"), max_pay=4), "lucid"),
}
LABEL = {"A": "Lucid plan (add-on, closed after the 4th payout, $90.50 evals)",
         "B": "A without the payout limit", "C": "B with Topstep's fees", "D": "C with Topstep's account rules = the Topstep plan",
         "E": "A with Topstep's fees only", "F": "A with Topstep's account rules only"}


def _job(args):
    step, off = args
    S = T._S["S"]
    k0 = T.start_k(S, "5y", off)
    ek, fk, fees = STEPS[step]
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
    cash = T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=90.5 if fees == "lucid" else None)
    lab, a, b, fy = T.WINDOWS[("fut", "5y")]
    r = T.summarise_run(S, k0, cash, ev, [(lab, a, b)], {lab: fy})
    span = r["periods"][lab]["M"] and (float(cash.sum()) / r["periods"][lab]["M"])  # years in the window
    pay = sum(v for _, kind, _, v in ev if kind == "payout")
    return step, off, dict(net=r["periods"][lab]["M"], years=span, payouts=r["funded"]["payouts"], paid=pay,
                           share=0.1 * pay, fees=0.9 * pay - float(cash.sum()), bought=r["evals"]["bought"],
                           funded=r["funded"]["started"], worst=r["periods"][lab]["W"], worst12=r["periods"][lab]["worst12"])


def main(fd, out):
    os.makedirs(out, exist_ok=True)
    jobs = [(s, o) for s in STEPS for o in T.OFF]
    with Pool(4, initializer=T._init, initargs=("fut", fd)) as pool:
        res = pool.map(_job, jobs, chunksize=2)
    rows = []
    for s in STEPS:
        R = [r for st, _, r in res if st == s]
        per = lambda k: float(np.mean([r[k] / r["years"] for r in R]))  # noqa: E731
        rows.append(dict(step=s, setup=LABEL[s], net_per_year_usd=round(float(np.mean([r["net"] for r in R]))),
                         payouts_per_year=round(per("payouts"), 1), paid_per_year_usd=round(per("paid")),
                         firm_share_per_year_usd=round(per("share")), fees_per_year_usd=round(per("fees")),
                         evals_bought_per_year=round(per("bought"), 1), funded_started_per_year=round(per("funded"), 1),
                         average_payout_usd=round(float(np.mean([r["paid"] / r["payouts"] for r in R]))),
                         worst_full_year_usd=round(float(np.mean([r["worst"] for r in R]))),
                         worst_12_months_usd=round(float(np.mean([r["worst12"] for r in R])))))
    net = {r["step"]: r["net_per_year_usd"] for r in rows}
    assert abs(net["A"] - 59272) <= 1, net["A"]   # the website's Lucid plan (lucid_5y B5-addon-stop4)
    assert abs(net["D"] - 77107) <= 1, net["D"]   # results_topstep 5y-50-standard-standard
    print(f"checks passed: A = ${net['A']:,} (the website's Lucid plan), D = ${net['D']:,} (results_topstep)", flush=True)
    T.write_csv(out, "why.csv", rows)
    for r in rows:
        print(f"{r['step']} {r['setup'][:52]:52s} net ${r['net_per_year_usd']:>7,}/yr | payouts {r['payouts_per_year']:>5}/yr avg ${r['average_payout_usd']:,}"
              f" paid ${r['paid_per_year_usd']:>7,} | fees ${r['fees_per_year_usd']:>6,} | evals {r['evals_bought_per_year']}/yr funded {r['funded_started_per_year']}/yr"
              f" | worst yr ${r['worst_full_year_usd']:,} worst 12m ${r['worst_12_months_usd']:,}", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
