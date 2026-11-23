#!/usr/bin/env python3
"""Starting with only $500 or $1,000: one row per way in, from plan_search.py's 24-month budget runs.

usage: budget_table.py PLAN_SEARCH_DIR
Reads budget.csv (the ways in and their labels) and budget_runs.csv (a start every 5th session, followed for 24 months:
216 starts on real NQ futures, Sep 2019 - Nov 2023, and 659 on the Nasdaq-100 CFD, Mar 2011 - Nov 2023) and writes
budget_view.csv. Per way in and data: the share of starts that ran out of money (nothing trading and no cash for an
evaluation or a waiting activation), the median month of the first payout among the starts that had one within the 24
months, and the money made after 24 months (business cash minus the tax set-aside and the starting money, the car added
back): its median over every start, its median over the starts that did not run out, and the share of starts ahead.
"""
import csv
import os
import sys

import numpy as np


def main(d):
    plans = list(csv.DictReader(open(os.path.join(d, "budget.csv"))))
    runs = list(csv.DictReader(open(os.path.join(d, "budget_runs.csv"))))
    rows = []
    for p in plans:
        budget = int(p["plan"].split()[1])
        way = p["label"].split(": ", 1)[1]
        row = dict(plan=p["plan"], budget_usd=budget, way_in=way[0].upper() + way[1:])
        for kind, pre in (("futures", "fut_"), ("CFD", "cfd_")):
            R = [r for r in runs if r["plan"] == p["plan"] and r["data"] == kind]
            assert R, (p["plan"], kind)
            bust = np.array([r["bust_month"] != "" for r in R])
            made = np.array([float(r["spare_24"]) for r in R])
            first = [float(r["first_payout_month"]) for r in R if r["first_payout_month"] != ""]
            row.update({pre + "starts": len(R), pre + "ran_out_pct": round(100.0 * bust.mean(), 1),
                        pre + "first_payout_month_median": round(float(np.median(first)), 1) if first else "",
                        pre + "made_24m_median_usd": round(float(np.median(made))),
                        pre + "made_24m_survivors_median_usd": round(float(np.median(made[~bust]))) if (~bust).any() else "",
                        pre + "ahead_24m_pct": round(100.0 * float((made > 0).mean()), 1)})
            assert row[pre + "ran_out_pct"] == float(p[pre + "ran_out_pct"]), (p["plan"], kind)  # = plan_search's own count
        rows.append(row)
    with open(os.path.join(d, "budget_view.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"wrote budget_view.csv: {len(rows)} rows")
    for r in rows:
        print(f"${r['budget_usd']:>5,} {r['way_in'][:70]:70s} ran out {r['fut_ran_out_pct']:5.1f}% / {r['cfd_ran_out_pct']:5.1f}% | "
              f"1st payout {r['fut_first_payout_month_median']} mo | 24m: median ${r['fut_made_24m_median_usd']:,} "
              f"(not run out ${r['fut_made_24m_survivors_median_usd']:,}), ahead {r['fut_ahead_24m_pct']}% / {r['cfd_ahead_24m_pct']}%")


if __name__ == "__main__":
    main(sys.argv[1])
