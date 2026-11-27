#!/usr/bin/env python3
"""The proposal's third variant (Nov 27 2026): keep the funded overnight trade, but charge the day budget only its
actual loss once it closes at 09:30 (nothing for a win), instead of reserving its 0.5 ADR risk for the whole day.

usage: python3 -I check_actual_loss.py MNQ_DATA_DIR CFD_DATA_DIR OUT_DIR

The variant's step() is account.FundedAccount.step with that one line changed (built from its source, so nothing else
can differ); with the change off it is asserted to make exactly the published class's events. Compared with the book
and with no overnight trade: Topstep 50K 5 XFAs + 5 Combines (MNQ last 5 years and Dec 2019 - Nov 2021, 12 start
dates) and funded accounts alone (share reaching a payout; NQ CFD 2016-2020, MNQ 2021-2026), as check_proposals.py.
Writes OUT_DIR/proposals_actual_loss.json.
"""
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
import check_proposals as CP  # noqa: E402
import research4 as R4  # noqa: E402
import topstep_sim as T  # noqa: E402

src = textwrap.dedent(inspect.getsource(ACC.FundedAccount.step))
pat = r"(p, _ = funded_on\(S, d, side, self\.slip, self\.on_stop, n=n, comm=self\.comm\)\n(\s+)day \+= p\n\s+)used \+= rk\n"
assert len(re.findall(pat, src)) == 1
src = re.sub(pat, lambda m: m.group(1) + "used += (max(0.0, -p) if self.actual_loss else rk)\n", src)
ns = {}
exec(compile(src, "<FundedAccount.step, actual-loss variant>", "exec"), vars(ACC), ns)


class FundedActual(ACC.FundedAccount):
    def __init__(self, S, actual_loss=True, **kw):
        super().__init__(S, **kw)
        self.actual_loss = actual_loss


FundedActual.step = ns["step"]
G = CP.G


def pool_events(S, k0, cls, **extra):
    R4.FundedAccount = cls
    try:
        ek, fk = T.ek(50), dict(T.fk(50, "standard"), **extra)
        return R4.sim_pool(S, 5, 10, k0, len(S.days), ek, fk)
    finally:
        R4.FundedAccount = ACC.FundedAccount


def pool_job(a):
    variant, k0, tag = a
    S = G["mnq"]
    if variant == "book":
        ev = pool_events(S, k0, ACC.FundedAccount)
    elif variant == "no overnight":
        ev = pool_events(S, k0, ACC.FundedAccount, legs=("pyr", "ib"))
    else:
        ev = pool_events(S, k0, FundedActual, actual_loss=True)
    cash = T.cash_flows(S, k0, ev, "noact", 50)
    per, fy = ([("last 5y", CP.W.START5, "2026-12-31")], {"last 5y": CP.W.FULL_YEARS_5Y}) if tag == "5y" else \
        ([("early", "2019-01-01", "2021-11-14")], {"early": ["2020"]})
    res = T.summarise_run(S, k0, cash, ev, per, fy)
    f = res["funded"]
    lab = per[0][0]
    return a, (res["periods"][lab]["M"], res["periods"][lab]["W"], f["with_payout"] / f["started"])


def alone_job(a):
    src, variant, k0, kb = a
    S = G[src]
    base = CP.FK["topstep50"](CP.BOOK)
    acc = FundedActual(S, actual_loss=True, **base) if variant == "actual loss" else \
        ACC.FundedAccount(S, **(base if variant == "book" else CP.FK["topstep50"](CP.NO_ON)))
    npay = 0
    for k in range(k0, kb):
        evn, amt = acc.step(S.days[k])
        if amt > 0:
            npay += 1
        if evn is not None:
            break
    return a, npay


def main(dd_mnq, dd_cfd, out):
    G["mnq"] = T.load("fut", dd_mnq)
    G["cfd"] = T.load("cfd", dd_cfd)
    S = G["mnq"]
    # parity: the variant class with the change off = the published class, event for event
    for off in (0, 25):
        k0 = T.start_k(S, "5y", off)
        a = pool_events(S, k0, ACC.FundedAccount)
        b = pool_events(S, k0, FundedActual, actual_loss=False)
        assert len(a) == len(b) and all(x[:3] == y[:3] and abs(x[3] - y[3]) < 1e-9 for x, y in zip(a, b))
    print("parity: the variant with its change off makes the published class's events", flush=True)
    variants = ("book", "no overnight", "actual loss")
    jobs = [(v, T.start_k(S, tag, o), tag) for v in variants for tag in ("5y", "all") for o in R4.OFFSETS]
    jobs = [(v, k0, "5y" if tag == "5y" else "early") for v, k0, tag in jobs]
    with get_context("fork").Pool(4) as p:
        got = p.map(pool_job, jobs, chunksize=2)
    agg = {}
    for (v, k0, tag), x in got:
        agg.setdefault((v, tag), []).append(x)
    res = {"pool_topstep50": {f"{tag} | {v}": dict(net_per_year=round(float(np.mean([x[0] for x in xs]))),
                                                   worst_full_year=round(float(np.mean([x[1] for x in xs]))),
                                                   xfa_share_with_payout_pct=round(100 * float(np.mean([x[2] for x in xs])), 1))
                               for (v, tag), xs in agg.items()}}
    assert res["pool_topstep50"]["5y | book"]["net_per_year"] == 73075
    jobs = []
    for src, a, b in (("cfd", "2016-01-01", "2020-12-31"), ("mnq", "2021-01-01", "2026-11-20")):
        Ss = G[src]
        ka = max(CP.kix(Ss, a), T.first_tradable(Ss))
        kb = int(np.searchsorted(Ss.days, np.datetime64(b).astype(int), "right"))
        jobs += [(src, v, k0, kb) for v in variants for k0 in range(ka, kb - 126, 5)]
    with get_context("fork").Pool(4) as p:
        got = p.map(alone_job, jobs, chunksize=8)
    agg = {}
    for (src, v, k0, kb), npay in got:
        agg.setdefault((src, v), []).append(npay)
    res["funded_alone_topstep50"] = {f"{src} | {v}": dict(accounts=len(n), reach_payout_pct=round(100 * float((np.array(n) > 0).mean()), 1),
                                                         payouts_per_account=round(float(np.mean(n)), 2))
                                     for (src, v), n in agg.items()}
    conv = lambda o: o.item() if hasattr(o, "item") else str(o)
    print(json.dumps(res, indent=1, default=conv), flush=True)
    json.dump(res, open(os.path.join(out, "proposals_actual_loss.json"), "w"), indent=1, default=conv)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
