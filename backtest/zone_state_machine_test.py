"""Faithful port of the patched touch-loop state machine, for verification."""
TICK = 0.25

class Z:
    def __init__(z, p, w, price, born=1):
        inside = abs(p - price) <= w
        z.p, z.w = p, w
        z.side = 0 if inside else (1 if p < price else -1)
        z.state = 3 if inside else 0
        z.born, z.touches, z.rejects, z.rejected, z.bad, z.outside = born, 0, 0, False, 0, True
        z.gone = False

def step(z, t, o, h, l, c, prev_close):
    """One confirmed bar. Mirrors the patched Pine block exactly."""
    if z.born > t or z.gone:
        return
    ps, pt, pr = z.state, z.touches, z.rejects
    gone = False
    if z.side == 0:
        if c > z.p + z.w:
            z.side, z.outside, z.state = 1, True, 0
        elif c < z.p - z.w:
            z.side, z.outside, z.state = -1, True, 0
    else:
        near = z.p + z.side * z.w
        far = z.p - z.side * z.w
        contact = l <= z.p + z.w and h >= z.p - z.w
        ref = o if z.born == t else prev_close
        approached = (ref - near) * z.side > 0
        if contact and z.outside and approached:
            z.touches += 1; z.outside = False; z.rejected = False; z.state = 1
        if not contact and (c - near) * z.side > z.w:
            z.outside = True
        z.bad = z.bad + 1 if (c - far) * z.side < -TICK else 0
        if z.bad >= 2:
            z.gone = True; gone = True
        elif contact and (c - near) * z.side > 0 and not z.rejected:
            z.rejects += 1; z.rejected = True; z.state = 2
    z.redrew = (not gone) and (z.state != ps or z.touches != pt or z.rejects != pr)

def run(z, bars):
    prev = None
    for t, (o, h, l, c) in enumerate(bars, start=1):
        step(z, t, o, h, l, c, prev); prev = c
    return z

def label(z):
    return "At price" if z.side == 0 else "Fresh" if z.touches == 0 else f"{z.rejects}/{z.touches} held"

T = []
def case(name, z, expect):
    got = (z.side, z.touches, z.rejects, z.gone, label(z))
    ok = got == expect
    T.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        expected {expect}\n        got      {got}")

# --- 1. key level injected at price, resolves up, held twice ---------------
z = Z(100, 1, price=100.0)
assert (z.side, z.state) == (0, 3), "born inside must be undetermined"
run(z, [(100,104,100,104),      # resolves to support
        (104,105,100.5,103),    # touch 1 + rejection 1
        (103,102,100.8,101.5),  # still inside the zone: must NOT recount
        (101.5,105,103,105),    # clears a full width -> outside again
        (105,106,100.2,104)])   # touch 2 + rejection 2
case("key at price -> support, 2 touches, no double count", z, (1, 2, 2, False, "2/2 held"))

# --- 2. the original bug: born inside, true role is resistance -------------
z_old_side = 1 if 100 < 100.2 else -1
assert z_old_side == 1, "old code would have called this support"
z = Z(100, 1, price=100.2)
run(z, [(100.2,100.5,97,97.5),  # resolves DOWN -> resistance (old code: bad=1)
        (97.5,98,96,97),        # clear below
        (97,100.5,98,99.2),     # touch 1, closes into zone -> no rejection
        (99.2,99.5,98,98.5)])   # closes back below near edge -> rejection 1
case("born inside, resolves to resistance (was mislabelled broken support)",
     z, (-1, 1, 1, False, "1/1 held"))

# --- 3. genuine break still retires after 2 closes beyond far --------------
z = Z(100, 1, price=105)
run(z, [(105,105,100.5,103),    # touch 1 + rejection
        (103,103,98,98.5),      # bad = 1
        (98.5,99,97,98)])       # bad = 2 -> gone
case("support breaks on two closes below far edge", z, (1, 1, 1, True, "1/1 held"))

# --- 4. no redraw emitted on the bar a zone is retired --------------------
z = Z(100, 1, price=105)
run(z, [(105,105,100.5,103)])
step(z, 2, 103,103,98,98.5, 103); b1 = z.redrew
step(z, 3, 98.5,99,97,98, 98.5); b2 = z.redrew
T.append(z.gone and not b2)
print(f"{'PASS' if z.gone and not b2 else 'FAIL'}  retirement bar emits no segment redraw (would draw a dead zone)")

# --- 5. price never leaves the zone: stays undetermined, never breaks ------
z = Z(100, 1, price=100)
run(z, [(100,100.5,99.5,100.2)]*8)
case("price camps inside: stays undetermined, never falsely broken",
     z, (0, 0, 0, False, "At price"))

# --- 6. touch without rejection (closes through into the zone) ------------
z = Z(100, 1, price=105)
run(z, [(105,105,100.5,100.5)])   # contact, closes AT/below near edge
case("touch that does not reject counts 0/1", z, (1, 1, 0, False, "0/1 held"))

print()
print(f"{sum(T)}/{len(T)} passed")
raise SystemExit(0 if all(T) else 1)
