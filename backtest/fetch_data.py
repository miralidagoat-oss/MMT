#!/usr/bin/env python3
"""Fetch OHLCV candles from Coinbase Exchange public API and cache as CSV.

Coinbase returns at most 300 candles per request, newest first, as
[time, low, high, open, close, volume]. We paginate backwards and write
ascending-time CSVs: time,open,high,low,close,volume
"""
import csv
import json
import os
import sys
import time
import urllib.request

BASE = "https://api.exchange.coinbase.com"
HEADERS = {"User-Agent": "mmt-backtest/1.0"}


def fetch_window(product, granularity, start_ts, end_ts):
    url = (f"{BASE}/products/{product}/candles?granularity={granularity}"
           f"&start={start_ts}&end={end_ts}")
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001 - retry any transport error
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    return []


def fetch_series(product, granularity, n_bars):
    now = int(time.time()) // granularity * granularity
    rows = {}
    end = now
    while len(rows) < n_bars:
        start = end - 300 * granularity
        batch = fetch_window(product, granularity, start, end)
        if not batch:
            break
        for t, lo, hi, op, cl, vol in batch:
            rows[int(t)] = (float(op), float(hi), float(lo), float(cl), float(vol))
        end = start
        time.sleep(0.2)
    times = sorted(rows)[-n_bars:]
    return [(t, *rows[t]) for t in times]


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    jobs = [
        ("BTC-USD", 3600, 4200), ("ETH-USD", 3600, 4200), ("SOL-USD", 3600, 4200),
        ("BTC-USD", 21600, 2000), ("ETH-USD", 21600, 2000), ("SOL-USD", 21600, 2000),
    ]
    for product, gran, n in jobs:
        name = f"{product}_{gran}.csv"
        path = os.path.join(out_dir, name)
        if os.path.exists(path):
            print(f"cached: {name}")
            continue
        series = fetch_series(product, gran, n)
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["time", "open", "high", "low", "close", "volume"])
            w.writerows(series)
        print(f"fetched: {name} ({len(series)} bars)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data")
