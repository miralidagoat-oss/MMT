#!/usr/bin/env python3
"""Every number behind the dashboard's charts, with the costs itemised, at Lucid Flex 50K with the shipped v2.2 rules:
the 60 days of real MNQ futures (Yahoo 5-minute bars, Sep 9 - Nov 17 2026) and the last 4 years (Nasdaq-100 CFD
minute bars, Nov 14 2022 - Nov 13 2026).

usage: export_charts.py DATA_DIR OUT_DIR

Costs: $1.34 per MNQ round turn (inside every trade's net), Lucid keeps 10% of each payout, $115 per eval (list price).
Commission per trade = the same trade replayed with commission 0, minus the trade with $1.34 (commission never changes
a fill or a decision of the day, so the two runs take the same trades). The script checks its totals against
mnq_real50k.py and report50k.py before writing.
"""
import csv
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account  # noqa: E402
from account import RULES, EvalAccount, FundedAccount, funded_size, run_eval  # noqa: E402
from engine import Sessions, load_npz, rth_sessions  # noqa: E402
from portfolio import pool  # noqa: E402

COMM = 1.34
FEE = RULES[50]["price"]
SPLIT = 0.9
E_KW = dict(improved=True, comm=COMM, size=50)
F_KW = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=COMM, size=50, payout_max=True)
LEG = {"on": "Overnight", "pyr": "Pyramid", "ib": "IB breakout"}
WHY = {"stop": "stop", "target": "target", "time": "time exit", "stop-fillbar": "stop (fill bar)", "none": "time exit"}

# ---- cost bookkeeping: wrap the leg functions the account module calls (results are passed through unchanged)
TRADES = []   # (gross, net, exit reason) of each funded-leg trade, in call order
PAID = [0.0]  # commission paid by every account, evals included


def _wrap(fn):
    def w(*a, **kw):
        res = fn(*a, **kw)
        if res is None or res[1] == "both-skip":
            return res
        gross = fn(*a, **dict(kw, comm=0.0))[0]
        TRADES.append((gross, res[0], res[1]))
        PAID[0] += gross - res[0]
        return res
    return w


account.funded_on = _wrap(account.funded_on)
account.pyramid = _wrap(account.pyramid)
account.ib_breakout = _wrap(account.ib_breakout)
_eval_bracket = account.eval_bracket


def _eval_bracket_paid(*a, **kw):
    res = _eval_bracket(*a, **kw)  # an eval trade always follows: n contracts x commission (positional arg 7)
    PAID[0] += res[0] * (a[7] if len(a) > 7 else kw.get("comm", 1.0))
    return res


account.eval_bracket = _eval_bracket_paid


def day(d):
    return str(np.datetime64(int(d), "D"))


def r2(x):
    return round(float(x), 2) + 0.0  # + 0.0 turns -0.0 into 0.0


def write(out, name, cols, rows):
    with open(os.path.join(out, name + ".csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(cols)
        w.writerows(rows)
    print(f"  {name}.csv: {len(rows)} rows")


def book(S, ks):
    """One funded 50K account trading every session with the full day budget (a fresh account each day)."""
    trades, days, cum = [], [], 0.0
    for k in ks:
        d = S.days[k]
        adr = S.S[d]["adr"]
        rec = []
        TRADES.clear()
        FundedAccount(S, record=rec, **F_KW).step(d)
        assert len(rec) == len(TRADES), (day(d), rec, TRADES)
        n = funded_size(adr, 350.0 * 2, nmax=RULES[50]["fundmax"]) if not np.isnan(adr) else 0
        g_day = c_day = n_day = 0.0
        for (_, leg, side, net), (gross, net2, why) in zip(rec, TRADES):
            assert abs(net - net2) < 1e-9
            comm = gross - net
            cum += net
            g_day += gross
            c_day += comm
            n_day += net
            trades.append([len(trades) + 1, day(d), LEG[leg], "BUY" if side > 0 else "SELL", int(round(comm / COMM)),
                           WHY.get(why, why), r2(gross), r2(-comm), r2(net), r2(cum)])
        days.append([day(d), r2(adr) if not np.isnan(adr) else "", n, len(rec), r2(g_day), r2(-c_day), r2(n_day), r2(cum)])
    return trades, days


def journey(S, k0, k1):
    """One account slot from session k0: buy an eval, trade it, fund it, take every payout, start over when it ends.
    Daily rows: phase, account P&L vs its start (after payouts), payout requested, your cash (90% of payouts - fees)."""
    rows, cash, k, nacct = [], 0.0, k0, 0
    while k < k1:
        nacct += 1
        ev = EvalAccount(S, **E_KW)
        cash -= FEE
        bought = True
        res = None
        while k < k1:
            res = ev.step(S.days[k])
            if res == "dead":
                break
            rows.append([day(S.days[k]), f"eval {nacct}", r2(ev.pnl), 0.0, 1 if bought else 0, r2(cash),
                         {"pass": "eval passed", "fail": "eval failed"}.get(res, "")])
            bought = False
            k += 1
            if res is not None:
                break
        if res != "pass":
            if res is None:
                break
            continue
        fu = FundedAccount(S, **F_KW)
        while k < k1:
            evn, amt = fu.step(S.days[k])
            if evn == "dead":
                rows[-1][6] = (rows[-1][6] + "; " if rows[-1][6] else "") + "funded account abandoned (cushion below $400)"
                break
            cash += SPLIT * amt
            note = f"payout {fu.npay} requested" if amt > 0 else ""
            if evn == "done":
                note += "; 5th payout: account finished"
            elif evn == "blown":
                note = "max loss hit: account closed"
            rows.append([day(S.days[k]), f"funded {nacct}", r2(fu.pnl), r2(amt), 0, r2(cash), note.strip("; ")])
            k += 1
            if evn is not None:
                break
    return rows


def pool_rows(S, k0, k1):
    PAID[0] = 0.0
    run = pool(S, k_start=k0, k_stop=k1, eval_kw=E_KW, funded_kw=F_KW)
    paid = PAID[0]
    by = {}
    for k, _, a in run["payouts"]:
        x = by.setdefault(k, [0, 0.0, 0])
        x[0] += 1
        x[1] += a
    for k in run["eval_buys"]:
        by.setdefault(k, [0, 0.0, 0])[2] += 1
    rows, cum = [], 0.0
    for k in range(k0, k1):
        npay, amt, nev = by.get(k, [0, 0.0, 0])
        net = SPLIT * amt - FEE * nev
        cum += net
        rows.append([day(S.days[k]), npay, r2(amt), r2(-(1 - SPLIT) * amt), nev, r2(-FEE * nev), r2(net), r2(cum)])
    gross = sum(a for _, _, a in run["payouts"])
    return rows, dict(payouts=len(run["payouts"]), gross=gross, evals=len(run["eval_buys"]), paid=paid,
                      net=SPLIT * gross - FEE * len(run["eval_buys"]))


def main(dd, out):
    os.makedirs(out, exist_ok=True)
    TC = ["trade", "date", "trade_type", "side", "mnq_traded", "exit", "gross_usd", "commission_usd", "net_usd",
          "running_net_usd"]
    DC = ["date", "adr_points", "mnq_per_leg", "trades", "gross_usd", "commission_usd", "net_usd", "running_net_usd"]
    JC = ["date", "phase", "account_pnl_usd", "payout_usd", "eval_bought", "your_cash_usd", "event"]
    PC = ["date", "payouts", "payouts_usd", "lucid_share_usd", "evals_bought", "eval_fees_usd", "net_usd", "running_net_usd"]

    # ================= 60 days of real MNQ futures
    mnq = load_npz(os.path.join(dd, "MNQ_5m_60d.npz"))
    own = rth_sessions(*mnq)
    src = {d: v for d, v in rth_sessions(*load_npz(os.path.join(dd, "NSXUSD.npz"))).items() if d < min(own)}
    src.update(own)
    R = Sessions(mnq, load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5, adr_src=src)
    m0 = int(np.argmax([not np.isnan(R.S[d]["adr"]) and not np.isnan(R.S[d]["score"]) for d in R.days]))
    kr = range(m0, len(R.days))
    print(f"real MNQ: {day(R.days[m0])} -> {day(R.days[-1])}, {len(kr)} sessions")
    rt, rd = book(R, kr)
    assert abs(sum(t[8] for t in rt) - 17568) < 1.0 and len(rt) == 71, sum(t[8] for t in rt)
    write(out, "real_trades", TC, rt)
    write(out, "real_days", DC, rd)
    ev = [(k, run_eval(R, k, **E_KW)) for k in kr]
    write(out, "real_evals", ["start_date", "result", "sessions", "trades", "end_date"],
          [[day(R.days[k]), r["result"], r["days"], r["trades"], day(R.days[min(r["k_end"], len(R.days) - 1)])] for k, r in ev])
    PAID[0] = 0.0
    ja = journey(R, m0, len(R.days))
    j_paid = PAID[0]
    j_pay = [x[3] for x in ja if x[3] > 0]
    assert [round(p) for p in j_pay] == [1136, 1280, 2000] and abs(ja[-1][5] - 3859.4) < 1.0, (j_pay, ja[-1])
    write(out, "real_account", JC, ja)
    rp, rs = pool_rows(R, m0, len(R.days))
    assert rs["payouts"] == 15 and round(rs["gross"]) == 21677 and rs["evals"] == 10 and abs(rs["net"] - 18359.3) < 1.0, rs
    write(out, "real_pool", PC, rp)

    # ================= last 4 years (CFD minute bars)
    S = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)
    k4 = int(np.searchsorted(S.days, np.datetime64("2022-11-14").astype(int)))
    k4s = range(k4, len(S.days))
    print(f"4 years: {day(S.days[k4])} -> {day(S.days[-1])}, {len(k4s)} sessions")
    bt, bd = book(S, k4s)
    by_year = {}
    for t in bt:
        by_year[t[1][:4]] = by_year.get(t[1][:4], 0.0) + t[8]
    want = {"2022": 4044, "2023": -3204, "2024": 27634, "2025": 15355, "2026": 35600}  # years.csv book_net_usd
    assert all(abs(by_year[y] - v) < 1.0 for y, v in want.items()), by_year
    write(out, "book_trades", TC, bt)
    write(out, "book_days", DC, bd)
    bp, bs = pool_rows(S, k4, len(S.days))
    assert abs(bs["net"] - 201371) < 2.0, bs  # kpis.csv pool_total
    PAID[0] = 0.0
    js = journey(S, k4, len(S.days))
    s_paid = PAID[0]
    write(out, "slot_4y", JC, js)

    # ================= costs, side by side
    def jsum(rows):
        pay = sum(x[3] for x in rows)
        ev_n = sum(x[4] for x in rows)
        return pay, ev_n

    rpay, rev = jsum(ja)
    spay, sev = jsum(js)
    cost = []

    def block(item_id, setup, item, a, b):
        cost.append([item_id, setup, item, round(a), round(b)])  # whole dollars, as the page prints them

    bk = "One funded account, every session"
    block("book_gross", bk, "Trading profit before commission", sum(t[6] for t in rt), sum(t[6] for t in bt))
    block("book_comm", bk, "Commission at $1.34 per MNQ round turn", sum(t[7] for t in rt), sum(t[7] for t in bt))
    block("book_net", bk, "Trading profit after commission", sum(t[8] for t in rt), sum(t[8] for t in bt))
    sl = "One account slot (new eval whenever one ends)"
    block("slot_payouts", sl, "Payouts requested", rpay, spay)
    block("slot_lucid", sl, "Lucid's 10% share", -(1 - SPLIT) * rpay, -(1 - SPLIT) * spay)
    block("slot_fees", sl, "Eval fees at $115", -FEE * rev, -FEE * sev)
    block("slot_net", sl, "Net to you", SPLIT * rpay - FEE * rev, SPLIT * spay - FEE * sev)
    block("slot_comm", sl, "Commission paid in the accounts (already taken out before the payouts)", -j_paid, -s_paid)
    pl = "5 funded accounts + evals"
    block("pool_payouts", pl, "Payouts requested", rs["gross"], bs["gross"])
    block("pool_lucid", pl, "Lucid's 10% share", -(1 - SPLIT) * rs["gross"], -(1 - SPLIT) * bs["gross"])
    block("pool_fees", pl, "Eval fees at $115", -FEE * rs["evals"], -FEE * bs["evals"])
    block("pool_net", pl, "Net to you", rs["net"], bs["net"])
    block("pool_comm", pl, "Commission paid in the accounts (already taken out before the payouts)", -rs["paid"], -bs["paid"])
    write(out, "costs", ["item_id", "setup", "item", "real_60d_usd", "last_4y_usd"], cost)

    # ================= single figures for the new sections
    rn = np.array([t[8] for t in rt])
    dn = np.array([x[6] for x in rd if x[3] > 0])
    done = [r for _, r in ev if r["result"] != "open"]
    npass = sum(r["result"] == "pass" for r in done)
    legs = {}
    for t in rt:
        legs.setdefault(t[2], []).append(t[8])
    K = [["real", "real_sessions", "Sessions in the window", len(kr), "count", "Sep 9 - Nov 17 2026"],
         ["real", "real_trades", "Trades, one funded account", len(rt), "count", ""],
         ["real", "real_win", "Winning trades", 100 * np.mean(rn > 0), "pct", ""],
         ["real", "real_net", "Trading profit after commission", rn.sum(), "usd", ""],
         ["real", "real_comm", "Commission paid", -sum(t[7] for t in rt), "usd", ""],
         ["real", "real_days_traded", "Days with a trade", len(dn), "count", ""],
         ["real", "real_days_pos", "Traded days positive", 100 * np.mean(dn > 0), "pct", ""],
         ["real", "real_best_day", "Best day", dn.max(), "usd", ""],
         ["real", "real_worst_day", "Worst day", dn.min(), "usd", ""],
         ["real", "real_evals_done", "Evals finished", len(done), "count", "one started every session"],
         ["real", "real_evals_pass", "Evals passed", npass, "count", ""],
         ["real", "real_eval_rate", "Eval pass rate", 100 * npass / len(done), "pct", ""],
         ["real", "real_slot_net", "Net to you, one account bought Sep 9", SPLIT * rpay - FEE * rev, "usd", ""],
         ["real", "real_slot_payouts", "Payouts, one account bought Sep 9", len([x for x in ja if x[3] > 0]), "count", ""],
         ["real", "real_pool_net", "Net to you, 5 funded accounts + evals", rs["net"], "usd", ""],
         ["real", "real_pool_payouts", "Payouts, 5 funded accounts + evals", rs["payouts"], "count", ""],
         ["real", "real_pool_evals", "Evals bought, 5 funded accounts + evals", rs["evals"], "count", ""],
         ["4y", "book_commission", "Commission paid, one funded account, 4 years", -sum(t[7] for t in bt), "usd", ""],
         ["4y", "book_trades_n", "Trades, one funded account, 4 years", len(bt), "count", ""],
         ["4y", "pool_total_net", "Net to you, 5 funded + evals, 4 years", bs["net"], "usd", ""],
         ["4y", "pool_total_payouts", "Payouts, 5 funded + evals, 4 years", bs["payouts"], "count", ""],
         ["4y", "pool_total_evals", "Evals bought, 5 funded + evals, 4 years", bs["evals"], "count", ""]]
    for name, v in sorted(legs.items()):
        key = {"Overnight": "on", "Pyramid": "pyr", "IB breakout": "ib"}[name]
        v = np.array(v)
        K.append(["real", f"real_{key}_n", f"{name} trades", len(v), "count", ""])
        K.append(["real", f"real_{key}_win", f"{name} winners", 100 * np.mean(v > 0), "pct", ""])
        K.append(["real", f"real_{key}_net", f"{name} net", v.sum(), "usd", ""])
    shown = {"usd": lambda v: round(v), "pct": lambda v: round(v, 1), "count": lambda v: int(round(v))}  # as printed
    write(out, "real_kpis", ["section", "metric", "label", "value", "unit", "note"],
          [[a, b, c, shown[u](v), u, n] for a, b, c, v, u, n in K])
    lg = []
    for name in ("Overnight", "Pyramid", "IB breakout"):
        sel = [t for t in rt if t[2] == name]
        lg.append([name, len(sel), round(100 * np.mean([t[8] > 0 for t in sel]), 1), round(sum(t[6] for t in sel)),
                   round(sum(t[7] for t in sel)), round(sum(t[8] for t in sel))])
    lg.append(["All trades", len(rt), round(100 * np.mean([t[8] > 0 for t in rt]), 1), round(sum(t[6] for t in rt)),
               round(sum(t[7] for t in rt)), round(sum(t[8] for t in rt))])
    write(out, "real_legs", ["trade_type", "trades", "win_pct", "gross_usd", "commission_usd", "net_usd"], lg)
    print("checks passed: real 71 trades +$17,568; account 3 payouts, net $3,859; pool 15 payouts, net $18,359; "
          "4-year book by year = years.csv; 4-year pool net = $201,371")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
