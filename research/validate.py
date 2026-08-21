#!/usr/bin/env python3
"""Validation harness: walk-forward, multiple-testing correction, Monte Carlo.

The old study's headline "OOS PF 3.20" came from 36 trades on one 60/40 split.
A single split is one draw; whichever half happens to suit the parameters is
the half you report. This does anchored walk-forward across many folds and
reports ONLY the stitched out-of-sample ledger, plus the two numbers that say
whether the result survives contact with statistics:

  * Deflated Sharpe (Bailey & Lopez de Prado): the best of N searched configs
    is upward-biased by construction. DSR asks whether the winner beats what
    the SEARCH ITSELF would have produced on noise.
  * Block bootstrap on the trade sequence: the distribution of expectancy and
    drawdown you should actually plan around.
"""
from __future__ import annotations

import math

import numpy as np

import engine


# ── walk-forward ─────────────────────────────────────────────────────────────

def walk_forward(m1, grid, base, run_fn, n_folds=6, train_frac=0.6,
                 min_trades=25, objective="robust"):
    """Anchored-rolling walk-forward.

    The series is cut into n_folds+1 blocks. Fold k tunes on everything up to
    block k and trades block k+1 untouched. Parameters are re-chosen at every
    step, so the stitched OOS ledger is what this system would actually have
    produced when run forward in time.
    """
    n = len(m1)
    edges = np.linspace(0, n, n_folds + 2).astype(int)
    oos = []
    picks = []
    for k in range(1, n_folds + 1):
        tr_lo, tr_hi = 0, edges[k]
        te_lo, te_hi = edges[k], edges[k + 1]
        # keep a gap so a trade open at the boundary cannot span both sets
        train = m1.slice(tr_lo, max(tr_hi - 1440, tr_lo + 1))
        test = m1.slice(te_lo, te_hi)

        best, best_score = None, -1e18
        for p in grid:
            led, _ = run_fn(train, p)
            s = engine.stats(led)
            score = _score(s, min_trades, objective)
            if score > best_score:
                best_score, best = score, p
        led, st = run_fn(test, best)
        picks.append((best, engine.stats(led), st))
        if len(led):
            oos.append(led)
    ledger = np.concatenate(oos) if oos else np.empty(0, dtype=engine.TRADE_DTYPE)
    return ledger, picks


def _score(s, min_trades, objective):
    if s["n"] < min_trades:
        return -1e9 + s["n"]
    if objective == "expectancy":
        return s["exp"]
    # "robust": expectancy penalised by its own standard error, so a config
    # that wins on a handful of lucky trades cannot outrank a steady one
    return s["exp"] - 0.5 * abs(s["exp"]) / math.sqrt(s["n"]) + 0.02 * math.log(s["n"])


# ── statistics ───────────────────────────────────────────────────────────────

def sharpe_of(r):
    if len(r) < 2 or r.std(ddof=1) == 0:
        return 0.0
    return float(r.mean() / r.std(ddof=1))


def deflated_sharpe(r, n_trials):
    """Probability the observed per-trade Sharpe is real given the search size.

    Returns (observed SR, the SR a null search of n_trials would be expected
    to produce, PSR against that threshold). PSR < 0.95 means the result is
    not distinguishable from the best of N coin flips.
    """
    n = len(r)
    if n < 10:
        return 0.0, 0.0, 0.0
    sr = sharpe_of(r)
    e = 0.5772156649
    # expected max of n_trials standard normals
    z = math.sqrt(2 * math.log(max(n_trials, 2)))
    emax = z - (math.log(math.log(max(n_trials, 3))) + math.log(4 * math.pi)) / (2 * z)
    emax += e * (1.0 / z)
    sr0 = emax / math.sqrt(n)          # threshold SR under the null

    m = r.mean(); sd = r.std(ddof=1)
    g3 = float(((r - m) ** 3).mean() / sd ** 3)
    g4 = float(((r - m) ** 4).mean() / sd ** 4)
    denom = math.sqrt(max(1 - g3 * sr + (g4 - 1) / 4.0 * sr * sr, 1e-9))
    stat = (sr - sr0) * math.sqrt(n - 1) / denom
    psr = 0.5 * (1 + math.erf(stat / math.sqrt(2)))
    return sr, sr0, psr


def bootstrap(r, n_boot=4000, block=10, seed=0):
    """Stationary block bootstrap over the trade sequence."""
    rng = np.random.default_rng(seed)
    n = len(r)
    if n < 20:
        return {}
    nb = int(np.ceil(n / block))
    exps = np.empty(n_boot); dds = np.empty(n_boot); pfs = np.empty(n_boot)
    for b in range(n_boot):
        starts = rng.integers(0, n, nb)
        idx = (starts[:, None] + np.arange(block)[None, :]).ravel()[:n] % n
        s = r[idx]
        exps[b] = s.mean()
        eq = np.cumsum(s)
        dds[b] = np.max(np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq])
        gl = -s[s < 0].sum()
        pfs[b] = s[s > 0].sum() / gl if gl > 0 else np.inf
    return dict(
        exp_mean=float(exps.mean()),
        exp_p05=float(np.percentile(exps, 5)),
        exp_p95=float(np.percentile(exps, 95)),
        p_profitable=float((exps > 0).mean()),
        dd_med=float(np.median(dds)),
        dd_p95=float(np.percentile(dds, 95)),
        pf_p05=float(np.percentile(pfs[np.isfinite(pfs)], 5)) if np.isfinite(pfs).any() else 0.0,
    )


def monthly_table(led):
    """Net R by calendar month of exit — the honest look at consistency."""
    if len(led) == 0:
        return []
    ts = led["t_exit"].astype("datetime64[s]")
    ym = ts.astype("datetime64[M]")
    keys = np.unique(ym)
    rows = []
    for k in keys:
        sel = led[ym == k]
        rows.append((str(k), len(sel), float(sel["r_net"].sum())))
    return rows
