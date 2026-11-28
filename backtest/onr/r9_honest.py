#!/usr/bin/env python3
"""Round 9 (PREREG_R9.md): the funded overnight trade judged on a blind rebuild of the book ("ONR-B", another
assistant's settings re-chosen on sessions before 2024), next to the book as built, in the user's prop pools.

usage: python3 -I r9_honest.py FUT_DATA_DIR OUT_DIR            # checks, every version x account x window, the table
       python3 -I r9_honest.py facts CFD_DATA_DIR OUT_DIR      # leg facts on the Nasdaq-100 CFD, 2011-2020 (the note's
                                                               # questions): the IB's three versions, the overnight leg
       python3 -I r9_honest.py unit FUT_DATA_DIR OUT_DIR       # the note's headline measure: 1 MNQ a leg, daily Sharpe

Funded accounts (evaluations and Combines trade as built in every version):
- as built: v2.6.6's legs (round 7's per-contract legs, results identical to the published account classes);
- ONR-B: pyramid at a 0.05 ADR drive, stop 0.50, add +0.10, trail 0.50; IB of the 09:30-11:00 range, orders
  11:00-14:00, stop 0.25, target 0.50, the drive's side only on ONR-B's drive days; overnight at the 0.80 quantile of
  |stretch score| before 2024 (THR_B), stop 1.0 ADR capped so its risk fits the day's budget;
- ONR-B with the honest IB: ONR's IB (09:30-10:30 range, orders to 13:00) on ONR-B's drive days.
Each with and without the funded overnight trade; placebos of ONR-B with the honest IB give the noise bands.
Writes versions.json (per version / account / window: mean net a year and worst full year over 12 start dates),
threeyear.json (the note's design: 25 monthly starts Nov 2021 - Nov 2023, 3 years each), r9_table.csv, r9_decision.json.
"""
import csv
import json
import os
import sys
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account as A  # noqa: E402
import r7_accounts as X  # noqa: E402
import research4 as R4  # noqa: E402
import research7 as R7  # noqa: E402
import topstep_sim as T  # noqa: E402
import windows as W  # noqa: E402
from account import COMM_RT, USER_ADDON, USER_EVAL, funded_size, is_half  # noqa: E402
from engine import PV, THR, Sessions, funded_on, ib_breakout, load_npz, pyramid, rth_sessions, score_series  # noqa: E402

B = dict(k=0.05, stop=0.50, add=0.10, trail=0.50, on_stop=1.0)
THR_B = 0.8985                       # the 0.80 quantile of |score| on S&P sessions Feb 2011 - Dec 2023 (checked in main)
LEGS = {}                            # "asbuilt" (round 7's), "B60" (honest IB), "B90" (ONR-B's IB)
IB90 = dict(ib=1020, ibend=1200)     # 11:00 and 14:00, minutes after 18:00


# ------------------------------------------------------------------------------------------------ ONR-B legs
def _pyr_exit(O, H, L, C, i, s, A_, stop, add, trail):
    """engine.pyramid (fix_gap) on the 5-minute arrays: (exit key, P&L of 1 contract) - the key times the leg for the
    no-opposite-position rule; the P&L must equal the engine's."""
    E1 = C[i, 186]
    stp = E1 - s * stop * A_
    best = E1
    ents = [E1]
    pnl = lambda px: sum((px - e) * s for e in ents) * PV - len(ents) * COMM_RT  # noqa: E731
    for j in range(187, 264):
        if np.isnan(O[i, j]):
            continue
        if (s == 1 and L[i, j] <= stp) or (s == -1 and H[i, j] >= stp):
            op = O[i, j]
            px = op if (s == 1 and op <= stp) or (s == -1 and op >= stp) else stp
            return j + 0.5, pnl(px)
        fav = H[i, j] if s == 1 else L[i, j]
        if (fav - best) * s > 0:
            best = fav
        if len(ents) == 1 and (best - E1) * s >= add * A_:
            lvl = E1 + s * add * A_
            gap = (s == 1 and O[i, j] > lvl) or (s == -1 and O[i, j] < lvl)
            ents.append(O[i, j] if gap else lvl)
            if (E1 - stp) * s > 0:
                stp = E1
        ts = best - s * trail * A_
        if (ts - stp) * s > 0:
            stp = ts
    px, _ = X._close_or_last(O, C, i, 263)
    return 263.9, pnl(px)


def _ib_leg(S, O, H, L, C, i, d, A_, side, j0, j1):
    res = ib_breakout(S, d, 0.0, stop=0.25, tgt=0.50, n=1, comm=COMM_RT, only_side=side)
    if res is None or res[1] == "both-skip":
        return None
    ib = S.S[d]["ib"]
    buy, sell = ib["H"] + 0.25, ib["L"] - 0.25
    s_, j, px = R7._stop_entry(O, H, L, i, buy if side >= 0 else np.nan, sell if side <= 0 else np.nan, j0, j1)
    assert s_ == res[2], (d, s_, res)
    if res[1] == "stop-fillbar":
        xk = j + 0.5
    else:
        ex, why, jj = R7._manage(O, H, L, C, i, s_, px, px - s_ * 0.25 * A_, px + s_ * 0.50 * A_, j, 264, 1, 1)
        xk = jj + 0.5 if why in (1, 2) else 263.9
    return (j + 0.5, "ib", s_, 0.25 * A_ * PV, res[0], xk)


def blind_legs(D, S90):
    S = D.S
    O, H, L, C = D.O, D.H, D.L, D.C
    b60, b90 = {}, {}
    n_pyr = n_ib60 = n_ib90 = 0
    for i, d in enumerate(D.days):
        d = int(d)
        r60, r90 = dict(pyr=None, ib=None), dict(pyr=None, ib=None)
        b60[d], b90[d] = r60, r90
        if d not in S.S or np.isnan(D.adr[i]):
            continue
        A_ = D.adr[i]
        assert A_ == S.S[d]["adr"] and A_ == S90.S[d]["adr"]
        sd = S.od_side(d, B["k"])
        if sd != 0:
            pnl = pyramid(S, d, sd, 0.0, stop=B["stop"], add=B["add"], trail=B["trail"], n=1, comm=COMM_RT, fix_gap=True)[0]
            xk, pnl2 = _pyr_exit(O, H, L, C, i, sd, A_, B["stop"], B["add"], B["trail"])
            assert abs(pnl - pnl2) < 1e-6, (d, pnl, pnl2)
            r60["pyr"] = r90["pyr"] = (186.9, "pyr", sd, B["stop"] * A_ * PV, pnl, xk)
            n_pyr += 1
        if "ib" in S.S[d]:
            r60["ib"] = _ib_leg(S, O, H, L, C, i, d, A_, sd, 198, 227)
            n_ib60 += r60["ib"] is not None
        if "ib" in S90.S[d]:
            r90["ib"] = _ib_leg(S90, O, H, L, C, i, d, A_, sd, 204, 239)
            n_ib90 += r90["ib"] is not None
    print(f"ONR-B legs: {n_pyr} pyramid days, {n_ib60} IB trades (60-minute range), {n_ib90} IB trades (90-minute); "
          f"every pyramid's exit replica equals engine.pyramid to the cent", flush=True)
    return b60, b90


# ------------------------------------------------------------------------------------------------ the account
class Funded9(A.FundedAccount):
    """round 7's Funded7 with a choice of leg set (r9src) and of overnight trade (r9on: "book" as built, "blind" =
    ONR-B's capped 1.0 ADR stop at thr, None = skipped)."""

    def __init__(self, S, r9src="asbuilt", r9on="book", **kw):
        super().__init__(S, **kw)
        self.r9src, self.r9on = r9src, r9on
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
            lg = LEGS[self.r9src][int(d)]
            if self.r9on == "book":
                side = S.on_side(d) if self.thr is None else S.on_side(d, self.thr)
                rk = self.on_stop * adr * PV * n
                if side != 0 and used + rk <= room and not (self.on_long_only and side < 0):
                    day += n * LEGS["asbuilt"][int(d)]["on"][side]
                    used += rk
            elif self.r9on == "blind":
                side = S.on_side(d, self.thr)
                if side != 0 and room - used > 0:
                    dist = min(B["on_stop"] * adr, (room - used) / (n * PV))
                    day += n * funded_on(S, d, side, 0.0, dist / adr, n=1, comm=COMM_RT)[0]
                    used += dist * n * PV
            items = []
            if not half:
                items += [x for x in (lg["pyr"], lg["ib"]) if x is not None]
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


# ------------------------------------------------------------------------------------------------ versions, accounts
VERS = {"asbuilt|on": dict(r9src="asbuilt", r9on="book"), "asbuilt|off": dict(r9src="asbuilt", r9on=None),
        "B90|on": dict(r9src="B90", r9on="blind", thr=THR_B), "B90|off": dict(r9src="B90", r9on=None),
        "B60|on": dict(r9src="B60", r9on="blind", thr=THR_B), "B60|off": dict(r9src="B60", r9on=None)}
for _t in (0.8920, 0.8950, 0.9020, 0.9050):
    VERS[f"placebo thr {_t}"] = dict(r9src="B60", r9on="blind", thr=_t)
for _a in (340, 345, 355, 360):
    VERS[f"placebo size {_a}"] = dict(r9src="B60", r9on="blind", thr=THR_B, adr_ref=_a)
ACCTS9 = ("topstep", "lucid_addon", "lucid25_40", "lucid40")
DECIDE = ("topstep", "lucid_addon", "lucid25_40")
WIN9 = dict(X.WINDOWS)
WIN9.pop("oos")
WIN9["2024"] = ([("2024-26", "2024-01-01", "2026-12-31")], {"2024-26": ["2024", "2025"]})


def kwargs9(acct, v):
    if acct == "topstep":
        ek, fk = T.ek(50), T.fk(50, "standard")
    elif acct == "lucid25_40":
        ek, fk = dict(R4.E_KW, size=25), dict(R4.F_KW, size=25, max_pay=4)
    else:
        ek = dict(R4.E_KW, cons=0.5) if acct == "lucid_addon" else dict(R4.E_KW)
        fk = dict(R4.F_KW, max_pay=4)
    ek, fk = dict(ek, slip=0.0, r7trigger=None), dict(fk, slip=0.0)
    for key in ("r9src", "r9on", "thr", "adr_ref"):
        if key in v:
            fk[key] = v[key]
    return ek, fk


def cash(S, k0, ev, acct):
    if acct == "topstep":
        return T.cash_flows(S, k0, ev, "noact", 50)
    fee = {"lucid_addon": USER_EVAL[50] + USER_ADDON, "lucid40": USER_EVAL[50], "lucid25_40": USER_EVAL[25]}[acct]
    return T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=fee)


def start_k(S, window, off):
    if window == "2024":
        return int(np.searchsorted(S.days, np.datetime64("2024-01-02").astype(int))) + off
    return X.start_k(S, window, off)


def job(a):
    v, acct, window, off = a
    S = X.G["D"].S
    ek, fk = kwargs9(acct, VERS[v])
    k0 = start_k(S, window, off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
    per, fy = WIN9[window]
    res = T.summarise_run(S, k0, cash(S, k0, ev, acct), ev, per, fy)["periods"]
    return a, {lab: dict(M=res[lab]["M"], W=res[lab]["W"]) for lab, _, _ in per}


def job3(a):
    """The note's design: one start, 3 years, total net to the trader."""
    v, acct, k0 = a
    S = X.G["D"].S
    ek, fk = kwargs9(acct, VERS[v])
    k1 = int(np.searchsorted(S.days, S.days[k0] + int(3 * 365.25)))
    ev = R4.sim_pool(S, 5, 10, k0, k1, ek, fk)
    return a, float(cash(S, k0, ev, acct)[: k1 - k0].sum())


def init(fd):
    D, P = X.init(fd, 0.0)       # round 7's data and per-contract legs; R4's account classes become Funded7 / Eval7
    S90 = Sessions(D.raw, load_npz(os.path.join(fd, "SPXUSD.npz")), tf=5, ev=IB90, score=(D.S.score_raw, D.S.feats))
    LEGS["asbuilt"] = X.G["legs"]
    LEGS["B60"], LEGS["B90"] = blind_legs(D, S90)
    R4.FundedAccount = Funded9
    return D


def checks(D):
    S = D.S
    # the overnight cutoff is the pre-registered quantile
    sc = np.array([v for k, v in sorted(S.score_raw.items()) if k < np.datetime64("2024-01-01").astype(int) and not np.isnan(v)])
    q80 = float(np.quantile(np.abs(sc), 0.80))
    assert abs(q80 - THR_B) < 5e-5, q80
    print(f"THR_B: the 0.80 quantile of |score| on {len(sc)} S&P sessions before 2024 = {q80:.4f}", flush=True)
    # as built: the new class makes round 7's events exactly, in every round-7 account
    for acct in ("topstep", "lucid_addon", "lucid40"):
        ek, fk = kwargs9(acct, VERS["asbuilt|on"])
        k0 = X.start_k(S, "5y", 0)
        R4.FundedAccount = Funded9
        mine = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
        ek7, fk7 = X.kwargs(acct, {}, 0.0)
        R4.FundedAccount = X.Funded7
        ref = R4.sim_pool(S, 5, 10, k0, len(S.days), ek7, fk7)
        R4.FundedAccount = Funded9
        assert len(mine) == len(ref) and all(a[:3] == b[:3] and abs(a[3] - b[3]) < 1e-6 for a, b in zip(mine, ref)), acct
        print(f"as built = round 7's account class ({acct}): {len(ref)} events identical", flush=True)


def main(fd, out):
    os.makedirs(out, exist_ok=True)
    D = init(fd)
    checks(D)
    S = D.S
    jobs = [(v, a, w, off) for v in VERS for a in ACCTS9 for w in WIN9 for off in R4.OFFSETS]
    jobs = [j for j in jobs if not (j[0].startswith("placebo") and j[1] == "lucid40")]
    with get_context("fork").Pool(4) as p:
        res = p.map(job, jobs, chunksize=4)
    agg = {}
    for (v, a, w, off), per in res:
        for lab, x in per.items():
            agg.setdefault(v, {}).setdefault(a, {}).setdefault(lab, []).append(x)
    tab = {v: {a: {lab: dict(M=float(np.mean([x["M"] for x in xs])), W=float(np.mean([x["W"] for x in xs])), n=len(xs))
                   for lab, xs in d2.items()} for a, d2 in d1.items()} for v, d1 in agg.items()}
    # the published as-built figures, with and without the overnight trade (results_r7/skip_accounts.csv)
    pub = {(r["variant"], r["account"]): r for r in csv.DictReader(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results_r7", "skip_accounts.csv")))}
    for acct in ("topstep", "lucid_addon", "lucid40"):
        for v, pv in (("asbuilt|on", "book"), ("asbuilt|off", "no-on")):
            assert round(tab[v][acct]["last 5y"]["M"]) == int(pub[(pv, acct)]["net_5y"]), (v, acct, tab[v][acct]["last 5y"]["M"])
            assert round(tab[v][acct]["early"]["M"]) == int(pub[(pv, acct)]["net_early"]), (v, acct)
    print("as built, with and without the overnight trade, reproduces results_r7/skip_accounts.csv", flush=True)
    json.dump(tab, open(os.path.join(out, "versions.json"), "w"), indent=1)
    # the note's design: 25 monthly starts, Nov 2021 - Nov 2023, 3 years each
    ks = []
    for k in range(len(S.days)):
        mth = str(np.datetime64(int(S.days[k]), "D"))[:7]
        if "2021-11" <= mth <= "2023-11" and (not ks or str(np.datetime64(int(S.days[ks[-1]]), "D"))[:7] != mth):
            ks.append(k)
    assert len(ks) == 25
    j3 = [(v, a, k) for v in ("asbuilt|on", "asbuilt|off", "B90|on", "B90|off", "B60|on", "B60|off") for a in ACCTS9 for k in ks]
    with get_context("fork").Pool(4) as p:
        r3 = p.map(job3, j3, chunksize=4)
    three = {}
    for (v, a, k), tot in r3:
        three.setdefault(v, {}).setdefault(a, []).append(tot)
    three = {v: {a: dict(mean=float(np.mean(x)), median=float(np.median(x)), worst=float(min(x)), n=len(x)) for a, x in d.items()} for v, d in three.items()}
    json.dump(three, open(os.path.join(out, "threeyear.json"), "w"), indent=1)
    table(out)


def table(out):
    tab = json.load(open(os.path.join(out, "versions.json")))
    three = json.load(open(os.path.join(out, "threeyear.json")))
    plac = [v for v in tab if v.startswith("placebo")]
    rows, verdict = [], {}
    for acct in ACCTS9:
        bands = None
        if acct in DECIDE:
            base = tab["B60|on"][acct]
            band = lambda lab, k: max(abs(tab[p][acct][lab][k] - base[lab][k]) for p in plac)  # noqa: E731
            bands = dict(M5=band("last 5y", "M"), W5=band("last 5y", "W"), Me=band("early", "M"), We=band("early", "W"))
        for ver in ("asbuilt", "B90", "B60"):
            on, off = tab[f"{ver}|on"][acct], tab[f"{ver}|off"][acct]
            d = {k: off[lab][x] - on[lab][x] for k, lab, x in (("M5", "last 5y", "M"), ("W5", "last 5y", "W"), ("Me", "early", "M"), ("We", "early", "W"))}
            row = dict(account=acct, version=ver, on_5y=round(on["last 5y"]["M"]), off_5y=round(off["last 5y"]["M"]), change_5y=round(d["M5"]),
                       on_worst=round(on["last 5y"]["W"]), off_worst=round(off["last 5y"]["W"]), change_worst=round(d["W5"]),
                       on_early=round(on["early"]["M"]), off_early=round(off["early"]["M"]), change_early=round(d["Me"]),
                       change_worst_early=round(d["We"]), on_2024_26=round(on["2024-26"]["M"]), off_2024_26=round(off["2024-26"]["M"]),
                       on_3y_mean=round(three[f"{ver}|on"][acct]["mean"]), off_3y_mean=round(three[f"{ver}|off"][acct]["mean"]))
            if bands and ver == "B60":
                ok = (((d["M5"] > bands["M5"] and d["W5"] > -bands["W5"]) or (d["W5"] > bands["W5"] and d["M5"] > -bands["M5"]))
                      and d["Me"] > -bands["Me"] and d["We"] > -bands["We"])
                row.update(band_5y=round(bands["M5"]), band_worst=round(bands["W5"]), band_early=round(bands["Me"]),
                           band_worst_early=round(bands["We"]), skip_passes_rule_5y="PASS" if ok else "fail")
                verdict[acct] = "PASS" if ok else "fail"
            rows.append(row)
    keys = max((list(r) for r in rows), key=len)
    with open(os.path.join(out, "r9_table.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    dec = dict(skip_passes=verdict, change_default=all(verdict.get(a) == "PASS" for a in DECIDE))
    json.dump(dec, open(os.path.join(out, "r9_decision.json"), "w"), indent=1)
    for r in rows:
        print(r, flush=True)
    print(dec, flush=True)


# ------------------------------------------------------------------------------------------------ facts (CFD)
def facts(dd, out):
    """The note's questions, on the Nasdaq-100 CFD of the earlier research (1-minute bars, quotes around the clock):
    the IB in three versions and the funded overnight leg as built and as ONR-B, 1 MNQ, $1.00 a round turn."""
    nq, spx = load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz"))
    S = Sessions(nq, spx, tf=1)
    yr = lambda d: str(np.datetime64(int(d), "D"))[:4]  # noqa: E731

    def stats(vals, lo, hi):
        v = [(y, x, r) for y, x, r in vals if lo <= y <= hi]
        if not v:
            return {}
        usd = np.array([x for _, x, _ in v])
        rr = np.array([r for _, _, r in v])
        sess = sum(1 for d in S.days if lo <= yr(d) <= hi and not np.isnan(S.S[d]["adr"]))
        yrs = sorted({y for y, _, _ in v})
        up = sum(1 for y in yrs if sum(x for yy, x, _ in v if yy == y) > 0)
        return dict(trades=len(v), usd_per_trade=round(float(usd.mean()), 2), usd_per_day=round(float(usd.sum() / sess), 2),
                    r_per_trade=round(float(rr.mean()), 3), t=round(float(rr.mean() / (rr.std(ddof=1) / np.sqrt(len(rr)))), 2),
                    years_up=f"{up} of {len(yrs)}")
    ib = {"both sides every day (v1 as received)": [], "drive's side on drive days, both sides otherwise (v2.1 onward)": [],
          "drive's side on drive days only": []}
    on = {"as built (score 0.7187, stop 0.5 ADR)": [], "ONR-B (score 0.8985, stop 1.0 ADR, 1 MNQ uncapped)": []}
    for d in S.days:
        A_ = S.S[d]["adr"]
        if np.isnan(A_):
            continue
        y = yr(d)
        sd = S.od_side(d, 0.10)
        for name, side, go in ((list(ib)[0], 0, True), (list(ib)[1], sd, True), (list(ib)[2], sd, sd != 0)):
            if go:
                res = ib_breakout(S, d, 0.0, n=1, comm=COMM_RT, only_side=side)
                if res and res[1] != "both-skip":
                    ib[name].append((y, res[0], res[0] / (0.25 * A_ * PV)))
        for name, thr, st in ((list(on)[0], THR, 0.5), (list(on)[1], THR_B, 1.0)):
            s = S.on_side(d, thr)
            if s:
                p = funded_on(S, d, s, 0.0, st, n=1, comm=COMM_RT)[0]
                on[name].append((y, p, p / (st * A_ * PV)))
    res = {"ib": {k: {w: stats(v, a, b) for w, a, b in (("2011-2018", "2011", "2018"), ("2019-2020", "2019", "2020"))} for k, v in ib.items()},
           "overnight": {k: {w: stats(v, a, b) for w, a, b in (("2011-2019", "2011", "2019"), ("2011-2018", "2011", "2018"))} for k, v in on.items()}}
    os.makedirs(out, exist_ok=True)
    json.dump(res, open(os.path.join(out, "facts_cfd.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


# ------------------------------------------------------------------------------------------------ 1 contract a leg
def unit(fd, out):
    """The note's headline measure: every leg at 1 MNQ, no account rules, daily P&L over all sessions (zero days
    included): daily Sharpe, t, $ a day, for as built and ONR-B (both IBs), with and without the overnight trade."""
    D = init(fd)
    S = D.S
    days = [int(d) for d in D.days if int(d) in S.S and not np.isnan(S.S[int(d)]["adr"])]
    iso = lambda d: str(np.datetime64(d, "D"))  # noqa: E731
    pnl = {}
    for ver in ("asbuilt", "B60", "B90"):
        for on in (True, False):
            v = []
            for d in days:
                lg = LEGS[ver][d]
                x = 0.0
                if on:
                    if ver == "asbuilt":
                        s = S.on_side(d)
                        x += LEGS["asbuilt"][d]["on"][s] if s else 0.0
                    else:
                        s = S.on_side(d, THR_B)
                        x += funded_on(S, d, s, 0.0, B["on_stop"], n=1, comm=COMM_RT)[0] if s else 0.0
                if not is_half(d):
                    x += sum(it[4] for it in (lg["pyr"], lg["ib"]) if it is not None)
                v.append(x)
            pnl[(ver, on)] = np.array(v)
    res = {}
    for w, a, b in (("Dec 2019 - Dec 2023", "2019-12-01", "2023-12-31"), ("2024 - Nov 20 2026", "2024-01-01", "2026-12-31")):
        m = np.array([a <= iso(d) <= b for d in days])
        for (ver, on), v in pnl.items():
            x = v[m]
            sh = x.mean() / x.std(ddof=1)
            res[f"{ver} {'with' if on else 'without'} the overnight trade | {w}"] = dict(
                sessions=int(m.sum()), usd_per_day=round(float(x.mean()), 2), daily_sharpe=round(float(sh), 3), t=round(float(sh * np.sqrt(len(x))), 2))
    json.dump(res, open(os.path.join(out, "unit.json"), "w"), indent=1)
    for k, v in res.items():
        print(k, v)


if __name__ == "__main__":
    if sys.argv[1] == "facts":
        facts(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "unit":
        unit(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "table":
        table(sys.argv[2])
    else:
        main(sys.argv[1], sys.argv[2])
