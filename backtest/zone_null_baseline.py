#!/usr/bin/env python3
"""Generate a driftless random-walk series shaped like 5m NQ.

A hold rate measured on real data means nothing on its own: the HOLD and
BREAK definitions are not symmetric, so even a series with no real levels in
it produces some rate. Run zone_study.py over this to get that null, then
judge real data against it rather than against 50%.

  python3 backtest/zone_null_baseline.py /tmp/null_5m.csv --days 60
  python3 backtest/zone_study.py /tmp/null_5m.csv
"""
import argparse
import csv
import math
import random
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

CA = ZoneInfo("America/Los_Angeles")
MINTICK = 0.25


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--start", default="21000", type=float)
    ap.add_argument("--sigma", type=float, default=0.0004,
                    help="per-bar log-return sd; 0.0004 gives NQ-like 5m ranges")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    px = args.start
    rows = []
    day = datetime(2026, 1, 5, tzinfo=CA)          # a Monday
    made = 0
    while made < args.days:
        if day.weekday() < 5:
            for m in range(360, 1140, 5):          # 06:00 - 18:55 California
                t = day.replace(hour=m // 60, minute=m % 60)
                o = px
                c = o * math.exp(rng.gauss(0, args.sigma))
                wick = abs(rng.gauss(0, args.sigma * 0.6))
                h = max(o, c) * math.exp(wick)
                l = min(o, c) * math.exp(-wick)
                q = lambda x: round(x / MINTICK) * MINTICK
                rows.append((int(t.timestamp()), q(o), q(h), q(l), q(c)))
                px = c
            made += 1
        day += timedelta(days=1)

    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        for r in rows:
            w.writerow(list(r) + [0])
    print(f"{len(rows)} bars over {args.days} sessions -> {args.out}")


if __name__ == "__main__":
    main()
