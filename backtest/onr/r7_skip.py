#!/usr/bin/env python3
"""Figures for an optional "FUNDED / LIVE: skip the overnight trade" switch (indicator v2.7.1), on round 7's account
harness (r7_accounts.py: per-contract legs, the published account rules, 12 start dates, $1.00 a round turn).

usage: python3 -I r7_skip.py DATA_DIR OUT_DIR

Variants of the funded book (evals and Combines keep the overnight trade): the book; no overnight trade; the ORB leg;
the ORB leg with no overnight trade (r7_accounts' "on->F1"). Accounts: Lucid 50K 40% rule and add-on (5 funded + 5
evals, each closed after its 4th payout) and Topstep 50K (5 XFAs + 5 Combines). Windows: last 5 years, Dec 2019 -
Nov 2021 and 2023-26; rule 5Y against the book with results_r7/accounts.csv's placebo noise bands.
Also the live alarm bands of one 50K funded account for each variant (r7_v27.py's method; the book's and the ORB
leg's are asserted equal to the published ones).
Writes OUT_DIR/skip_accounts.csv and OUT_DIR/skip_alarm_bands.csv.
"""
import csv
import os
import sys
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r7_accounts as X  # noqa: E402
import r7_v27 as V  # noqa: E402
import research4 as R4  # noqa: E402

X.VARIANTS["no-on"] = dict(legs=("pyr", "ib"))
VARS = ("book", "no-on", "+F1", "on->F1")
LEGS = {"book": X.BOOK, "no-on": ("pyr", "ib"), "+F1": X.BOOK + ("F1",), "on->F1": ("F1", "pyr", "ib")}
ORB_BANDS = [[20, 1735.0, -3574.0, -5452.0], [40, 3840.0, -4184.0, -6899.0], [60, 5890.0, -4078.0, -7842.0],
             [120, 12248.0, -2465.0, -7934.0], [250, 26128.0, 4170.0, -4170.0]]   # results_r7/v27_alarm_bands.csv


def main(dd, out):
    X.init(dd, 0.0)
    bands = {v: V.bands(V.daily_one_account(LEGS[v])) for v in VARS}
    assert bands["book"] == V.BANDS_PUBLISHED and bands["+F1"] == ORB_BANDS
    with open(os.path.join(out, "skip_alarm_bands.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["variant", "trading_days", "median_usd", "p5_yellow_usd", "p1_red_usd"])
        for v in VARS:
            for row in bands[v]:
                w.writerow([v] + row)
    jobs = [(v, a, win, off) for v in VARS for a in X.ACCTS for win in X.WINDOWS for off in R4.OFFSETS]
    with get_context("fork").Pool(4) as p:
        res = p.map(X.job, jobs, chunksize=4)
    agg = {}
    for (v, a, win, off), per in res:
        for lab, x in per.items():
            agg.setdefault((v, a, lab), []).append(x)
    t = {k: (float(np.mean([x["M"] for x in xs])), float(np.mean([x["W"] for x in xs]))) for k, xs in agg.items()}
    pub = {(r["variant"], r["account"]): r for r in csv.DictReader(open(os.path.join(out, "accounts.csv")))}
    rows = []
    for a in X.ACCTS:
        b = pub[("book", a)]
        bM, bW, bMe, bWe = (float(b[k]) for k in ("band_5y", "band_worst", "band_early", "band_worst_early"))
        for v in VARS:
            x5, b5 = t[(v, a, "last 5y")], t[("book", a, "last 5y")]
            xe, be = t[(v, a, "early")], t[("book", a, "early")]
            dM, dW, dMe, dWe = x5[0] - b5[0], x5[1] - b5[1], xe[0] - be[0], xe[1] - be[1]
            ok = ((dM > bM and dW > -bW) or (dW > bW and dM > -bM)) and dMe > -bMe and dWe > -bWe
            if v in ("book", "+F1", "on->F1"):   # the published runs must reproduce
                assert round(x5[0]) == int(pub[(v, a)]["net_5y"]), (v, a, x5[0], pub[(v, a)]["net_5y"])
            rows.append(dict(variant=v, account=a, net_5y=round(x5[0]), worst_year_5y=round(x5[1]), change_5y=round(dM),
                             change_worst=round(dW), net_early=round(xe[0]), change_early=round(dMe),
                             change_worst_early=round(dWe), net_2023_26=round(t[(v, a, "oos")][0]),
                             rule_5y_vs_book="" if v == "book" else ("PASS" if ok else "fail")))
            print(rows[-1], flush=True)
    with open(os.path.join(out, "skip_accounts.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    for v in VARS:
        print(v, "alarm bands:", bands[v], flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
