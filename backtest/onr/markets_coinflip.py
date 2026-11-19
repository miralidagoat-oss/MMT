#!/usr/bin/env python3
"""No-skill baseline for markets50k.py: the same book on each market with coin-flip directions.

usage (ONR_EVAL_FEE_50K=80.50): markets_coinflip.py DATA_DIR R5_DATA_DIR OUT_DIR [SEEDS, default 30]
Every trade keeps its day, time, stop, size and exits; only its direction is a coin flip: the overnight trade's side
and the 09:35 drive's side (which the pyramid takes and the IB order follows) are each multiplied by a random +1/-1
per session, fixed by the seed. Days with no signal stay without a trade, and the IB order on a day with no drive is
still the two-sided OCO. Evals and funded accounts use the flipped sides alike.
The payout rules alone pay something even with no edge: an eval costs at most its fee while a lucky funded run is paid
out. What a market's real book makes above this baseline is what its signals add.
Writes markets_coinflip.csv (per market and period: actual, coin-flip mean and range over the seeds, and how many
coin-flip runs made at least as much as the actual book).
"""
import copy
import csv
import os
import sys
from multiprocessing import Pool as MP

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402
import markets50k as MK  # noqa: E402
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402

BASES = [("nq", "nq", {}, {}), ("spx", "spx", {}, {}), ("crude", "crude", MK.MOM_E, MK.MOM_F), ("gold", "gold", MK.MOM_E, MK.MOM_F)]
SEEDS = None


def flipped(S, seed):
    """A shallow copy of Sessions S whose on_side / od_side directions are coin flips (one per session per signal)."""
    C = copy.copy(S)
    rng = np.random.default_rng(seed)
    f_on = dict(zip(S.days.tolist(), rng.choice([-1, 1], len(S.days)).tolist()))
    f_od = dict(zip(S.days.tolist(), rng.choice([-1, 1], len(S.days)).tolist()))
    on, od = S.on_side, S.od_side
    C.on_side = lambda d, thr=engine.THR: on(d, thr) * f_on[int(d)]
    C.od_side = lambda d, k=0.10: od(d, k) * f_od[int(d)]
    return C


def _init(dd, rd, seeds):
    MK._init(dd, rd)
    for _, mk, _, _ in BASES:
        for s in seeds:
            key = f"{mk}#{s}"
            R5._S[key] = flipped(R5._S[mk], 1000 * (1 + ["nq", "spx", "crude", "gold"].index(mk)) + s)
            R5.TICK[key] = R5.TICK[mk]


def main(dd, rd, out, nseeds=30):
    seeds = list(range(1, nseeds + 1))
    _init(dd, rd, seeds)
    # the flip must change sides and nothing else: same signal days, opposite side on about half of them
    S, C = R5._S["nq"], R5._S["nq#1"]
    same = [S.od_side(d) == C.od_side(d) for d in S.days if S.od_side(d) != 0]
    assert all((S.od_side(d) == 0) == (C.od_side(d) == 0) for d in S.days) and 0.4 < np.mean(same) < 0.6, np.mean(same)
    print(f"check passed: coin flips keep every signal day and reverse {100 * (1 - np.mean(same)):.1f}% of NQ's drive sides", flush=True)
    jobs = []
    for cid, mk, ek, fk in BASES:
        for s in seeds:
            parts = R5.nq(key=f"{mk}#{s}", ek=ek, fk=fk)
            jobs += [(f"{cid}#{s}", [parts], w, o) for w in ("all", "5y") for o in R4.OFFSETS]
    with MP(4, initializer=_init, initargs=(dd, rd, seeds)) as mp:
        res = dict(mp.map(R5._job, jobs, chunksize=2))
    actual = {r["id"]: r for r in csv.DictReader(open(os.path.join(out, "markets_summary.csv")))}
    rows = []
    for cid, mk, _, _ in BASES:
        for lab, w, a_key, w_key in (("last 5 years", "5y", "net_per_year_5y_usd", "worst_full_year_5y_usd"),
                                     ("2011-21", "all", "net_per_year_2011_21_usd", "worst_full_year_2011_21_usd")):
            per = "last 5y" if w == "5y" else "2011-21"
            M = [float(np.mean([res[(f"{cid}#{s}", w, o)]["periods"][per]["M"] for o in R4.OFFSETS])) for s in seeds]
            W = [float(np.mean([res[(f"{cid}#{s}", w, o)]["periods"][per]["W"] for o in R4.OFFSETS])) for s in seeds]
            act_m, act_w = float(actual[cid][a_key]), float(actual[cid][w_key])
            rows.append([cid, MK.NAME[mk], lab, round(act_m), round(float(np.mean(M))), round(min(M)), round(max(M)),
                         round(act_m - float(np.mean(M))), round(act_w), round(float(np.mean(W))), len(seeds),
                         sum(m >= act_m for m in M)])
            print(f"  {MK.NAME[mk]:16s} {lab:12s} actual ${act_m:>8,.0f}/yr | coin flips ${np.mean(M):>8,.0f} "
                  f"(${min(M):,.0f} to ${max(M):,.0f}) | signals add ${act_m - np.mean(M):>+8,.0f} | "
                  f"{sum(m >= act_m for m in M)} of {len(seeds)} runs as good", flush=True)
    with open(os.path.join(out, "markets_coinflip.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "market", "period", "actual_net_per_year_usd", "coinflip_net_per_year_usd", "coinflip_lowest_usd",
                    "coinflip_highest_usd", "signals_add_usd", "actual_worst_full_year_usd", "coinflip_worst_full_year_usd",
                    "coinflip_runs", "coinflip_runs_at_or_above_actual"])
        w.writerows(rows)
    print(f"{len(seeds)} seeds; wrote {out}/markets_coinflip.csv")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 30)
