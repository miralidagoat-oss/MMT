#!/usr/bin/env python3
"""Your plan: which way of running and growing the accounts makes the most for its risk, when is a $15,000 car
comfortably affordable, and how to start with only $500 to $1,000.

usage: plan_search.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR [--budget-only]
Every payout stays in the business: 90% of it in, every fee out, 30% of each payout to you set aside for tax (an
assumption) and never counted. "Spare cash" = business cash - the tax set-aside (- the car, once bought).

Accounts (one pool per firm: up to N funded, `total` accounts in all, at most one new evaluation a session; a passed
evaluation waits for a free funded slot and becomes a funded account of its own size; research4.sim_pool's order):
  Topstep 50K / 100K / 150K with Standard payouts (topstep_sim.ek / fk), on the No Activation Fee path ($95 / $149 / $229
  a Combine when bought and every 30 days it stays open) or the Standard fee path ($49 / $99 / $199 a month, $149 when an
  XFA starts). Lucid at the user's prices (account.USER_EVAL / USER_ADDON, Nov 23 2026): 25K or 50K with the add-on
  ($60.30 / $98.20 an eval) or the 40% rule ($50.30 / $88.20), and 150K with the 40% rule ($226.10, assumed: not
  confirmed); Lucid funded accounts are closed after their 4th payout.
  The range rule ("RANGE:big:small[:points]"): a new Topstep Combine is 150K only while NQ's 14-day range is at least 151
  points, the range above which a 150K XFA's 10-micro leg cap no longer binds; otherwise 50K.
Plans: a start setup, then steps taken the first session the spare cash reaches each step's threshold. The thresholds
of rounds 1 and 2 are reserves: each setup's deepest fall since Dec 20 2019 on the MNQ file (5 funded + 5 evaluations,
the worst of 12 start dates, computed here), rounded up to $1,000.
  round 1  17 plans: sizes, firms, fee paths, reserve sizes, the range rule, the order of the steps
  round 2  14 plans around round 1's plan B (Lucid, then 150K by range, at the reserves): when to add Lucid and switch to
           150K, Lucid's rule, 7 Combines in reserve, Lucid 150K by range, the range rule at 125 / 175 / 200 points, the
           range rule from the first day
  car      7 ways to fit a $15,000 car (bought when the spare cash reaches the threshold; scaling may wait for it), and
           your first ladder: 1 XFA + 1 Combine, 2 + 2 at the first payout, 5 + 5 at $11k, Lucid at $22k, both firms to
           150K at $46k, the car at $61k
  final    the plan ("FINAL"): Topstep 50K 5+5, Lucid 50K with the add-on at Lucid 50K's reserve, Topstep 150K by the
           range rule at Topstep 150K's reserve, the car at both reserves plus its price (on the MNQ file with the S&P input
           filled, Nov 24 2026: $12k, $25k, $52k). Its steps follow the reserves, so a price or data change moves them.
  budget   the final plan started with only $500 or $1,000 and never more: a Combine is bought only while the spare
           cash covers its price, one more month of every open Combine and, on the Standard fee path, the $149
           activation; a passed Combine on that path starts its XFA once the $149 is there. On the No Activation Fee
           path and on the Standard fee path, from the first session of every month and, for the odds of running out,
           from every 5th session (24 months each). Ways in: Topstep 5+5 at once on either fee path, one Topstep Combine
           at a time until the first payout, or one Lucid 25K or 50K eval at a time (a one-off price; the 40% rule or
           the add-on) until the first payout.
           A start "runs out" when nothing is trading and the spare cash pays for neither a new evaluation nor the
           activation of a passed one.
Start dates: the first session of every month, Dec 2019 - Nov 2023 on the user's MNQ file (and, with a CFD_DATA_DIR, as
before Nov 23 2026, Mar 2011 - Nov 2023 on the Nasdaq-100 CFD): every run has at least 36 months.
Checks: the pool code equals research4.sim_pool with topstep_sim.cash_flows (both fee paths) or a flat eval price,
session by session, for every account type and two reserve sizes; the deepest falls of Topstep 50K / 150K and Lucid
25K / 50K / 150K equal those of topstep_sim.py's and scale_sizes.py's runs (results_topstep/topstep.csv,
results_scale_sizes/sizes.csv).
Writes reserves.json, runs.csv (every monthly-start run), round1.csv, round2.csv, car.csv, final_steps.csv, budget.csv,
budget_monthly_runs.csv and budget_runs.csv (--budget-only rewrites only the last three).
"""
import csv
import functools
import json
import math
import os
import sys
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account  # noqa: E402
import engine  # noqa: E402
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402
from account import USER_ADDON, USER_EVAL, EvalAccount, FundedAccount  # noqa: E402
import windows as W  # noqa: E402

account.funded_on = functools.lru_cache(maxsize=None)(engine.funded_on)
account.pyramid = functools.lru_cache(maxsize=None)(engine.pyramid)
account.ib_breakout = functools.lru_cache(maxsize=None)(engine.ib_breakout)

SPLIT, TAX, CAR = 0.9, 0.30, 15000.0
FUT_FIRST = W.FIRST[:7]  # the first month of futures starts: the MNQ file's first tradable session (Dec 2019)
RANGE_150 = 151.0
REF_SKIP = set()  # account types whose deepest falls are not checked against the book's published tables (plan_v27.py)
CFG = {}
for _s in (50, 100, 150):
    CFG[f"T{_s}n"] = dict(ek=T.ek(_s), fk=T.fk(_s, "standard"), monthly=T.PRICE["noact"][_s], flat=0.0, act=T.ACTIVATION["noact"])
    CFG[f"T{_s}s"] = dict(ek=T.ek(_s), fk=T.fk(_s, "standard"), monthly=T.PRICE["standard"][_s], flat=0.0, act=T.ACTIVATION["standard"])
for _s in (25, 50):  # Lucid at the user's prices: the add-on ("a") or the 40% rule ("f")
    CFG[f"L{_s}a"] = dict(ek=dict(R4.E_KW, size=_s, cons=0.5), fk=dict(R4.F_KW, size=_s, max_pay=4), monthly=0.0,
                          flat=USER_EVAL[_s] + USER_ADDON, act=0.0)
    CFG[f"L{_s}f"] = dict(ek=dict(R4.E_KW, size=_s), fk=dict(R4.F_KW, size=_s, max_pay=4), monthly=0.0, flat=USER_EVAL[_s], act=0.0)
CFG["L150f"] = dict(ek=dict(R4.E_KW, size=150), fk=dict(R4.F_KW, size=150, max_pay=4), monthly=0.0, flat=USER_EVAL[150], act=0.0)
_S = {}


class Pool:
    """One firm's accounts. Each session: fund the waiting passes, buy at most one evaluation, step the funded accounts,
    step the evaluations. Cash: 90% of payouts in; prices out (Topstep: when bought and on the first session 30, 60, ...
    days later while open, and the activation fee when an XFA starts on the Standard fee path; Lucid: once, when bought).
    With a wallet (a one-item list holding the spare cash, kept current by the caller and by this step), purchases and
    activations wait until the spare cash covers them (the budget rule)."""

    def __init__(self, S, cfg, N, total=None):
        self.S, self.cfg, self.N = S, cfg, N
        self.total = 2 * N if total is None else total
        self.funded, self.evals, self.ready = [], [], []
        self.bought = {}

    def pick(self, d):
        if not self.cfg.startswith("RANGE:"):
            return self.cfg
        parts = self.cfg.split(":")
        thr = float(parts[3]) if len(parts) > 3 else RANGE_150
        adr = self.S.S[d]["adr"]
        return parts[1] if (not np.isnan(adr) and adr >= thr) else parts[2]

    def affordable(self, c, wallet):
        """The budget rule: the price, one more month of every open Combine and, on the Standard fee path, $149 kept for
        the activation."""
        need = CFG[c]["flat"] + CFG[c]["monthly"] + CFG[c]["act"] + sum(CFG[e[1]]["monthly"] for e in self.evals)
        return wallet[0] >= need

    def step(self, k, wallet=None):
        S, d = self.S, self.S.days[k]
        cash = pay = 0.0

        def spend(x):
            nonlocal cash
            cash -= x
            if wallet is not None:
                wallet[0] -= x
        while self.ready and len(self.funded) < self.N:
            c = self.ready[0]
            if wallet is not None and wallet[0] < CFG[c]["act"]:
                break
            self.ready.pop(0)
            self.funded.append(FundedAccount(S, **CFG[c]["fk"]))
            spend(CFG[c]["act"])
        if self.N and len(self.funded) + len(self.evals) + len(self.ready) < self.total:
            c = self.pick(d)
            if wallet is None or self.affordable(c, wallet):
                self.bought[c] = self.bought.get(c, 0) + 1
                self.evals.append([EvalAccount(S, **CFG[c]["ek"]), c, int(d), 1])
                spend(CFG[c]["flat"] + CFG[c]["monthly"])
        keep = []
        for f in self.funded:
            evn, amt = f.step(d)
            if amt > 0:
                cash += SPLIT * amt
                pay += SPLIT * amt
                if wallet is not None:
                    wallet[0] += SPLIT * amt * (1 - TAX)
            if evn is None:
                keep.append(f)
        self.funded = keep
        keep = []
        for item in self.evals:
            e, c, d0, n = item
            m = CFG[c]["monthly"]
            while m and int(d) >= d0 + 30 * n:
                spend(m)
                n += 1
            item[3] = n
            res = e.step(d)
            if res == "pass":
                self.ready.append(c)
            elif res is None:
                keep.append(item)
        self.evals = keep
        return cash, pay

    def empty(self):
        return not (self.funded or self.evals or self.ready)


def ref_cash(S, k0, k1, cfg, N, total):
    ev = R4.sim_pool(S, N, total, k0, k1, CFG[cfg]["ek"], CFG[cfg]["fk"])
    if cfg.startswith("T"):
        return T.cash_flows(S, k0, ev, "noact" if cfg.endswith("n") else "standard", int(cfg[1:-1]))[: k1 - k0]
    ref = np.zeros(k1 - k0)
    for k, kind, _, v in ev:
        ref[k - k0] += SPLIT * v if kind == "payout" else (-CFG[cfg]["flat"] if kind == "buy" else 0.0)
    return ref


def check(S, k0):
    for cfg in CFG:
        for N, total in ((5, 10), (3, 4)):
            k1 = min(len(S.days), k0 + 400)
            p = Pool(S, cfg, N, total)
            mine = np.array([p.step(k)[0] for k in range(k0, k1)])
            ref = ref_cash(S, k0, k1, cfg, N, total)
            assert np.allclose(mine, ref, atol=1e-6), (cfg, N, total, np.flatnonzero(~np.isclose(mine, ref))[:5])
    print(f"check passed: pool cash = research4.sim_pool + topstep_sim.cash_flows (both fee paths) / Lucid's flat price, "
          f"{len(CFG)} account types x 2 reserve sizes", flush=True)


def drop_job(args):
    cfg, off = args
    S = _S["S"]
    k0 = T.first_tradable(S) + off
    p = Pool(S, cfg, 5, 10)
    run = np.cumsum([p.step(k)[0] for k in range(k0, len(S.days))])
    return cfg, off, float((run - np.maximum.accumulate(np.r_[0.0, run])[1:]).min())


# ---------------- plans: (name, label, steps); a step is (threshold, action) with None for the start; an action sets a
# firm's pool ("ts" Topstep, "lu" Lucid) to (N funded, accounts in all, account type) or buys the car ("car": price)
T5, LU50, T150R = {"ts": (5, 10, "T50n")}, {"lu": (5, 10, "L50a")}, {"ts": (5, 10, "RANGE:T150n:T50n")}


def round1(R):
    t150 = {"ts": (5, 10, "T150n")}
    return [("T50", "Topstep 50K 5+5 only", [(None, T5)]),
            ("T50s", "Topstep 50K 5+5 only, Standard fee path", [(None, {"ts": (5, 10, "T50s")})]),
            ("T50r3", "Topstep 50K, 5 XFAs + 3 Combines", [(None, {"ts": (5, 8, "T50n")})]),
            ("T50r7", "Topstep 50K, 5 XFAs + 7 Combines", [(None, {"ts": (5, 12, "T50n")})]),
            ("T50+L50", "Topstep 50K, then Lucid 50K add-on", [(None, T5), (R["T50n"] + R["L50a"], LU50)]),
            ("T50+L50f", "Topstep 50K, then Lucid 50K 40% rule", [(None, T5), (R["T50n"] + R["L50f"], {"lu": (5, 10, "L50f")})]),
            ("T50+L50>T150", "Topstep 50K, Lucid 50K, then Topstep 150K", [(None, T5), (R["T50n"] + R["L50a"], LU50), (R["T150n"] + R["L50a"], t150)]),
            ("T50+L50>T150r", "Topstep 50K, Lucid 50K, then Topstep 150K by the range rule", [(None, T5), (R["T50n"] + R["L50a"], LU50), (R["T150n"] + R["L50a"], T150R)]),
            ("T50+L50>both150", "Topstep 50K, Lucid 50K, then both firms 150K", [(None, T5), (R["T50n"] + R["L50a"], LU50),
                                                                 (R["T150n"] + R["L150f"], {"ts": (5, 10, "T150n"), "lu": (5, 10, "L150f")})]),
            ("T50>T150", "Topstep 50K, then Topstep 150K, no Lucid", [(None, T5), (R["T150n"], t150)]),
            ("T50>T150r", "Topstep 50K, then 150K by the range rule, no Lucid", [(None, T5), (R["T150n"], T150R)]),
            ("T50>T150>L50", "Topstep 50K, then 150K, then Lucid 50K", [(None, T5), (R["T150n"], t150), (R["T150n"] + R["L50a"], LU50)]),
            ("T50>T150r>L50", "Topstep 50K, 150K by range, then Lucid 50K", [(None, T5), (R["T150n"], T150R), (R["T150n"] + R["L50a"], LU50)]),
            ("T150", "Topstep 150K 5+5 from day one", [(None, t150)]),
            ("T150+L50", "Topstep 150K from day one, then Lucid 50K", [(None, t150), (R["T150n"] + R["L50a"], LU50)]),
            ("T50+L50>T150 half", "Topstep 50K, Lucid 50K, then Topstep 150K, half the reserves", [(None, T5), ((R["T50n"] + R["L50a"]) / 2, LU50),
                                                                        ((R["T150n"] + R["L50a"]) / 2, t150)]),
            ("T50>T150r>L50 half", "Topstep 50K, 150K by range, then Lucid 50K, half the reserves", [(None, T5), (R["T150n"] / 2, T150R), ((R["T150n"] + R["L50a"]) / 2, LU50)])]


def round2(R):
    tr = lambda thr=None: {"ts": (5, 10, "RANGE:T150n:T50n" + (f":{thr}" if thr else ""))}  # noqa: E731
    base, up = R["T50n"] + R["L50a"], R["T150n"] + R["L50a"]
    P = [("A T50+L50", f"Topstep 50K, Lucid 50K at {kusd(base)} (round 1)", [(None, T5), (base, LU50)]),
         ("B base", f"Topstep 50K, Lucid at {kusd(base)}, Topstep 150K by range at {kusd(up)} (round 1)", [(None, T5), (base, LU50), (up, tr())])]
    for lu_at, up_at in ((11000.0, 23000.0), (11000.0, 35000.0), (22000.0, 22000.0), (16500.0, 17500.0), (0.0, 0.0)):
        P.append((f"C L{int(lu_at / 1000)}k T{int(up_at / 1000)}k", f"Lucid at ${lu_at:,.0f}, Topstep 150K by range at ${up_at:,.0f}",
                  [(None, T5), (lu_at, LU50), (up_at, tr())]))
    P += [("D 40% rule", "Plan B with Lucid's 40% rule", [(None, T5), (R["T50n"] + R["L50f"], {"lu": (5, 10, "L50f")}), (R["T150n"] + R["L50f"], tr())]),
          ("E 7 Combines", "Plan B with 7 Combines behind the XFAs", [(None, {"ts": (5, 12, "T50n")}), (base, LU50),
                                                                    (up, {"ts": (5, 12, "RANGE:T150n:T50n")})]),
          ("F both by range", "Plan B, then Lucid 150K by range too", [(None, T5), (base, LU50), (up, tr()),
                                                                     (R["T150n"] + R["L150f"], {"lu": (5, 10, "RANGE:L150f:L50a")})])]
    for thr in (125, 175, 200):
        P.append((f"G range {thr}", f"Plan B with the range rule at {thr} points", [(None, T5), (base, LU50), (up, tr(thr))]))
    P.append(("H range from day 1", f"Topstep by range from the start (150K when the range is 151+), Lucid at {kusd(base)}",
              [(None, T150R), (base, LU50)]))
    return P


def kusd(x):
    return f"${x / 1000:g}k"


def final_at(R):
    """The final plan's thresholds: Lucid 50K (add-on) at its reserve, Topstep 150K by range at its reserve, and the car
    once the spare cash covers both reserves plus the car."""
    return R["L50a"], R["T150n"], R["L50a"] + R["T150n"] + CAR


def car_plans(R):
    car = {"car": CAR}
    lu, up, at = final_at(R)
    L, U = kusd(lu), kusd(up)
    return [("PREV start5_50 car@26k", "Topstep 5+5, car at $26k, then Lucid at $22k", [(None, T5), (26000.0, car), (22000.0, LU50)]),
            ("FINAL", f"Lucid {L}, 150K by range {U}, car at {kusd(at)}", [(None, T5), (lu, LU50), (up, T150R), (at, car)]),
            ("car last @45k", f"Lucid {L}, 150K by range {U}, car at $45k", [(None, T5), (lu, LU50), (up, T150R), (45000.0, car)]),
            ("car last @40k", f"Lucid {L}, 150K by range {U}, car at $40k", [(None, T5), (lu, LU50), (up, T150R), (40000.0, car)]),
            ("car mid @37k", f"Lucid {L}, car at $37k, then 150K by range at {U}", [(None, T5), (lu, LU50), (37000.0, car), (up, T150R)]),
            ("car first @37k", f"car at $37k, then Lucid {L}, 150K by range {U}", [(None, T5), (37000.0, car), (lu, LU50), (up, T150R)]),
            ("car first @30k", f"car at $30k, then Lucid {L}, 150K by range {U}", [(None, T5), (30000.0, car), (lu, LU50), (up, T150R)])]


def ladder_plans():
    """Your first ladder (Nov 20): 1 XFA + 1 Combine, 2 + 2 at the first payout, Topstep 5 + 5 at $11k, Lucid 5 + 5 at $22k,
    both firms to 150K (always) at $46k, the $15,000 car at $46k + $15k."""
    return [("LADDER start small", "1+1, 2+2 at the first payout, 5+5 at $11k, Lucid at $22k, both 150K at $46k, car at $61k",
             [(None, {"ts": (1, 2, "T50n")}), ("payout", {"ts": (2, 4, "T50n")}), (11000.0, T5), (22000.0, LU50),
              (46000.0, {"ts": (5, 10, "T150n"), "lu": (5, 10, "L150f")}), (61000.0, {"car": CAR})])]


def budget_plans(R):
    """The final plan started with only $500 or $1,000: Topstep 5+5 at once on either fee path, Topstep one Combine at a
    time until the first payout, or Lucid 25K or 50K one eval at a time (a one-off price, no monthly renewal; the 40% rule
    or the add-on) until the first payout; from there the final plan's steps, as the budget rule allows."""
    car = {"car": CAR}
    lu, up, at = final_at(R)
    late = [(lu, LU50), (up, T150R), (at, car)]
    late_s = [(lu, LU50), (up, {"ts": (5, 10, "RANGE:T150n:T50s")}), (at, car)]
    out = []
    for b in (500, 1000):
        out += [(f"budget {b} noact", f"${b}: Topstep 50K 5+5 at once, No Activation Fee path", [(None, T5)] + late, float(b)),
                (f"budget {b} standard", f"${b}: Topstep 50K 5+5 at once, Standard fee path", [(None, {"ts": (5, 10, "T50s")})] + late_s, float(b)),
                (f"budget {b} noact 1x", f"${b}: one Topstep Combine at a time until the first payout, No Activation Fee path",
                 [(None, {"ts": (1, 1, "T50n")}), ("payout", T5)] + late, float(b)),
                (f"budget {b} standard 1x", f"${b}: one Topstep Combine at a time until the first payout, Standard fee path",
                 [(None, {"ts": (1, 1, "T50s")}), ("payout", {"ts": (5, 10, "T50s")})] + late_s, float(b)),
                (f"budget {b} lucid40 1x", f"${b}: one Lucid 50K eval at a time (${CFG['L50f']['flat']:.2f}, 40% rule) until the first payout, then Topstep",
                 [(None, {"lu": (1, 1, "L50f")}), ("payout", T5)] + late, float(b)),
                (f"budget {b} lucid50 1x", f"${b}: one Lucid 50K eval at a time (${CFG['L50a']['flat']:.2f}, add-on) until the first payout, then Topstep",
                 [(None, {"lu": (1, 1, "L50a")}), ("payout", T5)] + late, float(b)),
                (f"budget {b} lucid25k40 1x", f"${b}: one Lucid 25K eval at a time (${CFG['L25f']['flat']:.2f}, 40% rule) until the first payout, then Topstep",
                 [(None, {"lu": (1, 1, "L25f")}), ("payout", T5)] + late, float(b)),
                (f"budget {b} lucid25k50 1x", f"${b}: one Lucid 25K eval at a time (${CFG['L25a']['flat']:.2f}, add-on) until the first payout, then Topstep",
                 [(None, {"lu": (1, 1, "L25a")}), ("payout", T5)] + late, float(b))]
    return out


def run(args):
    name, steps, k0, budget, horizon = args
    S = _S["S"]
    pools = {"ts": Pool(S, "T50n", 0, 0), "lu": Pool(S, "L50a", 0, 0)}
    car = [0.0, None]
    wallet = [budget] if budget is not None else None  # the spare cash, for the budget rule

    def apply(act):
        for firm, v in act.items():
            if firm == "car":
                car[0] += v
                if wallet is not None:
                    wallet[0] -= v
                continue
            N, total, cfg = v
            pools[firm].N, pools[firm].total, pools[firm].cfg = N, total, cfg
    apply(steps[0][1])
    nxt, when = 1, {}
    cash = budget or 0.0
    tax = 0.0
    low = peak = drop = 0.0
    month_end = {}
    at = {12: None, 24: None, 36: None}  # the money made at exactly 12, 24 and 36 months (the last session before each)
    after_car = None
    first_pay = five_xfa = bust = None
    mo_of = lambda k: round(float((S.days[k] - S.days[k0]) / 30.44), 1)  # noqa: E731
    k_end = len(S.days) if horizon is None else min(len(S.days), int(np.searchsorted(S.days, S.days[k0] + horizon * 30.44)))
    for k in range(k0, k_end):
        paid_today = False
        for p in pools.values():
            c, pay = p.step(k, wallet)
            cash += c
            tax += TAX * pay
            paid_today = paid_today or pay > 0
        spare = cash - tax - car[0]
        if wallet is not None:
            assert abs(wallet[0] - spare) < 1e-6, (wallet[0], spare)
        if paid_today and first_pay is None:
            first_pay = mo_of(k)
        if five_xfa is None and len(pools["ts"].funded) >= 5:
            five_xfa = mo_of(k)
        low = min(low, spare)
        made = spare + car[0] - (budget or 0.0)  # the money the plan made (the car added back, the budget taken off)
        peak = max(peak, made)
        drop = min(drop, made - peak)
        mo = int((S.days[k] - S.days[k0]) // 30.44)
        month_end[mo] = made
        for m in at:
            if (S.days[k] - S.days[k0]) / 30.44 <= m:
                at[m] = made
        if car[0] and after_car is not None:
            after_car[0] = min(after_car[0], spare)
        if car[0] and after_car is None:
            after_car = [spare]
        if budget is not None and all(not p.funded and not p.evals for p in pools.values()):
            can_start = any(p.ready and wallet[0] >= CFG[p.ready[0]]["act"] for p in pools.values())
            can_buy = any(p.N and p.affordable(p.pick(S.days[k]), wallet) for p in pools.values())
            if not (can_start or can_buy):
                bust = mo_of(k)  # nothing trading, no money for a new evaluation or an activation: it cannot go on
                break
        if nxt < len(steps) and (first_pay is not None if steps[nxt][0] == "payout" else spare >= steps[nxt][0]):
            if "car" in steps[nxt][1]:
                car[1] = mo_of(k)
            apply(steps[nxt][1])
            when[nxt] = mo_of(k)
            nxt += 1
    ms = sorted(month_end)
    assert ms == list(range(len(ms))), ms[:5]
    series = np.array([month_end[m] for m in ms])
    snap = lambda m: float(at[m])  # noqa: E731
    w12 = float(min(series[i] - series[i - 12] for i in range(24, len(series)))) if len(series) > 24 else float("nan")
    return dict(plan=name, start=str(np.datetime64(int(S.days[k0]), "D")), own_money=-low, deepest_fall=drop,
                spare_12=snap(12), spare_24=snap(24), spare_36=snap(36), year3=snap(36) - snap(24), worst_12m_after_year1=w12,
                steps_taken=nxt - 1, **{f"step{i}_month": when.get(i, "") for i in (1, 2, 3)},
                car_month=car[1] if car[1] is not None else "", low_spare_after_car=round(after_car[0]) if after_car else "",
                first_payout_month=first_pay if first_pay is not None else "", five_xfa_month=five_xfa if five_xfa is not None else "",
                bust_month=bust if bust is not None else "", ts_150k_bought=pools["ts"].bought.get("T150n", 0))


def _init(kind, data):
    _S["S"] = T.load(kind, data)


def starts(S, first, last, every=None):
    if every:
        k0 = T.first_tradable(S)
        return [k for k in range(k0, len(S.days), every) if first <= str(np.datetime64(int(S.days[k]), "D"))[:7] <= last]
    months, ks = set(), []
    for k in range(T.first_tradable(S), len(S.days)):
        m = str(np.datetime64(int(S.days[k]), "D"))[:7]
        if first <= m <= last and m not in months:
            months.add(m)
            ks.append(k)
    return ks


def write(out, name, rows):
    with open(os.path.join(out, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {name}: {len(rows)} rows", flush=True)


KINDS = ["futures", "CFD"]  # main() keeps only "futures" when CFD_DATA_DIR is "-"


def summary(rows, P):
    out = []
    for n, lab, *_ in P:
        row = dict(plan=n, label=lab)
        for kind in KINDS:
            Rr = [r for r in rows if r["data"] == kind and r["plan"] == n]
            a = lambda key: np.array([r[key] for r in Rr], float)  # noqa: E731
            pre = "fut_" if kind == "futures" else "cfd_"
            row.update({pre + "own_money_worst": round(a("own_money").max()), pre + "own_money_median": round(float(np.median(a("own_money")))),
                        pre + "fall_worst": round(a("deepest_fall").min()), pre + "worst_12m": round(np.nanmin(a("worst_12m_after_year1"))),
                        pre + "spare36_median": round(float(np.median(a("spare_36")))), pre + "spare36_p10": round(float(np.percentile(a("spare_36"), 10))),
                        pre + "spare36_worst": round(a("spare_36").min()), pre + "year3_median": round(float(np.median(a("year3")))),
                        pre + "spare24_median": round(float(np.median(a("spare_24"))))})
            for key in ("car_month", "first_payout_month", "five_xfa_month"):
                v = [float(r[key]) for r in Rr if r[key] != ""]
                if v:
                    row.update({pre + key + "_median": round(float(np.median(v)), 1), pre + key + "_p90": round(float(np.percentile(v, 90)), 1),
                                pre + key + "_worst": round(max(v), 1)})
            lows = [float(r["low_spare_after_car"]) for r in Rr if r["low_spare_after_car"] != ""]
            if lows:
                row.update({pre + "low_after_car_worst": round(min(lows)), pre + "starts_below_0_after_car": sum(x < 0 for x in lows)})
        out.append(row)
    return out


def main(fd, dd, out, only=None):
    os.makedirs(out, exist_ok=True)
    Sf = T.load("fut", fd)
    _S["S"] = Sf
    if dd == "-":
        KINDS[:] = ["futures"]  # the user's MNQ file alone
        W.check(Sf)
    check(Sf, starts(Sf, FUT_FIRST, FUT_FIRST)[0])
    with get_context("fork").Pool(4, initializer=_init, initargs=("fut", fd)) as p:
        res = p.map(drop_job, [(c, o) for c in CFG for o in R4.OFFSETS], chunksize=3)
    worst = {c: min(d for cc, _, d in res if cc == c) for c in CFG}
    mean = {c: float(np.mean([d for cc, _, d in res if cc == c])) for c in CFG}
    here = os.path.dirname(os.path.abspath(__file__))
    ts = {r["id"]: float(r["deepest_drop_usd"]) for r in csv.DictReader(open(os.path.join(here, "results_topstep", "topstep.csv")))}
    lu = {r["id"]: float(r["deepest_drop_usd"]) for r in csv.DictReader(open(os.path.join(here, "results_scale_sizes", "sizes.csv")))}
    ref = {"T50n": ts["2019-50-standard-noact"], "T150n": ts["2019-150-standard-noact"], "L25a": lu["2019-25-addon"],
           "L25f": lu["2019-25-40"], "L50a": lu["2019-50-addon"], "L50f": lu["2019-50-40"], "L150f": lu["2019-150-40"]}
    for c, v in ref.items():  # the same deepest falls as topstep_sim.py's and scale_sizes.py's runs (same prices); their
        if c not in REF_SKIP:  # tables give the mean of the 12 starts, the reserve takes the worst
            assert round(mean[c]) == v, (c, mean[c], v)
    R = {c: 1000.0 * math.ceil(-v / 1000.0) for c, v in worst.items()}
    json.dump({"deepest_fall_since_first_start": worst, "reserve": R}, open(os.path.join(out, "reserves.json"), "w"), indent=1)
    print("reserves:", {c: int(v) for c, v in R.items()}, flush=True)
    groups = {} if only == "--budget-only" else {"round1": round1(R), "round2": round2(R), "car": car_plans(R) + ladder_plans()}
    B = budget_plans(R)
    rows, brows = [], []
    for kind, data, first, last in (("futures", fd, FUT_FIRST, "2023-11"), ("CFD", dd, "2011-03", "2023-11"))[:len(KINDS)]:
        S = Sf if kind == "futures" else T.load("cfd", data)
        ks = starts(S, first, last)
        assert all((S.days[-1] - S.days[k]) / 30.44 >= 36 for k in ks)
        jobs = [(n, st, k, None, None) for P in groups.values() for n, _, st in P for k in ks]
        jobs += [(n, st, k, b, None) for n, _, st, b in B for k in ks]
        wk = starts(S, first, last, every=5)
        jobs_b = [(n, st, k, b, 24) for n, _, st, b in B for k in wk]
        with get_context("fork").Pool(4, initializer=_init, initargs=("fut" if kind == "futures" else "cfd", data)) as p:
            for r in p.map(run, jobs, chunksize=4):
                rows.append(dict(data=kind, **r))
            for r in p.map(run, jobs_b, chunksize=8):
                brows.append(dict(data=kind, **r))
        print(f"{kind}: {len(ks)} monthly starts, {len(wk)} starts every 5 sessions", flush=True)
    if groups:
        write(out, "runs.csv", [r for r in rows if not r["plan"].startswith("budget")])
    for g, P in groups.items():
        write(out, f"{g}.csv", summary(rows, P))
    bsum = summary(rows, B)
    for row, (n, _, _, b) in zip(bsum, B):
        for kind in KINDS:
            Rb = [r for r in brows if r["data"] == kind and r["plan"] == n]
            pre = "fut_" if kind == "futures" else "cfd_"
            busts = [float(r["bust_month"]) for r in Rb if r["bust_month"] != ""]
            fp = [float(r["first_payout_month"]) for r in Rb if r["first_payout_month"] != ""]
            fx = [float(r["five_xfa_month"]) for r in Rb if r["five_xfa_month"] != ""]
            row.update({pre + "starts_24m": len(Rb), pre + "ran_out": len(busts), pre + "ran_out_pct": round(100.0 * len(busts) / len(Rb), 1),
                        pre + "ran_out_month_median": round(float(np.median(busts)), 1) if busts else "",
                        pre + "first_payout_24m_median": round(float(np.median(fp)), 1) if fp else "",
                        pre + "no_payout_in_24m": len(Rb) - len(fp), pre + "five_xfa_24m_median": round(float(np.median(fx)), 1) if fx else "",
                        pre + "five_xfa_24m_p90": round(float(np.percentile(fx, 90)), 1) if fx else ""})
    write(out, "budget.csv", bsum)
    write(out, "budget_runs.csv", brows)
    write(out, "budget_monthly_runs.csv", [r for r in rows if r["plan"].startswith("budget")])
    if not groups:
        return
    fin = [r for r in rows if r["plan"] == "FINAL"]
    lu, up, at = final_at(R)
    steps = []
    for kind in KINDS:
        for key, lab in (("step1_month", f"Add Lucid 50K (spare cash ${lu:,.0f})"), ("step2_month", f"Topstep 150K by the range rule (${up:,.0f})"),
                         ("car_month", f"The ${CAR:,.0f} car (${at:,.0f})")):
            v = [float(r[key]) for r in fin if r["data"] == kind and r[key] != ""]
            steps.append(dict(data=kind, step=lab, starts=len([r for r in fin if r["data"] == kind]), reached=len(v),
                              p10_month=round(float(np.percentile(v, 10)), 1), median_month=round(float(np.median(v)), 1),
                              p90_month=round(float(np.percentile(v, 90)), 1), latest_month=round(max(v), 1)))
    write(out, "final_steps.csv", steps)


if __name__ == "__main__":
    main(*sys.argv[1:5])
