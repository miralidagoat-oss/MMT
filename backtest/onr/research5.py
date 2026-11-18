#!/usr/bin/env python3
"""Research round 5 (PREREG_R5.md and its addendum, both committed before any round-5 or last-5-year result).

usage: research5.py DATA_DIR R5_DATA_DIR OUT_DIR legs|accounts|all
  DATA_DIR: NSXUSD.npz, SPXUSD.npz (prep_data.py); R5_DATA_DIR: XAUUSD.npz, WTIUSD.npz (prep_r5.py, prices scaled so
  one point = $2 per micro contract). A market whose file is missing is reported as not tested.

legs      H5-M: the book's opening-drive pyramid and IB legs, unchanged, on the gold (08:20-13:30 ET) and crude
          (09:00-14:30 ET) day sessions: R per trade at 1 micro and $1.34, by period, with 1 tick of slippage; the
          original leg rule (2011-18 and 2019-26) and the 5Y leg rule (last 5 years, 2011-21 not negative); monthly
          correlation with the NQ legs.
accounts  The last 5 years (2021-11-15 -> 2026-11-13) first.
          Part 1 (descriptive): the current rules with 1-5 accounts in round 4's structures A, B and C, 12 start dates
          every 5 sessions from 2021-11-15, every year.
          Part 2 (decisions): every account-level change of rounds 3-5 against BASE (B5 = 5 funded + 5 evals in
          reserve) and 8 placebos, rule 5Y of the addendum; for round 5's own changes (S, M) also the original rule.

Lucid Flex 50K, $1.34 per micro round turn, $115 per eval, 90% split, maximum-allowed payouts (as round 4).
"""
import datetime as dt
import json
import os
import sys
from multiprocessing import Pool as MP

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402
import research4 as R4  # noqa: E402
from account import is_half  # noqa: E402
from engine import PV, Sessions, ib_breakout, load_npz, pyramid  # noqa: E402
from research4 import E_KW, F_KW, FEE, OFFSETS, SPLIT, gate_for, sim_pool, sim_slots  # noqa: E402

START5 = "2021-11-15"
MK = {"gold": dict(file="XAUUSD.npz", rth=(860, 1170), ev=dict(od=865, ib=920, ibend=1070, eod=1170), nb_full=11),
      "crude": dict(file="WTIUSD.npz", rth=(900, 1230), ev=dict(od=905, ib=960, ibend=1110, eod=1230), nb_full=11)}
TICK = {"nq": 0.25, "f04": 0.25, "gold": 0.5, "crude": 0.5}  # one real tick in scaled points (MGC $0.10, MCL $0.01)
FULL5 = {"2011-18": [str(y) for y in range(2012, 2019)], "2019-26": [str(y) for y in range(2019, 2026)],
         "2011-21": [str(y) for y in range(2012, 2021)], "last 5y": ["2022", "2023", "2024", "2025"],
         "all years": [str(y) for y in range(2012, 2026)]}
P_ALL = [("2011-18", "2011-01-01", "2018-12-31"), ("2019-26", "2019-01-01", "2026-12-31"),
         ("2011-21", "2011-01-01", "2021-11-14"), ("all years", "2011-01-01", "2026-12-31")]
P_5Y = [("last 5y", START5, "2026-12-31")]
R4_BANDS = {"2011-18": dict(M=4535.0, W=5605.0), "2019-26": dict(M=3644.0, W=5434.0)}  # results_r4/decisions.txt
BLOCKS = (("2011-18", "2011-01-01", "2018-12-31"), ("2019-26", "2019-01-01", "2026-12-31"),
          ("2011-21", "2011-01-01", "2021-11-14"), ("last 5y", START5, "2026-12-31"))
_S = {}


def iso(d):
    return str(np.datetime64(int(d), "D"))


def load_market(rd, spx, name):
    m = MK[name]
    p = os.path.join(rd, m["file"])
    if not os.path.exists(p):
        return None
    return Sessions(load_npz(p), spx, tf=1, ev=m["ev"], rth=m["rth"], nb_full=m["nb_full"])


# ------------------------------------------------------------------------------------------------------- leg level
def tstat(x):
    x = np.asarray(x, float)
    return x.mean() / (x.std(ddof=1) / np.sqrt(len(x))) if len(x) > 2 else float("nan")


def blocks(vals):
    out = {}
    for lab, a, b in BLOCKS:
        x = [v for d, v in vals if a <= iso(d) <= b]
        out[lab] = (float(np.mean(x)) if x else float("nan"), tstat(x), len(x))
    return out


def leg_trades(S, slip=0.0):
    pyr, ib = [], []
    for d in S.days:
        A = S.S[d]["adr"]
        if np.isnan(A) or is_half(d) or "od" not in S.S[d]:
            continue
        side = S.od_side(d)
        if side:
            pyr.append((d, pyramid(S, d, side, slip, n=1, comm=1.34, fix_gap=True)[0] / (0.35 * A * PV)))
        res = ib_breakout(S, d, slip, n=1, comm=1.34, only_side=side)
        if res and res[1] != "both-skip":
            ib.append((d, res[0] / (0.25 * A * PV)))
    return pyr, ib


def monthly(vals):
    m = {}
    for d, v in vals:
        m[iso(d)[:7]] = m.get(iso(d)[:7], 0.0) + v
    return m


def legs(dd, rd, out):
    spx = load_npz(os.path.join(dd, "SPXUSD.npz"))
    lines = []

    def say(s):
        print(s, flush=True)
        lines.append(s)

    def fmt(b):
        return " | ".join(f"{k} {b[k][0]:+.3f} (t {b[k][1]:.1f}, n {b[k][2]})" for k in b)

    engine.TK = 0.25
    SN = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), spx, tf=1)
    npyr, nib = leg_trades(SN)
    nq_month = monthly(npyr + nib)
    say("H5-M legs: mean R per trade at 1 micro contract, $1.34 commission (t-statistic, trades) by period")
    say(f"  {'NQ pyramid (reference)':30s} {fmt(blocks(npyr))}")
    say(f"  {'NQ IB with the drive (ref.)':30s} {fmt(blocks(nib))}")
    verdict = {}
    for name in MK:
        engine.TK = TICK[name]
        S = load_market(rd, spx, name)
        if S is None:
            say(f"  {name}: no data file -> not tested")
            verdict[name] = dict(original=False, five=False)
            continue
        p, i = leg_trades(S)
        ps, is_ = leg_trades(S, slip=TICK[name])
        ok_o, ok_5 = [], []
        for leg, v, vs in (("pyramid", p, ps), ("IB with the drive", i, is_)):
            b, bs = blocks(v), blocks(vs)
            o = all(b[h][0] > 0 and b[h][1] >= 2 for h in ("2011-18", "2019-26")) and bs["2019-26"][0] > 0
            f = b["last 5y"][0] > 0 and b["last 5y"][1] >= 2 and bs["last 5y"][0] > 0 and b["2011-21"][0] > 0
            ok_o.append(o)
            ok_5.append(f)
            say(f"  {name + ' ' + leg:30s} {fmt(b)}")
            say(f"  {'':30s} with 1 tick of slippage: 2019-26 {bs['2019-26'][0]:+.3f}, last 5y {bs['last 5y'][0]:+.3f}"
                f" -> original rule {'counts' if o else 'does not count'}, 5Y rule {'counts' if f else 'does not count'}")
        mm = monthly(p + i)
        ks = sorted(set(mm) & set(nq_month))
        say(f"  {name}: monthly correlation with the NQ legs {np.corrcoef([mm[k] for k in ks], [nq_month[k] for k in ks])[0, 1]:+.2f}"
            f" over {len(ks)} months; sessions {len(S.days)}, with an ADR {sum(not np.isnan(S.S[d]['adr']) for d in S.days)}")
        verdict[name] = dict(original=all(ok_o), five=all(ok_5))
        say(f"  {name}: both legs count under the original rule: {all(ok_o)}; under the 5Y rule: {all(ok_5)}"
            f" -> account test {'YES' if all(ok_o) or all(ok_5) else 'no (pre-registered)'}")
    engine.TK = 0.25
    os.makedirs(out, exist_ok=True)
    open(os.path.join(out, "legs.txt"), "w").write("\n".join(lines) + "\n")
    json.dump(verdict, open(os.path.join(out, "legs_verdict.json"), "w"), indent=1)
    return verdict


# --------------------------------------------------------------------------------------------------- account level
def _init(dd, rd, keys):
    R4._init(dd)  # NQ sessions, first tradable session, the one-account book used by family T
    _S["nq"] = R4._G["S"]
    spx = load_npz(os.path.join(dd, "SPXUSD.npz"))
    if "f04" in keys:
        _S["f04"] = Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), spx, tf=1, ev=dict(onx=600))
    for name in MK:
        if name in keys:
            _S[name] = load_market(rd, spx, name)


def metrics(evs, full_years, periods):
    """research4.run_metrics on the merged calendar of one or more markets (checked equal for one market)."""
    cal = sorted({iso(S.days[k]) for _, S, k0, _ in evs for k in range(k0, len(S.days))})
    pos = {d: i for i, d in enumerate(cal)}
    E = [(iso(S.days[k]), kind, (key, aid), v) for key, S, _, ev in evs for k, kind, aid, v in ev]
    net = np.zeros(len(cal))
    pays = []
    for d, kind, _, v in E:
        if kind == "payout":
            net[pos[d]] += SPLIT * v
            pays.append(pos[d])
        elif kind == "buy":
            net[pos[d]] -= FEE
    run = np.cumsum(net)
    yrs = {}
    for i, d in enumerate(cal):
        y = yrs.setdefault(d[:4], dict(net=0.0, payouts=0, payouts_usd=0.0, evals_bought=0, evals_passed=0, evals_failed=0,
                                       funded_started=0))
        y["net"] += net[i]
    for d, kind, _, v in E:
        y = yrs[d[:4]]
        if kind == "payout":
            y["payouts"] += 1
            y["payouts_usd"] += v
        elif kind == "buy":
            y["evals_bought"] += 1
        elif kind == "pass":
            y["evals_passed"] += 1
        elif kind == "fail":
            y["evals_failed"] += 1
        elif kind == "fund":
            y["funded_started"] += 1
    fund = {aid for _, kind, aid, _ in E if kind == "fund"}
    paid = {aid for _, kind, aid, _ in E if kind == "payout"}
    ended = {aid: kind[4:] for _, kind, aid, _ in E if kind.startswith("end:")}
    passes = [v for _, kind, _, v in E if kind == "pass"]
    out = dict(years=yrs, cash_low=float(run.min()), total=float(run[-1]),
               evals=dict(bought=sum(kind == "buy" for _, kind, _, _ in E), passed=len(passes),
                          failed=sum(kind == "fail" for _, kind, _, _ in E),
                          median_pass=float(np.median(passes)) if passes else 0.0),
               funded=dict(started=len(fund), with_payout=len(paid & fund), payouts=sum(kind == "payout" for _, kind, _, _ in E),
                           payouts_usd=float(sum(v for _, kind, _, v in E if kind == "payout")),
                           abandoned=sum(v == "abandoned" for v in ended.values()), blown=sum(v == "blown" for v in ended.values()),
                           done=sum(v == "done" for v in ended.values()), open=len(fund) - len(ended)))
    per = {}
    for lab, a, b in periods:
        idx = [i for i, d in enumerate(cal) if a <= d <= b]
        if not idx:
            continue
        i0, i1 = idx[0], idx[-1]
        pn = net[i0:i1 + 1]
        span = (dt.date.fromisoformat(cal[i1]) - dt.date.fromisoformat(cal[i0])).days / 365.25
        prun = np.cumsum(pn)
        drop = float((prun - np.maximum.accumulate(np.r_[0.0, prun])[1:]).min())
        months = {}
        for i in range(i0, i1 + 1):
            months[cal[i][:7]] = months.get(cal[i][:7], 0.0) + net[i]
        mv = np.array([months[m] for m in sorted(months)])
        roll = np.array([mv[j:j + 12].sum() for j in range(len(mv) - 11)]) if len(mv) >= 12 else np.array([mv.sum()])
        pd_ = sorted(cal[i] for i in pays if i0 <= i <= i1)
        pts = [dt.date.fromisoformat(cal[i0])] + [dt.date.fromisoformat(x) for x in pd_] + [dt.date.fromisoformat(cal[i1])]
        gap = max((pts[j + 1] - pts[j]).days for j in range(len(pts) - 1)) / 30.44
        fy = [yrs[y]["net"] for y in full_years.get(lab, []) if y in yrs]
        per[lab] = dict(M=float(pn.sum() / span), W=float(min(fy)) if fy else float("nan"),
                        L=float(sum(x < 0 for x in fy)), D=drop, worst12=float(roll.min()), gap=gap,
                        months_paid=100.0 * len({x[:7] for x in pd_}) / len(months),
                        evals_yr=sum(1 for d, kind, _, _ in E if kind == "buy" and cal[i0] <= d <= cal[i1]) / span)
    out["periods"] = per
    return out


def start_day(window, off):
    SN = _S["nq"]
    k = R4._G["k0"] if window == "all" else int(np.searchsorted(SN.days, np.datetime64(START5).astype(int)))
    return SN.days[k + off]


def run_parts(parts, sd):
    evs = []
    for key, struct, N, mt, ek, fk, lb in parts:
        S = _S[key]
        engine.TK = TICK[key]
        k0 = int(np.searchsorted(S.days, sd))
        if struct == "A":
            ev = sim_slots(S, N, k0, len(S.days), ek, fk)
        else:
            ev = sim_pool(S, N, mt, k0, len(S.days), ek, fk, gate_for(lb))
        engine.TK = 0.25
        evs.append((key, S, k0, ev))
    return evs


def _job(args):
    name, parts, window, off = args
    evs = run_parts(parts, start_day(window, off))
    return (name, window, off), metrics(evs, FULL5, P_ALL if window == "all" else P_5Y)


def self_check():
    """metrics() must equal research4.run_metrics on one market (both windows, a pool and a slot structure)."""
    S = _S["nq"]
    for window, off, part in (("all", 0, ("nq", "B", 5, 10, E_KW, F_KW, None)), ("5y", 25, ("nq", "B", 5, 10, E_KW, F_KW, None)),
                              ("5y", 0, ("nq", "A", 3, None, E_KW, F_KW, None)), ("all", 10, ("nq", "B", 2, 2, E_KW, F_KW, 63))):
        sd = start_day(window, off)
        evs = run_parts([part], sd)
        _, _, k0, ev = evs[0]
        per = P_ALL if window == "all" else P_5Y
        a = metrics(evs, FULL5, per)
        b = R4.run_metrics(S, ev, k0, len(S.days), FULL5, per)
        assert a["periods"].keys() == b["periods"].keys()
        for lab in a["periods"]:
            for k in a["periods"][lab]:
                x, y = a["periods"][lab][k], b["periods"][lab][k]
                assert (np.isnan(x) and np.isnan(y)) or abs(x - y) < 1e-6, (window, lab, k, x, y)
        for y in a["years"]:
            for k in a["years"][y]:
                assert abs(a["years"][y][k] - b["years"][y][k]) < 1e-6, (y, k)
        assert a["evals"] == b["evals"] and a["funded"] == b["funded"], (a["evals"], b["evals"], a["funded"], b["funded"])
    print("self-check passed: merged-calendar metrics = research4.run_metrics (4 runs)", flush=True)


def nq(ek=None, fk=None, mt=10, lb=None, key="nq", N=5, struct="B"):
    return (key, struct, N, mt, dict(E_KW, **(ek or {})), dict(F_KW, **(fk or {})), lb)


def second(market, k):
    return [nq(N=5 - k, mt=2 * (5 - k)),
            (market, "B", k, 2 * k, dict(E_KW, legs=("od",)), dict(F_KW, legs=("pyr", "ib")), None)]


def decision_configs(markets):
    c = [("BASE", "base", [nq()])]
    for x in (0.712, 0.715, 0.722, 0.725):
        c.append((f"P thr {x}", "placebo", [nq(dict(thr=x), dict(thr=x))]))
    for x in (340, 345, 355, 360):
        c.append((f"P size ref {x}", "placebo", [nq(fk=dict(adr_ref=x))]))
    c += [("A f=0.4 (risk by cushion)", "A", [nq(fk=dict(cushion_frac=0.4))]),
          ("A f=0.6 (risk by cushion)", "A", [nq(fk=dict(cushion_frac=0.6))]),
          ("B day budget 800 x M", "B", [nq(fk=dict(day_budget=800.0))]),
          ("C eval risk x0.5", "C", [nq(ek=dict(risk_k=0.5))]),
          ("C eval risk x0.75", "C", [nq(ek=dict(risk_k=0.75))]),
          ("D1 eval 09:35 drive only", "D", [nq(ek=dict(legs=("od",)))]),
          ("D2 eval skips overnight sells", "D", [nq(ek=dict(on_long_only=True))]),
          ("E second pyramid add +0.30", "E", [nq(fk=dict(add2=0.30))]),
          ("F overnight exit 04:00", "F", [nq(ek=dict(news=False), key="f04")]),
          ("T 63 sessions", "T", [nq(lb=63)]), ("T 126 sessions", "T", [nq(lb=126)])]
    for kk in (0.5, 0.75, 1.25, 1.5):
        c.append((f"R x{kk}", "R", [nq(fk=dict(adr_ref=350 * kk, day_budget=600.0 * kk))]))
    c += [("V 7 accounts", "V", [nq(mt=7)]), ("V 8 accounts", "V", [nq(mt=8)]),
          ("S funded skips overnight sells", "S", [nq(fk=dict(on_long_only=True))])]
    for m in markets:
        for k in (1, 2):
            c.append((f"M {5 - k} NQ + {k} {m}", f"M-{m}", second(m, k)))
    return c


def descriptive_configs():
    c = []
    for N in range(1, 6):
        c.append((f"A{N}", "A", [nq(N=N, mt=None, struct="A")]))
        c.append((f"C{N}", "C", [nq(N=N, mt=N)]))
        c.append((f"B{N}", "B", [nq(N=N, mt=2 * N)]))
    return c


def run_jobs(dd, rd, jobs, keys):
    with MP(4, initializer=_init, initargs=(dd, rd, keys)) as mp:
        return dict(mp.map(_job, jobs, chunksize=2))


def accounts(dd, rd, out):
    os.makedirs(out, exist_ok=True)
    _init(dd, rd, ())
    self_check()
    vpath = os.path.join(out, "legs_verdict.json")
    verdict = json.load(open(vpath)) if os.path.exists(vpath) else {}
    markets = [m for m, v in verdict.items() if v["original"] or v["five"]]
    C = decision_configs(markets)
    D = descriptive_configs()
    keys = {p[0] for _, _, parts in C + D for p in parts}
    jobs = [(n, parts, w, o) for n, _, parts in C for w in ("all", "5y") for o in OFFSETS]
    jobs += [(n, parts, "5y", o) for n, _, parts in D for o in OFFSETS]
    res = run_jobs(dd, rd, jobs, keys)
    json.dump({f"{n}|{w}|{o}": v for (n, w, o), v in res.items()}, open(os.path.join(out, "runs.json"), "w"))
    lines = []

    def say(s=""):
        print(s, flush=True)
        lines.append(s)

    # ---------------- Part 1: the last 5 years, 1-5 accounts
    years = ["2021", "2022", "2023", "2024", "2025", "2026"]
    rows, summ = [], []
    LAB = {"A": "N accounts bought the same day (copy-traded in lockstep)",
           "C": "N accounts, each an eval then funded, at most one new eval a day",
           "B": "N funded + N evals in reserve"}
    for st in ("A", "C", "B"):
        for N in range(1, 6):
            R = [res[(f"{st}{N}", "5y", o)] for o in OFFSETS]
            for y in years:
                vals = [r["years"][y] for r in R if y in r["years"]]
                nets = [v["net"] for v in vals]
                med = lambda key: float(np.median([v[key] for v in vals]))  # noqa: E731
                rp, rf = sum(v["evals_passed"] for v in vals), sum(v["evals_failed"] for v in vals)
                rows.append([LAB[st], N, y + (" (from Nov 15)" if y == "2021" else " (to Nov 13)" if y == "2026" else ""),
                             round(float(np.median(nets))), round(min(nets)), round(max(nets)), med("payouts"),
                             round(med("payouts_usd")), med("evals_bought"), med("evals_passed"), med("evals_failed"),
                             round(100 * rp / (rp + rf), 1) if rp + rf else "", med("funded_started")])
            g = lambda key: float(np.mean([r["periods"]["last 5y"][key] for r in R]))  # noqa: E731
            ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
            fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
            summ.append([LAB[st], N, round(g("M")), round(g("W")), round(g("L"), 2), round(g("D")), round(g("worst12")),
                         round(g("gap"), 1), round(g("months_paid"), 1), round(g("evals_yr"), 1),
                         round(float(np.mean([r["cash_low"] for r in R]))), round(float(np.mean([r["total"] for r in R]))),
                         round(ev("bought"), 1), round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                         round(ev("median_pass"), 1), round(fu("started"), 1),
                         round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1), round(fu("payouts"), 1),
                         round(fu("payouts_usd") / max(fu("payouts"), 1e-9)), round(fu("abandoned"), 1), round(fu("done"), 1),
                         round(fu("blown"), 1)])
    import csv
    with open(os.path.join(out, "accounts_5y_by_year.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["structure", "accounts", "year", "net_median_usd", "net_lowest_usd", "net_highest_usd", "payouts_median",
                    "payouts_usd_median", "evals_bought_median", "evals_passed_median", "evals_failed_median", "eval_pass_pct",
                    "funded_started_median"])
        w.writerows(rows)
    with open(os.path.join(out, "accounts_5y_summary.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["structure", "accounts", "net_per_year_usd", "worst_full_year_usd", "losing_full_years", "deepest_drop_usd",
                    "worst_12_months_usd", "longest_gap_months", "months_with_payout_pct", "evals_per_year",
                    "most_cash_out_usd", "total_net_5y_usd", "evals_bought", "eval_pass_pct", "eval_median_sessions",
                    "funded_accounts", "funded_with_payout_pct", "payouts", "average_payout_usd", "funded_abandoned",
                    "funded_done_5_payouts", "funded_blown"])
        w.writerows(summ)
    say("Part 1: the last 5 years (start dates 2021-11-15 + 0..55 sessions, to 2026-11-13), mean of 12 start dates")
    for r in summ:
        say(f"  {r[0][:22]:22s} N={r[1]}: net/yr ${r[2]:>7,} | worst full year ${r[3]:>7,} | losing years {r[4]:.2f} | "
            f"deepest drop ${r[5]:>7,} | 5-year total ${r[11]:>8,} | eval pass {r[13]}% | payouts {r[17]}")

    # ---------------- Part 2: decisions
    names = [n for n, _, _ in C]
    fam = {n: f for n, f, _ in C}
    mean = {n: {} for n in names}
    for n in names:
        for w, plist in (("all", P_ALL), ("5y", P_5Y)):
            for lab, _, _ in plist:
                mean[n][lab] = {k: float(np.mean([res[(n, w, o)]["periods"][lab][k] for o in OFFSETS]))
                                for k in ("M", "W", "L", "D", "worst12", "gap")}
    for lab, w in (("2011-18", "all"), ("2019-26", "all")):  # BASE = round 4's B5, to the dollar
        r4 = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results_r4", "runs.json")))
        for k in ("M", "W"):
            v4 = float(np.mean([r4[f"B5|all|{o}"]["periods"][lab][k] for o in OFFSETS]))
            assert abs(mean["BASE"][lab][k] - v4) < 0.01, (lab, k, mean["BASE"][lab][k], v4)
    say("\ncheck passed: BASE = round 4's B5 in 2011-18 and 2019-26")
    plac = [n for n in names if fam[n] == "placebo"]
    band = {p: {k: max(abs(mean[x][p][k] - mean["BASE"][p][k]) for x in plac) for k in ("M", "W")}
            for p in ("last 5y", "2011-21", "2011-18", "2019-26")}
    say("Part 2: 5 funded + 5 evals in reserve; M net a year, W worst full year, L losing full years, D deepest drop, "
        "gap longest wait for a payout (months); mean of 12 start dates")
    say("noise bands, 8 placebos (largest move): " + " | ".join(f"{p}: M {band[p]['M']:,.0f}, W {band[p]['W']:,.0f}" for p in band))

    def row(n):
        return " || ".join(f"{p}: M {mean[n][p]['M']:>7,.0f} W {mean[n][p]['W']:>7,.0f} L {mean[n][p]['L']:.2f} "
                           f"D {mean[n][p]['D']:>7,.0f} gap {mean[n][p]['gap']:4.1f}" for p in ("last 5y", "2011-21"))
    for n in names:
        say(f"  {n:32s} {row(n)}")

    def route(n, p, bands, base="BASE"):
        dM, dW = mean[n][p]["M"] - mean[base][p]["M"], mean[n][p]["W"] - mean[base][p]["W"]
        if dW > bands[p]["W"] and dM >= -bands[p]["M"]:
            return "consistency", dW
        if dM > bands[p]["M"] and dW >= -bands[p]["W"]:
            return "money", dM
        return None, 0.0

    say("\nRule 5Y (addendum): best variant of each family in the last 5 years; it must pass there (round 4's rule, "
        "8-placebo band) and not be worse than the band in 2011-21")
    adopted = []
    for f in sorted({fam[n] for n in names} - {"base", "placebo"}, key=lambda x: (len(x) > 1, x)):
        cand = [n for n in names if fam[n] == f]
        ok = sorted([(n,) + route(n, "last 5y", band) for n in cand if route(n, "last 5y", band)[0]],
                    key=lambda x: (x[1] != "consistency", -x[2]))
        if not ok:
            best = max(cand, key=lambda n: mean[n]["last 5y"]["M"] - mean["BASE"]["last 5y"]["M"])
            say(f"  {f:8s} reject: no variant passes the last 5 years (closest on net/yr: {best}, "
                f"M {mean[best]['last 5y']['M'] - mean['BASE']['last 5y']['M']:+,.0f}, "
                f"W {mean[best]['last 5y']['W'] - mean['BASE']['last 5y']['W']:+,.0f})")
            continue
        pick, rt, imp = ok[0]
        dM = mean[pick]["2011-21"]["M"] - mean["BASE"]["2011-21"]["M"]
        dW = mean[pick]["2011-21"]["W"] - mean["BASE"]["2011-21"]["W"]
        good = dM >= -band["2011-21"]["M"] and dW >= -band["2011-21"]["W"]
        say(f"  {f:8s} {pick}: passes the last 5 years by {rt} ({imp:+,.0f}); 2011-21 M {dM:+,.0f}, W {dW:+,.0f} "
            f"-> {'ADOPT' if good else 'reject (worse in 2011-21)'}")
        if good:
            adopted.append((pick, rt, imp))
    say("Adopted under rule 5Y: " + (", ".join(a[0] for a in adopted) if adopted else "none"))
    if len(adopted) > 1:
        say("  more than one family passes: their combination must be run and must beat each (pre-registered); "
            "not run in this pass")

    say("\nOriginal rule (PREREG_R4/R5) for round 5's own changes: variant chosen on 2011-18, must pass 2011-18 and "
        "2019-26 against BASE with round 4's bands")
    for f in sorted({fam[n] for n in names if fam[n] == "S" or fam[n].startswith("M-")}):
        cand = [n for n in names if fam[n] == f]
        ok = sorted([(n,) + route(n, "2011-18", R4_BANDS) for n in cand if route(n, "2011-18", R4_BANDS)[0]],
                    key=lambda x: (x[1] != "consistency", -x[2]))
        if not ok:
            say(f"  {f:8s} reject: no variant passes 2011-18 ("
                + "; ".join(f"{n}: M {mean[n]['2011-18']['M'] - mean['BASE']['2011-18']['M']:+,.0f}, "
                            f"W {mean[n]['2011-18']['W'] - mean['BASE']['2011-18']['W']:+,.0f}" for n in cand) + ")")
            continue
        pick = ok[0][0]
        rt, _ = route(pick, "2019-26", R4_BANDS)
        say(f"  {f:8s} {pick}: passes 2011-18 by {ok[0][1]}; 2019-26 {'passes by ' + rt if rt else 'fails'} "
            f"-> {'ADOPT' if rt else 'reject'}")
    open(os.path.join(out, "decisions.txt"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    dd, rd, out, what = sys.argv[1:5]
    if what in ("legs", "all"):
        legs(dd, rd, out)
    if what in ("accounts", "all"):
        accounts(dd, rd, out)
