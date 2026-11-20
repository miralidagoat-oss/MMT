#!/usr/bin/env python3
"""Scaling up: the user's plan at every LucidFlex size (25K, 50K, 100K, 150K).

usage: scale_sizes.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
The plan at each size: 5 funded + 5 evals in reserve (Lucid's limit counts every funded account together, whatever its
size), one new eval a day, each funded account closed right after its 4th payout, the indicator's rules with every $
limit scaled by the size's max loss / $1,000 (account.RULES: Lucid's targets, max losses, qualifying days, payout caps
and position limits, re-read on Lucid's help centre on Nov 20 2026). Machinery: site_v23.py's (research round 5's
pool, 12 start dates, eval price passed per run).
Prices (Lucid's list prices in account.RULES, $65 / $115 / $215 / $323): the user's discount code takes 30% off the 50K
eval ($115 -> $80.50); the same 30% is assumed at every size. The 50% consistency add-on costs the user $10 at 50K
(12.4% of $80.50); the same share is assumed at the other sizes. Prices are only bookkeeping: no trade depends on one.
Runs: real NQ futures over the last 5 years (from Nov 15 2021) and from Aug 30 2019, and the Nasdaq-100 CFD from Feb
2011 (every year), each with the add-on and with the 40% rule. Runs already in OUT_DIR/runs.json are reused.
Writes sizes.csv (one row per window, size and rule), sizes_years.csv (net by calendar year, median of the 12 start
dates) and runs.json.
"""
import csv
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import site_v23 as V  # noqa: E402  (futures loader swap; account functions without export_charts' wrappers)
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from account import RULES  # noqa: E402

SIZES = (25, 50, 100, 150)
DISCOUNT = 80.50 / 115.0  # the user's 50K price over Lucid's list price
PRICE = {s: (80.50 if s == 50 else round(RULES[s]["price"] * DISCOUNT, 2)) for s in SIZES}
ADDON = {s: (10.0 if s == 50 else round(10.0 / 80.50 * PRICE[s], 2)) for s in SIZES}
OFF = R4.OFFSETS
RULE = {"addon": 0.5, "40": 0.4}


def cfg(size, cons):
    ek = dict(size=size, **({"cons": 0.5} if cons == 0.5 else {}))
    return R5.nq(ek=ek, fk=dict(size=size, max_pay=4), N=5, mt=10)


def jobs(prefix, windows, tags):
    out = []
    for s in SIZES:
        for tag in tags:
            fee = PRICE[s] + (ADDON[s] if tag == "addon" else 0.0)
            for w in windows:
                out += [(f"{prefix}{s}-{tag}", [cfg(s, RULE[tag])], w, o, fee) for o in OFF]
    return out


def summarise(R, period, full_years):
    g = lambda k: float(np.mean([r["periods"][period][k] for r in R]))  # noqa: E731
    wy = [min(r["years"][y]["net"] for y in full_years if y in r["years"]) for r in R]
    ly = [sum(r["years"][y]["net"] < 0 for y in full_years if y in r["years"]) for r in R]
    ev = lambda k: float(np.mean([r["evals"][k] for r in R]))  # noqa: E731
    fu = lambda k: float(np.mean([r["funded"][k] for r in R]))  # noqa: E731
    return dict(net_per_year_usd=round(g("M")), worst_full_year_usd=round(float(np.mean(wy))),
                losing_full_years=round(float(np.mean(ly)), 2), deepest_drop_usd=round(g("D")),
                worst_12_months_usd=round(g("worst12")), longest_gap_months=round(g("gap"), 1),
                months_with_payout_pct=round(g("months_paid"), 1), evals_per_year=round(g("evals_yr"), 1),
                most_cash_out_usd=round(float(np.mean([r["cash_low"] for r in R]))),
                eval_pass_pct=round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                funded_with_payout_pct=round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1),
                payouts=round(fu("payouts"), 1), average_payout_usd=round(fu("payouts_usd") / max(fu("payouts"), 1e-9)))


def main(fd, dd, out):
    os.makedirs(out, exist_ok=True)
    print("eval prices:", PRICE, "add-on (assumed except at 50K):", ADDON, flush=True)
    rp = os.path.join(out, "runs.json")  # runs already made are reused: only missing ones run
    res = {tuple(k.rsplit("|", 2)[:2]) + (int(k.rsplit("|", 1)[1]),): v for k, v in json.load(open(rp)).items()} if os.path.exists(rp) else {}
    for prefix, data, windows in (("F", fd, ("5y", "all")), ("C", dd, ("all",))):
        todo = [j for j in jobs(prefix, windows, ("addon", "40")) if (j[0], j[2], j[3]) not in res]
        if todo:
            R4._init = V.FUT_INIT if prefix == "F" else V.CFD_INIT
            res.update(R5.run_jobs(data, data, todo, {"nq"}))
            print(f"ran {len(todo)} {prefix} jobs", flush=True)
    R4._init = V.FUT_INIT
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in res.items()}, open(rp, "w"))
    # 50K with the add-on is the website's plan: live50k.py / site_v23.py's $59,716 a year over the last 5 years
    m50 = float(np.mean([res[("F50-addon", "5y", o)]["periods"]["last 5y"]["M"] for o in OFF]))
    assert abs(m50 - 59716) < 1.0, m50
    print(f"check passed: 50K with the add-on = the website's plan (${m50:,.0f} a year)", flush=True)
    spec = [("futures, last 5 years", "F", "5y", "last 5y", [str(y) for y in range(2022, 2026)], ("addon", "40")),
            ("futures, from Aug 30 2019", "F", "all", "2019-26", [str(y) for y in range(2020, 2026)], ("addon", "40")),
            ("CFD, from Feb 2011", "C", "all", "all years", [str(y) for y in range(2012, 2026)], ("addon", "40"))]
    rows, yrows = [], []
    for label, p, w, per, fy, tags in spec:
        for s in SIZES:
            for tag in tags:
                R = [res[(f"{p}{s}-{tag}", w, o)] for o in OFF]
                rows.append(dict(window=label, size=f"{s}K", rule="50% add-on" if tag == "addon" else "40% rule",
                                 eval_price_usd=round(PRICE[s] + (ADDON[s] if tag == "addon" else 0.0), 2),
                                 **summarise(R, per, fy)))
                for y in sorted({y for r in R for y in r["years"]}):
                    v = [r["years"][y]["net"] for r in R if y in r["years"]]
                    yrows.append(dict(window=label, size=f"{s}K", rule="50% add-on" if tag == "addon" else "40% rule",
                                      year=y, net_median_usd=round(float(np.median(v))), net_low_usd=round(min(v)),
                                      net_high_usd=round(max(v))))
    for name, data in (("sizes.csv", rows), ("sizes_years.csv", yrows)):
        with open(os.path.join(out, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0]), lineterminator="\n")
            w.writeheader()
            w.writerows(data)
        print(f"wrote {name}: {len(data)} rows", flush=True)
    for r in rows:
        print(f"{r['window']:27s} {r['size']:>5s} {r['rule']:10s} ${r['eval_price_usd']:>7,.2f}  net ${r['net_per_year_usd']:>8,}/yr  "
              f"worst yr ${r['worst_full_year_usd']:>8,}  worst 12m ${r['worst_12_months_usd']:>8,}  drop ${r['deepest_drop_usd']:>8,}  "
              f"cash out ${r['most_cash_out_usd']:>7,}  pass {r['eval_pass_pct']}%", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
