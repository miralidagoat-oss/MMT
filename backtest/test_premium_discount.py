#!/usr/bin/env python3
"""Known-answer checks for the Premium & Discount Zones logic.

1. A hand-built zigzag: the dealing range must be its latest swing high and
   swing low, and the reading at a known price must match by hand.
2. Trailing: a breakout above the swing high moves the top with it.
3. Lower high: a newer, lower swing high replaces the old top.
4. Random walks: price must never sit outside its own range (0-100%).

Run: python3 test_premium_discount.py
"""
import random
import sys

from premium_discount import dealing_range, reading


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        check.failed = True


check.failed = False


def bars_from(closes):
    """One bar per close, high/low = close ± 0.25, so every peak and trough
    belongs to exactly one bar."""
    return [(i * 60, c, c + 0.25, c - 0.25, c) for i, c in enumerate(closes)]


def ramp(a, b, n):
    return [a + (b - a) * k / n for k in range(1, n + 1)]


def test_zigzag():
    # 100 -> 110 (swing high), -> 90 (swing low), -> 104, then sideways at 104
    closes = [100.0] * 5 + ramp(100, 110, 10) + ramp(110, 90, 10) + ramp(90, 104, 7) + [104.0] * 6
    bars = bars_from(closes)
    top, bot, _, _ = list(dealing_range(bars, length=3))[-1]
    check("zigzag: range is the latest swing high and swing low", (top, bot) == (110.25, 89.75), f"{bot} – {top}")
    zone, depth, p = reading(top, bot, 104.0)
    exp_p = (104.0 - 89.75) / (110.25 - 89.75)
    check("zigzag: reading at 104 matches by hand", zone == "Premium" and abs(p - exp_p) < 1e-12
          and abs(depth - (2 * exp_p - 1)) < 1e-12, f"{zone} depth {100 * depth:.1f}% in range {100 * p:.1f}%")
    zone, depth, p = reading(top, bot, 100.0)
    check("zigzag: 100 sits at equilibrium", zone == "Equilibrium", f"in range {100 * p:.1f}%")


def test_trailing():
    closes = [100.0] * 5 + ramp(100, 110, 10) + ramp(110, 95, 8) + ramp(95, 118, 6)
    bars = bars_from(closes)
    top, bot, _, _ = list(dealing_range(bars, length=3))[-1]
    check("breakout: the top trails the new high", top == max(b[2] for b in bars), f"top {top}")
    zone, depth, p = reading(top, bot, bars[-1][4])
    check("breakout: price at the high reads deep premium", zone == "Premium" and depth > 0.95, f"depth {100 * depth:.1f}%")


def test_lower_high():
    closes = ([100.0] * 5 + ramp(100, 120, 10) + ramp(120, 100, 10) + ramp(100, 112, 6)
              + ramp(112, 104, 6) + [104.0] * 4)
    bars = bars_from(closes)
    top, bot, _, _ = list(dealing_range(bars, length=3))[-1]
    check("lower high: the newer, lower swing high becomes the top", top == 112.25, f"top {top}")


def test_random_walks():
    rng = random.Random(3)
    worst = 0
    for trial in range(200):
        x, closes = 100.0, []
        for _ in range(600):
            x += rng.gauss(0, 1)
            closes.append(round(x * 4) / 4)
        bars = bars_from(closes)
        for length in (1, 3, 10):
            for (t, o, h, l, c), (top, bot, _, _) in zip(bars, dealing_range(bars, length=length)):
                if not (bot <= l <= c <= h <= top):
                    worst += 1
    check("random walks: price never outside its range (120,000 bar checks)", worst == 0, f"violations {worst}")
    bars = bars_from(closes)
    for (t, o, h, l, c), (top, bot, _, _) in list(zip(bars, dealing_range(bars, mode="Lookback", lookback=50)))[49:]:
        if not (bot <= l <= c <= h <= top):
            worst += 1
    check("lookback mode: price never outside its range", worst == 0)


if __name__ == "__main__":
    test_zigzag()
    test_trailing()
    test_lower_high()
    test_random_walks()
    print("\nALL PASSED" if not check.failed else "\nFAILURES ABOVE")
    sys.exit(1 if check.failed else 0)
