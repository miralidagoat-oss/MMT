#!/usr/bin/env python3
"""Refetch the days the first pass lost, and keep going until coverage stops
improving. The first pass treated an empty body or any exhausted retry as
"this day has no data", which is indistinguishable from a throttled request —
that is how 11.5 years of history came back with 1,226 trading days in it.
Here a missing day is retried with backoff, and only a real 404 is accepted
as absence.
"""
import concurrent.futures as cf
import datetime as dt
import lzma
import os
import struct
import sys
import time

import numpy as np
import requests

SYM = "USATECHIDXUSD"
BASE = "https://datafeed.dukascopy.com/datafeed"
POINT = 1000.0
REC = struct.Struct(">Iiiiif")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ndx_1m.npz")


def fetch_day(d, session, retries=6):
    url = f"{BASE}/{SYM}/{d.year}/{d.month - 1:02d}/{d.day:02d}/BID_candles_min_1.bi5"
    for a in range(retries):
        try:
            r = session.get(url, timeout=60)
            if r.status_code == 404:
                return np.empty((0, 6)), True          # genuinely absent
            if r.status_code != 200:
                raise IOError(f"http {r.status_code}")
            if not r.content:
                return np.empty((0, 6)), True          # empty file = holiday
            raw = lzma.LZMADecompressor().decompress(r.content)
            n = len(raw) // REC.size
            base = int(dt.datetime(d.year, d.month, d.day,
                                   tzinfo=dt.timezone.utc).timestamp())
            out = np.empty((n, 6))
            for i in range(n):
                sec, o, c, l, h, v = REC.unpack_from(raw, i * REC.size)
                out[i] = (base + sec, o / POINT, h / POINT, l / POINT, c / POINT, v)
            return out, True
        except Exception:
            if a == retries - 1:
                return np.empty((0, 6)), False         # unresolved
            time.sleep(min(1.5 ** a, 12) + 0.3 * a)
    return np.empty((0, 6)), False


def covered_days(arr):
    """UTC dates that already carry a plausible full session."""
    if len(arr) == 0:
        return set()
    days = (arr[:, 0] // 86400).astype(np.int64)
    u, cnt = np.unique(days, return_counts=True)
    return set(u[cnt > 200].tolist())


def main(passes=4, workers=8):
    arr = np.load(OUT)["bars"] if os.path.exists(OUT) else np.empty((0, 6))
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 (mmt-research)"

    start = dt.date(2015, 1, 1)
    end = dt.date.today() - dt.timedelta(days=1)
    wanted = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            wanted.append(d)
        d += dt.timedelta(days=1)

    dead = set()
    for p in range(passes):
        have = covered_days(arr)
        todo = [d for d in wanted
                if int(dt.datetime(d.year, d.month, d.day,
                                   tzinfo=dt.timezone.utc).timestamp()) // 86400 not in have
                and d not in dead]
        print(f"pass {p+1}: have {len(have)} days, refetching {len(todo)}", flush=True)
        if not todo:
            break
        got = []
        n_404 = 0
        with cf.ThreadPoolExecutor(workers) as ex:
            futs = {ex.submit(fetch_day, day, session): day for day in todo}
            for i, f in enumerate(cf.as_completed(futs)):
                chunk, resolved = f.result()
                if len(chunk):
                    got.append(chunk)
                elif resolved:
                    dead.add(futs[f])
                    n_404 += 1
                if (i + 1) % 200 == 0:
                    print(f"   {i+1}/{len(todo)}  (+{len(got)} days)", flush=True)
        print(f"  recovered {len(got)} days, {n_404} confirmed absent", flush=True)
        if got:
            arr = np.vstack([arr] + got)
            arr = arr[np.argsort(arr[:, 0], kind="stable")]
            _, keep = np.unique(arr[:, 0], return_index=True)
            arr = arr[np.sort(keep)]
            live = ~((arr[:, 1] == arr[:, 4]) & (arr[:, 2] == arr[:, 3]) & (arr[:, 5] <= 0))
            arr = arr[live]
            np.savez_compressed(OUT, bars=arr)
            print(f"  saved {len(arr):,} bars", flush=True)
        if not got:
            break
    print(f"DONE {len(arr):,} bars, {len(covered_days(arr))} covered days")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 4)
