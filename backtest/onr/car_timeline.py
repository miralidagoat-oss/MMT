#!/usr/bin/env python3
"""When could the user pay cash for a $16,000 or a $32,000 car without touching the trading plan?

usage: car_timeline.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
The scaling plan (README, "Scaling up"): 5 funded + 5 evals at 50K with the 50% add-on ($90.50 an eval) until the
after-tax savings first reach $30,000; from the next session every NEW eval is a 150K eval with the 40% rule ($226.10),
so the accounts move to 150K slot by slot (evals already running finish at 50K, and a passed eval keeps its size).
Lucid's limits hold throughout: at most 5 funded and 10 accounts in all, one new eval a session, and every funded
account is closed right after its 4th payout. Trades and accounts are account.py's, unchanged.
Money rules (assumptions): Lucid keeps 10% of each payout; 30% of the running profit is set aside for tax (nothing on
a loss); $30,000 of savings always stays put as the trading reserve (150K's deepest historical drop in the running
total was about $29k-31k, mean of 12 start dates), so the car money is what is left above it:
    savings = profit so far x 0.7 (or the loss so far, untaxed); car money = savings - 30,000.
A car is affordable on the first day the car money covers its price. The script also checks whether, had it been
bought that day, the savings left would ever have gone below zero later in that history (the reserve running out).
Start dates: the first session of every month, Sep 2019 - Nov 2023 on real NQ futures (today's market) and
Mar 2011 - Nov 2023 on the Nasdaq-100 CFD (includes the weak 2011-2017 years); each start has 3+ years of data after it.
Writes car_timeline.csv (one row per start date) and car_summary.csv.
"""
import csv
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from account import EvalAccount, FundedAccount  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402
import research4 as R4  # noqa: E402

N_FUNDED, MAX_TOTAL, SPLIT = 5, 10, 0.9
TAX, RESERVE, SWITCH_AT = 0.30, 30000.0, 30000.0
CARS = (16000.0, 32000.0)
EK = {50: dict(R4.E_KW, size=50, cons=0.5), 150: dict(R4.E_KW, size=150)}
FK = {50: dict(R4.F_KW, size=50, max_pay=4), 150: dict(R4.F_KW, size=150, max_pay=4)}
FEE = {50: 90.50, 150: 226.10}
_S = {}


def load(kind, dd):
    if kind == "fut":
        return Sessions(load_npz(os.path.join(dd, "NQFUT.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5)
    return Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)


def sim_plan(S, k0, k1, switch_at=SWITCH_AT, start=50):
    """research4.sim_pool's session loop with the eval size switching from 50K to 150K once the after-tax savings
    reach switch_at. Returns (daily net cash: 90% of payouts minus eval fees, switch session or None)."""
    funded, evals, ready = [], [], []
    net = np.zeros(k1 - k0)
    cum, switched = 0.0, None
    for k in range(k0, k1):
        d = S.days[k]
        while ready and len(funded) < N_FUNDED:
            funded.append(FundedAccount(S, **FK[ready.pop(0)]))
        for _ in range(max(0, min(1, MAX_TOTAL - len(funded) - len(evals) - len(ready)))):
            size = 150 if (switched is not None or start == 150) else 50
            evals.append((EvalAccount(S, **EK[size]), size))
            net[k - k0] -= FEE[size]
        keep = []
        for f in funded:
            evn, amt = f.step(d)
            if amt > 0:
                net[k - k0] += SPLIT * amt
            if evn is None:
                keep.append(f)
        funded = keep
        keep = []
        for e, size in evals:
            res = e.step(d)
            if res == "pass":
                ready.append(size)
            elif res is None:
                keep.append((e, size))
        evals = keep
        cum += net[k - k0]
        if switched is None and cum * (1 - TAX) >= switch_at:
            switched = k
    return net, switched


def check(S, k0, k1):
    """With no switch the plan is research4.sim_pool at 50K (add-on); started at 150K it is sim_pool at 150K."""
    for size in (50, 150):
        ev = R4.sim_pool(S, N_FUNDED, MAX_TOTAL, k0, k1, EK[size], FK[size])
        ref = np.zeros(k1 - k0)
        for k, kind, _, v in ev:
            if kind == "payout":
                ref[k - k0] += SPLIT * v
            elif kind == "buy":
                ref[k - k0] -= FEE[size]
        mine, _ = sim_plan(S, k0, k1, switch_at=float("inf"), start=size)
        assert np.allclose(mine, ref), (size, float(np.abs(mine - ref).max()))


def _init(kind, dd):
    _S["S"] = load(kind, dd)


def _run(k0):
    S = _S["S"]
    net, sw = sim_plan(S, k0, len(S.days))
    cum = np.cumsum(net)
    savings = np.where(cum > 0, cum * (1 - TAX), cum)
    free = savings - RESERVE
    days = S.days[k0:]
    out = dict(start=str(np.datetime64(int(days[0]), "D")),
               switch_months=round((int(S.days[sw]) - int(days[0])) / 30.44, 1) if sw is not None else "")
    for price in CARS:
        hit = np.nonzero(free >= price)[0]
        tag = f"{int(price / 1000)}k"
        if len(hit):
            t = int(hit[0])
            out[f"car{tag}_months"] = round((int(days[t]) - int(days[0])) / 30.44, 1)
            out[f"car{tag}_date"] = str(np.datetime64(int(days[t]), "D"))
            out[f"car{tag}_safe"] = int(float((savings[t:] - price).min()) >= 0.0)
        else:
            out[f"car{tag}_months"], out[f"car{tag}_date"], out[f"car{tag}_safe"] = "", "", ""
    yrs = (int(days[-1]) - int(days[0])) / 365.25
    out["net_per_year_usd"] = round(float(cum[-1]) / yrs)
    out["years_of_data"] = round(yrs, 1)
    return out


def starts(S, first, last):
    k0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))
    seen, ks = set(), []
    for k in range(k0, len(S.days)):
        m = str(np.datetime64(int(S.days[k]), "D").astype("datetime64[M]"))
        if first <= m <= last and m not in seen:
            seen.add(m)
            ks.append(k)
    return ks


def main(fd, dd, out):
    os.makedirs(out, exist_ok=True)
    rows = []
    for kind, data, first, last in (("futures", fd, "2019-09", "2023-11"), ("CFD", dd, "2011-03", "2023-11")):
        S = load("fut" if kind == "futures" else "cfd", data)
        ks = starts(S, first, last)
        check(S, ks[0], min(ks[0] + 400, len(S.days)))
        print(f"{kind}: {len(ks)} start dates {first} - {last}; check passed (no switch = sim_pool at 50K and at 150K)", flush=True)
        with Pool(4, initializer=_init, initargs=("fut" if kind == "futures" else "cfd", data)) as p:
            for r in p.map(_run, ks, chunksize=2):
                rows.append(dict(data=kind, **r))
    with open(os.path.join(out, "car_timeline.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    summ = []
    for kind in ("futures", "CFD"):
        R = [r for r in rows if r["data"] == kind]
        for key, label in (("switch_months", "switch to 150K ($30,000 saved after tax)"),
                           ("car16k_months", "$16,000 car paid in cash above the reserve"),
                           ("car32k_months", "$32,000 car paid in cash above the reserve")):
            v = np.array([float(r[key]) for r in R if r[key] != ""])
            miss = sum(1 for r in R if r[key] == "")
            safe = [r[key.replace("_months", "_safe")] for r in R if r[key] != ""] if key != "switch_months" else []
            summ.append(dict(data=kind, milestone=label, starts=len(R), reached=len(v), not_reached=miss,
                             months_median=round(float(np.median(v)), 1), months_p75=round(float(np.percentile(v, 75)), 1),
                             months_p90=round(float(np.percentile(v, 90)), 1), months_worst=round(float(v.max()), 1),
                             months_best=round(float(v.min()), 1),
                             safe_pct=round(100 * float(np.mean(safe)), 1) if safe else ""))
    with open(os.path.join(out, "car_summary.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(summ[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(summ)
    for s in summ:
        print(s, flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
