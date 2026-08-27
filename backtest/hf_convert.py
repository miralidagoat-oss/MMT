#!/usr/bin/env python3
"""Convert the Hugging Face NQ 1-minute parquet set to 5-minute ETH CSVs.

Source: mdelcristo/NQ-F_1min_OHLCV_Parquet (MIT). Timestamps are naive UTC;
they are localised to UTC and converted to America/New_York so the CME session
boundaries (18:00 ET open, 17:00 ET close, 17:00-18:00 maintenance break) land
correctly through both DST regimes.
"""
import csv, datetime as dt, sys
from zoneinfo import ZoneInfo
import pyarrow.parquet as pq

UTC = ZoneInfo("UTC")
ET  = ZoneInfo("America/New_York")


def session_day(et):
    d = et.date()
    if et.hour >= 18:
        d += dt.timedelta(days=1)
    if d.weekday() == 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


def load_year(path):
    t = pq.read_table(path).to_pydict()
    out = []
    for ts, o, h, l, c, v in zip(t["timestamp"], t["open"], t["high"],
                                 t["low"], t["close"], t["volume"]):
        if None in (o, h, l, c):
            continue
        et = ts.replace(tzinfo=UTC).astimezone(ET)
        out.append((et, float(o), float(h), float(l), float(c), float(v or 0)))
    out.sort(key=lambda r: r[0])
    return out


def to_5m(rows):
    """Aggregate 1m -> 5m on wall-clock 5-minute boundaries."""
    buckets = {}
    order = []
    for et, o, h, l, c, v in rows:
        key = et.replace(minute=(et.minute // 5) * 5, second=0, microsecond=0)
        if key not in buckets:
            buckets[key] = [o, h, l, c, v]
            order.append(key)
        else:
            b = buckets[key]
            b[1] = max(b[1], h); b[2] = min(b[2], l); b[3] = c; b[4] += v
    return [(k, *buckets[k]) for k in order]


def main(years, out_path):
    rows = []
    for y in years:
        rows += load_year(f"data/hf/NQ_1min_{y}.parquet")
        print(f"  loaded {y}: {len(rows)} cumulative 1m bars")
    bars = to_5m(rows)
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time","open","high","low","close","volume",
                    "session_day","et_minute","dow"])
        for et, o, h, l, c, v in bars:
            sd = session_day(et)
            w.writerow([int(et.timestamp()), o, h, l, c, v, sd,
                        et.hour * 60 + et.minute,
                        dt.date.fromisoformat(sd).weekday()])
    print(f"wrote {out_path}: {len(bars)} 5m bars, "
          f"{len({session_day(b[0]) for b in bars})} trading days")


if __name__ == "__main__":
    main(sys.argv[1].split(","), sys.argv[2])
