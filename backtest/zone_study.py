#!/usr/bin/env python3
"""Measure how often QT Reversal Zones actually hold, per source and session.

The indicator draws zones and labels their state, but it has never graded
them - exactly the gap the README calls out about Alpha Matrix v1. This
ports the zone engine from indicators/qt_reversal_zones.pine and attaches a
fixed-horizon outcome to every touch, so "chance of reversal" becomes a
measured rate with a confidence interval instead of an impression.

Why the indicator's own labels cannot be counted
------------------------------------------------
Its "Rejected" state is one 5-minute close back on the approach side. Price
can print that and break on the next bar, so Rejected and Broken are
sequential snapshots of the same touch, not outcomes. Counting them gives a
rate above 100%. Each touch here is instead followed forward until one of
three terminal states is reached.

Outcome labelling, per touch
----------------------------
From the touch bar, walk forward up to `horizon` bars:
  HOLD    price trades `target` x ATR clear of the near edge, on the side it
          approached from, before breaking
  BREAK   two consecutive closes beyond the far edge
  TIMEOUT neither happens inside the horizon
Ambiguity is resolved against the zone, matching the pessimism of the
existing fill model: the break is tested first on every bar, so a bar that
both completes a break and reaches the target books a break.

A second, tradeable framing runs alongside it: fade the level at the near
edge with the stop beyond the far edge, and race target against stop with
the stop winning any bar that contains both. That yields a win rate and
expectancy in R directly comparable to the README's tables.

Outcomes are measured on the raw bar series, independently of the zone's
own lifecycle, so a zone the engine retires or a block deadline that
expires does not truncate the label and bias the rate.

Usage
-----
  python3 zone_study.py data/MNQ_5m.csv
  python3 zone_study.py data/MNQ_5m.csv --horizon 24 --target 1.0 --rr 2
  python3 zone_study.py data/*.csv --dump touches.csv
  python3 zone_study.py data/MNQ_5m.csv --key-file keys.txt --offset 0

Input CSV is what backtest/fetch_yahoo.py writes: time,open,high,low,close,
volume with time in Unix seconds. Note Yahoo caps 5m history near 60 days,
which is a few hundred touches pooled - enough for a pooled rate, not enough
to split every bucket. Bucket sample sizes are printed so thin cells are
visible rather than implied.
"""
import argparse
import csv
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

CA = ZoneInfo("America/Los_Angeles")
MINTICK = 0.25

# source bits, mirroring the indicator
SRC_NY_HIGH, SRC_SWING, SRC_KEY, SRC_NY_LOW = 1, 2, 4, 8
SRC_NAME = {SRC_NY_HIGH: "NY high", SRC_SWING: "Swing",
            SRC_KEY: "Key 4/5", SRC_NY_LOW: "NY low"}


# ── data ─────────────────────────────────────────────────────────────────────

@dataclass
class Bars:
    t: list
    o: list
    h: list
    l: list
    c: list

    def __len__(self):
        return len(self.t)


def load(path):
    t, o, h, l, c = [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            t.append(int(float(row["time"])))
            o.append(float(row["open"]))
            h.append(float(row["high"]))
            l.append(float(row["low"]))
            c.append(float(row["close"]))
    return Bars(t, o, h, l, c)


# ── indicator port: ATR, widths, sessions ────────────────────────────────────

def atr14(b, n=14):
    """Wilder RMA of true range, seeded with the SMA of the first n, as ta.atr."""
    tr = [b.h[0] - b.l[0]]
    for i in range(1, len(b)):
        tr.append(max(b.h[i] - b.l[i], abs(b.h[i] - b.c[i - 1]),
                      abs(b.l[i] - b.c[i - 1])))
    out = [None] * len(tr)
    if len(tr) < n:
        return out
    seed = sum(tr[:n]) / n
    out[n - 1] = seed
    for i in range(n, len(tr)):
        out[i] = (out[i - 1] * (n - 1) + tr[i]) / n
    return out


def to_mintick(x):
    return round(x / MINTICK) * MINTICK


def half_width(atr, nq=True):
    if atr is None:
        return None
    lo, hi = (2.0, 6.0) if nq else (0.5, 1.5)
    return to_mintick(max(lo, min(hi, atr * 0.12)))


def ca_time(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(CA)


def session_of(ts, use_ny=True, use_asia=True):
    d = ca_time(ts)
    m = d.hour * 60 + d.minute
    if use_ny and 360 <= m < 835:
        return "NY"
    if use_asia and 900 <= m < 1140:
        return "ASIA"
    return None


def block_of(ts, **kw):
    """Block identity: California calendar date plus session, matching dateKey."""
    s = session_of(ts, **kw)
    return None if s is None else (ca_time(ts).strftime("%Y%m%d"), s)


def deadline_of(ts):
    d = ca_time(ts)
    s = session_of(ts)
    end = d.replace(hour=13, minute=55, second=0, microsecond=0) if s == "NY" \
        else d.replace(hour=19, minute=0, second=0, microsecond=0)
    return int(end.timestamp())


# ── zone engine, mirroring the patched Pine ──────────────────────────────────

@dataclass
class Zone:
    p: float
    w: float
    side: int
    born: int
    until: int
    sources: int
    touches: int = 0
    rejects: int = 0
    rejected: bool = False
    bad: int = 0
    outside: bool = True
    resolved_at: int = None      # bar index where an undetermined side settled


def has(mask, bit):
    return (mask // bit) % 2 == 1


def n_sources(mask):
    return sum(1 for b in (1, 2, 4, 8) if has(mask, b))


@dataclass
class Touch:
    i: int                  # bar index of the touch
    ts: int
    zone_p: float
    zone_w: float
    side: int
    near: float
    far: float
    sources: int
    session: str
    atr: float
    outcome: str = None     # HOLD / BREAK / TIMEOUT
    bars_to: int = None
    r: float = None         # R booked by the fade framing
    fade: str = None        # TARGET / STOP / OPEN


class Engine:
    """Zone set for one chart, driven bar by bar."""

    def __init__(self, max_zones=8, use_swings=True, nq=True):
        self.max_zones = max_zones
        self.use_swings = use_swings
        self.nq = nq
        self.zones = []
        self.touches = []
        self.created = 0
        self.dropped = 0

    def add(self, p, w, source, when, price, scale, until):
        """Port of f_add. Returns True when the level is represented."""
        if p is None or w is None or scale is None or p <= 0 or when >= until:
            return False
        if source != SRC_KEY and not (w < abs(p - price) <= 12 * scale):
            return False
        placed = False
        merged = False
        for z in self.zones:
            if not merged and abs(p - z.p) <= z.w:
                if not has(z.sources, source):
                    z.sources += source
                merged = placed = True
            elif not merged and abs(p - z.p) < w + z.w:
                merged = placed = True
        if not merged:
            if len(self.zones) >= self.max_zones:
                far_i, far_d = 0, -1
                for j, z in enumerate(self.zones):
                    d = abs(z.p - price)
                    if d > far_d and (source != SRC_KEY or not has(z.sources, SRC_KEY)):
                        far_i, far_d = j, d
                if far_d > abs(p - price) or (source == SRC_KEY and far_d >= 0):
                    self.zones.pop(far_i)
                else:
                    merged = True
            if not merged:
                inside = abs(p - price) <= w
                self.zones.append(Zone(
                    p=p, w=w, side=0 if inside else (1 if p < price else -1),
                    born=when, until=until, sources=source))
                self.created += 1
                placed = True
        if not placed:
            self.dropped += 1
        return placed

    def step(self, b, i, session, atr):
        """Port of the confirmed-bar touch loop. Emits Touch records."""
        o, h, l, c, t = b.o[i], b.h[i], b.l[i], b.c[i], b.t[i]
        for j in range(len(self.zones) - 1, -1, -1):
            z = self.zones[j]
            if z.born > t:
                continue
            if z.side == 0:
                if c > z.p + z.w:
                    z.side, z.outside, z.resolved_at = 1, True, i
                elif c < z.p - z.w:
                    z.side, z.outside, z.resolved_at = -1, True, i
                continue
            near = z.p + z.side * z.w
            far = z.p - z.side * z.w
            contact = l <= z.p + z.w and h >= z.p - z.w
            ref = o if z.born == t else b.c[i - 1]
            approached = (ref - near) * z.side > 0
            if contact and z.outside and approached:
                z.touches += 1
                z.outside = False
                z.rejected = False
                self.touches.append(Touch(
                    i=i, ts=t, zone_p=z.p, zone_w=z.w, side=z.side,
                    near=near, far=far, sources=z.sources,
                    session=session, atr=atr))
            if not contact and (c - near) * z.side > z.w:
                z.outside = True
            z.bad = z.bad + 1 if (c - far) * z.side < -MINTICK else 0
            if z.bad >= 2:
                self.zones.pop(j)
            elif contact and (c - near) * z.side > 0 and not z.rejected:
                z.rejects += 1
                z.rejected = True


# ── outcome labelling ────────────────────────────────────────────────────────

def label(b, tc, horizon, target_mult, rr, stop_pad_ticks):
    """Walk forward from the touch and attach both framings."""
    side, near, far, atr = tc.side, tc.near, tc.far, tc.atr
    target = near + side * target_mult * atr
    stop = far - side * stop_pad_ticks * MINTICK
    risk = abs(near - stop)
    fade_target = near + side * rr * risk

    beyond = 0
    tc.outcome, tc.fade = "TIMEOUT", "OPEN"
    for k in range(tc.i + 1, min(tc.i + 1 + horizon, len(b))):
        hi, lo, c = b.h[k], b.l[k], b.c[k]
        # break tested first: a bar that does both books the break
        beyond = beyond + 1 if (c - far) * side < -MINTICK else 0
        broke = beyond >= 2
        hit_target = (hi - target) >= 0 if side == 1 else (target - lo) >= 0
        if tc.outcome == "TIMEOUT":
            if broke:
                tc.outcome, tc.bars_to = "BREAK", k - tc.i
            elif hit_target:
                tc.outcome, tc.bars_to = "HOLD", k - tc.i
        if tc.fade == "OPEN":
            # stop wins any bar containing both
            hit_stop = (lo - stop) <= 0 if side == 1 else (stop - hi) <= 0
            hit_ft = (hi - fade_target) >= 0 if side == 1 else (fade_target - lo) >= 0
            if hit_stop:
                tc.fade, tc.r = "STOP", -1.0
            elif hit_ft:
                tc.fade, tc.r = "TARGET", float(rr)
        if tc.outcome != "TIMEOUT" and tc.fade != "OPEN":
            break
    if tc.fade == "OPEN":
        k = min(tc.i + horizon, len(b) - 1)
        tc.r = side * (b.c[k] - near) / risk if risk else 0.0
    return tc


# ── statistics ───────────────────────────────────────────────────────────────

def wilson(k, n, z=1.96):
    """Wilson score interval - honest at the small n these buckets produce."""
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (p, max(0.0, centre - half), min(1.0, centre + half))


def bucket_name(sources):
    if n_sources(sources) > 1:
        return "Multi-source"
    for bit, name in SRC_NAME.items():
        if has(sources, bit):
            return name
    return "?"


def summarise(touches, title, min_n):
    rows = []
    groups = {"ALL": touches}
    for t in touches:
        groups.setdefault(bucket_name(t.sources), []).append(t)
        groups.setdefault(f"session {t.session}", []).append(t)
    order = ["ALL"] + sorted(k for k in groups if k != "ALL")
    for name in order:
        g = groups[name]
        n = len(g)
        holds = sum(1 for t in g if t.outcome == "HOLD")
        breaks = sum(1 for t in g if t.outcome == "BREAK")
        outs = sum(1 for t in g if t.outcome == "TIMEOUT")
        decided = holds + breaks
        p, lo, hi = wilson(holds, decided)
        wins = sum(1 for t in g if t.fade == "TARGET")
        closed = sum(1 for t in g if t.fade in ("TARGET", "STOP"))
        net_r = sum(t.r for t in g)
        rows.append((name, n, holds, breaks, outs, decided, p, lo, hi,
                     wins, closed, net_r / n if n else 0.0))
    print(f"\n{title}")
    print(f"{'bucket':<15}{'touch':>6}{'hold':>6}{'brk':>5}{'t/o':>5}"
          f"{'hold rate':>11}{'95% CI':>16}{'fade WR':>9}{'R/touch':>9}")
    print("-" * 82)
    for (name, n, ho, br, to, dec, p, lo, hi, w, cl, rpt) in rows:
        flag = "" if dec >= min_n else "  <- thin"
        rate = f"{p*100:>9.1f}%" if dec else f"{'n/a':>10}"
        ci = f"[{lo*100:>4.1f}, {hi*100:>4.1f}]" if dec else f"{'':>16}"
        wr = f"{w/cl*100:>7.1f}%" if cl else f"{'n/a':>8}"
        print(f"{name:<15}{n:>6}{ho:>6}{br:>5}{to:>5}{rate}{ci:>16}{wr}"
              f"{rpt:>9.3f}{flag}")


# ── driver ───────────────────────────────────────────────────────────────────

def study(b, args, keys=None):
    nq = args.contract == "nq"
    atr = atr14(b)
    eng = Engine(max_zones=args.max_zones, use_swings=not args.no_swings, nq=nq)

    cur_block = None
    ny_hi = ny_lo = None
    ny_bars = 0
    done_hi = done_lo = done_at = None
    swings = []          # (price, ts)
    key_added = set()

    for i in range(len(b)):
        t, o, h, l, c = b.t[i], b.o[i], b.h[i], b.l[i], b.c[i]
        sess = session_of(t, use_ny=not args.no_ny, use_asia=not args.no_asia)
        blk = block_of(t, use_ny=not args.no_ny, use_asia=not args.no_asia)
        d = ca_time(t)
        m = d.hour * 60 + d.minute

        if blk != cur_block:
            cur_block = blk
            eng.zones.clear()
            if sess and i > 0 and atr[i - 1] is not None:
                w = half_width(atr[i - 1], nq)
                dl = deadline_of(t)
                if done_at is not None and t - done_at <= 5 * 86400:
                    eng.add(done_hi, w, SRC_NY_HIGH, t, o, atr[i - 1], dl)
                    eng.add(done_lo, w, SRC_NY_LOW, t, o, atr[i - 1], dl)
                if not args.no_swings:
                    for p, sts in reversed(swings):
                        if t - sts <= 86400:
                            eng.add(p, w, SRC_SWING, t, o, atr[i - 1], dl)
                if keys and blk[0] in keys and blk not in key_added:
                    key_added.add(blk)
                    for lvl in keys[blk[0]]:
                        eng.add(to_mintick(lvl + args.offset), w, SRC_KEY,
                                t, o, atr[i - 1], dl)

        if sess and atr[i] is not None:
            eng.step(b, i, sess, atr[i])

        # New York RTH range, 06:30-13:00 CA, captured on the 12:55 bar
        if m == 390:
            ny_hi = ny_lo = None
            ny_bars = 0
        if 390 <= m < 780:
            ny_hi = h if ny_hi is None else max(ny_hi, h)
            ny_lo = l if ny_lo is None else min(ny_lo, l)
            ny_bars += 1
            if m == 775 and ny_bars >= 75:
                done_hi, done_lo, done_at = ny_hi, ny_lo, t

        # 5-bar fractal centred at i-2, confirmed here
        if not args.no_swings and i >= 4 and atr[i] is not None:
            if b.t[i] - b.t[i - 4] == 20 * 60:
                win_h = b.h[i - 4:i + 1]
                win_l = b.l[i - 4:i + 1]
                piv_h, piv_l = b.h[i - 2], b.l[i - 2]
                ph = piv_h == max(win_h) and win_h.count(piv_h) == 1 \
                    and piv_h - min(win_l) >= 0.75 * atr[i]
                pl = piv_l == min(win_l) and win_l.count(piv_l) == 1 \
                    and max(win_h) - piv_l >= 0.75 * atr[i]
                for on, p in ((ph, piv_h), (pl, piv_l)):
                    if not on:
                        continue
                    swings.append((p, t))
                    del swings[:-8]
                    if sess and t < deadline_of(t):
                        eng.add(p, half_width(atr[i], nq), SRC_SWING,
                                t, c, atr[i], deadline_of(t))

    for tc in eng.touches:
        label(b, tc, args.horizon, args.target, args.rr, args.stop_pad)
    return eng


def load_keys(path, tag):
    """Parse the daily key file with the same rules the indicator applies."""
    out = {}
    raw = open(path).read().replace("\r", "").replace("\n", ";")
    for row in raw.split(";"):
        row = row.strip()
        if not row:
            continue
        f = [x.strip() for x in row.split(",")]
        if len(f) not in (25, 26) or f[0] != tag:
            continue
        if len(f[1]) != 8 or not f[1].isdigit():
            continue
        try:
            r5, r4 = float(f[9]), float(f[12])
        except ValueError:
            continue
        if r5 > 0 and r4 > 0:
            out[f[1]] = (r5, r4)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="+", help="5m OHLC CSV(s) from fetch_yahoo.py")
    ap.add_argument("--contract", default="nq", choices=["nq", "es"])
    ap.add_argument("--horizon", type=int, default=12,
                    help="bars to follow a touch (default 12 = 1 hour)")
    ap.add_argument("--target", type=float, default=0.75,
                    help="HOLD threshold, in ATR clear of the near edge")
    ap.add_argument("--rr", type=float, default=2.0,
                    help="reward:risk for the fade framing")
    ap.add_argument("--stop-pad", type=float, default=4,
                    help="ticks beyond the far edge for the fade stop")
    ap.add_argument("--max-zones", type=int, default=8)
    ap.add_argument("--min-n", type=int, default=30,
                    help="decided touches below which a bucket is flagged thin")
    ap.add_argument("--no-swings", action="store_true")
    ap.add_argument("--no-ny", action="store_true")
    ap.add_argument("--no-asia", action="store_true")
    ap.add_argument("--key-file", help="daily key rows, 25/26 columns")
    ap.add_argument("--offset", type=float, default=0.0,
                    help="cash-to-futures offset added to key levels")
    ap.add_argument("--dump", help="write every touch to this CSV")
    args = ap.parse_args()

    keys = load_keys(args.key_file, args.contract.upper()) if args.key_file else None
    if args.key_file:
        print(f"key rows loaded: {len(keys)}")

    pooled = []
    for path in args.csv:
        b = load(path)
        if len(b) < 100:
            print(f"{path}: only {len(b)} bars, skipped")
            continue
        eng = study(b, args, keys)
        span = f"{ca_time(b.t[0]):%Y-%m-%d} to {ca_time(b.t[-1]):%Y-%m-%d}"
        print(f"\n=== {os.path.basename(path)}  {len(b)} bars  {span} ===")
        print(f"zones created {eng.created}, dropped for want of a slot "
              f"{eng.dropped}, touches {len(eng.touches)}")
        summarise(eng.touches, f"{os.path.basename(path)} - touch outcomes",
                  args.min_n)
        pooled += eng.touches

    if len(args.csv) > 1:
        summarise(pooled, "POOLED - touch outcomes", args.min_n)

    print(f"\nhorizon {args.horizon} bars, HOLD at {args.target} ATR clear, "
          f"fade at {args.rr}:1 with a {args.stop_pad}-tick stop pad.")
    print("Breaks are tested before targets, so an ambiguous bar books against "
          "the zone.")

    if args.dump:
        with open(args.dump, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["time", "session", "source", "side", "zone_low",
                        "zone_high", "atr", "outcome", "bars_to", "fade", "r"])
            for t in pooled or []:
                w.writerow([ca_time(t.ts).isoformat(), t.session,
                            bucket_name(t.sources), t.side,
                            round(t.zone_p - t.zone_w, 2),
                            round(t.zone_p + t.zone_w, 2), round(t.atr, 2),
                            t.outcome, t.bars_to, t.fade,
                            None if t.r is None else round(t.r, 3)])
        print(f"wrote {args.dump}")


if __name__ == "__main__":
    main()
