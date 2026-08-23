#!/usr/bin/env python3
"""Hypothesis battery for MNQ 5-minute intraday structure.

Design principles (the point of this file is to FAIL honestly):

  * Every feature is computable from information available strictly BEFORE the
    return it is asked to predict. Feature bars and target bars never overlap.
  * t-statistics use Newey-West HAC; raw t-stats overstate significance on
    overlapping / autocorrelated intraday samples.
  * Every number is reported in basis points of the index, so it can be
    compared directly against the cost hurdle (1.5 index points at NDX 29,500
    = 0.51 bp round turn; the harness converts per-session).
  * The number of hypotheses tested is counted and a Benjamini-Hochberg FDR
    correction is applied at the end. A t of 2.0 means nothing when you tested
    40 things.
  * Train/test is a single chronological split with an embargo gap, never a
    re-optimised walk-forward, so the test half stays genuinely untouched.

Usage:
  python3 research5m.py <csv> [label]
"""
import sys
import math
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import (load, is_rth, et_parts, mean, stdev, newey_west_t, pct,
                   RTH_OPEN, RTH_CLOSE)          # noqa: E402

BP = 1e4


# ── session construction ─────────────────────────────────────────────────────
class Session:
    """One RTH trading day plus the overnight run-up that preceded it."""
    __slots__ = ("date", "idx", "mins", "o", "h", "l", "c", "v",
                 "prev_close", "on_high", "on_low", "on_bars")

    def __init__(self, date):
        self.date = date
        self.idx, self.mins = [], []
        self.o, self.h, self.l, self.c, self.v = [], [], [], [], []
        self.prev_close = None
        self.on_high = self.on_low = None
        self.on_bars = 0

    def bar_at(self, minute):
        """Index into this session's arrays for an ET minute-of-day, or None."""
        try:
            return self.mins.index(minute)
        except ValueError:
            return None

    def ret_bp(self, i0, i1):
        """Return from close[i0] to close[i1] in bp."""
        if i0 is None or i1 is None or i0 >= len(self.c) or i1 >= len(self.c):
            return None
        return (self.c[i1] / self.c[i0] - 1.0) * BP


def build_sessions(b, min_bars=60):
    """Group bars into RTH sessions, attaching the prior overnight window."""
    by_day = defaultdict(list)
    overnight = defaultdict(list)
    for i in range(b.n):
        d, hh, mm, wd, tot = b.et[i]
        if wd >= 5 and not (wd == 6):
            continue
        if RTH_OPEN <= tot < RTH_CLOSE and wd < 5:
            by_day[d].append(i)
        else:
            # attribute pre-open bars to the NEXT rth date
            key = d if tot < RTH_OPEN else None
            if key is not None:
                overnight[key].append(i)

    out = []
    prev_rth_close = None
    for d in sorted(by_day):
        ids = by_day[d]
        if len(ids) < min_bars:
            prev_rth_close = b.c[ids[-1]] if ids else prev_rth_close
            continue
        s = Session(d)
        s.idx = ids
        s.mins = [b.et[i][4] for i in ids]
        s.o = [b.o[i] for i in ids]
        s.h = [b.h[i] for i in ids]
        s.l = [b.l[i] for i in ids]
        s.c = [b.c[i] for i in ids]
        s.v = [b.v[i] for i in ids]
        s.prev_close = prev_rth_close
        on = overnight.get(d, [])
        s.on_bars = len(on)
        if on:
            s.on_high = max(b.h[i] for i in on)
            s.on_low = min(b.l[i] for i in on)
        out.append(s)
        prev_rth_close = s.c[-1]
    return out


# ── result plumbing ──────────────────────────────────────────────────────────
class Test:
    def __init__(self, name, xs, family, note=""):
        self.name, self.family, self.note = name, family, note
        self.xs = [x for x in xs if x is not None and not math.isnan(x)]
        self.n = len(self.xs)
        self.mean = mean(self.xs) if self.n else float("nan")
        self.sd = stdev(self.xs) if self.n > 1 else float("nan")
        self.t = newey_west_t(self.xs, lags=5) if self.n > 10 else float("nan")

    @property
    def p(self):
        if math.isnan(self.t):
            return float("nan")
        # two-sided normal approximation
        z = abs(self.t)
        return math.erfc(z / math.sqrt(2))

    def hit(self):
        return 100.0 * sum(1 for x in self.xs if x > 0) / self.n if self.n else float("nan")


def bh_fdr(tests, alpha=0.10):
    """Benjamini-Hochberg: return the set of names surviving FDR control."""
    valid = [t for t in tests if not math.isnan(t.p)]
    m = len(valid)
    if not m:
        return set(), m
    ranked = sorted(valid, key=lambda t: t.p)
    survivors = set()
    for k, t in enumerate(ranked, start=1):
        if t.p <= alpha * k / m:
            survivors = {r.name for r in ranked[:k]}
    return survivors, m


def report(tests, cost_bp, title):
    print(f"\n{'='*100}\n{title}\n{'='*100}")
    surv, m = bh_fdr(tests)
    hdr = (f"{'hypothesis':<44}{'n':>5}{'mean_bp':>9}{'t_NW':>7}"
           f"{'p':>8}{'hit%':>7}{'net_bp':>8}  flag")
    print(hdr)
    print("-" * len(hdr))
    for t in tests:
        if t.n == 0:
            print(f"{t.name:<44}{'--- no observations ---':>40}")
            continue
        net = t.mean - cost_bp   # signed: hypothesis direction is pre-specified
        flag = []
        if t.name in surv:
            flag.append("FDR-OK")
        if abs(t.t) >= 2.0:
            flag.append("t>2")
        if net > 0:
            flag.append("NET+")
        print(f"{t.name:<44}{t.n:>5}{t.mean:>9.2f}{t.t:>7.2f}"
              f"{t.p:>8.3f}{t.hit():>7.1f}{net:>8.2f}  {','.join(flag) or '-'}")
    print(f"\n{m} hypotheses tested; BH-FDR at 10% keeps {len(surv)}: "
          f"{sorted(surv) if surv else 'NONE'}")
    print(f"cost hurdle used: {cost_bp:.2f} bp round turn")
    return surv


# ── the hypothesis battery ───────────────────────────────────────────────────
def battery(sessions, label=""):
    """Every test here predicts a FORWARD window from a STRICTLY PRIOR one."""
    T = []

    def add(name, xs, family, note=""):
        T.append(Test(name, xs, family, note))

    # ---- A. intraday momentum (Gao et al. 2018 family) ----
    # first 30m return -> last 30m return, signed by the first-30m direction
    for (fm, fl, tag) in ((RTH_OPEN + 30, RTH_CLOSE - 30, "30m"),
                          (RTH_OPEN + 60, RTH_CLOSE - 30, "60m")):
        xs = []
        for s in sessions:
            i0, i1 = s.bar_at(RTH_OPEN), s.bar_at(fm)
            j0, j1 = s.bar_at(fl), len(s.c) - 1
            r_first = s.ret_bp(i0, i1)
            r_last = s.ret_bp(j0, j1)
            if r_first is None or r_last is None:
                continue
            xs.append(math.copysign(1.0, r_first) * r_last)
        add(f"A1 intraday-mom {tag}first -> last30m", xs, "A")

    # overnight return -> last 30m (the variant that decayed in the literature)
    xs = []
    for s in sessions:
        if s.prev_close is None:
            continue
        r_on = (s.c[0] / s.prev_close - 1.0) * BP
        r_last = s.ret_bp(s.bar_at(RTH_CLOSE - 30), len(s.c) - 1)
        if r_last is None:
            continue
        xs.append(math.copysign(1.0, r_on) * r_last)
    add("A2 overnight-sign -> last30m", xs, "A")

    # first 30m -> rest of day
    xs = []
    for s in sessions:
        r_first = s.ret_bp(s.bar_at(RTH_OPEN), s.bar_at(RTH_OPEN + 30))
        r_rest = s.ret_bp(s.bar_at(RTH_OPEN + 30), len(s.c) - 1)
        if r_first is None or r_rest is None:
            continue
        xs.append(math.copysign(1.0, r_first) * r_rest)
    add("A3 first30m-sign -> rest of day", xs, "A")

    # ---- B. opening-range breakout ----
    for orm in (15, 30, 60):
        xs = []
        for s in sessions:
            k = s.bar_at(RTH_OPEN + orm)
            if k is None or k >= len(s.c) - 6:
                continue
            orh, orl = max(s.h[:k]), min(s.l[:k])
            if orh <= orl:
                continue
            # first touch after the OR window decides direction; hold to close
            direction = 0
            for j in range(k, len(s.c)):
                if s.h[j] >= orh:
                    direction, entry = 1, orh
                    break
                if s.l[j] <= orl:
                    direction, entry = -1, orl
                    break
            if direction == 0:
                continue
            xs.append(direction * (s.c[-1] / entry - 1.0) * BP)
        add(f"B1 OR{orm}m breakout -> close", xs, "B")

    # ---- C. short-horizon reversal on 5m bars (all RTH bars pooled) ----
    for lag in (1, 3, 6):
        xs = []
        for s in sessions:
            for i in range(lag, len(s.c) - lag):
                prev = (s.c[i] / s.c[i - lag] - 1.0) * BP
                fwd = (s.c[i + lag] / s.c[i] - 1.0) * BP
                if prev == 0:
                    continue
                # negative sign => reversal pays
                xs.append(-math.copysign(1.0, prev) * fwd)
        add(f"C1 reversal {lag*5}m -> next {lag*5}m", xs, "C")

    # ---- D. last-hour drift & close auction ----
    for start, tag in ((RTH_CLOSE - 60, "last60m"), (RTH_CLOSE - 15, "last15m")):
        xs = []
        for s in sessions:
            r = s.ret_bp(s.bar_at(start), len(s.c) - 1)
            if r is not None:
                xs.append(r)
        add(f"D1 unconditional long {tag}", xs, "D")

    # ---- E. overnight vs RTH decomposition ----
    xs_on, xs_rth = [], []
    for s in sessions:
        if s.prev_close is not None:
            xs_on.append((s.c[0] / s.prev_close - 1.0) * BP)
        xs_rth.append((s.c[-1] / s.c[0] - 1.0) * BP)
    add("E1 overnight (prev close -> open)", xs_on, "E")
    add("E2 RTH (open -> close)", xs_rth, "E")

    # ---- F. gap continuation / fade ----
    xs = []
    for s in sessions:
        if s.prev_close is None:
            continue
        gap = (s.c[0] / s.prev_close - 1.0) * BP
        if abs(gap) < 10:                     # only meaningful gaps
            continue
        rth = (s.c[-1] / s.c[0] - 1.0) * BP
        xs.append(-math.copysign(1.0, gap) * rth)   # positive => fading pays
    add("F1 fade gap>10bp -> RTH close", xs, "F")

    return T


def main():
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else path.rsplit("/", 1)[-1]
    b = load(path)
    sessions = build_sessions(b)
    if not sessions:
        print("no complete RTH sessions found")
        return
    px = mean([s.c[0] for s in sessions])
    cost_bp = 1.5 / px * BP
    print(f"{label}: {b.n} bars, {len(sessions)} RTH sessions, "
          f"{sessions[0].date} .. {sessions[-1].date}")
    print(f"mean index level {px:.0f}  ->  1.5pt round turn = {cost_bp:.3f} bp")

    # chronological split with a 5-session embargo
    cut = int(len(sessions) * 0.70)
    emb = 5
    train, test = sessions[:cut], sessions[cut + emb:]

    report(battery(sessions), cost_bp, f"[{label}] FULL SAMPLE (in-sample, for reference only)")
    surv_tr = report(battery(train), cost_bp, f"[{label}] TRAIN (first 70%, n={len(train)})")
    report(battery(test), cost_bp,
           f"[{label}] TEST (last 30%, untouched, n={len(test)}) "
           f"— survivors of train were: {sorted(surv_tr) if surv_tr else 'NONE'}")


if __name__ == "__main__":
    main()
