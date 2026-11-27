#!/usr/bin/env python3
"""Round 7's account test (PREREG_R7.md, "Account test" and its addendum 2): the four survivors of the screen with
the ONR book in the user's prop pools - Lucid 50K 5 funded + 5 evals (40% rule and add-on, each closed after its 4th
payout) and Topstep 50K 5 XFAs + 5 Combines (Standard payouts, No Activation Fee path) - 12 start dates each.

usage: python3 -I r7_accounts.py DATA_DIR OUT_DIR [--slip TICKS]      # every variant, every account, every window
       python3 -I r7_accounts.py book DATA_DIR OUT_DIR [--slip TICKS] # one funded account every session, per variant
       python3 -I r7_accounts.py years DATA_DIR OUT_DIR              # each year of the last 5 years, main variants
       python3 -I r7_accounts.py table OUT_DIR                        # accounts.csv with rule 5Y per account

Every leg is precomputed per contract in the engine's convention (fills at the event bar's close, no slippage, $1.00
a round turn) with its entry and exit times; the book's three are checked equal to engine.funded_on / pyramid /
ib_breakout session by session. The accounts are account.FundedAccount / EvalAccount with their leg blocks taking the
legs in entry order: a leg is taken if its risk fits the day's budget and no taken position is open on the other side.
With the book's legs alone this is asserted identical to the published account classes.
"""
import json
import math
import os
import sys
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account as A  # noqa: E402
import research4 as R4  # noqa: E402
import research7 as R7  # noqa: E402
import topstep_sim as T  # noqa: E402
import windows as W  # noqa: E402
from account import COMM_RT, USER_ADDON, USER_EVAL, eval_bracket, funded_size, is_half  # noqa: E402
from engine import PV, funded_on, ib_breakout, pyramid  # noqa: E402

G = {}   # per-process state: D, legs per session, slippage


# ------------------------------------------------------------------------------------------------ legs per contract
def _close_or_last(O, C, i, j):
    """Engine convention: the close of bar j, or of the last bar before it if bar j is missing."""
    for q in range(j, -1, -1):
        if not np.isnan(O[i, q]):
            return C[i, q], q
    return np.nan, -1


def precompute(D, P, slip):
    """{session day: {...}} with per-contract $ results (commission and `slip` points a fill included) and timing keys
    (slot + 0.5 inside a bar, + 0.9 at its close)."""
    S = D.S
    O, H, L, C = D.O, D.H, D.L, D.C
    out = {}
    m_ = R7._manage
    for i, d in enumerate(D.days):
        d = int(d)
        if d not in S.S:
            continue
        A_ = D.adr[i]
        rec = dict(i=i, on={}, pyr=None, ib=None, F1=[], F3=[], F8=[], F9=[], ev_F1=None, ev_F8=None, ev_F9=None)
        out[d] = rec
        if np.isnan(A_):
            continue
        # the book's overnight leg, both sides (a placebo threshold can choose either)
        for sd in (1, -1):
            if "on" in S.S[d]:
                rec["on"][sd] = funded_on(S, d, sd, slip, 0.5, n=1, comm=COMM_RT)[0]
        # the pyramid with its exit time (k_book_pyr's engine mode, checked against engine.pyramid)
        sd = int(D.od_side[i])
        if sd != 0:
            pnl = pyramid(S, d, sd, slip, n=1, comm=COMM_RT, fix_gap=True)[0]
            xk = _pyr_exit_key(O, H, L, C, i, sd, A_)
            rec["pyr"] = (186.9, "pyr", sd, 0.35 * A_ * PV, pnl, xk)
        # the IB with its fill and exit times
        if "ib" in S.S[d]:
            res = ib_breakout(S, d, slip, n=1, comm=COMM_RT, only_side=sd)
            if res is not None and res[1] != "both-skip":
                ib = S.S[d]["ib"]
                buy, sell = ib["H"] + 0.25, ib["L"] - 0.25
                s_, j, px = R7._stop_entry(O, H, L, i, buy if sd >= 0 else np.nan, sell if sd <= 0 else np.nan, 198, 227)
                assert s_ == res[2], (d, s_, res)
                if res[1] == "stop-fillbar":
                    xk = j + 0.5
                else:
                    stop, tgt = px - s_ * 0.25 * A_, px + s_ * 0.5 * A_
                    ex, why, jj = m_(O, H, L, C, i, s_, px, stop, tgt, j, 264, 1, 1)
                    xk = jj + 0.5 if why in (1, 2) else 263.9
                rec["ib"] = (j + 0.5, "ib", s_, 0.25 * A_ * PV, res[0], xk)
        # F1: ORB, the first 5 minutes' direction, stop 0.10 ADR, target 10R, |move| >= 0.05 ADR (entry at 09:35's close)
        if np.isfinite(O[i, 186]) and np.isfinite(C[i, 186]):
            mv = C[i, 186] - O[i, 186]
            if mv != 0 and abs(mv) >= 0.05 * A_:
                s_ = 1 if mv > 0 else -1
                E0 = C[i, 186] + s_ * slip
                dist = 0.10 * A_
                ex, why, jj = m_(O, H, L, C, i, s_, E0, E0 - s_ * dist, E0 + s_ * 10 * dist, 187, 264, 2, 1)
                ex = ex - s_ * slip if why != 2 else ex
                rec["F1"] = [(186.95, "F1", s_, dist * PV, (ex - E0) * s_ * PV - COMM_RT, jj + 0.5 if why in (1, 2) else 263.9)]
                rec["ev_F1"] = (s_, C[i, 186], 187, 2)
        # F8: stop orders at the open +/- 0.2 x Crabel's stretch, 09:35-12:55 bars, stop 0.25 ADR
        X = P.f8x["stretch"][i]
        op = O[i, 186]
        if np.isfinite(X) and np.isfinite(op):
            buy = math.ceil((op + 0.2 * X) / 0.25) * 0.25
            sell = math.floor((op - 0.2 * X) / 0.25) * 0.25
            s_, j, px = R7._stop_entry(O, H, L, i, buy, sell, 187, 227)
            if s_ != 0:
                E0 = px + s_ * slip
                dist = 0.25 * A_
                ex, why, jj = m_(O, H, L, C, i, s_, E0, E0 - s_ * dist, np.nan, j, 264, 1, 1)
                ex = ex - s_ * slip
                rec["F8"] = [(j + 0.5, "F8", s_, dist * PV, (ex - E0) * s_ * PV - COMM_RT, jj + 0.5 if why == 1 else 263.9)]
                rec["ev_F8"] = (s_, px, j, 1)
        # F9: Mondays long 09:30 -> 16:00, no stop (risk counted as 0.5 ADR)
        if D.monday[i] and np.isfinite(C[i, 185]):
            E0 = C[i, 185] + slip
            ex, why, jj = m_(O, H, L, C, i, 1, E0, np.nan, np.nan, 186, 264, 2, 1)
            rec["F9"] = [(185.9, "F9", 1, 0.5 * A_ * PV, (ex - slip - E0) * PV - COMM_RT, 263.9)]
            if np.isfinite(C[i, 186]):
                rec["ev_F9"] = (1, C[i, 186], 187, 2)
        # F3: the noise area (n 21, m 1.5, 30-minute checks, gap-adjusted, flips) as segments, fills at the check's close
        rec["F3"] = _f3_segments(D, P, i, slip)
    return out


def _pyr_exit_key(O, H, L, C, i, s, A_):
    E1 = C[i, 186]
    stp = E1 - s * 0.35 * A_
    best = E1
    n_ent = 1
    for j in range(187, 264):
        if np.isnan(O[i, j]):
            continue
        if (s == 1 and L[i, j] <= stp) or (s == -1 and H[i, j] >= stp):
            return j + 0.5
        fav = H[i, j] if s == 1 else L[i, j]
        if (fav - best) * s > 0:
            best = fav
        if n_ent == 1 and (best - E1) * s >= 0.15 * A_:
            n_ent = 2
            if (E1 - stp) * s > 0:
                stp = E1
        ts = best - s * 0.25 * A_
        if (ts - stp) * s > 0:
            stp = ts
    return 263.9


def _f3_segments(D, P, i, slip):
    O, C = D.O, D.C
    A_ = D.adr[i]
    up, dn = P.up_gap[i], P.dn_gap[i]
    sig = P.sig[21]
    if np.isnan(up) or np.isnan(A_):
        return []
    segs = []
    pos, E0, k0 = 0, 0.0, 0.0
    for q in range(12):
        j = 191 + 6 * q
        if np.isnan(C[i, j]) or np.isnan(sig[i, j]):
            continue
        c = C[i, j]
        ub = up * (1 + 1.5 * sig[i, j])
        lb = dn * (1 - 1.5 * sig[i, j])
        want = pos
        if pos == 0:
            want = 1 if c > ub else (-1 if c < lb else 0)
        elif pos == 1 and c < lb:
            want = -1
        elif pos == -1 and c > ub:
            want = 1
        if want != pos:
            if pos != 0:
                ex = c - pos * slip
                segs.append((k0, "F3", pos, 0.5 * A_ * PV, (ex - E0) * pos * PV - COMM_RT, j + 0.9))
            E0, k0 = c + want * slip, j + 0.9
            pos = want
    if pos != 0:
        ex, q = _close_or_last(O, C, i, 263)
        ex = ex - pos * slip
        segs.append((k0, "F3", pos, 0.5 * A_ * PV, (ex - E0) * pos * PV - COMM_RT, 263.9))
    return segs


# ------------------------------------------------------------------------------------------------ the accounts
class Funded7(A.FundedAccount):
    def __init__(self, S, r7legs=("on", "pyr", "ib"), **kw):
        super().__init__(S, **kw)
        self.r7legs = r7legs
        assert self.cushion_frac is None and self.add2 is None and self.record is None and self.ib_with_drive
        assert self.improved and self.adr_ref is not None

    def step(self, d):
        S, r = self.S, self.S.S[d]
        m = self.m
        if self.npay > 0:
            fl = self.lock_after_pay
        else:
            fl = self.lock if self.peak >= self.R["mll"] + self.lock else self.peak - self.R["mll"]
        cushion = self.pnl - fl
        if cushion < self.abandon * m:
            return "dead", 0.0
        room = min(self.day_budget * m, cushion - 10.0 * m)
        used = day = 0.0
        adr = r["adr"]
        half = self.improved and is_half(d)
        if not np.isnan(adr):
            n = funded_size(adr, self.adr_ref * m, nmax=self.R["fundmax"])
            lg = G["legs"][int(d)]
            if "on" in self.r7legs:
                side = S.on_side(d) if self.thr is None else S.on_side(d, self.thr)
                rk = self.on_stop * adr * PV * n
                if side != 0 and used + rk <= room and not (self.on_long_only and side < 0):
                    day += n * lg["on"][side]
                    used += rk
            items = []
            if "pyr" in self.r7legs and not half and lg["pyr"] is not None:
                items.append(lg["pyr"])
            if "ib" in self.r7legs and not half and lg["ib"] is not None:
                items.append(lg["ib"])
            for nm in ("F1", "F3", "F8", "F9"):
                if nm in self.r7legs and not half:
                    items += lg[nm]
            items.sort(key=lambda x: x[0])
            taken = []
            for key, nm, side, rk1, pnl1, xkey in items:
                rk = rk1 * n
                if used + rk > room:
                    continue
                if any(ts != side and tk <= key < tx for tk, ts, tx in taken):
                    continue
                day += n * pnl1
                used += rk
                taken.append((key, side, xkey))
        self.pnl += day
        if self.pnl <= fl:
            return "blown", 0.0
        self.peak = max(self.peak, self.pnl)
        if day >= self.R["qday"]:
            self.q += 1
        if day != 0.0:
            self.td += 1
            self.maxday = max(self.maxday, day)
        if self.pay_path == "days":
            ready = self.q >= 5
        else:
            cyc = self.pnl - self.after_pay
            ready = self.td >= self.pay_days and cyc > 0 and self.maxday <= self.pay_cons * cyc
        if ready and self.pnl >= 2 * self.pay_min and (not self.cycle_rule or self.pnl > self.after_pay):
            amt = min(self.R["paycap"], max(self.pay_min, 0.5 * self.pnl)) if self.payout_max else self.payout_amt
            self.pnl -= amt
            self.after_pay = self.pnl
            self.npay += 1
            self.q = self.td = 0
            self.maxday = 0.0
            return ("done" if self.npay >= self.max_pay else None), max(amt, 1e-9)
        return None, 0.0


class Eval7(A.EvalAccount):
    """The book's eval, plus (r7trigger) a survivor's trade on a session the book's two triggers left empty."""

    def __init__(self, S, r7trigger=None, **kw):
        super().__init__(S, **kw)
        self.r7trigger = r7trigger
        assert self.book_mult == 0 and not self.ib_fallback and self.side_override is None

    def step(self, d):
        if self.r7trigger is None:
            return super().step(d)
        S, r = self.S, self.S.S[d]
        if self.d0 is None:
            self.d0 = int(d)
        if self.max_days is not None and int(d) - self.d0 >= self.max_days:
            return "fail"
        fl = self.lock if self.peak >= self.R["mll"] + self.lock else self.peak - self.R["mll"]
        cushion = self.pnl - fl
        if cushion < 50.0 * self.m:
            return "dead"
        day, traded = self._book_triggers(d, cushion)
        adr = r["adr"]
        if not traded and not np.isnan(adr) and not (self.improved and is_half(d)):
            lg = G["legs"][int(d)]
            ev = lg["ev_" + self.r7trigger]
            if ev is not None and not (self.r7trigger == "F9" and S.od_side(d, self.od_k) != 0):
                side, E0, j0, emode = ev
                n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved,
                                         self.comm, self.size, self.risk_k, R=self.R, dll=self.dll)
                E = E0 + side * self.slip
                D = G["D"]
                px, why, jj = R7._manage(D.O, D.H, D.L, D.C, lg["i"], side, E, E - side * sd, E + side * td, j0, 264, emode, 1)
                if why != 2:
                    px -= side * self.slip
                day = (px - E) * side * n * PV - n * self.comm
                traded = True
        self.trades += traded
        self.pnl += day
        if traded:
            self.best = max(self.best, day)
        if self.pnl <= fl:
            return "fail"
        self.peak = max(self.peak, self.pnl)
        if self.pnl >= max(self.R["target"], self.best / self.pass_cons):
            return "pass"
        return None

    def _book_triggers(self, d, cushion):
        """account.EvalAccount.step's overnight and 09:35 triggers, unchanged."""
        from engine import bracket_exit, news_night
        S, r = self.S, self.S.S[d]
        adr = r["adr"]
        day, traded = 0.0, False
        if np.isnan(adr):
            return day, traded
        if "on" in self.legs:
            side = S.on_side(d) if self.thr is None else S.on_side(d, self.thr)
            if side != 0 and not (self.news and news_night(d)) and not (self.on_long_only and side < 0):
                n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved,
                                         self.comm, self.size, self.risk_k, R=self.R, dll=self.dll)
                E = r["on"]["E"] + side * self.slip
                px, _ = bracket_exit(r["on"]["w"], side, E, sd, td, self.slip)
                day = (px - E) * side * n * PV - n * self.comm
                traded = True
        if not traded and "od" in self.legs and not (self.improved and is_half(d)):
            side = S.od_side(d, self.od_k)
            if side != 0:
                n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved,
                                         self.comm, self.size, self.risk_k, R=self.R, dll=self.dll)
                E = r["od"]["E"] + side * self.slip
                px, _ = bracket_exit(r["od"]["w"], side, E, sd, td, self.slip)
                day = (px - E) * side * n * PV - n * self.comm
                traded = True
        return day, traded


# ------------------------------------------------------------------------------------------------ runs
ACCTS = ("lucid40", "lucid_addon", "topstep")
BOOK = ("on", "pyr", "ib")
VARIANTS = {
    "book": dict(),
    "+F1": dict(legs=BOOK + ("F1",)), "+F3": dict(legs=BOOK + ("F3",)), "+F8": dict(legs=BOOK + ("F8",)), "+F9": dict(legs=BOOK + ("F9",)),
    "eval+F1": dict(trigger="F1"), "eval+F8": dict(trigger="F8"), "eval+F9": dict(trigger="F9"),
    "on->F1": dict(legs=("F1", "pyr", "ib")), "on->F3": dict(legs=("F3", "pyr", "ib")), "on->F8": dict(legs=("F8", "pyr", "ib")),
    "on->F9": dict(legs=("F9", "pyr", "ib")), "ib->F3": dict(legs=("on", "pyr", "F3")), "ib->F8": dict(legs=("on", "pyr", "F8")),
    "ib->F9": dict(legs=("on", "pyr", "F9")), "pyr->F8": dict(legs=("on", "F8", "ib")),
    "placebo thr 0.712": dict(thr=0.712), "placebo thr 0.715": dict(thr=0.715), "placebo thr 0.722": dict(thr=0.722),
    "placebo thr 0.725": dict(thr=0.725), "placebo size 340": dict(adr_ref=340.0), "placebo size 345": dict(adr_ref=345.0),
    "placebo size 355": dict(adr_ref=355.0), "placebo size 360": dict(adr_ref=360.0),
}
WINDOWS = {
    "5y": ([("last 5y", W.START5, "2026-12-31")], {"last 5y": W.FULL_YEARS_5Y}),
    "all": ([("since Dec 2019", "2019-01-01", "2026-12-31"), ("early", "2019-01-01", "2021-11-14")],
            {"since Dec 2019": W.FULL_YEARS_ALL, "early": ["2020"]}),
    "oos": ([("oos", "2023-01-03", "2026-12-31")], {"oos": ["2023", "2024", "2025"]}),
}


def start_k(S, window, off):
    if window == "5y":
        return T.start_k(S, "5y", off)
    if window == "all":
        return T.start_k(S, "all", off)
    return int(np.searchsorted(S.days, np.datetime64("2023-01-03").astype(int))) + off


def kwargs(acct, v, slip):
    if acct == "topstep":
        ek, fk = T.ek(50), T.fk(50, "standard")
    else:
        ek = dict(R4.E_KW, cons=0.5) if acct == "lucid_addon" else dict(R4.E_KW)
        fk = dict(R4.F_KW, max_pay=4)
    ek, fk = dict(ek, slip=slip), dict(fk, slip=slip)
    if "thr" in v:
        ek["thr"] = fk["thr"] = v["thr"]
    if "adr_ref" in v:
        fk["adr_ref"] = v["adr_ref"]
    fk["r7legs"] = v.get("legs", BOOK)
    ek["r7trigger"] = v.get("trigger")
    return ek, fk


def job(a):
    vname, acct, window, off = a
    D = G["D"]
    S = D.S
    v = VARIANTS[vname]
    ek, fk = kwargs(acct, v, G["slip"])
    k0 = start_k(S, window, off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
    if acct == "topstep":
        cash = T.cash_flows(S, k0, ev, "noact", 50)
    else:
        cash = T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=USER_EVAL[50] + (USER_ADDON if acct == "lucid_addon" else 0.0))
    per, fy = WINDOWS[window]
    res = T.summarise_run(S, k0, cash, ev, per, fy)["periods"]
    return a, {lab: dict(M=res[lab]["M"], W=res[lab]["W"]) for lab, _, _ in per}


def init(dd, slip):
    D = R7.load(dd)
    P = R7.Inputs(D)
    G["D"], G["slip"] = D, slip
    G["legs"] = precompute(D, P, slip)
    R4.FundedAccount, R4.EvalAccount = Funded7, Eval7
    return D, P


def check_parity(D):
    """With the book's legs alone, Funded7 / Eval7 make exactly the published classes' events."""
    S = D.S
    for acct in ACCTS:
        ek, fk = kwargs(acct, {}, G["slip"])
        k0 = start_k(S, "5y", 0)
        mine = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
        ek0 = {k: v for k, v in ek.items() if k != "r7trigger"}
        fk0 = {k: v for k, v in fk.items() if k != "r7legs"}
        R4.FundedAccount, R4.EvalAccount = A.FundedAccount, A.EvalAccount
        ref = R4.sim_pool(S, 5, 10, k0, len(S.days), ek0, fk0)
        R4.FundedAccount, R4.EvalAccount = Funded7, Eval7
        assert len(mine) == len(ref) and all(a[:3] == b[:3] and abs(a[3] - b[3]) < 1e-6 for a, b in zip(mine, ref)), acct
        print(f"parity with the published account classes ({acct}): {len(ref)} events identical", flush=True)


def check_legs(D):
    """The precomputed per-contract legs at slip 0 equal the engine's (and research7's engine-mode kernels)."""
    S = D.S
    for i, d in enumerate(D.days):
        d = int(d)
        lg = G["legs"].get(d)
        if lg is None or np.isnan(D.adr[i]):
            continue
        if lg["pyr"] is not None:
            assert abs(lg["pyr"][4] - pyramid(S, d, int(D.od_side[i]), 0.0, n=1, comm=COMM_RT, fix_gap=True)[0]) < 1e-9
    print("per-contract legs checked", flush=True)


def main(dd, out, slip_ticks=0.0):
    slip = 0.25 * slip_ticks
    D, P = init(dd, slip)
    os.makedirs(out, exist_ok=True)
    if slip == 0.0:
        check_legs(D)
        check_parity(D)
    jobs = [(v, a, w, off) for v in VARIANTS for a in ACCTS for w in WINDOWS for off in R4.OFFSETS]
    if slip > 0:
        jobs = [j for j in jobs if not j[0].startswith("placebo")]
    with get_context("fork").Pool(4) as p:
        res = p.map(job, jobs, chunksize=4)
    agg = {}
    for (v, a, w, off), per in res:
        for lab, x in per.items():
            agg.setdefault((v, a, lab), []).append(x)
    tab = {}
    for (v, a, lab), xs in agg.items():
        tab.setdefault(v, {}).setdefault(a, {})[lab] = dict(M=float(np.mean([x["M"] for x in xs])), W=float(np.mean([x["W"] for x in xs])))
    tag = "" if slip == 0 else f"_slip{slip_ticks:g}"
    json.dump(tab, open(os.path.join(out, f"accounts{tag}.json"), "w"), indent=1)
    print("written", flush=True)
    return tab


def book_every_session(dd, out, slip_ticks=0.0):
    """One funded 50K account trading every session (day budget $1,200, no account rules, Lucid's 20-MNQ cap, size
    round(700 / ADR)) with each variant's legs: the change's own effect, without the pools' path noise."""
    import csv
    D, P = init(dd, 0.25 * slip_ticks)
    S = D.S
    rows = []
    m5, oos = D.iso >= W.START5, D.oos
    yrs_oos = D.oos.sum() / 252.0
    base = None
    for vn, v in VARIANTS.items():
        if vn.startswith("placebo") or "trigger" in v:
            continue
        legs = v.get("legs", BOOK)
        pnl = np.zeros(D.n)
        for i, d in enumerate(D.days):
            d = int(d)
            lg = G["legs"].get(d)
            adr = D.adr[i]
            if lg is None or np.isnan(adr):
                continue
            n = funded_size(adr, 700.0, nmax=20)
            room, used, day = 1200.0, 0.0, 0.0
            half = is_half(d)
            if "on" in legs:
                sd = S.on_side(d)
                if sd != 0 and used + 0.5 * adr * PV * n <= room:
                    day += n * lg["on"][sd]
                    used += 0.5 * adr * PV * n
            items = []
            if "pyr" in legs and not half and lg["pyr"] is not None:
                items.append(lg["pyr"])
            if "ib" in legs and not half and lg["ib"] is not None:
                items.append(lg["ib"])
            for nm in ("F1", "F3", "F8", "F9"):
                if nm in legs and not half:
                    items += lg[nm]
            items.sort(key=lambda x: x[0])
            taken = []
            for key, nm, side, rk1, p1, xk in items:
                if used + rk1 * n > room or any(ts != side and tk <= key < tx for tk, ts, tx in taken):
                    continue
                day += n * p1
                used += rk1 * n
                taken.append((key, side, xk))
            pnl[i] = day
        a5, ao = pnl[m5].sum() / 5.0, pnl[oos].sum() / yrs_oos
        if base is None:
            base = (a5, ao)
        rows.append(dict(variant=vn, last5y_per_year=round(a5), change_5y=round(a5 - base[0]), oos_2023_26_per_year=round(ao),
                         change_oos=round(ao - base[1]), **{str(y): round(float(pnl[D.year == y].sum())) for y in range(2020, 2027)}))
        print(rows[-1], flush=True)
    tag = "" if slip_ticks == 0 else f"_slip{slip_ticks:g}"
    with open(os.path.join(out, f"book_every_session{tag}.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def years_job(a):
    vname, acct, off = a
    S = G["D"].S
    ek, fk = kwargs(acct, VARIANTS[vname], G["slip"])
    k0 = start_k(S, "5y", off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
    if acct == "topstep":
        cash = T.cash_flows(S, k0, ev, "noact", 50)
    else:
        cash = T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=USER_EVAL[50] + (USER_ADDON if acct == "lucid_addon" else 0.0))
    return a, T.summarise_run(S, k0, cash, ev, [("x", W.START5, "2026-12-31")], {"x": W.FULL_YEARS_5Y})["years"]


def years(dd, out, names=("book", "+F1", "+F8", "on->F8", "on->F9", "ib->F8")):
    """Each year of the last 5 years, mean of the 12 start dates, for the main variants."""
    import csv
    init(dd, 0.0)
    jobs = [(v, a, o) for v in names for a in ACCTS for o in R4.OFFSETS]
    with get_context("fork").Pool(4) as p:
        res = p.map(years_job, jobs, chunksize=3)
    agg = {}
    for (v, a, o), yr in res:
        for y, x in yr.items():
            agg.setdefault((v, a), {}).setdefault(y, []).append(x)
    with open(os.path.join(out, "accounts_years.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        ys = sorted({y for d in agg.values() for y in d})
        w.writerow(["account", "variant"] + ys)
        for a in ACCTS:
            for v in names:
                w.writerow([a, v] + [round(float(np.mean(agg[(v, a)].get(y, [0.0])))) for y in ys])
    print("accounts_years.csv written", flush=True)


def table(out):
    """accounts.csv: every variant x account x window, with rule 5Y's verdict per account."""
    import csv
    t = json.load(open(os.path.join(out, "accounts.json")))
    t1 = json.load(open(os.path.join(out, "accounts_slip1.json"))) if os.path.exists(os.path.join(out, "accounts_slip1.json")) else {}
    plac = [v for v in t if v.startswith("placebo")]
    band = lambda a, lab, k: max(abs(t[p][a][lab][k] - t["book"][a][lab][k]) for p in plac)
    rows = []
    for v in t:
        for a in ACCTS:
            x5, b5, xe, be = t[v][a]["last 5y"], t["book"][a]["last 5y"], t[v][a]["early"], t["book"][a]["early"]
            dM, dW, dMe, dWe = x5["M"] - b5["M"], x5["W"] - b5["W"], xe["M"] - be["M"], xe["W"] - be["W"]
            bM, bW, bMe, bWe = band(a, "last 5y", "M"), band(a, "last 5y", "W"), band(a, "early", "M"), band(a, "early", "W")
            ok = ((dM > bM and dW > -bW) or (dW > bW and dM > -bM)) and dMe > -bMe and dWe > -bWe
            r = dict(variant=v, account=a, net_5y=round(x5["M"]), change_5y=round(dM), band_5y=round(bM), worst_year_5y=round(x5["W"]),
                     change_worst=round(dW), band_worst=round(bW), net_early=round(xe["M"]), change_early=round(dMe), band_early=round(bMe),
                     worst_early=round(xe["W"]), change_worst_early=round(dWe), band_worst_early=round(bWe),
                     net_since_dec2019=round(t[v][a]["since Dec 2019"]["M"]), net_oos_2023_26=round(t[v][a]["oos"]["M"]),
                     rule_5y=("" if v == "book" or v.startswith("placebo") else ("PASS" if ok else "fail")))
            if v in t1:
                r.update(net_5y_1tick=round(t1[v][a]["last 5y"]["M"]), net_oos_1tick=round(t1[v][a]["oos"]["M"]))
            rows.append(r)
    keys = max((list(r) for r in rows), key=len)
    with open(os.path.join(out, "accounts.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    print("accounts.csv written")


if __name__ == "__main__":
    st = float(sys.argv[sys.argv.index("--slip") + 1]) if "--slip" in sys.argv else 0.0
    if sys.argv[1] == "book":
        book_every_session(sys.argv[2], sys.argv[3], st)
    elif sys.argv[1] == "years":
        years(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "table":
        table(sys.argv[2])
    else:
        main(sys.argv[1], sys.argv[2], st)
