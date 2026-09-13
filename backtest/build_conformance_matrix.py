#!/usr/bin/env python3
"""Item 3: FEATURE_SPEC_V2 feature -> implementation -> formula -> availability
-> missingness rule -> implemented -> unit test id.

HALTS if any declared feature has no mapping. Computes no outcome.
"""
import ast, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2_features as FE

SPEC = "research/FEATURE_SPEC_V2.json"
OUT = "research/CONFORMANCE_MATRIX_V2.json"
ENGINE = "backtest/v2_features.py"

# feature -> (implementing function, unit test id)
IMPL = {
 "direction": ("compute_events/_row", "T-B"),
 "liquidity_class": ("compute_events/_row", "T-B"),
 "level_kind_dynamic": ("compute_events/_row", "T-B"),
 "session_location": ("session_location()", "T-S"),
 "level_age_min": ("compute_events/_row", "T-T"),
 "level_formation_lag_min": ("compute_events/_row", "T-I"),
 "touch_count": ("compute_events step E", "T-H"),
 "level_prominence_atr": ("_attach_prominence()+_row", "T-C"),
 "competing_liquidity_atr": ("_SortedLevels.nearest_other()", "T-B"),
 "penetration_pts": ("v2_events.penetration_pts()", "T-T"),
 "penetration_atr": ("compute_events/_row", "T-B"),
 "close_vs_level_atr": ("compute_events/_row", "T-B"),
 "same_bar_reclaim": ("compute_events/_row", "T-B"),
 "wick_body_ratio": ("v2_events.wick_body_ratio()", "T-B"),
 "vwap_dist_pts": ("session_vwap()+_row", "T-J/K"),
 "vwap_dist_sigma": ("session_vwap()+_row", "T-J/K"),
 "vwap_slope_sigma_per_bar": ("session_vwap()+_row", "T-L"),
 "minutes_since_session_open": ("compute_events/_row", "T-B"),
 "atr_percentile": ("same_bucket_percentile()", "T-Q"),
 "realized_vol_state": ("build_state()+same_bucket_percentile()", "T-R"),
 "range_compression": ("compute_events/_row", "T-B"),
 "dist_session_open_atr": ("compute_events/_row", "T-B"),
 "dist_weekly_open_atr": ("compute_events/_row", "T-B"),
 "dist_overnight_high_atr": ("compute_events/_row", "T-B"),
 "dist_overnight_low_atr": ("compute_events/_row", "T-B"),
 "htf_15m_compression": ("htf_series()+_row", "T-M"),
 "htf_1h_range_pctile": ("htf_series()+same_bucket_percentile()", "T-O"),
 "htf_1h_vol_state": ("htf_series()+same_bucket_percentile()", "T-P"),
 "htf_1h_dist_ref_atr": ("htf_series()+wilder_rma()+_row", "T-N"),
}

S = json.load(open(SPEC))
decl = S["event_time_features"]
fam = set(S["confirmatory_family"])
emitted = set(FE.EVENT_FIELDS)
tree = ast.parse(open(ENGINE).read())
defined = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

rows, halt = {}, []
for f, spec in sorted(decl.items()):
    impl = IMPL.get(f)
    if impl is None:
        halt.append(f"{f}: NO implementation mapping")
        continue
    fn, tid = impl
    base = fn.split("(")[0].split("/")[0].split("+")[0].strip()
    known = base in defined or base.startswith("v2_events.") or \
        base.startswith("compute_events") or base.startswith("_SortedLevels")
    if not known:
        halt.append(f"{f}: implementation {fn!r} not found in {ENGINE}")
    if f not in emitted:
        halt.append(f"{f}: declared but NOT emitted in the event row")
    rows[f] = {
        "implementation": fn,
        "engine": ENGINE,
        "required_formula": spec.get("formula"),
        "availability": spec.get("availability",
                                 S["global"]["availability"]),
        "missingness_rule": spec.get("missing", spec.get("comparator_causality")),
        "implemented": f in emitted and known,
        "unit_test_id": tid,
        "in_confirmatory_family": f in fam,
        "winsorized": f in FE.WINSORIZED,
    }

out = {"spec": SPEC, "engine": ENGINE,
       "declared_event_time_features": len(decl),
       "implemented": sum(1 for v in rows.values() if v["implemented"]),
       "confirmatory_family_size": len(fam),
       "confirmatory_implemented": sum(1 for f, v in rows.items()
                                       if v["in_confirmatory_family"]
                                       and v["implemented"]),
       "winsorized_fields": len(FE.WINSORIZED),
       "note": "Availability/missingness only. No outcome is computed.",
       "features": rows}
if halt:
    print("HALT: conformance mapping incomplete")
    for h in halt: print("  - " + h)
    json.dump(out, open(OUT, "w"), indent=2)
    sys.exit(1)
json.dump(out, open(OUT, "w"), indent=2)
print(f"{out['implemented']}/{out['declared_event_time_features']} declared "
      f"event-time features implemented")
print(f"{out['confirmatory_implemented']}/{out['confirmatory_family_size']} "
      f"confirmatory features implemented")
print(f"-> {OUT}")
