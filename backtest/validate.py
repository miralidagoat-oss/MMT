#!/usr/bin/env python3
"""Overfitting controls.

Searching hundreds of millions of strategies guarantees a spectacular-looking
winner even when the data contains no edge at all. Under a pure-noise null the
expected best t-statistic across N independent trials grows like sqrt(2 ln N);
at N = 2.2e8 that is about 6.2. So a t-stat of 6 proves nothing here. These
routines establish what "good" has to beat.

Three independent checks, because each can fail in a different way:

1. `permutation_null` - the honest version of White's Reality Check. Each real
   trigger is replaced by a random trigger drawn to match its **time-of-day
   distribution and event count**, then the *entire* search is re-run. This
   keeps real prices, real volatility clustering and real intraday seasonality,
   and destroys only the alignment between signal and subsequent return. The
   distribution of the best score across repetitions is the bar the live result
   must clear.

2. `deflated_sharpe` - Bailey & Lopez de Prado's analytic correction, using the
   observed spread of trial Sharpes and the effective number of trials.

3. `oos_report` / `walk_forward` - plain chronological holdout and rolling
   refit. A mined artifact rarely survives a period it was not fitted on.

Nothing here rescues a strategy that only works in-sample; the point is to find
out, cheaply, which bucket the winner is in.
"""
import numpy as np
from scipy import stats

from search import EXITS, build_trades, exact_eval, prepare, run_sweep
from qlib import trade_stats


# ===========================================================================
# Chronological splits
# ===========================================================================
def chrono_masks(n, fracs=(0.5, 0.25, 0.25)):
    """Contiguous train/validation/test masks over bar index."""
    cuts = np.cumsum([int(round(fr * n)) for fr in fracs])
    cuts[-1] = n
    masks = []
    lo = 0
    for hi in cuts:
        m = np.zeros(n, dtype=bool)
        m[lo:hi] = True
        masks.append(m)
        lo = hi
    return masks


def folds(n, k=5, embargo=0):
    """k contiguous walk-forward folds: (train_mask, test_mask) pairs.

    `embargo` drops bars either side of the boundary so a trade opened just
    before the split cannot leak its outcome across it.
    """
    edges = np.linspace(0, n, k + 1).astype(int)
    out = []
    for i in range(1, k):
        tr = np.zeros(n, dtype=bool)
        te = np.zeros(n, dtype=bool)
        tr[:max(edges[i] - embargo, 0)] = True
        te[edges[i]:edges[i + 1]] = True
        out.append((tr, te))
    return out


# ===========================================================================
# 1. Permutation null - the search-wide reality check
# ===========================================================================
def matched_random_trigger(mask, et_min, valid, rng):
    """A random event set with the same size and time-of-day profile as `mask`.

    Matching time-of-day matters: index futures have strong intraday
    seasonality, and an unmatched random trigger would make any session-aware
    strategy look informative purely through that seasonality.
    """
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return mask.copy()
    out = np.zeros(len(mask), dtype=bool)
    pool = {}
    for t in np.unique(et_min[idx]):
        cand = np.flatnonzero(valid & (et_min == t))
        if len(cand):
            pool[t] = cand
    for t, cnt in zip(*np.unique(et_min[idx], return_counts=True)):
        cand = pool.get(t)
        if cand is None or len(cand) == 0:
            continue
        take = rng.choice(cand, size=min(cnt, len(cand)), replace=False)
        out[take] = True
    return out


def permutation_null(f, triggers, filters, n_iter=20, seed=0, valid=None,
                     min_trades=40, max_depth=3, depths=None, verbose=True,
                     **kw):
    """Re-run the whole search on time-of-day-matched random triggers.

    Returns the best score from each repetition - the null distribution of
    "best of the entire search". If `depths` is given, returns a dict keyed by
    depth; the expensive simulation pass is shared across depths within an
    iteration, since they score the *same* random triggers.
    """
    rng = np.random.default_rng(seed)
    et = f["et_min"]
    if valid is None:
        valid = np.isfinite(f["atr14"]) & np.isfinite(f["ema200"])
        valid[:500] = False
    want = list(depths) if depths is not None else [max_depth]
    best = {d: [] for d in want}
    for it in range(n_iter):
        fake = [(n, d, matched_random_trigger(m, et, valid, rng))
                for n, d, m in triggers]
        packed = prepare(f, fake, filters, min_trades=min_trades, verbose=False)
        for dep in want:
            cands, _c, _cb, _t = run_sweep(f, fake, filters,
                                           min_trades=min_trades, topk=5,
                                           max_depth=dep, verbose=False,
                                           packed=packed, **kw)
            b = cands[0]["score"] if cands else 0.0
            best[dep].append(b)
        if verbose:
            print(f"  null iter {it + 1}/{n_iter}: "
                  + "  ".join(f"d{d}={best[d][-1]:.2f}" for d in want),
                  flush=True)
    if depths is None:
        return np.array(best[max_depth])
    return {d: np.array(v) for d, v in best.items()}


def null_pvalue(observed, null_scores):
    """Empirical p-value for the observed best score against the null."""
    null_scores = np.asarray(null_scores, dtype=float)
    k = int((null_scores >= observed).sum())
    return (k + 1) / (len(null_scores) + 1)


# ===========================================================================
# 2. Deflated Sharpe ratio
# ===========================================================================
def deflated_sharpe(sr, n_obs, n_trials, sr_var, skew=0.0, kurt=3.0):
    """Bailey & Lopez de Prado (2014) deflated Sharpe ratio.

    `sr` is the candidate's per-trade Sharpe, `sr_var` the variance of Sharpes
    across the trials searched. Returns the probability that the true Sharpe
    exceeds zero once selection over `n_trials` is accounted for.
    """
    if n_trials < 2 or sr_var <= 0 or n_obs < 3:
        return np.nan
    e = 0.5772156649
    z1 = stats.norm.ppf(1.0 - 1.0 / n_trials)
    z2 = stats.norm.ppf(1.0 - 1.0 / (n_trials * np.e))
    sr0 = np.sqrt(sr_var) * ((1 - e) * z1 + e * z2)   # expected best under null
    denom = np.sqrt(max(1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr ** 2, 1e-12))
    return float(stats.norm.cdf((sr - sr0) * np.sqrt(n_obs - 1) / denom))


def trade_sharpe(r):
    r = np.asarray(r, float)
    if len(r) < 3 or r.std(ddof=1) == 0:
        return 0.0
    return float(r.mean() / r.std(ddof=1))


# ===========================================================================
# 3. Out-of-sample and walk-forward
# ===========================================================================
def oos_report(f, triggers, filters, cand, masks, labels, exits=EXITS):
    """Evaluate one candidate on each chronological slice."""
    rows = []
    for m, lab in zip(masks, labels):
        st, tr = exact_eval(f, triggers, filters, cand, exits=exits, subset=m)
        rows.append((lab, st))
    return rows


def bootstrap_ci(r, stat="pf", n_boot=2000, seed=0):
    """Percentile bootstrap CI - trade order is resampled, not the price path."""
    rng = np.random.default_rng(seed)
    r = np.asarray(r, float)
    if len(r) < 5:
        return (np.nan, np.nan)
    out = np.empty(n_boot)
    for i in range(n_boot):
        s = rng.choice(r, size=len(r), replace=True)
        if stat == "pf":
            gl = -s[s < 0].sum()
            out[i] = (s[s > 0].sum() / gl) if gl > 0 else np.nan
        elif stat == "wr":
            out[i] = 100.0 * (s > 0).mean()
        else:
            out[i] = s.mean()
    out = out[np.isfinite(out)]
    return (float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5)))


def stability(r, exit_bars=None, k=4):
    """Split the trade sequence into k chronological quarters and report each.

    A real edge is untidy but present throughout; a mined one is usually
    carried by one segment.
    """
    r = np.asarray(r, float)
    if len(r) < k * 5:
        return []
    parts = np.array_split(r, k)
    return [trade_stats(p) for p in parts]
