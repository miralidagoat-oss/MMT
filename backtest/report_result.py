#!/usr/bin/env python3
"""Headline reporting under PROTOCOL v1.3b §6, §7 and §11.

Every headline number in this project goes through here, so the rules are
applied by code rather than remembered:

  §6  frequency is measured per CME TRADE DAY. The 9 time-of-day buckets are
      diagnostic and are never used as a frequency denominator - doing so would
      turn 2-3 trades/day into "20-27 per session".
  §7  three dependence scales are ALWAYS computed, and the headline respects the
      MOST CONSERVATIVE dependence-aware interval. Block lengths {5,10,20} are
      predeclared; the one that produces significance is never chosen.
  §11 failure criteria are evaluated mechanically. INCONCLUSIVE is a permitted
      outcome and is not retried with adjusted thresholds.
"""
import datetime as dt
import math
import random
import statistics as st
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
Z = 1.959964
BLOCK_LENGTHS = (5, 10, 20)          # predeclared, fixed
STATIONARY_MEAN_BLOCK = 5
N_BOOT = 2000
FREQ_FLOOR = 1.0                     # §11 failure floor, trades per trade day

# §6 diagnostic buckets, in minutes since the 18:00 ET session open
BUCKETS = (("overnight", 0, 480), ("london", 480, 780), ("premarket", 780, 930),
           ("ny_open", 930, 990), ("ny_morning", 990, 1080),
           ("midday", 1080, 1200), ("ny_afternoon", 1200, 1260),
           ("power_hour", 1260, 1320), ("post", 1320, 1440))


def trade_day(ts):
    """CME trade day: 18:00 ET rolls into the next day."""
    return (dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(ET)
            + dt.timedelta(hours=6)).date()


def mspo(ts):
    """Minutes since the 18:00 ET session open."""
    e = dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(ET)
    return (e.hour * 60 + e.minute + 360) % 1440


def _mean(v):
    return sum(v) / len(v) if v else 0.0


def cr1_se(by_day, n, mean):
    """Cluster-robust SE with the CR1 finite-sample correction, clustering on
    trade day. For a simple mean the meat is the sum of within-cluster residual
    sums, squared."""
    g = len(by_day)
    if g < 2:
        return float("nan")
    meat = sum(sum(x - mean for x in day) ** 2 for day in by_day.values())
    # CR1 = G/(G-1) * (n-1)/(n-K). Estimating only a mean makes K=1, so the
    # second factor is exactly 1 and is omitted rather than written as (n-1)/(n-1).
    return math.sqrt(g / (g - 1) * meat) / n


def _pct(v, lo=2.5, hi=97.5):
    v = sorted(v)
    n = len(v)
    return (v[max(0, int(n * lo / 100))], v[min(n - 1, int(n * hi / 100))])


def day_bootstrap(days, rng, reps=N_BOOT):
    """Resample whole trade days with replacement: preserves intraday structure,
    destroys multi-day dependence."""
    keys = list(days)
    out = []
    for _ in range(reps):
        pool = []
        for _ in range(len(keys)):
            pool.extend(days[keys[rng.randrange(len(keys))]])
        if pool:
            out.append(_mean(pool))
    return _pct(out)


def moving_block_bootstrap(ordered_days, days, L, rng, reps=N_BOOT):
    """Contiguous blocks of L trade days, preserving dependence up to length L."""
    m = len(ordered_days)
    if m <= L:
        return (float("nan"), float("nan"))
    nblocks = max(1, m // L)
    out = []
    for _ in range(reps):
        pool = []
        for _ in range(nblocks):
            s = rng.randrange(m - L + 1)
            for d in ordered_days[s:s + L]:
                pool.extend(days[d])
        if pool:
            out.append(_mean(pool))
    return _pct(out) if out else (float("nan"), float("nan"))


def stationary_bootstrap(ordered_days, days, mean_block, rng, reps=N_BOOT):
    """Politis-Romano: geometric block lengths, so the resample is stationary."""
    m = len(ordered_days)
    p = 1.0 / mean_block
    out = []
    for _ in range(reps):
        pool = []
        while len(pool) < sum(len(days[d]) for d in ordered_days) * 0.9:
            i = rng.randrange(m)
            while True:
                pool.extend(days[ordered_days[i]])
                i = (i + 1) % m
                if rng.random() < p:
                    break
        if pool:
            out.append(_mean(pool))
    return _pct(out) if out else (float("nan"), float("nan"))


def summarize(log, bars, label="", seed=20260913, eligible_days=None):
    """One headline block. `log` is the engine's outcome_log; `bars` supplies
    timestamps so trades can be placed on trade days and in buckets."""
    t = bars["t"]
    rows = [(trade_day(t[x["bar"]]), mspo(t[x["bar"]]), x["r"], x["dir"]) for x in log]
    if not rows:
        return {"label": label, "n": 0, "verdict": "NO TRADES"}
    rs = [r for _, _, r, _ in rows]
    n = len(rs)
    mean = _mean(rs)
    sd = st.stdev(rs) if n > 1 else float("nan")

    days = {}
    for d, _, r, _ in rows:
        days.setdefault(d, []).append(r)
    ordered = sorted(days)
    # GATE 2: the denominator is the set of trade dates that actually contain
    # evaluation-eligible bars, supplied by partitions.load(). Numerator and
    # denominator must describe the same population.
    #
    # The V1 defect: this counted every trade day among the LOADED bars, warm-up
    # included (706 rather than 685), so trades were divided by days on which no
    # trade could be evaluated. Every V1 frequency was understated by ~3%.
    if eligible_days is None:
        raise ValueError(
            "summarize() requires eligible_days (GATE 2). Pass the third value "
            "from partitions.load(); deriving it from the loaded bars silently "
            "includes warm-up days and understates frequency.")
    n_days = len(eligible_days) if not isinstance(eligible_days, int) \
        else eligible_days

    rng = random.Random(seed)
    naive_se = sd / math.sqrt(n) if n > 1 else float("nan")
    scales = {
        "naive_trade": (mean - Z * naive_se, mean + Z * naive_se),
        "cr1_day_cluster": None,
        "day_block": day_bootstrap(days, rng),
        "stationary_5d": stationary_bootstrap(ordered, days,
                                              STATIONARY_MEAN_BLOCK, rng),
    }
    cse = cr1_se(days, n, mean)
    scales["cr1_day_cluster"] = (mean - Z * cse, mean + Z * cse)
    for L in BLOCK_LENGTHS:
        scales[f"moving_block_{L}d"] = moving_block_bootstrap(ordered, days, L, rng)

    # §7: the headline respects the WIDEST dependence-aware interval. The naive
    # trade-level scale is reported but is never the headline.
    dep = {k: v for k, v in scales.items()
           if k != "naive_trade" and v and not math.isnan(v[0])}
    widest = max(dep, key=lambda k: dep[k][1] - dep[k][0])
    lo, hi = dep[widest]

    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r < 0]
    pf = (sum(wins) / abs(sum(losses))) if losses and sum(losses) else float("inf")

    rth = [r for _, m, r, _ in rows if 930 <= m < 1320]
    buckets = {name: 0 for name, _, _ in BUCKETS}
    for _, m, _, _ in rows:
        for name, a, b in BUCKETS:
            if a <= m < b:
                buckets[name] += 1
                break

    return {"label": label, "n": n, "mean_r": mean, "sd": sd,
            "pf": pf, "win_rate": len(wins) / n,
            "trade_days_in_span": n_days,
            "trade_days_with_trades": len(days),
            "freq_per_trade_day": n / n_days if n_days else 0.0,
            "rth_trades": len(rth),
            "freq_rth_per_trade_day": len(rth) / n_days if n_days else 0.0,
            "buckets": buckets,
            "scales": scales,
            "headline_scale": widest,
            "headline_ci": (lo, hi),
            "significant": lo > 0 or hi < 0}


def render(s):
    if s["n"] == 0:
        print(f"{s['label']}: NO TRADES")
        return
    print(f"── {s['label']} " + "─" * max(0, 58 - len(s['label'])))
    print(f"  trades {s['n']:,}   mean {s['mean_r']:+.4f}R   sd {s['sd']:.3f}   "
          f"PF {s['pf']:.3f}   win {100*s['win_rate']:.1f}%")
    print(f"  frequency  {s['freq_per_trade_day']:.2f}/CME trade day "
          f"(§6 primary; floor {FREQ_FLOOR})   "
          f"{s['freq_rth_per_trade_day']:.2f}/day in RTH (secondary)")
    print(f"  span {s['trade_days_in_span']:,} trade days, "
          f"{s['trade_days_with_trades']:,} of them with a trade")
    print("  §7 dependence scales:")
    for k, v in s["scales"].items():
        if not v or math.isnan(v[0]):
            continue
        mark = "  <- HEADLINE (widest)" if k == s["headline_scale"] else ""
        note = "  (reported, never the headline)" if k == "naive_trade" else ""
        print(f"    {k:<20} [{v[0]:+.4f}, {v[1]:+.4f}]{mark}{note}")
    print(f"  headline CI {'EXCLUDES' if s['significant'] else 'INCLUDES'} zero")
    print("  §6 diagnostic buckets (never a frequency denominator): "
          + ", ".join(f"{k} {v}" for k, v in s["buckets"].items() if v))


def verdict(dev, stressed=None, corroboration_sign=None, plateau_ok=None):
    """§11, evaluated mechanically. Returns (verdict, reasons)."""
    fails = []
    if dev["n"] == 0:
        return "REJECT", ["no trades"]
    if dev["mean_r"] <= 0:
        fails.append(f"development expectancy {dev['mean_r']:+.4f}R is not positive")
    if not dev["significant"]:
        fails.append(f"most conservative interval ({dev['headline_scale']}) "
                     f"includes zero")
    if dev["freq_per_trade_day"] < FREQ_FLOOR:
        fails.append(f"frequency {dev['freq_per_trade_day']:.2f}/trade day "
                     f"is below the {FREQ_FLOOR} floor")
    if plateau_ok is False:
        fails.append("type-appropriate plateau test failed (§5)")
    if stressed is not None and stressed["mean_r"] <= 0:
        fails.append(f"negative at stressed friction "
                     f"({stressed['mean_r']:+.4f}R)")
    if (corroboration_sign is not None
            and corroboration_sign != (1 if dev["mean_r"] > 0 else -1)
            and not dev["significant"]):
        fails.append("sign disagreement with corroboration AND development CI "
                     "includes zero")
    if fails:
        return "REJECT", fails
    return "PASS", []
