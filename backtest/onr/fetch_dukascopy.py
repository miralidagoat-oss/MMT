#!/usr/bin/env python3
"""Download Dukascopy's free 1-minute BID candles, one UTC day per file, as raw .bi5 (LZMA) files.

usage: fetch_dukascopy.py OUT_DIR SYMBOL FIRST_DAY LAST_DAY      (days as YYYY-MM-DD, UTC)

Used for WTI crude (LIGHTCMDUSD) from 2023 on, because HistData's WTIUSD ends on 2023-12-01. Saturdays (UTC) are
skipped: the market is shut. A day the server does not have (404) is recorded in OUT_DIR/missing.txt. The server throttles with HTTP 503, so
requests are paced (1 s apart) and a 503 is retried with a growing wait (up to 12 tries).
"""
import datetime as dt
import os
import sys
import time

import requests

URL = "https://datafeed.dukascopy.com/datafeed/{sym}/{y:04d}/{m:02d}/{d:02d}/BID_candles_min_1.bi5"


def main(out, sym, first, last):
    os.makedirs(out, exist_ok=True)
    s = requests.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0"})
    day, end = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
    missing = []
    while day <= end:
        if day.weekday() != 5:
            fn = os.path.join(out, f"{sym}_{day.isoformat()}.bi5")
            if not (os.path.exists(fn) and os.path.getsize(fn) > 0):
                url = URL.format(sym=sym, y=day.year, m=day.month - 1, d=day.day)  # month is 0-based in the path
                for attempt in range(12):
                    try:
                        r = s.get(url, timeout=60)
                        if r.status_code == 200:
                            with open(fn, "wb") as f:
                                f.write(r.content)
                            break
                        if r.status_code == 404:
                            missing.append(day.isoformat())
                            break
                        print(f"{day}: HTTP {r.status_code}", flush=True)
                    except Exception as e:  # noqa: BLE001
                        print(f"{day}: error {type(e).__name__}", flush=True)
                        s = requests.Session()
                        s.headers.update({"User-Agent": "Mozilla/5.0"})
                    time.sleep(min(120, 15 * (attempt + 1)))  # the server answers 503 when it is throttling
                else:
                    print(f"{day}: FAILED after retries", flush=True)
                if day.day == 1:
                    print(f"{sym} {day}", flush=True)
                time.sleep(1.0)
        day += dt.timedelta(days=1)
    with open(os.path.join(out, "missing.txt"), "a") as f:
        f.write("".join(d + "\n" for d in missing))
    print(f"done; {len(missing)} days not on the server", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:5])
