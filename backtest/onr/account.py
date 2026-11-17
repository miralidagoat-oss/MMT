"""Lucid Flex 25K account simulation driven by engine.Sessions, mirroring the Pine script's account math.

Rules encoded (Lucid Flex 25K, as published Nov 2026): eval target $1,250; max loss $1,000 trailing on end-of-day
balance, locked at +$100 once the EOD peak reaches +$1,100 or on the first payout request; eval consistency: best
day <= 40% (50% with the paid add-on) of total profit at the pass; funded: payout when 5 days >= $100 since the last
payout and P&L >= $1,000 (request $500, the minimum; 90% split); max 5 payouts.
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


def run_eval(S, k0, cons=0.4, span=1.0, news=True, slip=0.0, comm=1.0, side_override=None, legs=("on", "od"),
             thr=None, od_k=0.10, improved=False):
    """improved=True applies the v2 fixes: commission-aware stop, no new RTH entries on half days."""
    """Returns dict(result='pass'|'fail'|'open', k_end, days, trades). side_override(d, leg) -> side for tests."""
    pnl = peak = best = 0.0
    trades = 0
    for k in range(k0, len(S.days)):
        d = S.days[k]
        r = S.S[d]
        fl = 100.0 if peak >= 1100.0 else peak - 1000.0
        cushion = pnl - fl
        if cushion < 50.0:
            return dict(result="fail", k_end=k - 1, days=k - k0, trades=trades)
        day = 0.0
        traded = False
        adr = r["adr"]
        if not np.isnan(adr):
            if "on" in legs:
                side = S.on_side(d) if thr is None else S.on_side(d, thr)
                if side_override is not None and side != 0:
                    side = side_override(d, "on")
                if side != 0 and not (news and news_night(d)):
                    n, sd, td = eval_bracket(adr, cushion, best, pnl, cons, span, improved, comm)
                    E = r["on"]["E"] + side * slip
                    px, _ = bracket_exit(r["on"]["w"], side, E, sd, td, slip)
                    day = (px - E) * side * n * PV - n * comm
                    traded = True
            if not traded and "od" in legs and not (improved and is_half(d)):
                side = S.od_side(d, od_k)
                if side_override is not None and side != 0:
                    side = side_override(d, "od")
                if side != 0:
                    n, sd, td = eval_bracket(adr, cushion, best, pnl, cons, span, improved, comm)
                    E = r["od"]["E"] + side * slip
                    px, _ = bracket_exit(r["od"]["w"], side, E, sd, td, slip)
                    day = (px - E) * side * n * PV - n * comm
                    traded = True
        trades += traded
        pnl += day
        if traded:
            best = max(best, day)
        if pnl <= fl:
            return dict(result="fail", k_end=k, days=k - k0 + 1, trades=trades)
        peak = max(peak, pnl)
        if pnl >= max(1250.0, best / cons):
            return dict(result="pass", k_end=k, days=k - k0 + 1, trades=trades)
    return dict(result="open", k_end=len(S.days) - 1, days=len(S.days) - k0, trades=trades)


def funded_size(adr, adr_ref, nmax=10):
    """Contracts per funded leg. adr_ref=None -> fixed 1 MNQ (script as written); else ADR-normalised:
    round(adr_ref / adr), at least 1, at most nmax (Lucid 25K: 10 MNQ below $1k profit)."""
    if adr_ref is None:
        return 1
    return int(max(1, min(nmax, math.floor(adr_ref / adr + 0.5))))


def run_funded(S, k0, slip=0.0, legs=("on", "pyr", "ib"), payout_amt=500.0, max_pay=5, day_budget=600.0,
               abandon=200.0, thr=None, on_stop=0.5, record=None, adr_ref=None, comm=1.0, improved=False):
    """Returns dict(result='blown'|'abandon'|'done'|'open', k_end, payouts=[k,...])."""
    pnl = peak = 0.0
    npay = q = 0
    pays = []
    for k in range(k0, len(S.days)):
        d = S.days[k]
        r = S.S[d]
        fl = 100.0 if (npay > 0 or peak >= 1100.0) else peak - 1000.0
        cushion = pnl - fl
        if cushion < abandon:
            return dict(result="abandon", k_end=k - 1, payouts=pays)
        room = min(day_budget, cushion - 10.0)
        used = 0.0
        day = 0.0
        adr = r["adr"]
        half = improved and is_half(d)
        if not np.isnan(adr):
            n = funded_size(adr, adr_ref)
            if "on" in legs:
                side = S.on_side(d) if thr is None else S.on_side(d, thr)
                rk = on_stop * adr * PV * n
                if side != 0 and used + rk <= room:
                    p, _ = funded_on(S, d, side, slip, on_stop, n=n, comm=comm)
                    day += p
                    used += rk
                    if record is not None:
                        record.append((d, "on", side, p))
            if "pyr" in legs and not half:
                side = S.od_side(d)
                rk = 0.35 * adr * PV * n
                if side != 0 and used + rk <= room:
                    p, _ = pyramid(S, d, side, slip, n=n, comm=comm, fix_gap=improved)
                    day += p
                    used += rk
                    if record is not None:
                        record.append((d, "pyr", side, p))
            if "ib" in legs and "ib" in r and not half:
                rk = 0.25 * adr * PV * n
                if used + rk <= room:
                    res = ib_breakout(S, d, slip, n=n, comm=comm)
                    if res is not None and res[1] != "both-skip":
                        day += res[0]
                        if record is not None:
                            record.append((d, "ib", res[2], res[0]))
        pnl += day
        if pnl <= fl:
            return dict(result="blown", k_end=k, payouts=pays)
        peak = max(peak, pnl)
        if day >= 100.0:
            q += 1
        if q >= 5 and pnl >= 1000.0:
            pays.append(k)
            pnl -= payout_amt
            npay += 1
            q = 0
            if npay >= max_pay:
                return dict(result="done", k_end=k, payouts=pays)
    return dict(result="open", k_end=len(S.days) - 1, payouts=pays)


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
