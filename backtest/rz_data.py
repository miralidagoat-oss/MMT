#!/usr/bin/env python3
"""Real market data for the reversal-zone study. No synthetic prices anywhere.

Two public sources are used:

  * Yahoo Finance chart API  - the actual CME contract (MNQ=F / NQ=F / ES=F).
      Intraday history is short: ~30 days of 1m, ~60 days of 5m, ~730 days
      of 1h, full daily history.
  * Dukascopy historical feed - USATECH.IDX/USD, a Nasdaq-100 CFD quoted from
      the futures. Years of 1-minute bars. Its 1-minute returns correlate
      0.99 with MNQ=F over the overlap (see rz_research.py `proxy`), so point
      moves are the same; only the absolute price differs by the futures
      basis. It does not trade 16:15-18:00 ET.

Usage:
  python3 rz_data.py yahoo <out_dir>
  python3 rz_data.py duka  <out_dir> <instrument> <start> <end> [threads]
     e.g. python3 rz_data.py duka data/duka USATECHIDXUSD 2021-01-01 2026-11-09
"""
import csv
import datetime as dt
import glob
import lzma
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (mmt-backtest)"}


# ── Yahoo ────────────────────────────────────────────────────────────────────

def _yahoo_chart(sess, symbol, params):
    last = None
    for attempt in range(6):
        host = ("query1", "query2")[attempt % 2]
        try:
            r = sess.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{symbol}",
                         params=params, timeout=40)
            if r.status_code == 200:
                res = r.json()["chart"]["result"][0]
                ts = res.get("timestamp") or []
                q = res["indicators"]["quote"][0]
                rows = []
                for i, t in enumerate(ts):
                    o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
                    if None in (o, h, l, c):
                        continue
                    rows.append((int(t), float(o), float(h), float(l), float(c), float(q["volume"][i] or 0)))
                return rows
            last = f"{r.status_code} {r.text[:120]}"
        except Exception as e:  # noqa: BLE001 - retry any transport error
            last = repr(e)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{symbol} {params}: {last}")


def _save(path, rows):
    rows = sorted({r[0]: r for r in rows}.values())
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        w.writerows(rows)
    return len(rows)


def fetch_yahoo(out_dir, symbols=("MNQ=F", "NQ=F", "ES=F")):
    os.makedirs(out_dir, exist_ok=True)
    sess = requests.Session()
    sess.headers.update(UA)
    now = int(time.time())
    for sym in symbols:
        tag = sym.replace("=F", "")
        rows, end = [], now
        while now - end < 29 * 86400:           # 1m: last ~30 days, <= 7 days per request
            start = max(end - 7 * 86400, now - int(29.5 * 86400))
            rows += _yahoo_chart(sess, sym, {"interval": "1m", "period1": start, "period2": end})
            end = start
            time.sleep(0.5)
        print(tag, "1m", _save(os.path.join(out_dir, f"{tag}_1m.csv"), rows))
        for interval, rng, name in (("5m", "60d", "5m"), ("60m", "730d", "1h")):
            print(tag, name, _save(os.path.join(out_dir, f"{tag}_{name}.csv"),
                                   _yahoo_chart(sess, sym, {"interval": interval, "range": rng})))
            time.sleep(0.5)
        print(tag, "1d", _save(os.path.join(out_dir, f"{tag}_1d.csv"),
                               _yahoo_chart(sess, sym, {"interval": "1d", "period1": now - 27 * 365 * 86400,
                                                        "period2": now})))


def load_csv(path):
    df = pd.read_csv(path)
    df["ts"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.drop_duplicates("ts").sort_values("ts").set_index("ts")
    return df[["open", "high", "low", "close", "volume"]]


def clean_yahoo(df, k=12.0):
    """Yahoo occasionally emits a bar with a stale open/extreme right after a
    feed gap (e.g. 2026-10-30 15:03 ET: a 1,268-point one-minute 'range' that
    no other source shows). An extreme sitting more than k x the local median
    bar range beyond both neighbours and the bar's own close is clipped.
    Returns (clean_df, number_of_repaired_extremes)."""
    d = df.copy()
    o, h, l, c = (d[x].values.copy() for x in ("open", "high", "low", "close"))
    rng = pd.Series(h - l).rolling(120, min_periods=20).median().bfill().values
    fixed = 0
    for i in range(1, len(d) - 1):
        tol = k * max(rng[i], 1.0)
        nb_hi = max(h[i - 1], h[i + 1])
        nb_lo = min(l[i - 1], l[i + 1])
        if h[i] > max(nb_hi, c[i]) + tol:
            if o[i] > max(nb_hi, c[i]) + tol:
                o[i] = c[i - 1] if abs(c[i - 1] - c[i]) < tol else c[i]
            h[i] = max(o[i], c[i], min(h[i], nb_hi))
            fixed += 1
        if l[i] < min(nb_lo, c[i]) - tol:
            if o[i] < min(nb_lo, c[i]) - tol:
                o[i] = c[i - 1] if abs(c[i - 1] - c[i]) < tol else c[i]
            l[i] = min(o[i], c[i], max(l[i], nb_lo))
            fixed += 1
    h = np.maximum(h, np.maximum(o, c))
    l = np.minimum(l, np.minimum(o, c))
    d["open"], d["high"], d["low"], d["close"] = o, h, l, c
    return d, fixed


def load_daily(path):
    """Daily bars -> frame indexed by trade date with columns h, l (for ADR)."""
    df = pd.read_csv(path)
    idx = pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert("America/New_York").dt.normalize().dt.tz_localize(None)
    return pd.DataFrame({"h": df["high"].values, "l": df["low"].values}, index=idx).groupby(level=0).last()


# ── Dukascopy ────────────────────────────────────────────────────────────────

_DUKA = "https://datafeed.dukascopy.com/datafeed"
_local = threading.local()


def _sess(reset=False):
    if reset or not hasattr(_local, "s"):
        _local.s = requests.Session()
        _local.s.headers.update(UA)
    return _local.s


def _duka_day(args):
    out_dir, inst, day = args
    path = os.path.join(out_dir, day.strftime("%Y%m%d") + ".bi5")
    if os.path.exists(path):
        return "skip"
    url = f"{_DUKA}/{inst}/{day.year}/{day.month - 1:02d}/{day.day:02d}/BID_candles_min_1.bi5"
    for attempt in range(12):       # the feed is slow and intermittently answers 503
        try:
            r = _sess().get(url, timeout=60)
            if r.status_code == 200:
                with open(path + ".part", "wb") as f:
                    f.write(r.content)
                os.replace(path + ".part", path)
                return "ok"
            if r.status_code == 404:
                open(path, "wb").close()
                return "404"
        except Exception:  # noqa: BLE001
            _sess(reset=True)
        time.sleep(min(20.0, 2.0 * (attempt + 1)))
    return "fail"


def fetch_duka(out_dir, inst, start, end, threads=6, sundays=False):
    os.makedirs(out_dir, exist_ok=True)
    d0, d1 = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    days, d = [], d1
    while d >= d0:                  # newest first
        if d.weekday() < 5 or (d.weekday() == 6 and sundays):
            days.append(d)
        d -= dt.timedelta(days=1)
    counts = {}
    with ThreadPoolExecutor(threads) as ex:
        for k, res in enumerate(ex.map(_duka_day, [(out_dir, inst, x) for x in days]), 1):
            counts[res] = counts.get(res, 0) + 1
            if k % 50 == 0:
                print(f"{k}/{len(days)} {counts}", flush=True)
    print("done", counts)


def load_duka(raw_dir, start=None, end=None):
    """Decode day files -> 1-minute DataFrame (UTC index). Record layout,
    big-endian: uint32 seconds-from-midnight, open, close, low, high
    (uint32, price x 1000), float32 volume. Flat zero-volume candles (market
    closed) are dropped."""
    rec = np.dtype([("t", ">u4"), ("o", ">u4"), ("c", ">u4"), ("l", ">u4"), ("h", ">u4"), ("v", ">f4")])
    frames = []
    for f in sorted(glob.glob(os.path.join(raw_dir, "*.bi5"))):
        day = os.path.basename(f)[:8]
        if (start and day < start) or (end and day > end):
            continue
        raw = open(f, "rb").read()
        if not raw:
            continue
        try:
            data = lzma.decompress(raw)
        except lzma.LZMAError:
            continue
        if len(data) % 24:
            continue
        a = np.frombuffer(data, dtype=rec)
        base = pd.Timestamp(day, tz="UTC").value // 10 ** 9
        d = pd.DataFrame({"time": base + a["t"].astype(np.int64), "open": a["o"] / 1000.0,
                          "high": a["h"] / 1000.0, "low": a["l"] / 1000.0, "close": a["c"] / 1000.0,
                          "volume": a["v"].astype(float)})
        frames.append(d[~((d["volume"] == 0) & (d["high"] == d["low"]))])
    df = pd.concat(frames, ignore_index=True)
    df["ts"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.drop_duplicates("ts").sort_values("ts").set_index("ts")
    return df[["open", "high", "low", "close", "volume"]]


def resample(df, minutes):
    """Aggregate 1-minute bars to an N-minute chart (bars labelled by open time)."""
    r = df.resample(f"{minutes}min", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
    return r.dropna(subset=["open"])


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "yahoo":
        fetch_yahoo(sys.argv[2])
    elif len(sys.argv) >= 6 and sys.argv[1] == "duka":
        fetch_duka(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                   int(sys.argv[6]) if len(sys.argv) > 6 else 6)
    else:
        print(__doc__)
