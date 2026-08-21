#!/usr/bin/env python3
"""Download multi-year 1-minute Nasdaq-100 data from the Dukascopy free datafeed.

Why this source: the previous study was capped at 60 days of 5m / 7 days of 1m
by Yahoo, which is why every sub-hourly verdict in the old README rests on
16-75 trades. Dukascopy publishes per-day LZMA-compressed 1-minute candle
files going back ~15 years for USATECHIDXUSD (Nasdaq-100), which is the same
underlying the MNQ/NQ contracts track. That turns "no evidence" into a real
sample.

File layout:  /datafeed/{SYM}/{YYYY}/{MM-1:02d}/{DD:02d}/BID_candles_min_1.bi5
Record (24B, big-endian):  uint32 sec-offset-from-00:00 UTC,
                           int32 open, close, low, high  (price * 1000),
                           float32 volume
"""
import concurrent.futures as cf
import datetime as dt
import lzma
import os
import struct
import sys

import numpy as np
import requests

SYM = "USATECHIDXUSD"
BASE = "https://datafeed.dukascopy.com/datafeed"
POINT = 1000.0
REC = struct.Struct(">Iiiiif")


def day_url(d):
    return f"{BASE}/{SYM}/{d.year}/{d.month - 1:02d}/{d.day:02d}/BID_candles_min_1.bi5"


def fetch_day(d, session, retries=3):
    """Return (N,6) array: epoch_sec, o, h, l, c, vol. Empty on missing day."""
    url = day_url(d)
    for a in range(retries):
        try:
            r = session.get(url, timeout=45)
            if r.status_code == 404 or not r.content:
                return np.empty((0, 6))
            r.raise_for_status()
            raw = lzma.LZMADecompressor().decompress(r.content)
            break
        except Exception:
            if a == retries - 1:
                return np.empty((0, 6))
    n = len(raw) // REC.size
    if n == 0:
        return np.empty((0, 6))
    base = int(dt.datetime(d.year, d.month, d.day,
                           tzinfo=dt.timezone.utc).timestamp())
    out = np.empty((n, 6))
    for i in range(n):
        sec, o, c, l, h, v = REC.unpack_from(raw, i * REC.size)
        out[i] = (base + sec, o / POINT, h / POINT, l / POINT, c / POINT, v)
    return out


def main(start_year=2015, out="research/data/ndx_1m.npz", workers=24):
    start = dt.date(start_year, 1, 1)
    end = dt.date.today() - dt.timedelta(days=1)
    days = []
    d = start
    while d <= end:
        if d.weekday() < 5 or d.weekday() == 6:   # Sun session opens 22:00 UTC
            days.append(d)
        d += dt.timedelta(days=1)
    print(f"fetching {len(days)} days {start}..{end}", flush=True)

    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 (mmt-research)"
    chunks = [None] * len(days)
    done = 0
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(fetch_day, day, session): i for i, day in enumerate(days)}
        for f in cf.as_completed(futs):
            chunks[futs[f]] = f.result()
            done += 1
            if done % 250 == 0:
                print(f"  {done}/{len(days)}", flush=True)

    arr = np.vstack([c for c in chunks if len(c)])
    arr = arr[np.argsort(arr[:, 0], kind="stable")]
    _, keep = np.unique(arr[:, 0], return_index=True)
    arr = arr[np.sort(keep)]
    # drop dead prints (weekend/holiday padding): zero range AND zero volume
    live = ~((arr[:, 1] == arr[:, 4]) & (arr[:, 2] == arr[:, 3]) & (arr[:, 5] <= 0))
    arr = arr[live]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.savez_compressed(out, bars=arr)
    t0 = dt.datetime.fromtimestamp(arr[0, 0], dt.timezone.utc)
    t1 = dt.datetime.fromtimestamp(arr[-1, 0], dt.timezone.utc)
    print(f"saved {len(arr):,} 1m bars  {t0:%Y-%m-%d} .. {t1:%Y-%m-%d} -> {out}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2015)
