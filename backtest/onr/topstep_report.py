#!/usr/bin/env python3
"""report50k.py's figures for your plan at Topstep: 50K, Standard payouts, No Activation Fee path, the last 5 years.

usage: topstep_report.py FUT_DATA_DIR LUCID_REPORT_DIR OUT_DIR
  FUT_DATA_DIR: NQFUT.npz (prep_mnq.py; prep_nqfut.py before Nov 23 2026) and SPXUSD.npz. LUCID_REPORT_DIR: report50k.py's run of the Lucid plan on the
  same series and window (results_v23_nqfut_5y_addon), for the checks below.
Rules and costs are topstep_sim.py's (ek(50), fk(50, "standard")):
  Combine: $3,000 target, best day at most 55% of the profit, end-of-day trailing $2,000 max loss that stops at the start
  balance, at most 50 micros. XFA: starts at $0, the same max loss locking at $0 and at $0 after a payout, at most
  6 micros a leg, half the balance up to $2,000 after 5 winning days of $150 once the account is $1,000 up, no payout
  limit. account.COMM_RT ($1.00) per MNQ round turn, Topstep keeps 10% of each payout, $95 per Combine when it is bought and again every
  30 days while it is open, no activation fee (the No Activation Fee path).
Definitions as report50k.py's, window Nov 15 2021 to the data's last session:
  book          one funded account trading every session (a fresh XFA each day, full $1,200 day budget). Topstep's
                6-micro cap never binds in this window, so the book must equal LUCID_REPORT_DIR's: checked year by year
  eval          a Combine bought on every session, each traded alone until it passes or fails
  funded        the XFA of every Combine that passed by May 13 2026 (6 months of runway), traded alone to its end
  first_payout  an account slot opened on every session to May 13 2026: Combines one after another until one passes,
                then its XFA to the first payout; a new Combine whenever the XFA ends without one
  pool          5 XFAs + 5 Combines, one new Combine a session (research4.sim_pool), started on 10 dates 0, 3, ..., 27
                sessions after the window's start; cash by topstep_sim.cash_flows (what topstep_sim.py's figures use)
  stress        the pool from the first 5 of those dates with 2x commission and 1 tick of slippage on every trade
Checks before writing: the book by year equals LUCID_REPORT_DIR/book_years.csv, and the 10 pools' start-offset-0 path
equals topstep_sim.py's run of the same plan (results_topstep/runs.json, offset 0) in total net.
Writes OUT_DIR/summary.json, report50k.py's tables (book_years, legs, daily_pnl_hist, alarm_bands, eval_sessions_to_pass,
eval_pass_by_year, funded_payout_count, pool_monthly, pool_years) and, with make_kpis.py's code in Topstep's words,
kpis.csv, years.csv, monthly.csv and distributions.csv.
"""
import csv
import functools
import json
import multiprocessing as mp
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account  # noqa: E402
import engine  # noqa: E402
import make_kpis  # noqa: E402
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402
from account import EvalAccount, FundedAccount, run_eval, run_funded  # noqa: E402

# the same caches as report50k.py: same-day trade results are pure functions of their arguments
account.funded_on = functools.lru_cache(maxsize=None)(engine.funded_on)
account.pyramid = functools.lru_cache(maxsize=None)(engine.pyramid)
account.ib_breakout = functools.lru_cache(maxsize=None)(engine.ib_breakout)

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE, PATH, FEE_PATH = 50, "standard", "noact"
EK, FK = T.ek(SIZE), T.fk(SIZE, PATH)
PRICE, ACT, SPLIT = T.PRICE[FEE_PATH][SIZE], T.ACTIVATION[FEE_PATH], T.SPLIT
QDAY = T.TS[SIZE]["qday"]
W0, CUTOFF = "2021-11-15", "2026-05-13"
S = None


def day(d):
    return str(np.datetime64(int(d), "D"))


def year(d):
    return day(d)[:4]


def month(d):
    return day(d)[:7]


def charges(k_buy, k_event):
    """Monthly charges of one Combine: when bought and every 30 days while open (topstep_sim.cash_flows' rule)."""
    return (int(S.days[k_event]) - int(S.days[k_buy])) // 30 + 1


def combine(k0):
    """run_eval's result, plus the session research4.sim_pool records the end on (a 'dead' Combine is seen there)."""
    acct = EvalAccount(S, **EK)
    for k in range(k0, len(S.days)):
        res = acct.step(S.days[k])
        if res == "dead":
            return dict(result="fail", k_end=k - 1, days=k - k0, trades=acct.trades, k_event=k)
        if res is not None:
            return dict(result=res, k_end=k, days=k - k0 + 1, trades=acct.trades, k_event=k)
    return dict(result="open", k_end=len(S.days) - 1, days=len(S.days) - k0, trades=acct.trades, k_event=len(S.days) - 1)


def book(days, **fk):
    """report50k.book with Topstep's XFA: each session traded by a fresh 50K XFA (full day budget, no history)."""
    rec = []
    for d in days:
        FundedAccount(S, record=rec, **dict(FK, **fk)).step(d)
    return rec


def first_payout_job(k):
    """report50k.first_payout_job with Topstep's accounts: days from the first Combine to the first payout."""
    days, N = S.days, len(S.days)
    evals, j = 0, k
    while j < N:
        ev = EvalAccount(S, **EK)
        evals += 1
        res = None
        while j < N:
            res = ev.step(days[j])
            if res == "dead":
                break
            j += 1
            if res is not None:
                break
        if res != "pass":
            continue
        fu = FundedAccount(S, **FK)
        while j < N:
            evn, amt = fu.step(days[j])
            if evn == "dead":
                break
            j += 1
            if amt > 0:
                return int(days[j - 1] - days[k]), evals
            if evn is not None:
                break
    return None, evals


def month_id(d):
    y, m = map(int, month(d).split("-"))
    return 12 * y + m - 1


def pool_job(args):
    """One 5 + 5 run: report50k.pool_job's fields from research4.sim_pool and topstep_sim.cash_flows."""
    k, ekw, fkw = args
    ev = R4.sim_pool(S, 5, 10, k, len(S.days), dict(EK, **ekw), dict(FK, **fkw))
    cash = T.cash_flows(S, k, ev, FEE_PATH, SIZE)
    d0, d1 = S.days[k], S.days[-1]
    yrs = (d1 - d0) / 365.25
    m0, m1 = month_id(d0), month_id(d1)
    by_m = np.zeros(m1 - m0 + 1)
    for i, c in enumerate(cash):
        by_m[month_id(S.days[k + i]) - m0] += c
    pays = [(kk, a) for kk, kind, _, a in ev if kind == "payout"]
    buys = [kk for kk, kind, _, _ in ev if kind == "buy"]
    pm, bm = {}, {}
    for kk, _ in pays:
        pm[month(S.days[kk])] = pm.get(month(S.days[kk]), 0) + 1
    for kk in buys:
        bm[month(S.days[kk])] = bm.get(month(S.days[kk]), 0) + 1
    gaps = np.diff([d0] + sorted(S.days[kk] for kk, _ in pays) + [d1])
    roll12 = np.array([by_m[i:i + 12].sum() for i in range(len(by_m) - 11)]) if len(by_m) >= 12 else by_m
    months = [f"{(m0 + i) // 12}-{(m0 + i) % 12 + 1:02d}" for i in range(len(by_m))]
    return dict(k=k, months=months, net=[float(x) for x in by_m], pays=pm, buys=bm, longest_gap=float(gaps.max() / 30.44),
                worst12=float(roll12.min()), net_yr=float(cash.sum() / yrs), payouts_yr=len(pays) / yrs, evals_yr=len(buys) / yrs,
                gross=float(sum(a for _, a in pays)), n_pay=len(pays), n_buy=len(buys), total=float(cash.sum()))


def write_csv(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def main(fd, lucid_dir, out):
    global S
    os.makedirs(out, exist_ok=True)
    S = T.load("fut", fd)
    days, N = S.days, len(S.days)
    k0 = int(np.searchsorted(days, np.datetime64(W0).astype(int)))
    wdays = days[k0:]
    yrs_window = (days[-1] - days[k0]) / 365.25
    lucid = json.load(open(os.path.join(lucid_dir, "summary.json")))
    assert lucid["window"] == [W0, day(days[-1])] and lucid["nq_file"] == "NQFUT.npz", lucid["window"]
    summary = dict(window=[day(days[k0]), day(days[-1])], size="Topstep 50K (Trading Combine and Express Funded Account)",
                   commission=account.COMM_RT, eval_price=PRICE, fee_path="No Activation Fee: $95 per Combine per 30 days, no activation fee",
                   payout_path="Standard: 5 winning days of $150+, half the balance up to $2,000", split=SPLIT,
                   payout_limit="none", nq_file="NQFUT.npz", nq_bar_minutes=5)
    print(f"window {day(days[k0])} -> {day(days[-1])} ({len(wdays)} sessions)", flush=True)

    # ---------------- book: report50k.py's code, Topstep's XFA
    rec = book(wdays)
    legs = {"on": "Overnight reversion (18:10 -> 09:30)", "pyr": "Opening-drive pyramid (09:35)",
            "ib": "IB breakout with the drive (10:30-13:00)"}
    rows = []
    for leg, name in legs.items():
        p = np.array([x[3] for x in rec if x[1] == leg])
        w, lo = p[p > 0], p[p <= 0]
        rows.append([name, len(p), round(len(p) / yrs_window, 1), round(100 * len(w) / len(p), 1),
                     round(w.mean(), 0) if len(w) else 0, round(lo.mean(), 0) if len(lo) else 0,
                     round(w.sum() / -lo.sum(), 2) if lo.sum() < 0 else None, round(p.mean(), 1),
                     round(p.sum() / yrs_window, 0), round(make_tstat(p), 2)])
    allp = np.array([x[3] for x in rec])
    write_csv(os.path.join(out, "legs.csv"), ["leg", "trades", "trades_per_year", "win_pct", "avg_win_usd", "avg_loss_usd",
                                              "profit_factor", "avg_trade_usd", "net_usd_per_year", "t_stat"], rows)
    by_day = {}
    for d, leg, side, p in rec:
        by_day[d] = by_day.get(d, 0.0) + p
    daily = np.array([by_day.get(d, 0.0) for d in wdays])
    traded = np.array([by_day[d] for d in wdays if d in by_day])
    yrows = []
    for y in sorted({year(d) for d in wdays}):
        yd = [d for d in wdays if year(d) == y]
        leg_y = {leg: sum(x[3] for x in rec if x[1] == leg and year(x[0]) == y) for leg in legs}
        yrows.append([y, len(yd), round(sum(by_day.get(d, 0.0) for d in yd), 0)] + [round(leg_y[g], 0) for g in legs])
    want = {r["year"]: r for r in csv.DictReader(open(os.path.join(lucid_dir, "book_years.csv")))}
    assert sorted(want) == [r[0] for r in yrows], (sorted(want), [r[0] for r in yrows])
    for r in yrows:  # Topstep's 6-micro cap never binds here: the book is the Lucid plan's to the dollar
        assert [float(want[r[0]][c]) for c in ("sessions", "net_usd", "overnight_usd", "pyramid_usd", "ib_usd")] == \
            [float(x) for x in r[1:]], (r, want[r[0]])
    summary["book"] = dict(trades=len(rec), net_per_year=round(allp.sum() / yrs_window, 0),
                           days_traded=int(len(traded)), pct_days_positive=round(100 * np.mean(traded > 0), 1),
                           pct_days_qualifying=round(100 * np.mean(traded >= QDAY), 1),
                           avg_day=round(traded.mean(), 1), median_day=round(float(np.median(traded)), 1),
                           best_day=round(traded.max(), 0), worst_day=round(traded.min(), 0),
                           daily_sharpe=round(daily.mean() / daily.std() * np.sqrt(252), 2))
    assert summary["book"] == lucid["book"], (summary["book"], lucid["book"])
    hist_edges = list(range(-1400, 2601, 200))
    h, _ = np.histogram(np.clip(traded, -1399, 2599), bins=hist_edges)
    write_csv(os.path.join(out, "daily_pnl_hist.csv"), ["from_usd", "to_usd", "days"],
              [[hist_edges[i], hist_edges[i + 1], int(h[i])] for i in range(len(h))])
    write_csv(os.path.join(out, "book_years.csv"), ["year", "sessions", "net_usd", "overnight_usd", "pyramid_usd", "ib_usd"], yrows)
    print("book", summary["book"], "(= the Lucid plan's book)", flush=True)

    # ---------------- Combines bought on every session of the window
    evs = [(k, combine(k)) for k in range(k0, N)]
    for k, r in evs[::50]:  # the same results as account.run_eval
        ref = run_eval(S, k, **EK)
        assert {x: r[x] for x in ref} == ref, (k, r, ref)
    done = [(k, r) for k, r in evs if r["result"] != "open"]
    passed = [(k, r) for k, r in done if r["result"] == "pass"]
    pdays = np.array([r["days"] for _, r in passed])
    fdays = np.array([r["days"] for _, r in done if r["result"] == "fail"])
    fees = sum(PRICE * charges(k, r["k_event"]) for k, r in done)
    summary["eval"] = dict(started=len(done), pass_pct=round(100 * len(passed) / len(done), 1),
                           sessions_to_pass=dict(p25=float(np.percentile(pdays, 25)), median=float(np.median(pdays)),
                                                 p75=float(np.percentile(pdays, 75)), p90=float(np.percentile(pdays, 90))),
                           sessions_to_fail_median=float(np.median(fdays)),
                           evals_per_funded_account=round(len(done) / len(passed), 2),
                           eval_cost_per_funded_account=round((fees + ACT * len(passed)) / len(passed), 0),
                           charges_per_combine=round(fees / PRICE / len(done), 3))
    ey = []
    for y in sorted({year(days[k]) for k, _ in done}):
        sel = [r for k, r in done if year(days[k]) == y]
        ey.append([y, len(sel), round(100 * np.mean([r["result"] == "pass" for r in sel]), 1)])
    write_csv(os.path.join(out, "eval_pass_by_year.csv"), ["year_started", "evals", "pass_pct"], ey)
    hp, _ = np.histogram(pdays, bins=[1, 4, 7, 10, 13, 16, 21, 31, 61, 999])
    write_csv(os.path.join(out, "eval_sessions_to_pass.csv"), ["sessions", "evals"],
              [[lab, int(c)] for lab, c in zip(["1-3", "4-6", "7-9", "10-12", "13-15", "16-20", "21-30", "31-60", "61+"], hp)])
    print("eval", summary["eval"], flush=True)

    # ---------------- the XFA of every Combine that passed with 6 months of runway
    cutoff = np.datetime64(CUTOFF).astype(int)
    fres = []
    for k, r in passed:
        if days[r["k_end"]] > cutoff:
            continue
        fu = run_funded(S, r["k_end"] + 1, **FK)
        first = (days[fu["payouts"][0]] - days[r["k_end"]]) if fu["payouts"] else None
        fres.append(dict(n=len(fu["payouts"]), gross=sum(fu["amounts"]), result=fu["result"], first=first,
                         life=int(days[min(fu["k_end"], N - 1)] - days[r["k_end"]])))
    npay = np.array([f["n"] for f in fres])
    firsts = np.array([f["first"] for f in fres if f["first"] is not None])
    summary["funded"] = dict(accounts=len(fres), pct_with_a_payout=round(100 * np.mean(npay >= 1), 1),
                             avg_payouts=round(npay.mean(), 2),
                             avg_withdrawn_net=round(SPLIT * np.mean([f["gross"] for f in fres]) - ACT, 0),
                             days_to_first_payout=dict(median=float(np.median(firsts)), p75=float(np.percentile(firsts, 75)),
                                                       p90=float(np.percentile(firsts, 90))),
                             outcome_pct={o: round(100 * np.mean([f["result"] == o for f in fres]), 1)
                                          for o in ("blown", "abandon", "done", "open")},
                             median_life_days=float(np.median([f["life"] for f in fres])), most_payouts=int(npay.max()))
    top = max(6, int(npay.max()) + 1)
    write_csv(os.path.join(out, "funded_payout_count.csv"), ["payouts_before_the_account_ends", "pct_of_funded_accounts"],
              [[i, round(100 * np.mean(npay == i), 1)] for i in range(top)])
    print("funded", summary["funded"], flush=True)

    # ---------------- one account slot: days from the first Combine to the first payout
    starts = [k for k in range(k0, N) if days[k] <= cutoff]
    with mp.get_context("fork").Pool(4) as pool:
        fp = pool.map(first_payout_job, starts, chunksize=20)
    got = np.array([x for x, _ in fp if x is not None], float)
    summary["first_payout"] = dict(starts=len(starts), pct_paid_by_end=round(100 * len(got) / len(starts), 1),
                                   **{f"pct_within_{m}_days": round(100 * np.mean([x is not None and x <= m for x, _ in fp]), 1)
                                      for m in (30, 60, 90, 180, 365)},
                                   median_days=float(np.median(got)), avg_evals_before=round(np.mean([e for _, e in fp]), 2))
    print("first payout", summary["first_payout"], flush=True)

    # ---------------- 5 XFAs + 5 Combines: 10 start dates in the window's first 6 weeks, and the stress test
    offs = list(range(0, 30, 3))
    with mp.get_context("fork").Pool(4) as pool:
        paths = pool.map(pool_job, [(k0 + o, {}, {}) for o in offs])
        stress = pool.map(pool_job, [(k0 + o, dict(comm=2 * account.COMM_RT, slip=0.25), dict(comm=2 * account.COMM_RT, slip=0.25)) for o in offs[:5]])
    runs = json.load(open(os.path.join(HERE, "results_topstep", "runs.json")))
    ref = runs[f"fut|5y|0|{SIZE}|{PATH}"][FEE_PATH]
    assert abs(paths[0]["total"] - ref["total"]) < 0.01, (paths[0]["total"], ref["total"])  # topstep_sim.py, offset 0
    P0 = paths[0]
    cum = np.cumsum(P0["net"])
    write_csv(os.path.join(out, "pool_monthly.csv"), ["month", "net_usd", "cumulative_usd", "payouts", "evals_bought"],
              [[m, round(v, 0), round(c, 0), P0["pays"].get(m, 0), P0["buys"].get(m, 0)] for m, v, c in zip(P0["months"], P0["net"], cum)])
    peak = np.maximum.accumulate(np.r_[0.0, cum])
    ytab = []
    for y in sorted({int(m[:4]) for m in P0["months"]}):
        vals = [sum(v for m, v in zip(p["months"], p["net"]) if int(m[:4]) == y) for p in paths]
        pay_n = [sum(n for m, n in p["pays"].items() if int(m[:4]) == y) for p in paths]
        ytab.append([y, round(vals[0], 0), round(min(vals), 0), round(float(np.median(vals)), 0), round(max(vals), 0), int(pay_n[0])])
    write_csv(os.path.join(out, "pool_years.csv"), ["year", "net_usd_first_path", "net_usd_min_of_10", "net_usd_median_of_10",
                                                   "net_usd_max_of_10", "payouts_first_path"], ytab)
    m_from = f"{int(W0[:4]) + 1}-01"
    allm = [(m, v, p["pays"].get(m, 0)) for p in paths for m, v in zip(p["months"], p["net"]) if m_from <= m <= "2026-10"]
    mv = np.array([v for _, v, _ in allm])
    full_years = [(y, sum(v for m, v in zip(p["months"], p["net"]) if int(m[:4]) == y)) for p in paths for y in range(int(W0[:4]) + 1, 2026)]
    summary["pool"] = dict(paths=len(paths), net_per_year_median=round(float(np.median([p["net_yr"] for p in paths])), 0),
                           net_per_year_range=[round(min(p["net_yr"] for p in paths), 0), round(max(p["net_yr"] for p in paths), 0)],
                           payouts_per_year=round(float(np.mean([p["payouts_yr"] for p in paths])), 1),
                           evals_per_year=round(float(np.mean([p["evals_yr"] for p in paths])), 1),
                           pct_months_net_positive=round(100 * np.mean(mv > 0), 1),
                           pct_months_with_a_payout=round(100 * np.mean([n > 0 for _, _, n in allm]), 1),
                           monthly_net_percentiles={q: round(float(np.percentile(mv, q)), 0) for q in (10, 25, 50, 75, 90)},
                           pct_full_years_positive=round(100 * np.mean([v > 0 for _, v in full_years]), 1),
                           longest_gap_months=dict(median=round(float(np.median([p["longest_gap"] for p in paths])), 1),
                                                   max=round(max(p["longest_gap"] for p in paths), 1)),
                           worst_12_months=round(min(p["worst12"] for p in paths), 0),
                           first_path_max_drawdown=round(float((peak - np.r_[0.0, cum]).max()), 0),
                           first_path_total=round(float(cum[-1]), 0))
    summary["stress_2x_costs_1_tick"] = dict(net_per_year_median=round(float(np.median([p["net_yr"] for p in stress])), 0),
                                             longest_gap_max=round(max(p["longest_gap"] for p in stress), 1),
                                             worst_12_months=round(min(p["worst12"] for p in stress), 0))
    print("pool", summary["pool"], flush=True)
    print("stress", summary["stress_2x_costs_1_tick"], flush=True)

    # ---------------- live alarm bands: report50k.py's block bootstrap of the same book (so the same bands)
    rng = np.random.default_rng(2026)
    nb = 25
    starts_b = rng.integers(0, len(daily) - 10, size=(20000, nb))
    paths_b = daily[(starts_b[:, :, None] + np.arange(10)).reshape(20000, -1)]
    cumb = np.cumsum(paths_b, axis=1)
    bands = []
    for dn in (20, 40, 60, 120, 250):
        c = cumb[:, dn - 1]
        bands.append([dn, round(float(np.median(c)), 0), round(float(np.percentile(c, 5)), 0), round(float(np.percentile(c, 1)), 0)])
    write_csv(os.path.join(out, "alarm_bands.csv"), ["trading_days", "median_usd", "p5_yellow_usd", "p1_red_usd"], bands)
    assert bands == lucid["alarm_bands"], (bands, lucid["alarm_bands"])
    summary["alarm_bands"] = bands
    json.dump(summary, open(os.path.join(out, "summary.json"), "w"), indent=1)

    # ---------------- the website's single figures and tables: make_kpis.py's code, in Topstep's words
    kp = os.path.join(out, "kpis.csv")
    d0, d1 = (np.datetime64(int(days[i]), "D").astype(object) for i in (k0, -1))
    make_kpis.main(out, kp, f"{d0:%b} {d0.day} {d0.year} - {d1:%b} {d1.day} {d1.year}", "2022-2025")
    words = [("Net income per year, 5 funded 50K + eval pool", "Net income per year, 5 XFAs + 5 Combines"),
             ("(after eval fees)", "(after Combine fees)"), ("Eval pass rate (evals started on every session)",
                                                               "Combine pass rate (a Combine started on every session)"),
             ("Evals bought per funded account", "Combines bought per XFA"), ("Evals bought per year", "Combines bought per year"),
             (f"Eval fees per funded account (${PRICE:.2f} each)", "Combine fees per XFA ($95 per 30 days open)"),
             ("Funded accounts that reach a payout", "XFAs that reach a payout"),
             ("Payouts per funded account, average", "Payouts per XFA, average"),
             ("Net withdrawn per funded account, average (after 10%)", "Net withdrawn per XFA, average (after Topstep's 10%)"),
             ("Days from funding to first payout", "Days from the XFA's start to its first payout"),
             ("Funded accounts that reach all 5 payouts", "XFAs closed after a set number of payouts (Topstep has no limit)"),
             ("Funded accounts that end below the cushion level", "XFAs that end below the cushion level or at the max loss"),
             ("Funded account life, median", "XFA life, median"),
             ("One account slot: days from first eval to first payout", "One account slot: days from the first Combine to the first payout"),
             ("of buying the first eval", "of buying the first Combine"),
             ("Evals bought before the first payout", "Combines bought before the first payout"),
             ("Traded days of $150 or more (Lucid qualifying day)", "Traded days of $150 or more (Topstep winning day)"),
             (": net per year, 5 x 50K", ": net per year, 5 XFAs + 5 Combines")]
    rows = list(csv.reader(open(kp)))
    for r in rows[1:]:
        for a, b in words:
            r[2] = r[2].replace(a, b)
        r[5] = r[5].replace(" evals", " Combines").replace(" funded accounts", " XFAs")
        assert "eval" not in r[2].lower() and "lucid" not in r[2].lower() and "funded account" not in r[2].lower() or \
            r[1] in ("book_net_year",), r
    with open(kp, "w", newline="") as f:
        csv.writer(f, lineterminator="\n").writerows(rows)
    make_kpis.years_monthly(out, out)
    print(f"checks passed: the book = the Lucid plan's ({lucid_dir}); the first pool path = topstep_sim.py's "
          f"(${ref['total']:,.0f}); alarm bands = the Lucid plan's", flush=True)


def make_tstat(x):
    x = np.asarray(x, float)
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))) if len(x) > 2 else float("nan")


if __name__ == "__main__":
    main(*sys.argv[1:4])
