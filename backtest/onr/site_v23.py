#!/usr/bin/env python3
"""The website's account and add-on datasets for indicator v2.3's default plan, the user's setup.

usage: ONR_MAX_PAY=4 site_v23.py FUT_DATA_DIR CFD_DATA_DIR LIVE_DATA_DIR OUT_DIR
  FUT_DATA_DIR: NQFUT.npz (prep_nqfut.py) and SPXUSD.npz. CFD_DATA_DIR: NSXUSD.npz and SPXUSD.npz (HistData minute bars).
  LIVE_DATA_DIR: MNQ_5m_60d.npz, NSXUSD.npz and the extended SPXUSD.npz (export_charts.py's real-MNQ inputs).

The plan: the 50% consistency add-on on every eval at $90.50 ($80.50 with a discount code + $10 for the add-on), each
funded account closed right after its 4th payout (so no 5th payout ever moves the trader live), up to 5 funded accounts
and 10 in all. The comparison: the 40% rule at $80.50 with the same payout plan.
Machinery: research round 5's, unchanged (research4.sim_pool / sim_slots, 12 start dates, research5.metrics), with the
eval price passed per run; the futures runs swap research4._init for futures_site.fut_init as futures_site.py does.
Writes into OUT_DIR:
  accounts_5y.csv, accounts_5y_years_wide.csv   real NQ futures, last 5 years: structures A, C, B x 1-5 accounts
  accounts_table.csv, accounts_years_wide.csv   Nasdaq-100 CFD, Feb 2011 - Nov 2026: the same structures
  addon_kpis.csv, addon_years.csv, addon_prices.csv, addon_summary.csv   futures: 40% at $80.50 vs the add-on at $90.50
  addon_real.csv, addon_journey.csv             the 60 sessions of real MNQ, both plans (export_charts.py's functions)
  runs_fut.json, runs_cfd.json                  every run's metrics
Checks before writing: B5 here = live50k.py's B5-addon-stop4 and B5-stop4 (results_live<FEE_TAG>_addon10, mean of the
same 12 start dates); report50k.py's runs of both plans (results_v23_nqfut_5y*) are the plans asked for; the real-MNQ
counts = mnq_real50k.py's (export_charts.REAL_BY_PLAN).
"""
import csv
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account  # noqa: E402
import research4 as R4  # noqa: E402

CFD_INIT = R4._init
ORIG = {n: getattr(account, n) for n in ("funded_on", "pyramid", "ib_breakout", "eval_bracket")}
import futures_site as FS  # noqa: E402  (swaps research4._init for the futures loader)
import addon50k as A50  # noqa: E402
import export_charts as X  # noqa: E402  (wraps the four account functions above to count commission)
import research5 as R5  # noqa: E402
from account import RULES, run_eval  # noqa: E402
from engine import Sessions, load_npz, rth_sessions  # noqa: E402

for _n, _f in ORIG.items():  # the bookkeeping wrappers pass results through unchanged but replay every trade: not needed here
    setattr(account, _n, _f)
FUT_INIT = R4._init
HERE = os.path.dirname(os.path.abspath(__file__))
OFF = R4.OFFSETS
FEE40, ADDON_PRICE = 80.50, 10.0
FEE_PLAN = FEE40 + ADDON_PRICE
ADD, FK4 = dict(cons=0.5), dict(max_pay=4)
PRICES = (0.0, 2.5, 5.0, 7.5, 10.0, 15.0, 20.0, 30.0, 40.0, 50.0)
PLAC = [f"P thr {x}" for x in (0.712, 0.715, 0.722, 0.725)] + [f"P size ref {x}" for x in (340, 345, 355, 360)]
LAB = {"A": "N accounts bought the same day (copy-traded in lockstep)",
       "C": "N accounts, each an eval then funded, at most one new eval a day", "B": "N funded + N evals in reserve"}


def structures():
    """A, C and B x 1-5 accounts on the plan (B5 is the plan itself)."""
    c = []
    for N in range(1, 6):
        c += [(f"A{N}", [R5.nq(ek=ADD, fk=FK4, N=N, mt=None, struct="A")]), (f"C{N}", [R5.nq(ek=ADD, fk=FK4, N=N, mt=N)]),
              (f"B{N}", [R5.nq(ek=ADD, fk=FK4, N=N, mt=2 * N)])]
    return c


def futures_runs(fd):
    R4._init = FUT_INIT
    jobs = [(n, parts, "5y", o, FEE_PLAN) for n, parts in structures() for o in OFF]
    plan = R5.nq(ek=ADD, fk=FK4)
    jobs += [("PLAN", [plan], "all", o, FEE_PLAN) for o in OFF]
    jobs += [("PLAN80", [plan], w, o, FEE40) for w in ("5y", "all") for o in OFF]  # the add-on before its own price
    cfg = [("BASE40", [R5.nq(fk=FK4)])]
    cfg += [(f"P thr {x}", [R5.nq(dict(thr=x), dict(thr=x, **FK4))]) for x in (0.712, 0.715, 0.722, 0.725)]
    cfg += [(f"P size ref {x}", [R5.nq(fk=dict(adr_ref=x, **FK4))]) for x in (340, 345, 355, 360)]
    jobs += [(n, parts, w, o, FEE40) for n, parts in cfg for w in ("5y", "all") for o in OFF]
    res = R5.run_jobs(fd, fd, jobs, {"nq"})
    for o in OFF:
        res[("PLAN", "5y", o)] = res[("B5", "5y", o)]
    return res


def cfd_runs(dd):
    R4._init = CFD_INIT
    res = R5.run_jobs(dd, dd, [(n, parts, "all", o, FEE_PLAN) for n, parts in structures() for o in OFF], {"nq"})
    R4._init = FUT_INIT
    return res


def check_live50k(res):
    """B5 here must be live50k.py's stop4 rows (sim_pool with max_pay=4, the same 12 start dates)."""
    rows = {r["id"]: r for r in csv.DictReader(open(os.path.join(HERE, "results_live_fee8050_addon10", "lucid_5y.csv")))}
    a, b = rows["B5-addon-stop4"], rows["B5-stop4"]
    assert float(a["eval_price_usd"]) == FEE_PLAN and float(b["eval_price_usd"]) == FEE40, (a["eval_price_usd"], b["eval_price_usd"])
    for rid, name in (("B5-addon-stop4", "PLAN"), ("B5-stop4", "BASE40")):
        m = np.mean([res[(name, "5y", o)]["periods"]["last 5y"]["M"] for o in OFF])
        w = np.mean([res[(name, "5y", o)]["periods"]["last 5y"]["W"] for o in OFF])
        assert abs(m - float(rows[rid]["net_per_year_usd"])) < 1.0 and abs(w - float(rows[rid]["worst_full_year_usd"])) < 1.0, \
            (rid, m, rows[rid]["net_per_year_usd"], w, rows[rid]["worst_full_year_usd"])
    print(f"check passed: B5 = live50k's B5-addon-stop4 (${float(a['net_per_year_usd']):,.0f} a year) and the 40% "
          f"comparison = its B5-stop4 (${float(b['net_per_year_usd']):,.0f})", flush=True)


def cfd_tables(res, out):
    """accounts_table.csv and accounts_years_wide.csv on the CFD's every year (research4/report4's formats, all years)."""
    rows, wide = [], []
    for st in ("C", "B", "A"):
        for N in range(1, 6):
            R = [res[(f"{st}{N}", "all", o)] for o in OFF]
            g = lambda key: float(np.mean([r["periods"]["all years"][key] for r in R]))  # noqa: E731
            ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
            fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
            rows.append([f"{st}{N}", LAB[st], N, round(g("M")), round(g("W")), round(g("L"), 2), round(g("D")),
                         round(g("worst12")), round(g("gap"), 1), round(g("months_paid"), 1), round(g("evals_yr"), 1),
                         round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1), round(ev("median_pass"), 1),
                         round(fu("started"), 1), round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1),
                         round(fu("payouts"), 1), round(fu("payouts_usd") / max(fu("payouts"), 1e-9)),
                         round(float(np.mean([r["cash_low"] for r in R]))), round(float(np.mean([r["total"] for r in R])))])
    FS.write(out, "accounts_table.csv", ["id", "structure", "accounts", "net_year_all_usd", "worst_year_usd", "losing_years",
                                         "deepest_drop_usd", "worst_12m_usd", "longest_gap_months", "months_with_payout_pct",
                                         "evals_per_year", "eval_pass_pct", "eval_median_sessions", "funded_accounts",
                                         "funded_with_payout_pct", "payouts", "average_payout_usd", "most_cash_out_usd",
                                         "total_net_usd"], rows)
    years = sorted({y for k, v in res.items() for y in v["years"]})
    for y in years:
        row = [y]
        for st in ("C", "B"):
            for N in range(1, 6):
                vals = [res[(f"{st}{N}", "all", o)]["years"][y] for o in OFF if y in res[(f"{st}{N}", "all", o)]["years"]]
                nets = [v["net"] for v in vals]
                p, f = sum(v["evals_passed"] for v in vals), sum(v["evals_failed"] for v in vals)
                row += [round(float(np.median(nets))), round(min(nets)), round(max(nets)),
                        round(100 * p / (p + f), 1) if p + f else 0.0, float(np.median([v["payouts"] for v in vals])),
                        float(np.median([v["evals_bought"] for v in vals]))]
        wide.append(row)
    FS.write(out, "accounts_years_wide.csv", ["year"] + [f"{st.lower()}{n}_{k}" for st in ("C", "B") for n in range(1, 6)
                                                        for k in ("net_usd", "net_low_usd", "net_high_usd", "eval_pass_pct",
                                                                  "payouts", "evals")], wide)


def addon_tables(res, out):
    cur = json.load(open(os.path.join(HERE, "results_v23_nqfut_5y", "summary.json")))
    add = json.load(open(os.path.join(HERE, "results_v23_nqfut_5y_addon", "summary.json")))
    assert cur["eval_price"] == FEE40 and add["eval_price"] == FEE_PLAN and add["eval_consistency"] == 0.5
    assert "eval_consistency" not in cur and cur["max_payouts_per_account"] == add["max_payouts_per_account"] == 4
    assert cur["window"] == add["window"] and cur["book"] == add["book"] and cur["nq_file"] == add["nq_file"] == "NQFUT.npz"
    b5, a5 = [res[("BASE40", "5y", o)] for o in OFF], [res[("PLAN", "5y", o)] for o in OFF]
    ball, aall = [res[("BASE40", "all", o)] for o in OFF], [res[("PLAN", "all", o)] for o in OFF]
    k = A50.kpis(cur, add, b5, a5)
    k.insert(0, ["eval_price", "Eval price (with the add-on: $80.50 + $10)", FEE40, FEE_PLAN, "usd", "setup"])
    FS.write(out, "addon_kpis.csv", ["metric", "label", "current", "addon", "unit", "source"], k)
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
    FS.write(out, "addon_years.csv", ["window", "year", "period", "current_net_usd", "addon_net_usd", "difference_usd",
                                      "current_payouts", "addon_payouts", "current_evals_bought", "addon_evals_bought",
                                      "current_eval_pass_pct", "addon_eval_pass_pct"], yrows)
    # rule 5Y at add-on prices (futures_site.addon's method): the add-on before its price (PLAN80) minus price x evals,
    # against the 40% plan and the noise band of its 8 placebo runs
    per = {"last 5y": "5y", "2011-21": "all"}

    def mean(name, lab, p=0.0):
        M, W = [], []
        for o in OFF:
            r = res[(name, per[lab], o)]
            M.append(r["periods"][lab]["M"] - p * r["periods"][lab]["evals_yr"])
            W.append(min(r["years"][y]["net"] - p * r["years"][y]["evals_bought"] for y in R5.FULL5[lab] if y in r["years"]))
        return float(np.mean(M)), float(np.mean(W))
    base = {lab: mean("BASE40", lab) for lab in per}
    band = {lab: tuple(max(abs(mean(n, lab)[i] - base[lab][i]) for n in PLAC) for i in (0, 1)) for lab in per}

    def score(p):
        A = {lab: mean("PLAN80", lab, p) for lab in per}
        dM5, dW5 = A["last 5y"][0] - base["last 5y"][0], A["last 5y"][1] - base["last 5y"][1]
        bM, bW = band["last 5y"]
        route = "consistency" if (dW5 > bW and dM5 >= -bM) else ("money" if (dM5 > bM and dW5 >= -bW) else "")
        dMo, dWo = A["2011-21"][0] - base["2011-21"][0], A["2011-21"][1] - base["2011-21"][1]
        ok_old = dMo >= -band["2011-21"][0] and dWo >= -band["2011-21"][1]
        return A, dM5, dW5, dMo, dWo, route, ok_old
    at10 = {lab: mean("PLAN", lab) for lab in per}  # the add-on's own run at $90.50 = PLAN80 - $10 an eval (checked)
    assert all(abs(at10[lab][i] - mean("PLAN80", lab, ADDON_PRICE)[i]) < 0.01 for lab in per for i in (0, 1)), at10
    prows = []
    for p in PRICES:
        A, dM5, dW5, dMo, dWo, route, ok_old = score(p)
        prows.append([p, round(A["last 5y"][0]), round(dM5), round(A["last 5y"][1]), round(dW5), round(dMo),
                      "pass" if route and ok_old else "fail"])
    FS.write(out, "addon_prices.csv", ["addon_price_usd", "net_per_year_usd", "net_vs_current_usd", "worst_full_year_usd",
                                       "worst_year_vs_current_usd", "net_2011_21_vs_current_usd", "rule_5y"], prows)
    lo, hi = 0.0, 200.0  # the price at which the add-on's net a year equals the 40% plan's (last 5 years)
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if score(mid)[1] > 0 else (lo, mid)
    z, z10 = score(0.0), score(ADDON_PRICE)
    srows = [["eval_price", "Eval price without the add-on", FEE40, "usd"],
             ["addon_price", "The add-on's price per eval", ADDON_PRICE, "usd"],
             ["pass_default_5y", "Eval pass rate, 40% rule, last 5 years", cur["eval"]["pass_pct"], "pct"],
             ["pass_addon_5y", "Eval pass rate, 50% add-on, last 5 years", add["eval"]["pass_pct"], "pct"],
             ["slot_first_default_5y", "First payout after the first eval, median, 40% rule", cur["first_payout"]["median_days"], "days"],
             ["slot_first_addon_5y", "First payout after the first eval, median, 50% add-on", add["first_payout"]["median_days"], "days"],
             ["net_current_5y", "Net a year, 40% rule, last 5 years", round(base["last 5y"][0]), "usd"],
             ["net_addon_5y", "Net a year with the add-on at $10, last 5 years", round(z10[0]["last 5y"][0]), "usd"],
             ["net_gain_5y", "Net a year gained with the add-on at $10, last 5 years", round(z10[1]), "usd"],
             ["net_gain_free_5y", "Net a year gained if the add-on were free, last 5 years", round(z[1]), "usd"],
             ["breakeven_price", "Add-on price per eval at which it pays for itself, last 5 years", round(lo, 2), "usd"],
             ["worst_current_5y", "Worst full year, 40% rule, last 5 years", round(base["last 5y"][1]), "usd"],
             ["worst_addon_5y", "Worst full year with the add-on at $10, last 5 years", round(z10[0]["last 5y"][1]), "usd"],
             ["worst12_current_5y", "Worst 12 months, 40% rule, last 5 years",
              round(float(np.mean([r["periods"]["last 5y"]["worst12"] for r in b5]))), "usd"],
             ["worst12_addon_5y", "Worst 12 months with the add-on at $10, last 5 years",
              round(float(np.mean([r["periods"]["last 5y"]["worst12"] for r in a5]))), "usd"],
             ["net_gain_early", "Net a year gained with the add-on at $10, Aug 30 2019 - Nov 14 2021", round(z10[3]), "usd"],
             ["band_net_5y", "Noise band for net a year, last 5 years (8 placebo runs)", round(band["last 5y"][0]), "usd"],
             ["band_worst_5y", "Noise band for the worst full year, last 5 years (8 placebo runs)", round(band["last 5y"][1]), "usd"],
             ["rule5y_at_10", "Rule 5Y at the add-on's $10", 1 if (z10[5] and z10[6]) else 0, "count"],
             ["evals_year_addon_5y", "Evals bought a year with the add-on, last 5 years",
              round(float(np.mean([r["periods"]["last 5y"]["evals_yr"] for r in a5])), 1), "count"]]
    FS.write(out, "addon_summary.csv", ["metric", "label", "value", "unit"], srows)
    print(f"  add-on at $10 vs the 40% rule, both closed after the 4th payout: {z10[1]:+,.0f} a year (band "
          f"{band['last 5y'][0]:,.0f}), worst year {z10[2]:+,.0f} (band {band['last 5y'][1]:,.0f}); break-even ${lo:.2f} an eval",
          flush=True)


def real_tables(dd, out):
    """addon50k.real on the plan: the 60 real-MNQ sessions under the 40% rule at $80.50 and the add-on at $90.50, both
    closed after the 4th payout. export_charts reads ONR_MAX_PAY at import, so its F_KW is the plan's."""
    assert X.MAXPAY == 4, "run with ONR_MAX_PAY=4"
    mnq = load_npz(os.path.join(dd, "MNQ_5m_60d.npz"))
    own = rth_sessions(*mnq)
    src = {d: v for d, v in rth_sessions(*load_npz(os.path.join(dd, "NSXUSD.npz"))).items() if d < min(own)}
    src.update(own)
    R = Sessions(mnq, load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5, adr_src=src)
    m0 = int(np.argmax([not np.isnan(R.S[d]["adr"]) and not np.isnan(R.S[d]["score"]) for d in R.days]))
    kr = range(m0, len(R.days))
    base = {k: v for k, v in X.E_KW.items() if k != "cons"}
    keep = (X.E_KW, X.FEE)
    out_, steps = {}, {}
    for name, ek, fee, cons in (("current", base, FEE40, 0.4), ("addon", dict(base, cons=0.5), FEE_PLAN, 0.5)):
        X.E_KW, X.FEE = ek, fee  # journey() and pool_rows() read the module's eval settings and price
        ev = [run_eval(R, k, **ek) for k in kr]
        fin = [r for r in ev if r["result"] != "open"]
        ja = X.journey(R, m0, len(R.days))
        pays = [x[3] for x in ja if x[3] > 0]
        ne, prev_phase, prev_event = 0, "", ""
        for date, phase, pnl, amt, bought, cash, event in ja:
            words = []
            if bought:
                ne += 1
                if prev_phase.startswith("eval") and not prev_event:
                    words.append(f"{prev_phase} ends (cushion below ${50.0 * RULES[50]['mll'] / 1000.0:,.0f}, too small to trade)")
                words.append(f"eval {ne} bought")
            if event:
                words.append(event.replace(" requested", f" requested (${amt:,.0f})") if amt > 0 else event)
            if words:
                steps.setdefault(str(date), {})[name] = (phase, "; ".join(words), round(pnl, 2), round(cash, 2))
            prev_phase, prev_event = phase, event
        _, rs = X.pool_rows(R, m0, len(R.days))
        want = X.REAL_BY_PLAN[(cons, 4)]
        assert [round(p) for p in pays] == want["slot_payouts"] and sum(x[4] for x in ja) == want["slot_evals"], (name, pays)
        assert (rs["payouts"], round(rs["gross"]), rs["evals"]) == want["pool"], (name, rs)
        assert abs(ja[-1][5] - (0.9 * sum(pays) - fee * want["slot_evals"])) < 0.01
        out_[name] = dict(finished=len(fin), passed=sum(r["result"] == "pass" for r in fin), slot_payouts=len(pays),
                          slot_evals=sum(x[4] for x in ja), slot_cash=ja[-1][5], pool_payouts=rs["payouts"],
                          pool_gross=rs["gross"], pool_evals=rs["evals"], pool_net=rs["net"])
    X.E_KW, X.FEE = keep
    print("check passed: both plans on real MNQ = mnq_real50k.py's counts", flush=True)
    c, a = out_["current"], out_["addon"]
    rows = [["eval_price", "Eval price", FEE40, FEE_PLAN, "usd"],
            ["evals_finished", "Evals finished (one started every session)", c["finished"], a["finished"], "count"],
            ["evals_passed", "Evals passed", c["passed"], a["passed"], "count"],
            ["eval_pass", "Eval pass rate", round(100 * c["passed"] / c["finished"], 1), round(100 * a["passed"] / a["finished"], 1), "pct"],
            ["slot_payouts", "One account bought on the first day: payouts", c["slot_payouts"], a["slot_payouts"], "count"],
            ["slot_evals", "One account bought on the first day: evals bought", c["slot_evals"], a["slot_evals"], "count"],
            ["slot_net", "One account bought on the first day: net to you", round(c["slot_cash"], 2), round(a["slot_cash"], 2), "usd"],
            ["pool_payouts", "5 funded + 5 evals: payouts", c["pool_payouts"], a["pool_payouts"], "count"],
            ["pool_evals", "5 funded + 5 evals: evals bought", c["pool_evals"], a["pool_evals"], "count"],
            ["pool_net", "5 funded + 5 evals: net to you", round(c["pool_net"], 2), round(a["pool_net"], 2), "usd"]]
    FS.write(out, "addon_real.csv", ["metric", "label", "current", "addon", "unit"], rows)
    jrows = []
    for date in sorted(steps):
        row = [date]
        for name in ("current", "addon"):
            ph, ev_, pnl, cash = steps[date].get(name, ("", "", "", ""))
            row += [ph, ev_, pnl, cash]
        jrows.append(row)
    FS.write(out, "addon_journey.csv", ["date", "current_phase", "current_event", "current_account_pnl_usd", "current_your_cash_usd",
                                        "addon_phase", "addon_event", "addon_account_pnl_usd", "addon_your_cash_usd"], jrows)


def fut_tables(out, fd):
    """futures_site.fut_tables on the plan's report50k.py runs: real futures vs the CFD from Sep 3 2019, the 40% rule at
    $80.50 and the add-on at $90.50, both closed after the 4th payout (results_v23_*). fut_check.csv and fut_data.csv
    describe the data, not a plan, and are made by futures_site.fut_tables' own code."""
    R = {"fut_current": "results_v23_nqfut", "fut_addon": "results_v23_nqfut_addon", "cfd_current": "results_v23_cfd19",
         "cfd_addon": "results_v23_cfd19_addon"}
    S = {k: json.load(open(os.path.join(HERE, v, "summary.json"))) for k, v in R.items()}
    for k, s in S.items():
        assert s["max_payouts_per_account"] == 4 and s["window"][0] == "2019-09-03", (k, s["window"])
        assert s["eval_price"] == (FEE_PLAN if k.endswith("addon") else FEE40), (k, s["eval_price"])
        assert s.get("eval_consistency", 0.4) == (0.5 if k.endswith("addon") else 0.4), k
        assert (s.get("nq_file") == "NQFUT.npz") == k.startswith("fut"), (k, s.get("nq_file"))
    saved = {n: getattr(FS, n) for n in ("HERE", "FEE_TAG")}
    tmp = os.path.join(out, "_fut_tmp")
    os.makedirs(tmp, exist_ok=True)
    for k, v in R.items():  # futures_site.fut_tables reads results_nqfut<FEE_TAG> etc.: point it at the plan's runs
        link = os.path.join(tmp, {"fut_current": "results_nqfut", "fut_addon": "results_nqfut_addon",
                                  "cfd_current": "results_cfd19", "cfd_addon": "results_cfd19_addon"}[k])
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(os.path.join(HERE, v), link)
    chk = os.path.join(tmp, "results_nqfut_check")
    if os.path.lexists(chk):
        os.remove(chk)
    os.symlink(os.path.join(HERE, "results_nqfut_check"), chk)
    FS.HERE, FS.FEE_TAG = tmp, ""
    try:
        FS.fut_tables(out, fd)
    finally:
        for n, v in saved.items():
            setattr(FS, n, v)


def main(fd, dd, ld, out):
    os.makedirs(out, exist_ok=True)
    real_tables(ld, out)
    rf = futures_runs(fd)
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in rf.items()}, open(os.path.join(out, "runs_fut.json"), "w"))
    check_live50k(rf)
    summ = FS.accounts(rf, out)
    print(f"  plan on futures, last 5 years: net ${summ['B5'][2]:,} a year, worst full year ${summ['B5'][3]:,}, "
          f"worst 12 months ${summ['B5'][6]:,}", flush=True)
    addon_tables(rf, out)
    rc = cfd_runs(dd)
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in rc.items()}, open(os.path.join(out, "runs_cfd.json"), "w"))
    cfd_tables(rc, out)
    print("done", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "--fut-tables":  # site_v23.py --fut-tables FUT_DATA_DIR OUT_DIR
        fut_tables(sys.argv[3], sys.argv[2])
    else:
        main(*sys.argv[1:5])
