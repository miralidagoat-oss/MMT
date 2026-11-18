#!/usr/bin/env python3
"""Extend the S&P 500 CFD series (HistData SPXUSD, which ends with the Nov 13 2026 session) with newer bars from another
source, shifted to the CFD's price level, so the real-MNQ backtest has the overnight score for the sessions after it.

usage: prep_spx_ext.py DATA_DIR SOURCE OUT_NPZ
  SOURCE: a Yahoo chart JSON (ES=F 5-minute bars), or a directory of Dukascopy USA500IDXUSD_<day>.bi5 minute files
  (another S&P 500 CFD, UTC; prep_r5.dukascopy reads them).

The level shift is the median of (CFD close - source close) over the 5-minute bars both have in the last 5 shared
sessions. Check: the score of each shared session is recomputed with that session's CFD bars replaced by the shifted
source bars and compared with the CFD score.
"""
import datetime as dt
import json
import os
import sys
from zoneinfo import ZoneInfo

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import THR, load_npz, rth_sessions, score_series, sess_cols  # noqa: E402

NY = ZoneInfo("America/New_York")


def yahoo_bars(path):
    r = json.load(open(path))["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    rows = {}
    for i, ts in enumerate(r["timestamp"]):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        loc = dt.datetime.fromtimestamp(int(ts), NY).replace(tzinfo=None)
        rows[int((loc - dt.datetime(1970, 1, 1)).total_seconds() // 60)] = (o, h, l, c)
    k = np.array(sorted(rows), "int64")
    a = np.array([rows[x] for x in k], float)
    return k, a[:, 0], a[:, 1], a[:, 2], a[:, 3]


def main(dd, src, out):
    t, o, h, l, c = load_npz(os.path.join(dd, "SPXUSD.npz"))
    if os.path.isdir(src):
        from prep_r5 import dukascopy
        et, cols = dukascopy(src, "USA500IDXUSD")
        eo, eh, el, ec = (cols[k] for k in "ohlc")
    else:
        et, eo, eh, el, ec = yahoo_bars(src)
    # CFD 5-minute closes (last 1-minute close of each bucket), keyed by bucket start
    b = t // 5 * 5
    last = np.r_[b[1:] != b[:-1], True]
    cfd5 = dict(zip(b[last].tolist(), c[last].tolist()))
    _, sday = sess_cols(t)
    _, eday = sess_cols(et)
    shared = sorted(set(sday.tolist()) & set(eday.tolist()))[-5:]
    keys = [int(k) for k, d in zip(et, eday) if d in shared and int(k) in cfd5]
    diff = np.array([cfd5[k] - ec[np.searchsorted(et, k)] for k in keys])
    off = float(np.median(diff))
    print(f"level shift CFD - source over sessions {[str(np.datetime64(int(d), 'D')) for d in shared]}: median {off:+.2f} "
          f"(25th-75th pct {np.percentile(diff, 25):+.2f} / {np.percentile(diff, 75):+.2f}, {len(diff)} bars)")
    # check: replace one shared session at a time with shifted ES bars and recompute its score
    base, _ = score_series(rth_sessions(t, o, h, l, c))
    for d in shared:
        keep = sday != d
        sel = eday == d
        tt = np.r_[t[keep], et[sel]]
        order = np.argsort(tt, kind="stable")
        cols = [np.r_[x[keep], y[sel] + off][order] for x, y in ((o, eo), (h, eh), (l, el), (c, ec))]
        sc, _ = score_series(rth_sessions(tt[order], *cols))
        if d not in sc:
            print(f"  session {np.datetime64(int(d), 'D')}: not a full session in the source, skipped")
            continue
        print(f"  session {np.datetime64(int(d), 'D')}: score from the CFD {base[d]:+.3f}, with the source's bars {sc[d]:+.3f} "
              f"(buy at or above {THR}, sell at or below -{THR})")
    # extend: ES bars after the CFD's last bar
    after = et > t[-1]
    T = np.r_[t, et[after]]
    O, H, L, C = (np.r_[x, y[after] + off] for x, y in ((o, eo), (h, eh), (l, el), (c, ec)))
    np.savez_compressed(out, t=T, o=O, h=H, l=L, c=C)
    sc, _ = score_series(rth_sessions(T, O, H, L, C))
    new = [d for d in sorted(sc) if d > shared[-1]]
    print(f"wrote {out}: +{after.sum()} source bars {np.datetime64(int(et[after][0]), 'm')} -> {np.datetime64(int(et[-1]), 'm')}")
    for d in new:
        print(f"  new session {np.datetime64(int(d), 'D')}: score {sc[d]:+.3f} -> next evening's overnight signal "
              f"{'BUY' if sc[d] >= THR else 'SELL' if sc[d] <= -THR else 'none'}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
