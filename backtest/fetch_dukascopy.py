#!/usr/bin/env python3
"""Download Dukascopy tick data for the Nasdaq-100 index CFD and build 5m bars.

Dukascopy serves one LZMA-compressed file per instrument-hour:

    https://datafeed.dukascopy.com/datafeed/{INST}/{YYYY}/{MM0}/{DD}/{HH}h_ticks.bi5

`MM0` is **zero-indexed** (January = 00). Each decompressed tick is 20 bytes,
big-endian: uint32 millisecond offset within the hour, uint32 ask, uint32 bid,
float32 ask volume, float32 bid volume. Ask/bid are integers scaled by
`POINT_SCALE` (1000 for USATECHIDXUSD, i.e. three decimals).

A 404 or zero-length body means "no ticks that hour" (weekend, holiday, or the
daily CFD break) and is cached as an empty file so reruns skip it. The download
and build phases are separate: bodies land in `<cache>/raw/`, and bars can be
rebuilt from a partial cache at any time (`--build-only`).

Why this instrument: MNQ 5-minute history is capped at 60 days by every free
futures feed, which is one volatility regime and far too little to search a
large strategy space against. USATECHIDXUSD is the Nasdaq-100 cash index CFD,
quoted ~24/5 and tracking NQ/MNQ closely, with years of history available. It
is the research set; true MNQ=F 5m stays a held-out validation set.

Caveat carried downstream: this is a *cash index* CFD. It has no futures roll,
no settlement gaps, and its "volume" is a tick count rather than contracts.
Levels are index points, which MNQ tracks at roughly a fixed basis.

Usage:
    python3 fetch_dukascopy.py <cache_dir> <out_csv> [start] [end] [--build-only]
"""
import concurrent.futures as cf
import csv
import datetime as dt
import lzma
import os
import struct
import sys
import threading
import time

import requests
from requests.adapters import HTTPAdapter

INST = "USATECHIDXUSD"
POINT_SCALE = 1000.0
BASE = "https://datafeed.dukascopy.com/datafeed"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    ),
    "Accept": "*/*",
}
# Dukascopy rate-limits hard: throughput peaks near 32-48 concurrent requests
# and collapses (>50% errors) by 96. Keep concurrency modest and retry.
WORKERS = 32
TRIES = 6

_local = threading.local()


def session():
    """One pooled session per worker thread - the proxy CONNECT tunnel is the
    dominant cost, so reusing connections is a ~7x speedup over urllib."""
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update(HEADERS)
        ad = HTTPAdapter(pool_connections=4, pool_maxsize=4, max_retries=0)
        s.mount("https://", ad)
        _local.s = s
    return s


def hour_url(when):
    return (f"{BASE}/{INST}/{when.year}/{when.month - 1:02d}/{when.day:02d}/"
            f"{when.hour:02d}h_ticks.bi5")


def cache_path(cache_dir, when):
    return os.path.join(cache_dir, "raw", f"{when:%Y%m}", f"{when:%Y%m%d_%H}.bi5")


def fetch_hour(cache_dir, when):
    """Download one hour into the cache. Returns True if the cache now holds it."""
    path = cache_path(cache_dir, when)
    if os.path.exists(path):
        return True
    for attempt in range(TRIES):
        try:
            r = session().get(hour_url(when), timeout=45)
            if r.status_code == 404:   # no ticks this hour - cache empty marker
                body = b""
            elif r.status_code == 200:
                body = r.content
            else:
                raise OSError(f"HTTP {r.status_code}")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, path)      # atomic: a partial file never looks cached
            return True
        except Exception:              # noqa: BLE001 - transport/rate-limit, retry
            if attempt == TRIES - 1:
                return False
            time.sleep(0.7 * (attempt + 1))
    return False


def decode(body, when):
    """Yield (epoch_seconds, mid_price) for one hour of ticks."""
    if not body:
        return []
    try:
        raw = lzma.decompress(body)
    except lzma.LZMAError:
        return []
    base = int(when.replace(tzinfo=dt.timezone.utc).timestamp())
    out = []
    for i in range(0, len(raw) - 19, 20):
        ms, ask, bid, _av, _bv = struct.unpack(">IIIff", raw[i:i + 20])
        if ask <= 0 or bid <= 0:
            continue
        out.append((base + ms / 1000.0, (ask + bid) / 2.0 / POINT_SCALE))
    return out


def candidate_hours(start, end):
    hours = []
    cur = start
    while cur < end:
        # CFD is shut all Saturday and until the Sunday 21:00 UTC reopen.
        if not (cur.weekday() == 5 or (cur.weekday() == 6 and cur.hour < 21)):
            hours.append(cur)
        cur += dt.timedelta(hours=1)
    return hours


def download(cache_dir, hours):
    done = failed = 0
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_hour, cache_dir, h) for h in hours]
        for fut in cf.as_completed(futs):
            if not fut.result():
                failed += 1
            done += 1
            if done % 2000 == 0:
                el = time.time() - t0
                eta = (len(hours) - done) / max(done / el, 1e-9)
                print(f"  {done}/{len(hours)}  {done / el:.1f} h/s  "
                      f"failed={failed}  eta={eta / 60:.0f}m", flush=True)
    print(f"download done: {done} hours, {failed} unrecoverable", flush=True)


def build(cache_dir, hours, out_csv, minutes=5):
    step = minutes * 60
    bars = {}
    missing = 0
    for h in hours:
        path = cache_path(cache_dir, h)
        if not os.path.exists(path):
            missing += 1
            continue
        with open(path, "rb") as f:
            body = f.read()
        for ts, px in decode(body, h):
            b = int(ts // step) * step
            e = bars.get(b)
            if e is None:
                bars[b] = [px, px, px, px, 1]
            else:
                if px > e[1]:
                    e[1] = px
                if px < e[2]:
                    e[2] = px
                e[3] = px
                e[4] += 1
    rows = [(b, v[0], v[1], v[2], v[3], v[4]) for b, v in sorted(bars.items())]
    os.makedirs(os.path.dirname(out_csv) or ".", exist_ok=True)
    with open(out_csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        w.writerows(rows)
    print(f"wrote {len(rows):,} {minutes}m bars -> {out_csv} "
          f"({missing} hours absent from cache)", flush=True)
    if rows:
        a = dt.datetime.utcfromtimestamp(rows[0][0])
        b = dt.datetime.utcfromtimestamp(rows[-1][0])
        print(f"span {a:%Y-%m-%d} -> {b:%Y-%m-%d}", flush=True)


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    cache = args[0] if len(args) > 0 else "duka_cache"
    out = args[1] if len(args) > 1 else "data/NDX_5m.csv"
    start = (dt.datetime.strptime(args[2], "%Y-%m-%d")
             if len(args) > 2 else dt.datetime(2022, 1, 1))
    end = (dt.datetime.strptime(args[3], "%Y-%m-%d")
           if len(args) > 3 else dt.datetime.utcnow())
    hours = candidate_hours(start, end)
    print(f"{INST}: {len(hours)} candidate hours "
          f"{start:%Y-%m-%d} -> {end:%Y-%m-%d}", flush=True)
    if "--build-only" not in flags:
        download(cache, hours)
    build(cache, hours, out)


if __name__ == "__main__":
    main(sys.argv[1:])
