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


SPEND_VAR = "MMT_SPEND_STRESS_SET"          # canonical (GATE O)
SPEND_VAR_LEGACY = "MMT_SPEND_HOLDOUT"      # accepted, deprecated


def guard(partition):
    """Refuse to touch the sealed historical stress set without a deliberate
    override.

    Named for what the block IS. It precedes the development data, so it cannot
    support a prospective-holdout claim, and the old variable name invited
    exactly that misreading. The legacy name still works so older scripts do not
    silently bypass the guard, but it warns.
    """
    # Match by PREFIX, not by an exact name list. The V2 rename to
    # stress_set_pristine / stress_set_contaminated_tail slipped past an exact
    # match and left both blocks unguarded - caught by test K.
    if not (str(partition).startswith("stress_set") or partition == "holdout"):
        return
    if os.environ.get(SPEND_VAR) == "yes":
        return
    if os.environ.get(SPEND_VAR_LEGACY) == "yes":
        print(f"WARNING: {SPEND_VAR_LEGACY} is deprecated; use {SPEND_VAR}. "
              "This block is a historical stress set, not a prospective "
              "holdout.", file=sys.stderr)
        return
    sys.exit("HALT: the sealed historical stress set has ONE permitted use and "
             "this run did not declare it.\n"
             f"  Set {SPEND_VAR}=yes only when a V2 architecture is frozen and "
             "has survived development, internal walk-forward and validation.\n"
             "  It PRECEDES the development data: it can show cross-regime "
             "historical generalisation, never prospective performance.\n"
             "  Nothing was read.")


def load_v2(csv_path, partition, manifest="research/PARTITIONS_V2.json"):
    """V2 loader. Two differences from load(), both required by the audit:

    GATE B - NO bar earlier than the partition's own first trade date is read.
    V1 pre-loaded 30 calendar days of warm-up which, for development, fell
    inside the sealed stress set (2022-08-10..2022-09-08). Those bars were read
    from disk and did initialize V1 state. V2 initializes causally from its own
    first day instead, so the stress set is genuinely untouched.

    GATE C - returns burn_end_ts. The first `burn_in_days` eligible trade dates
    build feature state (including the 252-day rolling variables) and are NOT
    eligible for inference. 252 days of state cannot come from 30 days of
    warm-up, and must not be taken from the stress set.
    """
    guard(partition)
    p, _ = spec(partition, manifest)
    first = dt.date.fromisoformat(p["start"])
    last = dt.date.fromisoformat(p["end"])
    lo, hi = S.span_epoch(first, last)

    cols = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
    seen = set()
    for x in _rows(csv_path):
        ts = int(x[0])
        if ts < lo or ts >= hi:
            continue
        cols["t"].append(ts)
        for k, i in (("o", 1), ("h", 2), ("l", 3), ("c", 4), ("v", 5)):
            cols[k].append(float(x[i]))
        d = S.trade_date(ts)
        if d is not None:
            seen.add(d)
    days = sorted(seen)
    burn = int(p.get("burn_in_days", 0))
    if burn and len(days) <= burn:
        sys.exit(f"HALT: {partition} has {len(days)} eligible trade days, "
                 f"which cannot supply a {burn}-day burn-in.")
    burn_end_ts = S.span_epoch(days[burn], last)[0] if burn else lo
    evaluable = set(days[burn:])
    return cols, burn_end_ts, evaluable


if __name__ == "__main__":
    _, m = spec("development")
    print(f"basis {m['basis']}")
    print(f"protocol {m['protocol']}")
    for p in m["partitions"]:
        print(f"  {p['name']:<12} {p['start']} .. {p['end']}  "
              f"{p['trade_days']:>5,} days   warm-up from {p['warmup_from']}")
    print(f"\nholdout uses remaining: {m['holdout_uses_remaining']}")
