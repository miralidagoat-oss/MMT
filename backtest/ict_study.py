#!/usr/bin/env python3
"""Tuning, ablation and walk-forward validation for the ICT strategy engine.

Ranking is always POOLED across contracts (MNQ + NQ, or whatever is passed) so
a config cannot win on one symbol's luck, and every headline number is produced
by `walkforward` — tune on the first 60% of the series, report the untouched
last 40%.
"""
import itertools
import json
import sys
from dataclasses import replace

from ict_engine import Config, Result, load, prepare, run

CACHE = {}


def prep_cached(key, bars, cfg):
    ck = (key, cfg.pivot_len, cfg.atr_len, cfg.vwap_anchor,
          cfg.bias, cfg.htf_mult, tuple(cfg.htf_mults), cfg.htf_look)
    if ck not in CACHE:
        CACHE[ck] = prepare(bars, cfg)
    return CACHE[ck]


def slice_bars(bars, lo, hi):
    return tuple(x[lo:hi] for x in bars)


class DS:
    """One symbol/timeframe dataset, optionally a slice of it."""

    def __init__(self, symbol, tf, path, lo=0.0, hi=1.0, tag=None):
        self.symbol, self.tf = symbol, tf
        full = load(path)
        n = len(full[0])
        a, b = int(n * lo), int(n * hi)
        self.bars = slice_bars(full, a, b)
        self.key = (path, a, b)
        self.tag = tag or f"{symbol} {tf}"

    def run(self, cfg):
        return run(self.bars, cfg, self.symbol, pre=prep_cached(self.key, self.bars, cfg))


def pooled(results):
    agg = Result()
    for r in results:
        agg.trades.extend(r.trades)
        agg.setups += r.setups
        agg.fills += r.fills
    return agg


def evaluate(cfg, datasets):
    return [ds.run(cfg) for ds in datasets]


def score(cfg, datasets, min_trades=25):
    """Pooled profit factor, penalised when the sample is too thin to mean
    anything. Expectancy breaks ties so a config cannot win on one fat tail."""
    res = pooled(evaluate(cfg, datasets))
    if res.n < min_trades:
        return -99.0, res
    return res.pf + 0.25 * res.expectancy, res


def grid_search(base, grid, datasets, top=12, min_trades=25):
    keys = list(grid)
    combos = list(itertools.product(*(grid[k] for k in keys)))
    out = []
    for combo in combos:
        cfg = replace(base, **dict(zip(keys, combo)))
        s, res = score(cfg, datasets, min_trades)
        out.append((s, dict(zip(keys, combo)), res))
    out.sort(key=lambda x: -x[0])
    print(f"\n{len(combos)} combos over {[d.tag for d in datasets]}")
    for s, params, res in out[:top]:
        print(f"  {s:6.2f}  {res.summary()}  {params}")
    return out


def report(cfg, datasets, title=""):
    if title:
        print(f"\n=== {title} ===")
    all_res = []
    for ds in datasets:
        r = ds.run(cfg)
        all_res.append(r)
        print(f"  {ds.tag:14s} {r.summary()}")
    agg = pooled(all_res)
    print(f"  {'POOLED':14s} {agg.summary()}")
    return agg
