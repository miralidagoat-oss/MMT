#!/usr/bin/env python3
"""The indicator's default plan (ONR Book v2.3, 50% add-on edition), trade by trade: one full simulated history.

usage: ONR_EVAL_FEE_50K=80.50 python3 export_v23.py FUT_DATA_DIR OUT_DIR
  FUT_DATA_DIR: NQFUT.npz (prep_nqfut.py) and SPXUSD.npz.

The plan: Lucid Flex 50K, evals with the 50% consistency add-on, 5 funded + 5 evals (Lucid's maximum: 10 accounts,
at most 5 funded), one new eval a session, each funded account closed right after its 4th payout (so no 5th payout
moves the trader live), maximum-allowed payouts, $1.34 commission per MNQ round turn, 90% payout split, evals at
the 50K price of account.RULES ($80.50 with ONR_EVAL_FEE_50K=80.50). Real NQ futures 5-minute bars (prep_nqfut.py:
to Aug 9 2024, then the Nasdaq-100 CFD and real MNQ to Nov 17 2026). One path: the first start date of the last-5-years
window, Nov 15 2021 (the website's figures are the mean of 12 start dates; live50k.py).

The run is research4.sim_pool's own loop with recording added; it is checked to give sim_pool's events exactly. Every
trade's entry, exit and reason are recomputed with the engine's functions and checked to reproduce the P&L the
simulator booked. Writes trades.csv, ledger.csv, accounts.csv and check.txt into OUT_DIR.
"""
import csv
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402
from account import RULES, EvalAccount, FundedAccount, eval_bracket, funded_size, is_half  # noqa: E402
from engine import PV, Sessions, Win, bracket_exit, load_npz, news_night  # noqa: E402
from research4 import E_KW, F_KW, FEE, SPLIT, sim_pool  # noqa: E402

START = "2021-11-15"
EK = dict(E_KW, cons=0.5)
FK = dict(F_KW, max_pay=4)
N, MAX_TOTAL = 5, 10
R50 = RULES[50]
M = R50["mll"] / 1000.0


def iso(d):
    return str(np.datetime64(int(d), "D"))


def pyr_detail(S, d, side):
    """engine.pyramid's path (stop 0.35, add 0.15 with the gap fix, trail 0.25, no slippage): entries, exit, reason."""
    r = S.S[d]
    A, w = r["adr"], r["od"]["w"]
    E1 = r["od"]["E"]
    stp, best, ents = E1 - side * 0.35 * A, E1, [E1]
    for j in range(len(w.o)):
        hit = w.l[j] <= stp if side == 1 else w.h[j] >= stp
        if hit:
            op = w.o[j]
            px = op if (side == 1 and op <= stp) or (side == -1 and op >= stp) else stp
            return ents, px, "stop / trail"
        fav = w.h[j] if side == 1 else w.l[j]
        if (fav - best) * side > 0:
            best = fav
        if len(ents) == 1 and (best - E1) * side >= 0.15 * A:
            lvl = E1 + side * 0.15 * A
            gap = (side == 1 and w.o[j] > lvl) or (side == -1 and w.o[j] < lvl)
            ents.append(w.o[j] if gap else lvl)
            if (E1 - stp) * side > 0:
                stp = E1
        ts = best - side * 0.25 * A
        if (ts - stp) * side > 0:
            stp = ts
    return ents, w.xc, "time 16:00"


def ib_detail(S, d, only_side):
    """engine.ib_breakout's fill and exit (stop 0.25, target 0.5 ADR, no slippage): side, entry, exit, reason."""
    r = S.S[d]
    o, h, l, c, _ = r["rng"]
    ib, A = r["ib"], r["adr"]
    buy, sell = ib["H"] + engine.TK, ib["L"] - engine.TK
    for j in range(ib["arm"] + 1, ib["end"] + 1):
        hu = h[j] >= buy and only_side >= 0
        hd = l[j] <= sell and only_side <= 0
        if hu and hd:
            return None
        if hu or hd:
            side = 1 if hu else -1
            E = max(buy, o[j]) if hu else min(sell, o[j])
            if (side == 1 and E - l[j] >= 0.25 * A) or (side == -1 and h[j] - E >= 0.25 * A):
                return side, E, E - side * 0.25 * A, "stopped in its fill bar"
            w = Win(o[j + 1:ib["eod"] + 1], h[j + 1:ib["eod"] + 1], l[j + 1:ib["eod"] + 1], c[j + 1:ib["eod"] + 1])
            px, why = bracket_exit(w, side, E, 0.25 * A, 0.5 * A, 0.0)
            return side, E, px, {"time": "time 16:00"}.get(why, why)
    return None


def run(S, k0):
    """research4.sim_pool(S, 5, 10, k0, end, EK, FK) with every trade recorded."""
    funded, evals, ev, ready, nid = [], [], [], 0, 0
    queue, origin, recs, etrades = [], {}, {}, []
    for k in range(k0, len(S.days)):
        d = S.days[k]
        while ready and len(funded) < N:
            nid += 1
            recs[nid] = []
            funded.append((FundedAccount(S, record=recs[nid], **FK), nid))
            origin[nid] = queue.pop(0)
            ev.append((k, "fund", nid, 0.0))
            ready -= 1
        for _ in range(max(0, min(1, MAX_TOTAL - len(funded) - len(evals) - ready))):
            nid += 1
            evals.append((EvalAccount(S, **EK), nid, k))
            ev.append((k, "buy", nid, 0.0))
        keep = []
        for f, aid in funded:
            evn, amt = f.step(d)
            if amt > 0:
                ev.append((k, "payout", aid, amt))
            if evn is None:
                keep.append((f, aid))
            else:
                ev.append((k, "end:" + ("abandoned" if evn == "dead" else evn), aid, 0.0))
        funded = keep
        keep = []
        for e, aid, ks in evals:
            pre = (e.pnl, e.peak, e.best, e.trades)
            res = e.step(d)
            if e.trades > pre[3]:
                etrades.append((k, aid, pre, e.pnl - pre[0]))
            if res == "pass":
                ready += 1
                queue.append(aid)
                ev.append((k, "pass", aid, float(k - ks + 1)))
            elif res is None:
                keep.append((e, aid, ks))
            else:
                ev.append((k, "fail", aid, float(k - ks + 1)))
        evals = keep
    return ev, recs, etrades, origin


def main(dd, out):
    os.makedirs(out, exist_ok=True)
    S = Sessions(load_npz(os.path.join(dd, "NQFUT.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5)
    k0 = int(np.searchsorted(S.days, np.datetime64(START).astype(int)))
    ev, recs, etrades, origin = run(S, k0)
    assert ev == sim_pool(S, N, MAX_TOTAL, k0, len(S.days), EK, FK), "the recorded run differs from research4.sim_pool"
    comm = FK["comm"]
    trades = []  # date, account, phase, trade, side, contracts per entry, entry, add entry, exit, reason, pnl
    worst = 0.0
    for k, aid, (pnl0, peak0, best0, _), day in etrades:
        d = S.S[S.days[k]]
        fl = 100.0 if peak0 >= R50["mll"] + 100.0 else peak0 - R50["mll"]
        cushion = pnl0 - fl
        side = S.on_side(S.days[k])
        leg = "on" if side != 0 and not news_night(S.days[k]) else "od"
        if leg == "od":
            assert not is_half(S.days[k])
            side = S.od_side(S.days[k], EK.get("od_k", 0.10))
        n, sd, td = eval_bracket(d["adr"], cushion, best0, pnl0, EK["cons"], 1.0, True, comm, 50, 1.0)
        E = d[leg]["E"]
        px, why = bracket_exit(d[leg]["w"], side, E, sd, td, 0.0)
        p = (px - E) * side * n * PV - n * comm
        worst = max(worst, abs(p - day))
        reason = {"time": "time 09:30" if leg == "on" else "time 16:00"}.get(why, why)
        trades.append((iso(S.days[k]), f"E{aid}", "Eval", "Overnight (18:10)" if leg == "on" else "Opening drive (09:35)",
                       side, n, E, None, px, reason, p))
    for aid, rec in recs.items():
        for dd_, leg, side, p in rec:
            d = S.S[dd_]
            n = funded_size(d["adr"], FK["adr_ref"] * M, nmax=R50["fundmax"])
            if leg == "on":
                E = d["on"]["E"]
                px, why = bracket_exit(d["on"]["w"], side, E, 0.5 * d["adr"], np.inf, 0.0)
                q = ((px - E) * side * PV - comm) * n
                row = ("Overnight (18:10)", side, n, E, None, px, {"time": "time 09:30"}.get(why, why))
            elif leg == "pyr":
                ents, px, why = pyr_detail(S, dd_, side)
                q = (sum((px - e) * side for e in ents) * PV - len(ents) * comm) * n
                row = ("Pyramid (09:35)", side, n, ents[0], ents[1] if len(ents) > 1 else None, px, why)
            else:
                det = ib_detail(S, dd_, S.od_side(dd_))
                assert det is not None and det[0] == side
                _, E, px, why = det
                q = ((px - E) * side * PV - comm) * n
                row = ("IB breakout (10:30-13:00)", side, n, E, None, px, why)
            worst = max(worst, abs(q - p))
            trades.append((iso(dd_), f"F{aid}", "Funded") + row + (p,))
    assert worst < 1e-6, f"recomputed trades differ from the simulator by up to ${worst}"
    order = {"Overnight (18:10)": 0, "Opening drive (09:35)": 1, "Pyramid (09:35)": 1, "IB breakout (10:30-13:00)": 2}
    trades.sort(key=lambda t: (t[0], order[t[3]], t[2] != "Eval", int(t[1][1:])))
    with open(os.path.join(out, "trades.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["session", "account", "phase", "trade", "side", "contracts_per_entry", "entry", "add_entry", "exit",
                    "exit_reason", "pnl_usd"])
        for t in trades:
            w.writerow([t[0], t[1], t[2], t[3], "BUY" if t[4] == 1 else "SELL", t[5], round(t[6], 4),
                        "" if t[7] is None else round(t[7], 4), round(t[8], 4), t[9], round(t[10], 2)])
    # ledger and accounts
    lab = {"buy": "Eval bought", "pass": "Eval passed", "fail": "Eval failed", "fund": "Funded account started",
           "payout": "Payout", "end:done": "Closed after its 4th payout", "end:blown": "Blown (max loss)",
           "end:abandoned": "Stopped: cushion below $400"}
    with open(os.path.join(out, "ledger.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["session", "account", "event", "gross_usd", "to_you_usd"])
        for k, kind, aid, v in ev:
            acct = f"F{aid}" if kind in ("fund", "payout") or kind.startswith("end:") else f"E{aid}"
            gross = v if kind == "payout" else (-FEE if kind == "buy" else 0.0)
            you = SPLIT * v if kind == "payout" else (-FEE if kind == "buy" else 0.0)
            w.writerow([iso(S.days[k]), acct, lab[kind], round(gross, 2), round(you, 2)])
    ev_by = {}
    for k, kind, aid, v in ev:
        ev_by.setdefault(aid, []).append((k, kind, v))
    fund_of = {e: f for f, e in origin.items()}
    with open(os.path.join(out, "accounts.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["eval", "bought", "eval_result", "eval_result_session", "eval_sessions", "funded", "funded_start",
                    "funded_end", "funded_end_session"])
        for aid in sorted(a for a, es in ev_by.items() if es[0][1] == "buy"):
            es = ev_by[aid]
            res = [(k, kind, v) for k, kind, v in es if kind in ("pass", "fail")]
            fa = fund_of.get(aid)
            fe = ev_by.get(fa, []) if fa else []
            start = [k for k, kind, _ in fe if kind == "fund"]
            end = [(k, kind) for k, kind, _ in fe if kind.startswith("end:")]
            w.writerow([f"E{aid}", iso(S.days[es[0][0]]), {"pass": "passed", "fail": "failed"}[res[0][1]] if res else "open",
                        iso(S.days[res[0][0]]) if res else "", int(res[0][2]) if res else "",
                        f"F{fa}" if fa else "", iso(S.days[start[0]]) if start else "",
                        lab[end[0][1]] if end else ("still open" if fa else ""), iso(S.days[end[0][0]]) if end else ""])
    pays = [v for _, kind, _, v in ev if kind == "payout"]
    msg = (f"path from {iso(S.days[k0])} to {iso(S.days[-1])}: {len(trades)} trades ({len(etrades)} eval, "
           f"{len(trades) - len(etrades)} funded), {sum(kind == 'buy' for _, kind, _, _ in ev)} evals bought, "
           f"{sum(kind == 'pass' for _, kind, _, _ in ev)} passed, {len(pays)} payouts (${sum(pays):,.0f} gross), "
           f"net to you ${SPLIT * sum(pays) - FEE * sum(kind == 'buy' for _, kind, _, _ in ev):,.0f}; "
           f"events = research4.sim_pool's; trades recomputed to within ${worst:.2e}")
    open(os.path.join(out, "check.txt"), "w").write(msg + "\n")
    print(msg)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
