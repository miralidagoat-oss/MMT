#!/usr/bin/env python3
"""Download HistData.com free ASCII M1 bars (yearly files, monthly for the current year).

usage: histdata_dl.py OUT_DIR SYMBOL [SYMBOL ...]
"""
import os
import re
import sys
import time

import requests

BASE = "https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}


def periods():
    for y in range(2010, 2026):
        yield f"{y}", str(y), str(y)
    for m in range(1, 12):
        yield f"2026/{m}", "2026", f"2026{m:02d}"


def main(out, syms):
    os.makedirs(out, exist_ok=True)
    s = requests.Session()
    s.headers.update(UA)
    for sym in syms:
        for path, date, datemonth in periods():
            fn = os.path.join(out, f"{sym}_{datemonth}.zip")
            if os.path.exists(fn) and os.path.getsize(fn) > 1000:
                continue
            url = f"{BASE}/{sym.lower()}/{path}"
            for attempt in range(4):
                try:
                    page = s.get(url, timeout=60).text
                    tk = re.search(r'name="tk" id="tk" value="([0-9a-f]+)"', page).group(1)
                    r = s.post("https://www.histdata.com/get.php",
                               data={"tk": tk, "date": date, "datemonth": datemonth,
                                     "platform": "ASCII", "timeframe": "M1", "fxpair": sym},
                               headers={"Referer": url}, timeout=180)
                    if r.status_code == 200 and r.content[:2] == b"PK":
                        with open(fn, "wb") as f:
                            f.write(r.content)
                        print(f"{sym} {datemonth}: {len(r.content)//1024} KB", flush=True)
                        break
                    print(f"{sym} {datemonth}: bad response {r.status_code} {r.content[:60]!r}", flush=True)
                except Exception as e:  # noqa: BLE001
                    print(f"{sym} {datemonth}: error {e}", flush=True)
                time.sleep(3 * (attempt + 1))
            time.sleep(1.0)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
