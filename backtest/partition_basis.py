#!/usr/bin/env python3
"""Freeze the chronological partitions for a basis (PROTOCOL v1.3a §4).

Emits a manifest and nothing else. It computes no result, so the boundaries
cannot be chosen with any knowledge of what they would produce - which is the
only reason a holdout means anything.

§4 rules implemented here:
  * partitions are chronological and never shuffled: development 50%,
    validation 25%, holdout 25%, split on CME TRADE DAYS rather than calendar
    days so a session is never cut in half;
  * a trade belongs to the partition containing its ENTRY bar; exits may run
    past the boundary, which is causally fine;
  * 30 calendar days of warm-up precede each partition, used solely to
    initialize causal state - no trade entering in warm-up is counted anywhere;
  * 1 full trade day of embargo follows each boundary, in which no trade may
    enter, so no position straddles the seam.

The holdout range is written down here, before it is ever read, so its single
permitted use is auditable after the fact.
"""
import csv
import datetime as dt
import json
import os
import sys
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
CSV = sys.argv[1] if len(sys.argv) > 1 else "data_ndx_q/NDX_5m.csv"
OUT = sys.argv[2] if len(sys.argv) > 2 else "research/PARTITIONS.json"
WARMUP_DAYS = 30
EMBARGO_TRADE_DAYS = 1


def trade_day(ts):
    """CME trade day: 18:00 ET rolls into the next day."""
    return (dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(ET)
            + dt.timedelta(hours=6)).date()


with open(CSV) as f:
    r = csv.reader(f)
    next(r)
    days = sorted({trade_day(int(x[0])) for x in r})

if len(days) < 400:
    sys.exit(f"HALT: only {len(days)} trade days in {CSV}; refusing to "
             "partition a sample this short into three parts.")

n = len(days)
i_dev = int(n * 0.50)
i_val = int(n * 0.75)
parts = [("development", days[:i_dev], "debugging, hypothesis formation, free exploration"),
         ("validation", days[i_dev:i_val], "selecting among predeclared variants only"),
         ("holdout", days[i_val:], "ONE run, after freeze")]

manifest = {"basis": CSV,
            "generated_utc": dt.datetime.utcnow().isoformat(),
            "protocol": "v1.3a §4",
            "trade_days_total": n,
            "warmup_calendar_days": WARMUP_DAYS,
            "embargo_trade_days": EMBARGO_TRADE_DAYS,
            "rule_entry_bar": "a trade belongs to the partition containing its "
                              "entry bar; exits may cross the boundary",
            "holdout_uses_remaining": 1,
            "partitions": []}

print(f"basis {CSV}")
print(f"{n:,} CME trade days   {days[0]} .. {days[-1]}\n")
prev_end = None
for name, dd, use in parts:
    start, end = dd[0], dd[-1]
    warm = start - dt.timedelta(days=WARMUP_DAYS)
    # the embargo eats the first trade days of every partition after the first
    embargo = dd[:EMBARGO_TRADE_DAYS] if prev_end else []
    tradeable = dd[len(embargo):]
    manifest["partitions"].append({
        "name": name, "use": use,
        "start": start.isoformat(), "end": end.isoformat(),
        "trade_days": len(dd),
        "warmup_from": warm.isoformat(),
        "embargoed_days": [d.isoformat() for d in embargo],
        "first_tradeable_day": tradeable[0].isoformat(),
        "share_pct": round(100 * len(dd) / n, 1)})
    print(f"{name:<12} {start} .. {end}   {len(dd):>5,} days "
          f"({100*len(dd)/n:4.1f}%)")
    print(f"{'':<12} warm-up state from {warm}"
          + (f"   embargo: {', '.join(d.isoformat() for d in embargo)}"
             if embargo else "   (no preceding boundary)"))
    prev_end = end

os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
with open(OUT, "w") as f:
    json.dump(manifest, f, indent=2)
print(f"\nwritten {OUT}")
print("HOLDOUT IS NOW FROZEN. It has exactly one permitted use, after the "
      "hypotheses are settled on development + validation.")
