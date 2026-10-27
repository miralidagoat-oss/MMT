#!/usr/bin/env python3
"""Premium & Discount Zones — reference of indicators/premium_discount_zones.pine.

Mirrors the indicator's dealing range and its reading, so the logic can be
checked off TradingView:

  dealing range  Swing:    most recent confirmed swing high / swing low
                           (pivots `length` bars each side), each side
                           trailing to any new extreme
                 Lookback: highest high / lowest low of the last N bars
  in range       (close - bottom) / (top - bottom), 0 = low, 1 = high
  depth          |in range - 0.5| / 0.5, 0 = equilibrium, 1 = the extreme
  zone           premium above 50% + band, discount below 50% - band

Usage:
  python3 premium_discount.py <csv> [<csv> ...]   # readings + invariant checks
  CSV columns: time (unix seconds, UTC), open, high, low, close[, volume]
"""
import csv
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def pivot(values, i, length, is_high):
    """Pivot confirmed at bar i for bar i - length (strictly beyond every
    other bar within `length` bars on both sides), else None."""
    c = i - length
    if c - length < 0:
        return None
    v = values[c]
    window = values[c - length:c] + values[c + 1:i + 1]
    if is_high:
        return v if all(v > x for x in window) else None
    return v if all(v < x for x in window) else None


def dealing_range(bars, length=10, mode="Swing", lookback=100):
    """Yield (top, bottom, top_time, bottom_time) for every bar, exactly as
    the Pine function updates them."""
    times = [b[0] for b in bars]
    highs = [b[2] for b in bars]
    lows = [b[3] for b in bars]
    top = bot = top_t = bot_t = None
    for i in range(len(bars)):
        if mode == "Swing":
            ph = pivot(highs, i, length, True)
            pl = pivot(lows, i, length, False)
            if ph is not None:
                top, top_t = ph, times[i - length]
            if pl is not None:
                bot, bot_t = pl, times[i - length]
            if top is None or highs[i] > top:
                top, top_t = highs[i], times[i]
            if bot is None or lows[i] < bot:
                bot, bot_t = lows[i], times[i]
        else:
            if i >= lookback - 1:
                top = max(highs[i - lookback + 1:i + 1])
                bot = min(lows[i - lookback + 1:i + 1])
                top_t = bot_t = times[i - lookback + 1]
        yield top, bot, top_t, bot_t


def reading(top, bot, close, eq_band=0.025):
    """(zone, depth, in_range) for a price inside [bot, top]."""
    if top is None or bot is None or top <= bot:
        return None
    p = (close - bot) / (top - bot)
    zone = "Premium" if p > 0.5 + eq_band else "Discount" if p < 0.5 - eq_band else "Equilibrium"
    return zone, abs(p - 0.5) / 0.5, p


def load(path):
    out = []
    with open(path) as f:
        for row in csv.DictReader(f):
            out.append((int(float(row["time"])), float(row["open"]), float(row["high"]),
                        float(row["low"]), float(row["close"])))
    return out


def resample(bars, key):
    """Aggregate bars by key(time) into (time, open, high, low, close)."""
    out = []
    for t, o, h, l, c in bars:
        k = key(t)
        if out and out[-1][0] == k:
            _, t0, o0, h0, l0, _ = out[-1]
            out[-1] = (k, t0, o0, max(h0, h), min(l0, l), c)
        else:
            out.append((k, t, o, h, l, c))
    return [(t0, o, h, l, c) for _, t0, o, h, l, c in out]


def check_inside(bars, **kw):
    """Every bar's close must sit inside its dealing range (Swing mode)."""
    bad = 0
    for (t, o, h, l, c), (top, bot, _, _) in zip(bars, dealing_range(bars, **kw)):
        if top is None or not (bot <= l <= c <= h <= top):
            bad += 1
    return bad


def main(paths):
    ny = ZoneInfo("America/New_York")
    for path in paths:
        bars = load(path)
        frames = {"as loaded": bars}
        span = bars[1][0] - bars[0][0] if len(bars) > 1 else 0
        if span < 3600:
            frames["15m"] = resample(bars, lambda t: t - t % 900)
            frames["1H"] = resample(bars, lambda t: t - t % 3600)
            frames["4H"] = resample(bars, lambda t: t - t % 14400)
        if span >= 86400 - 3600:
            frames["W"] = resample(bars, lambda t: datetime.fromtimestamp(t, tz=timezone.utc).astimezone(ny).isocalendar()[:2])
            frames["M"] = resample(bars, lambda t: (lambda d: (d.year, d.month))(datetime.fromtimestamp(t, tz=timezone.utc).astimezone(ny)))
        last = bars[-1]
        print(f"── {path.split('/')[-1]}  last bar {datetime.fromtimestamp(last[0], tz=timezone.utc).astimezone(ny):%Y-%m-%d %H:%M} ET  close {last[4]}")
        for name, fb in frames.items():
            bad = check_inside(fb)
            top, bot, _, _ = list(dealing_range(fb))[-1]
            zone, depth, p = reading(top, bot, last[4])
            print(f"   {name:9} bars {len(fb):6}  range {bot} – {top}  {zone:11} depth {100 * depth:5.1f}%  in range {100 * p:5.1f}%"
                  f"  | closes outside range: {bad}")


if __name__ == "__main__":
    main(sys.argv[1:])
