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
import os

import numpy as np

from engine import PV, Win, bracket_exit, funded_on, ib_breakout, ib_entry, news_night, pyramid
from holidays import half_day


def is_half(d):
    return half_day(np.datetime64(int(d), "D").astype(dt.date))


# Lucid Flex sizes (BestProps, checked against Lucid's help centre 2026-11-10). The strategy scales its $ limits by
# m = mll / 1000 (eval stop cap, day budget, cushion thresholds, funded size reference).
RULES = {25: dict(target=1250.0, mll=1000.0, qday=100.0, paycap=1000.0, evalmax=20, fundmax=10, price=65.0),
         50: dict(target=3000.0, mll=2000.0, qday=150.0, paycap=2000.0, evalmax=40, fundmax=20, price=115.0),
         100: dict(target=6000.0, mll=3000.0, qday=200.0, paycap=2500.0, evalmax=60, fundmax=30, price=215.0),
         150: dict(target=9000.0, mll=4500.0, qday=250.0, paycap=3000.0, evalmax=100, fundmax=40, price=323.0)}
# The 50K eval price: $115 is Lucid's list price. ONR_EVAL_FEE_50K sets another one, e.g. 80.50 with a discount code.
# Only the bookkeeping uses it (net = 90% of payouts - fee x evals bought); no trading decision does, so a run at another
# price takes exactly the same trades. Results at another price go to folders tagged FEE_TAG (e.g. "_fee8050").
RULES[50]["price"] = float(os.environ.get("ONR_EVAL_FEE_50K", RULES[50]["price"]))
FEE_TAG = "" if RULES[50]["price"] == 115.0 else "_fee" + f"{RULES[50]['price']:.2f}".replace(".", "")


def eval_bracket(adr, cushion, best, pnl, cons, span, comm_aware=False, comm=1.0, size=25, k=1.0, R=None, dll=None):
    """k scales the stop cap and the per-trade target cap (round 3, hypothesis C: timid play). R: another firm's rules
    (default Lucid's RULES[size]). dll: a daily loss limit the stop must stay inside (Topstep Labs: $500 at 25K)."""
    R = RULES[size] if R is None else R
    m = R["mll"] / 1000.0
    sl = min(600.0 * m * k, cushion - 5.0 * m)
    if dll is not None:
        sl = min(sl, dll)
    need = max(R["target"], best / cons)
    tp = max(20.0 * m, min(R["target"] * cons * k, max(need - pnl, 0.0) + 15.0 * m))
    n = int(max(1.0, min(float(R["evalmax"]), math.floor((sl + tp) / (span * adr * PV) + 0.5))))
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
                 legs=("on", "od"), thr=None, od_k=0.10, improved=False, book_mult=0, adr_ref=350.0, size=25,
                 on_long_only=False, risk_k=1.0, ib_fallback=False, rules=None, lock=100.0, pass_cons=None, dll=None,
                 max_days=None):
        """book_mult=0: v1/v2 eval (one bracket trade a day). book_mult=k: trade the funded book (overnight, pyramid,
        IB with the drive) at k x the funded size under the same $600 day budget. risk_k: bracket stop and target caps
        x risk_k (round 3, C). ib_fallback (round 6, U1): on a session with no trade so far (no 09:35 drive), take the
        10:30 IB breakout (OCO, engine.ib_entry) with the same bracket, held to 16:00; a stop inside the fill bar counts."""
        self.S, self.cons, self.span, self.news, self.slip, self.comm = S, cons, span, news, slip, comm
        self.side_override, self.legs, self.thr, self.od_k, self.improved = side_override, legs, thr, od_k, improved
        self.book_mult, self.adr_ref, self.size, self.on_long_only = book_mult, adr_ref, size, on_long_only
        self.risk_k, self.ib_fallback = risk_k, ib_fallback
        # another firm: rules (target, mll, evalmax, ...), lock (where the trailing max loss stops above the start;
        # Lucid +$100, Topstep $0) and pass_cons (the firm's best-day share when it differs from the indicator's cons)
        self.R = RULES[size] if rules is None else rules
        self.lock, self.pass_cons = lock, (cons if pass_cons is None else pass_cons)
        # dll: the stop stays inside a daily loss limit; max_days: calendar days from the first session to expiry (a fail)
        # (a static max loss is lock = -mll: the floor then sits at -mll from the start and never moves)
        self.dll, self.max_days, self.d0 = dll, max_days, None
        self.m = self.R["mll"] / 1000.0
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
        if self.d0 is None:
            self.d0 = int(d)
        if self.max_days is not None and int(d) - self.d0 >= self.max_days:
            return "fail"  # expired before passing
        fl = self.lock if self.peak >= self.R["mll"] + self.lock else self.peak - self.R["mll"]
        cushion = self.pnl - fl
        if cushion < (200.0 if self.book_mult else 50.0) * self.m:  # book mode: same abandon level as funded
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
                if side != 0 and not (self.news and news_night(d)) and not (self.on_long_only and side < 0):
                    n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved,
                                             self.comm, self.size, self.risk_k, R=self.R, dll=self.dll)
                    E = r["on"]["E"] + side * self.slip
                    px, _ = bracket_exit(r["on"]["w"], side, E, sd, td, self.slip)
                    day = (px - E) * side * n * PV - n * self.comm
                    traded = True
            if not traded and "od" in self.legs and not (self.improved and is_half(d)):
                side = S.od_side(d, self.od_k)
                if self.side_override is not None and side != 0:
                    side = self.side_override(d, "od")
                if side != 0:
                    n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved,
                                             self.comm, self.size, self.risk_k, R=self.R, dll=self.dll)
                    E = r["od"]["E"] + side * self.slip
                    px, _ = bracket_exit(r["od"]["w"], side, E, sd, td, self.slip)
                    day = (px - E) * side * n * PV - n * self.comm
                    traded = True
            if not traded and self.ib_fallback and not (self.improved and is_half(d)):
                f = ib_entry(S, d, 0)
                if f is not None:
                    side, E0, j = f
                    n, sd, td = eval_bracket(adr, cushion, self.best, self.pnl, self.cons, self.span, self.improved,
                                             self.comm, self.size, self.risk_k, R=self.R, dll=self.dll)
                    E = E0 + side * self.slip
                    o, h, l, c, _ = r["rng"]
                    if (side == 1 and E - l[j] >= sd) or (side == -1 and h[j] - E >= sd):
                        px = E - side * sd - side * self.slip  # stopped inside the fill bar (as ib_breakout)
                    else:
                        e = r["ib"]["eod"]
                        px, _ = bracket_exit(Win(o[j + 1:e + 1], h[j + 1:e + 1], l[j + 1:e + 1], c[j + 1:e + 1]), side, E,
                                             sd, td, self.slip)
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


class FundedAccount:
    """step(d) -> (event, payout$): event None | 'blown' | 'done' | 'dead' ('dead' = cushion below the abandon level
    before the session: not traded). payout$ = gross payout requested at the end of the session (0 if none)."""

    def __init__(self, S, slip=0.0, legs=("on", "pyr", "ib"), payout_amt=500.0, max_pay=5, day_budget=600.0,
                 abandon=200.0, thr=None, on_stop=0.5, record=None, adr_ref=None, comm=1.0, improved=False,
                 ib_with_drive=False, payout_max=False, size=25, on_long_only=False, cycle_rule=False,
                 cushion_frac=None, add2=None, rules=None, lock=100.0, pay_min=500.0, pay_path="days", pay_cons=0.4,
                 pay_days=3, lock_after_pay=None):
        """cushion_frac=f (round 3, A): day budget min(day_budget x M, f x cushion) and contracts scaled by
        min(1, f x cushion / (day_budget x M)), at least 1. add2 (round 3, E): second pyramid add at add2 x ADR."""
        self.cushion_frac, self.add2 = cushion_frac, add2
        self.S, self.slip, self.legs, self.payout_amt, self.max_pay = S, slip, legs, payout_amt, max_pay
        self.day_budget, self.abandon, self.thr, self.on_stop, self.record = day_budget, abandon, thr, on_stop, record
        self.adr_ref, self.comm, self.improved, self.ib_with_drive, self.payout_max = adr_ref, comm, improved, ib_with_drive, payout_max
        self.size, self.on_long_only, self.cycle_rule = size, on_long_only, cycle_rule
        # another firm: rules, lock (see EvalAccount), pay_min (minimum payout; a request needs 2 x pay_min of profit),
        # pay_path "days" (5 days of qday or more, Lucid / Topstep Standard) or "consistency" (Topstep: pay_days traded
        # sessions and the largest day <= pay_cons x the net profit since the last payout)
        self.R = RULES[size] if rules is None else rules
        self.lock, self.pay_min, self.pay_path, self.pay_cons, self.pay_days = lock, pay_min, pay_path, pay_cons, pay_days
        # where the floor sits after a payout (default: lock); a static max loss is lock = -mll, lock_after_pay = 0
        self.lock_after_pay = lock if lock_after_pay is None else lock_after_pay
        self.td, self.maxday = 0, 0.0
        self.m = self.R["mll"] / 1000.0
        self.pnl = self.peak = 0.0
        self.npay = self.q = 0
        self.after_pay = 0.0  # P&L right after the last payout (Lucid: the next one needs net profit above it)

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
            n = funded_size(adr, None if self.adr_ref is None else self.adr_ref * m,
                            nmax=self.R["fundmax"]) if self.adr_ref is not None else 1
            if self.cushion_frac is not None:
                g = min(1.0, self.cushion_frac * cushion / (self.day_budget * m))
                n = max(1, int(math.floor(n * g + 0.5)))
                room = min(room, self.cushion_frac * cushion)
            if "on" in self.legs:
                side = S.on_side(d) if self.thr is None else S.on_side(d, self.thr)
                rk = self.on_stop * adr * PV * n
                if side != 0 and used + rk <= room and not (self.on_long_only and side < 0):
                    p, _ = funded_on(S, d, side, self.slip, self.on_stop, n=n, comm=self.comm)
                    day += p
                    used += rk
                    if self.record is not None:
                        self.record.append((d, "on", side, p))
            if "pyr" in self.legs and not half:
                side = S.od_side(d)
                rk = 0.35 * adr * PV * n
                if side != 0 and used + rk <= room:
                    p, _ = pyramid(S, d, side, self.slip, n=n, comm=self.comm, fix_gap=self.improved, add2=self.add2)
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
        if day >= self.R["qday"]:
            self.q += 1
        if day != 0.0:  # a session with a trade (counted by the Topstep Consistency path)
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
