#!/usr/bin/env python3
"""Put the S&P 500 CFD back on New York time in the weeks its clock is an hour off, using real MNQ as the reference.

usage: python3 -I spx_clock.py MNQ_NPZ SPX_IN_NPZ SPX_OUT_NPZ       (writes SPX_OUT_NPZ and SPX_OUT_NPZ.json)

The overnight trade's signal is the S&P 500 score of each session's 09:30-16:00 bars (engine.score_series), so the S&P
input must be on New York time. HistData's CFD drifts by an hour in some weeks between the US and the European clock
changes. Week by week (Monday to Friday, by MNQ's bars), the 5-minute returns of the CFD are correlated with real MNQ's
with the CFD's clock as it is and moved by an hour either way. A week is moved when one shift fits clearly better (a
correlation above 0.8, at least 0.2 above the unshifted one); all its bars from the Sunday open to the Friday close
move by that hour. Weeks with too few common bars are left alone. The .json lists every moved week and the
correlations before and after.
"""
import datetime as dt
import json
import sys

import numpy as np

EP = dt.datetime(1970, 1, 1)


def five(t, c):
    g = t // 5 * 5
    last = np.r_[g[1:] != g[:-1], True]
    return g[last], c[last]


def corr(mt, mc, st, sc, sh):
    cm, a, b = np.intersect1d(mt + sh, st, return_indices=True)
    k = np.flatnonzero((np.diff(cm) == 5) & (np.diff(a) == 1) & (np.diff(b) == 1))
    if len(k) < 200:
        return None
    return float(np.corrcoef(mc[a[k + 1]] - mc[a[k]], sc[b[k + 1]] - sc[b[k]])[0, 1])


def main(mnq, spx_in, out):
    m, s = np.load(mnq), np.load(spx_in)
    mt, mc = m["t"], m["c"]
    t, o, h, l, c = (s[k].copy() for k in ("t", "o", "h", "l", "c"))
    st5, sc5 = five(t, c)
    wk = (mt // 1440 + 3) // 7                      # weeks starting Monday 00:00
    moved = []
    for w in np.unique(wk):
        sel = wk == w
        r = {sh: corr(mt[sel], mc[sel], st5, sc5, sh) for sh in (-60, 0, 60)}
        if r[0] is None or r[-60] is None or r[60] is None:
            continue
        best = max((-60, 60), key=lambda x: r[x])
        if r[best] > 0.8 and r[best] > r[0] + 0.2:
            mon = int(w) * 7 * 1440 - 3 * 1440       # Monday 00:00 of week w
            a, b = mon - 1440, mon + 5 * 1440        # Sunday 00:00 to Saturday 00:00 (the CFD's own clock)
            idx = (t >= a) & (t < b)
            moved.append(dict(week_of=str((EP + dt.timedelta(minutes=mon)).date()), shift_minutes=-best,
                              bars=int(idx.sum()), corr_before=round(r[0], 3), corr_shifted=round(r[best], 3)))
            t[idx] = t[idx] - best                   # MNQ's bar at x matched the CFD's labelled x + best: its true time is label - best
    order = np.argsort(t, kind="stable")
    t, o, h, l, c = t[order], o[order], h[order], l[order], c[order]
    assert np.all(np.diff(t) > 0), "moving a week made two bars share a minute"
    st5, sc5 = five(t, c)
    for mv in moved:
        mon = int((dt.datetime.fromisoformat(mv["week_of"]) - EP).total_seconds() // 60)
        sel = (mt >= mon) & (mt < mon + 5 * 1440)
        mv["corr_after"] = round(corr(mt[sel], mc[sel], st5, sc5, 0), 3)
    np.savez_compressed(out, t=t, o=o, h=h, l=l, c=c)
    json.dump(dict(source=spx_in.split("/")[-1], reference=mnq.split("/")[-1], moved_weeks=moved), open(out + ".json", "w"), indent=1)
    print(json.dumps(moved, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:4])
