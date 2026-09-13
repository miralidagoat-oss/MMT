#!/usr/bin/env python3
"""Build the permanent V2_PROXY negative-result artifacts.

Reports EXISTING Phase-1 inference. Runs no new test, opens no validation, and
never touches the sealed historical stress set.
"""
import datetime as dt, hashlib, json, os, subprocess, sys

R = json.load(open("research/V2_PROXY_PRIMARY_RESULTS.json"))
H = {e["feature"]: e for e in json.load(open("research/V2_PROXY_HOLM.json"))["results"]}
P = json.load(open("research/V2_PROXY_EVENT_POPULATION.json"))
SUB = json.load(open("research/V2_PROXY_SUBPERIODS.json"))
SEC = json.load(open("research/V2_PROXY_SECONDARY_HORIZONS.json"))
LM = json.load(open("research/V2_PROXY_LANDMARKS.json"))
OS_ = json.load(open("research/V2_PROXY_OUTCOME_SUMMARY.json"))
SPEC = json.load(open("research/FEATURE_SPEC_V2.json"))
FAM = list(SPEC["confirmatory_family"])


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


CONCLUSION = (
 "The frozen V2_PROXY development event study found no statistically "
 "supported stable conditional relationship between any of the 22 predeclared "
 "event-time features and the primary 30-minute direction-normalized "
 "post-event return. Across 16,182 primary-eligible events spanning 431 CME "
 "trade dates, no primary feature rejected under the frozen Holm FWER "
 "procedure (m=22, alpha=0.05), and therefore no feature satisfied the "
 "complete Phase-1 promotion gate. These results apply to the tested "
 "V2_PROXY architecture and Dukascopy Nasdaq CFD proxy dataset. They do not "
 "establish that all liquidity-event models are ineffective, that every "
 "possible post-event variable is uninformative, or that genuine CME NQ must "
 "behave identically.")

POWER = (
 "The event study has a substantially larger effective research sample than "
 "earlier work - 16,182 primary-eligible events across 431 trade-date "
 "clusters - making the null more informative for effects of practically "
 "relevant magnitude. Sample size alone, however, does not prove power "
 "against arbitrarily small or irregular clustered effects. No post-hoc power "
 "test was run; the CR1 effect estimates and 95% clustered confidence "
 "intervals below show the range of effects compatible with the data.")

CATEGORICAL_NOTE = (
 "The categorical effects were unstable across adjacent development "
 "subperiods, which is consistent with a non-robust/noisy relationship.")

LANDMARK_NOTE = (
 "The landmark analysis contained a small negative association between "
 "already-completed reclaim/displacement and remaining forward return, "
 "directionally consistent with hypothesis A. However, effect sizes were tiny "
 "(|rho| <= 0.047), the landmark comparisons were secondary, and the 24 "
 "comparisons were not multiplicity-controlled. Therefore this pattern is "
 "exploratory and does not distinguish A from B or C reliably.")

Y60_NOTE = (
 "vwap_dist_sigma at Y_60 produced one nominal unadjusted p < 0.05 "
 "(p = 0.04945). Y_60 was SECONDARY; Y_30 was the frozen PRIMARY horizon; 22 "
 "Y_60 relationships were examined descriptively; no second "
 "multiplicity-controlled family was declared. The result does NOT promote "
 "the feature. Re-running V2 with Y_60 as primary would be post-result "
 "horizon selection and is prohibited.")

feat = {}
for f in FAM:
    p = R["primary"][f]; h = H[f]; s = SUB["features"][f]
    feat[f] = {
        "test_type": p.get("kind"),
        "effect_estimate": p.get("beta"),
        "effect_estimate_meaning": (
            "CR1 slope of rank(Y_30) on rank(X)" if p.get("kind") ==
            "continuous_rank" else
            "omnibus only - individual category betas are descriptive"),
        "ci95_cr1": p.get("ci95"),
        "rho_descriptive": p.get("rho_descriptive"),
        "wald_F": p.get("wald_F"), "q": p.get("q"),
        "category_betas_descriptive": p.get("category_betas"),
        "raw_p": p.get("raw_p"),
        "holm_adjusted_p": h.get("p_holm"),
        "holm_multiplier": h.get("multiplier"),
        "reject": h.get("reject"),
        "N": p.get("N"), "G": p.get("G"),
        "missing_pct": R["coverage"][f]["missing_pct"],
        "missingness_gate_pass": R["coverage"][f]["missingness_gate_pass"],
        "subperiod_effects": s.get("subperiods"),
        "direction_reproduced_in_all_three": s.get(
            "direction_reproduced_in_all_three"),
        "categorical_stability": s.get("categorical_stability"),
        "promotion_status": "NOT PROMOTED",
        "failure_gate": "gate 5: holm_adjusted_p <= alpha",
        "gates": p.get("gates")}

art = {
 "artifact": "V2_PROXY_FROZEN_NEGATIVE_RESULT",
 "status": "CLOSED - NO PROMOTED DEVELOPMENT SIGNAL",
 "frozen_at": str(dt.date.today()),
 "generation": "V2_PROXY",
 "evidence_class": "PROXY EVIDENCE - Dukascopy Nasdaq CFD, not CME NQ",
 "conclusion": CONCLUSION,
 "power_statement": POWER,
 "categorical_stability_statement": CATEGORICAL_NOTE,
 "landmark_statement": LANDMARK_NOTE,
 "y60_nominal_result": Y60_NOTE,
 "code_commit": subprocess.check_output(
     ["git", "rev-parse", "HEAD"]).decode().strip(),
 "hashes": {
   "protocol": sha("research/PROTOCOL_V2_CANONICAL.md"),
   "feature_spec": sha("research/FEATURE_SPEC_V2.json"),
   "feature_engine": sha("backtest/v2_features.py"),
   "outcome_engine": sha("backtest/v2_outcomes.py"),
   "inference": sha("backtest/v2_inference.py"),
   "population": sha("backtest/v2_population.py"),
   "events": sha("backtest/v2_events.py"),
   "winsorization": sha("research/WINSORIZATION_FREEZE_V2.json"),
   "conformance_matrix": sha("research/CONFORMANCE_MATRIX_V2.json"),
   "phase1_runner": sha("backtest/run_phase1.py")},
 "data_provenance": {
   "basis": SPEC["global"]["price_fields"],
   "file": "data_ndx/NDX_5m.csv (RAW, unquantized)",
   "source": "Dukascopy NDX CFD, 5-minute BID OHLC, broker-side volume",
   "class": "PROXY - not CME NQ futures; no exchange volume; CFD quotes"},
 "development_boundaries": {
   "partition_start": "2022-09-09", "burn_in_end": "2023-08-31",
   "evaluable_start": "2023-09-01", "evaluable_end": "2025-05-05",
   "subperiods": SUB["frozen_subperiods"]},
 "primary_horizon": "Y_30", "secondary_horizons": ["Y_5", "Y_15", "Y_60"],
 "holm_family_size": 22, "alpha": 0.05,
 "event_count": P["total_detected_events"],
 "episode_count": P["unique_episodes"],
 "trade_date_count": P["unique_trade_dates"],
 "y30_eligible_events": P["y30_eligible_events"],
 "y30_eligible_episodes": P["y30_eligible_episodes"],
 "y30_eligible_trade_dates": P["y30_eligible_trade_dates"],
 "y30_censored_events": P["y30_censored_events"],
 "censoring_by_reason": P["censor_counts_by_reason"],
 "eligibility_by_stratum": P["eligibility_by"],
 "features": feat,
 "features_rejected_under_holm": 0,
 "features_promoted": [],
 "secondary_horizons_DESCRIPTIVE_ONLY": SEC["features"],
 "secondary_horizons_note": (
   "DESCRIPTIVE ONLY. No second Holm family was declared. Y_30 remains the "
   "frozen primary horizon. These cannot promote a feature."),
 "landmark_analysis_EXPLORATORY_ONLY": LM["landmarks"],
 "landmark_note": LANDMARK_NOTE,
 "descriptive_outcome_record": OS_["all"],
 "direction_split_descriptive": OS_["by_direction"],
 "limitations": [
   "CFD proxy, not genuine CME NQ futures",
   "broker-side volume, so every VWAP-derived feature is proxy-specific",
   "missing late CME-session coverage: the 'post' session bucket is 100% "
   "censored (0/166 eligible) and 'power_hour' is 41% censored",
   "no genuine NQ replication was attempted",
   "no validation data inspected",
   "no pristine historical stress-set data inspected",
   "no trading strategy metric computed - this is an event study",
   "conclusions bind the tested architecture and this proxy dataset only"],
 "validation_inspected": False,
 "pristine_stress_set_inspected": False,
 "v2_proxy_validation_inspections": 0,
 "v2_proxy_pristine_stress_set_outcome_inspections": 0,
 "model_class_closure": {
   "state": "CLOSED - NO PROMOTED DEVELOPMENT SIGNAL",
   "applies_to": [
     "the frozen V2 liquidity-event definition",
     "the tested 22-feature family",
     "the tested primary Y_30 conditional-return target",
     "the Dukascopy Nasdaq CFD proxy dataset"],
   "prohibited_continuations": [
     "adding indicators to this family",
     "changing penetration from 0.25 to another value",
     "changing PIVOT_LEN",
     "switching the primary horizon to Y_60",
     "changing Holm family size or alpha",
     "splitting longs and shorts until something works",
     "mining validation"],
   "rationale": (
     "Each would continue a search family that has already failed. Any future "
     "generation requires a genuinely new economic hypothesis, a protocol "
     "preregistered before its outcomes are seen, and the full accumulated "
     "research-history count carried forward.")},
 "no_v3_authorized": True,
 "future_preference": (
   "target-market research should use genuine CME NQ data rather than "
   "continue increasingly elaborate discovery on the CFD proxy")}

json.dump(art, open("research/V2_PROXY_FROZEN_NEGATIVE_RESULT.json", "w"),
          indent=2, default=str)
print("-> research/V2_PROXY_FROZEN_NEGATIVE_RESULT.json")
