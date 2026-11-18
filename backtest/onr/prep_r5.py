#!/usr/bin/env python3
"""Round 5 data: gold and crude 1-minute bars -> New York wall-clock .npz files (PREREG_R5.md and its addendum).

usage: prep_r5.py gold  HISTDATA_DIR YAHOO_DIR OUT_DIR DUKASCOPY_GOLD_DIR
       prep_r5.py crude HISTDATA_DIR YAHOO_DIR OUT_DIR DUKASCOPY_CRUDE_DIR

Gold = HistData XAUUSD for the whole span. Its clock convention is chosen by the correlation of 5-minute moves with
real futures (Yahoo GC=F, last 60 days), separately for daylight-saving and standard weeks.

Crude = HistData WTIUSD up to the session that starts 2023-11-30 18:00 ET (HistData's file ends on 2023-12-01), then
Dukascopy LIGHT.CMD/USD (UTC 1-minute bid candles, zero-volume minutes dropped). HistData's clock convention is chosen
against Dukascopy over Jan-Nov 2023; Dukascopy is checked against Yahoo CL=F (last 60 days).

HistData's notes say its bars are labelled in fixed EST (UTC-5); its index CFDs turned out to be in New York time,
with the sessions of the US/European daylight-saving mismatch weeks labelled an hour early (prep_data.py), so all three
readings are scored. Prices are scaled so one point = $2 per micro contract: gold x5 (MGC $10 per $1),
crude x50 (MCL $100 per $1).
"""
import datetime as dt
import glob
import json
import lzma
import os
import struct
import sys
from zoneinfo import ZoneInfo

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prep_data import fix_dst_mismatch, load_histdata  # noqa: E402

NY = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")
EPOCH = dt.datetime(1970, 1, 1)


def ny_dst_days(days):
    """{day number since 1970: True if New York is on daylight saving time at noon that day}."""
    out = {}
    for d in np.unique(days):
        date = dt.date(1970, 1, 1) + dt.timedelta(days=int(d))
        out[int(d)] = bool(dt.datetime(date.year, date.month, date.day, 12, tzinfo=NY).dst())
    return out


def convert(t, convention):
    """File labels -> New York wall-clock minutes. 'ny': already New York time. 'ny+fix': New York time, except the
    sessions labelled an hour early (opening at 17:00), moved +60 minutes as for the index CFDs (prep_data.py: the
    weeks when US and European daylight saving differ). 'est': fixed UTC-5 labels, so add 60 minutes while New York is
    on daylight saving time."""
    if convention == "ny":
        return t.copy()
    if convention == "ny+fix":
        t2, order, _ = fix_dst_mismatch(t)
        out = np.empty_like(t)
        out[order] = t2  # same positions as the input, so the caller's columns still line up
        return out
    shifted = t + 60
    flag = ny_dst_days(shifted // 1440)
    dst = np.array([flag[int(d)] for d in shifted // 1440])
    return np.where(dst, shifted, t)


def buckets5(t_ny, c):
    """{5-minute bucket start: close of the last 1-minute bar in it}."""
    b = t_ny // 5 * 5
    last = np.r_[b[1:] != b[:-1], True]
    return dict(zip(b[last].tolist(), c[last].tolist()))


def yahoo(path):
    r = json.load(open(path))["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    rows = {}
    for i, ts in enumerate(r["timestamp"]):
        c = q["close"][i]
        if c is None:
            continue
        loc = dt.datetime.fromtimestamp(int(ts), NY).replace(tzinfo=None)
        rows[int((loc - EPOCH).total_seconds() // 60)] = c
    return rows  # 5-minute bar open time -> close


def score(cfd, ref):
    """Correlation of 5-minute close-to-close moves on the buckets both series have, by daylight-saving state."""
    common = sorted(k for k in set(cfd) & set(ref) if (k - 5) in cfd and (k - 5) in ref)
    flag = ny_dst_days(np.array(common) // 1440) if common else {}
    out = {}
    for lab, want in (("daylight saving", True), ("standard time", False)):
        sel = [k for k in common if flag[k // 1440] == want]
        if len(sel) < 50:
            out[lab] = (float("nan"), len(sel))
            continue
        a = np.array([cfd[k] - cfd[k - 5] for k in sel])
        b = np.array([ref[k] - ref[k - 5] for k in sel])
        out[lab] = (float(np.corrcoef(a, b)[0, 1]), len(sel))
    return out


def choose(sym, t, c, ref, label):
    best = None
    for conv in ("ny", "ny+fix", "est"):
        tn = convert(t, conv)
        sc = score(buckets5(tn, c), ref)
        print(f"{sym} convention {conv:6s} vs {label}: " + " | ".join(f"{k} corr {v[0]:.3f} (n {v[1]})" for k, v in sc.items()),
              flush=True)
        worst = min(v[0] for v in sc.values())
        if best is None or worst > best[0]:
            best = (worst, conv, tn)
    print(f"{sym}: chose '{best[1]}' (lowest of the two correlations {best[0]:.3f})", flush=True)
    return best[1], best[2]


def dukascopy(ddir, sym):
    """Dukascopy BID_candles_min_1 day files -> (New York wall-clock minutes, dict of o h l c). Zero-volume minutes
    (market shut) are dropped. Record: time offset s, open, close, low, high (x1000), volume (float), big-endian."""
    ts, cols = [], {k: [] for k in "ohlc"}
    for fn in sorted(glob.glob(os.path.join(ddir, f"{sym}_*.bi5"))):
        day = dt.date.fromisoformat(os.path.basename(fn)[len(sym) + 1:-4])
        raw = open(fn, "rb").read()
        if not raw:
            continue
        b = lzma.decompress(raw)
        off = dt.datetime(day.year, day.month, day.day, 12, tzinfo=UTC).astimezone(NY).utcoffset()
        base = int((dt.datetime(day.year, day.month, day.day) + off - EPOCH).total_seconds() // 60)  # 00:00 UTC in NY minutes
        for i in range(len(b) // 24):
            s, o, c, lo, hi, v = struct.unpack(">5if", b[24 * i:24 * i + 24])
            if v <= 0:
                continue
            ts.append(base + s // 60)
            for k, x in zip("ohlc", (o, hi, lo, c)):
                cols[k].append(x / 1000.0)
    t = np.array(ts, "int64")
    order = np.argsort(t, kind="stable")
    t = t[order]
    keep = np.r_[True, np.diff(t) > 0]
    return t[keep], {k: np.array(v)[order][keep] for k, v in cols.items()}


def save(out, sym, t, cols, scale):
    np.savez_compressed(os.path.join(out, f"{sym}.npz"), t=t, **{k: v * scale for k, v in cols.items()})
    print(f"{sym}: {len(t)} bars {np.datetime64(int(t[0]), 'm')} -> {np.datetime64(int(t[-1]), 'm')}, prices x{scale:g}",
          flush=True)


def coverage(t, window):
    """{calendar day: minutes present in the day-session window [a, b) (minutes after midnight)}, weekdays with bars."""
    a, b = window
    tod, dn = t % 1440, t // 1440
    wk = (dn + 3) % 7 < 5  # Mon-Fri (1970-01-01 was a Thursday)
    days = np.unique(dn[wk])
    sel = wk & (tod >= a) & (tod < b)
    d2, cnt = np.unique(dn[sel], return_counts=True)
    cov = dict.fromkeys(days.tolist(), 0)
    cov.update(dict(zip(d2.tolist(), cnt.tolist())))
    return cov


def repair(sym, t, cols, window, td, cd):
    """Days with < 90% of the day-session minutes: fill that day session from Dukascopy where Dukascopy has >= 90% of
    it (shifted by the median level difference on the complete days both have), else remove that day session
    (PREREG_R5.md, data quality note). t must be sorted and unique."""
    a, b = window
    need = 0.9 * (b - a)
    ch, cdu = coverage(t, window), (coverage(td, window) if td is not None else {})
    bad = sorted(d for d, n in ch.items() if n < need)
    both = sorted(d for d, n in ch.items() if n >= need and cdu.get(d, 0) >= need)
    off = 0.0
    if both:
        hsel, dsel = np.isin(t // 1440, both), np.isin(td // 1440, both)
        hi = dict(zip(t[hsel].tolist(), cols["c"][hsel].tolist()))
        du = dict(zip(td[dsel].tolist(), cd["c"][dsel].tolist()))
        com = sorted(set(hi) & set(du))
        diff = np.array([hi[k] - du[k] for k in com])
        off = float(np.median(diff))
        sc = score(buckets5(t[hsel], cols["c"][hsel]), buckets5(td[dsel], cd["c"][dsel]))
        print(f"{sym}: HistData vs Dukascopy on the {len(both)} complete days both have: "
              + " | ".join(f"{k} corr {v[0]:.3f} (n {v[1]})" for k, v in sc.items())
              + f"; level HistData - Dukascopy median {off:+.3f} (5th-95th pct {np.percentile(diff, 5):+.3f} / "
              f"{np.percentile(diff, 95):+.3f}, {len(diff)} minutes)", flush=True)
    fill = [d for d in bad if cdu.get(d, 0) >= need]
    drop = [d for d in bad if cdu.get(d, 0) < need]
    tod, dn = t % 1440, t // 1440
    out_ds = ~(np.isin(dn, bad) & (tod >= a) & (tod < b))
    T = [t[out_ds]]
    C = {k: [v[out_ds]] for k, v in cols.items()}
    if fill:
        tdd, ddn = td % 1440, td // 1440
        sel = np.isin(ddn, fill) & (tdd >= a) & (tdd < b)
        T.append(td[sel])
        for k in C:
            C[k].append(cd[k][sel] + off)
    T = np.concatenate(T)
    order = np.argsort(T, kind="stable")
    T = T[order]
    C = {k: np.concatenate(v)[order] for k, v in C.items()}
    keep = np.r_[True, np.diff(T) > 0]
    by_year = {}
    for d in bad:
        y = str(np.datetime64(int(d), "D"))[:4]
        by_year.setdefault(y, [0, 0])[0 if d in set(fill) else 1] += 1
    print(f"{sym}: {len(bad)} weekdays with < 90% of the day session: filled from Dukascopy {len(fill)}, day session "
          f"removed {len(drop)}; by year (filled, removed) {by_year}", flush=True)
    print(f"{sym}: removed days outside the Dukascopy download: "
          + ", ".join(str(np.datetime64(int(d), "D")) for d in drop if d not in cdu)[:600], flush=True)
    return T[keep], {k: v[keep] for k, v in C.items()}


def gold(raw, ydir, out, gdir):
    t, cols = load_histdata(raw, "XAUUSD")
    _, tn = choose("XAUUSD", t, cols["c"], yahoo(os.path.join(ydir, "GCF_5m.json")), "Yahoo GC=F")
    order = np.argsort(tn, kind="stable")
    tn = tn[order]
    keep = np.r_[True, np.diff(tn) > 0]
    tn, cols = tn[keep], {k: v[order][keep] for k, v in cols.items()}
    td, cd = dukascopy(gdir, "XAUUSD")
    print(f"Dukascopy XAUUSD: {len(td)} bars {np.datetime64(int(td[0]), 'm')} -> {np.datetime64(int(td[-1]), 'm')}",
          flush=True)
    tn, cols = repair("XAUUSD", tn, cols, (500, 810), td, cd)
    save(out, "XAUUSD", tn, cols, 5.0)


def crude(raw, ydir, out, ddir):
    td, cd = dukascopy(ddir, "LIGHTCMDUSD")
    print(f"Dukascopy LIGHTCMDUSD: {len(td)} bars {np.datetime64(int(td[0]), 'm')} -> {np.datetime64(int(td[-1]), 'm')}",
          flush=True)
    sc = score(buckets5(td, cd["c"]), yahoo(os.path.join(ydir, "CLF_5m.json")))
    print("Dukascopy vs Yahoo CL=F: " + " | ".join(f"{k} corr {v[0]:.3f} (n {v[1]})" for k, v in sc.items()), flush=True)
    t, cols = load_histdata(raw, "WTIUSD")
    a, b = int(np.datetime64("2023-01-01T00:00").astype("datetime64[m]").astype("int64")), \
        int(np.datetime64("2023-11-30T18:00").astype("datetime64[m]").astype("int64"))
    ref = {k: v for k, v in buckets5(td, cd["c"]).items() if a <= k < b}
    conv, tn = choose("WTIUSD", t, cols["c"], ref, "Dukascopy Jan-Nov 2023")
    order = np.argsort(tn, kind="stable")
    tn = tn[order]
    cols = {k: v[order] for k, v in cols.items()}
    keep = np.r_[True, np.diff(tn) > 0]
    tn, cols = tn[keep], {k: v[keep] for k, v in cols.items()}
    h = tn < b
    tn, cols = repair("WTIUSD (HistData part)", tn[h], {k: v[h] for k, v in cols.items()}, (540, 870), td, cd)
    d = td >= b
    td2, cd2 = repair("WTIUSD (Dukascopy part)", td[d], {k: v[d] for k, v in cd.items()}, (540, 870), None, None)
    t_all = np.r_[tn, td2]
    c_all = {k: np.r_[cols[k], cd2[k]] for k in "ohlc"}
    print(f"stitch at {np.datetime64(b, 'm')} ET: HistData {len(tn)} bars, Dukascopy {len(td2)} bars", flush=True)
    save(out, "WTIUSD", t_all, c_all, 50.0)


if __name__ == "__main__":
    if sys.argv[1] == "gold":
        gold(*sys.argv[2:6])
    else:
        crude(*sys.argv[2:6])
