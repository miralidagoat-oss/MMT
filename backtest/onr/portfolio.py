#!/usr/bin/env python3
"""Several Lucid Flex 25K accounts copy-trading the ONR Book side by side.

Each "lane" is one account slot: eval -> funded -> payouts until blown / abandoned / 5 payouts -> next eval, exactly
as account.lifecycle. Lucid caps (Nov 2026): 5 funded accounts, 10 accounts in total, per household. With
reserve=True each lane also runs one eval while its funded account is alive; a reserve eval that passes waits (assumed:
activated only when the lane's funded account ends), so a lane never holds more than 1 funded + 1 eval.
All accounts take the same signals, so with the v2.1 IB rule no two positions are ever opposite (Lucid's hedging rule).

usage: portfolio.py DATA_DIR
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from account import EvalAccount, FundedAccount  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402

V21_EVAL = dict(improved=True)
V21_FUNDED = dict(adr_ref=350, improved=True, ib_with_drive=True)


def portfolio(S, lanes=5, k_start=0, k_stop=None, stagger=0, eval_kw=None, funded_kw=None, reserve=False):
    """Returns dict(payouts=[(k, lane, gross $)], eval_buys=[k, ...])."""
    eval_kw = V21_EVAL if eval_kw is None else eval_kw
    funded_kw = V21_FUNDED if funded_kw is None else funded_kw
    k_stop = len(S.days) if k_stop is None else k_stop
    L = [dict(start=k_start + i * stagger, main=None, kind=None, res=None, ready=False) for i in range(lanes)]
    pays, buys = [], []

    def new_eval(k):
        buys.append(k)
        return EvalAccount(S, **eval_kw)

    for k in range(k_start, k_stop):
        d = S.days[k]
        for i, ln in enumerate(L):
            if k < ln["start"]:
                continue
            if ln["main"] is None:  # fill the slot: passed eval -> funded, else continue a reserve eval, else buy one
                if ln["ready"]:
                    ln["main"], ln["kind"], ln["ready"] = FundedAccount(S, **funded_kw), "F", False
                elif ln["res"] is not None:
                    ln["main"], ln["kind"], ln["res"] = ln["res"], "E", None
                else:
                    ln["main"], ln["kind"] = new_eval(k), "E"
            funded_at_start = ln["kind"] == "F"
            for _ in range(2):  # a 'dead' account is replaced and the replacement trades this same session
                if ln["kind"] == "E":
                    res = ln["main"].step(d)
                    if res == "dead":
                        ln["main"] = new_eval(k)
                        continue
                    if res == "fail":
                        ln["main"] = None
                    elif res == "pass":
                        ln["main"], ln["ready"] = None, True
                    break
                ev, amt = ln["main"].step(d)
                if ev == "dead":
                    funded_at_start = False
                    if ln["ready"]:
                        ln["main"], ln["ready"] = FundedAccount(S, **funded_kw), False
                    elif ln["res"] is not None:
                        ln["main"], ln["kind"], ln["res"] = ln["res"], "E", None
                    else:
                        ln["main"], ln["kind"] = new_eval(k), "E"
                    continue
                if amt > 0:
                    pays.append((k, i, amt))
                if ev in ("blown", "done"):
                    ln["main"] = None
                break
            if reserve and funded_at_start and not ln["ready"]:
                if ln["res"] is None:
                    ln["res"] = new_eval(k)
                res = ln["res"].step(d)
                if res == "dead":
                    ln["res"] = new_eval(k)
                    res = ln["res"].step(d)
                if res == "fail":
                    ln["res"] = None
                elif res == "pass":
                    ln["res"], ln["ready"] = None, True
    return dict(payouts=pays, eval_buys=buys)


def pool(S, k_start=0, k_stop=None, max_funded=5, max_total=10, new_per_day=1, eval_kw=None, funded_kw=None,
         buy_gate=None):
    """Keep the household at Lucid's caps: up to max_funded funded accounts and max_total accounts in all; buy at most
    new_per_day evals per session while below max_total. Passed evals wait (counted) until a funded slot frees up.
    buy_gate(k) -> bool (research round 4, family T): when given, no eval is bought on a session where it is False."""
    eval_kw = V21_EVAL if eval_kw is None else eval_kw
    funded_kw = V21_FUNDED if funded_kw is None else funded_kw
    k_stop = len(S.days) if k_stop is None else k_stop
    funded, evals, pays, buys = [], [], [], []
    ready = 0
    for k in range(k_start, k_stop):
        d = S.days[k]
        while ready and len(funded) < max_funded:
            funded.append(FundedAccount(S, **funded_kw))
            ready -= 1
        for _ in range(max(0, min(new_per_day, max_total - len(funded) - len(evals) - ready))):
            if buy_gate is not None and not buy_gate(k):
                break
            evals.append(EvalAccount(S, **eval_kw))
            buys.append(k)
        keep = []
        for i, f in enumerate(funded):
            ev, amt = f.step(d)
            if amt > 0:
                pays.append((k, i, amt))
            if ev is None:
                keep.append(f)
        funded = keep
        keep = []
        for e in evals:
            res = e.step(d)
            if res == "pass":
                ready += 1
            elif res is None:
                keep.append(e)
        evals = keep
    return dict(payouts=pays, eval_buys=buys)


def month_id(d):
    s = str(np.datetime64(int(d), "D"))
    return int(s[:4]) * 12 + int(s[5:7]) - 1


def summarize(S, run, k_start, k_stop, fee=60.0, split=0.9):
    days = S.days
    d0, d1 = days[k_start], days[k_stop - 1]
    yrs = (d1 - d0) / 365.25
    pays = [(days[k], a) for k, _, a in run["payouts"] if k < k_stop]
    gross = sum(a for _, a in pays)
    net = gross * split - fee * sum(1 for k in run["eval_buys"] if k < k_stop)
    m0, m1 = month_id(d0), month_id(d1)
    by_m = np.zeros(m1 - m0 + 1)
    for d, a in pays:
        by_m[month_id(d) - m0] += a * split
    for k in run["eval_buys"]:
        if k < k_stop:
            by_m[month_id(days[k]) - m0] -= fee
    gaps = np.diff([d0] + sorted(d for d, _ in pays) + [d1])
    roll12 = np.array([by_m[i:i + 12].sum() for i in range(len(by_m) - 11)]) if len(by_m) >= 12 else by_m
    return dict(payouts_yr=len(pays) / yrs, net_yr=net / yrs, months_paid=100 * np.mean(by_m > 0) if len(by_m) else 0,
                months_with_payout=100 * len({month_id(d) for d, _ in pays}) / (m1 - m0 + 1),
                longest_gap_mo=gaps.max() / 30.44, worst_12m=roll12.min(), evals_yr=len(run["eval_buys"]) / yrs,
                by_month=by_m, m0=m0)


def main(dd):
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    days = S.days
    k0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in days]))
    kmid = int(np.searchsorted(days, np.datetime64("2019-01-01").astype(int)))
    periods = (("2011-18", k0, kmid), ("2019-26", kmid, len(days)))
    scen = [("1 account", portfolio, dict(lanes=1)),
            ("5 accounts, bought the same day", portfolio, dict(lanes=5, stagger=0)),
            ("5 accounts, staggered 1 week", portfolio, dict(lanes=5, stagger=5)),
            ("5 accounts, 1 week + reserve evals", portfolio, dict(lanes=5, stagger=5, reserve=True)),
            ("5 funded + pool of evals (10 max)", pool, dict(max_funded=5, max_total=10, new_per_day=1))]
    print("v2.1, net = payouts x 90% - evals x $60; averaged over 6 start dates 2 months apart in each period")
    for name, fn, kw in scen:
        for lab, a, b in periods:
            rs = [summarize(S, fn(S, k_start=a + off, k_stop=b, **kw), a + off, b) for off in range(0, 252, 42)]
            g = lambda key, f=np.mean: f([r[key] for r in rs])  # noqa: E731
            print(f"  {name:36s} {lab}: payouts/yr {g('payouts_yr'):5.1f} | net ${g('net_yr'):7,.0f}/yr | months with a payout "
                  f"{g('months_with_payout'):4.1f}% | evals/yr {g('evals_yr'):5.1f} | longest dry spell {g('longest_gap_mo'):4.1f} mo "
                  f"(worst {g('longest_gap_mo', np.max):4.1f}) | worst 12 months ${g('worst_12m', np.min):7,.0f}", flush=True)
    for name, fn, kw in (scen[2], scen[4]):
        r = summarize(S, fn(S, k_start=k0, **kw), k0, len(days))
        by_y = {}
        for i, v in enumerate(r["by_month"]):
            y = (r["m0"] + i) // 12
            by_y[y] = by_y.get(y, 0.0) + v
        print(f"  {name}, started {np.datetime64(int(days[k0]), 'D')}: net by year " +
              " ".join(f"{y}:${v:,.0f}" for y, v in sorted(by_y.items())), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
