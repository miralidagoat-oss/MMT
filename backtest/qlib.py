#!/usr/bin/env python3
"""Core research library: data loading, feature bank, and simulation kernels.

Design notes
------------
**No lookahead, enforced structurally.** Every feature at bar `i` is computed
from bars `<= i`. A signal at bar `i` enters at bar `i`'s *close*, and exits are
evaluated from bar `i+1` onward. Nothing reads a bar it could not have seen.

**Why bitsets.** The search evaluates millions of complete strategies. A
strategy here is (trigger, exit, filter-set, direction). Simulating each from
scratch is O(trades x bars) and hopeless at that scale. Instead each
(trigger, exit) pair is simulated *once* to produce per-trade outcomes; wins and
losses become bitsets over trade index, and every filter becomes a bitset over
the same index. Then any filtered variant's statistics are two popcounts:

    n_win  = popcount(F & W)
    n_loss = popcount(F & L)

which is ~400 machine ops regardless of trade count. That is what makes an
exhaustive multi-million-config sweep finish in minutes rather than days.

**Costs.** MNQ is $2/index point, tick 0.25pt ($0.50). Round-turn cost is
modelled in index points and charged against every trade: commission plus
spread crossing plus stop slippage. See `DEFAULT_COST_POINTS`.
"""
import numpy as np
import pandas as pd
from numba import njit, prange

# --- MNQ contract economics -------------------------------------------------
# Micro E-mini Nasdaq-100: $2 per index point, 0.25pt tick = $0.50.
MNQ_POINT_VALUE = 2.0
MNQ_TICK = 0.25
# Round-turn cost in *index points*, charged once per trade:
#   commission ~$1.00 RT ($0.50/side)            -> 0.50 pt
#   spread crossing, ~1 tick total               -> 0.25 pt
#   stop slippage allowance, ~1 tick             -> 0.25 pt
# 1.00 index point = $2.00 round turn per contract. This is deliberately on the
# realistic-to-pessimistic side; 5m systems live or die on this number.
DEFAULT_COST_POINTS = 1.00
# Overnight MNQ runs a wider spread and thinner book, so stop slippage is worse.
# Charging RTH costs to a 03:00 ET trade is the quiet way to invent an edge.
OVERNIGHT_COST_POINTS = 1.75


def cost_per_bar(et_min, rth_open=570, rth_close=960,
                 rth=DEFAULT_COST_POINTS, overnight=OVERNIGHT_COST_POINTS):
    """Per-bar round-turn cost in index points, by session."""
    inside = (et_min >= rth_open) & (et_min < rth_close)
    return np.where(inside, rth, overnight)


# ===========================================================================
# Data loading and time features
# ===========================================================================
def load_bars(path, tz="America/New_York"):
    """Load an OHLCV csv (epoch seconds) into a frame with ET time features."""
    df = pd.read_csv(path)
    df = df.dropna(subset=["open", "high", "low", "close"])
    df = df[df["high"] >= df["low"]]
    ts = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.set_index(ts).sort_index()
    df = df[~df.index.duplicated(keep="first")]
    et = df.index.tz_convert(tz)
    df["et_min"] = et.hour * 60 + et.minute      # minutes past ET midnight
    df["dow"] = et.dayofweek                     # 0=Mon
    df["session"] = _session_id(et)              # ET calendar day, as int
    return df


def _session_id(et_index):
    """Integer id per ET calendar date - the anchor for VWAP / OR / daily levels."""
    d = et_index.normalize()
    return ((d - d[0]).days).astype(np.int64)


# ===========================================================================
# Vectorised indicators (all causal)
# ===========================================================================
def ema(x, n):
    return pd.Series(x).ewm(span=n, adjust=False).mean().to_numpy()


def sma(x, n):
    return pd.Series(x).rolling(n, min_periods=n).mean().to_numpy()


def rma(x, n):
    """Wilder's smoothing - the average used by ATR and RSI."""
    return pd.Series(x).ewm(alpha=1.0 / n, adjust=False).mean().to_numpy()


def true_range(h, l, c):
    pc = np.roll(c, 1)
    pc[0] = c[0]
    return np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))


def atr(h, l, c, n=14):
    return rma(true_range(h, l, c), n)


def rsi(c, n=14):
    d = np.diff(c, prepend=c[0])
    up = rma(np.where(d > 0, d, 0.0), n)
    dn = rma(np.where(d < 0, -d, 0.0), n)
    rs = up / np.where(dn == 0, 1e-12, dn)
    return 100.0 - 100.0 / (1.0 + rs)


def rolling_max(x, n):
    return pd.Series(x).rolling(n, min_periods=n).max().to_numpy()


def rolling_min(x, n):
    return pd.Series(x).rolling(n, min_periods=n).min().to_numpy()


def rolling_rank(x, n):
    """Percentile rank of the current value within its trailing n-bar window."""
    s = pd.Series(x)
    return s.rolling(n, min_periods=max(5, n // 4)).rank(pct=True).to_numpy()


def prev_session_agg(df, col, how):
    """Previous ET session's high/low/close, broadcast onto every bar."""
    g = df.groupby("session")[col]
    agg = g.max() if how == "max" else (g.min() if how == "min" else g.last())
    prev = agg.shift(1)
    return df["session"].map(prev).to_numpy()


def session_vwap(df):
    """Session-anchored VWAP, causal (includes the current bar's own volume)."""
    tp = (df["high"] + df["low"] + df["close"]).to_numpy() / 3.0
    v = df["volume"].to_numpy().astype(np.float64)
    v = np.where(v <= 0, 1.0, v)
    s = df["session"].to_numpy()
    new = np.empty(len(s), dtype=bool)
    new[0] = True
    new[1:] = s[1:] != s[:-1]
    cum_pv = np.zeros(len(s))
    cum_v = np.zeros(len(s))
    acc_pv = acc_v = 0.0
    for i in range(len(s)):
        if new[i]:
            acc_pv = acc_v = 0.0
        acc_pv += tp[i] * v[i]
        acc_v += v[i]
        cum_pv[i] = acc_pv
        cum_v[i] = acc_v
    return cum_pv / np.where(cum_v == 0, 1e-12, cum_v)


def session_cum_extreme(df, col, how):
    """Running session high/low up to and including the current bar."""
    s = df["session"].to_numpy()
    x = df[col].to_numpy()
    out = np.empty(len(x))
    cur = np.nan
    for i in range(len(x)):
        if i == 0 or s[i] != s[i - 1]:
            cur = x[i]
        else:
            cur = max(cur, x[i]) if how == "max" else min(cur, x[i])
        out[i] = cur
    return out


def opening_range(df, minutes=30, rth_open=570):
    """Opening-range high/low for each session, NaN until the range completes."""
    s = df["session"].to_numpy()
    m = df["et_min"].to_numpy()
    h = df["high"].to_numpy()
    l = df["low"].to_numpy()
    orh = np.full(len(s), np.nan)
    orl = np.full(len(s), np.nan)
    i = 0
    n = len(s)
    while i < n:
        j = i
        while j < n and s[j] == s[i]:
            j += 1
        seg = slice(i, j)
        inrange = (m[seg] >= rth_open) & (m[seg] < rth_open + minutes)
        if inrange.any():
            hi = h[seg][inrange].max()
            lo = l[seg][inrange].min()
            after = m[seg] >= rth_open + minutes
            orh[seg][after] = hi          # only visible once the OR has closed
            orl[seg][after] = lo
        i = j
    return orh, orl


# ===========================================================================
# Simulation kernels
# ===========================================================================
@njit(cache=True)
def simulate_fixed(entry_idx, direction, entry_px, stop_px, tp_px,
                   high, low, close, max_hold, session, exit_on_session_end):
    """Bracket-order simulation, one trade per entry.

    Returns (outcome, exit_bar, exit_px) where outcome is
    +1 target, -1 stop, 0 timeout/session-close exit.

    Pessimistic by construction: if a single bar spans both the stop and the
    target, the stop is booked. OHLC bars hide the intrabar path, so every
    ambiguity resolves against the strategy.
    """
    n = entry_idx.shape[0]
    nb = high.shape[0]
    outcome = np.zeros(n, dtype=np.int8)
    exit_bar = np.zeros(n, dtype=np.int64)
    exit_px = np.zeros(n, dtype=np.float64)
    for k in range(n):
        i0 = entry_idx[k]
        d = direction[k]
        sp = stop_px[k]
        tp = tp_px[k]
        res = 0
        eb = i0
        ex = entry_px[k]
        end = i0 + max_hold
        if end >= nb:
            end = nb - 1
        for i in range(i0 + 1, end + 1):
            if exit_on_session_end and session[i] != session[i0]:
                res = 0
                eb = i - 1
                ex = close[i - 1]
                break
            if d > 0:
                if low[i] <= sp:          # stop first when both are touched
                    res = -1
                    eb = i
                    ex = sp
                    break
                if high[i] >= tp:
                    res = 1
                    eb = i
                    ex = tp
                    break
            else:
                if high[i] >= sp:
                    res = -1
                    eb = i
                    ex = sp
                    break
                if low[i] <= tp:
                    res = 1
                    eb = i
                    ex = tp
                    break
            eb = i
            ex = close[i]
        outcome[k] = res
        exit_bar[k] = eb
        exit_px[k] = ex
    return outcome, exit_bar, exit_px


@njit(cache=True)
def simulate_managed(entry_idx, direction, entry_px, stop_px, tp_px,
                     high, low, close, max_hold, session, exit_on_session_end,
                     be_trigger_r, trail_atr_mult, atr_at_entry):
    """Simulation with breakeven-at-R and/or ATR trailing stop.

    `be_trigger_r <= 0` disables breakeven; `trail_atr_mult <= 0` disables the
    trail. Stop movement is evaluated on bar closes (a stop cannot be moved on
    information from inside the bar that has not printed yet), while stop and
    target *hits* are evaluated on the bar's high/low.
    """
    n = entry_idx.shape[0]
    nb = high.shape[0]
    outcome = np.zeros(n, dtype=np.int8)
    exit_bar = np.zeros(n, dtype=np.int64)
    exit_px = np.zeros(n, dtype=np.float64)
    for k in range(n):
        i0 = entry_idx[k]
        d = direction[k]
        ep = entry_px[k]
        sp = stop_px[k]
        tp = tp_px[k]
        risk = abs(ep - sp)
        if risk <= 0:
            outcome[k] = 0
            exit_bar[k] = i0
            exit_px[k] = ep
            continue
        a = atr_at_entry[k]
        res = 0
        eb = i0
        ex = ep
        end = i0 + max_hold
        if end >= nb:
            end = nb - 1
        for i in range(i0 + 1, end + 1):
            if exit_on_session_end and session[i] != session[i0]:
                res = 0
                eb = i - 1
                ex = close[i - 1]
                break
            if d > 0:
                if low[i] <= sp:
                    res = -1 if sp < ep else 0    # scratched at/above entry
                    eb = i
                    ex = sp
                    break
                if high[i] >= tp:
                    res = 1
                    eb = i
                    ex = tp
                    break
                if be_trigger_r > 0.0 and close[i] >= ep + be_trigger_r * risk:
                    if sp < ep:
                        sp = ep
                if trail_atr_mult > 0.0:
                    cand = close[i] - trail_atr_mult * a
                    if cand > sp:
                        sp = cand
            else:
                if high[i] >= sp:
                    res = -1 if sp > ep else 0
                    eb = i
                    ex = sp
                    break
                if low[i] <= tp:
                    res = 1
                    eb = i
                    ex = tp
                    break
                if be_trigger_r > 0.0 and close[i] <= ep - be_trigger_r * risk:
                    if sp > ep:
                        sp = ep
                if trail_atr_mult > 0.0:
                    cand = close[i] + trail_atr_mult * a
                    if cand < sp:
                        sp = cand
            eb = i
            ex = close[i]
        outcome[k] = res
        exit_bar[k] = eb
        exit_px[k] = ex
    return outcome, exit_bar, exit_px


# ===========================================================================
# Bitset machinery
# ===========================================================================
@njit(cache=True)
def pack_bits(mask):
    """Pack a boolean array into uint64 words."""
    n = mask.shape[0]
    nw = (n + 63) // 64
    out = np.zeros(nw, dtype=np.uint64)
    for i in range(n):
        if mask[i]:
            out[i >> 6] |= np.uint64(1) << np.uint64(i & 63)
    return out


@njit(cache=True, inline="always")
def _popcnt(x):
    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
    x = (x & np.uint64(0x3333333333333333)) + \
        ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
    return int((x * np.uint64(0x0101010101010101)) >> np.uint64(56))


@njit(cache=True)
def popcount_and2(a, b):
    s = 0
    for i in range(a.shape[0]):
        s += _popcnt(a[i] & b[i])
    return s


@njit(cache=True)
def popcount_and3(a, b, c):
    s = 0
    for i in range(a.shape[0]):
        s += _popcnt(a[i] & b[i] & c[i])
    return s


# ===========================================================================
# Metrics
# ===========================================================================
def trade_stats(r):
    """Aggregate R-multiple statistics for a trade series."""
    r = np.asarray(r, dtype=np.float64)
    n = len(r)
    if n == 0:
        return dict(n=0, wr=0.0, pf=0.0, net=0.0, exp=0.0, maxdd=0.0, sharpe=0.0)
    wins = r[r > 0]
    losses = r[r < 0]
    gp = wins.sum()
    gl = -losses.sum()
    eq = np.cumsum(r)
    dd = np.maximum.accumulate(eq) - eq
    sd = r.std(ddof=1) if n > 1 else 0.0
    return dict(
        n=n,
        sd=float(sd),
        wr=100.0 * len(wins) / n,
        pf=(gp / gl) if gl > 0 else (np.inf if gp > 0 else 0.0),
        net=eq[-1],
        exp=r.mean(),
        maxdd=dd.max() if n else 0.0,
        sharpe=(r.mean() / sd * np.sqrt(len(r))) if sd > 0 else 0.0,
    )
