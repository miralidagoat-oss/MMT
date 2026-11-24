#!/usr/bin/env python3
"""Real MNQ futures 5-minute bars from the user's parquet export -> the engine's futures file.

usage: python3 -I prep_mnq.py MNQ_PARQUET OUT_NPZ        (needs pyarrow: pip install pyarrow)
Writes OUT_NPZ (t in New York wall-clock minutes, bar-open labels, 5-minute bars; o, h, l, c) and OUT_NPZ.json.
       python3 -I prep_mnq.py --cut NQFUT_NPZ FIRST_DAY OUT_NPZ
Writes the sessions from trading day FIRST_DAY (its 18:00 ET open the evening before) to the end: the recent window
(MNQ_5m_60d.npz, Sep 9 - Nov 20 2026) that mnq_real50k.py, export_charts.py and the site's real-MNQ pages read, with
NQFUT.npz beside it for the average range of its first sessions (engine.adr_seed).

The export (MICRONASDAQ100_futures_5m_2019-12-01_2026-11-23.parquet: time as a UTC timestamp, open, high, low, close,
volume, trades) is MNQ's front contract in 5-minute bars labelled by the bar's open, Dec 1 2019 18:00 ET to Nov 20 2026
16:55 ET. Every backtest uses it alone, as recorded: nothing is filled, repaired or adjusted.
Checks, all asserted: times sorted and unique, on the 5-minute grid, every price on MNQ's 0.25 tick, high >= open,
close >= low, no bar inside the 17:00-18:00 ET halt.
- New York time comes from UTC with the tz database (daylight saving included).
- The series is the raw front contract, so it jumps at each quarterly roll. Every roll falls on a session's 18:00 open,
  when the strategy holds nothing (its trades open after 18:00 and close by 16:00), and its ranges and moves are
  measured inside a session, so the rolls change no trade.
- Prices the CFD cannot confirm are kept: in March 2020 MNQ was thin and fast, and a print is what a stop would have met.
The .json lists the sessions, the sessions that open at another time than 18:00 ET (halts and holidays) and the RTH
days with fewer than 78 bars (early closes and halts).
"""
import datetime as dt
import json
import sys

import numpy as np
import pyarrow.parquet as pq

EP = dt.datetime(1970, 1, 1)


def main(src, out):
    tb = pq.read_table(src)
    names = tb.schema.names
    assert names[:5] == ["time", "open", "high", "low", "close"], names
    df = tb.to_pandas()
    utc = df["time"]
    assert str(utc.dt.tz) == "UTC", utc.dt.tz
    ny = utc.dt.tz_convert("America/New_York").dt.tz_localize(None)
    t = ((ny - EP).dt.total_seconds() // 60).astype(np.int64).to_numpy()
    o, h, l, c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    assert np.all(np.diff(utc.astype("int64").to_numpy()) > 0), "UTC times not sorted and unique"
    assert np.all(np.diff(t) > 0), "New York times not increasing"
    assert np.all(t % 5 == 0), "off the 5-minute grid"
    px = np.r_[o, h, l, c]
    assert np.all(np.abs(px * 4 - np.round(px * 4)) < 1e-6), "a price off the 0.25 tick"
    assert np.all(h >= np.maximum(o, c) - 1e-9) and np.all(l <= np.minimum(o, c) + 1e-9), "high/low not around open/close"
    tod = t % 1440
    assert not np.any((tod >= 17 * 60) & (tod < 18 * 60)), "a bar inside the 17:00-18:00 ET halt"
    starts = np.r_[0, np.flatnonzero(np.diff(t) >= 45) + 1]
    day = (t + 360) // 1440
    rth = (tod >= 570) & (tod < 960)
    nrth = {int(d): int(n) for d, n in zip(*np.unique(day[rth], return_counts=True))}
    d0 = dt.date(1970, 1, 1)
    info = dict(source=src.split("/")[-1], bars=int(len(t)),
                first_et=str(EP + dt.timedelta(minutes=int(t[0]))), last_et=str(EP + dt.timedelta(minutes=int(t[-1]))),
                sessions=int(len(np.unique(day))),
                sessions_not_opening_at_1800=[str(EP + dt.timedelta(minutes=int(t[i]))) for i in starts if t[i] % 1440 != 18 * 60],
                rth_days_under_78_bars={str(d0 + dt.timedelta(days=k)): n for k, n in sorted(nrth.items()) if n < 78})
    np.savez_compressed(out, t=t, o=o, h=h, l=l, c=c)
    json.dump(info, open(out + ".json", "w"), indent=1)
    print(json.dumps({k: (v if not isinstance(v, (list, dict)) or len(v) < 12 else f"{len(v)} entries") for k, v in info.items()}, indent=1))


def cut(src, first_day, out):
    z = np.load(src)
    t = z["t"]
    d0 = (dt.datetime.fromisoformat(first_day) - EP).days
    keep = (t + 360) // 1440 >= d0                  # a session's bars from its 18:00 open (the evening before its day)
    np.savez_compressed(out, **{k: z[k][keep] for k in ("t", "o", "h", "l", "c")})
    info = dict(source=src.split("/")[-1], first_day=first_day, bars=int(keep.sum()),
                first_et=str(EP + dt.timedelta(minutes=int(t[keep][0]))), last_et=str(EP + dt.timedelta(minutes=int(t[keep][-1]))),
                sessions=int(len(np.unique((t[keep] + 360) // 1440))))
    json.dump(info, open(out + ".json", "w"), indent=1)
    print(json.dumps(info, indent=1))


if __name__ == "__main__":
    if sys.argv[1] == "--cut":
        cut(*sys.argv[2:5])
    else:
        main(*sys.argv[1:3])
