#!/usr/bin/env python3
"""Offline port of the DOL Engine (indicators/draw_on_liquidity.pine).

Mirrors the Pine logic bar for bar on a chart whose timeframe equals the
execution TF (the indicator's lag-free "local" path): execution-TF zones
(FVG / OB / breaker / iFVG), sub-structure BSL / SSL, HTF bias, confluence
anchors, the four-pillar score, DOL selection with hysteresis and the PoT
self-audit. STF / HTF series are resampled from the execution data and read
with the indicator's closed-bar semantics (expr[1] + lookahead_on: the
previous completed higher-timeframe bar).

It answers the question the indicator's label implies: when the engine
calls a level the draw with "PoT x%", how often is that level actually
touched within the horizon — and does a higher score mean a higher rate?

Usage:
  python3 dol_validate.py <csv> [exec_min stf_min htf_min]   # default 60 240 1440
  python3 dol_validate.py --bundled                          # EURUSD 1h shipped with
                                                             # `pip install backtesting`
CSV columns: time (unix seconds or "YYYY-MM-DD HH:MM:SS" UTC), open, high,
low, close, volume.
"""
import csv
import math
import os
import random
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

P = dict(max_pool=40, max_atr_dist=8.0, purge_mult=2.0, half_life=48.0, max_age=600,
         atr_len=14, swing_len=3, htf_len=3, fvg_min_atr=0.15, ifvg_max_in=2,
         ob_swing_len=5, dens_len=10, eq_tol=0.1, conf_tol=0.25,
         w_prox=30.0, w_fresh=20.0, w_conf=30.0, w_dens=20.0, min_score=30.0,
         hyst=8.0, horizon=30, zone_near=False,
         use_liq=True, use_fvg=True, use_ifvg=True, use_ob=True, use_brk=True)


# ── data ─────────────────────────────────────────────────────────────────────

def load(path):
    t, o, h, l, c, v = [], [], [], [], [], []
    with open(path) as f:
        rows = list(csv.reader(f))
    for row in rows[1:]:
        ts = row[0]
        try:
            sec = int(float(ts))
        except ValueError:
            sec = int(datetime.fromisoformat(ts).replace(tzinfo=timezone.utc).timestamp())
        t.append(sec)
        o.append(float(row[1]))
        h.append(float(row[2]))
        l.append(float(row[3]))
        c.append(float(row[4]))
        v.append(float(row[5]) if len(row) > 5 and row[5] else float("nan"))
    return t, o, h, l, c, v


def bucket_of(ts, minutes):
    if minutes == 10080:  # weeks start Monday 00:00 UTC
        return (ts // 86400 + 3) // 7
    return ts // (minutes * 60)


def resample(bars, minutes):
    """Aggregate to a higher TF. Returns (series, bucket index per input bar)."""
    t, o, h, l, c, v = bars
    out = [[], [], [], [], [], []]
    idx = []
    cur = None
    for i in range(len(t)):
        b = bucket_of(t[i], minutes)
        if b != cur:
            cur = b
            out[0].append(t[i])
            out[1].append(o[i])
            out[2].append(h[i])
            out[3].append(l[i])
            out[4].append(c[i])
            out[5].append(v[i])
        else:
            out[2][-1] = max(out[2][-1], h[i])
            out[3][-1] = min(out[3][-1], l[i])
            out[4][-1] = c[i]
            out[5][-1] += v[i]
        idx.append(len(out[0]) - 1)
    return out, idx


# ── Pine built-in equivalents ────────────────────────────────────────────────

def atr(h, l, c, n):
    """ta.atr: RMA of true range, seeded with the SMA of the first n values."""
    tr = [h[0] - l[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
                         for i in range(1, len(h))]
    out = [None] * len(h)
    if len(h) >= n:
        out[n - 1] = sum(tr[:n]) / n
        for i in range(n, len(h)):
            out[i] = (out[i - 1] * (n - 1) + tr[i]) / n
    return out


def sma(x, n):
    out = [None] * len(x)
    for i in range(n - 1, len(x)):
        w = x[i - n + 1:i + 1]
        if not any(math.isnan(z) for z in w):
            out[i] = sum(w) / n
    return out


def pivots(h, l, n):
    """ta.pivothigh / ta.pivotlow(n, n): value reported n bars after the pivot."""
    ph = [None] * len(h)
    pl = [None] * len(h)
    for i in range(2 * n, len(h)):
        p = i - n
        if all(h[p] > h[p - k] for k in range(1, n + 1)) and all(h[p] >= h[p + k] for k in range(1, n + 1)):
            ph[i] = h[p]
        if all(l[p] < l[p - k] for k in range(1, n + 1)) and all(l[p] <= l[p + k] for k in range(1, n + 1)):
            pl[i] = l[p]
    return ph, pl


def context(h, l, c, a, length, tolm):
    """f_context: pre-creation density of each bar (window = the bars before it)."""
    n = len(h)
    coil, eq, swl, swh = [0.0] * n, [0] * n, [False] * n, [False] * n
    for i in range(n):
        if i < length:
            continue
        hh = max(h[i - length:i])
        ll = min(l[i - length:i])
        ap = a[i - 1]
        tol = tolm * (ap or 0.0)
        cnt = sum(1 for j in range(1, length + 1) if h[i - j] >= hh - tol)
        cnt += sum(1 for j in range(1, length + 1) if l[i - j] <= ll + tol)
        eq[i] = max(cnt - 2, 0)
        if ap and ap > 0:
            coil[i] = max(0.0, min(1.0, 1.5 - (hh - ll) / (ap * math.sqrt(length))))
        swl[i] = l[i] < ll and c[i] > ll
        swh[i] = h[i] > hh and c[i] < hh
    return coil, eq, swl, swh


def structure(h, l, c, n):
    """f_structure: bias flips on a close through the last confirmed swing."""
    ph, pl = pivots(h, l, n)
    bias, sh_out, sl_out = [0] * len(h), [None] * len(h), [None] * len(h)
    sh = sl = None
    sh_used = sl_used = True
    b = 0
    for i in range(len(h)):
        if not sh_used and c[i] > sh:
            b, sh_used = 1, True
        if not sl_used and c[i] < sl:
            b, sl_used = -1, True
        if ph[i] is not None:
            sh, sh_used = ph[i], False
        if pl[i] is not None:
            sl, sl_used = pl[i], False
        bias[i], sh_out[i], sl_out[i] = b, sh, sl
    return bias, sh_out, sl_out, ph, pl


def exec_pack(bars, a, ctx, p):
    """f_execPack: FVG and order-block events per execution bar (off = 0)."""
    t, o, h, l, c, v = bars
    coil, eq, swl, swh = ctx
    n = len(t)
    m = p["ob_swing_len"]
    oph, opl = pivots(h, l, m)
    events = [[] for _ in range(n)]
    shi = slo = leglo = leghi = None
    shi_used = slo_used = True
    for i in range(n):
        if i >= 2 and a[i] is not None:
            gap_min = p["fvg_min_atr"] * a[i]
            if l[i] > h[i - 2] and c[i - 1] > h[i - 2] and l[i] - h[i - 2] >= gap_min:
                events[i].append(("BUFVG", False, l[i], h[i - 2], t[i - 1], coil[i - 1], eq[i - 1], swl[i - 1] or swl[i - 2]))
            if h[i] < l[i - 2] and c[i - 1] < l[i - 2] and l[i - 2] - h[i] >= gap_min:
                events[i].append(("BEFVG", True, l[i - 2], h[i], t[i - 1], coil[i - 1], eq[i - 1], swh[i - 1] or swh[i - 2]))
        # 1) structure breaks use the leg as it stood before this bar
        if not shi_used and c[i] > shi:
            shi_used = True
            if leglo is not None and leglo[1] < c[i]:
                events[i].append(("BUOB", False, leglo[1], leglo[0], leglo[2], leglo[3], leglo[4], leglo[5]))
        if not slo_used and c[i] < slo:
            slo_used = True
            if leghi is not None and leghi[1] > c[i]:
                events[i].append(("BEOB", True, leghi[0], leghi[1], leghi[2], leghi[3], leghi[4], leghi[5]))
        # 2) a new swing starts the leg that can produce the next block
        if oph[i] is not None:
            kk = min(range(i - m, i + 1), key=lambda q: (l[q], -q))
            shi, shi_used = oph[i], False
            leglo = (l[kk], h[kk], t[kk], coil[kk], eq[kk], swl[kk])
        if opl[i] is not None:
            kk = max(range(i - m, i + 1), key=lambda q: (h[q], q))
            slo, slo_used = opl[i], False
            leghi = (h[kk], l[kk], t[kk], coil[kk], eq[kk], swh[kk])
        # 3) extend the legs with this bar
        if leglo is not None and l[i] < leglo[0]:
            leglo = (l[i], h[i], t[i], coil[i], eq[i], swl[i])
        if leghi is not None and h[i] > leghi[0]:
            leghi = (h[i], l[i], t[i], coil[i], eq[i], swh[i])
    return events


# ── engine ───────────────────────────────────────────────────────────────────

ZONES = {"BUFVG", "BEFVG", "BUOB", "BEOB", "BUBRK", "BEBRK", "BUiFVG", "BEiFVG"}
FLIP = {"BUFVG": "BEiFVG", "BEFVG": "BUiFVG", "BUOB": "BEBRK", "BEOB": "BUBRK"}


@dataclass
class Level:
    id: int
    kind: str
    above: bool
    top: float
    bot: float
    t_born: int
    t_active: int
    arm: int
    coil: float
    eq: float
    induce: bool
    rvol: float
    inside: int = 0
    mitigated: bool = False
    eligible: bool = False
    score: float = 0.0
    parts: tuple = (0.0, 0.0, 0.0, 0.0)


def target(lv, p):
    if lv.kind not in ZONES:
        return lv.top
    if p["zone_near"]:
        return lv.bot if lv.above else lv.top
    return (lv.top + lv.bot) / 2.0


def touched(above, strict, price, hi, lo):
    if above:
        return hi > price if strict else hi >= price
    return lo < price if strict else lo <= price


def bucket(s):
    return 0 if s < 40 else 1 if s < 50 else 2 if s < 60 else 3 if s < 70 else 4


def run(bars, exec_min=60, stf_min=240, htf_min=1440, p=None, seed=7):
    p = dict(P, **(p or {}))
    rng = random.Random(seed)
    t, o, h, l, c, v = bars
    n = len(t)
    exec_sec = exec_min * 60

    # execution TF (== chart TF): the indicator's local path, off = 0
    a = atr(h, l, c, p["atr_len"])
    coil, eq, swl, swh = context(h, l, c, a, p["dens_len"], p["eq_tol"])
    vs = sma(v, 20)
    rvol = [v[i] / vs[i] if vs[i] and vs[i] > 0 else None for i in range(n)]
    exec_events = exec_pack(bars, a, (coil, eq, swl, swh), p)

    # STF: resampled, read as the previous completed bar
    sb, sidx = resample(bars, stf_min)
    st, so, sh_, sl_, sc, sv = sb
    sa = atr(sh_, sl_, sc, p["atr_len"])
    scoil, seq_, sswl, sswh = context(sh_, sl_, sc, sa, p["dens_len"], p["eq_tol"])
    sbias, _, _, sph, spl = structure(sh_, sl_, sc, p["swing_len"])
    svs = sma(sv, 20)
    srv = [sv[k] / svs[k] if svs[k] and svs[k] > 0 else None for k in range(len(st))]
    L = p["swing_len"]
    stf_pack = []
    for k in range(len(st)):
        tol = p["eq_tol"] * (sa[k] or 0.0)
        phe = ple = 0
        if k >= L + p["dens_len"]:
            hic, loc = sh_[k - L], sl_[k - L]
            for j in range(0, L + p["dens_len"] + 1):
                if j != L:
                    phe += sh_[k - j] >= hic - tol
                    ple += sl_[k - j] <= loc + tol
        piv = k - L
        stf_pack.append(dict(
            bias=sbias[k], ph=sph[k], pl=spl[k], ptime=st[piv] if piv >= 0 else None, atr=sa[k],
            coil=scoil[piv] if piv >= 0 else 0.0, pheq=phe, pleq=ple,
            phind=sswh[piv] if piv >= 0 else False, plind=sswl[piv] if piv >= 0 else False,
            rv=srv[piv] if piv >= 0 else None))

    # HTF structure
    hb_, hidx = resample(bars, htf_min)
    hbias, hsh, hsl, _, _ = structure(hb_[2], hb_[3], hb_[4], p["htf_len"])

    # daily / weekly anchors (previous period H/L, current period open)
    db, didx = resample(bars, 1440)
    wb, widx = resample(bars, 10080)

    pool = []
    next_id = 0
    dol_id = -1
    probes = {"dol": [], "nearest": [], "random": []}
    stats = {k: [[0, 0] for _ in range(5)] for k in probes}
    pop = []          # (score, parts, hit) for the whole eligible population
    pop_open = []
    dist_log = []
    switches = 0
    reasons = {"delivered": 0, "invalidated": 0, "overtaken": 0}
    ny_mid = ny_rth = None
    rth_set = False
    prev_ny_day = None
    prev_stf = None

    for i in range(n):
        # anchors
        dt = datetime.fromtimestamp(t[i], NY)
        if dt.day != prev_ny_day:
            ny_mid, rth_set = o[i], False
            prev_ny_day = dt.day
        if not rth_set and dt.hour * 60 + dt.minute >= 570:
            ny_rth, rth_set = o[i], True
        d, w = didx[i], widx[i]
        pdh = db[2][d - 1] if d > 0 else None
        pdl = db[3][d - 1] if d > 0 else None
        dopen = db[1][d]
        pwh = wb[2][w - 1] if w > 0 else None
        pwl = wb[3][w - 1] if w > 0 else None
        wopen = wb[1][w]
        k_h = hidx[i] - 1
        h_bias = hbias[k_h] if k_h >= 0 else 0
        h_sh = hsh[k_h] if k_h >= 0 else None
        h_sl = hsl[k_h] if k_h >= 0 else None
        k_s = sidx[i] - 1
        s_bias = stf_pack[k_s]["bias"] if k_s >= 0 else 0
        anchors = []
        if pdh is not None:
            anchors += [(pdh, 1.0), (pdl, 1.0), ((pdh + pdl) / 2, 0.6)]
        if pwh is not None:
            anchors += [(pwh, 1.0), (pwl, 1.0)]
        anchors += [(dopen, 0.6), (wopen, 0.6), (ny_mid, 0.6), (ny_rth, 0.6)]
        if h_sh is not None:
            anchors.append((h_sh, 0.8))
        if h_sl is not None:
            anchors.append((h_sl, 0.8))
        if h_sh is not None and h_sl is not None:
            anchors.append(((h_sh + h_sl) / 2, 0.6))

        stf_event = k_s >= 0 and k_s != prev_stf
        prev_stf = k_s
        atr_e = a[i]
        if atr_e is None or atr_e <= 0:
            continue
        e_close = c[i]
        arm_exec = t[i] + 1

        # 1) execution-TF close state machine
        for j in range(len(pool) - 1, -1, -1):
            lv = pool[j]
            kill = flip = False
            inside = lv.bot <= e_close <= lv.top
            if lv.kind == "BUFVG" and e_close < lv.bot:
                kill, flip = not p["use_ifvg"], p["use_ifvg"]
            elif lv.kind == "BEFVG" and e_close > lv.top:
                kill, flip = not p["use_ifvg"], p["use_ifvg"]
            elif lv.kind == "BUOB" and e_close < lv.bot:
                kill, flip = not p["use_brk"], p["use_brk"]
            elif lv.kind == "BEOB" and e_close > lv.top:
                kill, flip = not p["use_brk"], p["use_brk"]
            elif lv.kind == "BUBRK":
                kill = e_close < lv.bot
            elif lv.kind == "BEBRK":
                kill = e_close > lv.top
            elif lv.kind == "BUiFVG":
                if e_close < lv.bot:
                    kill = True
                elif inside:
                    lv.inside += 1
                    kill = lv.inside > p["ifvg_max_in"]
            elif lv.kind == "BEiFVG":
                if e_close > lv.top:
                    kill = True
                elif inside:
                    lv.inside += 1
                    kill = lv.inside > p["ifvg_max_in"]
            if kill:
                pool.pop(j)
            elif flip:
                lv.kind = FLIP[lv.kind]
                lv.above = not lv.above
                lv.mitigated = False
                lv.inside = 0
                lv.t_active = t[i]
                lv.arm = arm_exec

        # 2) new execution-TF zones (same detection as f_execPack, off = 0)
        def add_zone(kind, above, top, bot, tb, cz, ez, ind):
            nonlocal next_id
            pool.append(Level(next_id, kind, above, top, bot, tb, tb, arm_exec, cz, float(ez), ind, rvol[i]))
            next_id += 1

        for kind, above, top, bot, tb, cz, ez, ind in exec_events[i]:
            if (kind in ("BUFVG", "BEFVG") and p["use_fvg"]) or (kind in ("BUOB", "BEOB") and p["use_ob"]):
                add_zone(kind, above, top, bot, tb, cz, ez, ind)

        # 3) STF liquidity on a new completed STF bar
        if stf_event and p["use_liq"]:
            pk = stf_pack[k_s]
            for above, price, peq, pind in ((True, pk["ph"], pk["pheq"], pk["phind"]),
                                            (False, pk["pl"], pk["pleq"], pk["plind"])):
                if price is None:
                    continue
                kind = "BSL" if above else "SSL"
                tol = p["eq_tol"] * (pk["atr"] or 0.0)
                hit = next((x for x in pool if x.kind == kind and abs(x.top - price) <= tol), None)
                if hit is not None:
                    hit.eq += 1.0
                    hit.t_active = max(hit.t_active, pk["ptime"])
                    hit.coil = max(hit.coil, pk["coil"])
                    hit.induce = hit.induce or pind
                else:
                    pool.append(Level(next_id, kind, above, price, price, pk["ptime"], pk["ptime"], t[i],
                                      pk["coil"], float(peq), pind, pk["rv"]))
                    next_id += 1

        # 4) touches, purge, score
        dol_hit = False
        for j in range(len(pool) - 1, -1, -1):
            lv = pool[j]
            kill = False
            is_zone = lv.kind in ZONES
            if not lv.mitigated and t[i] >= lv.arm:
                tp = target(lv, p)
                if touched(lv.above, not is_zone, tp, h[i], l[i]):
                    lv.mitigated = True
                    dol_hit = dol_hit or lv.id == dol_id
                    if not is_zone:
                        kill = True
            if not kill:
                age = (t[i] - lv.t_active) / exec_sec
                dist_abs = abs(target(lv, p) - c[i]) / atr_e
                kill = age > p["max_age"] or dist_abs > p["max_atr_dist"] * p["purge_mult"]
            if kill:
                pool.pop(j)
            else:
                score_level(lv, p, c[i], t[i], atr_e, exec_sec, anchors, h_bias, s_bias)

        # 5) grade probes
        for key, plist in probes.items():
            keep = []
            for pr in plist:
                hit = touched(pr[1], pr[2], pr[0], h[i], l[i])
                if hit or t[i] >= pr[4]:
                    stats[key][pr[3]][0] += 1
                    stats[key][pr[3]][1] += hit
                else:
                    keep.append(pr)
            probes[key] = keep
        still = []
        for pr in pop_open:
            hit = touched(pr[1], pr[2], pr[0], h[i], l[i])
            if hit or t[i] >= pr[4]:
                pop.append((pr[3], pr[5], hit))
            else:
                still.append(pr)
        pop_open = still

        # 6) selection with hysteresis, then pool cap
        elig = [x for x in pool if x.eligible]
        best = max(elig, key=lambda x: x.score, default=None)
        cur = next((x for x in elig if x.id == dol_id), None)
        pick = best
        if cur is not None and best is not None and cur is not best and best.score < cur.score + p["hyst"]:
            pick = cur
        new_id = pick.id if pick else -1
        if new_id != dol_id:
            if dol_id >= 0:
                if dol_hit:
                    reasons["delivered"] += 1
                elif cur is None:
                    reasons["invalidated"] += 1   # flipped, purged, evicted or fell below eligibility
                else:
                    reasons["overtaken"] += 1
            dol_id = new_id
            if pick is not None:
                switches += 1
                deadline = t[i] + p["horizon"] * exec_sec
                tp = target(pick, p)
                probes["dol"].append((tp, pick.above, pick.kind not in ZONES, bucket(pick.score), deadline))
                dist_log.append(abs(tp - c[i]) / atr_e)
                near = min(elig, key=lambda x: abs(target(x, p) - c[i]))
                probes["nearest"].append((target(near, p), near.above, near.kind not in ZONES, bucket(pick.score), deadline))
                rnd = rng.choice(elig)
                probes["random"].append((target(rnd, p), rnd.above, rnd.kind not in ZONES, bucket(pick.score), deadline))
        if i % 5 == 0:
            for x in elig:
                pop_open.append((target(x, p), x.above, x.kind not in ZONES, x.score,
                                 t[i] + p["horizon"] * exec_sec, x.parts))
        while len(pool) > p["max_pool"]:
            cands = [(x.score if not x.mitigated else -1.0, x.t_active, q)
                     for q, x in enumerate(pool) if x.id != dol_id]
            if not cands:
                break
            pool.pop(min(cands)[2])
    return dict(stats=stats, pop=pop, switches=switches, dist=dist_log, bars=n, reasons=reasons)


def score_level(lv, p, close, now, atr_e, exec_sec, anchors, h_bias, s_bias):
    tp = target(lv, p)
    dist = ((tp - close) if lv.above else (close - tp)) / atr_e
    in_rng = 0 <= dist <= p["max_atr_dist"]
    age = max(0.0, (now - lv.t_active) / exec_sec)
    prox = 1.0 - (dist / p["max_atr_dist"]) ** 1.5 if in_rng else 0.0
    fresh = 0.5 ** (age / p["half_life"])
    tol = p["conf_tol"] * atr_e
    s = sum(wt for price, wt in anchors if price is not None and lv.bot - tol <= price <= lv.top + tol)
    anch = 1.0 - math.exp(-s)
    hb = 0.5 if h_bias == 0 else (1.0 if lv.above == (h_bias > 0) else 0.0)
    sb = 0.5 if s_bias == 0 else (1.0 if lv.above == (s_bias > 0) else 0.0)
    conf = 0.5 * anch + 0.5 * (0.6 * hb + 0.4 * sb)
    eqs = min(lv.eq / 3.0, 1.0)
    rvs = 0.5 if lv.rvol is None else max(0.0, min(1.0, (lv.rvol - 0.5) / 1.5))
    ind = 1.0 if lv.induce else 0.0
    if lv.kind in ZONES:
        dens = 0.35 * eqs + 0.30 * lv.coil + 0.20 * ind + 0.15 * rvs
    else:
        dens = 0.45 * eqs + 0.25 * lv.coil + 0.15 * ind + 0.15 * rvs
    wsum = p["w_prox"] + p["w_fresh"] + p["w_conf"] + p["w_dens"]
    lv.parts = (prox, fresh, conf, dens)
    lv.score = 100.0 * (p["w_prox"] * prox + p["w_fresh"] * fresh + p["w_conf"] * conf + p["w_dens"] * dens) / wsum if wsum > 0 else 0.0
    lv.eligible = not lv.mitigated and in_rng and lv.score >= p["min_score"]


# ── reporting ────────────────────────────────────────────────────────────────

def auc(pairs):
    """Probability a random touched level outscored a random untouched one."""
    pos = sorted(s for s, y in pairs if y)
    neg = sorted(s for s, y in pairs if not y)
    if not pos or not neg:
        return float("nan")
    import bisect
    total = 0.0
    for s in pos:
        lo = bisect.bisect_left(neg, s)
        hi = bisect.bisect_right(neg, s)
        total += lo + 0.5 * (hi - lo)
    return total / (len(pos) * len(neg))


NAMES = ["<40", "40-50", "50-60", "60-70", ">=70"]


def report(res, label):
    print(f"\n=== {label}: {res['bars']} bars, {res['switches']} DOL selections, "
          f"median target distance {sorted(res['dist'])[len(res['dist']) // 2]:.2f} ATR")
    print("target changes: " + ", ".join(f"{k} {v}" for k, v in res["reasons"].items()))
    print(f"{'bucket':8} | {'DOL n':>6} {'DOL hit%':>8} | {'nearest%':>8} | {'random%':>8}")
    tot = {k: [0, 0] for k in res["stats"]}
    for b in range(5):
        row = []
        for k in ("dol", "nearest", "random"):
            nn, hh = res["stats"][k][b]
            tot[k][0] += nn
            tot[k][1] += hh
            row.append((nn, hh))
        pct = lambda x: f"{100 * x[1] / x[0]:7.1f}%" if x[0] else "      —"
        print(f"{NAMES[b]:8} | {row[0][0]:6d} {pct(row[0]):>8} | {pct(row[1]):>8} | {pct(row[2]):>8}")
    pct = lambda x: f"{100 * x[1] / x[0]:.1f}%" if x[0] else "—"
    print(f"{'all':8} | {tot['dol'][0]:6d} {pct(tot['dol']):>8} | {pct(tot['nearest']):>8} | {pct(tot['random']):>8}")
    pop = res["pop"]
    if pop:
        print(f"population (every eligible level, sampled every 5 bars): n={len(pop)}")
        cal = [[0, 0] for _ in range(5)]
        for s, _, y in pop:
            cal[bucket(s)][0] += 1
            cal[bucket(s)][1] += y
        print("  touch rate by score bucket: " + "  ".join(
            f"{NAMES[b]} {100 * cal[b][1] / cal[b][0]:.0f}% (n={cal[b][0]})" for b in range(5) if cal[b][0]))
        print(f"  AUC composite score: {auc([(s, y) for s, _, y in pop]):.3f}")
        for q, nm in enumerate(("proximity", "freshness", "confluence", "density")):
            print(f"  AUC {nm:10} alone: {auc([(parts[q], y) for _, parts, y in pop]):.3f}")
        # does a pillar add information once distance is held fixed? split each
        # proximity quintile at the pillar's median and compare touch rates
        by_prox = sorted(pop, key=lambda r: r[1][0])
        size = len(by_prox) // 5
        for q, nm in ((1, "freshness"), (2, "confluence"), (3, "density")):
            lifts = []
            for k in range(5):
                chunk = by_prox[k * size:(k + 1) * size]
                med = sorted(r[1][q] for r in chunk)[len(chunk) // 2]
                hi = [r[2] for r in chunk if r[1][q] > med]
                lo = [r[2] for r in chunk if r[1][q] <= med]
                if hi and lo:
                    lifts.append(100.0 * (sum(hi) / len(hi) - sum(lo) / len(lo)))
            print(f"  {nm:10} lift within proximity quintiles: "
                  + " ".join(f"{x:+.1f}" for x in lifts) + f"  (mean {sum(lifts) / len(lifts):+.1f} pts)")


def bundled_csv():
    import importlib.util
    spec = importlib.util.find_spec("backtesting")
    if spec is None:
        sys.exit("pip install backtesting  (ships EURUSD 1h sample data)")
    return os.path.join(os.path.dirname(spec.origin), "test", "EURUSD.csv")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = bundled_csv() if sys.argv[1] == "--bundled" else sys.argv[1]
    tfs = [int(x) for x in sys.argv[2:5]] if len(sys.argv) >= 5 else [60, 240, 1440]
    data = load(path)
    report(run(data, *tfs), f"{os.path.basename(path)} exec {tfs[0]}m / STF {tfs[1]}m / HTF {tfs[2]}m")
