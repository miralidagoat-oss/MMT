#!/usr/bin/env python3
"""Single figures for the dashboard (kpis CSV) from a report50k.py summary.json.

usage: make_kpis.py REPORT_DIR OUT_CSV WINDOW_TEXT FULL_YEARS_TEXT [YEARS_MONTHLY_DIR]
  e.g. make_kpis.py results_50k_5y results_50k_5y/kpis.csv "Nov 15 2021 - Nov 13 2026" "2022-2025"
Same metrics, labels and units as the dashboard's 4-year kpis.csv (made by the same code earlier), without the
real-MNQ rows: those come from export_charts.py's real_kpis.csv. With YEARS_MONTHLY_DIR (the 4-year report only), also
the dashboard's years.csv and monthly.csv from the same report.
"""
import csv
import json
import os
import sys


def main(rd, out, window, full_years):
    s = json.load(open(os.path.join(rd, "summary.json")))
    k = []

    def add(sec, metric, label, value, unit, note=""):
        k.append([sec, metric, label, round(float(value), 2), unit, note])

    p, e, f, fp, b = s["pool"], s["eval"], s["funded"], s["first_payout"], s["book"]
    add("pool", "pool_net_year", "Net income per year, 5 funded 50K + eval pool", p["net_per_year_median"], "usd",
        "median of 10 start dates in the first 6 weeks")
    add("pool", "pool_net_year_low", "Lowest of the 10 start dates", p["net_per_year_range"][0], "usd")
    add("pool", "pool_net_year_high", "Highest of the 10 start dates", p["net_per_year_range"][1], "usd")
    add("pool", "pool_payouts_year", "Payouts per year", p["payouts_per_year"], "count")
    add("pool", "pool_evals_year", "Evals bought per year", p["evals_per_year"], "count")
    add("pool", "pool_months_with_payout", "Months with at least one payout", p["pct_months_with_a_payout"], "pct")
    add("pool", "pool_months_positive", "Months with positive net (after eval fees)", p["pct_months_net_positive"], "pct")
    add("pool", "pool_years_positive", f"Full calendar years with positive net ({full_years})", p["pct_full_years_positive"], "pct")
    add("pool", "pool_longest_gap", "Longest stretch with no payout", p["longest_gap_months"]["max"], "months")
    add("pool", "pool_worst_12m", "Worst 12 months of net income", p["worst_12_months"], "usd")
    add("pool", "pool_total", f"Total net, first start date ({window})", p["first_path_total"], "usd")
    add("pool", "pool_max_dd", "Largest drop in cumulative net, first start date", p["first_path_max_drawdown"], "usd")
    for q, v in p["monthly_net_percentiles"].items():
        add("pool", f"pool_month_p{q}", f"Monthly net, {q}th percentile", v, "usd")
    add("eval", "eval_pass", "Eval pass rate (evals started on every session)", e["pass_pct"], "pct", f"{e['started']} evals")
    add("eval", "eval_days_median", "Sessions to pass, median", e["sessions_to_pass"]["median"], "sessions")
    add("eval", "eval_days_p25", "Sessions to pass, 25th percentile", e["sessions_to_pass"]["p25"], "sessions")
    add("eval", "eval_days_p75", "Sessions to pass, 75th percentile", e["sessions_to_pass"]["p75"], "sessions")
    add("eval", "eval_days_p90", "Sessions to pass, 90th percentile", e["sessions_to_pass"]["p90"], "sessions")
    add("eval", "eval_fail_days_median", "Sessions to fail, median", e["sessions_to_fail_median"], "sessions")
    add("eval", "evals_per_funded", "Evals bought per funded account", e["evals_per_funded_account"], "count")
    price = float(s["eval_price"])
    add("eval", "eval_cost_per_funded", "Eval fees per funded account (list price $115)" if price == 115.0 else
        f"Eval fees per funded account (${price:.2f} each)", e["eval_cost_per_funded_account"], "usd")
    add("funded", "funded_with_payout", "Funded accounts that reach a payout", f["pct_with_a_payout"], "pct", f"{f['accounts']} funded accounts")
    add("funded", "funded_avg_payouts", "Payouts per funded account, average", f["avg_payouts"], "count")
    add("funded", "funded_avg_net", "Net withdrawn per funded account, average (after 10%)", f["avg_withdrawn_net"], "usd")
    add("funded", "funded_first_days", "Days from funding to first payout, median (when one comes)", f["days_to_first_payout"]["median"], "days")
    add("funded", "funded_first_days_p90", "Days from funding to first payout, 90th percentile", f["days_to_first_payout"]["p90"], "days")
    add("funded", "funded_done", "Funded accounts that reach all 5 payouts", f["outcome_pct"]["done"], "pct")
    add("funded", "funded_abandoned", "Funded accounts that end below the cushion level",
        f["outcome_pct"]["abandon"] + f["outcome_pct"]["blown"], "pct")
    add("funded", "funded_life", "Funded account life, median", f["median_life_days"], "days")
    add("slot", "slot_first_median", "One account slot: days from first eval to first payout, median", fp["median_days"], "days")
    for d in (30, 60, 90, 180, 365):
        add("slot", f"slot_within_{d}", f"First payout within {d} days of buying the first eval", fp[f"pct_within_{d}_days"], "pct")
    add("slot", "slot_evals_before", "Evals bought before the first payout, average", fp["avg_evals_before"], "count")
    add("book", "book_net_year", "One funded account trading every day, net per year", b["net_per_year"], "usd",
        "no resets, full $1,200 day budget")
    add("book", "book_days_positive", "Traded days that end positive", b["pct_days_positive"], "pct")
    add("book", "book_days_qualifying", "Traded days of $150 or more (Lucid qualifying day)", b["pct_days_qualifying"], "pct")
    add("book", "book_avg_day", "Average traded day", b["avg_day"], "usd")
    add("book", "book_median_day", "Median traded day", b["median_day"], "usd")
    add("book", "book_best_day", "Best day", b["best_day"], "usd")
    add("book", "book_worst_day", "Worst day", b["worst_day"], "usd")
    add("book", "book_sharpe", "Daily Sharpe ratio, annualised", b["daily_sharpe"], "ratio")
    st = s["stress_2x_costs_1_tick"]
    add("stress", "stress_net_year", "2x commission + 1 tick slippage: net per year, 5 x 50K", st["net_per_year_median"], "usd")
    add("stress", "stress_worst_12m", "2x commission + 1 tick slippage: worst 12 months", st["worst_12_months"], "usd")
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["section", "metric", "label", "value", "unit", "note"])
        w.writerows(k)
    print(f"wrote {out}: {len(k)} figures")


def years_monthly(rd, od):
    """The dashboard's years.csv and monthly.csv (4-year window) from report50k.py's tables."""
    def rows(fn):
        return list(csv.DictReader(open(os.path.join(rd, fn))))
    py = {r["year"]: r for r in rows("pool_years.csv")}
    by = {r["year"]: r for r in rows("book_years.csv")}
    ey = {r["year_started"]: r for r in rows("eval_pass_by_year.csv")}
    with open(os.path.join(od, "years.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["year", "period", "pool_net_usd", "pool_payouts", "book_net_usd", "overnight_usd", "pyramid_usd", "ib_usd",
                    "eval_pass_pct", "evals_started"])
        for y in sorted(py):
            per = "Nov 14 - Dec 31" if y == "2022" else ("Jan 1 - Nov 13" if y == "2026" else "full year")
            w.writerow([y, per, py[y]["net_usd_first_path"], py[y]["payouts_first_path"], by[y]["net_usd"], by[y]["overnight_usd"],
                        by[y]["pyramid_usd"], by[y]["ib_usd"], ey[y]["pass_pct"], ey[y]["evals"]])
    with open(os.path.join(od, "monthly.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["month", "net_usd", "cumulative_usd", "payouts", "evals_bought"])
        for r in rows("pool_monthly.csv"):
            w.writerow([r["month"], r["net_usd"], r["cumulative_usd"], r["payouts"], r["evals_bought"]])
    print(f"wrote {od}/years.csv and monthly.csv")


if __name__ == "__main__":
    main(*sys.argv[1:5])
    if len(sys.argv) > 5:
        years_monthly(sys.argv[1], sys.argv[5])
