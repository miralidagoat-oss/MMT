#!/usr/bin/env python3
"""Research round 7 (PREREG_R7.md): published strategies on the user's MNQ file, every configuration, with controls.

usage:
  python3 -I research7.py prep  MNQ_PARQUET DATA_DIR      # DATA_DIR/NQFUT_V.npz (bars + volume), checked against NQFUT.npz
  python3 -I research7.py selftest DATA_DIR               # engine equivalence, fills, rolls, look-ahead checks
  python3 -I research7.py screen DATA_DIR OUT_DIR         # all 1,556 configurations, design selection, one OOS look
  python3 -I research7.py diag DATA_DIR OUT_DIR           # controls, PBO, deflated Sharpe, walk-forward, correlations

Conventions (PREREG_R7.md, "Data and execution"):
- A session's bars sit on a grid of 276 five-minute slots: slot j = minute 5j after 18:00 ET (186 = 09:30,
  263 = 15:55, 264 = 16:00). Missing bars are NaN.
- Strict fills: decisions on closed bars; market orders at the next bar's open; stop orders at the stop or the
  gapped open; limits need a 1-tick trade-through and fill at the limit; stop wins a same-bar tie; in a stop-entry's
  fill bar the protective stop counts and the target does not; time exits at the open of the bar starting at the exit
  time; a session that ends early closes at its last bar.
- Costs per contract: $1.00 per round turn (0.5 point) + slippage per market/stop fill (1 tick = 0.25 point; stress 2).
  Kernels return gross points, contract round turns and slippage fills, so costs are applied afterwards.
- Statistics in ADR units (net points / that session's ADR), with zero on sessions without a trade.
"""
import datetime as dt
import json
import math
import os
import sys

import numpy as np
from numba import njit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine as E  # noqa: E402
from account import COMM_RT  # noqa: E402

NS = 276            # slots per session (18:00 -> 16:55)
RTH0, RTH1 = 186, 264  # 09:30 slot, 16:00 slot (RTH = 186..263)
TK = 0.25
PV = 2.0
COMM_PTS = COMM_RT / PV      # 0.5 point per contract round turn
SLIP1 = TK                   # 1 tick per market/stop fill
DESIGN_END = "2022-12-30"
OOS_START, OOS_END = "2023-01-03", "2026-11-20"
NAN = np.nan
EP = dt.datetime(1970, 1, 1)


def slot(hhmm):
    """'10:30' -> the slot of the bar that STARTS at 10:30 ET."""
    h, m = map(int, hhmm.split(":"))
    return (((h * 60 + m) - 1080) % 1440) // 5


# ------------------------------------------------------------------------------------------------ data
def prep(parquet, dd):
    """NQFUT_V.npz: prep_mnq.py's conversion of the user's parquet, plus volume; asserted equal to NQFUT.npz."""
    import pyarrow.parquet as pq
    tb = pq.read_table(parquet)
    df = tb.to_pandas()
    assert list(df.columns[:6]) == ["time", "open", "high", "low", "close", "volume"], list(df.columns)
    ny = df["time"].dt.tz_convert("America/New_York").dt.tz_localize(None)
    t = ((ny - EP).dt.total_seconds() // 60).astype(np.int64).to_numpy()
    o, h, l, c, v = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close", "volume"))
    z = np.load(os.path.join(dd, "NQFUT.npz"))
    for k, a in (("t", t), ("o", o), ("h", h), ("l", l), ("c", c)):
        assert np.array_equal(z[k], a), f"{k} differs from NQFUT.npz"
    assert np.all(np.isfinite(v)) and np.all(v >= 0), "volume"
    np.savez_compressed(os.path.join(dd, "NQFUT_V.npz"), t=t, o=o, h=h, l=l, c=c, v=v)
    print(f"NQFUT_V.npz: {len(t)} bars, equal to NQFUT.npz; volume total {v.sum():,.0f}, zero-volume bars {(v == 0).sum()}")


def third_friday(y, m):
    d = dt.date(y, m, 1)
    return d + dt.timedelta(days=(4 - d.weekday()) % 7 + 14)


def nyse_holidays(y):
    """Weekday NYSE holidays on which CME equity futures run a half session (holidays.py's federal-holiday set)."""
    from holidays import last_weekday, nth_weekday, observed
    s = {nth_weekday(y, 1, 0, 3), nth_weekday(y, 2, 0, 3), last_weekday(y, 5, 0), observed(dt.date(y, 7, 4)),
         nth_weekday(y, 9, 0, 1), nth_weekday(y, 11, 3, 4)}
    if y >= 2022:
        s.add(observed(dt.date(y, 6, 19)))
    return s


class Data:
    def __init__(self, dd, cut_t=None):
        z = np.load(os.path.join(dd, "NQFUT_V.npz"))
        t, o, h, l, c, v = (z[k] for k in ("t", "o", "h", "l", "c", "v"))
        if cut_t is not None:                 # the look-ahead test: nothing at or after this NY minute exists
            keep = t < cut_t
            t, o, h, l, c, v = (a[keep] for a in (t, o, h, l, c, v))
        self.raw = (t, o, h, l, c)
        s, day = E.sess_cols(t)
        assert np.all(s % 5 == 0)
        ids, start = np.unique(day, return_index=True)
        n = len(ids)
        self.days = ids.astype(np.int64)
        self.n = n
        self.date = [dt.date(1970, 1, 1) + dt.timedelta(days=int(d)) for d in ids]
        self.iso = np.array([d.isoformat() for d in self.date])
        G = {k: np.full((n, NS), NAN) for k in "ohlcv"}
        si = np.searchsorted(ids, day)
        sl = s // 5
        assert sl.max() < NS
        for k, a in zip("ohlcv", (o, h, l, c, v)):
            G[k][si, sl] = a
        # every bar landed on its own slot
        cnt = np.zeros((n, NS), np.int64)
        np.add.at(cnt, (si, sl), 1)
        assert cnt.max() == 1, "two bars on one slot"
        self.O, self.H, self.L, self.C, self.V = G["o"], G["h"], G["l"], G["c"], G["v"]
        # the engine's own ADR (the book's), so every rule sizes from the same number
        self.rth = E.rth_sessions(t, o, h, l, c)
        adr = E.adr_by_session(self.rth)
        self.adr = np.array([adr.get(int(d), NAN) for d in ids])
        self.nrth = np.sum(np.isfinite(self.O[:, RTH0:RTH1]), axis=1)
        self.has_rth = self.nrth > 0
        self.full = self.nrth == 78
        # RTH daily OHLC (raw)
        self.ro = np.full(n, NAN); self.rh = np.full(n, NAN); self.rl = np.full(n, NAN); self.rc = np.full(n, NAN)
        for i in range(n):
            js = np.flatnonzero(np.isfinite(self.O[i, RTH0:RTH1])) + RTH0
            if len(js):
                self.ro[i], self.rc[i] = self.O[i, js[0]], self.C[i, js[-1]]
                self.rh[i], self.rl[i] = np.nanmax(self.H[i, js]), np.nanmin(self.L[i, js])
        self._rolls()
        self._vwap()
        self._calendar()
        self.design = (self.iso <= DESIGN_END)
        self.oos = (self.iso >= OOS_START) & (self.iso <= OOS_END)
        self.year = np.array([d.year for d in self.date])

    # ---- rolls (PREREG_R7: Monday/Tuesday 18:00 opens of expiry week, residual vs the S&P > 50 points)
    def _rolls(self):
        dd_spx = getattr(self, "_spx", None)
        self.roll = np.zeros(self.n)          # offset at the 18:00 open of session i (new - old contract)
        self.roll_log = []
        if dd_spx is None:
            return

    def attach_spx(self, dd):
        """The S&P CFD (the book's score input) measures the market's move over each roll span."""
        s = np.load(os.path.join(dd, "SPXUSD.npz"))
        st, sc = s["t"], s["c"]
        t = self.raw[0]
        firsts = {}
        for i in range(self.n):
            js = np.flatnonzero(np.isfinite(self.O[i]))
            firsts[i] = js
        self.roll[:] = 0.0
        self.roll_log = []
        for y in range(2019, 2027):
            for m in (3, 6, 9, 12):
                tf = third_friday(y, m)
                best = None
                for wd in (0, 1):  # Monday and Tuesday evenings: sessions dated Tuesday and Wednesday
                    sess_date = tf - dt.timedelta(days=4 - wd - 1)   # Fri - 3 = Tue (Mon evening), Fri - 2 = Wed (Tue evening)
                    k = np.searchsorted(self.iso, sess_date.isoformat())
                    if k >= self.n or self.iso[k] != sess_date.isoformat() or k == 0:
                        continue
                    jp = firsts[k - 1]
                    jn = firsts[k]
                    if not len(jp) or not len(jn) or jn[0] != 0:
                        continue
                    last_c = self.C[k - 1, jp[-1]]
                    t_last = self.days[k - 1] * 1440 - 360 + jp[-1] * 5 + 5   # end of the previous session's last bar (NY minutes)
                    first_c = self.C[k, jn[0]]
                    t_first = self.days[k] * 1440 - 360 + jn[0] * 5 + 5        # end of this session's first bar
                    jb = np.searchsorted(st, t_last, "right") - 1
                    ja = np.searchsorted(st, t_first, "right") - 1
                    sp = (last_c / sc[jb]) * (sc[ja] - sc[jb])
                    res = (first_c - last_c) - sp
                    if best is None or abs(res) > abs(best[1]):
                        best = (k, res, first_c - last_c, sp)
                if best is not None and abs(best[1]) > 50.0:
                    self.roll[best[0]] = best[1]
                    self.roll_log.append((self.iso[best[0]], round(best[1], 2), round(best[2], 2), round(best[3], 2)))
        self.cum = np.cumsum(self.roll)       # cum[i] = offsets at opens up to and including session i
        # prior RTH close of session i in session i's contract terms
        self.pc = np.full(self.n, NAN)
        last = -1
        for i in range(self.n):
            if last >= 0:
                self.pc[i] = self.rc[last] + (self.cum[i] - self.cum[last])
            if self.has_rth[i]:
                last = i
        # ratio-adjusted daily RTH closes for daily indicators (all levels in the latest contract's terms)
        self.rc_adj = np.where(self.has_rth, self.rc * self._ratio(), NAN)

    def _ratio(self):
        """Back-adjustment ratio per session: the product of (1 + offset / price) of every later roll."""
        r = np.ones(self.n)
        f = 1.0
        for i in range(self.n - 1, -1, -1):
            r[i] = f
            if self.roll[i] != 0.0:
                js = np.flatnonzero(np.isfinite(self.O[i]))
                p_new = self.O[i, js[0]]
                f *= p_new / (p_new - self.roll[i])
        return r

    def _vwap(self):
        """RTH VWAP after each RTH bar closes: cumulative (H+L+C)/3 x volume over volume, from 09:30."""
        tp = (self.H + self.L + self.C) / 3.0
        self.VW = np.full((self.n, NS), NAN)
        for i in range(self.n):
            cv = 0.0
            ctp = 0.0
            for j in range(RTH0, RTH1):
                if np.isfinite(tp[i, j]):
                    cv += self.V[i, j]
                    ctp += tp[i, j] * self.V[i, j]
                if cv > 0:
                    self.VW[i, j] = ctp / cv

    def _calendar(self):
        n = self.n
        dates = self.date
        wd = np.array([d.weekday() for d in dates])
        self.wd = wd
        present = set(dates)
        hol = set()
        for y in range(2019, 2028):
            hol |= nyse_holidays(y)
        d = dates[0]
        while d <= dates[-1] + dt.timedelta(days=7):
            if d.weekday() < 5 and d not in present:
                hol.add(d)
            d += dt.timedelta(days=1)
        self.holiday = np.array([x in hol for x in dates])
        # pre-holiday: the last session before a holiday (the next weekday after it is a holiday)
        pre = np.zeros(n, bool)
        for i in range(n):
            nxt = dates[i] + dt.timedelta(days=1)
            while nxt.weekday() >= 5:
                nxt += dt.timedelta(days=1)
            pre[i] = (nxt in hol) and not self.holiday[i]
        self.pre_holiday = pre
        # turn of the month: last trading session of a month and the first 3 (sessions with an RTH, not holidays)
        trad = [i for i in range(n) if self.has_rth[i] and not self.holiday[i]]
        tom = np.zeros(n, bool)
        for a, b in zip(trad, trad[1:]):
            if dates[a].month != dates[b].month:
                tom[a] = True
        k = 0
        for idx, i in enumerate(trad):
            if idx == 0 or dates[trad[idx - 1]].month != dates[i].month:
                for q in trad[idx:idx + 3]:
                    tom[q] = True
        self.tom = tom
        self.opex = np.array([x == third_friday(x.year, x.month) for x in dates])
        self.quad = self.opex & np.isin([x.month for x in dates], [3, 6, 9, 12])
        fomc = set()
        for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fomc_dates.txt")):
            line = line.strip()
            if line and not line.startswith("#"):
                fomc.add(dt.date.fromisoformat(line))
        self.fomc = np.array([x in fomc for x in dates])
        self.monday = wd == 0
        self.friday = wd == 4

    def attach_book(self, dd):
        """The book's overnight score side and 09:35 drive side per session (engine.Sessions on the same bars)."""
        spx = E.load_npz(os.path.join(dd, "SPXUSD.npz"))
        S = E.Sessions(self.raw, spx, tf=5)
        self.S = S
        self.on_side = np.array([S.on_side(int(d)) if int(d) in S.S else 0 for d in self.days])
        self.od_side = np.array([S.od_side(int(d)) if int(d) in S.S else 0 for d in self.days])
        assert np.allclose(np.array([S.S[int(d)]["adr"] for d in self.days]), self.adr, equal_nan=True)


def load(dd, cut_t=None):
    D = Data(dd, cut_t)
    D.attach_spx(dd)
    D.attach_book(dd)
    return D


# ------------------------------------------------------------------------------------------------ kernels
@njit(cache=True)
def _manage(O, H, L, C, i, side, E0, stop, tgt, j0, jx, emode, xmode):
    """One position from slot j0 to the exit slot jx. Returns (exit price, why, exit slot).
    emode 0: market entry at O[j0] (bar j0's range counts); 1: stop/limit fill inside bar j0 (stop counts there, target
    not); 2: engine convention (entry at the close of bar j0-1, managed from j0).
    xmode 0: time exit at the open of bar jx (strict); 1: at the close of bar jx-1 (engine).
    why: 0 time, 1 stop, 2 target, 3 session end. stop / tgt NaN = none."""
    last = -1
    for j in range(j0, jx):
        if np.isnan(O[i, j]):
            continue
        last = j
        hs = (not np.isnan(stop)) and ((side == 1 and L[i, j] <= stop) or (side == -1 and H[i, j] >= stop))
        ht = (not np.isnan(tgt)) and ((side == 1 and H[i, j] >= tgt + 0.25) or (side == -1 and L[i, j] <= tgt - 0.25))
        if emode == 1 and j == j0:
            ht = False
        if hs:
            op = O[i, j]
            if emode == 1 and j == j0:
                return stop, 1, j          # stopped inside the fill bar: at the stop
            if (side == 1 and op <= stop) or (side == -1 and op >= stop):
                return op, 1, j
            return stop, 1, j
        if ht:
            return tgt, 2, j
    if xmode == 0:
        for j in range(jx, O.shape[1]):
            if not np.isnan(O[i, j]):
                return O[i, j], 0, j       # the first bar at or after the exit time (normally bar jx itself)
        if last >= 0:
            return C[i, last], 3, last     # the session ended before the exit time (half days)
        return E0, 3, j0
    # engine: close of the last bar before jx
    if last >= 0:
        return C[i, last], (0 if last == jx - 1 else 3), last
    return E0, 3, j0


@njit(cache=True)
def _stop_entry(O, H, L, i, buy, sell, j0, j1):
    """First fill of an OCO pair of stop orders live on bars j0..j1. (side, slot, price); side 0 = none or both."""
    for j in range(j0, j1 + 1):
        if np.isnan(O[i, j]):
            continue
        hu = (not np.isnan(buy)) and H[i, j] >= buy
        hd = (not np.isnan(sell)) and L[i, j] <= sell
        if hu and hd:
            return 0, -2, np.nan
        if hu:
            return 1, j, max(buy, O[i, j])
        if hd:
            return -1, j, min(sell, O[i, j])
    return 0, -1, np.nan


@njit(cache=True)
def _limit_entry(O, H, L, i, sell_at, buy_at, j0, j1):
    """First fill of an OCO pair of limit orders (sell at sell_at, buy at buy_at), 1-tick trade-through."""
    for j in range(j0, j1 + 1):
        if np.isnan(O[i, j]):
            continue
        su = (not np.isnan(sell_at)) and H[i, j] >= sell_at + 0.25
        bd = (not np.isnan(buy_at)) and L[i, j] <= buy_at - 0.25
        if su and bd:
            return 0, -2, np.nan
        if su:
            return -1, j, sell_at
        if bd:
            return 1, j, buy_at
    return 0, -1, np.nan


@njit(cache=True)
def _first_bar(O, i, j0, j1):
    for j in range(j0, j1 + 1):
        if not np.isnan(O[i, j]):
            return j
    return -1


@njit(cache=True)
def _last_close_before(O, C, i, j):
    """Close of the last bar before slot j (the price known at slot j's open)."""
    for k in range(j - 1, -1, -1):
        if not np.isnan(O[i, k]):
            return C[i, k], k
    return np.nan, -1


@njit(cache=True)
def _close_at(O, C, i, jx):
    """Market exit at the open of the first bar at or after slot jx; if the session ended before, its last close."""
    for j in range(jx, O.shape[1]):
        if not np.isnan(O[i, j]):
            return O[i, j]
    for j in range(jx - 1, -1, -1):
        if not np.isnan(O[i, j]):
            return C[i, j]
    return np.nan


def pack(n):
    """Per-session result arrays of a configuration: gross points, contract round turns, slippage fills, side."""
    return dict(g=np.zeros(n), rt=np.zeros(n), sf=np.zeros(n), side=np.zeros(n, np.int64))


def net_adr(res, adr, slip=SLIP1):
    with np.errstate(invalid="ignore", divide="ignore"):
        x = (res["g"] - COMM_PTS * res["rt"] - slip * res["sf"]) / adr
    return np.where(res["rt"] > 0, x, 0.0)


def net_pts(res, slip=SLIP1):
    return np.where(res["rt"] > 0, res["g"] - COMM_PTS * res["rt"] - slip * res["sf"], 0.0)


# ------------------------------------------------------------------------------------------------ the book's legs
@njit(cache=True)
def k_book_on(O, H, L, C, side, adr, strict, g, rt, sf):
    """The book's funded overnight leg: 18:10 -> 09:30, stop 0.5 ADR, no target."""
    for i in range(O.shape[0]):
        s = side[i]
        if s == 0 or np.isnan(adr[i]):
            continue
        e = _first_bar(O, i, 1, 184)          # the bar closing at 18:10 (or the first after it, before 09:30)
        if e < 0:
            continue
        x = _first_bar(O, i, 185, 275)        # the bar closing at 09:30
        if x < 0:                             # the session halted before 09:30 (Good Friday 09:15): its last bar
            for q in range(275, e, -1):
                if not np.isnan(O[i, q]):
                    x = q
                    break
            if x < 0:
                continue
        if strict:
            j0 = _first_bar(O, i, e + 1, 275)
            if j0 < 0 or j0 >= 186:
                continue
            E0 = O[i, j0]
            px, why, jj = _manage(O, H, L, C, i, s, E0, E0 - s * 0.5 * adr[i], np.nan, j0, 186, 0, 0)
            sf[i] += 2
        else:
            E0 = C[i, e]
            px, why, jj = _manage(O, H, L, C, i, s, E0, E0 - s * 0.5 * adr[i], np.nan, e + 1, x + 1, 2, 1)
        g[i] += (px - E0) * s
        rt[i] += 1


@njit(cache=True)
def k_book_pyr(O, H, L, C, side, adr, strict, g, rt, sf):
    """The book's 09:35 pyramid: stop 0.35 ADR, add 1 more at +0.15 ADR (stop order, gapped open), stop -> breakeven,
    trail 0.25 ADR from the best price, exit 16:00 (engine.pyramid with fix_gap=True)."""
    for i in range(O.shape[0]):
        s = side[i]
        A = adr[i]
        if s == 0 or np.isnan(A):
            continue
        e = _first_bar(O, i, RTH0, RTH1 - 1)      # the bar closing at 09:35
        if e != RTH0:
            continue
        if strict:
            j0 = _first_bar(O, i, e + 1, RTH1 - 1)
            if j0 < 0:
                continue
            E1 = O[i, j0]
            jend = RTH1
        else:
            E1 = C[i, e]
            j0 = e + 1
            jend = RTH1
        stp = E1 - s * 0.35 * A
        best = E1
        n_ent = 1
        E2 = 0.0
        done = False
        last = -1
        for j in range(j0, jend):
            if np.isnan(O[i, j]):
                continue
            last = j
            hit = (L[i, j] <= stp) if s == 1 else (H[i, j] >= stp)
            if hit:
                op = O[i, j]
                px = op if ((s == 1 and op <= stp) or (s == -1 and op >= stp)) else stp
                g[i] += (px - E1) * s + ((px - E2) * s if n_ent == 2 else 0.0)
                done = True
                break
            fav = H[i, j] if s == 1 else L[i, j]
            if (fav - best) * s > 0:
                best = fav
            if n_ent == 1 and (best - E1) * s >= 0.15 * A:
                lvl = E1 + s * 0.15 * A
                gap = (s == 1 and O[i, j] > lvl) or (s == -1 and O[i, j] < lvl)
                E2 = O[i, j] if gap else lvl
                n_ent = 2
                if (E1 - stp) * s > 0:
                    stp = E1
            ts = best - s * 0.25 * A
            if (ts - stp) * s > 0:
                stp = ts
        if not done:
            if strict:
                px = np.nan
                for j in range(jend, O.shape[1]):
                    if not np.isnan(O[i, j]):
                        px = O[i, j]
                        break
                if np.isnan(px):
                    px = C[i, last] if last >= 0 else E1
            else:
                px = C[i, last] if last >= 0 else E1
            g[i] += (px - E1) * s + ((px - E2) * s if n_ent == 2 else 0.0)
        rt[i] += n_ent
        if strict:
            sf[i] += 2 * n_ent


@njit(cache=True)
def k_book_ib(O, H, L, C, only, adr, strict, g, rt, sf):
    """The book's IB breakout: stop orders 1 tick beyond the 09:30-10:29 range, live 10:30-12:55 bars, only the
    drive's side on a drive day (both, OCO, otherwise), stop 0.25 ADR, target 0.5 ADR, exit 16:00."""
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A):
            continue
        if _first_bar(O, i, RTH0, RTH0) < 0:
            continue
        hi = -1e18
        lo = 1e18
        for j in range(RTH0, 198):
            if not np.isnan(O[i, j]):
                hi = max(hi, H[i, j])
                lo = min(lo, L[i, j])
        if hi < 0:
            continue
        arm = _first_bar(O, i, 197, 275)
        if arm != 197:
            continue
        buy = hi + 0.25 if only[i] >= 0 else np.nan
        sell = lo - 0.25 if only[i] <= 0 else np.nan
        sd, j, px = _stop_entry(O, H, L, i, buy, sell, 198, 227)
        if sd == 0:
            continue
        stop = px - sd * 0.25 * A
        tgt = px + sd * 0.5 * A
        if strict:
            ex, why, jj = _manage(O, H, L, C, i, sd, px, stop, tgt, j, RTH1, 1, 0)
            sf[i] += 1 + (0 if why == 2 else 1)
        else:
            ex, why, jj = _manage(O, H, L, C, i, sd, px, stop, tgt, j, RTH1, 1, 1)
        g[i] += (ex - px) * sd
        rt[i] += 1


def book_legs(D, strict):
    out = {}
    for name, k, side in (("book_overnight", k_book_on, D.on_side), ("book_pyramid", k_book_pyr, D.od_side),
                          ("book_ib", k_book_ib, D.od_side)):
        r = pack(D.n)
        k(D.O, D.H, D.L, D.C, side.astype(np.int64), D.adr, strict, r["g"], r["rt"], r["sf"])
        out[name] = r
    return out



# ------------------------------------------------------------------------------------------------ families
def cslot(hhmm):
    """The slot of the bar that CLOSES at hhmm."""
    return slot(hhmm) - 1


@njit(cache=True)
def _single(O, H, L, C, i, s, E0, dist, R, j0, jx, emode, entry_slip, g, rt, sf, side, es, ep):
    """Book one trade: stop at dist from E0, target R x dist (R <= 0: none). entry_slip: 1 market/stop, 0 limit."""
    stop = E0 - s * dist if dist > 0 else np.nan
    tgt = E0 + s * R * dist if (R > 0 and dist > 0) else np.nan
    px, why, jj = _manage(O, H, L, C, i, s, E0, stop, tgt, j0, jx, emode, 0)
    g[i] += (px - E0) * s
    rt[i] += 1
    sf[i] += entry_slip + (0 if why == 2 else 1)
    side[i] = s
    es[i] = j0
    ep[i] = E0


@njit(cache=True)
def k_f1(O, H, L, C, adr, nb, smode, R, f, flip, g, rt, sf, side, es, ep):
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A):
            continue
        ok = True
        hi = -1e18
        lo = 1e18
        for j in range(RTH0, RTH0 + nb):
            if np.isnan(O[i, j]):
                ok = False
                break
            hi = max(hi, H[i, j])
            lo = min(lo, L[i, j])
        if not ok:
            continue
        mv = C[i, RTH0 + nb - 1] - O[i, RTH0]
        if mv == 0.0 or abs(mv) < f * A:
            continue
        s0 = 1 if mv > 0 else -1
        j0 = _first_bar(O, i, RTH0 + nb, RTH1 - 1)
        if j0 < 0:
            continue
        E0 = O[i, j0]
        if smode == 0:
            dist = (E0 - lo) if s0 == 1 else (hi - E0)
        elif smode == 1:
            dist = 0.10 * A
        else:
            dist = 0.25 * A
        if dist < 0.25:
            continue
        s = -s0 if flip else s0
        _single(O, H, L, C, i, s, E0, dist, R, j0, RTH1, 0, 1, g, rt, sf, side, es, ep)


@njit(cache=True)
def k_f2(O, H, L, C, adr, nb, cut, smode, R, filt, flip, g, rt, sf, side, es, ep):
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A) or not filt[i]:
            continue
        ok = True
        hi = -1e18
        lo = 1e18
        for j in range(RTH0, RTH0 + nb):
            if np.isnan(O[i, j]):
                ok = False
                break
            hi = max(hi, H[i, j])
            lo = min(lo, L[i, j])
        if not ok:
            continue
        s0, j, px = _stop_entry(O, H, L, i, hi + 0.25, lo - 0.25, RTH0 + nb, cut - 1)
        if s0 == 0:
            continue
        if smode == 0:
            dist = (px - (lo - 0.25)) if s0 == 1 else ((hi + 0.25) - px)
        elif smode == 1:
            mid = math.floor((hi + lo) / 2.0 / 0.25) * 0.25
            dist = (px - mid) if s0 == 1 else (mid - px)
        else:
            dist = 0.25 * A
        if dist < 0.25:
            continue
        s = -s0 if flip else s0
        _single(O, H, L, C, i, s, px, dist, R, j, RTH1, 1, 1, g, rt, sf, side, es, ep)


@njit(cache=True)
def k_f3(O, H, L, C, VW, adr, sig, up_ref, dn_ref, m, checks, xmode, g, rt, sf, side, es, ep):
    """Noise area. sig[i, j]: sigma for the bar closing at slot j's close; up_ref / dn_ref: the band anchors.
    xmode 0: opposite band (flip); 1: back inside the current band; 2: max(UB, VWAP) / min(LB, VWAP)."""
    for i in range(O.shape[0]):
        if np.isnan(adr[i]) or np.isnan(up_ref[i]):
            continue
        pos = 0
        E0 = 0.0
        first = True
        for q in range(checks.shape[0]):
            j = checks[q]
            if np.isnan(C[i, j]) or np.isnan(sig[i, j]):
                continue
            c = C[i, j]
            ub = up_ref[i] * (1.0 + m * sig[i, j])
            lb = dn_ref[i] * (1.0 - m * sig[i, j])
            want = pos
            if pos == 0:
                if c > ub:
                    want = 1
                elif c < lb:
                    want = -1
            elif pos == 1:
                if xmode == 0:
                    if c < lb:
                        want = -1
                else:
                    stopv = ub if xmode == 1 else max(ub, VW[i, j])
                    if c < stopv:
                        want = -1 if c < lb else 0
            else:
                if xmode == 0:
                    if c > ub:
                        want = 1
                else:
                    stopv = lb if xmode == 1 else min(lb, VW[i, j])
                    if c > stopv:
                        want = 1 if c > ub else 0
            if want != pos:
                jn = _first_bar(O, i, j + 1, RTH1 - 1)
                if jn < 0:
                    break
                px = O[i, jn]
                if pos != 0:
                    g[i] += (px - E0) * pos
                    sf[i] += 1
                if want != 0:
                    E0 = px
                    rt[i] += 1
                    sf[i] += 1
                    if first:
                        side[i] = want
                        es[i] = jn
                        ep[i] = px
                        first = False
                pos = want
        if pos != 0:
            g[i] += (_close_at(O, C, i, RTH1) - E0) * pos
            sf[i] += 1


@njit(cache=True)
def k_f4(O, H, L, C, adr, pc, pred, mom, q, jdec, stop_on, flip, g, rt, sf, side, es, ep):
    """pred 0 ONFH (prior close -> 10:00), 1 ROD (prior close -> decision), 2 FH (09:30 -> 10:00), 3 MID
    (10:00 -> decision), 4 RTH (09:30 -> decision). jdec = the slot whose close is the decision time."""
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A):
            continue
        op = O[i, RTH0]
        c10 = C[i, 191]
        cd = C[i, jdec]
        if pred == 0:
            P = c10 - pc[i]
        elif pred == 1:
            P = cd - pc[i]
        elif pred == 2:
            P = c10 - op
        elif pred == 3:
            P = cd - c10
        else:
            P = cd - op
        if np.isnan(P) or P == 0.0 or abs(P) < q * A:
            continue
        s0 = 1 if P > 0 else -1
        if not mom:
            s0 = -s0
        j0 = _first_bar(O, i, jdec + 1, RTH1 - 1)
        if j0 < 0:
            continue
        s = -s0 if flip else s0
        _single(O, H, L, C, i, s, O[i, j0], 0.10 * A if stop_on else 0.0, 0.0, j0, RTH1, 0, 1, g, rt, sf, side, es, ep)


@njit(cache=True)
def k_f5t(O, H, L, C, VW, adr, jfirst, step, d, g, rt, sf, side, es, ep):
    """VWAP trend: checks at the closes of slots jfirst, jfirst + step, ... up to 262; flips allowed."""
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A):
            continue
        pos = 0
        E0 = 0.0
        first = True
        j = jfirst
        while j <= 262:
            if not (np.isnan(C[i, j]) or np.isnan(VW[i, j])):
                c = C[i, j]
                want = pos
                if c > VW[i, j] + d * A:
                    want = 1
                elif c < VW[i, j] - d * A:
                    want = -1
                if want != pos:
                    jn = _first_bar(O, i, j + 1, RTH1 - 1)
                    if jn < 0:
                        break
                    px = O[i, jn]
                    if pos != 0:
                        g[i] += (px - E0) * pos
                        sf[i] += 1
                    E0 = px
                    rt[i] += 1
                    sf[i] += 1
                    if first:
                        side[i] = want
                        es[i] = jn
                        ep[i] = px
                        first = False
                    pos = want
            j += step
        if pos != 0:
            g[i] += (_close_at(O, C, i, RTH1) - E0) * pos
            sf[i] += 1


@njit(cache=True)
def k_f5r(O, H, L, C, VW, adr, jlast, k, sdist, flip, g, rt, sf, side, es, ep):
    """VWAP reversion: from the 10:00 close to jlast, fade a close >= k ADR from VWAP; exit with a limit at the
    previous bar's VWAP (1-tick trade-through), a stop sdist ADR away, or 16:00. One trade a session."""
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A):
            continue
        for j in range(191, jlast + 1):
            if np.isnan(C[i, j]) or np.isnan(VW[i, j]):
                continue
            dv = C[i, j] - VW[i, j]
            if abs(dv) < k * A:
                continue
            s0 = -1 if dv > 0 else 1
            j0 = _first_bar(O, i, j + 1, RTH1 - 1)
            if j0 < 0:
                break
            s = -s0 if flip else s0
            E0 = O[i, j0]
            stop = E0 - s * sdist * A
            px = np.nan
            why = 0
            lastb = -1
            for jj in range(j0, RTH1):
                if np.isnan(O[i, jj]):
                    continue
                lastb = jj
                hs = (L[i, jj] <= stop) if s == 1 else (H[i, jj] >= stop)
                if hs:
                    op = O[i, jj]
                    px = op if ((s == 1 and op <= stop) or (s == -1 and op >= stop)) else stop
                    why = 1
                    break
                if jj > j0:
                    tg = VW[i, jj - 1]          # the limit rests at the VWAP known after the previous bar
                    if not np.isnan(tg) and (tg - E0) * s > 0:
                        if (s == 1 and H[i, jj] >= tg + 0.25) or (s == -1 and L[i, jj] <= tg - 0.25):
                            px = tg
                            why = 2
                            break
            if np.isnan(px):
                px = _close_at(O, C, i, RTH1)
                why = 0
            g[i] += (px - E0) * s
            rt[i] += 1
            sf[i] += 1 + (0 if why == 2 else 1)
            side[i] = s
            es[i] = j0
            ep[i] = E0
            break


@njit(cache=True)
def k_f6(O, H, L, C, adr, pc, fade, glo, ghi, jent, xslot, sdist, flip, g, rt, sf, side, es, ep):
    for i in range(O.shape[0]):
        A = adr[i]
        p = pc[i]
        if np.isnan(A) or np.isnan(p) or np.isnan(O[i, RTH0]):
            continue
        if jent == RTH0:
            ref, kk = _last_close_before(O, C, i, RTH0)   # the last price before the open
            if np.isnan(ref) or kk < 150:
                continue
        else:
            ref = O[i, RTH0]
        gp = (ref - p) / A
        if gp == 0.0 or not (glo <= abs(gp) < ghi):
            continue
        s0 = (-1 if gp > 0 else 1) if fade else (1 if gp > 0 else -1)
        if fade and jent > RTH0:
            filled = False
            for j in range(RTH0, jent):
                if not np.isnan(O[i, j]) and L[i, j] <= p <= H[i, j]:
                    filled = True
                    break
            if filled:
                continue
        j0 = _first_bar(O, i, jent, RTH1 - 1)
        if j0 < 0 or j0 > jent + 2:
            continue
        E0 = O[i, j0]
        s = -s0 if flip else s0
        dist = sdist * A
        stop = E0 - s * dist
        tgt = np.nan
        if fade and not flip and (p - E0) * s > 0:
            tgt = p
        if flip and fade:
            # the mirror trade: its "target" is as far on the other side as the gap fill was on this side
            dfill = (p - E0) * s0
            if dfill > 0:
                tgt = E0 + s * dfill
        px, why, jj = _manage(O, H, L, C, i, s, E0, stop, tgt, j0, xslot, 0, 0)
        g[i] += (px - E0) * s
        rt[i] += 1
        sf[i] += 1 + (0 if why == 2 else 1)
        side[i] = s
        es[i] = j0
        ep[i] = E0


@njit(cache=True)
def k_f7(O, H, L, C, adr, brk, cut, sdist, R, flip, g, rt, sf, side, es, ep):
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A):
            continue
        hi = -1e18
        lo = 1e18
        nb = 0
        for j in range(0, RTH0):
            if not np.isnan(O[i, j]):
                hi = max(hi, H[i, j])
                lo = min(lo, L[i, j])
                nb += 1
        if nb < 100:
            continue
        if brk:
            s0, j, px = _stop_entry(O, H, L, i, hi + 0.25, lo - 0.25, RTH0, cut - 1)
            slip_in = 1
        else:
            s0, j, px = _limit_entry(O, H, L, i, hi, lo, RTH0, cut - 1)
            slip_in = 0
        if s0 == 0:
            continue
        s = -s0 if flip else s0
        _single(O, H, L, C, i, s, px, sdist * A, R, j, RTH1, 1, slip_in, g, rt, sf, side, es, ep)


@njit(cache=True)
def k_f8(O, H, L, C, adr, X, k, cut, smode, flip, g, rt, sf, side, es, ep):
    for i in range(O.shape[0]):
        A = adr[i]
        op = O[i, RTH0]
        if np.isnan(A) or np.isnan(X[i]) or np.isnan(op):
            continue
        buy = math.ceil((op + k * X[i]) / 0.25) * 0.25
        sell = math.floor((op - k * X[i]) / 0.25) * 0.25
        s0, j, px = _stop_entry(O, H, L, i, buy, sell, RTH0 + 1, cut - 1)
        if s0 == 0:
            continue
        dist = ((px - op) * s0) if smode == 0 else 0.25 * A
        if dist < 0.25:
            continue
        s = -s0 if flip else s0
        _single(O, H, L, C, i, s, px, dist, 0.0, j, RTH1, 1, 1, g, rt, sf, side, es, ep)


@njit(cache=True)
def k_window(O, H, L, C, adr, ev, sd, jin, jout, stop_adr, g, rt, sf, side, es, ep):
    """Hold side sd[i] (0 = no trade) from the open of slot jin (market) to the open of slot jout, stop stop_adr ADR."""
    for i in range(O.shape[0]):
        if not ev[i] or sd[i] == 0 or np.isnan(adr[i]):
            continue
        j0 = _first_bar(O, i, jin, jout - 1)
        if j0 < 0 or j0 > jin + 2:
            continue
        _single(O, H, L, C, i, sd[i], O[i, j0], stop_adr * adr[i], 0.0, j0, jout, 0, 1, g, rt, sf, side, es, ep)


@njit(cache=True)
def k_asia(O, H, L, C, adr, brk, smode, flip, g, rt, sf, side, es, ep):
    """Asia range (20:00-01:55 bars) breakout (stop orders) or fade (limits), 02:00-05:55 bars, exit 09:25."""
    for i in range(O.shape[0]):
        A = adr[i]
        if np.isnan(A):
            continue
        hi = -1e18
        lo = 1e18
        nb = 0
        for j in range(24, 96):
            if not np.isnan(O[i, j]):
                hi = max(hi, H[i, j])
                lo = min(lo, L[i, j])
                nb += 1
        if nb < 60:
            continue
        if brk:
            s0, j, px = _stop_entry(O, H, L, i, hi + 0.25, lo - 0.25, 96, 143)
            slip_in = 1
        else:
            s0, j, px = _limit_entry(O, H, L, i, hi, lo, 96, 143)
            slip_in = 0
        if s0 == 0:
            continue
        if smode == 0:
            dist = (px - (lo - 0.25)) if s0 == 1 else ((hi + 0.25) - px)
            if not brk:
                dist = hi - lo
        else:
            dist = 0.25 * A
        if dist < 0.25:
            continue
        s = -s0 if flip else s0
        _single(O, H, L, C, i, s, px, dist, 0.0, j, 185, 1, slip_in, g, rt, sf, side, es, ep)



# ------------------------------------------------------------------------------------------------ F11: indicators
@njit(cache=True)
def i_ema(x, n):
    out = np.empty_like(x)
    a = 2.0 / (n + 1.0)
    out[0] = x[0]
    for k in range(1, x.shape[0]):
        out[k] = a * x[k] + (1.0 - a) * out[k - 1]
    return out


@njit(cache=True)
def i_rsi(x, n):
    """Wilder's RSI (seeded with the simple mean of the first n changes)."""
    out = np.full(x.shape[0], np.nan)
    up = 0.0
    dn = 0.0
    for k in range(1, x.shape[0]):
        ch = x[k] - x[k - 1]
        u = ch if ch > 0 else 0.0
        d = -ch if ch < 0 else 0.0
        if k <= n:
            up += u / n
            dn += d / n
            if k == n:
                out[k] = 100.0 if dn == 0 else 100.0 - 100.0 / (1.0 + up / dn)
        else:
            up = (up * (n - 1) + u) / n
            dn = (dn * (n - 1) + d) / n
            out[k] = 100.0 if dn == 0 else 100.0 - 100.0 / (1.0 + up / dn)
    return out


@njit(cache=True)
def i_sma_sd(x, n):
    m = np.full(x.shape[0], np.nan)
    sd = np.full(x.shape[0], np.nan)
    for k in range(n - 1, x.shape[0]):
        w = x[k - n + 1:k + 1]
        mu = w.mean()
        m[k] = mu
        sd[k] = math.sqrt(((w - mu) ** 2).mean())
    return m, sd


@njit(cache=True)
def i_atr(h, l, c, n):
    out = np.full(h.shape[0], np.nan)
    tr = np.empty(h.shape[0])
    tr[0] = h[0] - l[0]
    for k in range(1, h.shape[0]):
        tr[k] = max(h[k] - l[k], abs(h[k] - c[k - 1]), abs(l[k] - c[k - 1]))
    acc = 0.0
    for k in range(h.shape[0]):
        if k < n:
            acc += tr[k]
            if k == n - 1:
                out[k] = acc / n
        else:
            out[k] = (out[k - 1] * (n - 1) + tr[k]) / n
    return out


@njit(cache=True)
def i_supertrend(h, l, c, n, mult):
    atr = i_atr(h, l, c, n)
    dirn = np.zeros(h.shape[0], np.int64)
    fu = 0.0
    fl = 0.0
    d = 1
    for k in range(h.shape[0]):
        if np.isnan(atr[k]):
            continue
        mid = (h[k] + l[k]) / 2.0
        bu = mid + mult * atr[k]
        bl = mid - mult * atr[k]
        if k == 0 or dirn[k - 1] == 0:
            fu, fl, d = bu, bl, 1
        else:
            fu = bu if (bu < fu or c[k - 1] > fu) else fu
            fl = bl if (bl > fl or c[k - 1] < fl) else fl
            if d == 1 and c[k] < fl:
                d = -1
            elif d == -1 and c[k] > fu:
                d = 1
        dirn[k] = d
    return dirn


@njit(cache=True)
def i_adx(h, l, c, n):
    out = np.full(h.shape[0], np.nan)
    trs = 0.0
    pds = 0.0
    mds = 0.0
    adx = 0.0
    cnt = 0
    for k in range(1, h.shape[0]):
        up = h[k] - h[k - 1]
        dn = l[k - 1] - l[k]
        pdm = up if (up > dn and up > 0) else 0.0
        mdm = dn if (dn > up and dn > 0) else 0.0
        tr = max(h[k] - l[k], abs(h[k] - c[k - 1]), abs(l[k] - c[k - 1]))
        if k <= n:
            trs += tr
            pds += pdm
            mds += mdm
            if k < n:
                continue
        else:
            trs = trs - trs / n + tr
            pds = pds - pds / n + pdm
            mds = mds - mds / n + mdm
        pdi = 100.0 * pds / trs if trs > 0 else 0.0
        mdi = 100.0 * mds / trs if trs > 0 else 0.0
        dx = 100.0 * abs(pdi - mdi) / (pdi + mdi) if (pdi + mdi) > 0 else 0.0
        cnt += 1
        if cnt <= n:
            adx += dx / n
            if cnt == n:
                out[k] = adx
        else:
            adx = (adx * (n - 1) + dx) / n
            out[k] = adx
    return out


@njit(cache=True)
def i_prev_max_min(h, l, n):
    hi = np.full(h.shape[0], np.nan)
    lo = np.full(h.shape[0], np.nan)
    for k in range(n, h.shape[0]):
        hi[k] = h[k - n:k].max()
        lo[k] = l[k - n:k].min()
    return hi, lo


class RTHSeries:
    """The RTH bars of every session as one series (back-adjusted to the latest contract), with a map to (i, j)."""

    def __init__(self, D):
        idx_i, idx_j = np.nonzero(np.isfinite(D.O[:, RTH0:RTH1]))
        idx_j = idx_j + RTH0
        adj = (D.cum[-1] - D.cum)[idx_i]
        self.i, self.j = idx_i, idx_j
        self.o = D.O[idx_i, idx_j] + adj
        self.h = D.H[idx_i, idx_j] + adj
        self.l = D.L[idx_i, idx_j] + adj
        self.c = D.C[idx_i, idx_j] + adj
        self.n, self.shape = D.n, D.O.shape

    def grid(self, x, fill=np.nan):
        out = np.full(self.shape, fill, dtype=np.asarray(x).dtype if np.asarray(x).dtype != bool else bool)
        out[self.i, self.j] = x
        return out


def cross_up(a, b):
    """a crosses above b at bar k (k vs k-1 of the series)."""
    a = np.asarray(a, float); b = np.asarray(b, float) * np.ones_like(a)
    out = np.zeros(a.shape[0], bool)
    out[1:] = (a[1:] > b[1:]) & (a[:-1] <= b[:-1])
    return out


def cross_dn(a, b):
    a = np.asarray(a, float); b = np.asarray(b, float) * np.ones_like(a)
    out = np.zeros(a.shape[0], bool)
    out[1:] = (a[1:] < b[1:]) & (a[:-1] >= b[:-1])
    return out


def f11_rules(R):
    """The 25 base rules: name -> (long entry, short entry, long exit, short exit) on the RTH series."""
    c, h, l = R.c, R.h, R.l
    rules = {}
    for f, sl_ in ((5, 20), (9, 21), (12, 26), (20, 50)):
        ef, es_ = i_ema(c, f), i_ema(c, sl_)
        le, se = cross_up(ef, es_), cross_dn(ef, es_)
        rules[f"ema{f}x{sl_}"] = (le, se, se, le)
    macd = i_ema(c, 12) - i_ema(c, 26)
    sig = i_ema(macd, 9)
    le, se = cross_up(macd, sig), cross_dn(macd, sig)
    rules["macd"] = (le, se, se, le)
    for n, levels in ((2, (10, 20)), (7, (20, 30)), (14, (20, 30))):
        r = i_rsi(c, n)
        for a in levels:
            rules[f"rsi{n}fade{a}"] = (cross_dn(r, a), cross_up(r, 100 - a), cross_up(r, 50), cross_dn(r, 50))
    for n in (2, 7, 14):
        r = i_rsi(c, n)
        le, se = cross_up(r, 60), cross_dn(r, 40)
        rules[f"rsi{n}trend"] = (le, se, se, le)
    m, sd = i_sma_sd(c, 20)
    for k in (2.0, 2.5):
        ub, lb = m + k * sd, m - k * sd
        rules[f"bb{k}fade"] = (cross_dn(c, lb), cross_up(c, ub), cross_up(c, m), cross_dn(c, m))
        rules[f"bb{k}brk"] = (cross_up(c, ub), cross_dn(c, lb), cross_dn(c, m), cross_up(c, m))
    for n in (12, 24, 48):
        hi, lo = i_prev_max_min(h, l, n)
        le, se = cross_up(c, hi), cross_dn(c, lo)
        rules[f"don{n}"] = (le, se, se, le)
    for mult in (2.0, 3.0):
        d = i_supertrend(h, l, c, 10, mult)
        le = np.zeros_like(d, bool); se = np.zeros_like(d, bool)
        le[1:] = (d[1:] == 1) & (d[:-1] == -1)
        se[1:] = (d[1:] == -1) & (d[:-1] == 1)
        rules[f"st{int(mult)}"] = (le, se, se, le)
    e20 = i_ema(c, 20)
    a10 = i_atr(h, l, c, 10)
    ku, kl = e20 + 2 * a10, e20 - 2 * a10
    rules["kelfade"] = (cross_dn(c, kl), cross_up(c, ku), cross_up(c, e20), cross_dn(c, e20))
    rules["kelbrk"] = (cross_up(c, ku), cross_dn(c, kl), cross_dn(c, e20), cross_up(c, e20))
    assert len(rules) == 25, len(rules)
    return rules


def f11_mixes(R, vw_series, c_raw):
    """27 = 3 trend sides x 3 triggers (x 3 exits later): trend side up/down arrays and triggers. The VWAP side
    compares the raw close with the (raw) session VWAP; everything else runs on the back-adjusted series."""
    c, h, l = R.c, R.h, R.l
    e20, e50 = i_ema(c, 20), i_ema(c, 50)
    st = i_supertrend(h, l, c, 10, 3.0)
    sides = {"ema20>50": (e20 > e50, e20 < e50), "vwap": (c_raw > vw_series, c_raw < vw_series), "st3": (st == 1, st == -1)}
    r2 = i_rsi(c, 2)
    m, sd = i_sma_sd(c, 20)
    ub, lb = m + 2 * sd, m - 2 * sd
    tl = np.zeros(len(c), bool); ts = np.zeros(len(c), bool)
    tl[1:] = (l[1:] <= lb[1:]) & ~(l[:-1] <= lb[:-1])
    ts[1:] = (h[1:] >= ub[1:]) & ~(h[:-1] >= ub[:-1])
    hi, lo = i_prev_max_min(h, l, 12)
    trig = {"rsi2pull": (cross_dn(r2, 10), cross_up(r2, 90)), "bbtouch": (tl, ts), "don12": (cross_up(c, hi), cross_dn(c, lo))}
    out = {}
    for sn, (up, dn) in sides.items():
        for tn, (tlg, tsh) in trig.items():
            out[f"mix_{sn}_{tn}"] = (up & tlg, dn & tsh, ~up, ~dn)
    return out


@njit(cache=True)
def k_f11(O, H, L, C, adr, atr, le, se, lx, sx, al, as_, xmode, g, rt, sf, side, es, ep):
    """Entries at bar closes 09:45-15:00 (slots 188-251), one position at a time, at most 3 trades a session.
    xmode 0: exit on the rule's exit event; 1: a 2 x ATR(14) stop plus the exit event; 2: a 60-minute time stop.
    All flat at 16:00."""
    for i in range(O.shape[0]):
        if np.isnan(adr[i]):
            continue
        pos = 0
        E0 = 0.0
        stop = np.nan
        jt = 0
        ntr = 0
        first = True
        j = RTH0
        while j < RTH1:
            if np.isnan(O[i, j]):
                j += 1
                continue
            # 1. an open position's stop inside this bar (market entries were at an earlier bar's open)
            if pos != 0 and xmode == 1 and not np.isnan(stop):
                if (pos == 1 and L[i, j] <= stop) or (pos == -1 and H[i, j] >= stop):
                    op = O[i, j]
                    px = op if ((pos == 1 and op <= stop) or (pos == -1 and op >= stop)) else stop
                    g[i] += (px - E0) * pos
                    sf[i] += 1
                    pos = 0
            # 2. time stop: exit at the open of the bar 60 minutes after the entry bar
            if pos != 0 and xmode == 2 and j >= jt:
                g[i] += (O[i, j] - E0) * pos
                sf[i] += 1
                pos = 0
            # 3. decisions at this bar's close, filled at the next bar's open
            want = pos
            if pos == 1 and xmode != 2 and lx[i, j]:
                want = 0
            elif pos == -1 and xmode != 2 and sx[i, j]:
                want = 0
            if want == 0 and ntr < 3 and 188 <= j <= 251:
                if le[i, j] and al[i, j]:
                    want = 1
                elif se[i, j] and as_[i, j]:
                    want = -1
            if want != pos:
                jn = _first_bar(O, i, j + 1, RTH1 - 1)
                if jn < 0:
                    break
                px = O[i, jn]
                if pos != 0:
                    g[i] += (px - E0) * pos
                    sf[i] += 1
                if want != 0:
                    E0 = px
                    rt[i] += 1
                    sf[i] += 1
                    ntr += 1
                    stop = (px - want * 2.0 * atr[i, j]) if (xmode == 1 and not np.isnan(atr[i, j])) else np.nan
                    jt = jn + 12
                    if first:
                        side[i] = want
                        es[i] = jn
                        ep[i] = px
                        first = False
                pos = want
                j = jn
                continue
            j += 1
        if pos != 0:
            g[i] += (_close_at(O, C, i, RTH1) - E0) * pos
            sf[i] += 1


# ------------------------------------------------------------------------------------------------ F12: Silver Bullet
@njit(cache=True)
def _untouched_hi(H, O, i, lvl, j0, j1):
    for j in range(j0, j1):
        if not np.isnan(O[i, j]) and H[i, j] >= lvl:
            return False
    return True


@njit(cache=True)
def _untouched_lo(L, O, i, lvl, j0, j1):
    for j in range(j0, j1):
        if not np.isnan(O[i, j]) and L[i, j] <= lvl:
            return False
    return True


@njit(cache=True)
def k_f12(O, H, L, C, adr, atr, prh, prl, ws, we, tmode, flip, g, rt, sf, side, es, ep):
    """ICT Silver Bullet in window [ws, we) (slots): sweep of an untouched level, a displacement gap, a limit at its
    near edge, stop 1 tick beyond the sweep's extreme, target per tmode (0 nearest opposite level >= 1.5R else skip,
    1 2R, 2 3R), time stop 60 minutes after the window."""
    for i in range(O.shape[0]):
        if np.isnan(adr[i]):
            continue
        # liquidity levels known at the window's start: (value, start slot of the untouched check)
        his = np.full(64, np.nan)
        los = np.full(64, np.nan)
        nh = 0
        nl = 0
        if not np.isnan(prh[i]) and _untouched_hi(H, O, i, prh[i], 0, ws):
            his[nh] = prh[i]; nh += 1
        if not np.isnan(prl[i]) and _untouched_lo(L, O, i, prl[i], 0, ws):
            los[nl] = prl[i]; nl += 1
        segs = ((24, 72), (96, 132))   # Asia 20:00-23:55, London 02:00-04:55
        for q in range(2):
            a, b = segs[q]
            if b > ws:
                continue
            hi = -1e18
            lo = 1e18
            for j in range(a, b):
                if not np.isnan(O[i, j]):
                    hi = max(hi, H[i, j]); lo = min(lo, L[i, j])
            if hi > 0:
                if _untouched_hi(H, O, i, hi, b, ws):
                    his[nh] = hi; nh += 1
                if _untouched_lo(L, O, i, lo, b, ws):
                    los[nl] = lo; nl += 1
        hi = -1e18
        lo = 1e18
        for j in range(ws - 12, ws):
            if not np.isnan(O[i, j]):
                hi = max(hi, H[i, j]); lo = min(lo, L[i, j])
        if hi > 0:
            his[nh] = hi; nh += 1
            los[nl] = lo; nl += 1
        for k in range(max(5, ws - 72), ws - 5):
            if np.isnan(O[i, k]):
                continue
            okh = True
            okl = True
            for q in range(k - 5, k + 6):
                if q == k or np.isnan(O[i, q]):
                    continue
                if H[i, q] >= H[i, k]:
                    okh = False
                if L[i, q] <= L[i, k]:
                    okl = False
            if okh and nh < 64 and _untouched_hi(H, O, i, H[i, k], k + 6, ws):
                his[nh] = H[i, k]; nh += 1
            if okl and nl < 64 and _untouched_lo(L, O, i, L[i, k], k + 6, ws):
                los[nl] = L[i, k]; nl += 1
        # the sweep
        js = -1
        s0 = 0
        for j in range(ws, we):
            if np.isnan(O[i, j]):
                continue
            sh = False
            sl_ = False
            for q in range(nh):
                if H[i, j] >= his[q] + 0.25:
                    sh = True
            for q in range(nl):
                if L[i, j] <= los[q] - 0.25:
                    sl_ = True
            if sh and sl_:
                break
            if sh:
                js, s0 = j, -1
                break
            if sl_:
                js, s0 = j, 1
                break
        if js < 0:
            continue
        # the displacement gap after the sweep, and its limit order
        ext = H[i, js] if s0 == -1 else L[i, js]
        done = False
        for j in range(js + 2, we):
            b1, b2, b3 = j - 2, j - 1, j
            if np.isnan(O[i, b1]) or np.isnan(O[i, b2]) or np.isnan(O[i, b3]):
                continue
            for q in range(js, j + 1):
                if not np.isnan(O[i, q]):
                    ext = max(ext, H[i, q]) if s0 == -1 else min(ext, L[i, q])
            A = atr[i, b2]
            if np.isnan(A) or b1 < js:
                continue
            if s0 == -1:
                body = O[i, b2] - C[i, b2]
                gap = L[i, b1] - H[i, b3]
                entry = H[i, b3]
            else:
                body = C[i, b2] - O[i, b2]
                gap = L[i, b3] - H[i, b1]
                entry = L[i, b3]
            if body < A or gap < max(0.1 * A, 0.5):
                continue
            # armed: the first gap only
            stop = ext + 0.25 if s0 == -1 else ext - 0.25
            R = (stop - entry) * (-s0)
            if R < 0.25:
                break
            if tmode == 0:
                best = np.nan
                if s0 == -1:
                    for q in range(nl):
                        if los[q] < entry and (np.isnan(best) or los[q] > best):
                            best = los[q]
                    dt_ = (entry - best) if not np.isnan(best) else 2.0 * R
                else:
                    for q in range(nh):
                        if his[q] > entry and (np.isnan(best) or his[q] < best):
                            best = his[q]
                    dt_ = (best - entry) if not np.isnan(best) else 2.0 * R
                if dt_ < 1.5 * R:
                    break
                tdist = dt_
            else:
                tdist = (2.0 if tmode == 1 else 3.0) * R
            sd, jf, px = (0, -1, np.nan)
            if s0 == -1:
                sd, jf, px = _limit_entry(O, H, L, i, entry, np.nan, j + 1, we - 1)
            else:
                sd, jf, px = _limit_entry(O, H, L, i, np.nan, entry, j + 1, we - 1)
            if sd == 0:
                break
            s = -s0 if flip else s0
            _single(O, H, L, C, i, s, px, R, tdist / R, jf, we + 12, 1, 0, g, rt, sf, side, es, ep)
            done = True
            break



# ------------------------------------------------------------------------------------------------ inputs and configs
class Inputs:
    """Everything the families read, computed once from bars closed before each decision."""

    def __init__(self, D):
        n = D.n
        self.D = D
        A = D.adr
        # previous RTH session index (for daily features) and roll-adjusted prior highs/lows
        prev = np.full(n, -1)
        last = -1
        for i in range(n):
            prev[i] = last
            if D.has_rth[i]:
                last = i
        self.prev = prev
        adjk = lambda i, k: D.cum[i] - D.cum[k]
        self.prh = np.array([D.rh[k] + adjk(i, k) if k >= 0 else NAN for i, k in enumerate(prev)])
        self.prl = np.array([D.rl[k] + adjk(i, k) if k >= 0 else NAN for i, k in enumerate(prev)])
        rng = D.rh - D.rl
        # F2 filters from completed prior sessions (full RTH only)
        nr4 = np.zeros(n, bool); nr7 = np.zeros(n, bool); ins = np.zeros(n, bool)
        fulls = [i for i in range(n) if D.full[i]]
        pos_of = {i: q for q, i in enumerate(fulls)}
        for i in range(n):
            k = prev[i]
            if k < 0 or k not in pos_of:
                continue
            q = pos_of[k]
            if q >= 3:
                w = [rng[fulls[x]] for x in range(q - 3, q + 1)]
                nr4[i] = rng[k] < min(w[:-1])
            if q >= 6:
                w = [rng[fulls[x]] for x in range(q - 6, q + 1)]
                nr7[i] = rng[k] < min(w[:-1])
            if q >= 1:
                k2 = fulls[q - 1]
                ins[i] = (D.rh[k] < D.rh[k2] + adjk(k, k2)) and (D.rl[k] > D.rl[k2] + adjk(k, k2))
        self.f2filt = {"none": np.ones(n, bool), "nr4": nr4, "nr7": nr7, "inside": ins}
        # F3 sigma per lookback: mean |close at slot j / open - 1| over the previous n sessions with that bar
        op = D.O[:, RTH0]
        mv = np.abs(D.C / op[:, None] - 1.0)
        mv[:, :RTH0] = NAN
        mv[:, RTH1:] = NAN
        self.sig = {}
        for lb in (7, 14, 21):
            sg = np.full((n, NS), NAN)
            for j in range(RTH0, RTH1):
                col = mv[:, j]
                vi = np.flatnonzero(np.isfinite(col) & D.full)
                vals = col[vi]
                cs = np.r_[0.0, np.cumsum(vals)]
                for i in range(n):
                    k = np.searchsorted(vi, i)          # valid sessions strictly before i
                    if k >= lb:
                        sg[i, j] = (cs[k] - cs[k - lb]) / lb
            self.sig[lb] = sg
        pc = D.pc
        self.up_gap = np.where(np.isfinite(pc), np.maximum(op, pc), NAN)
        self.dn_gap = np.where(np.isfinite(pc), np.minimum(op, pc), NAN)
        # F8 references
        stretch = np.full(n, NAN)
        st_raw = np.minimum(D.rh - D.ro, D.ro - D.rl)
        for i in range(n):
            ks = [k for k in fulls if k < i][-10:]
            if len(ks) == 10:
                stretch[i] = np.mean(st_raw[ks])
        prior_rng = np.array([rng[k] if k >= 0 and D.full[k] else NAN for k in prev])
        self.f8x = {"prior_range": prior_rng, "adr": A.copy(), "stretch": stretch}
        # F10 daily signals at the prior RTH close (ratio-adjusted closes)
        rc = D.rc_adj
        ibs = np.where(D.rh > D.rl, (D.rc - D.rl) / (D.rh - D.rl), 0.5)
        fidx = np.array(fulls)
        rsi = np.full(n, NAN)
        r_on_full = np.asarray(i_rsi(rc[fidx], 2))
        rsi[fidx] = r_on_full
        nlo = {N: np.zeros(n, bool) for N in (3, 5, 10)}
        nhi = {N: np.zeros(n, bool) for N in (3, 5, 10)}
        stdn = np.zeros(n, np.int64); stup = np.zeros(n, np.int64)
        for q, k in enumerate(fulls):
            for N in (3, 5, 10):
                if q >= N - 1:
                    w = rc[fidx[q - N + 1:q + 1]]
                    nlo[N][k] = rc[k] <= w.min()
                    nhi[N][k] = rc[k] >= w.max()
            if q >= 1:
                stdn[k] = stdn[fulls[q - 1]] + 1 if rc[k] < rc[fulls[q - 1]] else 0
                stup[k] = stup[fulls[q - 1]] + 1 if rc[k] > rc[fulls[q - 1]] else 0
        f10 = {}
        for lo_, hi_ in ((0.1, 0.9), (0.2, 0.8), (0.3, 0.7)):
            f10[f"ibs{lo_}"] = np.where(ibs <= lo_, 1, np.where(ibs >= hi_, -1, 0))
        for lo_, hi_ in ((5, 95), (10, 90), (20, 80)):
            f10[f"rsi2_{lo_}"] = np.where(rsi <= lo_, 1, np.where(rsi >= hi_, -1, 0))
        for N in (3, 5, 10):
            f10[f"nday{N}"] = np.where(nlo[N], 1, np.where(nhi[N], -1, 0))
        for N in (2, 3, 4):
            f10[f"streak{N}"] = np.where(stdn >= N, 1, np.where(stup >= N, -1, 0))
        self.f10 = {}
        for k_, a in f10.items():
            sd_ = np.zeros(n, np.int64)
            for i in range(n):
                k = prev[i]
                if k >= 0 and D.full[k] and np.isfinite(rc[k]):
                    sd_[i] = a[k]
            self.f10[k_] = sd_
        # F9 events
        dn_mon = np.zeros(n, bool)
        for i in range(n):
            k = prev[i]
            if D.wd[i] == 1 and k >= 0 and D.wd[k] == 0 and np.isfinite(pc[k]) and D.rc[k] < pc[k]:
                dn_mon[i] = True
        self.f9 = {"tom": D.tom, "preholiday": D.pre_holiday, "fomc": D.fomc, "monday": D.monday, "turnaround_tue": dn_mon,
                   "friday": D.friday, "opex": D.opex, "quad": D.quad}
        # F11 / F12 series
        self.R = RTHSeries(D)
        R = self.R
        vw_series = D.VW[R.i, R.j]
        self.f11_rules = {k_: tuple(R.grid(x, False) for x in v) for k_, v in f11_rules(R).items()}
        self.f11_mixes = {k_: tuple(R.grid(x, False) for x in v) for k_, v in f11_mixes(R, vw_series, D.C[R.i, R.j]).items()}
        self.atr_rth = R.grid(i_atr(R.h, R.l, R.c, 14))
        e5 = np.full(n, NAN)
        for i in range(n):
            k = prev[i]
            ks = [x for x in fulls if x <= k][-5:] if k >= 0 else []
            if len(ks) == 5:
                e5[i] = np.mean(rc[ks])
        prior_rc = np.array([rc[k] if k >= 0 else NAN for k in prev])
        trend_up = prior_rc > e5
        trend_dn = prior_rc < e5
        adx = R.grid(i_adx(R.h, R.l, R.c, 14))
        ones = np.ones((n, NS), bool)
        vwl = D.C > D.VW
        vws = D.C < D.VW
        bs = D.on_side
        self.f11_filters = {
            "none": (ones, ones),
            "vwap": (vwl, vws),
            "daily_trend": (np.repeat(trend_up[:, None], NS, 1), np.repeat(trend_dn[:, None], NS, 1)),
            "adx25": (adx > 25, adx > 25),
            "book_signal": (np.repeat((bs >= 0)[:, None], NS, 1), np.repeat((bs <= 0)[:, None], NS, 1)),
        }
        # all-bars ATR(14) for F12, continuous across sessions (back-adjusted)
        ii, jj = np.nonzero(np.isfinite(D.O))
        adj = (D.cum[-1] - D.cum)[ii]
        a_all = i_atr(D.H[ii, jj] + adj, D.L[ii, jj] + adj, D.C[ii, jj] + adj, 14)
        self.atr_all = np.full((n, NS), NAN)
        self.atr_all[ii, jj] = a_all


def configs():
    """Every configuration of PREREG_R7, in a fixed order. Each is a dict: fam, id, kind, params."""
    out = []
    add = lambda fam, cid, kind, **p: out.append(dict(fam=fam, id=f"{fam}|{cid}", kind=kind, **p))
    for L_ in (5, 15, 30):
        for sm, sn in ((0, "extreme"), (1, "0.10adr"), (2, "0.25adr")):
            for R in (0, 2, 5, 10):
                for f in (0.0, 0.05, 0.10):
                    add("F1", f"or{L_}|stop_{sn}|tgt{R}R|f{f}", "single", nb=L_ // 5, smode=sm, R=float(R), f=f)
    for L_ in (5, 15, 30, 60):
        for cut in ("11:00", "13:00", "15:00"):
            for sm, sn in ((0, "otherside"), (1, "mid"), (2, "0.25adr")):
                for R in (0, 1, 2):
                    for flt in ("none", "nr4", "nr7", "inside"):
                        add("F2", f"or{L_}|until{cut}|stop_{sn}|tgt{R}R|{flt}", "single", nb=L_ // 5, cut=slot(cut), smode=sm, R=float(R), filt=flt)
    chk30 = np.array([191 + 6 * k for k in range(12)], np.int64)
    chk60 = np.array([191 + 12 * k for k in range(6)], np.int64)
    for lb in (7, 14, 21):
        for m in (1.0, 1.25, 1.5):
            for kname, ck in (("30", chk30), ("60", chk60)):
                for gapadj in (True, False):
                    for xm, xn in ((0, "flip"), (1, "band"), (2, "band+vwap")):
                        add("F3", f"n{lb}|m{m}|every{kname}|gap{int(gapadj)}|exit_{xn}", "flip", lb=lb, m=m, checks=ck, gapadj=gapadj, xmode=xm)
    for pn, pid in (("ONFH", 0), ("ROD", 1), ("FH", 2), ("MID", 3), ("RTH", 4)):
        for mom in (True, False):
            for q in (0.0, 0.25, 0.5):
                for win, jdec in (("15:30", cslot("15:30")), ("15:00", cslot("15:00"))):
                    for st in (False, True):
                        add("F4", f"{pn}|{'mom' if mom else 'rev'}|q{q}|from{win}|stop{int(st)}", "single", pred=pid, mom=mom, q=q, jdec=jdec, stop_on=st)
    for t0, jf in (("09:35", cslot("09:35")), ("10:00", cslot("10:00"))):
        for stp, sn in ((1, "bar"), (6, "30min")):
            for d in (0.0, 0.02, 0.05, 0.10):
                add("F5", f"trend|from{t0}|every_{sn}|d{d}", "flip", sub="trend", jfirst=jf, step=stp, d=d)
    for cut in ("12:00", "15:00"):
        for k in (0.25, 0.40, 0.60):
            for sd in (0.25, 0.50):
                add("F5", f"revert|until{cut}|k{k}|stop{sd}", "single", sub="revert", jlast=cslot(cut), k=k, sdist=sd)
    for fade in (True, False):
        for lo_, hi_ in ((0.05, 0.25), (0.25, 0.50), (0.50, np.inf), (0.10, np.inf)):
            for ent in ("09:30", "09:35", "10:00"):
                for sd in (0.25, 0.50):
                    for xt in ("11:00", "16:00"):
                        add("F6", f"{'fade' if fade else 'cont'}|g{lo_}-{hi_}|at{ent}|stop{sd}|exit{xt}", "single", fade=fade, glo=lo_, ghi=hi_, jent=slot(ent), sdist=sd, xslot=slot(xt))
    for brk in (True, False):
        for cut in ("11:00", "13:00", "15:00"):
            for sd in (0.15, 0.25, 0.50):
                for R in (0, 1, 2):
                    add("F7", f"{'breakout' if brk else 'fade'}|until{cut}|stop{sd}|tgt{R}R", "single", brk=brk, cut=slot(cut), sdist=sd, R=float(R))
    for xn in ("prior_range", "adr", "stretch"):
        for k in (0.2, 0.3, 0.4, 0.5, 0.6):
            for cut in ("13:00", "15:30"):
                for sm, sn in ((0, "open"), (1, "0.25adr")):
                    add("F8", f"{xn}|k{k}|until{cut}|stop_{sn}", "single", x=xn, k=k, cut=slot(cut), smode=sm)
    for ev in ("tom", "preholiday", "fomc", "monday", "turnaround_tue", "friday", "opex", "quad"):
        for win, (ji, jo) in (("rth", (RTH0, RTH1)), ("overnight", (2, RTH0))):
            for st in (0.0, 0.5):
                add("F9", f"{ev}|{win}|stop{st}", "long", ev=ev, jin=ji, jout=jo, stop=st)
    for st in (0.0, 0.5):
        add("F9", f"fomc|09:30-14:00|stop{st}", "long", ev="fomc", jin=RTH0, jout=slot("14:00"), stop=st)
    for sig in ("ibs0.1", "ibs0.2", "ibs0.3", "rsi2_5", "rsi2_10", "rsi2_20", "nday3", "nday5", "nday10", "streak2", "streak3", "streak4"):
        for sides in ("long", "both"):
            for hold, jo in (("to09:30", RTH0), ("to16:00", RTH1)):
                for st in (0.0, 0.5):
                    add("F10", f"{sig}|{sides}|{hold}|stop{st}", "long" if sides == "long" else "single", sig=sig, sides=sides, jout=jo, stop=st)
    for rule in ("ema5x20", "ema9x21", "ema12x26", "ema20x50", "macd", "rsi2fade10", "rsi2fade20", "rsi7fade20", "rsi7fade30",
                 "rsi14fade20", "rsi14fade30", "rsi2trend", "rsi7trend", "rsi14trend", "bb2.0fade", "bb2.0brk", "bb2.5fade",
                 "bb2.5brk", "don12", "don24", "don48", "st2", "st3", "kelfade", "kelbrk"):
        for xm, xn in ((0, "signal"), (1, "atrstop"), (2, "60min")):
            for flt in ("none", "vwap", "daily_trend", "adx25", "book_signal"):
                add("F11", f"{rule}|exit_{xn}|{flt}", "flip", rule=rule, mix=False, xmode=xm, filt=flt)
    for side_ in ("ema20>50", "vwap", "st3"):
        for trig in ("rsi2pull", "bbtouch", "don12"):
            for xm, xn in ((0, "signal"), (1, "atrstop"), (2, "60min")):
                add("F11", f"mix_{side_}_{trig}|exit_{xn}", "flip", rule=f"mix_{side_}_{trig}", mix=True, xmode=xm, filt="none")
    for wn, (ws, we) in (("03-04", ("03:00", "04:00")), ("10-11", ("10:00", "11:00")), ("14-15", ("14:00", "15:00"))):
        for tm, tn in ((0, "liquidity"), (1, "2R"), (2, "3R")):
            add("F12", f"{wn}|tgt_{tn}", "single", ws=slot(ws), we=slot(we), tmode=tm)
    for wn, (a, b) in (("02:00-03:00", ("02:00", "03:00")), ("02:00-04:00", ("02:00", "04:00")), ("18:10-09:30", ("18:10", "09:30")),
                       ("18:10-02:00", ("18:10", "02:00")), ("04:00-09:30", ("04:00", "09:30"))):
        add("F13", f"drift|{wn}", "drift", jin=slot(a), jout=slot(b))
    for brk in (True, False):
        for sm, sn in ((0, "otherside"), (1, "0.25adr")):
            add("F13", f"asia_{'breakout' if brk else 'fade'}|stop_{sn}", "single", brk=brk, smode=sm)
    assert len(out) == 1556, len(out)
    assert len({c["id"] for c in out}) == 1556
    return out


def run(P, c, flip=False, all_days=False):
    """One configuration over every session. flip: the opposite side of every trade (mirrored stops and targets).
    all_days (long-only rules): hold the window on every session (the random-day control's population)."""
    D = P.D
    n = D.n
    r = pack(n)
    r["es"] = np.full(n, -1, np.int64)
    r["ep"] = np.full(n, NAN)
    a = (D.O, D.H, D.L, D.C)
    out = (r["g"], r["rt"], r["sf"], r["side"], r["es"], r["ep"])
    f = c["fam"]
    if f == "F1":
        k_f1(*a, D.adr, c["nb"], c["smode"], c["R"], c["f"], flip, *out)
    elif f == "F2":
        k_f2(*a, D.adr, c["nb"], c["cut"], c["smode"], c["R"], P.f2filt[c["filt"]], flip, *out)
    elif f == "F3":
        up = P.up_gap if c["gapadj"] else D.O[:, RTH0].copy()
        dn = P.dn_gap if c["gapadj"] else D.O[:, RTH0].copy()
        k_f3(*a, D.VW, D.adr, P.sig[c["lb"]], up, dn, c["m"], c["checks"], c["xmode"], *out)
    elif f == "F4":
        k_f4(*a, D.adr, D.pc, c["pred"], c["mom"], c["q"], c["jdec"], c["stop_on"], flip, *out)
    elif f == "F5":
        if c["sub"] == "trend":
            k_f5t(*a, D.VW, D.adr, c["jfirst"], c["step"], c["d"], *out)
        else:
            k_f5r(*a, D.VW, D.adr, c["jlast"], c["k"], c["sdist"], flip, *out)
    elif f == "F6":
        k_f6(*a, D.adr, D.pc, c["fade"], c["glo"], c["ghi"], c["jent"], c["xslot"], c["sdist"], flip, *out)
    elif f == "F7":
        k_f7(*a, D.adr, c["brk"], c["cut"], c["sdist"], c["R"], flip, *out)
    elif f == "F8":
        k_f8(*a, D.adr, P.f8x[c["x"]], c["k"], c["cut"], c["smode"], flip, *out)
    elif f == "F9":
        ev = np.ones(n, bool) if all_days else P.f9[c["ev"]]
        k_window(*a, D.adr, ev, np.ones(n, np.int64), c["jin"], c["jout"], c["stop"], *out)
    elif f == "F10":
        sd = P.f10[c["sig"]].copy()
        if c["sides"] == "long":
            sd = np.where(sd > 0, 1, 0)
            if all_days:
                sd = np.ones(n, np.int64)
        elif flip:
            sd = -sd
        k_window(*a, D.adr, np.ones(n, bool), sd.astype(np.int64), 2, c["jout"], c["stop"], *out)
    elif f == "F11":
        src = P.f11_mixes if c["mix"] else P.f11_rules
        le, se, lx, sx = src[c["rule"]]
        al, as_ = P.f11_filters[c["filt"]]
        k_f11(*a, D.adr, P.atr_rth, le, se, lx, sx, al, as_, c["xmode"], *out)
    elif f == "F12":
        k_f12(*a, D.adr, P.atr_all, P.prh, P.prl, c["ws"], c["we"], c["tmode"], flip, *out)
    elif f == "F13":
        if c["kind"] == "drift":
            k_window(*a, D.adr, np.ones(n, bool), np.ones(n, np.int64), c["jin"], c["jout"], 0.0, *out)
        else:
            k_asia(*a, D.adr, c["brk"], c["smode"], flip, *out)
    if flip and c["kind"] == "flip":
        r["g"] = -r["g"]                      # the day's whole position path mirrored, costs unchanged
        r["side"] = -r["side"]
    return r



# ------------------------------------------------------------------------------------------------ statistics
def stats(D, r, mask, slip=SLIP1):
    """A configuration's numbers on the sessions in mask (sessions with a finite ADR)."""
    m = mask & np.isfinite(D.adr)
    x = net_adr(r, D.adr, slip)[m]
    pts = net_pts(r, slip)[m]
    tr = (r["rt"][m] > 0)
    N = len(x)
    sd = x.std(ddof=1) if N > 1 else 0.0
    t = x.mean() / sd * math.sqrt(N) if sd > 0 else 0.0
    cum = np.cumsum(x)
    dd = float((cum - np.maximum.accumulate(np.r_[0.0, cum])[1:]).min()) if N else 0.0
    nt = int(tr.sum())
    yrs = D.year[m]
    by = {int(y): float(x[yrs == y].sum()) for y in np.unique(yrs)}
    return dict(sessions=N, trades=nt, round_turns=int(r["rt"][m].sum()), net_adr=float(x.sum()),
                per_trade_adr=float(x[tr].mean()) if nt else 0.0, per_trade_pts=float(pts[tr].mean()) if nt else 0.0,
                win=float((x[tr] > 0).mean()) if nt else 0.0, t=float(t), sharpe=float(x.mean() / sd * math.sqrt(252)) if sd > 0 else 0.0,
                maxdd_adr=dd, usd_1mnq=float(pts.sum() * PV), by_year=by)


def screen(dd, out):
    D = load(dd)
    P = Inputs(D)
    os.makedirs(out, exist_ok=True)
    cfgs = configs()
    rows = []
    net = np.zeros((len(cfgs), D.n), np.float32)
    res = {}
    for q, c in enumerate(cfgs):
        r = run(P, c)
        res[c["id"]] = r
        net[q] = net_adr(r, D.adr)
        sd_ = stats(D, r, D.design)
        rows.append(dict(id=c["id"], fam=c["fam"], kind=c["kind"], design=sd_))
        if q % 200 == 0:
            print(f"  {q}/{len(cfgs)} {c['id']}", flush=True)
    np.save(os.path.join(out, "net_adr_1tick.npy"), net)
    json.dump([c["id"] for c in cfgs], open(os.path.join(out, "config_ids.json"), "w"))
    np.save(os.path.join(out, "session_iso.npy"), D.iso)
    # ---- selection on the design period only (fixed before the out-of-sample numbers below are computed)
    sel = {}
    for fam in sorted({c["fam"] for c in cfgs}, key=lambda x: int(x[1:])):
        cand = [row for row in rows if row["fam"] == fam and row["design"]["trades"] >= (30 if fam == "F9" else 60)]
        cand.sort(key=lambda row: -row["design"]["t"])
        sel[fam] = [row["id"] for row in cand[:5]]
    json.dump(sel, open(os.path.join(out, "selection.json"), "w"), indent=1)
    print("selection fixed:", {k: v[0] if v else None for k, v in sel.items()})
    # ---- the one out-of-sample look
    for row in rows:
        r = res[row["id"]]
        row["oos"] = stats(D, r, D.oos)
        row["oos_2tick"] = stats(D, r, D.oos, slip=2 * SLIP1)
        row["design_2tick"] = stats(D, r, D.design, slip=2 * SLIP1)
    json.dump(rows, open(os.path.join(out, "all_configs.json"), "w"))
    # the book's legs, strict and engine conventions
    ref = {}
    for strict in (True, False):
        for name, r in book_legs(D, strict).items():
            key = f"{name}|{'strict' if strict else 'engine'}"
            ref[key] = dict(design=stats(D, r, D.design, SLIP1 if strict else 0.0), oos=stats(D, r, D.oos, SLIP1 if strict else 0.0))
            if strict:
                np.save(os.path.join(out, f"ref_{name}.npy"), net_adr(r, D.adr).astype(np.float32))
    json.dump(ref, open(os.path.join(out, "reference.json"), "w"), indent=1)
    write_tables(out, rows, sel, ref)
    return D, P, rows, sel


def write_tables(out, rows, sel, ref):
    import csv
    by_id = {r["id"]: r for r in rows}
    with open(os.path.join(out, "all_configs.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "family", "design_trades", "design_t", "design_per_trade_adr", "design_win", "design_net_adr",
                    "oos_trades", "oos_t", "oos_per_trade_adr", "oos_win", "oos_net_adr", "oos_net_adr_2tick", "oos_usd_1mnq",
                    "oos_2023", "oos_2024", "oos_2025", "oos_2026"])
        for r in rows:
            d, o, o2 = r["design"], r["oos"], r["oos_2tick"]
            w.writerow([r["id"], r["fam"], d["trades"], round(d["t"], 3), round(d["per_trade_adr"], 5), round(d["win"], 4),
                        round(d["net_adr"], 3), o["trades"], round(o["t"], 3), round(o["per_trade_adr"], 5), round(o["win"], 4),
                        round(o["net_adr"], 3), round(o2["net_adr"], 3), round(o["usd_1mnq"], 2)]
                       + [round(o["by_year"].get(y, 0.0), 3) for y in (2023, 2024, 2025, 2026)])
    print(f"wrote {len(rows)} rows")



# ------------------------------------------------------------------------------------------------ diagnostics
def control(D, P, c, r, rng, ndraw=400, slip=SLIP1):
    """P3: the out-of-sample net against ndraw random copies. Returns (net, p95, kind) or None (not applicable)."""
    m = D.oos & np.isfinite(D.adr)
    x = net_adr(r, D.adr, slip)
    obs = float(x[m].sum())
    if c["kind"] == "drift":
        return None
    if c["kind"] == "long":
        ra = run(P, c, all_days=True)
        xa = net_adr(ra, D.adr, slip)
        pool = np.flatnonzero(m & (ra["rt"] > 0))
        k = int((m & (r["rt"] > 0)).sum())
        if k == 0 or len(pool) < k:
            return obs, np.nan, "random days"
        sims = np.array([xa[rng.choice(pool, k, replace=False)].sum() for _ in range(ndraw)])
        return obs, float(np.percentile(sims, 95)), "random days"
    if c["kind"] == "single":
        rf = run(P, c, flip=True)
        xf = net_adr(rf, D.adr, slip)
        kind = "random sides (each trade simulated both ways)"
    else:
        with np.errstate(invalid="ignore", divide="ignore"):
            xf = np.where(r["rt"] > 0, (-r["g"] - COMM_PTS * r["rt"] - slip * r["sf"]) / D.adr, 0.0)
        kind = "random sides (the day's path mirrored)"
    sess = np.flatnonzero(m & (r["rt"] > 0))
    a, b = x[sess], xf[sess]
    sims = np.array([np.where(rng.random(len(sess)) < 0.5, a, b).sum() for _ in range(ndraw)])
    return obs, float(np.percentile(sims, 95)), kind


def pbo_cscv(M, S=16):
    """Probability of backtest overfitting (Bailey, Borwein, Lopez de Prado & Zhu 2017) by CSCV: S contiguous blocks,
    every half/half split; the in-sample best configuration's out-of-sample relative rank. M: configs x sessions."""
    from itertools import combinations
    N, T = M.shape
    edges = np.linspace(0, T, S + 1).astype(int)
    s1 = np.stack([M[:, a:b].sum(1) for a, b in zip(edges[:-1], edges[1:])], 1)
    s2 = np.stack([(M[:, a:b] ** 2).sum(1) for a, b in zip(edges[:-1], edges[1:])], 1)
    cnt = np.diff(edges)
    lam = []
    for comb in combinations(range(S), S // 2):
        isb = np.zeros(S, bool); isb[list(comb)] = True
        def sharpe(mask):
            n_ = cnt[mask].sum()
            mu = s1[:, mask].sum(1) / n_
            var = s2[:, mask].sum(1) / n_ - mu ** 2
            return mu / np.sqrt(np.maximum(var, 1e-18))
        si, so = sharpe(isb), sharpe(~isb)
        best = int(np.argmax(si))
        rank = (so < so[best]).sum() + 0.5 * ((so == so[best]).sum() - 1) + 1
        w = rank / (N + 1)
        lam.append(math.log(w / (1 - w)))
    lam = np.array(lam)
    return float((lam <= 0).mean()), float(np.median(lam))


def deflated_sharpe(x, sr_trials):
    """Bailey & Lopez de Prado (2014): the probability that the per-session Sharpe of x beats the expected maximum of
    len(sr_trials) unskilled trials with that dispersion."""
    from statistics import NormalDist
    nd = NormalDist()
    T = len(x)
    sr = x.mean() / x.std(ddof=1)
    g3 = ((x - x.mean()) ** 3).mean() / x.std() ** 3
    g4 = ((x - x.mean()) ** 4).mean() / x.std() ** 4
    N = len(sr_trials)
    v = np.var(sr_trials, ddof=1)
    e = 0.5772156649
    sr0 = math.sqrt(v) * ((1 - e) * nd.inv_cdf(1 - 1.0 / N) + e * nd.inv_cdf(1 - 1.0 / (N * math.e)))
    z = (sr - sr0) * math.sqrt(T - 1) / math.sqrt(max(1e-12, 1 - g3 * sr + (g4 - 1) / 4 * sr ** 2))
    return float(nd.cdf(z)), float(sr), float(sr0)


def diag(dd, out):
    import csv
    D = load(dd)
    P = Inputs(D)
    cfgs = configs()
    byid = {c["id"]: c for c in cfgs}
    rows = {r["id"]: r for r in json.load(open(os.path.join(out, "all_configs.json")))}
    sel = json.load(open(os.path.join(out, "selection.json")))
    M = np.load(os.path.join(out, "net_adr_1tick.npy")).astype(float)
    ids = json.load(open(os.path.join(out, "config_ids.json")))
    assert ids == [c["id"] for c in cfgs]
    ok = np.isfinite(D.adr)
    rng = np.random.default_rng(20261127)
    refs = {k: np.load(os.path.join(out, f"ref_{k}.npy")).astype(float) for k in ("book_overnight", "book_pyramid", "book_ib")}
    book = refs["book_overnight"] + refs["book_pyramid"] + refs["book_ib"]
    dec = []
    allsr = M[:, D.design & ok].mean(1) / np.maximum(M[:, D.design & ok].std(1, ddof=1), 1e-12)
    for fam, top in sel.items():
        if not top:
            dec.append(dict(family=fam, selected="(no configuration with enough trades)"))
            continue
        cid = top[0]
        c = byid[cid]
        r = run(P, c)
        row = rows[cid]
        o = row["oos"]
        yrs = [o["by_year"].get(str(y), o["by_year"].get(y, 0.0)) for y in (2023, 2024, 2025, 2026)]
        ctl = control(D, P, c, r, rng)
        famidx = [q for q, x in enumerate(cfgs) if x["fam"] == fam]
        fam_sr = allsr[famidx]
        x_design = net_adr(r, D.adr)[D.design & ok]
        dsr_f = deflated_sharpe(x_design, fam_sr)
        dsr_all = deflated_sharpe(x_design, allsr)
        pbo_f = pbo_cscv(M[famidx][:, ok]) if len(famidx) > 2 else (np.nan, np.nan)
        # neighbours: same family, exactly one field different
        f0 = cid.split("|")
        nb_t = [rows[x["id"]]["design"]["t"] for x in cfgs if x["fam"] == fam and x["id"] != cid
                and len(x["id"].split("|")) == len(f0) and sum(a != b for a, b in zip(x["id"].split("|"), f0)) == 1]
        xs = net_adr(r, D.adr)
        corr = {k: float(np.corrcoef(xs[ok], v[ok])[0, 1]) for k, v in list(refs.items()) + [("book", book)]}
        corr_oos = float(np.corrcoef(xs[D.oos & ok], book[D.oos & ok])[0, 1])
        p1 = o["t"] >= 2.0
        p2 = sum(y > 0 for y in yrs) >= 3
        p3 = (ctl is None) or (np.isfinite(ctl[1]) and ctl[0] > ctl[1])
        p4 = row["oos_2tick"]["net_adr"] > 0
        p5 = o["trades"] >= 30
        dec.append(dict(family=fam, selected=cid, design_trades=row["design"]["trades"], design_t=round(row["design"]["t"], 2),
                        design_per_trade_adr=round(row["design"]["per_trade_adr"], 4), oos_trades=o["trades"], oos_t=round(o["t"], 2),
                        oos_per_trade_adr=round(o["per_trade_adr"], 4), oos_per_trade_pts=round(o["per_trade_pts"], 2), oos_net_adr=round(o["net_adr"], 2),
                        oos_usd_1mnq=round(o["usd_1mnq"], 0), oos_2023=round(yrs[0], 2), oos_2024=round(yrs[1], 2), oos_2025=round(yrs[2], 2),
                        oos_2026=round(yrs[3], 2), oos_net_2tick=round(row["oos_2tick"]["net_adr"], 2),
                        control=(ctl[2] if ctl else "n/a (trades every session)"), control_p95=(round(ctl[1], 2) if ctl and np.isfinite(ctl[1]) else ""),
                        P1=p1, P2=p2, P3=p3, P4=p4, P5=p5, PASS=bool(p1 and p2 and p3 and p4 and p5),
                        pbo_family=round(pbo_f[0], 3), dsr_family=round(dsr_f[0], 3), dsr_round=round(dsr_all[0], 3),
                        neighbours_median_t=round(float(np.median(nb_t)), 2) if nb_t else "", corr_book=round(corr["book"], 3),
                        corr_book_oos=round(corr_oos, 3), corr_overnight=round(corr["book_overnight"], 3),
                        corr_pyramid=round(corr["book_pyramid"], 3), corr_ib=round(corr["book_ib"], 3)))
        print(f"{fam}: {cid} | design t {row['design']['t']:.2f} | OOS t {o['t']:.2f}, {o['trades']} trades, years {[round(y, 2) for y in yrs]}, "
              f"2-tick {row['oos_2tick']['net_adr']:.2f}, control {ctl[0] if ctl else ''} vs p95 {ctl[1] if ctl else ''} -> "
              f"{'PASS' if dec[-1]['PASS'] else 'fail'} (P1 {p1} P2 {p2} P3 {p3} P4 {p4} P5 {p5}) | PBO {pbo_f[0]:.2f}", flush=True)
    keys = list(dec[0].keys()) if dec and "design_t" in dec[0] else None
    keys = max((list(d.keys()) for d in dec), key=len)
    with open(os.path.join(out, "decisions.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys)
        w.writeheader()
        for d_ in dec:
            w.writerow(d_)
    # PBO of the whole search
    pbo_all = pbo_cscv(M[:, ok])
    # walk-forward: each year traded with the configuration best on all earlier data
    wf = []
    for fam in sel:
        famidx = [q for q, x in enumerate(cfgs) if x["fam"] == fam]
        tot = []
        for Y in (2022, 2023, 2024, 2025, 2026):
            before = ok & (D.year < Y)
            inY = ok & (D.year == Y)
            best, bt = None, -1e9
            for q in famidx:
                x = M[q, before]
                ntr = int((np.abs(x) > 0).sum())
                if ntr < (30 if fam == "F9" else 60):
                    continue
                sd_ = x.std(ddof=1)
                t = x.mean() / sd_ * math.sqrt(len(x)) if sd_ > 0 else 0.0
                if t > bt:
                    best, bt = q, t
            if best is None:
                continue
            y = M[best, inY]
            tot.append(y)
            wf.append(dict(family=fam, year=Y, config=cfgs[best]["id"], prior_t=round(bt, 2), net_adr=round(float(y.sum()), 3)))
        if tot:
            z = np.concatenate(tot)
            sd_ = z.std(ddof=1)
            wf.append(dict(family=fam, year="2022-2026", config="(re-picked each year)", prior_t="",
                           net_adr=round(float(z.sum()), 3), t=round(float(z.mean() / sd_ * math.sqrt(len(z))) if sd_ > 0 else 0.0, 2)))
    with open(os.path.join(out, "walkforward.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["family", "year", "config", "prior_t", "net_adr", "t"])
        w.writeheader()
        for d_ in wf:
            w.writerow(d_)
    json.dump(dict(pbo_all_configs=pbo_all[0], median_logit=pbo_all[1]), open(os.path.join(out, "pbo.json"), "w"), indent=1)
    print(f"PBO over all {len(cfgs)} configurations: {pbo_all[0]:.3f}")
    print("survivors:", [d_["selected"] for d_ in dec if d_.get("PASS")])


# ------------------------------------------------------------------------------------------------ self-tests
def selftest(dd):
    D = load(dd)
    print(f"sessions {D.n}, full RTH {int(D.full.sum())}, first {D.iso[0]}, last {D.iso[-1]}")
    print("rolls found:", len(D.roll_log))
    for r in D.roll_log:
        print("   ", r)
    assert all(r[0] >= "2022-09-01" for r in D.roll_log) and len(D.roll_log) == 17, "the roll set is not the expected one"
    # 1. the book's legs in the engine's convention equal the engine's own functions, session by session
    S = D.S
    legs = book_legs(D, strict=False)
    bad = {}
    for name, f in (("book_overnight", lambda d, s: E.funded_on(S, d, s, 0.0, 0.5, n=1, comm=COMM_RT)[0]),
                    ("book_pyramid", lambda d, s: E.pyramid(S, d, s, 0.0, n=1, comm=COMM_RT, fix_gap=True)[0]),
                    ("book_ib", None)):
        r = legs[name]
        mine = np.where(r["rt"] > 0, (r["g"] * PV - COMM_RT * r["rt"]), 0.0)
        ref = np.zeros(D.n)
        for i, d in enumerate(D.days):
            d = int(d)
            if d not in S.S:
                continue
            if name == "book_ib":
                x = E.ib_breakout(S, d, 0.0, n=1, comm=COMM_RT, only_side=S.od_side(d)) if not np.isnan(S.S[d]["adr"]) else None
                ref[i] = x[0] if (x is not None and x[1] != "both-skip") else 0.0
            else:
                side = D.on_side[i] if name == "book_overnight" else D.od_side[i]
                if side != 0:
                    ref[i] = f(d, side)
        diff = np.abs(mine - ref)
        bad[name] = int((diff > 1e-6).sum())
        print(f"{name}: engine {np.count_nonzero(ref)} trades ${ref.sum():,.2f} | mine {int((r['rt'] > 0).sum())} sessions ${mine.sum():,.2f} | sessions differing {bad[name]}")
        if bad[name]:
            for i in np.flatnonzero(diff > 1e-6)[:5]:
                print("     ", D.iso[i], round(ref[i], 2), round(mine[i], 2))
    assert sum(bad.values()) == 0, bad
    print("engine equivalence: OK")
    unit_tests()
    lookahead(dd, D)
    return D


def unit_tests():
    """Hand-made bars through the fill rules."""
    def grid(rows):
        a = np.full((1, NS), NAN)
        O, H, L, C = a.copy(), a.copy(), a.copy(), a.copy()
        for j, (o, h, l, c) in rows.items():
            O[0, j], H[0, j], L[0, j], C[0, j] = o, h, l, c
        return O, H, L, C
    # long market entry at 100 (bar 190 open); stop 98; target 104
    O, H, L, C = grid({190: (100, 101, 99.5, 100.5), 191: (100.5, 103, 100, 102), 192: (102, 104.25, 101, 104), 264: (104, 104, 104, 104)})
    assert _manage(O, H, L, C, 0, 1, 100.0, 98.0, 104.0, 190, 264, 0, 0)[:2] == (104.0, 2)       # target with a tick through
    O2, H2, L2, C2 = grid({190: (100, 101, 99.5, 100.5), 191: (100.5, 104.0, 100, 102), 264: (101, 101, 101, 101)})
    assert _manage(O2, H2, L2, C2, 0, 1, 100.0, 98.0, 104.0, 190, 264, 0, 0)[:2] == (101.0, 0)    # touch without a tick through: no fill, time exit at 16:00's open
    O3, H3, L3, C3 = grid({190: (100, 104.5, 97.5, 101), 264: (101, 101, 101, 101)})
    assert _manage(O3, H3, L3, C3, 0, 1, 100.0, 98.0, 104.0, 190, 264, 0, 0)[:2] == (98.0, 1)     # stop and target in one bar: the stop
    O4, H4, L4, C4 = grid({190: (100, 101, 99, 100), 191: (97, 97.5, 96, 97), 264: (99, 99, 99, 99)})
    assert _manage(O4, H4, L4, C4, 0, 1, 100.0, 98.0, np.nan, 190, 264, 0, 0)[:2] == (97.0, 1)    # gap through the stop: the open
    O5, H5, L5, C5 = grid({200: (100, 102, 97, 101), 201: (101, 103, 100, 102), 264: (102, 102, 102, 102)})
    assert _manage(O5, H5, L5, C5, 0, 1, 101.0, 98.0, 102.0, 200, 264, 1, 0)[:2] == (98.0, 1)     # stop-entry fill bar: the stop counts
    O6, H6, L6, C6 = grid({200: (100, 104, 99, 101), 201: (101, 101.5, 100, 101), 264: (101, 101, 101, 101)})
    assert _manage(O6, H6, L6, C6, 0, 1, 101.0, 98.0, 103.0, 200, 264, 1, 0)[:2] == (101.0, 0)    # fill bar: the target does not count
    O7, H7, L7, C7 = grid({200: (100, 100.5, 99, 100), 201: (100, 102, 99.5, 101.5)})
    assert _manage(O7, H7, L7, C7, 0, 1, 100.0, 98.0, np.nan, 200, 264, 0, 0)[:2] == (101.5, 3)  # half day: the last bar's close
    O8, H8, L8, C8 = grid({200: (100, 101, 99.75, 100.5), 201: (100.5, 102, 100.25, 101)})
    sd, j, px = _stop_entry(O8, H8, L8, 0, 101.25, 99.75, 200, 210)
    assert (sd, j, px) == (-1, 200, 99.75), (sd, j, px)                                          # the low touches the sell stop first bar
    O9, H9, L9, C9 = grid({200: (102, 103, 101.5, 102.5)})
    assert _stop_entry(O9, H9, L9, 0, 101.25, 99.75, 200, 210) == (1, 200, 102.0)                 # gapped open above the buy stop: the open
    O10, H10, L10, C10 = grid({200: (100, 101.25, 98.5, 100)})
    assert _stop_entry(O10, H10, L10, 0, 101.25, 98.75, 200, 210)[0] == 0                         # both in one bar: no trade
    O11, H11, L11, C11 = grid({200: (100, 101.0, 99.5, 100), 201: (100, 101.25, 99.5, 100)})
    assert _limit_entry(O11, H11, L11, 0, 101.0, np.nan, 200, 210) == (-1, 201, 101.0)             # a sell limit needs a tick through
    r = dict(g=np.array([2.0]), rt=np.array([1.0]), sf=np.array([2.0]))
    assert abs(net_pts(r)[0] - (2.0 - 0.5 - 0.5)) < 1e-12                                          # $1.00 a round turn + 2 ticks
    print("fill unit tests: OK")


def lookahead(dd, D):
    """Cut the data at a moment inside a session (nothing at or after it exists) and rerun every configuration:
    every entry made before the cut must be identical (time, side, price)."""
    P = Inputs(D)
    cfgs = configs()
    full = {c["id"]: run(P, c) for c in cfgs}
    cuts = [("2020-06-15", "11:00"), ("2021-03-10", "14:00"), ("2022-05-12", "10:15"), ("2023-08-01", "12:30"),
            ("2024-11-06", "15:10"), ("2026-04-07", "09:50"), ("2025-04-09", "03:40")]
    checked = 0
    for day, hm in cuts:
        i = int(np.searchsorted(D.iso, day))
        assert D.iso[i] == day
        js = slot(hm)
        cut_t = int(D.days[i]) * 1440 - 360 + js * 5
        Dt = load(dd, cut_t)
        Pt = Inputs(Dt)
        assert Dt.iso[-1] == day and np.isnan(Dt.O[i, js:]).all() and np.array_equal(np.isnan(Dt.O[i, :js]), np.isnan(D.O[i, :js]))
        nbad = 0
        for c in cfgs:
            a = full[c["id"]]
            if a["es"][i] < 0 or a["es"][i] >= js:
                continue
            b = run(Pt, c)
            checked += 1
            if not (b["es"][i] == a["es"][i] and b["side"][i] == a["side"][i] and abs(b["ep"][i] - a["ep"][i]) < 1e-9):
                nbad += 1
                if nbad <= 5:
                    print("   LOOK-AHEAD?", day, hm, c["id"], (a["es"][i], a["side"][i], a["ep"][i]), (b["es"][i], b["side"][i], b["ep"][i]))
        print(f"  cut {day} {hm}: entries before the cut identical in every configuration that had one (bad {nbad})", flush=True)
        assert nbad == 0
    print(f"look-ahead test: OK ({checked} entries checked)")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "prep":
        prep(sys.argv[2], sys.argv[3])
    elif cmd == "selftest":
        selftest(sys.argv[2])
    elif cmd == "screen":
        screen(sys.argv[2], sys.argv[3])
    elif cmd == "diag":
        diag(sys.argv[2], sys.argv[3])
