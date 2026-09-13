#!/usr/bin/env python3
"""GATE 1 tests: a CME trade day is identified identically regardless of DST."""
import datetime as dt
import os
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S

ET = S.ET
FAILS = []


def ok(cond, msg):
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


def at(y, m, d, hh, mm=0):
    """An aware ET wall-clock instant."""
    return dt.datetime(y, m, d, hh, mm, tzinfo=ET)


# ── 1. ordinary EST and EDT dates ──────────────────────────────────────────
print("1. Ordinary dates, both offsets")
est = at(2024, 1, 17, 9, 30)                     # January: EST, UTC-5
edt = at(2024, 6, 12, 9, 30)                     # June: EDT, UTC-4
ok(est.utcoffset() == dt.timedelta(hours=-5), "January instant really is EST (UTC-5)")
ok(edt.utcoffset() == dt.timedelta(hours=-4), "June instant really is EDT (UTC-4)")
ok(S.trade_date(est) == dt.date(2024, 1, 17), "EST 09:30 -> same calendar trade date")
ok(S.trade_date(edt) == dt.date(2024, 6, 12), "EDT 09:30 -> same calendar trade date")

# the same wall-clock time must give the same RELATIVE answer in both offsets,
# which is the whole point: DST must not shift the trade date
for label, base in (("EST", dt.date(2024, 1, 17)), ("EDT", dt.date(2024, 6, 12))):
    ev = at(base.year, base.month, base.day, 19, 0)          # 19:00 ET, after open
    ok(S.trade_date(ev) == base + dt.timedelta(days=1),
       f"{label} 19:00 belongs to the NEXT trade date")

# ── 2. session open, and the instant before it ─────────────────────────────
print("\n2. Session open boundary (18:00 ET on D-1)")
d = dt.date(2024, 6, 13)
op, cl = S.session_bounds(d)
ok(op == at(2024, 6, 12, 18, 0).astimezone(dt.timezone.utc),
   "open is 18:00 ET on the previous calendar day")
ok(S.trade_date(at(2024, 6, 12, 18, 0)) == d, "18:00 ET exactly -> trade date D (inclusive)")
ok(S.trade_date(at(2024, 6, 12, 17, 59)) is None,
   "17:59 ET is maintenance, NOT the previous session")
ok(S.trade_date(at(2024, 6, 12, 16, 59)) == dt.date(2024, 6, 12),
   "16:59 ET belongs to the previous trade date")

# ── 3. session close, and the instant after it ─────────────────────────────
print("\n3. Session close boundary (17:00 ET on D), half-open")
ok(cl == at(2024, 6, 13, 17, 0).astimezone(dt.timezone.utc), "close is 17:00 ET on D")
ok(S.trade_date(at(2024, 6, 13, 16, 59)) == d, "16:59 ET is still inside trade date D")
ok(S.trade_date(at(2024, 6, 13, 17, 0)) is None,
   "17:00 ET exactly is EXCLUDED - half-open interval")
ok(S.trade_date(at(2024, 6, 13, 17, 1)) is None, "17:01 ET is maintenance")
ok(S.trade_date(at(2024, 6, 13, 18, 0)) == dt.date(2024, 6, 14),
   "18:00 ET opens the NEXT trade date")

# ── 4. the maintenance hour belongs to neither session ────────────────────
print("\n4. Maintenance hour 17:00-18:00 ET belongs to NEITHER session")
allnone = all(S.trade_date(at(2024, 6, 13, 17, m)) is None for m in range(0, 60, 5))
ok(allnone, "every instant in [17:00,18:00) ET returns None")
ok(S.classify(at(2024, 6, 13, 17, 30)) == "maintenance", "classify() says maintenance")
ok(S.classify(at(2024, 6, 13, 18, 30)) == "session", "classify() says session at 18:30")

# ── 5. spring DST transition ──────────────────────────────────────────────
print("\n5. Spring forward (2024-03-10, 02:00 ET jumps to 03:00)")
# the session labelled 2024-03-11 opens 18:00 ET on 03-10 and spans the change
op_s, cl_s = S.session_bounds(dt.date(2024, 3, 11))
ok(S.trade_date(at(2024, 3, 10, 18, 0)) == dt.date(2024, 3, 11),
   "18:00 ET on the transition day opens trade date 2024-03-11")
ok(S.trade_date(at(2024, 3, 11, 9, 30)) == dt.date(2024, 3, 11),
   "09:30 ET after the change is still trade date 2024-03-11")
# The transition fires at 02:00 ET on SUNDAY 03-10, so the session that
# actually spans it is the one LABELLED 2024-03-10: it opens 18:00 ET Saturday
# in EST and closes 17:00 ET Sunday in EDT. The session labelled 03-11 opens
# after the change and is an ordinary 23 hours - which the first version of
# this test got wrong, expecting 22.
op_b, cl_b = S.session_bounds(dt.date(2024, 3, 10))
hours = (cl_b - op_b).total_seconds() / 3600
ok(abs(hours - 22.0) < 1e-9,
   f"the session SPANNING the spring change is 22 REAL hours ({hours:.1f}) - "
   "an hour vanishes, and the wall-clock definition absorbs it")
ok(abs((S.session_bounds(dt.date(2024, 3, 11))[1]
        - S.session_bounds(dt.date(2024, 3, 11))[0]).total_seconds() / 3600
       - 23.0) < 1e-9,
   "the session AFTER the spring change is an ordinary 23 real hours")

# ── 6. fall DST transition ────────────────────────────────────────────────
print("\n6. Fall back (2024-11-03, 02:00 ET repeats)")
# same reasoning: the session spanning the 02:00 Sunday repeat is 2024-11-03
op_f, cl_f = S.session_bounds(dt.date(2024, 11, 3))
hours_f = (cl_f - op_f).total_seconds() / 3600
ok(S.trade_date(at(2024, 11, 3, 18, 0)) == dt.date(2024, 11, 4),
   "18:00 ET on the transition day opens trade date 2024-11-04")
ok(abs(hours_f - 24.0) < 1e-9,
   f"the session SPANNING the fall change is 24 REAL hours ({hours_f:.1f}) - "
   "an hour repeats")
# both transition sessions are still 23 WALL-CLOCK hours
for lbl, (o, c) in (("spring", (op_b, cl_b)), ("fall", (op_f, cl_f))):
    wall = (c.astimezone(ET).replace(tzinfo=None)
            - o.astimezone(ET).replace(tzinfo=None)).total_seconds() / 3600
    ok(abs(wall - 23.0) < 1e-9, f"{lbl} session is 23 WALL-CLOCK hours ({wall:.1f})")

# ── 7. UTC calendar midnight is not a boundary ────────────────────────────
print("\n7. UTC midnight carries no special meaning")
for y, m, d_, expect in ((2024, 1, 17, dt.date(2024, 1, 17)),
                         (2024, 6, 12, dt.date(2024, 6, 12))):
    mid = dt.datetime(y, m, d_, 0, 0, tzinfo=dt.timezone.utc)
    got = S.trade_date(mid)
    et_h = mid.astimezone(ET).hour
    ok(got == expect,
       f"UTC midnight {y}-{m:02d}-{d_:02d} ({et_h}:00 ET) -> trade date {got}, "
       f"not the UTC date")

# ── 8. DST-invariance of the identification itself ────────────────────────
print("\n8. The same wall-clock instant maps identically in EST and EDT")
mismatch = []
for month, day in ((1, 17), (4, 17), (7, 17), (10, 17)):
    base = dt.date(2024, month, day)
    for hh, mm in ((18, 0), (23, 55), (0, 0), (9, 30), (16, 55)):
        inst = at(2024, month, day, hh, mm)
        got = S.trade_date(inst)
        want = base + dt.timedelta(days=1) if hh >= 18 else base
        if got != want:
            mismatch.append((inst.isoformat(), got, want))
ok(not mismatch, f"all 20 wall-clock probes across both offsets agree ({mismatch[:2]})")

# ── 9. span_epoch covers exactly the intended trade dates ─────────────────
print("\n9. span_epoch covers exactly the intended trade dates")
s, e = S.span_epoch(dt.date(2024, 6, 10), dt.date(2024, 6, 14))
inside = S.eligible_trade_dates(range(s, e, 300))
ok(min(inside) == dt.date(2024, 6, 10) and max(inside) == dt.date(2024, 6, 14),
   f"span yields exactly 2024-06-10..2024-06-14 ({len(inside)} dates)")
before = S.trade_date(s - 1)
ok(before != dt.date(2024, 6, 10),
   f"one second before the span is NOT the first trade date (it is {before})")
ok(S.trade_date(e) != dt.date(2024, 6, 14),
   "the exclusive end instant is NOT the last trade date")

print()
if FAILS:
    print(f"GATE 1 FAILED - {len(FAILS)} check(s):")
    for f in FAILS:
        print(f"  - {f}")
    sys.exit(1)
print("GATE 1 PASSED - CME trade day identified identically regardless of DST.")
