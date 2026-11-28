#!/usr/bin/env python3
"""Round 8 (PREREG_R8.md): AL, the overnight trade's charge to the day budget becomes its actual loss once it closes.

usage: python3 -I r8_actual_loss.py MNQ_DATA_DIR CFD_DATA_DIR OUT_DIR

Decision data: the MNQ file on round 7's account harness. A1 Topstep 50K and A2 Topstep 150K with the ORB leg, A3
Lucid 50K add-on and A4 Lucid 50K 40% without it; 12 start dates; last 5 years, Dec 2019 - Nov 2021, 2023-26; 0 and 1
tick of slippage. Rule 5Y with round 7's bands.
Holdout: the Nasdaq-100 CFD, Feb 2011 - Dec 2019, A1 and A3 without the ORB leg, on the published account classes, with
8 placebo runs as noise bands (no-harm test).
AL is the round-7 class's and the published class's step() with one line changed (built from their source); with AL
off each is asserted to make exactly its counterpart's events, and the baselines must reproduce the published figures.
Writes OUT_DIR/r8_accounts.csv, OUT_DIR/r8_holdout.csv and OUT_DIR/r8_decision.json.
"""
import csv
import inspect
import json
import os
import re
import sys
import textwrap
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account as ACC  # noqa: E402
import check_actual_loss as CAL  # noqa: E402
import r7_accounts as X  # noqa: E402
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402
from account import USER_ADDON, USER_EVAL  # noqa: E402

# ---- the round-7 class with AL (one line of its step() changed)
_src = textwrap.dedent(inspect.getsource(X.Funded7.step))
_pat = r"(day \+= n \* lg\[\"on\"\]\[side\]\n\s+)used \+= rk\n"
assert len(re.findall(_pat, _src)) == 1
_src = re.sub(_pat, lambda m: m.group(1) + "used += (max(0.0, -n * lg[\"on\"][side]) if self.al else rk)\n", _src)
_ns = {}
exec(compile(_src, "<Funded7.step, AL>", "exec"), vars(X), _ns)


class Funded8(X.Funded7):
    def __init__(self, S, al=True, **kw):
        super().__init__(S, **kw)
        self.al = al


Funded8.step = _ns["step"]

ACCTS = {   # name: (ek, fk, legs, cash flows)
    "A1 Topstep 50K + ORB": (lambda: T.ek(50), lambda: T.fk(50, "standard"), X.BOOK + ("F1",), ("noact", 50, None)),
    "A2 Topstep 150K + ORB": (lambda: T.ek(150), lambda: T.fk(150, "standard"), X.BOOK + ("F1",), ("noact", 150, None)),
    "A3 Lucid 50K add-on": (lambda: dict(R4.E_KW, cons=0.5), lambda: dict(R4.F_KW, max_pay=4), X.BOOK,
                            ("standard", 50, USER_EVAL[50] + USER_ADDON)),
    "A4 Lucid 50K 40%": (lambda: dict(R4.E_KW), lambda: dict(R4.F_KW, max_pay=4), X.BOOK, ("standard", 50, USER_EVAL[50])),
}
PUBLISHED = {"A1 Topstep 50K + ORB": 90515, "A2 Topstep 150K + ORB": 185383, "A3 Lucid 50K add-on": 58262,
             "A4 Lucid 50K 40%": 55669}
G = X.G


def mnq_events(acct, al, k0, slip):
    ekf, fkf, legs, _ = ACCTS[acct]
    ek, fk = dict(ekf(), slip=slip), dict(fkf(), slip=slip, r7legs=legs)
    R4.FundedAccount = lambda S, **kw: Funded8(S, al=al, **kw)
    R4.EvalAccount = ACC.EvalAccount
    return R4.sim_pool(G["D"].S, 5, 10, k0, len(G["D"].S.days), ek, fk)


def mnq_job(a):
    acct, al, win, off, slip = a
    S = G["D"].S
    k0 = X.start_k(S, win, off)
    ev = mnq_events(acct, al, k0, slip)
    path, size, fee = ACCTS[acct][3]
    cash = T.cash_flows(S, k0, ev, path, size) if fee is None else T.cash_flows(S, k0, ev, path, size, fee_per_buy=fee)
    per, fy = X.WINDOWS[win]
    res = T.summarise_run(S, k0, cash, ev, per, fy)["periods"]
    return a, {lab: (res[lab]["M"], res[lab]["W"]) for lab, _, _ in per}


def cfd_job(a):
    acct, variant, off = a
    S = G["cfd"]
    ekf, fkf, _, (path, size, fee) = ACCTS[acct]
    ek, fk = ekf(), fkf()
    if variant.startswith("thr "):
        ek["thr"] = fk["thr"] = float(variant[4:])
    elif variant.startswith("size "):
        fk["adr_ref"] = float(variant[5:])
    R4.EvalAccount = ACC.EvalAccount
    R4.FundedAccount = (lambda S_, **kw: CAL.FundedActual(S_, actual_loss=True, **kw)) if variant == "AL" else ACC.FundedAccount
    k0 = T.start_k(S, "all", off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
    cash = T.cash_flows(S, k0, ev, path, size) if fee is None else T.cash_flows(S, k0, ev, path, size, fee_per_buy=fee)
    per, fy = [("2011-19", "2011-01-01", "2019-12-31")], {"2011-19": [str(y) for y in range(2012, 2020)]}
    r = T.summarise_run(S, k0, cash, ev, per, fy)["periods"]["2011-19"]
    return a, (r["M"], r["W"])


def bands_r7():
    pub = {(r["variant"], r["account"]): r for r in csv.DictReader(open(os.path.join(OUT, "accounts.csv")))}
    s150 = {r["size"]: r for r in csv.DictReader(open(os.path.join(OUT, "v27_topstep_sizes.csv")))}["150K"]
    pick = lambda r: tuple(float(r[k]) for k in ("band_5y", "band_worst", "band_early", "band_worst_early"))
    return {"A1 Topstep 50K + ORB": pick(pub[("book", "topstep")]), "A2 Topstep 150K + ORB": pick(s150),
            "A3 Lucid 50K add-on": pick(pub[("book", "lucid_addon")]), "A4 Lucid 50K 40%": pick(pub[("book", "lucid40")])}


def main(dd_mnq, dd_cfd):
    t = {}
    for slip in (0.0, 0.25):
        X.init(dd_mnq, slip)
        if slip == 0.0:   # parity: AL off = the round-7 class, event for event
            S = G["D"].S
            for acct in ACCTS:
                k0 = X.start_k(S, "5y", 0)
                a = mnq_events(acct, False, k0, 0.0)
                ekf, fkf, legs, _ = ACCTS[acct]
                R4.FundedAccount, R4.EvalAccount = X.Funded7, ACC.EvalAccount
                b = R4.sim_pool(S, 5, 10, k0, len(S.days), dict(ekf(), slip=0.0), dict(fkf(), slip=0.0, r7legs=legs))
                assert len(a) == len(b) and all(x[:3] == y[:3] and abs(x[3] - y[3]) < 1e-9 for x, y in zip(a, b)), acct
            print("parity: AL off makes the round-7 class's events in all four accounts", flush=True)
        jobs = [(acct, al, win, off, slip) for acct in ACCTS for al in (False, True) for win in X.WINDOWS for off in R4.OFFSETS]
        with get_context("fork").Pool(4) as p:
            for (acct, al, win, off, s), per in p.map(mnq_job, jobs, chunksize=4):
                for lab, mw in per.items():
                    t.setdefault((acct, al, lab, s), []).append(mw)
    t = {k: (float(np.mean([x[0] for x in v])), float(np.mean([x[1] for x in v]))) for k, v in t.items()}
    for acct, pub in PUBLISHED.items():
        assert round(t[(acct, False, "last 5y", 0.0)][0]) == pub, (acct, t[(acct, False, "last 5y", 0.0)])
    bands = bands_r7()
    rows, verdict = [], {}
    for acct in ACCTS:
        bM, bW, bMe, bWe = bands[acct]
        b5, x5 = t[(acct, False, "last 5y", 0.0)], t[(acct, True, "last 5y", 0.0)]
        be, xe = t[(acct, False, "early", 0.0)], t[(acct, True, "early", 0.0)]
        dM, dW, dMe, dWe = x5[0] - b5[0], x5[1] - b5[1], xe[0] - be[0], xe[1] - be[1]
        ok = ((dM > bM and dW > -bW) or (dW > bW and dM > -bM)) and dMe > -bMe and dWe > -bWe
        verdict[acct] = "PASS" if ok else "fail"
        rows.append(dict(account=acct, book_5y=round(b5[0]), al_5y=round(x5[0]), change_5y=round(dM), band_5y=round(bM),
                         book_worst=round(b5[1]), al_worst=round(x5[1]), change_worst=round(dW), band_worst=round(bW),
                         book_early=round(be[0]), al_early=round(xe[0]), change_early=round(dMe), band_early=round(bMe),
                         change_worst_early=round(dWe), band_worst_early=round(bWe),
                         book_2023_26=round(t[(acct, False, "oos", 0.0)][0]), al_2023_26=round(t[(acct, True, "oos", 0.0)][0]),
                         book_5y_1tick=round(t[(acct, False, "last 5y", 0.25)][0]), al_5y_1tick=round(t[(acct, True, "last 5y", 0.25)][0]),
                         book_2023_26_1tick=round(t[(acct, False, "oos", 0.25)][0]), al_2023_26_1tick=round(t[(acct, True, "oos", 0.25)][0]),
                         rule_5y=verdict[acct]))
        print(rows[-1], flush=True)
    with open(os.path.join(OUT, "r8_accounts.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    # ---- holdout: the Nasdaq-100 CFD, Feb 2011 - Dec 2019
    G["cfd"] = T.load("cfd", dd_cfd)
    S = G["cfd"]
    k0 = T.start_k(S, "all", 0)
    R4.EvalAccount = ACC.EvalAccount
    for acct in ("A1 Topstep 50K + ORB", "A3 Lucid 50K add-on"):
        ekf, fkf, _, _ = ACCTS[acct]
        R4.FundedAccount = ACC.FundedAccount
        a = R4.sim_pool(S, 5, 10, k0, len(S.days), ekf(), fkf())
        R4.FundedAccount = lambda S_, **kw: CAL.FundedActual(S_, actual_loss=False, **kw)
        b = R4.sim_pool(S, 5, 10, k0, len(S.days), ekf(), fkf())
        assert len(a) == len(b) and all(x[:3] == y[:3] and abs(x[3] - y[3]) < 1e-9 for x, y in zip(a, b)), acct
    print("parity: AL off makes the published class's events on the CFD", flush=True)
    variants = ["book", "AL"] + [f"thr {x}" for x in (0.712, 0.715, 0.722, 0.725)] + [f"size {x}" for x in (340, 345, 355, 360)]
    jobs = [(acct, v, off) for acct in ("A1 Topstep 50K + ORB", "A3 Lucid 50K add-on") for v in variants for off in R4.OFFSETS]
    h = {}
    with get_context("fork").Pool(4) as p:
        for (acct, v, off), mw in p.map(cfd_job, jobs, chunksize=4):
            h.setdefault((acct, v), []).append(mw)
    h = {k: (float(np.mean([x[0] for x in v])), float(np.mean([x[1] for x in v]))) for k, v in h.items()}
    hrows = []
    for acct in ("A1 Topstep 50K + ORB", "A3 Lucid 50K add-on"):
        b, x = h[(acct, "book")], h[(acct, "AL")]
        plac = [v for v in variants if v not in ("book", "AL")]
        bM = max(abs(h[(acct, v)][0] - b[0]) for v in plac)
        bW = max(abs(h[(acct, v)][1] - b[1]) for v in plac)
        ok = (x[0] - b[0] > -bM) and (x[1] - b[1] > -bW)
        name = acct.replace(" + ORB", " (no ORB on the CFD)")
        verdict[f"holdout {acct}"] = "PASS" if ok else "fail"
        hrows.append(dict(account=name, book_2011_19=round(b[0]), al_2011_19=round(x[0]), change=round(x[0] - b[0]), band=round(bM),
                          book_worst=round(b[1]), al_worst=round(x[1]), change_worst=round(x[1] - b[1]), band_worst=round(bW),
                          no_harm="PASS" if ok else "fail"))
        print(hrows[-1], flush=True)
    with open(os.path.join(OUT, "r8_holdout.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(hrows[0]))
        w.writeheader()
        w.writerows(hrows)
    adopt = all(verdict[a] == "PASS" for a in ("A1 Topstep 50K + ORB", "A2 Topstep 150K + ORB", "A3 Lucid 50K add-on")) and \
        all(verdict[f"holdout {a}"] == "PASS" for a in ("A1 Topstep 50K + ORB", "A3 Lucid 50K add-on"))
    json.dump(dict(verdict=verdict, adopt=adopt), open(os.path.join(OUT, "r8_decision.json"), "w"), indent=1)
    print("verdicts:", verdict, "| adopt AL:", adopt, flush=True)


if __name__ == "__main__":
    OUT = sys.argv[3]
    main(sys.argv[1], sys.argv[2])
