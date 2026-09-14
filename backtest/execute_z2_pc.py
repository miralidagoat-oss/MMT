#!/usr/bin/env python3
"""V3-Z2-PC execution: instrument check on the V3-Z1 inference pipeline.

  --dry-run   eligibility, design, conditioning. Outcome value unreachable.
  --execute --i-authorize-outcome-inspection   the authorized path.

A1 sensitivity: can the pipeline detect volatility persistence?
A2 specificity: does it reject at its nominal rate when no effect exists?
"""
import argparse, datetime as dt, hashlib, json, math, os, random, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_inference as I, z1_panel as Z, z1_design as D
import z2_control as C

SPEC = "research/V3_Z2_PC_EXECUTION_SPEC.json"
PRE = json.load(open("research/V3_Z2_PC_PREREGISTRATION.json"))

A1_T_MIN = 4.0
A1_WALD_P_MAX = 1e-4
A1_BETA_MIN = 0.0698                 # the design's own MDE
A2_PERMUTATIONS = 1000
A2_SEED = 20260914
A2_ALPHA = 0.05
A2_BAND = (0.025, 0.080)
COLS = ("intercept",) + C.HAR_COMPONENTS + \
    tuple(f"session[{n}]" for n in D.SESSION_DUMMIES)


class OutcomeFirewall(Exception):
    pass


def _poisoned(*a, **k):
    raise OutcomeFirewall("outcome value unreachable on the dry-run path")


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def verify(spec_path=SPEC):
    if not os.path.exists(spec_path):
        return {"verified": False, "reason": "spec not yet written"}
    want = json.load(open(spec_path))["protected_hashes"]
    bad = {p: sha(p) for p, h in want.items() if sha(p) != h}
    if bad:
        raise SystemExit(f"HALT: protected hash mismatch {list(bad)}. "
                         "No outcome was read.")
    return {"verified": True, "files": len(want)}


def build(dry_run=True):
    if dry_run:
        C.forward_rv = _poisoned
    rows, _ = Z.build_panel()
    rets = {m: Z.log_returns(rows, m) for m in Z.MARKETS}
    dates = sorted({r["trade_date"] for r in rows})
    excl = Z.roll_excluded_dates(dates[0], dates[-1])
    P = json.load(open("research/V3_Z1_PREREGISTRATION.json"))["partitions"]
    d0 = dt.date.fromisoformat(P["A_development"]["first"])
    d1 = dt.date.fromisoformat(P["A_development"]["last"])
    cutoff = int(dt.datetime.fromisoformat(
        P["C_true_prospective_holdout"]["starts_after_utc"]).timestamp())
    out = []
    for i, r in enumerate(rows):
        d = r["trade_date"]
        if r["ts"] > cutoff or d in excl or not (d0 <= d <= d1):
            continue
        f = C.har_features(rets["NQ"], i)
        if any(v is None for v in f.values()):
            continue
        if not C.forward_rv_available(rows, rets, i):
            continue
        b = D.session_bucket(r["ts"])
        if b is None:
            continue
        out.append({"i": i, "trade_date": d, "bucket": b, "har": f})
    return rows, rets, out


def wald(fit, idx, G):
    """Joint Wald on the coefficients at positions `idx`, referred to F(q,G-1)."""
    q = len(idx)
    b = [fit["beta"][j] for j in idx]
    V = [[fit["V"][a][c] for c in idx] for a in idx]
    Vi = I._inv(V)
    w = sum(b[a] * sum(Vi[a][c] * b[c] for c in range(q))
            for a in range(q)) / q
    return w, I.f_sf(w, q, G - 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--i-authorize-outcome-inspection", action="store_true")
    a = ap.parse_args()
    if a.execute and not a.i_authorize_outcome_inspection:
        sys.exit("HALT: --execute requires --i-authorize-outcome-inspection.")
    print(json.dumps(verify(), indent=2))
    rows, rets, recs = build(dry_run=not a.execute)
    sc = {k: Z.fit_scaler([r["har"][k] for r in recs]) for k in C.HAR_COMPONENTS}
    X = [[1.0] + [Z.apply_scaler(r["har"][k], sc[k]) for k in C.HAR_COMPONENTS]
         + D.dummies(r["bucket"]) for r in recs]
    info = D.check_design(X, COLS)
    print(f"rows {len(recs):,}  clusters {len({r['trade_date'] for r in recs})}  "
          f"rank {info['rank']}/{info['k']}  cond {info['condition_number']:.2f}")
    if not a.execute:
        print("DRY RUN COMPLETE - no outcome value computed.")
        return

    FIRST = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    y = [C.forward_rv(rows, rets, r["i"]) for r in recs]
    keep = [k for k, v in enumerate(y) if v is not None]
    Xk = [X[k] for k in keep]; yk = [y[k] for k in keep]
    cl = [recs[k]["trade_date"] for k in keep]
    G = len({*cl})
    fit = I.cr1_ols(yk, [r[1:] for r in Xk], cl)
    bs, se, t, p = fit["beta"][1], fit["se"][1], fit["t"][1], fit["p"][1]
    W, wp = wald(fit, [1, 2, 3], G)
    res = {"first_outcome_inspection_utc": FIRST,
           "code_commit": os.popen("git rev-parse HEAD").read().strip(),
           "rows": len(keep), "clusters": G,
           "design": {"k": info["k"], "rank": info["rank"],
                      "condition_number": info["condition_number"]},
           "A1": {"beta_short": bs, "cr1_se": se, "t": t, "raw_p": p,
                  "ci95": fit["ci"][1], "df": fit["df"],
                  "beta_day": fit["beta"][2], "t_day": fit["t"][2],
                  "beta_week": fit["beta"][3], "t_week": fit["t"][3],
                  "joint_wald_F": W, "joint_wald_p": wp,
                  "gate_positive": bs > 0, "gate_t": abs(t) >= A1_T_MIN,
                  "gate_wald": wp < A1_WALD_P_MAX,
                  "gate_mde": abs(bs) >= A1_BETA_MIN}}
    res["A1"]["PASS"] = all(res["A1"][k] for k in
                            ("gate_positive", "gate_t", "gate_wald", "gate_mde"))
    print(f"\n=== A1 SENSITIVITY ===  first outcome {FIRST}")
    A = res["A1"]
    print(f"  rows {len(keep):,}  clusters {G}  df {A['df']}")
    print(f"  beta_short {A['beta_short']:+.5f}  se {A['cr1_se']:.5f}  "
          f"t {A['t']:+.2f}  p {A['raw_p']:.3e}")
    print(f"  95% CI [{A['ci95'][0]:+.5f}, {A['ci95'][1]:+.5f}]")
    print(f"  beta_day {A['beta_day']:+.5f} (t {A['t_day']:+.2f})   "
          f"beta_week {A['beta_week']:+.5f} (t {A['t_week']:+.2f})")
    print(f"  joint Wald F {A['joint_wald_F']:.2f}  p {A['joint_wald_p']:.3e}")
    for g, lbl in (("gate_positive", "b_s > 0"), ("gate_t", f"|t| >= {A1_T_MIN}"),
                   ("gate_wald", f"Wald p < {A1_WALD_P_MAX}"),
                   ("gate_mde", f"|b_s| >= {A1_BETA_MIN}")):
        print(f"    {lbl:<22} {'PASS' if A[g] else 'FAIL'}")
    print(f"  A1 {'PASS' if A['PASS'] else 'FAIL'}")

    # ── A2: block permutation across whole trade dates ────────────────────
    bydate = {}
    for k in keep:
        bydate.setdefault(recs[k]["trade_date"], []).append(k)
    dl = sorted(bydate)
    rng = random.Random(A2_SEED)
    rej = 0; done = 0; ts = []
    for _ in range(A2_PERMUTATIONS):
        perm = dl[:]; rng.shuffle(perm)
        Xp, yp, cp = [], [], []
        for d, src in zip(dl, perm):
            n = min(len(bydate[d]), len(bydate[src]))
            for a_, b_ in zip(bydate[src][:n], bydate[d][:n]):
                Xp.append(X[a_][1:]); yp.append(y[b_]); cp.append(d)
        try:
            f2 = I.cr1_ols(yp, Xp, cp)
        except Exception:
            continue
        done += 1; ts.append(f2["t"][1])
        if f2["p"][1] <= A2_ALPHA:
            rej += 1
    rate = rej / done if done else None
    res["A2"] = {"permutations": done, "seed": A2_SEED, "alpha": A2_ALPHA,
                 "rejections": rej, "rejection_rate": rate,
                 "band": list(A2_BAND),
                 "mean_abs_t": float(np.mean([abs(x) for x in ts])) if ts else None,
                 "PASS": (rate is not None and A2_BAND[0] <= rate <= A2_BAND[1])}
    print(f"\n=== A2 SPECIFICITY (size) ===")
    B = res["A2"]
    print(f"  {B['permutations']:,} block permutations, seed {B['seed']}")
    print(f"  rejections at alpha={A2_ALPHA}: {B['rejections']}  "
          f"rate {B['rejection_rate']:.4f}")
    print(f"  pass band [{A2_BAND[0]}, {A2_BAND[1]}]  ->  "
          f"{'PASS' if B['PASS'] else 'FAIL'}")
    print(f"  mean |t| under the null: {B['mean_abs_t']:.3f}")

    res["VERDICT"] = ("INSTRUMENT VALIDATED" if res["A1"]["PASS"] and res["A2"]["PASS"]
                      else "INSTRUMENT CHECK FAILED")
    res["performance_inspected"] = True
    res["outcomes_inspected"] = True
    res["development_run"] = True
    res["prospective_holdout_inspected"] = False
    res["data_cost_usd"] = 0
    res["scalers"] = {k: {"mean": v["mean"], "sd": v["sd"], "n": v["n"]}
                      for k, v in sc.items()}
    json.dump(res, open("research/V3_Z2_PC_RESULTS.json", "w"), indent=2, default=str)
    print(f"\nVERDICT: {res['VERDICT']}")
    print("-> research/V3_Z2_PC_RESULTS.json")


if __name__ == "__main__":
    main()
