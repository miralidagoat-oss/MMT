#!/usr/bin/env python3
"""Fill the S&P 500 day sessions that HistData's CFD lacks with Dukascopy's S&P 500 CFD, so that every session the
backtest trades has its own overnight score.

usage: python3 -I fill_spx.py SPX_IN_NPZ DUKA_DIR MNQ_NPZ OUT_NPZ
  SPX_IN_NPZ   the S&P input after spx_clock.py (its .json, the moved weeks, is carried into OUT_NPZ.json)
  DUKA_DIR     Dukascopy USA500IDXUSD_<day>.bi5 minute files (UTC days, fetch_dukascopy.py) for every session to fill
               and for the sessions around them
  MNQ_NPZ      the user's MNQ file (prep_mnq.py)

The overnight trade's signal is the S&P 500 score of the day session before it (engine.score_series), and a score exists
only for a full session (13 half-hour buckets from 09:30 to 16:00). On the user's MNQ file 119 sessions had no full S&P
session behind them, so the overnight trade after each was skipped, and the scores after the long 2023 gap took their
60-session features across it:
  - Feb 21 - Jul 28 2023: HistData's SPXUSD misses most of the day session (as its NSXUSD does);
  - 8 days of Mar 2020: HistData's clock is an hour early (between the US and European clock changes) and its day
    session has 12 of the 13 buckets;
  - Nov 30 2020: no bars; Jan 8 and Jan 12 2024: 7 buckets.
The live indicator reads OANDA's SPX500USD, which has these sessions.

Dukascopy's day files are UTC, so their New York times are exact, and where HistData is complete and on time its bars
are Dukascopy's to the cent (check 1). A session is filled when MNQ's day session is full and the CFD's is not: all of
the CFD's bars of that session (18:00 to 17:00 ET) are replaced with Dukascopy's, plus the level shift of the complete
sessions both have among the 5 on each side (the median of CFD close - Dukascopy close on their shared minutes; 0 when
they are identical). The broken session's own bars are not used for the shift: they are partial or off the clock. A
complete session whose bars differ from Dukascopy's on more than 10% of their shared minutes (the CFD's clock off) is
replaced the same way; the json lists those as differing_replaced.

Checks, written to OUT_NPZ.json and printed:
  1. every complete session both sources have (the days downloaded around the gaps, and the Oct 28 2019 week, a US / Europe
     clock-change week inside the first scores' 60-session lookback, before MNQ's first session): the share of their shared
     minutes whose open, high, low and close are identical in both sources, and each session's score with its bars replaced
     alone by Dukascopy's, against the CFD's own (as prep_spx_ext.py checks the sessions after HistData's end);
  2. the 5-minute moves of the filled sessions against MNQ's (spx_clock.py's correlation), gap by gap;
  3. every session MNQ has: the day session's 5-minute moves against MNQ's at the recorded time and an hour either way;
     a session where another hour fits clearly better (r above 0.8 and 0.2 above the recorded time) is listed;
  4. the MNQ sessions after a full MNQ day session whose S&P session is not full (no score for that evening), before
     and after the fill.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import THR, load_npz, rth_sessions, score_series, sess_cols  # noqa: E402
from prep_r5 import dukascopy  # noqa: E402
from spx_clock import corr, five  # noqa: E402

NEAR = 5          # complete sessions on each side for the level shift
RTH = (930, 1320)  # 09:30-16:00 in minutes after 18:00


def iso(d):
    return str(np.datetime64(int(d), "D"))


def side(x):
    return "none" if not np.isfinite(x) else "buy" if x >= THR else "sell" if x <= -THR else "none"


def shifted(r, off):
    return dict(o=r["o"] + off, h=r["h"] + off, l=r["l"] + off, c=r["c"] + off, onl=r["onl"] + off, nb=r["nb"])


def no_fresh_score(srth, mrth):
    """MNQ day sessions (full) whose S&P session - the last of any kind before the next MNQ session, as engine.Sessions
    reads it - is not full: the overnight trade of that evening has no score."""
    sk = np.array(sorted(srth))
    md = sorted(mrth)
    out = []
    for p, d in zip(md, md[1:]):
        if mrth[p]["nb"] < 13:
            continue
        j = np.searchsorted(sk, d) - 1
        if j < 0 or srth[int(sk[j])]["nb"] < 13:
            out.append(int(p))
    return out


def rth_clock(mt, mc, T, C):
    """Per MNQ session: r of the day session's 5-minute moves against the S&P's at shifts -60, 0, +60 minutes."""
    st5, sc5 = five(T, C)
    pos = {int(x): i for i, x in enumerate(st5.tolist())}
    ms, md = sess_cols(mt)
    out = {}
    for d in np.unique(md):
        sel = np.flatnonzero((md == d) & (ms >= RTH[0]) & (ms < RTH[1]))
        if len(sel) < 40:
            continue
        xs, ys = mt[sel], mc[sel]
        r = {}
        for sh in (-60, 0, 60):
            pr = [(ys[i + 1] - ys[i], sc5[pos[int(xs[i + 1]) + sh]] - sc5[pos[int(xs[i]) + sh]])
                  for i in range(len(xs) - 1) if xs[i + 1] - xs[i] == 5 and int(xs[i]) + sh in pos
                  and int(xs[i + 1]) + sh in pos and pos[int(xs[i + 1]) + sh] == pos[int(xs[i]) + sh] + 1]
            p = np.array(pr)
            r[sh] = float(np.corrcoef(p[:, 0], p[:, 1])[0, 1]) if len(p) >= 30 and p[:, 0].std() > 0 and p[:, 1].std() > 0 else None
        out[int(d)] = r
    return out


def main(spx_in, duka, mnq, out):
    t, o, h, l, c = load_npz(spx_in)
    mt, mo, mh, ml, mc = load_npz(mnq)
    et, ecols = dukascopy(duka, "USA500IDXUSD")
    eo, eh, el, ec = (ecols[k] for k in "ohlc")
    print(f"Dukascopy: {len(et)} minute bars {np.datetime64(int(et[0]), 'm')} -> {np.datetime64(int(et[-1]), 'm')} (New York)")
    _, sday = sess_cols(t)
    _, eday = sess_cols(et)
    srth = rth_sessions(t, o, h, l, c)
    mrth = rth_sessions(mt, mo, mh, ml, mc)
    erth = rth_sessions(et, eo, eh, el, ec)
    full_s = {d for d, r in srth.items() if r["nb"] >= 13}
    full_e = {d for d, r in erth.items() if r["nb"] >= 13}
    want = sorted(d for d, r in mrth.items() if r["nb"] >= 13 and d not in full_s)
    fill = [d for d in want if d in full_e]
    left = [d for d in want if d not in full_e]
    both = sorted(full_s & full_e)          # complete in both sources
    print(f"MNQ full day sessions without a full S&P session: {len(want)}; Dukascopy has {len(fill)} of them full"
          + (f"; NOT FILLED: {[iso(d) for d in left]}" if left else ""))

    # shared minutes of a session: CFD bar index and Dukascopy bar index
    cpos = {int(x): i for i, x in zip(np.flatnonzero(np.isin(sday, both)).tolist(), t[np.isin(sday, both)].tolist())}

    def shared(d):
        sel = np.flatnonzero(eday == d)
        k = [(cpos[x], i) for x, i in zip(et[sel].tolist(), sel.tolist()) if x in cpos]
        return np.array([p for p, _ in k], int), np.array([i for _, i in k], int)

    # level shift of each filled session: the complete sessions both have among the NEAR on each side
    offs, near_of = {}, {}
    for d in fill:
        j = int(np.searchsorted(both, d))
        near = both[max(0, j - NEAR):j] + both[j:j + NEAR]
        diffs = np.concatenate([c[a] - ec[b] for a, b in map(shared, near)])
        assert len(diffs) >= 500, f"too few shared minutes near {iso(d)}"
        offs[d], near_of[d] = float(np.median(diffs)), near

    # gaps: runs of filled sessions with no complete CFD session between them
    gaps, cur = [], []
    for d in fill:
        if cur and any(cur[-1] < x < d for x in full_s):
            gaps.append(cur)
            cur = []
        cur.append(d)
    if cur:
        gaps.append(cur)

    # check 1: every complete session both sources have
    base, _ = score_series(srth)
    cal = both                              # every complete session both sources have (the downloaded days)
    cal_rows = []
    for x in cal:
        a, b = shared(x)
        same = (np.abs(o[a] - eo[b]) < 5e-4) & (np.abs(h[a] - eh[b]) < 5e-4) & (np.abs(l[a] - el[b]) < 5e-4) & (np.abs(c[a] - ec[b]) < 5e-4)
        row = dict(day=iso(x), shared_minutes=len(a), identical=round(float(same.mean()), 4),
                   cfd_only=int((sday == x).sum()) - len(a), dukascopy_only=int((eday == x).sum()) - len(a))
        if x in base and np.isfinite(base[x]):
            r2 = dict(srth)
            r2[x] = shifted(erth[x], 0.0)
            sc, _ = score_series(r2)
            row.update(score_cfd=round(float(base[x]), 4), score_dukascopy=round(float(sc[x]), 4),
                       same_signal=side(base[x]) == side(sc[x]))
        cal_rows.append(row)
    n_sh = sum(r["shared_minutes"] for r in cal_rows)
    n_id = sum(r["shared_minutes"] * r["identical"] for r in cal_rows)
    scored = [r for r in cal_rows if "score_cfd" in r]
    dif = np.array([abs(r["score_cfd"] - r["score_dukascopy"]) for r in scored])
    cal_sum = dict(sessions=len(cal_rows), shared_minutes=n_sh, identical=round(n_id / n_sh, 5),
                   cfd_only=sum(r["cfd_only"] for r in cal_rows), dukascopy_only=sum(r["dukascopy_only"] for r in cal_rows),
                   scored=len(scored), score_diff_max=round(float(dif.max()), 4),
                   same_signal=sum(r["same_signal"] for r in scored))
    print(f"check 1: {len(cal_rows)} complete sessions both sources have, {n_sh} shared minutes, "
          f"{100 * cal_sum['identical']:.2f}% identical to the cent (open, high, low, close); minutes only in the CFD "
          f"{cal_sum['cfd_only']}, only in Dukascopy {cal_sum['dukascopy_only']}; each replaced alone: score difference max "
          f"{cal_sum['score_diff_max']:.4f}, same signal {cal_sum['same_signal']} of {len(scored)}")
    # a complete session where the two disagree (HistData's clock off) is Dukascopy's too
    differ = [int(np.datetime64(r["day"], "D").astype(int)) for r in cal_rows if r["identical"] < 0.9]
    print(f"  complete sessions where HistData's bars differ from Dukascopy's on more than 10% of shared minutes: "
          f"{[r['day'] + ' (' + format(100 * r['identical'], '.0f') + '% identical)' for r in cal_rows if r['identical'] < 0.9]}")
    for d in differ:
        offs[d], near_of[d] = 0.0, []
        j = int(np.searchsorted(both, d))
        near = [x for x in both[max(0, j - NEAR - 1):j + NEAR + 1] if x not in differ][:2 * NEAR]
        diffs = np.concatenate([c[a] - ec[b] for a, b in map(shared, near)])
        offs[d], near_of[d] = float(np.median(diffs)), near
    fill = sorted(fill + differ)

    # the fill
    keep = ~np.isin(sday, fill)
    add = np.isin(eday, fill)
    shift = np.array([offs[int(d)] for d in eday[add]])
    assert np.all(eh[add] >= np.maximum(eo[add], ec[add])) and np.all(el[add] <= np.minimum(eo[add], ec[add]))
    T = np.r_[t[keep], et[add]]
    order = np.argsort(T, kind="stable")
    O, H, L, C = (np.r_[x[keep], y[add] + shift][order] for x, y in ((o, eo), (h, eh), (l, el), (c, ec)))
    T = T[order]
    assert np.all(np.diff(T) > 0), "two bars share a minute"
    frth = rth_sessions(T, O, H, L, C)
    assert all(frth[d]["nb"] >= 13 for d in fill)
    fsc, _ = score_series(frth)

    # check 2: the filled sessions' 5-minute moves against MNQ's, gap by gap
    st5, sc5 = five(T, C)
    _, mday = sess_cols(mt)
    gap_rows = []
    for g in gaps:
        sel = np.isin(mday, g)
        r = corr(mt[sel], mc[sel], st5, sc5, 0)
        gap_rows.append(dict(first=iso(g[0]), last=iso(g[-1]), sessions=len(g),
                             corr_with_mnq=None if r is None else round(r, 3),
                             level_shift=sorted({round(offs[d], 3) for d in g})))
        print(f"  gap {iso(g[0])} -> {iso(g[-1])}: {len(g)} filled, level shift {gap_rows[-1]['level_shift']}, "
              f"5-minute moves vs MNQ r = {gap_rows[-1]['corr_with_mnq']}")
    allr = corr(mt[np.isin(mday, fill)], mc[np.isin(mday, fill)], st5, sc5, 0)
    print(f"check 2: all {len(fill)} filled sessions, 5-minute moves vs MNQ r = {allr:.3f}")

    # check 3: every session's clock against MNQ's, before and after
    def off_clock(rc):
        bad = []
        for d, r in sorted(rc.items()):
            alt = max((x for x in (-60, 60) if r[x] is not None), key=lambda x: r[x], default=None)
            if alt is not None and r[alt] > 0.8 and (r[0] is None or r[alt] > r[0] + 0.2):
                bad.append(dict(day=iso(d), r_recorded=None if r[0] is None else round(r[0], 3), shift=alt,
                                r_shifted=round(r[alt], 3)))
        return bad
    clock0 = off_clock(rth_clock(mt, mc, t, c))
    rc1 = rth_clock(mt, mc, T, C)
    clock1 = off_clock(rc1)
    r0s = [r[0] for r in rc1.values() if r[0] is not None]
    print(f"check 3: day-session clock against MNQ on {len(rc1)} sessions: an hour off before the fill "
          f"{[b['day'] for b in clock0]}; after: {[b['day'] for b in clock1]}; median r at the recorded time "
          f"{np.median(r0s):.3f}")

    # check 4: sessions with no score for the evening, before and after
    nf0 = no_fresh_score(srth, mrth)
    nf1 = no_fresh_score(frth, mrth)
    print(f"check 4: full MNQ day sessions with no S&P score for that evening: {len(nf0)} before, {len(nf1)} after"
          + (f": {[iso(d) for d in nf1]}" if nf1 else ""))

    filled = [dict(day=iso(d), score=round(float(fsc[d]), 4), signal=side(fsc[d]),
                   cfd_buckets=int(srth[d]["nb"]) if d in srth else 0, dukascopy_buckets=int(erth[d]["nb"]),
                   level_shift=round(offs[d], 3), level_from=[iso(x) for x in near_of[d]]) for d in fill]
    meta = json.load(open(spx_in + ".json")) if os.path.exists(spx_in + ".json") else {}
    for w in meta.get("moved_weeks", []):
        mon = int(np.datetime64(w["week_of"], "D").astype(int))
        wk = [d for d in srth if mon <= d <= mon + 4]                 # Monday's to Friday's session
        w["sessions"] = len(wk)
        w["sessions_filled"] = sum(d in fill for d in wk)
    meta.update(fill_source="Dukascopy USA500IDXUSD 1-minute bid candles (fetch_dukascopy.py)",
                filled_sessions=filled, not_filled=[iso(d) for d in left], differing_replaced=[iso(d) for d in differ], gaps=gap_rows,
                check_neighbours=dict(summary=cal_sum, sessions=cal_rows), corr_filled_with_mnq=round(allr, 3),
                clock_off_before=clock0, clock_off_after=clock1,
                no_score_before=[iso(d) for d in nf0], no_score_after=[iso(d) for d in nf1],
                bars_removed=int((~keep).sum()), bars_added=int(add.sum()))
    np.savez_compressed(out, t=T, o=O, h=H, l=L, c=C)
    json.dump(meta, open(out + ".json", "w"), indent=1)
    print(f"wrote {out}: {len(T)} bars ({int((~keep).sum())} CFD bars of {len(fill)} sessions replaced by {int(add.sum())} "
          f"Dukascopy bars)")


if __name__ == "__main__":
    main(*sys.argv[1:5])
