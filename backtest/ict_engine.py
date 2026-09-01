#!/usr/bin/env python3
"""ICT sweep -> MSS -> FVG strategy engine (offline, dependency-free).

Models one mechanical trade sequence, strictly causally:

  1. LIQUIDITY SWEEP   price raids a live sell-side pool (prior-day low, prior
                       session low, or an untaken swing low) and closes back
                       above it.
  2. MSS               within a window, a bar CLOSES through the most recent
                       swing high that existed at the sweep, with a
                       displacement body (>= disp_atr x ATR).
  3. FVG / IFVG        the displacement leg leaves a fair value gap; the limit
                       entry sits inside it (proximal / CE / distal). If no
                       fresh FVG formed, an inverted FVG the leg closed
                       through can be used instead.
  4. RISK              stop beyond the sweep extreme + ATR buffer; target is
                       fixed R or the next opposing liquidity pool.

Everything is mirrored for shorts. All accounting is deliberately pessimistic
(see fill model in `_manage`): a fill bar that also trades the stop books a
loss, TP is never credited on the fill bar, and the stop wins any same-bar tie.
Costs (commission + stop slippage) are charged in R.
"""
from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field, replace
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

# Per-contract economics used to convert costs into R.
CONTRACTS = {
    "MNQ": dict(tick=0.25, point_value=2.0, commission_rt=1.04),
    "NQ":  dict(tick=0.25, point_value=20.0, commission_rt=4.28),
    "MES": dict(tick=0.25, point_value=5.0, commission_rt=1.04),
    "ES":  dict(tick=0.25, point_value=50.0, commission_rt=4.28),
    "QQQ": dict(tick=0.01, point_value=1.0, commission_rt=0.02),
    "SPY": dict(tick=0.01, point_value=1.0, commission_rt=0.02),
}

KILLZONES = {
    "all":     [(0, 24 * 60)],
    "rth":     [(9 * 60 + 30, 16 * 60)],
    "nyam":    [(9 * 60 + 30, 11 * 60 + 30)],
    "nyam_ex": [(8 * 60 + 30, 11 * 60 + 30)],   # includes the 08:30 news window
    "nypm":    [(13 * 60 + 30, 16 * 60)],
    "london":  [(2 * 60, 5 * 60)],
    "lnyam":   [(2 * 60, 5 * 60), (9 * 60 + 30, 11 * 60 + 30)],
    "nyboth":  [(9 * 60 + 30, 11 * 60 + 30), (13 * 60 + 30, 15 * 60 + 30)],
}


@dataclass
class Config:
    # structure
    pivot_len: int = 2           # fractal half-width; pivot confirmed pivot_len bars later
    pool_lookback: int = 120     # how far back untaken swing pools stay eligible
    use_pd_levels: bool = True   # prior-day high/low as pools
    use_session_levels: bool = True   # Asia / London range extremes as pools
    # sweep
    min_sweep_atr: float = 0.0   # depth beyond the level, in ATR
    max_sweep_atr: float = 3.0   # ignore raids that blow through the level
    # MSS
    mss_window: int = 12         # bars allowed between sweep and MSS
    mss_ref: str = "prior"       # "prior" = last swing high before the sweep, "recent" = newest
    disp_atr: float = 0.5        # MSS bar body >= this x ATR
    # entry
    entry_mode: str = "fvg"      # "fvg" = limit in the gap, "market" = at the next open after MSS
    fvg_wait: int = 3            # bars after MSS to wait for an FVG to form
    ce_frac: float = 0.5         # 0 = proximal edge, 0.5 = consequent encroachment, 1 = distal
    fvg_pick: str = "recent"     # "recent" = last gap in the leg, "first" = the one nearest the sweep
    use_ifvg: bool = True        # allow inverted-FVG entries when no fresh FVG
    entry_validity: int = 12     # bars a resting limit stays live
    # risk
    atr_len: int = 14
    stop_buf_atr: float = 0.25
    stop_mode: str = "sweep"     # sweep | fvg | struct | tighter
    min_stop_atr: float = 0.3    # floor on risk so degenerate setups can't book huge R
    max_stop_atr: float = 4.0    # skip setups whose stop is absurdly wide
    target_mode: str = "rr"      # "rr" | "liquidity"
    rr: float = 2.5
    min_rr: float = 1.5          # liquidity mode: floor
    max_rr: float = 5.0          # liquidity mode: cap
    be_r: float = 1.0            # move stop to entry at +R (0 = off)
    max_hold: int = 0            # bars after fill (0 = off)
    # filters
    killzone: str = "nyam"
    bias: str = "none"           # none|pdclose|pdmid|dopen|vwap|htf|htfs|sweepday
    htf_mult: int = 4            # bars per higher-timeframe candle for bias="htf"
    htf_mults: tuple = (6, 12)   # bias="htfs": every listed HTF must agree (bars per HTF candle)
    htf_look: int = 3            # HTF candles compared for a break of structure
    vwap_filter: str = "off"     # off|with|against
    vwap_anchor: str = "rth"     # rth|session
    max_trades_day: int = 2
    allow_long: bool = True
    allow_short: bool = True
    eod_flat_min: int = 15 * 60 + 55   # ET minute to flatten intraday (-1 = off)
    # costs
    stop_slip_ticks: float = 1.0
    charge_costs: bool = True


@dataclass
class Trade:
    ts: int
    direction: int
    entry: float
    stop: float
    tp: float
    risk: float
    created: int
    hour: int = 0
    day: int = 0
    state: str = "pending"
    filled_bar: int = -1
    be: bool = False
    market: bool = False
    r: float = 0.0
    exit_kind: str = ""
    mfe_r: float = 0.0
    mae_r: float = 0.0
    bars_held: int = 0


@dataclass
class Result:
    trades: list = field(default_factory=list)   # closed Trade objects
    setups: int = 0
    fills: int = 0
    expired: int = 0
    diag: dict = field(default_factory=dict)

    @property
    def closed(self):
        return self.trades

    @property
    def n(self):
        return len(self.trades)

    @property
    def net_r(self):
        return sum(t.r for t in self.trades)

    @property
    def wins(self):
        return sum(1 for t in self.trades if t.r > 0.01)

    @property
    def losses(self):
        return sum(1 for t in self.trades if t.r < -0.01)

    @property
    def scratches(self):
        return sum(1 for t in self.trades if -0.01 <= t.r <= 0.01)

    @property
    def wr(self):
        d = self.wins + self.losses
        return 100.0 * self.wins / d if d else 0.0

    @property
    def pf(self):
        gw = sum(t.r for t in self.trades if t.r > 0)
        gl = -sum(t.r for t in self.trades if t.r < 0)
        if gl <= 0:
            return float("inf") if gw > 0 else 0.0
        return gw / gl

    @property
    def expectancy(self):
        return self.net_r / self.n if self.n else 0.0

    @property
    def max_dd(self):
        eq = peak = dd = 0.0
        for t in self.trades:
            eq += t.r
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
        return dd

    def summary(self):
        return (f"n={self.n:4d} fills={self.fills:4d} W/L/BE={self.wins}/{self.losses}/"
                f"{self.scratches} WR={self.wr:5.1f}% PF={self.pf:5.2f} "
                f"netR={self.net_r:+7.1f} exp={self.expectancy:+5.2f} dd={self.max_dd:4.1f}")


# ── data ─────────────────────────────────────────────────────────────────────

def load(path):
    t, o, h, l, c, v = [], [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            t.append(int(row["time"]))
            o.append(float(row["open"]))
            h.append(float(row["high"]))
            l.append(float(row["low"]))
            c.append(float(row["close"]))
            v.append(float(row["volume"]))
    return t, o, h, l, c, v


def _clock(ts_list):
    """ET minute-of-day and a futures day id (18:00 ET rollover), DST-correct."""
    minute, day = [], []
    for ts in ts_list:
        d = datetime.fromtimestamp(ts, ET)
        m = d.hour * 60 + d.minute
        minute.append(m)
        # day id: ordinal, rolled to the next day for the 18:00-24:00 Globex open
        day.append(d.toordinal() + (1 if d.hour >= 18 else 0))
    return minute, day


def prepare(bars, cfg: Config):
    """Precompute everything path-independent: clocks, ATR, VWAP, pivots, levels."""
    t, o, h, l, c, v = bars
    n = len(c)
    minute, day = _clock(t)

    tr = [h[0] - l[0]] * n
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    atr = [None] * n
    if n > cfg.atr_len:
        seed = sum(tr[1:cfg.atr_len + 1]) / cfg.atr_len
        atr[cfg.atr_len] = seed
        k = 1.0 / cfg.atr_len
        for i in range(cfg.atr_len + 1, n):
            atr[i] = atr[i - 1] * (1 - k) + tr[i] * k

    # session VWAP (reset at 18:00 ET Globex open, or at 09:30 RTH)
    vwap = [None] * n
    pv = vol = 0.0
    for i in range(n):
        reset = i == 0 or day[i] != day[i - 1]
        if cfg.vwap_anchor == "rth":
            reset = reset or (minute[i] >= 570 and (i == 0 or minute[i - 1] < 570
                                                    or day[i] != day[i - 1]))
        if reset:
            pv = vol = 0.0
        tp = (h[i] + l[i] + c[i]) / 3.0
        pv += tp * v[i]
        vol += v[i]
        vwap[i] = pv / vol if vol > 0 else c[i]

    # fractal pivots: pivot at p is confirmed only at bar p + pivot_len
    k = cfg.pivot_len
    piv_hi, piv_lo = [], []          # (bar, price), ascending by bar
    for p in range(k, n - k):
        seg_h = h[p - k:p + k + 1]
        seg_l = l[p - k:p + k + 1]
        if h[p] == max(seg_h) and h[p] > max(h[p - k:p]) and h[p] >= max(h[p + 1:p + k + 1]):
            piv_hi.append((p, h[p]))
        if l[p] == min(seg_l) and l[p] < min(l[p - k:p]) and l[p] <= min(l[p + 1:p + k + 1]):
            piv_lo.append((p, l[p]))

    # prior-day and prior-session extremes per bar (causal: only completed days)
    day_hi, day_lo, day_open = {}, {}, {}
    for i in range(n):
        d = day[i]
        if d not in day_hi:
            day_hi[d], day_lo[d], day_open[d] = h[i], l[i], o[i]
        else:
            day_hi[d] = max(day_hi[d], h[i])
            day_lo[d] = min(day_lo[d], l[i])
    days_sorted = sorted(day_hi)
    prev_of = {d: days_sorted[j - 1] for j, d in enumerate(days_sorted) if j > 0}

    # Asia (18:00-02:00 ET) and London (02:00-08:00 ET) ranges of the current day
    asia_hi, asia_lo, lon_hi, lon_lo = {}, {}, {}, {}
    for i in range(n):
        d, m = day[i], minute[i]
        if m >= 18 * 60 or m < 2 * 60:
            asia_hi[d] = max(asia_hi.get(d, h[i]), h[i])
            asia_lo[d] = min(asia_lo.get(d, l[i]), l[i])
        elif m < 8 * 60:
            lon_hi[d] = max(lon_hi.get(d, h[i]), h[i])
            lon_lo[d] = min(lon_lo.get(d, l[i]), l[i])

    # higher-timeframe structure bias: break of the prior HTF block extremes
    def _htf_series(m, look):
        blocks = [(i + m - 1, max(h[i:i + m]), min(l[i:i + m]))
                  for i in range(0, n - m + 1, m)]
        out, state, bi = [0] * n, 0, 0
        for i in range(n):
            while bi < len(blocks) and blocks[bi][0] <= i:
                if bi >= look:
                    prev = blocks[bi - look:bi]
                    _, bh, bl = blocks[bi]
                    if bh > max(x[1] for x in prev):
                        state = 1
                    elif bl < min(x[2] for x in prev):
                        state = -1
                bi += 1
            out[i] = state
        return out

    htf_stack = ([_htf_series(max(2, m), cfg.htf_look) for m in cfg.htf_mults]
                 if cfg.bias == "htfs" else [])

    htf_bias = [0] * n
    if cfg.bias == "htf":
        m = max(2, cfg.htf_mult)
        look = cfg.htf_look
        blocks = []                      # (end_bar, hi, lo) of completed HTF candles
        for i in range(0, n - m + 1, m):
            blocks.append((i + m - 1, max(h[i:i + m]), min(l[i:i + m])))
        state, bi = 0, 0
        for i in range(n):
            while bi < len(blocks) and blocks[bi][0] <= i:
                if bi >= look:
                    prev = blocks[bi - look:bi]
                    _, bh, bl = blocks[bi]
                    if bh > max(x[1] for x in prev):
                        state = 1
                    elif bl < min(x[2] for x in prev):
                        state = -1
                bi += 1
            htf_bias[i] = state

    return dict(t=t, o=o, h=h, l=l, c=c, v=v, n=n, minute=minute, day=day,
                atr=atr, vwap=vwap, piv_hi=piv_hi, piv_lo=piv_lo,
                day_hi=day_hi, day_lo=day_lo, day_open=day_open, prev_of=prev_of,
                asia_hi=asia_hi, asia_lo=asia_lo, lon_hi=lon_hi, lon_lo=lon_lo,
                htf_bias=htf_bias, htf_stack=htf_stack)


# ── engine ───────────────────────────────────────────────────────────────────

def _in_kz(minute, cfg):
    for a, b in KILLZONES.get(cfg.killzone, KILLZONES["all"]):
        if a <= minute < b:
            return True
    return False


def _bias_ok(d, i, direction, cfg):
    """Daily/HTF bias gate. Returns True when `direction` is permitted."""
    b = cfg.bias
    if b == "none":
        return True
    c, day, prev_of = d["c"][i], d["day"][i], d["prev_of"]
    if b == "vwap":
        ref = d["vwap"][i]
        return (c > ref) if direction > 0 else (c < ref)
    if b == "htf":
        return d["htf_bias"][i] == direction
    if b == "htfs":
        return all(series[i] == direction for series in d["htf_stack"])
    prev = prev_of.get(day)
    if prev is None:
        return False
    if b == "pdclose":
        # prior day's last close, approximated by its range midpoint's own close
        ref = d["day_close"][prev]
        return (c > ref) if direction > 0 else (c < ref)
    if b == "pdmid":
        ref = (d["day_hi"][prev] + d["day_lo"][prev]) / 2.0
        return (c > ref) if direction > 0 else (c < ref)
    if b == "dopen":
        ref = d["day_open"][day]
        return (c > ref) if direction > 0 else (c < ref)
    if b == "sweepday":
        # ICT daily bias by draw: if today already raided PDL and reclaimed it,
        # the draw is to the upside (and vice versa).
        pdl, pdh = d["day_lo"][prev], d["day_hi"][prev]
        raided_lo = d["day_min_so_far"][i] < pdl
        raided_hi = d["day_max_so_far"][i] > pdh
        if raided_lo and not raided_hi:
            return direction > 0 and c > pdl
        if raided_hi and not raided_lo:
            return direction < 0 and c < pdh
        return False
    return True


def _vwap_ok(d, i, direction, cfg):
    if cfg.vwap_filter == "off":
        return True
    above = d["c"][i] > d["vwap"][i]
    if cfg.vwap_filter == "with":       # trade in the direction VWAP confirms
        return above if direction > 0 else not above
    if cfg.vwap_filter == "against":    # buy discount below VWAP / sell premium above
        return (not above) if direction > 0 else above
    return True


def _find_fvg(d, direction, lo_bar, hi_bar, cfg):
    """Most recent fair value gap of `direction` polarity with its third bar in
    [lo_bar, hi_bar]. Returns (gap_bot, gap_top) or None."""
    h, l, atr = d["h"], d["l"], d["atr"]
    lo = max(lo_bar, 2)
    order = range(hi_bar, lo - 1, -1) if cfg.fvg_pick == "recent" else range(lo, hi_bar + 1)
    for x in order:
        a = atr[x] or 0.0
        if direction > 0 and l[x] > h[x - 2]:
            if l[x] - h[x - 2] >= 0.05 * a:
                return h[x - 2], l[x]
        if direction < 0 and h[x] < l[x - 2]:
            if l[x - 2] - h[x] >= 0.05 * a:
                return h[x], l[x - 2]
    return None


def _find_ifvg(d, direction, lo_bar, hi_bar, cfg, close_now):
    """An opposite-polarity FVG the displacement leg closed through, which now
    acts as support (long) / resistance (short). Returns (bot, top) or None."""
    h, l, atr = d["h"], d["l"], d["atr"]
    for x in range(hi_bar, max(lo_bar, 2) - 1, -1):
        a = atr[x] or 0.0
        if direction > 0 and h[x] < l[x - 2] and (l[x - 2] - h[x]) >= 0.05 * a:
            if close_now > l[x - 2]:            # inverted: closed above the gap
                return h[x], l[x - 2]
        if direction < 0 and l[x] > h[x - 2] and (l[x] - h[x - 2]) >= 0.05 * a:
            if close_now < h[x - 2]:
                return h[x - 2], l[x]
    return None


def run(bars, cfg: Config, symbol="MNQ", pre=None) -> Result:
    d = pre if pre is not None else prepare(bars, cfg)
    o, h, l, c = d["o"], d["h"], d["l"], d["c"]
    n, minute, day, atr, ts = d["n"], d["minute"], d["day"], d["atr"], d["t"]

    # per-bar running day extremes and prior-day closes (needed by some biases)
    if "day_min_so_far" not in d:
        dmin, dmax, dclose = [0.0] * n, [0.0] * n, {}
        cur_lo = cur_hi = None
        for i in range(n):
            if i == 0 or day[i] != day[i - 1]:
                cur_lo, cur_hi = l[i], h[i]
                if i > 0:
                    dclose[day[i - 1]] = c[i - 1]
            else:
                cur_lo, cur_hi = min(cur_lo, l[i]), max(cur_hi, h[i])
            dmin[i], dmax[i] = cur_lo, cur_hi
        dclose[day[n - 1]] = c[n - 1]
        d["day_min_so_far"], d["day_max_so_far"], d["day_close"] = dmin, dmax, dclose

    spec = CONTRACTS.get(symbol, CONTRACTS["MNQ"])
    comm_pts = spec["commission_rt"] / spec["point_value"]
    slip_pts = cfg.stop_slip_ticks * spec["tick"]

    res = Result()
    D = res.diag
    k = cfg.pivot_len
    piv_hi, piv_lo = d["piv_hi"], d["piv_lo"]
    hi_ptr = lo_ptr = 0
    conf_hi, conf_lo = [], []        # confirmed pivots (bar, price)
    sell_pools, buy_pools = [], []   # live liquidity: dicts(price, bar, kind)
    swept_low = swept_high = None    # pending sweep contexts
    trade = None
    trades_today, cur_day = 0, None
    added_pd, added_asia, added_lon = set(), set(), set()

    def book(tr, r_gross, kind, bar):
        risk_pts = tr.risk
        cost = 0.0
        if cfg.charge_costs and risk_pts > 0:
            cost = comm_pts / risk_pts
            if kind in ("stop", "be", "eod", "time"):
                cost += slip_pts / risk_pts
        tr.r = r_gross - cost
        tr.exit_kind = kind
        tr.state = "done"
        res.trades.append(tr)

    for i in range(n):
        a = atr[i]
        if cur_day != day[i]:
            cur_day, trades_today = day[i], 0

        # ── 1. manage the live order/position with THIS bar ──────────────────
        if trade is not None and trade.created < i:
            bull = trade.direction > 0
            if trade.state == "pending" and trade.market:
                fill = o[i] + trade.direction * slip_pts
                shift = fill - trade.entry
                trade.entry, trade.stop, trade.tp = fill, trade.stop + shift, trade.tp + shift
                trade.state = "filled"
                trade.filled_bar = i
                res.fills += 1
                if (l[i] <= trade.stop) if bull else (h[i] >= trade.stop):
                    book(trade, -1.0, "stop", i)
                    trade = None
            elif trade.state == "pending":
                hit_entry = (l[i] <= trade.entry) if bull else (h[i] >= trade.entry)
                hit_stop = (l[i] <= trade.stop) if bull else (h[i] >= trade.stop)
                if hit_entry:
                    trade.state = "filled"
                    trade.filled_bar = i
                    res.fills += 1
                    if hit_stop:                      # pessimistic: same-bar stop
                        book(trade, -1.0, "stop", i)
                        trade = None
                elif hit_stop or i - trade.created >= cfg.entry_validity:
                    res.expired += 1
                    trade = None
                elif cfg.eod_flat_min >= 0 and minute[i] >= cfg.eod_flat_min and \
                        minute[i] < cfg.eod_flat_min + 120:
                    res.expired += 1
                    trade = None
            if trade is not None and trade.state == "filled" and trade.filled_bar < i:
                stop_hit = (l[i] <= trade.stop) if bull else (h[i] >= trade.stop)
                tp_hit = (h[i] >= trade.tp) if bull else (l[i] <= trade.tp)
                if stop_hit:
                    book(trade, 0.0 if trade.be else -1.0,
                         "be" if trade.be else "stop", i)
                    trade = None
                elif tp_hit:
                    rr_actual = abs(trade.tp - trade.entry) / trade.risk
                    book(trade, rr_actual, "tp", i)
                    trade = None
                else:
                    mfe = (h[i] - trade.entry) if bull else (trade.entry - l[i])
                    mae = (trade.entry - l[i]) if bull else (h[i] - trade.entry)
                    trade.mfe_r = max(trade.mfe_r, mfe / trade.risk)
                    trade.mae_r = max(trade.mae_r, mae / trade.risk)
                    trade.bars_held = i - trade.filled_bar
                    if cfg.be_r > 0 and not trade.be and mfe >= cfg.be_r * trade.risk:
                        trade.be = True
                        trade.stop = trade.entry
                    if cfg.max_hold and i - trade.filled_bar >= cfg.max_hold:
                        r = ((c[i] - trade.entry) if bull else (trade.entry - c[i])) / trade.risk
                        book(trade, r, "time", i)
                        trade = None
                    elif cfg.eod_flat_min >= 0 and minute[i] >= cfg.eod_flat_min and \
                            minute[i] < cfg.eod_flat_min + 120:
                        r = ((c[i] - trade.entry) if bull else (trade.entry - c[i])) / trade.risk
                        book(trade, r, "eod", i)
                        trade = None

        # ── 2. publish newly confirmed pivots and session/day pools ──────────
        while hi_ptr < len(piv_hi) and piv_hi[hi_ptr][0] + k <= i:
            p, price = piv_hi[hi_ptr]
            conf_hi.append((p, price))
            buy_pools.append(dict(price=price, bar=p, kind="swing"))
            hi_ptr += 1
        while lo_ptr < len(piv_lo) and piv_lo[lo_ptr][0] + k <= i:
            p, price = piv_lo[lo_ptr]
            conf_lo.append((p, price))
            sell_pools.append(dict(price=price, bar=p, kind="swing"))
            lo_ptr += 1

        if cfg.use_pd_levels and day[i] not in added_pd:
            prev = d["prev_of"].get(day[i])
            if prev is not None:
                buy_pools.append(dict(price=d["day_hi"][prev], bar=i, kind="pdh"))
                sell_pools.append(dict(price=d["day_lo"][prev], bar=i, kind="pdl"))
            added_pd.add(day[i])
        if cfg.use_session_levels:
            if minute[i] >= 2 * 60 and day[i] not in added_asia:
                if day[i] in d["asia_hi"]:
                    buy_pools.append(dict(price=d["asia_hi"][day[i]], bar=i, kind="asia"))
                    sell_pools.append(dict(price=d["asia_lo"][day[i]], bar=i, kind="asia"))
                added_asia.add(day[i])
            if minute[i] >= 8 * 60 and day[i] not in added_lon:
                if day[i] in d["lon_hi"]:
                    buy_pools.append(dict(price=d["lon_hi"][day[i]], bar=i, kind="london"))
                    sell_pools.append(dict(price=d["lon_lo"][day[i]], bar=i, kind="london"))
                added_lon.add(day[i])

        if a is None or a <= 0:
            continue

        # ── 3. liquidity sweeps (raid + close back inside) ───────────────────
        raided_sell = [pl for pl in sell_pools if l[i] < pl["price"]]
        raided_buy = [pl for pl in buy_pools if h[i] > pl["price"]]
        if raided_sell:
            best = max(raided_sell, key=lambda pl: pl["price"])
            depth = best["price"] - l[i]
            if c[i] > best["price"] and cfg.min_sweep_atr * a <= depth <= cfg.max_sweep_atr * a:
                trig = None
                for p, price in reversed(conf_hi):
                    if price > c[i]:
                        trig = price
                        break
                if trig is not None:
                    swept_low = dict(bar=i, low=l[i], trig=trig, level=best["price"])
                    D["sweep"] = D.get("sweep", 0) + 1
            sell_pools = [pl for pl in sell_pools if l[i] >= pl["price"]]
        if raided_buy:
            best = min(raided_buy, key=lambda pl: pl["price"])
            depth = h[i] - best["price"]
            if c[i] < best["price"] and cfg.min_sweep_atr * a <= depth <= cfg.max_sweep_atr * a:
                trig = None
                for p, price in reversed(conf_lo):
                    if price < c[i]:
                        trig = price
                        break
                if trig is not None:
                    swept_high = dict(bar=i, high=h[i], trig=trig, level=best["price"])
                    D["sweep"] = D.get("sweep", 0) + 1
            buy_pools = [pl for pl in buy_pools if h[i] <= pl["price"]]
        sell_pools = [pl for pl in sell_pools if i - pl["bar"] <= cfg.pool_lookback]
        buy_pools = [pl for pl in buy_pools if i - pl["bar"] <= cfg.pool_lookback]

        # ── 4. MSS + FVG entry construction ─────────────────────────────────
        for direction in (1, -1):
            ctx = swept_low if direction > 0 else swept_high
            if ctx is None or ctx["bar"] >= i:
                continue
            if i - ctx["bar"] > cfg.mss_window:
                if direction > 0:
                    swept_low = None
                else:
                    swept_high = None
                continue
            # structure re-broken the wrong way: the sweep failed
            if (l[i] < ctx["low"]) if direction > 0 else (h[i] > ctx["high"]):
                if direction > 0:
                    swept_low = None
                else:
                    swept_high = None
                continue
            trig = ctx["trig"]
            if cfg.mss_ref == "recent":
                pool = conf_hi if direction > 0 else conf_lo
                for p, price in reversed(pool):
                    if p > ctx["bar"]:
                        trig = price
                        break
            broke = (c[i] > trig) if direction > 0 else (c[i] < trig)
            if not broke:
                continue
            body = abs(c[i] - o[i])
            if body < cfg.disp_atr * a:
                continue
            if not ctx.get("armed"):
                D["mss"] = D.get("mss", 0) + 1
            ctx["mss_bar"] = i
            ctx["armed"] = True

        # entry construction runs for an armed context on the MSS bar and for
        # `fvg_wait` bars after it, so a gap that completes late is still used
        for direction in (1, -1):
            ctx = swept_low if direction > 0 else swept_high
            if ctx is None or not ctx.get("armed"):
                continue
            if i - ctx["mss_bar"] > cfg.fvg_wait:
                if direction > 0:
                    swept_low = None
                else:
                    swept_high = None
                continue
            if trade is not None:
                D["rej_busy"] = D.get("rej_busy", 0) + 1
                continue
            if not (cfg.allow_long if direction > 0 else cfg.allow_short):
                continue
            if trades_today >= cfg.max_trades_day:
                D["rej_maxday"] = D.get("rej_maxday", 0) + 1
                continue
            if not _in_kz(minute[i], cfg):
                D["rej_kz"] = D.get("rej_kz", 0) + 1
                continue
            if not _bias_ok(d, i, direction, cfg):
                D["rej_bias"] = D.get("rej_bias", 0) + 1
                continue
            if not _vwap_ok(d, i, direction, cfg):
                D["rej_vwap"] = D.get("rej_vwap", 0) + 1
                continue

            if cfg.entry_mode == "market":
                entry = c[i]
                stop = entry - direction * cfg.min_stop_atr * a
                risk = abs(entry - stop)
                tp = entry + direction * cfg.rr * risk
                trade = Trade(ts=ts[i], direction=direction, entry=entry, stop=stop,
                              tp=tp, risk=risk, created=i, hour=minute[i] // 60,
                              day=day[i], market=True)
                res.setups += 1
                trades_today += 1
                if direction > 0:
                    swept_low = None
                else:
                    swept_high = None
                continue

            gap = _find_fvg(d, direction, ctx["bar"], i, cfg)
            if gap is None and cfg.use_ifvg:
                gap = _find_ifvg(d, direction, max(0, ctx["bar"] - cfg.pool_lookback),
                                 i, cfg, c[i])
            if gap is None:
                D["rej_nogap"] = D.get("rej_nogap", 0) + 1
                continue
            gbot, gtop = gap
            buf = cfg.stop_buf_atr * a
            # structural stop: the pullback swing formed after the sweep
            struct = None
            pool = conf_lo if direction > 0 else conf_hi
            for p, price in reversed(pool):
                if p > ctx["bar"]:
                    struct = price
                    break
            if direction > 0:
                entry = gtop - cfg.ce_frac * (gtop - gbot)
                cands = {"sweep": ctx["low"] - buf, "fvg": gbot - buf,
                         "struct": (struct - buf) if struct is not None else ctx["low"] - buf}
                cands["tighter"] = max(cands["sweep"], cands["struct"])
                stop = min(cands[cfg.stop_mode], entry - cfg.min_stop_atr * a)
                if not (stop < entry < c[i]):
                    D["rej_geom"] = D.get("rej_geom", 0) + 1
                    continue
            else:
                entry = gbot + cfg.ce_frac * (gtop - gbot)
                cands = {"sweep": ctx["high"] + buf, "fvg": gtop + buf,
                         "struct": (struct + buf) if struct is not None else ctx["high"] + buf}
                cands["tighter"] = min(cands["sweep"], cands["struct"])
                stop = max(cands[cfg.stop_mode], entry + cfg.min_stop_atr * a)
                if not (c[i] < entry < stop):
                    D["rej_geom"] = D.get("rej_geom", 0) + 1
                    continue
            risk = abs(entry - stop)
            if risk > cfg.max_stop_atr * a:
                D["rej_risk"] = D.get("rej_risk", 0) + 1
                continue

            if cfg.target_mode == "liquidity":
                pools = buy_pools if direction > 0 else sell_pools
                floor_ = entry + direction * cfg.min_rr * risk
                cand = [pl["price"] for pl in pools
                        if (pl["price"] > floor_ if direction > 0
                            else pl["price"] < floor_)]
                if cand:
                    tgt = min(cand) if direction > 0 else max(cand)
                    rr_eff = min(abs(tgt - entry) / risk, cfg.max_rr)
                else:
                    rr_eff = cfg.rr
            else:
                rr_eff = cfg.rr
            tp = entry + direction * rr_eff * risk

            trade = Trade(ts=ts[i], direction=direction, entry=entry, stop=stop,
                          tp=tp, risk=risk, created=i, hour=minute[i] // 60,
                          day=day[i])
            res.setups += 1
            trades_today += 1
            if direction > 0:
                swept_low = None
            else:
                swept_high = None

    return res
