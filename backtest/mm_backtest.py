#!/usr/bin/env python3
"""Offline backtest of the MM MATRIX v2 engine (indicators/mm_matrix.pine).

Port of the Pine detection engine and its deliberately pessimistic
accounting:
  - no target credit on the signal bar itself
  - a bar that touches both stop and target books a LOSS
  - unresolved trades close at market after max_hold and book their real R
  - wins book their posted R, losses -1R, before costs

Costs are applied in R terms via `cost_r` (round-trip cost as a fraction of
the trade's risk), because a fixed tick cost is a different fraction of risk
on every trade and ignoring it flatters 1m results enormously.

Usage:
  python3 mm_backtest.py <data_dir> report '<json params>' [suffix]
  python3 mm_backtest.py <data_dir> wf [suffix]
"""
import csv
import itertools
import json
import os
import sys
from dataclasses import dataclass


def load(path):
    t, o, h, l, c = [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            t.append(int(float(row["time"])))
            o.append(float(row["open"]))
            h.append(float(row["high"]))
            l.append(float(row["low"]))
            c.append(float(row["close"]))
    return t, o, h, l, c


@dataclass
class Params:
    sw: int = 5
    body_bos: bool = True
    poi_depth: int = 25
    body_poi: bool = False
    disp_atr: float = 1.0
    req_fvg: bool = False
    req_ind: bool = True
    req_pd: bool = True
    use_brk: bool = True
    poi_life: int = 400
    sl_ticks: int = 4
    sl_atr: float = 0.0        # stop buffer as a fraction of ATR; overrides sl_ticks when > 0
    dedup: bool = True
    min_rr: float = 1.5
    cool_bars: int = 5
    use_htf: bool = False
    htf_mult: int = 60
    htf_fast: int = 20
    htf_slow: int = 50
    eq_tol: float = 0.15
    max_hold: int = 150
    tick: float = 0.01
    cost_r: float = 0.0
    sess_on: bool = False
    sess: tuple = (13, 20)
    block_on: bool = False
    block: tuple = (7, 16)


@dataclass
class Result:
    signals: int = 0
    wins: int = 0
    losses: int = 0
    timeouts: int = 0
    sum_r: float = 0.0
    gross_win: float = 0.0
    gross_loss: float = 0.0
    max_dd: float = 0.0
    by_code: dict = None

    @property
    def n(self):
        return self.wins + self.losses

    @property
    def wr(self):
        return 100.0 * self.wins / self.n if self.n else 0.0

    @property
    def exp_r(self):
        return self.sum_r / self.n if self.n else 0.0

    @property
    def pf(self):
        return self.gross_win / self.gross_loss if self.gross_loss > 0 else float("inf")


def atr_series(h, l, c, n=14):
    out = [None] * len(c)
    prev, acc, rma = None, [], None
    for i in range(len(c)):
        tr = h[i] - l[i] if prev is None else max(h[i] - l[i], abs(h[i] - prev), abs(l[i] - prev))
        prev = c[i]
        acc.append(tr)
        if i == n - 1:
            rma = sum(acc[:n]) / n
        elif i >= n:
            rma = (rma * (n - 1) + tr) / n
        out[i] = rma
    return out


def pivots(h, l, sw):
    n = len(h)
    ph, pl = [None] * n, [None] * n
    for i in range(2 * sw, n):
        m = i - sw
        if all(h[m] > h[j] for j in range(m - sw, m)) and all(h[m] >= h[j] for j in range(m + 1, i + 1)):
            ph[i] = h[m]
        if all(l[m] < l[j] for j in range(m - sw, m)) and all(l[m] <= l[j] for j in range(m + 1, i + 1)):
            pl[i] = l[m]
    return ph, pl


def htf_bias(c, mult, fast, slow):
    n = len(c)
    bull, bear = [True] * n, [True] * n
    ef = es = None
    kf, ks = 2.0 / (fast + 1), 2.0 / (slow + 1)
    cur = -1
    for i in range(n):
        b = i // mult
        if b > cur:
            if cur >= 0:
                cp = c[b * mult - 1]
                ef = cp if ef is None else (cp - ef) * kf + ef
                es = cp if es is None else (cp - es) * ks + es
            cur = b
        if ef is None or es is None or i < slow * mult:
            bull[i] = bear[i] = True
        else:
            bull[i], bear[i] = ef > es, ef < es
    return bull, bear


def in_win(hour, win):
    a, b = win
    return a <= hour < b if a <= b else (hour >= a or hour < b)


def run(bars, p):
    t, o, h, l, c = bars
    n = len(c)
    atr = atr_series(h, l, c)
    ph, pl = pivots(h, l, p.sw)
    hb, hbr = htf_bias(c, p.htf_mult, p.htf_fast, p.htf_slow) if p.use_htf else ([True] * n, [True] * n)
    hours = [((ts // 3600) % 24) for ts in t]

    zones, pools, open_tr = [], [], []
    res = Result(by_code={k: [0, 0, 0.0] for k in range(4)})
    equity = peak = 0.0
    last_ph = last_pl = prev_ph = prev_pl = None
    anchor_hi = anchor_lo = 0
    ph_live = pl_live = False
    trend = 0
    rng_hi = rng_lo = None
    last_sig = -10 ** 6

    for i in range(n):
        a = atr[i]
        if ph[i] is not None:
            prev_ph, anchor_hi = last_ph, i - p.sw
            if ph[i] > c[i]:
                last_ph, ph_live = ph[i], True
        if pl[i] is not None:
            prev_pl, anchor_lo = last_pl, i - p.sw
            if pl[i] < c[i]:
                last_pl, pl_live = pl[i], True

        bu = ph_live and last_ph is not None and (c[i] > last_ph if p.body_bos else h[i] > last_ph)
        bd = pl_live and last_pl is not None and (c[i] < last_pl if p.body_bos else l[i] < last_pl)
        if bu and bd:
            if c[i] >= (h[i] + l[i]) / 2:
                bd = False
            else:
                bu = False
        bos_up = bos_dn = False
        if bu:
            bos_up, ph_live, trend = True, False, 1
            rng_lo = l[i] if last_pl is None else last_pl
            rng_hi = h[i]
        if bd:
            bos_dn, pl_live, trend = True, False, -1
            rng_hi = h[i] if last_ph is None else last_ph
            rng_lo = l[i]
        if not bos_up and not bos_dn:
            if trend == 1 and rng_hi is not None:
                rng_hi = max(rng_hi, h[i])
            elif trend == -1 and rng_lo is not None:
                rng_lo = min(rng_lo, l[i])

        eq = (rng_hi + rng_lo) / 2 if (rng_hi is not None and rng_lo is not None) else None
        premium = eq is not None and c[i] > eq
        discount = eq is not None and c[i] < eq

        if (bos_up or bos_dn) and i > p.sw + 2 and a:
            anchor = anchor_hi if bos_dn else anchor_lo
            w = max(1, min(p.poi_depth, min(i - anchor, i - 1)))
            bk = bex = None
            for k in range(1, w + 1):
                j = i - k
                if bos_dn and c[j] > o[j] and (bex is None or h[j] > bex):
                    bex, bk = h[j], k
                if bos_up and c[j] < o[j] and (bex is None or l[j] < bex):
                    bex, bk = l[j], k
            if bk is not None:
                moved = (bex - c[i]) if bos_dn else (c[i] - bex)
                disp_ok = p.disp_atr <= 0 or moved >= p.disp_atr * a
                fvg = False
                if bk >= 2:
                    for jj in range(1, bk):
                        x1, x2 = i - (jj + 1), i - (jj - 1)
                        if bos_dn and l[x1] > h[x2]:
                            fvg = True
                            break
                        if bos_up and h[x1] < l[x2]:
                            fvg = True
                            break
                m = i - bk
                top = max(o[m], c[m]) if p.body_poi else h[m]
                bot = min(o[m], c[m]) if p.body_poi else l[m]
                d = -1 if bos_dn else 1
                buf = p.sl_atr * a if p.sl_atr > 0 else p.sl_ticks * p.tick
                slp = h[m] + buf if bos_dn else l[m] - buf
                dup = p.dedup and any((not z["dead"]) and z["dir"] == d and top >= z["bot"] and bot <= z["top"]
                                      for z in zones)
                if disp_ok and (fvg or not p.req_fvg) and top > bot and not dup:
                    zones.append(dict(top=top, bot=bot, sl=slp, ind=None, dir=d, kind="POI",
                                      birth=i, ind_taken=False, fired=False, dead=False))
                    if len(zones) > 70:
                        zones.pop(0)

        if a:
            if ph[i] is not None and prev_ph is not None and abs(ph[i] - prev_ph) <= p.eq_tol * a:
                pools.append(dict(px=ph[i], dir=1, swept=False))
            if pl[i] is not None and prev_pl is not None and abs(pl[i] - prev_pl) <= p.eq_tol * a:
                pools.append(dict(px=pl[i], dir=-1, swept=False))
            if len(pools) > 40:
                pools.pop(0)
        for q in pools:
            if not q["swept"] and ((q["dir"] == 1 and h[i] > q["px"]) or (q["dir"] == -1 and l[i] < q["px"])):
                q["swept"] = True

        lag_hi = max(h[max(0, i - p.sw):i + 1])
        lag_lo = min(l[max(0, i - p.sw):i + 1])
        best = None
        for zi in range(len(zones) - 1, -1, -1):
            z = zones[zi]
            if z["dead"]:
                continue
            if z["dir"] == -1:
                if z["ind"] is None and ph[i] is not None and ph[i] < z["bot"]:
                    z["ind"] = ph[i]
                    if lag_hi > ph[i]:
                        z["ind_taken"] = True
                if z["ind"] is not None and h[i] > z["ind"]:
                    z["ind_taken"] = True
            else:
                if z["ind"] is None and pl[i] is not None and pl[i] > z["top"]:
                    z["ind"] = pl[i]
                    if lag_lo < pl[i]:
                        z["ind_taken"] = True
                if z["ind"] is not None and l[i] < z["ind"]:
                    z["ind_taken"] = True

            if (z["dir"] == -1 and c[i] > z["top"]) or (z["dir"] == 1 and c[i] < z["bot"]):
                if p.use_brk and z["kind"] != "BRK":
                    z.update(kind="BRK", dir=-z["dir"], fired=False, ind_taken=False, ind=None, birth=i)
                    bufz = p.sl_atr * a if (p.sl_atr > 0 and a) else p.sl_ticks * p.tick
                    z["sl"] = (z["top"] + bufz) if z["dir"] == -1 else (z["bot"] - bufz)
                else:
                    z["dead"] = True
                continue
            if i - z["birth"] > p.poi_life:
                z["dead"] = True
                continue
            if z["fired"] or i <= z["birth"] + 1 or i - last_sig <= p.cool_bars:
                continue

            tapped = h[i] >= z["bot"] and l[i] <= z["top"]
            ind_ok = z["ind_taken"] or not p.req_ind
            pd_ok = (not p.req_pd) or (premium if z["dir"] == -1 else discount)
            dir_ok = (c[i] < o[i] and hbr[i]) if z["dir"] == -1 else (c[i] > o[i] and hb[i])
            sess_ok = (not p.sess_on or in_win(hours[i], p.sess)) and \
                      (not p.block_on or not in_win(hours[i], p.block))
            if not (tapped and ind_ok and pd_ok and dir_ok and sess_ok):
                continue
            risk = abs(c[i] - z["sl"])
            if not (risk > p.tick and (z["sl"] > c[i] if z["dir"] == -1 else z["sl"] < c[i])):
                continue
            cand = [q["px"] for q in pools if not q["swept"] and q["dir"] == z["dir"] and
                    ((q["px"] < c[i]) if z["dir"] == -1 else (q["px"] > c[i]))]
            tgt_p = (max(cand) if z["dir"] == -1 else min(cand)) if cand else None
            tgt_r = rng_lo if z["dir"] == -1 else rng_hi
            tgt = rr = None
            for ct in (tgt_p, tgt_r):
                if ct is None:
                    continue
                if not ((ct < c[i]) if z["dir"] == -1 else (ct > c[i])):
                    continue
                r = abs(ct - c[i]) / risk
                if r >= p.min_rr:
                    tgt, rr = ct, r
                    break
            if tgt is None:
                continue
            code = (2 if z["kind"] == "BRK" else 0) + (1 if z["ind_taken"] else 0)
            if best is None or rr > best[1]:
                best = (zi, rr, z["dir"], z["sl"], tgt, code)

        if best is not None:
            zi, rr, d, sl, tgt, code = best
            zones[zi]["fired"] = True
            last_sig = i
            res.signals += 1
            open_tr.append(dict(dir=d, entry=c[i], sl=sl, tp=tgt, code=code, birth=i))

        for ti in range(len(open_tr) - 1, -1, -1):
            tr = open_tr[ti]
            if i <= tr["birth"]:
                continue
            risk = abs(tr["entry"] - tr["sl"])
            if risk <= 0:
                open_tr.pop(ti)
                continue
            hit_sl = h[i] >= tr["sl"] if tr["dir"] == -1 else l[i] <= tr["sl"]
            hit_tp = l[i] <= tr["tp"] if tr["dir"] == -1 else h[i] >= tr["tp"]
            r, timeout = None, False
            if hit_sl:
                r = -1.0
            elif hit_tp:
                r = abs(tr["tp"] - tr["entry"]) / risk
            elif i - tr["birth"] >= p.max_hold:
                r, timeout = (tr["dir"] * (c[i] - tr["entry"])) / risk, True
            if r is None:
                continue
            r -= p.cost_r
            if timeout:
                res.timeouts += 1
            if r > 0:
                res.wins += 1
                res.gross_win += r
            else:
                res.losses += 1
                res.gross_loss += -r
            res.sum_r += r
            b = res.by_code[tr["code"]]
            b[0 if r > 0 else 1] += 1
            b[2] += r
            equity += r
            peak = max(peak, equity)
            res.max_dd = max(res.max_dd, peak - equity)
            open_tr.pop(ti)
    return res


def datasets(d, suffix):
    return [(f[:-4], load(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(suffix)]


def slice_bars(bars, a, b):
    n = len(bars[0])
    return tuple(s[int(n * a):int(n * b)] for s in bars)


def pooled(ds, p):
    agg = Result(by_code={k: [0, 0, 0.0] for k in range(4)})
    pfs = []
    for _, bars in ds:
        r = run(bars, p)
        agg.signals += r.signals
        agg.wins += r.wins
        agg.losses += r.losses
        agg.timeouts += r.timeouts
        agg.sum_r += r.sum_r
        agg.gross_win += r.gross_win
        agg.gross_loss += r.gross_loss
        agg.max_dd = max(agg.max_dd, r.max_dd)
        for k in range(4):
            for j in range(3):
                agg.by_code[k][j] += r.by_code[k][j]
        pfs.append(r.pf)
    return agg, pfs


def line(tag, r):
    return (f"{tag:<22} n={r.n:<5} wr={r.wr:5.1f}%  expR={r.exp_r:+6.3f}  "
            f"PF={r.pf:5.2f}  totR={r.sum_r:+8.1f}  maxDD={r.max_dd:6.1f}R  to={r.timeouts}")


if __name__ == "__main__":
    d, mode = sys.argv[1], sys.argv[2]
    if mode == "report":
        p = Params(**json.loads(sys.argv[3]))
        suffix = sys.argv[4] if len(sys.argv) > 4 else "_60.csv"
        ds = datasets(d, suffix)
        for name, bars in ds:
            print(line(name, run(bars, p)))
        agg, _ = pooled(ds, p)
        print(line("POOLED", agg))
        for k, nm in enumerate(["Type 1", "Type 3", "BRK", "BRK+IDM"]):
            w, ls, s = agg.by_code[k]
            tot = w + ls
            print(f"  {nm:<10} n={tot:<5} wr={(100.0*w/tot if tot else 0):5.1f}%  expR={(s/tot if tot else 0):+6.3f}")
