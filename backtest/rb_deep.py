#!/usr/bin/env python3
"""Can anything lift the share of blocks that go on to 100 points?

Same strict rules as indicators/mnq_reversal_blocks.pine (60-point block at a
session level, HIT = 45 points from the extreme made at the block, 100+ = 100
points, a candle closing beyond the block ends it). The blocks are the
session levels and opens; each level counts once per day.

Everything here is known BEFORE the touch candle opens. Beyond the conditions
already tested in rb_hunt.py, the new ideas are:

  how the level was made   the wick that rejected it, how far price closed
                           away in the next 15 minutes, how many candles
                           traded at it, how old it is, how far price left
                           before coming back
  what today's earlier     blocks already broken / hit / gone to 100+ today,
  blocks did               on the same side and on the other side
  how choppy today is      completed 100-point swings so far, the session's
                           efficiency ratio (net move / path length)
  how fast the market is   100 points in units of the last hour's candle
                           range, and of the usual range of this time slot
  known territory          how many of the last 5 days traded beyond the level
  yesterday                its range against the average, daily RSI(14),
                           distance from the 20-day average

Commands
  table   each new idea in buckets: hit rate and 100+ rate, real and on
          direction-scrambled copies (chance), in both halves of the sample
  model   gradient-boosted trees on every feature, trained on the first part
          of the history and judged on the rest: the 100+ rate of the blocks
          it ranks highest, on real data and on a scrambled copy
  after   once a block HAS hit: how often it goes on to 100+, by how deep
          into the block the turn was made and how long the hit took

  python3 rb_deep.py table --duka data/nq --start 20221109 --null 4
  python3 rb_deep.py model --duka data/nq --start 20170301 --scale --split 20221109
  python3 rb_deep.py after --duka data/nq --start 20221109 --null 4
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from numba import njit

import rb_blocks
import rb_hunt
import rz_null
import rz_tiers

SESSION = ("AS", "LO", "ON", "OR5", "OR15", "OR30", "IB", "AM", "LUNCH", "GO", "MO", "RO")
MASKS = {"AS": lambda m: (m >= 1080) | (m < 180), "LO": lambda m: (m >= 180) & (m < 570), "ON": lambda m: (m >= 1080) | (m < 570),
         "OR5": lambda m: (m >= 570) & (m < 575), "OR15": lambda m: (m >= 570) & (m < 585), "OR30": lambda m: (m >= 570) & (m < 600),
         "IB": lambda m: (m >= 570) & (m < 630), "AM": lambda m: (m >= 570) & (m < 720), "LUNCH": lambda m: (m >= 720) & (m < 810)}


@njit(cache=True)
def grade2(o, h, l, c, td, ev_i, ev_lv, ev_side, ev_w, ev_tg, ev_hit, ev_ttl):
    """rb_zoo.grade plus when things happened: touch, hit and end candles, and
    how deep into the block the extreme was when the hit registered."""
    n, m = len(o), len(ev_i)
    res = np.zeros(m, np.int8)                 # 0 never touched, 1 went on to the target, 2 broken, 3 open
    ti = np.full(m, -1, np.int64)
    hi = np.full(m, -1, np.int64)
    ri = np.full(m, -1, np.int64)
    dep = np.full(m, np.nan)
    for k in range(m):
        i0, s = ev_i[k], ev_side[k]
        near = ev_lv[k]
        far = near + s * ev_w[k]
        if i0 >= n or s * (o[i0] - near) >= 0:
            continue
        waited = played = 0
        touched = False
        turn = best = 0.0
        for i in range(i0, n):
            if i > i0 and td[i] != td[i - 1]:
                if not touched:
                    waited += 1
                    if waited > ev_ttl[k]:
                        break
                else:
                    played += 1
                    if played >= 2:
                        res[k], ri[k] = 3, i - 1
                        break
            ext = h[i] if s > 0 else l[i]
            opp = l[i] if s > 0 else h[i]
            first = False
            if not touched:
                if s * (ext - near) < 0:
                    continue
                touched, first, turn = True, True, ext
                ti[k] = i
            newturn = ext if s * (ext - turn) > 0 else turn
            if s * (c[i] - far) > 0:                        # a close beyond the block ends it
                res[k], ri[k] = 2, i
                break
            if not first and s * (turn - opp) > best:
                best = s * (turn - opp)
                if hi[k] < 0 and best >= ev_hit[k]:
                    hi[k], dep[k] = i, s * (turn - near)
            if s * (newturn - c[i]) > best:
                best = s * (newturn - c[i])
                if hi[k] < 0 and best >= ev_hit[k]:
                    hi[k], dep[k] = i, s * (newturn - near)
            if best >= ev_tg[k]:
                res[k], ri[k] = 1, i
                break
            turn = newturn
    return res, ti, hi, ri, dep


@njit(cache=True)
def swing_count(h, l, td, size):
    """Completed reversals of at least `size` since the 18:00 open, as known before each candle."""
    n = len(h)
    out = np.zeros(n, np.int64)
    cnt, direction = 0, 0
    hi_ = lo_ = 0.0
    for i in range(n):
        if i == 0 or td[i] != td[i - 1]:
            cnt, direction, hi_, lo_ = 0, 0, h[i], l[i]
        out[i] = cnt
        hi_, lo_ = max(hi_, h[i]), min(lo_, l[i])
        if direction >= 0 and hi_ - l[i] >= size[i]:        # fell `size` from the running high
            cnt += 1 if direction != 0 else 0
            direction, lo_ = -1, l[i]
            hi_ = h[i]
        elif direction <= 0 and h[i] - lo_ >= size[i]:      # rose `size` from the running low
            cnt += 1 if direction != 0 else 0
            direction, hi_ = 1, h[i]
            lo_ = l[i]
    return out


def build(B, args, vxn):
    """One row per touched session-level block: outcome + everything known before its touch candle opened."""
    o, h, l, c, mod, td = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"]
    n = len(o)
    ref = float(c[-1]) if args.scale else 0.0
    fams, arr, fam, T = rb_hunt.events(B, args.width, args.target, ref, vxn)
    keep = np.isin(fam, [fams.index(x) for x in SESSION if x in fams])
    ev = tuple(a[keep] for a in arr)
    fam = fam[keep]
    hitsz = ev[4] * args.hit / args.target
    res, ti, hi, ri, dep = grade2(o, h, l, c, td, ev[0], ev[1], ev[2], ev[3], ev[4], hitsz, ev[5])
    didx, D, starts = T["didx"], T["D"], T["starts"]
    ok = ti >= 0
    key = pd.DataFrame({"d": didx[np.maximum(ti, 0)], "s": ev[2], "lv": np.round(ev[1], 1), "ok": ok})
    ok &= ~key.duplicated().values                          # the same level under two names counts once
    idx = np.flatnonzero(ok)
    i, s, lv, tg, wdt = ti[idx], ev[2][idx], ev[1][idx], ev[4][idx], ev[3][idx]
    d = didx[i]
    hit = hi[idx] >= 0
    X = pd.DataFrame({"t": B["index"][i], "side": s, "fam": [fams[k] for k in fam[idx]]})
    X["hit"] = hit
    X["big"] = res[idx] == 1
    X["graded"] = hit | (res[idx] == 2)
    X["dep"] = dep[idx] / wdt                                # depth of the turn when the hit registered, in block depths
    X["mins_to_hit"] = np.where(hit, (hi[idx] - i) * B["tf"], np.nan)

    # ── already tested in rb_hunt (numeric here)
    H, L = T["DAY"]
    C = T["C"]
    Hs, Ls, Cs = pd.Series(H), pd.Series(L), pd.Series(C)
    adr = (Hs - Ls).shift(1).rolling(14, min_periods=5).mean().values
    hour = max(1, round(60 / B["tf"]))
    dopen = o[starts][d]
    X["date"] = T["dates"][d]                                # the trade date of the touch
    X["mod"] = mod[i]                                        # minute of the day, New York
    X["r1"] = s * (Cs.shift(1) / Cs.shift(2) - 1).values[d] * 100        # yesterday's move, positive = the direction being faded
    X["today"] = s * (o[i] / np.r_[np.nan, C[:-1]][d] - 1) * 100         # today's move so far from yesterday's close, same sign rule
    X["r1n"] = (s * (Cs.shift(1) - Cs.shift(2)).values[d]) / adr[d]       # yesterday's move in average daily ranges
    X["todayn"] = s * (o[i] - np.r_[np.nan, C[:-1]][d]) / adr[d]           # today's move so far, in average daily ranges
    X["tod"] = (mod[i] - 1080) % 1440
    X["dow"] = pd.DatetimeIndex(T["dates"][d]).dayofweek
    X["run"] = s * (o[i] - dopen) / adr[d]
    sma50, sma20 = Cs.shift(1).rolling(50).mean().values, Cs.shift(1).rolling(20).mean().values
    pc = np.r_[np.nan, C[:-1]]
    X["trend50"] = s * (pc[d] - sma50[d]) / adr[d]
    X["r5"] = s * (Cs.shift(1) / Cs.shift(6) - 1).values[d] * 100
    dh = pd.Series(h).groupby(didx).cummax().shift(1).values
    dl = pd.Series(l).groupby(didx).cummin().shift(1).values
    X["used"] = (dh[i] - dl[i]) / adr[d]
    X["spd"] = s * B["spd"][i]
    X["rsi"] = np.where(s > 0, B["rsi"][i], 100 - B["rsi"][i])
    wts = np.maximum(B["v"] if np.nansum(B["v"]) > 0 else np.ones(n), 1e-9)
    vw, sd, *_ = rb_hunt.vwap_scan(o, h, l, c, wts, td, mod, -1, 2 * hour, hour)
    X["vwz"] = s * (o[i] - vw[i]) / sd[i]
    gap = np.full(D, np.nan)
    has = T["i_rth"] >= 0
    gap[1:] = np.where(has[1:], (o[np.maximum(T["i_rth"][1:], 0)] - C[:-1]) / adr[1:], np.nan)
    X["gap"] = np.where((mod[i] >= 570) & (mod[i] < 1020), s * gap[d], np.nan)
    if vxn is not None:
        X["vxn"] = vxn.reindex(pd.DatetimeIndex(T["dates"]), method="ffill").shift(1).values[d]

    # ── how fast the market is: 100 points in candle ranges
    rngb = pd.Series(h - l)
    X["tg_last_hour"] = tg / rngb.rolling(hour).mean().shift(1).values[i]
    slot = rngb.groupby(mod).transform(lambda x: x.rolling(20, min_periods=5).mean().shift(1)).values
    X["tg_slot"] = tg / slot[i]

    # ── how choppy today is
    scale = np.ones(n) if ref <= 0 else (pc[didx] / ref)
    scale = np.where(np.isnan(scale), 1.0, scale)
    X["swings"] = swing_count(h, l, td, args.target * scale)[i]
    path = pd.Series(np.abs(np.diff(c, prepend=c[0]))).groupby(didx).cumsum().shift(1).values
    X["er"] = s * (c[np.maximum(i - 1, 0)] - dopen) / np.where(path[i] > 0, path[i], np.nan)

    # ── what today's earlier blocks did (status known before this touch candle)
    cols = {k: np.zeros(len(idx), np.int64) for k in ("brk_same", "brk_opp", "hit_same", "hit_opp", "big_same", "big_opp")}
    hi_, ri_, res_ = hi[idx], ri[idx], res[idx]
    order = np.argsort(i, kind="stable")
    by_day = {}
    for q in order:
        by_day.setdefault(d[q], []).append(q)
    for qs in by_day.values():
        for a_, q in enumerate(qs):
            for p in qs[:a_]:
                same = "same" if s[p] == s[q] else "opp"
                if hi_[p] >= 0 and hi_[p] < i[q]:
                    cols["hit_" + same][q] += 1
                if res_[p] == 1 and ri_[p] < i[q]:
                    cols["big_" + same][q] += 1
                if res_[p] == 2 and hi_[p] < 0 and ri_[p] < i[q]:
                    cols["brk_" + same][q] += 1
    for k, v in cols.items():
        X[k] = v

    # ── how the level was made (session highs / lows only)
    f = pd.DataFrame({"d": didx, "h": h, "l": l})
    jbar = {}
    for name, fn in MASKS.items():
        g = f[fn(mod)].groupby("d")
        jbar[name] = (g.h.idxmax().reindex(range(D)).values, g.l.idxmin().reindex(range(D)).values)
    tail, rej, timeat, age, depart = (np.full(len(idx), np.nan) for _ in range(5))
    body_hi, body_lo = np.maximum(o, c), np.minimum(o, c)
    for q in range(len(idx)):
        name = X.fam.values[q]
        if name not in jbar:
            continue
        j = jbar[name][0 if s[q] > 0 else 1][d[q]]
        if np.isnan(j) or j >= i[q]:
            continue
        j = int(j)
        ext = h[j] if s[q] > 0 else l[j]
        tail[q] = (h[j] - body_hi[j] if s[q] > 0 else body_lo[j] - l[j]) / tg[q]
        rej[q] = s[q] * (ext - c[min(j + 3, i[q] - 1)]) / tg[q]
        a_ = starts[d[q]]
        seg = h[a_:i[q]] if s[q] > 0 else l[a_:i[q]]
        timeat[q] = (s[q] * (seg - (ext - s[q] * 0.1 * wdt[q])) >= 0).sum()
        age[q] = (i[q] - j) * B["tf"] / 60.0
        if i[q] - j > 1:
            depart[q] = (ext - l[j + 1:i[q]].min() if s[q] > 0 else h[j + 1:i[q]].max() - ext) / tg[q]
    X["tail"], X["rej15"], X["time_at"], X["age_h"], X["depart"] = tail, rej, timeat, age, depart

    # ── known territory, yesterday
    inter = np.zeros(len(idx))
    for back in range(1, 6):
        prev = np.maximum(d - back, 0)
        inter += np.where(d - back >= 0, np.where(s > 0, H[prev] > lv, L[prev] < lv), 0)
    X["interior5"] = inter
    X["prev_range"] = ((Hs - Ls).shift(1) / pd.Series(adr)).values[d]
    r14 = pd.Series(rz_tiers.wilder(C, 14)[2]).shift(1).values
    X["rsi14d"] = np.where(s > 0, r14[d], 100 - r14[d])
    X["stretch20"] = s * (pc[d] - sma20[d]) / adr[d]
    X["famcode"] = pd.Categorical(X.fam, categories=list(SESSION)).codes
    return X[X.graded].reset_index(drop=True)


NEW = {"tail": ("the wick that made the level, in units of 100 pts", [0.02, 0.06, 0.12]),
       "rej15": ("how far price closed away within 15 minutes of making it", [0.1, 0.25, 0.5]),
       "time_at": ("candles that traded within 6 pts of the level before the touch", [1.5, 3.5, 8.5]),
       "age_h": ("hours since the level was made", [1, 3, 8]),
       "depart": ("how far price left before coming back, in units of 100 pts", [0.5, 1.0, 2.0]),
       "brk_same": ("blocks on this side already broken today", [0.5, 1.5]),
       "brk_opp": ("blocks on the other side already broken today", [0.5, 1.5]),
       "big_same": ("blocks on this side that already went to 100+ today", [0.5]),
       "big_opp": ("blocks on the other side that already went to 100+ today", [0.5]),
       "swings": ("completed 100-point swings today before the touch", [0.5, 2.5, 5.5]),
       "er": ("session efficiency ratio in the fade direction (net move / path)", [-0.05, 0.05, 0.15]),
       "tg_last_hour": ("100 points, in average candle ranges of the last hour", [2.5, 4, 6]),
       "tg_slot": ("100 points, in the usual candle range of this time slot", [2.5, 4, 6]),
       "interior5": ("of the last 5 days, how many traded beyond the level", [0.5, 2.5, 4.5]),
       "prev_range": ("yesterday's range against the 14-day average", [0.7, 1.0, 1.4]),
       "rsi14d": ("daily RSI(14), stretched in the direction being faded", [40, 55, 70]),
       "stretch20": ("yesterday's close beyond the 20-day average, in daily ranges", [-1, 0, 1])}


def bucket_rows(X, col, cuts):
    v = X[col].values
    edges = [-np.inf] + list(cuts) + [np.inf]
    rows = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (v > a) & (v <= b)
        name = f"<= {b:g}" if a == -np.inf else (f"> {a:g}" if b == np.inf else f"{a:g} - {b:g}")
        rows.append((name, m))
    return rows


def rate(X, m):
    g = X[m]
    return len(g), (100.0 * g.hit.mean() if len(g) else np.nan), (100.0 * g.big.mean() if len(g) else np.nan)


def load_all(args):
    args.csv = None
    df = rb_blocks.load(args)
    vxn = None
    if args.vxn:
        x = pd.read_csv(args.vxn)
        vxn = pd.Series(x.close.values, index=pd.to_datetime(x.time, unit="s").dt.normalize()).groupby(level=0).last()
    return df, vxn


def cmd_table(args):
    df, vxn = load_all(args)
    X = build(rb_blocks.prep(df, args.tf), args, vxn)
    nulls = [build(rb_blocks.prep(rz_null.scramble(df, 900 + k), args.tf), args, vxn) for k in range(args.null)]
    mid = X.t.iloc[0] + (X.t.iloc[-1] - X.t.iloc[0]) / 2
    n, hr, br = rate(X, np.ones(len(X), bool))
    print(f"{X.t.iloc[0].date()} -> {X.t.iloc[-1].date()}, {args.tf}-minute candles{' (scaled to price)' if args.scale else ''}: "
          f"{n} graded session-level blocks, hit {hr:.1f}%, went on to 100+ {br:.1f}%; halves split at {mid.date()}")
    print(f"{'':62s} {'graded':>6s} {'HIT':>6s} {'chance':>7s} {'100+':>6s} {'chance':>7s} {'z':>5s}   {'100+ 1st':>8s} {'100+ 2nd':>8s}")
    for col, (label, cuts) in NEW.items():
        print(f"-- {label}")
        for (name, m), *rest in zip(bucket_rows(X, col, cuts), *[bucket_rows(Z, col, cuts) for Z in nulls]):
            k, hr, br = rate(X, m)
            if k < args.min_n:
                continue
            ch = np.array([rate(Z, mm)[1] for Z, (_, mm) in zip(nulls, rest)])
            cb = np.array([rate(Z, mm)[2] for Z, (_, mm) in zip(nulls, rest)])
            z = (br - cb.mean()) / cb.std() if len(cb) > 1 and cb.std() > 0 else np.nan
            b1, b2 = rate(X, m & (X.t < mid).values)[2], rate(X, m & (X.t >= mid).values)[2]
            print(f"   {name:59s} {k:6d} {hr:5.1f}% {ch.mean() if len(ch) else np.nan:6.1f}% {br:5.1f}% {cb.mean() if len(cb) else np.nan:6.1f}% {z:+5.1f}   "
                  f"{b1:7.1f}% {b2:7.1f}%")


FEATS = ["side", "tod", "dow", "r1", "today", "run", "trend50", "r5", "used", "spd", "rsi", "vwz", "gap", "tg_last_hour", "tg_slot", "swings", "er",
         "brk_same", "brk_opp", "hit_same", "hit_opp", "big_same", "big_opp", "tail", "rej15", "time_at", "age_h", "depart", "interior5",
         "prev_range", "rsi14d", "stretch20", "famcode"]


def cmd_model(args):
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    df, vxn = load_all(args)
    split = pd.Timestamp(args.split, tz="UTC")
    feats = FEATS + (["vxn"] if vxn is not None else [])
    print(f"gradient-boosted trees on {len(feats)} features; trained on blocks touched before {split.date()}, judged on the blocks after")
    frames = [("REAL DATA", df)]
    if not args.scale:                                       # a scrambled path can cross zero, which price-scaling cannot handle
        frames.append(("SCRAMBLED (direction is a coin flip: only size and speed can matter)", rz_null.scramble(df, 901)))
    for label, frame_ in frames:
        X = build(rb_blocks.prep(frame_, args.tf), args, vxn)
        tr, te = X[X.t < split], X[X.t >= split]
        for target in ("big", "hit"):
            mdl = HistGradientBoostingClassifier(max_depth=3, max_iter=300, learning_rate=0.03, min_samples_leaf=200, l2_regularization=1.0,
                                                 random_state=0).fit(tr[feats], tr[target])
            p = mdl.predict_proba(te[feats])[:, 1]
            auc = roc_auc_score(te[target], p)
            rank = pd.qcut(pd.Series(p).rank(method="first"), 10, labels=False).values
            name = "went on to 100+" if target == "big" else "hit (45 pts)"
            print(f"\n{label} - {name}: {len(tr)} blocks to train, {len(te)} to judge; base rate {100 * te[target].mean():.1f}%, AUC {auc:.3f}")
            print("   by the model's ranking, lowest tenth -> highest tenth:  "
                  + "  ".join(f"{100 * te[target].values[rank == k].mean():.0f}%" for k in range(10)))
            print("   " + ";  ".join(f"highest {q}% ({int((p >= np.quantile(p, 1 - q / 100)).sum())} blocks): "
                                    f"{100 * te[target].values[p >= np.quantile(p, 1 - q / 100)].mean():.1f}%" for q in (2, 5, 10, 20)))


def cmd_after(args):
    df, vxn = load_all(args)
    X = build(rb_blocks.prep(df, args.tf), args, vxn)
    nulls = [build(rb_blocks.prep(rz_null.scramble(df, 900 + k), args.tf), args, vxn) for k in range(args.null)]
    mid = X.t.iloc[0] + (X.t.iloc[-1] - X.t.iloc[0]) / 2

    def row(name, fn):
        m = fn(X)
        g = X[m]
        if len(g) < args.min_n:
            return
        ch = np.array([100 * Z[fn(Z)].big.mean() for Z in nulls])
        b1, b2 = 100 * g[g.t < mid].big.mean(), 100 * g[g.t >= mid].big.mean()
        print(f"   {name:58s} {len(g):6d} {100 * g.big.mean():6.1f}% {ch.mean() if len(ch) else np.nan:7.1f}%   {b1:7.1f}% {b2:7.1f}%")

    print(f"{X.t.iloc[0].date()} -> {X.t.iloc[-1].date()}, {args.tf}-minute candles{' (scaled to price)' if args.scale else ''}; "
          f"all graded blocks: {100 * X.big.mean():.1f}% went on to 100+")
    print(f"{'ONCE A BLOCK HAS HIT (45-pt reversal): went on to 100+':61s} {'blocks':>6s} {'100+':>7s} {'chance':>8s}   {'1st half':>8s} {'2nd half':>8s}")
    row("every block that hit", lambda Z: Z.hit.values)
    print("-- how deep into the 60-pt block the turn was made")
    for a, b, name in ((-9, 0.25, "front quarter (0-15 pts)"), (0.25, 0.5, "15-30 pts"), (0.5, 0.75, "30-45 pts"), (0.75, 1.0, "45-60 pts"),
                       (1.0, 9, "a wick beyond the block")):
        row(name, lambda Z, a=a, b=b: Z.hit.values & (Z.dep.values > a) & (Z.dep.values <= b))
    row("front half (0-30 pts)", lambda Z: Z.hit.values & (Z.dep.values <= 0.5))
    print("-- how long the 45-pt hit took")
    for a, b, name in ((-1, 15, "within 15 minutes"), (15, 60, "15-60 minutes"), (60, 240, "1-4 hours"), (240, 1e9, "more than 4 hours")):
        row(name, lambda Z, a=a, b=b: Z.hit.values & (Z.mins_to_hit.values > a) & (Z.mins_to_hit.values <= b))
    print("-- front half AND ...")
    row("with the daily trend", lambda Z: Z.hit.values & (Z.dep.values <= 0.5) & (Z.trend50.values <= 0))
    row("hit within 60 minutes", lambda Z: Z.hit.values & (Z.dep.values <= 0.5) & (Z.mins_to_hit.values <= 60))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["table", "model", "after"])
    ap.add_argument("--duka")
    ap.add_argument("--cache")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--vxn")
    ap.add_argument("--tf", type=int, default=5)
    ap.add_argument("--width", type=float, default=60.0)
    ap.add_argument("--hit", type=float, default=45.0)
    ap.add_argument("--target", type=float, default=100.0)
    ap.add_argument("--scale", action="store_true")
    ap.add_argument("--null", type=int, default=4)
    ap.add_argument("--split", default="20221109", help="model: train before this date, judge after")
    ap.add_argument("--min-n", dest="min_n", type=int, default=150)
    args = ap.parse_args()
    globals()[f"cmd_{args.command}"](args)


if __name__ == "__main__":
    main()
