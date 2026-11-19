#!/usr/bin/env python3
"""The dashboard's datasets on real NQ futures (prep_nqfut.py's series), in the same formats as the CFD ones.

usage (ONR_EVAL_FEE_50K=80.50): futures_site.py FUT_DATA_DIR OUT_DIR
  FUT_DATA_DIR: NQFUT.npz (5-minute bars) and SPXUSD.npz.
Research round 5's machinery runs unchanged, with its NQ sessions replaced by the futures series (research4._init is
swapped for one that loads NQFUT.npz at 5-minute bars; nothing else changes):
  - 1-5 accounts in round 4's structures A, B and C over the last 5 years, 12 start dates (as research5.py Part 1)
  - the current rules (BASE), the 8 placebo runs and the 50% add-on, over the last 5 years and from Aug 30 2019, the
    futures' first tradable session (research5's "2011-21" period then covers Aug 30 2019 -> Nov 14 2021 only, and
    its worst full year is 2020's)
It also gathers report50k.py's futures and CFD reports (results_nqfut*, results_cfd19*) and nqfut_check.py's output.
Writes accounts_5y.csv, accounts_5y_years_wide.csv, addon_kpis.csv, addon_years.csv, addon_prices.csv,
addon_summary.csv, fut_full.csv, fut_years.csv, fut_check.csv, fut_data.csv and runs.json into OUT_DIR.
"""
import csv
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import addon50k as A50  # noqa: E402
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from account import FEE_TAG, RULES, FundedAccount  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OFF = R4.OFFSETS
PRICES = (0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0)


def fut_init(dd):
    """research4._init on the futures series (5-minute bars)."""
    S = Sessions(load_npz(os.path.join(dd, "NQFUT.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5)
    R4._G["S"] = S
    R4._G["k0"] = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))
    R4._G["k4"] = int(np.searchsorted(S.days, np.datetime64("2022-11-14").astype(int)))
    book = np.zeros(len(S.days))
    for k, d in enumerate(S.days):
        rec = []
        FundedAccount(S, record=rec, **R4.F_KW).step(d)
        book[k] = sum(p for *_, p in rec)
    R4._G["book"] = book


R4._init = fut_init  # research5._init calls research4._init: from here on every run uses the futures series


def write(out, name, header, rows):
    with open(os.path.join(out, name), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)
    print(f"wrote {name}: {len(rows)} rows", flush=True)


def accounts(res, out):
    """research5.py accounts Part 1, then report5.py's accounts_5y.csv and accounts_5y_years_wide.csv (same formats)."""
    years = ["2021", "2022", "2023", "2024", "2025", "2026"]
    LAB = {"A": "N accounts bought the same day (copy-traded in lockstep)",
           "C": "N accounts, each an eval then funded, at most one new eval a day", "B": "N funded + N evals in reserve"}
    rows, summ = [], []
    for st in ("A", "C", "B"):
        for N in range(1, 6):
            R = [res[(f"{st}{N}", "5y", o)] for o in OFF]
            for y in years:
                vals = [r["years"][y] for r in R if y in r["years"]]
                nets = [v["net"] for v in vals]
                med = lambda key: float(np.median([v[key] for v in vals]))  # noqa: E731
                rp, rf = sum(v["evals_passed"] for v in vals), sum(v["evals_failed"] for v in vals)
                rows.append([LAB[st], N, y + (" (from Nov 15)" if y == "2021" else " (to Nov 17)" if y == "2026" else ""),
                             round(float(np.median(nets))), round(min(nets)), round(max(nets)), med("payouts"),
                             round(med("payouts_usd")), med("evals_bought"), med("evals_passed"), med("evals_failed"),
                             round(100 * rp / (rp + rf), 1) if rp + rf else "", med("funded_started")])
            g = lambda key: float(np.mean([r["periods"]["last 5y"][key] for r in R]))  # noqa: E731
            ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
            fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
            summ.append([LAB[st], N, round(g("M")), round(g("W")), round(g("L"), 2), round(g("D")), round(g("worst12")),
                         round(g("gap"), 1), round(g("months_paid"), 1), round(g("evals_yr"), 1),
                         round(float(np.mean([r["cash_low"] for r in R]))), round(float(np.mean([r["total"] for r in R]))),
                         round(ev("bought"), 1), round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                         round(ev("median_pass"), 1), round(fu("started"), 1),
                         round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1), round(fu("payouts"), 1),
                         round(fu("payouts_usd") / max(fu("payouts"), 1e-9)), round(fu("abandoned"), 1), round(fu("done"), 1),
                         round(fu("blown"), 1)])
    head = ["structure", "accounts", "net_per_year_usd", "worst_full_year_usd", "losing_full_years", "deepest_drop_usd",
            "worst_12_months_usd", "longest_gap_months", "months_with_payout_pct", "evals_per_year", "most_cash_out_usd",
            "total_net_5y_usd", "evals_bought", "eval_pass_pct", "eval_median_sessions", "funded_accounts",
            "funded_with_payout_pct", "payouts", "average_payout_usd", "funded_abandoned", "funded_done_5_payouts", "funded_blown"]
    SID = {v: k for k, v in LAB.items()}
    write(out, "accounts_5y.csv", ["id"] + head, [[SID[r[0]] + str(r[1])] + r for r in summ])
    cols = ([f"c{n}_net_usd" for n in range(1, 6)] + ["c5_eval_pass_pct"] + [f"b{n}_net_usd" for n in range(1, 6)]
            + ["b5_eval_pass_pct", "b5_payouts", "b5_evals_bought", "a1_net_usd"])
    wide = []
    for y in dict.fromkeys(r[2] for r in rows):
        gg = {(SID[r[0]], r[1]): r for r in rows if r[2] == y}
        wide.append([y] + [gg[("C", n)][3] for n in range(1, 6)] + [gg[("C", 5)][11]] + [gg[("B", n)][3] for n in range(1, 6)]
                    + [gg[("B", 5)][11], gg[("B", 5)][6], gg[("B", 5)][8], gg[("A", 1)][3]])
    write(out, "accounts_5y_years_wide.csv", ["year"] + cols, wide)
    return {SID[r[0]] + str(r[1]): r for r in summ}


def addon(res, out, plac):
    """The add-on page's datasets: addon_kpis.csv, addon_years.csv, addon_prices.csv, addon_summary.csv."""
    cur = json.load(open(os.path.join(HERE, f"results_nqfut_5y{FEE_TAG}", "summary.json")))
    add = json.load(open(os.path.join(HERE, f"results_nqfut_5y_addon{FEE_TAG}", "summary.json")))
    assert cur["nq_file"] == add["nq_file"] == "NQFUT.npz" and add.get("eval_consistency") == 0.5
    b5, a5 = [res[("BASE", "5y", o)] for o in OFF], [res[("ADDON", "5y", o)] for o in OFF]
    ball, aall = [res[("BASE", "all", o)] for o in OFF], [res[("ADDON", "all", o)] for o in OFF]
    k = A50.kpis(cur, add, b5, a5)
    k.insert(0, ["eval_price", "Eval price used (the add-on's own price not included)", RULES[50]["price"], RULES[50]["price"],
                 "usd", "setup"])
    write(out, "addon_kpis.csv", ["metric", "label", "current", "addon", "unit", "source"], k)
    yrows = []
    for window, B, Ad, ys in (("last 5 years", b5, a5, range(2021, 2027)), ("all years", ball, aall, range(2019, 2027))):
        for y in map(str, ys):
            def med(runs, key):
                v = [r["years"][y][key] for r in runs if y in r["years"]]
                return float(np.median(v)) if v else float("nan")

            def pas(runs):
                p = sum(r["years"][y]["evals_passed"] for r in runs if y in r["years"])
                f = sum(r["years"][y]["evals_failed"] for r in runs if y in r["years"])
                return round(100 * p / (p + f), 1) if p + f else ""
            per = "full year"
            if window == "last 5 years" and y == "2021":
                per = "Nov 15 - Dec 31"
            elif window == "all years" and y == "2019":
                per = "from Aug 30"
            if y == "2026":
                per = "Jan 1 - Nov 17"
            yrows.append([window, y, per, round(med(B, "net")), round(med(Ad, "net")), round(med(Ad, "net") - med(B, "net")),
                          med(B, "payouts"), med(Ad, "payouts"), med(B, "evals_bought"), med(Ad, "evals_bought"), pas(B), pas(Ad)])
    write(out, "addon_years.csv", ["window", "year", "period", "current_net_usd", "addon_net_usd", "difference_usd",
                                   "current_payouts", "addon_payouts", "current_evals_bought", "addon_evals_bought",
                                   "current_eval_pass_pct", "addon_eval_pass_pct"], yrows)
    # rule 5Y at add-on prices, as options50k.addon_rule5y, with the futures' own BASE and placebo runs
    per = {"last 5y": "5y", "2011-21": "all"}

    def mean(get, lab, p=0.0):
        M, W = [], []
        for o in OFF:
            r = get(per[lab], o)
            M.append(r["periods"][lab]["M"] - p * r["periods"][lab]["evals_yr"])
            W.append(min(r["years"][y]["net"] - p * r["years"][y]["evals_bought"] for y in R5.FULL5[lab] if y in r["years"]))
        return float(np.mean(M)), float(np.mean(W))
    base = {lab: mean(lambda w, o: res[("BASE", w, o)], lab) for lab in per}
    band = {lab: tuple(max(abs(mean(lambda w, o, n=n: res[(n, w, o)], lab)[i] - base[lab][i]) for n in plac) for i in (0, 1))
            for lab in per}

    def score(p):
        A = {lab: mean(lambda w, o: res[("ADDON", w, o)], lab, p) for lab in per}
        dM5, dW5 = A["last 5y"][0] - base["last 5y"][0], A["last 5y"][1] - base["last 5y"][1]
        bM, bW = band["last 5y"]
        route = "consistency" if (dW5 > bW and dM5 >= -bM) else ("money" if (dM5 > bM and dW5 >= -bW) else "")
        dMo, dWo = A["2011-21"][0] - base["2011-21"][0], A["2011-21"][1] - base["2011-21"][1]
        ok_old = dMo >= -band["2011-21"][0] and dWo >= -band["2011-21"][1]
        return A, dM5, dW5, dMo, dWo, route, ok_old
    prows = []
    for p in PRICES:
        A, dM5, dW5, dMo, dWo, route, ok_old = score(p)
        prows.append([p, round(A["last 5y"][0]), round(dM5), round(A["last 5y"][1]), round(dW5), round(dMo),
                      "pass" if route and ok_old else "fail"])
    write(out, "addon_prices.csv", ["addon_price_usd", "net_per_year_usd", "net_vs_current_usd", "worst_full_year_usd",
                                    "worst_year_vs_current_usd", "net_2011_21_vs_current_usd", "rule_5y"], prows)
    p_max = None
    if score(0.0)[5] and score(0.0)[6]:
        lo, hi = 0.0, 500.0
        for _ in range(50):
            mid = (lo + hi) / 2
            s = score(mid)
            lo, hi = (mid, hi) if (s[5] and s[6]) else (lo, mid)
        p_max = lo
    z = score(0.0)
    ev5 = float(np.mean([r["periods"]["last 5y"]["evals_yr"] for r in a5]))
    srows = [["eval_price", "Eval price used", RULES[50]["price"], "usd"],
             ["pass_default_5y", "Eval pass rate, 40% rule, last 5 years", cur["eval"]["pass_pct"], "pct"],
             ["pass_addon_5y", "Eval pass rate, 50% add-on, last 5 years", add["eval"]["pass_pct"], "pct"],
             ["slot_first_default_5y", "First payout after the first eval, median, 40% rule", cur["first_payout"]["median_days"], "days"],
             ["slot_first_addon_5y", "First payout after the first eval, median, 50% add-on", add["first_payout"]["median_days"], "days"],
             ["net_current_5y", "Net a year, current rules, last 5 years", round(base["last 5y"][0]), "usd"],
             ["net_addon_5y", "Net a year with the add-on (before its price), last 5 years", round(z[0]["last 5y"][0]), "usd"],
             ["net_gain_5y", "Net a year gained (before its price), last 5 years", round(z[1]), "usd"],
             ["worst_current_5y", "Worst full year, current rules, last 5 years", round(base["last 5y"][1]), "usd"],
             ["worst_addon_5y", "Worst full year with the add-on, last 5 years", round(z[0]["last 5y"][1]), "usd"],
             ["worst12_current_5y", "Worst 12 months, current rules, last 5 years",
              round(float(np.mean([r["periods"]["last 5y"]["worst12"] for r in b5]))), "usd"],
             ["worst12_addon_5y", "Worst 12 months with the add-on, last 5 years",
              round(float(np.mean([r["periods"]["last 5y"]["worst12"] for r in a5]))), "usd"],
             ["net_gain_early", "Net a year gained (before its price), Aug 30 2019 - Nov 14 2021", round(z[3]), "usd"],
             ["band_net_5y", "Noise band for net a year, last 5 years (8 placebo runs)", round(band["last 5y"][0]), "usd"],
             ["rule5y_at_0", "Rule 5Y at an add-on price of $0", 1 if (z[5] and z[6]) else 0, "count"],
             ["max_price_rule5y", "Highest add-on price per eval at which rule 5Y still passes", round(p_max, 2) if p_max is not None else 0, "usd"],
             ["evals_year_addon_5y", "Evals bought a year with the add-on, last 5 years", round(ev5, 1), "count"]]
    write(out, "addon_summary.csv", ["metric", "label", "value", "unit"], srows)
    print(f"  add-on on futures: last 5 years {z[1]:+,.0f} a year (band {band['last 5y'][0]:,.0f}), worst year {z[2]:+,.0f} "
          f"(band {band['last 5y'][1]:,.0f}), early period {z[3]:+,.0f}; rule 5Y at $0: {'pass' if z[5] and z[6] else 'fail'}")


def fut_tables(out, fd):
    R = {"fut_current": "results_nqfut", "fut_addon": "results_nqfut_addon", "cfd_current": "results_cfd19",
         "cfd_addon": "results_cfd19_addon"}
    S = {k: json.load(open(os.path.join(HERE, v + FEE_TAG, "summary.json"))) for k, v in R.items()}
    rows = [("eval_pass", "Eval pass rate (an eval started on every session)", lambda s: s["eval"]["pass_pct"], "pct"),
            ("eval_days_median", "Sessions to pass, median", lambda s: s["eval"]["sessions_to_pass"]["median"], "sessions"),
            ("funded_paid", "Funded accounts that reach a payout", lambda s: s["funded"]["pct_with_a_payout"], "pct"),
            ("funded_avg_net", "Paid to you per funded account, average", lambda s: s["funded"]["avg_withdrawn_net"], "usd"),
            ("slot_first_median", "One account slot: first payout, median", lambda s: s["first_payout"]["median_days"], "days"),
            ("slot_within_90", "One account slot: first payout within 90 days", lambda s: s["first_payout"]["pct_within_90_days"], "pct"),
            ("pool_net_year", "5 funded + 5 evals: net a year (median of 10 start dates)", lambda s: s["pool"]["net_per_year_median"], "usd"),
            ("pool_worst_12m", "5 funded + 5 evals: worst 12 months", lambda s: s["pool"]["worst_12_months"], "usd"),
            ("pool_gap", "5 funded + 5 evals: longest wait for a payout", lambda s: s["pool"]["longest_gap_months"]["max"], "months"),
            ("pool_months_paid", "5 funded + 5 evals: months with a payout", lambda s: s["pool"]["pct_months_with_a_payout"], "pct"),
            ("pool_years_positive", "5 funded + 5 evals: full years positive (2020-2025)", lambda s: s["pool"]["pct_full_years_positive"], "pct"),
            ("pool_total", "5 funded + 5 evals: total over the period (first start date)", lambda s: s["pool"]["first_path_total"], "usd"),
            ("pool_max_dd", "5 funded + 5 evals: deepest drop (first start date)", lambda s: -s["pool"]["first_path_max_drawdown"], "usd"),
            ("stress_net_year", "2x commission + 1 tick slippage: net a year", lambda s: s["stress_2x_costs_1_tick"]["net_per_year_median"], "usd"),
            ("book_net_year", "One funded account trading every day: net a year", lambda s: s["book"]["net_per_year"], "usd"),
            ("book_worst_day", "One funded account trading every day: worst day", lambda s: s["book"]["worst_day"], "usd")]
    write(out, "fut_full.csv", ["metric", "label", "fut_current", "fut_addon", "cfd_current", "cfd_addon", "unit"],
          [[m, lab, round(float(f(S["fut_current"])), 2), round(float(f(S["fut_addon"])), 2), round(float(f(S["cfd_current"])), 2),
            round(float(f(S["cfd_addon"])), 2), u] for m, lab, f, u in rows])

    pool = {k: {r["year"]: float(r["net_usd_first_path"]) for r in csv.DictReader(open(os.path.join(HERE, v + FEE_TAG, "pool_years.csv")))}
            for k, v in R.items()}
    book = {k: {r["year"]: float(r["net_usd"]) for r in csv.DictReader(open(os.path.join(HERE, R[k] + FEE_TAG, "book_years.csv")))}
            for k in ("fut_current", "cfd_current")}
    evp = {k: {r["year_started"]: float(r["pass_pct"]) for r in csv.DictReader(open(os.path.join(HERE, v + FEE_TAG, "eval_pass_by_year.csv")))}
           for k, v in R.items()}
    yrows = []
    for y in sorted(pool["fut_current"]):
        per = "from Sep 3" if y == "2019" else ("to Nov 17 (CFD: Nov 13)" if y == "2026" else "full year")
        src = ("real NQ futures" if y <= "2023" else "real futures to Aug 9, then the CFD" if y == "2024"
               else "the CFD" if y == "2025" else "the CFD to Sep 9, then real MNQ")
        yrows.append([y, per, src, round(pool["fut_current"][y]), round(pool["fut_addon"][y]), round(pool["cfd_current"][y]),
                      round(pool["cfd_addon"][y]), round(book["fut_current"][y]), round(book["cfd_current"][y]),
                      evp["fut_current"][y], evp["cfd_current"][y], evp["fut_addon"][y], evp["cfd_addon"][y]])
    write(out, "fut_years.csv", ["year", "period", "futures_data", "fut_current_usd", "fut_addon_usd", "cfd_current_usd",
                                 "cfd_addon_usd", "fut_book_usd", "cfd_book_usd", "fut_pass_current_pct", "cfd_pass_current_pct",
                                 "fut_pass_addon_pct", "cfd_pass_addon_pct"], yrows)
    shutil.copy(os.path.join(HERE, "results_nqfut_check", "nqfut_check.csv"), os.path.join(out, "fut_check.csv"))
    print("wrote fut_check.csv (copy of results_nqfut_check/nqfut_check.csv)")
    info = json.load(open(os.path.join(fd, "NQFUT.npz.json")))
    corr = info["monthly_corr_with_cfd"]
    seg = info["segments"]
    filled = info["rth_bars_filled_from_cfd"]
    drows = [["fut", "Real NQ futures (the 5-year file)", seg[0]["first"][:10], seg[0]["last"][:10], seg[0]["bars"],
              f"clock repaired; 5-minute moves vs the market {min(corr.values()):.3f} to {max(corr.values()):.3f} by month"]]
    for y in ("2019", "2020", "2021", "2022", "2023", "2024"):
        n, tot = filled[y].split(" of ")
        drows.append([f"fill{y}", f"  {y}: day-session bars filled from the CFD", "", "", int(n), f"{100 * int(n) / int(tot):.1f}% of {tot}"])
    drows.append(["cfd", "HistData Nasdaq-100 CFD, made into 5-minute bars", seg[1]["first"][:10], seg[1]["last"][:10], seg[1]["bars"],
                  "the gap after the file ends"])
    drows.append(["mnq", "Real MNQ futures (Yahoo Finance, 5-minute)", seg[2]["first"][:10], seg[2]["last"][:10], seg[2]["bars"],
                  "to 12:40 ET on Nov 17 2026"])
    write(out, "fut_data.csv", ["id", "source", "from", "to", "bars", "note"], drows)


def main(fd, out):
    os.makedirs(out, exist_ok=True)
    R5._init(fd, fd, {"nq"})
    S = R5._S["nq"]
    print(f"futures sessions {len(S.days)}: first tradable {R5.iso(S.days[R4._G['k0']])}, last {R5.iso(S.days[-1])}", flush=True)
    plac = [f"P thr {x}" for x in (0.712, 0.715, 0.722, 0.725)] + [f"P size ref {x}" for x in (340, 345, 355, 360)]
    C = [("BASE", [R5.nq()]), ("ADDON", [R5.nq(ek=dict(cons=0.5))])]
    C += [(f"P thr {x}", [R5.nq(dict(thr=x), dict(thr=x))]) for x in (0.712, 0.715, 0.722, 0.725)]
    C += [(f"P size ref {x}", [R5.nq(fk=dict(adr_ref=x))]) for x in (340, 345, 355, 360)]
    D = []
    for N in range(1, 6):
        D += [(f"A{N}", [R5.nq(N=N, mt=None, struct="A")]), (f"C{N}", [R5.nq(N=N, mt=N)]), (f"B{N}", [R5.nq(N=N, mt=2 * N)])]
    jobs = [(n, parts, w, o) for n, parts in C for w in ("all", "5y") for o in OFF]
    jobs += [(n, parts, "5y", o) for n, parts in D for o in OFF]
    res = R5.run_jobs(fd, fd, jobs, {"nq"})
    for o in OFF:  # B5 is the current rules: the same runs
        assert res[("B5", "5y", o)]["periods"] == res[("BASE", "5y", o)]["periods"]
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in res.items()}, open(os.path.join(out, "runs.json"), "w"))
    summ = accounts(res, out)
    print(f"  5 funded + 5 evals on futures, last 5 years: net ${summ['B5'][2]:,} a year, worst full year ${summ['B5'][3]:,}, "
          f"worst 12 months ${summ['B5'][6]:,}", flush=True)
    addon(res, out, plac)
    fut_tables(out, fd)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
