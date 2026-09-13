#!/usr/bin/env python3
"""Partition-aware loading (PROTOCOL v1.3b §4/§4a).

Exists because a script that loads a basis file and runs the engine over all of
it silently includes the holdout. That already happened once: nq_mde.py was
pointed at the whole basis and reported a pooled mean spanning the holdout
period. The fix is not to remember harder, it is to make the partition an
argument that must be supplied.

load(csv, partition) returns bars trimmed to [warm-up start, partition end] and
the timestamp from which trades may be COUNTED. Warm-up bars are loaded so
causal state (pools, VWAP accumulators, HTF, volatility) initializes correctly,
but no trade entering before `countable_from` is evaluated - §4.
"""
import csv
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S

ET = S.ET
MANIFEST = "research/PARTITIONS.json"


def spec(name, manifest=MANIFEST):
    with open(manifest) as f:
        m = json.load(f)
    for p in m["partitions"]:
        if p["name"] == name:
            return p, m
    raise KeyError(f"no partition {name!r}; have "
                   f"{[p['name'] for p in m['partitions']]}")


def load(csv_path, partition, manifest=MANIFEST, engine=None):
    """Bars for one partition, with warm-up prepended.

    Returns (bars, countable_from_ts, eligible_dates).

    GATE 1: every boundary comes from cme_session, which builds ET-local
    wall-clock times and converts once the boundary is known. The previous
    implementation treated a date as UTC midnight and applied fixed -6h/+30h
    offsets, which leaked one trade day at each edge.

    GATE 2: eligible_dates is the set of CME trade dates that actually contain
    evaluation-eligible bars - after warm-up, embargo and partition bounds. It
    is the ONLY correct frequency denominator, and it is returned alongside the
    bars so a caller cannot accidentally substitute the loaded span.
    """
    p, _ = spec(partition, manifest)
    first_eval = dt.date.fromisoformat(p["first_tradeable_day"])
    last_eval = dt.date.fromisoformat(p["end"])
    warm_from = dt.date.fromisoformat(p["warmup_from"])

    load_start, _ = S.span_epoch(warm_from, last_eval)   # warm-up included
    _, load_end = S.span_epoch(warm_from, last_eval)     # exclusive close
    countable, _ = S.span_epoch(first_eval, last_eval)   # evaluation opens here

    cols = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
    eligible = set()
    for x in _rows(csv_path):
        ts = int(x[0])
        if ts < load_start or ts >= load_end:
            continue
        cols["t"].append(ts)
        cols["o"].append(float(x[1]))
        cols["h"].append(float(x[2]))
        cols["l"].append(float(x[3]))
        cols["c"].append(float(x[4]))
        cols["v"].append(float(x[5]))
        if ts >= countable:
            d = S.trade_date(ts)
            if d is not None:
                eligible.add(d)
    if not cols["t"]:
        sys.exit(f"HALT: no bars for partition {partition!r} in {csv_path}")
    return cols, countable, eligible


def _rows(csv_path):
    with open(csv_path) as f:
        r = csv.reader(f)
        next(r)
        for x in r:
            yield x


def countable(log, bars, countable_from):
    """Drop trades whose ENTRY bar falls in warm-up or before the embargo ends.
    A trade belongs to the partition containing its entry bar (§4); its exit may
    fall beyond the boundary, which is causally fine and is not filtered."""
    t = bars["t"]
    return [x for x in log if t[x["bar"]] >= countable_from]


def guard(partition):
    """Refuse to touch the holdout without an explicit, deliberate override.

    The holdout has exactly one permitted use. This makes spending it an act
    rather than an accident: the caller must set MMT_SPEND_HOLDOUT=yes in the
    environment, which no routine script does.
    """
    if partition != "holdout":
        return
    if os.environ.get("MMT_SPEND_HOLDOUT") != "yes":
        sys.exit("HALT: the holdout has ONE permitted use and this run did not "
                 "declare it.\n"
                 "  Set MMT_SPEND_HOLDOUT=yes only when the hypotheses are "
                 "settled on development + validation and you intend to spend "
                 "it now.\n"
                 "  Nothing was read.")


if __name__ == "__main__":
    _, m = spec("development")
    print(f"basis {m['basis']}")
    print(f"protocol {m['protocol']}")
    for p in m["partitions"]:
        print(f"  {p['name']:<12} {p['start']} .. {p['end']}  "
              f"{p['trade_days']:>5,} days   warm-up from {p['warmup_from']}")
    print(f"\nholdout uses remaining: {m['holdout_uses_remaining']}")
