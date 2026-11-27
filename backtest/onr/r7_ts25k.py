#!/usr/bin/env python3
"""Round 7, after the account test: "+F1" on Topstep's 25K (Labs Static) plan of topstep25k.py - 5 XFAs + 5 Combines,
Standard payouts, at most 5 Combines a month, 12 start dates; last 5 years and 2023-26, at 0 and 1 tick.
Descriptive (not in the pre-registration). With the book's legs alone, asserted identical to the published classes.

usage: python3 -I r7_ts25k.py DATA_DIR OUT_DIR      # writes OUT_DIR/topstep25k.csv
"""
import csv
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from multiprocessing import get_context
import numpy as np
import r7_accounts as X, research4 as R4, topstep_sim as T, topstep25k as L, account as A

def run(v, off, window, slip, cls=True):
    S = X.G["D"].S
    ek, fk = L.ek(), L.fk("standard")
    ek, fk = dict(ek, slip=slip), dict(fk, slip=slip)
    if cls:
        fk["r7legs"] = X.VARIANTS[v].get("legs", X.BOOK); ek["r7trigger"] = None
    k0 = T.start_k(S, "5y", off) if window == "5y" else int(np.searchsorted(S.days, np.datetime64("2023-01-03").astype(int))) + off
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk, gate=L.month_gate(S, L.PER_MONTH))
    cash = T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=L.PRICE)
    if window == "5y":
        per, fy = [("last 5y", T.START5, "2026-12-31")], {"last 5y": T.W.FULL_YEARS_5Y}
    else:
        per, fy = [("oos", "2023-01-03", "2026-12-31")], {"oos": ["2023", "2024", "2025"]}
    r = T.summarise_run(S, k0, cash, ev, per, fy)["periods"][per[0][0]]
    return ev, r

def job(a):
    v, off, w, slip = a
    X.G["slip"] = slip
    _, r = run(v, off, w, slip)
    return a, (r["M"], r["W"])

if __name__ == "__main__":
    X.init(sys.argv[1], 0.0)
    # parity: book legs with the round-7 classes vs the published classes
    ev1, r1 = run("book", 0, "5y", 0.0)
    R4.FundedAccount, R4.EvalAccount = A.FundedAccount, A.EvalAccount
    ev0, r0 = run("book", 0, "5y", 0.0, cls=False)
    R4.FundedAccount, R4.EvalAccount = X.Funded7, X.Eval7
    assert len(ev0) == len(ev1) and all(a[:3] == b[:3] and abs(a[3]-b[3]) < 1e-6 for a, b in zip(ev0, ev1))
    print("parity at 25K:", len(ev0), "events identical", flush=True)
    res = {}
    for slip in (0.0, 0.25):
        X.init(sys.argv[1], slip)
        jobs = [(v, o, w, slip) for v in ("book", "+F1") for w in ("5y", "oos") for o in R4.OFFSETS]
        with get_context("fork").Pool(4) as p:
            for a, mw in p.map(job, jobs):
                res.setdefault((a[0], a[2], slip), []).append(mw)
    with open(os.path.join(sys.argv[2], "topstep25k.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["variant", "window", "slip_ticks", "net_per_year", "worst_full_year"])
        for (v, win, slip), xs in sorted(res.items()):
            row = [v, win, int(slip / 0.25), round(float(np.mean([x[0] for x in xs]))), round(float(np.mean([x[1] for x in xs])))]
            w.writerow(row)
            print(row, flush=True)
