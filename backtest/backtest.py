#!/usr/bin/env python3
"""Offline backtest of the Alpha Predictive Limit Matrix v3 logic.

Exact port of the Pine indicator's signal + fill model, including its
deliberately pessimistic accounting:
  - a limit fills only on a bar AFTER the signal bar, when price trades
    through the entry
  - a fill bar that also trades through the stop books a loss immediately
  - TP is never credited on the fill bar
  - if stop and TP both print inside one bar, the stop wins
  - wins book +RR, losses -1 R, at posted levels (no fees/slippage)

Usage:
  python3 backtest.py <data_dir> sweep    # parameter sweep, robustness ranking
  python3 backtest.py <data_dir> report P # full per-dataset report for a
                                          # JSON-encoded param dict P
"""
import csv
import itertools
import json
import math
import os
import sys
from dataclasses import dataclass, field


# ── data ─────────────────────────────────────────────────────────────────────

def load(path):
    o, h, l, c, v = [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            o.append(float(row["open"]))
            h.append(float(row["high"]))
            l.append(float(row["low"]))
            c.append(float(row["close"]))
            v.append(float(row["volume"]))
    return o, h, l, c, v


# ── parameters ───────────────────────────────────────────────────────────────

@dataclass
class Params:
    rb_lookback: int = 12
    body_thresh: float = 0.33
    min_wick: float = 0.4        # rejection-side wick, fraction of range
    min_close_pos: float = 0.6   # close in rejection direction, fraction of range
    sweep_sigma: float = 0.25    # sweep depth beyond prior extreme, in EWMA sigma
    range_exp: float = 1.0       # bar range vs 20-bar average range
    vol_mult: float = 1.2
    use_regime: bool = True
    trend_len: int = 200
    lam: float = 0.94
    seed_len: int = 20
    stop_sigma: float = 0.5
    rr: float = 4.0
    validity: int = 24
    cooldown: int = 10


@dataclass
class Result:
    signals: int = 0
    fills: int = 0
    wins: int = 0
    losses: int = 0
    expired: int = 0
    open_end: int = 0
    hold_bars: list = field(default_factory=list)
    exits: list = field(default_factory=list)  # (exit_bar, r)

    @property
    def net_r(self):
        return sum(r for _, r in self.exits)

    @property
    def pf(self):
        gw = sum(r for _, r in self.exits if r > 0)
        gl = -sum(r for _, r in self.exits if r < 0)
        return gw / gl if gl > 0 else float("inf") if gw > 0 else 0.0

    @property
    def wr(self):
        d = self.wins + self.losses
        return 100.0 * self.wins / d if d else 0.0

    @property
    def expectancy(self):
        n = len(self.exits)
        return self.net_r / n if n else 0.0

    @property
    def max_dd(self):
        eq = peak = dd = 0.0
        for _, r in sorted(self.exits):
            eq += r
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
        return dd


# ── engine ───────────────────────────────────────────────────────────────────

def run(bars, p: Params) -> Result:
    o, h, l, c, v = bars
    n = len(c)
    res = Result()

    # EWMA variance of log returns, seeded like ta.variance(x, seed_len)
    logret = [0.0] + [math.log(c[i] / c[i - 1]) for i in range(1, n)]
    ewma = [None] * n
    for i in range(n):
        if ewma[i - 1] is None if i else True:
            if i >= p.seed_len - 1:
                win = logret[i - p.seed_len + 1: i + 1]
                m = sum(win) / p.seed_len
                ewma[i] = sum((x - m) ** 2 for x in win) / p.seed_len
        else:
            ewma[i] = p.lam * ewma[i - 1] + (1 - p.lam) * logret[i] ** 2

    # rolling helpers
    ema_k = 2.0 / (p.trend_len + 1)
    ema = [c[0]] * n
    for i in range(1, n):
        ema[i] = c[i] * ema_k + ema[i - 1] * (1 - ema_k)

    def sma(series, length, i):
        if i + 1 < length:
            return None
        return sum(series[i - length + 1: i + 1]) / length

    rng = [h[i] - l[i] for i in range(n)]

    trades = []  # dicts: dir, entry, stop, tp, created, state, filled_bar
    last_bull = last_bear = -10 ** 9

    for i in range(1, n):
        # ── manage open setups on this bar (created strictly earlier) ──
        for t in trades:
            if t["state"] in ("win", "loss", "expired"):
                continue
            if t["created"] >= i:
                continue
            bull = t["dir"] == 1
            if t["state"] == "pending":
                filled = l[i] <= t["entry"] if bull else h[i] >= t["entry"]
                if filled:
                    t["state"] = "filled"
                    t["filled_bar"] = i
                    res.fills += 1
                    stop_same = l[i] <= t["stop"] if bull else h[i] >= t["stop"]
                    if stop_same:
                        t["state"] = "loss"
                        res.losses += 1
                        res.exits.append((i, -1.0))
                        res.hold_bars.append(0)
                elif i - t["created"] >= p.validity:
                    t["state"] = "expired"
                    res.expired += 1
            elif t["state"] == "filled":
                stop_hit = l[i] <= t["stop"] if bull else h[i] >= t["stop"]
                tp_hit = h[i] >= t["tp"] if bull else l[i] <= t["tp"]
                if stop_hit:
                    t["state"] = "loss"
                    res.losses += 1
                    res.exits.append((i, -1.0))
                    res.hold_bars.append(i - t["filled_bar"])
                elif tp_hit:
                    t["state"] = "win"
                    res.wins += 1
                    res.exits.append((i, p.rr))
                    res.hold_bars.append(i - t["filled_bar"])

        # ── signal detection on bar i (needs full lookbacks) ──
        if i < p.rb_lookback or ewma[i] is None:
            continue
        vol_sma = sma(v, 20, i)
        rng_sma = sma(rng, 20, i)
        if vol_sma is None or rng_sma is None:
            continue

        prev_hh = max(h[i - p.rb_lookback: i])
        prev_ll = min(l[i - p.rb_lookback: i])
        bar_rng = rng[i]
        if bar_rng <= 0:
            continue
        body = abs(c[i] - o[i])
        top_w = h[i] - max(c[i], o[i])
        bot_w = min(c[i], o[i]) - l[i]
        vol_price = math.sqrt(max(ewma[i], 0.0)) * c[i]

        small_body = body <= bar_rng * p.body_thresh
        range_ok = bar_rng >= rng_sma * p.range_exp

        # bull: sweep of prior low, rejected by lower wick, strong close
        bull = (l[i] < prev_ll and c[i] > prev_ll and small_body and range_ok
                and bot_w / bar_rng >= p.min_wick
                and (c[i] - l[i]) / bar_rng >= p.min_close_pos
                and (prev_ll - l[i]) >= p.sweep_sigma * vol_price
                and v[i] * (bot_w / bar_rng) >= vol_sma * p.vol_mult
                and (not p.use_regime or c[i] > ema[i])
                and i - last_bull >= p.cooldown)
        bear = (h[i] > prev_hh and c[i] < prev_hh and small_body and range_ok
                and top_w / bar_rng >= p.min_wick
                and (h[i] - c[i]) / bar_rng >= p.min_close_pos
                and (h[i] - prev_hh) >= p.sweep_sigma * vol_price
                and v[i] * (top_w / bar_rng) >= vol_sma * p.vol_mult
                and (not p.use_regime or c[i] < ema[i])
                and i - last_bear >= p.cooldown)

        if bull:
            entry = l[i] + (min(o[i], c[i]) - l[i]) / 2.0
            stop = l[i] - vol_price * p.stop_sigma
            risk = entry - stop
            if risk > 0:
                trades.append({"dir": 1, "entry": entry, "stop": stop,
                               "tp": entry + risk * p.rr, "created": i,
                               "state": "pending", "filled_bar": -1})
                res.signals += 1
                last_bull = i
        if bear:
            entry = h[i] - (h[i] - max(o[i], c[i])) / 2.0
            stop = h[i] + vol_price * p.stop_sigma
            risk = stop - entry
            if risk > 0:
                trades.append({"dir": -1, "entry": entry, "stop": stop,
                               "tp": entry - risk * p.rr, "created": i,
                               "state": "pending", "filled_bar": -1})
                res.signals += 1
                last_bear = i

    res.open_end = sum(1 for t in trades if t["state"] in ("pending", "filled"))
    return res


# ── sweep & reporting ────────────────────────────────────────────────────────

def datasets(data_dir):
    out = []
    for name in sorted(os.listdir(data_dir)):
        if name.endswith(".csv"):
            out.append((name[:-4], load(os.path.join(data_dir, name))))
    return out


def sweep(data_dir):
    ds = datasets(data_dir)
    grid = {
        "rr": [2.0, 3.0, 4.0, 5.0],
        "min_wick": [0.3, 0.4, 0.5],
        "min_close_pos": [0.5, 0.6, 0.7],
        "sweep_sigma": [0.0, 0.25, 0.5],
        "range_exp": [0.8, 1.0],
        "use_regime": [True, False],
        "stop_sigma": [0.5, 1.0],
    }
    keys = list(grid)
    rows = []
    for combo in itertools.product(*grid.values()):
        p = Params(**dict(zip(keys, combo)))
        pooled = Result()
        per_pf = []
        for _, bars in ds:
            r = run(bars, p)
            pooled.signals += r.signals
            pooled.fills += r.fills
            pooled.wins += r.wins
            pooled.losses += r.losses
            pooled.expired += r.expired
            pooled.exits += r.exits
            pooled.hold_bars += r.hold_bars
            per_pf.append(r.pf)
        closed = pooled.wins + pooled.losses
        if closed < 40:  # not enough evidence — skip
            continue
        pf_pos = sum(1 for x in per_pf if x > 1.0)
        rows.append((pooled.expectancy, pooled.pf, pooled.wr, closed,
                     pooled.net_r, pooled.max_dd, pf_pos, dict(zip(keys, combo))))
    rows.sort(key=lambda x: (x[6], x[0]), reverse=True)
    print(f"{'expR':>6} {'PF':>5} {'WR%':>5} {'n':>4} {'netR':>7} {'maxDD':>6} {'ds+':>3}  params")
    for exp, pf, wr, nn, net, dd, pos, kv in rows[:25]:
        print(f"{exp:6.3f} {pf:5.2f} {wr:5.1f} {nn:4d} {net:7.1f} {dd:6.1f} {pos:3d}  {kv}")


def report(data_dir, overrides):
    p = Params(**overrides)
    print("Params:", p, "\n")
    ds = datasets(data_dir)
    pooled = Result()
    hdr = f"{'dataset':<16} {'sig':>4} {'fill':>4} {'W':>3} {'L':>3} {'exp':>4} {'WR%':>5} {'PF':>5} {'netR':>7} {'expR':>6} {'maxDD':>6} {'avgHold':>7}"
    print(hdr)
    for name, bars in ds:
        r = run(bars, p)
        avg_hold = sum(r.hold_bars) / len(r.hold_bars) if r.hold_bars else 0
        print(f"{name:<16} {r.signals:>4} {r.fills:>4} {r.wins:>3} {r.losses:>3} "
              f"{r.expired:>4} {r.wr:>5.1f} {r.pf:>5.2f} {r.net_r:>7.1f} "
              f"{r.expectancy:>6.3f} {r.max_dd:>6.1f} {avg_hold:>7.1f}")
        pooled.signals += r.signals
        pooled.fills += r.fills
        pooled.wins += r.wins
        pooled.losses += r.losses
        pooled.expired += r.expired
        pooled.exits += r.exits
        pooled.hold_bars += r.hold_bars
        pooled.open_end += r.open_end
    avg_hold = sum(pooled.hold_bars) / len(pooled.hold_bars) if pooled.hold_bars else 0
    print("-" * len(hdr))
    print(f"{'POOLED':<16} {pooled.signals:>4} {pooled.fills:>4} {pooled.wins:>3} "
          f"{pooled.losses:>3} {pooled.expired:>4} {pooled.wr:>5.1f} {pooled.pf:>5.2f} "
          f"{pooled.net_r:>7.1f} {pooled.expectancy:>6.3f} {pooled.max_dd:>6.1f} {avg_hold:>7.1f}")
    print(f"\nfill rate: {100.0 * pooled.fills / pooled.signals:.1f}%  "
          f"open at end: {pooled.open_end}")


if __name__ == "__main__":
    data_dir = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "sweep"
    if mode == "sweep":
        sweep(data_dir)
    else:
        report(data_dir, json.loads(sys.argv[3]) if len(sys.argv) > 3 else {})
