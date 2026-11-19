#!/usr/bin/env python3
"""Lucid's maximum (5 funded + 5 evals) with Lucid's move-to-live rule, on real NQ futures.

usage: ONR_EVAL_FEE_50K=80.50 python3 live50k.py FUT_DATA_DIR OUT_DIR
  FUT_DATA_DIR: NQFUT.npz (prep_nqfut.py) and SPXUSD.npz.

Every earlier pool backtest let the 10 accounts cycle for ever: an account that took its 5th payout simply ended and
the next passed eval took its slot. Lucid's help centre (read Nov 19 2026) says otherwise:
- "Maximum Number of Accounts" (Aug 26 2026): up to 10 accounts in all across evaluations and funded accounts, at most
  5 funded, per household; up to 5 LucidLive accounts.
- "LucidFlex Payouts" (Jul 28 2026): "Traders may take up to 5 payouts from each LucidFlex account after which they
  will be moved live."
- Live structure (Oct 4 2026): all simulated prop accounts are closed when a trader is moved live; one live account per
  funded account with at least one payout; a funded account with no payout is refunded its evaluation if >= 50% of its
  drawdown remains; evaluations are closed. Live (50K): $0 start, end-of-day drawdown $2,000 that locks at $100 once
  live profits reach it (or at a live payout before that), no daily loss limit, no consistency rule, daily payouts.
  One-time Live Bonus at 50K: $2,000 at 90/10 once live profits reach $2,100, only the first time a trader is moved
  live. After blowing a live account a trader may buy a new evaluation after a 2-week cooldown.

The model (fixed before any run):
  sim phase   round 4's structure B with N = 5, exactly research4.sim_pool: up to 5 funded and 10 accounts in all, one
              new eval a session, passed evals wait for a funded slot.
  move live   the session after any funded account takes its 5th payout. That is the point Lucid's rules name; its risk
              team decides and may move a trader earlier, which is not modelled. Funded accounts with >= 1 payout become
              live accounts; the others close (eval price refunded if the cushion is >= $1,000); evals and passed evals
              waiting for a slot close with no refund; unpaid sim profit is lost.
  live        each live account trades the funded plan with FundedAccount's own code (sized and budgeted from the live
              cushion), requests nothing before the drawdown locks, then keeps a $2,000 cushion and withdraws the rest at
              the end of every session, at an 80% split (Lucid's "LucidLive Account Payouts" article; reviews report 90%
              since March 2026: shown as a variant). A live account whose cushion falls below $400 (the plan's abandon
              level) is closed.
  restart     10 sessions (2 weeks) after the last live account is gone, the sim phase starts again from no account.
              Variant "side by side": 10 sessions after the first live account is lost, the sim phase runs beside the
              live accounts left (Lucid's caps count live accounts separately). Later moves live get no bonus.
  stop4       an alternative plan: close each funded account right after its 4th payout (a passed eval takes its slot),
              so no account ever takes the 5th payout that moves the trader live. Lucid's risk team may still move a
              trader live for other reasons (lifetime payouts, sim performance), which is not modelled.
For reference, "cycle" is the earlier model (accounts end after 5 payouts and the pool goes on).
Writes live_summary.csv, live_years.csv, live_paths.csv, runs.json and summary.txt into OUT_DIR.
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
from research4 import E_KW, F_KW, FEE, OFFSETS, SPLIT, run_metrics, sim_pool  # noqa: E402

N_FUNDED, MAX_TOTAL = 5, 10          # Lucid's caps (per household)
MLL = RULES[50]["mll"]               # 50K: $2,000
ABANDON = 200.0 * MLL / 1000.0       # the plan's abandon level: cushion below $400
KEEP = MLL                           # cushion a live account keeps after the lock; the rest is withdrawn
BONUS, BONUS_AT = 2000.0, 2100.0     # 50K Live Bonus (gross, 90/10) and its Live Target
COOLDOWN = 10                        # 2 weeks of sessions
LIVE_CAP = 5
START5 = "2021-11-15"
PERIODS = {"5y": [("last 5y", START5, "2026-12-31")], "all": [("since 2019", "2019-01-01", "2026-12-31")]}
FULL = {"last 5y": ["2022", "2023", "2024", "2025"], "since 2019": ["2020", "2021", "2022", "2023", "2024", "2025"]}
CASH = ("payout", "live_wd", "bonus")
_G = {}


def iso(d):
    return str(np.datetime64(int(d), "D"))


class LiveAccount:
    """A LucidLive 50K account trading the funded plan. step(d) -> (event, withdrawal $, bonus $), event None | 'blown' |
    'closed' ('closed': cushion below the abandon level before the session, not traded)."""

    def __init__(self, S, fk, bonus):
        self.S, self.fk, self.bonus = S, fk, bonus
        self.pnl = self.peak = 0.0
        self.locked = False

    def step(self, d):
        fl = 100.0 if self.locked else self.peak - MLL
        cushion = self.pnl - fl
        if cushion < ABANDON:
            return "closed", 0.0, 0.0
        # FundedAccount's own trading code at this cushion: floor at +$100 (one payout taken), no payout possible
        probe = FundedAccount(self.S, **self.fk)
        probe.npay, probe.q = 1, -10 ** 9
        probe.pnl = probe.peak = 100.0 + cushion
        probe.step(d)
        self.pnl += probe.pnl - (100.0 + cushion)
        if self.pnl <= fl:
            return "blown", 0.0, 0.0
        self.peak = max(self.peak, self.pnl)
        if not self.locked and self.peak >= MLL:  # live profits reached the starting drawdown: locks at +$100
            self.locked = True
        bonus = 0.0
        if self.bonus and self.pnl >= BONUS_AT:
            bonus, self.bonus = BONUS, False
        wd = 0.0
        if self.locked and self.pnl > 100.0 + KEEP:
            wd = self.pnl - (100.0 + KEEP)
            self.pnl -= wd
        return None, wd, bonus


def sim_live(S, k0, k1, ek, fk, live=True, restart="all", N=N_FUNDED, max_total=MAX_TOTAL):
    """research4.sim_pool(S, N, max_total, ...) with Lucid's move-to-live rule; live=False is sim_pool exactly (checked).
    Returns (events, phases). Events (k, kind, id, value): sim_pool's ('buy', 'pass', 'fail', 'fund', 'payout',
    'end:...'), plus 'move' (value = live accounts opened), 'close' (a sim account closed by a move; value 0 = funded
    without a payout, 1 = funded with a payout but over the live cap, 2 = an eval), 'close_ready' (value = passed evals
    waiting for a slot, closed), 'refund' (value = the eval price), 'live' (a live account opened, id = its funded
    account), 'live_wd' (gross withdrawal), 'bonus' (gross), 'live_end:blown' / 'live_end:closed'.
    phases: one letter a session: S sim only, L live only, B both, W waiting (cooldown, no account)."""
    funded, evals, ev, ready, nid = [], [], [], 0, 0
    paid = {}
    lives, done_now, phases = [], [], []
    sim_from, moves, move_next = k0, 0, False
    for k in range(k0, k1):
        d = S.days[k]
        if move_next:
            move_next, moves = False, moves + 1
            opened = 0
            for f, aid in [(None, a) for a in done_now] + funded:
                if paid.get(aid, 0) > 0 and len(lives) < LIVE_CAP:
                    lives.append((LiveAccount(S, fk, bonus=moves == 1), aid))
                    ev.append((k, "live", aid, 0.0))
                    opened += 1
                elif paid.get(aid, 0) > 0:
                    ev.append((k, "close", aid, 1.0))
                else:
                    ev.append((k, "close", aid, 0.0))
                    fl = 100.0 if f.peak >= MLL + 100.0 else f.peak - MLL
                    if f.pnl - fl >= 0.5 * MLL:
                        ev.append((k, "refund", aid, FEE))
            for _, aid, _ in evals:
                ev.append((k, "close", aid, 2.0))
            if ready:
                ev.append((k, "close_ready", 0, float(ready)))
            ev.append((k, "move", 0, float(opened)))
            funded, evals, ready, done_now, sim_from = [], [], 0, [], None
        keep = []
        for la, aid in lives:
            evn, wd, bonus = la.step(d)
            if bonus > 0:
                ev.append((k, "bonus", aid, bonus))
            if wd > 0:
                ev.append((k, "live_wd", aid, wd))
            if evn is None:
                keep.append((la, aid))
            else:
                ev.append((k, "live_end:" + evn, aid, 0.0))
        lost = len(lives) - len(keep)
        lives = keep
        if lost and sim_from is None and (restart == "first" or not lives):
            sim_from = k + 1 + COOLDOWN
        sim_on = sim_from is not None and k >= sim_from
        phases.append(("B" if lives else "S") if sim_on else ("L" if lives else "W"))
        if not sim_on:
            continue
        # ---- the sim phase: research4.sim_pool's session, line for line
        while ready and len(funded) < N:
            nid += 1
            funded.append((FundedAccount(S, **fk), nid))
            ev.append((k, "fund", nid, 0.0))
            ready -= 1
        for _ in range(max(0, min(1, max_total - len(funded) - len(evals) - ready))):
            nid += 1
            evals.append((EvalAccount(S, **ek), nid, k))
            ev.append((k, "buy", nid, 0.0))
        keep = []
        for f, aid in funded:
            evn, amt = f.step(d)
            if amt > 0:
                ev.append((k, "payout", aid, amt))
                paid[aid] = paid.get(aid, 0) + 1
            if evn is None:
                keep.append((f, aid))
            else:
                ev.append((k, "end:" + ("abandoned" if evn == "dead" else evn), aid, 0.0))
                if evn == "done" and live:
                    done_now.append(aid)
                    move_next = True
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
    return ev, "".join(phases)


def cash(kind, v, split_live):
    """$ to the trader of one event: sim payouts 90%, live withdrawals at the live split, the bonus 90/10, eval bought
    -price, refund +price."""
    if kind == "payout" or kind == "bonus":
        return SPLIT * v
    if kind == "live_wd":
        return split_live * v
    if kind == "buy":
        return -FEE
    if kind == "refund":
        return v
    return 0.0


def metrics(S, ev, phases, k_start, k_stop, split_live, periods):
    """research4.run_metrics with live withdrawals, bonuses and refunds counted as cash (equal to it when none occur:
    checked), plus the live phase's own figures."""
    days = [iso(S.days[k]) for k in range(k_start, k_stop)]
    net = np.zeros(k_stop - k_start)
    pays = []
    for k, kind, _, v in ev:
        net[k - k_start] += cash(kind, v, split_live)
        if kind in CASH:
            pays.append(k)
    run = np.cumsum(net)
    yrs = {}
    for i, d in enumerate(days):
        y = yrs.setdefault(d[:4], dict(net=0.0, sim_payouts=0, sim_payouts_net=0.0, live_wd_net=0.0, bonus_net=0.0,
                                       evals_bought=0, evals_passed=0, evals_failed=0, refunds=0, moves=0, live_opened=0,
                                       sessions_live_only=0, sessions_sim=0))
        y["net"] += net[i]
        y["sessions_live_only"] += phases[i] == "L"
        y["sessions_sim"] += phases[i] in "SB"
    for k, kind, aid, v in ev:
        y = yrs[iso(S.days[k])[:4]]
        if kind == "payout":
            y["sim_payouts"] += 1
            y["sim_payouts_net"] += cash(kind, v, split_live)
        elif kind == "live_wd":
            y["live_wd_net"] += cash(kind, v, split_live)
        elif kind == "bonus":
            y["bonus_net"] += cash(kind, v, split_live)
        elif kind == "buy":
            y["evals_bought"] += 1
        elif kind == "pass":
            y["evals_passed"] += 1
        elif kind == "fail":
            y["evals_failed"] += 1
        elif kind == "refund":
            y["refunds"] += 1
        elif kind == "move":
            y["moves"] += 1
        elif kind == "live":
            y["live_opened"] += 1
    opened = {aid: k for k, kind, aid, _ in ev if kind == "live"}
    lives = []  # (opened k, ended k or None, gross withdrawn, bonus gross, end kind)
    for aid, k_open in opened.items():  # a funded id opens at most one live account
        ends = [(k, kind[9:]) for k, kind, a, _ in ev if a == aid and kind.startswith("live_end:")]
        lives.append(dict(open=k_open, end=ends[0][0] if ends else None, how=ends[0][1] if ends else "open",
                          wd=float(sum(v for k, kind, a, v in ev if a == aid and kind == "live_wd")),
                          bonus=float(sum(v for k, kind, a, v in ev if a == aid and kind == "bonus"))))
    mv = [k for k, kind, _, _ in ev if kind == "move"]
    passes = [v for _, kind, _, v in ev if kind == "pass"]
    out = dict(years=yrs, cash_low=float(run.min()), total=float(run[-1]),
               evals=dict(bought=sum(kind == "buy" for _, kind, _, _ in ev), passed=len(passes),
                          failed=sum(kind == "fail" for _, kind, _, _ in ev),
                          median_pass=float(np.median(passes)) if passes else 0.0,
                          closed_by_moves=sum(kind == "close" and v == 2.0 for _, kind, _, v in ev)),
               live=dict(moves=len(mv), first_move=days[mv[0] - k_start] if mv else None,
                         first_move_days=((dt.date.fromisoformat(days[mv[0] - k_start]) - dt.date.fromisoformat(days[0])).days
                                          if mv else None),
                         opened=len(lives), lives=lives, refunds=sum(kind == "refund" for _, kind, _, _ in ev),
                         sim_payouts=sum(kind == "payout" for _, kind, _, _ in ev),
                         sessions_live_only=phases.count("L"), sessions_sim=phases.count("S") + phases.count("B"),
                         sessions_waiting=phases.count("W"), sessions=len(phases)))
    per = {}
    for lab, a, b in periods:  # as research4.run_metrics, with every cash-in event (sim payout, live withdrawal, bonus)
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
        mvals = np.array([months[m] for m in sorted(months)])
        roll = np.array([mvals[j:j + 12].sum() for j in range(len(mvals) - 11)]) if len(mvals) >= 12 else np.array([mvals.sum()])
        pd_ = sorted(days[k - k_start] for k in pays if i0 <= k - k_start <= i1)
        pts = [dt.date.fromisoformat(days[i0])] + [dt.date.fromisoformat(x) for x in pd_] + [dt.date.fromisoformat(days[i1])]
        gap = max((pts[j + 1] - pts[j]).days for j in range(len(pts) - 1)) / 30.44
        fy = [yrs[y]["net"] for y in FULL.get(lab, []) if y in yrs]
        per[lab] = dict(M=float(pn.sum() / span), W=float(min(fy)) if fy else float("nan"),
                        L=float(sum(x < 0 for x in fy)), D=drop, worst12=float(roll.min()), gap=gap,
                        months_paid=100.0 * len({x[:7] for x in pd_}) / len(months),
                        evals_yr=sum(1 for k, kind, _, _ in ev if kind == "buy" and i0 <= k - k_start <= i1) / span)
    out["periods"] = per
    months = {}
    for i, d in enumerate(days):
        months[d[:7]] = months.get(d[:7], 0.0) + net[i]
    out["months"] = months
    return out


def _init(dd):
    S = Sessions(load_npz(os.path.join(dd, "NQFUT.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5)
    _G["S"] = S
    _G["k0"] = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))
    _G["k5"] = int(np.searchsorted(S.days, np.datetime64(START5).astype(int)))


def start(window, off):
    return (_G["k0"] if window == "all" else _G["k5"]) + off


# model -> (sim_live arguments, FundedAccount changes)
MODELS = {"cycle": (dict(live=False), {}), "live": (dict(live=True, restart="all"), {}),
          "side": (dict(live=True, restart="first"), {}), "stop4": (dict(live=False), dict(max_pay=4))}


def _job(args):
    model, cons, window, off, N = args
    S = _G["S"]
    ek = dict(E_KW, **({} if cons == 0.4 else dict(cons=cons)))
    k0 = start(window, off)
    kw, fx = MODELS[model]
    ev, ph = sim_live(S, k0, len(S.days), ek, dict(F_KW, **fx), N=N, max_total=2 * N, **kw)
    res = {f"split{int(100 * s)}": metrics(S, ev, ph, k0, len(S.days), s, PERIODS[window]) for s in (0.8, 0.9)}
    return (model, cons, window, off, N), res


def self_check():
    """live=False must give research4.sim_pool's events exactly, and metrics() research4.run_metrics' figures."""
    S = _G["S"]
    for window, off, cons in (("5y", 0, 0.4), ("5y", 35, 0.5), ("all", 20, 0.4)):
        ek = dict(E_KW, **({} if cons == 0.4 else dict(cons=cons)))
        k0 = start(window, off)
        a, ph = sim_live(S, k0, len(S.days), ek, F_KW, live=False)
        b = sim_pool(S, N_FUNDED, MAX_TOTAL, k0, len(S.days), ek, F_KW)
        assert a == b, (window, off, cons)
        assert set(ph) == {"S"}
        m1 = metrics(S, a, ph, k0, len(S.days), 0.8, PERIODS[window])
        m2 = run_metrics(S, b, k0, len(S.days), FULL, PERIODS[window])
        for lab in m2["periods"]:
            for key, x in m2["periods"][lab].items():
                y = m1["periods"][lab][key]
                assert (np.isnan(x) and np.isnan(y)) or abs(x - y) < 1e-6, (lab, key, x, y)
        for y, v in m2["years"].items():
            assert abs(v["net"] - m1["years"][y]["net"]) < 1e-6, (y, v["net"], m1["years"][y]["net"])
    k0 = start("5y", 10)
    a, _ = sim_live(S, k0, len(S.days), E_KW, dict(F_KW, max_pay=4), live=False)
    assert a == sim_pool(S, N_FUNDED, MAX_TOTAL, k0, len(S.days), E_KW, dict(F_KW, max_pay=4))
    assert sum(kind == "end:done" for _, kind, _, _ in a) > 0
    for n in (1, 3):
        a, _ = sim_live(S, k0, len(S.days), E_KW, F_KW, live=False, N=n, max_total=2 * n)
        assert a == sim_pool(S, n, 2 * n, k0, len(S.days), E_KW, F_KW), n
    print("self-check passed: live=False = research4.sim_pool (events) and run_metrics (figures), 6 runs", flush=True)


def write(out, name, header, rows):
    with open(os.path.join(out, name), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)
    print(f"wrote {name}: {len(rows)} rows", flush=True)


def main(dd, out):
    os.makedirs(out, exist_ok=True)
    _init(dd)
    S = _G["S"]
    print(f"futures sessions {len(S.days)}: first tradable {iso(S.days[_G['k0']])}, last 5 years from {iso(S.days[_G['k5']])}, "
          f"last {iso(S.days[-1])}; eval price ${FEE:.2f}", flush=True)
    self_check()
    jobs = [(m, c, w, o, 5) for m in MODELS for c in (0.4, 0.5) for w in ("5y", "all") for o in OFFSETS]
    jobs += [(m, c, "5y", o, n) for m in ("cycle", "live", "stop4") for c in (0.4, 0.5) for o in OFFSETS for n in (1, 2, 3, 4)]
    with MP(4, initializer=_init, initargs=(dd,)) as mp:
        res_n = dict(mp.map(_job, jobs, chunksize=2))
    json.dump({f"{m}|{c}|{w}|{o}|{n}": v for (m, c, w, o, n), v in res_n.items()}, open(os.path.join(out, "runs.json"), "w"))
    res = {(m, c, w, o): v for (m, c, w, o, n), v in res_n.items() if n == 5}
    lines = []

    def say(s=""):
        print(s, flush=True)
        lines.append(s)
    variants = [("cycle", "split80", "Accounts cycle for ever (every earlier backtest; not Lucid's rules)"),
                ("live", "split80", "Moved live at the first 5th payout; live split 80% (main)"),
                ("live", "split90", "Moved live at the first 5th payout; live split 90%"),
                ("side", "split80", "Moved live; evals again 2 weeks after the first live loss, beside live (80%)"),
                ("stop4", "split80", "Each account closed after its 4th payout, so none is moved live")]
    srows = []
    for window, lab in (("5y", "last 5y"), ("all", "since 2019")):
        for cons in (0.4, 0.5):
            for model, sk, name in variants:
                R = [res[(model, cons, window, o)][sk] for o in OFFSETS]
                g = lambda key: float(np.mean([r["periods"][lab][key] for r in R]))  # noqa: E731
                L = [r["live"] for r in R]
                fm = [x["first_move_days"] for x in L if x["first_move_days"] is not None]
                life = [((lv["end"] if lv["end"] is not None else len(S.days) - 1) - lv["open"]) for x in L for lv in x["lives"]]
                wd_acct = [lv["wd"] for x in L for lv in x["lives"]]
                yrs_span = np.mean([x["sessions"] for x in L]) / 252.0
                srows.append([window, lab, "50% add-on" if cons == 0.5 else "40% (standard)", model, sk[5:], name,
                              round(g("M")), round(g("W")), round(g("worst12")), round(g("D")), round(g("gap"), 1),
                              round(g("months_paid"), 1), round(g("evals_yr"), 1),
                              round(float(np.mean([x["moves"] for x in L])), 2),
                              round(float(np.median(fm))) if fm else "", len(fm),
                              round(float(np.mean([x["opened"] for x in L])), 2),
                              round(float(np.median(life)), 1) if life else "",
                              round(float(np.median(wd_acct))) if wd_acct else "",
                              round(100 * float(np.mean([x["sessions_live_only"] / x["sessions"] for x in L])), 1),
                              round(100 * float(np.mean([x["sessions_waiting"] / x["sessions"] for x in L])), 1),
                              round(float(np.mean([x["sim_payouts"] for x in L])) / yrs_span, 1),
                              round(float(np.mean([sum(lv["bonus"] > 0 for lv in x["lives"]) for x in L])), 2),
                              round(float(np.mean([r["total"] for r in R]))), round(float(np.mean([r["cash_low"] for r in R])))])
                say(f"{lab:10s} {'add-on' if cons == 0.5 else '40%   '} {name[:62]:62s} net ${g('M'):>9,.0f}/yr | worst year "
                    f"${g('W'):>8,.0f} | worst 12m ${g('worst12'):>8,.0f} | gap {g('gap'):4.1f} mo | moves {srows[-1][13]} "
                    f"| first move {srows[-1][14]} d ({len(fm)}/12) | live accts {srows[-1][16]}, life {srows[-1][17]} sessions, "
                    f"withdrawn ${srows[-1][18]} each | live-only {srows[-1][19]}% of sessions")
    write(out, "live_summary.csv", ["window", "period", "eval_rule", "model", "live_split_pct", "description",
                                    "net_per_year_usd", "worst_full_year_usd", "worst_12_months_usd", "deepest_drop_usd",
                                    "longest_gap_months", "months_with_cash_pct", "evals_per_year", "moves_live",
                                    "first_move_days_median", "paths_moved_live_of_12", "live_accounts_opened",
                                    "live_account_life_sessions_median", "live_withdrawn_per_account_gross_median_usd",
                                    "live_only_sessions_pct", "waiting_sessions_pct", "sim_payouts_per_year",
                                    "live_bonuses_paid",
                                    "total_net_usd", "most_cash_out_usd"], srows)
    yrows = []
    for cons in (0.4, 0.5):
        for model, sk, name in variants:
            R = [res[(model, cons, "5y", o)][sk] for o in OFFSETS]
            for y in ("2021", "2022", "2023", "2024", "2025", "2026"):
                v = [r["years"][y] for r in R if y in r["years"]]
                med = lambda key: float(np.median([x[key] for x in v]))  # noqa: E731
                yrows.append(["50% add-on" if cons == 0.5 else "40% (standard)", model, sk[5:], y,
                              "Nov 15 - Dec 31" if y == "2021" else "Jan 1 - Nov 17" if y == "2026" else "full year",
                              round(med("net")), round(min(x["net"] for x in v)), round(max(x["net"] for x in v)),
                              round(med("sim_payouts_net")), round(med("live_wd_net")), round(med("bonus_net")),
                              med("evals_bought"), med("moves"), med("live_opened"), med("sessions_live_only")])
    write(out, "live_years.csv", ["eval_rule", "model", "live_split_pct", "year", "period", "net_median_usd", "net_lowest_usd",
                                  "net_highest_usd", "sim_payouts_net_median_usd", "live_withdrawals_net_median_usd",
                                  "live_bonus_net_median_usd", "evals_bought_median", "moves_live_median",
                                  "live_accounts_opened_median", "live_only_sessions_median"], yrows)
    prow = []
    for cons in (0.4, 0.5):
        for o in OFFSETS:
            r = res[("live", cons, "5y", o)]["split80"]
            x = r["live"]
            for i, lv in enumerate(x["lives"]):
                prow.append(["50% add-on" if cons == 0.5 else "40% (standard)", iso(S.days[start("5y", o)]), i + 1,
                             iso(S.days[lv["open"]]), iso(S.days[lv["end"]]) if lv["end"] is not None else "still open",
                             lv["how"], ((lv["end"] if lv["end"] is not None else len(S.days) - 1) - lv["open"]),
                             round(lv["wd"]), round(0.8 * lv["wd"]), round(lv["bonus"] * SPLIT)])
    write(out, "live_paths.csv", ["eval_rule", "start", "live_account", "opened", "ended", "how", "sessions", "withdrawn_gross_usd",
                                  "withdrawn_net_80_usd", "bonus_net_usd"], prow)
    # ---- the website's overview: N funded + N evals under Lucid's rule (live split 80%), and 5 + 5 the other ways
    lrows = []
    for cons, tag in ((0.4, ""), (0.5, "-addon")):
        for model, n, rid in ([("live", n, f"B{n}{tag}") for n in range(1, 6)]
                              + [("stop4", 5, f"B5{tag}-stop4"), ("cycle", 5, f"B5{tag}-cycle")]):
            R = [res_n[(model, cons, "5y", o, n)]["split80"] for o in OFFSETS]
            g = lambda key: float(np.mean([r["periods"]["last 5y"][key] for r in R]))  # noqa: E731
            ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
            mv = np.array([v for r in R for m, v in r["months"].items() if "2022-01" <= m <= "2026-10"])
            L = [r["live"] for r in R]
            fm = [x["first_move_days"] for x in L if x["first_move_days"] is not None]
            lrows.append([rid, n, "50% add-on" if cons == 0.5 else "40% (standard)",
                          {"live": "Lucid's rules: moved live at the first 5th payout", "stop4": "Each account closed after its 4th payout",
                           "cycle": "Accounts cycle for ever (not Lucid's rules)"}[model],
                          round(g("M")), round(g("W")), round(g("L"), 2), round(g("D")), round(g("worst12")), round(g("gap"), 1),
                          round(g("months_paid"), 1), round(g("evals_yr"), 1), round(float(np.mean([r["cash_low"] for r in R]))),
                          round(float(np.mean([r["total"] for r in R]))),
                          round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                          round(100 * float(np.mean(mv > 0)), 1), round(float(np.percentile(mv, 50))), round(float(np.percentile(mv, 10))),
                          round(float(np.mean([x["moves"] for x in L])), 2), round(float(np.mean([x["opened"] for x in L])), 2),
                          round(float(np.median(fm))) if fm else "",
                          round(float(np.mean([sum(lv["bonus"] > 0 for lv in x["lives"]) for x in L])), 2)])
    write(out, "lucid_5y.csv", ["id", "accounts", "eval_rule", "model", "net_per_year_usd", "worst_full_year_usd", "losing_full_years",
                                "deepest_drop_usd", "worst_12_months_usd", "longest_gap_months", "months_with_payout_pct",
                                "evals_per_year", "most_cash_out_usd", "total_net_5y_usd", "eval_pass_pct", "months_positive_pct",
                                "month_p50_usd", "month_p10_usd", "moves_live", "live_accounts_opened", "first_move_days_median",
                                "live_bonuses_paid"], lrows)
    wy = []
    for y in ("2021", "2022", "2023", "2024", "2025", "2026"):
        row = [y if y not in ("2021", "2026") else y + (" (from Nov 15)" if y == "2021" else " (to Nov 17)")]
        for cons in (0.4, 0.5):
            for model in ("live", "stop4", "cycle"):
                v = [res[(model, cons, "5y", o)]["split80"]["years"][y]["net"] for o in OFFSETS
                     if y in res[(model, cons, "5y", o)]["split80"]["years"]]
                row.append(round(float(np.median(v))))
        R = [res[("live", 0.4, "5y", o)]["split80"]["years"][y] for o in OFFSETS if y in res[("live", 0.4, "5y", o)]["split80"]["years"]]
        row += [float(np.median([x["moves"] for x in R])), float(np.median([x["evals_bought"] for x in R])),
                float(np.median([x["sim_payouts"] for x in R]))]
        wy.append(row)
    write(out, "lucid_5y_years.csv", ["year", "b5_live_usd", "b5_stop4_usd", "b5_cycle_usd", "b5_addon_live_usd", "b5_addon_stop4_usd",
                                      "b5_addon_cycle_usd", "b5_live_moves", "b5_live_evals_bought", "b5_live_payouts"], wy)
    for r in lrows:
        say(f"overview {r[0]:16s} net ${r[4]:>8,}/yr | worst year ${r[5]:>8,} | worst 12m ${r[8]:>8,} | gap {r[9]} mo | "
            f"months positive {r[15]}% (median month ${r[16]:,}, 1 in 10 below ${r[17]:,}) | moves {r[18]} | most cash out ${r[12]:,}")
    open(os.path.join(out, "summary.txt"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
