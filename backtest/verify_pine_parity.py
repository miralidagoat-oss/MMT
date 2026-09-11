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
from dataclasses import replace  # noqa: E402
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
    outcomes = []
    peak_open = 0
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
        # outcome codes are the Pine's: 1 win, -1 loss, 2 expired, 3 time stop,
        # 4 stop hit after it was moved. Booking mirrors the Pine exactly,
        # including its pessimism (a fill bar that also trades the stop books
        # the loss now, and the target is never credited on the entry bar).
        for s in setups:
            if s["done"] or s["created"] >= i:
                continue
            bull = s["dir"] == 1
            outcome = 0
            if not s["filled"]:
                if (l[i] <= s["entry"]) if bull else (h[i] >= s["entry"]):
                    s["filled"] = True
                    s["fill"] = i
                    if (l[i] <= s["stop"]) if bull else (h[i] >= s["stop"]):
                        outcome = -1
                elif i - s["created"] >= p.validity:
                    outcome = 2
            else:
                stop_hit = (l[i] <= s["stop"]) if bull else (h[i] >= s["stop"])
                tp_hit = (h[i] >= s["tp"]) if bull else (l[i] <= s["tp"])
                outcome = -1 if stop_hit and not s["be"] else \
                    4 if stop_hit else 1 if tp_hit else 0
                # breakeven is armed only AFTER the exit checks, so it can
                # never take effect on the bar that triggered it
                if outcome == 0 and p.be_at_r > 0 and not s["be"]:
                    lvl = s["entry"] + (1 if bull else -1) * p.be_at_r * s["risk"]
                    if (h[i] >= lvl) if bull else (l[i] <= lvl):
                        s["be"] = True
                        moved = s["entry"] + (1 if bull else -1) * p.be_to_r * s["risk"]
                        s["stop"] = max(s["stop"], moved) if bull else \
                            min(s["stop"], moved)
                if outcome == 0 and p.max_hold > 0 and i - s["fill"] >= p.max_hold:
                    outcome = 3
            if outcome != 0:
                s["done"] = True
                if outcome == 2:
                    s["r"] = None
                else:
                    gross = p.rr if outcome == 1 else -1.0 if outcome == -1 else \
                        p.be_to_r if outcome == 4 else \
                        ((c[i] - s["entry"]) if bull else (s["entry"] - c[i])) / s["risk"]
                    s["r"] = gross - p.cost_ticks * p.tick / s["risk"]
                    s["exit"] = i
                    outcomes.append((s["created"], s["dir"], i, round(s["r"], 6)))

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
        PL = p.pivot_len
        if i >= 2 * PL and a:
            k = i - PL
            if h[k] == max(h[i - 2 * PL:i + 1]) and max(h[k + 1:i + 1]) < h[k]:
                eq = False
                for q in pools:
                    if q["kind"] == "Pivot" and q["side"] > 0 and not q["swept"] \
                            and abs(q["price"] - h[k]) <= EQ_TOL * a:
                        q["eq"] = True
                        eq = True
                pools.append({"price": h[k], "side": 1, "kind": "Pivot",
                              "swept": False, "eq": eq})
            if l[k] == min(l[i - 2 * PL:i + 1]) and min(l[k + 1:i + 1]) > l[k]:
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
            if p.max_sweep_atr > 0 and depth > p.max_sweep_atr * a:
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
            if ok and p.vol_mult > 0:
                vs = sum(v[max(0, i - 19):i + 1]) / 20.0 if i >= 19 else None
                ok = bool(vs and vs > 0 and v[i] >= p.vol_mult * vs)
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
                too_wide = p.max_risk_atr > 0 and risk > p.max_risk_atr * a
                too_small = p.min_target_pts > 0 and p.rr * risk < p.min_target_pts
                if risk >= 2 * p.tick and not too_wide and not too_small:
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
        live = [s for s in setups if not s["done"]]
        peak_open = max(peak_open, len(live))
        setups = live + [s for s in setups if s["done"]]
    # the Pine evicts the oldest setup past inMaxOpen (20) and books it as a
    # market exit. If that valve ever bound, the two would legitimately differ,
    # so assert it does not rather than quietly transliterating around it.
    assert peak_open <= 20, f"Pine's max-open valve would bind: {peak_open} live setups"
    return signals, outcomes


CONFIGS = {
    # the shipped configuration, plus one per optional gate, so the paths that
    # a user can switch on are covered too and not only the defaults
    "preset (as shipped)": {},
    "vol_mult=1.3": {"vol_mult": 1.3},
    "max_risk_atr=2.0": {"max_risk_atr": 2.0},
    "max_sweep_atr=1.5 (cap on)": {"max_sweep_atr": 1.5},
    "max_sweep_atr=0 (cap off)": {"max_sweep_atr": 0.0},
    "min_target_pts=80": {"min_target_pts": 80.0},
    "all three gates": {"vol_mult": 1.2, "max_risk_atr": 2.5, "min_target_pts": 60.0},
    "half-risk stop at +0.5R": {"be_at_r": 0.5, "be_to_r": -0.5},
    "half-risk stop at +1R": {"be_at_r": 1.0, "be_to_r": -0.5},
    "wick_mid + vwap stretch": {"entry_mode": "wick_mid", "use_vwap": True,
                                "dev_entry": 1.5},
    "vwap reclaim + eq + rth": {"vwap_reclaim": True, "eq_only": True,
                                "session": "rth"},
    "level retest + no po3": {"entry_mode": "level_retest", "po3_mode": "off"},
}


def compare(bars, ctx, p):
    """Diff the transliteration against the engine on BOTH halves of the model:
    which trades are taken (bar, direction, entry, stop, target) and how each
    one is then managed to its exit (exit bar and booked R). Signals alone were
    not enough - stop management is where the shipped preset now lives."""
    got, got_out = pine(bars, p)
    ref, ref_out = [], []
    E.run(bars, ctx, p, 0, len(bars["c"]), trade_log=ref, outcome_log=ref_out)

    gs = {(b, d) for b, d, *_ in got}
    rs = {(b, d) for b, d, *_ in ref}
    gm = {(b, d): (e, s, t) for b, d, e, s, t in got}
    rm = {(b, d): (e, s, t) for b, d, e, s, t in ref}
    diffs = [k for k in gs & rs
             if any(abs(x - y) > 1e-6 for x, y in zip(gm[k], rm[k]))]

    # exits, keyed by the signal that produced them
    go = {(b, d): (x, r) for b, d, x, r in got_out}
    ro = {(o["bar"], o["dir"]): (o["exit_bar"], round(o["r"], 6)) for o in ref_out}
    odiffs = [k for k in set(go) & set(ro)
              if go[k][0] != ro[k][0] or abs(go[k][1] - ro[k][1]) > 1e-6]
    # a trade booked by one side and not the other is just as much a mismatch
    odiffs += sorted(set(go) ^ set(ro))
    return len(got), len(ref), sorted(gs - rs), sorted(rs - gs), diffs, odiffs


OVERRIDE_VAR = "pLowDD"   # the Pine variable the 2nd preset overrides through


def check_preset(pine_path):
    """The parity test proves the Pine LOGIC matches the engine for a given
    parameter set. This proves the constants the Pine actually ships in its
    validated preset are that parameter set - otherwise the indicator would
    faithfully reproduce a configuration nobody tested."""
    src = open(pine_path).read()
    if not re.search(r"^bool\s+" + OVERRIDE_VAR + r"\s*=", src, re.M):
        print("\nPreset consistency:")
        print(f"  MISMATCH: the Pine no longer defines `{OVERRIDE_VAR}`. Every "
              f"second-preset check below would silently pass - update "
              f"OVERRIDE_VAR in this guard to the new name.")
        return False
    want = {
        "minSweepAtr": ("0.35", CANDIDATE.min_sweep_atr, 0.35),
        "reclaimBars": ("2", CANDIDATE.reclaim_bars, 2),
        "stopBufAtr": ("0.50", CANDIDATE.stop_buf_atr, 0.50),
        "rrTarget": ("3.0", CANDIDATE.rr, 3.0),
        "beAtR": ("1.5", CANDIDATE.be_at_r, 1.5),
        "beToR": ("-0.30", CANDIDATE.be_to_r, -0.30),
        "validity": ("12", CANDIDATE.validity, 12),
        "cooldown": ("6", CANDIDATE.cooldown, 6),
    }
    bad = []

    def resolved(name):
        """Pull the value a preset resolves `name` to. Handles both shapes:
            X = usePreset ? V : inX
            X = pLowDD ? W : usePreset ? V : inX
        and returns (V, W) so BOTH presets stay guarded. Returning None means
        the line was not found at all - which is the failure mode this check
        exists for, since a refactor can silently stop verifying a value."""
        m = re.search(r"^\s*\w+\s+" + name +
                      r"\s*=\s*(?:" + OVERRIDE_VAR + r" \? (\S+)\s*:\s*)?usePreset \? ([^:]+?)\s*:",
                      src, re.M)
        if not m:
            return None
        return m.group(2).strip(), (m.group(1).strip() if m.group(1) else None)

    for name, (literal, cand, expect) in want.items():
        got = resolved(name)
        if got is None:
            bad.append(f"{name}: no preset line found in the Pine")
        elif got[0] != literal:
            bad.append(f"{name}: Pine ships {got[0]}, validated value is {literal}")
        if abs(float(cand) - expect) > 1e-9:
            bad.append(f"{name}: CANDIDATE holds {cand}, expected {expect}")
    # the second preset differs ONLY in how the stop is managed after entry
    for name, want_alt in [("beAtR", "0.25"), ("beToR", "0.0")]:
        got = resolved(name)
        if got is None or got[1] != want_alt:
            bad.append(f"{name}: 'low drawdown' preset ships "
                       f"{got[1] if got else 'nothing'}, expected {want_alt}")
    for name in ("minSweepAtr", "reclaimBars", "rrTarget", "stopBufAtr", "cooldown"):
        got = resolved(name)
        if got and got[1] is not None:
            bad.append(f"{name}: the two presets must share this, but "
                       f"'low drawdown' overrides it with {got[1]}")
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
    specs = sys.argv[2].split(",") if len(sys.argv) > 2 else ["MNQ_1h"]
    check_preset(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "indicators", "po3_vwap_liquidity_sweep.pine"))
    print("\nSignal- and exit-by-exit parity, Pine transliteration vs engine:")
    failures = 0
    for spec in specs:
        bars = E.load_csv(os.path.join(data, f"{spec}.csv"))
        ctx = E.build_context(bars)
        for name, kw in CONFIGS.items():
            p = replace(CANDIDATE, **kw)
            ng, nr, extra, missing, diffs, odiffs = compare(bars, ctx, p)
            ok = not extra and not missing and not diffs and not odiffs
            failures += 0 if ok else 1
            print(f"  {'OK ' if ok else 'FAIL'} {spec:<9} {name:<26} "
                  f"pine={ng:<5} engine={nr:<5} extra={len(extra)} "
                  f"missing={len(missing)} price-diff={len(diffs)} "
                  f"exit-diff={len(odiffs)}"
                  + ("" if ok else f"  {(extra + missing + odiffs)[:4]}"))
    print(f"\n{'ALL CONFIGURATIONS MATCH' if not failures else str(failures) + ' MISMATCHING CONFIGURATIONS'}")
    sys.exit(1 if failures else 0)
