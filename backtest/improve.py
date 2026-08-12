#!/usr/bin/env python3
"""Improvement study for the MNQ 5-minute expansion breakout.

WHY THIS EXISTS
---------------
The 220,699,136-strategy sweep searched `trigger x filter x fixed bracket`. It
never searched two things, and both have strong economic priors on a 5-minute
index system:

* **Session.** A round turn costs 1.00 index point in RTH and 1.75 overnight,
  against a median 5m ATR near 11 points. The same setup taken at 03:00 ET
  starts ~7 points of percentage-of-R further behind than at 10:00 ET, and the
  book it has to exit into is thinner. The original search *could* select
  session filters, but it scored them with the noise floor of a 220M search
  sitting on top - a 2-3% expectancy effect is invisible at that depth.
* **Trade management.** A breakout that paid +1R and handed it all back is a
  different trade from one that never moved. A fixed bracket cannot tell them
  apart. Nothing in the sweep could express "move the stop".

Those are two unexplored dimensions with real priors, not another haystack.

METHOD - deliberately small
---------------------------
Mining 220M strategies produced nothing significant, because the null rises as
fast as the observed best. So this study does the opposite: a handful of
pre-registered hypotheses, each tested with a small grid, each selected on
TRAIN only, and every choice reported against an untouched HOLDOUT plus real
MNQ/NQ futures that were never used for anything.

Every hypothesis grid below is printed in full, including the cells that lost.
A grid where only one cell works is a fluke; a grid with a plateau is a result.

All accounting is **one position at a time** - the only version an account can
actually trade, and the version the indicator implements.

Usage:
    python3 improve.py <ndx_5m.csv> <mnq_5m.csv> <nq_5m.csv> [out_dir]
"""
import json
import os
import sys
import time
from dataclasses import dataclass, replace

import numpy as np

from features import RTH_CLOSE, RTH_OPEN, build_features
from qlib import ema, load_bars
from search import build_trades_managed

# ---------------------------------------------------------------------------
# Session windows, as ET-minute predicates. `all` is the v1 behaviour.
# ---------------------------------------------------------------------------
SESSIONS = {
    "all":        lambda et: np.ones(len(et), bool),
    "rth":        lambda et: (et >= RTH_OPEN) & (et < RTH_CLOSE),
    "rth_no_last30": lambda et: (et >= RTH_OPEN) & (et < RTH_CLOSE - 30),
    "rth_am":     lambda et: (et >= RTH_OPEN) & (et < 13 * 60),
    "rth_pm":     lambda et: (et >= 13 * 60) & (et < RTH_CLOSE),
    "premkt_rth": lambda et: (et >= 7 * 60) & (et < RTH_CLOSE),
    "euro_rth":   lambda et: (et >= 3 * 60) & (et < RTH_CLOSE),
    "no_deadzone": lambda et: (et >= 2 * 60) & (et < 17 * 60),
    "overnight":  lambda et: (et < RTH_OPEN) | (et >= RTH_CLOSE),
}


@dataclass(frozen=True)
class Cfg:
    """One complete strategy. Defaults are the shipped v1 configuration."""
    # entry
    lookback: int = 12          # Donchian lookback for the breakout level
    atr_rank_min: float = 0.66  # volatility-expansion gate (percentile, 0-1)
    vwap_min: float = 1.5       # min |close - VWAP| in ATR
    outside_pd: bool = True     # price beyond yesterday's high/low
    close_pos_min: float = 0.0  # bar must close in top (1-x) of its range
    relvol_min: float = 0.0     # volume vs its 20-bar average
    margin_atr: float = 0.0     # clear the level by this many ATR, not 1 tick
    regime: str = "none"        # none | ema200 | ema780 | ema1560 | ema3900 | pdc
    session: str = "all"
    direction: int = 1          # +1 long breakout, -1 short breakdown (mirrored)
    # exit
    stop: float = 2.5           # stop distance in ATR14
    rr: float = 1.5             # target as a multiple of risk
    hold: int = 72              # time stop, in bars (72 = 6h on 5m)
    be: float = 0.0             # move stop to entry at +N R (0 = off)
    trail: float = 0.0          # ATR trailing stop distance (0 = off)
    flat_by: int = 0            # force flat at this ET minute (0 = off)


def add_regime_series(f):
    """Longer-horizon trend series the v1 feature bank does not carry.

    On a 5m chart there are ~78 RTH bars a day, so these are roughly 2, 10, 20
    and 50 trading days. All are plain EMAs so the Pine port is exact.
    """
    c = f["close"]
    for n in (780, 1560, 3900):
        f[f"ema{n}"] = ema(c, n)
    return f


def entry_mask(f, cfg):
    """Boolean entry events. Causal: bar i uses bars <= i only."""
    c = f["close"]
    d = cfg.direction
    n = cfg.lookback
    # The short side is the exact mirror: break the N-bar low instead of the
    # high, and require price below the trend instead of above it.
    key = (f"hh{n}_prev" if d > 0 else f"ll{n}_prev")
    if key in f:
        level = f[key]
    else:                                   # lookback outside the prebuilt grid
        import pandas as pd
        src = pd.Series(f["high"] if d > 0 else f["low"]).rolling(n, min_periods=n)
        level = np.roll((src.max() if d > 0 else src.min()).to_numpy(), 1)
    m = (c > level + cfg.margin_atr * f["atr14"] if d > 0
         else c < level - cfg.margin_atr * f["atr14"])
    if cfg.atr_rank_min > 0:
        m &= f["atr_rank"] > cfg.atr_rank_min
    if cfg.vwap_min > 0:
        m &= np.abs(f["vwap_dev"]) >= cfg.vwap_min
    if cfg.outside_pd:
        m &= (c > f["pdh"]) | (c < f["pdl"])
    if cfg.close_pos_min > 0:
        # "Closed strong" mirrors too: near the high for longs, near the low
        # for shorts.
        cp = f["close_pos"] if d > 0 else (1.0 - f["close_pos"])
        m &= cp >= cfg.close_pos_min
    if cfg.relvol_min > 0:
        m &= f["rel_vol"] >= cfg.relvol_min
    if cfg.regime != "none":
        ref = f["pdc"] if cfg.regime == "pdc" else f[cfg.regime]
        m &= (c > ref) if d > 0 else (c < ref)
    m &= SESSIONS[cfg.session](f["et_min"])
    if cfg.flat_by:
        # Never open a position on the same bar the flat-by rule would close it.
        # Such a trade lasts zero bars and books nothing but the round turn; the
        # bracket kernel dutifully simulates it, which is how a "no overnight
        # risk" rule can quietly *lower* expectancy in a backtest for a reason
        # that has nothing to do with overnight risk.
        m &= (f["et_min"] + bar_minutes(f)) < cfg.flat_by
    # Warmup: every series consumed above must be finite.
    ok = np.isfinite(f["atr14"]) & (f["atr14"] > 0) & np.isfinite(f["atr_rank"])
    ok &= np.isfinite(f["pdh"]) & np.isfinite(f["pdl"]) & np.isfinite(level)
    if cfg.regime != "none":
        ok &= np.isfinite(f["pdc"] if cfg.regime == "pdc" else f[cfg.regime])
    ok[:max(500, cfg.lookback + 20)] = False
    return m & ok


def bar_minutes(f):
    """Bar duration in minutes, inferred from the ET clock."""
    d = np.diff(f["et_min"])
    d = d[d > 0]
    return int(np.median(d)) if len(d) else 5


def flat_session_ids(f, flat_by):
    """Session ids whose boundary an indicator could actually trade.

    The bracket kernel books an open trade at `close[i-1]` whenever the session
    id changes at bar `i`. To force "flat by 16:00" that change must land on the
    bar *after* the one that ends at 16:00 - i.e. the 15:55 bar is the exit.

    The boundary is defined purely from a bar's own start time plus the
    timeframe (`et + tf >= flat_by`), never from looking at the next bar. That
    matters: Pine can evaluate "this bar ends at the flat time" on the bar
    itself, but it cannot know that the *next* bar starts a new day. Defining it
    the other way would have made the backtest untradeable by the indicator, and
    the two would have quietly disagreed.
    """
    et = f["et_min"]
    tf = bar_minutes(f)
    flat_bar = ((et < flat_by) & (et + tf >= flat_by)) | (et + tf >= 24 * 60)
    new = np.zeros(len(et), dtype=np.int64)
    new[1:] = flat_bar[:-1]
    return np.cumsum(new)


def sequentialize(tr):
    """Drop the trades an account already in a position could not have taken.

    This is the single most important line in the whole study. Simulating every
    signal independently lets one move be counted several times; on this setup
    signals overlap 3.4x, which inflates profit factor from 1.19 to 1.33 and the
    trade count from ~320/yr to ~950/yr. Exits are processed before entries on a
    bar, matching the indicator, so a signal on the exit bar itself is takeable.
    """
    idx, xb = tr["idx"], tr["exit_bar"]
    keep = np.zeros(len(idx), bool)
    free = -1
    for k in range(len(idx)):
        if idx[k] >= free:
            keep[k] = True
            free = xb[k]
    out = {}
    for k, v in tr.items():
        out[k] = v[keep] if isinstance(v, np.ndarray) and len(v) == len(keep) else v
    return out


def perf(tr, f=None):
    """Statistics as the indicator's dashboard reports them.

    Win rate is *profitable trades / closed trades*, not target-hits vs stops.
    With a breakeven stop and a time exit in play, counting only target hits
    reports ~18% for a genuinely profitable configuration, which is noise
    dressed as a number.
    """
    if tr is None or len(tr["r"]) == 0:
        return dict(n=0, wr=0.0, pf=0.0, net=0.0, exp=0.0, maxdd=0.0, t=0.0,
                    per_yr=0.0, cost_r=0.0)
    r = tr["r"]
    n = len(r)
    gp = float(r[r > 0].sum())
    gl = float(-r[r < 0].sum())
    eq = np.cumsum(r)
    sd = float(r.std(ddof=1)) if n > 1 else 0.0
    yrs = 1.0
    if f is not None:
        yrs = max(len(np.unique(f["session"][tr["idx"]])) / 252.0, 1e-9)
        # sessions *containing a trade* understates the span when the config is
        # selective, so use the calendar span the trades actually cover.
        span = f["session"][tr["idx"]].max() - f["session"][tr["idx"]].min() + 1
        yrs = max(span / 365.0, 1e-9)
    return dict(
        n=n,
        wr=100.0 * float((r > 0).sum()) / n,
        pf=(gp / gl) if gl > 0 else float("inf"),
        net=float(eq[-1]),
        exp=float(r.mean()),
        maxdd=float((np.maximum.accumulate(eq) - eq).max()),
        t=float(r.mean() / sd * np.sqrt(n)) if sd > 0 else 0.0,
        per_yr=n / yrs,
        cost_r=float(tr["cost_r"].mean()),
    )


def run(f, cfg, subset=None, sequential=True, cost=None):
    """Full evaluation of one config on an optional bar subset.

    `cost` overrides the session-dependent schedule with a flat round turn in
    index points - useful for reproducing an indicator that charges one number
    around the clock.
    """
    m = entry_mask(f, cfg)
    if subset is not None:
        m = m & subset
    tr = build_trades_managed(
        f, m, cfg.direction, cfg.stop, cfg.rr, cfg.hold,
        cost=cost, be_trigger_r=cfg.be, trail_atr=cfg.trail,
        sess_override=(flat_session_ids(f, cfg.flat_by) if cfg.flat_by else None))
    if tr is None:
        return None, None
    if sequential:
        tr = sequentialize(tr)
    return perf(tr, f), tr


# Minimum trades a variant must keep to be eligible, set in main() to a fraction
# of the baseline's own trade count. A "variant" that discards 80% of the trades
# is not an improvement to this strategy, it is a different and much rarer
# strategy being scored on a sample too small to tell apart from luck - and it
# is exactly how PF-maximising searches talk themselves into 20-trade fantasies.
MIN_N = [150]


def run_pair(f, cfg_long, cfg_short, subset=None):
    """Both directions sharing ONE position slot.

    Running the long and short books separately and adding the results is not
    the same strategy: an account with one contract cannot be long and short at
    once, and whichever side fires first blocks the other. So both signal sets
    are simulated independently, merged in entry order, and then the same greedy
    one-position filter is applied across the union. The result is what a single
    account could actually have traded.
    """
    parts = []
    for cfg in (cfg_long, cfg_short):
        m = entry_mask(f, cfg)
        if subset is not None:
            m = m & subset
        tr = build_trades_managed(
            f, m, cfg.direction, cfg.stop, cfg.rr, cfg.hold,
            be_trigger_r=cfg.be, trail_atr=cfg.trail,
            sess_override=(flat_session_ids(f, cfg.flat_by) if cfg.flat_by else None))
        if tr is not None and len(tr["r"]):
            parts.append(tr)
    if not parts:
        return None, None
    merged = {k: np.concatenate([p[k] for p in parts])
              for k in ("idx", "r", "exit_bar", "risk", "cost_r", "outcome")}
    order = np.argsort(merged["idx"], kind="stable")
    merged = {k: v[order] for k, v in merged.items()}
    merged = sequentialize(merged)
    return perf(merged, f), merged


def score(st, min_n=None):
    """Selection statistic: expectancy scaled by sample size.

    Ranking on profit factor alone crowns whichever cell happened to take the
    fewest trades. Requiring a floor on trade count and then ranking on
    exp*sqrt(n) trades edge against evidence, which is what a search has to do
    to stay honest.
    """
    if min_n is None:
        min_n = MIN_N[0]
    if st is None or st["n"] < min_n:
        return -1e9
    return st["exp"] * np.sqrt(st["n"])


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def log(m=""):
    print(m, flush=True)


def hr(t):
    log("\n" + "=" * 92)
    log(t)
    log("=" * 92)


HDR = (f"{'variant':>16s} | {'n':>5s} {'WR':>5s} {'PF':>5s} {'exp':>7s} "
       f"{'t':>5s} {'/yr':>5s} {'DD':>5s} | {'n':>5s} {'WR':>5s} {'PF':>5s} "
       f"{'exp':>7s} {'t':>5s}")


def row(label, a, b, mark=""):
    def fmt(s):
        if s is None or s["n"] == 0:
            return f"{'-':>5s} {'-':>5s} {'-':>5s} {'-':>7s} {'-':>5s}"
        return (f"{s['n']:5d} {s['wr']:5.1f} {s['pf']:5.2f} {s['exp']:+7.3f} "
                f"{s['t']:5.2f}")
    extra = (f" {a['per_yr']:5.0f} {a['maxdd']:5.1f}"
             if a and a["n"] else f" {'-':>5s} {'-':>5s}")
    log(f"{label:>16s} | {fmt(a)}{extra} | {fmt(b)} {mark}")


def grid(f, base, field, values, train, hold, label=None):
    """Test one hypothesis: sweep `field` over `values`, everything else fixed."""
    hr(f"H: {label or field}")
    log(HDR)
    log(f"{'':>16s} | {'--------------- TRAIN (selection) ----------------':^49s} "
        f"| {'------- HOLDOUT (untouched) -------':^37s}")
    cur = getattr(base, field)
    best, best_s = cur, -1e18
    rows = []
    for v in values:
        cfg = replace(base, **{field: v})
        a, _ = run(f, cfg, train)
        b, _ = run(f, cfg, hold)
        s = score(a)
        rows.append(dict(value=str(v), train=a, hold=b, score=float(s)))
        if s > best_s:
            best_s, best = s, v
        row(str(v), a, b, "" if s > -1e8 else "(below trade floor)")
    if best_s <= -1e8:      # nothing cleared the floor - keep what we had
        best = cur
        log(f"\n  -> no cell cleared the {MIN_N[0]}-trade floor; keeping "
            f"{field} = {best}")
    else:
        log(f"\n  -> TRAIN selects {field} = {best}")
    for r in rows:
        if r["value"] == str(best):
            r["selected"] = True
    return best, rows


def pick_presets(f, shape, train, hold):
    """One configuration per objective, all selected on TRAIN.

    Profit factor, win rate and trade count pull against each other, and no
    single configuration maximises all three: a wider target buys profit factor
    and gives back win rate, a longer hold buys profit factor and gives back
    trade count (a position held 12 hours cannot take the next signal), and
    every filter buys quality and gives back frequency. Pretending one setting
    wins on all three is how backtests get sold.

    So the frontier gets surfaced instead. The search spans the exit grid plus
    the option to switch off the two most frequency-reducing gates, which is
    ~1,000 cells - small enough that the selection-corrected significance bar is
    t ~ 3.7 rather than the 6.20 a 220M sweep demands.

    HOLDOUT is computed for every preset but never selected on.
    """
    sessions = list({shape.session, "all"})
    regimes = list({shape.regime, "none"})
    cells = []
    for sess in sessions:
        for reg in regimes:
            for stop in (1.5, 2.0, 2.5, 3.0, 3.5):
                for rr in (1.0, 1.25, 1.5, 2.0, 2.5, 3.0):
                    for hld in (24, 48, 72, 144):
                        for be in (0.0, 0.75, 1.0):
                            cfg = replace(shape, session=sess, regime=reg,
                                          stop=stop, rr=rr, hold=hld, be=be)
                            a, _ = run(f, cfg, train)
                            if a is None or a["n"] < MIN_N[0]:
                                continue
                            cells.append((cfg, a))
    if not cells:
        return {}, 0

    def best(key, where=lambda c, a: True):
        ok = [(c, a) for c, a in cells if where(c, a)]
        return max(ok, key=lambda ca: key(ca[1]))[0] if ok else None

    picks = {
        # The all-round pick: expectancy weighted by evidence.
        "Balanced": best(lambda a: a["exp"] * np.sqrt(a["n"])),
        # Highest profit factor that still trades often enough to be real.
        "Max profit factor": best(lambda a: a["pf"]),
        # Highest win rate, but only among configurations that actually make
        # money - a 90% win rate at PF 0.9 is a losing strategy with a nice hit
        # rate, and that is the trap this constraint exists to block.
        "Max win rate": best(lambda a: a["wr"], lambda c, a: a["pf"] >= 1.15),
        # Most trades, subject to a profit factor worth taking them for.
        "Max trades": best(lambda a: a["n"], lambda c, a: a["pf"] >= 1.20),
    }
    return {k: v for k, v in picks.items() if v is not None}, len(cells)


def by_year(f, cfg, index):
    """Calendar-year breakdown - the check that kills configs living in one regime."""
    st_all, tr = run(f, cfg)
    if tr is None:
        return []
    yr = index[tr["idx"]].year.to_numpy()
    out = []
    for y in sorted(set(yr.tolist())):
        r = tr["r"][yr == y]
        if len(r) < 10:
            continue
        gp = float(r[r > 0].sum())
        gl = float(-r[r < 0].sum())
        out.append(dict(year=int(y), n=len(r),
                        wr=100.0 * float((r > 0).sum()) / len(r),
                        pf=(gp / gl) if gl > 0 else float("inf"),
                        net=float(r.sum())))
    return out


def random_entry_null(f, cfg, n_iter=200, seed=7, pool_mode="conditions"):
    """Matched-random-entry null: the honest alpha test.

    Same number of entries, run through the identical exit logic and the
    identical one-position-at-a-time filter. Whatever the strategy earns above
    this is signal; whatever it shares with it is drift, and drift on an index
    that rose 365% across the sample is not an edge anyone discovered.

    What the entries are matched *on* decides what the test actually proves:

    * `pool_mode="session"` draws from any tradeable bar in the trading window.
      This asks "is the whole strategy better than showing up and buying?" and
      it is the weaker question, because a trend filter can beat it just by
      being long an index that went up.
    * `pool_mode="conditions"` draws only from bars that pass *every* gate
      except the breakout event itself - same session, same volatility regime,
      same trend regime, same distance from VWAP, same outside-prior-day-range.
      This asks the question that matters: given that we are already in exactly
      the conditions the strategy waits for, does the breakout *event* add
      anything, or would a coin flip in those conditions do just as well?

    Reporting only the first would let a filter stack take credit for beta. Both
    are reported.
    """
    m = entry_mask(f, cfg)
    idx = np.flatnonzero(m)
    if len(idx) == 0:
        return None
    if pool_mode == "conditions":
        # Every gate except the trigger: rebuild the mask with a lookback that
        # cannot bind (the breakout test becomes close > -inf).
        pool = entry_mask(f, replace(cfg, margin_atr=-1e9))
        pool &= np.isfinite(f["atr14"]) & (f["atr14"] > 0)
    else:
        pool = (SESSIONS[cfg.session](f["et_min"]) & np.isfinite(f["atr14"])
                & (f["atr14"] > 0))
    pool[:500] = False
    pool[-cfg.hold - 2:] = False
    pool_idx = np.flatnonzero(pool)
    if len(pool_idx) < 10:
        return None
    rng = np.random.default_rng(seed)
    exps = []
    for _ in range(n_iter):
        take = rng.choice(pool_idx, size=min(len(idx), len(pool_idx)), replace=False)
        mm = np.zeros(len(m), bool)
        mm[np.sort(take)] = True
        tr = build_trades_managed(f, mm, cfg.direction, cfg.stop, cfg.rr, cfg.hold,
                                  be_trigger_r=cfg.be, trail_atr=cfg.trail,
                                  sess_override=(flat_session_ids(f, cfg.flat_by)
                                                 if cfg.flat_by else None))
        if tr is None:
            continue
        tr = sequentialize(tr)
        if len(tr["r"]):
            exps.append(float(tr["r"].mean()))
    if not exps:
        return None
    exps = np.array(exps)
    st, _ = run(f, cfg)
    excess = st["exp"] - exps.mean()
    return dict(signal_exp=st["exp"], null_mean=float(exps.mean()),
                null_sd=float(exps.std(ddof=1)),
                t=float(excess / max(exps.std(ddof=1), 1e-12)),
                p=float((exps >= st["exp"]).mean()), n_iter=len(exps))


def bootstrap(tr, n_iter=2000, seed=3):
    """Block bootstrap CI on PF and expectancy (blocks preserve streaks)."""
    r = tr["r"]
    n = len(r)
    if n < 30:
        return None
    rng = np.random.default_rng(seed)
    blk = max(5, n // 50)
    nb = int(np.ceil(n / blk))
    pfs, exps = [], []
    for _ in range(n_iter):
        starts = rng.integers(0, n - blk + 1, nb)
        s = np.concatenate([r[i:i + blk] for i in starts])[:n]
        gp, gl = s[s > 0].sum(), -s[s < 0].sum()
        pfs.append(gp / gl if gl > 0 else np.nan)
        exps.append(s.mean())
    pfs = np.array(pfs)
    pfs = pfs[np.isfinite(pfs)]
    return dict(pf_lo=float(np.percentile(pfs, 2.5)),
                pf_hi=float(np.percentile(pfs, 97.5)),
                exp_lo=float(np.percentile(exps, 2.5)),
                exp_hi=float(np.percentile(exps, 97.5)),
                p_exp_le0=float((np.array(exps) <= 0).mean()))


def walk_forward(f, base, index, n_folds=6):
    """Re-select the exit parameters inside each fold, trade the next fold.

    This is the only test that prices in the act of choosing. Everything else
    in this file selects once on TRAIN; here the selection is repeated inside
    each window, so the reported result includes the cost of being wrong.
    """
    n = len(f["close"])
    edges = np.linspace(0, n, n_folds + 1).astype(int)
    rows = []
    pooled = []
    for k in range(n_folds - 1):
        tr_mask = np.zeros(n, bool)
        tr_mask[edges[k]:edges[k + 1]] = True
        te_mask = np.zeros(n, bool)
        te_mask[edges[k + 1]:edges[k + 2]] = True
        best, bs = base, -1e18
        for stop in (2.0, 2.5, 3.0):
            for rr in (1.0, 1.5, 2.0):
                for be in (0.0, 1.0):
                    cfg = replace(base, stop=stop, rr=rr, be=be)
                    a, _ = run(f, cfg, tr_mask)
                    s = score(a, min_n=40)
                    if s > bs:
                        bs, best = s, cfg
        st, tr = run(f, best, te_mask)
        if st and st["n"]:
            pooled.append(tr["r"])
            rows.append(dict(fold=k + 1, chosen=f"stop{best.stop}/rr{best.rr}/be{best.be}",
                             n=st["n"], pf=st["pf"], wr=st["wr"], exp=st["exp"]))
    pool = np.concatenate(pooled) if pooled else np.array([])
    return rows, pool


# ---------------------------------------------------------------------------
def main(ndx_path, mnq_path, nq_path, out_dir="out"):
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()
    rep = {}

    hr("0. DATA AND SPLIT")
    ndx = load_bars(ndx_path)
    f = add_regime_series(build_features(ndx))
    n = len(ndx)
    log(f"NDX research set: {n:,} 5m bars  "
        f"{ndx.index[0]:%Y-%m-%d} -> {ndx.index[-1]:%Y-%m-%d}")

    cut = int(n * 0.60)
    train = np.zeros(n, bool)
    train[:cut] = True
    hold = ~train
    log(f"  TRAIN   (selection) : {cut:,} bars  {ndx.index[0]:%Y-%m-%d} -> "
        f"{ndx.index[cut - 1]:%Y-%m-%d}")
    log(f"  HOLDOUT (untouched) : {n - cut:,} bars  {ndx.index[cut]:%Y-%m-%d} -> "
        f"{ndx.index[-1]:%Y-%m-%d}")
    log("\nEvery hypothesis below is selected on TRAIN. HOLDOUT is reported "
        "beside it but never selected on.")

    base = Cfg()
    hr("1. BASELINE - shipped v1, one position at a time")
    a, _ = run(f, base, train)
    # Trade floor: a variant must retain at least a quarter of the baseline's
    # trades. Without this the selection drifts toward ever-rarer setups scored
    # on ever-smaller samples, which is the classic way a sweep fools itself.
    MIN_N[0] = max(40, int(0.25 * a["n"])) if a and a["n"] else 40
    log(f"\n  trade floor for every selection below: {MIN_N[0]} trades on TRAIN "
        f"(25% of the baseline's {a['n'] if a else 0})")
    b, _ = run(f, base, hold)
    full, tr_full = run(f, base)
    log(HDR)
    row("v1 baseline", a, b)
    log(f"\n  full sample: n={full['n']}  WR={full['wr']:.1f}%  PF={full['pf']:.2f}  "
        f"net={full['net']:+.1f}R  exp={full['exp']:+.4f}  "
        f"{full['per_yr']:.0f} trades/yr  maxDD={full['maxdd']:.1f}R")
    log(f"  mean cost charged per trade: {full['cost_r']:.4f} R "
        f"({100 * full['cost_r']:.1f}% of risk)")
    rep["baseline"] = dict(train=a, hold=b, full=full)

    # ---------------------------------------------------------------- H1..H6
    sel = {}
    sel["session"], rows_s = grid(f, base, "session", list(SESSIONS), train, hold,
                                  "session window (cost is 1.00pt RTH vs 1.75 overnight)")
    c1 = replace(base, session=sel["session"])

    sel["be"], rows_be = grid(f, c1, "be", [0.0, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0],
                              train, hold, "breakeven stop at +N R")
    c2 = replace(c1, be=sel["be"])

    sel["trail"], rows_tr = grid(f, c2, "trail", [0.0, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0],
                                 train, hold, "ATR trailing stop")
    c3 = replace(c2, trail=sel["trail"])

    sel["regime"], rows_rg = grid(f, c3, "regime",
                                  ["none", "pdc", "ema200", "ema780", "ema1560", "ema3900"],
                                  train, hold, "higher-horizon trend regime")
    c4 = replace(c3, regime=sel["regime"])

    sel["close_pos_min"], rows_cp = grid(f, c4, "close_pos_min",
                                         [0.0, 0.5, 0.6, 0.7, 0.8], train, hold,
                                         "breakout bar must close strong")
    c5 = replace(c4, close_pos_min=sel["close_pos_min"])

    sel["relvol_min"], rows_rv = grid(f, c5, "relvol_min",
                                      [0.0, 0.8, 1.0, 1.2, 1.5], train, hold,
                                      "relative volume at the breakout")
    c6 = replace(c5, relvol_min=sel["relvol_min"])

    sel["margin_atr"], rows_mg = grid(f, c6, "margin_atr",
                                      [0.0, 0.05, 0.1, 0.2, 0.3], train, hold,
                                      "clear the level by N x ATR, not one tick")
    c7 = replace(c6, margin_atr=sel["margin_atr"])

    sel["flat_by"], rows_fb = grid(f, c7, "flat_by", [0, RTH_CLOSE, RTH_CLOSE - 10],
                                   train, hold, "force flat before the close")
    c8 = replace(c7, flat_by=sel["flat_by"])

    sel["lookback"], rows_lb = grid(f, c8, "lookback", [12, 24, 48, 96], train, hold,
                                    "Donchian lookback (plateau check)")
    c9 = replace(c8, lookback=sel["lookback"])

    sel["atr_rank_min"], rows_ar = grid(f, c9, "atr_rank_min",
                                        [0.0, 0.33, 0.5, 0.66, 0.8], train, hold,
                                        "volatility-expansion threshold")
    c10 = replace(c9, atr_rank_min=sel["atr_rank_min"])

    sel["vwap_min"], rows_vw = grid(f, c10, "vwap_min", [0.0, 0.5, 1.0, 1.5, 2.0],
                                    train, hold, "distance from VWAP")
    cand = replace(c10, vwap_min=sel["vwap_min"])

    rep["hypotheses"] = dict(session=rows_s, be=rows_be, trail=rows_tr,
                             regime=rows_rg, close_pos=rows_cp, relvol=rows_rv,
                             margin=rows_mg, flat_by=rows_fb, lookback=rows_lb,
                             atr_rank=rows_ar, vwap=rows_vw)

    # ---------------------------------------------------------------- exits
    hr("2. EXIT GRID with the selected management (TRAIN)")
    log("A real edge is a plateau in stop/target space. A spike is an artifact.\n")
    log(f"{'stop':>5s} {'rr':>5s} {'hold':>5s} | {'n':>5s} {'WR':>5s} {'PF':>5s} "
        f"{'exp':>7s} {'t':>5s} | HOLDOUT {'n':>5s} {'PF':>5s} {'exp':>7s}")
    best_exit, bs = (cand.stop, cand.rr, cand.hold), -1e18
    exit_rows = []
    for stop in (1.5, 2.0, 2.5, 3.0, 3.5):
        for rr in (1.0, 1.25, 1.5, 2.0, 2.5, 3.0):
            for hld in (48, 72, 144):
                cfg = replace(cand, stop=stop, rr=rr, hold=hld)
                a, _ = run(f, cfg, train)
                if a is None or a["n"] < MIN_N[0]:
                    continue
                s = score(a)
                b, _ = run(f, cfg, hold)
                exit_rows.append(dict(stop=stop, rr=rr, hold=hld, train=a, hold_=b,
                                      score=float(s)))
                if s > bs:
                    bs, best_exit = s, (stop, rr, hld)
    exit_rows.sort(key=lambda d: -d["score"])
    for d in exit_rows[:14]:
        a, b = d["train"], d["hold_"]
        log(f"{d['stop']:5.1f} {d['rr']:5.2f} {d['hold']:5d} | {a['n']:5d} "
            f"{a['wr']:5.1f} {a['pf']:5.2f} {a['exp']:+7.3f} {a['t']:5.2f} | "
            f"        {b['n']:5d} {b['pf']:5.2f} {b['exp']:+7.3f}")
    pos = float(np.mean([d["train"]["exp"] > 0 for d in exit_rows])) if exit_rows else 0.0
    log(f"\n  {len(exit_rows)} exit cells tested, {100 * pos:.0f}% positive on TRAIN "
        f"-> {'plateau' if pos > 0.7 else 'NOT a plateau, treat with suspicion'}")
    log(f"  -> TRAIN selects stop={best_exit[0]} rr={best_exit[1]} hold={best_exit[2]}")
    final = replace(cand, stop=best_exit[0], rr=best_exit[1], hold=best_exit[2])
    rep["exit_grid"] = dict(rows=[{k: v for k, v in d.items()} for d in exit_rows[:40]],
                            frac_positive=float(pos))

    # ---------------------------------------------------------------- presets
    hr("3. THE FRONTIER - one preset per objective (selected on TRAIN)")
    log("Profit factor, win rate and trade count cannot all be maximised at "
        "once.\nEach row below is the best TRAIN configuration for ONE of them.\n")
    presets, n_cells = pick_presets(f, cand, train, hold)
    log(f"searched {n_cells:,} eligible cells "
        f"-> selection-corrected significance bar t = "
        f"{np.sqrt(2 * np.log(max(n_cells, 2))):.2f}\n")
    log(HDR)
    log(f"{'':>16s} | {'--------------- TRAIN (selection) ----------------':^49s} "
        f"| {'------- HOLDOUT (untouched) -------':^37s}")
    rep["presets"] = {}
    for nm, cfg in presets.items():
        a, _ = run(f, cfg, train)
        b, _ = run(f, cfg, hold)
        fl, _ = run(f, cfg)
        row(nm, a, b)
        rep["presets"][nm] = dict(
            cfg={k: getattr(cfg, k) for k in cfg.__dataclass_fields__},
            train=a, hold=b, full=fl)
    log("\n  full-sample view (what the indicator's dashboard should show):")
    log(f"{'preset':>18s} {'n':>6s} {'/yr':>6s} {'WR':>6s} {'PF':>6s} "
        f"{'netR':>8s} {'maxDD':>7s}  config")
    for nm, cfg in presets.items():
        fl, _ = run(f, cfg)
        log(f"{nm:>18s} {fl['n']:6d} {fl['per_yr']:6.0f} {fl['wr']:6.1f} "
            f"{fl['pf']:6.2f} {fl['net']:+8.1f} {fl['maxdd']:7.1f}  "
            f"stop{cfg.stop}/rr{cfg.rr}/hold{cfg.hold}/be{cfg.be}/"
            f"{cfg.session}/{cfg.regime}")
    final = presets.get("Balanced", final)

    # ------------------------------------------------------------ short side
    hr("3b. THE SHORT MIRROR - does the setup work in both directions?")
    log("v1 shipped long-only because the unfiltered short mirror lost "
        "(PF 0.89).\nBut it was never tested WITH the trend filter and session "
        "gate. If breakouts\npay during expansion above trend, breakdowns "
        "should pay during expansion\nbelow it - and if they do, the trade "
        "count roughly doubles.\n")
    log(HDR)
    log(f"{'':>16s} | {'--------------- TRAIN (selection) ----------------':^49s} "
        f"| {'------- HOLDOUT (untouched) -------':^37s}")
    shorts = replace(final, direction=-1)
    row("long only", *[run(f, final, m)[0] for m in (train, hold)])
    row("short only", *[run(f, shorts, m)[0] for m in (train, hold)])
    row("both sides", *[run_pair(f, final, shorts, m)[0] for m in (train, hold)])
    sl, _ = run(f, shorts)
    bl, _ = run_pair(f, final, shorts)
    lo, _ = run(f, final)
    log(f"\n  full sample  long only : n={lo['n']:5d} ({lo['per_yr']:3.0f}/yr) "
        f"WR {lo['wr']:.1f}%  PF {lo['pf']:.2f}  net {lo['net']:+.1f}R")
    log(f"  full sample  short only: n={sl['n']:5d} ({sl['per_yr']:3.0f}/yr) "
        f"WR {sl['wr']:.1f}%  PF {sl['pf']:.2f}  net {sl['net']:+.1f}R")
    log(f"  full sample  BOTH      : n={bl['n']:5d} ({bl['per_yr']:3.0f}/yr) "
        f"WR {bl['wr']:.1f}%  PF {bl['pf']:.2f}  net {bl['net']:+.1f}R")
    nl_s = random_entry_null(f, shorts, n_iter=200, pool_mode="conditions")
    if nl_s:
        log(f"\n  short side vs matched conditions: t = {nl_s['t']:+.2f}  "
            f"(bar is {np.sqrt(2 * np.log(1500)):.2f})")
    keep_short = sl["pf"] > 1.05 and run(f, shorts, hold)[0]["pf"] > 1.0
    log(f"\n  -> shorts {'EARN their place' if keep_short else 'do NOT clear the bar'}"
        f"; indicator ships with the short side "
        f"{'available (default off)' if not keep_short else 'ON by default'}.")
    rep["short"] = dict(long=lo, short=sl, both=bl, null=nl_s,
                        keep=bool(keep_short))

    # ---------------------------------------------------------------- final
    hr("4. FINAL CONFIGURATION (Balanced preset — the shipped default)")
    log(json.dumps({k: getattr(final, k) for k in final.__dataclass_fields__},
                   indent=2))
    a, _ = run(f, final, train)
    b, tr_h = run(f, final, hold)
    full2, tr2 = run(f, final)
    log("\n" + HDR)
    row("v1 baseline", *[run(f, base, m)[0] for m in (train, hold)])
    row("v2 final", a, b)
    log(f"\n  full sample : n={full2['n']}  WR={full2['wr']:.1f}%  PF={full2['pf']:.2f}  "
        f"net={full2['net']:+.1f}R  {full2['per_yr']:.0f}/yr  maxDD={full2['maxdd']:.1f}R")
    log(f"  v1 baseline : n={full['n']}  WR={full['wr']:.1f}%  PF={full['pf']:.2f}  "
        f"net={full['net']:+.1f}R  {full['per_yr']:.0f}/yr  maxDD={full['maxdd']:.1f}R")
    rep["final_cfg"] = {k: getattr(final, k) for k in final.__dataclass_fields__}
    rep["final"] = dict(train=a, hold=b, full=full2)

    hr("5. PER-YEAR (full sample)")
    log(f"{'year':>6s} {'n':>6s} {'WR':>6s} {'PF':>6s} {'netR':>8s}   |   "
        f"{'v1 n':>6s} {'v1 PF':>6s} {'v1 netR':>8s}")
    y2 = {r["year"]: r for r in by_year(f, final, ndx.index)}
    y1 = {r["year"]: r for r in by_year(f, base, ndx.index)}
    for y in sorted(y2):
        r = y2[y]
        o = y1.get(y)
        log(f"{y:6d} {r['n']:6d} {r['wr']:6.1f} {r['pf']:6.2f} {r['net']:+8.1f}   |   "
            + (f"{o['n']:6d} {o['pf']:6.2f} {o['net']:+8.1f}" if o else " " * 22))
    rep["by_year"] = dict(v2=list(y2.values()), v1=list(y1.values()))

    hr("6. MATCHED-RANDOM-ENTRY NULL (the alpha test)")
    log("  'vs session'    = random entry anywhere in the trading window.")
    log("  'vs conditions' = random entry among bars that already pass every")
    log("                    gate EXCEPT the breakout itself. This is the test")
    log("                    a trend filter cannot pass on beta alone.\n")
    log(f"{'config':>18s} {'signal exp':>11s} | {'vs session':>22s} | "
        f"{'vs conditions':>22s}")
    for nm, cfg in [("v1 baseline", base)] + list(presets.items()):
        a = random_entry_null(f, cfg, n_iter=200, pool_mode="session")
        b = random_entry_null(f, cfg, n_iter=200, pool_mode="conditions")
        if not a:
            continue
        fmt = lambda x: (f"{x['null_mean']:+.4f} t={x['t']:+5.2f}" if x
                         else f"{'-':>18s}")
        log(f"{nm:>18s} {a['signal_exp']:+11.4f} | {fmt(a):>22s} | {fmt(b):>22s}")
        rep[f"null_{nm}"] = dict(session=a, conditions=b)
    log("\n  The 220.7M sweep demanded t = 6.20 to claim significance, and its")
    log("  winner reached +2.84. This study searched ~1,500 cells, for which the")
    log(f"  selection-corrected bar is t = {np.sqrt(2 * np.log(1500)):.2f}. Judge "
        "the 'vs conditions'")
    log("  column against that number, not against the 'vs session' column.")

    hr("7. WALK-FORWARD (exit parameters re-chosen inside every fold)")
    wf, pool = walk_forward(f, cand, ndx.index)
    log(f"{'fold':>5s} {'chosen on prior fold':>26s} {'n':>6s} {'WR':>6s} "
        f"{'PF':>6s} {'exp':>8s}")
    for r in wf:
        log(f"{r['fold']:5d} {r['chosen']:>26s} {r['n']:6d} {r['wr']:6.1f} "
            f"{r['pf']:6.2f} {r['exp']:+8.4f}")
    if len(pool):
        gp, gl = pool[pool > 0].sum(), -pool[pool < 0].sum()
        log(f"\n  pooled out-of-fold: n={len(pool)}  PF={gp / gl:.2f}  "
            f"WR={100 * (pool > 0).mean():.1f}%  exp={pool.mean():+.4f}")
        rep["walk_forward"] = dict(folds=wf, pooled_n=int(len(pool)),
                                   pooled_pf=float(gp / gl),
                                   pooled_exp=float(pool.mean()))

    hr("8. BOOTSTRAP CONFIDENCE (block resample, full sample)")
    for nm, t in (("v1 baseline", tr_full), ("v2 final", tr2)):
        ci = bootstrap(t)
        if ci:
            log(f"  {nm:12s}: PF 95% CI [{ci['pf_lo']:.2f}, {ci['pf_hi']:.2f}]   "
                f"exp 95% CI [{ci['exp_lo']:+.4f}, {ci['exp_hi']:+.4f}]   "
                f"P(exp<=0) = {ci['p_exp_le0']:.4f}")
            rep[f"ci_{nm.split()[0]}"] = ci

    hr("9. HELD-OUT REAL FUTURES (never used for anything)")
    log(f"{'series':>10s} {'cfg':>18s} {'n':>5s} {'WR':>6s} {'PF':>6s} {'exp':>8s} "
        f"{'netR':>7s}")
    rep["futures"] = {}
    log("  70 days only, so these are small samples - they are a sanity check "
        "that\n  the rules transfer from the CFD research set to real futures, "
        "not proof.\n")
    variants = [("v1 baseline", base)] + list(presets.items())
    for nm, path in (("MNQ", mnq_path), ("NQ", nq_path)):
        d = load_bars(path)
        ff = add_regime_series(build_features(d))
        for cn, cfg in variants:
            st, _ = run(ff, cfg)
            if st and st["n"]:
                log(f"{nm:>10s} {cn:>18s} {st['n']:5d} {st['wr']:6.1f} "
                    f"{st['pf']:6.2f} {st['exp']:+8.4f} {st['net']:+7.1f}")
                rep["futures"][f"{nm}_{cn}"] = st
            else:
                log(f"{nm:>10s} {cn:>18s} {'-':>5s}  (no trades in the window)")

    hr("10. OVERLAP CORRECTION - what the honest number costs")
    for nm, cfg in (("v1", base), ("v2", final)):
        ov, _ = run(f, cfg, sequential=False)
        sq, _ = run(f, cfg, sequential=True)
        log(f"  {nm}: overlapping PF {ov['pf']:.2f} @ {ov['per_yr']:.0f} trades/yr  ->  "
            f"one-at-a-time PF {sq['pf']:.2f} @ {sq['per_yr']:.0f} trades/yr  "
            f"({ov['n'] / max(sq['n'], 1):.1f}x inflation)")

    with open(os.path.join(out_dir, "improve.json"), "w") as fh:
        json.dump(rep, fh, indent=2, default=float)
    log(f"\nwrote {out_dir}/improve.json   total runtime {time.time() - t0:.0f}s")
    return final, rep


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3],
         sys.argv[4] if len(sys.argv) > 4 else "out")
