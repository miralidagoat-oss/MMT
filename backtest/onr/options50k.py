#!/usr/bin/env python3
"""The indicator's eval options at Lucid Flex 50K (final review, 2026-11-18): the numbers behind its input tooltips.

usage: options50k.py DATA_DIR OUT_DIR      (ONR_EVAL_FEE_50K sets the eval price, as everywhere; default $115)
       options50k.py --mnq FUT_DATA_DIR OUT_DIR   (since Nov 23 2026: part 1 only, on the user's MNQ file, NQFUT.npz at
       5-minute bars, from its first tradable session (Dec 20 2019) and over the last 5 years; the add-on's rule 5Y on
       the MNQ file is site_v23.py's addon_summary.csv)

1. Eval pass rate of each eval option, evals started on every session (an eval still open at the data's end is left
   out, as report50k.py does): the default (40% rule, wide bracket, news skip), the paid 50% consistency add-on,
   the medium and tight brackets, and no news skip. -> options_pass_rates.csv
2. The 50% add-on for 5 funded + 5 evals, scored with research round 5/6's machinery and rule 5Y unchanged (12 start
   dates, mean; noise bands from the 8 placebo runs stored in results_r6<FEE_TAG>/runs.json, whose BASE this script
   recomputes and checks to the cent). The add-on's own price p per eval is unknown here, and net is linear in the
   fee, so each p is scored exactly: net a year falls by p x evals bought a year, each full year by p x its evals.
   -> addon_rule5y.csv, addon_runs.json, summary.txt, addon_summary.csv (the dashboard's single figures)
This is a descriptive check written after the add-on's first numbers were seen, not a pre-registered test.
"""
import csv
import json
import os
import sys
from multiprocessing import Pool as MP

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from account import COMM_RT, FEE_TAG, RULES, run_eval  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
E_KW = dict(improved=True, comm=COMM_RT, size=50)  # report50k.E_KW
OPTIONS = {"default (40% rule, wide bracket, news skip)": {}, "50% consistency add-on": dict(cons=0.5),
           "medium bracket x0.75": dict(span=0.75), "tight bracket x0.5": dict(span=0.5), "no news skip": dict(news=False)}
PERIODS = (("2011-20", "2011-01-01", "2020-12-31"), ("2021-26", "2021-01-01", "2026-12-31"),
           ("last 5 years", "2021-11-15", "2026-12-31"), ("all years", "2011-01-01", "2026-12-31"))
PRICES = (0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0)
S = None


MNQ = [False]  # --mnq: the user's MNQ file


def _init(dd):
    global S
    if MNQ[0]:
        S = Sessions(load_npz(os.path.join(dd, "NQFUT.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5)
    else:
        S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)


def _eval_job(args):
    name, k = args
    r = run_eval(S, k, **dict(E_KW, **OPTIONS[name]))
    return name, k, r["result"], r["days"]


def pass_rates(dd, periods=PERIODS):
    _init(dd)
    days = S.days
    k_first = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in days]))
    with MP(4, initializer=_init, initargs=(dd,)) as mp:
        res = mp.map(_eval_job, [(n, k) for n in OPTIONS for k in range(k_first, len(days))], chunksize=200)
    iso = lambda k: str(np.datetime64(int(days[k]), "D"))  # noqa: E731
    rows = []
    for lab, a, b in periods:
        for n in OPTIONS:
            sel = [(r, dd_) for nm, k, r, dd_ in res if nm == n and r != "open" and a <= iso(k) <= b]
            ps = [dd_ for r, dd_ in sel if r == "pass"]
            rows.append([lab, n, len(sel), len(ps), round(100 * len(ps) / len(sel), 1), float(np.median(ps))])
    return rows


def addon_rule5y(dd):
    off = R4.OFFSETS
    res = R5.run_jobs(dd, dd, [("ADDON", [R5.nq(ek=dict(cons=0.5))], w, o) for w in ("all", "5y") for o in off], {"nq"})
    r6 = json.load(open(os.path.join(HERE, "results_r6" + FEE_TAG, "runs.json")))
    plac = sorted({k.split("|")[0] for k in r6 if k.startswith("P ")})
    assert len(plac) == 8, plac
    per = {"last 5y": "5y", "2011-21": "all"}

    def mean(get, lab, p=0.0):
        M, W = [], []
        for o in off:
            r = get(per[lab], o)
            M.append(r["periods"][lab]["M"] - p * r["periods"][lab]["evals_yr"])
            W.append(min(r["years"][y]["net"] - p * r["years"][y]["evals_bought"] for y in R5.FULL5[lab] if y in r["years"]))
        return float(np.mean(M)), float(np.mean(W))

    base = {lab: mean(lambda w, o: r6[f"BASE|{w}|{o}"], lab) for lab in per}
    for lab in per:  # the stored W must be what this script computes at p = 0
        for i, k in enumerate(("M", "W")):
            v = float(np.mean([r6[f"BASE|{per[lab]}|{o}"]["periods"][lab][k] for o in off]))
            assert abs(v - base[lab][i]) < 0.01, (lab, k, v, base[lab][i])
    band = {lab: tuple(max(abs(mean(lambda w, o, n=n: r6[f"{n}|{w}|{o}"], lab)[i] - base[lab][i]) for n in plac)
                       for i in (0, 1)) for lab in per}

    def score(p):
        A = {lab: mean(lambda w, o: res[("ADDON", w, o)], lab, p) for lab in per}
        dM5, dW5 = A["last 5y"][0] - base["last 5y"][0], A["last 5y"][1] - base["last 5y"][1]
        bM, bW = band["last 5y"]
        route = "consistency" if (dW5 > bW and dM5 >= -bM) else ("money" if (dM5 > bM and dW5 >= -bW) else "")
        dMo, dWo = A["2011-21"][0] - base["2011-21"][0], A["2011-21"][1] - base["2011-21"][1]
        ok_old = dMo >= -band["2011-21"][0] and dWo >= -band["2011-21"][1]
        return A, dM5, dW5, dMo, dWo, route, ok_old

    rows = []
    for p in PRICES:
        A, dM5, dW5, dMo, dWo, route, ok_old = score(p)
        rows.append([p, round(A["last 5y"][0]), round(dM5), round(A["last 5y"][1]), round(dW5), round(A["2011-21"][0]),
                     round(dMo), round(A["2011-21"][1]), round(dWo), route or "inside the band", "yes" if ok_old else "no",
                     "pass" if route and ok_old else "fail"])
    lo, hi = 0.0, 500.0
    if score(0.0)[5] and score(0.0)[6]:
        for _ in range(50):
            mid = (lo + hi) / 2
            s = score(mid)
            lo, hi = (mid, hi) if (s[5] and s[6]) else (lo, mid)
    else:
        lo = None
    ev5 = float(np.mean([res[("ADDON", "5y", o)]["periods"]["last 5y"]["evals_yr"] for o in off]))
    return rows, base, band, lo, ev5, {f"ADDON|{w}|{o}": v for (_, w, o), v in res.items()}


def main(dd, out):
    os.makedirs(out, exist_ok=True)
    lines = []

    def say(s=""):
        print(s, flush=True)
        lines.append(s)

    fee = RULES[50]["price"]
    say(f"Lucid Flex 50K, ${COMM_RT:.2f} per MNQ round turn, evals at ${fee:.2f}")
    pr = pass_rates(dd)
    with open(os.path.join(out, "options_pass_rates.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["period", "option", "evals_finished", "evals_passed", "pass_pct", "median_sessions_to_pass"])
        w.writerows(pr)
    say("\n1. Eval pass rate by option (evals started on every session)")
    for r in pr:
        say(f"  {r[0]:13s} {r[1]:45s} {r[4]:5.1f}% of {r[2]:5d}, median {r[5]:.0f} sessions to pass")
    rows, base, band, p_max, ev5, runs = addon_rule5y(dd)
    json.dump(runs, open(os.path.join(out, "addon_runs.json"), "w"))
    with open(os.path.join(out, "addon_rule5y.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["addon_price_per_eval_usd", "last5y_net_per_year_usd", "last5y_net_vs_current_usd",
                    "last5y_worst_full_year_usd", "last5y_worst_year_vs_current_usd", "y2011_21_net_per_year_usd",
                    "y2011_21_net_vs_current_usd", "y2011_21_worst_full_year_usd", "y2011_21_worst_year_vs_current_usd",
                    "last5y_route", "y2011_21_not_worse_than_band", "rule_5y"])
        w.writerows(rows)
    say("\n2. The 50% add-on, 5 funded + 5 evals, mean of 12 start dates (research round 5/6 machinery, rule 5Y)")
    say(f"  current rules: last 5 years net ${base['last 5y'][0]:,.0f} a year, worst full year ${base['last 5y'][1]:,.0f}; "
        f"2011-21 ${base['2011-21'][0]:,.0f}, ${base['2011-21'][1]:,.0f}")
    say(f"  noise bands (8 placebos): last 5 years net {band['last 5y'][0]:,.0f}, worst year {band['last 5y'][1]:,.0f}; "
        f"2011-21 {band['2011-21'][0]:,.0f}, {band['2011-21'][1]:,.0f}")
    for r in rows:
        say(f"  add-on ${r[0]:5.2f} an eval: last 5 years net ${r[1]:>7,} ({r[2]:+,}), worst year ${r[3]:>7,} ({r[4]:+,}) | "
            f"2011-21 net ${r[5]:>7,} ({r[6]:+,}), worst year ${r[7]:>7,} ({r[8]:+,}) -> {r[11]} ({r[9]})")
    say(f"  rule 5Y passes up to an add-on price of ${p_max:.2f} an eval" if p_max is not None else "  rule 5Y fails even at $0")
    say(f"  evals bought a year with the add-on, last 5 years: {ev5:.1f}")
    say("  descriptive check, not pre-registered")
    open(os.path.join(out, "summary.txt"), "w").write("\n".join(lines) + "\n")
    # single figures for the dashboard (metric, label, value, unit)
    pp = {(r[0], r[1]): r[4] for r in pr}
    z = rows[0]  # add-on price $0
    k = [["eval_price", "Eval price used", fee, "usd"],
         ["pass_default_5y", "Eval pass rate, 40% rule, last 5 years", pp[("last 5 years", list(OPTIONS)[0])], "pct"],
         ["pass_addon_5y", "Eval pass rate, 50% add-on, last 5 years", pp[("last 5 years", "50% consistency add-on")], "pct"],
         ["pass_default_2011_20", "Eval pass rate, 40% rule, 2011-20", pp[("2011-20", list(OPTIONS)[0])], "pct"],
         ["pass_addon_2011_20", "Eval pass rate, 50% add-on, 2011-20", pp[("2011-20", "50% consistency add-on")], "pct"],
         ["net_current_5y", "Net a year, current rules, last 5 years", round(base["last 5y"][0]), "usd"],
         ["net_addon_5y", "Net a year with the add-on (before its price), last 5 years", z[1], "usd"],
         ["net_gain_5y", "Net a year gained (before its price), last 5 years", z[2], "usd"],
         ["worst_current_5y", "Worst full year, current rules, last 5 years", round(base["last 5y"][1]), "usd"],
         ["worst_addon_5y", "Worst full year with the add-on (before its price), last 5 years", z[3], "usd"],
         ["net_gain_2011_21", "Net a year gained (before its price), 2011-21", z[6], "usd"],
         ["worst_gain_2011_21", "Worst full year gained (before its price), 2011-21", z[8], "usd"],
         ["max_price_rule5y", "Highest add-on price per eval at which rule 5Y still passes", round(p_max, 2) if p_max is not None else "", "usd"],
         ["evals_year_addon_5y", "Evals bought a year with the add-on, last 5 years", round(ev5, 1), "count"]]
    with open(os.path.join(out, "addon_summary.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["metric", "label", "value", "unit"])
        w.writerows(k)


def main_mnq(fd, out):
    import windows as W
    MNQ[0] = True
    os.makedirs(out, exist_ok=True)
    periods = ((f"since {W.FIRST}", W.FIRST, "2026-12-31"), (f"{W.FIRST} - 2021-11-14", W.FIRST, "2021-11-14"),
               ("last 5 years", W.START5, "2026-12-31"))
    pr = pass_rates(fd, periods)
    with open(os.path.join(out, "options_pass_rates.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["period", "option", "evals_finished", "evals_passed", "pass_pct", "median_sessions_to_pass"])
        w.writerows(pr)
    print(f"Lucid Flex 50K on the user's MNQ file, ${COMM_RT:.2f} per MNQ round turn: eval pass rate by option (an eval started on every session)")
    for r in pr:
        print(f"  {r[0]:26s} {r[1]:45s} {r[4]:5.1f}% of {r[2]:5d}, median {r[5]:.0f} sessions to pass")


if __name__ == "__main__":
    if sys.argv[1] == "--mnq":
        main_mnq(sys.argv[2], sys.argv[3])
    else:
        main(sys.argv[1], sys.argv[2])
