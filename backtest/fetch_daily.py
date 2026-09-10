#!/usr/bin/env python3
"""Fetch long-history daily OHLCV for the index ETFs used by overnight_study.py.

Index ETFs are used rather than futures because their daily open IS the 09:30
cash open and their close IS the 16:00 cash close, which is exactly the
boundary the overnight rule trades. A futures daily bar cannot be used the
same way: its "open" is the prior evening's Globex open.

Note `range=max` returns MONTHLY bars from this endpoint; an explicit
period1/period2 window is required to get true daily data.

Usage: python3 fetch_daily.py <out_dir> [SYMBOL ...]
"""
import csv
import json
import os
import sys
import time
import urllib.request

HEADERS = {"User-Agent": "Mozilla/5.0 (mmt-backtest)"}
DEFAULT = ("QQQ", "SPY", "DIA", "IWM")


def fetch(symbol):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?interval=1d&period1=0&period2={int(time.time())}")
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            res = data["chart"]["result"][0]
            ts = res["timestamp"]
            q = res["indicators"]["quote"][0]
            rows = []
            for i, t in enumerate(ts):
                o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
                v = q["volume"][i]
                if None in (o, h, l, c) or o <= 0:
                    continue
                rows.append((int(t), float(o), float(h), float(l), float(c), float(v or 0)))
            return rows
        except Exception:  # noqa: BLE001 - retry any transport error
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    return []


def main(out_dir, symbols):
    os.makedirs(out_dir, exist_ok=True)
    for sym in symbols:
        rows = fetch(sym)
        path = os.path.join(out_dir, f"{sym}_1d.csv")
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["time", "open", "high", "low", "close", "volume"])
            w.writerows(rows)
        span = (f"{time.strftime('%Y-%m-%d', time.gmtime(rows[0][0]))} → "
                f"{time.strftime('%Y-%m-%d', time.gmtime(rows[-1][0]))}") if rows else "empty"
        print(f"{sym}: {len(rows)} days  {span}")
        time.sleep(0.4)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data",
         sys.argv[2:] or list(DEFAULT))
