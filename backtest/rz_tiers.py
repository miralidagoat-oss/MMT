#!/usr/bin/env python3
"""Tiered exhaustion reversals: the daily engine of
indicators/mnq_exhaustion_reversals.pine, mirrored statement by statement,
plus the tests that decided what went into it. Real daily / hourly bars only.

Tiers, all judged on a COMPLETED daily close:
    standard      RSI(2) < 10, or the third down close in a row
    prime         a standard close that falls on a Monday or Tuesday
    deep          RSI(5) < 20
    capitulation  RSI(14) < 30
    blow-off top  RSI(14) >= 80

Commands
  scorecard  what the Pine scorecard prints for one daily CSV (--file)
  eras       every tier on NQ / ES futures, QQQ, SPY and the Nasdaq-100 index,
             split into 2000-12 / 2013-20 / 2021-26, with the blow-off tops
             also counted as separate episodes
  split      when the move arrives: overnight (close -> next open) versus the
             day session (open -> close), on QQQ and SPY
  entry      buy the signal close versus waiting for a dip, NQ futures
  lines      proof that the trigger lines are exact: on every real daily bar,
             a close just beyond the line flips the RSI test and a close just
             short of it does not
  hourly     real MNQ=F hourly volume and VIX: climax lows / highs, VIX spikes
             and divergences, against a joint direction-scrambled null

  python3 rz_tiers.py scorecard --yahoo data/yahoo --file MNQ_1d.csv
  python3 rz_tiers.py eras      --yahoo data/yahoo
"""
import argparse
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd

import rz_data
import rz_null

warnings.filterwarnings("ignore")

ERAS = (("2000", "2012"), ("2013", "2020"), ("2021", "2026"))
TIERS = ("std", "prime", "deep", "cap", "top")
NAMES = {"std": "Standard exhaustion close", "prime": "Prime: on a Monday / Tuesday", "deep": "Deep: RSI(5) < 20",
         "cap": "Capitulation: RSI(14) < 30", "top": "Blow-off top: RSI(14) >= 80"}
RSI_STD, RSI_DEEP, RSI_CAP, RSI_TOP, STREAK = 10.0, 20.0, 30.0, 80.0, 3


def daily(path):
    d = pd.read_csv(path)
    d.index = pd.to_datetime(d.time, unit="s").dt.normalize()      # Yahoo stamps a daily bar with its trade date
    return d[["open", "high", "low", "close"]]


def wilder(close, n):
    """ta.rma of the up / down closes: seeded with the SMA of the first n changes."""
    g = np.full(len(close), np.nan)
    lo = np.full(len(close), np.nan)
    ch = np.diff(close)
    for i in range(n, len(close)):
        up, dn = max(ch[i - 1], 0.0), max(-ch[i - 1], 0.0)
        if i == n:
            g[i], lo[i] = np.maximum(ch[:n], 0).mean(), np.maximum(-ch[:n], 0).mean()
        else:
            g[i] = (g[i - 1] * (n - 1) + up) / n
            lo[i] = (lo[i - 1] * (n - 1) + dn) / n
    with np.errstate(divide="ignore", invalid="ignore"):
        rsi = np.where(lo == 0, 100.0, 100.0 - 100.0 / (1.0 + g / lo))
    rsi[np.isnan(g)] = np.nan
    return g, lo, rsi


def line_below(pc, g, lo, n, thr):
    """Close below this price  <=>  RSI(n) < thr at that close (f_lineBelow in the Pine script)."""
    q = thr / (100.0 - thr)
    d0 = g * (n - 1) / q - lo * (n - 1)
    return pc - d0 if d0 > 0 else pc - q * d0


def line_above(pc, g, lo, n, thr):
    """Close at or above this price  <=>  RSI(n) >= thr at that close (f_lineAbove)."""
    q = thr / (100.0 - thr)
    u0 = q * lo * (n - 1) - g * (n - 1)
    return pc + u0 if u0 > 0 else pc + u0 / q


def engine(d):
    """Mirror of f_daily(): tier flags per completed close and the cumulative
    grades (n, sum, sum of squares, closed higher, n5, sum5) per tier + all."""
    close = d.close.values
    n = len(close)
    dow = d.index.dayofweek.values                    # Monday = 0
    g2, l2, r2 = wilder(close, 2)
    g5, l5, r5 = wilder(close, 5)
    g14, l14, r14 = wilder(close, 14)
    streak = np.zeros(n, int)
    for i in range(1, n):
        streak[i] = streak[i - 1] + 1 if close[i] < close[i - 1] else 0
    sig = {"std": (r2 < RSI_STD) | (streak >= STREAK)}       # a comparison with nan is False, as with na in Pine
    sig["prime"] = sig["std"] & (dow <= 1)
    sig["deep"] = r5 < RSI_DEEP
    sig["cap"] = r14 < RSI_CAP
    sig["top"] = r14 >= RSI_TOP
    sig["all"] = np.ones(n, bool)
    cum = {k: np.zeros((n, 6)) for k in sig}
    for i in range(1, n):
        ok1 = not np.isnan(r14[i - 1])
        ok5 = i >= 5 and not np.isnan(r14[i - 5])
        ret1 = close[i] / close[i - 1] - 1.0
        ret5 = close[i] / close[i - 5] - 1.0 if i >= 5 else np.nan
        for k in sig:
            cum[k][i] = cum[k][i - 1]
            if ok1 and sig[k][i - 1]:
                cum[k][i, :4] += (1, ret1, ret1 * ret1, 1 if ret1 > 0 else 0)
            if ok5 and sig[k][i - 5]:
                cum[k][i, 4:] += (1, ret5)
    st = dict(close=close, dow=dow, r2=r2, r5=r5, r14=r14, streak=streak, g2=g2, l2=l2, g5=g5, l5=l5, g14=g14, l14=l14)
    return sig, cum, st


def tstat(c, a):
    """Tier (c) against every other session (a - c), from cumulative sums."""
    n1, s1, q1 = c[0], c[1], c[2]
    n0, s0, q0 = a[0] - c[0], a[1] - c[1], a[2] - c[2]
    if n1 < 2 or n0 < 2:
        return np.nan
    m1, m0 = s1 / n1, s0 / n0
    se = np.sqrt(max(q1 / n1 - m1 * m1, 0) / n1 + max(q0 / n0 - m0 * m0, 0) / n0)
    return (m1 - m0) / se if se > 0 else np.nan


def cmd_scorecard(args):
    d = daily(os.path.join(args.yahoo, args.file))
    sig, cum, st = engine(d)
    p = len(d) - 2                                    # the trailing [1]: the last COMPLETED daily bar
    a = cum["all"][p]
    print(f"{args.file}: {len(d)} daily bars, {d.index[0].date()} -> {d.index[-1].date()}  (last bar = session in progress)")
    print(f"  {'tier':32s} {'n':>5s} {'next session':>22s} {'higher':>7s} {'t':>6s} {'next 5':>9s}")
    for k in TIERS:
        c = cum[k][p]
        if c[0] == 0:
            print(f"  {NAMES[k]:32s} {0:5d}")
            continue
        m = c[1] / c[0]
        five = f"{100 * c[5] / c[4]:+.2f}%" if c[4] else "-"
        print(f"  {NAMES[k]:32s} {int(c[0]):5d} {100 * m:+.3f}% = {m * st['close'][-1]:+5.0f} pts {100 * c[3] / c[0]:6.0f}% "
              f"{tstat(c, a):+6.2f} {five:>9s}")
    print(f"  {'Every session':32s} {int(a[0]):5d} {100 * a[1] / a[0]:+.3f}% = {a[1] / a[0] * st['close'][-1]:+5.0f} pts "
          f"{100 * a[3] / a[0]:6.0f}% {'':6s} {100 * a[5] / a[4]:+.2f}%")
    pc = st["close"][p]
    x_rsi = line_below(pc, st["g2"][p], st["l2"][p], 2, RSI_STD)
    x_std = max(x_rsi, pc) if st["streak"][p] >= STREAK - 1 else x_rsi
    live = [NAMES[k] for k in TIERS if sig[k][p]]
    print(f"  last completed close {pc:,.2f} ({d.index[p].day_name()}): RSI(2) {st['r2'][p]:.1f}, RSI(5) {st['r5'][p]:.1f}, "
          f"RSI(14) {st['r14'][p]:.1f}, {st['streak'][p]} down closes -> {', '.join(live) if live else 'no signal'}")
    print(f"  lines for the session in progress: exhaustion {x_std:,.2f} | deep {line_below(pc, st['g5'][p], st['l5'][p], 5, RSI_DEEP):,.2f}"
          f" | capitulation {line_below(pc, st['g14'][p], st['l14'][p], 14, RSI_CAP):,.2f}"
          f" | blow-off {line_above(pc, st['g14'][p], st['l14'][p], 14, RSI_TOP):,.2f}")


def cmd_lines(args):
    d = daily(os.path.join(args.yahoo, args.file))
    _, _, st = engine(d)
    c = st["close"]
    bad = total = 0
    for i in range(20, len(c) - 1):
        for n, thr, below, g, lo in ((2, RSI_STD, True, st["g2"], st["l2"]), (5, RSI_DEEP, True, st["g5"], st["l5"]),
                                     (14, RSI_CAP, True, st["g14"], st["l14"]), (14, RSI_TOP, False, st["g14"], st["l14"])):
            x = (line_below if below else line_above)(c[i], g[i], lo[i], n, thr)
            for eps in (-0.01, 0.01):                      # one cent either side of the line
                chg = x + eps - c[i]
                g1 = (g[i] * (n - 1) + max(chg, 0.0)) / n
                l1 = (lo[i] * (n - 1) + max(-chg, 0.0)) / n
                rsi = 100.0 if l1 == 0 else 100.0 - 100.0 / (1.0 + g1 / l1)
                want = (eps < 0) if below else (eps > 0)
                got = (rsi < thr) if below else (rsi >= thr)
                total += 1
                bad += want != got
            nxt = c[i + 1]                                 # and the close that actually followed
            real = {2: st["r2"], 5: st["r5"], 14: st["r14"]}[n][i + 1]
            total += 1
            bad += ((nxt < x) != (real < thr)) if below else ((nxt >= x) != (real >= thr))
    print(f"{args.file}: {total:,} checks of the four trigger lines on {len(c) - 21:,} real daily bars, {bad} mismatches")


def _fwd(d, k):
    c = d.close.values
    out = np.full(len(c), np.nan)
    out[:-k] = c[k:] / c[:-k] - 1.0
    return out


def cmd_eras(args):
    mk = (("NQ futures", "NQ_1d.csv"), ("ES futures", "ES_1d.csv"), ("QQQ", "QQQ_1d.csv"), ("SPY", "SPY_1d.csv"),
          ("Nasdaq-100", "NDX_1d.csv"))
    print("next-session return after each tier (5-session return in brackets), in %; 'all' = every session")
    for name, f in mk:
        d = daily(os.path.join(args.yahoo, f))
        d = d[d.index >= "2000-01-01"]
        sig, _, st = engine(d)
        f1, f5 = 100 * _fwd(d, 1), 100 * _fwd(d, 5)
        yr = d.index.year.values
        print(f"\n{name}  {d.index[0].date()} -> {d.index[-1].date()}")
        print(f"  {'tier':30s} {'n':>5s} {'whole sample':>20s} {'t':>6s}   " + "   ".join(f"{a}-{b[2:]:<14s}" for a, b in ERAS))
        for k in TIERS + ("all",):
            m = sig[k] & ~np.isnan(f1) & ~np.isnan(st["r14"])
            o = ~sig[k] & ~np.isnan(f1) & ~np.isnan(st["r14"])
            t = (f1[m].mean() - f1[o].mean()) / np.sqrt(f1[m].var() / m.sum() + f1[o].var() / o.sum()) if k != "all" and m.sum() > 1 else np.nan
            row = f"  {NAMES.get(k, 'every session'):30s} {int(m.sum()):5d} {f1[m].mean():+7.3f} ({np.nanmean(f5[m]):+6.2f}) {t:+6.2f}   "
            for a, b in ERAS:
                e = m & (yr >= int(a)) & (yr <= int(b))
                row += f"{f1[e].mean():+6.2f} ({np.nanmean(f5[e]):+6.2f}) n={int(e.sum()):<4d} " if e.sum() else f"{'-':>22s} "
            print(row)
        idx = np.flatnonzero(sig["top"] & ~np.isnan(f5))
        if len(idx):
            first = idx[np.r_[True, np.diff(idx) > 10]]            # a new episode = no blow-off close in the prior 10 sessions
            e5, e1 = f5[first], f1[first]
            f10 = 100 * _fwd(d, 10)[first]
            print(f"  blow-off EPISODES (first close of each run): {len(first)}  next session {e1.mean():+.2f}%, "
                  f"5 sessions {e5.mean():+.2f}% (t={e5.mean() / (e5.std(ddof=1) / np.sqrt(len(e5))):+.1f}, lower {100 * (e5 < 0).mean():.0f}%), "
                  f"10 sessions {np.nanmean(f10):+.2f}%;  years: {sorted(set(yr[first]))}")


def cmd_split(args):
    print("where the next-session move arrives, in %: overnight (signal close -> next open) vs day session (open -> close)")
    for name, f in (("QQQ", "QQQ_1d.csv"), ("SPY", "SPY_1d.csv")):
        d = daily(os.path.join(args.yahoo, f))
        d = d[d.index >= "2000-01-01"]
        sig, _, st = engine(d)
        o, c = d.open.values, d.close.values
        on = np.r_[100 * (o[1:] / c[:-1] - 1), np.nan]
        dy = np.r_[100 * (c[1:] / o[1:] - 1), np.nan]
        print(f"\n{name}  {d.index[0].date()} -> {d.index[-1].date()}")
        print(f"  {'tier':30s} {'n':>5s} {'overnight':>16s} {'day session':>16s}")
        for k in TIERS + ("all",):
            m = sig[k] & ~np.isnan(on) & ~np.isnan(st["r14"])
            ts = [x[m].mean() / (x[m].std(ddof=1) / np.sqrt(m.sum())) for x in (on, dy)]
            print(f"  {NAMES.get(k, 'every session'):30s} {int(m.sum()):5d} {on[m].mean():+7.3f} (t={ts[0]:+.1f}) {dy[m].mean():+7.3f} (t={ts[1]:+.1f})")


def cmd_entry(args):
    d = daily(os.path.join(args.yahoo, "NQ_1d.csv"))
    d = d[d.index >= "2000-01-01"]
    sig, _, st = engine(d)
    h, l, c = d.high.values, d.low.values, d.close.values
    tr = np.maximum(h[1:] - l[1:], np.maximum(abs(h[1:] - c[:-1]), abs(l[1:] - c[:-1])))
    atr = np.r_[np.nan, pd.Series(tr).rolling(14).mean().values]
    print("NQ futures: buy the signal close, or rest a limit below it for the next session (filled if the low trades through)")
    print("exit at the next close / 5 closes later; 'per signal' counts unfilled limits as zero")
    for k in ("std", "prime", "cap"):
        idx = np.flatnonzero(sig[k] & ~np.isnan(atr))
        idx = idx[idx < len(c) - 6]
        print(f"\n{NAMES[k]}  ({len(idx)} signals)")
        print(f"  {'entry':28s} {'filled':>7s} {'per fill 1d':>12s} {'per fill 5d':>12s} {'per signal 1d':>14s} {'per signal 5d':>14s}")
        for off in (0.0, 0.25, 0.5, 1.0):
            px = c[idx] - off * atr[idx]
            fill = (l[idx + 1] <= px) if off else np.ones(len(idx), bool)
            px = np.minimum(px, d.open.values[idx + 1]) if off else px        # a gap through the limit fills at the open
            r1 = 100 * (c[idx + 1] / px - 1)
            r5 = 100 * (c[idx + 5] / px - 1)
            nm = "at the signal close" if not off else f"limit {off:.2f} ATR below"
            print(f"  {nm:28s} {100 * fill.mean():6.0f}% {r1[fill].mean():+11.2f}% {r5[fill].mean():+11.2f}% "
                  f"{(r1 * fill).mean():+13.2f}% {(r5 * fill).mean():+13.2f}%")


def _hourly_features(m, v):
    f = pd.DataFrame(index=m.index)
    c, h, l = m.close, m.high, m.low
    hr = m.index.tz_convert("America/New_York").hour
    f["rvol"] = m.volume / m.volume.groupby(hr).transform(lambda s: s.rolling(20, min_periods=10).median().shift(1))
    f["lo20"] = l <= l.rolling(20).min()
    f["hi20"] = h >= h.rolling(20).max()
    atr = (h - l).rolling(100, min_periods=50).mean().shift(1)
    f["z1"] = c.diff() / atr
    f["vchg"] = v.close.pct_change()
    f["vhi20"] = v.close >= v.close.rolling(20).max()
    f["vlo20"] = v.close <= v.close.rolling(20).min()
    f["vok"] = v.close.notna() & v.close.shift(1).notna()
    for k in (4, 24):
        f[f"f{k}"] = (c.shift(-k) - c) / atr          # in average hourly ranges, so the additive null stays comparable
    return f


def _hourly_conds(f):
    return {
        "BOTTOM new 20h low on volume >= 2x usual": (f.lo20 & (f.rvol >= 2), 1),
        "BOTTOM new 20h low on volume >= 3x usual": (f.lo20 & (f.rvol >= 3), 1),
        "BOTTOM new 20h low on ordinary volume (< 1.5x)": (f.lo20 & (f.rvol < 1.5), 1),
        "BOTTOM hour down > 2 ranges on volume >= 2x": ((f.z1 < -2) & (f.rvol >= 2), 1),
        "BOTTOM VIX up > 5% in the hour": (f.vok & (f.vchg > 0.05), 1),
        "BOTTOM VIX up > 8% in the hour": (f.vok & (f.vchg > 0.08), 1),
        "BOTTOM new 20h low, VIX not at a 20h high": (f.vok & f.lo20 & ~f.vhi20, 1),
        "TOP new 20h high on volume >= 2x usual": (f.hi20 & (f.rvol >= 2), -1),
        "TOP new 20h high on volume >= 3x usual": (f.hi20 & (f.rvol >= 3), -1),
        "TOP hour up > 2 ranges on volume >= 2x": ((f.z1 > 2) & (f.rvol >= 2), -1),
        "TOP VIX down > 4% in the hour": (f.vok & (f.vchg < -0.04), -1),
        "TOP new 20h high, VIX not at a 20h low": (f.vok & f.hi20 & ~f.vlo20, -1),
        "TOP new 20h high with VIX rising (> +2%)": (f.vok & f.hi20 & (f.vchg > 0.02), -1)}


def cmd_hourly(args):
    m, fixed = rz_data.clean_yahoo(rz_data.load_csv(os.path.join(args.yahoo, "MNQ_1h.csv")), k=10.0)
    v = rz_data.load_csv(os.path.join(args.yahoo, "VIX_1h.csv"))
    vx = pd.merge_asof(m[[]].reset_index(), v[["open", "high", "low", "close"]].reset_index().rename(columns={"ts": "vts"}),
                       left_on="ts", right_on="vts", direction="backward", tolerance=pd.Timedelta("90min")).set_index("ts")
    vx["volume"] = 0.0
    live = vx.close.notna().values
    print(f"real MNQ=F hourly: {len(m)} bars, {m.index[0].date()} -> {m.index[-1].date()}; {int(live.sum())} with a live VIX quote")
    real = _hourly_features(m, vx)
    conds = _hourly_conds(real)
    filled = vx[["open", "high", "low", "close", "volume"]].ffill().bfill()
    nulls = []
    for s in range(args.null):
        a, b = rz_null.scramble_pair(m, filled, 1200 + s)
        b.loc[~live, ["open", "high", "low", "close"]] = np.nan
        fs = _hourly_features(a, b)
        nulls.append((fs, _hourly_conds(fs)))
    print("move in the FADE direction (bottom = up, top = down), in average hourly ranges; z = against the scrambled copies")
    print(f"  {'signal':48s} {'n':>5s} {'next 4h':>9s} {'z':>5s} {'next 24h':>9s} {'z':>5s}")
    for name, (mask, sgn) in conds.items():
        row = f"  {name:48s} {int(mask.sum()):5d}"
        for k in (4, 24):
            y = sgn * real[f"f{k}"][mask].mean()
            nm = [sgn * fs[f"f{k}"][cs[name][0]].mean() for fs, cs in nulls]
            row += f" {y:+9.3f} {(y - np.mean(nm)) / np.std(nm):+5.1f}"
        print(row)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["scorecard", "eras", "split", "entry", "lines", "hourly"])
    ap.add_argument("--yahoo", required=True)
    ap.add_argument("--file", default="MNQ_1d.csv", help="daily CSV inside --yahoo (scorecard)")
    ap.add_argument("--null", type=int, default=40, help="scrambled copies (hourly)")
    args = ap.parse_args()
    globals()[f"cmd_{args.command}"](args)


if __name__ == "__main__":
    main()
