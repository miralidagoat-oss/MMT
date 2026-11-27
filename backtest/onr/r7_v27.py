#!/usr/bin/env python3
"""The figures behind indicator v2.7's 5-minute ORB leg (round 7's F1: the first 5 minutes' direction when that move is
at least 0.05 ADR, entry at 09:35, stop 0.10 ADR, target 1 ADR, exit 16:00; a funded leg after the 09:35 pyramid).

usage: python3 -I r7_v27.py DATA_DIR OUT_DIR

1. Topstep 25K (Labs Static, topstep25k.py's plan) and 50K / 100K / 150K (5 XFAs + 5 Combines, Standard payouts, No
   Activation Fee path), book vs book + F1, 12 start dates; last 5 years, Dec 2019 - Nov 2021 and 2023-26, at 0 and
   1 tick; rule 5Y with the 8 placebo runs of r7_accounts.py as noise bands. At 50K this repeats r7_accounts.py's
   pre-registered test; the other sizes were run after it, so they are descriptive. With the book's legs alone every
   size reproduces the published figures (asserted for 25K / 50K / 100K / 150K).
2. The live alarm bands for an account running the ORB leg: one 50K funded account every session from Nov 15 2021
   ($1,200 day budget, round(700 / ADR) MNQ, at most 20), 20,000 block-bootstrap paths of 10 sessions (seed 2026), as
   report50k.py builds the published bands; with the book's legs alone this reproduces those bands exactly (asserted).
Writes OUT_DIR/v27_topstep_sizes.csv and OUT_DIR/v27_alarm_bands.csv.
"""
import csv
import os
import sys
from multiprocessing import get_context

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r7_accounts as X  # noqa: E402
import research4 as R4  # noqa: E402
import topstep25k as L  # noqa: E402
import topstep_sim as T  # noqa: E402
from account import funded_size, is_half  # noqa: E402
from engine import PV  # noqa: E402

VS = ["book", "+F1"] + [v for v in X.VARIANTS if v.startswith("placebo")]
SIZES = (25, 50, 100, 150)
PUBLISHED = {25: 32201, 50: 73075, 100: 122070, 150: 136013}   # the book, last 5 years (results_topstep*, rounded)
BANDS_PUBLISHED = [[20, 1549.0, -3126.0, -5063.0], [40, 3195.0, -3569.0, -6261.0], [60, 4861.0, -3574.0, -6766.0],
                   [120, 9878.0, -1969.0, -6853.0], [250, 20920.0, 3295.0, -3622.0]]   # results_nqfut_5y_addon_fee8820


def job(a):
    v, size, w, off, slip = a
    S = X.G["D"].S
    var = X.VARIANTS[v]
    if size == 25:
        ek, fk = dict(L.ek(), slip=slip), dict(L.fk("standard"), slip=slip)
    else:
        ek, fk = dict(T.ek(size), slip=slip), dict(T.fk(size, "standard"), slip=slip)
    if "thr" in var:
        ek["thr"] = fk["thr"] = var["thr"]
    if "adr_ref" in var:
        fk["adr_ref"] = var["adr_ref"]
    fk["r7legs"] = var.get("legs", X.BOOK)
    ek["r7trigger"] = None
    k0 = X.start_k(S, w, off)
    if size == 25:
        ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk, gate=L.month_gate(S, L.PER_MONTH))
        cash = T.cash_flows(S, k0, ev, "standard", 50, fee_per_buy=L.PRICE)
    else:
        ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
        cash = T.cash_flows(S, k0, ev, "noact", size)
    per, fy = X.WINDOWS[w]
    res = T.summarise_run(S, k0, cash, ev, per, fy)["periods"]
    return a, {lab: (res[lab]["M"], res[lab]["W"]) for lab, _, _ in per}


def accounts(dd):
    t = {}
    for slip in (0.0, 0.25):
        X.init(dd, slip)
        vs = VS if slip == 0.0 else ["book", "+F1"]
        jobs = [(v, s, w, o, slip) for v in vs for s in SIZES for w in X.WINDOWS for o in R4.OFFSETS]
        agg = {}
        with get_context("fork").Pool(4) as p:
            for a, per in p.map(job, jobs, chunksize=4):
                for lab, mw in per.items():
                    agg.setdefault((a[0], a[1], lab, slip), []).append(mw)
        t.update({k: (float(np.mean([x[0] for x in xs])), float(np.mean([x[1] for x in xs]))) for k, xs in agg.items()})
    rows = []
    plac = [v for v in VS if v.startswith("placebo")]
    for s in SIZES:
        assert round(t[("book", s, "last 5y", 0.0)][0]) == PUBLISHED[s], (s, t[("book", s, "last 5y", 0.0)])
        band = lambda lab, q: max(abs(t[(p, s, lab, 0.0)][q] - t[("book", s, lab, 0.0)][q]) for p in plac)
        b5, x5 = t[("book", s, "last 5y", 0.0)], t[("+F1", s, "last 5y", 0.0)]
        be, xe = t[("book", s, "early", 0.0)], t[("+F1", s, "early", 0.0)]
        dM, dW, dMe, dWe = x5[0] - b5[0], x5[1] - b5[1], xe[0] - be[0], xe[1] - be[1]
        bM, bW, bMe, bWe = band("last 5y", 0), band("last 5y", 1), band("early", 0), band("early", 1)
        ok = ((dM > bM and dW > -bW) or (dW > bW and dM > -bM)) and dMe > -bMe and dWe > -bWe
        r = dict(size=f"{s}K", book_5y=round(b5[0]), orb_5y=round(x5[0]), change_5y=round(dM), band_5y=round(bM),
                 book_worst_year=round(b5[1]), orb_worst_year=round(x5[1]), change_worst=round(dW), band_worst=round(bW),
                 change_early=round(dMe), band_early=round(bMe), change_worst_early=round(dWe), band_worst_early=round(bWe),
                 rule_5y="PASS" if ok else "fail",
                 book_2023_26=round(t[("book", s, "oos", 0.0)][0]), orb_2023_26=round(t[("+F1", s, "oos", 0.0)][0]),
                 book_5y_1tick=round(t[("book", s, "last 5y", 0.25)][0]), orb_5y_1tick=round(t[("+F1", s, "last 5y", 0.25)][0]),
                 book_2023_26_1tick=round(t[("book", s, "oos", 0.25)][0]), orb_2023_26_1tick=round(t[("+F1", s, "oos", 0.25)][0]),
                 book_worst_year_1tick=round(t[("book", s, "last 5y", 0.25)][1]), orb_worst_year_1tick=round(t[("+F1", s, "last 5y", 0.25)][1]))
        rows.append(r)
        print(r, flush=True)
    return rows


def daily_one_account(legs):
    """One 50K funded account every session from Nov 15 2021 (report50k.py's continuous book), legs in entry order."""
    S = X.G["D"].S
    k0 = int(np.searchsorted(S.days, np.datetime64("2021-11-15").astype(int)))
    out = []
    for d in S.days[k0:]:
        d = int(d)
        lg = X.G["legs"].get(d)
        adr = S.S[d]["adr"] if d in S.S else np.nan
        if lg is None or np.isnan(adr):
            out.append(0.0)
            continue
        n = funded_size(adr, 700.0, nmax=20)
        room, used, day = 1200.0, 0.0, 0.0
        half = is_half(d)
        sd = S.on_side(d)
        if "on" in legs and sd != 0 and used + 0.5 * adr * PV * n <= room:
            day += n * lg["on"][sd]
            used += 0.5 * adr * PV * n
        items = []
        if "pyr" in legs and not half and lg["pyr"] is not None:
            items.append(lg["pyr"])
        if "ib" in legs and not half and lg["ib"] is not None:
            items.append(lg["ib"])
        if "F1" in legs and not half:
            items += lg["F1"]
        items.sort(key=lambda x: x[0])
        taken = []
        for key, nm, side, rk1, p1, xk in items:
            if used + rk1 * n > room or any(ts != side and tk <= key < tx for tk, ts, tx in taken):
                continue
            day += n * p1
            used += rk1 * n
            taken.append((key, side, xk))
        out.append(day)
    return np.array(out)


def bands(daily):
    rng = np.random.default_rng(2026)
    nb = 25
    starts_b = rng.integers(0, len(daily) - 10, size=(20000, nb))
    paths_b = daily[(starts_b[:, :, None] + np.arange(10)).reshape(20000, -1)]
    cumb = np.cumsum(paths_b, axis=1)
    return [[dn, round(float(np.median(cumb[:, dn - 1])), 0), round(float(np.percentile(cumb[:, dn - 1], 5)), 0),
             round(float(np.percentile(cumb[:, dn - 1], 1)), 0)] for dn in (20, 40, 60, 120, 250)]


if __name__ == "__main__":
    dd, out = sys.argv[1], sys.argv[2]
    X.init(dd, 0.0)
    assert bands(daily_one_account(X.BOOK)) == BANDS_PUBLISHED
    orb = bands(daily_one_account(X.BOOK + ("F1",)))
    with open(os.path.join(out, "v27_alarm_bands.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["trading_days", "median_usd", "p5_yellow_usd", "p1_red_usd"])
        w.writerows(orb)
    print("alarm bands with the ORB leg:", orb, flush=True)
    rows = accounts(dd)
    with open(os.path.join(out, "v27_topstep_sizes.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print("written", flush=True)
