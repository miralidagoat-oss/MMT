#!/usr/bin/env python3
"""Scaling up: the user's plan at every LucidFlex size (25K, 50K, 100K, 150K).

usage: scale_sizes.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
The plan at each size: 5 funded + 5 evals in reserve (Lucid's limit counts every funded account together, whatever its
size), one new eval a day, each funded account closed right after its 4th payout, the indicator's rules with every $
limit scaled by the size's max loss / $1,000 (account.RULES: Lucid's targets, max losses, qualifying days, payout caps
and position limits, re-read on Lucid's help centre on Nov 20 2026). Machinery: site_v23.py's (research round 5's
pool, 12 start dates, eval price passed per run).
Prices (account.USER_EVAL / USER_ADDON, the user's own with Lucid's 30% discount code, Nov 23 2026): an eval costs $50.30
at 25K and $88.20 at 50K, and the 50% consistency add-on $10 more at either size. 100K and 150K are not confirmed: 30% off
the earlier list prices ($215 / $323: $150.50 / $226.10) with the same $10 add-on is assumed. Prices are only
bookkeeping: no trade depends on one.
Runs: real NQ futures over the last 5 years (from Nov 15 2021) and from Aug 30 2019, and the Nasdaq-100 CFD from Feb
2011 (every year), each with the add-on and with the 40% rule. Runs already in OUT_DIR/runs.json are reused when they
were made on the same price files and at the same eval prices (OUT_DIR/runs_data.json keeps each data folder's sha256 and
the prices); any other run is made again.
Writes sizes.csv (one row per window, size and rule), sizes_years.csv (net by calendar year, median / lowest / highest of
the 12 start dates) and runs.json; window ids, configs and year labels follow topstep_sim.py's tables.
"""
import csv
import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import site_v23 as V  # noqa: E402  (futures loader swap; account functions without export_charts' wrappers)
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from account import USER_ADDON, USER_EVAL, USER_TAG  # noqa: E402

SIZES = (25, 50, 100, 150)
PRICE = {s: USER_EVAL[s] for s in SIZES}  # the user's eval prices (25K and 50K confirmed; 100K and 150K assumed)
ADDON = {s: USER_ADDON for s in SIZES}    # the add-on: $10 at 25K and 50K (confirmed), assumed the same above
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


def data_id(d, names):
    """sha256 of the price files a run reads, so a saved run is reused only on the same data."""
    h = hashlib.sha256()
    for n in names:
        with open(os.path.join(d, n), "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()


def main(fd, dd, out):
    os.makedirs(out, exist_ok=True)
    print("eval prices:", PRICE, "add-on:", ADDON, flush=True)
    rp, dp = os.path.join(out, "runs.json"), os.path.join(out, "runs_data.json")  # runs made on the same data are reused
    ids = {"F": data_id(fd, ("NQFUT.npz", "SPXUSD.npz")), "C": data_id(dd, ("NSXUSD.npz", "SPXUSD.npz")),
           "prices": json.dumps({"eval": PRICE, "addon": ADDON}, sort_keys=True)}
    seen = json.load(open(dp)) if os.path.exists(dp) else {}
    res = {tuple(k.rsplit("|", 2)[:2]) + (int(k.rsplit("|", 1)[1]),): v for k, v in json.load(open(rp)).items()} if os.path.exists(rp) else {}
    # a run on other price files, or at other eval prices (its net includes the fees), is made again
    res = {k: v for k, v in res.items() if seen.get(k[0][0]) == ids[k[0][0]] and seen.get("prices") == ids["prices"]}
    for prefix, data, windows in (("F", fd, ("5y", "all")), ("C", dd, ("all",))):
        todo = [j for j in jobs(prefix, windows, ("addon", "40")) if (j[0], j[2], j[3]) not in res]
        if todo:
            R4._init = V.FUT_INIT if prefix == "F" else V.CFD_INIT
            res.update(R5.run_jobs(data, data, todo, {"nq"}))
            print(f"ran {len(todo)} {prefix} jobs", flush=True)
    R4._init = V.FUT_INIT
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in res.items()}, open(rp, "w"))
    json.dump(ids, open(dp, "w"), indent=1)
    # 50K with the add-on is the website's plan: live50k.py's B5-addon-stop4 at the user's price (results_live<USER_TAG>_addon10)
    m50 = float(np.mean([res[("F50-addon", "5y", o)]["periods"]["last 5y"]["M"] for o in OFF]))
    lv = {r["id"]: r for r in csv.DictReader(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                               f"results_live{USER_TAG}_addon10", "lucid_5y.csv")))}["B5-addon-stop4"]
    assert float(lv["eval_price_usd"]) == PRICE[50] + ADDON[50] and abs(m50 - float(lv["net_per_year_usd"])) < 1.0, (m50, lv)
    print(f"check passed: 50K with the add-on = the website's plan (live50k.py, ${m50:,.0f} a year)", flush=True)
    # window ids, configs and year labels as in topstep_sim.py's tables, so the website can set the two side by side
    spec = [("futures, last 5 years", "5y", "F", "5y", "last 5y", [str(y) for y in range(2022, 2026)], "from Nov 15", "to Nov 17"),
            ("futures, from Aug 30 2019", "2019", "F", "all", "2019-26", [str(y) for y in range(2020, 2026)], "from Aug 30", "to Nov 17"),
            ("CFD, from Feb 2011", "2011", "C", "all", "all years", [str(y) for y in range(2012, 2026)], "from Feb 15", "to Nov 13")]
    rows, yrows = [], []
    for label, wid, p, w, per, fy, first, last in spec:
        for s in SIZES:
            for tag in ("addon", "40"):
                R = [res[(f"{p}{s}-{tag}", w, o)] for o in OFF]
                rule = "50% add-on" if tag == "addon" else "40% rule"
                rows.append(dict(id=f"{wid}-{s}-{tag}", window_id=wid, config=f"{s}-{tag}", window=label, size=f"{s}K", rule=rule,
                                 eval_price_usd=round(PRICE[s] + (ADDON[s] if tag == "addon" else 0.0), 2),
                                 **summarise(R, per, fy)))
                years = sorted({y for r in R for y in r["years"]})
                for y in years:
                    v = [r["years"][y]["net"] for r in R if y in r["years"]]
                    yl = y + (f" ({first})" if y == years[0] else f" ({last})" if y == years[-1] else "")
                    yrows.append(dict(window_id=wid, config=f"{s}-{tag}", window=label, size=f"{s}K", rule=rule,
                                      year=y, year_label=yl, net_median_usd=round(float(np.median(v))), net_low_usd=round(min(v)),
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
