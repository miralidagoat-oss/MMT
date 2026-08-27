#!/usr/bin/env python3
"""Leakage-safe feature layer for MNQ 5m ETH research (Phase 1 §4).

Every feature on bar i is computed from information available at the close of
bar i and no later. The ET-time-of-day normalisation (§4.1) uses only *prior
trading days*, never the current one.
"""
import csv
import statistics as st
from collections import defaultdict

SLOT_MIN = 5  # bar size in minutes


class Bar:
    __slots__ = ("t", "o", "h", "l", "c", "v", "day", "etm", "dow", "f")

    def __init__(self, t, o, h, l, c, v, day, etm, dow):
        self.t, self.o, self.h, self.l, self.c, self.v = t, o, h, l, c, v
        self.day, self.etm, self.dow = day, etm, dow
        self.f = {}  # feature dict

    @property
    def rng(self):
        return self.h - self.l

    @property
    def slot(self):
        return self.etm // SLOT_MIN


def load_bars(path):
    bars = []
    with open(path) as fh:
        for r in csv.DictReader(fh):
            bars.append(Bar(int(r["time"]), float(r["open"]), float(r["high"]),
                            float(r["low"]), float(r["close"]), float(r["volume"]),
                            r["session_day"], int(r["et_minute"]), int(r["dow"])))
    bars.sort(key=lambda b: b.t)
    return bars


def _wilder_atr(bars, n=14):
    """Wilder ATR, causal. bars[i].f['atr'] uses bars 0..i only."""
    atr = None
    prev_close = None
    for i, b in enumerate(bars):
        tr = b.rng if prev_close is None else max(
            b.rng, abs(b.h - prev_close), abs(b.l - prev_close))
        b.f["tr"] = tr
        if i < n:
            atr = tr if atr is None else atr + (tr - atr) / (i + 1)
        else:
            atr = atr + (tr - atr) / n
        b.f["atr"] = atr if i >= n else None
        prev_close = b.c


def _session_vwap(bars):
    """VWAP anchored to the CME trading-day open (18:00 ET), plus its
    volume-weighted sigma. Resets on each new session day."""
    day = None
    pv = vv = pv2 = 0.0
    idx = 0
    for b in bars:
        if b.day != day:
            day, pv, vv, pv2, idx = b.day, 0.0, 0.0, 0.0, 0
        tp = (b.h + b.l + b.c) / 3.0
        vol = max(b.v, 1.0)          # guard the rare zero-volume bar
        pv += tp * vol
        vv += vol
        pv2 += tp * tp * vol
        vwap = pv / vv
        var = max(pv2 / vv - vwap * vwap, 0.0)
        b.f["vwap"] = vwap
        b.f["vwap_sd"] = var ** 0.5
        b.f["bar_in_day"] = idx
        idx += 1


def _tod_normalise(bars, attr, name, days=10, min_days=5):
    """value / median(same ET slot over the previous `days` trading days).

    Strictly trailing: the current day's value is appended only *after* its
    normalised value has been computed, so a bar never sees itself or any
    later bar. This is the §4.1 rule that stops flat thresholds from silently
    converting an ETH strategy into an RTH one.
    """
    hist = defaultdict(list)
    for b in bars:
        val = attr(b)
        prior = hist[b.slot][-days:]
        if len(prior) >= min_days and st.median(prior) > 0:
            b.f[name] = val / st.median(prior)
        else:
            b.f[name] = None
        hist[b.slot].append(val)


def add_features(bars, norm_days=10, min_days=5, atr_n=14):
    _wilder_atr(bars, atr_n)
    _session_vwap(bars)
    _tod_normalise(bars, lambda b: b.v, "rvol", norm_days, min_days)
    _tod_normalise(bars, lambda b: b.rng, "rrange", norm_days, min_days)

    prev = None
    for b in bars:
        atr = b.f["atr"]
        b.f["dev_atr"] = (b.c - b.f["vwap"]) / atr if atr else None
        sd = b.f["vwap_sd"]
        b.f["dev_sig"] = (b.c - b.f["vwap"]) / sd if sd and sd > 0 else None
        b.f["body_frac"] = abs(b.c - b.o) / b.rng if b.rng > 0 else 0.0
        # gap guard input: discontinuity from the previous bar's close
        b.f["gap_atr"] = (abs(b.o - prev.c) / atr
                          if prev is not None and atr else 0.0)
        prev = b
    return bars


def ready(b):
    """True when every feature this research uses is populated."""
    return (b.f.get("atr") is not None and b.f.get("rvol") is not None
            and b.f.get("rrange") is not None and b.f.get("dev_atr") is not None)


def split_by_day(bars, frac):
    """Chronological split on trading-day boundaries (never mid-session)."""
    days = sorted({b.day for b in bars})
    cut = days[int(len(days) * frac)]
    return ([b for b in bars if b.day < cut], [b for b in bars if b.day >= cut])


# ---------------------------------------------------------------------------
# Phase 3 features: liquidity levels, ranges, regime, structure.
# Every level is frozen at the moment it becomes knowable and never before.
# ---------------------------------------------------------------------------

def _ema(bars, n, key):
    a = 2.0 / (n + 1)
    e = None
    for b in bars:
        e = b.c if e is None else e + a * (b.c - e)
        b.f[key] = e


def add_levels(bars, on_end_min=570, or_start_min=570, or_end_min=600):
    """Previous-day H/L, overnight H/L, and opening-range H/L.

    Windows are parameters because bar alignment differs by timeframe: 5m bars
    land on 09:30 so the classic 09:30-10:00 opening range exists, while this
    feed's 1h bars sit on the hour and have no 09:30 boundary at all. Passing
    5m windows to a 1h series silently yields an empty range - which reads as
    "the family lost" when in fact it was never tested.

    - PDH/PDL come from the *completed* prior trading day.
    - Overnight H/L accumulate from the 18:00 ET open and FREEZE at `on_end_min`.
      Before the freeze they are None: a running extreme is not a level, and
      consuming it would be lookahead by another name.
    - Opening range accumulates over [or_start_min, or_end_min) and freezes after.
    """
    day = None
    prev_hi = prev_lo = cur_hi = cur_lo = None
    on_hi = on_lo = or_hi = or_lo = None
    for b in bars:
        if b.day != day:
            prev_hi, prev_lo = cur_hi, cur_lo
            day = b.day
            cur_hi, cur_lo = b.h, b.l
            on_hi, on_lo = b.h, b.l
            or_hi = or_lo = None
        else:
            cur_hi, cur_lo = max(cur_hi, b.h), min(cur_lo, b.l)

        if (b.etm >= 1080) or (b.etm < on_end_min):      # 18:00 ET -> on_end_min
            on_hi, on_lo = max(on_hi, b.h), min(on_lo, b.l)
        b.f["pdh"], b.f["pdl"] = prev_hi, prev_lo
        frozen_on = on_end_min <= b.etm < 1080
        b.f["onh"] = on_hi if frozen_on else None
        b.f["onl"] = on_lo if frozen_on else None

        if or_start_min <= b.etm < or_end_min:
            or_hi = b.h if or_hi is None else max(or_hi, b.h)
            or_lo = b.l if or_lo is None else min(or_lo, b.l)
            b.f["orh"] = b.f["orl"] = None
        elif or_end_min <= b.etm < 1080:
            b.f["orh"], b.f["orl"] = or_hi, or_lo
        else:
            b.f["orh"] = b.f["orl"] = None


def add_regime(bars, fast=14, slow=56, ema_f=20, ema_s=50):
    """ATR compression ratio and EMA trend state, both causal."""
    _ema(bars, ema_f, "ema_f")
    _ema(bars, ema_s, "ema_s")
    trs = [b.f["tr"] for b in bars]
    for i, b in enumerate(bars):
        if i >= slow:
            a_f = sum(trs[i - fast + 1:i + 1]) / fast
            a_s = sum(trs[i - slow + 1:i + 1]) / slow
            b.f["compression"] = a_f / a_s if a_s > 0 else None
        else:
            b.f["compression"] = None
        b.f["trend"] = (1 if b.f["ema_f"] > b.f["ema_s"] else -1)


def swept(b, level, side):
    """Wick pierced `level` but the bar CLOSED back inside.

    Close-based confirmation is what makes this non-repainting: the condition is
    only ever evaluated on a completed bar, and it can never un-happen.
    """
    if level is None:
        return False
    return (b.h > level and b.c < level) if side > 0 else (b.l < level and b.c > level)
