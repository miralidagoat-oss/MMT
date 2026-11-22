#!/usr/bin/env python3
"""The user's "W+Z Funded" indicator (pasted Nov 21 2026: a Williams breakout and the Zarattini 5-minute candle on a
1-minute chart, for funded accounts), its trade rules replicated bar for bar and backtested on this study's data.

usage: python3 -I wz_check.py CFD_DIR FUT_DIR OUT_DIR
  CFD_DIR: NSXUSD.npz, the Nasdaq-100 CFD in 1-minute bars (Nov 2010 - Nov 2026)
  FUT_DIR: NQFUT.npz, 5-minute bars: real NQ futures Aug 2019 - Aug 9 2024 (with RTH holes filled from the CFD, see
           prep_nqfut.py), the CFD Aug 12 2024 - Sep 8 2026, real MNQ futures Sep 9 - Nov 17 2026
Writes OUT_DIR/trades_<run>.csv (one row per day), summary.json and the tables it prints.

The indicator's rules, per MNQ (it trades N = 2 per strategy at 50K, 1 at 25K; every $ here is for 50K, N = 2):
  09:30 bar: dO = its open; upL / dnL = dO +/- 0.3 x yesterday's RTH range; ADR = the mean RTH range of the last 14
  sessions (TradingView's daily RTH bars: half days count). No trade on holidays and early closes.
  Williams: from the 09:31 bar to the 15:58 bar, the first bar through a level fills a stop order at max(level, open)
  + 1 tick (shorts mirrored); a bar through both levels = no Williams trade that day. Stop = the nearer of the other
  level and the price that loses $490 per MNQ with commission. The fill bar's own extreme at the stop = stopped at the
  stop - 1 tick; later bars stop at min(open, stop) - 1 tick. No target. Out at the 15:59 bar's close - 1 tick.
  Zarattini: at the 09:34 bar's close, the side of close - dO; entry at that close + 1 tick; stop 0.10 x ADR and target
  1.0 x ADR from that close. From the 09:35 bar the stop is checked first (min(open, stop) - 1 tick); the target fills
  at the target when touched. Out at the 15:59 bar's close - 1 tick.
  Day limit: at each bar's close, realised + open P&L (at the close, commission in) <= -$600 x N closes both at that
  close and ends the day. Commission $1.34 per MNQ round turn.
The 1-minute CFD runs these rules exactly ("cfd1"). The 5-minute files can only approximate them ("cfd5", "fut5"):
the Zarattini entry is exact (the 09:30 5-minute bar closes at 09:34:59), but Williams fills, the both-levels rule and
the stops are judged on 5-minute bars, and the OCO is live from the 09:30 bar. cfd5 runs that approximation on the
same CFD minutes made into 5-minute bars, so cfd1 - cfd5 measures the approximation itself.
Each day also records the worst point of the open P&L inside the day (each bar's low or high, whichever hurts the net
position), which a prop firm's max loss is checked against.
"""
import csv
import datetime as dt
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from holidays import half_day  # noqa: E402

PV, TK = 2.0, 0.25
N50 = 2  # MNQ per strategy at 50K
BASE = dict(k=0.3, wcap=490.0, zstop=0.10, ztgt=1.0, slip=1, comm=1.34, dll=600.0, zdelay=0, W=True, Z=True, wskip=False)
# Version 2 (pasted Nov 22 2026) adds one rule: no Williams trade on the session after a weekday holiday, an early close
# or any other gap: at the 09:30 bar, the days since the last session that had a 09:30 bar must be <= 1 (<= 3 on a
# Monday), and that session must not be a listed early close (here: holidays.half_day, every year). Nothing else changed.
V2 = dict(BASE, wskip=True)
PERIODS = [("design 2011-18", "2011-01-01", "2018-12-31"), ("look 2019-23", "2019-01-01", "2023-12-31"),
           ("sealed 2024-26", "2024-01-01", "2026-12-31")]
REAL_FUT = (("2019-08-11", "2024-08-09"), ("2026-09-09", "2026-12-31"))


def easter(y):
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month = (h + l_ - 7 * m + 114) // 31
    return dt.date(y, month, (h + l_ - 7 * m + 114) % 31 + 1)


def obs(d):
    return d - dt.timedelta(days=1) if d.weekday() == 5 else (d + dt.timedelta(days=1) if d.weekday() == 6 else d)


def closed(d):
    """CME equity futures have no RTH session: New Year's Day, Good Friday, Christmas (the CFD may still print)."""
    return d in (obs(dt.date(d.year, 1, 1)), easter(d.year) - dt.timedelta(days=2), obs(dt.date(d.year, 12, 25)))


def to5(t, o, h, l, c):
    """1-minute bars -> 5-minute bars labelled by their open."""
    g = t // 5 * 5
    idx = np.r_[0, np.flatnonzero(np.diff(g)) + 1]
    end = np.r_[idx[1:], len(t)] - 1
    return g[idx], o[idx], np.maximum.reduceat(h, idx), np.minimum.reduceat(l, idx), c[end]


def rth_days(t, o, h, l, c):
    """[(date, O, H, L, C, MI)] per RTH day (bars opening 09:30-15:59 ET), closed days left out; MI = minutes after 09:30."""
    tod, day = t % 1440, t // 1440
    sel = np.flatnonzero((tod >= 570) & (tod < 960))
    days, start = np.unique(day[sel], return_index=True)
    end = np.r_[start[1:], len(sel)]
    out = []
    for d, a, b in zip(days, start, end):
        date = (np.datetime64(int(d), "D")).astype(object)
        if date.weekday() >= 5 or closed(date):
            continue
        ii = sel[a:b]
        out.append((date, o[ii].tolist(), h[ii].tolist(), l[ii].tolist(), c[ii].tolist(), (tod[ii] - 570).tolist()))
    return out


def sim_day(O, H, L, C, MI, dO, R1, A, P, tf):
    """One RTH day for 1 MNQ per strategy, the indicator's bar order: Williams stop, Zarattini stop/target, Williams
    entry, Zarattini entry, day limit, 15:59 exit."""
    slip, comm, cap = P["slip"] * TK, P["comm"], (P["wcap"] - P["comm"]) / PV
    up, dn = dO + P["k"] * R1, dO - P["k"] * R1
    if tf == 1:
        z_sig, z_in, w_first, w_last, x_mi = 4, 4 + P["zdelay"], 1, 388, 389
    else:
        z_sig, z_in, w_first, w_last, x_mi = 0, 0, 0, 385, 385
    r = dict(w_side=0, w_ent=math.nan, w_x=math.nan, w_pnl=0.0, w_why="", z_side=0, z_ent=math.nan, z_x=math.nan,
             z_pnl=0.0, z_why="", both=0, dll=0, min_eq=0.0)
    real = 0.0
    wpos = zpos = zdir = 0
    wdone, zdone = not P["W"], not P["Z"]
    went = wstp = zent = zstp = ztgt = 0.0
    last = len(MI) - 1
    for j in range(len(MI)):
        m, o, h, l, c = MI[j], O[j], H[j], L[j], C[j]
        if wpos != 0 and ((l <= wstp) if wpos == 1 else (h >= wstp)):
            x = (min(o, wstp) if wpos == 1 else max(o, wstp)) - wpos * slip
            p = (x - went) * wpos * PV - comm
            real += p
            r.update(w_x=x, w_pnl=p, w_why="stop")
            wpos = 0
        if zpos != 0 and m > z_in:
            hs = (l <= zstp) if zpos == 1 else (h >= zstp)
            ht = (h >= ztgt) if zpos == 1 else (l <= ztgt)
            if hs or ht:
                x = ((min(o, zstp) if zpos == 1 else max(o, zstp)) - zpos * slip) if hs else ztgt
                p = (x - zent) * zpos * PV - comm
                real += p
                r.update(z_x=x, z_pnl=p, z_why="stop" if hs else "target")
                zpos = 0
        if not wdone and wpos == 0 and w_first <= m <= w_last:
            hu, hd = h >= up, l <= dn
            if hu and hd:
                wdone = True
                r["both"] = 1
            elif hu or hd:
                wpos = 1 if hu else -1
                went = (max(up, o) if hu else min(dn, o)) + wpos * slip
                wstp = max(dn, went - cap) if hu else min(up, went + cap)
                wdone = True
                r.update(w_side=wpos, w_ent=went)
                if (l <= wstp) if wpos == 1 else (h >= wstp):
                    x = wstp - wpos * slip
                    p = (x - went) * wpos * PV - comm
                    real += p
                    r.update(w_x=x, w_pnl=p, w_why="stop (fill bar)")
                    wpos = 0
        if not zdone and m == z_sig:
            zdir = (1 if c > dO else -1) if c != dO else 0
            if zdir == 0:
                zdone = True
        if not zdone and m == z_in:
            zdone = True
            if zdir != 0:
                zpos = zdir
                zent = c + zpos * slip
                zstp, ztgt = c - zpos * P["zstop"] * A, c + zpos * P["ztgt"] * A
                r.update(z_side=zpos, z_ent=zent)
        q = wpos + zpos
        px = l if q > 0 else (h if q < 0 else c)
        eq = real + (((px - went) * wpos * PV - comm) if wpos else 0.0) + (((px - zent) * zpos * PV - comm) if zpos else 0.0)
        r["min_eq"] = min(r["min_eq"], eq)
        ow = ((c - went) * wpos * PV - comm) if wpos else 0.0
        oz = ((c - zent) * zpos * PV - comm) if zpos else 0.0
        if (wpos or zpos) and real + ow + oz <= -P["dll"]:
            real += ow + oz
            if wpos:
                r.update(w_x=c, w_pnl=ow, w_why="day limit")
            if zpos:
                r.update(z_x=c, z_pnl=oz, z_why="day limit")
            wpos = zpos = 0
            r["dll"] = 1
            break
        if (m == x_mi or j == last) and (wpos or zpos):
            if wpos:
                x = c - wpos * slip
                p = (x - went) * wpos * PV - comm
                real += p
                r.update(w_x=x, w_pnl=p, w_why="15:59" if m == x_mi else "last bar")
                wpos = 0
            if zpos:
                x = c - zpos * slip
                p = (x - zent) * zpos * PV - comm
                real += p
                r.update(z_x=x, z_pnl=p, z_why="15:59" if m == x_mi else "last bar")
                zpos = 0
            break
    r["total"] = real
    return r


def run(days, P, tf):
    """Every tradable day: previous RTH day's range and the 14-day ADR as the indicator reads them."""
    rng = [max(H) - min(L) for _, _, H, L, _, _ in days]
    out, skipped = [], dict(half_day=0, no_0930_bar=0, warmup=0, williams_after_gap=0, williams_after_half_day=0)
    last_open = None  # the last session with a 09:30 bar (the indicator's lastT / lastYmd, updated on half days too)
    for i, (date, O, H, L, C, MI) in enumerate(days):
        prev_open, gap_skip, half_skip = last_open, False, False
        if MI[0] == 0:
            last_open = date
        if prev_open is not None:
            gap = (date - prev_open).days
            gap_skip = gap > 3 if date.weekday() == 0 else gap > 1
            half_skip = half_day(prev_open)
        if i < 14:
            skipped["warmup"] += 1
            continue
        if half_day(date):
            skipped["half_day"] += 1
            continue
        if MI[0] != 0:
            skipped["no_0930_bar"] += 1
            continue
        R1, A = rng[i - 1], float(np.mean(rng[i - 14:i]))
        Pd = P
        if P.get("wskip") and P["W"] and (gap_skip or half_skip):
            Pd = dict(P, W=False)
            skipped["williams_after_gap" if gap_skip else "williams_after_half_day"] += 1
        r = sim_day(O, H, L, C, MI, O[0], R1, A, Pd, tf)
        r.update(date=date.isoformat(), r1=R1, adr=A)
        out.append(r)
    return out, skipped


def tstat(x):
    x = np.asarray(x, float)
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(len(x)))) if len(x) > 2 and x.std(ddof=1) > 0 else math.nan


def stats(x, n=N50):
    """Per-trade (or per-day) $ at N MNQ: count, mean, t, win %, profit factor, total, worst drop of the running total."""
    x = np.asarray(x, float) * n
    if len(x) == 0:
        return dict(n=0)
    run_ = np.cumsum(x)
    dd = float((run_ - np.maximum.accumulate(np.r_[0.0, run_])[1:]).min())
    g, b = x[x > 0].sum(), -x[x < 0].sum()
    return dict(n=int(len(x)), mean=float(x.mean()), t=tstat(x), win=float(100 * (x > 0).mean()),
                pf=float(g / b) if b > 0 else math.inf, total=float(x.sum()), drop=dd)


def table(rows, a, b, real_only=False):
    rs = [r for r in rows if a <= r["date"] <= b and (not real_only or any(x <= r["date"] <= y for x, y in REAL_FUT))]
    w = [r["w_pnl"] for r in rs if r["w_side"] != 0]
    z = [r["z_pnl"] for r in rs if r["z_side"] != 0]
    d = [r["total"] for r in rs]
    return dict(williams=stats(w), zarattini=stats(z), days=stats(d), sessions=len(rs),
                w_both=int(sum(r["both"] for r in rs)), dll_days=int(sum(r["dll"] for r in rs)))


def fmt(s):
    if not s or s.get("n", 0) == 0:
        return "no trades"
    return (f"{s['n']:5d} | {s['mean']:+8.1f} | t {s['t']:+5.2f} | win {s['win']:4.1f}% | PF {s['pf']:4.2f} | "
            f"total {s['total']:+10,.0f} | worst drop {s['drop']:+9,.0f}")


def write(path, rows):
    keys = ["date", "r1", "adr", "w_side", "w_ent", "w_x", "w_why", "w_pnl", "z_side", "z_ent", "z_x", "z_why", "z_pnl",
            "both", "dll", "total", "min_eq"]
    with open(path, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(keys + ["note"])
        for r in rows:
            wr.writerow([r[k] if not isinstance(r[k], float) else round(r[k], 4) for k in keys] +
                        ["$ per 1 MNQ per strategy; x2 at 50K"])


def load(path):
    z = np.load(path)
    return z["t"].astype(np.int64), z["o"], z["h"], z["l"], z["c"]


def repair(t, o, h, l, c, verbose=True):
    """A bar whose open (and high or low) jumps > 400 points from the previous close while its close stays within 150
    points of it is a bad print: its open becomes the previous close and its high / low the bar's other prices. In
    NQFUT.npz this matches one bar only, 2026-10-30 15:00 ET in Yahoo's MNQ (and NQ) file: open = high = 29,562.00
    after a 28,234.50 close, low 28,284.00, close 28,307.25 (NQ fell, it did not jump 1,327 points)."""
    o, h, l = o.copy(), h.copy(), l.copy()
    near = np.r_[False, (t[1:] - t[:-1]) <= 10]
    pc = np.r_[c[0], c[:-1]]
    bad = np.flatnonzero(near & (np.abs(o - pc) > 400) & (np.abs(c - pc) < 150))
    for i in bad:
        if verbose:
            print(f"  repaired bad print {np.datetime64(int(t[i]), 'm')} ET: o {o[i]:.2f} h {h[i]:.2f} l {l[i]:.2f} c {c[i]:.2f}"
                  f" (previous close {pc[i]:.2f})", flush=True)
        o[i] = pc[i]
        h[i] = max(o[i], c[i], min(h[i], max(o[i], c[i]) + 0.0))
        l[i] = min(o[i], c[i], max(l[i], min(o[i], c[i])))
    return t, o, h, l, c


def main(cfd_dir, fut_dir, out, P=BASE):
    os.makedirs(out, exist_ok=True)
    cfd = load(os.path.join(cfd_dir, "NSXUSD.npz"))
    fut = repair(*load(os.path.join(fut_dir, "NQFUT.npz")))
    data = {"cfd1": (rth_days(*cfd), 1), "cfd5": (rth_days(*to5(*cfd)), 5), "fut5": (rth_days(*fut), 5)}
    res, summ = {}, {}
    for name, (days, tf) in data.items():
        rows, skipped = run(days, P, tf)
        res[name] = rows
        write(os.path.join(out, f"trades_{name}.csv"), rows)
        summ[name] = dict(skipped=skipped, first=rows[0]["date"], last=rows[-1]["date"],
                          periods={lab: table(rows, a, b) for lab, a, b in PERIODS},
                          years={y: table(rows, f"{y}-01-01", f"{y}-12-31") for y in sorted({r["date"][:4] for r in rows})})
        if name == "fut5":
            summ[name]["real_futures_only"] = {lab: table(rows, a, b, real_only=True) for lab, a, b in PERIODS}
        print(f"\n== {name}: {rows[0]['date']} -> {rows[-1]['date']}, {len(rows)} sessions traded, skipped {skipped}")
        for lab, a, b in PERIODS:
            tb = summ[name]["periods"][lab]
            print(f"  {lab:15s} ({tb['sessions']} sessions; both-levels days {tb['w_both']}, day-limit days {tb['dll_days']})")
            print(f"     Williams  {fmt(tb['williams'])}")
            print(f"     Zarattini {fmt(tb['zarattini'])}")
            print(f"     W+Z days  {fmt(tb['days'])}")
        if name == "fut5":
            print("  real futures bars only (Aug 2019 - Aug 9 2024, Sep 9 - Nov 17 2026):")
            for lab, a, b in PERIODS:
                tb = summ[name]["real_futures_only"][lab]
                if tb["sessions"]:
                    print(f"  {lab:15s} ({tb['sessions']} sessions)  W {fmt(tb['williams'])}")
                    print(f"  {'':15s}  Z {fmt(tb['zarattini'])}")
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summ, f, indent=1, default=float)




VARIANTS = [("as written", {}), ("Zarattini 1 min late", dict(zdelay=1)), ("Zarattini 2 min late", dict(zdelay=2)),
            ("Zarattini 3 min late", dict(zdelay=3)), ("2 ticks slippage", dict(slip=2)), ("4 ticks slippage", dict(slip=4)),
            ("Williams k 0.2", dict(k=0.2)), ("Williams k 0.4", dict(k=0.4)), ("no day limit", dict(dll=1e9))]


def extra(cfd_dir, fut_dir, out, P0=BASE):
    """Year by year, and the rules' sensitivity (each change alone; nothing here is fitted or chosen)."""
    cfd = load(os.path.join(cfd_dir, "NSXUSD.npz"))
    fut = repair(*load(os.path.join(fut_dir, "NQFUT.npz")), verbose=False)
    feeds = {"cfd1": (rth_days(*cfd), 1), "fut5": (rth_days(*fut), 5)}
    base = {name: run(days, P0, tf)[0] for name, (days, tf) in feeds.items()}
    yrows = []
    print("\n== by calendar year, 50K (2 MNQ per strategy), $ after commission and 1 tick per fill")
    print(f"{'year':6s} | {'CFD 1-min: Williams':>22s} {'Zarattini':>18s} {'W+Z':>9s} | {'NQ futures 5-min: W':>20s} {'Z':>9s} {'W+Z':>9s}")
    for y in [str(v) for v in range(2011, 2027)]:
        row = dict(year=y)
        for name in feeds:
            rs = [r for r in base[name] if r["date"][:4] == y]
            row[name] = dict(sessions=len(rs), w=N50 * sum(r["w_pnl"] for r in rs), z=N50 * sum(r["z_pnl"] for r in rs),
                             wz=N50 * sum(r["total"] for r in rs),
                             src="real" if name == "fut5" and rs and all(any(a <= r["date"] <= b for a, b in REAL_FUT) for r in rs) else
                             ("mixed" if name == "fut5" and rs and any(any(a <= r["date"] <= b for a, b in REAL_FUT) for r in rs) else
                              ("CFD fill" if name == "fut5" and rs else "")))
        yrows.append(row)
        c, f = row["cfd1"], row["fut5"]
        fs = f"{f['w']:+10,.0f} {f['z']:+9,.0f} {f['wz']:+9,.0f} ({f['src']})" if f["sessions"] else ""
        print(f"{y:6s} | {c['w']:+22,.0f} {c['z']:+18,.0f} {c['wz']:+9,.0f} | {fs}")
    vrows = []
    print("\n== sensitivity, 50K, $ per year of W+Z (both strategies, day limit on) | Zarattini t | Williams t")
    for lab, ch in VARIANTS:
        P = dict(P0, **ch)
        row = dict(variant=lab)
        txt = f"{lab:22s}"
        for name, (days, tf) in feeds.items():
            if name == "fut5" and P["zdelay"]:
                txt += " | (5-minute bars cannot shift by minutes)"
                continue
            rows = run(days, P, tf)[0]
            for lab2, a, b in PERIODS:
                tb = table(rows, a, b)
                if tb["sessions"] == 0:
                    continue
                yrs = tb["sessions"] / 252.0
                row[f"{name} {lab2}"] = dict(per_year=tb["days"]["total"] / yrs, z_t=tb["zarattini"].get("t"),
                                            w_t=tb["williams"].get("t"))
                txt += f" | {name} {lab2[-7:]}: {tb['days']['total'] / yrs:+8,.0f}/yr Zt {tb['zarattini'].get('t', float('nan')):+.2f} Wt {tb['williams'].get('t', float('nan')):+.2f}"
        vrows.append(row)
        print(txt)
    with open(os.path.join(out, "years_sensitivity.json"), "w") as f:
        json.dump(dict(years=yrows, sensitivity=vrows), f, indent=1, default=float)


# ---------------------------------------------------------------------------------------------- accounts and pools
def wz_by_session(rows, n=N50):
    """{session id: (day $, worst intraday $)} at n MNQ per strategy (session id = the RTH date's day number)."""
    return {int(np.datetime64(r["date"]).astype(int)): (n * r["total"], n * r["min_eq"]) for r in rows}


def make_wz_funded():
    from account import FundedAccount

    class WZFunded(FundedAccount):
        """A funded account trading W+Z as written: no cushion check and no abandon level (the indicator has neither);
        the max loss is checked at the day's worst intraday point as well as at the close (both firms enforce it
        intraday). Payouts exactly as FundedAccount (the indicator's panel uses the same rule)."""

        def __init__(self, S, wz, **kw):
            super().__init__(S, **kw)
            self.wz = wz

        def step(self, d):
            if self.npay > 0:
                fl = self.lock_after_pay
            else:
                fl = self.lock if self.peak >= self.R["mll"] + self.lock else self.peak - self.R["mll"]
            day, low = self.wz.get(int(d), (0.0, 0.0))
            if self.pnl + low <= fl:
                self.pnl = fl
                return "blown", 0.0
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
    return WZFunded


def sim_pool_mix(S, N, max_total, k0, k1, ek, fk, wz_slots, wz, WZF):
    """research4.sim_pool with wz_slots of the N funded slots trading W+Z (a new funded account takes the type further
    below its quota; ties go to ONR). wz_slots = 0 is research4.sim_pool exactly (checked)."""
    from account import EvalAccount, FundedAccount
    funded, evals, ev, ready, nid, typ = [], [], [], 0, 0, {}
    for k in range(k0, k1):
        d = S.days[k]
        while ready and len(funded) < N:
            nid += 1
            n_wz = sum(typ[a] == "wz" for _, a in funded)
            kind = "wz" if wz_slots - n_wz > (N - wz_slots) - (len(funded) - n_wz) else "onr"
            funded.append((WZF(S, wz, **fk) if kind == "wz" else FundedAccount(S, **fk), nid))
            typ[nid] = kind
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
            if evn is None:
                keep.append((f, aid))
            else:
                ev.append((k, "end:" + ("abandoned" if evn == "dead" else evn), aid, 0.0))
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
    return ev, typ


_W = {}


def _init_pool(fut_dir, cfd_dir, P=BASE):
    import functools
    import account
    import engine
    import topstep_sim as T
    account.funded_on = functools.lru_cache(maxsize=None)(engine.funded_on)
    account.pyramid = functools.lru_cache(maxsize=None)(engine.pyramid)
    account.ib_breakout = functools.lru_cache(maxsize=None)(engine.ib_breakout)
    from engine import Sessions, load_npz
    fut = repair(*load(os.path.join(fut_dir, "NQFUT.npz")), verbose=False)
    # topstep_sim.load('fut') with the bad print repaired (the same S&P file: FUT_DIR/SPXUSD.npz)
    _W["S"] = {"fut": Sessions(fut, load_npz(os.path.join(fut_dir, "SPXUSD.npz")), tf=5), "cfd": T.load("cfd", cfd_dir)}
    _W["wz"] = {"fut": wz_by_session(run(rth_days(*fut), P, 5)[0]),
                "cfd": wz_by_session(run(rth_days(*load(os.path.join(cfd_dir, "NSXUSD.npz"))), P, 1)[0])}
    # the same days with the max loss checked at the close only (what a test without intraday checks would do)
    _W["wz_eod"] = {kind: {d: (v[0], v[0]) for d, v in m.items()} for kind, m in _W["wz"].items()}
    _W["WZF"] = make_wz_funded()


def firm_kw(firm):
    import research4 as R4
    import topstep_sim as T
    if firm == "lucid":
        return R4.E_KW, dict(R4.F_KW, max_pay=4)
    return T.ek(50), T.fk(50, "standard")


def _pool_job(args):
    import topstep_sim as T
    kind, window, off, firm, wz_slots, eod = args
    S, wz = _W["S"][kind], (_W["wz_eod"] if eod else _W["wz"])[kind]
    k0 = T.start_k(S, window, off)
    ek, fk = firm_kw(firm)
    ev, typ = sim_pool_mix(S, 5, 10, k0, len(S.days), ek, fk, wz_slots, wz, _W["WZF"])
    cash = T.cash_flows(S, k0, ev, "noact", 50) if firm == "topstep" else T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=80.5)
    lab, a, b, fy = T.WINDOWS[(kind, window)]
    summ = T.summarise_run(S, k0, cash, ev, [(lab, a, b)], {lab: fy})
    cal = [T.iso(S, k) for k in range(k0, len(S.days))]
    run_ = np.cumsum(cash)
    i3 = int(np.searchsorted(np.array(cal), str((dt.date.fromisoformat(cal[0]) + dt.timedelta(days=round(3 * 365.25))))))
    by_type = {}
    for k, kk, aid, v in ev:
        t_ = typ.get(aid)
        if t_ is None:
            continue
        b_ = by_type.setdefault(t_, dict(accounts=0, payouts=0, paid=0.0, blown=0, done=0, abandoned=0, open=0))
        if kk == "fund":
            b_["accounts"] += 1
        elif kk == "payout":
            b_["payouts"] += 1
            b_["paid"] += 0.9 * v
        elif kk.startswith("end:"):
            b_[kk[4:]] = b_.get(kk[4:], 0) + 1
    for t_, b_ in by_type.items():
        b_["open"] = b_["accounts"] - b_["blown"] - b_["done"] - b_["abandoned"]
    p = summ["periods"][lab]
    return args, dict(per_year=p["M"], worst_full_year=p["W"], worst12=p["worst12"], drop=p["D"],
                      months_paid=p["months_paid"], cash_low=summ["cash_low"], three_years=float(run_[min(i3, len(run_)) - 1]),
                      total=summ["total"], start=cal[0], by_type=by_type)


def pools(cfd_dir, fut_dir, out, procs=4, P=BASE):
    from multiprocessing import Pool as MP
    CASES = ((0, False), (2, False), (5, False), (2, True), (5, True))
    jobs = [("fut", "5y", off, firm, wzs, eod) for firm in ("topstep", "lucid") for wzs, eod in CASES for off in range(0, 60, 5)]
    jobs += [("cfd", "all", 0, firm, wzs, eod) for firm in ("topstep", "lucid") for wzs, eod in CASES]
    with MP(procs, initializer=_init_pool, initargs=(fut_dir, cfd_dir, P)) as mp:
        res = dict(mp.map(_pool_job, jobs, chunksize=1))
    rows = []
    print("\n== pools of 5 funded + 5 evals (evals trade ONR), 50K. Topstep: No Activation Fee Combines, Standard payouts;"
          " Lucid: $80.50 evals (40% rule), each funded account closed after its 4th payout. Mean of 12 start dates on the"
          " futures file (Nov 15 2021 -> Nov 17 2026); one run from Feb 2011 on the CFD")
    for kind, window, n_off in (("fut", "5y", 12), ("cfd", "all", 1)):
        for firm in ("topstep", "lucid"):
            for wzs, eod in CASES:
                rs = [res[(kind, window, off, firm, wzs, eod)] for off in (range(0, 60, 5) if n_off == 12 else (0,))]
                m = lambda key: float(np.mean([r[key] for r in rs]))  # noqa: E731
                agg = {}
                for r in rs:
                    for t_, b_ in r["by_type"].items():
                        a_ = agg.setdefault(t_, dict(accounts=0, payouts=0, paid=0.0, blown=0, done=0, abandoned=0, open=0))
                        for kk in a_:
                            a_[kk] += b_.get(kk, 0)
                lab = {0: "5 ONR", 2: "3 ONR + 2 W+Z", 5: "5 W+Z"}[wzs] + (" (close-only max loss)" if eod else "")
                row = dict(data=kind, firm=firm, funded=lab, starts=len(rs), per_year=m("per_year"),
                           worst_full_year=m("worst_full_year"), worst12=m("worst12"), drop=m("drop"),
                           months_paid=m("months_paid"), cash_low=m("cash_low"), three_years=m("three_years"),
                           three_years_worst=float(min(r["three_years"] for r in rs)), by_type=agg)
                rows.append(row)
                typ_txt = " | ".join(f"{t_}: {a_['accounts'] / len(rs):.1f} accounts per start, {a_['payouts'] / max(a_['accounts'], 1):.2f} payouts and"
                                     f" ${a_['paid'] / max(a_['accounts'], 1):,.0f} to you each; ended: {a_['blown']} blown, {a_['abandoned']} abandoned,"
                                     f" {a_['done']} closed after 4th payout, {a_['open']} still open" for t_, a_ in sorted(agg.items()))
                print(f"  {kind} {firm:8s} {lab:36s}: ${row['per_year']:>9,.0f}/yr | 3 yrs ${row['three_years']:>9,.0f} (worst start ${row['three_years_worst']:>9,.0f})"
                      f" | worst full yr ${row['worst_full_year']:>8,.0f} | worst 12 mo ${row['worst12']:>8,.0f} | months paid {row['months_paid']:.0f}%"
                      f" | {typ_txt}")
    with open(os.path.join(out, "pools.json"), "w") as f:
        json.dump(rows, f, indent=1, default=float)


def pool_check(cfd_dir, fut_dir):
    """sim_pool_mix with no W+Z slot equals research4.sim_pool (both firms, one start date)."""
    import research4 as R4
    import topstep_sim as T
    _init_pool(fut_dir, cfd_dir)
    S = _W["S"]["fut"]
    for firm in ("topstep", "lucid"):
        ek, fk = firm_kw(firm)
        k0 = T.start_k(S, "5y", 0)
        a, _ = sim_pool_mix(S, 5, 10, k0, len(S.days), ek, fk, 0, _W["wz"]["fut"], _W["WZF"])
        b = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
        assert a == b, firm
    print("check passed: the mixed pool with no W+Z slot equals research4.sim_pool (Topstep and Lucid)", flush=True)


if __name__ == "__main__":
    # usage: wz_check.py CFD_DIR FUT_DIR OUT_DIR [v1|v2]   (v1: the first version pasted; v2: with the Williams skip)
    rules = V2 if (sys.argv[4:5] or ["v1"])[0] == "v2" else BASE
    main(*sys.argv[1:4], P=rules)
    extra(*sys.argv[1:4], P0=rules)
    pool_check(sys.argv[1], sys.argv[2])
    pools(*sys.argv[1:4], P=rules)
