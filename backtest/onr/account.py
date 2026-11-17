"""Lucid Flex 25K account simulation driven by engine.Sessions, mirroring the Pine script's account math.

Rules encoded (Lucid Flex 25K, as published Nov 2026): eval target $1,250; max loss $1,000 trailing on end-of-day
balance, locked at +$100 once the EOD peak reaches +$1,100 or on the first payout request; eval consistency: best
day <= 40% (50% with the paid add-on) of total profit at the pass; funded: payout when 5 days >= $100 since the last
payout and P&L >= $1,000 (request $500, the minimum, or optionally the maximum allowed: 50% of profit up to $1,000;
90% split); max 5 payouts per account.

EvalAccount / FundedAccount process one session per step() call; run_eval / run_funded / lifecycle are the
one-account drivers and portfolio.py runs several accounts side by side.
"""
import datetime as dt
import math

import numpy as np

from engine import PV, bracket_exit, funded_on, ib_breakout, news_night, pyramid
from holidays import half_day


def is_half(d):
    return half_day(np.datetime64(int(d), "D").astype(dt.date))


def eval_bracket(adr, cushion, best, pnl, cons, span, comm_aware=False, comm=1.0):
    sl = min(600.0, cushion - 5.0)
    need = max(1250.0, best / cons)
    tp = max(20.0, min(1250.0 * cons, max(need - pnl, 0.0) + 15.0))
    n = int(max(1.0, min(20.0, math.floor((sl + tp) / (span * adr * PV) + 0.5))))
    if comm_aware:  # worst-case loss INCLUDING commission stays inside the $ limit
        sl = sl - n * comm
    return n, sl / (n * PV), tp / (n * PV)


def funded_size(adr, adr_ref, nmax=10):
    """Contracts per funded leg. adr_ref=None -> fixed 1 MNQ (v1); else ADR-normalised:
    round(adr_ref / adr), at least 1, at most nmax (Lucid 25K: 10 MNQ below $1k profit)."""
    if adr_ref is None:
        return 1
    return int(max(1, min(nmax, math.floor(adr_ref / adr + 0.5))))


class EvalAccount:
    """step(d) -> None | 'pass' | 'fail' | 'dead' ('dead' = cushion < $50 before the session: not traded)."""

    def __init__(self, S, cons=0.4, span=1.0, news=True, slip=0.0, comm=1.0, side_override=None,
                 legs=("on", "od"), thr=None, od_k=0.10, improved=False, book_mult=0, adr_ref=350.0):
        """book_mult=0: v1/v2 eval (one bracket trade a day). book_mult=k: trade the funded book (overnight, pyramid,
        IB with the drive) at k x the funded size under the same $600 day budget."""
        self.S, self.cons, self.span, self.news, self.slip, self.comm = S, cons, span, news, slip, comm
        self.side_override, self.legs, self.thr, self.od_k, self.improved = side_override, legs, thr, od_k, improved
        self.book_mult, self.adr_ref = book_mult, adr_ref
        self.pnl = self.peak = self.best = 0.0
        self.trades = 0

    def _book_day(self, d, cushion):
        S, r = self.S, self.S.S[d]
        adr = r["adr"]
        room = min(600.0, cushion - 10.0)
        used = day = 0.0
        traded = False
        if np.isnan(adr):
            return 0.0, False
        n = funded_size(adr, self.adr_ref) * self.book_mult
        half = self.improved and is_half(d)
        side = S.on_side(d)
        rk = 0.5 * adr * PV * n
        if side != 0 and used + rk <= room:
            day += funded_on(S, d, side, self.slip, 0.5, n=n, comm=self.comm)[0]
            used += rk
            traded = True
        side = S.od_side(d)
        rk = 0.35 * adr * PV * n
        if not half and side != 0 and used + rk <= room:
            day += pyramid(S, d, side, self.slip, n=n, comm=self.comm, fix_gap=self.improved)[0]
            used += rk
            traded = True
        rk = 0.25 * adr * PV * n
        if not half and "ib" in r and used + rk <= room:
            res = ib_breakout(S, d, self.slip, n=n, comm=self.comm, only_side=S.od_side(d))
            if res is not None and res[1] != "both-skip":
                day += res[0]
                traded = True
        return day, traded

    def step(self, d):
        S, r = self.S, self.S.S[d]
        fl = 100.0 if self.peak >= 1100.0 else self.peak - 1000.0
        cushion = self.pnl - fl
        if cushion < (200.0 if self.book_mult else 50.0):  # book mode: same abandon level as the funded account
            return "dead"
        day = 0.0
        traded = False
        adr = r["adr"]
        if self.book_mult:
            day, traded = self._book_day(d, cushion)
        elif not np.isnan(adr):
            if "on" in self.legs:
                side = S.on_side(d) if self.thr is None else S.on_side(d, self.thr)
                if self.side_override is not None and side != 0:
                    side = self.side_override(d, "on")
                if side != 0 and not (self.news and news_night(d)):
                    n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved, self.comm)
                    E = r["on"]["E"] + side * self.slip
                    px, _ = bracket_exit(r["on"]["w"], side, E, sd, td, self.slip)
                    day = (px - E) * side * n * PV - n * self.comm
                    traded = True
            if not traded and "od" in self.legs and not (self.improved and is_half(d)):
                side = S.od_side(d, self.od_k)
                if self.side_override is not None and side != 0:
                    side = self.side_override(d, "od")
                if side != 0:
                    n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved, self.comm)
                    E = r["od"]["E"] + side * self.slip
                    px, _ = bracket_exit(r["od"]["w"], side, E, sd, td, self.slip)
                    day = (px - E) * side * n * PV - n * self.comm
                    traded = True
        self.trades += traded
        self.pnl += day
        if traded:
            self.best = max(self.best, day)
        if self.pnl <= fl:
            return "fail"
        self.peak = max(self.peak, self.pnl)
        if self.pnl >= max(1250.0, self.best / self.cons):
            return "pass"
        return None


class FundedAccount:
    """step(d) -> (event, payout$): event None | 'blown' | 'done' | 'dead' ('dead' = cushion below the abandon level
    before the session: not traded). payout$ = gross payout requested at the end of the session (0 if none)."""

    def __init__(self, S, slip=0.0, legs=("on", "pyr", "ib"), payout_amt=500.0, max_pay=5, day_budget=600.0,
                 abandon=200.0, thr=None, on_stop=0.5, record=None, adr_ref=None, comm=1.0, improved=False,
                 ib_with_drive=False, payout_max=False):
        self.S, self.slip, self.legs, self.payout_amt, self.max_pay = S, slip, legs, payout_amt, max_pay
        self.day_budget, self.abandon, self.thr, self.on_stop, self.record = day_budget, abandon, thr, on_stop, record
        self.adr_ref, self.comm, self.improved, self.ib_with_drive, self.payout_max = adr_ref, comm, improved, ib_with_drive, payout_max
        self.pnl = self.peak = 0.0
        self.npay = self.q = 0

    def step(self, d):
        S, r = self.S, self.S.S[d]
        fl = 100.0 if (self.npay > 0 or self.peak >= 1100.0) else self.peak - 1000.0
        cushion = self.pnl - fl
        if cushion < self.abandon:
            return "dead", 0.0
        room = min(self.day_budget, cushion - 10.0)
        used = day = 0.0
        adr = r["adr"]
        half = self.improved and is_half(d)
        if not np.isnan(adr):
            n = funded_size(adr, self.adr_ref)
            if "on" in self.legs:
                side = S.on_side(d) if self.thr is None else S.on_side(d, self.thr)
                rk = self.on_stop * adr * PV * n
                if side != 0 and used + rk <= room:
                    p, _ = funded_on(S, d, side, self.slip, self.on_stop, n=n, comm=self.comm)
                    day += p
                    used += rk
                    if self.record is not None:
                        self.record.append((d, "on", side, p))
            if "pyr" in self.legs and not half:
                side = S.od_side(d)
                rk = 0.35 * adr * PV * n
                if side != 0 and used + rk <= room:
                    p, _ = pyramid(S, d, side, self.slip, n=n, comm=self.comm, fix_gap=self.improved)
                    day += p
                    used += rk
                    if self.record is not None:
                        self.record.append((d, "pyr", side, p))
            if "ib" in self.legs and "ib" in r and not half:
                rk = 0.25 * adr * PV * n
                if used + rk <= room:
                    res = ib_breakout(S, d, self.slip, n=n, comm=self.comm,
                                      only_side=S.od_side(d) if self.ib_with_drive else 0)
                    if res is not None and res[1] != "both-skip":
                        day += res[0]
                        if self.record is not None:
                            self.record.append((d, "ib", res[2], res[0]))
        self.pnl += day
        if self.pnl <= fl:
            return "blown", 0.0
        self.peak = max(self.peak, self.pnl)
        if day >= 100.0:
            self.q += 1
        if self.q >= 5 and self.pnl >= 1000.0:
            amt = min(1000.0, max(500.0, 0.5 * self.pnl)) if self.payout_max else self.payout_amt
            self.pnl -= amt
            self.npay += 1
            self.q = 0
            return ("done" if self.npay >= self.max_pay else None), max(amt, 1e-9)
        return None, 0.0


def run_eval(S, k0, **kw):
    """Returns dict(result='pass'|'fail'|'open', k_end, days, trades). side_override(d, leg) -> side for tests."""
    acct = EvalAccount(S, **kw)
    for k in range(k0, len(S.days)):
        res = acct.step(S.days[k])
        if res == "dead":
            return dict(result="fail", k_end=k - 1, days=k - k0, trades=acct.trades)
        if res is not None:
            return dict(result=res, k_end=k, days=k - k0 + 1, trades=acct.trades)
    return dict(result="open", k_end=len(S.days) - 1, days=len(S.days) - k0, trades=acct.trades)


def run_funded(S, k0, **kw):
    """Returns dict(result='blown'|'abandon'|'done'|'open', k_end, payouts=[k,...], amounts=[$,...])."""
    acct = FundedAccount(S, **kw)
    pays, amts = [], []
    for k in range(k0, len(S.days)):
        ev, amt = acct.step(S.days[k])
        if ev == "dead":
            return dict(result="abandon", k_end=k - 1, payouts=pays, amounts=amts)
        if amt > 0:
            pays.append(k)
            amts.append(amt)
        if ev is not None:
            return dict(result=ev, k_end=k, payouts=pays, amounts=amts)
    return dict(result="open", k_end=len(S.days) - 1, payouts=pays, amounts=amts)


def lifecycle(S, k_start=0, k_stop=None, eval_kw=None, funded_kw=None):
    """One account at a time, buy a new eval the session after any eval/funded account ends."""
    eval_kw = eval_kw or {}
    funded_kw = funded_kw or {}
    k_stop = len(S.days) if k_stop is None else k_stop
    k = k_start
    evals = passes = 0
    payouts = []
    log = []
    while k < k_stop:
        ev = run_eval(S, k, **eval_kw)
        evals += 1
        log.append(("eval", S.days[k], ev["result"], ev["days"]))
        if ev["result"] != "pass":
            k = ev["k_end"] + 1
            continue
        passes += 1
        fu = run_funded(S, ev["k_end"] + 1, **funded_kw)
        payouts += fu["payouts"]
        log.append(("funded", S.days[min(ev["k_end"] + 1, len(S.days) - 1)], fu["result"], len(fu["payouts"])))
        k = fu["k_end"] + 1
    return dict(evals=evals, passes=passes, payouts=[S.days[i] for i in payouts if i < k_stop], log=log)


def dry_spells(pay_days, start_day, end_day):
    """Gaps (in days) between consecutive payouts, including start->first and last->end."""
    pts = [start_day] + sorted(pay_days) + [end_day]
    return np.diff(pts)
