#!/usr/bin/env python3
"""Mass strategy sweep.

Two stages, for a reason. The full space is hundreds of millions of complete
strategies; scoring every one with exact per-trade accounting would take days.

* **Stage 1 (screen, exhaustive).** Every (trigger, exit, filter-set,
  direction) combination is scored from four popcounts over bitsets - target
  hits, stop hits, positive timeouts, negative timeouts - using each class's
  mean R as a representative value. Approximate, but monotone enough to rank,
  and it costs ~600 machine ops per strategy instead of millions.
* **Stage 2 (exact).** Survivors are re-scored with exact per-trade R including
  per-trade slippage/commission drag, which varies with the ATR at entry.

Stage 1's approximation is a *screen only*. Nothing is ever reported from it;
every number that reaches the writeup comes from stage 2 or from validation.
"""
import itertools
import sys
import time

import numpy as np
from numba import njit, prange

from qlib import (DEFAULT_COST_POINTS, pack_bits, simulate_fixed,
                  simulate_managed, trade_stats)

# Exit grid: stop in ATR units, target as a multiple of the stop, max hold.
STOP_MULTS = (0.5, 1.0, 1.5, 2.0)
RR_MULTS = (1.0, 1.5, 2.0, 3.0)
MAX_HOLDS = (24, 72)          # 2h and 6h on a 5m chart
EXITS = [(s, r, h) for s in STOP_MULTS for r in RR_MULTS for h in MAX_HOLDS]


def build_trades(f, mask, direction, stop_mult, rr, max_hold,
                 cost=None, exit_on_session_end=False):
    """Simulate one (trigger, exit) pair. Returns per-trade arrays.

    `cost` may be a scalar or a per-bar array of round-turn costs in index
    points; it defaults to the session-dependent schedule.
    """
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return None
    c = f["close"]
    a = f["atr14"]
    ep = c[idx]
    risk = stop_mult * a[idx]
    good = np.isfinite(risk) & (risk > 1e-9)
    idx, ep, risk = idx[good], ep[good], risk[good]
    if len(idx) == 0:
        return None
    d = np.full(len(idx), direction, dtype=np.int64)
    sp = ep - d * risk
    tp = ep + d * risk * rr
    outcome, exit_bar, exit_px = simulate_fixed(
        idx, d, ep, sp, tp, f["high"], f["low"], f["close"],
        max_hold, f["session"], exit_on_session_end)
    # Exact R: every trade risks 1R by construction, so the cost of the round
    # turn is expressed as a fraction of that trade's own risk distance.
    if cost is None:
        cost = f["cost_pts"]
    cost_pts = cost[idx] if np.ndim(cost) else np.full(len(idx), float(cost))
    cost_r = cost_pts / risk
    gross = d * (exit_px - ep) / risk
    r = gross - cost_r
    return dict(idx=idx, r=r, outcome=outcome, exit_bar=exit_bar,
                risk=risk, cost_r=cost_r)


def class_bitsets(tr):
    """Split trades into the four outcome classes and pack each as a bitset."""
    o, r = tr["outcome"], tr["r"]
    w = o == 1
    l = o == -1
    zp = (o == 0) & (r > 0)
    zn = (o == 0) & (r <= 0)
    means = np.array([
        r[w].mean() if w.any() else 0.0,
        r[l].mean() if l.any() else 0.0,
        r[zp].mean() if zp.any() else 0.0,
        r[zn].mean() if zn.any() else 0.0,
    ])
    return (pack_bits(w), pack_bits(l), pack_bits(zp), pack_bits(zn)), means


@njit(cache=True, parallel=True)
def sweep(filter_bits, combos, W, L, ZP, ZN, means, nwords, ntrades,
          min_trades, topk, out_score, out_cfg, out_stat):
    """Score every (exit, filter-combo) pair for every trigger.

    `combos` is an (ncombo, 3) int32 array of filter ids; -1 pads unused slots,
    so depth 0/1/2/3 all share one loop. Results land in per-trigger top-K
    slices of the output arrays.
    """
    ntrig = W.shape[0]
    nexit = W.shape[1]
    ncombo = combos.shape[0]
    for t in prange(ntrig):
        kmin = 0.0
        kpos = 0
        filled = 0
        base = t * topk
        for e in range(nexit):
            nw_all = ntrades[t, e]
            if nw_all < min_trades:
                continue
            nwd = nwords[t, e]
            wm = means[t, e, 0]
            lm = means[t, e, 1]
            zpm = means[t, e, 2]
            znm = means[t, e, 3]
            for ci in range(ncombo):
                f0 = combos[ci, 0]
                f1 = combos[ci, 1]
                f2 = combos[ci, 2]
                nw = 0
                nl = 0
                nzp = 0
                nzn = 0
                for wi in range(nwd):
                    m = np.uint64(0xFFFFFFFFFFFFFFFF)
                    if f0 >= 0:
                        m &= filter_bits[t, f0, wi]
                    if f1 >= 0:
                        m &= filter_bits[t, f1, wi]
                    if f2 >= 0:
                        m &= filter_bits[t, f2, wi]
                    if m == np.uint64(0):
                        continue
                    x = W[t, e, wi] & m
                    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
                    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
                    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
                    nw += int((x * np.uint64(0x0101010101010101)) >> np.uint64(56))
                    x = L[t, e, wi] & m
                    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
                    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
                    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
                    nl += int((x * np.uint64(0x0101010101010101)) >> np.uint64(56))
                    x = ZP[t, e, wi] & m
                    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
                    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
                    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
                    nzp += int((x * np.uint64(0x0101010101010101)) >> np.uint64(56))
                    x = ZN[t, e, wi] & m
                    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
                    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
                    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
                    nzn += int((x * np.uint64(0x0101010101010101)) >> np.uint64(56))
                n = nw + nl + nzp + nzn
                if n < min_trades:
                    continue
                gp = nw * wm + nzp * zpm
                gl = -(nl * lm + nzn * znm)
                if gl <= 1e-9:
                    continue
                pf = gp / gl
                net = gp - gl
                exp = net / n
                # Score: expectancy scaled by sqrt(n). Ranking on PF alone
                # crowns 12-trade flukes; this trades off edge against sample.
                score = exp * np.sqrt(np.float64(n))
                if filled < topk:
                    p = base + filled
                    out_score[p] = score
                    out_cfg[p, 0] = t
                    out_cfg[p, 1] = e
                    out_cfg[p, 2] = f0
                    out_cfg[p, 3] = f1
                    out_cfg[p, 4] = f2
                    out_stat[p, 0] = n
                    out_stat[p, 1] = pf
                    out_stat[p, 2] = 100.0 * nw / n
                    out_stat[p, 3] = net
                    filled += 1
                    if filled == topk:
                        kmin = out_score[base]
                        kpos = 0
                        for q in range(1, topk):
                            if out_score[base + q] < kmin:
                                kmin = out_score[base + q]
                                kpos = q
                elif score > kmin:
                    p = base + kpos
                    out_score[p] = score
                    out_cfg[p, 0] = t
                    out_cfg[p, 1] = e
                    out_cfg[p, 2] = f0
                    out_cfg[p, 3] = f1
                    out_cfg[p, 4] = f2
                    out_stat[p, 0] = n
                    out_stat[p, 1] = pf
                    out_stat[p, 2] = 100.0 * nw / n
                    out_stat[p, 3] = net
                    kmin = out_score[base]
                    kpos = 0
                    for q in range(1, topk):
                        if out_score[base + q] < kmin:
                            kmin = out_score[base + q]
                            kpos = q


def make_combos(nfilt, max_depth=3):
    """All filter id tuples up to `max_depth`, padded to width 3 with -1."""
    rows = [(-1, -1, -1)]
    if max_depth >= 1:
        rows += [(i, -1, -1) for i in range(nfilt)]
    if max_depth >= 2:
        rows += [(i, j, -1) for i, j in itertools.combinations(range(nfilt), 2)]
    if max_depth >= 3:
        rows += list(itertools.combinations(range(nfilt), 3))
    return np.array(rows, dtype=np.int32)


def prepare(f, triggers, filters, exits=EXITS, min_trades=40,
            cost=None, verbose=True):
    """Passes A and B: simulate every (trigger, exit) and pack all bitsets.

    Separated from the sweep so one simulation pass can serve several mining
    depths - the null needs the same random triggers scored at depth 0..3, and
    re-simulating for each would dominate the runtime.
    """
    ntrig, nexit, nfilt = len(triggers), len(exits), len(filters)
    t0 = time.time()
    cache = {}
    max_words = 0
    max_tr = 0
    for ti, (_n, d, m) in enumerate(triggers):
        for ei, (s, rr, mh) in enumerate(exits):
            tr = build_trades(f, m, d, s, rr, mh, cost=cost)
            if tr is None or len(tr["r"]) < min_trades:
                continue
            cache[(ti, ei)] = tr
            max_words = max(max_words, (len(tr["r"]) + 63) // 64)
            max_tr = max(max_tr, len(tr["r"]))
    if verbose:
        print(f"pass A: {len(cache):,} trigger-exit sims, max {max_tr:,} trades, "
              f"{time.time() - t0:.1f}s", flush=True)

    # Pass B - pack bitsets into dense arrays for the kernel.
    W = np.zeros((ntrig, nexit, max_words), dtype=np.uint64)
    L = np.zeros_like(W)
    ZP = np.zeros_like(W)
    ZN = np.zeros_like(W)
    FB = np.zeros((ntrig, nfilt, max_words), dtype=np.uint64)
    means = np.zeros((ntrig, nexit, 4))
    nwords = np.zeros((ntrig, nexit), dtype=np.int64)
    ntrades = np.zeros((ntrig, nexit), dtype=np.int64)

    filt_arrays = [fa for _n, fa in filters]
    for (ti, ei), tr in cache.items():
        bits, mu = class_bitsets(tr)
        nwd = (len(tr["r"]) + 63) // 64
        for arr, b in zip((W, L, ZP, ZN), bits):
            arr[ti, ei, :nwd] = b
        means[ti, ei] = mu
        nwords[ti, ei] = nwd
        ntrades[ti, ei] = len(tr["r"])
    # Filter bitsets are indexed by *trade*, so they depend only on the trigger
    # (all exits share a trigger's entry bars).
    for ti in range(ntrig):
        key = next((k for k in cache if k[0] == ti), None)
        if key is None:
            continue
        idx = cache[key]["idx"]
        for fi, fa in enumerate(filt_arrays):
            FB[ti, fi, :(len(idx) + 63) // 64] = pack_bits(fa[idx])
    return dict(FB=FB, W=W, L=L, ZP=ZP, ZN=ZN, means=means, nwords=nwords,
                ntrades=ntrades, cache=cache, ntrig=ntrig, nexit=nexit,
                nfilt=nfilt)


def run_sweep(f, triggers, filters, exits=EXITS, min_trades=40, topk=400,
              max_depth=3, cost=None, verbose=True, packed=None,
              return_packed=False):
    """Stage 1. Returns (candidates, cache, combos, total)."""
    if packed is None:
        packed = prepare(f, triggers, filters, exits, min_trades, cost, verbose)
    ntrig, nexit, nfilt = packed["ntrig"], packed["nexit"], packed["nfilt"]
    combos = make_combos(nfilt, max_depth)
    total = ntrig * nexit * len(combos)
    if verbose:
        print(f"space: {ntrig} triggers x {nexit} exits x {len(combos):,} "
              f"filter sets = {total:,} strategies", flush=True)

    out_score = np.full(ntrig * topk, -1e18)
    out_cfg = np.full((ntrig * topk, 5), -1, dtype=np.int32)
    out_stat = np.zeros((ntrig * topk, 4))
    t0 = time.time()
    sweep(packed["FB"], combos, packed["W"], packed["L"], packed["ZP"],
          packed["ZN"], packed["means"], packed["nwords"], packed["ntrades"],
          min_trades, topk, out_score, out_cfg, out_stat)
    el = time.time() - t0
    if verbose:
        print(f"pass C: {total:,} strategies scored in {el:.1f}s "
              f"({total / max(el, 1e-9) / 1e6:.1f}M/s)", flush=True)

    keep = out_score > -1e17
    cands = []
    for p in np.flatnonzero(keep):
        t, e, f0, f1, f2 = out_cfg[p]
        cands.append(dict(
            trigger=int(t), exit=int(e),
            filters=[int(x) for x in (f0, f1, f2) if x >= 0],
            score=float(out_score[p]), n=int(out_stat[p, 0]),
            pf_approx=float(out_stat[p, 1]), wr_approx=float(out_stat[p, 2]),
            net_approx=float(out_stat[p, 3])))
    cands.sort(key=lambda d: -d["score"])
    if return_packed:
        return cands, packed["cache"], combos, total, packed
    return cands, packed["cache"], combos, total


def exact_eval(f, triggers, filters, cand, exits=EXITS,
               cost=DEFAULT_COST_POINTS, subset=None):
    """Stage 2. Exact per-trade R for one candidate, optionally on a bar subset."""
    name, d, m = triggers[cand["trigger"]]
    s, rr, mh = exits[cand["exit"]]
    mask = m.copy()
    for fi in cand["filters"]:
        mask &= filters[fi][1]
    if subset is not None:
        mask &= subset
    tr = build_trades(f, mask, d, s, rr, mh, cost=cost)
    if tr is None or len(tr["r"]) == 0:
        return None, None
    return trade_stats(tr["r"]), tr


def build_trades_managed(f, mask, direction, stop_mult, rr, max_hold,
                         be_trigger_r=0.0, trail_atr=0.0, cost=None,
                         flat_by_min=None):
    """Stage-2 simulation with breakeven / trailing / forced session-flat.

    `flat_by_min` (ET minutes) forces an exit at the last bar before that time
    each day - the usual "no overnight risk" rule for an intraday system.
    """
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return None
    c, a = f["close"], f["atr14"]
    ep = c[idx]
    risk = stop_mult * a[idx]
    good = np.isfinite(risk) & (risk > 1e-9)
    idx, ep, risk = idx[good], ep[good], risk[good]
    if len(idx) == 0:
        return None
    d = np.full(len(idx), direction, dtype=np.int64)
    sp = ep - d * risk
    tp = ep + d * risk * rr
    if flat_by_min is None:
        sess = f["session"]
        force = False
    else:
        # Re-label sessions so each "session" ends at flat_by_min; the kernel's
        # session-change exit then books the trade there.
        sess = _intraday_session_id(f["session"], f["et_min"], flat_by_min)
        force = True
    outcome, exit_bar, exit_px = simulate_managed(
        idx, d, ep, sp, tp, f["high"], f["low"], f["close"], max_hold,
        sess, force, be_trigger_r, trail_atr, a[idx])
    if cost is None:
        cost = f["cost_pts"]
    cost_pts = cost[idx] if np.ndim(cost) else np.full(len(idx), float(cost))
    cost_r = cost_pts / risk
    gross = d * (exit_px - ep) / risk
    return dict(idx=idx, r=gross - cost_r, outcome=outcome,
                exit_bar=exit_bar, risk=risk, cost_r=cost_r)


def _intraday_session_id(session, et_min, flat_by_min):
    """Session id that increments at `flat_by_min` instead of ET midnight."""
    return session * 2 + (et_min >= flat_by_min).astype(np.int64)


def describe(triggers, filters, exits, cand):
    name, d, _ = triggers[cand["trigger"]]
    s, rr, mh = exits[cand["exit"]]
    fs = "+".join(filters[i][0] for i in cand["filters"]) or "(none)"
    return (f"{name} dir={'L' if d > 0 else 'S'} stop={s}atr rr={rr} "
            f"hold={mh} | {fs}")
