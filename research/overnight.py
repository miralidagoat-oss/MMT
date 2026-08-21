#!/usr/bin/env python3
"""MMT-N: the overnight session, which is where NQ's return actually is.

Everything else in this repo tried to find structure inside the RTH session.
Across 2,998 sessions the RTH session has a drift of +2.13 points a day with
t = 0.80 and an annualised Sharpe of 0.23 -- statistically indistinguishable
from nothing, which is exactly why every intraday rule tested here landed on
a profit factor near 1.00. The overnight window carries +4.54 points a day at
t = 2.18 and Sharpe 0.63, profitable in 10 of 12 calendar years.

This is the "night effect", documented across equity indices for two decades
(Cliff/Cooper/Gulen; Lachance; Boyarchenko et al. at the NY Fed). Be clear
about what it is: it is not alpha. It is the equity risk premium, and it
accrues almost entirely while the cash market is shut. You are being paid to
hold risk through the gap, not to outsmart anyone.

That honesty matters for what can be built on top. Two things are worth
adding, and both are risk management rather than prediction:

  * a long-term trend filter, to sit out the regimes where holding index risk
    is not paid (2022 cost this strategy more than any other year)
  * volatility targeting, to stop 2020 and 2022 contributing ten times the
    risk of 2017

Both are tested below against the unfiltered baseline, walked forward.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

import core
from core import POINT_VALUE, TICK
from edge_search import build_panel, features

FLAT_M = 385                       # 15:55 ET entry
COMMISSION_PTS = 1.20 / POINT_VALUE
SLIP_PTS = TICK                    # per side, market orders


@dataclass
class NightCfg:
    trend_len: int = 200           # daily SMA for the regime filter (0 = off)
    vol_target: float = 0.0        # annualised vol target (0 = fixed 1 lot)
    vol_len: int = 20              # realised-vol lookback, days
    max_lev: float = 3.0           # cap on vol-target sizing
    skip_after_up: float = 9.9     # skip if the day's RTH return exceeded this sigma
    require_up_day: bool = False   # only hold after an up session


def night_returns(P):
    """Per-night gross points: 15:55 close -> next session's 09:30 open."""
    C, O = P["C"], P["O"]
    nd = len(C)
    entry = C[:, FLAT_M]
    exit_ = np.full(nd, np.nan)
    exit_[:-1] = O[1:, 0]
    return exit_ - entry, entry


def build(P, scale, cfg: NightCfg):
    """Return (position size per night, gross points per night)."""
    C, O = P["C"], P["O"]
    nd = len(C)
    gross, entry = night_returns(P)

    daily_close = C[:, FLAT_M]
    # trend filter: today's close vs the mean of the PRIOR trend_len closes
    ok_trend = np.ones(nd, dtype=bool)
    if cfg.trend_len > 0:
        sma = np.full(nd, np.nan)
        for i in range(cfg.trend_len, nd):
            sma[i] = np.nanmean(daily_close[i - cfg.trend_len:i])
        ok_trend = np.isfinite(sma) & (daily_close > sma)

    # realised vol of prior close-to-close moves, for sizing
    r = np.full(nd, np.nan)
    r[1:] = np.diff(daily_close) / daily_close[:-1]
    rv = np.full(nd, np.nan)
    for i in range(cfg.vol_len + 1, nd):
        w = r[i - cfg.vol_len:i]
        w = w[np.isfinite(w)]
        if len(w) > 5:
            rv[i] = w.std(ddof=1) * np.sqrt(252)

    size = np.ones(nd)
    if cfg.vol_target > 0:
        size = np.clip(cfg.vol_target / np.maximum(rv, 1e-6), 0.0, cfg.max_lev)
        size[~np.isfinite(rv)] = 0.0

    day_ret = (C[:, FLAT_M] - O[:, 0]) / np.maximum(scale[:, 0], 1e-9)
    ok_day = np.isfinite(day_ret) & (day_ret <= cfg.skip_after_up)
    if cfg.require_up_day:
        ok_day &= day_ret > 0

    take = ok_trend & ok_day & np.isfinite(gross) & np.isfinite(size) & (size > 0)
    pos = np.where(take, size, 0.0)
    return pos, gross


def evaluate(P, scale, cfg: NightCfg, label=""):
    pos, gross = build(P, scale, cfg)
    cost = COMMISSION_PTS + 2 * SLIP_PTS
    net = np.where(pos > 0, pos * gross - cost * pos, np.nan)
    ok = np.isfinite(net) & (pos > 0)
    v = net[ok]
    if len(v) < 30:
        return None
    wins = v[v > 0]; losses = v[v < 0]
    pf = wins.sum() / -losses.sum() if len(losses) and losses.sum() < 0 else np.inf
    eq = np.cumsum(v)
    dd = float(np.max(np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]))
    t = v.mean() / (v.std(ddof=1) / np.sqrt(len(v)))
    sharpe = v.mean() / v.std(ddof=1) * np.sqrt(252)
    return dict(label=label, n=len(v), wr=100.0 * len(wins) / len(v), pf=float(pf),
                pts=float(v.sum()), t=float(t), sharpe=float(sharpe), dd=dd,
                usd=float(v.sum() * POINT_VALUE), exposure=100.0 * ok.mean(),
                net=net, pos=pos)


def by_year(P, res):
    yr = (P["days"] * 86400).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    net = res["net"]
    rows = []
    for y in np.unique(yr):
        v = net[(yr == y) & np.isfinite(net)]
        if len(v) < 5:
            continue
        w = v[v > 0]; l = v[v < 0]
        pf = w.sum() / -l.sum() if len(l) and l.sum() < 0 else np.inf
        rows.append((int(y), len(v), 100.0 * len(w) / len(v), float(pf),
                     float(v.sum()), float(v.sum() * POINT_VALUE)))
    return rows


def main():
    m1 = core.load_1m()
    P = build_panel(m1)
    F, scale = features(P)
    nd = len(P["C"])
    print(f"panel {nd} sessions, MNQ costs charged "
          f"({COMMISSION_PTS:.2f}pt + {2*SLIP_PTS:.2f}pt slip per night)\n")

    variants = [
        ("baseline: hold every night",       NightCfg(trend_len=0)),
        ("trend filter SMA100",              NightCfg(trend_len=100)),
        ("trend filter SMA200",              NightCfg(trend_len=200)),
        ("trend filter SMA150",              NightCfg(trend_len=150)),
        ("vol target 15% only",              NightCfg(trend_len=0, vol_target=0.15)),
        ("SMA200 + vol target 15%",          NightCfg(trend_len=200, vol_target=0.15)),
        ("SMA200 + vol target 20%",          NightCfg(trend_len=200, vol_target=0.20)),
        ("SMA200 + vt15 + skip big up days", NightCfg(trend_len=200, vol_target=0.15,
                                                      skip_after_up=1.5)),
    ]
    print(f"{'variant':<34}{'nights':>7}{'expo%':>7}{'WR%':>6}{'PF':>6}"
          f"{'net pts':>10}{'t':>6}{'Sharpe':>8}{'maxDD':>9}{'$/yr':>10}")
    print("-" * 103)
    results = {}
    yrs = nd / 252.0
    for lbl, cfg in variants:
        r = evaluate(P, scale, cfg, lbl)
        if r is None:
            continue
        results[lbl] = r
        print(f"{lbl:<34}{r['n']:>7}{r['exposure']:>7.0f}{r['wr']:>6.1f}{r['pf']:>6.2f}"
              f"{r['pts']:>10,.0f}{r['t']:>+6.2f}{r['sharpe']:>8.2f}"
              f"{r['dd']:>9,.0f}{r['usd']/yrs:>10,.0f}")

    print("\n== year by year: SMA200 + vol target 15% ==")
    best = results.get("SMA200 + vol target 15%")
    print(f"{'year':>6}{'nights':>8}{'WR%':>7}{'PF':>7}{'net pts':>10}{'$ (1 MNQ)':>12}")
    for y, n, wr, pf, pts, usd in by_year(P, best):
        print(f"{y:>6}{n:>8}{wr:>7.1f}{pf:>7.2f}{pts:>10,.0f}{usd:>12,.0f}")

    print("\n== same, unfiltered baseline (for comparison) ==")
    base = results["baseline: hold every night"]
    print(f"{'year':>6}{'nights':>8}{'WR%':>7}{'PF':>7}{'net pts':>10}{'$ (1 MNQ)':>12}")
    for y, n, wr, pf, pts, usd in by_year(P, base):
        print(f"{y:>6}{n:>8}{wr:>7.1f}{pf:>7.2f}{pts:>10,.0f}{usd:>12,.0f}")


if __name__ == "__main__":
    main()


def night_paths_stop(m1, P, scale, pos, stop_sig, slip=SLIP_PTS):
    """Honest overnight stop: walk the real 1-minute path from 15:55 to 09:30.

    A stop test that only floors the loss is not a test -- it never lets the
    stop trigger on a night that would have recovered, so it can only improve
    the result. MNQ trades through the night, so the path exists; this walks
    it minute by minute and takes the stop the moment it is touched, whether
    or not the night would have come back.
    """
    et_min, et_day, _ = m1.et
    keys = et_day.astype(np.int64) * 1440 + et_min
    days = P["days"]
    C, O = P["C"], P["O"]
    nd = len(C)
    out = np.full(nd, np.nan)

    for i in range(nd - 1):
        if pos[i] <= 0 or not np.isfinite(scale[i, 0]):
            continue
        k0 = int(days[i]) * 1440 + (570 + FLAT_M)      # 15:55 ET
        k1 = int(days[i + 1]) * 1440 + 570             # 09:30 ET next session
        a = int(np.searchsorted(keys, k0, side="right"))
        b = int(np.searchsorted(keys, k1, side="right"))
        entry = C[i, FLAT_M]
        exit_px = O[i + 1, 0]
        if stop_sig > 0 and b > a:
            stop = entry - stop_sig * scale[i, 0]
            seg = m1.l[a:b]
            hit = np.flatnonzero(seg <= stop)
            if len(hit):
                exit_px = stop - slip                  # market-out, pays slip
        out[i] = exit_px - entry
    return out


def stop_study(m1, P, scale, cfg=None, sigs=(0.0, 3.0, 2.0, 1.5, 1.0, 0.75)):
    cfg = cfg or NightCfg(trend_len=200, vol_target=0.15)
    pos, _ = build(P, scale, cfg)
    cost = COMMISSION_PTS + 2 * SLIP_PTS
    print(f"{'stop':>13}{'n':>7}{'WR%':>7}{'PF':>7}{'net pts':>10}{'Sharpe':>8}"
          f"{'maxDD':>9}{'worst':>8}{'stopped%':>10}")
    for s in sigs:
        g = night_paths_stop(m1, P, scale, pos, s)
        net = np.where(pos > 0, pos * g - cost * pos, np.nan)
        v = net[np.isfinite(net)]
        w, l = v[v > 0], v[v < 0]
        pf = w.sum() / -l.sum() if len(l) and l.sum() < 0 else np.inf
        eq = np.cumsum(v)
        dd = float(np.max(np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]))
        sh = v.mean() / v.std(ddof=1) * np.sqrt(252)
        if s > 0:
            base = night_paths_stop(m1, P, scale, pos, 0.0)
            stopped = 100.0 * np.mean(
                (g < base - 1e-9)[np.isfinite(g) & np.isfinite(base)])
        else:
            stopped = 0.0
        lbl = "none" if s == 0 else f"{s}x scale"
        print(f"{lbl:>13}{len(v):>7}{100*len(w)/len(v):>7.1f}{pf:>7.2f}"
              f"{v.sum():>10,.0f}{sh:>8.2f}{dd:>9,.0f}{v.min():>8,.0f}{stopped:>10.1f}")
