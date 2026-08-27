#!/usr/bin/env python3
"""MNQ/NQ ETH data layer for the 5-minute research programme.

Two jobs the older `fetch_yahoo.py` did not do:

1. **Futures trading-day mapping.** The CME equity-index session runs
   18:00 ET -> 17:00 ET the next calendar day, with a 17:00-18:00 ET
   maintenance break. The block that starts Sunday 18:00 ET belongs to
   *Monday's* trading day. Anything that keys off "the previous day's
   high/low" or counts "trades per day" on calendar days is simply wrong
   on ETH data.
2. **Null-padding removal.** Yahoo returns a synthetic 24x12 grid per
   calendar day and fills non-traded slots with nulls (~20% of rows).
"""
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.request

HEADERS = {"User-Agent": "Mozilla/5.0 (mmt-eth-research)"}
ET = dt.timezone(dt.timedelta(hours=-4))  # see note in session_day()


def fetch(symbol, interval, range_):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?interval={interval}&range={range_}")
    req = urllib.request.Request(url, headers=HEADERS)
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            res = data["chart"]["result"][0]
            ts = res["timestamp"]
            q = res["indicators"]["quote"][0]
            gmt = res["meta"]["gmtoffset"]
            rows = []
            for i, t in enumerate(ts):
                o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
                if None in (o, h, l, c):
                    continue  # Yahoo pads a full 24h grid with nulls
                rows.append((int(t), float(o), float(h), float(l), float(c),
                             float(q["volume"][i] or 0)))
            return rows, gmt
        except Exception as e:  # noqa: BLE001 - retry any transport error
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"fetch failed for {symbol} {interval}: {last!r}")


def session_day(ts, gmt):
    """Trading day a bar belongs to, as an ISO date string.

    `gmt` is Yahoo's exchange offset for the *series*; ET is DST-varying but
    the CME session boundary is defined in ET local time, so we use the
    reported offset rather than assuming a fixed one. Bars at/after 18:00 ET
    roll into the next trading day. Saturday bars (Friday's late tail, if the
    feed ever emits any) fold back into Friday.
    """
    lt = dt.datetime.utcfromtimestamp(ts + gmt)
    day = lt.date()
    if lt.hour >= 18:
        day = day + dt.timedelta(days=1)
    if day.weekday() == 5:      # Saturday -> belongs to Friday's session
        day = day - dt.timedelta(days=1)
    return day.isoformat()


def et_minute(ts, gmt):
    """Minutes since midnight ET, for time-of-day bucketing."""
    lt = dt.datetime.utcfromtimestamp(ts + gmt)
    return lt.hour * 60 + lt.minute


def save(path, rows, gmt):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume",
                    "session_day", "et_minute", "dow"])
        for t, o, h, l, c, v in rows:
            sd = session_day(t, gmt)
            w.writerow([t, o, h, l, c, v, sd, et_minute(t, gmt),
                        dt.date.fromisoformat(sd).weekday()])


def main(out_dir="data"):
    os.makedirs(out_dir, exist_ok=True)
    jobs = [("MNQ=F", "5m", "60d"), ("MNQ=F", "1h", "730d"),
            ("NQ=F", "5m", "60d"), ("NQ=F", "1h", "730d"),
            ("MNQ=F", "15m", "60d"), ("MNQ=F", "30m", "60d")]
    for sym, iv, rng in jobs:
        tag = sym.replace("=F", "")
        path = os.path.join(out_dir, f"{tag}_{iv}.csv")
        if os.path.exists(path):
            print(f"cached: {os.path.basename(path)}")
            continue
        rows, gmt = fetch(sym, iv, rng)
        save(path, rows, gmt)
        days = len({session_day(r[0], gmt) for r in rows})
        print(f"fetched {tag} {iv}: {len(rows)} bars over {days} trading days")
        time.sleep(1.5)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data")
