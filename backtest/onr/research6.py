#!/usr/bin/env python3
"""Research round 6 (pre-registered in PREREG_R6.md, committed before any result): the strategy without its
overnight trade, and the eval's 10:30 IB breakout in its place.

usage: research6.py DATA_DIR OUT_DIR
Uses research5.py's simulation, metrics, windows and rule 5Y unchanged (the current rules and the 8 placebo runs are
recomputed and checked against round 5's to the dollar, so the noise bands are the same).

Decisions: N1 no overnight trade anywhere; N2 funded accounts without it; N3 the eval without it (= round 3's D1,
checked equal to round 5's run); U1 = N1 plus the eval's IB fallback on sessions with no 09:35 drive.
Descriptive: N1 with 1-5 accounts (structures A, B, C) over the last 5 years; the overnight trade's share of one funded
account's results by year; the eval plan's overnight and 09:35 trades by year.
"""
import csv
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from account import is_half  # noqa: E402
from engine import PV, bracket_exit, news_night  # noqa: E402
from account import FEE_TAG, eval_bracket  # noqa: E402

OFFSETS = R4.OFFSETS
NO_ON_E, NO_ON_F = dict(legs=("od",)), dict(legs=("pyr", "ib"))
HERE = os.path.dirname(os.path.abspath(__file__))


def configs():
    nq = R5.nq
    c = [("BASE", "base", [nq()])]
    for x in (0.712, 0.715, 0.722, 0.725):
        c.append((f"P thr {x}", "placebo", [nq(dict(thr=x), dict(thr=x))]))
    for x in (340, 345, 355, 360):
        c.append((f"P size ref {x}", "placebo", [nq(fk=dict(adr_ref=x))]))
    c += [("N1 no overnight trade", "N", [nq(ek=NO_ON_E, fk=NO_ON_F)]),
          ("N2 funded without the overnight trade", "N", [nq(fk=NO_ON_F)]),
          ("N3 eval without the overnight trade", "N", [nq(ek=NO_ON_E)]),
          ("U1 no overnight, eval takes the 10:30 IB on no-drive days", "U",
           [nq(ek=dict(NO_ON_E, ib_fallback=True), fk=NO_ON_F)])]
    return c


def descriptive():
    nq, c = R5.nq, []
    for N in range(1, 6):
        c.append((f"N1-A{N}", "A", [nq(N=N, mt=None, struct="A", ek=NO_ON_E, fk=NO_ON_F)]))
        c.append((f"N1-C{N}", "C", [nq(N=N, mt=N, ek=NO_ON_E, fk=NO_ON_F)]))
        c.append((f"N1-B{N}", "B", [nq(N=N, mt=2 * N, ek=NO_ON_E, fk=NO_ON_F)]))
    return c


def eval_plan_rows(S):
    """The eval plan session by session (full bracket, as export_charts.eval_plan): [(date, 'overnight'|'drive', net $)]."""
    out = []
    for d in S.days:
        r = S.S[d]
        adr = r["adr"]
        if np.isnan(adr):
            continue
        so, sd_ = S.on_side(d), S.od_side(d)
        if so != 0 and not news_night(d):
            leg, side, rec = "overnight", so, r["on"]
        elif sd_ != 0 and not is_half(d):
            leg, side, rec = "drive", sd_, r["od"]
        else:
            continue
        n, stop_pts, tgt_pts = eval_bracket(adr, 2000.0, 0.0, 0.0, 0.4, 1.0, True, 1.34, 50)
        px, _ = bracket_exit(rec["w"], side, rec["E"], stop_pts, tgt_pts)
        out.append((str(np.datetime64(int(d), "D")), leg, (px - rec["E"]) * side * n * PV - n * 1.34))
    return out


def main(dd, out):
    os.makedirs(out, exist_ok=True)
    R5._init(dd, dd, ())
    R5.self_check()
    C, D = configs(), descriptive()
    jobs = [(n, parts, w, o) for n, _, parts in C for w in ("all", "5y") for o in OFFSETS]
    jobs += [(n, parts, "5y", o) for n, _, parts in D for o in OFFSETS]
    res = R5.run_jobs(dd, dd, jobs, {"nq"})
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in res.items()}, open(os.path.join(out, "runs.json"), "w"))
    lines = []

    def say(s=""):
        print(s, flush=True)
        lines.append(s)

    # ---------------- checks against round 5 (same code, same data -> same numbers)
    r5 = json.load(open(os.path.join(HERE, "results_r5" + FEE_TAG, "runs.json")))
    pairs = [("BASE", "BASE")] + [(n, n) for n, f, _ in C if f == "placebo"] + [("N3 eval without the overnight trade",
                                                                                   "D1 eval 09:35 drive only")]
    for mine, theirs in pairs:
        for w, plist in (("all", R5.P_ALL), ("5y", R5.P_5Y)):
            for o in OFFSETS:
                a, b = res[(mine, w, o)]["periods"], r5[f"{theirs}|{w}|{o}"]["periods"]
                for lab, _, _ in plist:
                    for k in ("M", "W", "L", "D"):
                        assert abs(a[lab][k] - b[lab][k]) < 1e-6, (mine, w, o, lab, k, a[lab][k], b[lab][k])
    say("check passed: the current rules, the 8 placebos and N3 (= round 3's D1) equal round 5's runs exactly")

    names = [n for n, _, _ in C]
    fam = {n: f for n, f, _ in C}
    mean = {n: {} for n in names}
    for n in names:
        for w, plist in (("all", R5.P_ALL), ("5y", R5.P_5Y)):
            for lab, _, _ in plist:
                mean[n][lab] = {k: float(np.mean([res[(n, w, o)]["periods"][lab][k] for o in OFFSETS]))
                                for k in ("M", "W", "L", "D", "worst12", "gap", "months_paid")}
    plac = [n for n in names if fam[n] == "placebo"]
    band = {p: {k: max(abs(mean[x][p][k] - mean["BASE"][p][k]) for x in plac) for k in ("M", "W")} for p in ("last 5y", "2011-21")}
    bands_r5 = {r["period"]: r for r in csv.DictReader(open(os.path.join(HERE, "results_r5" + FEE_TAG, "r5_bands.csv")))}
    for p in band:
        assert round(band[p]["M"]) == int(bands_r5[p]["net_band_usd"]) and round(band[p]["W"]) == int(bands_r5[p]["worst_year_band_usd"])
    say("noise bands (round 5's, recomputed): " + " | ".join(f"{p}: M {band[p]['M']:,.0f}, W {band[p]['W']:,.0f}" for p in band))

    def row(n):
        return " || ".join(f"{p}: M {mean[n][p]['M']:>7,.0f} W {mean[n][p]['W']:>7,.0f} L {mean[n][p]['L']:.2f} "
                           f"D {mean[n][p]['D']:>7,.0f} gap {mean[n][p]['gap']:4.1f}" for p in ("last 5y", "2011-21", "2011-18", "2019-26"))
    say("5 funded + 5 evals, mean of 12 start dates; M net a year, W worst full year, L losing full years, D deepest drop")
    for n in names:
        say(f"  {n:58s} {row(n)}")

    def route(n, p, bands):
        dM, dW = mean[n][p]["M"] - mean["BASE"][p]["M"], mean[n][p]["W"] - mean["BASE"][p]["W"]
        if dW > bands[p]["W"] and dM >= -bands[p]["M"]:
            return "consistency", dW
        if dM > bands[p]["M"] and dW >= -bands[p]["W"]:
            return "money", dM
        return None, 0.0

    verdict = {"BASE": "The rules in use"}
    for n in plac:
        verdict[n] = "Trivial change: sets the noise band"
    say("\nRule 5Y: best variant of each family over the last 5 years; it must pass there and not be worse than the band in 2011-21")
    adopted = []
    for f in ("N", "U"):
        cand = [n for n in names if fam[n] == f]
        for n in cand:
            verdict[n] = "Not better than the noise in the last 5 years"
        ok = sorted([(n,) + route(n, "last 5y", band) for n in cand if route(n, "last 5y", band)[0]],
                    key=lambda x: (x[1] != "consistency", -x[2]))
        if not ok:
            say(f"  {f}: reject, no variant passes the last 5 years ("
                + "; ".join(f"{n}: M {mean[n]['last 5y']['M'] - mean['BASE']['last 5y']['M']:+,.0f}, "
                            f"W {mean[n]['last 5y']['W'] - mean['BASE']['last 5y']['W']:+,.0f}" for n in cand) + ")")
            continue
        for n, rt, _ in ok[1:]:
            verdict[n] = (f"Better in the last 5 years ({'steadier' if rt == 'consistency' else 'more money'}), but another "
                          "variant of its family did more")
        pick, rt, imp = ok[0]
        dM = mean[pick]["2011-21"]["M"] - mean["BASE"]["2011-21"]["M"]
        dW = mean[pick]["2011-21"]["W"] - mean["BASE"]["2011-21"]["W"]
        good = dM >= -band["2011-21"]["M"] and dW >= -band["2011-21"]["W"]
        verdict[pick] = ("ADOPTED" if good else f"Better in the last 5 years ({'steadier' if rt == 'consistency' else 'more money'}), "
                         "but worse than the noise in 2011-21: rejected")
        say(f"  {f}: {pick} passes the last 5 years by {rt} ({imp:+,.0f}); 2011-21 M {dM:+,.0f}, W {dW:+,.0f} -> "
            f"{'ADOPT' if good else 'reject'}")
        if good:
            adopted.append(pick)
    say("Adopted under rule 5Y: " + (", ".join(adopted) if adopted else "none"))
    R4B = R5.r4_bands()
    say("\nOriginal rule (variant chosen on 2011-18; must pass 2011-18 and 2019-26 with round 4's bands)")
    for f in ("N", "U"):
        cand = [n for n in names if fam[n] == f]
        ok = sorted([(n,) + route(n, "2011-18", R4B) for n in cand if route(n, "2011-18", R4B)[0]],
                    key=lambda x: (x[1] != "consistency", -x[2]))
        if not ok:
            say(f"  {f}: reject, no variant passes 2011-18")
            continue
        rt, _ = route(ok[0][0], "2019-26", R4B)
        say(f"  {f}: {ok[0][0]} passes 2011-18 by {ok[0][1]}; 2019-26 {'passes by ' + rt if rt else 'fails'} -> "
            f"{'ADOPT' if rt else 'reject'}")

    # ---------------- tables for the dashboard
    NAME = {"BASE": "Current rules (5 funded + 5 evals)", "N1 no overnight trade": "No overnight trade at all",
            "N2 funded without the overnight trade": "Funded accounts skip the overnight trade",
            "N3 eval without the overnight trade": "Evals skip the overnight trade",
            "U1 no overnight, eval takes the 10:30 IB on no-drive days": "No overnight trade; the eval takes the 10:30 IB breakout instead"}
    KIND = {"base": "Current rules", "placebo": "Placebo", "N": "No overnight trade", "U": "Replacement"}
    with open(os.path.join(out, "r6_configs.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["setup", "name", "family", "net_5y_usd", "worst_year_5y_usd", "deepest_drop_5y_usd", "longest_gap_5y_months",
                    "net_2011_21_usd", "worst_year_2011_21_usd", "deepest_drop_2011_21_usd", "verdict"])
        for n in names:
            if fam[n] == "placebo":
                continue
            w.writerow([n.split()[0], NAME[n], KIND[fam[n]], round(mean[n]["last 5y"]["M"]), round(mean[n]["last 5y"]["W"]),
                        round(mean[n]["last 5y"]["D"]), round(mean[n]["last 5y"]["gap"], 1), round(mean[n]["2011-21"]["M"]),
                        round(mean[n]["2011-21"]["W"]), round(mean[n]["2011-21"]["D"]), verdict[n]])
    # every year, current rules vs N1 vs U1 (median of 12 start dates), both windows
    with open(os.path.join(out, "r6_years.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["year", "current_usd", "no_overnight_usd", "no_overnight_ib_eval_usd", "current_eval_pass_pct",
                    "no_overnight_eval_pass_pct", "window"])
        for win, lab in (("5y", "last 5 years"), ("all", "all years")):
            years = sorted({y for o in OFFSETS for y in res[("BASE", win, o)]["years"]})
            for y in years:
                vals = {}
                for n in ("BASE", "N1 no overnight trade", "U1 no overnight, eval takes the 10:30 IB on no-drive days"):
                    yy = [res[(n, win, o)]["years"][y] for o in OFFSETS if y in res[(n, win, o)]["years"]]
                    p_, f_ = sum(v["evals_passed"] for v in yy), sum(v["evals_failed"] for v in yy)
                    vals[n] = (round(float(np.median([v["net"] for v in yy]))), round(100 * p_ / (p_ + f_), 1) if p_ + f_ else "")
                w.writerow([y, vals["BASE"][0], vals["N1 no overnight trade"][0],
                            vals["U1 no overnight, eval takes the 10:30 IB on no-drive days"][0], vals["BASE"][1],
                            vals["N1 no overnight trade"][1], lab])
    # N1 with 1-5 accounts, last 5 years
    LAB = {"A": "N accounts bought the same day (copy-traded in lockstep)",
           "C": "N accounts, each an eval then funded, at most one new eval a day", "B": "N funded + N evals in reserve"}
    with open(os.path.join(out, "accounts_5y_no_overnight.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["id", "structure", "accounts", "net_per_year_usd", "worst_full_year_usd", "losing_full_years", "total_net_5y_usd",
                    "deepest_drop_usd", "worst_12_months_usd", "longest_gap_months", "months_with_payout_pct", "eval_pass_pct",
                    "payouts", "current_rules_net_per_year_usd"])
        cur = {r["id"]: r for r in csv.DictReader(open(os.path.join(HERE, "results_r5" + FEE_TAG, "accounts_5y.csv")))}
        for st in ("C", "B", "A"):
            for N in range(1, 6):
                R = [res[(f"N1-{st}{N}", "5y", o)] for o in OFFSETS]
                g = lambda key: float(np.mean([r["periods"]["last 5y"][key] for r in R]))  # noqa: E731
                ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
                fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
                w.writerow([f"{st}{N}", LAB[st], N, round(g("M")), round(g("W")), round(g("L"), 2),
                            round(float(np.mean([r["total"] for r in R]))), round(g("D")), round(g("worst12")), round(g("gap"), 1),
                            round(g("months_paid"), 1), round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                            round(fu("payouts"), 1), cur[f"{st}{N}"]["net_per_year_usd"]])
    # the overnight trade's share of one funded account, and the eval plan's two trade types, by year
    at = list(csv.DictReader(open(os.path.join(HERE, "results_charts", "all_trades.csv"))))
    ep = eval_plan_rows(R4._G["S"])
    with open(os.path.join(out, "overnight_share.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["period", "funded_overnight_trades", "funded_overnight_usd", "funded_pyramid_usd", "funded_ib_usd", "funded_all_usd",
                    "eval_overnight_trades", "eval_overnight_won_pct", "eval_overnight_usd", "eval_drive_trades", "eval_drive_won_pct",
                    "eval_drive_usd"])
        years = sorted({t["date"][:4] for t in at})
        for y in years + ["Last 5 years", "All years"]:
            keep = ((lambda dd: dd >= R5.START5) if y == "Last 5 years" else (lambda dd: True) if y == "All years"
                    else (lambda dd, y=y: dd[:4] == y))
            sel = [t for t in at if keep(t["date"])]
            s_ = {k: sum(float(t["net_usd"]) for t in sel if t["trade_type"] == k) for k in ("Overnight", "Pyramid", "IB breakout")}
            e_on = [v for dd, leg, v in ep if leg == "overnight" and keep(dd) and dd >= sel[0]["date"]]
            e_od = [v for dd, leg, v in ep if leg == "drive" and keep(dd) and dd >= sel[0]["date"]]
            w.writerow([y, sum(1 for t in sel if t["trade_type"] == "Overnight"), round(s_["Overnight"]), round(s_["Pyramid"]),
                        round(s_["IB breakout"]), round(sum(s_.values())), len(e_on),
                        round(100 * np.mean([v > 0 for v in e_on]), 1) if e_on else "", round(sum(e_on)), len(e_od),
                        round(100 * np.mean([v > 0 for v in e_od]), 1) if e_od else "", round(sum(e_od))])
    open(os.path.join(out, "decisions.txt"), "w").write("\n".join(lines) + "\n")
    print("wrote", out, flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
