#!/usr/bin/env python3
"""The backtest with Lucid's paid 50% consistency add-on, side by side with the current rules (dashboard datasets).

usage (ONR_EVAL_FEE_50K=88.20): addon50k.py DATA_LIVE_DIR OUT_DIR
Reads, never recomputes, the runs it compares (all at the same eval price, before the add-on's own price):
  results_50k_5y<FEE_TAG>/summary.json         current rules, report50k.py, last 5 years
  results_50k_5y_addon<FEE_TAG>/summary.json   the same with ONR_EVAL_CONS=0.5
  results_r6<FEE_TAG>/runs.json                current rules, 5 funded + 5 evals, 12 start dates (BASE)
  results_options<FEE_TAG>/addon_runs.json      the same with the add-on (options50k.py)
  results_options<FEE_TAG>/addon_rule5y.csv     rule 5Y at add-on prices $0-50 an eval
and runs one thing itself: the 60 sessions of real MNQ futures (Sep 9 - Nov 17 2026) with export_charts.py's own
functions, eval settings swapped; the current rules must reproduce export_charts.py's checked figures exactly.
Writes addon_kpis.csv, addon_years.csv, addon_prices.csv, addon_real.csv and addon_journey.csv (one real-MNQ account
bought on the first day, every eval purchase, pass, fail, payout and abandonment under both rules).
The add-on is modelled as exactly 50%. Lucid's help centre describes a small extra cushion (a 50K best day of up to
$1,560 instead of $1,500), so this is slightly conservative. Funded accounts have no consistency rule either way.
"""
import csv
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_charts as X  # noqa: E402
import research4 as R4  # noqa: E402
from account import FEE_TAG, RULES, run_eval  # noqa: E402
from engine import Sessions, adr_seed, load_npz, rth_sessions  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OFF = R4.OFFSETS


def write(out, name, header, rows):
    with open(os.path.join(out, name), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)
    print(f"wrote {name}: {len(rows)} rows")


def kpis(cur, add, b6, a6):
    """Side-by-side single figures: report50k (evals and funded accounts started on every session, one account slot)
    and the research-round machinery (5 funded + 5 evals, mean of 12 start dates)."""
    rows = []

    def r(metric, label, f, unit, src):
        nd = {"usd": 0, "count": 1}.get(unit, 2)  # whole dollars; counts that are means of 12 start dates to 0.1
        rows.append([metric, label, round(float(f(cur if src == "report" else b6)), nd),
                     round(float(f(add if src == "report" else a6)), nd), unit, src])

    e, fu, fp = (lambda s: s["eval"]), (lambda s: s["funded"]), (lambda s: s["first_payout"])
    r("eval_pass", "Eval pass rate (an eval started on every session)", lambda s: e(s)["pass_pct"], "pct", "report")
    r("eval_days_median", "Sessions to pass, median", lambda s: e(s)["sessions_to_pass"]["median"], "sessions", "report")
    r("eval_days_p90", "Sessions to pass, 90th percentile", lambda s: e(s)["sessions_to_pass"]["p90"], "sessions", "report")
    r("eval_fail_median", "Sessions to fail, median", lambda s: e(s)["sessions_to_fail_median"], "sessions", "report")
    r("evals_per_funded", "Evals bought per funded account", lambda s: e(s)["evals_per_funded_account"], "count", "report")
    r("fees_per_funded", "Eval fees per funded account", lambda s: e(s)["eval_cost_per_funded_account"], "usd", "report")
    r("funded_paid", "Funded accounts that reach a payout", lambda s: fu(s)["pct_with_a_payout"], "pct", "report")
    r("funded_avg_payouts", "Payouts per funded account, average", lambda s: fu(s)["avg_payouts"], "count", "report")
    r("funded_avg_net", "Paid to you per funded account, average (after Lucid's 10%)", lambda s: fu(s)["avg_withdrawn_net"], "usd", "report")
    r("slot_first_median", "One account slot: days from the first eval to the first payout, median",
      lambda s: fp(s)["median_days"], "days", "report")
    r("slot_within_30", "One account slot: first payout within 30 days", lambda s: fp(s)["pct_within_30_days"], "pct", "report")
    r("slot_within_90", "One account slot: first payout within 90 days", lambda s: fp(s)["pct_within_90_days"], "pct", "report")
    r("slot_evals_before", "One account slot: evals bought before the first payout, average",
      lambda s: fp(s)["avg_evals_before"], "count", "report")

    def m(key, per="last 5y"):
        return lambda runs: np.mean([v["periods"][per][key] for v in runs])

    def tot(f):
        return lambda runs: np.mean([f(v) for v in runs])
    r("pool_net_year", "5 funded + 5 evals: net a year", m("M"), "usd", "pool")
    r("pool_worst_year", "5 funded + 5 evals: worst full year (2022-2025)", m("W"), "usd", "pool")
    r("pool_worst_12m", "5 funded + 5 evals: worst 12 months", m("worst12"), "usd", "pool")
    r("pool_gap", "5 funded + 5 evals: longest wait for a payout", m("gap"), "months", "pool")
    r("pool_months_paid", "5 funded + 5 evals: months with a payout", m("months_paid"), "pct", "pool")
    r("pool_deepest_drop", "5 funded + 5 evals: deepest drop in cumulative net", m("D"), "usd", "pool")
    r("pool_total", "5 funded + 5 evals: total net, 5 years", tot(lambda v: v["total"]), "usd", "pool")
    r("pool_cash_low", "5 funded + 5 evals: most cash out of pocket", tot(lambda v: v["cash_low"]), "usd", "pool")
    r("pool_payouts", "5 funded + 5 evals: payouts in 5 years", tot(lambda v: v["funded"]["payouts"]), "count", "pool")
    r("pool_evals_year", "5 funded + 5 evals: evals bought a year", m("evals_yr"), "count", "pool")
    r("pool_pass_pct", "5 funded + 5 evals: share of the evals it bought that passed",
      tot(lambda v: 100 * v["evals"]["passed"] / (v["evals"]["passed"] + v["evals"]["failed"])), "pct", "pool")
    return rows


def years(b_all, a_all, b5, a5):
    """Net by calendar year, median of the 12 start dates (the Years page's method), both windows."""
    rows = []
    for window, B, A, ys in (("last 5 years", b5, a5, range(2021, 2027)), ("all years", b_all, a_all, range(2011, 2027))):
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
            elif window == "all years" and y == "2011":
                per = "from Feb 15"
            if y == "2026":
                per = "Jan 1 - Nov 13"
            rows.append([window, y, per, round(med(B, "net")), round(med(A, "net")), round(med(A, "net") - med(B, "net")),
                         med(B, "payouts"), med(A, "payouts"), med(B, "evals_bought"), med(A, "evals_bought"), pas(B), pas(A)])
    return rows


def real(dd):
    mnq = load_npz(os.path.join(dd, "MNQ_5m_60d.npz"))
    own = rth_sessions(*mnq)
    src = adr_seed(dd, own)
    R = Sessions(mnq, load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5, adr_src=src)
    m0 = int(np.argmax([not np.isnan(R.S[d]["adr"]) and not np.isnan(R.S[d]["score"]) for d in R.days]))
    kr = range(m0, len(R.days))
    base = dict(X.E_KW)
    out, steps = {}, {}
    for name, ek in (("current", base), ("addon", dict(base, cons=0.5))):
        X.E_KW = ek  # journey() and pool_rows() read the module's eval settings
        ev = [run_eval(R, k, **ek) for k in kr]
        fin = [r for r in ev if r["result"] != "open"]
        ja = X.journey(R, m0, len(R.days))
        pays = [x[3] for x in ja if x[3] > 0]
        ne, prev_phase, prev_event = 0, "", ""
        for date, phase, pnl, amt, bought, cash, event in ja:  # one account bought on the first day: what happened when
            words = []
            if bought:
                ne += 1
                # journey() buys the next eval on the session at whose start the previous one could no longer trade
                if prev_phase.startswith("eval") and not prev_event:
                    words.append(f"{prev_phase} ends (cushion below ${50.0 * RULES[50]['mll'] / 1000.0:,.0f}, too small to trade)")
                words.append(f"eval {ne} bought")
            if event:
                words.append(event.replace(" requested", f" requested (${amt:,.0f})") if amt > 0 else event)
            if words:
                steps.setdefault(str(date), {})[name] = (phase, "; ".join(words), round(pnl, 2), round(cash, 2))
            prev_phase, prev_event = phase, event
        _, rs = X.pool_rows(R, m0, len(R.days))
        out[name] = dict(finished=len(fin), passed=sum(r["result"] == "pass" for r in fin), slot_payouts=len(pays),
                         slot_gross=sum(pays), slot_evals=sum(x[4] for x in ja), slot_cash=ja[-1][5],
                         pool_payouts=rs["payouts"], pool_gross=rs["gross"], pool_evals=rs["evals"], pool_net=rs["net"])
    X.E_KW = base
    c = out["current"]  # must be export_charts.py's checked figures (REAL)
    assert [round(p) for p in [x[3] for x in X.journey(R, m0, len(R.days)) if x[3] > 0]] == X.REAL["slot_payouts"]
    assert c["slot_evals"] == X.REAL["slot_evals"], c
    assert (c["pool_payouts"], round(c["pool_gross"]), c["pool_evals"]) == X.REAL["pool"], c
    print("check passed: current rules on real MNQ = export_charts.py's checked figures")
    win = f"{X.day(R.days[m0])} to {X.day(R.days[-1])}"
    rows = [["evals_finished", "Evals finished (one started every session)", c["finished"], out["addon"]["finished"], "count"],
            ["evals_passed", "Evals passed", c["passed"], out["addon"]["passed"], "count"],
            ["eval_pass", "Eval pass rate", round(100 * c["passed"] / c["finished"], 1),
             round(100 * out["addon"]["passed"] / out["addon"]["finished"], 1), "pct"],
            ["slot_payouts", "One account bought on the first day: payouts", c["slot_payouts"], out["addon"]["slot_payouts"], "count"],
            ["slot_evals", "One account bought on the first day: evals bought", c["slot_evals"], out["addon"]["slot_evals"], "count"],
            ["slot_net", "One account bought on the first day: net to you", round(c["slot_cash"], 2),
             round(out["addon"]["slot_cash"], 2), "usd"],
            ["pool_payouts", "5 funded + 5 evals: payouts", c["pool_payouts"], out["addon"]["pool_payouts"], "count"],
            ["pool_evals", "5 funded + 5 evals: evals bought", c["pool_evals"], out["addon"]["pool_evals"], "count"],
            ["pool_net", "5 funded + 5 evals: net to you", round(c["pool_net"], 2), round(out["addon"]["pool_net"], 2), "usd"]]
    jrows = []
    for date in sorted(steps):
        row = [date]
        for name in ("current", "addon"):
            ph, ev, pnl, cash = steps[date].get(name, ("", "", "", ""))
            row += [ph, ev, pnl, cash]
        jrows.append(row)
    return rows, win, jrows


def main(dd, out):
    os.makedirs(out, exist_ok=True)
    fee = RULES[50]["price"]
    cur = json.load(open(os.path.join(HERE, f"results_50k_5y{FEE_TAG}", "summary.json")))
    add = json.load(open(os.path.join(HERE, f"results_50k_5y_addon{FEE_TAG}", "summary.json")))
    assert cur["eval_price"] == add["eval_price"] == fee and add.get("eval_consistency") == 0.5 and "eval_consistency" not in cur
    assert cur["window"] == add["window"] and cur["book"] == add["book"]  # funded accounts trade the same either way
    r6 = json.load(open(os.path.join(HERE, f"results_r6{FEE_TAG}", "runs.json")))
    ad = json.load(open(os.path.join(HERE, f"results_options{FEE_TAG}", "addon_runs.json")))
    b5, a5 = [r6[f"BASE|5y|{o}"] for o in OFF], [ad[f"ADDON|5y|{o}"] for o in OFF]
    b_all, a_all = [r6[f"BASE|all|{o}"] for o in OFF], [ad[f"ADDON|all|{o}"] for o in OFF]
    k = kpis(cur, add, b5, a5)
    k.insert(0, ["eval_price", "Eval price used (the add-on's own price not included)", fee, fee, "usd", "setup"])
    write(out, "addon_kpis.csv", ["metric", "label", "current", "addon", "unit", "source"], k)
    write(out, "addon_years.csv", ["window", "year", "period", "current_net_usd", "addon_net_usd", "difference_usd",
                                   "current_payouts", "addon_payouts", "current_evals_bought", "addon_evals_bought",
                                   "current_eval_pass_pct", "addon_eval_pass_pct"], years(b_all, a_all, b5, a5))
    pr = list(csv.DictReader(open(os.path.join(HERE, f"results_options{FEE_TAG}", "addon_rule5y.csv"))))
    write(out, "addon_prices.csv", ["addon_price_usd", "net_per_year_usd", "net_vs_current_usd", "worst_full_year_usd",
                                    "worst_year_vs_current_usd", "net_2011_21_vs_current_usd", "rule_5y"],
          [[float(p["addon_price_per_eval_usd"]), int(p["last5y_net_per_year_usd"]), int(p["last5y_net_vs_current_usd"]),
            int(p["last5y_worst_full_year_usd"]), int(p["last5y_worst_year_vs_current_usd"]),
            int(p["y2011_21_net_vs_current_usd"]), p["rule_5y"]] for p in pr])
    rr, win, jr = real(dd)
    write(out, "addon_real.csv", ["metric", "label", "current", "addon", "unit"], rr)
    write(out, "addon_journey.csv", ["date", "current_phase", "current_event", "current_account_pnl_usd", "current_your_cash_usd",
                                     "addon_phase", "addon_event", "addon_account_pnl_usd", "addon_your_cash_usd"], jr)
    print(f"real MNQ window: {win}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
