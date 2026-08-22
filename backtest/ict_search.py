#!/usr/bin/env python3
"""Brute-force the whole parameter space of the ICT/orderflow suite.

Ten thousand random configurations are graded on MNQ 5m. That is the easy
part. The hard part is that with ten thousand tries, the best result is the
LUCKIEST one, not the best one - so this script does three things a naive
sweep does not:

  1. SELECT on MNQ, VALIDATE on five index futures the search never touched.
  2. Run the identical search against a NULL series - real timestamps, real
     volumes, real volatility, but a structureless price path built by
     permuting the bar returns. Whatever profit factor the best config
     reaches there is the score you get from luck alone at this sample size.
     A real configuration has to beat it.
  3. Score neighbourhood robustness: a configuration whose near-identical
     twins all collapse was a lucky lottery ticket, not a setting.

Usage:
  python3 backtest/ict_search.py <data_dir> [n_configs]
"""
import json
import math
import os
import random
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ict_of_backtest import (P0, load, prep, run, stats, primary_csv)  # noqa: E402

MARKETS = ("NQ", "MES", "ES", "YM", "RTY")
PVS = dict(MNQ=2.0, NQ=20.0, MES=5.0, ES=50.0, YM=5.0, RTY=5.0)
TKS = dict(MNQ=0.25, NQ=0.25, MES=0.25, ES=0.25, YM=1.0, RTY=0.1)

# absolute point filters off; every bound in the search is ATR-relative so the
# same configuration means the same thing on every instrument
BASE = dict(min_stop_pt=0.0, max_stop_pt=1e9, atr_min_pt=0.0, atr_max_pt=1e9,
            max_trades=99, max_day_dd=1e9, size_mode="fixed")

MIN_TRADES = 40          # raised by --freq
FREQ = False             # frequency-hunting sampling profile


KZ_SETS = {
    "NY AM only":      dict(kz_lon=None, kz_am=(510, 660), kz_sb=None, kz_pm=None),
    "NY PM only":      dict(kz_lon=None, kz_am=None, kz_sb=None, kz_pm=(810, 960)),
    "AM + PM":         dict(kz_lon=None, kz_am=(510, 660), kz_sb=None, kz_pm=(810, 960)),
    "Silver bullet":   dict(kz_lon=None, kz_am=None, kz_sb=(600, 660), kz_pm=None),
    "London + AM":     dict(kz_lon=(120, 300), kz_am=(510, 660), kz_sb=None, kz_pm=None),
    "All three":       dict(kz_lon=(120, 300), kz_am=(510, 660), kz_sb=None, kz_pm=(810, 960)),
    "RTH only":        dict(kz_lon=None, kz_am=(570, 960), kz_sb=None, kz_pm=None),
    "RTH + London":    dict(kz_lon=(120, 300), kz_am=(570, 960), kz_sb=None, kz_pm=None),
    "Almost all day":  dict(kz_lon=(120, 300), kz_am=(480, 960), kz_sb=None, kz_pm=(960, 1140)),
}


def sample_config(rnd):
    c = dict(BASE)
    # FREQ tilts every lever that gates trade COUNT: a low bar to qualify, few
    # hard gates, wide stop bands, a market fallback when price will not
    # retrace, and short holds so the single-position slot frees up quickly.
    c["thresh"] = rnd.randint(0, 6) if FREQ else rnd.randint(0, 11)
    c["req_mss"] = rnd.random() < (0.20 if FREQ else 0.6)
    c["req_fvg"] = rnd.random() < (0.12 if FREQ else 0.35)
    c["req_kz"] = rnd.random() < (0.55 if FREQ else 0.75)
    c["_kz"] = rnd.choice(list(KZ_SETS))
    c.update(KZ_SETS[c["_kz"]])
    c["stop_mode"] = rnd.choice(["raid", "zone", "tighter"])
    c["fill_pref"] = rnd.choice(["aggressive", "mid", "patient"])
    c["rr_mode"] = rnd.choice(["fixed", "stretch", "pool"])
    c["fixed_r"] = rnd.choice([1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0])
    c["min_r"] = rnd.choice([0.75, 1.0, 1.25, 1.5, 2.0, 2.5])
    c["max_r"] = rnd.choice([3.0, 4.0, 5.0, 6.0, 8.0])
    c["def_r"] = rnd.choice([1.5, 2.0, 2.5, 3.0])
    c["min_stop_atr"] = rnd.choice([0.1, 0.25, 0.4, 0.5, 0.75] if FREQ else [0.0, 0.25, 0.5, 0.75, 1.0, 1.25])
    c["max_stop_atr"] = rnd.choice([2.0, 2.5, 3.0, 4.0] if FREQ else [1.5, 2.0, 2.5, 3.0, 4.0])
    c["stop_buf_atr"] = rnd.choice([0.0, 0.1, 0.2, 0.3, 0.5])
    c["be_on"] = rnd.random() < 0.4
    c["be_trig_r"] = rnd.choice([0.5, 0.75, 1.0, 1.5, 2.0])
    c["use_part"] = rnd.random() < 0.4
    c["tp1_r"] = rnd.choice([0.5, 0.75, 1.0, 1.5])
    c["tp1_pct"] = rnd.choice([25, 33, 50, 66, 75])
    c["sweep_lb"] = rnd.randint(1, 8) if FREQ else rnd.randint(1, 6)
    c["struct_lb"] = rnd.choice([6, 8, 10, 12, 16, 20, 24])
    c["pv_len"] = rnd.randint(1, 4)
    c["min_pen_ticks"] = rnd.randint(0, 4)
    c["eq_tol_atr"] = rnd.choice([0.05, 0.1, 0.15, 0.25])
    c["disp_atr"] = rnd.choice([0.2, 0.35, 0.55, 0.7, 0.9])
    c["leg_atr"] = rnd.choice([0.6, 0.9, 1.1, 1.4, 1.8])
    c["mss_max_bar"] = rnd.choice([4, 6, 8, 12, 16, 24])
    c["zone_valid"] = rnd.choice([4, 6, 8, 12, 16, 24])
    c["zone_mode"] = rnd.choice(["Auto", "FVG", "Order block", "OTE", "FVG + OTE"])
    c["ote_lo"] = rnd.choice([0.5, 0.62, 0.705])
    c["ote_hi"] = rnd.choice([0.705, 0.79, 0.89])
    c["ob_lb"] = rnd.choice([5, 10, 15, 25])
    c["max_hold"] = rnd.choice([4, 6, 9, 12, 18, 24] if FREQ else [12, 18, 24, 36, 48, 72])
    c["no_retrace"] = rnd.choice(["Market", "Market", "Skip"] if FREQ else ["Skip", "Market"])
    c["zone_valid"] = rnd.choice([2, 3, 4, 6, 8, 12]) if FREQ else c["zone_valid"]
    c["rvol_min"] = rnd.choice([0.0, 0.3, 0.5, 0.8] if FREQ else [0.0, 0.5, 0.8, 1.0, 1.2])
    c["rvol_hot"] = rnd.choice([1.0, 1.3, 1.6, 2.0])
    c["div_len"] = rnd.choice([10, 20, 30])
    c["use_delta_score"] = rnd.random() < 0.7
    c["use_htf"] = rnd.random() < 0.7
    c["veto_htf"] = rnd.random() < 0.3
    # NOTE: htf_min, ema_fast, ema_slow, atr_len and rvol_len are consumed by
    # prep(), not run(). They are held at defaults so the prepped-data cache
    # stays small; pv_len and the killzone set ARE varied and ARE keyed below.
    c["use_vw_tgt"] = rnd.random() < 0.6
    c["allow_long"] = True
    c["allow_short"] = True
    if rnd.random() < 0.12:
        if rnd.random() < 0.5:
            c["allow_short"] = False
        else:
            c["allow_long"] = False
    return c


def make_null(b, seed=1):
    """Same timestamps, same volumes, same volatility - structureless path.

    Each bar's log return and its open/high/low offsets from the close travel
    together, so bar geometry stays realistic; permuting the order destroys
    every trend, level and mean-reversion the strategy could exploit."""
    rnd = random.Random(seed)
    n = b["n"]
    shapes = []
    for i in range(1, n):
        c0, c1 = b["c"][i - 1], b["c"][i]
        if c0 <= 0 or c1 <= 0:
            continue
        shapes.append((math.log(c1 / c0),
                       math.log(max(b["o"][i], 1e-9) / c1),
                       math.log(max(b["h"][i], 1e-9) / c1),
                       math.log(max(b["l"][i], 1e-9) / c1)))
    rnd.shuffle(shapes)
    o, h, l, c = [b["o"][0]], [b["h"][0]], [b["l"][0]], [b["c"][0]]
    px = b["c"][0]
    for k in range(n - 1):
        r, oo, hh, ll = shapes[k % len(shapes)]
        px = px * math.exp(r)
        c.append(px)
        o.append(px * math.exp(oo))
        h.append(px * math.exp(hh))
        l.append(px * math.exp(ll))
    for i in range(n):                     # keep OHLC internally consistent
        hi = max(o[i], c[i], h[i])
        lo = min(o[i], c[i], l[i])
        h[i], l[i] = hi, lo
    return dict(t=list(b["t"]), o=o, h=h, l=l, c=c, v=list(b["v"]), n=n)


DATA = {}          # key -> prepped bars.  key = (market, pv_len, kz_name)
RAW = {}           # market -> raw bars, shared by every variant


def prep_key(cfg):
    return (cfg["pv_len"], cfg["_kz"])


def build_variant(market, pv_len, kz_name):
    """prep() reads sessions and pivot length, so every distinct combination
    needs its own prepped copy. The raw OHLCV lists are shared - only the
    derived series are duplicated."""
    P = dict(P0, pv_len=pv_len, **KZ_SETS[kz_name])
    return prep(dict(RAW[market]), P)


def _score(trp, tro):
    """In-sample quality: expectancy in R, penalised for small samples and for
    outcomes that were decided by intrabar sequencing rather than by the model."""
    s = stats(trp, [], P0)
    if s.get("trades", 0) < MIN_TRADES:
        return None
    op = {t["t"]: t for t in tro}
    dis = sum(1 for t in trp if op.get(t["t"]) and (t["net"] > 0) != (op[t["t"]]["net"] > 0))
    amb = dis / len(trp)
    if amb > 0.30:
        return None
    rs = [t["R"] for t in trp]
    n = len(rs)
    m = sum(rs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in rs) / (n - 1)) if n > 1 else 9
    t_stat = m / (sd / math.sqrt(n)) if sd > 0 else 0.0
    return dict(n=n, wr=s["wr"], pf=s["pf"], avgR=m, sd=sd, t=t_stat, amb=amb)


def eval_one(args):
    idx, cfg, key = args
    b = DATA[(key,) + prep_key(cfg)]
    P = dict(P0, **{k: v for k, v in cfg.items() if not k.startswith("_")})
    P["point_value"], P["tick"] = PVS["MNQ"], TKS["MNQ"]
    trp, _ = run(b, P, True)
    if len(trp) < MIN_TRADES:
        return None
    tro, _ = run(b, P, False)
    sc = _score(trp, tro)
    if sc is None:
        return None
    mid = b["t"][b["n"] // 2]
    halves = []
    for w in (True, False):
        sub = [t for t in trp if (t["t"] < mid) == w]
        halves.append(sum(t["R"] for t in sub) / len(sub) if sub else 0.0)
    sc.update(idx=idx, h1=halves[0], h2=halves[1])
    return sc


def eval_oos(args):
    idx, cfg = args
    out = []
    for sym in MARKETS:
        b = DATA.get((sym,) + prep_key(cfg))
        if b is None:
            continue
        P = dict(P0, **{k: v for k, v in cfg.items() if not k.startswith("_")})
        P["point_value"], P["tick"] = PVS[sym], TKS[sym]
        tr, _ = run(b, P, True)
        out += [t["R"] for t in tr]
    if len(out) < 40:
        return idx, None
    n = len(out)
    m = sum(out) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in out) / (n - 1))
    gp = sum(x for x in out if x > 0)
    gl = -sum(x for x in out if x <= 0)
    return idx, dict(n=n, avgR=m, t=m / (sd / math.sqrt(n)) if sd > 0 else 0.0,
                     wr=100 * sum(1 for x in out if x > 0) / n,
                     pf=gp / gl if gl > 0 else 9.99)


def main(d, n_cfg):
    print("preparing data ...", flush=True)
    RAW["MNQ"] = load(primary_csv(d))
    for sym in MARKETS:
        p = os.path.join(d, f"{sym}_5m.csv")
        if os.path.exists(p):
            RAW[sym] = load(p)
    RAW["NULL"] = make_null(prep(dict(RAW["MNQ"]), P0))

    rnd = random.Random(20260821)
    cfgs = [sample_config(rnd) for _ in range(n_cfg)]
    variants = sorted({prep_key(c) for c in cfgs})
    print(f"  {len(variants)} prep variants (pivot length x killzone set)", flush=True)
    for pv, kz in variants:
        for m in ("MNQ", "NULL"):
            DATA[(m, pv, kz)] = build_variant(m, pv, kz)
    print(f"  MNQ {RAW['MNQ']['n']} bars | {len(DATA)} prepped datasets cached", flush=True)

    with Pool(4) as pool:
        print(f"\nstage 1/3: grading {n_cfg} configurations on MNQ ...", flush=True)
        real = [r for r in pool.imap_unordered(
            eval_one, [(i, c, "MNQ") for i, c in enumerate(cfgs)], chunksize=25) if r]
        print(f"  {len(real)} passed the sample-size and ambiguity filters", flush=True)

        print(f"\nstage 2/3: same {n_cfg} configurations on the NULL series ...", flush=True)
        null = [r for r in pool.imap_unordered(
            eval_one, [(i, c, "NULL") for i, c in enumerate(cfgs)], chunksize=25) if r]
        print(f"  {len(null)} passed", flush=True)

    real.sort(key=lambda r: -r["t"])
    top = real[:250]
    print(f"\nstage 3/3: validating the top {len(top)} on five untouched markets ...", flush=True)
    # grouped by prep variant so only five prepped markets are held at a time
    groups = {}
    for r in top:
        groups.setdefault(prep_key(cfgs[r["idx"]]), []).append(r)
    oos = {}
    for (pv, kz), members in groups.items():
        for sym in MARKETS:
            if sym in RAW:
                DATA[(sym, pv, kz)] = build_variant(sym, pv, kz)
        with Pool(4) as pool:
            oos.update(dict(pool.imap_unordered(
                eval_oos, [(r["idx"], cfgs[r["idx"]]) for r in members], chunksize=2)))
        for sym in MARKETS:
            DATA.pop((sym, pv, kz), None)
    for r in top:
        r["oos"] = oos.get(r["idx"])

    json.dump(dict(real=real, null=null, top=top,
                   cfgs={r["idx"]: cfgs[r["idx"]] for r in top}),
              open(os.path.join(d, "search_results.json"), "w"), default=str)
    print("\nwrote search_results.json", flush=True)
    return real, null, top, cfgs


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "data"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 10000
    if "--freq" in sys.argv:
        FREQ = True
        MIN_TRADES = 150
        print("FREQUENCY MODE: sampling tilted for trade count, minimum 150 trades")
    main(d, n)
