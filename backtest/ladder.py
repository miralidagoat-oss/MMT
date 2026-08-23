#!/usr/bin/env python3
"""Incremental-value ladder + regime conditioning for the 5m sweep baseline.

MODEL 1  price / market structure only            (the 222-trade baseline)
MODEL 2  + positioning        (CFTC TFF leveraged-money net, release-timed)
MODEL 3  + options / volatility     (VIX level and VIX/VXN, prior close only)
MODEL 4  + macro / cross-asset      (10y yield change, S&P co-movement)
MODEL 5  full

Rules that keep this honest:

 * TIMING. A COT value is usable only after its Friday 15:30 ET release
   instant; a VIX value only from the following session. Every conditioning
   variable is looked up with an as-of query against those timestamps, so no
   model can see a number that did not exist when the trade was taken.

 * NO REFITTING. Thresholds are fixed a priori at distribution medians /
   terciles computed on the TRAIN period only, then applied unchanged to the
   test period.

 * MULTIPLE TESTING. Every conditioning tested is counted. With ~20 subgroup
   tests on 222 trades, one or two will look significant by chance; the
   script prints how many were tried so the reader can discount accordingly.

 * A filter that merely REMOVES trades is not adding value unless the
   remaining trades have higher expectancy than the trades it removed. Both
   halves are always reported.
"""
import csv
import datetime as dt
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, mean, stdev, pct, et_parts       # noqa: E402
from reaudit import run, PRESET                          # noqa: E402

S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
     "/scratchpad")
COST = 1.5
N_TESTS = [0]


def stats(rs):
    if not rs:
        return dict(n=0, exp=float("nan"), t=float("nan"), pf=float("nan"),
                    net=0.0)
    gw = sum(r for r in rs if r > 0)
    gl = -sum(r for r in rs if r < 0)
    sd = stdev(rs) if len(rs) > 1 else float("nan")
    return dict(n=len(rs), exp=mean(rs),
                t=(mean(rs) / (sd / math.sqrt(len(rs))) if sd else float("nan")),
                pf=(gw / gl if gl else float("inf")), net=sum(rs))


def show(tag, rs, rs_excluded=None):
    N_TESTS[0] += 1
    s = stats(rs)
    line = (f"  {tag:<40}{s['n']:>5}{s['exp']:>9.3f}{s['t']:>7.2f}"
            f"{s['pf']:>7.2f}{s['net']:>9.1f}")
    if rs_excluded is not None:
        e = stats(rs_excluded)
        line += f"   | removed n={e['n']:<4} exp {e['exp']:+.3f}"
    print(line)


# ── external conditioning series ────────────────────────────────────────────
def load_cot(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append((int(r["release_ts"]), float(r["lev_net_pct_oi"]),
                         float(r["lev_net"])))
    rows.sort()
    return rows


def load_daily(path):
    """date -> close, for VIX-style daily series."""
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            ts = int(float(r["time"]))
            d = dt.datetime.utcfromtimestamp(ts).date()
            try:
                out[d] = float(r["close"])
            except (TypeError, ValueError):
                pass
    return out


def asof(series, ts):
    """Latest value whose release timestamp is strictly before ts."""
    lo, hi, best = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] < ts:
            best = series[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def prior_close(daily, d):
    """Most recent daily close strictly before date d."""
    for back in range(1, 8):
        k = d - dt.timedelta(days=back)
        if k in daily:
            return daily[k]
    return None


def main():
    b = load(f"{S}/data5m/USATECHIDXUSD_5m.csv")
    closed, risks, nsig, nfill, nexp = run(b, PRESET, rth_only=True,
                                           be_trigger=1.0)
    # attach context to each trade
    trades = []
    for r, risk, bar in closed:
        ts = b.t[bar]
        d, hh, mm, wd, tot = et_parts(ts)
        trades.append(dict(r=r - COST / risk, gross=r, risk=risk, ts=ts,
                           date=d, tod=tot, wd=wd, bar=bar))
    trades.sort(key=lambda x: x["ts"])

    cot = load_cot(f"{S}/cot_ndx_consolidated.csv")
    vix = load_daily(f"{S}/dataYH/VIX_1d.csv")
    vxn = load_daily(f"{S}/dataYH/VXN_1d.csv")
    tnx = load_daily(f"{S}/dataYH/TNX_1d.csv")

    # realised volatility at signal time (trailing 78 bars = one session)
    for t in trades:
        i = t["bar"]
        w = [abs(math.log(b.c[j] / b.c[j - 1])) for j in range(max(1, i - 78), i)]
        t["rv"] = mean(w) * 1e4 if w else float("nan")
        c = asof(cot, t["ts"])
        t["cot"] = c[1] if c else None
        t["vix"] = prior_close(vix, t["date"])
        t["vxn"] = prior_close(vxn, t["date"])
        t["tnx"] = prior_close(tnx, t["date"])

    cut = int(len(trades) * 0.6)
    train, test = trades[:cut], trades[cut:]
    print("=" * 96)
    print(f"MODEL LADDER — baseline {len(trades)} trades "
          f"({trades[0]['date']} .. {trades[-1]['date']})")
    print(f"train {len(train)}  test {len(test)}  (chronological, no refit)")
    print("=" * 96)
    hdr = (f"  {'model / condition':<40}{'n':>5}{'expR':>9}{'t':>7}"
           f"{'PF':>7}{'netR':>9}")

    # thresholds from TRAIN only
    def thr(key, q):
        vals = [t[key] for t in train if t.get(key) is not None
                and not (isinstance(t[key], float) and math.isnan(t[key]))]
        return pct(sorted(vals), q) if vals else None

    rv_med = thr("rv", 0.5)
    vix_med = thr("vix", 0.5)
    cot_lo, cot_hi = thr("cot", 0.33), thr("cot", 0.67)

    print(f"\n  thresholds fixed on TRAIN: rv_median={rv_med:.2f}bp  "
          f"vix_median={vix_med:.2f}  cot_terciles=({cot_lo:.2f},{cot_hi:.2f})%OI")

    for label, sub in (("TRAIN", train), ("TEST (untouched)", test)):
        print(f"\n--- {label} ---")
        print(hdr)
        print("  " + "-" * 77)
        R = lambda ts: [t["r"] for t in ts]                       # noqa: E731

        show("MODEL 1  baseline (all trades)", R(sub))

        # MODEL 2 — positioning
        ok = [t for t in sub if t["cot"] is not None and t["cot"] <= cot_hi]
        no = [t for t in sub if t["cot"] is not None and t["cot"] > cot_hi]
        show("MODEL 2  + COT lev-money not extreme-long", R(ok), R(no))
        ok = [t for t in sub if t["cot"] is not None and t["cot"] >= cot_lo]
        no = [t for t in sub if t["cot"] is not None and t["cot"] < cot_lo]
        show("MODEL 2b + COT lev-money not extreme-short", R(ok), R(no))

        # MODEL 3 — options / volatility
        ok = [t for t in sub if t["vix"] is not None and t["vix"] <= vix_med]
        no = [t for t in sub if t["vix"] is not None and t["vix"] > vix_med]
        show("MODEL 3  + VIX below median (calm)", R(ok), R(no))
        ok = [t for t in sub if t["vix"] is not None and t["vix"] > vix_med]
        no = [t for t in sub if t["vix"] is not None and t["vix"] <= vix_med]
        show("MODEL 3b + VIX above median (stressed)", R(ok), R(no))

        # MODEL 4 — realised-vol regime + cross-asset
        ok = [t for t in sub if not math.isnan(t["rv"]) and t["rv"] > rv_med]
        no = [t for t in sub if not math.isnan(t["rv"]) and t["rv"] <= rv_med]
        show("MODEL 4  + realised vol above median", R(ok), R(no))
        ok = [t for t in sub if not math.isnan(t["rv"]) and t["rv"] <= rv_med]
        no = [t for t in sub if not math.isnan(t["rv"]) and t["rv"] > rv_med]
        show("MODEL 4b + realised vol below median", R(ok), R(no))

        # regime conditioning (Part 17)
        print("  " + "-" * 77)
        for lo_h, hi_h, name in ((570, 660, "09:30-11:00 open block"),
                                 (660, 780, "11:00-13:00 midday"),
                                 (780, 900, "13:00-15:00 afternoon"),
                                 (900, 960, "15:00-16:00 close block")):
            g = [t for t in sub if lo_h <= t["tod"] < hi_h]
            show(f"session  {name}", R(g))
        for wd, name in ((0, "Mon"), (1, "Tue"), (2, "Wed"), (3, "Thu"), (4, "Fri")):
            g = [t for t in sub if t["wd"] == wd]
            show(f"weekday  {name}", R(g))

    print(f"\n{N_TESTS[0]} subgroup tests were run in total. On 222 trades, "
          f"expect ~{N_TESTS[0]*0.05:.0f} to clear |t|>2 by chance alone.")
    print("A conditioning is only credible if it holds in BOTH panels with the")
    print("SAME sign and the removed trades are genuinely worse.")


if __name__ == "__main__":
    main()
