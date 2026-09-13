#!/usr/bin/env python3
"""Type-specific plateau tests (PROTOCOL v1.3b §5).

The principle is a plateau, not a needle: a parameter whose value only works at
one setting has been fitted to noise. §5 states the requirement per type; two of
those requirements are qualitative in the protocol text, so they are made
numeric here and the numbers are declared BEFORE any sweep is run:

  "neighbours must not collapse" (small integer) is operationalized as:
      no neighbour may flip sign against the chosen value, AND
      no neighbour may fall more than 2 SE below it.
  "incremental value" (liquidity tiers) is operationalized as:
      removing the tier reduces expectancy by more than 0 in that sub-window.

Both thresholds are choices, not deductions. They are recorded so they cannot
be adjusted after seeing which parameter would otherwise fail.

Every function returns (ok: bool, detail: str) so a caller can report WHY a
plateau test failed rather than only that it did.
"""

MIN_CONTIGUOUS = 5          # §5 continuous
NEIGHBOUR_SE_DROP = 2.0     # operationalized "must not collapse"
TEMPORAL_RATIO = 2.0        # §5 temporal: stable region spans >= 2x
MIN_SUBWINDOWS = 3          # §5 categorical
TIER_WINDOWS_REQUIRED = 2   # §5 tiers: >= 2 of 3


def _contiguous_runs(flags):
    """Lengths and positions of contiguous True runs."""
    runs, start = [], None
    for i, f in enumerate(flags):
        if f and start is None:
            start = i
        elif not f and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(flags) - 1))
    return runs


def continuous(values, means, ses, chosen_idx):
    """>= MIN_CONTIGUOUS contiguous tested values within 1 SE of the chosen one,
    and the chosen value must lie inside that run - a plateau the choice does
    not sit on is not the choice's plateau."""
    if len(values) < MIN_CONTIGUOUS:
        return False, (f"only {len(values)} values tested; §5 requires at least "
                       f"{MIN_CONTIGUOUS} contiguous")
    ref, se = means[chosen_idx], ses[chosen_idx]
    within = [abs(m - ref) <= se for m in means]
    runs = [(a, b) for a, b in _contiguous_runs(within)
            if a <= chosen_idx <= b and (b - a + 1) >= MIN_CONTIGUOUS]
    if not runs:
        best = max((b - a + 1 for a, b in _contiguous_runs(within)), default=0)
        return False, (f"longest run within 1 SE is {best}, need "
                       f"{MIN_CONTIGUOUS} containing the chosen value "
                       f"{values[chosen_idx]}")
    a, b = runs[0]
    return True, (f"plateau {values[a]}..{values[b]} "
                  f"({b - a + 1} values within 1 SE of {values[chosen_idx]})")


def small_integer(values, means, ses, chosen_idx):
    """n-2..n+2 tested where sensible; no neighbour may collapse."""
    lo = max(0, chosen_idx - 2)
    hi = min(len(values) - 1, chosen_idx + 2)
    if hi - lo < 2:
        return False, f"too few neighbours tested around {values[chosen_idx]}"
    ref, se = means[chosen_idx], ses[chosen_idx]
    bad = []
    for i in range(lo, hi + 1):
        if i == chosen_idx:
            continue
        if (ref > 0) != (means[i] > 0):
            # a mean of exactly 0 is not a sign flip but is still a collapse
            # from a positive chosen value, so it is reported for what it is
            how = "flips sign" if means[i] else "collapses to zero"
            bad.append(f"{values[i]} {how} ({means[i]:+.4f})")
        elif ref - means[i] > NEIGHBOUR_SE_DROP * se:
            bad.append(f"{values[i]} drops {(ref - means[i]) / se:.1f} SE")
    if bad:
        return False, "neighbours collapse: " + "; ".join(bad)
    return True, (f"neighbours {values[lo]}..{values[hi]} hold "
                  f"(no sign flip, none below {NEIGHBOUR_SE_DROP} SE)")


def temporal(values, means, ses, chosen_idx):
    """A contiguous stable region spanning at least a TEMPORAL_RATIO ratio of
    the parameter's own units - a cooldown stable from 6 to 12 minutes, not one
    that works at 8 and nowhere else."""
    ref, se = means[chosen_idx], ses[chosen_idx]
    within = [abs(m - ref) <= se for m in means]
    for a, b in _contiguous_runs(within):
        if not (a <= chosen_idx <= b):
            continue
        lo_v, hi_v = values[a], values[b]
        if lo_v > 0 and hi_v / lo_v >= TEMPORAL_RATIO:
            return True, (f"stable {lo_v}..{hi_v} = {hi_v / lo_v:.1f}x span "
                          f"(need {TEMPORAL_RATIO}x)")
    return False, (f"no contiguous stable region spanning {TEMPORAL_RATIO}x "
                   f"contains {values[chosen_idx]}")


def categorical(options, per_window_means, chosen):
    """Rank stability across >= MIN_SUBWINDOWS development sub-windows: the
    winner must not depend on one window.

    per_window_means: list (one per sub-window) of {option: mean}.
    """
    w = len(per_window_means)
    if w < MIN_SUBWINDOWS:
        return False, f"only {w} sub-windows; §5 requires {MIN_SUBWINDOWS}"
    wins = sum(1 for wm in per_window_means
               if wm and max(wm, key=wm.get) == chosen)
    ranks = []
    for wm in per_window_means:
        order = sorted(options, key=lambda o: wm.get(o, float("-inf")),
                       reverse=True)
        ranks.append(order.index(chosen) + 1 if chosen in order else len(options))
    if wins == 0:
        return False, (f"{chosen} wins no sub-window; ranks {ranks}")
    if max(ranks) > max(2, len(options) // 2):
        return False, (f"{chosen} rank varies too much across windows: {ranks}")
    return True, f"{chosen} wins {wins}/{w} sub-windows, ranks {ranks}"


def tiers(tier, per_window_with, per_window_without):
    """A retained tier must show incremental value in >= TIER_WINDOWS_REQUIRED
    of 3 development sub-windows: removing it must cost expectancy."""
    if len(per_window_with) != len(per_window_without):
        return False, "mismatched window counts"
    helped = [i for i, (a, b) in enumerate(zip(per_window_with,
                                               per_window_without)) if a > b]
    ok = len(helped) >= TIER_WINDOWS_REQUIRED
    deltas = [f"{a - b:+.4f}" for a, b in zip(per_window_with, per_window_without)]
    return ok, (f"{tier} adds value in {len(helped)}/{len(per_window_with)} "
                f"windows (need {TIER_WINDOWS_REQUIRED}); deltas {deltas}")


TESTS = {"continuous": continuous, "small_integer": small_integer,
         "temporal": temporal}


def check(kind, *a):
    """Dispatch a swept-parameter test by §5 type."""
    if kind not in TESTS:
        raise ValueError(f"unknown parameter type {kind!r}; "
                         f"categorical and tiers have their own signatures")
    return TESTS[kind](*a)
