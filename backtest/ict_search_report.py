#!/usr/bin/env python3
"""Turn a 10,000-configuration search into an answer you can trust.

Reads search_results.json and asks, in order:
  1. What profit factor does the LUCKIEST configuration reach on a
     structureless null series? That is the lock-picking threshold.
  2. Does the best real configuration clear it?
  3. Of the strongest in-sample configurations, which also work on five
     index futures the search never saw?
  4. Is the winner a plateau or a spike? Perturb every parameter one at a
     time; a setting that only works at exactly one value is a lottery
     ticket, not a setting.
"""
import json
import math
import os
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ict_of_backtest import P0, load, prep, run, stats, primary_csv   # noqa: E402
import ict_search as S                                               # noqa: E402


def pct(vals, q):
    v = sorted(vals)
    return v[min(len(v) - 1, int(q * len(v)))]


def rs_of(trades):
    return [t["R"] for t in trades]


def tstat(rs):
    n = len(rs)
    if n < 2:
        return 0.0, 0.0
    m = sum(rs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in rs) / (n - 1))
    return m, (m / (sd / math.sqrt(n)) if sd > 0 else 0.0)


def evaluate(cfg, key):
    P = dict(P0, **{k: v for k, v in cfg.items() if not k.startswith("_")})
    P["point_value"], P["tick"] = S.PVS.get(key, 2.0), S.TKS.get(key, 0.25)
    tr, _ = run(S.DATA[key], P, True)
    return tr


def full_picture(cfg):
    tr = evaluate(cfg, "MNQ")
    s = stats(tr, [], P0)
    m, t = tstat(rs_of(tr))
    oos = []
    for sym in S.MARKETS:
        if sym in S.DATA:
            oos += rs_of(evaluate(cfg, sym))
    om, ot = tstat(oos)
    gp = sum(x for x in oos if x > 0)
    gl = -sum(x for x in oos if x <= 0)
    return dict(n=s.get("trades", 0), wr=s.get("wr", 0), pf=s.get("pf", 0),
                avgR=m, t=t, oos_n=len(oos), oos_avgR=om, oos_t=ot,
                oos_pf=(gp / gl if gl > 0 else 9.99),
                oos_wr=(100 * sum(1 for x in oos if x > 0) / len(oos)) if oos else 0)


PERTURB = {
    "thresh": [-2, -1, 1, 2], "sweep_lb": [-1, 1], "struct_lb": [-4, 4],
    "pv_len": [-1, 1], "mss_max_bar": [-4, 4], "zone_valid": [-4, 4],
    "min_stop_atr": [-0.25, 0.25], "max_stop_atr": [-0.5, 0.5],
    "stop_buf_atr": [-0.1, 0.1], "fixed_r": [-0.5, 0.5], "max_hold": [-12, 12],
    "disp_atr": [-0.2, 0.2], "leg_atr": [-0.3, 0.3], "ob_lb": [-5, 5],
    "rvol_min": [-0.3, 0.3], "min_pen_ticks": [-1, 1], "div_len": [-10, 10],
}
FLIPS = ["req_mss", "req_fvg", "req_kz", "be_on", "use_part", "use_htf",
         "veto_htf", "use_delta_score", "use_vw_tgt"]


def _job(a):
    lab, cfg = a
    return lab, full_picture(cfg)


def neighbourhood(cfg):
    jobs = []
    for k, deltas in PERTURB.items():
        if k not in cfg:
            continue
        for dlt in deltas:
            c = dict(cfg)
            v = c[k] + dlt
            if isinstance(cfg[k], int):
                v = int(round(v))
            if v <= 0 and k not in ("min_stop_atr", "stop_buf_atr", "rvol_min",
                                    "min_pen_ticks", "thresh"):
                continue
            if v < 0:
                continue
            c[k] = v
            jobs.append((f"{k} {cfg[k]}->{v}", c))
    for k in FLIPS:
        if k in cfg:
            c = dict(cfg)
            c[k] = not c[k]
            jobs.append((f"{k} -> {not cfg[k]}", c))
    for k in ("stop_mode", "fill_pref", "rr_mode", "zone_mode"):
        if k not in cfg:
            continue
        opts = {"stop_mode": ["raid", "zone", "tighter"],
                "fill_pref": ["aggressive", "mid", "patient"],
                "rr_mode": ["fixed", "stretch", "pool"],
                "zone_mode": ["Auto", "FVG", "Order block", "OTE", "FVG + OTE"]}[k]
        for o in opts:
            if o != cfg[k]:
                c = dict(cfg)
                c[k] = o
                jobs.append((f"{k} -> {o}", c))
    with Pool(4) as pool:
        return pool.map(_job, jobs, chunksize=2)


def main(d):
    res = json.load(open(os.path.join(d, "search_results.json")))
    real, null, top = res["real"], res["null"], res["top"]
    cfgs = {int(k): v for k, v in res["cfgs"].items()}

    print("=" * 78)
    print("  STEP 1 - HOW GOOD DOES LUCK LOOK?")
    print("=" * 78)
    print(f"  Identical search, structureless price path (real timestamps,")
    print(f"  real volumes, real volatility, no exploitable structure).\n")
    for lab, arr in (("REAL MNQ", real), ("NULL (noise)", null)):
        pfs = [r["pf"] for r in arr]
        ts = [r["t"] for r in arr]
        print(f"  {lab:<14} {len(arr):>5} configs passed filters   "
              f"best PF {max(pfs):>5.2f}   best t {max(ts):>5.2f}   "
              f"median PF {pct(pfs,.5):>4.2f}   90th pct PF {pct(pfs,.9):>4.2f}")
    nb_pf, nb_t = max(r["pf"] for r in null), max(r["t"] for r in null)
    rb_pf, rb_t = max(r["pf"] for r in real), max(r["t"] for r in real)
    print(f"\n  Lock-picking threshold: on pure noise the best of ~10,000 tries")
    print(f"  still reached PF {nb_pf:.2f} (t = {nb_t:.2f}).")
    print(f"  Best on real MNQ: PF {rb_pf:.2f} (t = {rb_t:.2f})  ->  "
          f"{'CLEARS' if rb_t > nb_t else 'DOES NOT CLEAR'} the noise bar.")
    beat = sum(1 for r in real if r["t"] > nb_t)
    print(f"  Real configs beating the best noise config: {beat} of {len(real)}"
          f"  ({100*beat/max(len(real),1):.1f}%)")

    print("\n" + "=" * 78)
    print("  STEP 2 - DOES THE IN-SAMPLE WINNER SURVIVE OUT OF SAMPLE?")
    print("=" * 78)
    withoos = [r for r in top if r.get("oos")]
    withoos.sort(key=lambda r: -r["t"])
    print(f"  {'rank':>4} {'MNQ n':>6} {'WR%':>6} {'PF':>6} {'avgR':>6} {'t':>6} | "
          f"{'OOS n':>6} {'OOS WR%':>8} {'OOS PF':>7} {'OOS avgR':>9} {'OOS t':>6}")
    for i, r in enumerate(withoos[:15]):
        o = r["oos"]
        print(f"  {i+1:>4} {r['n']:>6} {r['wr']:>6.1f} {r['pf']:>6.2f} {r['avgR']:>6.2f} "
              f"{r['t']:>6.2f} | {o['n']:>6} {o['wr']:>8.1f} {o['pf']:>7.2f} "
              f"{o['avgR']:>9.3f} {o['oos_t'] if 'oos_t' in o else o['t']:>6.2f}")
    pos = [r for r in withoos if r["oos"]["avgR"] > 0]
    print(f"\n  Of the top {len(withoos)} in-sample configurations, "
          f"{len(pos)} have positive expectancy out of sample "
          f"({100*len(pos)/max(len(withoos),1):.0f}%).")
    corr_x = [r["t"] for r in withoos]
    corr_y = [r["oos"]["t"] for r in withoos]
    if len(corr_x) > 5:
        mx, my = sum(corr_x)/len(corr_x), sum(corr_y)/len(corr_y)
        cov = sum((corr_x[i]-mx)*(corr_y[i]-my) for i in range(len(corr_x)))
        sx = math.sqrt(sum((x-mx)**2 for x in corr_x))
        sy = math.sqrt(sum((y-my)**2 for y in corr_y))
        r_corr = cov/(sx*sy) if sx*sy else 0
        print(f"  Correlation between in-sample and out-of-sample t: {r_corr:+.3f}")
        print(f"  (near zero = in-sample ranking carries no information about the future)")
    return res, real, null, withoos, cfgs


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "data"
    S.DATA["MNQ"] = prep(load(primary_csv(d)), P0)
    for sym in S.MARKETS:
        p = os.path.join(d, f"{sym}_5m.csv")
        if os.path.exists(p):
            S.DATA[sym] = prep(load(p), P0)
    _cfg, _res = None, None
    main(d)
    _cfg, _res = pick_and_verify(d)
    if _cfg:
        import ict_to_tradingview as TV
        print()
        print(TV.render(_cfg, "BEST VALIDATED CONFIGURATION"))
        json.dump(_cfg, open(os.path.join(d, "best_config.json"), "w"), default=str)


def pick_and_verify(d):
    """Select the configuration that is strongest OUT of sample among the
    in-sample leaders, then test whether it is a plateau or a spike."""
    res = json.load(open(os.path.join(d, "search_results.json")))
    top = [r for r in res["top"] if r.get("oos")]
    cfgs = {int(k): v for k, v in res["cfgs"].items()}
    null_best_t = max(r["t"] for r in res["null"])

    # a candidate must be strong in-sample, positive out of sample, and
    # consistent across both halves of the selection set
    cands = [r for r in top
             if r["oos"]["avgR"] > 0 and r["h1"] > 0 and r["h2"] > 0]
    cands.sort(key=lambda r: -(r["oos"]["avgR"] * math.sqrt(r["oos"]["n"])))
    print("\n" + "=" * 78)
    print("  STEP 3 - CANDIDATES THAT SURVIVE EVERY TEST")
    print("=" * 78)
    print(f"  requirement: top-250 in-sample  AND  positive in both MNQ halves"
          f"  AND  positive across the five untouched markets")
    print(f"  survivors: {len(cands)} of {len(top)}\n")
    if not cands:
        print("  NONE. No configuration in the search passes all three tests.")
        return None, res
    for i, r in enumerate(cands[:8]):
        o = r["oos"]
        print(f"  #{i+1}  MNQ n={r['n']:>3} WR={r['wr']:>5.1f}% PF={r['pf']:>5.2f} "
              f"t={r['t']:>5.2f} (h1 {r['h1']:+.2f}R / h2 {r['h2']:+.2f}R)  |  "
              f"OOS n={o['n']:>3} WR={o['wr']:>5.1f}% PF={o['pf']:>5.2f} avgR={o['avgR']:+.3f}")
    win = cands[0]
    cfg = cfgs[win["idx"]]
    print(f"\n  Best-of-noise t was {null_best_t:.2f}; this candidate's in-sample t is "
          f"{win['t']:.2f}.")

    print("\n" + "=" * 78)
    print("  STEP 4 - IS IT A PLATEAU OR A SPIKE?")
    print("=" * 78)
    base = full_picture(cfg)
    print(f"  baseline: MNQ n={base['n']} WR={base['wr']:.1f}% PF={base['pf']:.2f} "
          f"avgR={base['avgR']:+.3f} | OOS avgR={base['oos_avgR']:+.3f}\n")
    nb = neighbourhood(cfg)
    ok = [x for x in nb if x[1]["n"] >= 25]
    worse = [x for x in ok if x[1]["avgR"] <= 0]
    print(f"  {len(ok)} single-parameter perturbations produced enough trades to judge")
    print(f"  {len(ok)-len(worse)} stayed profitable on MNQ, {len(worse)} went negative")
    print(f"  -> {'PLATEAU (robust)' if len(worse) <= 0.35*len(ok) else 'SPIKE (fragile)'}\n")
    ok.sort(key=lambda x: x[1]["avgR"])
    print("  most damaging changes:")
    for lab, st in ok[:6]:
        print(f"    {lab:<34} n={st['n']:>3}  avgR={st['avgR']:+.3f}  PF={st['pf']:.2f}")
    print("  least damaging:")
    for lab, st in ok[-4:]:
        print(f"    {lab:<34} n={st['n']:>3}  avgR={st['avgR']:+.3f}  PF={st['pf']:.2f}")
    return cfg, res
