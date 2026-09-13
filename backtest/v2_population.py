#!/usr/bin/env python3
"""Primary-outcome eligibility and the censoring audit (items 3, 4, 10).

Computes NO outcome VALUE. It decides, per event, whether the primary outcome
COULD be computed, and audits how that availability varies. The distinction is
the whole point: eligibility must be settled before any feature is tested, so
each feature test cannot silently obtain a different Y_30 population.

    PRIMARY OUTCOME ELIGIBILITY   determined first, once, for all features
    FEATURE AVAILABILITY          applied second, per feature

Nothing here reads a return, a sign, or a magnitude.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S
import v2_events as V

PRIMARY_HORIZON_MIN = 30
MIN_CLUSTERS_PER_CATEGORY = 30      # item 4, frozen sample-availability rule
HOLM_FAMILY_SIZE = 22               # item 10, NEVER reduced after the fact

CENSOR_REASONS = ("outside_evaluable", "invalid_confirmation", "invalid_atr0",
                  "missing_endpoint_bar", "path_gap", "partition_boundary",
                  "contract_roll")


class OutcomeValueAccess(Exception):
    """Raised if audit code is handed outcome VALUES. The censoring audit may
    look at whether an outcome exists, never at what it is."""


def primary_eligible(event, bar_index, evaluable_lo, evaluable_hi,
                     horizon_min=PRIMARY_HORIZON_MIN):
    """(eligible: bool, reason: str|None) for ONE event.

    `bar_index` maps an epoch second -> bar position, and must contain ONLY
    bars of the current partition, so a boundary crossing shows up as a missing
    endpoint rather than silently borrowing the next partition's price.

    Conditions A-H of item 3, in order. The first failure is the reason.
    """
    t0 = event["t0"]
    if not (evaluable_lo <= t0 < evaluable_hi):
        return False, "outside_evaluable"
    if event.get("confirmation_valid") is False:
        return False, "invalid_confirmation"
    a0 = event.get("atr0")
    if a0 is None or a0 <= 0 or a0 != a0:
        return False, "invalid_atr0"

    end = t0 + horizon_min * 60
    if end > evaluable_hi:
        return False, "partition_boundary"
    if event.get("roll_crossed"):
        return False, "contract_roll"
    # the endpoint bar must be the one CLOSING exactly at t0+H. Stored stamps
    # are bar OPENS, so that bar's stamp is end - BAR_SECONDS. No nearest,
    # previous or next bar may stand in for it.
    if (end - V.BAR_SECONDS) not in bar_index:
        return False, "missing_endpoint_bar"
    # every intermediate bar must exist too: a hole in the path is a gap, and a
    # path with a hole is not the path we claim to have measured
    step = V.BAR_SECONDS
    for ts in range(t0, end - step + 1, step):
        if ts not in bar_index:
            return False, "path_gap"
    return True, None


def build_population(events, bar_index, evaluable_lo, evaluable_hi):
    """The MASTER primary population. Returns (eligible, censored, counts)."""
    eligible, censored = [], []
    counts = {r: 0 for r in CENSOR_REASONS}
    for e in events:
        okk, why = primary_eligible(e, bar_index, evaluable_lo, evaluable_hi)
        if okk:
            eligible.append(e)
        else:
            counts[why] += 1
            censored.append(dict(e, censor_reason=why))
    return eligible, censored, counts


def censoring_audit(events, eligible_ids, by=("session_location", "direction",
                                              "liquidity_class", "year",
                                              "hour_et")):
    """Item 4. Eligibility RATE by stratum, using availability only.

    Takes a set of eligible event ids rather than any outcome, so it is
    structurally incapable of reading a return. If an event dict carries an
    outcome value, that is a programming error and this raises.
    """
    for e in events[:50]:
        for k in e:
            if k.startswith(("y_", "Y_", "mfe", "mae", "ret", "forward")):
                raise OutcomeValueAccess(
                    f"event carries outcome field {k!r}; the censoring audit "
                    "may read availability only, never values")
    out = {}
    for dim in by:
        tab = {}
        for e in events:
            k = e.get(dim)
            if k is None:
                continue
            row = tab.setdefault(k, {"events": 0, "eligible": 0, "clusters": set(),
                                     "eligible_clusters": set()})
            row["events"] += 1
            row["clusters"].add(e["trade_date"])
            if e["event_id"] in eligible_ids:
                row["eligible"] += 1
                row["eligible_clusters"].add(e["trade_date"])
        out[dim] = {k: {"events": v["events"], "eligible": v["eligible"],
                        "eligibility_rate": v["eligible"] / v["events"],
                        "clusters": len(v["clusters"]),
                        "eligible_clusters": len(v["eligible_clusters"])}
                    for k, v in tab.items()}
    return out


def admissible_categories(audit_dim):
    """Item 4. A category joins the confirmatory design only if it has at least
    MIN_CLUSTERS_PER_CATEGORY distinct trade dates carrying primary-eligible
    events. Pure sample availability - never an outcome-performance decision."""
    keep, drop = [], {}
    for k, v in audit_dim.items():
        if v["eligible_clusters"] >= MIN_CLUSTERS_PER_CATEGORY:
            keep.append(k)
        else:
            drop[k] = v["eligible_clusters"]
    return sorted(keep), drop


# ── item 10: Holm over a FIXED family of 22 ────────────────────────────────
def holm_fixed_family(pvalues, family=HOLM_FAMILY_SIZE, alpha=0.05,
                      not_testable=()):
    """Holm step-down where m is ALWAYS `family`, even when some predeclared
    features produced no valid test.

    A feature that cannot be tested for a pre-outcome reason (missingness,
    singular design, too few clusters) is reported NOT TESTABLE / NOT
    PROMOTABLE. It is never replaced, and its absence never shrinks m - power
    must not be gained because a predeclared test failed to become usable.
    """
    items = sorted(pvalues.items(), key=lambda kv: kv[1])
    out, running = [], 0.0
    for i, (k, p) in enumerate(items):
        adj = min(1.0, max(running, (family - i) * p))
        running = adj
        out.append({"feature": k, "p": p, "p_holm": adj,
                    "reject": adj <= alpha, "testable": True})
    for k in not_testable:
        out.append({"feature": k, "p": None, "p_holm": None, "reject": False,
                    "testable": False, "status": "NOT TESTABLE / NOT PROMOTABLE"})
    return {"family_size": family, "alpha": alpha,
            "tested": len(items), "not_testable": len(not_testable),
            "results": out}


# ── item 8: the ONLY hard promotion gates ──────────────────────────────────
HARD_GATES = ("in_frozen_family", "missingness_le_20pct", "min_clusters_met",
              "valid_primary_test", "holm_adjusted_p_le_alpha",
              "subperiod_rule_met", "no_integrity_failure")

DIAGNOSTICS_ONLY = ("year_effect", "direction_split", "day_concentration",
                    "block_dependence", "outlier_day_sensitivity",
                    "gapped_event_sensitivity", "parameter_neighbourhood")


def promote(flags):
    """Mechanical. Every hard gate must be True; diagnostics cannot change it.

    Diagnostics are reported alongside, and a caller passing one in here is
    refused - that is how 'no domination by a handful of days' stops being a
    discretionary veto applied after the numbers are seen.
    """
    bad = sorted(set(flags) & set(DIAGNOSTICS_ONLY))
    if bad:
        raise ValueError(
            f"diagnostic(s) {bad} cannot participate in the promotion decision; "
            "they are reported, not gates (PROTOCOL_V2_CANONICAL item 8)")
    missing = [g for g in HARD_GATES if g not in flags]
    if missing:
        raise ValueError(f"promotion decision missing hard gate(s): {missing}")
    return all(bool(flags[g]) for g in HARD_GATES)
