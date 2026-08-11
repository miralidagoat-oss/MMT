#!/usr/bin/env python3
"""Fetch futures OHLCV from the Yahoo Finance chart API and cache as CSV.

Yahoo history limits per interval: 1m ~7d, 5m/15m/30m ~60d, 60m ~730d.
4h series are resampled from 60m (Yahoo has no native 4h). Null candles
(halts) are dropped.
"""
import csv
import json
import os
import sys
import time
import urllib.request

HEADERS = {"User-Agent": "Mozilla/5.0 (mmt-backtest)"}


def fetch(symbol, interval, range_):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?interval={interval}&range={range_}")
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            res = data["chart"]["result"][0]
            ts = res["timestamp"]
            q = res["indicators"]["quote"][0]
            rows = []
            for i, t in enumerate(ts):
                o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
                v = q["volume"][i]
                if None in (o, h, l, c):
                    continue
                rows.append((int(t), float(o), float(h), float(l), float(c),
                             float(v or 0)))
            return rows
        except Exception:  # noqa: BLE001 - retry any transport error
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    return []


def resample(rows, factor):
    out = []
    bucket = []
    for row in rows:
        bucket.append(row)
        if len(bucket) == factor:
            out.append((bucket[0][0], bucket[0][1],
                        max(r[2] for r in bucket), min(r[3] for r in bucket),
                        bucket[-1][4], sum(r[5] for r in bucket)))
            bucket = []
    return out


def save(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        w.writerows(rows)


def main(out_dir, symbol="MNQ=F"):
    os.makedirs(out_dir, exist_ok=True)
    tag = symbol.replace("=F", "")
    jobs = [("1m", "7d", "1m"), ("5m", "60d", "5m"), ("15m", "60d", "15m"),
            ("30m", "60d", "30m"), ("60m", "730d", "1h")]
    hourly = None
    for interval, range_, name in jobs:
        rows = fetch(symbol, interval, range_)
        save(os.path.join(out_dir, f"{tag}_{name}.csv"), rows)
        print(f"{tag} {name}: {len(rows)} bars")
        if name == "1h":
            hourly = rows
        time.sleep(0.5)
    if hourly:
        four = resample(hourly, 4)
        save(os.path.join(out_dir, f"{tag}_4h.csv"), four)
        print(f"{tag} 4h (resampled): {len(four)} bars")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data",
         sys.argv[2] if len(sys.argv) > 2 else "MNQ=F")
