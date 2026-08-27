#!/usr/bin/env python3
"""Backtest engine for MNQ 5m ETH research.

Design rules, all from Phase 1:

* **No lookahead.** A signal is decided at the *close* of bar i; entry is the
  *open* of bar i+1. Nothing consults bar i+1 before that.
* **Dual path resolution (§3.3).** When one bar's range contains both the stop
  and the target, OHLC cannot say which came first. The engine scores every
  candidate twice - `pess` (stop first) and `opt` (target first) - and the
  research only trusts the pessimistic number. The gap between them is the
  path-assumption band and is itself a rejection criterion.
* **Realistic fills.** Entry is a market order at the next open and pays
  slippage. The stop is a stop-market and pays slippage. The target is a
  resting limit and pays none. Commission is charged both sides.
"""
from dataclasses import dataclass, field

PV = 2.00      # MNQ dollars per index point
TICK = 0.25    # minimum tick, in points

COSTS = {
    "zero":     dict(comm=0.00, slip_ticks=0),   # diagnostic only, never a verdict
    "base":     dict(comm=0.85, slip_ticks=1),
    "moderate": dict(comm=0.85, slip_ticks=2),
    "harsh":    dict(comm=1.25, slip_ticks=3),
}


@dataclass
class Trade:
    day: str
    etm: int
    dir: int
    entry: float
    stop: float
    target: float
    exit: float = 0.0
    exit_kind: str = ""
    bars_held: int = 0
    r: float = 0.0
    mae_r: float = 0.0
    mfe_r: float = 0.0


@dataclass
class Result:
    trades: list = field(default_factory=list)
    signals: int = 0
    suppressed_gap: int = 0

    @property
    def n(self):
        return len(self.trades)

    @property
    def wins(self):
        return [t for t in self.trades if t.r > 0]

    @property
    def losses(self):
        return [t for t in self.trades if t.r <= 0]

    @property
    def wr(self):
        return 100.0 * len(self.wins) / self.n if self.n else 0.0

    @property
    def pf(self):
        g = sum(t.r for t in self.wins)
        b = -sum(t.r for t in self.losses)
        return (g / b) if b > 0 else (float("inf") if g > 0 else 0.0)

    @property
    def expectancy(self):
        return sum(t.r for t in self.trades) / self.n if self.n else 0.0

    @property
    def net_r(self):
        return sum(t.r for t in self.trades)

    @property
    def max_dd(self):
        peak = eq = dd = 0.0
        for t in self.trades:
            eq += t.r
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
        return dd

    def days(self):
        return len({t.day for t in self.trades})

    def summary(self, label=""):
        if not self.n:
            return f"{label:<22} no trades (signals={self.signals})"
        return (f"{label:<22} n={self.n:4d} WR={self.wr:5.1f}% PF={self.pf:5.2f} "
                f"exp={self.expectancy:+.3f}R net={self.net_r:+7.1f}R "
                f"maxDD={self.max_dd:5.1f}R")


def run(bars, signal_fn, *, stop_atr=1.25, rr=0.643, cost="moderate",
        path="pess", cooldown=12, max_hold=48, gap_guard=1.5,
        flat_eod=True, min_bar_in_day=24):
    """Walk the series once and book trades.

    `signal_fn(bars, i) -> +1 | -1 | 0` is evaluated on the confirmed close of
    bar i and may only read bars[<= i].
    """
    c = COSTS[cost]
    slip = c["slip_ticks"] * TICK           # points, adverse on entry and stop
    comm_rt = 2 * c["comm"]                 # dollars, round turn
    res = Result()
    i, n = 0, len(bars)
    cool_until = -1

    while i < n - 1:
        b = bars[i]
        atr = b.f.get("atr")
        if atr is None or i <= cool_until or b.f.get("bar_in_day", 0) < min_bar_in_day:
            i += 1
            continue

        d = signal_fn(bars, i)
        if not d:
            i += 1
            continue
        res.signals += 1

        nxt = bars[i + 1]
        # Never trade across a session break or a splice discontinuity (§1.3).
        # The gap test reads the SIGNAL bar's own gap, not the entry bar's.
        # Reading nxt.gap_atr here would decide the trade using the entry bar's
        # open - information not in hand when the order is placed at bar i's
        # close. The session-boundary test is fine: the calendar is known ahead.
        if nxt.day != b.day or b.f.get("gap_atr", 0.0) > gap_guard:
            res.suppressed_gap += 1
            i += 1
            continue

        stop_dist = stop_atr * atr
        entry = nxt.o + d * slip
        stop = entry - d * stop_dist
        target = entry + d * stop_dist * rr
        risk_usd = stop_dist * PV
        t = Trade(day=b.day, etm=b.etm, dir=d, entry=entry, stop=stop, target=target)

        j = i + 1
        while j < n:
            bj = bars[j]
            if bj.day != t.day:              # session rolled while flat-eod off
                j -= 1
                bj = bars[j]
                t.exit, t.exit_kind = bj.c, "eod"
                break

            adverse = (t.entry - bj.l) if d > 0 else (bj.h - t.entry)
            favour = (bj.h - t.entry) if d > 0 else (t.entry - bj.l)
            t.mae_r = max(t.mae_r, adverse / stop_dist)
            t.mfe_r = max(t.mfe_r, favour / stop_dist)

            hit_stop = (bj.l <= stop) if d > 0 else (bj.h >= stop)
            hit_tgt = (bj.h >= target) if d > 0 else (bj.l <= target)

            if hit_stop and hit_tgt:
                # Ambiguous bar: the OHLC cannot resolve the order.
                if path == "pess":
                    t.exit, t.exit_kind = stop - d * slip, "stop_amb"
                else:
                    t.exit, t.exit_kind = target, "target_amb"
                break
            if hit_stop:
                t.exit, t.exit_kind = stop - d * slip, "stop"
                break
            if hit_tgt:
                t.exit, t.exit_kind = target, "target"
                break
            if j - i >= max_hold:
                t.exit, t.exit_kind = bj.c, "time"
                break
            if flat_eod and (j + 1 >= n or bars[j + 1].day != t.day):
                t.exit, t.exit_kind = bj.c, "eod"
                break
            j += 1
        else:
            j = n - 1
            t.exit, t.exit_kind = bars[j].c, "eod"

        t.bars_held = j - i
        gross = d * (t.exit - t.entry) * PV
        t.r = (gross - comm_rt) / risk_usd
        res.trades.append(t)
        cool_until = j + cooldown
        i = j + 1

    return res


def band(bars, signal_fn, **kw):
    """Run both path assumptions. Returns (pessimistic, optimistic)."""
    kw.pop("path", None)
    return (run(bars, signal_fn, path="pess", **kw),
            run(bars, signal_fn, path="opt", **kw))
