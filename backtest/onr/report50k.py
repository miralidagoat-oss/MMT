#!/usr/bin/env python3
"""Full backtest of the ONR Book v2.2 default setup: Lucid Flex 50K, max-allowed payouts, $1.34 per MNQ round turn.

Primary window: the last 4 years (Nov 14 2022 -> Nov 13 2026). 2011-2026 and real MNQ futures (Sep-Nov 2026) as context.
usage: report50k.py DATA_DIR OUT_DIR [WINDOW_START]   (writes CSV tables + summary.json into OUT_DIR and prints the
       summary; WINDOW_START defaults to 2022-11-14, e.g. 2021-11-15 for the last 5 years)
Environment: ONR_EVAL_FEE_50K sets the eval price (account.py); ONR_EVAL_CONS=0.5 runs every eval with Lucid's paid
50% consistency add-on (results_50k_5y_addon_fee8820). ONR_NQ_FILE / ONR_NQ_TF read another NQ file from DATA_DIR
and its bar size in minutes (default NSXUSD.npz, 1), e.g. NQFUT.npz, 5 for real NQ futures (prep_nqfut.py).
ONR_MAX_PAY=4 closes each funded account right after its 4th payout (indicator v2.3's default plan).
"""
import csv
import functools
import json
import os
import sys
from multiprocessing import Pool as MP

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account  # noqa: E402
import engine  # noqa: E402
from account import RULES, EvalAccount, FundedAccount, run_eval, run_funded  # noqa: E402
from engine import Sessions, adr_seed, load_npz, rth_sessions  # noqa: E402

# same-day trade results are identical for every account of the same size: cache them (pure functions of their args)
account.funded_on = functools.lru_cache(maxsize=None)(engine.funded_on)
account.pyramid = functools.lru_cache(maxsize=None)(engine.pyramid)
account.ib_breakout = functools.lru_cache(maxsize=None)(engine.ib_breakout)

SIZE = 50
COMM = 1.34
FEE = RULES[SIZE]["price"]
# ONR_EVAL_CONS=0.5: evals bought with Lucid's paid 50% consistency add-on (pass rule and the bracket's target cap use
# 50% instead of 40%). Unset, E_KW is exactly as before.
CONS = float(os.environ.get("ONR_EVAL_CONS", "0.4"))
E_KW = dict(improved=True, comm=COMM, size=SIZE, **({} if CONS == 0.4 else dict(cons=CONS)))
# ONR_MAX_PAY=4: each funded account is closed right after its 4th payout (indicator v2.3's default payout plan, so no
# 5th payout moves the trader to a live account). Unset, F_KW is exactly as before (Lucid's 5-payout limit).
MAXPAY = int(os.environ.get("ONR_MAX_PAY", "5"))
F_KW = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=COMM, size=SIZE, payout_max=True,
            **({} if MAXPAY == 5 else dict(max_pay=MAXPAY)))
W0 = "2022-11-14"
S = None
NQ_FILE = os.environ.get("ONR_NQ_FILE", "NSXUSD.npz")
NQ_TF = int(os.environ.get("ONR_NQ_TF", "1"))


def day(d):
    return np.datetime64(int(d), "D")


def year(d):
    return int(str(day(d))[:4])


def month(d):
    return str(day(d))[:7]


def tstat(x):
    x = np.asarray(x, float)
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))) if len(x) > 2 else float("nan")


def build(dd):
    global S
    S = Sessions(load_npz(os.path.join(dd, NQ_FILE)), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=NQ_TF)
    return S


def write_csv(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def book(days, **fk):
    """Continuous funded book: each session traded by a fresh 50K funded account (full $1,200 day budget, no resets)."""
    rec = []
    for d in days:
        FundedAccount(S, record=rec, **dict(F_KW, **fk)).step(d)
    return rec


def first_payout_job(k):
    """Days from buying the first eval at session k to the first payout (one account slot), evals bought on the way."""
    days, N = S.days, len(S.days)
    evals = 0
    j = k
    while j < N:
        ev = EvalAccount(S, **E_KW)
        evals += 1
        res = None
        while j < N:
            res = ev.step(days[j])
            if res == "dead":
                break  # replaced on the same session
            j += 1
            if res is not None:
                break
        if res != "pass":
            continue
        fu = FundedAccount(S, **F_KW)
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


def pool_job(args):
    from portfolio import pool, summarize
    k, kw_e, kw_f, S_alt = args
    SS = S if S_alt is None else S_alt
    run = pool(SS, k_start=k, eval_kw=dict(E_KW, **kw_e), funded_kw=dict(F_KW, **kw_f))
    r = summarize(SS, run, k, len(SS.days), fee=FEE)
    months = [f"{(r['m0'] + i) // 12}-{(r['m0'] + i) % 12 + 1:02d}" for i in range(len(r["by_month"]))]
    pays = {}
    for kk, _, a in run["payouts"]:
        m = month(SS.days[kk])
        pays[m] = pays.get(m, 0) + 1
    buys = {}
    for kk in run["eval_buys"]:
        m = month(SS.days[kk])
        buys[m] = buys.get(m, 0) + 1
    return dict(k=k, months=months, net=[float(x) for x in r["by_month"]], pays=pays, buys=buys,
                longest_gap=float(r["longest_gap_mo"]), worst12=float(r["worst_12m"]), net_yr=float(r["net_yr"]),
                payouts_yr=float(r["payouts_yr"]), evals_yr=float(r["evals_yr"]),
                gross=float(sum(a for _, _, a in run["payouts"])), n_pay=len(run["payouts"]), n_buy=len(run["eval_buys"]))


def main(dd, out):
    global S
    os.makedirs(out, exist_ok=True)
    build(dd)
    days, N = S.days, len(S.days)
    k0 = int(np.searchsorted(days, np.datetime64(W0).astype(int)))
    wdays = days[k0:]
    yrs_window = (days[-1] - days[k0]) / 365.25
    summary = dict(window=[str(day(days[k0])), str(day(days[-1]))], size="Lucid Flex 50K", commission=COMM,
                   eval_price=FEE, payout_policy="maximum allowed (50% of profit, cap $2,000)",
                   **({} if CONS == 0.4 else dict(eval_consistency=CONS)),
                   **({} if MAXPAY == 5 else dict(max_payouts_per_account=MAXPAY)),
                   **({} if (NQ_FILE, NQ_TF) == ("NSXUSD.npz", 1) else dict(nq_file=NQ_FILE, nq_bar_minutes=NQ_TF)))
    print(f"window {day(days[k0])} -> {day(days[-1])} ({len(wdays)} sessions)", flush=True)

    # ---------------- continuous funded book: legs, years, daily P&L
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
                     round(p.sum() / yrs_window, 0), round(tstat(p), 2)])
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
    summary["book"] = dict(trades=len(rec), net_per_year=round(allp.sum() / yrs_window, 0),
                           days_traded=int(len(traded)), pct_days_positive=round(100 * np.mean(traded > 0), 1),
                           pct_days_qualifying=round(100 * np.mean(traded >= RULES[SIZE]["qday"]), 1),
                           avg_day=round(traded.mean(), 1), median_day=round(float(np.median(traded)), 1),
                           best_day=round(traded.max(), 0), worst_day=round(traded.min(), 0),
                           daily_sharpe=round(daily.mean() / daily.std() * np.sqrt(252), 2))
    hist_edges = list(range(-1400, 2601, 200))
    h, _ = np.histogram(np.clip(traded, -1399, 2599), bins=hist_edges)
    write_csv(os.path.join(out, "daily_pnl_hist.csv"), ["from_usd", "to_usd", "days"],
              [[hist_edges[i], hist_edges[i + 1], int(h[i])] for i in range(len(h))])
    print("book", summary["book"], flush=True)

    # ---------------- evals started on every session of the window
    evs = [(k, run_eval(S, k, **E_KW)) for k in range(k0, N)]
    done = [(k, r) for k, r in evs if r["result"] != "open"]
    passed = [(k, r) for k, r in done if r["result"] == "pass"]
    pdays = np.array([r["days"] for _, r in passed])
    fdays = np.array([r["days"] for _, r in done if r["result"] == "fail"])
    summary["eval"] = dict(started=len(done), pass_pct=round(100 * len(passed) / len(done), 1),
                           sessions_to_pass=dict(p25=float(np.percentile(pdays, 25)), median=float(np.median(pdays)),
                                                 p75=float(np.percentile(pdays, 75)), p90=float(np.percentile(pdays, 90))),
                           sessions_to_fail_median=float(np.median(fdays)),
                           evals_per_funded_account=round(len(done) / len(passed), 2),
                           eval_cost_per_funded_account=round(FEE * len(done) / len(passed), 0))
    ey = []
    for y in sorted({year(days[k]) for k, _ in done}):
        sel = [r for k, r in done if year(days[k]) == y]
        ey.append([y, len(sel), round(100 * np.mean([r["result"] == "pass" for r in sel]), 1)])
    hp, _ = np.histogram(pdays, bins=[1, 4, 7, 10, 13, 16, 21, 31, 61, 999])
    write_csv(os.path.join(out, "eval_sessions_to_pass.csv"), ["sessions", "evals"],
              [[lab, int(c)] for lab, c in zip(["1-3", "4-6", "7-9", "10-12", "13-15", "16-20", "21-30", "31-60", "61+"], hp)])
    print("eval", summary["eval"], flush=True)

    # ---------------- each funded account (from every passed eval with >= 6 months of runway)
    cutoff = np.datetime64("2026-05-13").astype(int)
    fres = []
    for k, r in passed:
        if days[r["k_end"]] > cutoff:
            continue
        fu = run_funded(S, r["k_end"] + 1, **F_KW)
        first = (days[fu["payouts"][0]] - days[r["k_end"]]) if fu["payouts"] else None
        fres.append(dict(n=len(fu["payouts"]), gross=sum(fu["amounts"]), result=fu["result"], first=first,
                         life=int(days[min(fu["k_end"], N - 1)] - days[r["k_end"]])))
    npay = np.array([f["n"] for f in fres])
    firsts = np.array([f["first"] for f in fres if f["first"] is not None])
    summary["funded"] = dict(accounts=len(fres), pct_with_a_payout=round(100 * np.mean(npay >= 1), 1),
                             avg_payouts=round(npay.mean(), 2), avg_withdrawn_net=round(0.9 * np.mean([f["gross"] for f in fres]), 0),
                             days_to_first_payout=dict(median=float(np.median(firsts)), p75=float(np.percentile(firsts, 75)),
                                                       p90=float(np.percentile(firsts, 90))),
                             outcome_pct={o: round(100 * np.mean([f["result"] == o for f in fres]), 1)
                                          for o in ("blown", "abandon", "done", "open")},
                             median_life_days=float(np.median([f["life"] for f in fres])))
    write_csv(os.path.join(out, "funded_payout_count.csv"), ["payouts_before_the_account_ends", "pct_of_funded_accounts"],
              [[i, round(100 * np.mean(npay == i), 1)] for i in range(6)])
    print("funded", summary["funded"], flush=True)

    # ---------------- one account slot: time from the first eval to the first payout
    starts = [k for k in range(k0, N) if days[k] <= cutoff]
    with MP(4, initializer=build, initargs=(dd,)) as mp:
        fp = mp.map(first_payout_job, starts, chunksize=20)
    got = np.array([x for x, _ in fp if x is not None], float)
    summary["first_payout"] = dict(starts=len(starts), pct_paid_by_end=round(100 * len(got) / len(starts), 1),
                                   **{f"pct_within_{m}_days": round(100 * np.mean([x is not None and x <= m for x, _ in fp]), 1)
                                      for m in (30, 60, 90, 180, 365)},
                                   median_days=float(np.median(got)), avg_evals_before=round(np.mean([e for _, e in fp]), 2))
    print("first payout", summary["first_payout"], flush=True)

    # ---------------- 5 funded + eval pool: 10 start dates in the window's first 6 weeks
    offs = list(range(0, 30, 3))
    with MP(4, initializer=build, initargs=(dd,)) as mp:
        paths = mp.map(pool_job, [(k0 + o, {}, {}, None) for o in offs])
        stress = mp.map(pool_job, [(k0 + o, dict(comm=2.0, slip=0.25), dict(comm=2.0, slip=0.25), None) for o in offs[:5]])
    P0 = paths[0]
    cum = np.cumsum(P0["net"])
    write_csv(os.path.join(out, "pool_monthly.csv"), ["month", "net_usd", "cumulative_usd", "payouts", "evals_bought"],
              [[m, round(v, 0), round(c, 0), P0["pays"].get(m, 0), P0["buys"].get(m, 0)] for m, v, c in zip(P0["months"], P0["net"], cum)])
    peak = np.maximum.accumulate(np.r_[0.0, cum])
    years = sorted({int(m[:4]) for m in P0["months"]})
    ytab = []
    for y in years:
        vals = [sum(v for m, v in zip(p["months"], p["net"]) if int(m[:4]) == y) for p in paths]
        pay_n = [sum(n for m, n in p["pays"].items() if int(m[:4]) == y) for p in paths]
        ytab.append([y, round(vals[0], 0), round(min(vals), 0), round(float(np.median(vals)), 0), round(max(vals), 0),
                     int(pay_n[0])])
    write_csv(os.path.join(out, "pool_years.csv"), ["year", "net_usd_first_path", "net_usd_min_of_10", "net_usd_median_of_10",
                                                   "net_usd_max_of_10", "payouts_first_path"], ytab)
    m_from = f"{int(W0[:4]) + 1}-01"  # whole calendar months from the first full year of the window
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

    # ---------------- live alarm bands: block bootstrap of the one-account daily P&L (blocks of 10 sessions)
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
    summary["alarm_bands"] = bands
    print("bands", bands, flush=True)

    # ---------------- book by year: window and full history (context)
    write_csv(os.path.join(out, "book_years.csv"), ["year", "sessions", "net_usd", "overnight_usd", "pyramid_usd", "ib_usd"], yrows)
    write_csv(os.path.join(out, "eval_pass_by_year.csv"), ["year_started", "evals", "pass_pct"], ey)
    k_hist = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in days]))
    rec_all = book(days[k_hist:])
    hy = {}
    for d, leg, side, p in rec_all:
        hy[year(d)] = hy.get(year(d), 0.0) + p
    write_csv(os.path.join(out, "book_years_full_history.csv"), ["year", "net_usd"], [[y, round(v, 0)] for y, v in sorted(hy.items())])

    # ---------------- real MNQ futures: DATA_DIR's recent window MNQ_5m_60d.npz, when it has one (prep_mnq.py --cut)
    mp_ = os.path.join(dd, "MNQ_5m_60d.npz")
    if os.path.exists(mp_):
        mnq = load_npz(mp_)
        own = rth_sessions(*mnq)
        src = adr_seed(dd, own)
        S_main = S
        S = Sessions(mnq, load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5, adr_src=src)
        m0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))
        r = [run_eval(S, k, **E_KW) for k in range(m0, len(S.days))]
        dn = [x for x in r if x["result"] != "open"]
        recm = book(S.days[m0:])
        summary["real_mnq"] = dict(window=[str(day(S.days[m0])), str(day(S.days[-1]))], evals_started=len(dn),
                                   evals_passed=sum(x["result"] == "pass" for x in dn), book_trades=len(recm),
                                   book_net=round(sum(x[3] for x in recm), 0),
                                   book_win_pct=round(100 * np.mean([x[3] > 0 for x in recm]), 1))
        S = S_main
        print("real mnq", summary["real_mnq"], flush=True)
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1, default=float)
    print("wrote", out)


if __name__ == "__main__":
    if len(sys.argv) > 3:
        W0 = sys.argv[3]
    main(sys.argv[1], sys.argv[2])
