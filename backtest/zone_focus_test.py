#!/usr/bin/env python3
"""Ground-truth tests for single-zone selection and its order plan.

Ports f_pick and the entry/stop/target arithmetic from
indicators/qt_reversal_zones.pine so the levels a limit order would be
placed at are checked rather than assumed.

Run: python3 backtest/zone_focus_test.py
"""
import sys
from dataclasses import dataclass

MINTICK = 0.25
T = []


def check(name, got, want):
    ok = got == want
    T.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        expected {want}\n        got      {got}")


@dataclass
class Z:
    p: float
    w: float
    side: int
    sources: int
    touches: int = 0
    rejects: int = 0
    name: str = ""


n_sources = lambda m: sum(1 for b in (1, 2, 4, 8) if (m // b) % 2 == 1)


def f_pick(zones, price, scale, max_dist):
    best, best_score = None, -1e20
    if zones and scale and scale > 0:
        for z in zones:
            if z.side != 0:
                dist = abs(z.p - price)
                if dist <= max_dist * scale:
                    score = (n_sources(z.sources) * 100.0 - dist / scale * 5.0
                             + (10.0 if z.touches == 0
                                else 20.0 * z.rejects / z.touches))
                    if score > best_score:
                        best, best_score = z, score
    return best


def plan(z, entry_at, pad_ticks, rr):
    entry = (z.p + z.side * z.w if entry_at == "Near edge"
             else z.p - z.side * z.w if entry_at == "Far edge" else z.p)
    stop = z.p - z.side * z.w - z.side * pad_ticks * MINTICK
    risk = abs(entry - stop)
    return entry, stop, risk, entry + z.side * rr * risk


# ── support: zone 20997.5-21002.5, price above ───────────────────────────────
sup = Z(21000, 2.5, 1, 1)
e, s, r, t = plan(sup, "Near edge", 4, 2)
check("support: buy limit at the top edge", e, 21002.5)
check("support: stop below the bottom edge", s, 20996.5)
check("support: risk is 2w + pad", r, 6.0)
check("support: target is 2R above entry", t, 21014.5)
check("support: direction is a BUY", "BUY" if sup.side == 1 else "SELL", "BUY")

# ── resistance mirrors it exactly ────────────────────────────────────────────
res = Z(21000, 2.5, -1, 1)
e, s, r, t = plan(res, "Near edge", 4, 2)
check("resistance: sell limit at the bottom edge", e, 20997.5)
check("resistance: stop above the top edge", s, 21003.5)
check("resistance: risk is 2w + pad", r, 6.0)
check("resistance: target is 2R below entry", t, 20985.5)
check("resistance: direction is a SELL", "BUY" if res.side == 1 else "SELL", "SELL")

# ── entry placement trade-off ────────────────────────────────────────────────
check("middle entry sits on the zone price", plan(sup, "Zone middle", 4, 2)[0], 21000.0)
check("middle entry risk is w + pad", plan(sup, "Zone middle", 4, 2)[2], 3.5)
check("far-edge entry is the far edge", plan(sup, "Far edge", 4, 2)[0], 20997.5)
check("far-edge entry collapses risk to the pad alone",
      plan(sup, "Far edge", 4, 2)[2], 1.0)
check("  ...which on NQ is one point - below noise, hence the tooltip warning",
      plan(sup, "Far edge", 4, 2)[2] <= 1.0, True)

# ── selection ────────────────────────────────────────────────────────────────
far_multi = Z(21300, 2.5, -1, 1 + 4, name="multi far")      # 2 sources, 3 ATR away
near_single = Z(21010, 2.5, -1, 2, name="single near")      # 1 source, 0.1 ATR
check("confluence outranks nearness",
      f_pick([near_single, far_multi], 21000, 100, 5).name, "multi far")
check("  ...and is not merely order-dependent",
      f_pick([far_multi, near_single], 21000, 100, 5).name, "multi far")

a = Z(21050, 2.5, -1, 2, name="nearer")
b = Z(21200, 2.5, -1, 2, name="further")
check("among equals, the nearer zone wins",
      f_pick([b, a], 21000, 100, 5).name, "nearer")

undet = Z(21005, 2.5, 0, 1 + 2 + 4, name="undetermined")
check("an unresolved side is never selected, however much confluence",
      f_pick([undet, a], 21000, 100, 5).name, "nearer")
check("nothing is selected when only unresolved zones exist",
      f_pick([undet], 21000, 100, 5), None)

check("zones beyond the distance cutoff are ignored",
      f_pick([Z(21500, 2.5, -1, 1 + 2 + 4)], 21000, 100, 4), None)
check("an empty set selects nothing", f_pick([], 21000, 100, 5), None)
check("a missing ATR selects nothing", f_pick([a], 21000, None, 5), None)

held = Z(21050, 2.5, -1, 2, touches=4, rejects=4, name="held 4/4")
broken_thru = Z(21050, 2.5, -1, 2, touches=4, rejects=0, name="held 0/4")
check("a level that has held outranks one that has not",
      f_pick([broken_thru, held], 21000, 100, 5).name, "held 4/4")

print(f"\n{sum(T)}/{len(T)} passed")
sys.exit(0 if all(T) else 1)
