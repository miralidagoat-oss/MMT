#!/usr/bin/env python3
"""Research round 4 (pre-registered in PREREG_R4.md, committed before this script was run).

usage: research4.py DATA_DIR OUT_DIR

Part 1 (descriptive): 1 to 5 accounts, three ways, every year Feb 2011 - Nov 2026 and the last 4 years:
  A. "N accounts": N account slots, each one an eval until it passes, then a funded account until it ends, then a new
     eval (portfolio(lanes=N)); every eval and funded account is recorded: pass rate, fails, funded outcomes, payouts.
  B. "N funded + N evals in reserve": up to N funded and 2N accounts in all, one new eval a day (pool(max_funded=N,
     max_total=2N)), the pre-registered form.
  C. "N accounts, one new eval a day": N accounts in all, each an eval until it passes, then funded; a replacement eval
     is bought the next session, never more than one a day (pool(max_funded=N, max_total=N)). Added after the user asked
     for evals to be part of each account; A with N accounts started the same day moves in lockstep (N x one account).
Part 2 (decisions): families T (eval-buying throttle), R (risk level), V (eval reserve size) on B with N = 5,
  against BASE and four placebos, with the decision rule of PREREG_R4.md applied mechanically.

The two instrumented simulators reproduce portfolio() and pool() exactly (checked at start-up: same payouts, same
eval purchases). Lucid Flex 50K, $1.34 per MNQ round turn, the 50K eval price of account.RULES ($115 list;
ONR_EVAL_FEE_50K sets another), 90% split, maximum-allowed payouts.
"""
import csv
import datetime as dt
import json
import os
import sys
from multiprocessing import Pool as MP

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from account import RULES, EvalAccount, FundedAccount  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402
from portfolio import pool, portfolio  # noqa: E402

FEE = RULES[50]["price"]
SPLIT = 0.9
E_KW = dict(improved=True, comm=1.34, size=50)
F_KW = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=1.34, size=50, payout_max=True)
OFFSETS = tuple(range(0, 60, 5))  # 12 start dates inside the first 3 months of each window

_G = {}


def day(S, k):
    return str(np.datetime64(int(S.days[k]), "D"))


# ---------------------------------------------------------------------------------------------- instrumented simulators
def sim_slots(S, N, k0, k1, ek, fk):
    """portfolio(S, lanes=N, reserve=False) with every event recorded: (k, kind, account id, value)."""
    L = [dict(main=None, kind=None, ready=False, start=None, aid=None) for _ in range(N)]
    ev, nid = [], [0]

    def new_eval(k, ln):
        nid[0] += 1
        ln["aid"], ln["start"] = nid[0], k
        ev.append((k, "buy", ln["aid"], 0.0))
        return EvalAccount(S, **ek)

    for k in range(k0, k1):
        d = S.days[k]
        for ln in L:
            if ln["main"] is None:
                if ln["ready"]:
                    nid[0] += 1
                    ln["main"], ln["kind"], ln["ready"], ln["aid"] = FundedAccount(S, **fk), "F", False, nid[0]
                    ev.append((k, "fund", ln["aid"], 0.0))
                else:
                    ln["main"], ln["kind"] = new_eval(k, ln), "E"
            for _ in range(2):  # a 'dead' account is replaced and the replacement trades this same session
                if ln["kind"] == "E":
                    res = ln["main"].step(d)
                    if res == "dead":
                        ev.append((k, "fail", ln["aid"], float(k - ln["start"])))
                        ln["main"] = new_eval(k, ln)
                        continue
                    if res == "fail":
                        ev.append((k, "fail", ln["aid"], float(k - ln["start"] + 1)))
                        ln["main"] = None
                    elif res == "pass":
                        ev.append((k, "pass", ln["aid"], float(k - ln["start"] + 1)))
                        ln["main"], ln["ready"] = None, True
                    break
                evn, amt = ln["main"].step(d)
                if evn == "dead":
                    ev.append((k, "end:abandoned", ln["aid"], 0.0))
                    ln["main"], ln["kind"] = new_eval(k, ln), "E"
                    continue
                if amt > 0:
                    ev.append((k, "payout", ln["aid"], amt))
                if evn in ("blown", "done"):
                    ev.append((k, "end:" + evn, ln["aid"], 0.0))
                    ln["main"] = None
                break
    return ev


def sim_pool(S, N, max_total, k0, k1, ek, fk, gate=None):
    """pool(S, max_funded=N, max_total=max_total, new_per_day=1, buy_gate=gate) with every event recorded."""
    funded, evals, ev, ready, nid = [], [], [], 0, 0
    for k in range(k0, k1):
        d = S.days[k]
        while ready and len(funded) < N:
            nid += 1
            funded.append((FundedAccount(S, **fk), nid))
            ev.append((k, "fund", nid, 0.0))
            ready -= 1
        for _ in range(max(0, min(1, max_total - len(funded) - len(evals) - ready))):
            if gate is not None and not gate(k):
                break
            nid += 1
            evals.append((EvalAccount(S, **ek), nid, k))
            ev.append((k, "buy", nid, 0.0))
        keep = []
        for f, aid in funded:
            evn, amt = f.step(d)
            if amt > 0:
                ev.append((k, "payout", aid, amt))
            if evn is None:
                keep.append((f, aid))
            else:
                ev.append((k, "end:" + ("abandoned" if evn == "dead" else evn), aid, 0.0))
        funded = keep
        keep = []
        for e, aid, ks in evals:
            res = e.step(d)
            if res == "pass":
                ready += 1
                ev.append((k, "pass", aid, float(k - ks + 1)))
            elif res is None:
                keep.append((e, aid, ks))
            else:
                ev.append((k, "fail", aid, float(k - ks + 1)))
        evals = keep
    return ev


def self_check(S):
    """The instrumented simulators must give the same payouts and eval purchases as portfolio() and pool()."""
    k0 = _G["k0"]
    for N in (1, 3, 5):
        for off in (0, 25):
            a = sim_slots(S, N, k0 + off, len(S.days), E_KW, F_KW)
            b = portfolio(S, lanes=N, k_start=k0 + off, eval_kw=E_KW, funded_kw=F_KW)
            assert [k for k, kind, _, _ in a if kind == "buy"] == b["eval_buys"]
            assert [(k, round(v, 6)) for k, kind, _, v in a if kind == "payout"] == [(k, round(x, 6)) for k, _, x in b["payouts"]]
            for mt in (N, 2 * N):
                a = sim_pool(S, N, mt, k0 + off, len(S.days), E_KW, F_KW)
                b = pool(S, k_start=k0 + off, max_funded=N, max_total=mt, eval_kw=E_KW, funded_kw=F_KW)
                assert [k for k, kind, _, _ in a if kind == "buy"] == b["eval_buys"]
                assert sorted((k, round(v, 6)) for k, kind, _, v in a if kind == "payout") == sorted(
                    (k, round(x, 6)) for k, _, x in b["payouts"])
    print("self-check passed: instrumented simulators = portfolio() and pool() (max_total N and 2N) for N = 1, 3, 5 at 2 start dates", flush=True)


# ---------------------------------------------------------------------------------------------- metrics of one run
def run_metrics(S, ev, k_start, k_stop, full_years, periods, fee=None):
    """fee: the price of one eval (default FEE, the 50K price of account.RULES)."""
    fee = FEE if fee is None else fee
    days = [day(S, k) for k in range(k_start, k_stop)]
    net = np.zeros(k_stop - k_start)
    pays = []
    for k, kind, _, v in ev:
        if kind == "payout":
            net[k - k_start] += SPLIT * v
            pays.append(k)
        elif kind == "buy":
            net[k - k_start] -= fee
    run = np.cumsum(net)
    # yearly detail
    yrs = {}
    for i, d in enumerate(days):
        y = yrs.setdefault(d[:4], dict(net=0.0, payouts=0, payouts_usd=0.0, evals_bought=0, evals_passed=0, evals_failed=0,
                                       funded_started=0, funded_paid=set()))
        y["net"] += net[i]
    for k, kind, aid, v in ev:
        y = yrs[day(S, k)[:4]]
        if kind == "payout":
            y["payouts"] += 1
            y["payouts_usd"] += v
        elif kind == "buy":
            y["evals_bought"] += 1
        elif kind == "pass":
            y["evals_passed"] += 1
        elif kind == "fail":
            y["evals_failed"] += 1
        elif kind == "fund":
            y["funded_started"] += 1
    for y in yrs.values():
        y.pop("funded_paid")
    # accounts
    fund = {aid: k for k, kind, aid, _ in ev if kind == "fund"}
    paid = {aid for k, kind, aid, _ in ev if kind == "payout"}
    ended = {aid: kind[4:] for k, kind, aid, _ in ev if kind.startswith("end:")}
    passes = [v for _, kind, _, v in ev if kind == "pass"]
    fails = sum(kind == "fail" for _, kind, _, _ in ev)
    out = dict(years=yrs, cash_low=float(run.min()), total=float(run[-1]),
               evals=dict(bought=sum(kind == "buy" for _, kind, _, _ in ev), passed=len(passes), failed=fails,
                          median_pass=float(np.median(passes)) if passes else 0.0),
               funded=dict(started=len(fund), with_payout=len(paid & set(fund)), payouts=len([1 for e in ev if e[1] == "payout"]),
                           payouts_usd=float(sum(v for _, kind, _, v in ev if kind == "payout")),
                           abandoned=sum(v == "abandoned" for v in ended.values()), blown=sum(v == "blown" for v in ended.values()),
                           done=sum(v == "done" for v in ended.values()), open=len(fund) - len(ended)))
    per = {}
    for lab, a, b in periods:  # a, b: inclusive ISO date strings
        idx = [i for i, d in enumerate(days) if a <= d <= b]
        if not idx:
            continue
        i0, i1 = idx[0], idx[-1]
        pn = net[i0:i1 + 1]
        span = (dt.date.fromisoformat(days[i1]) - dt.date.fromisoformat(days[i0])).days / 365.25
        prun = np.cumsum(pn)
        drop = float((prun - np.maximum.accumulate(np.r_[0.0, prun])[1:]).min())
        months = {}
        for i in range(i0, i1 + 1):
            months[days[i][:7]] = months.get(days[i][:7], 0.0) + net[i]
        mv = np.array([months[m] for m in sorted(months)])
        roll = np.array([mv[j:j + 12].sum() for j in range(len(mv) - 11)]) if len(mv) >= 12 else np.array([mv.sum()])
        pd_ = sorted(days[k - k_start] for k in pays if i0 <= k - k_start <= i1)
        pts = [dt.date.fromisoformat(days[i0])] + [dt.date.fromisoformat(x) for x in pd_] + [dt.date.fromisoformat(days[i1])]
        gap = max((pts[j + 1] - pts[j]).days for j in range(len(pts) - 1)) / 30.44
        fy = [yrs[y]["net"] for y in full_years.get(lab, []) if y in yrs]
        per[lab] = dict(M=float(pn.sum() / span), W=float(min(fy)) if fy else float("nan"),
                        L=float(sum(x < 0 for x in fy)), D=drop, worst12=float(roll.min()), gap=gap,
                        months_paid=100.0 * len({x[:7] for x in pd_}) / len(months),
                        evals_yr=sum(1 for k, kind, _, _ in ev if kind == "buy" and i0 <= k - k_start <= i1) / span)
    out["periods"] = per
    return out


# ---------------------------------------------------------------------------------------------- jobs
def _init(dd):
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    _G["S"] = S
    _G["k0"] = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))
    _G["k4"] = int(np.searchsorted(S.days, np.datetime64("2022-11-14").astype(int)))
    book = np.zeros(len(S.days))  # one funded account, full day budget, fresh account each session (family T)
    for k, d in enumerate(S.days):
        rec = []
        FundedAccount(S, record=rec, **F_KW).step(d)
        book[k] = sum(p for *_, p in rec)
    _G["book"] = book


def gate_for(lookback):
    if lookback is None:
        return None
    book, k0 = _G["book"], _G["k0"]

    def gate(k):
        return k - lookback < k0 or book[k - lookback:k].sum() >= 0.0
    return gate


FULL = {"2011-18": [str(y) for y in range(2012, 2019)], "2019-26": [str(y) for y in range(2019, 2026)],
        "last 4y": ["2023", "2024", "2025"], "all years": [str(y) for y in range(2012, 2026)]}


def _job(args):
    name, struct, N, max_total, ek, fk, lookback, window, off = args
    S = _G["S"]
    k_start = (_G["k0"] if window == "all" else _G["k4"]) + off
    if struct == "A":
        ev = sim_slots(S, N, k_start, len(S.days), ek, fk)
    else:
        ev = sim_pool(S, N, max_total, k_start, len(S.days), ek, fk, gate_for(lookback))
    periods = ([("2011-18", "2011-01-01", "2018-12-31"), ("2019-26", "2019-01-01", "2026-12-31"),
                ("all years", "2011-01-01", "2026-12-31")] if window == "all" else [("last 4y", "2022-11-14", "2026-12-31")])
    return (name, window, off), run_metrics(S, ev, k_start, len(S.days), FULL, periods)


def configs():
    c = []
    for N in range(1, 6):
        c.append((f"A{N}", "A", N, None, E_KW, F_KW, None))
        c.append((f"B{N}", "B", N, 2 * N, E_KW, F_KW, None))
        c.append((f"C{N}", "B", N, N, E_KW, F_KW, None))  # N accounts in all, at most one new eval a day
    c += [("P thr 0.715", "B", 5, 10, dict(E_KW, thr=0.715), dict(F_KW, thr=0.715), None),
          ("P thr 0.722", "B", 5, 10, dict(E_KW, thr=0.722), dict(F_KW, thr=0.722), None),
          ("P size ref 345", "B", 5, 10, E_KW, dict(F_KW, adr_ref=345), None),
          ("P size ref 355", "B", 5, 10, E_KW, dict(F_KW, adr_ref=355), None),
          ("T 63 sessions", "B", 5, 10, E_KW, F_KW, 63),
          ("T 126 sessions", "B", 5, 10, E_KW, F_KW, 126)]
    for kk in (0.5, 0.75, 1.25, 1.5):
        c.append((f"R x{kk}", "B", 5, 10, E_KW, dict(F_KW, adr_ref=350 * kk, day_budget=600.0 * kk), None))
    c += [("V 7 accounts", "B", 5, 7, E_KW, F_KW, None), ("V 8 accounts", "B", 5, 8, E_KW, F_KW, None)]
    return c


def main(dd, out):
    os.makedirs(out, exist_ok=True)
    _init(dd)
    self_check(_G["S"])
    C = configs()
    jobs = [(n, st, N, mt, ek, fk, lb, w, off) for n, st, N, mt, ek, fk, lb in C for w in ("all", "4y") for off in OFFSETS]
    with MP(4, initializer=_init, initargs=(dd,)) as mp:
        res = dict(mp.map(_job, jobs, chunksize=4))
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in res.items()}, open(os.path.join(out, "runs.json"), "w"))
    names = [c[0] for c in C]

    def agg(name, window, key, period):
        return [res[(name, window, o)]["periods"][period][key] for o in OFFSETS]

    # ---------------- Part 1 tables
    years = [str(y) for y in range(2011, 2027)]
    rows = []
    for st, lab in (("A", "N accounts bought the same day (copy-traded in lockstep)"),
                    ("C", "N accounts, each an eval then funded, at most one new eval a day"),
                    ("B", "N funded + N evals in reserve")):
        for N in range(1, 6):
            n = f"{st}{N}"
            for y in years:
                vals = [res[(n, "all", o)]["years"][y] for o in OFFSETS if y in res[(n, "all", o)]["years"]]
                nets = [v["net"] for v in vals]
                med = lambda key: float(np.median([v[key] for v in vals]))  # noqa: E731
                rp = sum(v["evals_passed"] for v in vals)
                rf = sum(v["evals_failed"] for v in vals)
                rows.append([lab, N, y, round(float(np.median(nets))), round(min(nets)), round(max(nets)), med("payouts"),
                             round(med("payouts_usd")), med("evals_bought"), med("evals_passed"), med("evals_failed"),
                             round(100 * rp / (rp + rf), 1) if rp + rf else 0.0, med("funded_started")])
    with open(os.path.join(out, "accounts_by_year.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["structure", "accounts", "year", "net_median_usd", "net_lowest_usd", "net_highest_usd", "payouts_median",
                    "payouts_usd_median", "evals_bought_median", "evals_passed_median", "evals_failed_median",
                    "eval_pass_pct", "funded_started_median"])
        w.writerows(rows)
    summ = []
    for st in ("A", "C", "B"):
        for N in range(1, 6):
            n = f"{st}{N}"
            for window, period in (("all", "all years"), ("all", "2011-18"), ("all", "2019-26"), ("4y", "last 4y")):
                g = lambda key: float(np.mean(agg(n, window, key, period)))  # noqa: E731
                R = [res[(n, window, o)] for o in OFFSETS]
                ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
                fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
                passed, failed = ev("passed"), ev("failed")
                summ.append([st, N, period, round(g("M")), round(g("W")), round(g("L"), 2), round(g("D")), round(g("worst12")),
                             round(g("gap"), 1), round(g("months_paid"), 1), round(g("evals_yr"), 1),
                             round(float(np.mean([r["cash_low"] for r in R]))) if period in ("all years", "last 4y") else "",
                             round(ev("bought"), 1) if period in ("all years", "last 4y") else "",
                             round(100 * passed / (passed + failed), 1) if period in ("all years", "last 4y") else "",
                             round(ev("median_pass"), 1) if period in ("all years", "last 4y") else "",
                             round(fu("started"), 1) if period in ("all years", "last 4y") else "",
                             round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1) if period in ("all years", "last 4y") else "",
                             round(fu("payouts"), 1) if period in ("all years", "last 4y") else "",
                             round(fu("payouts_usd") / max(fu("payouts"), 1e-9)) if period in ("all years", "last 4y") else "",
                             round(fu("abandoned"), 1) if period in ("all years", "last 4y") else "",
                             round(fu("done"), 1) if period in ("all years", "last 4y") else "",
                             round(fu("blown"), 1) if period in ("all years", "last 4y") else ""])
    with open(os.path.join(out, "accounts_summary.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["structure", "accounts", "period", "net_per_year_usd", "worst_full_year_usd", "losing_full_years",
                    "deepest_drop_usd", "worst_12_months_usd", "longest_gap_months", "months_with_payout_pct", "evals_per_year",
                    "most_cash_out_usd", "evals_bought", "eval_pass_pct", "eval_median_sessions", "funded_accounts",
                    "funded_with_payout_pct", "payouts", "average_payout_usd", "funded_abandoned", "funded_done_5_payouts",
                    "funded_blown"])
        w.writerows(summ)
    print("wrote accounts_by_year.csv and accounts_summary.csv", flush=True)

    # ---------------- Part 2 decisions (B5 = BASE)
    P = ("2011-18", "2019-26")
    keys = ("M", "W", "L", "D")
    mean = {n: {p: {k: float(np.mean(agg(n, "all", k, p))) for k in keys + ("worst12", "gap")} for p in P} for n in names}
    for n in names:
        mean[n]["last 4y"] = {k: float(np.mean(agg(n, "4y", k, "last 4y"))) for k in keys + ("worst12", "gap")}
    base = "B5"
    band = {p: {k: max(abs(mean[x][p][k] - mean[base][p][k]) for x in names if x.startswith("P ")) for k in keys} for p in P}
    lines = ["Part 2: 5 funded accounts + evals (BASE = B5), mean of 12 start dates; M net/yr, W worst full year, "
             "L losing full years, D deepest drop",
             "noise bands (largest placebo move): " + " | ".join(f"{p}: M {band[p]['M']:,.0f}, W {band[p]['W']:,.0f}" for p in P)]
    for n in [base] + [x for x in names if x[0] in "PTRV"]:
        lines.append(f"  {n:16s} " + " || ".join(f"{p}: M {mean[n][p]['M']:>8,.0f} W {mean[n][p]['W']:>8,.0f} L {mean[n][p]['L']:.2f} "
                                                  f"D {mean[n][p]['D']:>8,.0f} worst12 {mean[n][p]['worst12']:>8,.0f} gap {mean[n][p]['gap']:.1f}"
                                                  for p in P + ("last 4y",)))

    def passes(n, p):
        dM, dW = mean[n][p]["M"] - mean[base][p]["M"], mean[n][p]["W"] - mean[base][p]["W"]
        if dW > band[p]["W"] and dM >= -band[p]["M"]:
            return "consistency", dW
        if dM > band[p]["M"] and dW >= -band[p]["W"]:
            return "money", dM
        return None, 0.0

    adopted = []
    for fam in "TRV":
        cand = [n for n in names if n.startswith(fam + " ")]
        ok = [(n,) + passes(n, "2011-18") for n in cand]
        ok = [x for x in ok if x[1]]
        if not ok:
            lines.append(f"  {fam}: reject (no variant passes 2011-18)")
            continue
        ok.sort(key=lambda x: (x[1] != "consistency", -x[2]))
        pick = ok[0][0]
        route, _ = passes(pick, "2019-26")
        lines.append(f"  {fam}: {pick} passes 2011-18 by {ok[0][1]}; 2019-26: {'passes by ' + route if route else 'fails'}"
                     f" -> {'ADOPT' if route else 'reject'}")
        if route:
            adopted.append(pick)
    lines.append("Adopted: " + (", ".join(adopted) if adopted else "none"))
    open(os.path.join(out, "decisions.txt"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines), flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
