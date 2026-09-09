#!/usr/bin/env python3
"""Transliteration check: does the Pine script compute what the engine does?

This is written FROM indicators/po3_vwap_liquidity_sweep.pine - reading the
Pine block by block and re-expressing it in Python - not from po3_engine.py.
The two are then diffed signal by signal. A transcription slip between the
research engine and the shipped indicator shows up here as a mismatched bar,
entry, stop or target, which no linter would catch.
"""
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from evaluate import CANDIDATE  # noqa: E402

PIVOT_LEN, ATR_LEN, EQ_TOL, MAX_POOLS = 5, 14, 0.10, 60


def et_minute(ts):
    d = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(E.ET)
    return d.hour * 60 + d.minute


def pine(bars, p):
    """Faithful re-expression of the Pine state machine, in its block order."""
    o, h, l, c, v, t = (bars["o"], bars["h"], bars["l"], bars["c"],
                        bars["v"], bars["t"])
    n = len(c)
    atr = E.wilder_atr(bars, ATR_LEN)
    days, mspos, weeks = E.calendar(bars)

    # minutes since the 18:00 ET trade-day open, exactly as the Pine computes
    mspo_l = [(et_minute(x) + 360) % 1440 for x in t]
    in_asia = [m < 480 for m in mspo_l]
    in_lon = [480 <= m < 840 for m in mspo_l]
    in_ib = [930 <= m < 990 for m in mspo_l]

    # ---- VWAP block (anchor = trade day, as the preset ships) --------------
    vwap = [0.0] * n
    vsd = [0.0] * n
    vok = [False] * n
    spv = sv = sp2v = 0.0
    abars = 0
    atime = 0
    for i in range(n):
        new_anchor = (i == 0) or days[i] != days[i - 1]
        if new_anchor:
            spv = sv = sp2v = 0.0
            abars = 0
            atime = t[i]
        tp = (h[i] + l[i] + c[i]) / 3.0
        vol = v[i]
        spv += vol * tp
        sv += vol
        sp2v += vol * tp * tp
        abars += 1
        vwap[i] = spv / sv if sv > 0 else tp
        vsd[i] = (max(sp2v / sv - vwap[i] ** 2, 0.0)) ** 0.5 if sv > 0 else 0.0
        vok[i] = abars >= 2 and (t[i] - atime) >= 3600 and vsd[i] > 0

    period_open = None
    pools = []          # dicts: price, side, kind, swept, eq
    setups = []
    signals = []
    day_h = day_l = wk_h = wk_l = None
    pd_h = pd_l = pw_h = pw_l = None
    asia_h = asia_l = lon_h = lon_l = ib_h = ib_l = None
    asia_done = lon_done = ib_done = False
    raid = {1: None, -1: None}      # keyed by trade direction
    last_sig = {1: None, -1: None}

    def set_named(price, side, kind):
        if price is None:
            return
        pools[:] = [q for q in pools if q["kind"] != kind]
        pools.append({"price": price, "side": side, "kind": kind,
                      "swept": False, "eq": False})

    def allowed(q):
        # named levels are only created when enabled, so the only runtime
        # filter left is the equal-highs restriction on pivots
        return q["kind"] != "Pivot" or (not p.eq_only) or q["eq"]

    for i in range(n):
        a = atr[i]
        new_day = (i == 0) or days[i] != days[i - 1]
        new_week = (i == 0) or weeks[i] != weeks[i - 1]
        if p.po3_period == "week":
            if new_week:
                period_open = o[i]
        elif new_day:
            period_open = o[i]

        # --- 1. manage setups opened earlier -------------------------------
        for s in setups:
            if s["done"] or s["created"] >= i:
                continue
            bull = s["dir"] == 1
            if not s["filled"]:
                if (l[i] <= s["entry"]) if bull else (h[i] >= s["entry"]):
                    s["filled"] = True
                    s["fill"] = i
                    if (l[i] <= s["stop"]) if bull else (h[i] >= s["stop"]):
                        s["done"] = True
                        s["r"] = -1.0
                elif i - s["created"] >= p.validity:
                    s["done"] = True
                    s["r"] = None
                continue
            stop_hit = (l[i] <= s["stop"]) if bull else (h[i] >= s["stop"])
            tp_hit = (h[i] >= s["tp"]) if bull else (l[i] <= s["tp"])
            if stop_hit:
                s["done"] = True
                s["r"] = 0.0 if s["be"] else -1.0
            elif tp_hit:
                s["done"] = True
                s["r"] = p.rr
            elif p.be_at_r > 0 and not s["be"]:
                lvl = s["entry"] + (1 if bull else -1) * p.be_at_r * s["risk"]
                if (h[i] >= lvl) if bull else (l[i] <= lvl):
                    s["be"] = True
                    s["stop"] = s["entry"]

        # --- 2. period / session rolls -------------------------------------
        if new_day:
            pd_h, pd_l = day_h, day_l
            day_h, day_l = h[i], l[i]
            asia_h = asia_l = lon_h = lon_l = ib_h = ib_l = None
            asia_done = lon_done = ib_done = False
            set_named(pd_h, 1, "PDH")
            set_named(pd_l, -1, "PDL")
        else:
            day_h = h[i] if day_h is None else max(day_h, h[i])
            day_l = l[i] if day_l is None else min(day_l, l[i])
        if new_week:
            pw_h, pw_l = wk_h, wk_l
            wk_h, wk_l = h[i], l[i]
            set_named(pw_h, 1, "PWH")
            set_named(pw_l, -1, "PWL")
        else:
            wk_h = h[i] if wk_h is None else max(wk_h, h[i])
            wk_l = l[i] if wk_l is None else min(wk_l, l[i])

        if in_asia[i]:
            asia_h = h[i] if asia_h is None else max(asia_h, h[i])
            asia_l = l[i] if asia_l is None else min(asia_l, l[i])
        elif not asia_done:
            asia_done = True
            set_named(asia_h, 1, "AsiaH")
            set_named(asia_l, -1, "AsiaL")
        if in_lon[i]:
            lon_h = h[i] if lon_h is None else max(lon_h, h[i])
            lon_l = l[i] if lon_l is None else min(lon_l, l[i])
        elif mspo_l[i] >= 840 and not lon_done:
            lon_done = True
            set_named(lon_h, 1, "LonH")
            set_named(lon_l, -1, "LonL")
        if in_ib[i]:
            ib_h = h[i] if ib_h is None else max(ib_h, h[i])
            ib_l = l[i] if ib_l is None else min(ib_l, l[i])
        elif mspo_l[i] >= 990 and not ib_done:
            ib_done = True
            set_named(ib_h, 1, "IBH")
            set_named(ib_l, -1, "IBL")

        # --- 3. fractal pivots ---------------------------------------------
        if i >= 2 * PIVOT_LEN and a:
            k = i - PIVOT_LEN
            if h[k] == max(h[i - 2 * PIVOT_LEN:i + 1]) and max(h[k + 1:i + 1]) < h[k]:
                eq = False
                for q in pools:
                    if q["kind"] == "Pivot" and q["side"] > 0 and not q["swept"] \
                            and abs(q["price"] - h[k]) <= EQ_TOL * a:
                        q["eq"] = True
                        eq = True
                pools.append({"price": h[k], "side": 1, "kind": "Pivot",
                              "swept": False, "eq": eq})
            if l[k] == min(l[i - 2 * PIVOT_LEN:i + 1]) and min(l[k + 1:i + 1]) > l[k]:
                eq = False
                for q in pools:
                    if q["kind"] == "Pivot" and q["side"] < 0 and not q["swept"] \
                            and abs(q["price"] - l[k]) <= EQ_TOL * a:
                        q["eq"] = True
                        eq = True
                pools.append({"price": l[k], "side": -1, "kind": "Pivot",
                              "swept": False, "eq": eq})
            npiv = sum(1 for q in pools if q["kind"] == "Pivot")
            if npiv > MAX_POOLS:
                pools[:] = [q for q in pools
                            if q["kind"] != "Pivot" or not q["swept"]]
                npiv = sum(1 for q in pools if q["kind"] == "Pivot")
                while npiv > MAX_POOLS:
                    for idx, q in enumerate(pools):
                        if q["kind"] == "Pivot":
                            pools.pop(idx)
                            npiv -= 1
                            break

        if a is None:
            continue

        # --- 4. sweeps -> raids --------------------------------------------
        ssl = bsl = None
        for q in pools:
            if not q["swept"] and ((h[i] > q["price"]) if q["side"] > 0
                                   else (l[i] < q["price"])):
                q["swept"] = True
                if not allowed(q):
                    continue
                if q["side"] > 0:
                    if bsl is None or q["price"] < bsl:
                        bsl = q["price"]
                else:
                    if ssl is None or q["price"] > ssl:
                        ssl = q["price"]
        if ssl is not None:
            if raid[1]:
                raid[1]["lvl"] = max(raid[1]["lvl"], ssl)
                raid[1]["bar"] = i
            else:
                raid[1] = {"lvl": ssl, "ext": l[i], "bar": i, "first": i}
        if bsl is not None:
            if raid[-1]:
                raid[-1]["lvl"] = min(raid[-1]["lvl"], bsl)
                raid[-1]["bar"] = i
            else:
                raid[-1] = {"lvl": bsl, "ext": h[i], "bar": i, "first": i}

        # --- 5. reclaim -> signal ------------------------------------------
        for d in (1, -1):
            r = raid[d]
            if not r:
                continue
            bull = d == 1
            r["ext"] = min(r["ext"], l[i]) if bull else max(r["ext"], h[i])
            depth = (r["lvl"] - r["ext"]) if bull else (r["ext"] - r["lvl"])
            if p.max_sweep_atr and 0 < p.max_sweep_atr < 90 and depth > p.max_sweep_atr * a:
                raid[d] = None
                continue
            if i - r["bar"] > p.reclaim_bars:
                raid[d] = None
                continue
            if not ((c[i] > r["lvl"]) if bull else (c[i] < r["lvl"])):
                continue
            ok = depth >= p.min_sweep_atr * a
            ok = ok and (p.longs if bull else p.shorts)
            ok = ok and E.in_session(mspos[i], p.session)
            ok = ok and (last_sig[d] is None or i - last_sig[d] >= p.cooldown)
            if ok and p.require_close_dir:
                ok = c[i] > o[i] if bull else c[i] < o[i]
            if ok and p.use_vwap:
                ok = vok[i] and ((r["ext"] <= vwap[i] - p.dev_entry * vsd[i]) if bull
                                 else (r["ext"] >= vwap[i] + p.dev_entry * vsd[i]))
            if ok and p.vwap_reclaim:
                ok = vok[i] and ((c[i] > vwap[i]) if bull else (c[i] < vwap[i]))
            if ok and p.po3_mode != "off" and period_open is not None:
                ok = r["ext"] < period_open if bull else r["ext"] > period_open
                if ok and p.po3_mode == "reclaim_open":
                    ok = c[i] > period_open if bull else c[i] < period_open
            if ok:
                if p.entry_mode == "level_retest":
                    entry = r["lvl"]
                elif p.entry_mode == "wick_mid":
                    entry = (r["lvl"] + r["ext"]) / 2.0
                else:
                    entry = c[i]
                stop = r["ext"] - p.stop_buf_atr * a if bull else r["ext"] + p.stop_buf_atr * a
                risk = (entry - stop) if bull else (stop - entry)
                if risk >= 2 * p.tick:
                    tp = entry + p.rr * risk if bull else entry - p.rr * risk
                    market = p.entry_mode == "reclaim_close"
                    setups.append({"dir": d, "entry": entry, "stop": stop,
                                   "tp": tp, "risk": risk, "created": i,
                                   "fill": i if market else -1,
                                   "filled": market, "be": False,
                                   "done": False, "r": None})
                    signals.append((i, d, round(entry, 6), round(stop, 6), round(tp, 6)))
                    last_sig[d] = i
            raid[d] = None
        setups = [s for s in setups if not s["done"]] + [s for s in setups if s["done"]]
    return signals


def check_preset(pine_path):
    """The parity test proves the Pine LOGIC matches the engine for a given
    parameter set. This proves the constants the Pine actually ships in its
    validated preset are that parameter set - otherwise the indicator would
    faithfully reproduce a configuration nobody tested."""
    src = open(pine_path).read()
    want = {
        "minSweepAtr": ("0.35", CANDIDATE.min_sweep_atr, 0.35),
        "reclaimBars": ("2", CANDIDATE.reclaim_bars, 2),
        "stopBufAtr": ("0.50", CANDIDATE.stop_buf_atr, 0.50),
        "rrTarget": ("3.0", CANDIDATE.rr, 3.0),
        "beAtR": ("1.0", CANDIDATE.be_at_r, 1.0),
        "validity": ("12", CANDIDATE.validity, 12),
        "cooldown": ("6", CANDIDATE.cooldown, 6),
    }
    bad = []
    for name, (literal, cand, expect) in want.items():
        m = re.search(r"^\s*\w+\s+" + name + r"\s*=\s*usePreset \? ([^ ]+)",
                      src, re.M)
        if not m:
            bad.append(f"{name}: no preset line found in the Pine")
        elif m.group(1) != literal:
            bad.append(f"{name}: Pine ships {m.group(1)}, validated value is {literal}")
        if abs(float(cand) - expect) > 1e-9:
            bad.append(f"{name}: CANDIDATE holds {cand}, expected {expect}")
    for name, literal in [("maxSweepAtr", "0.0"), ("po3Mode", '"Sweep beyond open"'),
                          ("po3Period", '"Week"'), ("vwapGate", "false"),
                          ("vwapReclaim", "false"), ("needCloseDir", "true"),
                          ("entryMode", '"Market on reclaim close"'),
                          ("sessMode", '"All hours"'), ("eqOnly", "false")]:
        m = re.search(r"^\s*\w+\s+" + name + r"\s*=\s*usePreset \? ([^:]+?)\s*:", src, re.M)
        if not m:
            bad.append(f"{name}: no preset line found in the Pine")
        elif m.group(1).strip() != literal:
            bad.append(f"{name}: Pine ships {m.group(1).strip()}, expected {literal}")
    # the engine-side twins of the string options
    for got, exp, label in [(CANDIDATE.po3_mode, "below_open", "po3_mode"),
                            (CANDIDATE.po3_period, "week", "po3_period"),
                            (CANDIDATE.entry_mode, "reclaim_close", "entry_mode"),
                            (CANDIDATE.session, "all", "session"),
                            (CANDIDATE.tp_mode, "rr", "tp_mode")]:
        if got != exp:
            bad.append(f"CANDIDATE.{label} is {got!r}, expected {exp!r}")
    if CANDIDATE.use_vwap or CANDIDATE.vwap_reclaim or CANDIDATE.eq_only:
        bad.append("CANDIDATE has a VWAP/eq filter on; the preset ships them off")
    print("\nPreset consistency (Pine constants vs validated parameters):")
    if bad:
        for b in bad:
            print("  MISMATCH:", b)
    else:
        print("  OK - the shipped preset is exactly the validated configuration")
    return not bad


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "data_po3"
    check_preset(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "indicators", "po3_vwap_liquidity_sweep.pine"))
    for spec in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["MNQ_1h"]):
        bars = E.load_csv(os.path.join(data, f"{spec}.csv"))
        ctx = E.build_context(bars)
        got = pine(bars, CANDIDATE)
        # reference: the engine's own trades, recorded straight out of run()
        ref = []
        E.run(bars, ctx, CANDIDATE, 0, len(bars["c"]), trade_log=ref)
        gs = set((b, d) for b, d, *_ in got)
        rs = set((b, d) for b, d, *_ in ref)
        print(f"\n{spec}: pine-transliteration {len(got)} signals, "
              f"engine {len(ref)} signals")
        only_p = sorted(gs - rs)
        only_e = sorted(rs - gs)
        print(f"  only in Pine transliteration: {len(only_p)}  {only_p[:8]}")
        print(f"  only in engine:               {len(only_e)}  {only_e[:8]}")
        gm = {(b, d): (e, s, tp) for b, d, e, s, tp in got}
        diffs = [k for k in gs & rs
                 if any(abs(x - y) > 1e-6 for x, y in
                        zip(gm[k], next((e, s, tp) for b, d, e, s, tp in ref if (b, d) == k)))]
        print(f"  price mismatches on shared signals: {len(diffs)} {diffs[:5]}")
