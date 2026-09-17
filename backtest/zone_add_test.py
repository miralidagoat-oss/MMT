"""Port of patched f_add: eviction, merge, and the new placed return."""
import random
has = lambda mask, bit: (mask // bit) % 2 == 1
n_sources = lambda m: sum(1 for b in (1, 2, 4, 8) if has(m, b))

class Zn:
    def __init__(s, p, w, src): s.p, s.w, s.sources = p, w, src
    def __repr__(s): return f"({s.p},src{s.sources})"

def f_add(zones, p, w, source, price, maxZones):
    placed = False
    merged = False
    for z in zones:
        # One test, not two: an overlapping level contributes its source even
        # when its centre falls outside the existing zone.
        if not merged and abs(p - z.p) < w + z.w:
            if not has(z.sources, source): z.sources += source
            merged = True; placed = True
    if not merged:
        if len(zones) >= maxZones:
            farIndex, farDistance = 0, -1
            for j, z in enumerate(zones):
                dist = abs(z.p - price)
                if dist > farDistance and (source != 4 or not has(z.sources, 4)):
                    farIndex, farDistance = j, dist
            if farDistance > abs(p - price) or (source == 4 and farDistance >= 0):
                zones.pop(farIndex)
            else:
                merged = True          # no room: dropped
        if not merged:
            zones.append(Zn(p, w, source)); placed = True
    return placed

T = []
def case(name, got, want):
    ok = got == want; T.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   expected {want}, got {got}"))

z = []
case("add into empty",              f_add(z, 100, 1, 1, 105, 8), True)
case("overlapping merge",           f_add(z, 100.5, 1, 2, 105, 8), True)
case("  ...merged source bits",     z[0].sources, 3)

# the case the old two-branch merge lost: overlapping, centre outside
z = [Zn(100, 1, 2)]                       # swing zone spanning 99-101
case("overlapping level is absorbed", f_add(z, 101.5, 1, 4, 100, 8), True)
case("  ...and its source is recorded (was silently discarded)", z[0].sources, 6)
case("  ...so it counts as two-source confluence", n_sources(z[0].sources), 2)
case("  ...and no second zone is created", len(z), 1)

# a level clear of every zone still creates its own
z = [Zn(100, 1, 2)]
case("a level clear of the zone creates its own", f_add(z, 110, 1, 4, 100, 8), True)
case("  ...as a separate zone", len(z), 2)

# swing cap: newest first, capped
def seed(zones, swings, w, price, max_swings, max_zones):
    seeded = 0
    for j in range(len(swings)):
        k = len(swings) - 1 - j
        if seeded < max_swings and f_add(zones, swings[k], w, 2, price, max_zones):
            seeded += 1
    return seeded

z = []
swings = [100 + 10 * i for i in range(8)]          # oldest .. newest
case("swing seeding stops at the cap", seed(z, swings, 1, 200, 4, 12), 4)
case("  ...and keeps the newest four", sorted(x.p for x in z), [140, 150, 160, 170])

# full of non-key zones, a key level arrives -> must evict, never drop
z = [Zn(100 + 10*i, 1, 1) for i in range(4)]
case("key evicts farthest non-key when full", f_add(z, 101.5, 1, 4, 100, 4), True)

# full of KEY zones, another key level arrives -> no eviction candidate
z = [Zn(100 + 10*i, 1, 4) for i in range(4)]
before = list(z)
placed = f_add(z, 205, 1, 4, 100, 4)
case("key dropped when every slot is already a key level", placed, False)
case("  ...and nothing was evicted", z, before)

# full, new non-key level farther than everything -> dropped
z = [Zn(100 + i, 1, 1) for i in range(4)]
case("distant non-key level dropped when full", f_add(z, 500, 1, 2, 100, 4), False)
# full, new non-key level nearer than the farthest -> evicts
z = [Zn(100 + 10*i, 1, 1) for i in range(4)]
case("nearer non-key level evicts the farthest", f_add(z, 101.5, 1, 2, 100, 4), True)

# the parenthesisation must be a pure no-op (and binds tighter than or)
mismatch = 0
for _ in range(200000):
    fd, d, src = random.uniform(-1, 50), random.uniform(0, 50), random.choice([1, 2, 4, 8])
    if (fd > d or src == 4 and fd >= 0) != (fd > d or (src == 4 and fd >= 0)): mismatch += 1
case("parenthesising the eviction test changes nothing", mismatch, 0)

print(f"\n{sum(T)}/{len(T)} passed")
raise SystemExit(0 if all(T) else 1)
