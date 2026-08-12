#!/usr/bin/env python3
"""Prove the Pine indicator computes what the research engine computed.

An indicator is only as trustworthy as the claim that it runs the strategy that
was actually validated. That claim is easy to get wrong: the research engine is
vectorised numpy plus a numba bracket kernel, while Pine is a bar-by-bar state
machine with its own evaluation order. A one-bar offset, an inclusive-vs-
exclusive comparison, or a stop checked after a target instead of before, and
the chart shows a strategy nobody tested.

So this file re-implements the indicator a *second* time - as a literal
sequential loop that mirrors the Pine source statement for statement, including
Pine's evaluation order (manage the open position, then consider a new entry) -
and asserts it produces the identical trade list to `improve.run()`.

Two independent implementations agreeing trade-for-trade is the only evidence
worth having here.

SEPARATELY, this file checks the two anchoring conventions that silently differ
between Pine and the research set (see `anchor_report`):

  * `ta.vwap()` anchors to the *exchange session*, which for CME futures opens
    at 18:00 ET the previous day. The research anchors VWAP to the ET calendar
    day. On a 24h chart those are different numbers all morning.
  * `request.security(..., "D", ...)` returns the *exchange* daily bar, which
    for MNQ also spans 18:00-17:00 ET, not midnight-to-midnight.

Both are why the shipped indicator must compute these two series explicitly
rather than take Pine's built-ins.

Usage:
    python3 pine_parity.py <bars.csv> [--cfg key=value ...]
"""
import sys

import numpy as np

from features import build_features
from improve import Cfg, add_regime_series, entry_mask, run, SESSIONS
from qlib import cost_per_bar, load_bars


def pine_state_machine(f, cfg):
    """Literal transcription of the indicator's bar loop.

    Mirrors the Pine source's structure exactly:

        for each bar:
            if inTrade:  check stop -> target -> timeout -> else trail/BE
            if signal and not inTrade:  enter at this bar's close

    Nothing here is vectorised and nothing looks forward. If this disagrees with
    the research engine, one of the two is wrong and both get read again.
    """
    c, h, l = f["close"], f["high"], f["low"]
    a = f["atr14"]
    sig = entry_mask(f, cfg)
    cost = f["cost_pts"]
    et = f["et_min"]
    sess = f["session"]
    n = len(c)
    # Bar duration, so "flat by 16:00" can be expressed causally: exit on the
    # bar that *ends* at 16:00, which is the 15:55 bar. Pine knows a bar's start
    # time and the timeframe, never its neighbour, so this is the only form of
    # the rule an indicator can actually place an order from.
    tf = int(np.median(np.diff(et[(np.diff(et, prepend=et[0]) > 0)])) or 5)

    in_trade = False
    entry_px = stop_px = tgt_px = risk = cost_r = 0.0
    entry_bar = -1
    trades = []

    for i in range(n):
        # ---- manage the open position (Pine: the `if inTrade` block) --------
        if in_trade:
            closed = False
            if l[i] <= stop_px:
                # Pessimistic: a bar spanning both books the stop.
                r = (stop_px - entry_px) / risk - cost_r
                kind = "scratch" if stop_px >= entry_px else "stop"
                closed = True
            elif h[i] >= tgt_px:
                r = cfg.rr - cost_r
                kind = "target"
                closed = True
            elif i - entry_bar >= cfg.hold:
                r = (c[i] - entry_px) / risk - cost_r
                kind = "timeout"
                closed = True
            elif cfg.flat_by and ((et[i] < cfg.flat_by <= et[i] + tf)
                                  or (et[i] + tf >= 24 * 60)):
                # Both conditions read only this bar's own clock, so Pine can
                # evaluate them on the bar it needs to place the order on.
                r = (c[i] - entry_px) / risk - cost_r
                kind = "flat"
                closed = True
            if closed:
                trades.append(dict(entry_bar=entry_bar, exit_bar=i, r=r, kind=kind))
                in_trade = False
            else:
                if cfg.be > 0 and c[i] >= entry_px + cfg.be * risk and stop_px < entry_px:
                    stop_px = entry_px
                if cfg.trail > 0:
                    cand = c[i] - cfg.trail * a[entry_bar]
                    if cand > stop_px:
                        stop_px = cand

        # ---- consider a new entry (Pine: the `if longSignal and not inTrade`)
        if sig[i] and not in_trade and i + 1 < n:
            in_trade = True
            entry_px = c[i]
            risk = cfg.stop * a[i]
            if not np.isfinite(risk) or risk <= 0:
                in_trade = False
                continue
            stop_px = entry_px - risk
            tgt_px = entry_px + cfg.rr * risk
            entry_bar = i
            cost_r = cost[i] / risk
    return trades


def compare(f, cfg, label=""):
    """Run both implementations and report agreement."""
    st_ref, tr_ref = run(f, cfg)
    pine = pine_state_machine(f, cfg)

    ref_entries = list(tr_ref["idx"]) if tr_ref is not None else []
    ref_exits = list(tr_ref["exit_bar"]) if tr_ref is not None else []
    ref_r = np.asarray(tr_ref["r"]) if tr_ref is not None else np.array([])
    pin_entries = [t["entry_bar"] for t in pine]
    pin_exits = [t["exit_bar"] for t in pine]
    pin_r = np.array([t["r"] for t in pine])

    ok_n = len(ref_entries) == len(pin_entries)
    ok_e = ok_n and ref_entries == pin_entries
    ok_x = ok_n and ref_exits == pin_exits
    max_dr = float(np.abs(ref_r - pin_r).max()) if ok_n and len(ref_r) else float("nan")

    print(f"\n--- parity: {label or 'config'} ---")
    print(f"  research engine : {len(ref_entries):5d} trades  "
          f"PF {st_ref['pf']:.4f}  WR {st_ref['wr']:.2f}%  net {st_ref['net']:+.3f}R")
    gp = pin_r[pin_r > 0].sum()
    gl = -pin_r[pin_r < 0].sum()
    print(f"  pine state mach.: {len(pin_entries):5d} trades  "
          f"PF {gp / gl if gl > 0 else float('inf'):.4f}  "
          f"WR {100 * (pin_r > 0).mean() if len(pin_r) else 0:.2f}%  "
          f"net {pin_r.sum():+.3f}R")
    print(f"  same trade count : {'PASS' if ok_n else 'FAIL'}")
    print(f"  same entry bars  : {'PASS' if ok_e else 'FAIL'}")
    print(f"  same exit bars   : {'PASS' if ok_x else 'FAIL'}")
    print(f"  max |dR|         : {max_dr:.3e}  "
          f"{'PASS' if (max_dr == max_dr and max_dr < 1e-9) else 'FAIL'}")
    if not ok_e and ok_n:
        bad = [(i, j) for i, j in zip(ref_entries, pin_entries) if i != j][:5]
        print(f"  first mismatches : {bad}")
    return ok_n and ok_e and ok_x and max_dr < 1e-9


def anchor_report(df, f):
    """Quantify the two anchoring conventions Pine would get wrong by default.

    Pine's `ta.vwap` and daily `request.security` both anchor to the *exchange*
    session (18:00 ET open for CME index futures). The research anchors both to
    the ET calendar day. This prints how far apart those two conventions are, in
    ATR units, so the indicator's decision to compute them explicitly is
    justified by a number rather than by assertion.
    """
    et = f["et_min"]
    c = f["close"]
    a = f["atr14"]
    # Rebuild VWAP under the futures-session anchor (new session at 18:00 ET).
    tp = (f["high"] + f["low"] + c) / 3.0
    v = np.where(f["volume"] <= 0, 1.0, f["volume"])
    fut_new = np.zeros(len(c), bool)
    fut_new[0] = True
    fut_new[1:] = (et[1:] >= 1080) & (et[:-1] < 1080)      # 18:00 ET
    acc_pv = acc_v = 0.0
    fut_vwap = np.empty(len(c))
    for i in range(len(c)):
        if fut_new[i]:
            acc_pv = acc_v = 0.0
        acc_pv += tp[i] * v[i]
        acc_v += v[i]
        fut_vwap[i] = acc_pv / max(acc_v, 1e-12)
    d = np.abs(f["vwap"] - fut_vwap) / np.maximum(a, 1e-9)
    rth = (et >= 570) & (et < 960)
    good = np.isfinite(d)
    print("\n--- anchoring conventions (why the indicator computes these itself) ---")
    print(f"  |ET-day VWAP  -  futures-session VWAP|, in ATR units")
    print(f"    all bars : median {np.nanmedian(d[good]):.3f}  "
          f"p90 {np.nanpercentile(d[good], 90):.3f}  max {np.nanmax(d[good]):.3f}")
    print(f"    RTH only : median {np.nanmedian(d[good & rth]):.3f}  "
          f"p90 {np.nanpercentile(d[good & rth], 90):.3f}")
    frac = float(np.mean(d[good] > 0.25))
    print(f"    bars where the two disagree by >0.25 ATR: {100 * frac:.1f}%")
    print("  The entry gate is |close - VWAP| >= 1.5 ATR, so a disagreement of")
    print("  this size flips the gate on and off. Pine must anchor to the ET")
    print("  calendar day explicitly to run the validated strategy.")

    # Prior-day range under the two conventions. `request.security(.., "D", ..)`
    # returns the exchange daily bar, which for CME index futures runs
    # 18:00-17:00 ET rather than midnight to midnight.
    sess = f["session"]
    fut_day = sess + (et >= 1080).astype(np.int64)     # 18:00 ET rolls the day
    def prev_extremes(day):
        import pandas as pd
        s = pd.Series(day)
        hi = pd.Series(f["high"]).groupby(s).max().shift(1)
        lo = pd.Series(f["low"]).groupby(s).min().shift(1)
        return s.map(hi).to_numpy(), s.map(lo).to_numpy()
    fh, fl = prev_extremes(fut_day)
    et_hi, et_lo = f["pdh"], f["pdl"]
    outside_et = (c > et_hi) | (c < et_lo)
    outside_fut = (c > fh) | (c < fl)
    ok2 = np.isfinite(et_hi) & np.isfinite(fh)
    disagree = float(np.mean(outside_et[ok2] != outside_fut[ok2]))
    print(f"\n  prior-day range: ET calendar day vs exchange (18:00 ET) day")
    print(f"    the 'outside prior-day range' gate disagrees on "
          f"{100 * disagree:.1f}% of bars")

    # ATR percentile convention. pandas ranks the current value inside a window
    # that includes itself; Pine's ta.percentrank counts how many of the N
    # *previous* values were <= the current one. If the resulting gate disagrees
    # rarely enough, the built-in is worth its speed; if not, Pine has to run
    # the loop explicitly.
    a14 = f["atr14"]
    L = 500
    pine_pr = np.full(len(a14), np.nan)
    from numpy.lib.stride_tricks import sliding_window_view
    if len(a14) > L:
        win = sliding_window_view(a14, L)[:-1]          # previous L values
        cur = a14[L:]
        pine_pr[L:] = 100.0 * (win <= cur[:, None]).sum(1) / L
    g3 = np.isfinite(pine_pr) & np.isfinite(f["atr_rank"])
    gate_p = pine_pr > 66.0
    gate_r = f["atr_rank"] > 0.66
    dis3 = float(np.mean(gate_p[g3] != gate_r[g3]))
    print(f"\n  ATR percentile: pandas rank(pct) vs Pine ta.percentrank")
    print(f"    expansion gate disagrees on {100 * dis3:.2f}% of bars "
          f"-> {'built-in is fine' if dis3 < 0.01 else 'Pine must compute it explicitly'}")
    return dict(median_atr_diff=float(np.nanmedian(d[good])),
                frac_gt_quarter_atr=frac, pd_gate_disagree=disagree,
                atr_rank_disagree=dis3)


def main(path, *args):
    df = load_bars(path)
    f = add_regime_series(build_features(df))
    print(f"{path}: {len(df):,} bars  {df.index[0]:%Y-%m-%d} -> {df.index[-1]:%Y-%m-%d}")

    overrides = {}
    for a in args:
        if a.startswith("--cfg"):
            continue
        if "=" in a:
            k, v = a.split("=", 1)
            cur = getattr(Cfg(), k)
            overrides[k] = type(cur)(v) if not isinstance(cur, bool) else v == "True"

    cfgs = [
        ("v1 shipped default", Cfg()),
        ("with breakeven @1R", Cfg(be=1.0)),
        ("with ATR trail", Cfg(trail=2.0)),
        ("RTH only", Cfg(session="rth")),
        ("RTH + BE + trail + flat", Cfg(session="rth", be=1.0, trail=2.5,
                                        flat_by=960)),
    ]
    # The configurations that actually ship matter most, so pull them straight
    # from the study output rather than restating them here and risking drift.
    import json
    import os
    for cand in ("out/improve.json", "improve.json"):
        if os.path.exists(cand):
            with open(cand) as fh:
                rep = json.load(fh)
            for nm, blk in (rep.get("presets") or {}).items():
                c = dict(blk["cfg"])
                for k, v in list(c.items()):
                    ref = getattr(Cfg(), k)
                    c[k] = bool(v) if isinstance(ref, bool) else type(ref)(v)
                cfgs.append((f"PRESET {nm}", Cfg(**c)))
            break
    if overrides:
        cfgs.append(("command-line config", Cfg(**overrides)))

    allok = True
    for label, cfg in cfgs:
        allok &= compare(f, cfg, label)
    anchor_report(df, f)
    print("\n" + ("ALL PARITY CHECKS PASSED" if allok
                  else "PARITY FAILURE - do not ship the indicator"))
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
