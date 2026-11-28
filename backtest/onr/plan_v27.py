#!/usr/bin/env python3
"""Your plan (plan_search.py) and the slow start, rerun with indicator v2.7.1's defaults: the 5-minute ORB leg in
Topstep 50K and 150K XFAs (Auto), the overnight trade kept (the v2.7.1 skip switch off), Lucid unchanged.

usage: python3 -I plan_v27.py FUT_DATA_DIR OUT_DIR [--parity]

The Topstep 50K / 150K XFAs run on round 7's account class (r7_accounts.Funded7: per-contract legs in entry order);
every other account is the published class. With --parity those XFAs get the book's legs only, and every output must
then equal results_plan_search/ (the published plan) exactly: that is the check that the new run differs from the
published one by the ORB leg alone.
Writes, as plan_search.py does: reserves.json, runs.csv, round1.csv, round2.csv, car.csv, final_steps.csv, budget.csv,
budget_runs.csv, budget_monthly_runs.csv; and slow_start.csv, the slow start quoted in the chat on Nov 26 (G4: start with
$1,000 or $3,000; one Lucid 25K eval at a time; Topstep 1+1 at $3k, 2+2 at $5k, 5+5 at $9k; Lucid 50K add-on at its
reserve; Topstep 150K by the range rule at its reserve; starts every 5 sessions Dec 2019 - Nov 2022, 48 months each).
"""
import csv
import inspect
import json
import os
import sys
import textwrap
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account as ACC  # noqa: E402
import plan_search as PS  # noqa: E402
import r7_accounts as X  # noqa: E402
import research4 as R4  # noqa: E402

TOPSTEP_ORB = ("T50n", "T50s", "T150n", "T150s")   # Auto: the ORB leg on Topstep 50K and 150K only


def FA(S, **kw):
    legs = kw.pop("r7legs", None)
    return ACC.FundedAccount(S, **kw) if legs is None else X.Funded7(S, r7legs=legs, **kw)


# the plan's run() with its monthly series and step months kept (the slow-start table needs them)
_rs = textwrap.dedent(inspect.getsource(PS.run)).replace("def run(args):", "def run_series(args):")
_rs = _rs.replace("return dict(plan=name,", "return dict(series=series.tolist(), when=dict(when), plan=name,")
assert "series=series.tolist()" in _rs
exec(_rs, PS.__dict__)


def slow_start(fd, out, R):
    S = PS._S["S"]
    ts = lambda n: {"ts": (n, 2 * n, "T50n")}  # noqa: E731
    steps = [(None, {"lu": (1, 1, "L25f")}), (3000.0, ts(1)), (5000.0, ts(2)), (9000.0, ts(5)), (R["L50a"], PS.LU50),
             (R["T150n"], PS.T150R)]
    names = ["Topstep 1+1 ($3k)", "Topstep 2+2 ($5k)", "Topstep 5+5 ($9k)", f"Lucid 50K add-on 5+5 (${R['L50a']:,.0f})",
             f"Topstep 150K by range (${R['T150n']:,.0f})"]
    H = 48
    wk = PS.starts(S, PS.FUT_FIRST, "2022-11", every=5)
    jobs = [(f"{int(b)}", steps, k, b, H) for b in (1000.0, 3000.0) for k in wk]
    with get_context("fork").Pool(4, initializer=PS._init, initargs=("fut", fd)) as p:
        rows = p.map(PS.run_series, jobs, chunksize=6)
    table = []
    for b in ("1000", "3000"):
        Rr = [r for r in rows if r["plan"] == b]
        M = np.array([(r["series"] + [r["series"][-1]] * H)[:H] for r in Rr])
        bust = [r for r in Rr if r["bust_month"] != ""]
        fp = [float(r["first_payout_month"]) for r in Rr if r["first_payout_month"] != ""]
        row = dict(start_money=int(b), starts=len(Rr), ran_out=len(bust), first_payout_month_median=round(float(np.median(fp)), 1))
        for i, nm in enumerate(names, 1):
            v = [float(r["when"][i]) for r in Rr if i in r["when"]]
            row[f"{nm}: reached"] = len(v)
            row[f"{nm}: month median"] = round(float(np.median(v)), 1) if v else ""
        for y in (1, 2, 3, 4):
            tot = M[:, 12 * y - 1]
            yr = tot - (M[:, 12 * (y - 1) - 1] if y > 1 else 0)
            row.update({f"y{y} total p10": round(float(np.percentile(tot, 10))), f"y{y} total p25": round(float(np.percentile(tot, 25))),
                        f"y{y} total median": round(float(np.median(tot))), f"y{y} total p75": round(float(np.percentile(tot, 75))),
                        f"y{y} total p90": round(float(np.percentile(tot, 90))), f"y{y} made that year median": round(float(np.median(yr)))})
        fall = np.array([r["deepest_fall"] for r in Rr])
        row.update(deepest_fall_median=round(float(np.median(fall))), deepest_fall_worst=round(float(fall.min())),
                   ahead_after_4y_pct=round(100 * float(np.mean(M[:, -1] > 0))))
        table.append(row)
        print({k: v for k, v in row.items()}, flush=True)
    with open(os.path.join(out, "slow_start.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(table[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(table)


def main(fd, out, parity):
    os.makedirs(out, exist_ok=True)
    X.init(fd, 0.0)   # round 7's per-contract legs on the MNQ file (and it swaps research4's account classes: undone here)
    PS.FundedAccount = FA
    R4.FundedAccount, R4.EvalAccount = FA, ACC.EvalAccount
    legs = X.BOOK if parity else X.BOOK + ("F1",)
    for c in TOPSTEP_ORB:
        PS.CFG[c]["fk"] = dict(PS.CFG[c]["fk"], r7legs=legs)
    if not parity:
        PS.REF_SKIP.update({"T50n", "T150n"})   # their deepest falls change with the ORB leg
    PS.main(fd, "-", out)
    R = json.load(open(os.path.join(out, "reserves.json")))["reserve"]
    slow_start(fd, out, R)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--parity" in sys.argv)
