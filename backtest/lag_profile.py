#!/usr/bin/env python3
"""Decay profile of the 5m fade signal — the artifact-vs-real discriminator.

Signal is formed from the return over bar k (close[k-1] -> close[k]).
We then measure the fade P&L over each SUBSEQUENT non-overlapping bar:

    h=1   open[k+1] -> open[k+2]      (the bar right after the decision)
    h=2   open[k+2] -> open[k+3]
    h=3   open[k+3] -> open[k+4]
    ...

Interpretation:
  * GENUINE transient price impact (someone pushed price, liquidity providers
    lean against it) decays SMOOTHLY: a large h=1, smaller h=2, smaller h=3,
    all the same sign. Total reversion accumulates over several bars.
  * A BAR-BOUNDARY / MICROSTRUCTURE-NOISE artifact (a trade allocated to the
    wrong bar, a stale or noisy close print) produces a single-bar spike at
    h=1 and approximately ZERO at h>=2, because the noise is i.i.d. and
    reverses exactly once.

The h=1 magnitude alone cannot distinguish the two. The shape can.

Also reports the same profile using CLOSE-to-CLOSE returns, so the two price
conventions can be compared: if the effect exists close-to-close but not
open-to-open, the signal is entangled with the close print itself.
"""
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, is_rth, mean, newey_west_t   # noqa: E402

BP = 1e4
MAXH = 8


def profile(b, label, price="o"):
    idx = [i for i in range(b.n) if is_rth(b.t[i])]
    sess = defaultdict(list)
    for i in idx:
        sess[b.et[i][0]].append(i)

    buckets = {h: [] for h in range(1, MAXH + 1)}
    for d, ids in sorted(sess.items()):
        if len(ids) < MAXH + 4:
            continue
        # require strict 5m adjacency so a session gap never fakes a move
        for k in range(1, len(ids) - MAXH - 2):
            ok = all(b.t[ids[j + 1]] - b.t[ids[j]] == 300
                     for j in range(k - 1, k + MAXH + 1))
            if not ok:
                continue
            i_prev, i_k = ids[k - 1], ids[k]
            r_sig = b.c[i_k] / b.c[i_prev] - 1.0
            if r_sig == 0:
                continue
            s = -math.copysign(1.0, r_sig)
            for h in range(1, MAXH + 1):
                a, z = ids[k + h], ids[k + h + 1]
                if price == "o":
                    ret = (b.o[z] / b.o[a] - 1.0) * BP
                else:
                    ret = (b.c[z] / b.c[a] - 1.0) * BP
                buckets[h].append(s * ret)

    px = mean([b.c[i] for i in idx])
    print(f"\n{label}   [{'open-to-open' if price=='o' else 'close-to-close'}]"
          f"   index {px:.0f}")
    print(f"  {'h (bars ahead)':<16}{'n':>7}{'mean_bp':>10}{'t_NW':>8}"
          f"{'cum_bp':>10}")
    print("  " + "-" * 51)
    cum = 0.0
    for h in range(1, MAXH + 1):
        xs = buckets[h]
        if not xs:
            continue
        m = mean(xs)
        cum += m
        print(f"  h={h:<14}{len(xs):>7}{m:>10.3f}"
              f"{newey_west_t(xs, 5):>8.2f}{cum:>10.3f}")
    return buckets


def main():
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else path.rsplit("/", 1)[-1]
    b = load(path)
    profile(b, label, "o")
    profile(b, label, "c")


if __name__ == "__main__":
    main()
