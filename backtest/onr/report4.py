#!/usr/bin/env python3
"""Dashboard tables from research4.py's output (results_r4/runs.json, accounts_by_year.csv, accounts_summary.csv).

usage: report4.py RESULTS_R4_DIR OUT_DIR
Writes: accounts_table.csv (one row per structure and number of accounts, all years and last 4 years side by side),
accounts_years_wide.csv (median net of every year for 1-5 accounts, both structures), r4_configs.csv (round-4 setups).
Every value is copied or averaged from the simulation output; nothing is typed in.
"""
import csv
import json
import os
import sys

import numpy as np

OFFSETS = tuple(range(0, 60, 5))


def main(src, out):
    os.makedirs(out, exist_ok=True)
    S = list(csv.DictReader(open(os.path.join(src, "accounts_summary.csv"))))
    Y = list(csv.DictReader(open(os.path.join(src, "accounts_by_year.csv"))))
    runs = json.load(open(os.path.join(src, "runs.json")))
    label = {"A": "N accounts bought the same day (copy-traded in lockstep)",
             "C": "N accounts, each an eval then funded, at most one new eval a day",
             "B": "N funded + N evals in reserve"}
    rows = []
    for st in ("C", "B", "A"):
        for n in range(1, 6):
            a = next(r for r in S if r["structure"] == st and r["accounts"] == str(n) and r["period"] == "all years")
            f = next(r for r in S if r["structure"] == st and r["accounts"] == str(n) and r["period"] == "last 4y")
            rows.append([f"{st}{n}", label[st], n, a["net_per_year_usd"], f["net_per_year_usd"], a["worst_full_year_usd"],
                         a["losing_full_years"], a["deepest_drop_usd"], a["worst_12_months_usd"], a["longest_gap_months"],
                         a["months_with_payout_pct"], a["evals_per_year"], a["eval_pass_pct"], a["eval_median_sessions"],
                         a["funded_accounts"], a["funded_with_payout_pct"], a["payouts"], a["average_payout_usd"],
                         a["most_cash_out_usd"], f["eval_pass_pct"], f["worst_full_year_usd"], f["most_cash_out_usd"]])
    with open(os.path.join(out, "accounts_table.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["id", "structure", "accounts", "net_year_all_usd", "net_year_4y_usd", "worst_year_usd", "losing_years",
                    "deepest_drop_usd", "worst_12m_usd", "longest_gap_months", "months_with_payout_pct", "evals_per_year",
                    "eval_pass_pct", "eval_median_sessions", "funded_accounts", "funded_with_payout_pct", "payouts",
                    "average_payout_usd", "most_cash_out_usd", "eval_pass_pct_4y", "worst_year_4y_usd", "most_cash_out_4y_usd"])
        w.writerows(rows)
    years = sorted({r["year"] for r in Y})
    by = {(r["structure"], r["accounts"], r["year"]): r for r in Y}
    wide = []
    for y in years:
        row = [y]
        for st in ("C", "B"):
            for n in range(1, 6):
                r = by[(label[st], str(n), y)]
                row += [r["net_median_usd"], r["net_lowest_usd"], r["net_highest_usd"], r["eval_pass_pct"],
                        r["payouts_median"], r["evals_bought_median"]]
        wide.append(row)
    with open(os.path.join(out, "accounts_years_wide.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["year"] + [f"{st.lower()}{n}_{k}" for st in ("C", "B") for n in range(1, 6)
                               for k in ("net_usd", "net_low_usd", "net_high_usd", "eval_pass_pct", "payouts", "evals")])
        w.writerows(wide)
    # round-4 setups: means over the 12 start dates, recomputed from every run
    names = sorted({k.split("|")[0] for k in runs})
    fam = {"B5": "base", "P": "placebo", "T": "throttle", "R": "risk level", "V": "eval reserve"}
    cfg = []
    for n in ["B5"] + [x for x in names if x[0] in "PTRV"]:
        vals = []
        for p, wnd in (("2011-18", "all"), ("2019-26", "all"), ("last 4y", "4y")):
            R = [runs[f"{n}|{wnd}|{o}"]["periods"][p] for o in OFFSETS]
            vals += [round(float(np.mean([r[k] for r in R])), 2 if k == "L" else 0) for k in ("M", "W", "L", "D")]
        cfg.append([n, fam.get(n, fam.get(n[0], ""))] + vals)
    with open(os.path.join(out, "r4_configs.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["setup", "family"] + [f"{p}_{k}" for p in ("s", "v", "l4") for k in ("net_year_usd", "worst_year_usd",
                                                                                         "losing_years", "deepest_drop_usd")])
        w.writerows(cfg)
    print(f"wrote accounts_table.csv ({len(rows)}), accounts_years_wide.csv ({len(wide)}), r4_configs.csv ({len(cfg)})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
