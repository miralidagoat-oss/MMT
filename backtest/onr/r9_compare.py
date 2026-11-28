#!/usr/bin/env python3
"""Round 9 follow-up: the trade-by-trade export another assistant asked for, to find where its engine and ours split on
the blind rebuild ("ONR-B"), and how far our 2024-26 figures move under other readings of the blind settings.

usage: python3 -I r9_compare.py export FUT_DATA_DIR OUT_DIR [YYYY-MM]    # every trade of a month, 1 MNQ a leg
       python3 -I r9_compare.py readings FUT_DATA_DIR OUT_DIR           # 2024-26 daily Sharpe, other readings
       python3 -I r9_compare.py cutoff FUT_DATA_DIR OUT_DIR             # the overnight cutoff, fixed vs expanding
       python3 -I r9_compare.py dll FUT_DATA_DIR OUT_DIR                # Lucid's $600 soft daily limit at 25K
       python3 -I r9_compare.py nights FUT_DATA_DIR OUT_DIR             # the blind overnight nights of 2024-26

export: one row per trade of each version ("blind60" = ONR-B with ONR's 60-minute IB, as round 9 ran it; "asbuilt" =
the book; "their_reading" = ONR-B with the other assistant's reading of its settings, see VER), 1 MNQ a leg (each
repeated add one more contract), $1.00 a round turn, prices and times as the engine fills them (5-minute bars; market entries
at the event bar's close; stops at the stop or the bar's open if it gapped through; IB targets need a 1-tick
trade-through). Each row's P&L is the engine's own (engine.funded_on / pyramid / ib_breakout), and the exit bar found
here must give the same P&L. taken_50k / taken_25k: whether a fresh funded account's daily risk budget ($1,200 at
50K, $600 at 25K; round 9's rule: the overnight trade's risk is reserved first, capped to the budget in the blind
version, then each leg in entry order if its risk still fits) would have taken the trade at 1 MNQ a leg.
"""
import csv
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r9_honest as H  # noqa: E402
import research7 as R7  # noqa: E402
from account import COMM_RT, funded_size, is_half  # noqa: E402
from engine import PV, funded_on, ib_breakout, pyramid, sess_cols  # noqa: E402

VER = {"blind60": dict(k=0.05, stop=0.50, add=0.10, trail=0.50, thr=H.THR_B, on_stop=1.0),
       "asbuilt": dict(k=0.10, stop=0.35, add=0.15, trail=0.25, thr=None, on_stop=0.5),
       # ONR-B read the other assistant's way (readings' "all three together"): one more contract at every further
       # 0.10 ADR of open profit, the IB only on days with a drive (on its side), the overnight stop capped at $600 a contract
       "their_reading": dict(k=0.05, stop=0.50, add=0.10, trail=0.50, thr=H.THR_B, on_stop=1.0, on_cap=600.0, multi=True,
                             ib_drive_only=True)}


def usd(x):
    """-$124.00 / $2,290.05"""
    return ("-" if x < 0 else "") + f"${abs(x):,.2f}"


def clock(d, j, end=False):
    """NY wall-clock time of 5-minute slot j of session d (the bar's open; its close with end=True)."""
    t = int(d) * 1440 - 360 + 5 * j + (5 if end else 0)
    return str(np.datetime64(t, "m")).replace("T", " ")


def _pyr(O, H_, L, C, i, s, A_, stop, add, trail):
    """engine.pyramid (fix_gap) on the 5-minute arrays with its add and exit: (add slot, add price, exit slot, exit
    price, reason, P&L of 1 contract)."""
    E1 = C[i, 186]
    stp = E1 - s * stop * A_
    best = E1
    ents, add_at = [E1], (None, None)
    pnl = lambda px: sum((px - e) * s for e in ents) * PV - len(ents) * COMM_RT  # noqa: E731
    for j in range(187, 264):
        if np.isnan(O[i, j]):
            continue
        if (s == 1 and L[i, j] <= stp) or (s == -1 and H_[i, j] >= stp):
            op = O[i, j]
            px = op if (s == 1 and op <= stp) or (s == -1 and op >= stp) else stp
            return add_at + (j, px, "stop" if len(ents) == 1 and stp == E1 - s * stop * A_ else "stop/trail", pnl(px))
        fav = H_[i, j] if s == 1 else L[i, j]
        if (fav - best) * s > 0:
            best = fav
        if len(ents) == 1 and (best - E1) * s >= add * A_:
            lvl = E1 + s * add * A_
            gap = (s == 1 and O[i, j] > lvl) or (s == -1 and O[i, j] < lvl)
            ents.append(O[i, j] if gap else lvl)
            add_at = (j, ents[-1])
            if (E1 - stp) * s > 0:
                stp = E1
        ts = best - s * trail * A_
        if (ts - stp) * s > 0:
            stp = ts
    for j in range(263, 186, -1):
        if not np.isnan(O[i, j]):
            break
    return add_at + (j, C[i, j], "time 16:00", pnl(C[i, j]))


def month_trades(D, month):
    S = D.S
    O, H_, L, C = D.O, D.H, D.L, D.C
    rows = []
    for i, d in enumerate(D.days):
        d = int(d)
        if str(np.datetime64(d, "D"))[:7] != month or d not in S.S or np.isnan(D.adr[i]):
            continue
        A_ = D.adr[i]
        date = str(np.datetime64(d, "D"))
        for ver, p in VER.items():
            day = []
            # overnight: 18:10 the evening before -> 09:30
            side = S.on_side(d) if p["thr"] is None else S.on_side(d, p["thr"])
            if side != 0:
                r = S.S[d]["on"]
                j0 = int(sess_cols(np.array([r["t"]]))[0][0] // 5)
                dist = min(p["on_stop"] * A_, p["on_cap"] / PV) if "on_cap" in p else p["on_stop"] * A_
                pnl = funded_on(S, d, side, 0.0, dist / A_, n=1, comm=COMM_RT)[0]
                px, why, jj = R7._manage(O, H_, L, C, i, side, r["E"], r["E"] - side * dist, np.nan, j0 + 1, 186, 2, 1)
                assert abs((px - r["E"]) * side * PV - COMM_RT - pnl) < 1e-6, (d, ver, "on")
                day.append(dict(date=date, version=ver, leg="overnight", side="BUY" if side == 1 else "SELL",
                                signal=f"score {S.S[d]['score']:+.4f}", adr=round(A_, 2), entry_time=clock(d, j0, True),
                                entry_price=r["E"], adds=0, add_time="", add_price="", stop_points=round(dist, 2), target_points="",
                                exit_time=clock(d, jj, True) if why in (0, 3) else clock(d, jj) + " bar",
                                exit_price=round(px, 2), exit_reason="stop" if why == 1 else "time 09:30", pnl_usd=round(pnl, 2),
                                risk_usd=round(dist * PV, 2), key=float(j0) - 400.0, sd=side, xkey=float(jj) - 400.0))
            half = is_half(d)
            sd = S.od_side(d, p["k"])
            if sd != 0 and not half:
                if p.get("multi"):
                    adds, jx, px, why, pnl = _pyr_multi_trade(O, H_, L, C, i, sd, A_, p["stop"], p["add"], p["trail"])
                    pnl2 = _pyr_multi(O, H_, L, C, i, sd, A_, p["stop"], p["add"], p["trail"])
                    pnl3 = H._pyr_multi_exit(O, H_, L, C, i, sd, A_, p["stop"], p["add"], p["trail"])[1]
                    assert abs(pnl - pnl2) < 1e-6 and abs(pnl - pnl3) < 1e-6, (d, ver, "pyr", pnl, pnl2, pnl3)
                else:
                    pnl = pyramid(S, d, sd, 0.0, stop=p["stop"], add=p["add"], trail=p["trail"], n=1, comm=COMM_RT, fix_gap=True)[0]
                    ja, pa, jx, px, why, pnl2 = _pyr(O, H_, L, C, i, sd, A_, p["stop"], p["add"], p["trail"])
                    assert abs(pnl - pnl2) < 1e-6, (d, ver, "pyr", pnl, pnl2)
                    adds = [] if ja is None else [(ja, pa)]
                mv = (C[i, 186] - S.S[d]["rOpen"]) / A_
                day.append(dict(date=date, version=ver, leg="pyramid", side="BUY" if sd == 1 else "SELL",
                                signal=f"first 5 min {mv:+.3f} ADR", adr=round(A_, 2), entry_time=clock(d, 186, True),
                                entry_price=C[i, 186], adds=len(adds), add_time="; ".join(clock(d, ja)[11:] + " bar" for ja, _ in adds),
                                add_price="; ".join(f"{pa:.2f}" for _, pa in adds), stop_points=round(p["stop"] * A_, 2), target_points="",
                                exit_time=clock(d, jx, True) if why.startswith("time") else clock(d, jx) + " bar", exit_price=round(px, 2),
                                exit_reason=why, pnl_usd=round(pnl, 2), risk_usd=round(p["stop"] * A_ * PV, 2), key=186.9, sd=sd,
                                xkey=jx + 0.5 if not why.startswith("time") else 263.9))
            if "ib" in S.S[d] and not half and (sd != 0 or not p.get("ib_drive_only")):
                res = ib_breakout(S, d, 0.0, stop=0.25, tgt=0.50, n=1, comm=COMM_RT, only_side=sd)
                if res is not None and res[1] != "both-skip":
                    ib = S.S[d]["ib"]
                    buy, sell = ib["H"] + 0.25, ib["L"] - 0.25
                    s_, j, E = R7._stop_entry(O, H_, L, i, buy if sd >= 0 else np.nan, sell if sd <= 0 else np.nan, 198, 227)
                    assert s_ == res[2]
                    if res[1] == "stop-fillbar":
                        px, why, jj = E - s_ * 0.25 * A_, 1, j
                    else:
                        px, why, jj = R7._manage(O, H_, L, C, i, s_, E, E - s_ * 0.25 * A_, E + s_ * 0.50 * A_, j, 264, 1, 1)
                    assert abs((px - E) * s_ * PV - COMM_RT - res[0]) < 1e-6, (d, ver, "ib", px, E, res)
                    day.append(dict(date=date, version=ver, leg="IB", side="BUY" if s_ == 1 else "SELL",
                                    signal=f"range {ib['L']:.2f}-{ib['H']:.2f}" + ("" if sd == 0 else " (drive's side only)"),
                                    adr=round(A_, 2), entry_time=clock(d, j) + " bar", entry_price=round(E, 2), adds=0, add_time="", add_price="",
                                    stop_points=round(0.25 * A_, 2), target_points=round(0.50 * A_, 2),
                                    exit_time=clock(d, jj) + " bar" if why in (1, 2) else clock(d, jj, True), exit_price=round(px, 2),
                                    exit_reason={1: "stop", 2: "target"}.get(why, "time 16:00"), pnl_usd=round(res[0], 2),
                                    risk_usd=round(0.25 * A_ * PV, 2), key=j + 0.5, sd=s_, xkey=jj + 0.5 if why in (1, 2) else 263.9))
            # a fresh funded account's daily risk budget at 1 MNQ a leg, in entry order (round 9's rule)
            for lab, budget in (("taken_50k", 1200.0), ("taken_25k", 600.0)):
                used, taken = 0.0, []
                for t in sorted(day, key=lambda x: x["key"]):
                    rk = t["risk_usd"]
                    if t["leg"] == "overnight" and ver != "asbuilt":
                        rk = min(rk, budget)          # the blind overnight stop is capped to the budget
                    ok = used + rk <= budget + 1e-9 and not any(ts != t["sd"] and tk <= t["key"] < tx for tk, ts, tx in taken)
                    t[lab] = "yes" if ok else "no (budget)" if used + rk > budget + 1e-9 else "no (opposite position)"
                    if ok:
                        used += rk
                        taken.append((t["key"], t["sd"], t["xkey"]))
                    if t["leg"] == "overnight" and ver != "asbuilt" and rk < t["risk_usd"]:
                        cap = funded_on(S, d, t["sd"], 0.0, budget / PV / A_, n=1, comm=COMM_RT)[0]
                        t[lab] += f" (stop capped to ${budget:,.0f}: P&L {usd(cap)})"
            rows += day
    return rows


FIELDS = ["date", "version", "leg", "side", "signal", "adr", "entry_time", "entry_price", "adds", "add_time", "add_price", "stop_points",
          "target_points", "exit_time", "exit_price", "exit_reason", "pnl_usd", "risk_usd", "taken_50k", "taken_25k"]


def export(fd, out, month="2026-10"):
    D = H.init(fd)
    rows = month_trades(D, month)
    os.makedirs(out, exist_ok=True)
    for ver in VER:
        with open(os.path.join(out, f"trades_{month}_{ver}.csv"), "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore", lineterminator="\n")
            w.writeheader()
            w.writerows([r for r in rows if r["version"] == ver])
    summ = {}
    for ver in VER:
        R = [r for r in rows if r["version"] == ver]
        s = {leg: dict(trades=sum(1 for r in R if r["leg"] == leg), pnl_usd=round(sum(r["pnl_usd"] for r in R if r["leg"] == leg), 2))
             for leg in ("overnight", "pyramid", "IB")}
        s["all"] = dict(trades=len(R), pnl_usd=round(sum(r["pnl_usd"] for r in R), 2))
        for lab in ("taken_50k", "taken_25k"):
            s[lab] = dict(trades=sum(1 for r in R if r[lab].startswith("yes")),
                          blocked=sum(1 for r in R if r[lab].startswith("no")))
        summ[ver] = s
    sessions = sorted({r["date"] for r in rows})
    summ["sessions_with_a_trade"] = len(sessions)
    json.dump(summ, open(os.path.join(out, f"trades_{month}_summary.json"), "w"), indent=1)
    print(json.dumps(summ, indent=1))


# ------------------------------------------------------------------------------------------------ other readings
def _pyr_multi(O, H_, L, C, i, s, A_, stop, add, trail):
    """'add every 0.10 ADR' read as repeated adds: one more contract at each further 0.10 ADR of open profit, the stop
    to breakeven at the first add, then the trail."""
    E1 = C[i, 186]
    stp = E1 - s * stop * A_
    best = E1
    ents = [E1]
    pnl = lambda px: sum((px - e) * s for e in ents) * PV - len(ents) * COMM_RT  # noqa: E731
    last = 186
    for j in range(187, 264):
        if np.isnan(O[i, j]):
            continue
        last = j
        if (s == 1 and L[i, j] <= stp) or (s == -1 and H_[i, j] >= stp):
            op = O[i, j]
            return pnl(op if (s == 1 and op <= stp) or (s == -1 and op >= stp) else stp)
        fav = H_[i, j] if s == 1 else L[i, j]
        if (fav - best) * s > 0:
            best = fav
        while (best - E1) * s >= len(ents) * add * A_:
            lvl = E1 + s * len(ents) * add * A_
            gap = (s == 1 and O[i, j] > lvl) or (s == -1 and O[i, j] < lvl)
            ents.append(O[i, j] if gap else lvl)
            if (E1 - stp) * s > 0:
                stp = E1
        ts = best - s * trail * A_
        if (ts - stp) * s > 0:
            stp = ts
    return pnl(C[i, last])


def _pyr_multi_trade(O, H_, L, C, i, s, A_, stop, add, trail):
    """_pyr_multi with its adds and exit: ([(add slot, add price), ...], exit slot, exit price, reason, P&L)."""
    E1 = C[i, 186]
    stp0 = stp = E1 - s * stop * A_
    best = E1
    ents, adds = [E1], []
    pnl = lambda px: sum((px - e) * s for e in ents) * PV - len(ents) * COMM_RT  # noqa: E731
    last = 186
    for j in range(187, 264):
        if np.isnan(O[i, j]):
            continue
        last = j
        if (s == 1 and L[i, j] <= stp) or (s == -1 and H_[i, j] >= stp):
            op = O[i, j]
            px = op if (s == 1 and op <= stp) or (s == -1 and op >= stp) else stp
            return adds, j, px, "stop" if stp == stp0 else "stop/trail", pnl(px)
        fav = H_[i, j] if s == 1 else L[i, j]
        if (fav - best) * s > 0:
            best = fav
        while (best - E1) * s >= len(ents) * add * A_:
            lvl = E1 + s * len(ents) * add * A_
            gap = (s == 1 and O[i, j] > lvl) or (s == -1 and O[i, j] < lvl)
            ents.append(O[i, j] if gap else lvl)
            adds.append((j, ents[-1]))
            if (E1 - stp) * s > 0:
                stp = E1
        ts = best - s * trail * A_
        if (ts - stp) * s > 0:
            stp = ts
    return adds, last, C[i, last], "time 16:00", pnl(C[i, last])


def readings(fd, out):
    """2024 - Nov 20 2026 (and Dec 2019 - Dec 2023), 1 MNQ a leg, no account rules: the blind rebuild as round 9 read it,
    and under each other reading of its settings, alone and together."""
    D = H.init(fd)
    S = D.S
    O, H_, L, C = D.O, D.H, D.L, D.C
    B = VER["blind60"]
    cols = {}
    days = []
    for i, d in enumerate(D.days):
        d = int(d)
        if d not in S.S or np.isnan(D.adr[i]):
            continue
        A_ = D.adr[i]
        days.append(d)
        half = is_half(d)
        sd = S.od_side(d, B["k"])
        side = S.on_side(d, B["thr"])
        on = funded_on(S, d, side, 0.0, 1.0, n=1, comm=COMM_RT)[0] if side else 0.0
        on_cap = funded_on(S, d, side, 0.0, min(1.0, 300.0 / A_), n=1, comm=COMM_RT)[0] if side else 0.0
        pyr = pyr_m = 0.0
        if sd != 0 and not half:
            pyr = pyramid(S, d, sd, 0.0, stop=B["stop"], add=B["add"], trail=B["trail"], n=1, comm=COMM_RT, fix_gap=True)[0]
            pyr_m = _pyr_multi(O, H_, L, C, i, sd, A_, B["stop"], B["add"], B["trail"])
        ib = ib_d = 0.0
        if "ib" in S.S[d] and not half:
            res = ib_breakout(S, d, 0.0, stop=0.25, tgt=0.50, n=1, comm=COMM_RT, only_side=sd)
            ib = res[0] if res is not None and res[1] != "both-skip" else 0.0
            ib_d = ib if sd != 0 else 0.0
        for name, v in (("as read in round 9", on + pyr + ib),
                        ("repeated adds every 0.10 ADR", on + pyr_m + ib),
                        ("no IB on days without a drive", on + pyr + ib_d),
                        ("overnight stop capped at $600 a contract", on_cap + pyr + ib),
                        ("all three together", on_cap + pyr_m + ib_d),
                        ("as read, without the overnight trade", pyr + ib)):
            cols.setdefault(name, []).append(v)
    iso = np.array([str(np.datetime64(d, "D")) for d in days])
    res = {}
    for w, a, b in (("2024 - Nov 20 2026", "2024-01-01", "2026-12-31"), ("Dec 2019 - Dec 2023", "2019-12-01", "2023-12-31")):
        m = (iso >= a) & (iso <= b)
        for name, v in cols.items():
            x = np.array(v)[m]
            sh = x.mean() / x.std(ddof=1)
            res[f"{name} | {w}"] = dict(sessions=int(m.sum()), usd_per_day=round(float(x.mean()), 2), daily_sharpe=round(float(sh), 3),
                                        t=round(float(sh * np.sqrt(len(x))), 2))
    json.dump(res, open(os.path.join(out, "readings.json"), "w"), indent=1)
    for k, v in res.items():
        print(k, v)


def cutoff(fd, out):
    """The blind overnight trade's cutoff: round 9's fixed 0.8985 (the 0.80 quantile of |score| on the S&P sessions
    before 2024) against the other assistant's expanding cutoff (the 0.80 quantile of every earlier night's |score|,
    from Feb 2011 on our S&P input). The leg alone at 1 MNQ, stop 1.0 ADR, no day budget, per window: trades, dollars,
    dollars a trade and a session, t on trades; and the expanding cutoff on a few dates."""
    D = H.init(fd)
    S = D.S
    keys = np.array(sorted(k for k, v in S.score_raw.items() if not np.isnan(v)))
    vals = np.abs(np.array([S.score_raw[k] for k in keys]))
    days = [int(d) for d in S.days if int(d) in S.S]
    thr = {d: float(np.quantile(vals[: np.searchsorted(keys, d)], 0.80)) for d in days}
    rows = {}
    for d in days:
        if np.isnan(S.S[d]["adr"]):
            continue
        for name, t in (("fixed 0.8985", H.THR_B), ("expanding", thr[d])):
            sd = S.on_side(d, t)
            rows.setdefault(name, {})[d] = (sd, funded_on(S, d, sd, 0.0, 1.0, n=1, comm=COMM_RT)[0] if sd else 0.0)
    res = {}
    for w, a, b in (("2021-2023", "2021-01-01", "2023-12-31"), ("2024 - Nov 20 2026", "2024-01-01", "2026-12-31"),
                    ("Dec 2019 - Dec 2023", "2019-12-01", "2023-12-31")):
        for name, R in rows.items():
            ds = [d for d in R if a <= str(np.datetime64(d, "D")) <= b]
            tr = np.array([R[d][1] for d in ds if R[d][0] != 0])
            res[f"{name} | {w}"] = dict(sessions=len(ds), trades=int(len(tr)), usd=round(float(tr.sum()), 2),
                                        usd_per_trade=round(float(tr.mean()), 2), usd_per_session=round(float(tr.sum() / len(ds)), 2),
                                        t=round(float(tr.mean() / tr.std(ddof=1) * np.sqrt(len(tr))), 2),
                                        same_side_as_fixed=int(sum(1 for d in ds if R[d][0] == rows["fixed 0.8985"][d][0] != 0)))
    marks = {}
    for iso in ("2021-01-04", "2024-01-02", "2025-01-02", "2026-01-02", "2026-10-26"):
        d = int(np.datetime64(iso, "D").astype(int))
        d = min(x for x in days if x >= d)
        marks[str(np.datetime64(d, "D"))] = dict(expanding_cutoff=round(thr[d], 4), score=round(float(S.S[d]["score"]), 4))
    res["cutoff on"] = marks
    json.dump(res, open(os.path.join(out, "cutoff.json"), "w"), indent=1)
    for k, v in res.items():
        print(k, v)


# ------------------------------------------------------------------------------------------------ Lucid's daily limit
def _leg_path(H_, L, i, s, ents, j_first, jx, pnl, stopped, ncol, lag=0):
    """A leg's value per contract at every 5-minute slot of the session: 0 before its first bar; then the open P&L at
    each bar's worst price; at the exit bar the realized P&L if it was stopped, else the lower of the open value and
    the realized P&L; after it, the realized P&L (commission included). ents: (slot, price, filled inside that bar).
    lag 0 counts a fill inside a bar from that bar (as if the bar's worst price came after it: the worst order); lag 1
    from the next bar (the best order). 5-minute bars cannot tell which."""
    v = np.zeros(ncol)
    prev = 0.0
    for j in range(j_first, jx + 1):
        if np.isnan(L[i, j]):
            v[j] = prev
            continue
        w = L[i, j] if s == 1 else H_[i, j]
        ow = sum(s * (w - e) * PV for ja, e, inside in ents if ja + (lag if inside else 0) <= j)
        v[j] = ow if j < jx else (pnl if stopped else min(ow, pnl))
        prev = v[j]
    v[jx + 1:] = pnl
    return v


HALTS = set()


def _day(D, i, d, ver, n, rule, room=600.0):
    """One session of a fresh funded Lucid 25K account (budget $600, n MNQ a leg) under a day rule ("risk": the
    indicator's, each leg's planned risk held all day; "net": the other assistant's, open risk + new risk - the day's
    realized P&L must fit): the legs taken, the day's P&L and its value path (realized + open, worst prices)."""
    S = D.S
    O, H_, L, C = D.O, D.H, D.L, D.C
    p = VER[ver]
    A_ = D.adr[i]
    ncol = O.shape[1]
    legs = []                                     # (key, xkey, side, risk $, pnl $ per contract, path per contract)
    side = S.on_side(d) if p["thr"] is None else S.on_side(d, p["thr"])
    if side != 0:
        r = S.S[d]["on"]
        j0 = int(sess_cols(np.array([r["t"]]))[0][0] // 5)
        dist = p["on_stop"] * A_ if ver == "asbuilt" else min(p["on_stop"] * A_, room / (n * PV))
        if ver != "asbuilt" or dist * PV * n <= room:
            pnl = funded_on(S, d, side, 0.0, dist / A_, n=1, comm=COMM_RT)[0]
            if ver == "asbuilt":
                assert abs(pnl - H.LEGS["asbuilt"][d]["on"][side]) < 1e-6, (d, "on")
            px, why, jj = R7._manage(O, H_, L, C, i, side, r["E"], r["E"] - side * dist, np.nan, j0 + 1, 186, 2, 1)
            if abs((px - r["E"]) * side * PV - COMM_RT - pnl) > 1e-6:
                # the limit-down halts of March 2020 (Mar 9, 13, 16): the night's bars end early and the engine prices
                # the exit after the halt; the path runs to the halt and the realized P&L is the engine's
                assert why == 3 and str(np.datetime64(d, "D"))[:7] == "2020-03", (d, why)
                HALTS.add(str(np.datetime64(d, "D")))
            legs.append((float(j0) - 400.0, float(jj) - 400.0, side, dist * PV, pnl,
                         *(_leg_path(H_, L, i, side, [(j0 + 1, r["E"], False)], j0 + 1, jj, pnl, why == 1, ncol, g) for g in (0, 1))))
    half = is_half(d)
    sd = S.od_side(d, p["k"])
    src = "asbuilt" if ver == "asbuilt" else "B60"
    if sd != 0 and not half:
        ja, pa, jx, px, why, pnl = _pyr(O, H_, L, C, i, sd, A_, p["stop"], p["add"], p["trail"])
        ref = H.LEGS[src][d]["pyr"]
        assert ref is not None and abs(ref[4] - pnl) < 1e-6 and ref[2] == sd, (d, ver, "pyr")
        ents = [(187, C[i, 186], False)] + ([(ja, pa, True)] if ja is not None else [])
        legs.append((ref[0], ref[5], sd, p["stop"] * A_ * PV, pnl,
                     *(_leg_path(H_, L, i, sd, ents, 187, jx, pnl, not why.startswith("time"), ncol, g) for g in (0, 1))))
    if "ib" in S.S[d] and not half:
        res = ib_breakout(S, d, 0.0, stop=0.25, tgt=0.50, n=1, comm=COMM_RT, only_side=sd)
        if res is not None and res[1] != "both-skip":
            ib = S.S[d]["ib"]
            s_, j, E = R7._stop_entry(O, H_, L, i, ib["H"] + 0.25 if sd >= 0 else np.nan, ib["L"] - 0.25 if sd <= 0 else np.nan, 198, 227)
            if res[1] == "stop-fillbar":
                px, why, jj = E - s_ * 0.25 * A_, 1, j
            else:
                px, why, jj = R7._manage(O, H_, L, C, i, s_, E, E - s_ * 0.25 * A_, E + s_ * 0.50 * A_, j, 264, 1, 1)
            ref = H.LEGS[src][d]["ib"]
            assert ref is not None and abs(ref[4] - res[0]) < 1e-6 and ref[2] == s_, (d, ver, "ib")
            legs.append((ref[0], ref[5], s_, 0.25 * A_ * PV, res[0],
                         *(_leg_path(H_, L, i, s_, [(j, E, True)], j, jj, res[0], why == 1, ncol, g) for g in (0, 1))))
    # the budget, in entry order (the overnight first, as the pools take it)
    taken, used = [], 0.0
    for key, xk, sd_, rk1, pnl, path, path1 in sorted(legs, key=lambda x: x[0]):
        rk = rk1 * n
        if rule == "net" and taken:
            real = sum(t[4] * n for t in taken if t[1] <= key)
            ok = sum(t[3] * n for t in taken if t[1] > key) + rk - real <= room + 1e-9
        else:
            ok = used + rk <= room + 1e-9
        if not ok or any(t[2] != sd_ and t[0] <= key < t[1] for t in taken):
            continue
        used += rk
        taken.append((key, xk, sd_, rk1, pnl, path, path1))
    if not taken:
        return 0.0, None, None, []
    return n * sum(t[4] for t in taken), n * sum(t[5] for t in taken), n * sum(t[6] for t in taken), taken


def dll(fd, out):
    """Lucid Flex 25K with the daily loss limit on (the user's accounts): a $600 soft limit on realized plus open P&L
    over the session from 18:00, which flattens everything and locks the account out until the next session. The
    indicator's day budget holds at most $600 of planned risk at 25K and every leg's loss stops at its stop, so the
    limit can only be touched as a stop fills, or by commission or a gap. Checked on every session of the MNQ file for a
    fresh funded 25K account (budget $600, contracts by ADR as the pools size them), as built and blind, under the
    indicator's rule and the other assistant's: the lowest realized-plus-open value inside each session (5-minute bars,
    open legs at each bar's worst price), the sessions that reach -$600, and what flattening there would change."""
    D = H.init(fd)
    S = D.S
    res = {}
    for ver in ("asbuilt", "blind60"):
        for rule in ("risk", "net"):
            low, worst, touch, ndays, near = 0.0, None, [], 0, 0
            for i, d in enumerate(D.days):
                d = int(d)
                if d not in S.S or np.isnan(D.adr[i]):
                    continue
                n = funded_size(D.adr[i], 350.0, nmax=10)
                pnl, val, val1, taken = _day(D, i, d, ver, n, rule)
                if val is None:
                    continue
                ndays += 1
                vmin, vmin1 = float(val.min()), float(val1.min())
                if vmin < low:
                    low, worst = vmin, (str(np.datetime64(d, "D")), round(vmin, 2), round(pnl, 2), n, len(taken))
                near += vmin <= -550.0
                if vmin <= -600.0:
                    iso = str(np.datetime64(d, "D"))
                    kind = ("halt night" if iso in HALTS else "at a stop (the day ends there, commission over $600)"
                            if pnl <= vmin + 0.01 else "in the best order the session stays above -$600" if vmin1 > -600.0
                            else "below -$600 in either order, then recovered")
                    touch.append(dict(date=iso, contracts=n, lowest_worst_order=round(vmin, 2), lowest_best_order=round(vmin1, 2),
                                      day_pnl=round(pnl, 2), kind=kind))
            kinds = {}
            for t in touch:
                kinds[t["kind"]] = kinds.get(t["kind"], 0) + 1
            # flattening at -$600: a day ending below it gains the difference; a day that recovered after touching it
            # would lose the recovery (counted only where the touch holds in the best order too)
            gain = sum(-600.0 - t["day_pnl"] for t in touch if t["day_pnl"] < -600.0)
            lost = sum(-600.0 - t["day_pnl"] for t in touch if t["day_pnl"] > -600.0 and t["lowest_best_order"] <= -600.0)
            unsure = sum(-600.0 - t["day_pnl"] for t in touch if t["day_pnl"] > -600.0 and t["lowest_best_order"] > -600.0)
            res[f"{ver} | {rule}"] = dict(sessions_with_a_leg=ndays, lowest_value=round(low, 2), lowest_session=worst,
                                         sessions_at_or_below_550=int(near), sessions_reaching_600=len(touch), by_kind=kinds,
                                         flattening_gain_usd=round(gain, 2), flattening_cost_usd=round(lost, 2),
                                         cost_if_the_worst_order_is_right_usd=round(unsure, 2), reaching=touch)
            print(ver, rule, res[f"{ver} | {rule}"], flush=True)
    res["halt nights (exit priced by the engine)"] = sorted(HALTS)
    json.dump(res, open(os.path.join(out, "dll.json"), "w"), indent=1)


def nights(fd, out):
    """The blind overnight trade, 2024 - Nov 20 2026, for the other assistant to find the nights its S&P feed drops:
    every night's score (overnight_scores_2024_26.csv) and every trade (overnight_trades_2024_26.csv) at round 9's fixed
    cutoff 0.8985: 1 MNQ, stop 1.0 ADR, no day budget, out at 09:30, $1.00 a round turn, actual prices."""
    D = H.init(fd)
    S = D.S
    O, H_, L, C = D.O, D.H, D.L, D.C
    sc, tr, raw = [], [], []
    for i, d in enumerate(D.days):
        d = int(d)
        iso = str(np.datetime64(d, "D"))
        if d not in S.S or iso < "2024-01-01" or np.isnan(D.adr[i]):
            continue
        score = S.S[d]["score"]
        side = S.on_side(d, H.THR_B)
        sc.append(dict(date=iso, score="" if np.isnan(score) else round(float(score), 4), traded="BUY" if side == 1 else "SELL" if side == -1 else ""))
        if side != 0:
            r = S.S[d]["on"]
            A_ = D.adr[i]
            j0 = int(sess_cols(np.array([r["t"]]))[0][0] // 5)
            pnl = funded_on(S, d, side, 0.0, 1.0, n=1, comm=COMM_RT)[0]
            px, why, jj = R7._manage(O, H_, L, C, i, side, r["E"], r["E"] - side * A_, np.nan, j0 + 1, 186, 2, 1)
            assert abs((px - r["E"]) * side * PV - COMM_RT - pnl) < 1e-6
            raw.append(pnl)
            tr.append(dict(date=iso, entry=clock(d, j0, True), score=round(float(score), 4), side="BUY" if side == 1 else "SELL",
                           adr=round(A_, 2), entry_price=r["E"], exit=clock(d, jj, True) if why != 1 else clock(d, jj) + " bar",
                           exit_price=round(px, 2), exit_reason="stop" if why == 1 else "time 09:30", pnl_usd=round(pnl, 2)))
    for name, rows in (("overnight_scores_2024_26.csv", sc), ("overnight_trades_2024_26.csv", tr)):
        with open(os.path.join(out, name), "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]), lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
    tot = round(float(sum(raw)), 2)
    assert len(tr) == 133 and abs(tot - 10201.82) < 0.01, (len(tr), tot)      # results_r9/cutoff.json, fixed cutoff
    print(len(sc), "nights,", sum(1 for r in sc if r["score"] == ""), "without a score;", len(tr), "trades,", tot, flush=True)
    # 1 MNQ a leg in the other assistant's window (Mar 2021 - Dec 2023), actual prices, no budget and $600 (its rule)
    LG = {"asbuilt": H.LEGS["asbuilt"], "B60": H.LEGS["B60"]}
    unit = {}
    for lim, room in (("none", 1e9), ("risk", 600.0), ("net", 600.0)):
        for tag, on in (("with", "blind"), ("without", None)):
            x = [H.unit_day(S, LG, int(d), "B60", on, "risk" if lim == "none" else lim, room)[0]
                 for d in D.days if int(d) in S.S and not np.isnan(S.S[int(d)]["adr"]) and "2021-03-01" <= str(np.datetime64(int(d), "D")) <= "2023-12-31"]
            unit[f"blind | {lim} | {tag} | Mar 2021 - Dec 2023"] = dict(sessions=len(x), usd_per_day=round(float(np.mean(x)), 2))
    json.dump(unit, open(os.path.join(out, "unit_mar2021.json"), "w"), indent=1)
    for k, v in unit.items():
        print(k, v)


if __name__ == "__main__":
    if sys.argv[1] == "export":
        export(sys.argv[2], sys.argv[3], *(sys.argv[4:5] or ["2026-10"]))
    elif sys.argv[1] == "cutoff":
        cutoff(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "dll":
        dll(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "nights":
        nights(sys.argv[2], sys.argv[3])
    else:
        readings(sys.argv[2], sys.argv[3])
