#!/usr/bin/env python3
"""Research engine for the PO3 / VWAP / Liquidity-Sweep model.

This is the reference implementation. The Pine indicator
(`indicators/po3_vwap_liquidity_sweep.pine`) is a line-for-line port of the
signal gates and the fill model below, so numbers quoted in the README can be
reproduced on-chart.

Design rules that keep the study honest
---------------------------------------
* Every threshold is expressed in ATR (or VWAP sigma) units, never in points,
  so one parameter set is meaningful across instruments and timeframes.
* Structural constants (pivot length, ATR length, initial-balance length) are
  fixed by convention, not fitted.
* No lookahead anywhere: a fractal pivot at bar k is only visible from bar
  k+PIVOT_LEN; session levels are only usable once the session has closed;
  signals are evaluated on closed bars only.
* The fill model resolves every intrabar ambiguity against the strategy.
"""
from __future__ import annotations

import csv
import math
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

# ── structural constants (conventional, deliberately not fitted) ─────────────
PIVOT_LEN = 5          # fractal half-width for short-term highs/lows
ATR_LEN = 14           # Wilder ATR
IB_MINUTES = 60        # initial balance = first hour of RTH
MAX_POOLS = 60         # cap on tracked pivot pools (oldest pruned first)
EQ_TOL_ATR = 0.10      # two pivots within 0.10 ATR are "relatively equal"

# minutes-since-18:00-ET markers for the CME trade day
M_ASIA_END = 480       # 02:00 ET
M_LON_END = 840        # 08:00 ET
M_RTH_OPEN = 930       # 09:30 ET
M_IB_END = M_RTH_OPEN + IB_MINUTES
M_RTH_CLOSE = 1320     # 16:00 ET
M_NYAM_OPEN = 870      # 08:30 ET
M_NYAM_CLOSE = 1020    # 11:00 ET


# ── data loading ─────────────────────────────────────────────────────────────

def load_csv(path):
    t, o, h, l, c, v = [], [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            hi, lo = float(row["high"]), float(row["low"])
            op, cl = float(row["open"]), float(row["close"])
            # Yahoo occasionally emits rows where O/C sit outside H/L; those
            # bars are unusable for a wick-based model, so drop them.
            if not (lo <= op <= hi and lo <= cl <= hi):
                continue
            t.append(int(row["time"]))
            o.append(op)
            h.append(hi)
            l.append(lo)
            c.append(cl)
            v.append(float(row["volume"]))
    return trim_partial({"t": t, "o": o, "h": h, "l": l, "c": c, "v": v})


def trim_partial(bars):
    """Drop a trailing in-progress bar (its stamp is off the modal grid)."""
    t = bars["t"]
    if len(t) < 20:
        return bars
    deltas = [t[i + 1] - t[i] for i in range(len(t) - 1)]
    modal = max(set(deltas), key=deltas.count)
    while len(t) > 1 and t[-1] - t[-2] < modal:
        for k in bars:
            bars[k].pop()
    return bars


def bar_seconds(bars):
    t = bars["t"]
    deltas = [t[i + 1] - t[i] for i in range(min(len(t) - 1, 2000))]
    return max(set(deltas), key=deltas.count)


def resample_trade_day(bars, hours):
    """Resample to `hours`-hour bars aligned to the 18:00 ET trade-day open,
    which is how TradingView aligns higher intraday timeframes on CME
    futures. Naive N-bar chunking would drift across weekends."""
    step = hours * 60
    out = {k: [] for k in bars}
    cur = None
    key = None
    for i in range(len(bars["t"])):
        day, mspo = trade_day_and_minute(bars["t"][i])
        k = (day, mspo // step)
        if k != key:
            if cur is not None:
                for kk in out:
                    out[kk].append(cur[kk])
            cur = {j: bars[j][i] for j in bars}
            key = k
        else:
            cur["h"] = max(cur["h"], bars["h"][i])
            cur["l"] = min(cur["l"], bars["l"][i])
            cur["c"] = bars["c"][i]
            cur["v"] += bars["v"][i]
    if cur is not None:
        for kk in out:
            out[kk].append(cur[kk])
    return out


# ── CME session calendar ─────────────────────────────────────────────────────

def trade_day_and_minute(ts):
    """Return (trade-day ordinal, minutes since that day's 18:00 ET open).

    The CME trade day runs 18:00 ET -> 17:00 ET, so a bar stamped 18:00 ET on
    Monday belongs to Tuesday's trade day. Shifting the ET wall clock forward
    six hours makes the calendar date the trade-day label and makes
    minutes-since-open monotonic within the day.
    """
    dt = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(ET)
    mins = dt.hour * 60 + dt.minute
    mspo = (mins - 1080) % 1440          # minutes since 18:00 ET
    # the trade-day date is today's date when mspo < 360 (i.e. clock >= 18:00)
    day = dt.toordinal() + (1 if mins >= 1080 else 0)
    return day, mspo


def calendar(bars):
    days, mspos, weeks = [], [], []
    for ts in bars["t"]:
        d, m = trade_day_and_minute(ts)
        days.append(d)
        mspos.append(m)
        # ISO week of the trade day: the CME week opens Sunday 18:00 ET, which
        # maps to Monday's trade day, so plain ISO weeks line up.
        weeks.append(datetime.fromordinal(d).isocalendar()[:2])
    return days, mspos, weeks


# ── indicators ───────────────────────────────────────────────────────────────

def wilder_atr(bars, length=ATR_LEN):
    h, l, c = bars["h"], bars["l"], bars["c"]
    n = len(c)
    atr = [None] * n
    tr_sum = 0.0
    for i in range(n):
        tr = h[i] - l[i] if i == 0 else max(h[i] - l[i], abs(h[i] - c[i - 1]),
                                            abs(l[i] - c[i - 1]))
        if i < length:
            tr_sum += tr
            if i == length - 1:
                atr[i] = tr_sum / length
        else:
            atr[i] = (atr[i - 1] * (length - 1) + tr) / length
    return atr


def session_vwap(bars, days, mspos, anchor="day"):
    """Volume-weighted average price and volume-weighted standard deviation,
    re-anchored per period.

        vwap = sum(v*p) / sum(v)
        var  = sum(v*p^2)/sum(v) - vwap^2      (population, volume-weighted)

    p is hlc3, matching TradingView's VWAP default source. Bars with zero
    reported volume (thin Globex prints, holidays) contribute nothing; if a
    whole period has no volume at all the VWAP falls back to hlc3 so the
    series never goes na mid-chart.
    """
    n = len(bars["c"])
    vwap = [None] * n
    sd = [None] * n
    ok = [False] * n
    key = None
    spv = sv = sp2v = 0.0
    nbars = 0
    t0 = 0
    for i in range(n):
        if anchor == "day":
            k = days[i]
        elif anchor == "week":
            k = datetime.fromordinal(days[i]).isocalendar()[:2]
        elif anchor == "rth":
            # anchor at the RTH open; before 09:30 ET carry the overnight anchor
            k = (days[i], mspos[i] >= M_RTH_OPEN)
        else:
            raise ValueError(anchor)
        if k != key:
            key = k
            spv = sv = sp2v = 0.0
            nbars = 0
            t0 = bars["t"][i]
        p = (bars["h"][i] + bars["l"][i] + bars["c"][i]) / 3.0
        vol = bars["v"][i]
        spv += vol * p
        sv += vol
        sp2v += vol * p * p
        nbars += 1
        if sv > 0:
            m = spv / sv
            vwap[i] = m
            sd[i] = math.sqrt(max(sp2v / sv - m * m, 0.0))
        else:
            vwap[i] = p
            sd[i] = 0.0
        # The band is meaningless in the first minutes after an anchor reset:
        # with two or three prints the volume-weighted variance is near zero,
        # so any deviation scores as a huge sigma. Both a bar count and an
        # elapsed-time floor are required so the rule behaves the same on a
        # 5-minute chart as on an hourly one.
        ok[i] = (nbars >= 2 and bars["t"][i] - t0 >= 3600 and sd[i] > 0)
    return vwap, sd, ok


# ── liquidity pool map ───────────────────────────────────────────────────────

@dataclass
class Pool:
    price: float
    side: int          # +1 buy-side (above), -1 sell-side (below)
    kind: str
    born: int
    swept: bool = False
    eq: bool = False   # part of an equal-highs / equal-lows cluster


class LiquidityMap:
    """Maintains the live set of untapped liquidity pools.

    Named levels (previous day/week, Asia, London, initial balance) are
    replaced when their period rolls. Fractal pivots accumulate and are pruned
    once swept or once the cap is hit.
    """

    def __init__(self):
        self.named = {}       # kind -> Pool
        self.pivots = []      # list[Pool]

    def set_named(self, kind, price, side, bar):
        if price is not None:
            self.named[kind] = Pool(price, side, kind, bar)

    def add_pivot(self, price, side, bar, atr):
        # tag equal highs/lows: a new pivot within EQ_TOL_ATR of an existing
        # unswept pivot on the same side is a stop cluster, the strongest
        # liquidity signature there is
        eq = False
        for p in self.pivots:
            if p.side == side and not p.swept and abs(p.price - price) <= EQ_TOL_ATR * atr:
                p.eq = True
                eq = True
        self.pivots.append(Pool(price, side, "pivot", bar, eq=eq))
        if len(self.pivots) > MAX_POOLS:
            self.pivots = [p for p in self.pivots if not p.swept][-MAX_POOLS:]

    def live(self, side):
        out = [p for p in self.named.values() if p.side == side and not p.swept]
        out += [p for p in self.pivots if p.side == side and not p.swept]
        return out

    def mark_swept(self, high, low):
        """Return the pools taken out by this bar, then flag them."""
        hit_bsl = [p for p in self.live(1) if high > p.price]
        hit_ssl = [p for p in self.live(-1) if low < p.price]
        for p in hit_bsl + hit_ssl:
            p.swept = True
        return hit_bsl, hit_ssl


def build_context(bars, anchor="day"):
    """Everything the signal logic needs that does not depend on tuned
    parameters. Computed once per dataset and reused across the grid."""
    days, mspos, weeks = calendar(bars)
    atr = wilder_atr(bars)
    vwap, vsd, vok = session_vwap(bars, days, mspos, anchor)
    # 20-bar simple average of volume, for the participation filter. Symbols
    # with no volume feed leave this None and the filter becomes a no-op.
    v = bars["v"]
    n = len(v)
    vsma = [None] * n
    run = 0.0
    for i in range(n):
        run += v[i]
        if i >= 20:
            run -= v[i - 20]
        if i >= 19:
            vsma[i] = run / 20.0
    return {"days": days, "mspos": mspos, "weeks": weeks, "atr": atr,
            "vwap": vwap, "vsd": vsd, "vok": vok, "vsma": vsma}


# ── parameters ───────────────────────────────────────────────────────────────

@dataclass
class Params:
    # --- sweep geometry (ATR-normalised, so it travels across TFs/symbols) ---
    min_sweep_atr: float = 0.05   # min depth beyond the level to count as a raid
    max_sweep_atr: float = 0.0    # deeper than this is a breakout (0 = no cap)
    reclaim_bars: int = 2         # bars allowed between the raid and the reclaim
    # --- pool selection ---
    pools: tuple = ("pdh", "pdl", "pwh", "pwl", "asiah", "asial",
                    "lonh", "lonl", "ibh", "ibl", "pivot")
    pivot_len: int = PIVOT_LEN    # fractal half-width, in bars
    eq_only: bool = False         # pivots must be equal-highs/lows clusters
    # --- VWAP context ---
    use_vwap: bool = True         # apply the stretch gate below
    dev_entry: float = 1.0        # raid extreme must be >= this many sigma out
    vwap_reclaim: bool = False    # reclaim bar must also close back across VWAP
    # --- PO3 context ---
    po3_mode: str = "below_open"  # off | below_open | reclaim_open
    po3_period: str = "day"       # day | week
    # --- confirmation quality ---
    require_close_dir: bool = True   # reclaim bar must close in the trade's direction
    vol_mult: float = 0.0            # reclaim bar volume vs its 20-bar average (0 = off)
    # --- trade construction ---
    entry_mode: str = "wick_mid"  # reclaim_close | wick_mid | level_retest
    stop_buf_atr: float = 0.25
    max_risk_atr: float = 0.0     # skip setups whose stop is further than this (0 = off)
    min_target_pts: float = 0.0   # skip setups whose target is worth less than this (0 = off)
    tp_mode: str = "rr"           # rr | vwap | pool  (pool = opposing liquidity)
    stop_at: str = "extreme"      # extreme | level  (where the stop is anchored)
    max_open_bars: int = 0        # signal must come within N bars of the period open (0 = off)
    rr: float = 2.0
    be_at_r: float = 0.0          # move stop toward entry at this R (0 = off)
    be_to_r: float = 0.0          # WHERE to move it, in R from entry. 0 = exact
                                  # breakeven; -0.5 = halfway, a reduced-risk
                                  # stop that is hit far less often
    partial_at_r: float = 0.0     # bank part of the position at this R (0 = off)
    partial_frac: float = 0.5     # how much of it to bank there
    trail_start_r: float = 0.0    # start trailing once this R is reached (0 = off)
    trail_atr: float = 1.0        # trail this far behind the run-up extreme
    validity: int = 12            # bars a resting limit stays live
    max_hold: int = 0             # bars after fill before a market exit (0 = off)
    # --- gating ---
    session: str = "all"          # all | rth | nyam | globex
    cooldown: int = 6             # bars between signals, per direction
    longs: bool = True
    shorts: bool = True
    # --- costs ---
    tick: float = 0.25
    cost_ticks: float = 0.0       # round-trip slippage+commission, in ticks


@dataclass
class Result:
    signals: int = 0
    fills: int = 0
    wins: int = 0
    losses: int = 0
    scratches: int = 0
    expired: int = 0
    open_end: int = 0
    exits: list = field(default_factory=list)   # (bar, R net of costs)
    hold: list = field(default_factory=list)
    mae_r: list = field(default_factory=list)   # max adverse excursion, in R
    caught_extreme: list = field(default_factory=list)  # bool per signal

    @property
    def net_r(self):
        return sum(r for _, r in self.exits)

    @property
    def pf(self):
        gw = sum(r for _, r in self.exits if r > 0)
        gl = -sum(r for _, r in self.exits if r < 0)
        if gl > 0:
            return gw / gl
        return float("inf") if gw > 0 else 0.0

    @property
    def wr(self):
        d = self.wins + self.losses
        return 100.0 * self.wins / d if d else 0.0

    @property
    def expectancy(self):
        return self.net_r / len(self.exits) if self.exits else 0.0

    @property
    def max_dd(self):
        eq = peak = dd = 0.0
        for _, r in sorted(self.exits):
            eq += r
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
        return dd

    @property
    def extreme_hit_rate(self):
        n = len(self.caught_extreme)
        return 100.0 * sum(self.caught_extreme) / n if n else 0.0

    def merge(self, o):
        for k in ("signals", "fills", "wins", "losses", "scratches", "expired",
                  "open_end"):
            setattr(self, k, getattr(self, k) + getattr(o, k))
        self.exits += o.exits
        self.hold += o.hold
        self.mae_r += o.mae_r
        self.caught_extreme += o.caught_extreme
        return self


def in_session(mspo, mode):
    if mode == "all":
        return True
    if mode == "rth":
        return M_RTH_OPEN <= mspo < M_RTH_CLOSE
    if mode == "nyam":
        return M_NYAM_OPEN <= mspo < M_NYAM_CLOSE
    if mode == "globex":
        return not (M_RTH_OPEN <= mspo < M_RTH_CLOSE)
    raise ValueError(mode)


@dataclass
class Raid:
    level: float
    side: int          # -1 sell-side raid (long setup), +1 buy-side (short)
    bar: int           # last bar that extended the raid
    extreme: float
    kind: str
    first_bar: int = -1   # bar the raid started on


# ── the model ────────────────────────────────────────────────────────────────

def run(bars, ctx, p: Params, lo_i=0, hi_i=None, extreme_horizon=20,
        collector=None, trade_log=None, outcome_log=None):
    PL = p.pivot_len
    """Walk the series once, bar by bar, exactly as the Pine script does.

    `lo_i`/`hi_i` restrict which bars may *originate* a signal (used for
    walk-forward splits); context and liquidity state are still built from the
    whole series so the split does not hand the engine a cold start.
    """
    o, h, l, c, v = (bars["o"], bars["h"], bars["l"], bars["c"], bars["v"])
    days, mspos = ctx["days"], ctx["mspos"]
    atr, vwap, vsd, vok = ctx["atr"], ctx["vwap"], ctx["vsd"], ctx["vok"]
    vsma = ctx["vsma"]
    n = len(c)
    hi_i = n if hi_i is None else hi_i
    res = Result()
    lm = LiquidityMap()

    # rolling period accumulators
    day_h = day_l = None
    wk_h = wk_l = None
    cur_week = None
    asia_h = asia_l = lon_h = lon_l = ib_h = ib_l = None
    asia_done = lon_done = ib_done = False
    period_open = None

    raids = []          # active, unreclaimed raids
    trades = []         # live setups
    last_sig = {1: -10 ** 9, -1: -10 ** 9}
    signal_log = []     # (bar, dir, extreme) for the extreme-capture diagnostic
    min_risk = 2 * p.tick

    for i in range(n):
        a = atr[i]

        # ── 1. manage live setups (all created strictly before this bar) ────
        for t in trades:
            if t["state"] in ("closed",) or t["created"] >= i:
                continue
            bull = t["dir"] == 1
            cost_r = p.cost_ticks * p.tick / t["risk"]

            if t["state"] == "pending":
                filled = l[i] <= t["entry"] if bull else h[i] >= t["entry"]
                if filled:
                    t["state"] = "filled"
                    t["fill_bar"] = i
                    res.fills += 1
                    # pessimistic: a fill bar that also trades the stop is a loss
                    # now, and the target is never credited on the fill bar
                    if (l[i] <= t["stop"]) if bull else (h[i] >= t["stop"]):
                        t["state"] = "closed"
                        res.losses += 1
                        res.exits.append((i, -1.0 - cost_r))
                        res.hold.append(0)
                        res.mae_r.append(1.0)
                        if outcome_log is not None:
                            outcome_log.append(dict(t["feat"], bar=t["created"],
                                                    exit_bar=i, dir=t["dir"],
                                                    r=-1.0 - cost_r,
                                                    outcome="loss_on_fill_bar"))
                # a resting order expires only if it did NOT fill on this bar.
                # This `elif` must chain to `if filled` - when it was chained to
                # the outcome_log branch instead, a fill landing exactly on the
                # expiry bar was thrown away as an expiry, and every resting bar
                # emitted a phantom -1R row into outcome_log.
                elif i - t["created"] >= p.validity:
                    t["state"] = "closed"
                    res.expired += 1
                continue

            # filled
            adverse = (t["entry"] - l[i]) if bull else (h[i] - t["entry"])
            t["mae"] = max(t["mae"], adverse / t["risk"])
            t["peak"] = max(t["peak"], h[i]) if bull else min(t["peak"], l[i])
            tgt = t["tp"]
            if p.tp_mode == "vwap":
                tgt = max(vwap[i], t["entry"]) if bull else min(vwap[i], t["entry"])
            stop_hit = (l[i] <= t["stop"]) if bull else (h[i] >= t["stop"])
            tp_hit = (h[i] >= tgt) if bull else (l[i] <= tgt)

            outcome = None
            if stop_hit:                     # stop wins ties inside a bar
                outcome = "scratch" if t["be"] else "loss"
            elif tp_hit:
                outcome = "win"
            elif p.max_hold and i - t["fill_bar"] >= p.max_hold:
                outcome = "time"

            if outcome is None:
                # Bank a partial, and trail, only AFTER the exit checks, so
                # neither can take effect on the bar that triggered it - the
                # same pessimism the breakeven rule already uses.
                if p.partial_at_r > 0 and t["part"] == 0.0:
                    lvl = (t["entry"] + p.partial_at_r * t["risk"]) if bull else \
                          (t["entry"] - p.partial_at_r * t["risk"])
                    if (h[i] >= lvl) if bull else (l[i] <= lvl):
                        t["part"] = p.partial_frac
                if p.trail_start_r > 0 and a:
                    start = (t["entry"] + p.trail_start_r * t["risk"]) if bull else \
                            (t["entry"] - p.trail_start_r * t["risk"])
                    if (t["peak"] >= start) if bull else (t["peak"] <= start):
                        trail = (t["peak"] - p.trail_atr * a) if bull else \
                                (t["peak"] + p.trail_atr * a)
                        t["stop"] = max(t["stop"], trail) if bull else min(t["stop"], trail)
                if p.be_at_r > 0 and not t["be"]:
                    lvl = (t["entry"] + p.be_at_r * t["risk"]) if bull else \
                          (t["entry"] - p.be_at_r * t["risk"])
                    if (h[i] >= lvl) if bull else (l[i] <= lvl):
                        t["be"] = True
                        # move the stop to be_to_r measured from entry: 0 is
                        # exact breakeven, negative leaves part of the original
                        # risk on so noise cannot scratch the trade out
                        moved = (t["entry"] + p.be_to_r * t["risk"]) if bull else \
                                (t["entry"] - p.be_to_r * t["risk"])
                        t["stop"] = max(t["stop"], moved) if bull else min(t["stop"], moved)
                continue

            t["state"] = "closed"
            res.hold.append(i - t["fill_bar"])
            res.mae_r.append(t["mae"])
            _booked = None
            if outcome == "win":
                r = p.rr if p.tp_mode == "rr" else abs(tgt - t["entry"]) / t["risk"]
            elif outcome == "loss":
                res.losses += 1
                r = -1.0
            elif outcome == "scratch":
                res.scratches += 1
                r = p.be_to_r
            else:
                r = (c[i] - t["entry"]) / t["risk"] if bull else (t["entry"] - c[i]) / t["risk"]
            if outcome == "win":
                res.wins += 1
            # A banked partial is already realised at partial_at_r; only the
            # remainder is exposed to whatever happened afterwards. The extra
            # exit ticket is charged half a round trip on the banked size.
            f = t["part"]
            gross = f * p.partial_at_r + (1.0 - f) * r if f > 0 else r
            _booked = gross - cost_r * (1.0 + 0.5 * f)
            res.exits.append((i, _booked))
            if outcome_log is not None:
                outcome_log.append(dict(t["feat"], bar=t["created"], exit_bar=i,
                                        dir=t["dir"], r=_booked, outcome=outcome,
                                        mae=t["mae"], hold=i - t["fill_bar"]))
        trades = [t for t in trades if t["state"] != "closed"]

        # ── 2. roll period / session state ──────────────────────────────────
        new_day = i == 0 or days[i] != days[i - 1]
        if new_day:
            if day_h is not None:
                lm.set_named("pdh", day_h, 1, i)
                lm.set_named("pdl", day_l, -1, i)
            day_h, day_l = h[i], l[i]
            asia_h = asia_l = lon_h = lon_l = ib_h = ib_l = None
            asia_done = lon_done = ib_done = False
            if p.po3_period == "day":
                period_open = o[i]
                period_open_bar = i
        else:
            day_h, day_l = max(day_h, h[i]), min(day_l, l[i])

        wk = ctx["weeks"][i]
        if wk != cur_week:
            if wk_h is not None:
                lm.set_named("pwh", wk_h, 1, i)
                lm.set_named("pwl", wk_l, -1, i)
            wk_h, wk_l = h[i], l[i]
            cur_week = wk
            if p.po3_period == "week":
                period_open = o[i]
                period_open_bar = i
        else:
            wk_h, wk_l = max(wk_h, h[i]), min(wk_l, l[i])

        m = mspos[i]
        if m < M_ASIA_END:
            asia_h = h[i] if asia_h is None else max(asia_h, h[i])
            asia_l = l[i] if asia_l is None else min(asia_l, l[i])
        elif not asia_done:
            asia_done = True
            if asia_h is not None:
                lm.set_named("asiah", asia_h, 1, i)
                lm.set_named("asial", asia_l, -1, i)
        if M_ASIA_END <= m < M_LON_END:
            lon_h = h[i] if lon_h is None else max(lon_h, h[i])
            lon_l = l[i] if lon_l is None else min(lon_l, l[i])
        elif m >= M_LON_END and not lon_done:
            lon_done = True
            if lon_h is not None:
                lm.set_named("lonh", lon_h, 1, i)
                lm.set_named("lonl", lon_l, -1, i)
        if M_RTH_OPEN <= m < M_IB_END:
            ib_h = h[i] if ib_h is None else max(ib_h, h[i])
            ib_l = l[i] if ib_l is None else min(ib_l, l[i])
        elif m >= M_IB_END and not ib_done:
            ib_done = True
            if ib_h is not None:
                lm.set_named("ibh", ib_h, 1, i)
                lm.set_named("ibl", ib_l, -1, i)

        # ── 3. fractal pivots (visible only PIVOT_LEN bars late) ────────────
        k = i - PL
        if k - PL >= 0 and a:
            win_h = h[k - PL:i + 1]
            win_l = l[k - PL:i + 1]
            if h[k] == max(win_h) and max(h[k + 1:i + 1]) < h[k]:
                lm.add_pivot(h[k], 1, k, a)
            if l[k] == min(win_l) and min(l[k + 1:i + 1]) > l[k]:
                lm.add_pivot(l[k], -1, k, a)

        if a is None or i == 0:
            continue

        # ── 4. sweeps -> raids ──────────────────────────────────────────────
        allowed = set(p.pools)

        def usable(pool):
            if pool.kind not in allowed:
                return False
            if pool.kind == "pivot" and p.eq_only and not pool.eq:
                return False
            return True

        hit_bsl, hit_ssl = lm.mark_swept(h[i], l[i])
        for side, hits in ((-1, hit_ssl), (1, hit_bsl)):
            hits = [x for x in hits if usable(x)]
            if not hits:
                continue
            # one raid per bar per side; the level to reclaim is the *nearest*
            # swept level on the far side of the extreme, i.e. the hardest one
            lvl = max(x.price for x in hits) if side == -1 else min(x.price for x in hits)
            kind = "+".join(sorted({x.kind for x in hits}))
            same = next((x for x in raids if x.side == side), None)
            if same is not None:
                # the raid is still running: extend it rather than spawning a
                # second, near-duplicate setup on the same leg
                same.level = max(same.level, lvl) if side == -1 else min(same.level, lvl)
                same.bar = i
                same.kind = kind
            else:
                raids.append(Raid(lvl, side, i, l[i] if side == -1 else h[i], kind, i))

        # ── 5. reclaim -> signal ────────────────────────────────────────────
        still = []
        for r in raids:
            bull = r.side == -1
            r.extreme = min(r.extreme, l[i]) if bull else max(r.extreme, h[i])
            depth = (r.level - r.extreme) if bull else (r.extreme - r.level)
            # 0 means "no cap", exactly as the indicator's input reads. Before
            # this guard, a literal 0 here silently rejected every signal
            # instead of disabling the filter.
            if p.max_sweep_atr > 0 and depth > p.max_sweep_atr * a:
                continue                                # ran too far: breakout
            if i - r.bar > p.reclaim_bars:           # never reclaimed in time
                continue
            reclaimed = c[i] > r.level if bull else c[i] < r.level
            if not reclaimed:
                still.append(r)
                continue

            # every reclaim is reported to the collector *before* any gate, so
            # the edge study and the trading model share one code path
            if collector is not None:
                sd = vsd[i]
                collector({
                    "bar": i, "dir": 1 if bull else -1, "kind": r.kind,
                    "depth_atr": depth / a,
                    "vwap_z": (r.extreme - vwap[i]) / sd if sd > 0 else 0.0,
                    "open_atr": ((period_open - r.extreme) / a if bull else
                                 (r.extreme - period_open) / a)
                                if period_open is not None else 0.0,
                    "lag": i - r.first_bar,
                    "mspo": mspos[i],
                    "close_dir": (c[i] > o[i]) if bull else (c[i] < o[i]),
                    "reclaim_atr": (c[i] - r.level) / a if bull else (r.level - c[i]) / a,
                    "range_atr": (h[i] - l[i]) / a,
                    "vwap_ok": vok[i],
                    "vol_rel": (v[i] / vsma[i]) if (vsma[i] and vsma[i] > 0) else None,
                    "extreme": r.extreme, "level": r.level, "close": c[i], "atr": a,
                    "vwap": vwap[i], "vsd": sd, "period_open": period_open,
                })

            # -- gates -------------------------------------------------------
            ok = depth >= p.min_sweep_atr * a
            ok = ok and (p.longs if bull else p.shorts)
            ok = ok and lo_i <= i < hi_i
            ok = ok and in_session(mspos[i], p.session)
            ok = ok and i - last_sig[r.side] >= p.cooldown
            if ok and p.require_close_dir:
                ok = c[i] > o[i] if bull else c[i] < o[i]
            if ok and p.vol_mult > 0:
                # a reclaim nobody participated in is drift, not a decision
                ok = (vsma[i] is not None and vsma[i] > 0
                      and v[i] >= p.vol_mult * vsma[i])
            if ok and p.use_vwap:
                if not vok[i]:
                    ok = False            # band not seeded yet - do not guess
                else:
                    band = (vwap[i] - p.dev_entry * vsd[i]) if bull else \
                           (vwap[i] + p.dev_entry * vsd[i])
                    ok = r.extreme <= band if bull else r.extreme >= band
            if ok and p.vwap_reclaim:
                if not vok[i]:
                    ok = False
                else:
                    ok = c[i] > vwap[i] if bull else c[i] < vwap[i]
            if ok and p.max_open_bars > 0:
                # PO3 says the Judas swing comes early in the period, not late.
                ok = (i - period_open_bar) <= p.max_open_bars
            if ok and p.po3_mode != "off" and period_open is not None:
                ok = r.extreme < period_open if bull else r.extreme > period_open
                if ok and p.po3_mode == "reclaim_open":
                    ok = c[i] > period_open if bull else c[i] < period_open
            if not ok:
                continue

            # -- build the setup ---------------------------------------------
            if p.entry_mode == "reclaim_close":
                entry = c[i]
            elif p.entry_mode == "wick_mid":
                entry = (r.level + r.extreme) / 2.0
            elif p.entry_mode == "level_retest":
                entry = r.level
            else:
                raise ValueError(p.entry_mode)
            anchor = r.extreme if p.stop_at == "extreme" else r.level
            stop = (anchor - p.stop_buf_atr * a) if bull else (anchor + p.stop_buf_atr * a)
            risk = (entry - stop) if bull else (stop - entry)
            if risk < min_risk:
                continue
            # A reclaim that closed a long way from the raid extreme leaves a
            # stop so wide the target stops being reachable; cap it rather than
            # take the trade at any size.
            if p.max_risk_atr > 0 and risk > p.max_risk_atr * a:
                continue
            # Minimum worthwhile target, in price points.
            if p.min_target_pts > 0 and p.rr * risk < p.min_target_pts:
                continue
            tp = (entry + p.rr * risk) if bull else (entry - p.rr * risk)
            if p.tp_mode == "pool":
                # ERL -> IRL: aim at the nearest untouched pool on the far side
                # rather than a fixed multiple. Falls back to the R target when
                # there is nothing left to aim at.
                opp = [q.price for q in lm.live(1 if bull else -1)
                       if ((q.price > entry) if bull else (q.price < entry))]
                if opp:
                    cand = min(opp) if bull else max(opp)
                    if (cand - entry if bull else entry - cand) >= 0.5 * risk:
                        tp = cand
            market = p.entry_mode == "reclaim_close"
            trades.append({"dir": 1 if bull else -1,
                           "entry": entry, "stop": stop, "tp": tp, "risk": risk,
                           "created": i, "fill_bar": i if market else -1,
                           "state": "filled" if market else "pending",
                           "be": False, "mae": 0.0,
                           "part": 0.0, "peak": entry,
                           "feat": {"kind": r.kind, "depth_atr": depth / a,
                                    "lag": i - r.first_bar, "mspo": mspos[i],
                                    "atr": a, "risk": risk, "entry": entry,
                                    "reclaim_atr": (abs(c[i] - r.level)) / a,
                                    "range_atr": (h[i] - l[i]) / a,
                                    "vwap_z": ((r.extreme - vwap[i]) / vsd[i]
                                               if vsd[i] > 0 else 0.0),
                                    "vol_rel": (v[i] / vsma[i]
                                                if vsma[i] and vsma[i] > 0 else None)}})
            if market:
                res.fills += 1
            res.signals += 1
            last_sig[r.side] = i
            signal_log.append((i, 1 if bull else -1, r.extreme))
            if trade_log is not None:
                trade_log.append((i, 1 if bull else -1, round(entry, 6),
                                  round(stop, 6), round(tp, 6)))
        raids = still

    res.open_end = len(trades)

    # ── diagnostic: how often was the raid extreme the actual local extreme? ─
    for i, d, ext in signal_log:
        j = min(i + extreme_horizon, n)
        if j <= i + 1:
            continue
        fwd = min(l[i + 1:j]) if d == 1 else max(h[i + 1:j])
        res.caught_extreme.append(ext <= fwd if d == 1 else ext >= fwd)
    return res
