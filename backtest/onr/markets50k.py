#!/usr/bin/env python3
"""The strategy on other markets, side by side with NQ (descriptive; not a pre-registered test).

usage (ONR_EVAL_FEE_50K=80.50): markets50k.py DATA_DIR R5_DATA_DIR OUT_DIR
  DATA_DIR: NSXUSD.npz, SPXUSD.npz (prep_data.py); R5_DATA_DIR: XAUUSD.npz, WTIUSD.npz (prep_r5.py).

Markets, each run on its own by research round 5's machinery unchanged (Lucid Flex 50K, $1.34 per micro round turn,
5 funded + 5 evals, 12 start dates; the last 5 years from Nov 15 2021 and every year from Feb 15 2011):
  NQ (MNQ)       the current rules, and the same without the overnight trade (round 6's N1), as references
  S&P 500 (MES)  the whole book on the S&P 500 CFD: overnight trade on the same S&P score, 09:35 pyramid, IB breakout,
                 09:30-16:00 session. Prices are scaled x2.5 so one point = $2 per MES contract ($5 per S&P point), as
                 prep_r5.py does for gold and crude: every $ limit, stop and size works in dollars exactly as on NQ.
  Crude (MCL), gold (MGC)  the opening-drive pyramid and IB legs only, on their day sessions (round 5's H5-M markets;
                 the overnight signal is an equity-index signal). The eval trades the drive only.
Writes markets_summary.csv, markets_years.csv, markets_legs.csv, markets_correlation.csv.
"""
import csv
import json
import os
import sys
from multiprocessing import Pool as MP

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from account import FEE_TAG, RULES, is_half, run_eval  # noqa: E402
from engine import PV, Sessions, funded_on, ib_breakout, load_npz, pyramid  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SPX_SCALE = 2.5  # MES: $5 per S&P point = 2.5 scaled points x $2
R5.TICK["spx"] = 0.25 * SPX_SCALE
MOM_E, MOM_F = dict(legs=("od",)), dict(legs=("pyr", "ib"))
CONFIGS = [("nq", "NQ (MNQ): current rules", R5.nq()),
           ("nq_mom", "NQ (MNQ): without the overnight trade", R5.nq(ek=MOM_E, fk=MOM_F)),
           ("spx", "S&P 500 (MES): the whole book", R5.nq(key="spx")),
           ("spx_mom", "S&P 500 (MES): without the overnight trade", R5.nq(key="spx", ek=MOM_E, fk=MOM_F)),
           ("crude", "Crude oil (MCL): pyramid and IB legs", R5.nq(key="crude", ek=MOM_E, fk=MOM_F)),
           ("gold", "Gold (MGC): pyramid and IB legs", R5.nq(key="gold", ek=MOM_E, fk=MOM_F))]
LEGS_OF = {"nq": ("on", "pyr", "ib"), "spx": ("on", "pyr", "ib"), "crude": ("pyr", "ib"), "gold": ("pyr", "ib")}
NAME = {"nq": "NQ (MNQ)", "spx": "S&P 500 (MES)", "crude": "Crude oil (MCL)", "gold": "Gold (MGC)"}


def spx_market(dd):
    spx = load_npz(os.path.join(dd, "SPXUSD.npz"))
    t, o, h, l, c = spx
    return Sessions((t, o * SPX_SCALE, h * SPX_SCALE, l * SPX_SCALE, c * SPX_SCALE), spx, tf=1)


def _init(dd, rd):
    R5._init(dd, rd, {"gold", "crude"})
    R5._S["spx"] = spx_market(dd)


def _job(a):
    return R5._job(a)


def legs(S, key):
    """R per trade at 1 micro contract and $1.34 by leg, as research5.leg_trades (plus the overnight leg)."""
    engine.TK = R5.TICK[key]
    out = {k: [] for k in LEGS_OF[key]}
    for d in S.days:
        r = S.S[d]
        A = r["adr"]
        if np.isnan(A):
            continue
        if "on" in out and "on" in r:
            side = S.on_side(d)
            if side:
                out["on"].append((d, funded_on(S, d, side, 0.0, 0.5, n=1, comm=1.34)[0] / (0.5 * A * PV)))
        if is_half(d) or "od" not in r:
            continue
        side = S.od_side(d)
        if side:
            out["pyr"].append((d, pyramid(S, d, side, 0.0, n=1, comm=1.34, fix_gap=True)[0] / (0.35 * A * PV)))
        res = ib_breakout(S, d, 0.0, n=1, comm=1.34, only_side=side)
        if res and res[1] != "both-skip":
            out["ib"].append((d, res[0] / (0.25 * A * PV)))
    engine.TK = 0.25
    return out


def eval_pass(S, key, ek, a, b):
    """Evals started on every session from a to b (ISO dates); an eval still open at the data's end is left out."""
    engine.TK = R5.TICK[key]
    ks = [k for k, d in enumerate(S.days) if a <= R5.iso(d) <= b and not np.isnan(S.S[d]["adr"])]
    res = [run_eval(S, k, **ek) for k in ks]
    engine.TK = 0.25
    fin = [r for r in res if r["result"] != "open"]
    return 100.0 * sum(r["result"] == "pass" for r in fin) / len(fin), len(fin)


def main(dd, rd, out):
    os.makedirs(out, exist_ok=True)
    fee = RULES[50]["price"]
    _init(dd, rd)
    S = {"nq": R5._S["nq"], "spx": R5._S["spx"], "crude": R5._S["crude"], "gold": R5._S["gold"]}
    jobs = [(k, [parts], w, o) for k, _, parts in CONFIGS for w in ("all", "5y") for o in R4.OFFSETS]
    with MP(4, initializer=_init, initargs=(dd, rd)) as mp:
        res = dict(mp.map(_job, jobs, chunksize=2))
    # NQ must reproduce round 6's stored BASE and N1 runs to the cent (same machinery, same price)
    r6 = json.load(open(os.path.join(HERE, f"results_r6{FEE_TAG}", "runs.json")))
    for mine, theirs in (("nq", "BASE"), ("nq_mom", "N1 no overnight trade")):
        for w in ("all", "5y"):
            for o in R4.OFFSETS:
                a, b = res[(mine, w, o)], r6[f"{theirs}|{w}|{o}"]
                for lab in a["periods"]:
                    for k in ("M", "W", "D", "gap"):
                        assert abs(a["periods"][lab][k] - b["periods"][lab][k]) < 0.01, (mine, w, o, lab, k)
    print("check passed: NQ runs = round 6's stored BASE and N1 runs", flush=True)

    def mean(key, w, lab, f):
        return float(np.mean([f(res[(key, w, o)]["periods"][lab]) for o in R4.OFFSETS]))
    summ = []
    for key, name, parts in CONFIGS:
        mk = parts[0]
        ek = parts[4]
        pass5, n5 = eval_pass(S[mk], mk, ek, R5.START5, "2026-12-31")
        pass_old, _ = eval_pass(S[mk], mk, ek, "2011-01-01", "2021-11-14")
        g5 = lambda k: mean(key, "5y", "last 5y", lambda p: p[k])  # noqa: E731
        go = lambda k: mean(key, "all", "2011-21", lambda p: p[k])  # noqa: E731
        R = [res[(key, "5y", o)] for o in R4.OFFSETS]
        pays = float(np.mean([r["funded"]["payouts"] for r in R]))
        summ.append([key, name, round(pass5, 1), n5, round(g5("M")), round(g5("W")), round(g5("worst12")), round(g5("gap"), 1),
                     round(g5("months_paid"), 1), round(pays, 1), round(float(np.mean([r["total"] for r in R]))),
                     round(pass_old, 1), round(go("M")), round(go("W")), round(go("L"), 2)])
        print(name, summ[-1][2:], flush=True)
    with open(os.path.join(out, "markets_summary.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "setup", "eval_pass_5y_pct", "evals_5y", "net_per_year_5y_usd", "worst_full_year_5y_usd",
                    "worst_12_months_5y_usd", "longest_gap_5y_months", "months_with_payout_5y_pct", "payouts_5y",
                    "total_net_5y_usd", "eval_pass_2011_21_pct", "net_per_year_2011_21_usd", "worst_full_year_2011_21_usd",
                    "losing_full_years_2011_21"])
        w.writerows(summ)
    yrows = []
    for key, name, _ in CONFIGS:
        for w_, ys in (("5y", range(2021, 2027)), ("all", range(2011, 2027))):
            for y in map(str, ys):
                v = [res[(key, w_, o)]["years"][y]["net"] for o in R4.OFFSETS if y in res[(key, w_, o)]["years"]]
                if v:
                    yrows.append([key, "last 5 years" if w_ == "5y" else "all years", y, round(float(np.median(v)))])
    with open(os.path.join(out, "markets_years.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "window", "year", "net_usd"])
        w.writerows(yrows)
    lrows, monthly = [], {}
    LEG = {"on": "Overnight trade", "pyr": "09:35 pyramid", "ib": "IB breakout with the drive"}
    for mk in ("nq", "spx", "crude", "gold"):
        L = legs(S[mk], mk)
        m = {}
        for vals in L.values():  # R summed by month over every leg the market trades, last 5 years
            for d, v in vals:
                if R5.iso(d) >= R5.START5:
                    m[R5.iso(d)[:7]] = m.get(R5.iso(d)[:7], 0.0) + v
        monthly[mk] = m
        for leg, vals in L.items():
            for lab, a, b in R5.BLOCKS:
                x = [v for d, v in vals if a <= R5.iso(d) <= b]
                lrows.append([mk, NAME[mk], LEG[leg], lab, round(float(np.mean(x)), 3), round(float(R5.tstat(x)), 1), len(x)])
    with open(os.path.join(out, "markets_legs.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["market_id", "market", "leg", "period", "r_per_trade", "t_stat", "trades"])
        w.writerows(lrows)
    for r in lrows:
        if r[3] in ("last 5y", "2011-21"):
            print(f"  {r[1]:16s} {r[2]:28s} {r[3]:8s} {r[4]:+.3f}R (t {r[5]:.1f}, n {r[6]})")
    crow = []
    for mk in ("spx", "crude", "gold"):  # does a second market move with NQ month by month?
        ks = sorted(set(monthly[mk]) & set(monthly["nq"]))
        cc = float(np.corrcoef([monthly[mk][k] for k in ks], [monthly["nq"][k] for k in ks])[0, 1])
        crow.append([mk, NAME[mk], round(cc, 2), len(ks)])
        print(f"  {NAME[mk]}: monthly correlation with NQ's legs, last 5 years {cc:+.2f} over {len(ks)} months")
    with open(os.path.join(out, "markets_correlation.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["market_id", "market", "monthly_correlation_with_nq_5y", "months"])
        w.writerows(crow)
    print(f"evals at ${fee:.2f}; wrote {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
