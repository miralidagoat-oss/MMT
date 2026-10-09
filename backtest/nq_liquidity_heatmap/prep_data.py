#!/usr/bin/env python3
"""Build multi-timeframe OHLCV fixtures from real market data for verifying
indicators/nq_liquidity_heatmap.pine.

Source: the historical data that ships inside the `backtesting` package
(EURUSD 1h, 5000 bars 2017-04..2018-02; GOOG daily 2004..2013). Higher
timeframes are aggregated on a UTC calendar grid with explicit period keys
(4H blocks, days, Monday-start weeks, calendar months): open = first, high =
max, low = min, close = last, volume = sum. EURNV is EURUSD with volume
zeroed, to exercise the indicator's no-volume fallback.

Writes <out_dir>/<SYMBOL>_<TF>.json as kline lists (ms open/close times;
closeTime = end of the period).

Usage: python3 prep_data.py <out_dir>
"""
import json
import os
import sys

import pandas as pd
from backtesting.test import EURUSD, GOOG


def start_of(ts, tf):
    if tf == "240":
        return ts.floor("D") + pd.Timedelta(hours=(ts.hour // 4) * 4)
    if tf == "D":
        return ts.floor("D")
    if tf == "W":
        d = ts.floor("D")
        return d - pd.Timedelta(days=d.weekday())
    if tf == "M":
        return pd.Timestamp(year=ts.year, month=ts.month, day=1)
    raise ValueError(tf)


def end_of(start, tf):
    return {"240": start + pd.Timedelta(hours=4), "D": start + pd.Timedelta(days=1),
            "W": start + pd.Timedelta(days=7), "M": start + pd.offsets.MonthBegin(1)}[tf]


def ms(t):
    return int(pd.Timestamp(t).value // 10**6)


def rows_of(df, dur, zero_volume=False):
    return [dict(openTime=ms(t), open=float(r.Open), high=float(r.High), low=float(r.Low),
                 close=float(r.Close), volume=0.0 if zero_volume else float(r.Volume),
                 closeTime=ms(t + dur))
            for t, r in df.iterrows()]


def agg(df, tf, zero_volume=False):
    g = df.groupby([start_of(t, tf) for t in df.index], sort=True)
    out = pd.DataFrame({"Open": g.Open.first(), "High": g.High.max(), "Low": g.Low.min(),
                        "Close": g.Close.last(), "Volume": g.Volume.sum()})
    return [dict(openTime=ms(t), open=float(r.Open), high=float(r.High), low=float(r.Low),
                 close=float(r.Close), volume=0.0 if zero_volume else float(r.Volume),
                 closeTime=ms(end_of(t, tf)))
            for t, r in out.iterrows()]


def dump(out_dir, name, rows):
    with open(os.path.join(out_dir, name + ".json"), "w") as f:
        json.dump(rows, f)
    print(f"{name}: {len(rows)} bars")


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    e = EURUSD.copy()
    e.index = pd.to_datetime(e.index)
    for sym, zv in (("EURUSD", False), ("EURNV", True)):
        dump(out_dir, f"{sym}_60", rows_of(e, pd.Timedelta(hours=1), zv))
        for tf in ("240", "D", "W", "M"):
            dump(out_dir, f"{sym}_{tf}", agg(e, tf, zv))
    g = GOOG.copy()
    g.index = pd.to_datetime(g.index)
    dump(out_dir, "GOOG_D", rows_of(g, pd.Timedelta(days=1)))
    for tf in ("W", "M"):
        dump(out_dir, f"GOOG_{tf}", agg(g, tf))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data")
