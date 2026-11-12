#!/usr/bin/env python3
"""Edge hunt: reversal ideas that do NOT use prior highs and lows.

Same standard as rz_research.py: every idea becomes a causal marker (it uses
only bars that closed before the marker prints), is run on real 1-minute data
and again on direction-scrambled copies (rz_null.py). A marker is a FADE: a
"top" marker expects price to fall, a "bottom" marker expects it to rise.

For each idea, separately for tops and bottoms:
    fwd60 / fwd240   mean move in the fade direction over the next 60 / 240
                     minutes, in % of the average daily range (ADR)
    hit              reversal of 0.2 x ADR before 0.06 x ADR of heat
    ... each minus the same statistic on the null, with a t / z score, and the
    60-minute edge again in each half of the sample (an edge that is real
    shows up in both).

Commands
  intraday   oscillators (RSI 14 / RSI 2, stochastic), Bollinger z-score,
             stretch from EMA 20/50/200 in ATRs, distance from the session
             average in sigmas, bar streaks, pin bars and engulfing bars at
             an extreme, RSI divergence - on 1 / 5 / 15 / 60-minute bars
  gap        fade the overnight gap / overnight move at the 09:30 open
  momentum   the published momentum effects, and follow-vs-fade after a
             confirmed directional change
  daily      daily-bar exhaustion on real NQ=F, the Nasdaq-100 index and QQQ
             since 2000: RSI(2), down/up streaks, internal bar strength,
             Bollinger bands, big down days, VXN spikes
  path       where the bounce after an oversold close actually happens
             (overnight vs next day), on 1-minute data
  dose       stress test of the exhaustion signal (RSI(2) < 10 or 3 down
             closes): dose-response, streaks, eras, years, holding period,
             trend, and the MNQ contract itself
  line       the zero-lag version: first intraday touch of the price that
             today's close must finish below to be an exhaustion close
  scorecard  the standard tier of indicators/mnq_exhaustion_reversals.pine on
             a daily CSV: the numbers its scorecard should show

Usage
  python3 rz_edge_hunt.py intraday --duka DIR [--start YYYYMMDD] [--end ...] [--null N]
  python3 rz_edge_hunt.py daily --yahoo DIR
  python3 rz_edge_hunt.py scorecard --yahoo DIR [--file MNQ_1d.csv]
"""
import argparse
import os
import sys
import warnings

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # works under `python3 -I` too
import rz_data  # noqa: E402
import rz_null  # noqa: E402
from rz_research import njit, outcome_from_open, prep  # noqa: E402

warnings.filterwarnings("ignore")
SPLIT = pd.Timestamp("2024-07-01")


# ── helpers ──────────────────────────────────────────────────────────────────

def tf_bars(a, tf):
    """Aggregate 1-minute arrays to tf-minute bars aligned to the session clock.
    Returns o, h, l, c and `nxt`: the 1-minute bar that opens right after each
    tf bar closes - the earliest moment a signal from that bar can be shown."""
    key = ((a["mins"] - 1080) % 1440) // tf
    chg = np.r_[True, (key[1:] != key[:-1]) | (a["td"][1:] != a["td"][:-1])]
    st = np.flatnonzero(chg)
    en = np.r_[st[1:] - 1, a["n"] - 1]
    return (a["o"][st], np.maximum.reduceat(a["h"], st), np.minimum.reduceat(a["l"], st), a["c"][en],
            np.r_[st[1:], a["n"]])


def rsi(c, n):
    d = pd.Series(c).diff()
    up = d.clip(lower=0).ewm(alpha=1.0 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1.0 / n, adjust=False).mean()
    return (100 - 100 / (1 + up / dn)).values


def fresh(cond):
    """Bars where a condition has just become true."""
    cond = np.asarray(cond, dtype=bool)
    return np.flatnonzero(cond[1:] & ~cond[:-1]) + 1


def gen_intraday(a):
    rows = []

    def add(test, nxt, top_bars, bot_bars):
        for bars, side in ((top_bars, 1), (bot_bars, -1)):
            if len(bars):
                rows.append(pd.DataFrame({"i0": nxt[bars], "side": side, "test": test}))

    for tf in (1, 5, 15, 60):
        o, h, l, c, nxt = tf_bars(a, tf)
        cs, hs, ls = pd.Series(c), pd.Series(h), pd.Series(l)
        tag = f"@{tf}m"
        r14 = rsi(c, 14)
        for hi, lo in ((70, 30), (80, 20), (85, 15)):
            add(f"RSI(14) {hi}/{lo} {tag}", nxt, fresh(r14 > hi), fresh(r14 < lo))
        sma, sd = cs.rolling(20).mean(), cs.rolling(20).std()
        z = ((cs - sma) / sd).values
        for k in (2.0, 2.5, 3.0):
            add(f"Bollinger {k}σ {tag}", nxt, fresh(z > k), fresh(z < -k))
        if tf == 1:
            continue
        r2 = rsi(c, 2)
        for hi, lo in ((95, 5), (98, 2)):
            add(f"RSI(2) {hi}/{lo} {tag}", nxt, fresh(r2 > hi), fresh(r2 < lo))
        tr = np.maximum(h - l, np.maximum(np.abs(h - np.r_[c[0], c[:-1]]), np.abs(l - np.r_[c[0], c[:-1]])))
        atr = pd.Series(tr).ewm(alpha=1 / 14, adjust=False).mean()
        for n_ema, ks in ((20, (2, 3, 4)), (50, (3, 5)), (200, (5, 8))):
            st = ((cs - cs.ewm(span=n_ema, adjust=False).mean()) / atr).values
            for k in ks:
                add(f"EMA{n_ema} stretch {k} ATR {tag}", nxt, fresh(st > k), fresh(st < -k))
        # stochastic %K(14,3): the classic cross back out of the extreme
        ll, hh = ls.rolling(14).min(), hs.rolling(14).max()
        k_ = (100 * (cs - ll) / (hh - ll)).rolling(3).mean().values
        add(f"Stochastic leaves 80/20 {tag}", nxt, np.flatnonzero((k_[1:] < 80) & (k_[:-1] >= 80)) + 1,
            np.flatnonzero((k_[1:] > 20) & (k_[:-1] <= 20)) + 1)
        # streaks of same-direction closes
        up = (c > np.r_[c[0], c[:-1]]).astype(int)
        dn = (c < np.r_[c[0], c[:-1]]).astype(int)
        run_up = pd.Series(up).groupby((pd.Series(up) != pd.Series(up).shift()).cumsum()).cumsum().values * up
        run_dn = pd.Series(dn).groupby((pd.Series(dn) != pd.Series(dn).shift()).cumsum()).cumsum().values * dn
        for n_run in {5: (5, 7, 9), 15: (4, 6), 60: (3, 5)}[tf]:
            add(f"{n_run} closes in a row {tag}", nxt, np.flatnonzero(run_up == n_run), np.flatnonzero(run_dn == n_run))
        # candle patterns at a 20-bar extreme
        rng = np.maximum(h - l, 1e-9)
        at_hi = h >= hs.rolling(20).max().values
        at_lo = l <= ls.rolling(20).min().values
        add(f"Pin bar at 20-bar extreme {tag}", nxt,
            np.flatnonzero(at_hi & ((h - np.maximum(o, c)) / rng >= 0.6) & ((c - l) / rng <= 0.4)),
            np.flatnonzero(at_lo & ((np.minimum(o, c) - l) / rng >= 0.6) & ((h - c) / rng <= 0.4)))
        po, pc = np.r_[o[0], o[:-1]], np.r_[c[0], c[:-1]]
        hi2 = np.maximum(h, np.r_[h[0], h[:-1]]) >= hs.rolling(20).max().values
        lo2 = np.minimum(l, np.r_[l[0], l[:-1]]) <= ls.rolling(20).min().values
        add(f"Engulfing at 20-bar extreme {tag}", nxt,
            np.flatnonzero(hi2 & (pc > po) & (c < o) & (o >= pc) & (c <= po)),
            np.flatnonzero(lo2 & (pc < po) & (c > o) & (o <= pc) & (c >= po)))
        # RSI divergence: a new 30-bar price extreme that RSI does not confirm
        rs = pd.Series(r14)
        prior_hi = rs.shift(5).rolling(25).max().values
        prior_lo = rs.shift(5).rolling(25).min().values
        new_hi = h > hs.shift(1).rolling(30).max().values
        new_lo = l < ls.shift(1).rolling(30).min().values
        add(f"RSI divergence {tag}", nxt,
            np.flatnonzero(new_hi & (prior_hi > 70) & (r14 < prior_hi - 5)),
            np.flatnonzero(new_lo & (prior_lo < 30) & (r14 > prior_lo + 5)))

    # distance from the session average price, in running sigmas (1-minute bars)
    tp = (a["h"] + a["l"] + a["c"]) / 3.0
    for name, start_min in (("globex", 1080), ("RTH", 570)):
        m = (a["mins"] - start_min) % 1440
        seg = np.r_[True, (m[1:] < m[:-1]) | (a["td"][1:] != a["td"][:-1])].cumsum()
        g = pd.Series(tp).groupby(seg)
        cnt = g.cumcount() + 1
        mean = g.cumsum() / cnt
        var = (pd.Series(tp * tp).groupby(seg).cumsum() / cnt - mean * mean).clip(lower=0)
        zz = ((a["c"] - mean) / np.sqrt(var)).where(cnt >= 60).values
        if name == "RTH":
            zz = np.where((a["mins"] >= 630) & (a["mins"] < 960), zz, np.nan)
        nxt1 = np.arange(1, a["n"] + 1)
        for k in (2.0, 2.5, 3.0):
            add(f"Session average {k}σ ({name})", nxt1, fresh(np.nan_to_num(zz, nan=0.0) > k),
                fresh(np.nan_to_num(zz, nan=0.0) < -k))
    ev = pd.concat(rows, ignore_index=True)
    return ev[ev.i0 < a["n"] - 245]


def gen_gap(a):
    """At the 09:30 open, fade the gap from the prior 16:00 close and, separately,
    the whole overnight move since 18:00."""
    mins, td, o, c, adr = a["mins"], a["td"], a["o"], a["c"], a["adr"]
    i_open = np.flatnonzero((mins >= 570) & (mins < 960) & np.r_[True, (mins[:-1] < 570) | (td[1:] != td[:-1])])
    rows = []
    last_rth_close = pd.Series(np.where((mins >= 570) & (mins < 960), c, np.nan)).ffill().shift(1).values
    sess_open = pd.Series(np.where(np.r_[True, td[1:] != td[:-1]], o, np.nan)).ffill().values
    for name, ref in (("gap vs prior close", last_rth_close), ("overnight move", sess_open)):
        mv = (o[i_open] - ref[i_open]) / adr[i_open]
        ok = np.isfinite(mv) & (mv != 0)
        b = pd.cut(np.abs(mv[ok]), [0, 0.1, 0.25, 0.5, 9], labels=["<0.1", "0.1-0.25", "0.25-0.5", ">0.5"])
        rows.append(pd.DataFrame({"i0": i_open[ok], "side": np.sign(mv[ok]).astype(int),
                                  "test": [f"Fade {name} {x} ADR" for x in b]}))
    ev = pd.concat(rows, ignore_index=True)
    return ev[ev.i0 < a["n"] - 400]


@njit(cache=True)
def _eval(o, h, l, c, adr, i0s, sides):
    m = len(i0s)
    out = np.full((m, 4), np.nan)
    hg = np.zeros(1)
    for k in range(m):
        i0 = i0s[k]
        a = adr[i0]
        if not (a > 0.0):
            continue
        p0 = o[i0]
        s = sides[k]
        out[k, 0] = 100.0 * s * (p0 - c[i0 + 14]) / a
        out[k, 1] = 100.0 * s * (p0 - c[i0 + 59]) / a
        out[k, 2] = 100.0 * s * (p0 - c[i0 + 239]) / a
        hg[0] = 0.06 * a
        out[k, 3] = 1.0 if outcome_from_open(h, l, i0, p0, s, min(len(c), i0 + 600), hg)[0] >= 0.2 * a else 0.0
    return out


def evaluate(a, ev):
    r = _eval(a["o"], a["h"], a["l"], a["c"], a["adr"], ev.i0.values.astype(np.int64), ev.side.values.astype(np.int64))
    ev = ev.assign(f15=r[:, 0], f60=r[:, 1], f240=r[:, 2], hit=r[:, 3], date=a["td"][ev.i0.values]).dropna(subset=["f60"])
    ev["half"] = np.where(pd.to_datetime(ev.date) < SPLIT, 1, 2)
    ev["sd"] = np.where(ev.side > 0, "top", "bottom")
    return ev


def run(df, gen, n_null):
    def one(d):
        a = prep(d)
        return evaluate(a, gen(a))
    return one(df), [one(rz_null.scramble(df, 900 + s)) for s in range(n_null)]


def report(real, nulls, min_n=150):
    key = ["test", "sd"]
    g = real.groupby(key)
    out = pd.DataFrame({"n": g.size(), "f60": g.f60.mean(), "f240": g.f240.mean(), "hit%": 100 * g.hit.mean(),
                        "se60": g.f60.std() / np.sqrt(g.size()), "se240": g.f240.std() / np.sqrt(g.size())})
    nm = lambda col, scale=1.0: pd.concat([scale * x.groupby(key)[col].mean() for x in nulls], axis=1).mean(axis=1)  # noqa: E731
    out["edge60"] = out.f60 - nm("f60")
    out["t60"] = out.edge60 / out.se60
    out["edge240"] = out.f240 - nm("f240")
    out["t240"] = out.edge240 / out.se240
    nh = nm("hit", 100.0)
    out["hit_lift"] = out["hit%"] - nh
    out["z_hit"] = out.hit_lift / (100 * np.sqrt(nh / 100 * (1 - nh / 100) / out.n))
    for hf in (1, 2):
        rh = real[real.half == hf].groupby(key).f60.mean()
        nhf = pd.concat([x[x.half == hf].groupby(key).f60.mean() for x in nulls], axis=1).mean(axis=1)
        out[f"edge60_h{hf}"] = rh - nhf
    return out[out.n >= min_n].drop(columns=["se60", "se240", "f60", "f240"])


# ── commands ─────────────────────────────────────────────────────────────────

def cmd_intraday(args, gen=gen_intraday, title="intraday reversal ideas"):
    df = rz_data.load_duka(args.duka, start=args.start, end=args.end)
    real, nulls = run(df, gen, args.null)
    tab = report(real, nulls, 150 if gen is gen_intraday else 40)
    print(f"{title}: {len(real):,} markers on {real.date.nunique()} sessions; {len(tab)} idea x side cells; "
          f"edge = real minus null, in % of ADR (fade direction positive)")
    cells = len(tab)
    print(f"|t60| > 2 in {(tab.t60.abs() > 2).sum()} cells, |t240| > 2 in {(tab.t240.abs() > 2).sum()}, "
          f"|z_hit| > 2 in {(tab.z_hit.abs() > 2).sum()}  (chance alone gives ~{0.0455 * cells:.0f} each)")
    both = tab[(tab.edge60_h1 > 0) & (tab.edge60_h2 > 0) & (tab.t60 > 2)]
    print(f"positive in BOTH halves with t60 > 2: {len(both)} cells")
    pd.set_option("display.width", 250)
    pd.set_option("display.max_rows", 400)
    cols = ["n", "edge60", "t60", "edge240", "t240", "hit%", "hit_lift", "z_hit", "edge60_h1", "edge60_h2"]
    if args.full:
        print(tab[cols].round(2).to_string())
    else:
        print("\n-- 15 strongest fade edges (by t60) --")
        print(tab.sort_values("t60", ascending=False)[cols].head(15).round(2).to_string())
        print("\n-- 15 strongest continuation edges (fade loses) --")
        print(tab.sort_values("t60")[cols].head(15).round(2).to_string())
    if args.save:
        tab.to_csv(args.save)


def cmd_gap(args):
    cmd_intraday(args, gen_gap, "gap / overnight-move fades at 09:30")


def cmd_momentum(args):
    df = rz_data.load_duka(args.duka, start=args.start, end=args.end)
    a = prep(df)
    mins, td, o, c = a["mins"], a["td"], a["o"], a["c"]
    d = pd.DataFrame({"td": td, "mins": mins, "o": o, "c": c})
    rth = d[(d.mins >= 570) & (d.mins < 960)]
    g = rth.groupby("td")
    day = pd.DataFrame({"open": g.o.first(), "close": g.c.last(),
                        "c1000": rth[rth.mins < 600].groupby("td").c.last(),
                        "c1530": rth[rth.mins < 930].groupby("td").c.last()})
    day["prev_close"] = day.close.shift(1)
    day = day.dropna()
    r_first = day.c1000 / day.prev_close - 1          # prior close -> 10:00 (Gao et al.)
    r_mid = day.c1530 / day.c1000 - 1
    r_last = day.close / day.c1530 - 1
    r_open = day.c1000 / day.open - 1
    print(f"{len(day)} sessions, {day.index[0].date()} -> {day.index[-1].date()}")
    for name, x in (("prior close -> 10:00", r_first), ("09:30 -> 10:00", r_open), ("10:00 -> 15:30", r_mid),
                    ("prior close -> 15:30", day.c1530 / day.prev_close - 1)):
        rho = np.corrcoef(x, r_last)[0, 1]
        cond = (np.sign(x) * r_last)
        print(f"  {name:22s} vs last half hour: corr {rho:+.3f}  (t = {rho * np.sqrt(len(x) - 2) / np.sqrt(1 - rho * rho):+.2f});  "
              f"following it earns {1e4 * cond.mean():+.2f} bp per session (t = {cond.mean() / (cond.std() / np.sqrt(len(cond))):+.2f})")
    # follow vs fade after a confirmed directional change of theta x ADR
    print("\nAfter a confirmed directional change of theta x ADR: mean further move in the NEW direction\n"
          "before the next opposite change is confirmed, minus theta (0 = no edge; > 0 = follow; < 0 = fade)")
    for theta in (0.1, 0.2, 0.3, 0.5):
        res = []
        for series in [df] + [rz_null.scramble(df, 700 + s) for s in range(args.null)]:
            b = prep(series)
            res.append(_dc_pnl(b["h"], b["l"], b["c"], theta * np.nan_to_num(b["adr"], nan=0.0), b["adr"]))
        real, nl = res[0], res[1:]
        nmean = np.mean([x.mean() for x in nl])
        print(f"  theta {theta:.1f}: {len(real):6d} changes, follow P&L {100 * real.mean():+.2f}% of ADR  "
              f"(null {100 * nmean:+.2f}, edge {100 * (real.mean() - nmean):+.2f}, t = {(real.mean() - nmean) / (real.std() / np.sqrt(len(real))):+.2f})")


@njit(cache=True)
def _dc_pnl(high, low, close, thr, adr):
    """Enter with the new direction at the close of the bar that confirms a
    directional change; exit at the close of the bar that confirms the next
    one. P&L in ADR units."""
    n = len(close)
    out = np.empty(n)
    k = 0
    hi = high[0]
    lo = low[0]
    direction = 0
    entry = np.nan
    for i in range(1, n):
        t = thr[i]
        if not (t > 0.0):
            continue
        if direction >= 0 and high[i] > hi:
            hi = high[i]
        if direction <= 0 and low[i] < lo:
            lo = low[i]
        new_dir = 0
        if direction >= 0 and hi - low[i] >= t:
            new_dir = -1
        elif direction <= 0 and high[i] - lo >= t:
            new_dir = 1
        if new_dir != 0:
            if entry == entry and direction != 0:
                out[k] = direction * (close[i] - entry) / adr[i]
                k += 1
            direction = new_dir
            entry = close[i]
            hi = high[i]
            lo = low[i]
    return out[:k]


def _daily(path):
    d = pd.read_csv(path)
    d.index = pd.to_datetime(d.time, unit="s").dt.normalize()
    return d[["open", "high", "low", "close"]]


def cmd_daily(args):
    vxn = _daily(os.path.join(args.yahoo, "VXN_1d.csv")).close
    for name, f in (("NQ=F futures (close -> next close)", "NQ_1d.csv"), ("Nasdaq-100 index", "NDX_1d.csv"),
                    ("QQQ", "QQQ_1d.csv")):
        d = _daily(os.path.join(args.yahoo, f)).loc["2000":]
        c = d.close
        ret = c.pct_change()
        chg = c.diff()
        r2 = 100 - 100 / (1 + chg.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
                          / (-chg.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean())
        ibs = (c - d.low) / (d.high - d.low)
        z = (c - c.rolling(20).mean()) / c.rolling(20).std()
        v = vxn.reindex(c.index)
        vz = (v - v.rolling(10).mean()) / v.rolling(10).mean()
        dn = lambda k: (ret < 0).rolling(k).sum() == k      # noqa: E731
        up = lambda k: (ret > 0).rolling(k).sum() == k      # noqa: E731
        conds = {
            "all days": pd.Series(True, index=c.index),
            "BOTTOMS  RSI(2) < 10": r2 < 10, "         RSI(2) < 5": r2 < 5,
            "         3 down closes": dn(3), "         4 down closes": dn(4),
            "         close in bottom 20% of range (IBS)": ibs < 0.2, "         IBS < 0.1": ibs < 0.1,
            "         close < lower Bollinger (2σ)": z < -2, "         day down > 2%": ret < -0.02,
            "         VXN > 10-day avg + 15%": vz > 0.15,
            "         RSI(2) < 10 and IBS < 0.2": (r2 < 10) & (ibs < 0.2),
            "         RSI(2) < 10, close > 200-day avg": (r2 < 10) & (c > c.rolling(200).mean()),
            "         RSI(2) < 10, close < 200-day avg": (r2 < 10) & (c < c.rolling(200).mean()),
            "TOPS     RSI(2) > 90": r2 > 90, "         RSI(2) > 95": r2 > 95,
            "         3 up closes": up(3), "         4 up closes": up(4),
            "         close in top 20% of range (IBS)": ibs > 0.8,
            "         close > upper Bollinger (2σ)": z > 2, "         day up > 2%": ret > 0.02,
            "         VXN < 10-day avg - 10%": vz < -0.10,
            "         RSI(2) > 90, close < 200-day avg": (r2 > 90) & (c < c.rolling(200).mean()),
        }
        f1 = c.shift(-1) / c - 1
        on = d.open.shift(-1) / c - 1              # close -> next open (cash products only)
        intr = c.shift(-1) / d.open.shift(-1) - 1  # next open -> next close
        cash = "futures" not in name
        print(f"\n===== {name}: {c.index[0].date()} -> {c.index[-1].date()} =====")
        print(f"{'next-session return after ...':46s} " + "".join(f"{e:>30s}" for e in ("2000-2012", "2013-2020", "2021-2026")))
        for label, m in conds.items():
            line = f"{label:46s} "
            for a_, b_ in (("2000", "2012"), ("2013", "2020"), ("2021", "2026")):
                y = f1[m].loc[a_:b_].dropna()
                if len(y) < 20:
                    line += f"{'n<20':>30s}"
                    continue
                line += f"{f'n={len(y):4d} {100 * y.mean():+.2f}% t={y.mean() / (y.std() / np.sqrt(len(y))):+.1f} up {100 * (y > 0).mean():.0f}%':>30s}"
            print(line)
        if cash:
            print("  split of the next session (2000-2026): overnight (close -> open) / day (open -> close)")
            for label in ("all days", "BOTTOMS  RSI(2) < 10", "         3 down closes", "         IBS < 0.1",
                          "TOPS     RSI(2) > 90"):
                m = conds[label]
                a_, b_ = on[m].dropna(), intr[m].dropna()
                print(f"  {label:44s} overnight {100 * a_.mean():+.3f}% (t={a_.mean() / (a_.std() / np.sqrt(len(a_))):+.1f})   "
                      f"day {100 * b_.mean():+.3f}% (t={b_.mean() / (b_.std() / np.sqrt(len(b_))):+.1f})")


def cmd_path(args):
    """After an oversold close, where does the bounce happen? 1-minute data."""
    df = rz_data.load_duka(args.duka, start=args.start, end=args.end)
    a = prep(df)
    mins, td, c, h, l, adr = a["mins"], a["td"], a["c"], a["h"], a["l"], a["adr"]
    d = pd.DataFrame({"td": td, "mins": mins, "c": c, "i": np.arange(a["n"])})
    rth = d[(d.mins >= 570) & (d.mins < 960)]
    day = rth.groupby("td").agg(close=("c", "last"), i_close=("i", "last"), i_open=("i", "first"))
    chg = day.close.diff()
    r2 = 100 - 100 / (1 + chg.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
                      / (-chg.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean())
    ret = day.close.pct_change()
    day["sig_rsi"] = r2 < 10
    day["sig_3dn"] = (ret < 0).rolling(3).sum() == 3
    day["sig_top"] = r2 > 90
    day["nxt_open"] = day.i_open.shift(-1)
    day["nxt_close"] = day.i_close.shift(-1)
    day = day.dropna(subset=["nxt_open", "nxt_close"])
    day["a"] = adr[day.i_close.values]
    day = day[day.a > 0]
    px = lambda idx: c[idx.values.astype(int)]       # noqa: E731
    day["overnight"] = 100 * (px(day.nxt_open) - day.close) / day.a
    day["next_day"] = 100 * (px(day.nxt_close) - px(day.nxt_open)) / day.a
    day["total"] = day.overnight + day.next_day
    hg = np.zeros(1)
    for col, T in (("up0.2", 0.2), ("up0.4", 0.4)):
        res = []
        for i, a_ in zip(day.i_close.values.astype(int), day.a.values):
            hg[0] = 0.5 * T * a_
            # bottom marker at the close: rise of T x ADR before a drop of T/2 x ADR
            res.append(outcome_from_open(h, l, i + 1, c[i], -1, min(a["n"], i + 1 + 2760), hg)[0] >= T * a_)
        day[col] = res
    print(f"{len(day)} sessions {day.index[0].date()} -> {day.index[-1].date()}; moves in % of ADR; marker at the 16:00 close")
    print(f"{'':28s} {'n':>5s} {'overnight':>18s} {'next day 9:30-16:00':>22s} {'close->next close':>20s} "
          f"{'+0.2 ADR before -0.1':>22s} {'+0.4 before -0.2':>18s}")
    for name, m in (("all sessions", day.total == day.total), ("RSI(2) < 10 at the close", day.sig_rsi),
                    ("3 down closes", day.sig_3dn), ("RSI(2) > 90 at the close", day.sig_top)):
        x = day[m]
        f = lambda s: f"{s.mean():+6.1f} (t={s.mean() / (s.std() / np.sqrt(len(s))):+.1f})"   # noqa: E731
        print(f"{name:28s} {len(x):5d} {f(x.overnight):>18s} {f(x.next_day):>22s} {f(x.total):>20s} "
              f"{100 * x['up0.2'].mean():21.1f}% {100 * x['up0.4'].mean():17.1f}%")
    print("(a market with no memory gives 33.3% in both barrier columns)")


def _exh_features(d):
    c = d.close
    chg = c.diff()
    d = d.copy()
    d["rsi2"] = 100 - 100 / (1 + chg.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
                             / (-chg.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean())
    dn = (chg < 0).astype(int)
    d["streak"] = dn.groupby((dn != dn.shift()).cumsum()).cumsum() * dn
    for k in (1, 2, 3, 5):
        d[f"f{k}"] = c.shift(-k) / c - 1
    d["hi1"] = d.high.shift(-1) / c - 1
    d["lo1"] = d.low.shift(-1) / c - 1
    d["up200"] = c > c.rolling(200).mean()
    d["sig"] = (d.rsi2 < 10) | (d.streak >= 3)
    return d


def _st(y):
    y = y.dropna()
    if len(y) < 15:
        return f"n={len(y)}"
    return f"n={len(y):4d} {100 * y.mean():+.3f}% t={y.mean() / (y.std() / np.sqrt(len(y))):+.2f} up {100 * (y > 0).mean():.0f}%"


def cmd_dose(args):
    nq = _exh_features(_daily(os.path.join(args.yahoo, "NQ_1d.csv")).loc["2000":])
    ndx = _exh_features(_daily(os.path.join(args.yahoo, "NDX_1d.csv")).loc["2000":])
    mnq = _exh_features(_daily(os.path.join(args.yahoo, "MNQ_1d.csv")))
    print("next-session return by RSI(2) at the close        NQ=F futures 2000-2026           |  Nasdaq-100 index")
    for lo, hi in ((0, 5), (5, 10), (10, 20), (20, 35), (35, 65), (65, 80), (80, 90), (90, 95), (95, 100)):
        print(f"  RSI(2) {lo:3d}-{hi:3d}   {_st(nq.f1[(nq.rsi2 >= lo) & (nq.rsi2 < hi)])}   |  {_st(ndx.f1[(ndx.rsi2 >= lo) & (ndx.rsi2 < hi)])}")
    print("\nby down-close streak")
    for k in range(6):
        a_, b_ = ((nq.streak == k), (ndx.streak == k)) if k < 5 else ((nq.streak >= 5), (ndx.streak >= 5))
        print(f"  {k}{'+' if k == 5 else ' '} down closes  {_st(nq.f1[a_])}   |  {_st(ndx.f1[b_])}")
    print("\nsignal = RSI(2) < 10 OR 3+ down closes")
    for name, d in (("NQ=F futures", nq), ("Nasdaq-100 index", ndx), ("MNQ=F futures", mnq)):
        print(f"  {name:17s} after a signal: {_st(d.f1[d.sig])} | every other day: {_st(d.f1[~d.sig])} | {100 * d.sig.mean():.0f}% of days")
        for a_, b_ in (("2000", "2012"), ("2013", "2020"), ("2021", "2026")):
            x = d.loc[a_:b_]
            if len(x) > 300:
                print(f"      {a_}-{b_}: signal {_st(x.f1[x.sig])} | other {_st(x.f1[~x.sig])}")
    print("\nNQ=F: holding 1 / 2 / 3 / 5 sessions after a signal vs any day")
    for k in (1, 2, 3, 5):
        print(f"  {k} sessions: {_st(nq[f'f{k}'][nq.sig])} | any day {_st(nq[f'f{k}'])}")
    print(f"\nNQ=F by trend:  above the 200-day average {_st(nq.f1[nq.sig & nq.up200])} | below it {_st(nq.f1[nq.sig & ~nq.up200])}")
    ex = (nq[nq.sig].groupby(nq[nq.sig].index.year).f1.mean() - nq.groupby(nq.index.year).f1.mean()).dropna()
    print(f"NQ=F by year, signal days minus all days: positive in {(ex > 0).sum()} of {len(ex)} years")
    print("  " + "  ".join(f"{y}:{100 * v:+.2f}" for y, v in ex.items()))
    x = nq[nq.sig].dropna(subset=["hi1"])
    sc = 27500.0
    print(f"\nNQ=F, the session after a signal (n={len(x)}), scaled to an index of {sc:,.0f}:")
    print(f"  close to close: mean {sc * x.f1.mean():+.0f} pts, median {sc * x.f1.median():+.0f} (all days: mean {sc * nq.f1.mean():+.0f})")
    print(f"  its high is a median {sc * x.hi1.median():+.0f} pts above the signal close; 100+ pts above on {100 * (x.hi1 >= 100 / sc).mean():.0f}% (all days {100 * (nq.hi1 >= 100 / sc).mean():.0f}%)")
    print(f"  its low  is a median {sc * x.lo1.median():+.0f} pts below the signal close; 100+ pts below on {100 * (x.lo1 <= -100 / sc).mean():.0f}% (all days {100 * (nq.lo1 <= -100 / sc).mean():.0f}%)")


def _line_events(df):
    a = prep(df)
    mins, td, o, h, l, c, adr, n = a["mins"], a["td"], a["o"], a["h"], a["l"], a["c"], a["adr"], a["n"]
    d = pd.DataFrame({"td": td, "mins": mins, "c": c, "i": np.arange(n)})
    rth = d[(d.mins >= 570) & (d.mins < 960)]
    day = rth.groupby("td").agg(close=("c", "last"), i_close=("i", "last"))
    day["i_start"] = d.groupby("td").i.first().reindex(day.index)
    chg = day.close.diff()
    G = chg.clip(lower=0).ewm(alpha=0.5, adjust=False).mean().shift(1)
    L = (-chg.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean().shift(1)
    P = day.close.shift(1)
    x = np.where(9 * G - L > 0, P - (9 * G - L), P + (L - 9 * G) / 9)           # close below this -> RSI(2) < 10
    two_dn = (chg < 0).shift(1) & (chg < 0).shift(2)
    day["x"] = np.where(two_dn, np.maximum(x, P), x)                           # ... or a third down close
    day["nxt"] = day.close.shift(-1)
    rows = []
    hg = np.zeros(1)
    for t, r in day.dropna(subset=["x", "nxt", "i_start"]).iterrows():
        a0, b0 = int(r.i_start), int(r.i_close)
        A = adr[b0]
        if not (A > 0) or b0 - a0 < 300:
            continue
        k = np.flatnonzero(l[a0:b0 + 1] <= r.x)
        if len(k) == 0:
            continue
        i0 = a0 + int(k[0])
        p0 = min(r.x, o[i0])
        hg[0] = 0.1 * A
        rows.append({"rth": 570 <= mins[i0] < 960, "to_close": 100 * (r.close - p0) / A,
                     "to_next": 100 * (r.nxt - p0) / A, "confirmed": r.close < r.x,
                     "up": outcome_from_open(h, l, i0 + 1, p0, -1, min(n, i0 + 2761), hg)[0] >= 0.2 * A,
                     "heat": 100 * (p0 - l[i0:b0 + 1].min()) / A})
    return pd.DataFrame(rows), len(day)


def cmd_line(args):
    df = rz_data.load_duka(args.duka, start=args.start, end=args.end)
    real, nd = _line_events(df)
    nulls = [_line_events(rz_null.scramble(df, 300 + s))[0] for s in range(args.null)]
    f = lambda s_: f"{s_.mean():+6.1f} (t={s_.mean() / (s_.std() / np.sqrt(len(s_))):+.1f})"      # noqa: E731
    nm = lambda col: np.mean([x[col].mean() for x in nulls])                                       # noqa: E731
    print(f"{nd} sessions; the exhaustion line was touched on {len(real)} ({100 * len(real) / nd:.0f}%); "
          f"the close stayed below it on {100 * real.confirmed.mean():.0f}% of those")
    print("buying the first touch, moves in % of ADR:")
    print(f"  touch -> that day's 16:00 close   real {f(real.to_close)}   null {nm('to_close'):+.1f}")
    print(f"  touch -> next day's 16:00 close   real {f(real.to_next)}   null {nm('to_next'):+.1f}")
    print(f"  +0.2 ADR before -0.1 ADR          real {100 * real.up.mean():.1f}%   null {100 * nm('up'):.1f}%   (no memory: 33.3%)")
    print(f"  drawdown after the touch, same day: median {real.heat.median():.0f}% of ADR, 75th percentile {real.heat.quantile(.75):.0f}%")
    for name, m in (("touched overnight", ~real.rth), ("touched 09:30-16:00", real.rth)):
        print(f"  {name:20s} n={m.sum():3d}  touch -> next close {f(real.to_next[m])}")


def cmd_scorecard(args):
    """The standard tier of mnq_exhaustion_reversals.pine (rz_tiers.py mirrors every tier)."""
    d = _daily(os.path.join(args.yahoo, args.file))
    close = d.close.values
    n = len(close)
    rsiLen, rsiThr, streakLen = 2, 10.0, 3
    g = np.full(n, np.nan)
    lo = np.full(n, np.nan)
    rsi = np.full(n, np.nan)
    sig = np.zeros(n, bool)
    streak = np.zeros(n, int)
    cum = np.zeros((n, 12))            # nS sS qS wS nO sO qO wO n5 s5 nA sA
    for i in range(n):
        chg = close[i] - close[i - 1] if i >= 1 else np.nan
        up, dn = (max(chg, 0.0), max(-chg, 0.0)) if i >= 1 else (np.nan, np.nan)
        if i == rsiLen:                                   # ta.rma seeds with the SMA of the first `length` values
            ch = np.diff(close[:rsiLen + 1])
            g[i], lo[i] = np.maximum(ch, 0).mean(), np.maximum(-ch, 0).mean()
        elif i > rsiLen:
            g[i] = (g[i - 1] * (rsiLen - 1) + up) / rsiLen
            lo[i] = (lo[i - 1] * (rsiLen - 1) + dn) / rsiLen
        if i >= rsiLen:
            rsi[i] = 100.0 if lo[i] == 0 else 100.0 - 100.0 / (1.0 + g[i] / lo[i])
        streak[i] = streak[i - 1] + 1 if i >= 1 and chg < 0 else 0
        sig[i] = (not np.isnan(rsi[i]) and rsi[i] < rsiThr) or streak[i] >= streakLen
        cum[i] = cum[i - 1] if i else 0
        if i >= 1 and not np.isnan(rsi[i - 1]):
            r1 = close[i] / close[i - 1] - 1.0
            j = 0 if sig[i - 1] else 4
            cum[i, j:j + 4] += (1, r1, r1 * r1, 1 if r1 > 0 else 0)
        if i >= 5 and not np.isnan(rsi[i - 5]):
            r5 = close[i] / close[i - 5] - 1.0
            cum[i, 10:12] += (1, r5)
            if sig[i - 5]:
                cum[i, 8:10] += (1, r5)
    nS, sS, qS, wS, nO, sO, qO, wO, n5, s5, nA, sA = cum[n - 2]        # the trailing [1]: last COMPLETED bar
    avgS, avgO = sS / nS, sO / nO
    tval = (avgS - avgO) / np.sqrt(max(qS / nS - avgS ** 2, 0) / nS + max(qO / nO - avgO ** 2, 0) / nO)
    pG, pL, pC, pStreak = g[n - 2], lo[n - 2], close[n - 2], streak[n - 2]
    q = rsiThr / (100.0 - rsiThr)
    d0 = pG * (rsiLen - 1) / q - pL * (rsiLen - 1)
    x = pC - d0 if d0 > 0 else pC - q * d0
    if pStreak >= streakLen - 1:
        x = max(x, pC)
    print(f"{args.file}: {n} daily bars, {d.index[0].date()} -> {d.index[-1].date()}  (last bar treated as the session in progress)")
    print(f"  After an exhaustion close   {int(nS):5d} sessions   {100 * avgS:+.3f}%  ≈ {avgS * close[-1]:+.0f} pts   closed higher {100 * wS / nS:.0f}%")
    print(f"  After every other close     {int(nO):5d} sessions   {100 * avgO:+.3f}%  ≈ {avgO * close[-1]:+.0f} pts   closed higher {100 * wO / nO:.0f}%")
    print(f"  Difference: t = {tval:.2f}")
    print(f"  Next 5 sessions: {100 * s5 / n5:+.3f}% after a signal vs {100 * sA / nA:+.3f}% for any 5 sessions")
    print(f"  Last completed close {pC:,.2f}: RSI(2) {rsi[n - 2]:.1f}, {pStreak} down closes -> "
          f"{'BOUNCE SESSION' if sig[n - 2] else 'no signal'};  exhaustion line for the session in progress: {x:,.2f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["intraday", "gap", "momentum", "daily", "path", "dose", "line", "scorecard"])
    ap.add_argument("--duka")
    ap.add_argument("--yahoo")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--null", type=int, default=6)
    ap.add_argument("--full", action="store_true", help="print every cell instead of the strongest")
    ap.add_argument("--save")
    ap.add_argument("--file", default="MNQ_1d.csv", help="daily CSV inside --yahoo (scorecard)")
    args = ap.parse_args()
    need = {"intraday": "duka", "gap": "duka", "momentum": "duka", "daily": "yahoo", "path": "duka", "dose": "yahoo",
            "line": "duka", "scorecard": "yahoo"}[args.command]
    if not getattr(args, need):
        ap.error(f"`{args.command}` needs --{need}")
    globals()[f"cmd_{args.command}"](args)


if __name__ == "__main__":
    main()
