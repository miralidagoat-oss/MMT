#!/usr/bin/env python3
"""Topstep month by month: every month of every Topstep configuration (topstep_sim.py's runs, same pools, same costs).

usage: topstep_months.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
Reruns topstep_sim.py's 216 pools (3 sizes x 2 payout paths x 12 start dates on futures over the last 5 years and from
Aug 30 2019, and on the Nasdaq-100 CFD from Feb 15 2011) and keeps each month. Checks: each run's monthly cash adds up to
topstep_sim.cash_flows exactly, and each year's total equals results_topstep/runs.json.
Writes
  topstep_months.csv       one row per window, configuration and calendar month: net to you, the median, lowest and
                           highest of the 12 start dates; then the first start date's month in full: Combines bought,
                           passed and failed, XFAs started and lost, payouts (count, gross, Topstep's 10%), Combine fees,
                           activation fees, net, running total, and the XFAs and Combines open at the month's end
  topstep_month_stats.csv  per window and configuration, over the first start date's months: months, months up / down /
                           flat, months with a payout, median month, 1 month in 10 below, worst and best month (and
                           which), the longest run of months without a payout and of losing months
"""
import csv
import json
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402

FEES = ("standard", "noact")


def month_detail(S, k0, ev, fee_path, size):
    """Per calendar month: counts and cash by kind. The fees follow topstep_sim.cash_flows exactly."""
    n = len(S.days) - k0
    kinds = ("payout_gross", "share", "combine_fee", "activation")
    cash = {x: np.zeros(n) for x in kinds}
    cnt = {x: np.zeros(n, dtype=int) for x in ("bought", "passed", "failed", "funded", "lost", "payouts")}
    end = {aid: k for k, kind, aid, _ in ev if kind in ("pass", "fail")}
    for k, kind, aid, v in ev:
        i = k - k0
        if kind == "payout":
            cash["payout_gross"][i] += v
            cash["share"][i] -= (1 - T.SPLIT) * v
            cnt["payouts"][i] += 1
        elif kind == "buy":
            cnt["bought"][i] += 1
            ke = end.get(aid, len(S.days) - 1)
            d0, j = int(S.days[k]), 0
            while d0 + 30 * j <= int(S.days[ke]):
                kc = int(np.searchsorted(S.days, d0 + 30 * j))
                cash["combine_fee"][min(kc, ke) - k0] -= T.PRICE[fee_path][size]
                j += 1
        elif kind == "fund":
            cnt["funded"][i] += 1
            cash["activation"][i] -= T.ACTIVATION[fee_path]
        elif kind == "pass":
            cnt["passed"][i] += 1
        elif kind == "fail":
            cnt["failed"][i] += 1
        elif kind.startswith("end:"):
            cnt["lost"][i] += 1
    net = cash["payout_gross"] + cash["share"] + cash["combine_fee"] + cash["activation"]
    ref = T.cash_flows(S, k0, ev, fee_path, size)
    assert np.allclose(net, ref, atol=1e-6), "monthly cash differs from topstep_sim.cash_flows"
    open_x = np.cumsum(cnt["funded"] - cnt["lost"])
    open_c = np.cumsum(cnt["bought"] - cnt["passed"] - cnt["failed"])
    months = {}
    for i in range(n):
        m = T.iso(S, k0 + i)[:7]
        r = months.setdefault(m, dict(first=T.iso(S, k0 + i), **{x: 0.0 for x in kinds}, **{x: 0 for x in cnt}, net=0.0))
        for x in kinds:
            r[x] += float(cash[x][i])
        for x in cnt:
            r[x] += int(cnt[x][i])
        r["net"] += float(net[i])
        r["last"], r["open_xfa"], r["open_combines"] = T.iso(S, k0 + i), int(open_x[i]), int(open_c[i])
    return months


def _job(args):
    window, off, size, path = args
    S = T._S["S"]
    k0 = T.start_k(S, window, off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), T.ek(size), T.fk(size, path))
    return (T._S["kind"], window, off, size, path), {f: month_detail(S, k0, ev, f, size) for f in FEES}


def streak(flags):
    best = cur = 0
    for f in flags:
        cur = cur + 1 if f else 0
        best = max(best, cur)
    return best


def main(fd, dd, out):
    res = {}
    for kind, data, windows in (("fut", fd, ("5y", "all")), ("cfd", dd, ("all",))):
        jobs = [(w, o, s, p) for w in windows for s in T.SIZES for p in ("standard", "consistency") for o in T.OFF]
        with Pool(4, initializer=T._init, initargs=(kind, data)) as pool:
            res.update(dict(pool.map(_job, jobs, chunksize=2)))
        print(f"{kind}: {len(jobs)} runs", flush=True)
    # each year's total equals topstep_sim's runs.json
    raw = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results_topstep", "runs.json")))
    for key, v in res.items():
        for f in FEES:
            yrs = {}
            for m, r in v[f].items():
                yrs[m[:4]] = yrs.get(m[:4], 0.0) + r["net"]
            want = raw["|".join(map(str, key))][f]["years"]
            assert set(yrs) == set(want) and all(abs(yrs[y] - want[y]) < 1e-6 for y in yrs), (key, f)
    print("check passed: every run's months add up to results_topstep/runs.json's years", flush=True)
    lab = {("fut", "5y"): "5y", ("fut", "all"): "2019", ("cfd", "all"): "2011"}
    rows, stats = [], []
    for (kind, window), wid in lab.items():
        for size in T.SIZES:
            for path in ("standard", "consistency"):
                for f in FEES:
                    runs = [res[(kind, window, o, size, path)][f] for o in T.OFF]
                    first = runs[0]
                    cfg = f"{size}-{path}-{f}"
                    run_total = 0.0
                    for m in sorted(first):
                        r = first[m]
                        v = [x[m]["net"] for x in runs if m in x]
                        run_total += r["net"]
                        rows.append(dict(window_id=wid, config=cfg, month=m, starts=len(v), net_median_usd=round(float(np.median(v))),
                                         net_low_usd=round(min(v)), net_high_usd=round(max(v)), combines_bought=r["bought"],
                                         combines_passed=r["passed"], combines_failed=r["failed"], xfas_started=r["funded"],
                                         xfas_lost=r["lost"], payouts=r["payouts"], payouts_usd=round(r["payout_gross"]),
                                         topstep_share_usd=round(r["share"]), combine_fees_usd=round(r["combine_fee"]),
                                         activation_fees_usd=round(r["activation"]), net_usd=round(r["net"]), running_usd=round(run_total),
                                         xfas_open=r["open_xfa"], combines_open=r["open_combines"]))
                    ms = sorted(first)
                    nets = np.array([first[m]["net"] for m in ms])
                    paid = [first[m]["payouts"] > 0 for m in ms]
                    worst, best = int(np.argmin(nets)), int(np.argmax(nets))
                    stats.append(dict(id=f"{wid}-{cfg}", window_id=wid, config=cfg, first_start=first[ms[0]]["first"], months=len(ms),
                                      months_up=int((nets > 0.5).sum()), months_down=int((nets < -0.5).sum()),
                                      months_flat=int((np.abs(nets) <= 0.5).sum()), months_paid=int(sum(paid)),
                                      median_month_usd=round(float(np.median(nets))), p10_month_usd=round(float(np.percentile(nets, 10))),
                                      worst_month_usd=round(float(nets[worst])), worst_month=ms[worst],
                                      best_month_usd=round(float(nets[best])), best_month=ms[best],
                                      longest_unpaid_months=streak([not p for p in paid]), longest_losing_months=streak(list(nets < -0.5))))
    T.write_csv(out, "topstep_months.csv", rows)
    T.write_csv(out, "topstep_month_stats.csv", stats)


if __name__ == "__main__":
    main(*sys.argv[1:4])
