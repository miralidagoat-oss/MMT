#!/usr/bin/env python3
"""Turn raw downloads into .npz bar files used by engine.py.

Times are stored as New York wall-clock minutes since 1970-01-01 (bar OPEN time).

HistData index CFDs (SPXUSD, NSXUSD): the files are labelled in New York time WITH daylight saving, except that
from 2019 on every session inside the US/EU daylight-saving mismatch weeks (2nd Sun of March -> last Sun of March,
last Sun of October -> 1st Sun of November) is labelled one hour early (the session opens at "17:00" instead of
18:00). Verified against real MNQ futures in Oct 2026 (correlation of 5-minute moves 0.998 after the fix, ~0 before).
This script detects each session's open label and shifts the 17:00-labelled sessions by +60 minutes.

usage:
  prep_data.py histdata RAW_DIR OUT_DIR SYMBOL...        (zips from fetch_histdata.py)
  prep_data.py yahoo JSON_FILE OUT_NPZ                     (Yahoo chart API JSON, e.g. MNQ=F 5m)
"""
import datetime as dt
import glob
import io
import json
import os
import sys
import zipfile
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd


def load_histdata(src, sym):
    frames = []
    for fn in sorted(glob.glob(os.path.join(src, f"{sym}_*.zip"))):
        with zipfile.ZipFile(fn) as z:
            name = [n for n in z.namelist() if n.endswith(".csv")][0]
            frames.append(pd.read_csv(io.BytesIO(z.read(name)), sep=";", header=None,
                                      names=["dt", "o", "h", "l", "c", "v"], dtype={"dt": str}))
    df = pd.concat(frames, ignore_index=True)
    t = pd.to_datetime(df["dt"], format="%Y%m%d %H%M%S").to_numpy().astype("datetime64[m]").astype("int64")
    order = np.argsort(t, kind="stable")
    t = t[order]
    keep = np.r_[True, np.diff(t) > 0]
    cols = {k: df[k].to_numpy(float)[order][keep] for k in "ohlc"}
    return t[keep], cols


def fix_dst_mismatch(t):
    """+60 min for every session whose open is labelled ~17:00 (see module doc). Returns (t_fixed, n_sessions_fixed)."""
    t = t.copy()
    gaps = np.where(np.diff(t) >= 40)[0] + 1
    opens = np.r_[0, gaps]
    ends = np.r_[gaps, len(t)]
    fixed = 0
    for a, b in zip(opens, ends):
        m = t[a] % 1440
        if 1015 <= m <= 1025:  # session opens at 16:55-17:05 label -> labelled one hour early
            t[a:b] += 60
            fixed += 1
    order = np.argsort(t, kind="stable")
    t = t[order]
    return t, order, fixed


def histdata_main(src, out, syms):
    os.makedirs(out, exist_ok=True)
    for sym in syms:
        t, cols = load_histdata(src, sym)
        np.savez_compressed(os.path.join(out, f"{sym}_raw.npz"), t=t, **cols)  # as published, for comparison
        t2, order, fixed = fix_dst_mismatch(t)
        keep = np.r_[True, np.diff(t2) > 0]
        cols = {k: v[order][keep] for k, v in cols.items()}
        np.savez_compressed(os.path.join(out, f"{sym}.npz"), t=t2[keep], **cols)
        print(f"{sym}: {keep.sum()} bars, {fixed} sessions shifted +60 min "
              f"({np.datetime64(int(t2[0]), 'm')} -> {np.datetime64(int(t2[-1]), 'm')})")


def yahoo_main(path, out):
    ny = ZoneInfo("America/New_York")
    r = json.load(open(path))["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(r["timestamp"]):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        loc = dt.datetime.fromtimestamp(int(ts), ny).replace(tzinfo=None)
        rows.append((int(loc.timestamp() // 60), o, h, l, c))
    a = np.array(sorted({x[0]: x for x in rows}.values()), float)
    np.savez_compressed(out, t=a[:, 0].astype("int64"), o=a[:, 1], h=a[:, 2], l=a[:, 3], c=a[:, 4])
    print(f"{out}: {len(a)} bars {np.datetime64(int(a[0, 0]), 'm')} -> {np.datetime64(int(a[-1, 0]), 'm')}")


if __name__ == "__main__":
    if sys.argv[1] == "histdata":
        histdata_main(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        yahoo_main(sys.argv[2], sys.argv[3])
