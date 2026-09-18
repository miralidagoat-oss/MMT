#!/usr/bin/env python3
"""Reach-and-hold calibration for the TERMINUS survival reversal engine.

TERMINUS does not emit entries, it emits a probability, so win rate is the
wrong instrument. The question is whether the number is honest: when the
dashboard says 40%, does the wall hold 40% of the time?

The displayed probability factors into two independently testable claims,
and testing them separately says WHICH half is wrong:

  reach = 2 * (1 - Phi(d / sigma_rem))      first passage, reflection principle
      Will price touch the wall's near edge before the session ends? Pure
      geometry under driftless Brownian motion. No trade model, no fill
      assumptions, no slippage - just bar data. Deviation from the diagonal
      here is a direct measurement of how non-Brownian the tape is.

  hold  = 1 - exp(-(kM * m_eff + kS * sqrt(s)))     absorbed mass + stop fuel
      Given price touched, did the wall turn it? This is a behavioral claim
      about order flow, and the exponential form is an assumption rather than
      a derivation. Tested conditional on reach actually happening.

  prob  = reach * hold * surv     what the dashboard prints
      Reported too, but note the survival chain makes it conservative by
      construction: a nearer wall holding first suppresses it.

Everything is resolved strictly forward from the prediction bar. Nodes are
born from completed epochs, ADR comes from prior days, and no outcome is read
from a bar at or before the one that produced the prediction.

Predictions are heavily autocorrelated - one node is the terminus for hours,
emitting a near-identical row every bar. Raw counts would badly overstate
significance, so the reported figures de-duplicate to one row per
(node, side, session) and the raw count is shown alongside for contrast.

Usage:
  python3 calibrate_terminus.py data/MNQ_1h.csv
  python3 calibrate_terminus.py data/MNQ_15m.csv --tf 900
  python3 calibrate_terminus.py --synthetic            # harness self-test
  python3 calibrate_terminus.py --synthetic --sessions 800 --seed 7

The synthetic mode is a unit test of this file, not of the market. It drives
the identical field/scan code with driftless geometric Brownian motion, where
the reflection principle is exactly true. Two results are expected:

  reach  ->  on the diagonal, up to a known floor. Measuring first passage on
             OHLC bars systematically UNDER-detects touches: a bar's high is a
             discrete sample of a continuous path, and the reflection principle
             describes the continuous max. Simulation puts the resulting gap at
             roughly -1% per bucket at 60 sub-steps and -0.4% at 240. So a small
             negative reach gap on real data is an artefact of bar sampling, not
             the model overstating reach. Read gaps beyond a couple of points.
  hold   ->  flat, no resolution. GBM has no memory, so mass and stop fuel
             carry no information and the model cannot have skill. Confirming
             the harness detects the ABSENCE of skill is what makes a
             non-flat curve on real data meaningful.
"""
import argparse
import csv
import math
import random
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

DAY_MS = 86_400_000


# ── parameters (mirror the Pine inputs) ──────────────────────────────────────

@dataclass
class Params:
    # memory field
    epoch_days: int = 1
    n_bins: int = 48
    peak_mult: float = 1.35
    top_k: int = 3
    w_calm_pct: float = 0.068
    w_vol_pct: float = 0.102
    max_nodes: int = 60
    max_age_d: float = 20.0
    half_life_d: float = 5.0
    band_pct: float = 10.0
    roll_pct: float = 12.0
    # hold model
    k_m: float = 0.35
    k_s: float = 0.40
    fuel_zone: float = 3.0
    piv_len: int = 5
    # reach model
    tz: str = "America/New_York"
    s_start: tuple = (9, 30)
    s_end: tuple = (16, 0)
    adr_len: int = 14
    # regime HMM
    hmm_len: int = 100
    mu_c: float = -0.25
    sd_c: float = 0.45
    mu_v: float = 0.45
    sd_v: float = 0.60
    p_stay: float = 0.98
    # outcome resolution (harness only, no Pine counterpart)
    hold_horizon: int = 12   # bars after the touch in which a close-through kills the wall
    rev_mult: float = 2.0    # retrace, in sigma_bar, that counts as a tradeable reversal


# ── exact ports of the Pine functions ────────────────────────────────────────

def f_phi(x):
    t = 1.0 / (1.0 + 0.2316419 * abs(x))
    d = 0.3989422804 * math.exp(-x * x / 2.0)
    q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
    return 1.0 - q if x >= 0 else q


def f_reach(d, s):
    return min(1.0, 2.0 * (1.0 - f_phi(d / s))) if s > 0 else 0.0


def f_gauss(x, mu, sd):
    return math.exp(-0.5 * ((x - mu) / sd) ** 2) / sd


@dataclass
class Node:
    p: float
    m: float
    w: float
    t: int          # ms, re-based on merge (see the Pine correction note)
    side: int
    id: int
    prob: float = 0.0
    hold: float = 0.0


def f_mass(n, now_ms, hl_d):
    return n.m * 0.5 ** (((now_ms - n.t) / DAY_MS) / hl_d)


def f_hold(n, res, P, now_ms):
    m_eff = f_mass(n, now_ms, P.half_life_d)
    fuel_r = P.fuel_zone * n.w
    s = 0
    for r in res:
        if n.side == 1 and n.p - n.w - fuel_r <= r <= n.p + n.w:
            s += 1
        if n.side == -1 and n.p - n.w <= r <= n.p + n.w + fuel_r:
            s += 1
    return 1.0 - math.exp(-(P.k_m * m_eff + P.k_s * math.sqrt(s)))


def f_side(nodes, sd, px, s_rem, res, P, now_ms):
    """Returns (terminus_node, best_prob, expected_px, none_prob, per_node).

    Mirrors the corrected Pine: walls price has already closed through are
    spent and excluded, so a breached node cannot score reach = 1.0 off the
    clamped distance.
    """
    cand = []
    for n in nodes:
        if n.side != sd:
            continue
        n.prob = 0.0
        spent = px > n.p + n.w if sd == 1 else px < n.p - n.w
        if spent:
            continue
        edge = n.p - n.w if sd == 1 else n.p + n.w
        d = max(0.0, edge - px) if sd == 1 else max(0.0, px - edge)
        cand.append((d, n, edge))
    cand.sort(key=lambda x: x[0])

    surv, best, best_p, sum_p, sum_px = 1.0, None, 0.0, 0.0, 0.0
    rows = []
    for d, n, edge in cand:
        h = f_hold(n, res, P, now_ms)
        reach = f_reach(d, s_rem)
        pr = reach * h * surv
        n.hold, n.prob = h, pr
        surv *= (1.0 - h)
        sum_p += pr
        sum_px += pr * n.p
        rows.append((n, d, edge, reach, h, pr))
        if pr > best_p:
            best_p, best = pr, n
    exp_px = sum_px / sum_p if sum_p > 0 else None
    return best, best_p, exp_px, 1.0 - sum_p, rows


# ── session clock (ported, including the midnight wrap fix) ──────────────────

class SessionClock:
    def __init__(self, P):
        self.tz = ZoneInfo(P.tz)
        self.sh, self.sm = P.s_start
        self.eh, self.em = P.s_end

    def bounds(self, ts_ms):
        """(start_ms, end_ms, in_session, session_key) for a bar timestamp."""
        dt = datetime.fromtimestamp(ts_ms / 1000, self.tz)
        d0 = dt.replace(hour=0, minute=0, second=0, microsecond=0)
        sS = d0.replace(hour=self.sh, minute=self.sm)
        sE = d0.replace(hour=self.eh, minute=self.em)
        if sE <= sS:
            if dt < sE:
                sS -= timedelta(days=1)
            else:
                sE += timedelta(days=1)
        in_s = sS <= dt < sE
        return (int(sS.timestamp() * 1000), int(sE.timestamp() * 1000), in_s,
                sS.strftime("%Y-%m-%d-%H%M"))


# ── field construction + prediction emission ─────────────────────────────────

def sma(seq, i, length):
    if i + 1 < length:
        return None
    return sum(seq[i - length + 1: i + 1]) / length


def build_predictions(bars, P, tf_sec):
    """Walk the series bar by bar, maintain the memory field exactly as the
    Pine does, and emit one prediction row per side per in-session bar."""
    t, o, h, l, c, v = bars
    n = len(c)
    clock = SessionClock(P)

    rng = [h[i] - l[i] for i in range(n)]

    # Wilder ATR(14) and ATR(200), matching ta.atr
    def wilder(series, length):
        out = [None] * n
        acc = None
        for i in range(n):
            if i < length:
                continue
            if acc is None:
                acc = sum(series[i - length + 1: i + 1]) / length
            else:
                acc = (acc * (length - 1) + series[i]) / length
            out[i] = acc
        return out

    tr = [rng[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
                     for i in range(1, n)]
    atr_s = wilder(tr, 14)
    atr_l = wilder(tr, 200)

    # daily aggregates for ADR / PDH / PDL, keyed by session
    day_key, day_hi, day_lo = [], {}, {}
    for i in range(n):
        _, _, _, key = clock.bounds(t[i] * 1000)
        day_key.append(key)
        day_hi[key] = max(day_hi.get(key, -1e18), h[i])
        day_lo[key] = min(day_lo.get(key, 1e18), l[i])
    day_order = []
    for k in day_key:
        if not day_order or day_order[-1] != k:
            day_order.append(k)
    day_idx = {k: j for j, k in enumerate(day_order)}

    def adr_at(key):
        j = day_idx[key]
        if j < P.adr_len:
            return None
        prev = day_order[j - P.adr_len: j]
        return sum(day_hi[k] - day_lo[k] for k in prev) / P.adr_len

    def pd_hl(key):
        j = day_idx[key]
        if j < 1:
            return None, None
        pk = day_order[j - 1]
        return day_hi[pk], day_lo[pk]

    nodes, res_h, res_l = [], [], []
    ep_p, ep_w = [], []
    node_id = 0
    p_vol = 0.5
    rows = []

    for i in range(n):
        ts_ms = t[i] * 1000
        key = day_key[i]
        sS, sE, in_sess, _ = clock.bounds(ts_ms)

        # ── regime HMM ──
        rb = sma(rng, i, P.hmm_len)
        if rb and rb > 0 and rng[i] > 0:
            xr = math.log(max(rng[i], 1e-9) / max(rb, 1e-9))
            pri_c = (1 - p_vol) * P.p_stay + p_vol * (1 - P.p_stay)
            pri_v = p_vol * P.p_stay + (1 - p_vol) * (1 - P.p_stay)
            a_c = pri_c * f_gauss(xr, P.mu_c, P.sd_c)
            a_v = pri_v * f_gauss(xr, P.mu_v, P.sd_v)
            if a_c + a_v > 0:
                p_vol = a_v / (a_c + a_v)
        is_vol = i > P.hmm_len and p_vol > 0.5

        # ── contract-roll wipe ──
        if i > 0 and c[i - 1] > 0 and abs(o[i] - c[i - 1]) / c[i - 1] * 100 > P.roll_pct:
            nodes.clear(); res_h.clear(); res_l.clear(); ep_p.clear(); ep_w.clear()

        # ── stop reservoirs: prune broken, then add confirmed pivots ──
        res_h[:] = [r for r in res_h if h[i] <= r]
        res_l[:] = [r for r in res_l if l[i] >= r]
        pv = P.piv_len
        if i >= 2 * pv:
            k = i - pv
            if all(h[k] > h[j] for j in range(k - pv, k)) and \
               all(h[k] > h[j] for j in range(k + 1, k + pv + 1)):
                res_h.append(h[k])
            if all(l[k] < l[j] for j in range(k - pv, k)) and \
               all(l[k] < l[j] for j in range(k + 1, k + pv + 1)):
                res_l.append(l[k])
        if i > 0 and day_key[i] != day_key[i - 1]:
            pdh, pdl = pd_hl(key)
            if pdh is not None and pdh > h[i]:
                res_h.append(pdh)
            if pdl is not None and pdl < l[i]:
                res_l.append(pdl)
        del res_h[:-80], res_l[:-80]

        # ── node birth at epoch boundary, from the COMPLETED epoch ──
        new_epoch = i > 0 and day_key[i] != day_key[i - 1]
        if new_epoch and len(ep_p) > 20:
            node_id = _birth(nodes, ep_p, ep_w, c[i], is_vol, P, node_id, ts_ms)
        if new_epoch:
            ep_p.clear(); ep_w.clear()

        # ── absorbed-volume accumulation for the running epoch ──
        body = abs(c[i] - o[i])
        uw = h[i] - max(o[i], c[i])
        lw = min(o[i], c[i]) - l[i]
        absorb = v[i] * (1.0 - body / rng[i]) if rng[i] > 0 else 0.0
        if absorb > 0 and uw + lw > 0:
            if uw > 0:
                ep_p.append(max(o[i], c[i]) + uw / 2.0); ep_w.append(absorb * uw / (uw + lw))
            if lw > 0:
                ep_p.append(min(o[i], c[i]) - lw / 2.0); ep_w.append(absorb * lw / (uw + lw))

        # ── lifecycle ──
        nodes[:] = [nd for nd in nodes if not (
            (nd.side == 1 and c[i] > nd.p + nd.w) or (nd.side == -1 and c[i] < nd.p - nd.w)
            or (ts_ms - nd.t) > P.max_age_d * DAY_MS
            or abs(nd.p - c[i]) / c[i] * 100 > P.band_pct)]

        # ── scan + emit ──
        if not in_sess or atr_l[i] is None or atr_s[i] is None:
            continue
        adr = adr_at(key)
        if adr is None or adr <= 0:
            continue
        vol_scale = max(0.6, min(1.8, atr_s[i] / atr_l[i])) if atr_l[i] > 0 else 1.0
        # Horizon runs from this bar's CLOSE: the scan prices off close[i],
        # and the outcome can only be realised from bar i+1 on. Pricing from
        # the bar's OPEN stamp overstates tau by one bar, worst at the bell.
        # The Pine equivalent is time_close, not time.
        tau = max(0.0, sE - (ts_ms + tf_sec * 1000)) / (sE - sS)
        sig_rem = (adr / 1.596) * math.sqrt(max(tau, 0.02)) * vol_scale
        sig_bar = (atr_l[i] / 1.596) * vol_scale

        for sd in (1, -1):
            res = res_h if sd == 1 else res_l
            best, best_p, _, _, per = f_side(nodes, sd, c[i], sig_rem, res, P, ts_ms)
            if best is None:
                continue
            d, edge, reach, hold = next(
                (r[1], r[2], r[3], r[4]) for r in per if r[0] is best)
            rows.append(dict(i=i, session=key, node=best.id, side=sd, edge=edge,
                             p=best.p, w=best.w, dist=d, reach=reach, hold=hold,
                             prob=best_p, sig_bar=sig_bar, sess_end=sE))
    return rows


def _birth(nodes, ep_p, ep_w, px, is_vol, P, node_id, ts_ms):
    lo, hi = min(ep_p), max(ep_p)
    bs = (hi - lo) / P.n_bins
    if bs <= 0:
        return node_id
    prof = [0.0] * P.n_bins
    tot = 0.0
    for p_, w_ in zip(ep_p, ep_w):
        b = max(0, min(P.n_bins - 1, int((p_ - lo) / bs)))
        prof[b] += w_
        tot += w_
    if tot <= 0:
        return node_id
    smo = [0.25 * prof[max(b - 1, 0)] + 0.5 * prof[b] + 0.25 * prof[min(b + 1, P.n_bins - 1)]
           for b in range(P.n_bins)]
    mean_sm = sum(smo) / len(smo)
    pk = []
    for b in range(1, P.n_bins - 1):
        if smo[b] >= smo[b - 1] and smo[b] > smo[b + 1] and smo[b] > mean_sm * P.peak_mult:
            w0, w1, w2 = prof[b - 1], prof[b], prof[b + 1]
            ws = w0 + w1 + w2
            if ws > 0:
                c0, c1, c2 = lo + (b - .5) * bs, lo + (b + .5) * bs, lo + (b + 1.5) * bs
                pk.append(((w0 * c0 + w1 * c1 + w2 * c2) / ws, ws / tot * P.n_bins / 3.0))
    pk.sort(key=lambda x: -x[1])
    hgt = px * (P.w_vol_pct if is_vol else P.w_calm_pct) / 100.0
    for np_, nm in pk[:P.top_k]:
        if abs(np_ - px) / px * 100 > P.band_pct:
            continue
        merged = False
        for e in nodes:
            if abs(e.p - np_) <= e.w:
                # decay to now, then add, then re-base the clock
                dec = 0.5 ** (((ts_ms - e.t) / DAY_MS) / P.half_life_d)
                e.m = min(e.m * dec + 0.5 * nm, 12.0)
                e.t = ts_ms
                merged = True
                break
        if merged or abs(np_ - px) <= hgt / 2.0:
            continue
        if len(nodes) >= P.max_nodes:
            nodes.remove(min(nodes, key=lambda z: f_mass(z, ts_ms, P.half_life_d)))
        node_id += 1
        nodes.append(Node(p=np_, m=nm, w=hgt / 2.0, t=ts_ms,
                          side=1 if np_ > px else -1, id=node_id))
    return node_id


# ── outcome resolution, strictly forward ─────────────────────────────────────

def resolve(rows, bars, P):
    t, o, h, l, c, v = bars
    n = len(c)
    for r in rows:
        i, sd, edge = r["i"], r["side"], r["edge"]
        kill = r["p"] + r["w"] if sd == 1 else r["p"] - r["w"]

        # reach: touched before this session ends
        touch = None
        for j in range(i + 1, n):
            if t[j] * 1000 >= r["sess_end"]:
                break
            if (h[j] >= edge) if sd == 1 else (l[j] <= edge):
                touch = j
                break
        r["reached"] = touch is not None
        if touch is None:
            r["held"] = r["reversed"] = None
            continue

        # hold and reversal are measured over the FULL horizon and derived
        # separately - an early break on either would make them near-identical
        closed_through = False
        max_back = 0.0
        extreme = h[touch] if sd == 1 else l[touch]
        for j in range(touch, min(touch + P.hold_horizon + 1, n)):
            extreme = max(extreme, h[j]) if sd == 1 else min(extreme, l[j])
            if (c[j] > kill) if sd == 1 else (c[j] < kill):
                closed_through = True
                break
            back = (extreme - l[j]) if sd == 1 else (h[j] - extreme)
            max_back = max(max_back, back)
        held = not closed_through
        # deliberately NOT conditioned on held: a pullback that later fails
        # still happened, and conflating the two made them identical
        rev = max_back >= P.rev_mult * r["sig_bar"]
        r["held"], r["reversed"] = held, rev
    return rows


# ── calibration statistics ───────────────────────────────────────────────────

BUCKETS = [0.0, 0.02, 0.05, 0.10, 0.20, 0.30, 0.45, 0.60, 0.80, 1.01]


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    ctr = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, ctr - half), min(1.0, ctr + half))


def reliability(pairs, label, out):
    """pairs: list of (predicted_prob, outcome_bool)."""
    pairs = [(p, bool(x)) for p, x in pairs if x is not None]
    n = len(pairs)
    out.append(f"\n  {label}   n = {n}")
    if n < 30:
        out.append("    too few samples to say anything")
        return None
    base = sum(x for _, x in pairs) / n
    bs = sum((p - x) ** 2 for p, x in pairs) / n
    unc = base * (1 - base)

    out.append(f"    {'bucket':>12} {'n':>6} {'pred':>7} {'actual':>8} {'95% CI':>15} {'gap':>8}")
    rel = res = ece = 0.0
    off = 0
    for a, b in zip(BUCKETS, BUCKETS[1:]):
        grp = [(p, x) for p, x in pairs if a <= p < b]
        if not grp:
            continue
        nk = len(grp)
        pk = sum(p for p, _ in grp) / nk
        ok = sum(x for _, x in grp) / nk
        lo, hi = wilson(sum(x for _, x in grp), nk)
        rel += nk * (pk - ok) ** 2
        res += nk * (ok - base) ** 2
        ece += nk * abs(pk - ok)
        off_k = not (lo <= pk <= hi)
        off += 1 if off_k else 0
        flag = "  <-- off" if off_k else ""
        out.append(f"    {a:>5.0%}-{b if b <= 1 else 1:<5.0%} {nk:>6} {pk:>7.1%} "
                   f"{ok:>8.1%} {lo:>6.1%}-{hi:<7.1%} {ok - pk:>+7.1%}{flag}")
    rel, res, ece = rel / n, res / n, ece / n
    skill = 1 - bs / unc if unc > 0 else 0.0
    out.append(f"    base rate {base:.1%}   Brier {bs:.4f} = reliability {rel:.4f} "
               f"- resolution {res:.4f} + uncertainty {unc:.4f}")
    out.append(f"    ECE {ece:.1%}   skill vs base rate {skill:>+.3f}"
               f"   {'(informative)' if skill > 0.01 else '(no better than guessing the base rate)'}")
    return dict(n=n, base=base, brier=bs, rel=rel, res=res, ece=ece,
                skill=skill, off=off)


def dedup(rows):
    """One row per (node, side, session) - the first bar it was the terminus.

    Consecutive bars re-emit the same wall with a near-identical probability;
    counting each would overstate the sample by roughly the bars-per-session.
    """
    seen, out = set(), []
    for r in rows:
        k = (r["session"], r["side"], r["node"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def report(rows, title, P):
    out = [f"\n{'=' * 78}", f" {title}", f"{'=' * 78}"]
    uniq = dedup(rows)
    out.append(f"  raw predictions {len(rows)}   independent (node,side,session) {len(uniq)}"
               f"   compression {len(rows) / max(len(uniq), 1):.1f}x")
    reach_stats = reliability([(r["reach"], r["reached"]) for r in uniq],
                              "REACH      P(touch wall edge before session end)", out)
    hold_stats = reliability([(r["hold"], r["held"]) for r in uniq if r["reached"]],
                             "HOLD       P(wall turns price | touched)", out)
    joint_stats = reliability([(r["prob"], r["reached"] and r["held"]) for r in uniq],
                              "PROB       P(touch and hold)  <- the dashboard number", out)
    reliability([(r["hold"], r["reversed"]) for r in uniq if r["reached"]],
                f"REVERSAL   P(retrace >= {P.rev_mult:g} sigma_bar | touched)", out)
    print("\n".join(out))
    return reach_stats, hold_stats, joint_stats


# ── data ─────────────────────────────────────────────────────────────────────

def load_t(path):
    t, o, h, l, c, v = [], [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            t.append(int(row["time"])); o.append(float(row["open"]))
            h.append(float(row["high"])); l.append(float(row["low"]))
            c.append(float(row["close"])); v.append(float(row["volume"]))
    return t, o, h, l, c, v


def synth(sessions, bars_per, tf_sec, seed, P, daily_sigma_pct=0.9):
    """Driftless GBM sampled into OHLCV bars on a real ET session calendar.

    Sub-stepped so the bar high/low approximate the continuous path's extremes,
    which is what the reflection principle actually describes.
    """
    rnd = random.Random(seed)
    tz = ZoneInfo(P.tz)
    sig_bar = (daily_sigma_pct / 100.0) / math.sqrt(bars_per)
    sub = 240
    sig_sub = sig_bar / math.sqrt(sub)

    t, o, h, l, c, v = [], [], [], [], [], []
    px = 20000.0
    day = datetime(2023, 1, 3, P.s_start[0], P.s_start[1], tzinfo=tz)
    made = 0
    while made < sessions:
        if day.weekday() < 5:
            step = (P.s_end[0] * 60 + P.s_end[1] - P.s_start[0] * 60 - P.s_start[1]) / bars_per
            for b in range(bars_per):
                ts = day + timedelta(minutes=step * b)
                op = px
                hi = lo = px
                for _ in range(sub):
                    px *= math.exp(sig_sub * rnd.gauss(0, 1) - 0.5 * sig_sub ** 2)
                    hi, lo = max(hi, px), min(lo, px)
                t.append(int(ts.timestamp())); o.append(op); h.append(hi)
                l.append(lo); c.append(px); v.append(rnd.lognormvariate(8, 0.5))
            made += 1
        day += timedelta(days=1)
    return t, o, h, l, c, v


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?", help="OHLCV csv: time,open,high,low,close,volume")
    ap.add_argument("--synthetic", action="store_true", help="run the GBM self-test")
    ap.add_argument("--sessions", type=int, default=600)
    ap.add_argument("--bars-per-session", type=int, default=13)
    ap.add_argument("--tf", type=int, default=1800, help="bar seconds (real data)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--hold-horizon", type=int, default=12)
    ap.add_argument("--rev-mult", type=float, default=2.0)
    a = ap.parse_args()

    P = Params(hold_horizon=a.hold_horizon, rev_mult=a.rev_mult)

    if a.synthetic:
        bars = synth(a.sessions, a.bars_per_session, a.tf, a.seed, P)
        tf = a.tf
        title = (f"SYNTHETIC GBM SELF-TEST  ({a.sessions} sessions x "
                 f"{a.bars_per_session} bars, seed {a.seed})")
    elif a.csv:
        bars = load_t(a.csv)
        tf = a.tf
        title = f"{a.csv}  ({len(bars[0])} bars)"
    else:
        ap.error("give a csv path or --synthetic")

    rows = resolve(build_predictions(bars, P, tf), bars, P)
    if not rows:
        print("no predictions emitted - not enough history to warm the field up")
        return 1
    rs, hs, js = report(rows, title, P)

    if a.synthetic:
        print(f"\n{'=' * 78}\n SELF-TEST VERDICT\n{'=' * 78}")
        ok = True
        if rs:
            good = rs["rel"] < 0.005 and rs["res"] > 0.02
            ok &= good
            print(f"  reach calibrated + informative   reliability {rs['rel']:.4f} "
                  f"resolution {rs['res']:.4f}  (ECE {rs['ece']:.1%}, "
                  f"{rs['off']} bucket(s) outside CI)  "
                  f"{'PASS' if good else 'FAIL - harness bug, not a market finding'}")
        if hs:
            # resolution, not skill, is the test for information content: skill
            # also punishes miscalibration, which is not what we are asking here
            flat = hs["res"] < 0.005
            ok &= flat
            print(f"  hold carries no information   resolution {hs['res']:.4f}  "
                  f"{'PASS' if flat else 'FAIL - information on memoryless data means a leak'}")
        if js:
            print(f"  joint: resolution {js['res']:.4f} (a little, inherited from reach) "
                  f"but reliability {js['rel']:.4f} and skill {js['skill']:+.3f}")
            print(f"    The joint is dominated by hold's miscalibration, not by reach.")
            print("    On memoryless data hold should sit at the base rate, but the")
            print("    default kM/kS print 50-70% regardless, so the product runs hot.")
            print("    Whether real tape holds more than GBM is what running this on")
            print("    real bars answers.")
        print(f"\n  {'harness validated' if ok else 'HARNESS NOT VALIDATED'}")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
