#!/usr/bin/env python3
"""V3-Z2-PC: positive/negative control for the Z1 inference pipeline.

This is an INSTRUMENT CHECK, not an edge hunt. It deliberately reuses the SAME
panel, SAME gap rules, SAME roll exclusion, SAME session coding, SAME frozen
scaler discipline and SAME CR1 day-clustered inference that produced the V3-Z1
null. Only the QUESTION changes: instead of asking whether a cross-market state
predicts direction (effect size 0.01-0.05, below this design's 0.071 noise
floor), it asks whether past volatility predicts future volatility (effect size
0.30-0.60, far above it).

A control that runs through different machinery calibrates nothing. That is why
every shared component is imported rather than reimplemented.

NO OUTCOME IS COMPUTED IN THE PREREGISTRATION TURN.
"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, z1_panel as Z, z1_design as D

# ── frozen windows, in CLOSED hourly bars ─────────────────────────────────
W_SHORT = 6      # a quarter session
W_DAY = 23       # one full CME session
W_WEEK = 115     # five sessions
H_FWD = 1        # forward window: EXACTLY Z1's horizon
#
# Originally drafted as 6 hours. That censored hso 17-22 entirely (the forward
# window cannot cross the 17:00 ET maintenance break), which emptied the
# us_midday and us_close buckets and made their dummies all-zero -> a
# rank-deficient design. The frozen absent-category rule caught it before any
# outcome existed.
#
# The fix is H_FWD = 1, which is also the BETTER control: it is exactly the
# horizon V3-Z1 used, so the control runs on essentially the same rows with the
# same censoring pattern. Comparability with the experiment being calibrated
# matters more than a smoother outcome.
#
# Cost, stated up front: log(r^2) over a single bar is a NOISY proxy for log
# variance (log chi-square with 1 df, variance pi^2/2 ~ 4.93). This ATTENUATES
# the standardized coefficient - it does not bias the sign or the test. The
# predeclared thresholds below account for that attenuation explicitly rather
# than quoting unattenuated literature values.
WARMUP_BARS = W_WEEK + 1

HAR_COMPONENTS = ("rv_short", "rv_day", "rv_week")


def realized_variance(rets, i, window):
    """Sum of squared VALID returns over the `window` closed bars ending at i.

    Gap returns are omitted exactly as in z1_panel.rolling_sigma - never
    fabricated, never stitched. The FULL count of valid returns is required, so
    a partial window yields None rather than a downward-biased estimate.
    """
    if i < 0:
        return None
    got, k = [], i
    while k >= 0 and len(got) < window:
        if rets[k] is not None:
            got.append(rets[k])
        k -= 1
    if len(got) < window:
        return None
    v = sum(x * x for x in got)
    return v if v > 0 else None      # log(0) is undefined -> MISSING


def har_features(rets, i):
    """The three HAR components at bar i, in logs. All use bars CLOSED AT OR
    BEFORE i, so nothing reaches past the prediction instant."""
    out = {}
    for name, w in zip(HAR_COMPONENTS, (W_SHORT, W_DAY, W_WEEK)):
        v = realized_variance(rets, i, w)
        out[name] = math.log(v / w) if v else None      # per-bar mean variance
    return out


def forward_rv_available(rows, rets, i, horizon=H_FWD):
    """PRESENCE predicate. Bool only - it can never return a variance.

    Mirrors the outcome rule exactly: the next `horizon` bars must be genuinely
    consecutive hours, so the outcome is CENSORED rather than bridged across a
    maintenance break, weekend, holiday or missing bar.
    """
    j = i + horizon
    if j >= len(rows):
        return False
    for k in range(i + 1, j + 1):
        if rows[k]["ts"] - rows[k-1]["ts"] != Z.HOUR:
            return False
        if rets["NQ"][k] is None:
            return False
    return True


def forward_rv(rows, rets, i, horizon=H_FWD):
    """THE OUTCOME. log of mean squared return over the next `horizon` closed
    hours. Begins STRICTLY after bar i closes; censored, never bridged."""
    if not forward_rv_available(rows, rets, i, horizon):
        return None
    v = sum(rets["NQ"][k] ** 2 for k in range(i + 1, i + horizon + 1))
    return math.log(v / horizon) if v > 0 else None
