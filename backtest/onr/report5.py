#!/usr/bin/env python3
"""Tables for the dashboard from research5.py's output (the last 5 years first).

usage: report5.py RESULTS_R5_DIR
writes accounts_5y.csv (1-5 accounts, last 5 years, one row per setup with an id), accounts_5y_years_wide.csv (every
year of the last 5 years, one column per setup) and r5_configs.csv (every candidate of rounds 3-5 against the current
rules: last 5 years and 2011-21, with rule 5Y's verdict, recomputed here from runs.json and checked against
decisions.txt).
"""
import csv
import json
import os
import sys

import numpy as np

OFFSETS = tuple(range(0, 60, 5))
NAME = {"BASE": "Current rules (5 funded + 5 evals)",
        "P thr 0.712": "Placebo: score threshold 0.712 (not 0.7187)", "P thr 0.715": "Placebo: score threshold 0.715",
        "P thr 0.722": "Placebo: score threshold 0.722", "P thr 0.725": "Placebo: score threshold 0.725",
        "P size ref 340": "Placebo: size reference 340 (not 350)", "P size ref 345": "Placebo: size reference 345",
        "P size ref 355": "Placebo: size reference 355", "P size ref 360": "Placebo: size reference 360",
        "A f=0.4 (risk by cushion)": "Risk tied to the cushion (0.4)", "A f=0.6 (risk by cushion)": "Risk tied to the cushion (0.6)",
        "B day budget 800 x M": "Funded day budget $1,600 (not $1,200)", "C eval risk x0.5": "Eval risk 0.5x",
        "C eval risk x0.75": "Eval risk 0.75x", "D1 eval 09:35 drive only": "Eval trades the 09:35 drive only",
        "D2 eval skips overnight sells": "Eval skips overnight sells", "E second pyramid add +0.30": "Pyramid adds again at +0.30 ADR",
        "F overnight exit 04:00": "Overnight trades exit at 04:00 ET", "T 63 sessions": "No new evals after a losing 3 months",
        "T 126 sessions": "No new evals after a losing 6 months", "R x0.5": "Half the size (0.5x)", "R x0.75": "0.75x the size",
        "R x1.25": "1.25x the size", "R x1.5": "1.5x the size", "V 7 accounts": "7 accounts in all (2 reserve evals)",
        "V 8 accounts": "8 accounts in all (3 reserve evals)", "S funded skips overnight sells": "Funded skips overnight sells"}
FAMILY = {"base": "Current rules", "placebo": "Placebo", "A": "Round 3: risk by cushion", "B": "Round 3: day budget",
          "C": "Round 3: eval risk", "D": "Round 3: eval triggers", "E": "Round 3: pyramid add", "F": "Round 3: overnight exit",
          "T": "Round 4: eval throttle", "R": "Round 4: risk level", "V": "Round 4: eval reserve",
          "S": "Round 5: overnight sells", "M-gold": "Round 5: gold", "M-crude": "Round 5: crude oil"}


def fam_of(n):
    if n == "BASE":
        return "base"
    if n.startswith("P "):
        return "placebo"
    if n.startswith("M "):
        return "M-" + n.split()[-1]
    if n.startswith("S "):
        return "S"
    return n[0]


def main(rd):
    runs = json.load(open(os.path.join(rd, "runs.json")))
    order = ["base", "placebo", "A", "B", "C", "D", "E", "F", "T", "R", "V", "S", "M-gold", "M-crude"]
    names = sorted({k.split("|")[0] for k in runs if k.split("|")[1] == "all"}, key=lambda n: (order.index(fam_of(n)), n))
    mean = {n: {p: {k: float(np.mean([runs[f"{n}|{w}|{o}"]["periods"][p][k] for o in OFFSETS])) for k in ("M", "W", "L", "D")}
                for w, p in (("all", "2011-21"), ("5y", "last 5y"))} for n in names}
    plac = [n for n in names if fam_of(n) == "placebo"]
    band = {p: {k: max(abs(mean[x][p][k] - mean["BASE"][p][k]) for x in plac) for k in ("M", "W")} for p in ("last 5y", "2011-21")}

    def route(n):
        dM = mean[n]["last 5y"]["M"] - mean["BASE"]["last 5y"]["M"]
        dW = mean[n]["last 5y"]["W"] - mean["BASE"]["last 5y"]["W"]
        if dW > band["last 5y"]["W"] and dM >= -band["last 5y"]["M"]:
            return "consistency", dW
        if dM > band["last 5y"]["M"] and dW >= -band["last 5y"]["W"]:
            return "money", dM
        return None, 0.0

    def old_ok(n):
        return (mean[n]["2011-21"]["M"] - mean["BASE"]["2011-21"]["M"] >= -band["2011-21"]["M"]
                and mean[n]["2011-21"]["W"] - mean["BASE"]["2011-21"]["W"] >= -band["2011-21"]["W"])

    verdict, adopted = {}, []
    for f in sorted({fam_of(n) for n in names} - {"base", "placebo"}):
        cand = [n for n in names if fam_of(n) == f]
        ok = sorted([(n,) + route(n) for n in cand if route(n)[0]], key=lambda x: (x[1] != "consistency", -x[2]))
        for n in cand:
            verdict[n] = "Not better than the noise in the last 5 years"
        if ok:
            pick = ok[0][0]
            for n, rt, _ in ok[1:]:
                verdict[n] = f"Better in the last 5 years ({'steadier' if rt == 'consistency' else 'more money'}), but another variant of its family did more"
            rt = ok[0][1]
            if old_ok(pick):
                verdict[pick] = "ADOPTED"
                adopted.append(pick)
            else:
                verdict[pick] = (f"Better in the last 5 years ({'steadier' if rt == 'consistency' else 'more money'}), "
                                 "but worse than the noise in 2011-21: rejected")
    verdict["BASE"] = "The rules in use"
    for n in plac:
        verdict[n] = "Trivial change: sets the noise band"
    txt = open(os.path.join(rd, "decisions.txt")).read()
    line = [x for x in txt.splitlines() if x.startswith("Adopted under rule 5Y:")][0]
    assert line == "Adopted under rule 5Y: " + (", ".join(adopted) if adopted else "none"), (line, adopted)
    with open(os.path.join(rd, "r5_configs.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["setup", "name", "family", "net_5y_usd", "worst_year_5y_usd", "deepest_drop_5y_usd", "net_2011_21_usd",
                    "worst_year_2011_21_usd", "verdict"])
        for n in names:
            w.writerow([n, NAME.get(n, n), FAMILY[fam_of(n)], round(mean[n]["last 5y"]["M"]), round(mean[n]["last 5y"]["W"]),
                        round(mean[n]["last 5y"]["D"]), round(mean[n]["2011-21"]["M"]), round(mean[n]["2011-21"]["W"]), verdict[n]])
    with open(os.path.join(rd, "r5_bands.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["period", "net_band_usd", "worst_year_band_usd"])
        for p in ("last 5y", "2011-21"):
            w.writerow([p, round(band[p]["M"]), round(band[p]["W"])])
    # ---- 1-5 accounts, last 5 years
    SID = {"N accounts bought the same day (copy-traded in lockstep)": "A",
           "N accounts, each an eval then funded, at most one new eval a day": "C", "N funded + N evals in reserve": "B"}
    rows = list(csv.DictReader(open(os.path.join(rd, "accounts_5y_summary.csv"))))
    with open(os.path.join(rd, "accounts_5y.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id"] + list(rows[0].keys()))
        for r in rows:
            w.writerow([SID[r["structure"]] + r["accounts"]] + list(r.values()))
    yr = list(csv.DictReader(open(os.path.join(rd, "accounts_5y_by_year.csv"))))
    years = []
    for r in yr:
        if r["year"] not in years:
            years.append(r["year"])
    with open(os.path.join(rd, "accounts_5y_years_wide.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        cols = ([f"c{n}_net_usd" for n in range(1, 6)] + ["c5_eval_pass_pct"] + [f"b{n}_net_usd" for n in range(1, 6)]
                + ["b5_eval_pass_pct", "b5_payouts", "b5_evals_bought", "a1_net_usd"])
        w.writerow(["year"] + cols)
        for y in years:
            g = {(SID[r["structure"]], r["accounts"]): r for r in yr if r["year"] == y}
            w.writerow([y] + [g[("C", str(n))]["net_median_usd"] for n in range(1, 6)] + [g[("C", "5")]["eval_pass_pct"]]
                       + [g[("B", str(n))]["net_median_usd"] for n in range(1, 6)]
                       + [g[("B", "5")]["eval_pass_pct"], g[("B", "5")]["payouts_median"], g[("B", "5")]["evals_bought_median"],
                          g[("A", "1")]["net_median_usd"]])
    print("wrote r5_configs.csv, r5_bands.csv, accounts_5y.csv, accounts_5y_years_wide.csv; adopted:", adopted or "none")
    for n in names:
        print(f"  {NAME.get(n, n):45s} {verdict[n]}")


if __name__ == "__main__":
    main(sys.argv[1])
