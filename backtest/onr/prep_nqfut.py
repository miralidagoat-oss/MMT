#!/usr/bin/env python3
"""Real NQ futures 5-minute bars from a CSV export (Time,Open,High,Low,Close,Volume; "M/D/YYYY H:MM") -> engine .npz,
then the gap after its end filled with the CFD and real MNQ futures.

usage: python3 -I prep_nqfut.py NQ_CSV NSXUSD_NPZ MNQ_5M_NPZ OUT_NPZ
Writes OUT_NPZ (t in New York wall-clock minutes, bar-open labels, 5-minute bars) and OUT_NPZ.json (what was done).

The export this was written for (NQ_5Years_8_11_2024.csv, Aug 11 2019 -> Aug 9 2024) needs three repairs:
- Labels are bar END times: the busiest bars are labelled 09:35 and 08:35 (the 09:30 open and the 08:30 news) and
  sessions run 18:05 -> 17:00. Every label moves back 5 minutes to the bar's open.
- For most of Aug 2019 - Nov 2022 its clock is Central European time: New York + 6 hours (+ 5 in the weeks the
  US and Europe change clocks on different dates). There its 5-minute moves match the market only once shifted
  (correlation with the CFD 0.99 vs 0.0-0.2 unshifted), and every day has two 65-minute holes: the real CME halt
  (23:00-00:05 on its clock) and 17:00-18:05 on its clock, i.e. 11:00-12:05 or 12:00-13:05 New York time. The
  export seems to have dropped "17:00-18:00" assuming New York time. Each contiguous block of bars (between gaps of
  45 minutes or more) gets the whole-hour offset from -2 to +8 that best matches the CFD's 5-minute moves; a block
  is kept only if that correlation is at least 0.80 with 24 or more returns, otherwise its bars are dropped (and the
  CFD takes their place below).
- 5-minute bars still missing inside 09:30-16:00 New York time on a session the file covers (above all that dropped
  hour) are filled from the CFD, moved to the futures' price level by the session's median futures - CFD
  difference. The count of filled bars is reported by year.
After that the series is checked against the CFD month by month (5-minute return correlation of the real futures
bars only).

The series is additively back-adjusted (a constant per contract period is added to earlier prices), which keeps every
move and range in points, so the strategy is unaffected. It ends with the session of Aug 9 2024; the sessions after
it come from the HistData NSXUSD CFD (1-minute bars made into 5-minute bars) until the day before the real MNQ file
(Yahoo, 5-minute) begins, then from that file. Every join is at a session start (18:00 ET), so no trade spans one.
"""
import csv
import datetime as dt
import json
import sys

import numpy as np

EP = dt.datetime(1970, 1, 1)


def read_csv(path):
    rows = list(csv.reader(open(path)))
    assert rows[0][:5] == ["Time", "Open", "High", "Low", "Close"], rows[0]
    t = np.array([int((dt.datetime.strptime(r[0], "%m/%d/%Y %H:%M") - EP).total_seconds() // 60) for r in rows[1:]])
    o, h, l, c = (np.array([float(r[i]) for r in rows[1:]]) for i in (1, 2, 3, 4))
    return t, o, h, l, c


def cfd_close_at(nt, nc):
    """Close of the CFD's 1-minute bar at minute m (bar open), or NaN."""
    def f(m):
        i = np.searchsorted(nt, m)
        ok = (i < len(nt)) & (nt[np.minimum(i, len(nt) - 1)] == m)
        return np.where(ok, nc[np.minimum(i, len(nt) - 1)], np.nan)
    return f


def block_offsets(t_open, c, cfd):
    """Whole-hour clock offset of each contiguous block of bars (gaps of 45+ minutes split blocks), chosen by the
    correlation of the block's 5-minute returns with the CFD's at the shifted times. t_open: file clock, bar open."""
    gap = np.diff(t_open) >= 45
    ends = np.r_[np.where(gap)[0], len(t_open) - 1]
    starts = np.r_[0, ends[:-1] + 1]
    off = np.full(len(t_open), np.nan)
    stats = []
    for a, b in zip(starts, ends):
        tt, cc = t_open[a:b + 1], c[a:b + 1]
        step = np.diff(tt) == 5
        if step.sum() < 24:
            stats.append((a, b, None, np.nan))
            continue
        fr = np.diff(np.log(cc))[step]
        best = (np.nan, None)
        for h in range(-2, 9):
            m1 = tt[1:][step] - 60 * h + 4      # each 5-minute bar's last minute, shifted to New York time
            m0 = tt[:-1][step] - 60 * h + 4
            x1, x0 = cfd(m1), cfd(m0)
            ok = np.isfinite(x1) & np.isfinite(x0)
            if ok.sum() >= 24:
                r = np.corrcoef(fr[ok], np.log(x1[ok] / x0[ok]))[0, 1]
                if not np.isfinite(best[0]) or r > best[0]:
                    best = (r, h)
        stats.append((a, b, best[1], best[0]))
        if best[1] is not None and best[0] >= 0.80:
            off[a:b + 1] = best[1]
    return off, stats


def resample5(t, o, h, l, c):
    g = t - t % 5
    ks, idx = np.unique(g, return_index=True)
    ends = np.r_[idx[1:], len(t)]
    return (ks, o[idx], np.maximum.reduceat(h, idx), np.minimum.reduceat(l, idx), c[ends - 1])


def sess_start(t):
    """The 18:00 ET start of the session containing minute t (sessions run 18:00 -> 17:00)."""
    return t - ((t % 1440) - 1080) % 1440


def main(src, cfd_path, mnq_path, out):
    t_lab, o, h, l, c = read_csv(src)
    z = np.load(cfd_path)
    nt, no, nh, nl, nc = z["t"].astype(np.int64), z["o"], z["h"], z["l"], z["c"]
    cfd = cfd_close_at(nt, nc)
    t_open = t_lab - 5                                       # labels are bar end times
    off, stats = block_offsets(t_open, c, cfd)
    kept = np.isfinite(off)
    blocks = dict(total=len(stats), kept=int(sum(1 for s in stats if s[2] is not None and s[3] >= 0.80)))
    by_off = {}
    for a, b, hh, r in stats:
        if hh is not None and r >= 0.80:
            by_off[f"{hh:+d}h"] = by_off.get(f"{hh:+d}h", 0) + int(b - a + 1)
    t = (t_open - np.nan_to_num(off) * 60).astype(np.int64)[kept]
    o, h, l, c = o[kept], h[kept], l[kept], c[kept]
    order = np.argsort(t, kind="stable")
    t, o, h, l, c = t[order], o[order], h[order], l[order], c[order]
    keep = np.r_[True, np.diff(t) > 0]                       # a clock change can repeat a minute: keep the first
    t, o, h, l, c = t[keep], o[keep], h[keep], l[keep], c[keep]
    info = dict(source=src, rows=int(len(t_lab)), blocks=blocks, bars_kept_by_offset=by_off,
                bars_dropped_unaligned=int((~kept).sum()), bars_after_repair=int(len(t)),
                first=str(EP + dt.timedelta(minutes=int(t[0]))), last=str(EP + dt.timedelta(minutes=int(t[-1]))))
    # check against the CFD, month by month (real futures bars only)
    pos = {int(x): i for i, x in enumerate(nt)}
    fut = dict(zip(t.tolist(), c.tolist()))
    months = {}
    for m in t.tolist():
        if m - 5 in fut:
            j1, j0 = pos.get(m + 4), pos.get(m - 1)
            if j1 is not None and j0 is not None:
                months.setdefault((EP + dt.timedelta(minutes=m)).strftime("%Y-%m"), []).append(
                    (np.log(fut[m] / fut[m - 5]), np.log(nc[j1] / nc[j0])))
    corr = {k: round(float(np.corrcoef(np.array(v).T)[0, 1]), 3) for k, v in sorted(months.items()) if len(v) > 100}
    info["monthly_corr_with_cfd"] = corr
    info["months_below_0.90"] = [k for k, v in corr.items() if v < 0.90]
    # fill 5-minute bars missing inside 09:30-16:00 ET of the sessions the futures cover, from the CFD at the futures' level
    ct5, co5, ch5, cl5, cc5 = resample5(nt, no, nh, nl, nc)
    c5 = {int(m): i for i, m in enumerate(ct5)}
    sess = sess_start(t)
    have = set(t.tolist())
    add_t, add = [], []
    filled_by_year = {}
    for s0 in np.unique(sess):
        sel = sess == s0
        rth = [int(s0) + 930 + 5 * k for k in range(78)]            # 09:30 ... 15:55 bar opens (minutes after 18:00 = 930)
        tt = t[sel]
        if not any(r in have for r in rth):
            continue                                          # no RTH from the futures that day: nothing to fill
        both = [m for m in tt.tolist() if m in c5]
        if len(both) < 12:
            continue
        diff = float(np.median([fut[m] - cc5[c5[m]] for m in both]))
        for m in rth:
            if m not in have and m in c5:
                i = c5[m]
                add_t.append(m)
                add.append((co5[i] + diff, ch5[i] + diff, cl5[i] + diff, cc5[i] + diff))
                y = (EP + dt.timedelta(minutes=int(m))).year
                filled_by_year[y] = filled_by_year.get(y, 0) + 1
    if add_t:
        t = np.r_[t, np.array(add_t)]
        a = np.array(add)
        o, h, l, c = np.r_[o, a[:, 0]], np.r_[h, a[:, 1]], np.r_[l, a[:, 2]], np.r_[c, a[:, 3]]
        order = np.argsort(t, kind="stable")
        t, o, h, l, c = t[order], o[order], h[order], l[order], c[order]
    rth_total = {}
    for m in t.tolist():
        tm = EP + dt.timedelta(minutes=m)
        if (9 * 60 + 30) <= tm.hour * 60 + tm.minute < 16 * 60:
            rth_total[tm.year] = rth_total.get(tm.year, 0) + 1
    info["rth_bars_filled_from_cfd"] = {str(y): f"{filled_by_year.get(y, 0)} of {rth_total[y]}" for y in sorted(rth_total)}
    # the fill: CFD (5-minute) from the next session start, then real MNQ from its first session start
    fut_end = int(sess_start(t[-1]) + 1440)                  # the session after the futures' last one
    zm = np.load(mnq_path)
    mt = zm["t"].astype(np.int64)
    mnq_start = int(sess_start(mt[0]) + (1440 if (mt[0] - sess_start(mt[0])) > 0 else 0))
    sel = (nt >= fut_end) & (nt < mnq_start)
    ct, co, ch, cl, cc = resample5(nt[sel], no[sel], nh[sel], nl[sel], nc[sel])
    ms = mt >= mnq_start
    parts = [(t, o, h, l, c), (ct, co, ch, cl, cc), (mt[ms], zm["o"][ms], zm["h"][ms], zm["l"][ms], zm["c"][ms])]
    T, O, H, L, C = (np.concatenate([p[i] for p in parts]) for i in range(5))
    assert np.all(np.diff(T) > 0)
    info["segments"] = [dict(name=n, bars=int(len(p[0])), first=str(EP + dt.timedelta(minutes=int(p[0][0]))),
                             last=str(EP + dt.timedelta(minutes=int(p[0][-1])))) for n, p in
                        zip(("NQ futures (this CSV)", "HistData NSXUSD CFD, 5-minute", "Yahoo MNQ=F futures, 5-minute"), parts)]
    np.savez_compressed(out, t=T, o=O, h=H, l=L, c=C)
    json.dump(info, open(out + ".json", "w"), indent=1)
    print(json.dumps({k: v for k, v in info.items() if k != "monthly_corr_with_cfd"}, indent=1))
    print("monthly 5-minute correlation with the CFD:", " ".join(f"{k}:{v}" for k, v in corr.items()))


if __name__ == "__main__":
    main(*sys.argv[1:5])
