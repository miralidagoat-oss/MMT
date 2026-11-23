#!/usr/bin/env python3
"""The indicator's plan at Topstep: every Trading Combine / Express Funded Account configuration.

usage: topstep_sim.py FUT_DATA_DIR CFD_DATA_DIR OUT_DIR
Topstep's rules (help.topstep.com, read Nov 20 2026), sizes 50K / 100K / 150K:
  Trading Combine: target $3,000 / $6,000 / $9,000; end-of-day trailing Maximum Loss Limit $2,000 / $3,000 / $4,500
  that locks at the starting balance; at most 50 / 100 / 150 micros; best day <= 55% of the total profit (above it the
  target rises to best day / 0.55); price per month, and per reset, $49 / $99 / $199 on the Standard path and
  $95 / $149 / $229 on the No Activation Fee path.
  Express Funded Account (XFA): starts at $0; MLL -$2,000 / -$3,000 / -$4,500 trailing end of day, locking at $0, and
  $0 after any payout; activation $149 on the Standard path, $0 on the No Activation Fee path; up to 5 at once; 90%
  split; minimum payout $125; no payout-count limit stated. Payout path, chosen at activation:
    Standard: 5 winning days of $150+ since the last payout; 50% of the balance up to $2,000 / $3,000 / $5,000.
    Consistency: 3 traded days, largest day <= 40% of the net profit since the last payout; 50% up to $3,000 /
    $4,000 / $6,000.
The plan: the indicator's trades at its 50K / 100K / 150K settings (every $ limit scaled by max loss / $1,000; the
eval's daily target capped at 50% of the target, the indicator's 50% setting, under Topstep's 55%), 5 funded accounts
with 5 Combines running behind them, one new Combine a session. Accounts are not closed after a set number of
payouts: Topstep has no payout limit. Its discretionary call-up to a live account, which closes every XFA, cannot be
modelled.
Not modelled: the optional Daily Loss Limit and its limited-time doubled caps, the monthly reset credit, and the
Scaling Plan tiers (its table could not be read). Each funded leg is capped at 6 / 10 / 10 micros, so three legs fit
the tiers we believe start at 20 / 30 / 30 micros: an assumption. It binds when NQ's daily range is below about
108 / 100 / 150 points: over the last 5 years never at 50K and 100K and on 6 days at 150K, but on most sessions of
2019 and of every CFD year before 2020 (topstep_cap.csv), so the windows reaching back there trade smaller than Lucid's
plan, whose caps are 20 / 30 / 40.
Payout requests: as the indicator's panel says, once an account is $1,000 up, half the profit up to Topstep's cap
(Topstep's own minimum is $125: ONR_TS_PAYMIN=125 tests requesting that early).
Costs: each Combine attempt pays the month's price when it starts and again every 30 days while it is open; each XFA
pays the activation fee on the Standard path.
Runs: 12 start dates (research4.OFFSETS) in each window: real NQ futures over the last 5 years and from Aug 30 2019,
and the Nasdaq-100 CFD from Feb 2011. Lucid's plan (results_scale_sizes) is the reference.
Writes runs.json and, from it (also alone: topstep_sim.py --tables FUT_DATA_DIR CFD_DATA_DIR OUT_DIR):
  topstep.csv          mean of the 12 start dates per window, size, payout path and fee path (36 rows, with ids)
  topstep_years.csv    net by calendar year, median / lowest / highest of the 12 start dates
  topstep_accounts.csv one XFA started every 10 sessions over the last 5 years, traded alone: what each path does
  topstep_rules.csv    the rules above, as used
  topstep_cap.csv      sessions where the funded leg cap binds, by data set and year
"""
import csv
import datetime as dt
import json
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research4 as R4  # noqa: E402
import research5 as R5  # noqa: E402
from account import USER_ADDON, USER_EVAL, FundedAccount  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402

SIZES = (50, 100, 150)
TS = {50: dict(target=3000.0, mll=2000.0, qday=150.0, evalmax=50, fundmax=6),
      100: dict(target=6000.0, mll=3000.0, qday=150.0, evalmax=100, fundmax=10),
      150: dict(target=9000.0, mll=4500.0, qday=150.0, evalmax=150, fundmax=10)}
CAP = {"standard": {50: 2000.0, 100: 3000.0, 150: 5000.0}, "consistency": {50: 3000.0, 100: 4000.0, 150: 6000.0}}
PRICE = {"standard": {50: 49.0, 100: 99.0, 150: 199.0}, "noact": {50: 95.0, 100: 149.0, 150: 229.0}}
ACTIVATION = {"standard": 149.0, "noact": 0.0}
FEE_LABEL = {"standard": "Standard path ($/month + $149 activation)", "noact": "No Activation Fee path"}
PAY_LABEL = {"standard": "Standard payouts (5 days of $150)", "consistency": "Consistency payouts (40%)"}
SPLIT, OFF = 0.9, R4.OFFSETS
# payout requests follow the indicator's panel: once an account is $1,000 up (a payout of at least $500), half the
# profit up to Topstep's cap. ONR_TS_PAYMIN=125 requests as soon as Topstep allows ($125 minimum, $250 of profit).
PAY_MIN = float(os.environ.get("ONR_TS_PAYMIN", "500"))
START5 = "2021-11-15"
_S = {}


def ek(size):
    return dict(R4.E_KW, cons=0.5, rules=TS[size], lock=0.0, pass_cons=0.55)


def fk(size, path):
    return dict(R4.F_KW, rules=dict(TS[size], paycap=CAP[path][size]), lock=0.0, pay_min=PAY_MIN,
                pay_path="days" if path == "standard" else "consistency", pay_cons=0.4, pay_days=3, max_pay=10 ** 9)


def load(kind, dd):
    if kind == "fut":
        return Sessions(load_npz(os.path.join(dd, "NQFUT.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=5)
    return Sessions(load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz")), tf=1)


def first_tradable(S):
    return int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))


def iso(S, k):
    return str(np.datetime64(int(S.days[k]), "D"))


def cash_flows(S, k0, ev, fee_path, size, fee_per_buy=None):
    """Daily cash from sim_pool events: 90% of payouts, Combine prices (at the start and every 30 days open) and
    activation fees. fee_per_buy: a flat price per eval instead (the check against research5.metrics)."""
    n = len(S.days) - k0
    cash = np.zeros(n)
    end = {aid: k for k, kind, aid, _ in ev if kind in ("pass", "fail")}
    for k, kind, aid, v in ev:
        if kind == "payout":
            cash[k - k0] += SPLIT * v
        elif kind == "buy":
            if fee_per_buy is not None:
                cash[k - k0] -= fee_per_buy
                continue
            ke = end.get(aid, len(S.days) - 1)
            d0, j = int(S.days[k]), 0
            while d0 + 30 * j <= int(S.days[ke]):
                kc = int(np.searchsorted(S.days, d0 + 30 * j))
                cash[min(kc, ke) - k0] -= PRICE[fee_path][size]
                j += 1
        elif kind == "fund" and fee_per_buy is None:
            cash[k - k0] -= ACTIVATION[fee_path]
    return cash


def summarise_run(S, k0, cash, ev, periods, full_years):
    """research5.metrics' definitions on a daily cash array (checked equal to it for flat eval prices)."""
    cal = [iso(S, k) for k in range(k0, len(S.days))]
    yrs = {}
    for i, d in enumerate(cal):
        yrs[d[:4]] = yrs.get(d[:4], 0.0) + cash[i]
    pays = sorted({k - k0 for k, kind, _, _ in ev if kind == "payout"})
    run = np.cumsum(cash)
    fund = {aid for _, kind, aid, _ in ev if kind == "fund"}
    paid = {aid for _, kind, aid, _ in ev if kind == "payout"}
    passes = [v for _, kind, _, v in ev if kind == "pass"]
    out = dict(years=yrs, cash_low=float(run.min()), total=float(run[-1]),
               evals=dict(bought=sum(kind == "buy" for _, kind, _, _ in ev), passed=len(passes),
                          failed=sum(kind == "fail" for _, kind, _, _ in ev)),
               funded=dict(started=len(fund), with_payout=len(paid & fund),
                           payouts=sum(kind == "payout" for _, kind, _, _ in ev),
                           payouts_usd=float(sum(v for _, kind, _, v in ev if kind == "payout"))))
    per = {}
    for lab, a, b in periods:
        idx = [i for i, d in enumerate(cal) if a <= d <= b]
        if not idx:
            continue
        i0, i1 = idx[0], idx[-1]
        pn = cash[i0:i1 + 1]
        span = (dt.date.fromisoformat(cal[i1]) - dt.date.fromisoformat(cal[i0])).days / 365.25
        prun = np.cumsum(pn)
        drop = float((prun - np.maximum.accumulate(np.r_[0.0, prun])[1:]).min())
        months = {}
        for i in range(i0, i1 + 1):
            months[cal[i][:7]] = months.get(cal[i][:7], 0.0) + cash[i]
        mv = np.array([months[m] for m in sorted(months)])
        roll = np.array([mv[j:j + 12].sum() for j in range(len(mv) - 11)]) if len(mv) >= 12 else np.array([mv.sum()])
        pd_ = sorted(cal[i] for i in pays if i0 <= i <= i1)
        pts = [dt.date.fromisoformat(cal[i0])] + [dt.date.fromisoformat(x) for x in pd_] + [dt.date.fromisoformat(cal[i1])]
        gap = max((pts[j + 1] - pts[j]).days for j in range(len(pts) - 1)) / 30.44
        fy = [yrs[y] for y in full_years[lab] if y in yrs]
        per[lab] = dict(M=float(pn.sum() / span), W=float(min(fy)), L=float(sum(x < 0 for x in fy)), D=drop,
                        worst12=float(roll.min()), gap=gap, months_paid=100.0 * len({x[:7] for x in pd_}) / len(months),
                        evals_yr=sum(1 for k, kind, _, _ in ev if kind == "buy" and cal[i0] <= iso(S, k) <= cal[i1]) / span)
    out["periods"] = per
    return out


WINDOWS = {("fut", "5y"): ("last 5y", START5, "2026-12-31", [str(y) for y in range(2022, 2026)]),
           ("fut", "all"): ("2019-26", "2019-01-01", "2026-12-31", [str(y) for y in range(2020, 2026)]),
           ("cfd", "all"): ("all years", "2011-01-01", "2026-12-31", [str(y) for y in range(2012, 2026)])}


def start_k(S, window, off):
    return (first_tradable(S) if window == "all" else int(np.searchsorted(S.days, np.datetime64(START5).astype(int)))) + off


def _init(kind, dd):
    _S["kind"], _S["S"] = kind, load(kind, dd)


def _job(args):
    window, off, size, path = args
    S = _S["S"]
    k0 = start_k(S, window, off)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), ek(size), fk(size, path))
    lab, a, b, fy = WINDOWS[(_S["kind"], window)]
    res = {}
    for fee_path in ("standard", "noact"):
        cash = cash_flows(S, k0, ev, fee_path, size)
        res[fee_path] = summarise_run(S, k0, cash, ev, [(lab, a, b)], {lab: fy})
    return (_S["kind"], window, off, size, path), res


def check(S):
    """summarise_run on a flat eval price equals research5.metrics for Lucid's plan (one start date)."""
    k0 = start_k(S, "5y", 0)
    ev = R4.sim_pool(S, 5, 10, k0, len(S.days), dict(R4.E_KW, cons=0.5), dict(R4.F_KW, max_pay=4))
    fee = USER_EVAL[50] + USER_ADDON  # the user's 50K eval with the add-on
    mine = summarise_run(S, k0, cash_flows(S, k0, ev, "standard", 50, fee_per_buy=fee), ev,
                         R5.P_5Y, {"last 5y": R5.FULL5["last 5y"]})["periods"]["last 5y"]
    ref = R5.metrics([("nq", S, k0, ev)], R5.FULL5, R5.P_5Y, fee)["periods"]["last 5y"]
    for key in ("M", "W", "L", "D", "worst12", "gap", "months_paid", "evals_yr"):
        assert abs(mine[key] - ref[key]) < 1e-6, (key, mine[key], ref[key])
    print(f"check passed: the summary equals research5.metrics on Lucid's plan (${ref['M']:,.0f} a year from {iso(S, k0)})", flush=True)


def main(fd, dd, out):
    os.makedirs(out, exist_ok=True)
    res = {}
    for kind, data, windows in (("fut", fd, ("5y", "all")), ("cfd", dd, ("all",))):
        if kind == "fut":
            check(load("fut", data))
        jobs = [(w, o, s, p) for w in windows for s in SIZES for p in ("standard", "consistency") for o in OFF]
        with Pool(4, initializer=_init, initargs=(kind, data)) as pool:
            res.update(dict(pool.map(_job, jobs, chunksize=2)))
        print(f"{kind}: {len(jobs)} runs", flush=True)
    json.dump({"|".join(map(str, k)): v for k, v in res.items()}, open(os.path.join(out, "runs.json"), "w"))
    write_tables(out, fd, dd)


WIN_LABEL = {"last 5y": "futures, last 5 years", "2019-26": "futures, from Aug 30 2019", "all years": "CFD, from Feb 2011"}
WIN_ID = {"last 5y": "5y", "2019-26": "2019", "all years": "2011"}
FIRST = {"last 5y": "from Nov 15", "2019-26": "from Aug 30", "all years": "from Feb 15"}
LAST = {"last 5y": "to Nov 17", "2019-26": "to Nov 17", "all years": "to Nov 13"}


def write_csv(out, name, rows):
    with open(os.path.join(out, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {name}: {len(rows)} rows", flush=True)


def accounts(fd):
    """Funded accounts (XFA) started every 10 sessions over the last 5 years on real futures, each traded alone to its
    end or to the end of the data: what each payout path does to one account."""
    S = load("fut", fd)
    k0 = int(np.searchsorted(S.days, np.datetime64(START5).astype(int)))
    rows = []
    for size in SIZES:
        for path in ("standard", "consistency"):
            npay, life, wait, opened, bal_open, paid_usd = [], [], [], 0, [], []
            for ks in range(k0, len(S.days) - 250, 10):
                f = FundedAccount(S, **fk(size, path))
                k, last, longest, amt_sum, evn = ks, ks, 0, 0.0, None
                while k < len(S.days):
                    evn, amt = f.step(S.days[k])
                    if amt > 0:
                        longest, last, amt_sum = max(longest, k - last), k, amt_sum + amt
                    if evn is not None:
                        break
                    k += 1
                k = min(k, len(S.days) - 1)
                longest = max(longest, k - last)
                npay.append(f.npay)
                life.append(k - ks + (1 if evn is not None else 0))
                wait.append(longest)
                paid_usd.append(amt_sum)
                if evn is None:
                    opened += 1
                    bal_open.append(f.pnl)
            n = len(npay)
            rows.append(dict(id=f"{size}-{path}", size=f"{size}K", payout_path=PAY_LABEL[path], accounts=n,
                             with_payout_pct=round(100 * float(np.mean([x > 0 for x in npay])), 1),
                             payouts_median=float(np.median(npay)), payouts_mean=round(float(np.mean(npay)), 2), payouts_max=int(max(npay)),
                             paid_per_account_usd=round(float(np.mean(paid_usd))), life_median_sessions=float(np.median(life)),
                             longest_wait_median_sessions=float(np.median(wait)), longest_wait_max_sessions=int(max(wait)),
                             still_open_pct=round(100 * opened / n, 1),
                             open_balance_mean_usd=round(float(np.mean(bal_open))) if bal_open else 0))
    return rows


def rules_rows():
    def r(rid, item, vals, unit, note=""):
        return dict(id=rid, item=item, k50=vals[0], k100=vals[1], k150=vals[2], unit=unit, note=note)
    return [r("price_standard", "Trading Combine per month, Standard fee path", [PRICE["standard"][s] for s in SIZES], "usd", "a reset costs the same"),
            r("price_noact", "Trading Combine per month, No Activation Fee path", [PRICE["noact"][s] for s in SIZES], "usd", "a reset costs the same"),
            r("target", "Combine profit target", [TS[s]["target"] for s in SIZES], "usd"),
            r("mll", "Combine Maximum Loss Limit, end-of-day trailing", [TS[s]["mll"] for s in SIZES], "usd", "stops trailing at the starting balance"),
            r("best_day", "Combine best-day limit", [55, 55, 55], "pct", "of the total profit; above it the target rises to the best day / 0.55"),
            r("min_days", "Combine minimum trading days", [2, 2, 2], "count", "always met under the best-day limit"),
            r("max_micros", "Combine maximum position, micros", [TS[s]["evalmax"] for s in SIZES], "count", "or minis at 10 micros each"),
            r("activation", "XFA activation fee, Standard fee path", [ACTIVATION["standard"]] * 3, "usd", "$0 on the No Activation Fee path"),
            r("xfa_mll", "XFA Maximum Loss Limit, end-of-day trailing", [TS[s]["mll"] for s in SIZES], "usd",
              "the XFA starts at a $0 balance; the limit stops trailing at $0 and is $0 after any payout"),
            r("cap_standard", "XFA payout cap, Standard payout path", [CAP["standard"][s] for s in SIZES], "usd",
              "after 5 winning days since the last payout; up to 50% of the balance"),
            r("qday", "Winning day on the Standard payout path", [TS[s]["qday"] for s in SIZES], "usd", "or more"),
            r("cap_consistency", "XFA payout cap, Consistency payout path", [CAP["consistency"][s] for s in SIZES], "usd",
              "after 3 traded days, the best day at most 40% of the profit since the last payout; up to 50% of the balance"),
            r("pay_min", "Minimum payout", [125, 125, 125], "usd", f"the backtest requests once an account is ${2 * PAY_MIN:,.0f} up"),
            r("split", "Profit split to you", [90, 90, 90], "pct"),
            r("max_xfa", "Funded accounts (XFA) at once", [5, 5, 5], "count", "Combines: no limit")]


def cap_rows(fd, dd):
    """How often the funded leg cap binds: sessions where the indicator's size, round(350 x max loss / $1,000 / ADR) MNQ
    a leg, is above 6 / 10 / 10 micros, by data set and calendar year from the first tradable session, plus the last 5
    years on futures. The median ADR (NQ points) shows why: NQ moved far fewer points before 2020."""
    from account import funded_size
    rows = []
    for kind, data, name in (("fut", fd, "futures"), ("cfd", dd, "CFD")):
        S = load(kind, data)
        k0, k5 = first_tradable(S), int(np.searchsorted(S.days, np.datetime64(START5).astype(int)))
        groups = {}
        for k in range(k0, len(S.days)):
            adr = S.S[S.days[k]]["adr"]
            if np.isnan(adr):
                continue
            keys = [iso(S, k)[:4]] + (["last 5y"] if kind == "fut" and k >= k5 else [])
            for g in keys:
                groups.setdefault(g, []).append((k, adr))
        for g in sorted(groups, key=lambda x: (x == "last 5y", x)):
            ks = groups[g]
            first, last = (dt.date.fromisoformat(iso(S, ks[j][0])) for j in (0, -1))
            day = lambda x: f"{x:%b} {x.day}"  # noqa: E731
            label = (f"Last 5 years ({day(first)} {first.year} to {day(last)} {last.year})" if g == "last 5y" else
                     g + (f" (from {day(first)})" if ks[0][0] == k0 else f" (to {day(last)})" if ks[-1][0] == len(S.days) - 1 else ""))
            row = dict(id=f"{kind}-{g.replace(' ', '')}", data=name, period=label, sessions=len(ks),
                       median_adr_points=round(float(np.median([a for _, a in ks])), 1))
            for size in SIZES:
                m = TS[size]["mll"] / 1000.0
                row[f"capped_{size}k"] = sum(funded_size(a, 350.0 * m, nmax=10 ** 6) > TS[size]["fundmax"] for _, a in ks)
            rows.append(row)
    return rows


def write_tables(out, fd, dd=None):
    raw = json.load(open(os.path.join(out, "runs.json")))
    res = {}
    for key, v in raw.items():
        kind, window, off, size, path = key.split("|")
        res[(kind, window, int(off), int(size), path)] = v
    rows, yrows = [], []
    for (kind, window), (lab, _, _, _) in WINDOWS.items():
        for size in SIZES:
            for path in ("standard", "consistency"):
                for fee_path in ("standard", "noact"):
                    R = [res[(kind, window, o, size, path)][fee_path] for o in OFF]
                    g = lambda key: float(np.mean([r["periods"][lab][key] for r in R]))  # noqa: E731
                    ev = lambda key: float(np.mean([r["evals"][key] for r in R]))  # noqa: E731
                    fu = lambda key: float(np.mean([r["funded"][key] for r in R]))  # noqa: E731
                    cid = f"{size}-{path}-{fee_path}"
                    rows.append(dict(id=f"{WIN_ID[lab]}-{cid}", window_id=WIN_ID[lab], config=cid, window=WIN_LABEL[lab],
                                     size=f"{size}K", payout_path=PAY_LABEL[path], fee_path=FEE_LABEL[fee_path],
                                     net_per_year_usd=round(g("M")), worst_full_year_usd=round(g("W")),
                                     losing_full_years=round(g("L"), 2), deepest_drop_usd=round(g("D")),
                                     worst_12_months_usd=round(g("worst12")), longest_gap_months=round(g("gap"), 1),
                                     months_with_payout_pct=round(g("months_paid"), 1), evals_per_year=round(g("evals_yr"), 1),
                                     most_cash_out_usd=round(float(np.mean([r["cash_low"] for r in R]))),
                                     eval_pass_pct=round(100 * ev("passed") / max(ev("passed") + ev("failed"), 1e-9), 1),
                                     funded_with_payout_pct=round(100 * fu("with_payout") / max(fu("started"), 1e-9), 1),
                                     payouts=round(fu("payouts"), 1),
                                     average_payout_usd=round(fu("payouts_usd") / max(fu("payouts"), 1e-9))))
                    years = sorted({y for r in R for y in r["years"]})
                    for y in years:
                        v = [r["years"][y] for r in R if y in r["years"]]
                        yl = y + (f" ({FIRST[lab]})" if y == years[0] else f" ({LAST[lab]})" if y == years[-1] else "")
                        yrows.append(dict(window_id=WIN_ID[lab], config=cid, size=f"{size}K", payout_path=PAY_LABEL[path],
                                          fee_path=FEE_LABEL[fee_path], year=y, year_label=yl, net_median_usd=round(float(np.median(v))),
                                          net_low_usd=round(min(v)), net_high_usd=round(max(v))))
    write_csv(out, "topstep.csv", rows)
    write_csv(out, "topstep_years.csv", yrows)
    write_csv(out, "topstep_rules.csv", rules_rows())
    write_csv(out, "topstep_accounts.csv", accounts(fd))
    if dd is not None:
        write_csv(out, "topstep_cap.csv", cap_rows(fd, dd))
    for r in rows:
        print(f"{r['id']:22s} net ${r['net_per_year_usd']:>8,}/yr worst yr ${r['worst_full_year_usd']:>8,} worst 12m "
              f"${r['worst_12_months_usd']:>8,} drop ${r['deepest_drop_usd']:>8,} cash out ${r['most_cash_out_usd']:>7,}", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "--tables":  # topstep_sim.py --tables FUT_DATA_DIR CFD_DATA_DIR OUT_DIR: the tables again from runs.json
        write_tables(sys.argv[4], sys.argv[2], sys.argv[3])
    else:
        main(*sys.argv[1:4])
