#!/usr/bin/env python3
"""Feature bank: the strategy search space.

A strategy in this project is four independent choices:

    trigger  x  filter set  x  exit config  x  direction

* **Triggers** are sparse, directional *events* (a sweep, a breakout, a band
  touch). They are the candidate alpha. Each family is expanded over its own
  parameter grid.
* **Filters** are dense boolean *conditions* (session, regime, structure)
  evaluated at the trigger bar to keep or drop the trade.
* **Exits** are stop/target/hold-time brackets in ATR units.

Splitting triggers from filters is what makes the sweep tractable: a trigger is
simulated once, then filters only ever *subset* its trades, which reduces to
popcounts over bitsets (see qlib).

Everything here is causal. Features at bar `i` use bars `<= i` only, and a
trigger firing at bar `i` is acted on at bar `i`'s close.
"""
import numpy as np
import pandas as pd

from qlib import (atr, cost_per_bar, ema, opening_range, prev_session_agg,
                  rolling_max, rolling_min, rolling_rank, rsi,
                  session_cum_extreme, session_vwap, sma)

RTH_OPEN = 9 * 60 + 30      # 09:30 ET
RTH_CLOSE = 16 * 60         # 16:00 ET


# ===========================================================================
# Feature computation
# ===========================================================================
def build_features(df):
    """Compute every derived series once; returns a dict of float arrays."""
    o = df["open"].to_numpy(np.float64)
    h = df["high"].to_numpy(np.float64)
    l = df["low"].to_numpy(np.float64)
    c = df["close"].to_numpy(np.float64)
    v = df["volume"].to_numpy(np.float64)
    f = {}
    f["open"], f["high"], f["low"], f["close"], f["volume"] = o, h, l, c, v

    rng = np.maximum(h - l, 1e-9)
    f["range"] = rng
    f["body"] = np.abs(c - o)
    f["body_frac"] = f["body"] / rng
    f["upper_wick"] = (h - np.maximum(o, c)) / rng
    f["lower_wick"] = (np.minimum(o, c) - l) / rng
    f["close_pos"] = (c - l) / rng            # 1 = closed on the high

    for n in (14, 20, 50):
        f[f"atr{n}"] = atr(h, l, c, n)
    a = f["atr14"]
    f["atr_rank"] = rolling_rank(a, 500)
    f["atr_pts"] = a
    f["range_exp"] = rng / np.maximum(sma(rng, 20), 1e-9)

    for n in (9, 21, 50, 200):
        f[f"ema{n}"] = ema(c, n)
    f["ema_slope9"] = (f["ema9"] - np.roll(f["ema9"], 5)) / np.maximum(a, 1e-9)
    f["ema_slope50"] = (f["ema50"] - np.roll(f["ema50"], 10)) / np.maximum(a, 1e-9)
    f["dist_ema50"] = (c - f["ema50"]) / np.maximum(a, 1e-9)
    f["dist_ema200"] = (c - f["ema200"]) / np.maximum(a, 1e-9)

    for n in (2, 7, 14):
        f[f"rsi{n}"] = rsi(c, n)

    for n in (12, 24, 48, 96):
        f[f"hh{n}"] = rolling_max(h, n)
        f[f"ll{n}"] = rolling_min(l, n)
    # Prior-bar extremes: the level a breakout must clear, known before bar i.
    for n in (12, 24, 48, 96):
        f[f"hh{n}_prev"] = np.roll(f[f"hh{n}"], 1)
        f[f"ll{n}_prev"] = np.roll(f[f"ll{n}"], 1)

    m20 = sma(c, 20)
    sd20 = pd.Series(c).rolling(20, min_periods=20).std().to_numpy()
    f["bb_up"] = m20 + 2.0 * sd20
    f["bb_dn"] = m20 - 2.0 * sd20
    f["bb_width"] = (f["bb_up"] - f["bb_dn"]) / np.maximum(a, 1e-9)
    f["bb_width_rank"] = rolling_rank(f["bb_width"], 500)

    vw = session_vwap(df)
    f["vwap"] = vw
    f["vwap_dev"] = (c - vw) / np.maximum(a, 1e-9)

    f["vol_ma"] = np.maximum(sma(v, 20), 1e-9)
    f["rel_vol"] = v / f["vol_ma"]

    f["pdh"] = prev_session_agg(df, "high", "max")
    f["pdl"] = prev_session_agg(df, "low", "min")
    f["pdc"] = prev_session_agg(df, "close", "last")
    f["sess_hi"] = session_cum_extreme(df, "high", "max")
    f["sess_lo"] = session_cum_extreme(df, "low", "min")

    for mins in (15, 30, 60):
        orh, orl = opening_range(df, mins, RTH_OPEN)
        f[f"orh{mins}"] = orh
        f[f"orl{mins}"] = orl

    up = (c > np.roll(c, 1)).astype(np.int32)
    f["consec_up"] = _run_length(up)
    f["consec_dn"] = _run_length(1 - up)

    f["et_min"] = df["et_min"].to_numpy(np.int64)
    f["dow"] = df["dow"].to_numpy(np.int64)
    f["session"] = df["session"].to_numpy(np.int64)
    f["bars_from_open"] = _bars_from_open(f["session"], f["et_min"])
    f["cost_pts"] = cost_per_bar(f["et_min"], RTH_OPEN, RTH_CLOSE)
    return f


def _run_length(flag):
    out = np.zeros(len(flag), dtype=np.int32)
    run = 0
    for i in range(len(flag)):
        run = run + 1 if flag[i] else 0
        out[i] = run
    return out


def _bars_from_open(session, et_min):
    """Bars elapsed since this session's RTH open (negative before it)."""
    out = np.full(len(session), -1, dtype=np.int64)
    start = None
    for i in range(len(session)):
        if i == 0 or session[i] != session[i - 1]:
            start = None
        if start is None and et_min[i] >= RTH_OPEN:
            start = i
        out[i] = (i - start) if start is not None else -1
    return out


def _valid(f):
    """Bars where every feature is warm; everything before is unusable."""
    ok = np.ones(len(f["close"]), dtype=bool)
    for k in ("atr14", "ema200", "bb_up", "atr_rank", "hh96_prev", "rsi14",
              "bb_width_rank", "vol_ma"):
        ok &= np.isfinite(f[k])
    ok[:500] = False        # warmup for the longest rolling window
    return ok


# ===========================================================================
# Triggers - sparse directional events
# ===========================================================================
def build_triggers(f):
    """Return [(name, direction, boolean event array), ...]."""
    c, h, l, o = f["close"], f["high"], f["low"], f["open"]
    ok = _valid(f)
    T = []

    def add(name, d, mask):
        T.append((name, d, mask & ok))

    # --- 1. Liquidity sweep + rejection (mean reversion) --------------------
    for n in (12, 24, 48, 96):
        for wick in (0.25, 0.40):
            swept_lo = (l < f[f"ll{n}_prev"]) & (c > f[f"ll{n}_prev"])
            add(f"sweep_lo{n}_w{wick}", +1,
                swept_lo & (f["lower_wick"] >= wick) & (f["close_pos"] >= 0.5))
            swept_hi = (h > f[f"hh{n}_prev"]) & (c < f[f"hh{n}_prev"])
            add(f"sweep_hi{n}_w{wick}", -1,
                swept_hi & (f["upper_wick"] >= wick) & (f["close_pos"] <= 0.5))

    # --- 2. Donchian breakout (momentum) ------------------------------------
    for n in (12, 24, 48, 96):
        add(f"brk_hi{n}", +1, c > f[f"hh{n}_prev"])
        add(f"brk_lo{n}", -1, c < f[f"ll{n}_prev"])

    # --- 3. Failed breakout / fade ------------------------------------------
    for n in (24, 48):
        add(f"fail_brk_hi{n}", -1,
            (h > f[f"hh{n}_prev"]) & (c < f[f"hh{n}_prev"]) & (f["close_pos"] < 0.4))
        add(f"fail_brk_lo{n}", +1,
            (l < f[f"ll{n}_prev"]) & (c > f[f"ll{n}_prev"]) & (f["close_pos"] > 0.6))

    # --- 4. Opening-range breakout ------------------------------------------
    for mins in (15, 30, 60):
        orh, orl = f[f"orh{mins}"], f[f"orl{mins}"]
        prev_below = np.roll(c, 1) <= orh
        prev_above = np.roll(c, 1) >= orl
        add(f"orb_up{mins}", +1, np.isfinite(orh) & (c > orh) & prev_below)
        add(f"orb_dn{mins}", -1, np.isfinite(orl) & (c < orl) & prev_above)
        add(f"orb_fade_up{mins}", -1, np.isfinite(orh) & (h > orh) & (c < orh))
        add(f"orb_fade_dn{mins}", +1, np.isfinite(orl) & (l < orl) & (c > orl))

    # --- 5. VWAP reversion and reclaim --------------------------------------
    for k in (1.5, 2.0, 2.5, 3.0):
        add(f"vwap_rev_lo{k}", +1, (f["vwap_dev"] <= -k) & (c > o))
        add(f"vwap_rev_hi{k}", -1, (f["vwap_dev"] >= k) & (c < o))
    xup = (c > f["vwap"]) & (np.roll(c, 1) <= np.roll(f["vwap"], 1))
    xdn = (c < f["vwap"]) & (np.roll(c, 1) >= np.roll(f["vwap"], 1))
    add("vwap_reclaim_up", +1, xup)
    add("vwap_reclaim_dn", -1, xdn)

    # --- 6. EMA pullback continuation ---------------------------------------
    for fast, slow in ((9, 21), (21, 50)):
        upt = f[f"ema{fast}"] > f[f"ema{slow}"]
        dnt = f[f"ema{fast}"] < f[f"ema{slow}"]
        touch_lo = (l <= f[f"ema{fast}"]) & (c > f[f"ema{fast}"])
        touch_hi = (h >= f[f"ema{fast}"]) & (c < f[f"ema{fast}"])
        add(f"ema_pb_up{fast}_{slow}", +1, upt & touch_lo)
        add(f"ema_pb_dn{fast}_{slow}", -1, dnt & touch_hi)

    # --- 7. RSI extremes ----------------------------------------------------
    for lo, hi in ((5, 95), (10, 90), (20, 80)):
        add(f"rsi2_lo{lo}", +1, f["rsi2"] <= lo)
        add(f"rsi2_hi{hi}", -1, f["rsi2"] >= hi)
    for lo, hi in ((25, 75), (30, 70)):
        add(f"rsi14_lo{lo}", +1, (f["rsi14"] <= lo) & (np.roll(f["rsi14"], 1) > lo))
        add(f"rsi14_hi{hi}", -1, (f["rsi14"] >= hi) & (np.roll(f["rsi14"], 1) < hi))

    # --- 8. Bollinger reversion ---------------------------------------------
    add("bb_lo_rev", +1, (l <= f["bb_dn"]) & (c > f["bb_dn"]))
    add("bb_hi_rev", -1, (h >= f["bb_up"]) & (c < f["bb_up"]))
    add("bb_lo_brk", -1, c < f["bb_dn"])
    add("bb_hi_brk", +1, c > f["bb_up"])

    # --- 9. Compression breakout --------------------------------------------
    squeeze = f["bb_width_rank"] <= 0.25
    add("squeeze_up", +1, squeeze & (c > np.roll(f["hh12"], 1)))
    add("squeeze_dn", -1, squeeze & (c < np.roll(f["ll12"], 1)))
    inside = (h < np.roll(h, 1)) & (l > np.roll(l, 1))
    add("inside_up", +1, np.roll(inside, 1) & (c > np.roll(h, 1)))
    add("inside_dn", -1, np.roll(inside, 1) & (c < np.roll(l, 1)))

    # --- 10. Prior-day level reactions --------------------------------------
    add("pdl_sweep", +1, (l < f["pdl"]) & (c > f["pdl"]))
    add("pdh_sweep", -1, (h > f["pdh"]) & (c < f["pdh"]))
    add("pdh_brk", +1, (c > f["pdh"]) & (np.roll(c, 1) <= f["pdh"]))
    add("pdl_brk", -1, (c < f["pdl"]) & (np.roll(c, 1) >= f["pdl"]))

    # --- 11. Momentum ignition / exhaustion ---------------------------------
    for k in (3, 4, 5):
        add(f"consec_up{k}", -1, f["consec_up"] >= k)      # fade the run
        add(f"consec_dn{k}", +1, f["consec_dn"] >= k)
        add(f"consec_up{k}_go", +1, f["consec_up"] == k)   # follow the run
        add(f"consec_dn{k}_go", -1, f["consec_dn"] == k)
    for m in (1.5, 2.0):
        add(f"range_exp_up{m}", +1, (f["range_exp"] >= m) & (f["close_pos"] >= 0.7))
        add(f"range_exp_dn{m}", -1, (f["range_exp"] >= m) & (f["close_pos"] <= 0.3))

    # --- 12. Pin bars / rejection candles -----------------------------------
    for w in (0.5, 0.6):
        add(f"pin_bull{w}", +1, (f["lower_wick"] >= w) & (f["close_pos"] >= 0.6))
        add(f"pin_bear{w}", -1, (f["upper_wick"] >= w) & (f["close_pos"] <= 0.4))

    # --- 13. Session-extreme reversion --------------------------------------
    add("sess_lo_rev", +1, (l <= f["sess_lo"]) & (c > o) & (f["bars_from_open"] > 6))
    add("sess_hi_rev", -1, (h >= f["sess_hi"]) & (c < o) & (f["bars_from_open"] > 6))

    return [(n, d, m) for n, d, m in T if m.sum() >= 30]


# ===========================================================================
# Filters - dense boolean conditions
# ===========================================================================
def build_filters(f):
    """Return [(name, boolean array), ...] evaluated at the trigger bar."""
    F = []

    def add(name, mask):
        F.append((name, np.asarray(mask, dtype=bool)))

    et = f["et_min"]
    # --- session windows ----------------------------------------------------
    add("sess_rth", (et >= RTH_OPEN) & (et < RTH_CLOSE))
    add("sess_open60", (et >= RTH_OPEN) & (et < RTH_OPEN + 60))
    add("sess_open30", (et >= RTH_OPEN) & (et < RTH_OPEN + 30))
    add("sess_0930_1130", (et >= RTH_OPEN) & (et < 11 * 60 + 30))
    add("sess_1000_1200", (et >= 10 * 60) & (et < 12 * 60))
    add("sess_1130_1400", (et >= 11 * 60 + 30) & (et < 14 * 60))
    add("sess_1400_1600", (et >= 14 * 60) & (et < RTH_CLOSE))
    add("sess_power_hour", (et >= 15 * 60) & (et < RTH_CLOSE))
    add("sess_no_lunch", ~((et >= 12 * 60) & (et < 13 * 60 + 30)))
    add("sess_overnight", (et < RTH_OPEN) | (et >= RTH_CLOSE))
    add("sess_london", (et >= 3 * 60) & (et < RTH_OPEN))
    add("sess_premkt", (et >= 7 * 60) & (et < RTH_OPEN))
    add("sess_not_last30", et < RTH_CLOSE - 30)

    # --- day of week --------------------------------------------------------
    for i, nm in enumerate(("mon", "tue", "wed", "thu", "fri")):
        add(f"dow_{nm}", f["dow"] == i)
    add("dow_midweek", (f["dow"] >= 1) & (f["dow"] <= 3))

    # --- trend regime -------------------------------------------------------
    c = f["close"]
    add("above_ema200", c > f["ema200"])
    add("below_ema200", c < f["ema200"])
    add("above_ema50", c > f["ema50"])
    add("below_ema50", c < f["ema50"])
    add("ema_stack_up", (f["ema9"] > f["ema21"]) & (f["ema21"] > f["ema50"]))
    add("ema_stack_dn", (f["ema9"] < f["ema21"]) & (f["ema21"] < f["ema50"]))
    add("slope50_up", f["ema_slope50"] > 0)
    add("slope50_dn", f["ema_slope50"] < 0)
    add("slope9_up", f["ema_slope9"] > 0)
    add("slope9_dn", f["ema_slope9"] < 0)
    for t in (1.0, 2.0):
        add(f"far_above_ema50_{t}", f["dist_ema50"] > t)
        add(f"far_below_ema50_{t}", f["dist_ema50"] < -t)
        add(f"near_ema50_{t}", np.abs(f["dist_ema50"]) < t)

    # --- volatility regime --------------------------------------------------
    r = f["atr_rank"]
    add("atr_rank_lo", r <= 0.33)
    add("atr_rank_mid", (r > 0.33) & (r <= 0.66))
    add("atr_rank_hi", r > 0.66)
    add("atr_rank_top10", r > 0.90)
    add("atr_rank_bot25", r <= 0.25)
    add("atr_rank_not_extreme", (r > 0.10) & (r <= 0.90))
    for lo, hi in ((5, 15), (10, 30), (15, 60)):
        add(f"atr_pts_{lo}_{hi}", (f["atr_pts"] >= lo) & (f["atr_pts"] < hi))
    add("bbw_rank_lo", f["bb_width_rank"] <= 0.33)
    add("bbw_rank_hi", f["bb_width_rank"] > 0.66)
    add("range_exp_gt1", f["range_exp"] > 1.0)
    add("range_exp_gt15", f["range_exp"] > 1.5)
    add("range_contract", f["range_exp"] < 0.8)

    # --- volume -------------------------------------------------------------
    add("relvol_gt08", f["rel_vol"] > 0.8)
    add("relvol_gt1", f["rel_vol"] > 1.0)
    add("relvol_gt15", f["rel_vol"] > 1.5)
    add("relvol_gt2", f["rel_vol"] > 2.0)
    add("relvol_lt1", f["rel_vol"] <= 1.0)

    # --- location -----------------------------------------------------------
    add("above_vwap", f["vwap_dev"] > 0)
    add("below_vwap", f["vwap_dev"] < 0)
    add("vwap_near", np.abs(f["vwap_dev"]) < 1.0)
    add("vwap_far", np.abs(f["vwap_dev"]) >= 1.5)
    add("above_pdc", c > f["pdc"])
    add("below_pdc", c < f["pdc"])
    add("inside_pd_range", (c < f["pdh"]) & (c > f["pdl"]))
    add("outside_pd_range", (c > f["pdh"]) | (c < f["pdl"]))

    # --- bar structure ------------------------------------------------------
    add("body_gt05", f["body_frac"] > 0.5)
    add("body_lt03", f["body_frac"] < 0.3)
    add("close_pos_hi", f["close_pos"] >= 0.7)
    add("close_pos_lo", f["close_pos"] <= 0.3)
    add("close_pos_mid", (f["close_pos"] > 0.3) & (f["close_pos"] < 0.7))

    # --- momentum zones -----------------------------------------------------
    add("rsi14_gt50", f["rsi14"] > 50)
    add("rsi14_lt50", f["rsi14"] < 50)
    add("rsi14_30_70", (f["rsi14"] > 30) & (f["rsi14"] < 70))
    add("rsi7_gt60", f["rsi7"] > 60)
    add("rsi7_lt40", f["rsi7"] < 40)

    # --- time since open ----------------------------------------------------
    b = f["bars_from_open"]
    add("bfo_first12", (b >= 0) & (b < 12))
    add("bfo_after12", b >= 12)
    add("bfo_12_48", (b >= 12) & (b < 48))

    return F
