#!/usr/bin/env python3
"""export_charts.py's datasets for your plan at Topstep (50K, Standard payouts, No Activation Fee path), and 1 to 5 XFAs.

usage: topstep_charts.py LIVE_DATA_DIR FUT_DATA_DIR LUCID_CHARTS_DIR TS_REPORT_DIR OUT_DIR
  LIVE_DATA_DIR: export_charts.py's (MNQ_5m_60d.npz, NSXUSD.npz and the extended SPXUSD.npz; its CFD is the every-year
  data). FUT_DATA_DIR: NQFUT.npz and SPXUSD.npz. LUCID_CHARTS_DIR: export_charts.py's output for the Lucid plan
  (results_v23_charts). TS_REPORT_DIR: topstep_report.py's output.
Rules and costs are topstep_sim.py's (ek(50), fk(50, "standard")): $1.34 per MNQ round turn, Topstep keeps 10% of each
payout, $95 per Combine when it is bought and again every 30 days while it is open, no activation fee. Each funded leg
is at most 6 micros (the cap topstep_sim.py assumes for Topstep's scaling plan): it binds when NQ's daily range is
below about 117 points, so on most CFD sessions before 2020 and on none since 2021.
The same three runs as export_charts.py, with Topstep's accounts:
  real MNQ, 60 sessions   one funded account's trades (the same as the Lucid plan's: checked), a Combine bought on every
                          session, one account slot from the first session, 5 XFAs + 5 Combines from the first session
  last 5 years, futures   one account slot and 5 XFAs + 5 Combines from Nov 15 2021 (the pool = topstep_report.py's
                          first path: checked)
  every year, CFD         one funded account's trades with the 6-micro cap, a Combine and an XFA started on every session,
                          one account slot and 5 XFAs + 5 Combines from Feb 15 2011 (the pool = topstep_sim.py's CFD run
                          from the same date: checked)
and 1 to 5 XFAs with as many Combines behind them over the last 5 years (topstep_sim.py's machinery, 12 start dates; the
5 + 5 row = topstep_sim.py's 5y-50-standard-noact: checked).
Writes into OUT_DIR, with Topstep's names (a Combine is an "eval", an XFA a "funded" account, in the column names):
  ts_real_evals, ts_real_account, ts_real_pool, ts_slot_5y, ts_costs, ts_years_all, ts_months_all, ts_all_days,
  ts_all_trades, ts_slot_all, ts_history, ts_real_kpis, ts_sizes (.csv)
"""
import csv
import json
import os
import sys
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_charts as X  # noqa: E402  (its wrappers count commission and pass every result through unchanged)
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402
from account import EvalAccount, FundedAccount, funded_size, run_eval, run_funded  # noqa: E402
from engine import Sessions, load_npz, rth_sessions  # noqa: E402
from export_charts import COMM, LEG, WHY, day, pd_, r2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE, PATH, FEE_PATH = 50, "standard", "noact"
EK, FK = T.ek(SIZE), T.fk(SIZE, PATH)
PRICE, ACT, SPLIT = T.PRICE[FEE_PATH][SIZE], T.ACTIVATION[FEE_PATH], T.SPLIT
FUNDMAX, QDAY = T.TS[SIZE]["fundmax"], T.TS[SIZE]["qday"]
assert ACT == 0.0  # the No Activation Fee path: the rows below have no activation column
TC = ["trade", "date", "trade_type", "side", "mnq_traded", "exit", "gross_usd", "commission_usd", "net_usd", "running_net_usd"]
DC = ["date", "adr_points", "mnq_per_leg", "trades", "gross_usd", "commission_usd", "net_usd", "running_net_usd"]
JC = ["date", "phase", "account_pnl_usd", "payout_usd", "eval_bought", "your_cash_usd", "event"]
PC = ["date", "payouts", "payouts_usd", "topstep_share_usd", "evals_bought", "eval_fees_usd", "net_usd", "running_net_usd"]


def write(out, name, cols, rows):
    with open(os.path.join(out, name + ".csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(cols)
        w.writerows(rows)
    print(f"  {name}.csv: {len(rows)} rows", flush=True)


def book(S, ks):
    """export_charts.book with Topstep's XFA: a fresh 50K XFA trading every session, at most 6 micros a leg."""
    trades, days, cum = [], [], 0.0
    for k in ks:
        d = S.days[k]
        adr = S.S[d]["adr"]
        rec = []
        X.TRADES.clear()
        FundedAccount(S, record=rec, **FK).step(d)
        assert len(rec) == len(X.TRADES), (day(d), rec, X.TRADES)
        n = funded_size(adr, 350.0 * 2, nmax=FUNDMAX) if not np.isnan(adr) else 0
        g_day = c_day = n_day = 0.0
        for (_, leg, side, net), (gross, net2, why) in zip(rec, X.TRADES):
            assert abs(net - net2) < 1e-9
            comm = gross - net
            cum += net
            g_day += gross
            c_day += comm
            n_day += net
            trades.append([len(trades) + 1, day(d), LEG[leg], "BUY" if side > 0 else "SELL", int(round(comm / COMM)),
                           WHY.get(why, why), r2(gross), r2(-comm), r2(net), r2(cum)])
        days.append([day(d), r2(adr) if not np.isnan(adr) else "", n, len(rec), r2(g_day), r2(-c_day), r2(n_day), r2(cum)])
    return trades, days


def journey(S, k0, k1):
    """export_charts.journey with Topstep's accounts and fees: one account slot from session k0. Each Combine pays $95
    when bought and again on the first session 30, 60, ... days later while it is open (topstep_sim.cash_flows' rule).
    Rows: date, phase, account P&L, payout requested, Combine bought, your cash, event, and (dropped before writing) the
    fees paid that session."""
    rows, evs, cash, k, nacct = [], [], 0.0, k0, 0
    carry, carry_note = 0.0, ""  # a renewal paid on the session a dead Combine is seen: shown on that session's next row
    while k < k1:
        nacct += 1
        ev = EvalAccount(S, **EK)
        evs.append((k, "buy", nacct, 0.0))
        d_buy, nchg = int(S.days[k]), 1
        cash -= PRICE
        fee_now, bought, res = PRICE + carry, True, None
        notes = [carry_note] if carry_note else []
        carry, carry_note = 0.0, ""
        while k < k1:
            while int(S.days[k]) >= d_buy + 30 * nchg:  # a renewal falls on this session (the Combine is still open)
                cash -= PRICE
                fee_now += PRICE
                nchg += 1
                notes.append(f"Combine {nacct}'s 30-day fee")
            res = ev.step(S.days[k])
            if res == "dead":  # failed at the last session's close; seen here, where the next Combine is bought
                evs.append((k, "fail", nacct, 0.0))
                carry = fee_now if not bought else 0.0
                carry_note = "; ".join(notes + [f"Combine {nacct} ended (less than $50 above its max loss)"])
                assert not bought
                break
            if res is not None:
                evs.append((k, "pass" if res == "pass" else "fail", nacct, 0.0))
                notes.append({"pass": "Combine passed", "fail": "Combine failed"}[res])
            rows.append([day(S.days[k]), f"Combine {nacct}", r2(ev.pnl), 0.0, 1 if bought else 0, r2(cash), "; ".join(notes), fee_now])
            fee_now, bought, notes = 0.0, False, []
            k += 1
            if res is not None:
                break
        if res != "pass":
            if res is None:
                break
            continue
        fu = FundedAccount(S, **FK)
        while k < k1:
            evn, amt = fu.step(S.days[k])
            if evn == "dead":
                rows[-1][6] = (rows[-1][6] + "; " if rows[-1][6] else "") + "XFA abandoned (cushion below $400)"
                break
            cash += SPLIT * amt
            if amt > 0:
                evs.append((k, "payout", nacct, amt))
            note = f"payout {fu.npay} requested" if amt > 0 else ""
            if evn == "blown":
                note = "max loss hit: XFA closed"
            assert evn != "done", "Topstep has no payout limit"
            rows.append([day(S.days[k]), f"XFA {nacct}", r2(fu.pnl), r2(amt), 0, r2(cash), note, 0.0])
            k += 1
            if evn is not None:
                break
    assert carry == 0.0 or k >= k1
    return rows, evs


def journey_check(S, k0, k1, rows, evs):
    """The slot's cash = topstep_sim.cash_flows on the same Combines and payouts, and its rows' fees add up."""
    cash = T.cash_flows(S, k0, evs, FEE_PATH, SIZE)[: k1 - k0]
    assert abs(cash.sum() - rows[-1][5]) < 0.01, (cash.sum(), rows[-1][5])
    fees = sum(r[7] for r in rows)
    pays = sum(r[3] for r in rows)
    assert abs(SPLIT * pays - fees - rows[-1][5]) < 0.01, (pays, fees, rows[-1][5])


def pool_rows(S, k0, k1):
    """5 XFAs + 5 Combines from session k0 (research4.sim_pool), each session's cash itemised; = topstep_sim.cash_flows."""
    X.PAID[0] = 0.0
    ev = R4.sim_pool(S, 5, 10, k0, k1, EK, FK)
    paid = X.PAID[0]
    cash = T.cash_flows(S, k0, ev, FEE_PATH, SIZE)[: k1 - k0]
    by = {}
    end = {aid: k for k, kind, aid, _ in ev if kind in ("pass", "fail")}
    for k, kind, aid, v in ev:
        x = by.setdefault(k, [0, 0.0, 0, 0.0])
        if kind == "payout":
            x[0] += 1
            x[1] += v
        elif kind == "buy":
            x[2] += 1
            ke = end.get(aid, len(S.days) - 1)
            d0, j = int(S.days[k]), 0
            while d0 + 30 * j <= int(S.days[ke]):
                kc = min(int(np.searchsorted(S.days, d0 + 30 * j)), ke)
                if kc < k1:
                    by.setdefault(kc, [0, 0.0, 0, 0.0])[3] += PRICE
                j += 1
    rows, cum = [], 0.0
    for k in range(k0, k1):
        npay, amt, nev, fee = by.get(k, [0, 0.0, 0, 0.0])
        net = SPLIT * amt - fee
        assert abs(net - cash[k - k0]) < 1e-6, (day(S.days[k]), net, cash[k - k0])
        cum += net
        rows.append([day(S.days[k]), npay, r2(amt), r2(-(1 - SPLIT) * amt), nev, r2(-fee), r2(net), r2(cum)])
    gross = sum(v for _, kind, _, v in ev if kind == "payout")
    fees = sum(r[5] for r in rows)
    return rows, dict(payouts=sum(kind == "payout" for _, kind, _, _ in ev), gross=gross,
                      evals=sum(kind == "buy" for _, kind, _, _ in ev), fees=-fees, paid=paid, net=float(cash.sum()))


def every_year(S, out, at, ad, ap, ja, ev, fu):
    """export_charts.every_year in Topstep's words and fees (the slot's fees are the ones it paid, renewals included)."""
    yof = lambda d: d[:4]  # noqa: E731
    years = sorted({yof(x[0]) for x in ad})
    sy = {k: day(S.days[k])[:4] for k in ev}

    def stats(y):
        sel = (lambda d: yof(d) == y) if y else (lambda d: True)
        tr = [t for t in at if sel(t[1])]
        dd_ = [x for x in ad if sel(x[0])]
        traded = np.array([x[6] for x in dd_ if x[3] > 0])
        run = np.cumsum([x[6] for x in dd_])
        drop = float((run - np.maximum.accumulate(np.r_[0.0, run])[1:]).min()) if len(run) else 0.0
        legs = {name: sum(t[8] for t in tr if t[2] == name) for name in ("Overnight", "Pyramid", "IB breakout")}
        adr = [x[1] for x in dd_ if x[1] != ""]
        mnq = [x[2] for x in dd_ if x[2]]
        done = [r for k, r in ev.items() if (not y or sy[k] == y) and r["result"] != "open"]
        passed = [r["days"] for r in done if r["result"] == "pass"]
        fr = [r for k, r in fu.items() if (not y or sy[k] == y) and r["result"] != "open"]
        pp = [x for x in ap if sel(x[0])]
        months = sorted({x[0][:7] for x in pp})
        paid_m = {x[0][:7] for x in pp if x[1] > 0}
        sj = [x for x in ja if sel(x[0])]
        s_pay = [x[3] for x in sj if x[3] > 0]
        s_ev = sum(x[4] for x in sj)
        s_fee = sum(x[7] for x in sj)
        first, last = pd_(dd_[0][0]), pd_(dd_[-1][0])
        return [y or "All", f"{first:%b} {first.day}" + ("" if y else f" {first.year}") + f" - {last:%b} {last.day}"
                + ("" if y else f" {last.year}"), len(dd_),
                len(tr), round(100 * np.mean([t[8] > 0 for t in tr]), 1) if tr else 0.0,
                round(sum(t[6] for t in tr)), round(sum(t[7] for t in tr)), round(sum(t[8] for t in tr)),
                round(legs["Overnight"]), round(legs["Pyramid"]), round(legs["IB breakout"]),
                round(float(np.mean(adr)), 1), round(float(np.mean(mnq)), 2), len(traded),
                round(100 * np.mean(traded > 0), 1), round(100 * np.mean(traded >= QDAY), 1),
                round(float(traded.max())), round(float(traded.min())), round(drop),
                len(done), round(100 * len(passed) / len(done), 1) if done else 0.0,
                float(np.median(passed)) if passed else 0.0,
                len(fr), round(100 * np.mean([len(r["payouts"]) > 0 for r in fr]), 1) if fr else 0.0,
                round(float(np.mean([len(r["payouts"]) for r in fr])), 2) if fr else 0.0,
                round(float(np.mean([sum(r["amounts"]) for r in fr]))) if fr else 0,
                sum(x[1] for x in pp), round(sum(x[2] for x in pp)), round(sum(x[3] for x in pp)), sum(x[4] for x in pp),
                round(sum(x[5] for x in pp)), round(sum(x[6] for x in pp)), round(100 * len(paid_m) / len(months), 1),
                len(s_pay), s_ev, round(SPLIT * sum(s_pay) - s_fee)]

    cols = ["year", "period", "sessions", "trades", "win_pct", "gross_usd", "commission_usd", "net_usd", "overnight_usd",
            "pyramid_usd", "ib_usd", "avg_range_points", "avg_mnq_per_leg", "days_traded", "days_positive_pct",
            "days_qualifying_pct", "best_day_usd", "worst_day_usd", "deepest_drop_usd", "evals_started", "eval_pass_pct",
            "eval_median_sessions", "funded_started", "funded_paid_pct", "funded_avg_payouts", "funded_avg_payout_usd",
            "pool_payouts", "pool_payouts_usd", "pool_topstep_usd", "pool_evals", "pool_fees_usd", "pool_net_usd",
            "pool_months_paid_pct", "slot_payouts", "slot_evals", "slot_net_usd"]
    rows = [stats(y) for y in years] + [stats(None)]
    write(out, "ts_years_all", cols, rows)
    mo = {}
    for x in ad:
        m = mo.setdefault(x[0][:7], dict(sessions=0, trades=0, net=0.0, run=0.0))
        m["sessions"] += 1
        m["trades"] += x[3]
        m["net"] += x[6]
        m["run"] = x[7]
    for x in ap:
        m = mo[x[0][:7]]
        m["pp"] = m.get("pp", 0) + x[1]
        m["pu"] = m.get("pu", 0.0) + x[2]
        m["pe"] = m.get("pe", 0) + x[4]
        m["pn"] = m.get("pn", 0.0) + x[6]
        m["pr"] = x[7]
    for x in ja:
        mo[x[0][:7]]["cash"] = x[5]
    write(out, "ts_months_all", ["month", "sessions", "trades", "net_usd", "running_net_usd", "pool_payouts", "pool_payouts_usd",
                                 "pool_evals", "pool_net_usd", "pool_running_usd", "slot_cash_usd"],
          [[k, m["sessions"], m["trades"], r2(m["net"]), r2(m["run"]), m.get("pp", 0), round(m.get("pu", 0.0)),
            m.get("pe", 0), round(m.get("pn", 0.0)), round(m.get("pr", 0.0)), round(m.get("cash", 0.0))] for k, m in sorted(mo.items())])
    yr = rows[:-1]
    span = (pd_(ad[-1][0]) - pd_(ad[0][0])).days / 365.25
    tot = rows[-1]
    return rows, [["all", "all_years_n", "Calendar years in the backtest", len(yr), "count", ""],
                  ["all", "all_years_pos", "Years one funded account ended positive", sum(r[7] > 0 for r in yr), "count", ""],
                  ["all", "all_book_net", "One funded account, all years, after commission", tot[7], "usd", ""],
                  ["all", "all_book_year", "One funded account, per year", tot[7] / span, "usd", ""],
                  ["all", "all_book_comm", "Commission paid, one funded account, all years", -tot[6], "usd", ""],
                  ["all", "all_book_trades", "Trades, one funded account, all years", tot[3], "count", ""],
                  ["all", "all_best_year", "Best year, one funded account", max(r[7] for r in yr), "usd", ""],
                  ["all", "all_worst_year", "Worst year, one funded account", min(r[7] for r in yr), "usd", ""],
                  ["all", "all_pool_net", "5 XFAs + 5 Combines, all years, net to you", tot[31], "usd", ""],
                  ["all", "all_pool_year", "5 XFAs + 5 Combines, per year", tot[31] / span, "usd", ""],
                  ["all", "all_pool_years_pos", "Years the 5 XFAs ended positive", sum(r[31] > 0 for r in yr), "count", ""],
                  ["all", "all_slot_net", "One account slot, all years, net to you", tot[35], "usd", ""],
                  ["all", "all_eval_rate", "Combine pass rate, all years", tot[20], "pct", ""],
                  ["all", "all_funded_paid", "XFAs reaching a payout, all years", tot[23], "pct", ""]]


def month_stats(S, k0, cash):
    m = {}
    for i, c in enumerate(cash):
        key = day(S.days[k0 + i])[:7]
        m[key] = m.get(key, 0.0) + c
    return m


def size_job(args):
    """N XFAs with N Combines behind them (sim_pool(N, 2N)), one start date, the last 5 years: topstep_sim's summary."""
    n, off = args
    S = T._S["S"]
    k0 = T.start_k(S, "5y", off)
    ev = R4.sim_pool(S, n, 2 * n, k0, len(S.days), EK, FK)
    lab, a, b, fy = T.WINDOWS[("fut", "5y")]
    cash = T.cash_flows(S, k0, ev, FEE_PATH, SIZE)
    r = T.summarise_run(S, k0, cash, ev, [(lab, a, b)], {lab: fy})
    r["months"] = month_stats(S, k0, cash)
    return (n, off), r


def sizes(fd, out):
    """ts_sizes.csv: 1 to 5 XFAs + as many Combines, mean of topstep_sim's 12 start dates, live50k.py's month figures."""
    with get_context("fork").Pool(4, initializer=T._init, initargs=("fut", fd)) as pool:
        res = dict(pool.map(size_job, [(n, o) for n in range(1, 6) for o in T.OFF], chunksize=3))
    lab = T.WINDOWS[("fut", "5y")][0]
    rows = []
    for n in range(1, 6):
        R = [res[(n, o)] for o in T.OFF]
        g = lambda key: float(np.mean([r["periods"][lab][key] for r in R]))  # noqa: E731
        ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
        fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
        mv = np.array([v for r in R for m, v in r["months"].items() if "2022-01" <= m <= "2026-10"])
        rows.append([f"B{n}", n, round(g("M")), round(g("W")), round(g("L"), 2), round(g("D")), round(g("worst12")),
                     round(g("gap"), 1), round(g("months_paid"), 1), round(g("evals_yr"), 1),
                     round(float(np.mean([r["cash_low"] for r in R]))), round(float(np.mean([r["total"] for r in R]))),
                     round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                     round(100 * float(np.mean(mv > 0)), 1), round(float(np.percentile(mv, 50))), round(float(np.percentile(mv, 10))),
                     round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1), round(fu("payouts"), 1),
                     round(fu("payouts_usd") / max(fu("payouts"), 1e-9))])
    cols = ["id", "accounts", "net_per_year_usd", "worst_full_year_usd", "losing_full_years", "deepest_drop_usd",
            "worst_12_months_usd", "longest_gap_months", "months_with_payout_pct", "evals_per_year", "most_cash_out_usd",
            "total_net_5y_usd", "eval_pass_pct", "months_positive_pct", "month_p50_usd", "month_p10_usd",
            "funded_with_payout_pct", "payouts", "average_payout_usd"]
    ref = {r["id"]: r for r in csv.DictReader(open(os.path.join(HERE, "results_topstep", "topstep.csv")))}["5y-50-standard-noact"]
    b5 = dict(zip(cols, rows[-1]))
    for c in ("net_per_year_usd", "worst_full_year_usd", "losing_full_years", "deepest_drop_usd", "worst_12_months_usd",
              "longest_gap_months", "months_with_payout_pct", "evals_per_year", "most_cash_out_usd", "eval_pass_pct",
              "funded_with_payout_pct", "payouts", "average_payout_usd"):
        assert float(ref[c]) == float(b5[c]), (c, ref[c], b5[c])
    write(out, "ts_sizes", cols, rows)
    return rows


def main(dd, fd, lucid_dir, rep_dir, out):
    os.makedirs(out, exist_ok=True)
    lucid = lambda name: list(csv.reader(open(os.path.join(lucid_dir, name + ".csv"))))[1:]  # noqa: E731
    asstr = lambda rows: [[str(x) for x in r] for r in rows]  # noqa: E731
    rep = json.load(open(os.path.join(rep_dir, "summary.json")))
    # ================= 60 days of real MNQ futures (export_charts.py's series)
    mnq = load_npz(os.path.join(dd, "MNQ_5m_60d.npz"))
    own = rth_sessions(*mnq)
    src = {d: v for d, v in rth_sessions(*load_npz(os.path.join(dd, "NSXUSD.npz"))).items() if d < min(own)}
    src.update(own)
    R = Sessions(mnq, load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5, adr_src=src)
    m0 = int(np.argmax([not np.isnan(R.S[d]["adr"]) and not np.isnan(R.S[d]["score"]) for d in R.days]))
    kr = range(m0, len(R.days))
    print(f"real MNQ: {day(R.days[m0])} -> {day(R.days[-1])}, {len(kr)} sessions", flush=True)
    rt, rd = book(R, kr)
    assert asstr(rt) == lucid("real_trades") and asstr(rd) == lucid("real_days"), "60-day book differs from the Lucid plan's"
    ev = [(k, run_eval(R, k, **EK)) for k in kr]
    write(out, "ts_real_evals", ["start_date", "result", "sessions", "trades", "end_date"],
          [[day(R.days[k]), r["result"], r["days"], r["trades"], day(R.days[min(r["k_end"], len(R.days) - 1)])] for k, r in ev])
    X.PAID[0] = 0.0
    ja, jev = journey(R, m0, len(R.days))
    j_paid = X.PAID[0]
    journey_check(R, m0, len(R.days), ja, jev)
    write(out, "ts_real_account", JC, [x[:7] for x in ja])
    rp, rs = pool_rows(R, m0, len(R.days))
    write(out, "ts_real_pool", PC, rp)

    # ================= the last 5 years on real NQ futures
    SS = T.load("fut", fd)
    k4 = int(np.searchsorted(SS.days, np.datetime64("2021-11-15").astype(int)))
    k4s = range(k4, len(SS.days))
    bt, bd = book(SS, k4s)
    assert asstr(bt) == lucid("book_trades") and asstr(bd) == lucid("book_days"), "5-year book differs from the Lucid plan's"
    bp, bs = pool_rows(SS, k4, len(SS.days))
    assert abs(bs["net"] - rep["pool"]["first_path_total"]) < 1.0, (bs["net"], rep["pool"]["first_path_total"])
    X.PAID[0] = 0.0
    js, sev_ = journey(SS, k4, len(SS.days))
    s_paid = X.PAID[0]
    journey_check(SS, k4, len(SS.days), js, sev_)
    write(out, "ts_slot_5y", JC, [x[:7] for x in js])

    # ================= every year, 2011 - 2026 (CFD minute bars): one continuous run from the first full session
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    k0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))
    assert k0 == T.first_tradable(S)
    ka = range(k0, len(S.days))
    print(f"every year: {day(S.days[k0])} -> {day(S.days[-1])}, {len(ka)} sessions", flush=True)
    at, ad = book(S, ka)
    assert max(x[2] for x in ad) <= FUNDMAX
    lt = lucid("all_trades")
    i21 = next(i for i, t in enumerate(at) if t[1] >= "2021-01-01")
    j21 = next(i for i, t in enumerate(lt) if t[1] >= "2021-01-01")
    assert [t[1:9] for t in asstr(at[i21:])] == [t[1:9] for t in lt[j21:]], "the book from 2021 differs from the Lucid plan's"
    write(out, "ts_all_trades", TC, at)
    write(out, "ts_all_days", DC, ad)
    hist = {}
    for t in at:
        hist[t[1][:4]] = hist.get(t[1][:4], 0.0) + t[8]
    lh = {r[0]: float(r[7]) for r in lucid("years_all") if r[0] != "All"}  # the Lucid plan's book by year (its history)
    assert sorted(lh) == sorted(hist), (sorted(lh), sorted(hist))
    write(out, "ts_history", ["year", "book_net_usd", "lucid_book_net_usd"], [[y, round(v), round(lh[y])] for y, v in sorted(hist.items())])
    ap, aps = pool_rows(S, k0, len(S.days))
    runs = json.load(open(os.path.join(HERE, "results_topstep", "runs.json")))
    ref = runs[f"cfd|all|0|{SIZE}|{PATH}"][FEE_PATH]
    assert abs(aps["net"] - ref["total"]) < 0.01, (aps["net"], ref["total"])  # topstep_sim.py's CFD run, offset 0
    X.PAID[0] = 0.0
    ja_all, aev_ = journey(S, k0, len(S.days))
    a_paid = X.PAID[0]
    journey_check(S, k0, len(S.days), ja_all, aev_)
    write(out, "ts_slot_all", JC, [x[:7] for x in ja_all if x[3] > 0 or x[4] or x[6]] + [ja_all[-1][:7]])
    ev_all = {k: run_eval(S, k, **EK) for k in ka}
    fu_all = {k: run_funded(S, k, **FK) for k in ka}
    yrows, all_k = every_year(S, out, at, ad, ap, ja_all, ev_all, fu_all)

    # ================= costs, side by side
    def jsum(rows):
        return sum(x[3] for x in rows), sum(x[4] for x in rows), sum(x[7] for x in rows)

    rpay, rev, rfee = jsum(ja)
    spay, sev, sfee = jsum(js)
    apay, aev, afee = jsum(ja_all)
    cost = []

    def block(item_id, setup, item, a, b, c):
        cost.append([item_id, setup, item, round(a), round(b), round(c)])

    bk = "One funded account, every session"
    block("book_gross", bk, "Trading profit before commission", sum(t[6] for t in rt), sum(t[6] for t in bt), sum(t[6] for t in at))
    block("book_comm", bk, "Commission at $1.34 per MNQ round turn", sum(t[7] for t in rt), sum(t[7] for t in bt), sum(t[7] for t in at))
    block("book_net", bk, "Trading profit after commission", sum(t[8] for t in rt), sum(t[8] for t in bt), sum(t[8] for t in at))
    sl = "One account slot (a new Combine whenever one ends)"
    block("slot_payouts", sl, "Payouts requested", rpay, spay, apay)
    block("slot_topstep", sl, "Topstep's 10% share", -(1 - SPLIT) * rpay, -(1 - SPLIT) * spay, -(1 - SPLIT) * apay)
    block("slot_fees", sl, "Combine fees at $95 per 30 days open", -rfee, -sfee, -afee)
    block("slot_net", sl, "Net to you", SPLIT * rpay - rfee, SPLIT * spay - sfee, SPLIT * apay - afee)
    block("slot_comm", sl, "Commission paid in the accounts (already taken out before the payouts)", -j_paid, -s_paid, -a_paid)
    pl = "5 XFAs + 5 Combines"
    block("pool_payouts", pl, "Payouts requested", rs["gross"], bs["gross"], aps["gross"])
    block("pool_topstep", pl, "Topstep's 10% share", -(1 - SPLIT) * rs["gross"], -(1 - SPLIT) * bs["gross"], -(1 - SPLIT) * aps["gross"])
    block("pool_fees", pl, "Combine fees at $95 per 30 days open", -rs["fees"], -bs["fees"], -aps["fees"])
    block("pool_net", pl, "Net to you", rs["net"], bs["net"], aps["net"])
    block("pool_comm", pl, "Commission paid in the accounts (already taken out before the payouts)", -rs["paid"], -bs["paid"], -aps["paid"])
    for grp in ("slot", "pool"):  # payouts - Topstep's share - fees = net, each column, to the rounding
        c = {r[0].split("_", 1)[1]: r for r in cost if r[0].startswith(grp + "_")}
        for i in (3, 4, 5):
            assert abs(c["payouts"][i] + c["topstep"][i] + c["fees"][i] - c["net"][i]) <= 2, (grp, i, c)
    write(out, "ts_costs", ["item_id", "setup", "item", "real_60d_usd", "last_5y_usd", "all_years_usd"], cost)

    # ================= single figures
    done = [r for _, r in ev if r["result"] != "open"]
    npass = sum(r["result"] == "pass" for r in done)
    K = [["real", "real_evals_done", "Combines finished", len(done), "count", "one bought every session"],
         ["real", "real_evals_pass", "Combines passed", npass, "count", ""],
         ["real", "real_eval_rate", "Combine pass rate", 100 * npass / len(done), "pct", ""],
         ["real", "real_slot_net", "Net to you, one account bought Sep 9", SPLIT * rpay - rfee, "usd", ""],
         ["real", "real_slot_payouts", "Payouts, one account bought Sep 9", len([x for x in ja if x[3] > 0]), "count", ""],
         ["real", "real_slot_evals", "Combines bought, one account bought Sep 9", rev, "count", ""],
         ["real", "real_pool_net", "Net to you, 5 XFAs + 5 Combines", rs["net"], "usd", ""],
         ["real", "real_pool_payouts", "Payouts, 5 XFAs + 5 Combines", rs["payouts"], "count", ""],
         ["real", "real_pool_evals", "Combines bought, 5 XFAs + 5 Combines", rs["evals"], "count", ""],
         ["5y", "pool_total_net", "Net to you, 5 XFAs + 5 Combines, 5 years", bs["net"], "usd", ""],
         ["5y", "pool_total_payouts", "Payouts, 5 XFAs + 5 Combines, 5 years", bs["payouts"], "count", ""],
         ["5y", "pool_total_evals", "Combines bought, 5 XFAs + 5 Combines, 5 years", bs["evals"], "count", ""],
         ["5y", "slot_total_net", "Net to you, one account slot, 5 years", SPLIT * spay - sfee, "usd", ""]] + all_k
    shown = {"usd": lambda v: round(v), "pct": lambda v: round(v, 1), "count": lambda v: int(round(v))}
    write(out, "ts_real_kpis", ["section", "metric", "label", "value", "unit", "note"], [[a, b, c, shown[u](v), u, n] for a, b, c, v, u, n in K])
    # ================= 1 to 5 XFAs
    sizes(fd, out)
    print(f"checks passed: the 60-day and 5-year books = the Lucid plan's, the every-year book from 2021 = the Lucid plan's; "
          f"the 5-year pool = topstep_report.py's first path (${bs['net']:,.0f}); the CFD pool = topstep_sim.py's (${aps['net']:,.0f}); "
          f"each slot's cash = topstep_sim.cash_flows; 5 + 5 = topstep_sim.py's 5y-50-standard-noact", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:6])
