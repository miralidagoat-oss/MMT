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
# HOLM_FAMILY_SIZE is owned by v2_inference; re-exported for callers.
from v2_inference import HOLM_FAMILY_SIZE                        # noqa: E402

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


FORBIDDEN_OUTCOME_FIELDS = (
    "y_5", "y_15", "y_30", "y_60", "mfe", "mae", "mfe_30", "mae_30",
    "mfe_atr", "mae_atr", "forward_return", "ret_5", "ret_15", "ret_30",
    "ret_60", "signed_return", "time_to_mfe", "time_to_mae",
    "remaining_return", "vwap_reached", "level_revisited",
    "opposing_liquidity_reached")


def assert_no_outcome_fields(events):
    """EVERY event is inspected - no sampling. The earlier version checked only
    the first 50, which did not establish the guarantee it claimed."""
    bad = []
    for idx, e in enumerate(events):
        for k in e:
            kl = str(k).lower()
            if kl in FORBIDDEN_OUTCOME_FIELDS or kl.startswith(
                    ("y_", "mfe", "mae", "ret_", "forward")):
                bad.append((idx, k))
    if bad:
        raise OutcomeValueAccess(
            f"{len(bad)} outcome field(s) present, first at index {bad[0][0]} "
            f"({bad[0][1]!r}). The censoring audit reads availability only.")
    return True


class CensorDescriptor(dict):
    """Item 15: the audit's input schema, in which an outcome magnitude cannot
    physically exist. Built by `descriptor()`; the field guard above remains as
    defence in depth."""
    FIELDS = ("event_id", "trade_date", "session_location", "hour_et",
              "direction", "liquidity_class", "primary_eligible",
              "censor_reason")


def descriptor(event, primary_eligible, censor_reason=None):
    """Project an event down to the outcome-free audit schema."""
    d = CensorDescriptor({k: event.get(k) for k in CensorDescriptor.FIELDS})
    d["primary_eligible"] = bool(primary_eligible)
    d["censor_reason"] = censor_reason
    d["event_id"] = event["event_id"]
    return d


def censoring_audit(events, eligible_ids, by=("session_location", "direction",
                                              "liquidity_class", "year",
                                              "hour_et")):
    """Item 4. Eligibility RATE by stratum, using availability only.

    Takes a set of eligible event ids rather than any outcome, so it is
    structurally incapable of reading a return. If an event dict carries an
    outcome value, that is a programming error and this raises.
    """
    assert_no_outcome_fields(events)          # EVERY event, no sampling
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


# ── item 10: Holm lives in v2_inference; this is a thin re-export ─────────
# There is exactly ONE executable Holm implementation for V2_PROXY. This module
# does not carry a second copy.
from v2_inference import holm_fixed_family, HOLM_ALPHA          # noqa: E402


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
