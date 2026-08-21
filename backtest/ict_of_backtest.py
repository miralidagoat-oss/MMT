#!/usr/bin/env python3
"""Offline backtest of indicators/mmt_ict_orderflow_suite.pine.

A line-for-line port of the Pine strategy: same sessions, same liquidity map,
same raid -> displacement -> PD-array model, same confluence score, same
sizing and the same order lifecycle as TradingView's broker emulator with
process_orders_on_close = false:

  - a signal on bar N places a RESTING LIMIT plus its protective bracket;
    the pair can first act on bar N+1
  - a limit fills only when price trades through it, at the limit price
  - the stop is live from the instant the limit fills (same bar included)
  - market exits (time stop, EOD flat, daily stop) fill at the NEXT bar's open
  - stop exits pay slippage; limit exits do not
  - when a bar contains both the stop and the target, the pessimistic run
    books the stop and the optimistic run books the target

Usage
  python3 ict_of_backtest.py <data_dir> report          full report, MNQ 5m
  python3 ict_of_backtest.py <data_dir> presets         Precision/Balanced/Volume
  python3 ict_of_backtest.py <data_dir> sweep           threshold + RR sweep
  python3 ict_of_backtest.py <data_dir> wf              walk-forward
  python3 ict_of_backtest.py <data_dir> cross           other index futures
"""
import csv
import json
import math
import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

# ---------------------------------------------------------------------------
# parameters - names mirror the Pine inputs
# ---------------------------------------------------------------------------
DIAG = {}


def _d(k, n=1):
    DIAG[k] = DIAG.get(k, 0) + n


P0 = dict(
    # instrument
    tick=0.25, point_value=2.0, commission=0.62, slip_ticks=2,
    initial_capital=25000.0,
    # engine
    thresh=7, req_mss=True, req_fvg=True, req_kz=True,
    allow_long=True, allow_short=True,
    # risk
    risk_usd=250.0, max_qty=20, skip_unfunded=True, size_mode="risk",
    min_stop_pt=10.0, max_stop_pt=70.0,
    stop_mode="raid", min_stop_atr=0.0, max_stop_atr=99.0, rvol_hot=1.3,
    rr_mode="stretch", fixed_r=2.0, use_part=False, tp1_r=1.0, tp1_pct=50,
    use_delta_score=True,
    min_r=1.5, def_r=2.0, max_r=5.0, tgt_off_ticks=4,
    be_on=True, be_trig_r=1.0, be_off_ticks=4,
    max_hold=36, max_trades=6, max_day_dd=750.0,
    # sessions (ET, minutes from midnight)
    rth=(570, 960), asia=(1200, 1440), orng=(570, 600), ib=(570, 630),
    kz_lon=None, kz_am=(510, 660), kz_sb=(600, 660), kz_pm=(810, 960),
    news=((508, 516), (598, 604), (838, 844)), use_news=True,
    flat=(950, 960), flat_on=True,
    # vwap / profile / flow
    sd1=1.0, vp_auto=True, vp_bin_atr=0.25, vp_bin_fix=5.0, va_pct=70.0,
    div_len=20,
    # structure
    pv_len=2, struct_lb=12, sweep_lb=3, min_pen_ticks=1, eq_tol_atr=0.15,
    disp_atr=0.55, leg_atr=1.10, mss_max_bar=12, zone_valid=12,
    zone_mode="Auto", fill_pref="mid", ote_hi=0.79, ote_lo=0.62,
    ob_lb=15, ob_body=False, no_retrace="Skip", stop_buf_atr=0.20,
    # filters
    atr_len=14, atr_min_pt=8.0, atr_max_pt=120.0,
    rvol_len=20, rvol_min=0.80, ema_fast=21, ema_slow=89,
    use_htf=True, htf_min=30, htf_ema=21, veto_htf=False, use_vw_tgt=True,
)

# Mirrors the three presets in indicators/mmt_ict_orderflow_suite.pine exactly.
_COMMON = dict(req_fvg=False, req_kz=True, be_on=False, use_part=False,
               rr_mode="fixed", fill_pref="aggressive", max_r=6.0,
               min_stop_pt=0.0, max_stop_pt=1000.0, atr_min_pt=0.0, atr_max_pt=500.0,
               max_stop_atr=2.5)
PRESETS = {
    "Precision": dict(_COMMON, thresh=7, req_mss=True,  stop_mode="tighter", fixed_r=1.5, min_stop_atr=1.00),
    "Balanced":  dict(_COMMON, thresh=5, req_mss=True,  stop_mode="zone",    fixed_r=2.0, min_stop_atr=0.75),
    "Volume":    dict(_COMMON, thresh=3, req_mss=False, stop_mode="zone",    fixed_r=2.0, min_stop_atr=0.50),
}


# ---------------------------------------------------------------------------
# data
# ---------------------------------------------------------------------------
def load(path):
    t, o, h, l, c, v = [], [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            t.append(int(row["time"]))
            o.append(float(row["open"]))
            h.append(float(row["high"]))
            l.append(float(row["low"]))
            c.append(float(row["close"]))
            v.append(float(row["volume"]))
    return dict(t=t, o=o, h=h, l=l, c=c, v=v, n=len(t))


def rma(xs, n):
    out, acc = [None] * len(xs), None
    for i, x in enumerate(xs):
        if i < n - 1:
            continue
        if acc is None:
            acc = sum(xs[i - n + 1:i + 1]) / n
        else:
            acc = (acc * (n - 1) + x) / n
        out[i] = acc
    return out


def ema(xs, n):
    out, k, prev = [None] * len(xs), 2.0 / (n + 1.0), None
    for i, x in enumerate(xs):
        if i < n - 1:
            continue
        if prev is None:
            prev = sum(xs[i - n + 1:i + 1]) / n
        else:
            prev = x * k + prev * (1 - k)
        out[i] = prev
    return out


def sma(xs, n):
    out, run = [None] * len(xs), 0.0
    for i, x in enumerate(xs):
        run += x
        if i >= n:
            run -= xs[i - n]
        if i >= n - 1:
            out[i] = run / n
    return out


def prep(b, P):
    n = b["n"]
    o, h, l, c, v = b["o"], b["h"], b["l"], b["c"], b["v"]

    tr = [h[0] - l[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
                          for i in range(1, n)]
    b["atr"] = rma(tr, P["atr_len"])
    b["emaF"] = ema(c, P["ema_fast"])
    b["emaS"] = ema(c, P["ema_slow"])
    vsma = sma(v, P["rvol_len"])
    b["rvol"] = [(v[i] / vsma[i]) if vsma[i] else 1.0 for i in range(n)]

    # ---- ET calendar fields -------------------------------------------------
    mins, dates, fdays, weeks = [], [], [], []
    for ts in b["t"]:
        d = datetime.fromtimestamp(ts, timezone.utc).astimezone(ET)
        mins.append(d.hour * 60 + d.minute)
        dates.append(d.date())
        # CME trading day rolls at 18:00 ET
        fd = (d.timestamp() + 6 * 3600)
        fdd = datetime.fromtimestamp(fd, timezone.utc).astimezone(ET).date()
        fdays.append(fdd)
        weeks.append(fdd.isocalendar()[:2])
    b["min"], b["date"], b["fday"], b["week"] = mins, dates, fdays, weeks

    def insess(i, w):
        if w is None:
            return False
        a, z = w
        return a <= mins[i] < z

    b["inRTH"] = [insess(i, P["rth"]) for i in range(n)]
    b["inAsia"] = [insess(i, P["asia"]) for i in range(n)]
    b["inOR"] = [insess(i, P["orng"]) for i in range(n)]
    b["inIB"] = [insess(i, P["ib"]) for i in range(n)]
    b["inFlat"] = [insess(i, P["flat"]) for i in range(n)]
    b["inKZ"] = [insess(i, P["kz_lon"]) or insess(i, P["kz_am"]) or
                 insess(i, P["kz_sb"]) or insess(i, P["kz_pm"]) for i in range(n)]
    b["blackout"] = [P["use_news"] and any(insess(i, w) for w in P["news"])
                     for i in range(n)]

    # ---- confirmed swing pivots (ta.pivothigh/low(len, len)) ----------------
    L = P["pv_len"]
    ph, pl = [None] * n, [None] * n
    for i in range(2 * L, n):
        k = i - L
        hk, lk = h[k], l[k]
        if all(hk > h[j] for j in range(k - L, k)) and all(hk > h[j] for j in range(k + 1, k + L + 1)):
            ph[i] = hk
        if all(lk < l[j] for j in range(k - L, k)) and all(lk < l[j] for j in range(k + 1, k + L + 1)):
            pl[i] = lk
    b["ph"], b["pl"] = ph, pl

    # ---- prior-day / prior-week RTH extremes -------------------------------
    # value at bar i = the most recent RTH session that had already CLOSED
    # before bar i (matches request.security(rthTicker, "D", high[1])).
    sessions, cur = [], None
    for i in range(n):
        if not b["inRTH"][i]:
            continue
        d = dates[i]
        if cur is None or cur[0] != d:
            if cur is not None:
                sessions.append(cur)
            cur = [d, h[i], l[i], b["t"][i]]
        else:
            cur[1] = max(cur[1], h[i])
            cur[2] = min(cur[2], l[i])
            cur[3] = b["t"][i]
    if cur is not None:
        sessions.append(cur)

    pdh, pdl = [None] * n, [None] * n
    pwh, pwl = [None] * n, [None] * n
    wk_hi, wk_lo, wk_end, wk_order = {}, {}, {}, []
    for d, hi, lo, ts in sessions:
        w = d.isocalendar()[:2]
        if w not in wk_hi:
            wk_hi[w], wk_lo[w] = hi, lo
            wk_order.append(w)
        else:
            wk_hi[w], wk_lo[w] = max(wk_hi[w], hi), min(wk_lo[w], lo)
        wk_end[w] = ts
    ptr = 0
    wptr = 0
    for i in range(n):
        while ptr < len(sessions) and sessions[ptr][3] < b["t"][i]:
            ptr += 1
        if ptr >= 1:
            pdh[i], pdl[i] = sessions[ptr - 1][1], sessions[ptr - 1][2]
        while wptr < len(wk_order) and wk_end[wk_order[wptr]] < b["t"][i]:
            wptr += 1
        if wptr >= 1:
            w = wk_order[wptr - 1]
            pwh[i], pwl[i] = wk_hi[w], wk_lo[w]
    b["pdh"], b["pdl"], b["pwh"], b["pwl"] = pdh, pdl, pwh, pwl

    # ---- HTF bias: last COMPLETED htf bar (lookahead_off + [1]) -------------
    step = P["htf_min"]
    bucket = [(b["t"][i] // (step * 60)) for i in range(n)]
    bclose, bidx = [], {}
    for i in range(n):
        k = bucket[i]
        if k not in bidx:
            bidx[k] = len(bclose)
            bclose.append(c[i])
        else:
            bclose[bidx[k]] = c[i]
    be = ema(bclose, P["htf_ema"])
    htfC, htfE = [None] * n, [None] * n
    for i in range(n):
        j = bidx[bucket[i]] - 1
        if j >= 0:
            htfC[i] = bclose[j]
            htfE[i] = be[j]
    b["htfC"], b["htfE"] = htfC, htfE
    return b


# ---------------------------------------------------------------------------
# engine
# ---------------------------------------------------------------------------
def run(b, P, pessimistic=True):
    n = b["n"]
    o, h, l, c, v = b["o"], b["h"], b["l"], b["c"], b["v"]
    tick, pv = P["tick"], P["point_value"]
    slip = P["slip_ticks"] * tick
    ftick = lambda x: round(x / tick) * tick

    equity = P["initial_capital"]
    trades, eq_curve = [], []

    # session-scoped state
    vw_pv = vw_v = vw_p2 = 0.0
    cvd = 0.0
    cvd_hist, low_hist, high_hist = [], [], []
    vp_bins, vp_base, bin_sz = [], None, None
    vp_poc = vp_vah = vp_val = None
    p_poc = p_vah = p_val = None
    asia_hi = asia_lo = or_hi = or_lo = ib_hi = ib_lo = None
    day_hi = day_lo = None
    bars_in_day = 0
    prev_day_hi = prev_day_lo = None
    last_ph = prev_ph = last_pl = prev_pl = None
    last_ph_b = last_pl_b = None
    eq_hi = eq_lo = None
    trades_today, day_start_eq = 0, equity

    sw_dir, sw_ext, sw_run, sw_bar, sw_ref = 0, None, None, None, None
    sw_major = sw_div = sw_va = sw_vw = sw_or = False

    pending = None            # dict(dir, e, s, tp, qty, risk, bar)
    pos = None                # dict(dir, e, s, tp, qty, risk, bar, be)
    market_close_next = None  # reason string

    for i in range(n):
        atr = b["atr"][i]
        bar_h, bar_l, bar_o, bar_c = h[i], l[i], o[i], c[i]
        filled_this_bar = False

        # =================== BROKER PHASE (orders from bar i-1) ==============
        # A market close requested by the previous bar's script phase fills at
        # this bar's open, ahead of anything else.
        if pos is not None and market_close_next is not None:
            px = bar_o - pos["dir"] * slip
            pos["realized"] += _pl(pos, px, pos["rem"], P)
            equity += _finalize(trades, pos, b, i, market_close_next, P)
            pos, market_close_next = None, None

        if pending is not None and pos is None:
            d, e = pending["dir"], pending["e"]
            if (bar_l <= e) if d == 1 else (bar_h >= e):
                r0 = (pending["e"] - pending["s"]) * d
                pos = dict(pending)
                pos.update(bar=i, be=False, mfe=0.0, s0=pending["s"],
                           rem=pending["qty"], realized=0.0, tp1_done=False,
                           tp1=ftick(pending["e"] + d * r0 * P["tp1_r"]))
                pending = None
                filled_this_bar = True

        if pos is not None:
            d, s_lv, tp_lv = pos["dir"], pos["s"], pos["tp"]
            stop_hit = (bar_l <= s_lv) if d == 1 else (bar_h >= s_lv)
            tgt_hit = (bar_h >= tp_lv) if d == 1 else (bar_l <= tp_lv)
            tp1_hit = False
            if P["use_part"] and not pos["tp1_done"]:
                tp1_hit = (bar_h >= pos["tp1"]) if d == 1 else (bar_l <= pos["tp1"])
            # On the bar the limit filled, a favourable touch is ambiguous: the
            # extreme may have printed before the fill. Only the stop is
            # deterministic there (it sits beyond the fill price).
            ambiguous = pos["bar"] == i

            def take_partial():
                if not P["use_part"] or pos["tp1_done"]:
                    return
                q1 = int(pos["qty"] * P["tp1_pct"] / 100)
                q1 = min(q1, pos["rem"] - 1)
                pos["tp1_done"] = True
                if q1 >= 1:
                    pos["realized"] += _pl(pos, pos["tp1"], q1, P)
                    pos["rem"] -= q1

            if pessimistic:
                if stop_hit:
                    px = _stop_px(s_lv, bar_o, d, slip)
                    pos["realized"] += _pl(pos, px, pos["rem"], P)
                    equity += _finalize(trades, pos, b, i, "stop", P)
                    pos, market_close_next = None, None
                elif not ambiguous:
                    if tp1_hit:
                        take_partial()
                    if tgt_hit:
                        px = tp_lv if ((d == 1 and bar_o < tp_lv) or (d == -1 and bar_o > tp_lv)) else bar_o
                        pos["realized"] += _pl(pos, px, pos["rem"], P)
                        equity += _finalize(trades, pos, b, i, "target", P)
                        pos, market_close_next = None, None
            else:
                if tp1_hit:
                    take_partial()
                if tgt_hit:
                    px = tp_lv if ((d == 1 and bar_o < tp_lv) or (d == -1 and bar_o > tp_lv)) else bar_o
                    pos["realized"] += _pl(pos, px, pos["rem"], P)
                    equity += _finalize(trades, pos, b, i, "target", P)
                    pos, market_close_next = None, None
                elif stop_hit:
                    px = _stop_px(s_lv, bar_o, d, slip)
                    pos["realized"] += _pl(pos, px, pos["rem"], P)
                    equity += _finalize(trades, pos, b, i, "stop", P)
                    pos, market_close_next = None, None

        eq_curve.append(equity)

        # =================== SCRIPT PHASE (runs on this bar's close) =========
        new_day = i == 0 or b["fday"][i] != b["fday"][i - 1]
        new_wk = i == 0 or b["week"][i] != b["week"][i - 1]
        new_rth = b["inRTH"][i] and (i == 0 or not b["inRTH"][i - 1])
        new_asia = b["inAsia"][i] and (i == 0 or not b["inAsia"][i - 1])
        new_or = b["inOR"][i] and (i == 0 or not b["inOR"][i - 1])
        new_ib = b["inIB"][i] and (i == 0 or not b["inIB"][i - 1])

        if new_day:
            trades_today, day_start_eq = 0, equity
        if filled_this_bar:
            trades_today += 1
        day_pnl = equity - day_start_eq
        dd_hit = day_pnl <= -P["max_day_dd"]
        risk_ok = trades_today < P["max_trades"] and not dd_hit

        # ---- VWAP ----------------------------------------------------------
        if new_rth:
            vw_pv = vw_v = vw_p2 = 0.0
        src = (bar_h + bar_l + bar_c) / 3.0
        vw_pv += src * v[i]
        vw_v += v[i]
        vw_p2 += src * src * v[i]
        vwap = vw_pv / vw_v if vw_v > 0 else None
        vsd = math.sqrt(max(vw_p2 / vw_v - vwap * vwap, 0.0)) if vw_v > 0 else None
        vw1u = vwap + P["sd1"] * vsd if vwap is not None else None
        vw1d = vwap - P["sd1"] * vsd if vwap is not None else None

        # ---- delta / CVD ---------------------------------------------------
        d_bar = v[i] * (2.0 * (bar_c - bar_l) / (bar_h - bar_l) - 1.0) if bar_h > bar_l else 0.0
        if new_day:
            cvd = 0.0
        cvd += d_bar
        cvd_hist.append(cvd)
        low_hist.append(bar_l)
        high_hist.append(bar_h)
        dl = P["div_len"]
        w_lo = min(low_hist[-dl:])
        w_hi = max(high_hist[-dl:])
        w_clo = min(cvd_hist[-dl:])
        w_chi = max(cvd_hist[-dl:])
        bull_div = bar_l <= w_lo and cvd > w_clo
        bear_div = bar_h >= w_hi and cvd < w_chi

        # ---- volume profile (anchor = futures day) -------------------------
        if new_day or bin_sz is None:
            p_poc, p_vah, p_val = vp_poc, vp_vah, vp_val
            vp_bins, vp_base = [], None
            vp_poc = vp_vah = vp_val = None
            raw = (atr if atr else 10.0) * P["vp_bin_atr"] if P["vp_auto"] else P["vp_bin_fix"]
            bin_sz = max(tick, round(raw / tick) * tick)
        if v[i] > 0:
            lo_b = math.floor(bar_l / bin_sz)
            hi_b = math.floor(bar_h / bin_sz)
            span = hi_b - lo_b + 1
            if 0 < span <= 400:
                if vp_base is None:
                    vp_base = lo_b
                    vp_bins = [0.0] * span
                if lo_b < vp_base:
                    vp_bins = [0.0] * (vp_base - lo_b) + vp_bins
                    vp_base = lo_b
                if hi_b > vp_base + len(vp_bins) - 1:
                    vp_bins += [0.0] * (hi_b - (vp_base + len(vp_bins) - 1))
                per = v[i] / span
                for bb in range(lo_b, hi_b + 1):
                    vp_bins[bb - vp_base] += per
        if vp_bins:
            total = sum(vp_bins)
            poc_idx = max(range(len(vp_bins)), key=lambda k: vp_bins[k])
            vp_poc = (vp_base + poc_idx + 0.5) * bin_sz
            acc, tgt = vp_bins[poc_idx], total * P["va_pct"] / 100.0
            lo_i = hi_i = poc_idx
            while acc < tgt and (lo_i > 0 or hi_i < len(vp_bins) - 1):
                a = vp_bins[lo_i - 1] if lo_i > 0 else -1.0
                z = vp_bins[hi_i + 1] if hi_i < len(vp_bins) - 1 else -1.0
                if z > a:
                    hi_i += 1
                    acc += z
                else:
                    lo_i -= 1
                    acc += a
            vp_val = (vp_base + lo_i) * bin_sz
            vp_vah = (vp_base + hi_i + 1) * bin_sz

        # ---- ranges --------------------------------------------------------
        if new_asia:
            asia_hi, asia_lo = bar_h, bar_l
        elif b["inAsia"][i] and asia_hi is not None:
            asia_hi, asia_lo = max(asia_hi, bar_h), min(asia_lo, bar_l)
        if new_or:
            or_hi, or_lo = bar_h, bar_l
        elif b["inOR"][i] and or_hi is not None:
            or_hi, or_lo = max(or_hi, bar_h), min(or_lo, bar_l)
        if new_ib:
            ib_hi, ib_lo = bar_h, bar_l
        elif b["inIB"][i] and ib_hi is not None:
            ib_hi, ib_lo = max(ib_hi, bar_h), min(ib_lo, bar_l)
        prev_day_hi, prev_day_lo = day_hi, day_lo
        if new_day:
            day_hi, day_lo, bars_in_day = bar_h, bar_l, 1
        else:
            day_hi = bar_h if day_hi is None else max(day_hi, bar_h)
            day_lo = bar_l if day_lo is None else min(day_lo, bar_l)
            bars_in_day += 1

        # ---- swings / equal highs & lows -----------------------------------
        if b["ph"][i] is not None:
            prev_ph, last_ph = last_ph, b["ph"][i]
            last_ph_b = i - P["pv_len"]
            if prev_ph is not None and atr and abs(last_ph - prev_ph) <= P["eq_tol_atr"] * atr:
                eq_hi = max(last_ph, prev_ph)
        if b["pl"][i] is not None:
            prev_pl, last_pl = last_pl, b["pl"][i]
            last_pl_b = i - P["pv_len"]
            if prev_pl is not None and atr and abs(last_pl - prev_pl) <= P["eq_tol_atr"] * atr:
                eq_lo = min(last_pl, prev_pl)
        if eq_hi is not None and bar_c > eq_hi:
            eq_hi = None
        if eq_lo is not None and bar_c < eq_lo:
            eq_lo = None

        # ---- liquidity pools ------------------------------------------------
        maj_buy = [x for x in (b["pdh"][i], b["pwh"][i], asia_hi, or_hi, ib_hi, p_vah) if x is not None]
        maj_sell = [x for x in (b["pdl"][i], b["pwl"][i], asia_lo, or_lo, ib_lo, p_val) if x is not None]
        min_buy = [x for x in (last_ph, eq_hi, vp_vah) if x is not None]
        min_sell = [x for x in (last_pl, eq_lo, vp_val) if x is not None]
        if bars_in_day > P["sweep_lb"] + 2:
            if prev_day_hi is not None:
                min_buy.append(prev_day_hi)
            if prev_day_lo is not None:
                min_sell.append(prev_day_lo)
        tgt_buy = maj_buy + min_buy + [x for x in (vp_poc, p_poc) if x is not None]
        tgt_sell = maj_sell + min_sell + [x for x in (vp_poc, p_poc) if x is not None]
        if P["use_vw_tgt"] and vsd:
            tgt_buy += [vwap + k * vsd for k in (1, 2, 3)]
            tgt_sell += [vwap - k * vsd for k in (1, 2, 3)]

        # ---- raid detection --------------------------------------------------
        slb = P["sweep_lb"]
        low_k = min(l[max(0, i - slb + 1):i + 1])
        high_k = max(h[max(0, i - slb + 1):i + 1])
        pen = P["min_pen_ticks"] * tick
        cprev = c[i - 1] if i else bar_c

        def raid_sell(pool):
            best = None
            for lv in pool:
                if lv - low_k >= pen and bar_c > lv and (bar_l <= lv or cprev <= lv):
                    best = lv if best is None else max(best, lv)
            return best

        def raid_buy(pool):
            best = None
            for lv in pool:
                if high_k - lv >= pen and bar_c < lv and (bar_h >= lv or cprev >= lv):
                    best = lv if best is None else min(best, lv)
            return best

        s_maj, s_min = raid_sell(maj_sell), raid_sell(min_sell)
        b_maj, b_min = raid_buy(maj_buy), raid_buy(min_buy)
        swept_sell = s_maj is not None or s_min is not None
        swept_buy = b_maj is not None or b_min is not None

        # ---- raid state machine ---------------------------------------------
        if sw_dir == 1 and (bar_c < sw_ext or i - sw_bar > P["mss_max_bar"]):
            sw_dir = 0
        if sw_dir == -1 and (bar_c > sw_ext or i - sw_bar > P["mss_max_bar"]):
            sw_dir = 0

        sl = P["struct_lb"]
        ref_hi_prev = max(h[max(0, i - sl):i]) if i else None
        ref_lo_prev = min(l[max(0, i - sl):i]) if i else None

        if swept_sell and not swept_buy and P["allow_long"]:
            sw_dir, sw_ext, sw_run, sw_bar = 1, low_k, bar_h, i
            sw_major = s_maj is not None
            sw_div = bull_div
            sw_va = vp_val is not None and low_k < vp_val
            sw_vw = vw1d is not None and low_k < vw1d
            sw_or = or_lo is not None and low_k <= or_lo
            phc = last_ph if (last_ph is not None and last_ph_b is not None and i - last_ph_b <= sl) else None
            sw_ref = ref_hi_prev if phc is None else min(phc, ref_hi_prev)
        elif swept_buy and not swept_sell and P["allow_short"]:
            sw_dir, sw_ext, sw_run, sw_bar = -1, high_k, bar_l, i
            sw_major = b_maj is not None
            sw_div = bear_div
            sw_va = vp_vah is not None and high_k > vp_vah
            sw_vw = vw1u is not None and high_k > vw1u
            sw_or = or_hi is not None and high_k >= or_hi
            plc = last_pl if (last_pl is not None and last_pl_b is not None and i - last_pl_b <= sl) else None
            sw_ref = ref_lo_prev if plc is None else max(plc, ref_lo_prev)

        if sw_dir == 1:
            sw_run = max(sw_run, bar_h)
        elif sw_dir == -1:
            sw_run = min(sw_run, bar_l)

        if sw_dir != 0 and (i == sw_bar):
            _d("raids_armed")
        made = False
        if sw_dir != 0 and atr and sw_ref is not None:
            D = sw_dir
            mss = (bar_c - sw_ref) * D > 0
            disp = ((bar_c - bar_o) * D >= P["disp_atr"] * atr or
                    (bar_c - sw_ext) * D >= P["leg_atr"] * atr)

            have_fvg, fvg_n, fvg_f = False, None, None
            for k in range(0, 3):
                if i - k - 2 < 0:
                    break
                if D == 1 and l[i - k] > h[i - k - 2]:
                    have_fvg, fvg_n, fvg_f = True, l[i - k], h[i - k - 2]
                    break
                if D == -1 and h[i - k] < l[i - k - 2]:
                    have_fvg, fvg_n, fvg_f = True, h[i - k], l[i - k - 2]
                    break

            have_ob, ob_n, ob_f = False, None, None
            for k in range(0, P["ob_lb"] + 1):
                j = i - k
                if j < 0:
                    break
                if D == 1 and c[j] < o[j]:
                    have_ob = True
                    ob_n, ob_f = (o[j], c[j]) if P["ob_body"] else (h[j], l[j])
                    break
                if D == -1 and c[j] > o[j]:
                    have_ob = True
                    ob_n, ob_f = (o[j], c[j]) if P["ob_body"] else (l[j], h[j])
                    break

            rng = (sw_run - sw_ext) * D
            have_ote = rng > 0
            ote_n = sw_run - D * P["ote_lo"] * rng if have_ote else None
            ote_f = sw_run - D * P["ote_hi"] * rng if have_ote else None

            if mss and disp:
                _d("mss_disp")
            gate = (
                (not P["req_mss"] or (mss and disp)) and
                (not P["req_fvg"] or have_fvg) and
                (not P["req_kz"] or b["inKZ"][i]) and
                P["atr_min_pt"] <= atr <= P["atr_max_pt"] and
                b["rvol"][i] >= P["rvol_min"] and
                (not b["blackout"][i]) and not (P["flat_on"] and b["inFlat"][i]) and
                pending is None and pos is None and (mss or not P["req_mss"])
            )
            if (mss or not P["req_mss"]) and (not P["req_mss"] or (mss and disp)) \
               and (not P["req_fvg"] or have_fvg) and not gate:
                if pending is not None or pos is not None:
                    _d("blocked_busy")
                elif P["req_kz"] and not b["inKZ"][i]:
                    _d("blocked_kz")
                elif b["blackout"][i]:
                    _d("blocked_news")
                else:
                    _d("blocked_other")
            htf_bias = 0
            if b["htfC"][i] is not None and b["htfE"][i] is not None:
                htf_bias = 1 if b["htfC"][i] > b["htfE"][i] else (-1 if b["htfC"][i] < b["htfE"][i] else 0)
            if P["veto_htf"] and htf_bias * D < 0:
                gate = False

            if gate:
                _d("gate_pass")
                zn = zf = None
                mode = P["zone_mode"]
                ov = None
                if have_fvg and have_ote:
                    aN = min(fvg_n, ote_n) if D == 1 else max(fvg_n, ote_n)
                    aF = max(fvg_f, ote_f) if D == 1 else min(fvg_f, ote_f)
                    if (aN - aF) * D > 0:
                        ov = (aN, aF)
                if mode == "FVG" and have_fvg:
                    zn, zf = fvg_n, fvg_f
                elif mode == "OTE" and have_ote:
                    zn, zf = ote_n, ote_f
                elif mode == "Order block" and have_ob:
                    zn, zf = ob_n, ob_f
                elif mode == "FVG + OTE" and ov:
                    zn, zf = ov
                elif mode == "Auto":
                    if ov:
                        zn, zf = ov
                    elif have_fvg:
                        zn, zf = fvg_n, fvg_f
                    elif have_ob:
                        zn, zf = ob_n, ob_f
                    elif have_ote:
                        zn, zf = ote_n, ote_f

                if zn is not None:
                    _d("zone_ok")
                    e = {"aggressive": zn, "patient": zf}.get(P["fill_pref"], (zn + zf) / 2.0)
                    ok = (bar_c - e) * D > tick
                    if not ok and P["no_retrace"] == "Market":
                        e, ok = bar_c, True
                    if ok:
                        _d("retrace_ok")
                        e = ftick(e)
                        raid_b = sw_ext
                        zone_b = zf
                        if P["stop_mode"] == "zone":
                            sbase = zone_b
                        elif P["stop_mode"] == "tighter":
                            sbase = max(raid_b, zone_b) if D == 1 else min(raid_b, zone_b)
                        else:
                            sbase = min(raid_b, zone_b) if D == 1 else max(raid_b, zone_b)
                        s = ftick(sbase - D * P["stop_buf_atr"] * atr)
                        rpts = (e - s) * D
                        tp = None
                        lo_b_pt = max(P["min_stop_pt"], P["min_stop_atr"] * atr)
                        hi_b_pt = min(P["max_stop_pt"], P["max_stop_atr"] * atr)
                        if not (lo_b_pt <= rpts <= hi_b_pt):
                            _d("stop_oob")
                        if lo_b_pt <= rpts <= hi_b_pt:
                            _d("stop_ok")
                            pool = tgt_buy if D == 1 else tgt_sell
                            tp = None
                            if P["rr_mode"] == "fixed":
                                tp = ftick(e + D * rpts * P["fixed_r"])
                            elif P["rr_mode"] == "pool":
                                # take the nearest real pool; skip when it is too close
                                cands = [x for x in pool if (x - e) * D > rpts * 0.3]
                                traw = (min(cands) if D == 1 else max(cands)) if cands else None
                                if traw is not None:
                                    off = traw - D * P["tgt_off_ticks"] * tick
                                    rr = (off - e) * D / rpts
                                    if rr >= P["min_r"]:
                                        cap = e + D * rpts * P["max_r"]
                                        tp = ftick(min(off, cap) if D == 1 else max(off, cap))
                            else:  # stretch
                                need = rpts * P["min_r"]
                                cands = [x for x in pool if (x - e) * D > need]
                                traw = (min(cands) if D == 1 else max(cands)) if cands else None
                                if traw is None:
                                    tp = e + D * rpts * P["def_r"]
                                else:
                                    cap = e + D * rpts * P["max_r"]
                                    off = traw - D * P["tgt_off_ticks"] * tick
                                    tp = min(off, cap) if D == 1 else max(off, cap)
                                mint = e + D * rpts * P["min_r"]
                                tp = ftick(max(tp, mint) if D == 1 else min(tp, mint))
                            if tp is not None:

                                sc = 2 if sw_major else 0
                                if mss and disp:
                                    sc += 1
                                if (bar_c - sw_ext) * D >= 1.5 * atr:
                                    sc += 1
                                if ov:
                                    sc += 2
                                elif have_fvg:
                                    sc += 1
                                if have_ote and (sw_run - D * 0.5 * rng - e) * D > 0:
                                    sc += 1
                                if vwap is not None and (bar_c - vwap) * D > 0:
                                    sc += 1
                                if P["use_delta_score"]:
                                    if sw_div:
                                        sc += 1
                                    if d_bar * D > 0:
                                        sc += 1
                                if sw_va:
                                    sc += 1
                                cb = 0
                                if b["emaF"][i] and b["emaS"][i]:
                                    cb = 1 if (b["emaF"][i] > b["emaS"][i] and bar_c > b["emaF"][i]) else \
                                         (-1 if (b["emaF"][i] < b["emaS"][i] and bar_c < b["emaF"][i]) else 0)
                                if cb == D:
                                    sc += 1
                                if P["use_htf"] and htf_bias == D:
                                    sc += 1
                                pdhi, pdlo = b["pdh"][i], b["pdl"][i]
                                if pdhi and pdlo and pdhi > pdlo and ((pdhi + pdlo) / 2.0 - bar_c) * D > 0:
                                    sc += 1
                                if sw_or:
                                    sc += 1
                                if b["rvol"][i] >= P["rvol_hot"]:
                                    sc += 1

                                _d("score_sum", sc)
                                _d("score_n")
                                if sc < P["thresh"]:
                                    _d("score_fail")
                                if sc >= P["thresh"]:
                                    if P["size_mode"] == "fixed":
                                        qty = 1
                                    else:
                                        per = rpts * pv
                                        qty = int(P["risk_usd"] // per) if per > 0 else 0
                                        qty = min(qty, P["max_qty"])
                                        if qty < 1:
                                            qty = 0 if P["skip_unfunded"] else 1
                                    if not risk_ok:
                                        _d("risk_block")
                                    if qty >= 1 and risk_ok:
                                        _d("orders_placed")
                                        pending = dict(dir=D, e=e, s=s, tp=tp, qty=qty,
                                                       risk=rpts * pv * qty, bar=i, score=sc,
                                                       inval=sw_ext, t=b["t"][i])
                                    made = True
        if made:
            sw_dir = 0

        # ---- cancel resting orders -------------------------------------------
        if pending is not None and pos is None:
            expired = i - pending["bar"] > P["zone_valid"]
            invalid = (bar_c - pending["inval"]) * pending["dir"] < 0
            if expired or invalid or not risk_ok or (P["flat_on"] and b["inFlat"][i]):
                pending = None

        # ---- manage the open position ----------------------------------------
        if pos is not None:
            D = pos["dir"]
            r0 = (pos["e"] - pos["s0"]) * D
            fav = bar_h if D == 1 else bar_l
            pos["mfe"] = max(pos["mfe"], (fav - pos["e"]) * D)
            if P["be_on"] and not pos["be"] and r0 > 0 and (fav - pos["e"]) * D >= r0 * P["be_trig_r"]:
                pos["be"] = True
                pos["s"] = ftick(pos["e"] + D * P["be_off_ticks"] * tick)
            if i - pos["bar"] >= P["max_hold"]:
                market_close_next = "time stop"
            elif dd_hit:
                market_close_next = "daily stop"
            elif P["flat_on"] and b["inFlat"][i]:
                market_close_next = "EOD flat"

    return trades, eq_curve


def _stop_px(s, bar_open, d, slip):
    # a gap through the stop fills at the open; otherwise at the stop - slippage
    if d == 1:
        return min(s, bar_open) - slip
    return max(s, bar_open) + slip


def _pl(pos, exit_px, qty, P):
    gross = (exit_px - pos["e"]) * pos["dir"] * P["point_value"] * qty
    return gross - 2.0 * P["commission"] * qty


def _finalize(trades, pos, b, i, reason, P):
    """One closed-trade record per ENTRY, netting any scale-out."""
    net = pos["realized"]
    d = pos["dir"]
    r0 = (pos["e"] - pos["s0"]) * d
    trades.append(dict(t=b["t"][pos["bar"]], dir=d, entry=pos["e"], qty=pos["qty"],
                       net=net, reason=reason, risk=pos["risk"],
                       R=net / pos["risk"] if pos["risk"] else 0.0,
                       score=pos.get("score", 0), bars=i - pos["bar"],
                       planR=((pos["tp"] - pos["e"]) * d / r0) if r0 else 0.0,
                       et_min=b["min"][pos["bar"]], date=str(b["date"][pos["bar"]])))
    return net


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------
def stats(trades, eq_curve, P):
    n = len(trades)
    if n == 0:
        return dict(trades=0)
    wins = [t for t in trades if t["net"] > 0]
    losses = [t for t in trades if t["net"] <= 0]
    gp = sum(t["net"] for t in wins)
    gl = -sum(t["net"] for t in losses)
    peak, dd = -1e18, 0.0
    for e in eq_curve:
        peak = max(peak, e)
        dd = max(dd, peak - e)
    net = sum(t["net"] for t in trades)
    return dict(
        trades=n, wins=len(wins), losses=len(losses),
        wr=100.0 * len(wins) / n,
        pf=(gp / gl) if gl > 0 else float("inf"),
        net=net, expectancy=net / n,
        avgR=sum(t["R"] for t in trades) / n,
        avgW=(gp / len(wins)) if wins else 0.0,
        avgL=(gl / len(losses)) if losses else 0.0,
        payoff=((gp / len(wins)) / (gl / len(losses))) if wins and losses else 0.0,
        maxdd=dd, planR=sum(t["planR"] for t in trades) / n,
        ret=100.0 * net / P["initial_capital"],
    )


def fmt(s, label=""):
    if s.get("trades", 0) == 0:
        return f"{label:<22} no trades"
    return (f"{label:<22} n={s['trades']:>4}  WR={s['wr']:>5.1f}%  PF={s['pf']:>5.2f}  "
            f"net=${s['net']:>9,.0f}  exp=${s['expectancy']:>7.1f}  avgR={s['avgR']:>5.2f}  "
            f"planRR={s['planR']:>4.2f}  maxDD=${s['maxdd']:>7,.0f}")


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------
def evaluate(path, P, both=True):
    b = prep(load(path), P)
    tp, ep = run(b, P, pessimistic=True)
    sp = stats(tp, ep, P)
    if not both:
        return sp, None, tp
    to, eo = run(b, P, pessimistic=False)
    so = stats(to, eo, P)
    return sp, so, tp


def with_preset(name, **over):
    P = dict(P0)
    P.update(PRESETS[name])
    P.update(over)
    return P


def cmd_presets(d):
    path = os.path.join(d, "MNQ_5m.csv")
    print(f"\nMNQ 5m  |  {os.path.basename(path)}")
    b = load(path)
    span = (b["t"][-1] - b["t"][0]) / 86400.0
    print(f"bars={b['n']}  span={span:.1f} calendar days\n")
    for name in ("Precision", "Balanced", "Volume"):
        P = with_preset(name)
        sp, so, tr = evaluate(path, P)
        print(fmt(sp, f"{name} (pessimistic)"))
        print(fmt(so, f"{name} (optimistic)"))
        if tr:
            longs = [t for t in tr if t["dir"] == 1]
            shorts = [t for t in tr if t["dir"] == -1]
            wl = 100 * sum(1 for t in longs if t["net"] > 0) / len(longs) if longs else 0
            ws = 100 * sum(1 for t in shorts if t["net"] > 0) / len(shorts) if shorts else 0
            print(f"{'':<22} longs {len(longs)} @ {wl:.0f}%WR   shorts {len(shorts)} @ {ws:.0f}%WR"
                  f"   trades/day {len(tr)/max(span*5/7,1):.2f}")
        print()


def cmd_sweep(d):
    path = os.path.join(d, "MNQ_5m.csv")
    b = prep(load(path), P0)
    rows = []
    for th in (4, 5, 6, 7, 8, 9, 10):
        for mss in (True, False):
            for fvg in (True, False):
                for minr, defr, maxr in ((1.0, 1.5, 4.0), (1.5, 2.0, 5.0), (2.0, 2.5, 6.0)):
                    P = dict(P0, thresh=th, req_mss=mss, req_fvg=fvg, req_kz=True,
                             min_r=minr, def_r=defr, max_r=maxr)
                    tr, eq = run(b, P, pessimistic=True)
                    s = stats(tr, eq, P)
                    if s.get("trades", 0) >= 15:
                        rows.append((s["pf"], s, th, mss, fvg, minr))
    rows.sort(key=lambda r: -r[0])
    print("\nthr MSS FVG minR |    n    WR%     PF     net$   avgR")
    for pf, s, th, mss, fvg, minr in rows[:25]:
        print(f"{th:>3} {str(mss)[0]:>3} {str(fvg)[0]:>3} {minr:>4} | "
              f"{s['trades']:>4} {s['wr']:>6.1f} {s['pf']:>6.2f} {s['net']:>8,.0f} {s['avgR']:>6.2f}")


def cmd_wf(d):
    """Walk-forward: pick the threshold on fold k, trade it on fold k+1."""
    path = os.path.join(d, "MNQ_5m.csv")
    raw = load(path)
    n = raw["n"]
    folds = 6
    edges = [int(n * k / folds) for k in range(folds + 1)]
    print(f"\nWalk-forward, {folds} folds of ~{n//folds} bars (~{(raw['t'][-1]-raw['t'][0])/86400/folds:.0f} days)")
    oos = []
    for k in range(folds - 1):
        tr_slice = {kk: raw[kk][edges[k]:edges[k + 1]] for kk in ("t", "o", "h", "l", "c", "v")}
        tr_slice["n"] = len(tr_slice["t"])
        te_slice = {kk: raw[kk][edges[k + 1]:edges[k + 2]] for kk in ("t", "o", "h", "l", "c", "v")}
        te_slice["n"] = len(te_slice["t"])
        best, bestP = None, None
        btr = prep(tr_slice, P0)
        for th in (5, 6, 7, 8, 9):
            P = dict(P0, thresh=th)
            t1, e1 = run(btr, P, pessimistic=True)
            s1 = stats(t1, e1, P)
            if s1.get("trades", 0) >= 5:
                score = s1["expectancy"] * math.log1p(s1["trades"])
                if best is None or score > best:
                    best, bestP = score, P
        if bestP is None:
            bestP = dict(P0)
        bte = prep(te_slice, bestP)
        t2, e2 = run(bte, bestP, pessimistic=True)
        s2 = stats(t2, e2, bestP)
        oos += t2
        print(f"  fold {k}->{k+1}  chosen thr={bestP['thresh']}   " + fmt(s2, "OOS"))
    if oos:
        eq, run_eq = [], P0["initial_capital"]
        for t in oos:
            run_eq += t["net"]
            eq.append(run_eq)
        print("\n  " + fmt(stats(oos, eq, P0), "POOLED OOS"))


def cmd_cross(d):
    print("\nSame model, same parameters, other index futures (5m, same window)")
    for sym in ("MNQ", "NQ", "MES", "ES", "YM", "RTY"):
        path = os.path.join(d, f"{sym}_5m.csv")
        if not os.path.exists(path):
            continue
        pvs = dict(MNQ=2.0, NQ=20.0, MES=5.0, ES=50.0, YM=5.0, RTY=5.0)
        tks = dict(MNQ=0.25, NQ=0.25, MES=0.25, ES=0.25, YM=1.0, RTY=0.1)
        P = with_preset("Balanced", point_value=pvs[sym], tick=tks[sym])
        # scale the point-based stop bounds to the instrument's ATR
        bb = prep(load(path), P)
        med = sorted(x for x in bb["atr"] if x)
        med = med[len(med) // 2] if med else 20.0
        P = dict(P, min_stop_pt=med * 0.4, max_stop_pt=med * 3.0,
                 atr_min_pt=med * 0.35, atr_max_pt=med * 5.0)
        tr, eq = run(prep(load(path), P), P, pessimistic=True)
        print(fmt(stats(tr, eq, P), sym))


def bootstrap(trades, n_boot=4000, seed=7):
    """Resample trade outcomes to get confidence bands on avg-R and PF."""
    import random
    rnd = random.Random(seed)
    rs = [t["R"] for t in trades]
    nets = [t["net"] for t in trades]
    n = len(rs)
    if n < 5:
        return None
    mrs, pfs, wrs = [], [], []
    for _ in range(n_boot):
        idx = [rnd.randrange(n) for _ in range(n)]
        sr = [rs[k] for k in idx]
        sn = [nets[k] for k in idx]
        mrs.append(sum(sr) / n)
        gp = sum(x for x in sn if x > 0)
        gl = -sum(x for x in sn if x <= 0)
        pfs.append(gp / gl if gl > 0 else 9.99)
        wrs.append(100.0 * sum(1 for x in sn if x > 0) / n)
    q = lambda a, p: sorted(a)[int(p * len(a))]
    return dict(R=(q(mrs, .05), q(mrs, .5), q(mrs, .95)),
                PF=(q(pfs, .05), q(pfs, .5), q(pfs, .95)),
                WR=(q(wrs, .05), q(wrs, .5), q(wrs, .95)),
                p_R_gt0=sum(1 for x in mrs if x > 0) / n_boot,
                p_PF_gt1=sum(1 for x in pfs if x > 1.0) / n_boot)


CFG = {}


def cmd_final(d):
    P = dict(P0, **CFG)
    path = os.path.join(d, "MNQ_5m.csv")
    b = prep(load(path), P)
    trp, eqp = run(b, P, pessimistic=True)
    tro, eqo = run(b, P, pessimistic=False)
    sp, so = stats(trp, eqp, P), stats(tro, eqo, P)
    span = (b["t"][-1] - b["t"][0]) / 86400.0
    sessions = len({t["date"] for t in trp}) or 1
    print(f"\n=== FINAL CONFIG on MNQ 5m ===  bars={b['n']}  span={span:.0f} cal days")
    print(json.dumps({k: v for k, v in CFG.items()}, default=str))
    print()
    print(fmt(sp, "pessimistic"))
    print(fmt(so, "optimistic"))
    print(f"{'':<22} trading days with >=1 trade: {sessions}   trades/day {sp['trades']/max(sessions,1):.2f}")
    bs = bootstrap(trp)
    if bs:
        print(f"\n  bootstrap (pessimistic, {sp['trades']} trades, 4000 resamples)")
        print(f"    avg R   5%={bs['R'][0]:+.3f}  median={bs['R'][1]:+.3f}  95%={bs['R'][2]:+.3f}"
              f"   P(edge>0) = {bs['p_R_gt0']*100:.0f}%")
        print(f"    PF      5%={bs['PF'][0]:.2f}   median={bs['PF'][1]:.2f}   95%={bs['PF'][2]:.2f}"
              f"    P(PF>1)  = {bs['p_PF_gt1']*100:.0f}%")
        print(f"    WR%     5%={bs['WR'][0]:.1f}   median={bs['WR'][1]:.1f}   95%={bs['WR'][2]:.1f}")
    bso = bootstrap(tro)
    if bso:
        print(f"    optimistic P(PF>1) = {bso['p_PF_gt1']*100:.0f}%")
    print("\n  by half")
    mid = b["t"][b["n"] // 2]
    for lab, sub in (("first half", [t for t in trp if t["t"] < mid]),
                     ("second half", [t for t in trp if t["t"] >= mid])):
        if sub:
            gp = sum(t["net"] for t in sub if t["net"] > 0)
            gl = -sum(t["net"] for t in sub if t["net"] <= 0)
            w = 100 * sum(1 for t in sub if t["net"] > 0) / len(sub)
            print(f"    {lab:<12} n={len(sub):>3}  WR={w:>5.1f}%  PF={(gp/gl if gl else 9.99):>5.2f}  net=${sum(t['net'] for t in sub):>8,.0f}")
    print("\n  direction split")
    for lab, dd in (("long", 1), ("short", -1)):
        sub = [t for t in trp if t["dir"] == dd]
        if sub:
            gp = sum(t["net"] for t in sub if t["net"] > 0)
            gl = -sum(t["net"] for t in sub if t["net"] <= 0)
            w = 100 * sum(1 for t in sub if t["net"] > 0) / len(sub)
            print(f"    {lab:<12} n={len(sub):>3}  WR={w:>5.1f}%  PF={(gp/gl if gl else 9.99):>5.2f}  net=${sum(t['net'] for t in sub):>8,.0f}")
    print("\n  exit reasons")
    for r in ("target", "stop", "time stop", "EOD flat", "daily stop"):
        sub = [t for t in trp if t["reason"] == r]
        if sub:
            print(f"    {r:<12} n={len(sub):>3}  net=${sum(t['net'] for t in sub):>8,.0f}")


def cmd_diag(d):
    path = os.path.join(d, "MNQ_5m.csv")
    P = with_preset("Balanced")
    b = prep(load(path), P)
    DIAG.clear()
    tr, eq = run(b, P, pessimistic=True)
    print("\nFUNNEL (Balanced)")
    for k in ("raids_armed", "mss_disp", "blocked_busy", "blocked_kz", "blocked_news",
              "blocked_other", "gate_pass", "zone_ok", "retrace_ok", "stop_ok", "stop_oob",
              "score_fail", "orders_placed", "risk_block", "fills"):
        print(f"  {k:<16} {DIAG.get(k,0)}")
    if DIAG.get("score_n"):
        print(f"  mean score       {DIAG['score_sum']/DIAG['score_n']:.2f}")
    print(f"  KZ bars          {sum(b['inKZ'])} / {b['n']}")


def cmd_report(d):
    path = os.path.join(d, "MNQ_5m.csv")
    P = with_preset("Balanced")
    b = prep(load(path), P)
    tr, eq = run(b, P, pessimistic=True)
    s = stats(tr, eq, P)
    print("\n=== MNQ 5m - Balanced preset - pessimistic fills ===")
    print(fmt(s, "ALL"))
    if not tr:
        return
    print("\nby exit reason")
    for r in ("target", "stop", "time stop", "EOD flat", "daily stop"):
        sub = [t for t in tr if t["reason"] == r]
        if sub:
            w = sum(1 for t in sub if t["net"] > 0)
            print(f"  {r:<12} n={len(sub):>4}  wins={w:>3}  net=${sum(t['net'] for t in sub):>9,.0f}")
    print("\nby confluence score")
    for sc in sorted({t["score"] for t in tr}):
        sub = [t for t in tr if t["score"] == sc]
        w = 100 * sum(1 for t in sub if t["net"] > 0) / len(sub)
        gp = sum(t["net"] for t in sub if t["net"] > 0)
        gl = -sum(t["net"] for t in sub if t["net"] <= 0)
        print(f"  score {sc:>2}  n={len(sub):>4}  WR={w:>5.1f}%  PF={(gp/gl if gl else float('inf')):>5.2f}"
              f"  net=${sum(t['net'] for t in sub):>8,.0f}")
    print("\nby ET hour of entry")
    for hh in range(24):
        sub = [t for t in tr if t["et_min"] // 60 == hh]
        if len(sub) >= 3:
            w = 100 * sum(1 for t in sub if t["net"] > 0) / len(sub)
            gp = sum(t["net"] for t in sub if t["net"] > 0)
            gl = -sum(t["net"] for t in sub if t["net"] <= 0)
            print(f"  {hh:02d}:00 ET  n={len(sub):>4}  WR={w:>5.1f}%  PF={(gp/gl if gl else float('inf')):>5.2f}")
    print("\nby planned RR bucket")
    for lo, hi in ((0, 1.75), (1.75, 2.25), (2.25, 3.0), (3.0, 99)):
        sub = [t for t in tr if lo <= t["planR"] < hi]
        if sub:
            w = 100 * sum(1 for t in sub if t["net"] > 0) / len(sub)
            gp = sum(t["net"] for t in sub if t["net"] > 0)
            gl = -sum(t["net"] for t in sub if t["net"] <= 0)
            print(f"  RR {lo}-{hi}  n={len(sub):>4}  WR={w:>5.1f}%  PF={(gp/gl if gl else float('inf')):>5.2f}")


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "data"
    cmd = sys.argv[2] if len(sys.argv) > 2 else "presets"
    if len(sys.argv) > 3:
        CFG.update(json.loads(sys.argv[3]))
    {"presets": cmd_presets, "sweep": cmd_sweep, "wf": cmd_wf,
     "cross": cmd_cross, "report": cmd_report, "diag": cmd_diag,
     "final": cmd_final}[cmd](d)
