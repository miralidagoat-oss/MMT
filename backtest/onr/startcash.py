#!/usr/bin/env python3
"""How much cash the plan needs before payouts cover the fees, starting on any date.

usage: startcash.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
The Topstep 50K plan (topstep_sim.py's rules: 5 XFAs + 5 Combines, one new Combine a session, Standard payouts) and the
Lucid 50K plan (the 50% add-on at $90.50 an eval, each funded account closed after its 4th payout), started on many dates:
every 5 sessions on futures prices from Aug 30 2019 and every 10 sessions on the Nasdaq-100 CFD from Feb 15 2011, each run
for 2 years (starts at least 2 years before the data ends). For each start: the most cash out of pocket (the lowest the
running total of payouts to you minus every fee went), when it was reached, and when the running total was back above $0.
Topstep fees on both fee paths: Standard ($49 a month per Combine + $149 per XFA) and No Activation Fee ($95 a month).
Writes starts.csv (one row per start and plan) and summary.csv (median, 1 in 10 worse, worst, and the worst start date).
"""
import csv
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402

YEARS2 = 504  # sessions in 2 years
PLANS = {"topstep-standard": "Topstep 50K, $49 a month + $149 activation", "topstep-noact": "Topstep 50K, $95 a month, no activation",
         "lucid-addon": "Lucid 50K, add-on ($90.50 evals), closed after the 4th payout"}


def _job(k0):
    S = T._S["S"]
    k1 = min(len(S.days), k0 + YEARS2)
    out = {}
    ev_t = R4.sim_pool(S, 5, 10, k0, k1, T.ek(50), T.fk(50, "standard"))
    ev_l = R4.sim_pool(S, 5, 10, k0, k1, dict(R4.E_KW, cons=0.5), dict(R4.F_KW, max_pay=4))
    for plan, ev, kw in (("topstep-standard", ev_t, dict(fee_path="standard")), ("topstep-noact", ev_t, dict(fee_path="noact")),
                         ("lucid-addon", ev_l, dict(fee_path="standard", fee_per_buy=90.5))):
        cash = T.cash_flows(S, k0, ev, kw["fee_path"], 50, fee_per_buy=kw.get("fee_per_buy"))[: k1 - k0]
        run = np.cumsum(cash)
        i_low = int(np.argmin(run))
        back = next((i for i in range(i_low, len(run)) if run[i] > 0), None)
        first_pay = next((k for k, kind, _, _ in ev if kind == "payout"), None)
        out[plan] = dict(start=T.iso(S, k0), cash_low_usd=round(float(run[i_low])), low_date=T.iso(S, k0 + i_low),
                         back_above_zero=T.iso(S, k0 + back) if back is not None else "not within 2 years",
                         sessions_to_break_even=back if back is not None else "",
                         first_payout=T.iso(S, first_pay) if first_pay is not None else "none within 2 years",
                         net_after_2_years_usd=round(float(run[-1])))
    return T._S["kind"], out


def main(fd, dd, out):
    os.makedirs(out, exist_ok=True)
    rows = []
    for kind, data, step in (("fut", fd, 5), ("cfd", dd, 10)):
        S = T.load(kind, data)
        k0 = T.first_tradable(S)
        starts = list(range(k0, len(S.days) - YEARS2 + 1, step))
        with Pool(4, initializer=T._init, initargs=(kind, data)) as pool:
            res = pool.map(_job, starts, chunksize=4)
        for kd, o in res:
            for plan, r in o.items():
                rows.append(dict(data="futures" if kd == "fut" else "CFD", plan=plan, **r))
        print(f"{kind}: {len(starts)} start dates", flush=True)
    T.write_csv(out, "starts.csv", rows)
    summ = []
    for data in ("futures", "CFD"):
        for plan, label in PLANS.items():
            R = [r for r in rows if r["data"] == data and r["plan"] == plan]
            lows = np.array([r["cash_low_usd"] for r in R])
            worst = min(R, key=lambda r: r["cash_low_usd"])
            be = [r["sessions_to_break_even"] for r in R if r["sessions_to_break_even"] != ""]
            summ.append(dict(data=data, plan=plan, setup=label, starts=len(R), first_start=R[0]["start"], last_start=R[-1]["start"],
                             cash_low_median_usd=round(float(np.median(lows))), cash_low_p10_usd=round(float(np.percentile(lows, 10))),
                             cash_low_worst_usd=int(lows.min()), worst_start=worst["start"], worst_low_date=worst["low_date"],
                             worst_back_above_zero=worst["back_above_zero"],
                             break_even_sessions_median=round(float(np.median(be))) if be else "",
                             never_back_within_2_years=sum(r["sessions_to_break_even"] == "" for r in R),
                             net_after_2_years_median_usd=round(float(np.median([r["net_after_2_years_usd"] for r in R]))),
                             net_after_2_years_worst_usd=int(min(r["net_after_2_years_usd"] for r in R))))
    T.write_csv(out, "summary.csv", summ)
    for s in summ:
        print(s, flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
