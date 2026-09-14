#!/usr/bin/env python3
"""V3-Z1 development runner with a ONE-WAY OUTCOME FIREWALL.

    python3 backtest/run_z1_dev.py --dry-run
        builds the panel, features, design matrix, eligibility, deciles and
        conditioning. Returns counts and metadata ONLY. Real Y values cannot be
        loaded or computed on this path.

    python3 backtest/run_z1_dev.py --execute --i-authorize-outcome-inspection
        the authorized path. Not used until explicitly instructed.

The firewall is structural, not a naming convention: on the dry-run path the
outcome VALUE function is replaced by a poisoned stub that raises. Only the
PRESENCE predicate (z1_design.outcome_available, which returns a bool) is
reachable, so eligibility can be counted without ever learning a return.
"""
import argparse, hashlib, json, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, z1_panel as Z, z1_design as D

SPEC = "research/V3_Z1_EXECUTION_SPEC.json"

PROTECTED = ("research/V3_Z1_PREREGISTRATION.json",
             "research/V3_Z1_PREREGISTRATION_AMENDMENT_01.md",
             "research/V3_Z1_DATA_MANIFEST.json",
             "backtest/z1_panel.py", "backtest/z1_design.py")


class OutcomeFirewall(Exception):
    """Raised if the dry-run path reaches the outcome VALUE function."""


def _poisoned(*a, **k):
    raise OutcomeFirewall(
        "the outcome value function is unreachable on the dry-run path; "
        "only z1_design.outcome_available (a bool) may be used")


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def verify_hashes(spec_path=SPEC):
    """HALT if any protected artifact differs from the frozen spec."""
    if not os.path.exists(spec_path):
        return {"verified": False, "reason": "execution spec not yet written"}
    want = json.load(open(spec_path)).get("protected_hashes", {})
    bad = {p: {"expected": h, "actual": sha(p)}
           for p, h in want.items() if os.path.exists(p) and sha(p) != h}
    missing = [p for p in want if not os.path.exists(p)]
    if bad or missing:
        raise SystemExit(
            f"HALT: protected artifact hash mismatch.\n  changed: {list(bad)}\n"
            f"  missing: {missing}\nNo real outcome was read.")
    return {"verified": True, "files": len(want)}


def build(dry_run=True):
    """Panel, features, eligibility and design metadata. NO outcome value."""
    if dry_run:
        Z.primary_outcome = _poisoned          # structural firewall
    rows, _ = Z.build_panel()
    rets = {m: Z.log_returns(rows, m) for m in Z.MARKETS}
    dates = sorted({r["trade_date"] for r in rows})
    excl = Z.roll_excluded_dates(dates[0], dates[-1])
    bounds = Z.session_bounds_rows(rows)
    ordered = sorted(bounds)
    dpos = {d: i for i, d in enumerate(ordered)}

    recs = []
    acc = {"n": 0, "sum": 0.0}; cur = None
    for i, r in enumerate(rows):
        k = Z.session_key(r["ts"])
        if k != cur:
            cur = k; acc = {"n": 0, "sum": 0.0}
        f, z = Z.features_at(rows, rets, i, acc)
        if f["divergence_1h"] is not None:
            acc["n"] += 1; acc["sum"] += f["divergence_1h"]
        d = r["trade_date"]
        sig = Z.rolling_sigma(rets["NQ"], i)
        recs.append({
            "i": i, "ts": r["ts"], "trade_date": d,
            "roll_excluded": d in excl,
            "bucket": D.session_bucket(r["ts"]),
            "divergence_1h": f["divergence_1h"],
            "divergence_session": f["divergence_session"],
            "nq_z": z["NQ"],
            "nq_vol_state": (math.log(sig) if sig else None),
            "prev_day_nq_return": Z.prev_day_nq_return(
                rows, bounds, ordered, dpos, d, excl),
            "outcome_present": D.outcome_available(rows, rets, i)})
    return rows, recs


import math  # noqa: E402  (used above, imported late to keep the header clean)


def complete_case(recs, feature, date_set):
    """The FROZEN per-hypothesis complete-case rule. Deterministic, no
    imputation, no forward fill, no post-hoc intersection with the other
    hypothesis."""
    out = []
    for r in recs:
        if r["roll_excluded"] or r["trade_date"] not in date_set:
            continue
        if not r["outcome_present"]:
            continue
        if r[feature] is None:
            continue
        if any(r[b] is None for b in ("nq_z", "nq_vol_state", "prev_day_nq_return")):
            continue
        if r["bucket"] is None:
            continue
        out.append(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--i-authorize-outcome-inspection", action="store_true")
    a = ap.parse_args()
    if a.execute and not a.i_authorize_outcome_inspection:
        sys.exit("HALT: --execute requires --i-authorize-outcome-inspection. "
                 "No outcome was read.")
    if not a.dry_run and not a.execute:
        sys.exit("specify --dry-run or --execute")
    if a.execute:
        sys.exit("HALT: execution is not authorized in this build. "
                 "The development test has NOT been run.")
    print(json.dumps(verify_hashes(), indent=2))
    rows, recs = build(dry_run=True)
    print(f"panel rows {len(rows):,}   records {len(recs):,}")
    print("DRY RUN COMPLETE - no outcome value was computed.")


if __name__ == "__main__":
    main()
