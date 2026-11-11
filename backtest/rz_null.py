#!/usr/bin/env python3
"""Null model for the reversal study: direction-scrambled surrogate data.

Every bar of the real series is kept - its range, its volume, its place in
the day - but each bar (and each gap between bars) is mirrored up/down with
probability 1/2. Volatility clustering and the time-of-day volatility profile
survive untouched; direction becomes a fair coin at every step.

Running the exact same zone rules on such surrogates answers the only question
that matters for a reversal tool: how often would these zones have "worked"
by pure chance, selection effects included? A real edge is whatever the real
market does beyond that.
"""
import numpy as np


def scramble(df, seed):
    rng = np.random.default_rng(seed)
    o = df.open.values
    h = df.high.values
    l = df.low.values
    c = df.close.values
    n = len(df)
    flip = rng.random(n) < 0.5
    gflip = rng.random(n) < 0.5
    gap = np.empty(n)
    gap[0] = 0.0
    gap[1:] = o[1:] - c[:-1]
    gap = np.where(gflip, -gap, gap)
    body = np.where(flip, -(c - o), c - o)
    up = np.where(flip, o - l, h - o)      # excursion above the open
    dn = np.where(flip, h - o, o - l)      # excursion below the open
    close = o[0] + np.cumsum(gap + body) - gap[0]
    opn = close - body
    out = df.copy()
    out["open"] = opn
    out["close"] = close
    out["high"] = opn + up
    out["low"] = opn - dn
    return out


def scramble_pair(df_a, df_b, seed):
    """Joint surrogate for two instruments on the same index: identical flips,
    so their co-movement is preserved while direction is scrambled."""
    assert df_a.index.equals(df_b.index)
    rng = np.random.default_rng(seed)
    n = len(df_a)
    flip = rng.random(n) < 0.5
    gflip = rng.random(n) < 0.5
    outs = []
    for df in (df_a, df_b):
        o, h, l, c = df.open.values, df.high.values, df.low.values, df.close.values
        gap = np.empty(n)
        gap[0] = 0.0
        gap[1:] = o[1:] - c[:-1]
        gap = np.where(gflip, -gap, gap)
        body = np.where(flip, -(c - o), c - o)
        up = np.where(flip, o - l, h - o)
        dn = np.where(flip, h - o, o - l)
        close = o[0] + np.cumsum(gap + body) - gap[0]
        opn = close - body
        out = df.copy()
        out["open"], out["close"], out["high"], out["low"] = opn, close, opn + up, opn - dn
        outs.append(out)
    return outs[0], outs[1]
