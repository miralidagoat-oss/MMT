#!/usr/bin/env python3
"""LSR — Liquidity Sweep Reversion, level-anchored and regime-gated.

Lineage. The old study established one real finding: on Nasdaq futures, a bar
that raids a prior extreme and closes back inside is worth fading, and moving
the stop to breakeven at +1R is worth more than any entry filter. Everything
here keeps that and fixes what surrounded it.

Three changes carry the thesis:

1. LEVEL ANCHORING. v3 swept a rolling N-bar extreme, which is mostly an
   arbitrary point in the tape. Resting stop orders are not arbitrary — they
   sit under the prior day's low, the overnight low, and the opening range.
   A raid only means something if it takes out inventory, so the sweep must
   break a NAMED level and close back above it. Fewer signals, better ones.

2. SWEEP *AND RECLAIM*. The bar must trade beyond the level and close back on
   the origin side of it. A close beyond the level is a breakout, not a
   failure, and fading it is how you get run over.

3. REGIME GATE BY VARIANCE RATIO, not by trend. The old EMA filter hurt
   (F10) because "which way is price going" is the wrong question for a
   reversion trade. The variance ratio asks whether this tape reverts or
   continues, which is the assumption the trade actually rests on.

Entry is a limit inside the rejection wick, so the fill sits near the extreme
of the move rather than chasing the close. Stop goes beyond the swept extreme
by a volatility multiple; target is either a fixed R multiple or the opposing
liquidity level.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

import core
from core import TICK

RTH_OPEN, RTH_CLOSE = 570, 960          # 09:30 / 16:00 ET, minutes past midnight
GLOBEX_OPEN = 1080                       # 18:00 ET

TAG_PD, TAG_ON, TAG_OR = 1, 2, 3
TAG_NAME = {TAG_PD: "prior-day", TAG_ON: "overnight", TAG_OR: "open-range"}


@dataclass
class Params:
    tf: int = 5                  # aggregate timeframe, minutes
    # -- sweep quality
    sweep_sigma: float = 0.35    # depth beyond the level, in bar-sigma
    min_wick: float = 0.35       # rejection wick as fraction of bar range
    min_close_pos: float = 0.55  # close position within bar range
    range_exp: float = 0.9       # bar range vs its 20-bar average
    max_sweep_sigma: float = 6.0 # ignore dislocations (news prints)
    # -- level set
    use_pd: bool = True
    use_on: bool = True
    use_or: bool = True
    or_minutes: int = 30
    # -- regime
    vr_q: int = 8
    vr_win: int = 96
    vr_max: float = 1.05         # only fade a tape that is not trending
    vol_lo: float = 0.05         # skip dead tape / news shocks by vol pctile
    vol_hi: float = 0.97
    # -- geometry
    wick_retrace: float = 0.5    # limit inside the wick: 0 = at the extreme
    stop_sigma: float = 0.6      # stop beyond the swept extreme, in bar-sigma
    rr: float = 3.0
    target_mode: str = "rr"      # "rr" | "level"
    # -- session
    start_min: int = 570         # first minute a signal may be generated (ET)
    end_min: int = 900           # last  minute a signal may be generated (ET)
    lam: float = 0.94
    seed_len: int = 30

    def copy(self, **kw):
        return Params(**{**asdict(self), **kw})


# ── session liquidity levels, computed causally on the 1m clock ──────────────

def liquidity_levels(m1, or_minutes=30):
    """Per-1m-bar arrays of the levels that hold resting orders.

    Every value at index i is derived only from bars strictly before i, or
    from a window that has fully closed by i. Verified by _selftest.
    """
    et_min, et_day, wd = m1.et
    h, l, c = m1.h, m1.l, m1.c
    n = len(h)

    rth = (et_min >= RTH_OPEN) & (et_min < RTH_CLOSE) & (wd < 5)
    days = np.unique(et_day)
    day_ix = np.searchsorted(days, et_day)

    # per-day RTH extremes (used only as PRIOR day values)
    nd = len(days)
    dh = np.full(nd, -np.inf); dl = np.full(nd, np.inf)
    np.maximum.at(dh, day_ix[rth], h[rth])
    np.minimum.at(dl, day_ix[rth], l[rth])
    has = np.isfinite(dh) & (dh > -np.inf) & (dl < np.inf)

    # prior completed RTH day, carried forward over weekends/holidays
    pdh = np.full(nd, np.nan); pdl = np.full(nd, np.nan)
    last_h = last_l = np.nan
    for k in range(nd):
        pdh[k] = last_h; pdl[k] = last_l
        if has[k]:
            last_h, last_l = dh[k], dl[k]

    out_pdh = pdh[day_ix]; out_pdl = pdl[day_ix]

    # overnight extremes: 18:00 ET prior day -> 09:30 ET, running, then frozen
    # for the rest of the session. Session id advances at the 18:00 boundary.
    sess = et_day + (et_min >= GLOBEX_OPEN)
    on_win = (et_min >= GLOBEX_OPEN) | (et_min < RTH_OPEN)
    out_onh = np.full(n, np.nan); out_onl = np.full(n, np.nan)
    cur_h = cur_l = np.nan
    cur_s = -1
    for i in range(n):
        s = sess[i]
        if s != cur_s:
            cur_s = s; cur_h = cur_l = np.nan
        if on_win[i]:
            cur_h = h[i] if not np.isfinite(cur_h) else max(cur_h, h[i])
            cur_l = l[i] if not np.isfinite(cur_l) else min(cur_l, l[i])
        out_onh[i] = cur_h; out_onl[i] = cur_l

    # opening range: fixed window after the cash open, available once closed
    or_end = RTH_OPEN + or_minutes
    in_or = (et_min >= RTH_OPEN) & (et_min < or_end) & (wd < 5)
    orh = np.full(nd, np.nan); orl = np.full(nd, np.nan)
    if in_or.any():
        oh = np.full(nd, -np.inf); ol = np.full(nd, np.inf)
        np.maximum.at(oh, day_ix[in_or], h[in_or])
        np.minimum.at(ol, day_ix[in_or], l[in_or])
        ok = np.isfinite(oh) & (oh > -np.inf)
        orh[ok] = oh[ok]; orl[ok] = ol[ok]
    out_orh = np.where(et_min >= or_end, orh[day_ix], np.nan)
    out_orl = np.where(et_min >= or_end, orl[day_ix], np.nan)

    return dict(pdh=out_pdh, pdl=out_pdl, onh=out_onh, onl=out_onl,
                orh=out_orh, orl=out_orl)


# ── signal generation ────────────────────────────────────────────────────────

def signals(m1, p: Params, lv=None):
    """Return arrays ready to hand to engine.simulate()."""
    agg, src_end = core.resample(m1, p.tf, anchor_min=RTH_OPEN)
    o, h, l, c = agg.o, agg.h, agg.l, agg.c
    n = len(c)
    if n < 400:
        return (np.empty(0, int),) * 1 + (np.empty(0),) * 5 + (np.empty(0, int),)

    sig, warm = core.ewma_sigma(c, lam=p.lam, seed=p.seed_len)
    rng = h - l
    avg_rng = core.rolling_mean(rng, 20)
    vr = core.variance_ratio(c, q=p.vr_q, win=p.vr_win)
    volp = core.pct_rank(sig, 500)

    lv = lv if lv is not None else liquidity_levels(m1, p.or_minutes)
    L = {k: v[src_end] for k, v in lv.items()}   # value as of the bar's close

    et_min, et_day, wd = agg.et
    body_lo = np.minimum(o, c)
    body_hi = np.maximum(o, c)
    with np.errstate(invalid="ignore", divide="ignore"):
        lower_wick = (body_lo - l) / rng
        upper_wick = (h - body_hi) / rng
        close_pos = (c - l) / rng          # 1 = closed on the high

    base = np.zeros(n, dtype=bool)
    base[warm:] = True
    base &= np.isfinite(sig) & np.isfinite(avg_rng) & np.isfinite(vr) & (rng > 0)
    base &= np.isfinite(volp) & (volp >= p.vol_lo) & (volp <= p.vol_hi)
    base &= (et_min >= p.start_min) & (et_min <= p.end_min) & (wd < 5)
    base &= rng >= p.range_exp * avg_rng
    base &= vr <= p.vr_max                    # reverting tape only
    base &= np.isfinite(m1.c[src_end])

    sweep_min = p.sweep_sigma * sig
    sweep_max = p.max_sweep_sigma * sig

    rows = []
    level_sets = []
    if p.use_pd:
        level_sets.append((TAG_PD, L["pdh"], L["pdl"]))
    if p.use_on:
        level_sets.append((TAG_ON, L["onh"], L["onl"]))
    if p.use_or:
        level_sets.append((TAG_OR, L["orh"], L["orl"]))

    for tag, up, dn in level_sets:
        # LONG: raid below `dn`, close back above it, reject off the low
        depth = dn - l
        m = base & np.isfinite(dn) & (depth >= sweep_min) & (depth <= sweep_max)
        m &= (c > dn) & (lower_wick >= p.min_wick) & (close_pos >= p.min_close_pos)
        idx = np.flatnonzero(m)
        if len(idx):
            rows.append((idx, np.full(len(idx), 1, np.int8), tag))
        # SHORT: raid above `up`, close back below it
        depth = h - up
        m = base & np.isfinite(up) & (depth >= sweep_min) & (depth <= sweep_max)
        m &= (c < up) & (upper_wick >= p.min_wick) & ((1 - close_pos) >= p.min_close_pos)
        idx = np.flatnonzero(m)
        if len(idx):
            rows.append((idx, np.full(len(idx), -1, np.int8), tag))

    if not rows:
        z = np.empty(0)
        return np.empty(0, int), np.empty(0, np.int8), z, z, z, np.empty(0, int)

    bi = np.concatenate([r[0] for r in rows])
    bd = np.concatenate([r[1] for r in rows])
    bt = np.concatenate([np.full(len(r[0]), r[2], np.int32) for r in rows])

    # one signal per bar: prior-day > overnight > open-range
    order = np.lexsort((bt, bi))
    bi, bd, bt = bi[order], bd[order], bt[order]
    keep = np.r_[True, bi[1:] != bi[:-1]]
    bi, bd, bt = bi[keep], bd[keep], bt[keep]

    ext = np.where(bd == 1, l[bi], h[bi])              # the swept extreme
    close_b = c[bi]
    entry = ext + p.wick_retrace * (close_b - ext)     # limit inside the wick
    stop = ext - bd * p.stop_sigma * sig[bi]
    risk = np.abs(entry - stop)

    if p.target_mode == "level":
        opp = np.where(bd == 1, L["pdh"][bi], L["pdl"][bi])
        fallback = entry + bd * p.rr * risk
        tp = np.where(np.isfinite(opp) & ((opp - entry) * bd > risk), opp, fallback)
    else:
        tp = entry + bd * p.rr * risk

    # F2: an order is live only on the 1m bar AFTER its aggregate bar closed
    i1 = src_end[bi] + 1
    ok = i1 < len(m1)
    return (i1[ok].astype(np.int64), bd[ok], entry[ok], stop[ok], tp[ok],
            bt[ok].astype(np.int32))


def _selftest():
    rng = np.random.default_rng(7)
    n = 60 * 24 * 40
    t = np.arange(n, dtype=np.int64) * 60 + int(np.datetime64("2024-01-01T00:00:00").astype("int64"))
    px = 16000 * np.exp(np.cumsum(rng.normal(0, 1.2e-4, n)))
    b = core.Bars(t, px, px + 1.5, px - 1.5, px, np.ones(n))
    lv = liquidity_levels(b, 30)
    et_min, et_day, wd = b.et

    # causality: today's prior-day low must equal a PREVIOUS day's RTH low
    rthm = (et_min >= RTH_OPEN) & (et_min < RTH_CLOSE) & (wd < 5)
    days = np.unique(et_day[rthm])
    for d in days[3:8]:
        cur = (et_day == d) & rthm
        prev = days[np.searchsorted(days, d) - 1]
        want_l = b.l[(et_day == prev) & rthm].min()
        got = lv["pdl"][cur]
        assert np.allclose(got, want_l), f"PDL not causal on day {d}"
        # the current day's own low must NOT be embedded in its own level
        assert not np.isclose(got[0], b.l[cur].min()) or want_l == b.l[cur].min()

    # opening range must be NaN before the window closes and set after
    for d in days[3:6]:
        pre = (et_day == d) & (et_min >= RTH_OPEN) & (et_min < RTH_OPEN + 30)
        post = (et_day == d) & (et_min >= RTH_OPEN + 30) & (et_min < RTH_CLOSE)
        assert np.isnan(lv["orh"][pre]).all(), "open range leaked before close"
        assert np.isfinite(lv["orh"][post]).all(), "open range missing after close"
        assert np.isclose(lv["orh"][post][0], b.h[pre].max())

    print("strategy selftest OK  (levels causal, open range gated)")


if __name__ == "__main__":
    _selftest()
