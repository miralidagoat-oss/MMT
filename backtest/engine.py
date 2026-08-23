#!/usr/bin/env python3
"""Unified multi-timeframe / multi-family / multi-RR research engine.

Design: signal GENERATION is separated from trade EXECUTION.

  * A family function scans bars once and emits
        (bar_index, direction, entry_price, stop_price)
    using only information available at the close of `bar_index`.
  * The executor takes those signals and applies an RR target, a pessimistic
    fill model and a per-instrument cost. Because signals are sparse, the
    executor forward-scans from each signal with a bounded horizon instead of
    looping the whole series, which makes sweeping RR cheap.

Every family is strictly causal. Where a family needs a session-level value
(VWAP, prior-day high) it uses only completed data: the prior day's range is
fixed before the session opens, and session VWAP at bar i accumulates bars
<= i only.

FILL MODEL (identical to the shipped system, deliberately pessimistic):
  - a limit fills only on a bar AFTER the signal bar
  - a fill bar that also trades the stop books the loss immediately
  - the target is never credited on the fill bar
  - if stop and target both print in one bar, the STOP wins
  - unfilled setups expire after `validity` bars
"""
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, is_rth, mean, stdev, pct, et_parts   # noqa: E402

BP = 1e4

# ── instrument economics (CME primary source, both verified) ────────────────
INSTRUMENTS = {
    "MNQ": dict(point_value=2.0, tick=0.25, cost_pts=1.50),
    "MES": dict(point_value=5.0, tick=0.25, cost_pts=0.80),
}


# ── per-bar feature precomputation ──────────────────────────────────────────
class Feat:
    """Causal per-bar features. Nothing here reads a future bar."""

    def __init__(self, b, bars_per_session):
        n = b.n
        self.b = b
        self.n = n
        self.spb = bars_per_session
        c, h, l, o, v = b.c, b.h, b.l, b.o, b.v

        # EWMA sigma in price units (RiskMetrics)
        logret = [0.0] * n
        for i in range(1, n):
            logret[i] = math.log(c[i] / c[i - 1]) if c[i - 1] > 0 else 0.0
        self.logret = logret
        ewma = [None] * n
        seed = 20
        var = None
        for i in range(n):
            if var is None:
                if i >= seed - 1:
                    w = logret[i - seed + 1:i + 1]
                    m = sum(w) / seed
                    var = sum((x - m) ** 2 for x in w) / seed
                    ewma[i] = var
            else:
                var = 0.94 * var + 0.06 * logret[i] * logret[i]
                ewma[i] = var
        self.sigma = [None if ewma[i] is None else math.sqrt(max(ewma[i], 0.0)) * c[i]
                      for i in range(n)]

        # rolling means
        self.rng = [h[i] - l[i] for i in range(n)]
        self.rng_sma = self._sma(self.rng, 20)
        self.vol_sma = self._sma(v, 20)

        # ATR(14) via true range
        tr = [self.rng[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]),
                                  abs(l[i] - c[i - 1])) for i in range(1, n)]
        self.atr = self._sma(tr, 14)

        # realised vol regime (the one validated filter)
        absret = [abs(x) * BP for x in logret]
        self.rv = self._sma(absret, bars_per_session)
        self.rv_base = self._sma_of(self.rv, min(1000, max(200, bars_per_session * 12)))

        # session structures
        self.sess_id = [None] * n
        self.vwap = [None] * n
        self.vwap_sd = [None] * n
        self.day_open = [None] * n
        self.bar_in_sess = [0] * n
        self.pdh = [None] * n
        self.pdl = [None] * n
        self.ib_hi = [None] * n
        self.ib_lo = [None] * n

        cur = None
        pv = pvol = pv2 = 0.0
        sess_hi = sess_lo = None
        prev_hi = prev_lo = None
        ib_bars = max(1, (30 * 60) // self._tf_seconds())
        k = 0
        for i in range(n):
            if not is_rth(b.t[i]):
                self.sess_id[i] = None
                continue
            d = b.et[i][0]
            if d != cur:
                if cur is not None:
                    prev_hi, prev_lo = sess_hi, sess_lo
                cur = d
                pv = pvol = pv2 = 0.0
                sess_hi, sess_lo = h[i], l[i]
                k = 0
            self.sess_id[i] = cur
            self.bar_in_sess[i] = k
            typ = (h[i] + l[i] + c[i]) / 3.0
            w = v[i] if v[i] > 0 else 1.0
            pv += typ * w
            pvol += w
            pv2 += typ * typ * w
            vw = pv / pvol
            self.vwap[i] = vw
            var = max(pv2 / pvol - vw * vw, 0.0)
            self.vwap_sd[i] = math.sqrt(var)
            sess_hi = max(sess_hi, h[i])
            sess_lo = min(sess_lo, l[i])
            if k == 0:
                self.day_open[i] = o[i]
            else:
                self.day_open[i] = self.day_open[i - 1] if self.day_open[i - 1] else o[i]
            self.pdh[i] = prev_hi
            self.pdl[i] = prev_lo
            # initial balance = first 30 minutes, frozen once complete
            if k < ib_bars:
                self.ib_hi[i] = None
                self.ib_lo[i] = None
            else:
                if k == ib_bars:
                    self._ibh = max(h[j] for j in range(i - ib_bars, i))
                    self._ibl = min(l[j] for j in range(i - ib_bars, i))
                self.ib_hi[i] = self._ibh
                self.ib_lo[i] = self._ibl
            k += 1

    def _tf_seconds(self):
        d = [self.b.t[i + 1] - self.b.t[i] for i in range(min(500, self.n - 1))]
        d = [x for x in d if x > 0]
        return min(d) if d else 300

    @staticmethod
    def _sma(series, length):
        n = len(series)
        out = [None] * n
        s = 0.0
        for i in range(n):
            s += series[i]
            if i >= length:
                s -= series[i - length]
            if i >= length - 1:
                out[i] = s / length
        return out

    @staticmethod
    def _sma_of(series, length):
        n = len(series)
        out = [None] * n
        buf, s = [], 0.0
        for i in range(n):
            if series[i] is None:
                out[i] = None
                continue
            buf.append(series[i])
            s += series[i]
            if len(buf) > length:
                s -= buf.pop(0)
            if len(buf) >= min(length, 50):
                out[i] = s / len(buf)
        return out


# ── signal families ─────────────────────────────────────────────────────────
# Each returns list of (i, direction, entry, stop). All causal.

def fam_sweep(F, p):
    """Liquidity sweep of a recent extreme, rejected inside the same bar."""
    b, out = F.b, []
    look = p.get("look", 12)
    last = {1: -10**9, -1: -10**9}
    cd = p.get("cooldown", 10)
    for i in range(max(look, 25), F.n):
        if F.sigma[i] is None or F.rng_sma[i] is None or not is_rth(b.t[i]):
            continue
        rng = F.rng[i]
        if rng <= 0 or rng < F.rng_sma[i] * p.get("range_exp", 1.0):
            continue
        if abs(b.c[i] - b.o[i]) > rng * p.get("body", 0.33):
            continue
        hh = max(b.h[i - look:i])
        ll = min(b.l[i - look:i])
        sg = F.sigma[i]
        bw = (min(b.c[i], b.o[i]) - b.l[i]) / rng
        tw = (b.h[i] - max(b.c[i], b.o[i])) / rng
        if (b.l[i] < ll and b.c[i] > ll and bw >= p.get("wick", 0.35)
                and (b.c[i] - b.l[i]) / rng >= p.get("cpos", 0.7)
                and (ll - b.l[i]) >= p.get("sweep", 0.75) * sg
                and i - last[1] >= cd):
            e = b.l[i] + (min(b.o[i], b.c[i]) - b.l[i]) / 2.0
            out.append((i, 1, e, b.l[i] - sg * p.get("stop", 1.5)))
            last[1] = i
        if (b.h[i] > hh and b.c[i] < hh and tw >= p.get("wick", 0.35)
                and (b.h[i] - b.c[i]) / rng >= p.get("cpos", 0.7)
                and (b.h[i] - hh) >= p.get("sweep", 0.75) * sg
                and i - last[-1] >= cd):
            e = b.h[i] - (b.h[i] - max(b.o[i], b.c[i])) / 2.0
            out.append((i, -1, e, b.h[i] + sg * p.get("stop", 1.5)))
            last[-1] = i
    return out


def fam_vwap_rev(F, p):
    """Fade an extension away from session VWAP back toward it.

    VWAP is the benchmark institutions are actually measured against, so
    extensions from it are where real reversion pressure plausibly lives.
    """
    b, out = F.b, []
    k = p.get("k", 2.0)
    cd = p.get("cooldown", 10)
    last = {1: -10**9, -1: -10**9}
    for i in range(25, F.n):
        if (F.vwap[i] is None or F.vwap_sd[i] is None or F.sigma[i] is None
                or F.bar_in_sess[i] < p.get("min_bar", 12)):
            continue
        sd = F.vwap_sd[i]
        if sd <= 0:
            continue
        dev = (b.c[i] - F.vwap[i]) / sd
        sg = F.sigma[i]
        # require the bar to have turned back toward VWAP (rejection), not
        # merely to be extended — extension alone is a trend, not a signal
        if dev <= -k and b.c[i] > b.o[i] and i - last[1] >= cd:
            out.append((i, 1, b.c[i], b.l[i] - sg * p.get("stop", 1.0)))
            last[1] = i
        elif dev >= k and b.c[i] < b.o[i] and i - last[-1] >= cd:
            out.append((i, -1, b.c[i], b.h[i] + sg * p.get("stop", 1.0)))
            last[-1] = i
    return out


def fam_pd_levels(F, p):
    """Sweep of the prior session's high/low, rejected."""
    b, out = F.b, []
    cd = p.get("cooldown", 10)
    last = {1: -10**9, -1: -10**9}
    for i in range(25, F.n):
        if F.pdh[i] is None or F.sigma[i] is None or F.rng[i] <= 0:
            continue
        sg = F.sigma[i]
        rng = F.rng[i]
        tol = p.get("tol", 0.25) * sg
        if (b.l[i] <= F.pdl[i] + tol and b.c[i] > F.pdl[i]
                and (b.c[i] - b.l[i]) / rng >= p.get("cpos", 0.6)
                and i - last[1] >= cd):
            out.append((i, 1, b.c[i], b.l[i] - sg * p.get("stop", 1.0)))
            last[1] = i
        if (b.h[i] >= F.pdh[i] - tol and b.c[i] < F.pdh[i]
                and (b.h[i] - b.c[i]) / rng >= p.get("cpos", 0.6)
                and i - last[-1] >= cd):
            out.append((i, -1, b.c[i], b.h[i] + sg * p.get("stop", 1.0)))
            last[-1] = i
    return out


def fam_ib_break(F, p):
    """Initial-balance (first 30m) break, taken in the break direction."""
    b, out = F.b, []
    done = set()
    for i in range(25, F.n):
        if F.ib_hi[i] is None or F.sigma[i] is None:
            continue
        sid = F.sess_id[i]
        sg = F.sigma[i]
        if (sid, 1) not in done and b.c[i] > F.ib_hi[i]:
            out.append((i, 1, b.c[i], b.c[i] - sg * p.get("stop", 1.5)))
            done.add((sid, 1))
        if (sid, -1) not in done and b.c[i] < F.ib_lo[i]:
            out.append((i, -1, b.c[i], b.c[i] + sg * p.get("stop", 1.5)))
            done.add((sid, -1))
    return out


def fam_ib_fade(F, p):
    """Initial-balance extreme FADE — the opposite bet to fam_ib_break."""
    b, out = F.b, []
    done = set()
    for i in range(25, F.n):
        if F.ib_hi[i] is None or F.sigma[i] is None or F.rng[i] <= 0:
            continue
        sid, sg, rng = F.sess_id[i], F.sigma[i], F.rng[i]
        if ((sid, -1) not in done and b.h[i] > F.ib_hi[i] and b.c[i] < F.ib_hi[i]
                and (b.h[i] - b.c[i]) / rng >= 0.5):
            out.append((i, -1, b.c[i], b.h[i] + sg * p.get("stop", 1.0)))
            done.add((sid, -1))
        if ((sid, 1) not in done and b.l[i] < F.ib_lo[i] and b.c[i] > F.ib_lo[i]
                and (b.c[i] - b.l[i]) / rng >= 0.5):
            out.append((i, 1, b.c[i], b.l[i] - sg * p.get("stop", 1.0)))
            done.add((sid, 1))
    return out


def fam_momentum(F, p):
    """Range breakout in the direction of the move — trend continuation."""
    b, out = F.b, []
    look = p.get("look", 20)
    cd = p.get("cooldown", 10)
    last = {1: -10**9, -1: -10**9}
    for i in range(max(look, 25), F.n):
        if F.sigma[i] is None or F.atr[i] is None or not is_rth(b.t[i]):
            continue
        hh = max(b.h[i - look:i])
        ll = min(b.l[i - look:i])
        sg = F.sigma[i]
        if b.c[i] > hh and i - last[1] >= cd:
            out.append((i, 1, b.c[i], b.c[i] - sg * p.get("stop", 1.5)))
            last[1] = i
        elif b.c[i] < ll and i - last[-1] >= cd:
            out.append((i, -1, b.c[i], b.c[i] + sg * p.get("stop", 1.5)))
            last[-1] = i
    return out


FAMILIES = {
    "sweep":     fam_sweep,
    "vwap_rev":  fam_vwap_rev,
    "pd_levels": fam_pd_levels,
    "ib_break":  fam_ib_break,
    "ib_fade":   fam_ib_fade,
    "momentum":  fam_momentum,
}


# ── executor ────────────────────────────────────────────────────────────────
def execute(F, signals, rr, cost_pts, validity=24, max_hold=None,
            be_trigger=1.0, regime_gate=False, market_entry=False):
    """Return list of (net_R, gross_R, risk_pts, bar). Bounded forward scan."""
    b = F.b
    out = []
    horizon = (max_hold or 0) or (validity + 200)
    for (i, d, entry, stop) in signals:
        if regime_gate:
            if F.rv[i] is None or F.rv_base[i] is None or F.rv[i] <= F.rv_base[i]:
                continue
        risk = abs(entry - stop) if not market_entry else abs(b.c[i] - stop)
        if risk <= 0:
            continue
        if market_entry:
            entry = b.c[i]
        tp = entry + d * risk * rr
        filled = market_entry
        fill_bar = i if market_entry else None
        be = False
        cur_stop = stop
        res = None
        end = min(F.n, i + 1 + horizon)
        for j in range(i + 1, end):
            # a session gap ends the trade at the last close (no overnight risk)
            if F.sess_id[j] is None:
                if filled:
                    res = d * (b.c[j - 1] - entry) / risk
                break
            if not filled:
                hit = (b.l[j] <= entry) if d == 1 else (b.h[j] >= entry)
                if hit:
                    filled = True
                    fill_bar = j
                    stopped = (b.l[j] <= cur_stop) if d == 1 else (b.h[j] >= cur_stop)
                    if stopped:
                        res = -1.0
                        break
                elif j - i >= validity:
                    break
                continue
            stop_hit = (b.l[j] <= cur_stop) if d == 1 else (b.h[j] >= cur_stop)
            tp_hit = (b.h[j] >= tp) if d == 1 else (b.l[j] <= tp)
            if stop_hit:
                res = 0.0 if be else -1.0
                break
            if tp_hit:
                res = rr
                break
            if be_trigger > 0 and not be:
                lvl = entry + d * be_trigger * risk
                if (b.h[j] >= lvl) if d == 1 else (b.l[j] <= lvl):
                    be = True
                    cur_stop = entry
            if max_hold and fill_bar is not None and j - fill_bar >= max_hold:
                res = d * (b.c[j] - entry) / risk
                break
        if res is None:
            continue
        out.append((res - cost_pts / risk, res, risk, i))
    return out


def summarise(trades):
    if not trades:
        return dict(n=0, wr=float("nan"), exp=float("nan"), pf=float("nan"),
                    t=float("nan"), net=0.0)
    net = [x[0] for x in trades]
    gross = [x[1] for x in trades]
    w = sum(1 for r in gross if r > 0)
    l = sum(1 for r in gross if r < 0)
    gw = sum(r for r in net if r > 0)
    gl = -sum(r for r in net if r < 0)
    sd = stdev(net) if len(net) > 1 else float("nan")
    return dict(
        n=len(net),
        wr=100.0 * w / max(w + l, 1),
        exp=mean(net),
        pf=(gw / gl if gl > 0 else float("inf")),
        t=(mean(net) / (sd / math.sqrt(len(net))) if sd else float("nan")),
        net=sum(net),
    )
