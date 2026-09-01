#!/usr/bin/env python3
"""Which confluences actually condition the sweep->MSS edge?

`ict_edge.py` showed the raw event has no forward drift. ICT's own claim is
that the edge lives in the CONFLUENCE — only take the 5m shift when the higher
timeframes agree. This script tests that claim one condition at a time.

For every event we tag a set of boolean features (HTF structure alignment,
VWAP side, daily-open side, prior-day-mid side, which pool was raided, which
killzone, displacement size) and then compare the forward move in ATR units
for events where the feature is TRUE vs FALSE. A feature that matters should
push the TRUE group clearly positive and preferably the FALSE group negative.

Caveat kept in view throughout: this tests many conditions on a few hundred
events, so a t around 2 on one slice is what noise looks like when you look
this many times. Only a condition that holds on both market complexes and on
both the long and the short series is worth anything.
"""
import statistics as st
import sys

from ict_edge import find_events, fwd, excursion
from ict_engine import Config, KILLZONES, load, prepare


def htf_state(d, mult, look=3):
    """Last break-of-structure direction on `mult`-bar higher-timeframe candles."""
    h, l, n = d["h"], d["l"], d["n"]
    blocks = [(i + mult - 1, max(h[i:i + mult]), min(l[i:i + mult]))
              for i in range(0, n - mult + 1, mult)]
    out, state, bi = [0] * n, 0, 0
    for i in range(n):
        while bi < len(blocks) and blocks[bi][0] <= i:
            if bi >= look:
                prev = blocks[bi - look:bi]
                _, bh, bl = blocks[bi]
                if bh > max(x[1] for x in prev):
                    state = 1
                elif bl < min(x[2] for x in prev):
                    state = -1
            bi += 1
        out[i] = state
    return out


def features(d, i, direction, htfs, cfg):
    c, minute = d["c"][i], d["minute"][i]
    day, prev_of = d["day"][i], d["prev_of"]
    prev = prev_of.get(day)
    f = {}
    for name, series in htfs.items():
        f[f"htf_{name}"] = series[i] == direction
    f["vwap_side"] = (c > d["vwap"][i]) == (direction > 0)
    f["day_open"] = (c > d["day_open"][day]) == (direction > 0)
    if prev is not None:
        pdm = (d["day_hi"][prev] + d["day_lo"][prev]) / 2.0
        f["pd_mid"] = (c > pdm) == (direction > 0)
    a = d["atr"][i] or 1.0
    f["big_disp"] = abs(d["c"][i] - d["o"][i]) >= 0.8 * a
    for kz in ("nyam", "nypm", "london"):
        f[f"kz_{kz}"] = any(x <= minute < y for x, y in KILLZONES[kz])
    return f


def run_conditions(path, symbol, tf, cfg, horizon, htf_mults, label):
    d = prepare(load(path), cfg)
    for name, m in htf_mults.items():
        pass
    htfs = {name: htf_state(d, m) for name, m in htf_mults.items()}
    events = find_events(d, cfg)
    kz = KILLZONES[cfg.killzone]
    ev = [(i, s) for i, s in events
          if any(a <= d["minute"][i] < b for a, b in kz)]
    rows = []
    for i, s in ev:
        r = fwd(d, i, s, horizon)
        if r is None:
            continue
        rows.append((features(d, i, s, htfs, cfg), r, s))
    if len(rows) < 30:
        print(f"\n{label}: only {len(rows)} events — skipped")
        return {}
    base = [r for _, r, _ in rows]
    print(f"\n{label}  n={len(rows)}  forward {horizon} bars  "
          f"ALL mean {st.mean(base):+.3f} ATR (t={tstat(base):+.2f})")
    out = {}
    keys = sorted(rows[0][0])
    for k in keys:
        yes = [r for f, r, _ in rows if f.get(k)]
        no = [r for f, r, _ in rows if not f.get(k)]
        if len(yes) < 15 or len(no) < 15:
            continue
        out[k] = (st.mean(yes), len(yes), tstat(yes))
        print(f"   {k:14s} TRUE  n={len(yes):4d} mean {st.mean(yes):+.3f} "
              f"(t={tstat(yes):+5.2f})   FALSE n={len(no):4d} mean {st.mean(no):+.3f} "
              f"(t={tstat(no):+5.2f})")
    return out


def tstat(xs):
    if len(xs) < 3:
        return 0.0
    sd = st.pstdev(xs) or 1e-9
    return st.mean(xs) / (sd / len(xs) ** 0.5)


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "../ictdata"
    cfg5 = Config(pivot_len=1, disp_atr=0.25, mss_window=6, killzone="rth")
    # 5m execution, HTF context at 15m / 30m / 1h / 4h / daily
    m5 = {"15m": 3, "30m": 6, "1h": 12, "4h": 48, "1d": 276}
    for sym in ("MNQ", "ES", "QQQ"):
        run_conditions(f"{data}/{sym}_5m.csv", sym, "5m", cfg5, 12, m5, f"{sym} 5m")
    # 1h series: 875 days, the only sample with real statistical power
    m1h = {"4h": 4, "1d": 23}
    for sym in ("MNQ", "ES"):
        run_conditions(f"{data}/{sym}_1h.csv", sym, "1h", cfg5, 4, m1h, f"{sym} 1h")
