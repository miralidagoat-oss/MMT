#!/usr/bin/env python3
"""Shared runner: params -> ledger. Also loads the Yahoo futures CSVs."""
from __future__ import annotations

import csv
import numpy as np

import core
import engine
import strategy
from strategy import Params


def run(m1, p: Params, costs=None, cfg=None, lv=None):
    i1, d, e, s, tp, tag = strategy.signals(m1, p, lv=lv)
    if len(i1) == 0:
        return np.empty(0, dtype=engine.TRADE_DTYPE), dict(
            signals=0, taken=0, expired=0, skipped_busy=0, rejected_risk=0)
    return engine.simulate(m1, i1, d, e, s, tp, tag, costs=costs, cfg=cfg)


def load_csv(path):
    t, o, h, l, c, v = [], [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            t.append(int(row["time"])); o.append(float(row["open"]))
            h.append(float(row["high"])); l.append(float(row["low"]))
            c.append(float(row["close"])); v.append(float(row["volume"]))
    return core.Bars(t, o, h, l, c, v)


def describe(m1, name="series"):
    et_min, et_day, wd = m1.et
    days = np.unique(et_day[(wd < 5) & (et_min >= 570) & (et_min < 960)])
    t0 = m1.t[0].astype("datetime64[s]"); t1 = m1.t[-1].astype("datetime64[s]")
    gaps = np.diff(m1.t)
    print(f"{name}: {len(m1):,} 1m bars | {t0} .. {t1} | {len(days):,} RTH days")
    print(f"  price {m1.c.min():,.0f}-{m1.c.max():,.0f} | "
          f"median gap {np.median(gaps):.0f}s | gaps>10m: {(gaps > 600).sum():,}")
    return len(days)
