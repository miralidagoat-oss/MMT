#!/usr/bin/env python3
"""Realistic 5-minute strategy simulator for MNQ.

Execution model (deliberately free of close-price fills):

    decision      at the CLOSE of bar i   (only bars <= i are read)
    execution     at the OPEN of bar i+1
    position held until the OPEN of bar i+2
    P&L           pos_i * (open[i+2] - open[i+1])          in index points
    cost          |pos_i - pos_{i-1}| * one_way_cost       in index points

Charging cost per POSITION CHANGE rather than per bar matters: an always-in
signal that keeps the same side pays nothing to hold, so a naive
"round turn every bar" assumption overstates cost by several times.

One-way cost default 0.75 pts = half of a 1.5 pt round turn
(1-tick spread + commission + typical slippage on a marketable order).

Positions are flattened at the session end: no overnight carry, because the
overnight gap is a completely different risk that this signal says nothing
about.
"""
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import (load, is_rth, mean, stdev, pct,          # noqa: E402
                   MNQ_POINT_VALUE, RTH_OPEN, RTH_CLOSE)


class SimResult:
    def __init__(self, label):
        self.label = label
        self.day_pnl = {}      # date -> net points
        self.trades = 0        # number of position changes
        self.bar_pnl = []      # per-holding-period net points
        self.gross = 0.0
        self.costs = 0.0

    @property
    def net(self):
        return sum(self.day_pnl.values())

    @property
    def days(self):
        return len(self.day_pnl)

    def summary(self, contracts=1):
        d = sorted(self.day_pnl.values())
        if not d:
            return f"{self.label}: no trades"
        mu, sd = mean(d), stdev(d)
        sharpe = (mu / sd * math.sqrt(252)) if sd else float("nan")
        eq, peak, mdd = 0.0, 0.0, 0.0
        for _, v in sorted(self.day_pnl.items()):
            eq += v
            peak = max(peak, eq)
            mdd = max(mdd, peak - eq)
        wins = sum(1 for x in d if x > 0)
        return (
            f"{self.label}\n"
            f"    sessions {self.days:>5}   position changes {self.trades:>6}"
            f"   ({self.trades/max(self.days,1):.1f}/day)\n"
            f"    gross {self.gross:>9.1f} pts   costs {self.costs:>8.1f} pts"
            f"   NET {self.net:>9.1f} pts  (${self.net*MNQ_POINT_VALUE*contracts:,.0f})\n"
            f"    per session: mean {mu:+.2f} pts   sd {sd:.2f}"
            f"   day win rate {100*wins/len(d):.1f}%\n"
            f"    annualised Sharpe {sharpe:>5.2f}   max drawdown {mdd:.1f} pts"
            f"   worst day {d[0]:+.1f}  best day {d[-1]:+.1f}"
        )


def simulate(b, signal_fn, label, one_way_cost=0.75, warmup=12):
    """signal_fn(ctx, k) -> target position in {-1,0,+1}, using bars <= k only.

    ctx is a dict of per-session lists, k is the index within the session.
    """
    res = SimResult(label)
    sess = defaultdict(list)
    for i in range(b.n):
        if is_rth(b.t[i]):
            sess[b.et[i][0]].append(i)

    for d, ids in sorted(sess.items()):
        if len(ids) < warmup + 5:
            continue
        # verify bars are truly consecutive 5m; drop the session otherwise
        ctx = {"o": [b.o[i] for i in ids], "h": [b.h[i] for i in ids],
               "l": [b.l[i] for i in ids], "c": [b.c[i] for i in ids],
               "v": [b.v[i] for i in ids], "t": [b.t[i] for i in ids],
               "min": [b.et[i][4] for i in ids]}
        n = len(ids)
        prev_pos = 0.0
        day_net = 0.0
        # decision at k, execute at open[k+1], hold to open[k+2]
        for k in range(warmup, n - 2):
            pos = signal_fn(ctx, k)
            if pos is None:
                pos = 0.0
            move = ctx["o"][k + 2] - ctx["o"][k + 1]
            gross = pos * move
            cost = abs(pos - prev_pos) * one_way_cost
            res.gross += gross
            res.costs += cost
            day_net += gross - cost
            if pos != prev_pos:
                res.trades += 1
            res.bar_pnl.append(gross - cost)
            prev_pos = pos
        # flatten at session end
        if prev_pos != 0.0:
            res.costs += abs(prev_pos) * one_way_cost
            day_net -= abs(prev_pos) * one_way_cost
            res.trades += 1
        res.day_pnl[d] = day_net
    return res


# ── signal definitions (all strictly causal: read bars <= k only) ────────────
def sig_fade_prev(ctx, k):
    """Fade the previous 5m bar's close-to-close direction."""
    r = ctx["c"][k] - ctx["c"][k - 1]
    return -math.copysign(1.0, r) if r != 0 else 0.0


def sig_follow_prev(ctx, k):
    r = ctx["c"][k] - ctx["c"][k - 1]
    return math.copysign(1.0, r) if r != 0 else 0.0


def make_fade_n(nbars):
    def f(ctx, k):
        r = ctx["c"][k] - ctx["c"][k - nbars]
        return -math.copysign(1.0, r) if r != 0 else 0.0
    return f


def make_fade_vol_filtered(nbars, mult):
    """Fade only when the move is large relative to recent bar ranges."""
    def f(ctx, k):
        r = ctx["c"][k] - ctx["c"][k - nbars]
        if r == 0:
            return 0.0
        lookback = 12
        if k < lookback + nbars:
            return 0.0
        avg_rng = mean([ctx["h"][j] - ctx["l"][j]
                        for j in range(k - lookback, k)])
        if avg_rng <= 0 or abs(r) < mult * avg_rng:
            return 0.0
        return -math.copysign(1.0, r)
    return f


def sig_always_long(ctx, k):
    return 1.0


def main():
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else path.rsplit("/", 1)[-1]
    b = load(path)
    print(f"\n### {label}  ({b.n} bars)\n")
    sigs = [
        ("fade prev 5m bar (always in)", sig_fade_prev),
        ("follow prev 5m bar (always in)", sig_follow_prev),
        ("fade prev 15m (3 bars)", make_fade_n(3)),
        ("fade prev 30m (6 bars)", make_fade_n(6)),
        ("fade 5m only if |move|>1.0x avg range", make_fade_vol_filtered(1, 1.0)),
        ("fade 5m only if |move|>1.5x avg range", make_fade_vol_filtered(1, 1.5)),
        ("always long (benchmark)", sig_always_long),
    ]
    for name, fn in sigs:
        r = simulate(b, fn, name)
        print(r.summary(), "\n")


if __name__ == "__main__":
    main()
