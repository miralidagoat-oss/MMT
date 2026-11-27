#!/usr/bin/env python3
"""Two proposals for indicator v2.7, made by another assistant (Nov 27 2026), checked on this research's own engine:
  1. funded / live accounts skip the 18:10 overnight trade (evals keep it);
  2. the 5-minute ORB leg (round 7's F1) loses before 2021.

usage: python3 -I check_proposals.py MNQ_DATA_DIR CFD_DATA_DIR OUT_DIR
  MNQ_DATA_DIR: NQFUT.npz + SPXUSD.npz (the user's MNQ file, Dec 2019 - Nov 2026)
  CFD_DATA_DIR: NSXUSD.npz + SPXUSD.npz (the HistData Nasdaq-100 and S&P 500 CFDs of the earlier research), used only
                for 2011-2020, which the MNQ file does not cover

Everything uses the published engine and account classes (engine.Sessions, account.FundedAccount / EvalAccount,
research4.sim_pool, topstep_sim's rules and cash flows), $1.00 a round turn, the engine's fills (the event bar's
close, stops at the stop or the gapped open, targets with a 1-tick trade-through, stop first on a tie).
  A. The overnight trade in its funded form (stop 0.5 ADR, no target, out at 09:30), 1 MNQ, by year.
  B. The 5-minute ORB (first 5 minutes >= 0.05 ADR, entry at the 09:35 close, stop 0.10 ADR, target 1 ADR, out at
     16:00), 1 MNQ, by year, in R (result / 0.10 ADR): NQ CFD 2011-2020, S&P 500 CFD 2011-2020 (as the traded
     market), MNQ 2020-2026. On the MNQ file it is checked equal to round 7's F1 leg (r7_accounts.precompute).
  C. Funded accounts alone (no pool): one started every 5 sessions, run until it ends or the window does (starts at
     least 126 sessions before the window's end): share reaching a payout and payouts per account, with the
     book's legs and without the overnight trade, under Topstep 50K XFA rules and Lucid 50K rules.
  D. Topstep 50K, 5 XFAs + 5 Combines (Combines keep the overnight trade), with and without it in the XFAs:
     MNQ last 5 years and Dec 2019 - Nov 2021 (12 start dates, rule 5Y with r7_accounts.py's Topstep noise bands),
     MNQ years 1 / 2 / 3 from 48 monthly start dates (Dec 2019 - Nov 2023), NQ CFD 2011-2020 (12 start dates).
Writes OUT_DIR/proposals.json.
"""
import json
import os
import sys
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account as ACC  # noqa: E402
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402
import windows as W  # noqa: E402
from account import COMM_RT, FundedAccount, is_half  # noqa: E402
from engine import PV, Sessions, bracket_exit, funded_on, load_npz  # noqa: E402

G = {}
BOOK, NO_ON = ("on", "pyr", "ib"), ("pyr", "ib")
FK = {"topstep50": lambda legs: dict(T.fk(50, "standard"), legs=legs),
      "lucid50": lambda legs: dict(R4.F_KW, max_pay=4, legs=legs)}
BANDS_TOPSTEP50 = dict(net_5y=14308, worst_5y=18872, net_early=4909, worst_early=8243)   # results_r7/accounts.csv


def iso(S, k):
    return str(np.datetime64(int(S.days[k]), "D"))


def kix(S, date):
    return int(np.searchsorted(S.days, np.datetime64(date).astype(int)))


def tstat(x):
    x = np.asarray(x, float)
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))) if len(x) > 2 and x.std() > 0 else float("nan")


def by_year(rows):
    """rows: (day, value) -> {year: [n, sum, mean, t]}"""
    out = {}
    for d, v in rows:
        out.setdefault(str(np.datetime64(int(d), "D"))[:4], []).append(v)
    return {y: [len(v), round(float(np.sum(v)), 2), round(float(np.mean(v)), 4), round(tstat(v), 2)] for y, v in sorted(out.items())}


def pooled(rows, a, b):
    v = [x for d, x in rows if a <= str(np.datetime64(int(d), "D")) <= b]
    return dict(n=len(v), mean=round(float(np.mean(v)), 4), t=round(tstat(v), 2), total=round(float(np.sum(v)), 1),
                years_up=None)


# ------------------------------------------------------------------------------------------------- A and B
def overnight_trades(S):
    rows = []
    for d in S.days:
        d = int(d)
        sd = S.on_side(d)
        if sd != 0:
            rows.append((d, funded_on(S, d, sd, 0.0, 0.5, n=1, comm=COMM_RT)[0]))
    return rows


def orb_trades(S, slip=0.0):
    """(day, side, $ at 1 MNQ, R): the 5-minute ORB in the engine convention, not on half days."""
    out = []
    for d in S.days:
        d = int(d)
        r = S.S[d]
        A = r["adr"]
        if np.isnan(A) or "od" not in r or is_half(d):
            continue
        d5 = (r["od"]["E"] - r["rOpen"]) / A
        if abs(d5) < 0.05:
            continue
        s = 1 if d5 > 0 else -1
        E = r["od"]["E"] + s * slip
        px, why = bracket_exit(r["od"]["w"], s, E, 0.10 * A, 1.0 * A, slip)
        usd = (px - E) * s * PV - COMM_RT
        out.append((d, s, usd, usd / (0.10 * A * PV)))
    return out


def summary_rows(rows):
    ys = by_year(rows)
    return dict(by_year=ys, years_up=sum(1 for v in ys.values() if v[1] > 0), years=len(ys))


# ------------------------------------------------------------------------------------------------- C
def payout_job(a):
    src, rule, legs, k0, kb, ka = a
    S = G[src]
    acc = FundedAccount(S, **FK[rule](legs))
    npay = 0
    for k in range(k0, kb):
        evn, amt = acc.step(S.days[k])
        if amt > 0:
            npay += 1
        if evn is not None:
            break
    return a, npay


def payout_jobs(src, a, b):
    S = G[src]
    ka, kb = kix(S, a), int(np.searchsorted(S.days, np.datetime64(b).astype(int), "right"))
    ka = max(ka, T.first_tradable(S))
    return [(src, rule, legs, k0, kb, ka) for rule in FK for legs in (BOOK, NO_ON) for k0 in range(ka, kb - 126, 5)]


# ------------------------------------------------------------------------------------------------- D
def pool_job(a):
    src, legs, k0, tag = a
    S = G[src]
    assert R4.FundedAccount is ACC.FundedAccount and R4.EvalAccount is ACC.EvalAccount
    ek, fk = T.ek(50), dict(T.fk(50, "standard"), legs=legs)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
    cash = T.cash_flows(S, k0, ev, "noact", 50)
    if tag == "5y":
        per, fy = [("last 5y", W.START5, "2026-12-31")], {"last 5y": W.FULL_YEARS_5Y}
    elif tag == "early":
        per, fy = [("early", "2019-01-01", "2021-11-14")], {"early": ["2020"]}
    elif tag == "cfd":
        per, fy = [("2011-20", "2011-01-01", "2020-12-31")], {"2011-20": [str(y) for y in range(2012, 2021)]}
    else:   # years 1 / 2 / 3 from this start
        return a, [float(cash[252 * i:252 * (i + 1)].sum()) for i in range(3)]
    res = T.summarise_run(S, k0, cash, ev, per, fy)
    lab = per[0][0]
    f = res["funded"]
    return a, dict(M=res["periods"][lab]["M"], W=res["periods"][lab]["W"],
                   funded_paid_share=f["with_payout"] / f["started"] if f["started"] else float("nan"))


def monthly_starts(S, a, b):
    out, seen = [], set()
    k1 = T.first_tradable(S)
    for k in range(len(S.days)):
        m = iso(S, k)[:7]
        if a <= m <= b and m not in seen:
            seen.add(m)
            out.append(max(k, k1))
    return out


def main(dd_mnq, dd_cfd, out):
    G["mnq"] = T.load("fut", dd_mnq)
    G["cfd"] = T.load("cfd", dd_cfd)
    spx = load_npz(os.path.join(dd_cfd, "SPXUSD.npz"))
    G["spx"] = Sessions(spx, spx, tf=1)
    res = {}
    # A: the overnight trade
    res["A_overnight"] = {src: summary_rows(overnight_trades(G[src])) for src in ("cfd", "mnq")}
    # B: the ORB, and its equality with round 7's F1 on the MNQ file
    orb = {src: orb_trades(G[src]) for src in ("cfd", "spx", "mnq")}
    res["B_orb"] = {src: dict(**summary_rows([(d, R) for d, s, u, R in rows]),
                              usd_by_year=by_year([(d, u) for d, s, u, R in rows]))
                    for src, rows in orb.items()}
    for src, a, b in (("cfd", "2011-01-01", "2020-12-31"), ("spx", "2011-01-01", "2020-12-31"),
                      ("mnq", "2020-01-01", "2020-12-31"), ("mnq", "2021-01-01", "2026-12-31"), ("mnq", "2023-01-03", "2026-12-31")):
        res["B_orb"].setdefault("pooled", {})[f"{src} {a[:4]}-{b[:4]}" + (" (from Jan 3 2023)" if a == "2023-01-03" else "")] = \
            pooled([(d, R) for d, s, u, R in orb[src]], a, b)
    try:
        import r7_accounts as X
        X.init(dd_mnq, 0.0)
        legs = X.G["legs"]
        mine = {d: u for d, s, u, R in orb["mnq"]}
        theirs = {d: lg["F1"][0][4] for d, lg in legs.items() if lg["F1"] and not is_half(d)}
        common = sorted(set(mine) & set(theirs))
        same = sum(abs(mine[d] - theirs[d]) < 1e-6 for d in common)
        res["B_orb"]["check_vs_r7_F1"] = dict(here=len(mine), r7=len(theirs), common=len(common), identical=same)
    except Exception as e:  # the check needs research7's data files
        res["B_orb"]["check_vs_r7_F1"] = f"not run: {e}"
    # r7_accounts.init swaps research4's account classes for round 7's: put the published ones back
    R4.FundedAccount, R4.EvalAccount = ACC.FundedAccount, ACC.EvalAccount
    # C: funded accounts alone
    jobs = payout_jobs("cfd", "2011-01-01", "2020-12-31") + payout_jobs("cfd", "2011-01-01", "2015-12-31") + \
        payout_jobs("cfd", "2016-01-01", "2020-12-31") + payout_jobs("mnq", "2021-01-01", "2026-11-20") + \
        payout_jobs("mnq", "2024-01-01", "2026-11-20")
    with get_context("fork").Pool(4) as p:
        got = p.map(payout_job, jobs, chunksize=8)
    C = {}
    for (src, rule, legs, k0, kb, ka), npay in got:   # one group per window (start and end), rule and legs
        C.setdefault((src, ka, kb, rule, legs), []).append((k0, npay))
    res["C_funded_alone"] = {}
    for (src, ka, kb, rule, legs), xs in C.items():
        S = G[src]
        name = f"{src} {iso(S, ka)} to {iso(S, kb - 1)} | {rule} | {'book' if legs == BOOK else 'no overnight'}"
        n = np.array([v for _, v in xs])
        res["C_funded_alone"][name] = dict(accounts=len(n), reach_payout_pct=round(100 * float((n > 0).mean()), 1),
                                           payouts_per_account=round(float(n.mean()), 2))
    # D: Topstep 50K pool
    S = G["mnq"]
    jobs = [("mnq", legs, T.start_k(S, "5y", o), "5y") for legs in (BOOK, NO_ON) for o in R4.OFFSETS]
    jobs += [("mnq", legs, T.start_k(S, "all", o), "early") for legs in (BOOK, NO_ON) for o in R4.OFFSETS]
    jobs += [("mnq", legs, k0, "years") for legs in (BOOK, NO_ON) for k0 in monthly_starts(S, "2019-12", "2023-11")]
    jobs += [("cfd", legs, T.start_k(G["cfd"], "all", o), "cfd") for legs in (BOOK, NO_ON) for o in R4.OFFSETS]
    with get_context("fork").Pool(4) as p:
        got = p.map(pool_job, jobs, chunksize=2)
    D = {}
    for (src, legs, k0, tag), v in got:
        D.setdefault((tag, legs), []).append(v)
    res["D_topstep50_pool"] = {}
    for (tag, legs), vs in D.items():
        nm = f"{tag} | {'book' if legs == BOOK else 'no overnight in XFAs'}"
        if tag == "years":
            arr = np.array(vs)
            res["D_topstep50_pool"][nm] = dict(starts=len(vs), year1=round(float(arr[:, 0].mean())),
                                               year2=round(float(arr[:, 1].mean())), year3=round(float(arr[:, 2].mean())))
        else:
            res["D_topstep50_pool"][nm] = dict(net_per_year=round(float(np.mean([v["M"] for v in vs]))),
                                               worst_full_year=round(float(np.mean([v["W"] for v in vs]))),
                                               xfa_share_with_payout_pct=round(100 * float(np.mean([v["funded_paid_share"] for v in vs])), 1))
    p5 = res["D_topstep50_pool"]
    assert p5["5y | book"]["net_per_year"] == 73075, p5["5y | book"]   # the published Topstep 50K figure
    dM = p5["5y | no overnight in XFAs"]["net_per_year"] - p5["5y | book"]["net_per_year"]
    dW = p5["5y | no overnight in XFAs"]["worst_full_year"] - p5["5y | book"]["worst_full_year"]
    dMe = p5["early | no overnight in XFAs"]["net_per_year"] - p5["early | book"]["net_per_year"]
    dWe = p5["early | no overnight in XFAs"]["worst_full_year"] - p5["early | book"]["worst_full_year"]
    b = BANDS_TOPSTEP50
    ok = ((dM > b["net_5y"] and dW > -b["worst_5y"]) or (dW > b["worst_5y"] and dM > -b["net_5y"])) and \
        dMe > -b["net_early"] and dWe > -b["worst_early"]
    res["D_rule_5y"] = dict(change_net_5y=dM, change_worst_5y=dW, change_net_early=dMe, change_worst_early=dWe,
                            bands=b, verdict="PASS" if ok else "fail")
    conv = lambda o: o.item() if hasattr(o, "item") else str(o)   # numpy scalars
    print(json.dumps(res, indent=1, default=conv), flush=True)
    json.dump(res, open(os.path.join(out, "proposals.json"), "w"), indent=1, default=conv)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
