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
# Everything strictly BEFORE this date is the holdout. See §4a: the window §4
# originally designated (latest 25%) is contaminated - prior research searched
# 18+ configurations over 2022-09-09..2026-09-08 - so the holdout is taken from
# the block no run has ever touched instead of from the most recent one.
HOLDOUT_BEFORE = dt.date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 \
    else dt.date(2022, 9, 9)
DEV_SHARE = 2 / 3          # split of the remaining (contaminated) block
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
untouched = [d for d in days if d < HOLDOUT_BEFORE]
searched = [d for d in days if d >= HOLDOUT_BEFORE]
if not untouched:
    sys.exit(f"HALT: no trade days before {HOLDOUT_BEFORE}; there is no "
             "uncontaminated block to hold out.")
if len(untouched) < 250:
    sys.exit(f"HALT: only {len(untouched)} untouched trade days before "
             f"{HOLDOUT_BEFORE}; too few to serve as a holdout.")
# The holdout's own first 30 calendar days are spent initializing causal state:
# there is no earlier data to warm up from (pre-2018 returns truncated ~14h
# sessions and is excluded by §12). Those days are warm-up, not evidence.
h_warm_end = untouched[0] + dt.timedelta(days=WARMUP_DAYS)
holdout_days = [d for d in untouched if d >= h_warm_end]
i_dev = int(len(searched) * DEV_SHARE)
parts = [("development", searched[:i_dev],
          "debugging, hypothesis formation, free exploration"),
         ("validation", searched[i_dev:],
          "selecting among predeclared variants only"),
         ("holdout", holdout_days, "ONE run, after freeze")]

manifest = {"basis": CSV,
            "generated_utc": dt.datetime.utcnow().isoformat(),
            "protocol": "v1.3b §4a - untouched-block holdout",
            "design": "Holdout is the block no prior run has touched "
                      f"(before {HOLDOUT_BEFORE}), NOT the latest 25%. Prior "
                      "research searched 18+ configurations over "
                      "2022-09-09..2026-09-08, so a recent holdout would be "
                      "development data wearing a holdout label.",
            "holdout_direction": "EARLIER than the fitting data. The test runs "
                                 "backwards in time. This is unconventional and "
                                 "is disclosed with every holdout number.",
            "contaminated_block": f"{HOLDOUT_BEFORE} onward",
            "trade_days_total": n,
            "warmup_calendar_days": WARMUP_DAYS,
            "embargo_trade_days": EMBARGO_TRADE_DAYS,
            "rule_entry_bar": "a trade belongs to the partition containing its "
                              "entry bar; exits may cross the boundary",
            "holdout_uses_remaining": 1,
            "partitions": []}

print(f"basis {CSV}")
print(f"{n:,} CME trade days   {days[0]} .. {days[-1]}")
print(f"untouched block  {len(untouched):,} days before {HOLDOUT_BEFORE}"
      f"  ({WARMUP_DAYS}d of it spent on warm-up)")
print(f"searched block   {len(searched):,} days from {HOLDOUT_BEFORE}\n")
prev_end = None
for name, dd, use in parts:
    start, end = dd[0], dd[-1]
    warm = start - dt.timedelta(days=WARMUP_DAYS)
    # the embargo eats the first trade days of every partition after the first
    embargo = dd[:EMBARGO_TRADE_DAYS] if (prev_end and name != "holdout") else []
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
