#!/usr/bin/env python3
"""Ground-truth tests for zone_study.py.

Real 5m futures data is not reachable from every environment, and a harness
that has never been checked is worth as little as an ungraded indicator. Each
case below is a series built so the correct answer is known by construction.

Run: python3 backtest/zone_study_test.py
"""
import os
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zone_study import (CA, MINTICK, Bars, Touch, atr14, half_width, label,
                        session_of, block_of, deadline_of, wilson, study,
                        SRC_NY_HIGH, SRC_NY_LOW, bucket_name, ca_time)

T = []


def check(name, got, want):
    ok = got == want
    T.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        expected {want}\n        got      {got}")


def close(name, got, want, tol=1e-4):
    ok = abs(got - want) < tol
    T.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        expected {want}\n        got      {got}")


# ── sessions and widths ──────────────────────────────────────────────────────
def ts(y, mo, d, hh, mm):
    return int(datetime(y, mo, d, hh, mm, tzinfo=CA).timestamp())

check("06:00 CA is the NY block",        session_of(ts(2026, 9, 17, 6, 0)), "NY")
check("13:50 CA is still NY",            session_of(ts(2026, 9, 17, 13, 50)), "NY")
check("13:55 CA is outside (deadline)",  session_of(ts(2026, 9, 17, 13, 55)), None)
check("14:30 CA is outside",             session_of(ts(2026, 9, 17, 14, 30)), None)
check("15:00 CA is the Asia block",      session_of(ts(2026, 9, 17, 15, 0)), "ASIA")
check("18:55 CA is still Asia",          session_of(ts(2026, 9, 17, 18, 55)), "ASIA")
check("19:00 CA is outside",             session_of(ts(2026, 9, 17, 19, 0)), None)
# the bug fixed in the indicator: both blocks of one CA day share a date
check("NY block date",   block_of(ts(2026, 9, 17, 6, 0))[0], "20260917")
check("Asia block date matches it", block_of(ts(2026, 9, 17, 15, 0))[0], "20260917")
check("NY deadline is 13:55 CA",
      ca_time(deadline_of(ts(2026, 9, 17, 9, 0))).strftime("%H:%M"), "13:55")
check("Asia deadline is 19:00 CA",
      ca_time(deadline_of(ts(2026, 9, 17, 16, 0))).strftime("%H:%M"), "19:00")

check("half width floors at 2.0 on NQ",  half_width(5.0), 2.0)
check("half width scales at 0.12 ATR",   half_width(30.0), 3.5)   # 3.6 -> mintick
check("half width caps at 6.0 on NQ",    half_width(100.0), 6.0)

# ── ATR is Wilder's RMA, seeded on the SMA ───────────────────────────────────
b = Bars(t=[i * 300 for i in range(20)],
         o=[100] * 20, h=[110] * 20, l=[90] * 20, c=[100] * 20)
a = atr14(b)
check("ATR undefined before 14 bars", a[12], None)
close("ATR of a constant 20-point range is 20", a[13], 20.0)
close("ATR stays at 20", a[19], 20.0)

# ── Wilson interval against the published value for 8/10 ─────────────────────
p, lo, hi = wilson(8, 10)
close("Wilson point estimate", p, 0.8)
close("Wilson lower bound", lo, 0.4902, 1e-3)
close("Wilson upper bound", hi, 0.9433, 1e-3)
check("Wilson of an empty bucket", wilson(0, 0), (0.0, 0.0, 0.0))


# ── outcome labelling ────────────────────────────────────────────────────────
def mk(seq):
    return Bars(t=[i * 300 for i in range(len(seq))],
                o=[x[0] for x in seq], h=[x[1] for x in seq],
                l=[x[2] for x in seq], c=[x[3] for x in seq])


def touch(side=1, near=100.0, far=98.0, atr=10.0):
    return Touch(i=0, ts=0, zone_p=99.0, zone_w=1.0, side=side, near=near,
                 far=far, sources=SRC_NY_HIGH, session="NY", atr=atr)


# support at 98-100, approached from above. HOLD needs 0.75*10 = 7.5 clear of
# the near edge, i.e. a trade up to 107.5. Fade: stop 97.0, risk 3, target 106.
bars = mk([(100, 100, 100, 100), (100, 102, 99, 101), (101, 108, 100, 107)])
tc = label(bars, touch(), horizon=12, target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("HOLD when price clears 0.75 ATR", (tc.outcome, tc.bars_to), ("HOLD", 2))
check("  ...and the fade books +2R", (tc.fade, tc.r), ("TARGET", 2.0))

# two consecutive closes below 97.75 break it
bars = mk([(100, 100, 100, 100), (100, 101, 97.5, 97.5), (97.5, 98, 97.2, 97)])
tc = label(bars, touch(), horizon=12, target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("BREAK on two closes beyond the far edge", (tc.outcome, tc.bars_to), ("BREAK", 2))

# one close beyond, then back: not a break
bars = mk([(100, 100, 100, 100), (100, 101, 97, 97.5), (97.5, 100, 97.5, 99.5),
           (99.5, 100, 99, 99.5)])
tc = label(bars, touch(), horizon=12, target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("a single close beyond the far edge is not a break", tc.outcome, "TIMEOUT")

# flat: neither
bars = mk([(100, 100, 100, 100)] + [(100, 100.5, 99.5, 100)] * 6)
tc = label(bars, touch(), horizon=5, target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("TIMEOUT when neither resolves", tc.outcome, "TIMEOUT")

# pessimism: a bar that both completes the break and reaches the target
bars = mk([(100, 100, 100, 100), (100, 101, 97.5, 97.5), (97.5, 110, 96, 97)])
tc = label(bars, touch(), horizon=12, target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("ambiguous bar books BREAK, not HOLD", tc.outcome, "BREAK")

# pessimism: a bar holding both the fade stop and the fade target
bars = mk([(100, 100, 100, 100), (100, 120, 96, 110)])
tc = label(bars, touch(), horizon=12, target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("ambiguous fade bar books the stop", (tc.fade, tc.r), ("STOP", -1.0))

# resistance mirrors it: near edge below, target above
bars = mk([(100, 100, 100, 100), (100, 101, 99, 100), (100, 100, 92, 92.5)])
tc = label(bars, touch(side=-1, near=100.0, far=102.0), horizon=12,
           target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("resistance HOLD is measured downward", (tc.outcome, tc.bars_to), ("HOLD", 2))

bars = mk([(100, 100, 100, 100), (100, 102.5, 100, 102.5), (102.5, 103, 102, 103)])
tc = label(bars, touch(side=-1, near=100.0, far=102.0), horizon=12,
           target_mult=0.75, rr=2.0, stop_pad_ticks=4)
check("resistance BREAK is measured upward", tc.outcome, "BREAK")


# ── end to end: a prior New York high, touched on a known bar ───────────────
def synth():
    """Day 1 sets an RTH high of 21000; day 2 touches it and is rejected."""
    rows = []

    def add(day, m, o, h, l, c):
        d = datetime(2026, 9, day, m // 60, m % 60, tzinfo=CA)
        rows.append((int(d.timestamp()), o, h, l, c))

    # Day 1: 06:00-18:55, flat 20900 +/-10, a 21000 spike at 08:00 and a
    # 20800 low at 10:00, both inside RTH (06:30-13:00).
    for m in range(360, 1140, 5):
        if m == 480:
            add(16, m, 20900, 21000, 20890, 20900)
        elif m == 600:
            add(16, m, 20900, 20910, 20800, 20900)
        else:
            add(16, m, 20900, 20910, 20890, 20900)
    # Day 2 New York block: open well below the level, rally into it at 08:00,
    # then fall away hard enough to clear 0.75 ATR.
    for m in range(360, 835, 5):
        if m == 480:
            add(17, m, 20960, 20998, 20950, 20996)   # first contact: 20997.5
        elif m in (485, 490):
            add(17, m, 20996, 20996, 20950, 20960)   # falls away -> HOLD
        else:
            add(17, m, 20900, 20910, 20890, 20900)
    return Bars([r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows],
                [r[3] for r in rows], [r[4] for r in rows])


args = SimpleNamespace(contract="nq", horizon=12, target=0.75, rr=2.0,
                       stop_pad=4, max_zones=8, no_swings=True, no_ny=False,
                       no_asia=False, offset=0.0, min_n=30)
eng = study(synth(), args)
srcs = sorted(bucket_name(z.sources) for z in eng.zones)
check("day 2 seeds exactly the prior NY high and low", srcs, ["NY high", "NY low"])
hi_zone = [z for z in eng.zones if z.sources == SRC_NY_HIGH][0]
close("NY high zone is centred on 21000", hi_zone.p, 21000.0)
check("approached from below, so it is resistance", hi_zone.side, -1)
check("exactly one touch of the NY high", len(eng.touches), 1)
if eng.touches:
    tc = eng.touches[0]
    check("touched on the 08:00 bar", ca_time(tc.ts).strftime("%H:%M"), "08:00")
    check("touch is labelled HOLD", tc.outcome, "HOLD")
    check("touch is attributed to NY high", bucket_name(tc.sources), "NY high")
    check("touch is attributed to the NY session", tc.session, "NY")

print(f"\n{sum(T)}/{len(T)} passed")
sys.exit(0 if all(T) else 1)
