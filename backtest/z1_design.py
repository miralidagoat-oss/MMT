#!/usr/bin/env python3
"""V3-Z1 frozen design layer. CONTAINS NO OUTCOME VALUE.

Everything here is a function of predictors, timestamps and eligibility only.
The outcome is represented ONLY by a PRESENCE predicate (`outcome_available`),
which answers "could Y be computed?" without ever computing it. The value
function lives in z1_panel and is reached only through the authorized runner.
"""
import datetime as dt, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, z1_panel as Z

# ── session_bucket: frozen categories, boundaries, reference ───────────────
#
# hso = hours since the 18:00 ET CME session open (0..22). Boundaries are ET
# wall clock and therefore DST-correct by construction, because hso is derived
# from cme_session.session_epoch rather than from a fixed UTC offset.
SESSION_BUCKETS = (
    ("asia",       0,  6),    # 18:00-00:00 ET
    ("europe",     6, 12),    # 00:00-06:00 ET
    ("premarket", 12, 15),    # 06:00-09:00 ET
    ("us_open",   15, 17),    # 09:00-11:00 ET  (the 09:30 cash open sits in hso 15)
    ("us_midday", 17, 20),    # 11:00-14:00 ET
    ("us_close",  20, 23),    # 14:00-17:00 ET
)
SESSION_REFERENCE = "asia"      # FROZEN: chronologically first, chosen before
                                # outcomes. beta_j is invariant to this choice -
                                # the dummies span the same space either way -
                                # and a test proves it.
SESSION_CATEGORIES = tuple(n for n, _, _ in SESSION_BUCKETS)
SESSION_DUMMIES = tuple(n for n in SESSION_CATEGORIES if n != SESSION_REFERENCE)

# ── design-matrix quality, thresholds frozen BEFORE any fit ───────────────
CONDITION_NUMBER_WARN = 30.0
CONDITION_NUMBER_FAIL = 100.0     # conservative for standardized continuous
                                  # predictors plus dummy variables
STANDARDIZED_CONTINUOUS = ("Z1", "nq_z", "nq_vol_state", "prev_day_nq_return")


class DesignError(RuntimeError):
    """Rank deficiency, an absent category, or conditioning beyond the frozen
    threshold. Always fails closed - never silently recodes."""


def hso(ts):
    """Hours since this bar's own CME session open."""
    d = S.trade_date(ts)
    if d is None:
        return None
    o, _ = S.session_epoch(d)
    return (ts - o) // Z.HOUR


def session_bucket(ts):
    h = hso(ts)
    if h is None:
        return None
    for name, a, b in SESSION_BUCKETS:
        if a <= h < b:
            return name
    return None


def dummies(bucket):
    """Reference-omitted dummy coding, fixed column order."""
    return [1.0 if bucket == n else 0.0 for n in SESSION_DUMMIES]


DESIGN_COLUMNS = ("intercept", "Z1", "nq_z", "nq_vol_state") + \
    tuple(f"session[{n}]" for n in SESSION_DUMMIES) + ("prev_day_nq_return",)


def check_design(X, columns=DESIGN_COLUMNS):
    """Rank and conditioning, computed BEFORE any fit. Fails closed."""
    A = np.asarray(X, dtype=float)
    n, k = A.shape
    if k != len(columns):
        raise DesignError(f"design has {k} columns, expected {len(columns)}")
    s = np.linalg.svd(A, compute_uv=False)
    rank = int((s > max(n, k) * np.finfo(float).eps * s[0]).sum())
    cond = float(s[0] / s[-1]) if s[-1] > 0 else float("inf")
    if rank < k:
        raise DesignError(
            f"design matrix is RANK DEFICIENT: rank {rank} < {k} columns. "
            f"Columns: {list(columns)}")
    if cond > CONDITION_NUMBER_FAIL:
        raise DesignError(
            f"condition number {cond:.1f} exceeds the frozen failure threshold "
            f"{CONDITION_NUMBER_FAIL}")
    return {"n": n, "k": k, "rank": rank, "condition_number": cond,
            "warn": cond > CONDITION_NUMBER_WARN,
            "columns": list(columns)}


# ── outcome PRESENCE, never outcome VALUE ────────────────────────────────
def outcome_available(rows, rets, i, horizon=Z.PRIMARY_HORIZON_HOURS):
    """Could Y(i) be computed? Returns a BOOL and nothing else.

    This is the firewall: eligibility counting needs to know whether the
    outcome exists, and must never learn what it is. The logic mirrors
    z1_panel.primary_outcome exactly, but returns presence only.
    """
    j = i + horizon
    if j >= len(rows):
        return False
    for k in range(i + 1, j + 1):
        if rows[k]["ts"] - rows[k-1]["ts"] != Z.HOUR:
            return False
    if not Z.rolling_sigma(rets["NQ"], i):
        return False
    return rows[i]["NQ"][4] > 0 and rows[j]["NQ"][4] > 0


# ── chronological deciles, frozen before outcomes ────────────────────────
N_DECILES = 10


def deciles(dev_dates):
    """Ten contiguous, approximately equal-count groups of DEVELOPMENT trade
    dates, in chronological order. Frozen here; never recomputed after results."""
    d = sorted(dev_dates)
    n = len(d)
    out = {}
    for g in range(N_DECILES):
        a = (g * n) // N_DECILES
        b = ((g + 1) * n) // N_DECILES
        for x in d[a:b]:
            out[x] = g + 1
    return out


# ── frozen moving-block bootstrap settings ───────────────────────────────
BOOTSTRAP_BLOCK_LENGTHS = (5, 10, 20)
BOOTSTRAP_RESAMPLES = 5000
BOOTSTRAP_SEED = 20260914
BOOTSTRAP_INTERVAL = 0.95


def moving_block_indices(dev_dates, block_len, rng):
    """ONE bootstrap sample of CME TRADE DATES.

    Contiguous blocks of `block_len` consecutive development trade dates are
    drawn WITH REPLACEMENT from all possible start positions, appended until at
    least len(dev_dates) dates are collected, then truncated to exactly that
    many WHOLE trade-date clusters. Every eligible hourly row belonging to a
    selected date is included, so within-date structure is preserved intact.
    """
    d = list(dev_dates)
    n = len(d)
    if block_len > n:
        raise DesignError(f"block length {block_len} exceeds {n} dates")
    starts = n - block_len + 1
    out = []
    while len(out) < n:
        s = rng.randrange(starts)
        out.extend(d[s:s + block_len])
    return out[:n]
