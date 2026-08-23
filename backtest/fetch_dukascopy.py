#!/usr/bin/env python3
"""Fetch deep intraday history from Dukascopy's public datafeed.

Why this exists: Yahoo caps 5m history at 60 days, which is far too little to
research a 5-minute system (~3,300 RTH bars). Dukascopy publishes free
per-day 1-minute candle files with several years of history and no API key.

Endpoint:  /datafeed/{INSTRUMENT}/{Y}/{M0}/{D}/BID_candles_min_1.bi5
  - M0 is ZERO-INDEXED (January = 00)
  - LZMA-compressed, 1440 fixed records of 24 bytes (one per minute of the
    UTC day), big-endian: uint32 seconds-offset, int32 O, C, L, H (price
    x1000 for index CFDs), float32 volume
  - Minutes with no ticks are zero-filled and are dropped here

IMPORTANT CAVEAT: USATECHIDXUSD is Dukascopy's Nasdaq-100 CASH INDEX CFD, not
CME futures. It tracks the same underlying but differs from MNQ in:
  - no CME contract volume (the volume field is a broker liquidity proxy)
  - no futures basis / roll / settlement behaviour
  - session coverage follows Dukascopy's CFD hours, not CME Globex exactly
Use it for structural research on a large sample; validate on real MNQ=F.
"""
import concurrent.futures as cf
import csv
import datetime as dt
import lzma
import os
import struct
import sys
import time
import urllib.error
import urllib.request

BASE = "https://datafeed.dukascopy.com/datafeed"
HEADERS = {"User-Agent": "Mozilla/5.0 (mmt-research)"}
REC = 24


def fetch_day(instrument, day, scale=1000.0, retries=3):
    """Return list of (epoch_sec, o, h, l, c, v) for one UTC day, or []."""
    url = (f"{BASE}/{instrument}/{day.year}/{day.month - 1:02d}/{day.day:02d}"
           f"/BID_candles_min_1.bi5")
    req = urllib.request.Request(url, headers=HEADERS)
    raw = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                raw = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                return []          # weekend / holiday / before listing
            if attempt == retries - 1:
                return []
            time.sleep(1.5 ** attempt)
        except Exception:          # noqa: BLE001 - retry any transport error
            if attempt == retries - 1:
                return []
            time.sleep(1.5 ** attempt)
    if not raw:
        return []
    try:
        d = lzma.LZMADecompressor().decompress(raw)
    except Exception:              # noqa: BLE001 - truncated/garbage payload
        return []

    base = int(dt.datetime(day.year, day.month, day.day,
                           tzinfo=dt.timezone.utc).timestamp())
    out = []
    for i in range(len(d) // REC):
        sec, o, c, l, h, v = struct.unpack(">Iiiiif", d[i * REC:(i + 1) * REC])
        if o <= 0 or h <= 0 or l <= 0 or c <= 0:
            continue               # zero-filled minute with no ticks
        out.append((base + sec, o / scale, h / scale, l / scale, c / scale,
                    float(v)))
    return out


def _cache_path(cache, instrument, day):
    return os.path.join(cache, instrument, f"{day.isoformat()}.csv")


def _fetch_and_cache(instrument, day, cache, scale):
    """Fetch one day unless already cached. Returns (day, n_minutes)."""
    p = _cache_path(cache, instrument, day)
    if os.path.exists(p):
        return day, -1                      # already have it
    rows = fetch_day(instrument, day, scale)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", newline="") as f:
        csv.writer(f).writerows(rows)
    os.replace(tmp, p)                      # atomic: no half-written cache
    return day, len(rows)


def fetch_range(instrument, start, end, workers=32, scale=1000.0, cache=None):
    """Fetch a date range, caching each day so the job is resumable.

    Requests are latency-bound (~10-50s each through the proxy), not
    bandwidth-bound, so a wide thread pool is the right lever.
    """
    cache = cache or ".dk_cache"
    days = []
    d = start
    while d <= end:
        if d.weekday() != 5:                # skip Saturday (no data at all)
            days.append(d)
        d += dt.timedelta(days=1)

    todo = [d for d in days if not os.path.exists(_cache_path(cache, instrument, d))]
    print(f"  {len(days)} days, {len(days)-len(todo)} cached, {len(todo)} to fetch",
          file=sys.stderr, flush=True)

    done = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_fetch_and_cache, instrument, day, cache, scale)
                for day in todo]
        for fut in cf.as_completed(futs):
            try:
                fut.result()
            except Exception as e:          # noqa: BLE001 - keep going
                print(f"  warn: {e}", file=sys.stderr, flush=True)
            done += 1
            if done % 50 == 0:
                print(f"  fetched {done}/{len(todo)}", file=sys.stderr, flush=True)

    rows = []
    for day in days:
        p = _cache_path(cache, instrument, day)
        if not os.path.exists(p):
            continue
        with open(p) as f:
            for r in csv.reader(f):
                if len(r) == 6:
                    rows.append((int(r[0]), float(r[1]), float(r[2]),
                                 float(r[3]), float(r[4]), float(r[5])))
    rows.sort()
    return rows


def resample(minutes, factor):
    """Aggregate 1m rows into `factor`-minute bars aligned to the wall clock.

    Bars are keyed by floor(epoch / (60*factor)) so a 5m bar always starts at
    :00/:05/:10..., matching how TradingView aligns intraday bars. Buckets with
    no data are simply absent (no synthetic bars across session gaps).
    """
    step = 60 * factor
    out = []
    cur_key = None
    o = h = l = c = None
    v = 0.0
    for ts, ro, rh, rl, rc, rv in minutes:
        key = ts - (ts % step)
        if key != cur_key:
            if cur_key is not None:
                out.append((cur_key, o, h, l, c, v))
            cur_key, o, h, l, c, v = key, ro, rh, rl, rc, rv
        else:
            h = max(h, rh)
            l = min(l, rl)
            c = rc
            v += rv
    if cur_key is not None:
        out.append((cur_key, o, h, l, c, v))
    return out


def save(path, rows):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        w.writerows(rows)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "data5m"
    years = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
    instruments = sys.argv[3].split(",") if len(sys.argv) > 3 else [
        "USATECHIDXUSD",   # Nasdaq-100 cash index CFD  (MNQ/NQ proxy)
        "USA500IDXUSD",    # S&P 500 cash index CFD     (ES proxy)
    ]
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=int(365 * years))

    for inst in instruments:
        print(f"[{inst}] {start} .. {end}", file=sys.stderr, flush=True)
        mins = fetch_range(inst, start, end, workers=32,
                           cache=os.environ.get("DK_CACHE", ".dk_cache"))
        if not mins:
            print(f"[{inst}] NO DATA", file=sys.stderr)
            continue
        save(os.path.join(out_dir, f"{inst}_1m.csv"), mins)
        for factor, name in ((5, "5m"), (15, "15m"), (60, "1h")):
            bars = resample(mins, factor)
            save(os.path.join(out_dir, f"{inst}_{name}.csv"), bars)
            print(f"[{inst}] {name}: {len(bars)} bars", file=sys.stderr)
        first = dt.datetime.utcfromtimestamp(mins[0][0])
        last = dt.datetime.utcfromtimestamp(mins[-1][0])
        print(f"[{inst}] 1m: {len(mins)} bars  {first} .. {last}",
              file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
