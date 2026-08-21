#!/usr/bin/env python3
"""Generic Dukascopy 1-minute downloader with completeness repair.

Same lesson as ndx: a throttled request and a genuinely empty day look
identical over HTTP, so a single pass silently loses days. This retries until
coverage stops improving and treats only a real 404 as absence.
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

BASE = "https://datafeed.dukascopy.com/datafeed"
REC = struct.Struct(">Iiiiif")
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# symbol -> (price divisor, plausible price range for a sanity check)
SYMBOLS = {
    "USA500IDXUSD":  (1000.0, (1500, 9000)),      # S&P 500
    "USATECHIDXUSD": (1000.0, (3000, 40000)),     # Nasdaq 100
    "USA30IDXUSD":   (1000.0, (14000, 60000)),    # Dow
    "VOLIDXUSD":     (1000.0, (8, 90)),           # VIX
    "USTBONDTRUSD":  (1000.0, (100, 200)),        # T-Bond
    "XAUUSD":        (1000.0, (900, 6000)),       # Gold
    "EURUSD":        (100000.0, (0.9, 1.6)),      # EUR/USD
}


def fetch_day(sym, point, d, session, retries=6):
    url = f"{BASE}/{sym}/{d.year}/{d.month - 1:02d}/{d.day:02d}/BID_candles_min_1.bi5"
    for a in range(retries):
        try:
            r = session.get(url, timeout=60)
            if r.status_code == 404:
                return np.empty((0, 6)), True
            if r.status_code != 200:
                raise IOError(str(r.status_code))
            if not r.content:
                return np.empty((0, 6)), True
            raw = lzma.LZMADecompressor().decompress(r.content)
            n = len(raw) // REC.size
            base = int(dt.datetime(d.year, d.month, d.day,
                                   tzinfo=dt.timezone.utc).timestamp())
            out = np.empty((n, 6))
            for i in range(n):
                sec, o, c, l, h, v = REC.unpack_from(raw, i * REC.size)
                out[i] = (base + sec, o / point, h / point, l / point, c / point, v)
            return out, True
        except Exception:
            if a == retries - 1:
                return np.empty((0, 6)), False
            time.sleep(min(1.5 ** a, 12) + 0.3 * a)
    return np.empty((0, 6)), False


def covered(arr):
    if len(arr) == 0:
        return set()
    u, c = np.unique((arr[:, 0] // 86400).astype(np.int64), return_counts=True)
    return set(u[c > 200].tolist())


def get(sym, start_year=2015, passes=5, workers=12):
    point, (plo, phi) = SYMBOLS[sym]
    out = os.path.join(DATA, f"{sym}_1m.npz")
    arr = np.load(out)["bars"] if os.path.exists(out) else np.empty((0, 6))
    ses = requests.Session()
    ses.headers["User-Agent"] = "Mozilla/5.0 (mmt-research)"

    wanted, d = [], dt.date(start_year, 1, 1)
    end = dt.date.today() - dt.timedelta(days=1)
    while d <= end:
        if d.weekday() < 5:
            wanted.append(d)
        d += dt.timedelta(days=1)

    dead = set()
    for p in range(passes):
        have = covered(arr)
        todo = [x for x in wanted if x not in dead and
                int(dt.datetime(x.year, x.month, x.day,
                                tzinfo=dt.timezone.utc).timestamp()) // 86400 not in have]
        print(f"[{sym}] pass {p+1}: have {len(have)}, todo {len(todo)}", flush=True)
        if not todo:
            break
        got = []
        with cf.ThreadPoolExecutor(workers) as ex:
            futs = {ex.submit(fetch_day, sym, point, x, ses): x for x in todo}
            for i, f in enumerate(cf.as_completed(futs)):
                ch, resolved = f.result()
                if len(ch):
                    got.append(ch)
                elif resolved:
                    dead.add(futs[f])
                if (i + 1) % 500 == 0:
                    print(f"  [{sym}] {i+1}/{len(todo)}", flush=True)
        if not got:
            break
        arr = np.vstack([arr] + got)
        arr = arr[np.argsort(arr[:, 0], kind="stable")]
        _, k = np.unique(arr[:, 0], return_index=True)
        arr = arr[np.sort(k)]
        live = ~((arr[:, 1] == arr[:, 4]) & (arr[:, 2] == arr[:, 3]) & (arr[:, 5] <= 0))
        arr = arr[live]
        os.makedirs(DATA, exist_ok=True)
        np.savez_compressed(out, bars=arr)

    med = float(np.median(arr[:, 4])) if len(arr) else 0.0
    ok = plo <= med <= phi
    print(f"[{sym}] DONE {len(arr):,} bars, {len(covered(arr))} days, "
          f"median price {med:,.2f} {'OK' if ok else '*** OUT OF EXPECTED RANGE ***'}",
          flush=True)
    return arr


if __name__ == "__main__":
    for s in sys.argv[1:]:
        get(s)
