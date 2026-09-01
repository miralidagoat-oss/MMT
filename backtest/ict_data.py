#!/usr/bin/env python3
"""Fetch OHLCV for the ICT strategy study and cache as CSV.

Yahoo hard-limits intraday history (verified, not assumed): 1m ~7d, 5m/15m/30m
~60d, 60m ~730d. period1/period2 pagination beyond those windows returns HTTP
422, so 60 days is genuinely all the sub-hourly history available here.
"""
import csv
import json
import os
import sys
import time
import urllib.request

HEADERS = {"User-Agent": "Mozilla/5.0 (mmt-backtest)"}
JOBS = [("5m", "60d"), ("15m", "60d"), ("30m", "60d"), ("60m", "730d"), ("1d", "10y")]
SYMBOLS = ["MNQ=F", "NQ=F", "MES=F", "ES=F", "QQQ", "SPY"]


def fetch(symbol, interval, range_):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?interval={interval}&range={range_}")
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
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
                rows.append((int(t), float(o), float(h), float(l), float(c), float(v or 0)))
            return rows
        except Exception as exc:  # noqa: BLE001 - retry any transport error
            if attempt == 3:
                print(f"  ! {symbol} {interval}: {exc}")
                return []
            time.sleep(2 ** attempt)
    return []


def save(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        w.writerows(rows)


def main(out_dir="ictdata", symbols=None):
    os.makedirs(out_dir, exist_ok=True)
    for symbol in (symbols or SYMBOLS):
        tag = symbol.replace("=F", "")
        for interval, range_ in JOBS:
            name = {"60m": "1h", "1d": "1d"}.get(interval, interval)
            rows = fetch(symbol, interval, range_)
            if not rows:
                continue
            save(os.path.join(out_dir, f"{tag}_{name}.csv"), rows)
            span = (rows[-1][0] - rows[0][0]) / 86400.0
            print(f"{tag:5s} {name:3s}: {len(rows):6d} bars, {span:6.1f} days")
            time.sleep(0.4)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "ictdata",
         sys.argv[2:] or None)
