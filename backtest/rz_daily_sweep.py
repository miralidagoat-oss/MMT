#!/usr/bin/env python3
"""Systematic daily-bar sweep for TOP and BOTTOM signals on real data.

About 110 conditions - every common way of calling a market stretched,
exhausted or reversing - are graded the same way on 26 years of daily bars:

    close signals   known at the daily close; outcome = next session
                    (close -> next close), on NQ=F futures, confirmed on ES=F
    open signals    known at the cash open (gaps); outcome = that session
                    (open -> close), on QQQ, confirmed on SPY

`edge` is the mean outcome on signal days minus the mean on all other days,
signed so that positive means "the signal worked" (a bottom was followed by
a better-than-usual session, a top by a worse-than-usual one). It is shown
for three eras; `ok` counts the eras with the right sign on the Nasdaq
instrument plus the three on the S&P instrument (6 = right everywhere).
`abs` is the plain average outcome after the signal: a top signal is only
tradable short if this is below zero.

With ~110 conditions, about 5 would clear |t| > 2 by luck alone. A finding is
kept only if it has the right sign in all six era x market cells.

Usage:  python3 rz_daily_sweep.py --yahoo DIR [--side top|bottom] [--all]
"""
import argparse
import os
import sys

import numpy as np
import pandas as pd

ERAS = (("2000", "2012"), ("2013", "2020"), ("2021", "2026"))


def load(yahoo, name):
    d = pd.read_csv(os.path.join(yahoo, name))
    d.index = pd.to_datetime(d.time, unit="s").dt.normalize()
    d = d[~d.index.duplicated(keep="last")]
    return d[["open", "high", "low", "close", "volume"]].loc["2000":]


def rsi(c, n):
    ch = c.diff()
    up = ch.clip(lower=0).ewm(alpha=1.0 / n, adjust=False).mean()
    dn = (-ch.clip(upper=0)).ewm(alpha=1.0 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)


def streak(flag):
    f = flag.astype(int)
    return f.groupby((f != f.shift()).cumsum()).cumsum() * f


def features(d, vix):
    c, o, h, l = d.close, d.open, d.high, d.low
    f = pd.DataFrame(index=d.index)
    r = c.pct_change()
    f["r1"], f["r3"], f["r5"] = r, c.pct_change(3), c.pct_change(5)
    for n in (2, 3, 5, 14):
        f[f"rsi{n}"] = rsi(c, n)
    f["dn"], f["up"] = streak(r < 0), streak(r > 0)
    f["ibs"] = (c - l) / (h - l)
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    f["rng"] = (h - l) / atr.shift(1)
    f["z20"] = (c - c.rolling(20).mean()) / c.rolling(20).std()
    for n in (5, 20, 50, 200):
        f[f"d{n}"] = (c - c.rolling(n).mean()) / atr
    for n in (5, 10, 20, 50):
        f[f"hi{n}"] = c >= c.rolling(n).max()
        f[f"lo{n}"] = c <= c.rolling(n).min()
    f["ihi10"] = h >= h.rolling(10).max()
    f["ilo10"] = l <= l.rolling(10).min()
    f["above200"] = c > c.rolling(200).mean()
    f["gap"] = o / pc - 1
    f["dow"] = d.index.dayofweek
    ym = d.index.to_period("M")
    f["dom"] = pd.Series(1, index=d.index).groupby(ym).cumsum()                 # trading day of month, from the start
    f["dom_end"] = pd.Series(1, index=d.index).iloc[::-1].groupby(ym[::-1]).cumsum().iloc[::-1]   # ... from the end
    v = vix.reindex(d.index).ffill()
    f["v_chg"] = v.pct_change()
    f["v_z"] = v / v.rolling(10).mean() - 1
    f["v_pct"] = v.rolling(252).rank(pct=True)
    f["vol_z"] = d.volume / d.volume.rolling(20).mean()
    # yesterday's state, for signals that are only known at today's open
    for k in ("rsi2", "dn", "up", "hi20", "lo20"):
        f["p_" + k] = f[k].shift(1)
    f["p_hi_gap"] = o >= c.rolling(20).max().shift(1)      # opens above the prior 20-day closing high
    f["p_lo_gap"] = o <= c.rolling(20).min().shift(1)
    # outcomes
    f["next"] = c.shift(-1) / c - 1            # close -> next close
    f["next5"] = c.shift(-5) / c - 1
    f["oc"] = c / o - 1                        # same session, open -> close
    return f


def conditions(f):
    B, T = {}, {}           # name -> (mask, outcome)
    nx, oc = "next", "oc"
    # ── bottoms: known at the close ──
    for x in (5, 10, 15):
        B[f"RSI(2) < {x}"] = (f.rsi2 < x, nx)
    B["RSI(3) < 10"] = (f.rsi3 < 10, nx)
    B["RSI(5) < 20"] = (f.rsi5 < 20, nx)
    B["RSI(14) < 30"] = (f.rsi14 < 30, nx)
    for k in (2, 3, 4, 5):
        B[f"{k}+ down closes"] = (f.dn >= k, nx)
    B["exactly 3 down closes"] = (f.dn == 3, nx)
    for x in (0.1, 0.2):
        B[f"close in bottom {int(x * 100)}% of range"] = (f.ibs < x, nx)
    for x in (1, 2, 3):
        B[f"day down > {x}%"] = (f.r1 < -x / 100, nx)
    B["3 days down > 4%"] = (f.r3 < -0.04, nx)
    B["5 days down > 5%"] = (f.r5 < -0.05, nx)
    B["close < lower Bollinger (2σ)"] = (f.z20 < -2, nx)
    B["2 ATR below 5-day avg"] = (f.d5 < -2, nx)
    B["3 ATR below 20-day avg"] = (f.d20 < -3, nx)
    for n in (5, 10, 20, 50):
        B[f"new {n}-day closing low"] = (f[f"lo{n}"], nx)
    B["10-day low then close up, top 30% of range"] = (f.ilo10 & (f.r1 > 0) & (f.ibs > 0.7), nx)
    B["10-day low, close in top 30% (hammer)"] = (f.ilo10 & (f.ibs > 0.7), nx)
    B["wide-range down day (> 1.5 ATR)"] = ((f.rng > 1.5) & (f.r1 < 0), nx)
    B["VIX 15% above its 10-day avg"] = (f.v_z > 0.15, nx)
    B["VIX 25% above its 10-day avg"] = (f.v_z > 0.25, nx)
    B["VIX up > 10% today"] = (f.v_chg > 0.10, nx)
    B["VIX up > 20% today"] = (f.v_chg > 0.20, nx)
    B["VIX in top 10% of the year"] = (f.v_pct > 0.9, nx)
    B["Monday down > 1%"] = ((f.dow == 0) & (f.r1 < -0.01), nx)
    B["Friday down > 1%"] = ((f.dow == 4) & (f.r1 < -0.01), nx)
    B["down day on heavy volume (> 1.5x)"] = ((f.r1 < 0) & (f.vol_z > 1.5), nx)
    B["RSI(2) < 10 and bottom 20% of range"] = ((f.rsi2 < 10) & (f.ibs < 0.2), nx)
    B["RSI(2) < 10 and VIX 10% above avg"] = ((f.rsi2 < 10) & (f.v_z > 0.10), nx)
    B["RSI(2) < 10, above 200-day avg"] = ((f.rsi2 < 10) & f.above200, nx)
    B["RSI(2) < 10, below 200-day avg"] = ((f.rsi2 < 10) & ~f.above200, nx)
    B["RSI(2) < 10 or 3+ down closes"] = ((f.rsi2 < 10) | (f.dn >= 3), nx)
    B["3+ down closes at a 20-day low"] = ((f.dn >= 3) & f.lo20, nx)
    B["last trading day of month"] = (f.dom_end == 1, nx)
    B["first 3 trading days of month eve"] = (f.dom_end == 1, nx)
    # ── bottoms: known at the open ──
    for x in (0.5, 1.0, 1.5):
        B[f"OPEN gap down > {x}%"] = (f.gap < -x / 100, oc)
    B["OPEN gap down > 0.5% after RSI(2) < 10"] = ((f.gap < -0.005) & (f.p_rsi2 < 10), oc)
    B["OPEN gap down > 0.5% after 2+ down closes"] = ((f.gap < -0.005) & (f.p_dn >= 2), oc)
    B["OPEN below the prior 20-day low"] = (f.p_lo_gap, oc)
    B["OPEN gap up > 0.5% after RSI(2) < 10"] = ((f.gap > 0.005) & (f.p_rsi2 < 10), oc)

    # ── tops: known at the close ──
    for x in (90, 95, 98):
        T[f"RSI(2) > {x}"] = (f.rsi2 > x, nx)
    T["RSI(3) > 90"] = (f.rsi3 > 90, nx)
    T["RSI(5) > 80"] = (f.rsi5 > 80, nx)
    T["RSI(14) > 70"] = (f.rsi14 > 70, nx)
    T["RSI(14) > 75"] = (f.rsi14 > 75, nx)
    for k in (3, 4, 5, 6):
        T[f"{k}+ up closes"] = (f.up >= k, nx)
    for x in (0.9, 0.8):
        T[f"close in top {int(round((1 - x) * 100))}% of range"] = (f.ibs > x, nx)
    for x in (1, 2, 3):
        T[f"day up > {x}%"] = (f.r1 > x / 100, nx)
    T["3 days up > 4%"] = (f.r3 > 0.04, nx)
    T["5 days up > 5%"] = (f.r5 > 0.05, nx)
    T["close > upper Bollinger (2σ)"] = (f.z20 > 2, nx)
    T["close > upper Bollinger (2.5σ)"] = (f.z20 > 2.5, nx)
    T["2 ATR above 5-day avg"] = (f.d5 > 2, nx)
    T["3 ATR above 20-day avg"] = (f.d20 > 3, nx)
    T["5 ATR above 50-day avg"] = (f.d50 > 5, nx)
    T["10 ATR above 200-day avg"] = (f.d200 > 10, nx)
    for n in (5, 10, 20, 50):
        T[f"new {n}-day closing high"] = (f[f"hi{n}"], nx)
    T["10-day high then close down, bottom 30%"] = (f.ihi10 & (f.r1 < 0) & (f.ibs < 0.3), nx)
    T["10-day high, close in bottom 30% (shooting star)"] = (f.ihi10 & (f.ibs < 0.3), nx)
    T["wide-range up day (> 1.5 ATR)"] = ((f.rng > 1.5) & (f.r1 > 0), nx)
    T["wide-range up day at a 50-day high"] = ((f.rng > 1.5) & (f.r1 > 0) & f.hi50, nx)
    T["VIX 10% below its 10-day avg"] = (f.v_z < -0.10, nx)
    T["VIX down > 8% today"] = (f.v_chg < -0.08, nx)
    T["VIX in bottom 10% of the year"] = (f.v_pct < 0.1, nx)
    T["VIX up > 3% on an up day (divergence)"] = ((f.r1 > 0.003) & (f.v_chg > 0.03), nx)
    T["VIX up > 5% at a 20-day high"] = (f.hi20 & (f.v_chg > 0.05), nx)
    T["Friday up > 1%"] = ((f.dow == 4) & (f.r1 > 0.01), nx)
    T["Monday up > 1%"] = ((f.dow == 0) & (f.r1 > 0.01), nx)
    T["up day on heavy volume (> 1.5x)"] = ((f.r1 > 0) & (f.vol_z > 1.5), nx)
    T["up day on light volume (< 0.7x) at 20-day high"] = ((f.r1 > 0) & (f.vol_z < 0.7) & f.hi20, nx)
    T["RSI(2) > 95 at a 20-day high"] = ((f.rsi2 > 95) & f.hi20, nx)
    T["RSI(2) > 90, below 200-day avg"] = ((f.rsi2 > 90) & ~f.above200, nx)
    T["RSI(2) > 90, above 200-day avg"] = ((f.rsi2 > 90) & f.above200, nx)
    T["4+ up closes at a 20-day high"] = ((f.up >= 4) & f.hi20, nx)
    T["RSI(14) > 70 and 3 ATR above 20-day avg"] = ((f.rsi14 > 70) & (f.d20 > 3), nx)
    T["5th trading day of month"] = (f.dom == 5, nx)
    # ── tops: known at the open ──
    for x in (0.5, 1.0, 1.5):
        T[f"OPEN gap up > {x}%"] = (f.gap > x / 100, oc)
    T["OPEN gap up > 0.5% after RSI(2) > 90"] = ((f.gap > 0.005) & (f.p_rsi2 > 90), oc)
    T["OPEN gap up > 0.5% after 3+ up closes"] = ((f.gap > 0.005) & (f.p_up >= 3), oc)
    T["OPEN above the prior 20-day high"] = (f.p_hi_gap, oc)
    T["OPEN gap up > 1% above the prior 20-day high"] = (f.p_hi_gap & (f.gap > 0.01), oc)
    T["OPEN gap down > 0.5% after RSI(2) > 90"] = ((f.gap < -0.005) & (f.p_rsi2 > 90), oc)
    del B["first 3 trading days of month eve"]
    return B, T


def grade(f, mask, outcome, sign):
    y = f[outcome]
    m = mask.reindex(f.index).fillna(False).astype(bool) & y.notna()
    rest = ~m & y.notna()
    out = {"n": int(m.sum()), "abs": 100 * y[m].mean()}
    eras = []
    for a, b in ERAS:
        ys, yo = y[m].loc[a:b], y[rest].loc[a:b]
        eras.append(sign * 100 * (ys.mean() - yo.mean()) if len(ys) >= 15 else np.nan)
    out["eras"] = eras
    ys, yo = y[m], y[rest]
    se = np.sqrt(ys.var() / max(len(ys), 1) + yo.var() / max(len(yo), 1))
    out["edge"] = sign * 100 * (ys.mean() - yo.mean())
    out["t"] = out["edge"] / (100 * se) if se > 0 else np.nan
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--yahoo", required=True)
    ap.add_argument("--side", choices=["top", "bottom", "both"], default="both")
    ap.add_argument("--all", action="store_true", help="print every condition, not only the notable ones")
    ap.add_argument("--save")
    a = ap.parse_args()
    vxn = load(a.yahoo, "VXN_1d.csv").close
    vix = load(a.yahoo, "VIX_1d.csv").close
    fx = {"NQ": features(load(a.yahoo, "NQ_1d.csv"), vxn), "ES": features(load(a.yahoo, "ES_1d.csv"), vix),
          "QQQ": features(load(a.yahoo, "QQQ_1d.csv"), vxn), "SPY": features(load(a.yahoo, "SPY_1d.csv"), vix)}
    rows = []
    for side, sign in (("bottom", 1), ("top", -1)):
        if a.side not in (side, "both"):
            continue
        conds = {k: conditions(v)[0 if side == "bottom" else 1] for k, v in fx.items()}
        for name in conds["NQ"]:
            outcome = conds["NQ"][name][1]
            p, s = ("NQ", "ES") if outcome == "next" else ("QQQ", "SPY")
            g1 = grade(fx[p], conds[p][name][0], outcome, sign)
            g2 = grade(fx[s], conds[s][name][0], outcome, sign)
            ok = sum(1 for e in g1["eras"] + g2["eras"] if e == e and e > 0)
            known = sum(1 for e in g1["eras"] + g2["eras"] if e == e)
            rows.append({"side": side, "signal": name, "on": p, "n": g1["n"], "abs%": g1["abs"], "edge%": g1["edge"],
                         "t": g1["t"], "e1": g1["eras"][0], "e2": g1["eras"][1], "e3": g1["eras"][2],
                         "S&P edge%": g2["edge"], "S&P t": g2["t"], "ok": f"{ok}/{known}"})
    tab = pd.DataFrame(rows)
    if a.save:
        tab.to_csv(a.save, index=False)
    pd.set_option("display.width", 250)
    pd.set_option("display.max_rows", 300)
    pd.set_option("display.max_colwidth", 60)
    for side in ("bottom", "top"):
        t_ = tab[tab.side == side].drop(columns="side")
        if len(t_) == 0:
            continue
        full = t_[t_.ok.isin(["6/6"]) & (t_.t > 2) & (t_["S&P t"] > 1.5)]
        print(f"\n===== {side.upper()} signals: {len(t_)} tested;  t > 2 on the Nasdaq instrument: {(t_.t > 2).sum()};  "
              f"t < -2 (backwards): {(t_.t < -2).sum()};  right sign in all 6 era x market cells with t > 2: {len(full)} =====")
        show = t_ if a.all else pd.concat([t_.sort_values("t", ascending=False).head(14), t_.sort_values("t").head(6)])
        print(show.round(2).to_string(index=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
