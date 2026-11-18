#!/usr/bin/env python3
"""The final ONR Book v2.2 at Lucid Flex 50K on REAL MNQ futures (Yahoo MNQ=F 5-minute bars, the last 60 days).

The S&P stretch score still comes from an S&P 500 CFD (as in the indicator); DATA_DIR's SPXUSD.npz may be HistData's
series extended past its end with another S&P source (prep_spx_ext.py), and the run says which sessions, if any, had
to reuse an older score. The ADR's first 14 sessions are seeded from the Nasdaq CFD because the Yahoo window starts
mid-stream. Everything traded is real MNQ.
usage: mnq_real50k.py DATA_DIR      (needs MNQ_5m_60d.npz, NSXUSD.npz, SPXUSD.npz from prep_data.py)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from account import RULES, EvalAccount, FundedAccount, funded_size, run_eval  # noqa: E402
from engine import Sessions, load_npz, rth_sessions  # noqa: E402
from portfolio import pool  # noqa: E402

E_KW = dict(improved=True, comm=1.34, size=50)
F_KW = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=1.34, size=50, payout_max=True)
FEE = RULES[50]["price"]
LEG = {"on": "Overnight", "pyr": "Pyramid", "ib": "IB breakout"}


def day(d):
    return str(np.datetime64(int(d), "D"))


def main(dd):
    mnq = load_npz(os.path.join(dd, "MNQ_5m_60d.npz"))
    own = rth_sessions(*mnq)
    src = {d: v for d, v in rth_sessions(*load_npz(os.path.join(dd, "NSXUSD.npz"))).items() if d < min(own)}
    src.update(own)
    S = Sessions(mnq, load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5, adr_src=src)
    days = S.days
    m0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in days]))
    last_spx = max(d for d, v in S.srth.items() if v["nb"] >= 13)
    after = [d for d in days[m0:] if d > last_spx]
    stale = [day(d) for d in after[1:]]  # the first session after it uses its score as intended; later ones reuse it
    t_end = np.datetime64(int(mnq[0][-1]) + 5, "m")
    print(f"REAL MNQ futures, 5-min bars: {day(days[m0])} -> {day(days[-1])}, {len(days) - m0} sessions, last bar ends "
          f"{t_end} ET; S&P score data through the {day(last_spx)} session"
          + (f", so {', '.join(stale)} reuse(s) that score" if stale else ": every session has its own score") + "\n")

    # ---- one funded 50K account trading every session (full $1,200 budget, never reset): every trade
    print("== Every trade of one funded 50K account (full day budget every session)")
    print(f"{'date':10s}  {'ADR':>5s}  {'MNQ':>3s}  {'trade':11s}  {'side':4s}  {'result':>8s}")
    rec, by_day, by_leg = [], {}, {}
    for d in days[m0:]:
        r = []
        FundedAccount(S, record=r, **F_KW).step(d)
        n = funded_size(S.S[d]["adr"], 700.0, nmax=RULES[50]["fundmax"])
        for _, leg, side, p in r:
            print(f"{day(d)}  {S.S[d]['adr']:5.0f}  {n:3d}  {LEG[leg]:11s}  {'BUY' if side > 0 else 'SELL':4s}  {p:+8.0f}")
            by_leg.setdefault(leg, []).append(p)
        if r:
            by_day[d] = sum(x[3] for x in r)
        rec += r
    allp = np.array([x[3] for x in rec])
    print(f"\n   {'trade':11s} {'trades':>6s} {'winners':>8s} {'net $':>9s} {'avg $':>7s}")
    for leg in ("on", "pyr", "ib"):
        p = np.array(by_leg.get(leg, []))
        if len(p):
            print(f"   {LEG[leg]:11s} {len(p):6d} {100 * np.mean(p > 0):7.0f}% {p.sum():+9,.0f} {p.mean():+7.0f}")
    print(f"   {'ALL':11s} {len(allp):6d} {100 * np.mean(allp > 0):7.0f}% {allp.sum():+9,.0f} {allp.mean():+7.0f}")
    dv = np.array(list(by_day.values()))
    print(f"   traded days {len(dv)}: positive {np.mean(dv > 0) * 100:.0f}%, >= $150 (qualifying) {np.mean(dv >= 150) * 100:.0f}%, "
          f"best {dv.max():+,.0f}, worst {dv.min():+,.0f}")
    wk = {}
    for d, v in by_day.items():
        key = day(int(d) - (int(d) + 3) % 7)  # Monday of that week (day 0, 1970-01-01, was a Thursday)
        wk[key] = wk.get(key, 0.0) + v
    print("   by week (Monday):", "  ".join(f"{k[5:]} {v:+,.0f}" for k, v in sorted(wk.items())))

    # ---- evals started on every session
    print("\n== 50K evals started on each session")
    res = [(k, run_eval(S, k, **E_KW)) for k in range(m0, len(days))]
    for k, r in res:
        end = day(days[min(r["k_end"], len(days) - 1)])
        print(f"   start {day(days[k])}: {r['result']:5s} after {r['days']:2d} sessions ({r['trades']} trades), ends {end}")
    done = [r for _, r in res if r["result"] != "open"]
    npass = sum(r["result"] == "pass" for r in done)
    print(f"   passed {npass} of {len(done)} finished ({100 * npass / len(done):.0f}%), "
          f"median {np.median([r['days'] for r in done if r['result'] == 'pass']):.0f} sessions to pass; "
          f"{len(res) - len(done)} still open at the data's end")

    # ---- one account bought on the first session, followed through eval and funding
    print("\n== One 50K account bought on the first session (eval -> funded -> payouts, buying a new eval if one fails)")
    k, evals, fees, paid = m0, 0, 0.0, 0.0
    while k < len(days):
        ev = EvalAccount(S, **E_KW)
        evals += 1
        fees += FEE
        start = k
        res_e = None
        while k < len(days):
            res_e = ev.step(days[k])
            if res_e == "dead":
                break
            k += 1
            if res_e is not None:
                break
        print(f"   eval #{evals} bought {day(days[start])}: {res_e or 'still open'} {day(days[k - 1]) if res_e else ''} "
              f"(eval P&L ${ev.pnl:+,.0f})")
        if res_e != "pass":
            if res_e is None:
                break
            continue
        fu = FundedAccount(S, **F_KW)
        fstart = k
        while k < len(days):
            evn, amt = fu.step(days[k])
            if evn == "dead":
                print(f"   funded account abandoned before {day(days[k])} (cushion below $400)")
                break
            k += 1
            if amt > 0:
                paid += amt
                print(f"   payout {fu.npay}: ${amt:,.0f} requested {day(days[k - 1])} (you keep ${0.9 * amt:,.0f})")
            if evn is not None:
                print(f"   funded account ended {day(days[k - 1])}: {evn}")
                break
        else:
            print(f"   funded since {day(days[fstart])}, still open at the data's end: P&L ${fu.pnl:+,.0f}, "
                  f"{fu.q} qualifying days since the last payout")
    print(f"   result: {evals} eval(s) (${fees:,.0f}), payouts ${paid:,.0f} gross -> net ${0.9 * paid - fees:+,.0f}")

    # ---- 5 funded + eval pool
    run = pool(S, k_start=m0, eval_kw=E_KW, funded_kw=F_KW)
    gross = sum(a for _, _, a in run["payouts"])
    print(f"\n== 5 funded 50K + eval pool from {day(days[m0])}: {len(run['payouts'])} payouts (${gross:,.0f} gross), "
          f"{len(run['eval_buys'])} evals bought (${FEE * len(run['eval_buys']):,.0f}) -> net "
          f"${0.9 * gross - FEE * len(run['eval_buys']):+,.0f} in {len(days) - m0} sessions")
    for kk, lane, a in run["payouts"]:
        print(f"   {day(days[kk])}  ${a:,.0f}")


if __name__ == "__main__":
    main(sys.argv[1])
