#!/usr/bin/env python3
"""GATE 4 - mechanical V1 correction.

Reruns the EXACT frozen V1 configurations under the corrected CME session
boundaries. Nothing about the strategies changes: parameters are rebuilt from
V1_FROZEN.json and each one's sha256 is re-derived and compared against the
stored hash, so a silent specification change would abort rather than pass.

This is a reproducibility correction, not a configuration search. No parameter,
hypothesis, threshold, or configuration is added, removed or altered.
"""
import hashlib, json, os, subprocess, sys
from dataclasses import asdict, replace
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E, partitions as P, report_result as R
from freeze_v1 import cfg_hash, drawdown_r

BASIS = "data_ndx_q/NDX_5m.csv"
orig = json.load(open("research/V1_FROZEN.json"))
bars, countable, eligible = P.load(BASIS, "development")
sha = subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()

out = {"commit_corrected": sha, "commit_original": orig["commit"],
       "basis": BASIS, "partition": "development",
       "eligible_trade_days_original": orig["frequency_denominator_used"],
       "eligible_trade_days_corrected": len(eligible),
       "correction": "GATE 1 timezone-aware CME session boundaries + GATE 2 "
                     "eligible-day denominator. No strategy specification "
                     "changed; every config hash re-verified.",
       "rows": []}

mismatch = []
for r in orig["rows"]:
    prm = dict(r["params"])
    prm["pools"] = tuple(prm["pools"])
    prm["htf_confirm"] = tuple(prm.get("htf_confirm", ()))
    params = E.Params(**prm)
    h = cfg_hash(params)
    if h != r["config_hash"]:
        mismatch.append((r["hypothesis"], r["config"], r["config_hash"], h))
        continue
    ctx = E.build_context(bars)
    log = []
    E.run(bars, ctx, replace(params, friction_points=0.70, cost_ticks=0.0,
                             tick=0.25), outcome_log=log)
    log = P.countable(log, bars, countable)
    s = R.summarize(log, bars, r["config"], eligible_days=eligible)
    rs = [x["r"] for x in log]
    out["rows"].append({
        "hypothesis": r["hypothesis"], "config": r["config"], "config_hash": h,
        "hash_verified": True,
        "original": {"n": r["n"], "eligible_days": orig["frequency_denominator_used"],
                     "freq": r["freq_reported"], "mean_r": r["mean_r"],
                     "pf": r["pf"], "win_rate": r["win_rate"],
                     "max_drawdown_r": r["max_drawdown_r"],
                     "headline_ci": r["headline_ci"],
                     "headline_scale": r["headline_scale"],
                     "all_scales": r["all_scales"], "significant": r["significant"]},
        "corrected": {"n": s["n"], "eligible_days": len(eligible),
                      "freq": s["freq_per_trade_day"], "mean_r": s["mean_r"],
                      "pf": s["pf"], "win_rate": s["win_rate"],
                      "max_drawdown_r": drawdown_r(rs),
                      "headline_ci": s["headline_ci"],
                      "headline_scale": s["headline_scale"],
                      "all_scales": s["scales"], "significant": s["significant"]},
        "failure_reason": r["failure_reason"]})
    print(f"  {r['hypothesis']:<9} {r['config']:<34} "
          f"n {r['n']:>5}->{s['n']:<5}  "
          f"{r['mean_r']:+.4f}->{s['mean_r']:+.4f}R  "
          f"freq {r['freq_reported']:.2f}->{s['freq_per_trade_day']:.2f}")

if mismatch:
    sys.exit(f"HALT: {len(mismatch)} configuration hash mismatches: {mismatch}")
out["all_hashes_verified"] = True
out["qualitative_change"] = any(
    x["original"]["significant"] != x["corrected"]["significant"]
    or (x["original"]["mean_r"] > 0) != (x["corrected"]["mean_r"] > 0)
    for x in out["rows"])
json.dump(out, open("research/V1_CORRECTED.json", "w"), indent=2, default=str)
print(f"\nall {len(out['rows'])} configuration hashes verified identical")
print(f"any qualitative conclusion changed: {out['qualitative_change']}")
print("-> research/V1_CORRECTED.json")
