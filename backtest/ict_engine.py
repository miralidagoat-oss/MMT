#!/usr/bin/env python3
"""Python port of indicators/mmt_ict_precision_model.pine.

Same rules, same pessimistic fill model, so the parameters that ship in the
Pine defaults can be walk-forward tuned offline on real bars instead of being
guessed. Feed it OHLCV CSVs (time,open,high,low,close,volume — epoch seconds)
produced by backtest/fetch_yahoo.py.

Deliberate mirror notes:
  · ATR is Wilder's RMA of true range, exactly like ta.atr().
  · Pivots confirm `piv_len` bars late, exactly like ta.pivothigh/pivotlow().
  · PDH/PDL/settlement use the CME trading day (18:00–17:00 ET), which is what
    TradingView's daily bars hold for futures; the midnight opening price and
    the per-day counters use the ET calendar day, like the Pine script.
  · A limit can only fill on a bar AFTER the one that posted it, the target is
    never credited on the fill bar, and stop beats target inside one bar.
"""
import math

try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:                                    # pragma: no cover
    _ET = None

from datetime import datetime, timedelta, timezone

# ── defaults: the same numbers the Pine script ships with ────────────────────
P = dict(
    piv_len=3, atr_len=14, sweep_atr=0.06, raid_window=20, disp_atr=0.60,
    fvg_atr=0.15, fvg_window=5, eq_tol_atr=0.10,
    max_quad=0.75, entry_valid=18, free_on_expiry=True, max_hold=0, fill_pref="ce", array_pref="auto",
    stop_ticks=4, stop_atr=0.10, min_rr=2.0, max_rr=8.0, fallback_rr=0.0,
    max_risk_atr=2.0, min_risk_atr=0.15, be_trigger=1.0, partial_r=0.0, partial_pct=50.0,
    min_score=3, hrl_max=2, snd_raids=4, require_bias=False, use_news_fib=True,
    avoid_snd=True, use_smt=True, smt_len=20,
    kz_asia=(2000, 2400), kz_london=(200, 500), kz_ny=(830, 1130), kz_pm=None,
    max_per_kz=1, max_per_day=3, flatten_hm=1600,
    tick=0.25, max_pools=80, max_zones=60, max_swing=12, max_setups=20,
)

KZ_NAMES = ["Asia", "London", "NY AM", "NY PM", "none"]


def et_fields(ts):
    """(hhmm, calendar day key, CME trading day key, iso week key)."""
    if _ET is not None:
        d = datetime.fromtimestamp(ts, _ET)
    else:                                            # no tz database available
        d = datetime.fromtimestamp(ts, timezone(timedelta(hours=-4)))
    hhmm = d.hour * 100 + d.minute
    cal = (d.year, d.month, d.day)
    cme = d + timedelta(hours=6)                     # 18:00 ET starts the next day
    iso = cme.isocalendar()
    return hhmm, cal, (cme.year, cme.month, cme.day), (iso[0], iso[1])


def in_window(hhmm, win):
    if not win:
        return False
    a, b = win
    return a <= hhmm < b if a < b else (hhmm >= a or hhmm < b)


def atr_series(h, l, c, length):
    n = len(c)
    out = [None] * n
    tr_sum, prev = 0.0, None
    for i in range(n):
        tr = h[i] - l[i] if i == 0 else max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        if i < length:
            tr_sum += tr
            if i == length - 1:
                prev = tr_sum / length
                out[i] = prev
        else:
            prev = (prev * (length - 1) + tr) / length
            out[i] = prev
    return out


def run(bars, params=None, smt_bars=None):
    """bars: list of (ts, o, h, l, c, v). Returns (stats, trades, signals)."""
    p = dict(P, **(params or {}))
    t = [b[0] for b in bars]
    o = [b[1] for b in bars]
    h = [b[2] for b in bars]
    l = [b[3] for b in bars]
    c = [b[4] for b in bars]
    n = len(c)
    tick = p["tick"]
    atr = atr_series(h, l, c, p["atr_len"])
    bar_sec = min((t[i] - t[i - 1] for i in range(1, min(n, 200))), default=300) or 300

    smt_map = {b[0]: b for b in (smt_bars or [])}

    pools, zones, setups = [], [], []
    sw_hi, sw_lo = [], []                            # (price, bar) unbroken swings
    long_raid = short_raid = None
    ms_bias = 0

    day_key = week_key = None
    day_hi = day_lo = day_close = None
    prev_day = {}                                    # pdh/pdl/settle
    wk_hi = wk_lo = None
    prev_week = {}
    mid_open = None
    news_hi = news_lo = None
    prev_in_news = False
    sess_state = {}                                  # (asia/london) -> [hi, lo, active]
    gap = None
    raids = {1: 0, -1: 0}
    kz_used = [0, 0, 0, 0]
    setups_today = 0
    trade_days = 0
    last_down = last_up = None                       # (hi, lo) of the last opposing candle
    ld_hist, lu_hist = [], []                        # their value at the close of each bar

    trades, signals = [], []
    stats = dict(signals=0, filled=0, wins=0, losses=0, scratches=0, expired=0,
                 timeouts=0, net_r=0.0, gross_win=0.0, gross_loss=0.0,
                 peak_r=0.0, max_dd=0.0, days=0)
    diag = dict(raids=0, mss=0, no_entry=0, risk=0, no_target=0, obstacles=0,
                score=0, quota=0, seek_destroy=0, outside_kz=0, posted=0)
    kz_net = [0.0] * 5
    kz_trades = [0] * 5
    type_wl = {k: [0, 0] for k in ("FVG", "OB", "RB", "CE")}

    def add_pool(price, side, kind, grade, i):
        if price is None or any(
                (not q["tapped"]) and q["side"] == side and abs(q["price"] - price) <= tick
                for q in pools):
            return
        pools.append(dict(price=price, bar=i, side=side, kind=kind, grade=grade, tapped=False))
        if len(pools) > p["max_pools"]:
            pools.pop(0)

    def add_zone(top, bot, direction, kind, i):
        if top is None or bot is None or top <= bot:
            return
        if any(z["dir"] == direction and z["top"] == top and z["bot"] == bot for z in zones):
            return
        zones.append(dict(top=top, bot=bot, bar=i - 1, dir=direction, kind=kind,
                          mitigated=False, inverted=False))
        if len(zones) > p["max_zones"]:
            zones.pop(0)

    def swing_beyond(price, min_bar, up):
        best = any_ = None
        pool = sw_hi if up else sw_lo
        for v, b in pool:
            if (v > price) if up else (v < price):
                if any_ is None or ((v < any_) if up else (v > any_)):
                    any_ = v
                if b >= min_bar and (best is None or ((v < best) if up else (v > best))):
                    best = v
        return best if best is not None else any_

    for i in range(n):
        hhmm, cal, cme, iso = et_fields(t[i])
        a = atr[i]
        new_day = cal != day_key
        new_week = iso != week_key

        # ── daily / weekly aggregation (CME trading day) ────────────────────
        if cme != prev_day.get("key"):
            if prev_day.get("hi") is not None:
                prev_day["pdh"], prev_day["pdl"] = prev_day["hi"], prev_day["lo"]
                prev_day["settle"] = prev_day["close"]
            prev_day["key"], prev_day["hi"], prev_day["lo"] = cme, h[i], l[i]
        else:
            prev_day["hi"] = max(prev_day["hi"], h[i])
            prev_day["lo"] = min(prev_day["lo"], l[i])
        prev_day["close"] = c[i]
        if iso != prev_week.get("key"):
            if prev_week.get("hi") is not None:
                prev_week["pwh"], prev_week["pwl"] = prev_week["hi"], prev_week["lo"]
            prev_week["key"], prev_week["hi"], prev_week["lo"] = iso, h[i], l[i]
        else:
            prev_week["hi"] = max(prev_week["hi"], h[i])
            prev_week["lo"] = min(prev_week["lo"], l[i])

        if new_day:
            day_key = cal
            mid_open = o[i]
            raids = {1: 0, -1: 0}
            kz_used = [0, 0, 0, 0]
            setups_today = 0
            trade_days += 1
            add_pool(prev_day.get("pdh"), 1, "PDH", 3, i)
            add_pool(prev_day.get("pdl"), -1, "PDL", 3, i)
            st = prev_day.get("settle")
            if st is not None:
                add_pool(st, -1 if c[i] > st else 1, "SETTLE", 2, i)
        if new_week:
            week_key = iso
            add_pool(prev_week.get("pwh"), 1, "PWH", 3, i)
            add_pool(prev_week.get("pwl"), -1, "PWL", 3, i)

        # ── session windows ─────────────────────────────────────────────────
        flags = dict(asia=in_window(hhmm, p["kz_asia"]), london=in_window(hhmm, p["kz_london"]),
                     ny=in_window(hhmm, p["kz_ny"]), pm=in_window(hhmm, p["kz_pm"]))
        kz_now = 0 if flags["asia"] else 1 if flags["london"] else 2 if flags["ny"] else 3 if flags["pm"] else -1
        kz_any = any((p["kz_asia"], p["kz_london"], p["kz_ny"], p["kz_pm"]))
        in_kz = (not kz_any) or kz_now >= 0

        for name, pool_kind in (("asia", "ASIA"), ("london", "LDN")):
            st = sess_state.setdefault(name, [None, None, False])
            if flags[name]:
                st[0] = h[i] if not st[2] else max(st[0], h[i])
                st[1] = l[i] if not st[2] else min(st[1], l[i])
                st[2] = True
            elif st[2]:
                add_pool(st[0], 1, pool_kind + " hi", 2, i)
                add_pool(st[1], -1, pool_kind + " lo", 2, i)
                st[2] = False
        in_news = in_window(hhmm, (830, 900))
        if in_news and not prev_in_news:
            news_hi, news_lo = h[i], l[i]
        elif in_news:
            news_hi, news_lo = max(news_hi, h[i]), min(news_lo, l[i])
        prev_in_news = in_news

        # ── NDOG / NWOG: the gap left by the session break ──────────────────
        if i > 0 and (t[i] - t[i - 1]) > bar_sec * 2:
            gap = dict(top=max(c[i - 1], o[i]), bot=min(c[i - 1], o[i]), bar=i,
                       weekly=(t[i] - t[i - 1]) > 86400 * 1.5)
            if gap["top"] > gap["bot"]:
                tag = "NWOG" if gap["weekly"] else "NDOG"
                add_pool(gap["top"], 1, tag + " hi", 3, i)
                add_pool(gap["bot"], -1, tag + " lo", 3, i)
                ce = (gap["top"] + gap["bot"]) / 2
                add_pool(ce, -1 if c[i] > ce else 1, tag + " CE", 2, i)

        # ── structure: confirmed pivots, PH/PL, PHC/PLC, EQH/EQL ────────────
        pl_ = p["piv_len"]
        if a and i >= 2 * pl_:
            k = i - pl_
            left, right = range(k - pl_, k), range(k + 1, i + 1)
            if all(h[k] > h[j] for j in left) and all(h[k] > h[j] for j in right):
                prev_ph = sw_hi[-1][0] if sw_hi else None
                is_eq = prev_ph is not None and abs(h[k] - prev_ph) <= p["eq_tol_atr"] * a
                add_pool(h[k], 1, "EQH" if is_eq else "PH", 2 if is_eq else 1, i)
                add_pool(c[k], 1, "PHC", 1, i)
                sw_hi.append((h[k], k))
                del sw_hi[:-p["max_swing"]]
            if all(l[k] < l[j] for j in left) and all(l[k] < l[j] for j in right):
                prev_pl = sw_lo[-1][0] if sw_lo else None
                is_eq = prev_pl is not None and abs(l[k] - prev_pl) <= p["eq_tol_atr"] * a
                add_pool(l[k], -1, "EQL" if is_eq else "PL", 2 if is_eq else 1, i)
                add_pool(c[k], -1, "PLC", 1, i)
                sw_lo.append((l[k], k))
                del sw_lo[:-p["max_swing"]]

        broke_hi = any(c[i] > v for v, _ in sw_hi)
        broke_lo = any(c[i] < v for v, _ in sw_lo)
        sw_hi[:] = [s for s in sw_hi if c[i] <= s[0]]
        sw_lo[:] = [s for s in sw_lo if c[i] >= s[0]]
        if broke_hi:
            ms_bias = 1
        if broke_lo:
            ms_bias = -1

        # ── PD arrays ───────────────────────────────────────────────────────
        # Pine updates the last-opposing-candle vars at the top of the bar and
        # then reads them at offset [2]; mirror that ordering exactly.
        if c[i] < o[i]:
            last_down = (h[i], l[i])
        if c[i] > o[i]:
            last_up = (h[i], l[i])
        ld_hist.append(last_down)
        lu_hist.append(last_up)
        prev_down2 = ld_hist[i - 2] if i >= 2 else None
        prev_up2 = lu_hist[i - 2] if i >= 2 else None
        if a and i >= 2:
            gap_up = l[i] - h[i - 2]
            gap_dn = l[i - 2] - h[i]
            if gap_up > 0 and gap_up >= p["fvg_atr"] * a:
                add_zone(l[i], h[i - 2], 1, "FVG", i)
                if prev_down2:
                    add_zone(prev_down2[0], prev_down2[1], 1, "OB", i)
            if gap_dn > 0 and gap_dn >= p["fvg_atr"] * a:
                add_zone(l[i - 2], h[i], -1, "FVG", i)
                if prev_up2:
                    add_zone(prev_up2[0], prev_up2[1], -1, "OB", i)

        for z in list(zones):
            eff = -z["dir"] if z["inverted"] else z["dir"]
            if h[i] >= z["bot"] and l[i] <= z["top"]:
                z["mitigated"] = True
            if eff > 0 and c[i] < z["bot"]:
                z["inverted"] = not z["inverted"]
                z["mitigated"] = False
            elif eff < 0 and c[i] > z["top"]:
                z["inverted"] = not z["inverted"]
                z["mitigated"] = False
            if i - z["bar"] > 300:
                zones.remove(z)

        # ── raids ───────────────────────────────────────────────────────────
        if a and i > max(p["atr_len"], 50):
            sweep_min = max(p["sweep_atr"] * a, tick)
            was_consol = (max(h[max(0, i - 12):i]) - min(l[max(0, i - 12):i])) <= 2.5 * a
            for direction in (1, -1):
                best = None
                for q in pools:
                    if q["tapped"] or i - q["bar"] <= p["piv_len"]:
                        continue
                    hit = (q["side"] < 0 and l[i] <= q["price"] - sweep_min and c[i] > q["price"]) \
                        if direction > 0 else \
                        (q["side"] > 0 and h[i] >= q["price"] + sweep_min and c[i] < q["price"])
                    if not hit:
                        continue
                    if best is None or q["grade"] > best["grade"] or (
                            q["grade"] == best["grade"] and
                            ((q["price"] > best["price"]) if direction > 0 else (q["price"] < best["price"]))):
                        best = q
                if best is None:
                    continue
                smt = False
                if p["use_smt"] and t[i] in smt_map and i >= p["smt_len"]:
                    sb = smt_map[t[i]]
                    ref = [smt_map[t[j]] for j in range(i - p["smt_len"], i) if t[j] in smt_map]
                    if len(ref) >= p["smt_len"] // 2:
                        if direction > 0:
                            smt = l[i] < min(l[i - p["smt_len"]:i]) and sb[3] > min(x[3] for x in ref)
                        else:
                            smt = h[i] > max(h[i - p["smt_len"]:i]) and sb[2] < max(x[2] for x in ref)
                raid = dict(bar=i, extreme=l[i] if direction > 0 else h[i], dir=direction,
                            kind=best["kind"], grade=best["grade"], smt=smt, consol=was_consol,
                            mss=swing_beyond(l[i] if direction > 0 else h[i], i, direction > 0),
                            mss_done=False, mss_bar=-1,
                            leg_ext=h[i] if direction > 0 else l[i])
                if best["grade"] >= 2:            # only majors define the day profile
                    raids[direction] += 1
                diag["raids"] += 1
                if direction > 0:
                    long_raid = raid
                    add_zone(min(o[i], c[i]), l[i], 1, "RB", i)
                else:
                    short_raid = raid
                    add_zone(h[i], max(o[i], c[i]), -1, "RB", i)

        for q in pools:
            if not q["tapped"] and (h[i] >= q["price"] if q["side"] > 0 else l[i] <= q["price"]):
                q["tapped"] = True
        pools[:] = [q for q in pools if not (q["tapped"] and i - q["bar"] > 400)]

        seek_destroy = p["avoid_snd"] and raids[1] >= 2 and raids[-1] >= 2 and \
            (raids[1] + raids[-1]) >= p["snd_raids"]

        # ── displacement → MSS → build ──────────────────────────────────────
        def has_fvg(direction, min_bar):
            return any(z["kind"] == "FVG" and not z["inverted"] and z["dir"] == direction
                       and i - z["bar"] <= p["fvg_window"] and z["bar"] >= min_bar - 2
                       for z in zones)

        def build(raid):
            nonlocal setups_today
            direction = raid["dir"]
            leg_lo = raid["extreme"] if direction > 0 else raid["leg_ext"]
            leg_hi = raid["leg_ext"] if direction > 0 else raid["extreme"]
            leg = leg_hi - leg_lo
            if leg <= 0:
                diag["no_entry"] += 1
                return False
            quad = leg_lo + leg * p["max_quad"] if direction > 0 else leg_hi - leg * p["max_quad"]
            buf = max(p["stop_ticks"] * tick, p["stop_atr"] * a)
            stop = raid["extreme"] - buf if direction > 0 else raid["extreme"] + buf
            min_risk = max(p["min_risk_atr"] * a, tick * 2)
            max_risk = p["max_risk_atr"] * a
            entry = kind = None
            rank = 0
            for z in zones:
                eff = -z["dir"] if z["inverted"] else z["dir"]
                if eff != direction or z["bar"] < raid["bar"] - 2:
                    continue
                if z["kind"] == "FVG":
                    k = "iFVG" if z["inverted"] else "FVG"
                elif z["kind"] == "OB":
                    k = "BRK" if z["inverted"] else "OB"
                else:
                    k = "iRB" if z["inverted"] else "RB"
                fam = "FVG" if k in ("FVG", "iFVG") else "OB" if k in ("OB", "BRK") else "RB"
                if p["array_pref"] != "auto" and p["array_pref"] != fam.lower():
                    continue
                if p["fill_pref"] == "ce":
                    lvl = (z["top"] + z["bot"]) / 2
                elif p["fill_pref"] == "proximal":
                    lvl = z["top"] if direction > 0 else z["bot"]
                else:
                    lvl = z["bot"] if direction > 0 else z["top"]
                ok_quad = lvl <= quad if direction > 0 else lvl >= quad
                pull = lvl < c[i] if direction > 0 else lvl > c[i]
                kr = 3 if fam == "FVG" else 2 if fam == "OB" else 1
                c_risk = lvl - stop if direction > 0 else stop - lvl
                risk_ok = min_risk <= c_risk <= max_risk
                better = entry is None or ((lvl > entry) if direction > 0 else (lvl < entry)) or \
                    (lvl == entry and kr > rank)
                if ok_quad and pull and risk_ok and better:
                    entry, kind, rank = lvl, k, kr
            if entry is None and p["array_pref"] == "auto":
                ce = leg_lo + leg * 0.5
                ce_risk = ce - stop if direction > 0 else stop - ce
                if min_risk <= ce_risk <= max_risk:
                    entry, kind = ce, "CE"
            if entry is None:
                diag["no_entry"] += 1
                return False
            risk = entry - stop if direction > 0 else stop - entry
            if risk <= 0:
                diag["risk"] += 1
                return False

            target = None
            for q in pools:
                if q["tapped"] or q["side"] != direction:
                    continue
                rr = (q["price"] - entry) / risk if direction > 0 else (entry - q["price"]) / risk
                if rr >= p["min_rr"] and (target is None or
                                          ((q["price"] < target) if direction > 0 else (q["price"] > target))):
                    target = q["price"]
            if target is None and p["fallback_rr"] > 0:
                target = entry + p["fallback_rr"] * risk * direction
            if target is None:
                diag["no_target"] += 1
                return False
            rr_raw = (target - entry) / risk if direction > 0 else (entry - target) / risk
            if rr_raw > p["max_rr"]:
                target = entry + p["max_rr"] * risk * direction

            lo_b, hi_b = min(entry, target), max(entry, target)
            obstacles = sum(1 for q in pools if not q["tapped"] and lo_b < q["price"] < hi_b
                            and q["side"] == direction and abs(q["price"] - target) > tick)
            obstacles += sum(1 for z in zones
                             if (-z["dir"] if z["inverted"] else z["dir"]) == -direction
                             and not z["mitigated"] and lo_b < (z["top"] + z["bot"]) / 2 < hi_b)

            settle = prev_day.get("settle")
            bias_ok = (c[i] > (mid_open or c[i]) and c[i] > (settle or c[i])) if direction > 0 else \
                      (c[i] < (mid_open or c[i]) and c[i] < (settle or c[i]))
            gap_touch = bool(gap) and (gap["bot"] <= raid["extreme"] <= gap["top"] or
                                       gap["bot"] <= entry <= gap["top"])
            fib_ok = False
            if p["use_news_fib"] and kz_now == 2 and news_hi and news_lo and news_hi > news_lo:
                frac = (news_hi - entry) / (news_hi - news_lo) if direction > 0 else \
                       (entry - news_lo) / (news_hi - news_lo)
                fib_ok = 0.45 <= frac <= 0.55 or 0.60 <= frac <= 0.82
            eq_leg = leg_lo + leg * 0.5
            deep = entry <= eq_leg if direction > 0 else entry >= eq_leg

            score = sum([raid["smt"], raid["grade"] >= 2, bias_ok, obstacles == 0, raid["consol"],
                         kind != "CE", fib_ok, gap_touch, deep])
            kz_free = kz_now < 0 or kz_used[kz_now] < p["max_per_kz"]
            if not in_kz:
                diag["outside_kz"] += 1
                return False
            if seek_destroy:
                diag["seek_destroy"] += 1
                return False
            if not (setups_today < p["max_per_day"] and kz_free):
                diag["quota"] += 1
                return False
            if obstacles > p["hrl_max"]:
                diag["obstacles"] += 1
                return False
            if score < p["min_score"] or (p["require_bias"] and not bias_ok):
                diag["score"] += 1
                return False
            diag["posted"] += 1

            setups.append(dict(entry=entry, stop=stop, target=target, risk=risk, dir=direction,
                               kind=kind, kz=kz_now, score=score, bar=i, filled=-1, state=0,
                               be=False, part=False, booked=0.0, ts=t[i], day=cal))
            signals.append(dict(ts=t[i], bar=i, dir=direction, kind=kind, kz=kz_now, score=score,
                                entry=entry, stop=stop, target=target,
                                rr=(target - entry) / risk * direction, raid=raid["kind"]))
            setups_today += 1
            if kz_now >= 0:
                kz_used[kz_now] += 1
            return True

        if a and i > max(p["atr_len"], 50):
            body_up = c[i] > o[i] and (c[i] - o[i]) >= p["disp_atr"] * a
            body_dn = o[i] > c[i] and (o[i] - c[i]) >= p["disp_atr"] * a
            for raid, is_long in ((long_raid, True), (short_raid, False)):
                if raid is None:
                    continue
                if i - raid["bar"] > p["raid_window"]:
                    if is_long:
                        long_raid = None
                    else:
                        short_raid = None
                    continue
                raid["leg_ext"] = max(raid["leg_ext"], h[i]) if is_long else min(raid["leg_ext"], l[i])
                if not raid["mss_done"]:
                    lvl = swing_beyond(raid["extreme"], raid["bar"], is_long)
                    if lvl is not None:
                        raid["mss"] = lvl if raid["mss"] is None else (
                            min(raid["mss"], lvl) if is_long else max(raid["mss"], lvl))
                    if is_long and l[i] < raid["extreme"]:
                        raid["extreme"] = l[i]
                    if not is_long and h[i] > raid["extreme"]:
                        raid["extreme"] = h[i]
                    if raid["mss"] is not None and (
                            (c[i] > raid["mss"] and c[i - 1] <= raid["mss"] and body_up) if is_long
                            else (c[i] < raid["mss"] and c[i - 1] >= raid["mss"] and body_dn)):
                        raid["mss_done"] = True
                        raid["mss_bar"] = i
                        diag["mss"] += 1
                # a three-candle FVG only confirms on the bar AFTER the
                # displacement, so arm the entry for a few bars past the shift
                if raid["mss_done"]:
                    if i - raid["mss_bar"] > p["fvg_window"]:
                        if is_long:
                            long_raid = None
                        else:
                            short_raid = None
                    elif has_fvg(1 if is_long else -1, raid["bar"]) and build(raid):
                        stats["signals"] += 1
                        if is_long:
                            long_raid = None
                        else:
                            short_raid = None

        # ── grading engine ──────────────────────────────────────────────────
        part_frac = p["partial_pct"] / 100.0 if p["partial_r"] > 0 else 0.0
        while len(setups) > p["max_setups"]:
            old = setups.pop(0)
            if old["state"] == 0:
                stats["expired"] += 1
            else:
                r = old["booked"] + (1 - part_frac) * (
                    (c[i] - old["entry"]) if old["dir"] > 0 else (old["entry"] - c[i])) / old["risk"]
                stats["net_r"] += r
                stats["gross_win" if r > 0 else "gross_loss"] += abs(r)
                stats["timeouts"] += 1

        flatten = p["flatten_hm"] and i > 0 and hhmm >= p["flatten_hm"] > et_fields(t[i - 1])[0]
        for s in list(setups):
            if i <= s["bar"]:
                continue
            outcome = 0
            if s["state"] == 0:
                hit = l[i] <= s["entry"] if s["dir"] > 0 else h[i] >= s["entry"]
                if hit:
                    s["state"], s["filled"] = 1, i
                    stats["filled"] += 1
                    if (l[i] <= s["stop"]) if s["dir"] > 0 else (h[i] >= s["stop"]):
                        outcome = -1
                elif i - s["bar"] >= p["entry_valid"]:
                    outcome = 2
            else:
                stop_hit = l[i] <= s["stop"] if s["dir"] > 0 else h[i] >= s["stop"]
                tp_hit = h[i] >= s["target"] if s["dir"] > 0 else l[i] <= s["target"]
                outcome = (4 if s["be"] else -1) if stop_hit else 1 if tp_hit else 0
                if outcome == 0 and p["partial_r"] > 0 and not s["part"]:
                    lvl = s["entry"] + p["partial_r"] * s["risk"] * s["dir"]
                    if (h[i] >= lvl) if s["dir"] > 0 else (l[i] <= lvl):
                        s["part"] = True
                        s["booked"] = part_frac * p["partial_r"]
                if outcome == 0 and p["be_trigger"] > 0 and not s["be"]:
                    lvl = s["entry"] + p["be_trigger"] * s["risk"] * s["dir"]
                    if (h[i] >= lvl) if s["dir"] > 0 else (l[i] <= lvl):
                        s["be"] = True
                        s["stop"] = s["entry"]
                if outcome == 0 and ((p["max_hold"] and i - s["filled"] >= p["max_hold"]) or flatten):
                    outcome = 3
            if outcome == 0:
                continue

            rem = 1 - part_frac
            fam = "FVG" if s["kind"] in ("FVG", "iFVG") else "OB" if s["kind"] in ("OB", "BRK") \
                else "RB" if s["kind"] in ("RB", "iRB") else "CE"
            r = None
            if outcome == 2:
                stats["expired"] += 1
                if p["free_on_expiry"] and s["day"] == cal:
                    setups_today = max(setups_today - 1, 0)
                    if s["kz"] >= 0:
                        kz_used[s["kz"]] = max(kz_used[s["kz"]] - 1, 0)
            elif outcome == 1:
                rr = (s["target"] - s["entry"]) / s["risk"] * s["dir"]
                r = s["booked"] + rem * rr
                stats["wins"] += 1
                type_wl[fam][0] += 1
            elif outcome == -1:
                r = s["booked"] - rem
                stats["losses"] += 1
                type_wl[fam][1] += 1
            elif outcome == 4:
                r = s["booked"]
                stats["scratches"] += 1
            else:
                r = s["booked"] + rem * ((c[i] - s["entry"]) if s["dir"] > 0
                                         else (s["entry"] - c[i])) / s["risk"]
                stats["timeouts"] += 1
            if r is not None:
                stats["net_r"] += r
                stats["gross_win" if r > 0 else "gross_loss"] += abs(r)
                stats["peak_r"] = max(stats["peak_r"], stats["net_r"])
                stats["max_dd"] = max(stats["max_dd"], stats["peak_r"] - stats["net_r"])
                ki = 4 if s["kz"] < 0 else s["kz"]
                kz_net[ki] += r
                kz_trades[ki] += 1
                trades.append(dict(ts=s["ts"], exit_ts=t[i], dir=s["dir"], kind=s["kind"],
                                   kz=s["kz"], score=s["score"], r=r, outcome=outcome,
                                   entry=s["entry"], stop=s["stop"], target=s["target"]))
            setups.remove(s)

    stats["days"] = trade_days
    stats["kz_net"] = kz_net
    stats["kz_trades"] = kz_trades
    stats["type_wl"] = type_wl
    dec = stats["wins"] + stats["losses"]
    closed = dec + stats["scratches"] + stats["timeouts"]
    stats["win_rate"] = 100.0 * stats["wins"] / dec if dec else None
    stats["pf"] = stats["gross_win"] / stats["gross_loss"] if stats["gross_loss"] > 0 else None
    stats["expectancy"] = stats["net_r"] / closed if closed else None
    stats["closed"] = closed
    stats["per_day"] = stats["signals"] / trade_days if trade_days else None
    stats["fill_rate"] = 100.0 * stats["filled"] / stats["signals"] if stats["signals"] else None
    stats["diag"] = diag
    return stats, trades, signals
