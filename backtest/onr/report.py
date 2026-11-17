#!/usr/bin/env python3
"""Headline backtest of indicators/onr_book.pine: original v1 logic vs the v2 fixes.

usage: report.py DATA_DIR      (DATA_DIR holds NSXUSD.npz, SPXUSD.npz from prep_data.py, optional MNQ_5m_60d.npz)

Long history (2011-2026) uses the HistData Nasdaq-100 / S&P 500 CFDs with the DST-mismatch timestamp fix; the CFD
reproduces real MNQ futures trades to within ~$25 per trade on the 2026 overlap (see README section). MNQ sizing
($2/pt), $1 commission per MNQ round turn, Pine fill rules. Lifecycle = one Lucid Flex 25K at a time: eval -> funded ->
payouts until blown / abandoned / 5 payouts -> buy the next eval the next session.
"""
import os
import sys

import numpy as np

from account import FundedAccount, lifecycle, run_eval
from engine import PV, Sessions, funded_on, ib_breakout, load_npz, pyramid, rth_sessions


def year(d):
    return int(str(np.datetime64(int(d), "D"))[:4])


def months(d):
    s = str(np.datetime64(int(d), "D"))
    return int(s[:4]) * 12 + int(s[5:7]) - 1


def life_stats(S, a, b, eval_kw, funded_kw, step=42):
    longest, mfrac, py, ev, net = [], [], [], [], []
    for k in range(a, b - 250, step):
        L = lifecycle(S, k, k_stop=b, eval_kw=eval_kw, funded_kw=funded_kw)
        p = sorted(x for x in L["payouts"] if x < S.days[b - 1])
        d0, d1 = S.days[k], S.days[b - 1]
        gaps = np.diff([d0] + p + [d1])
        longest.append(gaps.max() / 30.44)
        mfrac.append(len(set(months(x) for x in p)) / (months(d1) - months(d0) + 1))
        yrs = (d1 - d0) / 365.25
        py.append(len(p) / yrs)
        ev.append(L["evals"] / yrs)
        net.append((len(p) * 450.0 - L["evals"] * 60.0) / yrs)
    return dict(payouts_yr=np.mean(py), months_pct=100 * np.mean(mfrac), evals_yr=np.mean(ev),
                net_yr=np.mean(net), dry_median=np.median(longest), dry_worst=np.max(longest))


def pass_rate(S, a, b, **kw):
    res = [run_eval(S, k, **kw) for k in range(a, b)]
    done = [r for r in res if r["result"] != "open"]
    p = [r for r in done if r["result"] == "pass"]
    return 100 * len(p) / len(done), np.median([r["days"] for r in p])


def book(S, days, **fk):
    """Continuous funded book: each session traded by a fresh account (full $600 day budget, no resets)."""
    rec = []
    for d in days:
        FundedAccount(S, record=rec, **fk).step(d)
    return rec


def funded_years(S, **fk):
    by = {}
    for d, leg, side, p in book(S, S.days, **fk):
        by[year(d)] = by.get(year(d), 0.0) + p
    return by


def main(dd):
    nq, spx = load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz"))
    S = Sessions(nq, spx, tf=1)
    days = S.days
    k0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in days]))
    kmid = int(np.searchsorted(days, np.datetime64("2019-01-01").astype(int)))
    periods = (("2011-18", k0, kmid), ("2019-26", kmid, len(days)))
    cfg = {"v1 (as written)": (dict(), dict()),
           "v2.1 (fixed)": (dict(improved=True), dict(adr_ref=350, improved=True, ib_with_drive=True))}
    print("== Eval pass rate (new eval started every session), median sessions to pass")
    for name, (ek, _) in cfg.items():
        print(f"  {name:16s}", " | ".join(f"{lab}: {pr:4.1f}% ({md:.0f} sessions)" for lab, a, b in periods
                                          for pr, md in [pass_rate(S, a, b, **ek)]), flush=True)
    print("== Lifecycle, one 25K at a time (net $/yr = payouts x $450 - evals x $60)")
    for name, (ek, fk) in cfg.items():
        for lab, a, b in periods:
            r = life_stats(S, a, b, ek, fk)
            print(f"  {name:16s} {lab}: payouts/yr {r['payouts_yr']:4.1f} | months with a payout {r['months_pct']:4.1f}% | "
                  f"evals/yr {r['evals_yr']:4.1f} | net ${r['net_yr']:6.0f}/yr | longest dry spell median "
                  f"{r['dry_median']:4.1f} mo, worst {r['dry_worst']:4.1f} mo", flush=True)
    print("== Robustness of v2.1 (lifecycle payouts/yr, worst dry spell)")
    late = Sessions(nq, spx, tf=1, ev=dict(on=11, od=936, ib=991), score=(S.score_raw, S.feats))
    f21 = cfg["v2.1 (fixed)"][1]
    for name, SS, ek, fk in (("costs x2 + 1 tick slip", S, dict(improved=True, comm=2.0, slip=0.25),
                              dict(f21, comm=2.0, slip=0.25)),
                             ("entries 1 min late", late, dict(improved=True), f21)):
        out = []
        for lab, a, b in periods:
            r = life_stats(SS, a, b, ek, fk)
            out.append(f"{lab}: {r['payouts_yr']:4.1f}/yr, worst dry {r['dry_worst']:4.1f} mo")
        print(f"  {name:24s}", " | ".join(out), flush=True)
    print("== Funded book $ per year (full day budget every session, no account resets)")
    for name, fk in (("v1 (1 MNQ)", dict()), ("v2.1 (ADR-sized)", f21)):
        by = funded_years(S, **fk)
        print(f"  {name:16s}", " ".join(f"{y}:{v:+.0f}" for y, v in sorted(by.items())),
              f"| positive years {sum(v > 0 for v in by.values())}/{len(by)}", flush=True)
    mp = os.path.join(dd, "MNQ_5m_60d.npz")
    if os.path.exists(mp):
        mnq = load_npz(mp)
        own = rth_sessions(*mnq)
        src = {d: v for d, v in rth_sessions(*nq).items() if d < min(own)}
        src.update(own)
        M = Sessions(mnq, spx, tf=5, adr_src=src)
        m0 = int(np.argmax([not np.isnan(M.S[d]["adr"]) and not np.isnan(M.S[d]["score"]) for d in M.days]))
        print(f"== REAL MNQ futures, 5-min bars {np.datetime64(int(M.days[0]), 'D')} -> {np.datetime64(int(M.days[-1]), 'D')}")
        for name, (ek, fk) in cfg.items():
            res = [run_eval(M, k, **ek) for k in range(m0, len(M.days))]
            done = [r for r in res if r["result"] != "open"]
            npass = sum(r["result"] == "pass" for r in done)
            rec = book(M, M.days[m0:], **fk)
            print(f"  {name:16s} evals: {npass}/{len(done)} rolling starts passed | funded book (full budget, "
                  f"no resets): {len(rec)} trades, ${sum(x[3] for x in rec):+.0f}, "
                  f"{100 * np.mean([x[3] > 0 for x in rec]):.0f}% winners", flush=True)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main(sys.argv[1])
