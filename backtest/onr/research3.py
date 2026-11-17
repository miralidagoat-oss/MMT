#!/usr/bin/env python3
"""Research round 3 (pre-registered in PREREG_R3.md, committed before this script was run).

usage: research3.py DATA_DIR [accounts|legs|diag|all]

accounts: BASE (shipped v2.2 at Lucid Flex 50K, max-allowed payouts, $1.34) vs hypotheses A-F and four placebo runs,
          5 funded + eval pool and one account, 2011-18 (selection), 2019-26 (validation), last 4 years; the decision
          rule of PREREG_R3.md is applied mechanically and printed.
legs:     paired per-trade tests for E (second pyramid add) and F (04:00 overnight exit); eval pass rates for C, D, F;
          funded-account outcomes for A, B, E.
diag:     G1 overnight edge by 4-year block and exit hour (and the 2-3 a.m. window the NY Fed studied); G2 pyramid and
          IB legs on the S&P 500 CFD and their correlation with the NQ legs.
"""
import os
import sys
from multiprocessing import Pool as MP

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from account import RULES, run_eval, run_funded  # noqa: E402
from engine import PV, Sessions, funded_on, ib_breakout, load_npz, pyramid  # noqa: E402

SIZE = 50
FEE = RULES[SIZE]["price"]
BASE_E = dict(improved=True, comm=1.34, size=SIZE)
BASE_F = dict(adr_ref=350, improved=True, ib_with_drive=True, cycle_rule=True, comm=1.34, size=SIZE, payout_max=True)
OFFSETS = tuple(range(0, 252, 21))  # 12 start dates per period
F04 = dict(onx=600)  # overnight exit 04:00 ET = 600 minutes after 18:00

CONFIGS = [  # (name, family, session set, eval kwargs, funded kwargs)
    ("BASE", "base", "base", BASE_E, BASE_F),
    ("placebo thr 0.715", "placebo", "base", dict(BASE_E, thr=0.715), dict(BASE_F, thr=0.715)),
    ("placebo thr 0.722", "placebo", "base", dict(BASE_E, thr=0.722), dict(BASE_F, thr=0.722)),
    ("placebo size ref 345", "placebo", "base", BASE_E, dict(BASE_F, adr_ref=345)),
    ("placebo size ref 355", "placebo", "base", BASE_E, dict(BASE_F, adr_ref=355)),
    ("A f=0.4 (risk by cushion)", "A", "base", BASE_E, dict(BASE_F, cushion_frac=0.4)),
    ("A f=0.6 (risk by cushion)", "A", "base", BASE_E, dict(BASE_F, cushion_frac=0.6)),
    ("B day budget 800 x M", "B", "base", BASE_E, dict(BASE_F, day_budget=800.0)),
    ("C eval risk x0.5", "C", "base", dict(BASE_E, risk_k=0.5), BASE_F),
    ("C eval risk x0.75", "C", "base", dict(BASE_E, risk_k=0.75), BASE_F),
    ("D1 eval 09:35 drive only", "D", "base", dict(BASE_E, legs=("od",)), BASE_F),
    ("D2 eval skips overnight sells", "D", "base", dict(BASE_E, on_long_only=True), BASE_F),
    ("E second pyramid add +0.30", "E", "base", BASE_E, dict(BASE_F, add2=0.30)),
    ("F overnight exit 04:00", "F", "f04", dict(BASE_E, news=False), BASE_F),
]

_SS = {}


def build(dd, which):
    nq = load_npz(os.path.join(dd, "NSXUSD.npz"))
    spx = load_npz(os.path.join(dd, "SPXUSD.npz"))
    if which == "base":
        return Sessions(nq, spx, tf=1)
    if which == "f04":
        return Sessions(nq, spx, tf=1, ev=F04)
    if which == "es":
        return Sessions(spx, spx, tf=1)
    raise ValueError(which)


def _init(dd):
    _SS["base"] = build(dd, "base")
    _SS["f04"] = build(dd, "f04")


def periods(S):
    days = S.days
    k0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in days]))
    kof = lambda s: int(np.searchsorted(days, np.datetime64(s).astype(int)))  # noqa: E731
    return [("2011-18", k0, kof("2019-01-01")), ("2019-26", kof("2019-01-01"), len(days)),
            ("last 4y", kof("2022-11-14"), len(days))]


def _job(args):
    from portfolio import pool, portfolio, summarize
    name, sess, ek, fk, structure, lab, a, b = args
    S = _SS[sess]
    fn = (lambda **kw: portfolio(S, lanes=1, **kw)) if structure == "1 account" else (lambda **kw: pool(S, **kw))
    rs = [summarize(S, fn(k_start=a + off, k_stop=b, eval_kw=ek, funded_kw=fk), a + off, b, fee=FEE) for off in OFFSETS]
    g = lambda k, f=np.mean: float(f([r[k] for r in rs]))  # noqa: E731
    return (name, structure, lab), dict(net=g("net_yr"), pay=g("payouts_yr"), months=g("months_with_payout"),
                                        gap=g("longest_gap_mo"), worst=g("worst_12m", np.min), evals=g("evals_yr"))


def accounts(dd):
    S = build(dd, "base")
    P = periods(S)
    jobs = [(n, sess, ek, fk, st, lab, a, b) for n, _, sess, ek, fk in CONFIGS
            for st in ("5 funded + eval pool", "1 account") for lab, a, b in P]
    with MP(4, initializer=_init, initargs=(dd,)) as mp:
        res = dict(mp.map(_job, jobs))
    labs = [lab for lab, _, _ in P]
    print(f"Lucid Flex 50K, max-allowed payouts, $1.34/MNQ; net = payouts x 90% - evals x ${FEE:.0f}; "
          f"{len(OFFSETS)} start dates per period: {' | '.join(labs)}")
    for st in ("5 funded + eval pool", "1 account"):
        print(f"-- {st}")
        for n, *_ in CONFIGS:
            r = [res[(n, st, lab)] for lab in labs]
            f = lambda k, fmt: " | ".join(fmt.format(x[k]) for x in r)  # noqa: E731
            print(f"  {n:31s} net {f('net', '${:7,.0f}')}  gap {f('gap', '{:4.1f}')} mo  worst 12m "
                  f"{f('worst', '${:7,.0f}')}  months paid {f('months', '{:3.0f}%')}  evals/yr {f('evals', '{:5.1f}')}",
                  flush=True)
    # ---- decision rule (PREREG_R3.md)
    st = "5 funded + eval pool"
    base = {lab: res[("BASE", st, lab)] for lab in labs}
    band = {lab: max(abs(res[(n, st, lab)]["net"] - base[lab]["net"]) for n, fam, *_ in CONFIGS if fam == "placebo")
            for lab in labs}
    print(f"\nNoise band (largest placebo move, pool net/yr): " + " | ".join(f"{lab} ${band[lab]:,.0f}" for lab in labs))
    print("Decision (variant chosen on 2011-18; must beat BASE by more than the band in 2011-18 AND 2019-26, longest gap "
          "<= BASE + 1.0 mo in both):")
    adopted = []
    for fam in ("A", "B", "C", "D", "E", "F"):
        cands = [n for n, f_, *_ in CONFIGS if f_ == fam]
        pick = max(cands, key=lambda n: res[(n, st, "2011-18")]["net"])
        ok = True
        why = []
        for lab in ("2011-18", "2019-26"):
            d = res[(pick, st, lab)]["net"] - base[lab]["net"]
            dg = res[(pick, st, lab)]["gap"] - base[lab]["gap"]
            why.append(f"{lab} {d:+,.0f} (band {band[lab]:,.0f}), gap {dg:+.1f} mo")
            ok &= d > band[lab] and dg <= 1.0
        d4 = res[(pick, st, "last 4y")]["net"] - base["last 4y"]["net"]
        print(f"  {fam}: {pick:31s} {'ADOPT' if ok else 'reject'} | " + " | ".join(why) + f" | last 4y {d4:+,.0f}")
        if ok:
            adopted.append(pick)
    print("Adopted:", adopted or "none", flush=True)
    return adopted


def tstat(x):
    x = np.asarray(x, float)
    return x.mean() / (x.std(ddof=1) / np.sqrt(len(x))) if len(x) > 2 else np.nan


def blocks(S):
    days = S.days
    d = lambda s: np.datetime64(s).astype(int)  # noqa: E731
    return [("2011-18", d("2011-01-01"), d("2019-01-01")), ("2019-26", d("2019-01-01"), days[-1] + 1),
            ("last 4y", d("2022-11-14"), days[-1] + 1)]


def show(name, vals, S, unit):
    out = []
    for lab, a, b in blocks(S):
        x = [v for dd_, v in vals if a <= dd_ < b]
        out.append(f"{lab} {np.mean(x):+.3f}{unit} (t {tstat(x):4.1f}, n {len(x):4d})" if len(x) > 2 else f"{lab} n/a")
    print(f"  {name:44s} " + " | ".join(out), flush=True)


def legs(dd):
    from account import is_half
    S, S4 = build(dd, "base"), build(dd, "f04")
    print("== E: second pyramid add at +0.30 ADR, paired per trade (R = initial risk 0.35 ADR, 1 MNQ, $1.34)")
    base, e2, diff = [], [], []
    for d in S.days:
        A = S.S[d]["adr"]
        side = S.od_side(d)
        if not side or np.isnan(A) or is_half(d):
            continue
        r0 = pyramid(S, d, side, n=1, comm=1.34, fix_gap=True)[0] / (0.35 * A * PV)
        r1 = pyramid(S, d, side, n=1, comm=1.34, fix_gap=True, add2=0.30)[0] / (0.35 * A * PV)
        base.append((d, r0))
        e2.append((d, r1))
        diff.append((d, r1 - r0))
    show("pyramid (current)", base, S, "R")
    show("pyramid + second add", e2, S, "R")
    show("difference (second add - current)", diff, S, "R")
    print("== F: overnight exit 04:00 vs 09:30, paired per trade (funded leg, 0.5 ADR stop, R = 0.5 ADR, 1 MNQ, $1.34)")
    for lab_side, want in (("buy", 1), ("sell", -1)):
        b0, b4, df = [], [], []
        for d in S.days:
            if d not in S4.S:
                continue
            side = S.on_side(d)
            if side != want or S4.on_side(d) != want:
                continue
            A = S.S[d]["adr"]
            p0 = funded_on(S, d, side, 0.0, 0.5, n=1, comm=1.34)[0] / (0.5 * A * PV)
            p4 = funded_on(S4, d, side, 0.0, 0.5, n=1, comm=1.34)[0] / (0.5 * A * PV)
            b0.append((d, p0))
            b4.append((d, p4))
            df.append((d, p4 - p0))
        show(f"overnight {lab_side}s, exit 09:30 (current)", b0, S, "R")
        show(f"overnight {lab_side}s, exit 04:00", b4, S, "R")
        show(f"difference (04:00 - 09:30), {lab_side}s", df, S, "R")
    print("== Eval pass rate, an eval started on every session (50K, $1.34)")
    for name, sess, kw in (("BASE", S, BASE_E), ("C eval risk x0.5", S, dict(BASE_E, risk_k=0.5)),
                           ("C eval risk x0.75", S, dict(BASE_E, risk_k=0.75)),
                           ("D1 eval 09:35 drive only", S, dict(BASE_E, legs=("od",))),
                           ("D2 eval skips overnight sells", S, dict(BASE_E, on_long_only=True)),
                           ("F overnight exit 04:00, no news skip", S4, dict(BASE_E, news=False))):
        out = []
        for lab, a, b in periods(sess):
            r = [run_eval(sess, k, **kw) for k in range(a, b)]
            done = [x for x in r if x["result"] != "open"]
            ps = [x["days"] for x in done if x["result"] == "pass"]
            out.append(f"{lab} {100 * len(ps) / len(done):4.1f}% (median {np.median(ps):3.0f} sessions)")
        print(f"  {name:38s} " + " | ".join(out), flush=True)
    print("== Funded 50K accounts started every 5th session: share with a payout / payouts per account / $ per account")
    for name, kw in (("BASE", BASE_F), ("A f=0.4", dict(BASE_F, cushion_frac=0.4)),
                     ("A f=0.6", dict(BASE_F, cushion_frac=0.6)), ("B day budget 800 x M", dict(BASE_F, day_budget=800.0)),
                     ("E second pyramid add", dict(BASE_F, add2=0.30))):
        out = []
        for lab, a, b in periods(S):
            r = [run_funded(S, k, **kw) for k in range(a, b, 5)]
            r = [x for x in r if x["result"] != "open"]
            out.append(f"{lab} {100 * np.mean([len(x['payouts']) > 0 for x in r]):4.1f}% / "
                       f"{np.mean([len(x['payouts']) for x in r]):.2f} / ${np.mean([sum(x['amounts']) for x in r]):,.0f}")
        print(f"  {name:22s} " + " | ".join(out), flush=True)


def diag(dd):
    S = build(dd, "base")
    print("== G1 overnight trades by 4-year block (no stop, entry 18:10, ADR units)")
    marks = [("20:00", 120), ("00:00", 360), ("02:00", 480), ("03:00", 540), ("04:00", 600), ("06:00", 720),
             ("08:00", 840), ("08:30", 870), ("09:30", 930)]
    yrs = [("2011-14", 2011, 2014), ("2015-18", 2015, 2018), ("2019-22", 2019, 2022), ("2023-26", 2023, 2026)]
    paths = {"buy": [], "sell": [], "all": []}
    for d in S.days:
        r = S.S[d]
        A = r["adr"]
        if "on" not in r or np.isnan(A) or np.isnan(r["score"]):
            continue
        o, h, l, c, t = r["rng"]
        i0, i1 = r["i0"], r["i1"]
        s = ((t[i0:i1] % 1440) - 1080) % 1440
        E = r["on"]["E"]
        pts = []
        for _, m in marks:
            j = np.searchsorted(s, m - 1, "left")  # 1-minute bars: the bar that closes at m (or the next one)
            pts.append((c[i0 + j] - E) / A if j < len(s) and s[j] < 1320 else np.nan)
        y = int(str(np.datetime64(int(d), "D"))[:4])
        side = S.on_side(d)
        paths["all"].append((y, np.array(pts)))
        if side:
            paths["buy" if side > 0 else "sell"].append((y, side * np.array(pts)))
    for key in ("buy", "sell", "all"):
        print(f"  {key} ({'signal side' if key != 'all' else 'long every night'}): mean move from 18:10 to each time, ADR")
        print("    block    n   " + " ".join(f"{lab:>7s}" for lab, _ in marks))
        for lab, a, b in yrs:
            X = np.array([p for y, p in paths[key] if a <= y <= b])
            print(f"    {lab} {len(X):4d}   " + " ".join(f"{v:+7.3f}" for v in np.nanmean(X, axis=0)))
    print("  2:00 -> 3:00 a.m. move, every night (the NY Fed's European-open window), ADR, mean (t):")
    for lab, a, b in yrs:
        x = np.array([p[3] - p[2] for y, p in paths["all"] if a <= y <= b])
        x = x[~np.isnan(x)]
        print(f"    {lab}: {x.mean():+.4f} (t {tstat(x):4.1f}, n {len(x)})")
    print("== G2 the momentum legs on the S&P 500 CFD (MES), R per trade, $1.34 per contract (R-normalised)")
    E = build(dd, "es")
    for name, Sx in (("NQ", S), ("ES", E)):
        pv, ibv = [], []
        for d in Sx.days:
            A = Sx.S[d]["adr"]
            if np.isnan(A):
                continue
            side = Sx.od_side(d)
            if side:
                pv.append((d, pyramid(Sx, d, side, n=1, comm=1.34 * PV / (5.0 if name == "ES" else PV),
                                      fix_gap=True)[0] / (0.35 * A * PV)))
            res = ib_breakout(Sx, d, n=1, comm=1.34 * PV / (5.0 if name == "ES" else PV), only_side=side)
            if res and res[1] != "both-skip":
                ibv.append((d, res[0] / (0.25 * A * PV)))
        show(f"{name} opening-drive pyramid", pv, Sx, "R")
        show(f"{name} IB breakout (with the drive / OCO)", ibv, Sx, "R")
        if name == "NQ":
            nq_month = {}
            for d, v in pv + ibv:
                k = str(np.datetime64(int(d), "D"))[:7]
                nq_month[k] = nq_month.get(k, 0.0) + v
        else:
            es_month = {}
            for d, v in pv + ibv:
                k = str(np.datetime64(int(d), "D"))[:7]
                es_month[k] = es_month.get(k, 0.0) + v
    ks = sorted(set(nq_month) & set(es_month))
    a = np.array([nq_month[k] for k in ks])
    b = np.array([es_month[k] for k in ks])
    print(f"  monthly correlation of the NQ and ES momentum legs (R): {np.corrcoef(a, b)[0, 1]:.2f} over {len(ks)} months")
    for lab, y0, y1 in (("2016-17 drought (Nov 2016 - Jul 2017)", "2016-11", "2017-07"),
                        ("2023-24 drought (Sep 2023 - Apr 2024)", "2023-09", "2024-04")):
        sel = [k for k in ks if y0 <= k <= y1]
        print(f"  {lab}: NQ legs {sum(nq_month[k] for k in sel):+.1f}R, ES legs {sum(es_month[k] for k in sel):+.1f}R")


if __name__ == "__main__":
    dd, what = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "all")
    if what in ("legs", "all"):
        legs(dd)
    if what in ("diag", "all"):
        diag(dd)
    if what in ("accounts", "all"):
        accounts(dd)
