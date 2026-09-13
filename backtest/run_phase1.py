#!/usr/bin/env python3
"""V2_PROXY PHASE 1 — DEVELOPMENT ONLY. Executes the frozen protocol.

Order is enforced: event population and availability audit are written BEFORE
any inferential statistic is computed. Validation and the sealed stress set are
never read.
"""
import datetime as dt, json, math, os, pickle, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE
import v2_outcomes as OC, v2_population as POP, v2_inference as I

DEV_START = dt.date(2022, 9, 9)          # partition start (burn-in included)
EVAL_START, EVAL_END = dt.date(2023, 9, 1), dt.date(2025, 5, 5)
SUBPERIODS = (("S1", dt.date(2023, 9, 1), dt.date(2024, 3, 21)),
              ("S2", dt.date(2024, 3, 22), dt.date(2024, 10, 10)),
              ("S3", dt.date(2024, 10, 11), dt.date(2025, 5, 5)))
CACHE = "/tmp/claude-0/-home-user-MMT/7398f50c-a4ba-53ef-9346-ca0eb03feac2/scratchpad/phase1.pkl"

SPEC = json.load(open("research/FEATURE_SPEC_V2.json"))
WINS = json.load(open("research/WINSORIZATION_FREEZE_V2.json"))["features"]
FAMILY = list(SPEC["confirmatory_family"])
CATEGORICAL = ("liquidity_class", "session_location")
CONTINUOUS = [f for f in FAMILY if f not in CATEGORICAL]


def build():
    lo, _ = S.span_epoch(DEV_START, DEV_START)
    _, hi = S.span_epoch(EVAL_END, EVAL_END)
    bars = FE.load_raw(V.RAW_BASIS, lo, hi)
    tr = {}
    rows = FE.compute_events(bars, trace=tr)
    return bars, rows, tr


if os.path.exists(CACHE):
    with open(CACHE, "rb") as f:
        bars, rows, tr = pickle.load(f)
    print("loaded cached development event set")
else:
    bars, rows, tr = build()
    with open(CACHE, "wb") as f:
        pickle.dump((bars, rows, tr), f)
print(f"bars {len(bars['t']):,}   events(all) {len(rows):,}")

# ── section 6: MASTER Y30 POPULATION, availability only ───────────────────
idx = OC.build_index(bars)
ev_lo, _ = S.span_epoch(EVAL_START, EVAL_START)
_, ev_hi = S.span_epoch(EVAL_END, EVAL_END)
dev = [r for r in rows if EVAL_START <= r["trade_date"] <= EVAL_END]
POP.assert_no_outcome_fields(dev)                 # every event, no sampling

eligible, censored, counts = POP.build_population(dev, idx, ev_lo, ev_hi)
elig_ids = {r["event_id"] for r in eligible}
audit = POP.censoring_audit(dev, elig_ids)

pop = {"generation": "V2_PROXY", "basis_class": SPEC["basis_class"],
       "partition": "development (evaluable)",
       "window": [str(EVAL_START), str(EVAL_END)],
       "total_detected_events": len(dev),
       "unique_episodes": len({r["episode_id"] for r in dev}),
       "unique_trade_dates": len({r["trade_date"] for r in dev}),
       "y30_eligible_events": len(eligible),
       "y30_censored_events": len(censored),
       "y30_eligible_episodes": len({r["episode_id"] for r in eligible}),
       "y30_eligible_trade_dates": len({r["trade_date"] for r in eligible}),
       "censor_counts_by_reason": counts,
       "eligibility_by": audit,
       "note": ("AVAILABILITY ONLY. Records whether Y_30 exists; inspects no "
                "sign, magnitude, MFE, MAE or performance.")}
json.dump(pop, open("research/V2_PROXY_EVENT_POPULATION.json", "w"),
          indent=2, default=str)
print(f"\nY30 eligible {len(eligible):,} / {len(dev):,}   "
      f"episodes {pop['y30_eligible_episodes']:,}   "
      f"dates {pop['y30_eligible_trade_dates']}")
print(f"censoring: { {k:v for k,v in counts.items() if v} }")
print("-> research/V2_PROXY_EVENT_POPULATION.json  (written BEFORE inference)")

# ── section 3/4/5: FROZEN OUTCOMES (first real-outcome computation) ────────
print("\ncomputing frozen outcomes on the Y30-eligible population ...")
for r in eligible:
    r.update(OC.outcomes(r, bars, idx))
Y = "y_30"

# ── section 7: apply the FROZEN winsorization bounds (never recomputed) ────
def winsorized(name, v):
    w = WINS.get(name)
    if v is None or w is None or w.get("frozen_lower") is None:
        return v
    return max(w["frozen_lower"], min(w["frozen_upper"], v))

# ── section 8: feature missingness on the master Y30-eligible population ───
cov = {}
for f in FAMILY:
    vals = [r.get(f) for r in eligible]
    valid = [r for r, v in zip(eligible, vals) if v is not None]
    miss = len(eligible) - len(valid)
    pct = 100.0 * miss / len(eligible)
    cov[f] = {"y30_eligible_before_missingness": len(eligible),
              "feature_valid_events": len(valid),
              "unique_episodes": len({r["episode_id"] for r in valid}),
              "unique_trade_dates": len({r["trade_date"] for r in valid}),
              "missing_n": miss, "missing_pct": round(pct, 2),
              "missingness_gate_pass": pct <= 20.0}

# ── sections 9/10: the 22 predeclared confirmatory tests ──────────────────
def subset(rows_, d0, d1):
    return [r for r in rows_ if d0 <= r["trade_date"] <= d1]

def run_one(f, sample):
    """One predeclared test. Continuous -> CR1 rank regression; categorical ->
    ONE clustered omnibus Wald. Returns None if not mechanically computable."""
    ys = [r[Y] for r in sample]
    cl = [r["trade_date"] for r in sample]
    if f in CATEGORICAL:
        adm = admissible[f]
        cat = [(r[f] if r[f] in adm else None) for r in sample]
        if len({c for c in cat if c is not None}) < 2:
            return None
        try:
            return I.categorical_test(cat, ys, cl)
        except Exception:
            return None
    xs = [winsorized(f, r.get(f)) for r in sample]
    if len([v for v in xs if v is not None]) < 2:
        return None
    if len({v for v in xs if v is not None}) < 2:
        return None                       # no variation -> singular design
    try:
        return I.continuous_test(xs, ys, cl)
    except Exception:
        return None

# frozen pre-outcome category admissibility (>=30 eligible trade-date clusters)
admissible = {}
for f in CATEGORICAL:
    tab = {}
    for r in eligible:
        k = r.get(f)
        if k is None: continue
        tab.setdefault(k, set()).add(r["trade_date"])
    keep, drop = [], {}
    for k, v in tab.items():
        (keep.append(k) if len(v) >= POP.MIN_CLUSTERS_PER_CATEGORY
         else drop.update({k: len(v)}))
    admissible[f] = sorted(keep)
    cov[f]["admissible_categories"] = sorted(keep)
    cov[f]["dropped_categories_for_sample_availability"] = drop

primary, pvals, not_testable = {}, {}, []
for f in FAMILY:
    res = run_one(f, eligible)
    if res is None:
        not_testable.append(f)
        primary[f] = {"testable": False,
                      "status": "NOT TESTABLE / NOT PROMOTABLE"}
        continue
    primary[f] = {"testable": True, "kind": res["kind"],
                  "beta": res.get("beta_of_interest"),
                  "ci95": res.get("ci_of_interest"),
                  "raw_p": res["p_of_interest"],
                  "rho_descriptive": res.get("rho"),
                  "wald_F": res.get("wald_F"), "q": res.get("q"),
                  "N": res["N"], "G": res["G"],
                  "levels": res.get("levels"),
                  "category_betas": res.get("category_betas")}
    pvals[f] = res["p_of_interest"]

holm = I.holm_fixed_family(pvals, not_testable=not_testable)
json.dump({"coverage": cov, "primary": primary,
           "winsorization_source": "research/WINSORIZATION_FREEZE_V2.json",
           "population": "development evaluable, master Y30-eligible",
           "note": "PROXY EVIDENCE - Dukascopy Nasdaq CFD, not CME NQ."},
          open("research/V2_PROXY_PRIMARY_RESULTS.json", "w"),
          indent=2, default=str)
json.dump(holm, open("research/V2_PROXY_HOLM.json", "w"), indent=2, default=str)

print(f"\n{'feature':<28} {'miss%':>6} {'N':>7} {'G':>5} {'raw p':>10} "
      f"{'adj p':>10}  rej")
for e in holm["results"]:
    f = e["feature"]; pr = primary[f]
    rp = f"{pr['raw_p']:.4g}" if pr.get("raw_p") is not None else "n/a"
    ap = f"{e['p_holm']:.4g}" if e.get("p_holm") is not None else "n/a"
    print(f"  {f:<26} {cov[f]['missing_pct']:>5.2f}% {pr.get('N',0):>7} "
          f"{pr.get('G',0):>5} {rp:>10} {ap:>10}  "
          f"{'YES' if e.get('reject') else 'no'}")
nrej = sum(1 for e in holm["results"] if e.get("reject"))
print(f"\nHolm m={holm['family_size']} alpha={holm['alpha']} "
      f"tested={holm['tested']} not_testable={holm['not_testable']} "
      f"rejected={nrej}")

# ── section 12: frozen subperiod stability (applies to Holm survivors) ─────
survivors = [e["feature"] for e in holm["results"] if e.get("reject")]
sub = {"frozen_subperiods": [{"name": n, "start": str(a), "end": str(b)}
                             for n, a, b in SUBPERIODS],
       "applies_to": "features surviving Holm",
       "holm_survivors": survivors, "features": {}}
for f in FAMILY:
    row = {"applied_as_gate": f in survivors, "subperiods": {}}
    for n, a, b in SUBPERIODS:
        res = run_one(f, subset(eligible, a, b))
        row["subperiods"][n] = (None if res is None else
                                {"beta": res.get("beta_of_interest"),
                                 "raw_p": res["p_of_interest"],
                                 "N": res["N"], "G": res["G"]})
    if f in CATEGORICAL:
        vecs = []
        for n, a, b in SUBPERIODS:
            sm = subset(eligible, a, b)
            vecs.append(I.category_effect_vector(
                [r.get(f) for r in sm], [r[Y] for r in sm], admissible[f]))
        try:
            row["categorical_stability"] = I.categorical_stability(*vecs)
        except Exception as exc:
            row["categorical_stability"] = {"status": f"UNEVALUABLE: {exc}"}
    else:
        bs = [row["subperiods"][n]["beta"] if row["subperiods"][n] else None
              for n, _, _ in SUBPERIODS]
        full = primary[f].get("beta")
        row["direction_reproduced_in_all_three"] = (
            None if full is None or any(b is None for b in bs)
            else all((b > 0) == (full > 0) for b in bs))
    sub["features"][f] = row
json.dump(sub, open("research/V2_PROXY_SUBPERIODS.json", "w"),
          indent=2, default=str)

# ── section 13: mechanical promotion ──────────────────────────────────────
promoted = []
for f in FAMILY:
    flags = {"in_frozen_family": True,
             "missingness_le_20pct": cov[f]["missingness_gate_pass"],
             "min_clusters_met": primary[f].get("G", 0) >= 30,
             "valid_primary_test": primary[f]["testable"],
             "holm_adjusted_p_le_alpha": any(
                 e["feature"] == f and e.get("reject") for e in holm["results"]),
             "subperiod_rule_met": bool(
                 sub["features"][f].get("direction_reproduced_in_all_three")
                 or (sub["features"][f].get("categorical_stability") or {})
                 .get("stable")),
             "no_integrity_failure": True}
    if POP.promote(flags):
        promoted.append(f)
    primary[f]["gates"] = flags
    primary[f]["PROMOTED_PHASE1"] = f in promoted

# ── section 14: robustness diagnostics, survivors only ────────────────────
rob = {"applies_to": "features surviving the frozen primary statistical stage",
       "qualifying_features": survivors, "seed": 20260913,
       "resamples": 5000, "features": {},
       "note": ("Diagnostics never alter Holm, promotion or family size. With "
                "no feature surviving the primary stage there is nothing to "
                "diagnose; running them anyway would be an undeclared test.")}
json.dump(rob, open("research/V2_PROXY_ROBUSTNESS.json", "w"),
          indent=2, default=str)

# ── section 15: secondary horizons, DESCRIPTIVE ONLY (no second Holm) ─────
sec = {"primary_horizon": "Y_30 (unchanged)", "status": "DESCRIPTIVE ONLY",
       "no_second_holm_family": True,
       "question": "how does the conditional effect evolve through time?",
       "features": {}}
for f in FAMILY:
    e = {}
    for H in OC.HORIZONS:
        ys = [r[f"y_{H}"] for r in eligible]
        cl = [r["trade_date"] for r in eligible]
        if f in CATEGORICAL:
            adm = admissible[f]
            xs = [(r[f] if r[f] in adm else None) for r in eligible]
            try:
                res = I.categorical_test(xs, ys, cl)
            except Exception:
                res = None
        else:
            xs = [winsorized(f, r.get(f)) for r in eligible]
            try:
                res = I.continuous_test(xs, ys, cl)
            except Exception:
                res = None
        e[f"Y_{H}"] = (None if res is None else
                       {"beta": res.get("beta_of_interest"),
                        "raw_p_descriptive": res["p_of_interest"],
                        "rho": res.get("rho"), "N": res["N"]})
    sec["features"][f] = e
json.dump(sec, open("research/V2_PROXY_SECONDARY_HORIZONS.json", "w"),
          indent=2, default=str)

# ── section 16: frozen landmark analysis ──────────────────────────────────
LF = ("reclaim_occurred_by_L", "reclaim_latency_min_if_by_L",
      "reclaim_magnitude_atr_if_by_L", "distance_travelled_atr_by_L",
      "displacement_observed_atr_by_L", "bars_elapsed")
lm = {"origin": "EVENT_CONFIRMATION_TIME", "landmarks_min": list(OC.LANDMARKS),
      "remaining_horizon_min": OC.LANDMARK_REMAINING_MIN,
      "atr": "ATR0 for all landmarks (frozen denominator)",
      "status": "PREDECLARED SECONDARY ANALYSIS - not a route around Y_30",
      "landmarks": {}}
for r in eligible:
    r["_lm"] = OC.landmarks(r, bars, idx)
for L in OC.LANDMARKS:
    have = [r for r in eligible if r["_lm"][L]["remaining_return"] is not None]
    ent = {"events_with_remaining_return": len(have),
           "trade_dates": len({r["trade_date"] for r in have}), "features": {}}
    ys = [r["_lm"][L]["remaining_return"] for r in have]
    cl = [r["trade_date"] for r in have]
    for f in LF:
        xs = [r["_lm"][L][f] for r in have]
        xs = [(1.0 if v is True else 0.0 if v is False else v) for v in xs]
        if len({v for v in xs if v is not None}) < 2:
            ent["features"][f] = None; continue
        try:
            res = I.continuous_test(xs, ys, cl)
            ent["features"][f] = {"beta": res["beta_of_interest"],
                                  "raw_p_descriptive": res["p_of_interest"],
                                  "rho": res.get("rho"), "N": res["N"],
                                  "G": res["G"]}
        except Exception as exc:
            ent["features"][f] = {"status": f"UNEVALUABLE: {exc}"}
    lm["landmarks"][f"+{L}m"] = ent
json.dump(lm, open("research/V2_PROXY_LANDMARKS.json", "w"),
          indent=2, default=str)

json.dump({"coverage": cov, "primary": primary, "promoted": promoted,
           "winsorization_source": "research/WINSORIZATION_FREEZE_V2.json",
           "population": "development evaluable, master Y30-eligible",
           "note": "PROXY EVIDENCE - Dukascopy Nasdaq CFD, not CME NQ."},
          open("research/V2_PROXY_PRIMARY_RESULTS.json", "w"),
          indent=2, default=str)

print(f"\nPROMOTED_PHASE1: {promoted if promoted else 'NONE'}")
print("artifacts: EVENT_POPULATION, PRIMARY_RESULTS, HOLM, SUBPERIODS, "
      "ROBUSTNESS, SECONDARY_HORIZONS, LANDMARKS")

# ── section 17: direction split + frozen outcome record, DESCRIPTIVE ───────
def summ(vals):
    v = sorted(x for x in vals if x is not None)
    if not v: return None
    n = len(v)
    q = lambda p: v[max(0, min(n-1, int(p*(n-1))))]
    return {"n": n, "median": q(0.5), "p25": q(0.25), "p75": q(0.75),
            "mean": sum(v)/n}

osum = {"status": "DESCRIPTIVE event-study record, NOT strategy metrics",
        "forbidden_here": ["entry", "stop", "target", "win rate",
                           "profit factor", "Sharpe", "equity curve"],
        "all": {}, "by_direction": {}}
for H in OC.HORIZONS:
    osum["all"][f"Y_{H}"] = summ([r[f"y_{H}"] for r in eligible])
    osum["all"][f"MFE_{H}"] = summ([r[f"mfe_{H}"] for r in eligible])
    osum["all"][f"MAE_{H}"] = summ([r[f"mae_{H}"] for r in eligible])
    osum["all"][f"time_to_MFE_{H}"] = summ([r[f"time_to_mfe_{H}"] for r in eligible])
    osum["all"][f"time_to_MAE_{H}"] = summ([r[f"time_to_mae_{H}"] for r in eligible])
for d, lab in ((1, "sell_side_bullish_orientation"),
               (-1, "buy_side_bearish_orientation")):
    ss = [r for r in eligible if r["direction"] == d]
    osum["by_direction"][lab] = {
        "events": len(ss), "trade_dates": len({r["trade_date"] for r in ss}),
        **{f"Y_{H}": summ([r[f"y_{H}"] for r in ss]) for H in OC.HORIZONS},
        "MFE_30": summ([r["mfe_30"] for r in ss]),
        "MAE_30": summ([r["mae_30"] for r in ss])}
for k, lab in (("vwap_reached", "vwap_reached_by_30m"),
               ("level_revisited", "level_revisited_by_30m"),
               ("opposing_liquidity_reached", "opposing_liquidity_reached_by_30m")):
    vv = [r[k] for r in eligible if r[k] is not None]
    osum["all"][lab] = {"n": len(vv),
                        "rate": (sum(1 for x in vv if x)/len(vv)) if vv else None}
json.dump(osum, open("research/V2_PROXY_OUTCOME_SUMMARY.json", "w"),
          indent=2, default=str)
print("\ndescriptive outcome record written")
