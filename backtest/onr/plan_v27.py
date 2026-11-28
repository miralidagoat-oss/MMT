#!/usr/bin/env python3
"""Your plan (plan_search.py) and the slow start, rerun with indicator v2.7.1's defaults: the 5-minute ORB leg in
Topstep 50K and 150K XFAs (Auto), the overnight trade kept (the v2.7.1 skip switch off), Lucid unchanged.

usage: python3 -I plan_v27.py FUT_DATA_DIR OUT_DIR [--parity | --variants | --switch-budget | --skip]

--variants (run after the plain run, into the same OUT_DIR): the plan's FINAL and the slow start four ways: published
(ORB off), the ORB on at the reserves measured with it (= the plain run), the ORB on at the published amounts, and the
ORB switched on for every Topstep account once the spare cash reaches $25,000 (the published 150K step). Writes
variants_final.csv and variants_slow_start.csv, after checking that its run function reproduces the published plan and
the plain run exactly.
--switch-budget (after --variants): the $500 / $1,000 starts with the ORB leg switched on at $25,000 (OUT_DIR/switch25k/,
as plan_search.py writes them, and budget_view.csv), and the FINAL variants' step months (variants_final_steps.csv).
--skip (after both): your plan as v2.7.2 runs it, with and without the funded overnight trade in every funded account
(skip_final.csv, skip_slow_start.csv, skip25k/).

The Topstep 50K / 150K XFAs run on round 7's account class (r7_accounts.Funded7: per-contract legs in entry order);
every other account is the published class. With --parity those XFAs get the book's legs only, and every output must
then equal results_plan_search/ (the published plan) exactly: that is the check that the new run differs from the
published one by the ORB leg alone.
Writes, as plan_search.py does: reserves.json, runs.csv, round1.csv, round2.csv, car.csv, final_steps.csv, budget.csv,
budget_runs.csv, budget_monthly_runs.csv; and slow_start.csv, the slow start quoted in the chat on Nov 26 (G4: start with
$1,000 or $3,000; one Lucid 25K eval at a time; Topstep 1+1 at $3k, 2+2 at $5k, 5+5 at $9k; Lucid 50K add-on at its
reserve; Topstep 150K by the range rule at its reserve; starts every 5 sessions Dec 2019 - Nov 2022, 48 months each).
"""
import csv
import inspect
import json
import os
import sys
import textwrap
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account as ACC  # noqa: E402
import plan_search as PS  # noqa: E402
import r7_accounts as X  # noqa: E402
import research4 as R4  # noqa: E402

TOPSTEP_ORB = ("T50n", "T50s", "T150n", "T150s")   # Auto: the ORB leg on Topstep 50K and 150K only
ORB = X.BOOK + ("F1",)


def FA(S, **kw):
    legs = kw.pop("r7legs", None)
    return ACC.FundedAccount(S, **kw) if legs is None else X.Funded7(S, r7legs=legs, **kw)


# the plan's run() with its monthly series and step months kept (the slow-start table needs them)
_rs = textwrap.dedent(inspect.getsource(PS.run)).replace("def run(args):", "def run_series(args):")
_rs = _rs.replace("return dict(plan=name,", "return dict(series=series.tolist(), when=dict(when), plan=name,")
assert "series=series.tolist()" in _rs
exec(_rs, PS.__dict__)
# ... and one whose step can also switch the ORB leg on (--variants): an action {"orb": legs} is the indicator's input
# turned to the ORB leg at that step, for every Topstep account from the next session on
_rl = _rs.replace("def run_series(args):", "def run_switch(args):")
_rl = _rl.replace('            if firm == "car":', '            if firm == "orb":\n                _orb_on(pools, v)\n                continue\n            if firm == "car":')
assert "_orb_on(pools, v)" in _rl
exec(_rl, PS.__dict__)


def _orb_on(pools, legs):
    """The switch: every open Topstep XFA trades the ORB leg from the next session; a Combine still open, or passed and
    waiting for a slot, becomes its ORB-on type (the same Combine, price and rules: the leg is funded-only)."""
    p = pools["ts"]
    for f in p.funded:
        f.r7legs = legs
    ren = {"T50n": "T50x", "T150n": "T150x", "T50s": "T50sx", "T150s": "T150sx",
           "T50nk": "T50xk", "T150nk": "T150xk", "T50sk": "T50sxk", "T150sk": "T150sxk"}   # and the skip twins (--skip)
    for e in p.evals:
        e[1] = ren.get(e[1], e[1])
    p.ready = [ren.get(c, c) for c in p.ready]


PS._orb_on = _orb_on


def slow_start(fd, out, R, variants=None, name="slow_start.csv"):
    """The slow start (G4) at R's amounts; or variants, [(label, steps, step names)], through run_switch."""
    S = PS._S["S"]
    ts = lambda n: {"ts": (n, 2 * n, "T50n")}  # noqa: E731
    steps = [(None, {"lu": (1, 1, "L25f")}), (3000.0, ts(1)), (5000.0, ts(2)), (9000.0, ts(5)), (R["L50a"], PS.LU50),
             (R["T150n"], PS.T150R)]
    names = ["Topstep 1+1 ($3k)", "Topstep 2+2 ($5k)", "Topstep 5+5 ($9k)", f"Lucid 50K add-on 5+5 (${R['L50a']:,.0f})",
             f"Topstep 150K by range (${R['T150n']:,.0f})"]
    H = 48
    wk = PS.starts(S, PS.FUT_FIRST, "2022-11", every=5)
    V = variants or [("", steps, names)]
    jobs = [(f"{lab}|{int(b)}", st, k, b, H) for lab, st, _ in V for b in (1000.0, 3000.0) for k in wk]
    with get_context("fork").Pool(4, initializer=PS._init, initargs=("fut", fd)) as p:
        rows = p.map(PS.run_switch if variants else PS.run_series, jobs, chunksize=6)
    table = []
    for lab, _, nms in V:
        for b in ("1000", "3000"):
            Rr = [r for r in rows if r["plan"] == f"{lab}|{b}"]
            M = np.array([(r["series"] + [r["series"][-1]] * H)[:H] for r in Rr])
            bust = [r for r in Rr if r["bust_month"] != ""]
            fp = [float(r["first_payout_month"]) for r in Rr if r["first_payout_month"] != ""]
            row = dict(variant=lab) if variants else {}
            row.update(start_money=int(b), starts=len(Rr), ran_out=len(bust), first_payout_month_median=round(float(np.median(fp)), 1))
            for i, nm in enumerate(nms, 1):
                v = [float(r["when"][i]) for r in Rr if i in r["when"]]
                row[f"{nm}: reached" if not variants else f"step {i} reached"] = len(v)
                row[f"{nm}: month median" if not variants else f"step {i} month median"] = round(float(np.median(v)), 1) if v else ""
            for y in (1, 2, 3, 4):
                tot = M[:, 12 * y - 1]
                yr = tot - (M[:, 12 * (y - 1) - 1] if y > 1 else 0)
                row.update({f"y{y} total p10": round(float(np.percentile(tot, 10))), f"y{y} total p25": round(float(np.percentile(tot, 25))),
                            f"y{y} total median": round(float(np.median(tot))), f"y{y} total p75": round(float(np.percentile(tot, 75))),
                            f"y{y} total p90": round(float(np.percentile(tot, 90))), f"y{y} made that year median": round(float(np.median(yr)))})
            fall = np.array([r["deepest_fall"] for r in Rr])
            row.update(deepest_fall_median=round(float(np.median(fall))), deepest_fall_worst=round(float(fall.min())),
                       ahead_after_4y_pct=round(100 * float(np.mean(M[:, -1] > 0))))
            if variants:
                row["ran_out_starts"] = " ".join(f"{r['start']}:m{r['bust_month']}" for r in bust)
            table.append(row)
            print({k: v for k, v in row.items()}, flush=True)
    with open(os.path.join(out, name), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(table[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(table)
    return table


def variants(fd, out):
    """--variants: the plan and the slow start with the ORB leg on from the start or switched on at $25,000, at the
    published amounts (results_plan_search/reserves.json, the ORB-off reserves), next to the published plan and to
    results_plan_v27's (the ORB on, at the reserves measured with it). Writes variants_final.csv and
    variants_slow_start.csv. Checks first that run_switch reproduces both: the published FINAL and slow start with the
    book's legs, and results_plan_v27's FINAL and slow start with the ORB on at its own reserves."""
    X.init(fd, 0.0)
    PS.FundedAccount = FA
    R4.FundedAccount, R4.EvalAccount = FA, ACC.EvalAccount
    for c in TOPSTEP_ORB:
        PS.CFG[c]["fk"] = dict(PS.CFG[c]["fk"], r7legs=X.BOOK)
    PS.CFG["T50x"] = dict(PS.CFG["T50n"], fk=dict(PS.CFG["T50n"]["fk"], r7legs=ORB))
    PS.CFG["T150x"] = dict(PS.CFG["T150n"], fk=dict(PS.CFG["T150n"]["fk"], r7legs=ORB))
    S = PS.T.load("fut", fd)
    PS._S["S"] = S
    PS.KINDS[:] = ["futures"]
    os.makedirs(out, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    Rp = json.load(open(os.path.join(here, "results_plan_search", "reserves.json")))["reserve"]
    Rn = json.load(open(os.path.join(here, "results_plan_v27", "reserves.json")))["reserve"]
    car = {"car": PS.CAR}
    T5x, T150Rx = {"ts": (5, 10, "T50x")}, {"ts": (5, 10, "RANGE:T150x:T50x")}
    lu, up, at = PS.final_at(Rp)
    lun, upn, atn = PS.final_at(Rn)
    F = [("published (ORB off)", [(None, PS.T5), (lu, PS.LU50), (up, PS.T150R), (at, car)]),
         ("ORB on, its own amounts", [(None, T5x), (lun, PS.LU50), (upn, T150Rx), (atn, car)]),
         ("ORB on, published amounts", [(None, T5x), (lu, PS.LU50), (up, T150Rx), (at, car)]),
         (f"ORB switched on at ${up:,.0f}", [(None, PS.T5), (lu, PS.LU50), (up, dict(T150Rx, orb=ORB)), (at, car)])]
    ks = PS.starts(S, PS.FUT_FIRST, "2023-11")
    jobs = [(n, st, k, None, None) for n, st in F for k in ks]
    with get_context("fork").Pool(4, initializer=PS._init, initargs=("fut", fd)) as p:
        rows = [dict(data="futures", **{k: v for k, v in r.items() if k not in ("series", "when")}) for r in p.map(PS.run_switch, jobs, chunksize=4)]
    P = [(n, n) for n, _ in F]
    summ = PS.summary(rows, P)
    pub = {r["plan"]: r for r in csv.DictReader(open(os.path.join(here, "results_plan_search", "car.csv")))}["FINAL"]
    new = {r["plan"]: r for r in csv.DictReader(open(os.path.join(here, "results_plan_v27", "car.csv")))}["FINAL"]
    for s, ref in ((summ[0], pub), (summ[1], new)):
        for k, v in s.items():
            if k not in ("plan", "label"):
                assert str(v) == ref[k], (s["plan"], k, v, ref[k])
    print("run_switch reproduces the published FINAL and results_plan_v27's FINAL, every column", flush=True)
    PS.write(out, "variants_final.csv", summ)
    ts = lambda n, c="T50n": {"ts": (n, 2 * n, c)}  # noqa: E731
    g4 = lambda c, R, top: [(None, {"lu": (1, 1, "L25f")}), (3000.0, ts(1, c)), (5000.0, ts(2, c)), (9000.0, ts(5, c)),  # noqa: E731
                            (R["L50a"], PS.LU50), (R["T150n"], top)]
    nm = lambda R: ["Topstep 1+1 ($3k)", "Topstep 2+2 ($5k)", "Topstep 5+5 ($9k)", f"Lucid 50K add-on 5+5 (${R['L50a']:,.0f})",  # noqa: E731
                    f"Topstep 150K by range (${R['T150n']:,.0f})"]
    V = [("published (ORB off)", g4("T50n", Rp, PS.T150R), nm(Rp)), ("ORB on, its own amounts", g4("T50x", Rn, T150Rx), nm(Rn)),
         ("ORB on, published amounts", g4("T50x", Rp, T150Rx), nm(Rp)),
         (f"ORB switched on at ${Rp['T150n']:,.0f}", g4("T50n", Rp, dict(T150Rx, orb=ORB)), nm(Rp))]
    tab = slow_start(fd, out, Rp, variants=V, name="variants_slow_start.csv")
    old = {r["start_money"]: r for r in csv.DictReader(open(os.path.join(here, "results_plan_v27", "slow_start.csv")))}
    for t in tab:
        if t["variant"] == "published (ORB off)":
            assert (t["ran_out"], t["y4 total median"]) == {1000: (2, 285452), 3000: (3, 366551)}[t["start_money"]], t
        if t["variant"] == "ORB on, its own amounts":
            o = old[str(t["start_money"])]
            assert all(str(t[k]) == o[k] for k in t if k in o), t
    print("run_switch reproduces the published slow start (Nov 25) and results_plan_v27/slow_start.csv", flush=True)


def main(fd, out, parity):
    os.makedirs(out, exist_ok=True)
    X.init(fd, 0.0)   # round 7's per-contract legs on the MNQ file (and it swaps research4's account classes: undone here)
    PS.FundedAccount = FA
    R4.FundedAccount, R4.EvalAccount = FA, ACC.EvalAccount
    legs = X.BOOK if parity else X.BOOK + ("F1",)
    for c in TOPSTEP_ORB:
        PS.CFG[c]["fk"] = dict(PS.CFG[c]["fk"], r7legs=legs)
    if not parity:
        PS.REF_SKIP.update({"T50n", "T150n"})   # their deepest falls change with the ORB leg
    PS.main(fd, "-", out)
    R = json.load(open(os.path.join(out, "reserves.json")))["reserve"]
    slow_start(fd, out, R)


def switch_budget(fd, out):
    """--switch-budget: the $500 / $1,000 starts (plan_search.budget_plans, published amounts) with the ORB leg switched
    on at $25,000, as v2.7.2's Auto does, into OUT_DIR/switch25k/ (budget.csv, budget_runs.csv, budget_monthly_runs.csv
    and, by budget_table.py, budget_view.csv); and the four FINAL variants' step months (variants_final_steps.csv).
    Checks first that run_switch reproduces the published budget runs exactly, and the FINAL variants' summary."""
    import budget_table
    X.init(fd, 0.0)
    PS.FundedAccount = FA
    R4.FundedAccount, R4.EvalAccount = FA, ACC.EvalAccount
    for c in TOPSTEP_ORB:
        PS.CFG[c]["fk"] = dict(PS.CFG[c]["fk"], r7legs=X.BOOK)
    for c, x in (("T50n", "T50x"), ("T150n", "T150x"), ("T50s", "T50sx"), ("T150s", "T150sx")):
        PS.CFG[x] = dict(PS.CFG[c], fk=dict(PS.CFG[c]["fk"], r7legs=ORB))
    S = PS.T.load("fut", fd)
    PS._S["S"] = S
    PS.KINDS[:] = ["futures"]
    here = os.path.dirname(os.path.abspath(__file__))
    Rp = json.load(open(os.path.join(here, "results_plan_search", "reserves.json")))["reserve"]
    lu, up, at = PS.final_at(Rp)
    car = {"car": PS.CAR}
    pubB = PS.budget_plans(Rp)
    swB = []
    for n, lab, st, b in pubB:
        st2 = []
        for thr, act in st:
            if thr == up and "ts" in act:
                big = act["ts"][2].replace("RANGE:T150n:T50n", "RANGE:T150x:T50x").replace("RANGE:T150n:T50s", "RANGE:T150x:T50sx")
                assert big != act["ts"][2], act
                act = {"ts": (act["ts"][0], act["ts"][1], big), "orb": ORB}
            st2.append((thr, act))
        assert st2 != st
        swB.append((n, lab, st2, b))
    ks = PS.starts(S, PS.FUT_FIRST, "2023-11")
    wk = PS.starts(S, PS.FUT_FIRST, "2023-11", every=5)
    strip = lambda r: {k: v for k, v in r.items() if k not in ("series", "when")}  # noqa: E731
    res = {}
    for tag, B in (("pub", pubB), ("sw", swB)):
        jobs = [(n, st, k, b, None) for n, _, st, b in B for k in ks]
        jobs_b = [(n, st, k, b, 24) for n, _, st, b in B for k in wk]
        with get_context("fork").Pool(4, initializer=PS._init, initargs=("fut", fd)) as p:
            rows = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, jobs, chunksize=4)]
            brows = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, jobs_b, chunksize=8)]
        res[tag] = (rows, brows)
        print(tag, "budget runs done", len(rows), len(brows), flush=True)
    ref = list(csv.DictReader(open(os.path.join(here, "results_plan_search", "budget_runs.csv"))))
    mine = res["pub"][1]
    assert len(ref) == len(mine) and all(all(str(m[k]) == r[k] for k in r) for m, r in zip(mine, ref)), "budget parity"
    refm = list(csv.DictReader(open(os.path.join(here, "results_plan_search", "budget_monthly_runs.csv"))))
    assert all(all(str(m[k]) == r[k] for k in r) for m, r in zip(res["pub"][0], refm)) and len(refm) == len(res["pub"][0])
    print("run_switch reproduces the published budget runs, every field of every run", flush=True)
    d = os.path.join(out, "switch25k")
    os.makedirs(d, exist_ok=True)
    rows, brows = res["sw"]
    bsum = PS.summary(rows, swB)
    for row, (n, _, _, b) in zip(bsum, swB):
        Rb = [r for r in brows if r["plan"] == n]
        busts = [float(r["bust_month"]) for r in Rb if r["bust_month"] != ""]
        fp = [float(r["first_payout_month"]) for r in Rb if r["first_payout_month"] != ""]
        fx = [float(r["five_xfa_month"]) for r in Rb if r["five_xfa_month"] != ""]
        row.update({"fut_starts_24m": len(Rb), "fut_ran_out": len(busts), "fut_ran_out_pct": round(100.0 * len(busts) / len(Rb), 1),
                    "fut_ran_out_month_median": round(float(np.median(busts)), 1) if busts else "",
                    "fut_first_payout_24m_median": round(float(np.median(fp)), 1) if fp else "",
                    "fut_no_payout_in_24m": len(Rb) - len(fp), "fut_five_xfa_24m_median": round(float(np.median(fx)), 1) if fx else "",
                    "fut_five_xfa_24m_p90": round(float(np.percentile(fx, 90)), 1) if fx else ""})
    PS.write(d, "budget.csv", bsum)
    PS.write(d, "budget_runs.csv", brows)
    PS.write(d, "budget_monthly_runs.csv", rows)
    budget_table.main(d)
    # the FINAL variants' step months
    Rn = json.load(open(os.path.join(here, "results_plan_v27", "reserves.json")))["reserve"]
    lun, upn, atn = PS.final_at(Rn)
    T5x, T150Rx = {"ts": (5, 10, "T50x")}, {"ts": (5, 10, "RANGE:T150x:T50x")}
    F = [("published (ORB off)", [(None, PS.T5), (lu, PS.LU50), (up, PS.T150R), (at, car)], (lu, up, at)),
         ("ORB on, its own amounts", [(None, T5x), (lun, PS.LU50), (upn, T150Rx), (atn, car)], (lun, upn, atn)),
         ("ORB on, published amounts", [(None, T5x), (lu, PS.LU50), (up, T150Rx), (at, car)], (lu, up, at)),
         (f"ORB switched on at ${up:,.0f}", [(None, PS.T5), (lu, PS.LU50), (up, dict(T150Rx, orb=ORB)), (at, car)], (lu, up, at))]
    jobs = [(n, st, k, None, None) for n, st, _ in F for k in ks]
    with get_context("fork").Pool(4, initializer=PS._init, initargs=("fut", fd)) as p:
        rows = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, jobs, chunksize=4)]
    summ = PS.summary(rows, [(n, n) for n, _, _ in F])
    old = list(csv.DictReader(open(os.path.join(out, "variants_final.csv"))))
    assert all(all(str(s_[k]) == o[k] for k in o) for s_, o in zip(summ, old)), "FINAL variants differ from variants_final.csv"
    steps = []
    for n, _, (a1, a2, a3) in F:
        fin = [r for r in rows if r["plan"] == n]
        for key, lab in (("step1_month", f"Add Lucid 50K (spare cash ${a1:,.0f})"), ("step2_month", f"Topstep 150K by the range rule (${a2:,.0f})"),
                         ("car_month", f"The ${PS.CAR:,.0f} car (${a3:,.0f})")):
            v = [float(r[key]) for r in fin if r[key] != ""]
            steps.append(dict(variant=n, step=lab, starts=len(fin), reached=len(v), p10_month=round(float(np.percentile(v, 10)), 1),
                              median_month=round(float(np.median(v)), 1), p90_month=round(float(np.percentile(v, 90)), 1),
                              latest_month=round(max(v), 1)))
    pubs = list(csv.DictReader(open(os.path.join(here, "results_plan_search", "final_steps.csv"))))
    assert [(s_["step"], str(s_["median_month"]), str(s_["p90_month"]), str(s_["latest_month"])) for s_ in steps[:3]] == \
        [(r["step"], r["median_month"], r["p90_month"], r["latest_month"]) for r in pubs]
    PS.write(out, "variants_final_steps.csv", steps)


SKIP = {"T50n": "T50nk", "T150n": "T150nk", "T50s": "T50sk", "T150s": "T150sk", "L25f": "L25fk", "L25a": "L25ak",
        "L50f": "L50fk", "L50a": "L50ak", "T50x": "T50xk", "T150x": "T150xk", "T50sx": "T50sxk", "T150sx": "T150sxk"}
NO_ON, ORB_K = ("pyr", "ib"), ("F1", "pyr", "ib")


def _rename_steps(steps, ren):
    """The same plan with each account type in REN replaced by its twin (orb and car steps unchanged)."""
    out = []
    for thr, act in steps:
        a2 = {}
        for firm, v in act.items():
            if firm in ("orb", "car"):
                a2[firm] = v
            else:
                N, tot, cfg = v
                if cfg.startswith("RANGE:"):
                    parts = cfg.split(":")
                    cfg = ":".join([parts[0], ren.get(parts[1], parts[1]), ren.get(parts[2], parts[2])] + parts[3:])
                else:
                    cfg = ren.get(cfg, cfg)
                a2[firm] = (N, tot, cfg)
        out.append((thr, a2))
    return out


def _skip_steps(steps):
    """The same plan with the funded overnight trade skipped in every funded account (Lucid and Topstep; evaluations
    and Combines keep it): each account type becomes its skip twin, and the ORB switch flips XFAs to the ORB leg
    without the overnight trade."""
    out = []
    for thr, act in steps:
        a2 = {}
        for firm, v in act.items():
            if firm == "orb":
                a2["orb"] = ORB_K
            elif firm == "car":
                a2["car"] = v
            else:
                N, tot, cfg = v
                if cfg.startswith("RANGE:"):
                    parts = cfg.split(":")
                    cfg = ":".join([parts[0], SKIP[parts[1]], SKIP[parts[2]]] + parts[3:])
                else:
                    cfg = SKIP[cfg]
                a2[firm] = (N, tot, cfg)
        out.append((thr, a2))
    return out


def skip_test(fd, out):
    """--skip (after --variants and --switch-budget): your plan as indicator v2.7.2 runs it (the ORB leg from $25,000)
    with and without the funded overnight trade in every funded account: the full plan (48 monthly starts), the slow
    start (153 starts, $1,000 / $3,000) and the $500 / $1,000 starts (205 starts, 24 months). Writes skip_final.csv,
    skip_slow_start.csv and skip25k/ (budget files and budget_view.csv). Checks that the keep runs reproduce
    variants_final.csv and variants_slow_start.csv, and that the plans with every Lucid account on round 7's class
    (the class the skip twins use) and the book's legs make the published slow start and switch25k exactly."""
    import budget_table
    X.init(fd, 0.0)
    PS.FundedAccount = FA
    R4.FundedAccount, R4.EvalAccount = FA, ACC.EvalAccount
    for c in TOPSTEP_ORB:
        PS.CFG[c]["fk"] = dict(PS.CFG[c]["fk"], r7legs=X.BOOK)
    for c, x in (("T50n", "T50x"), ("T150n", "T150x"), ("T50s", "T50sx"), ("T150s", "T150sx")):
        PS.CFG[x] = dict(PS.CFG[c], fk=dict(PS.CFG[c]["fk"], r7legs=ORB))
    for c, k in SKIP.items():
        legs = ORB_K if c.endswith("x") else NO_ON
        PS.CFG[k] = dict(PS.CFG[c], fk=dict(PS.CFG[c]["fk"], r7legs=legs))
    for c in ("L25f", "L25a", "L50f", "L50a"):          # parity twins: round 7's class with the book's legs
        PS.CFG[c + "p"] = dict(PS.CFG[c], fk=dict(PS.CFG[c]["fk"], r7legs=X.BOOK))
    S = PS.T.load("fut", fd)
    PS._S["S"] = S
    PS.KINDS[:] = ["futures"]
    os.makedirs(out, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    Rp = json.load(open(os.path.join(here, "results_plan_search", "reserves.json")))["reserve"]
    lu, up, at = PS.final_at(Rp)
    car = {"car": PS.CAR}
    T150Rx = {"ts": (5, 10, "RANGE:T150x:T50x")}
    keep_final = [(None, PS.T5), (lu, PS.LU50), (up, dict(T150Rx, orb=ORB)), (at, car)]
    F = [("keep (v2.7.2)", keep_final), ("skip", _skip_steps(keep_final))]
    ks = PS.starts(S, PS.FUT_FIRST, "2023-11")
    strip = lambda r: {k: v for k, v in r.items() if k not in ("series", "when")}  # noqa: E731
    with get_context("fork").Pool(4, initializer=PS._init, initargs=("fut", fd)) as p:
        rows = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, [(n, st, k, None, None) for n, st in F for k in ks], chunksize=4)]
    summ = PS.summary(rows, [(n, n) for n, _ in F])
    ref = {r["plan"]: r for r in csv.DictReader(open(os.path.join(out, "variants_final.csv")))}["ORB switched on at $25,000"]
    assert all(str(summ[0][k]) == ref[k] for k in ref if k not in ("plan", "label")), "keep != variants_final"
    PS.write(out, "skip_final.csv", summ)
    # the slow start
    ts = lambda n, c: {"ts": (n, 2 * n, c)}  # noqa: E731
    g4 = [(None, {"lu": (1, 1, "L25f")}), (3000.0, ts(1, "T50n")), (5000.0, ts(2, "T50n")), (9000.0, ts(5, "T50n")),
          (Rp["L50a"], PS.LU50), (Rp["T150n"], dict(T150Rx, orb=ORB))]
    g4p = [(None, {"lu": (1, 1, "L25fp")}), (3000.0, ts(1, "T50n")), (5000.0, ts(2, "T50n")), (9000.0, ts(5, "T50n")),
           (Rp["L50a"], {"lu": (5, 10, "L50ap")}), (Rp["T150n"], dict(T150Rx, orb=ORB))]
    nm = ["Topstep 1+1 ($3k)", "Topstep 2+2 ($5k)", "Topstep 5+5 ($9k)", "Lucid 50K add-on 5+5 ($11,000)", "Topstep 150K by range ($25,000)"]
    V = [("keep (v2.7.2)", g4, nm), ("skip", _skip_steps(g4), nm), ("parity: Lucid on round 7's class", g4p, nm)]
    tab = slow_start(fd, out, Rp, variants=V, name="skip_slow_start.csv")
    old = {(r["variant"], r["start_money"]): r for r in csv.DictReader(open(os.path.join(out, "variants_slow_start.csv")))}
    for t in tab:
        if t["variant"] != "skip":
            o_ = old[("ORB switched on at $25,000", str(t["start_money"]))]
            assert all(str(t[k]) == o_[k] for k in t if k in o_ and k != "variant"), (t["variant"], t["start_money"])
    print("keep runs reproduce the v2.7.2 plan and slow start; Lucid on round 7's class makes the same slow start", flush=True)
    # the $500 / $1,000 starts
    pubB = PS.budget_plans(Rp)
    keepB = []
    for n, lab, st, b in pubB:
        st2 = []
        for thr, act in st:
            if thr == up and "ts" in act:
                big = act["ts"][2].replace("RANGE:T150n:T50n", "RANGE:T150x:T50x").replace("RANGE:T150n:T50s", "RANGE:T150x:T50sx")
                act = {"ts": (act["ts"][0], act["ts"][1], big), "orb": ORB}
            st2.append((thr, act))
        keepB.append((n, lab, st2, b))
    skipB = [(n, lab, _skip_steps(st), b) for n, lab, st, b in keepB]
    parB = [(n, lab, _rename_steps(st, {c: c + "p" for c in ("L25f", "L25a", "L50f", "L50a")}), b) for n, lab, st, b in keepB]
    assert all(pb[2] != kb[2] for pb, kb in zip(parB, keepB))      # every budget plan has a Lucid step
    wk = PS.starts(S, PS.FUT_FIRST, "2023-11", every=5)
    with get_context("fork").Pool(4, initializer=PS._init, initargs=("fut", fd)) as p:
        prow = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, [(n, st, k, b, None) for n, _, st, b in parB for k in ks], chunksize=4)]
        pbrow = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, [(n, st, k, b, 24) for n, _, st, b in parB for k in wk], chunksize=8)]
        rows = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, [(n, st, k, b, None) for n, _, st, b in skipB for k in ks], chunksize=4)]
        brows = [dict(data="futures", **strip(r)) for r in p.map(PS.run_switch, [(n, st, k, b, 24) for n, _, st, b in skipB for k in wk], chunksize=8)]
    for mine, f in ((pbrow, "budget_runs.csv"), (prow, "budget_monthly_runs.csv")):
        ref = list(csv.DictReader(open(os.path.join(out, "switch25k", f))))
        assert len(ref) == len(mine) and all(all(str(m[k]) == r[k] for k in r) for m, r in zip(mine, ref)), ("switch25k parity", f)
    print("the $500 / $1,000 keep runs with every Lucid account on round 7's class reproduce switch25k, every field of every run", flush=True)
    d = os.path.join(out, "skip25k")
    os.makedirs(d, exist_ok=True)
    bsum = PS.summary(rows, skipB)
    for row, (n, _, _, b) in zip(bsum, skipB):
        Rb = [r for r in brows if r["plan"] == n]
        busts = [float(r["bust_month"]) for r in Rb if r["bust_month"] != ""]
        fp = [float(r["first_payout_month"]) for r in Rb if r["first_payout_month"] != ""]
        fx = [float(r["five_xfa_month"]) for r in Rb if r["five_xfa_month"] != ""]
        row.update({"fut_starts_24m": len(Rb), "fut_ran_out": len(busts), "fut_ran_out_pct": round(100.0 * len(busts) / len(Rb), 1),
                    "fut_ran_out_month_median": round(float(np.median(busts)), 1) if busts else "",
                    "fut_first_payout_24m_median": round(float(np.median(fp)), 1) if fp else "",
                    "fut_no_payout_in_24m": len(Rb) - len(fp), "fut_five_xfa_24m_median": round(float(np.median(fx)), 1) if fx else "",
                    "fut_five_xfa_24m_p90": round(float(np.percentile(fx, 90)), 1) if fx else ""})
    PS.write(d, "budget.csv", bsum)
    PS.write(d, "budget_runs.csv", brows)
    PS.write(d, "budget_monthly_runs.csv", rows)
    budget_table.main(d)


if __name__ == "__main__":
    if "--variants" in sys.argv:
        variants(sys.argv[1], sys.argv[2])
    elif "--switch-budget" in sys.argv:
        switch_budget(sys.argv[1], sys.argv[2])
    elif "--skip" in sys.argv:
        skip_test(sys.argv[1], sys.argv[2])
    else:
        main(sys.argv[1], sys.argv[2], "--parity" in sys.argv)
