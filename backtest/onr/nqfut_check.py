#!/usr/bin/env python3
"""Real NQ futures vs the CFD, trade by trade, on the sessions where prep_nqfut.py's series is the futures file
(Aug 2019 -> Aug 9 2024). Same rules, $1.34 commission, Lucid Flex 50K.

usage: nqfut_check.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
  FUT_DATA_DIR: NQFUT.npz (+ .json) and SPXUSD.npz; CFD_DATA_DIR: NSXUSD.npz, SPXUSD.npz.
Three versions of the same sessions:
  futures 5-min   the repaired futures file (5-minute bars)
  CFD 5-min       the CFD's 1-minute bars made into 5-minute bars: futures vs this isolates the data source
  CFD 1-min       the CFD as every earlier backtest used it: CFD 5-min vs this isolates the bar size
Per session, one funded account trading the full book with the full day budget (as report50k.book), and an eval
started on that session with the 40% rule and with the 50% add-on. Writes nqfut_check.csv (by year) and summary.txt.
"""
import csv
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from account import FundedAccount, run_eval  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402
from prep_nqfut import resample5  # noqa: E402

COMM = 1.34
E_KW = dict(improved=True, comm=COMM, size=50)
F_KW = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=COMM, size=50, payout_max=True)
CFD_BAD = ("2023-02-01", "2023-07-31")  # HistData NSXUSD misses large parts of the day session in these months


def iso(d):
    return str(np.datetime64(int(d), "D"))


def book_day(S, d):
    rec = []
    FundedAccount(S, record=rec, **F_KW).step(d)
    return {leg: (side, p) for _, leg, side, p in rec}


def main(fd, cd, out):
    os.makedirs(out, exist_ok=True)
    info = json.load(open(os.path.join(fd, "NQFUT.npz.json")))
    fut_last = info["segments"][0]["last"][:10]
    spx_f = load_npz(os.path.join(fd, "SPXUSD.npz"))
    F = Sessions(load_npz(os.path.join(fd, "NQFUT.npz")), spx_f, tf=5)
    nq = load_npz(os.path.join(cd, "NSXUSD.npz"))
    spx_c = load_npz(os.path.join(cd, "SPXUSD.npz"))
    C1 = Sessions(nq, spx_c, tf=1)
    C5 = Sessions(resample5(*nq), spx_c, tf=5)
    sets = {"futures 5-min": F, "CFD 5-min": C5, "CFD 1-min": C1}
    days = [d for d in F.days if d in C1.S and d in C5.S and iso(d) <= fut_last
            and all(not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for S in sets.values())]
    print(f"{len(days)} sessions {iso(days[0])} -> {iso(days[-1])} where all three have an ADR and a score", flush=True)
    books = {n: {d: book_day(S, d) for d in days} for n, S in sets.items()}
    evals = {}
    for n, S in sets.items():
        pos = {d: k for k, d in enumerate(S.days)}
        for cons in (0.4, 0.5):
            kw = dict(E_KW, **({} if cons == 0.4 else dict(cons=cons)))
            evals[(n, cons)] = {d: run_eval(S, pos[d], **kw)["result"] for d in days}
    rows, lines = [], []

    def say(s=""):
        print(s, flush=True)
        lines.append(s)
    say(f"Real NQ futures vs the CFD, {iso(days[0])} -> {iso(days[-1])} ({len(days)} sessions); CFD defective "
        f"{CFD_BAD[0]} -> {CFD_BAD[1]}")
    groups = [(str(y), lambda d, y=y: iso(d)[:4] == str(y)) for y in range(2019, 2025)]
    groups += [("all", lambda d: True), ("all but Feb-Jul 2023", lambda d: not (CFD_BAD[0] <= iso(d) <= CFD_BAD[1]))]
    for lab, f in groups:
        ds = [d for d in days if f(d)]
        net = {}
        for n, b in books.items():
            net[n] = float(sum(sum(p for _, p in b[d].values()) for d in ds))
        dayf = np.array([sum(p for _, p in books["futures 5-min"][d].values()) for d in ds])
        dayc5 = np.array([sum(p for _, p in books["CFD 5-min"][d].values()) for d in ds])
        dayc1 = np.array([sum(p for _, p in books["CFD 1-min"][d].values()) for d in ds])
        same_side = np.mean([books["futures 5-min"][d].get(leg, (0,))[0] == books["CFD 5-min"][d].get(leg, (0,))[0]
                             for d in ds for leg in ("on", "pyr", "ib")])
        ep = {k: 100 * np.mean([v[d] == "pass" for d in ds if v[d] != "open"]) for k, v in evals.items()}
        yrs = max(len(ds) / 252.0, 1e-9)
        row = [lab, len(ds), round(net["futures 5-min"] / yrs), round(net["CFD 5-min"] / yrs), round(net["CFD 1-min"] / yrs),
               round(float(np.corrcoef(dayf, dayc5)[0, 1]), 3), round(float(np.corrcoef(dayc5, dayc1)[0, 1]), 3),
               round(100 * float(same_side), 1),
               round(ep[("futures 5-min", 0.4)], 1), round(ep[("CFD 5-min", 0.4)], 1), round(ep[("CFD 1-min", 0.4)], 1),
               round(ep[("futures 5-min", 0.5)], 1), round(ep[("CFD 5-min", 0.5)], 1), round(ep[("CFD 1-min", 0.5)], 1)]
        rows.append(row)
        say(f"  {lab:21s} n {len(ds):4d} | one funded account a year: futures ${row[2]:>8,} CFD-5 ${row[3]:>8,} CFD-1 ${row[4]:>8,} "
            f"| daily corr fut/CFD5 {row[5]:.2f}, CFD5/CFD1 {row[6]:.2f} | same trade side {row[7]}% "
            f"| eval pass 40%: {row[8]}/{row[9]}/{row[10]} | add-on: {row[11]}/{row[12]}/{row[13]}")
    with open(os.path.join(out, "nqfut_check.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["period", "sessions", "book_net_per_year_futures_usd", "book_net_per_year_cfd5_usd", "book_net_per_year_cfd1_usd",
                    "daily_corr_futures_cfd5", "daily_corr_cfd5_cfd1", "same_side_pct", "eval_pass_40_futures_pct",
                    "eval_pass_40_cfd5_pct", "eval_pass_40_cfd1_pct", "eval_pass_addon_futures_pct", "eval_pass_addon_cfd5_pct",
                    "eval_pass_addon_cfd1_pct"])
        w.writerows(rows)
    open(os.path.join(out, "summary.txt"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
