"""Bar-by-bar replica of indicators/onr_book.pine, for offline backtests.

Conventions
- Bars: t = bar OPEN time in New York wall-clock minutes since 1970-01-01, plus o/h/l/c; tf = bar length (minutes).
- Session minute s = minutes since 18:00 ET; session id = day number of (t + 6 h) -> same as the Pine sessT rule.
- An event at session minute m fires on the FIRST bar of the session whose close (s + tf) is >= m  (Pine f_hit).
- Fills follow the Pine script exactly: market entries at the event bar's close; stops fill at the stop (or the bar
  open if it gapped through); targets need a 1-tick trade-through and fill at the target; stop wins a same-bar tie;
  time exits at the event bar's close. Commission $1 per MNQ round turn. Optional extra slippage in ticks per side.
- $ figures are MNQ ($2 / point).
"""
from dataclasses import dataclass, field

import numpy as np

PV = 2.0
TK = 0.25
THR = 0.7187

Z = [  # (mean, sd) used by the Pine score, in the order of the 14 features
    (-0.144803, 0.992304), (-0.366907, 1.472484), (-0.866958, 2.110144), (-0.126071, 0.907152),
    (-0.176010, 0.876653), (-0.283615, 0.855161), (1.168381, 1.361280), (1.551989, 1.655467),
    (2.324757, 2.348382), (-0.054304, 0.178694), (-0.054296, 0.137704), (-0.045908, 0.216550),
    (-0.064120, 0.675399), (0.355450, 0.478650)]


def load_npz(path):
    z = np.load(path)
    return z["t"].astype(np.int64), z["o"], z["h"], z["l"], z["c"]


def sess_cols(t):
    return ((t % 1440) - 1080) % 1440, (t + 360) // 1440


def rth_sessions(t, o, h, l, c):
    """Per session id: RTH open/high/low/close, overnight low (18:00-09:30), number of 30-min RTH buckets."""
    s, day = sess_cols(t)
    out = {}
    ids, start = np.unique(day, return_index=True)
    end = np.r_[start[1:], len(t)]
    for d, a, b in zip(ids, start, end):
        ss = s[a:b]
        r = np.where((ss >= 930) & (ss < 1320))[0]
        if len(r) == 0:
            continue
        r = r + a
        on = np.where(ss < 930)[0] + a
        out[int(d)] = dict(o=o[r[0]], h=h[r].max(), l=l[r].min(), c=c[r[-1]],
                           onl=l[on].min() if len(on) else l[r[0]],
                           nb=len(np.unique(t[r] // 30)))
    return out


def adr_by_session(rth, n=14):
    """ADR used for session X = mean range of the last n FULL (13 x 30-min) RTH sessions before X."""
    days = sorted(rth)
    full = [d for d in days if rth[d]["nb"] >= 13]
    rng = np.array([rth[d]["h"] - rth[d]["l"] for d in full])
    res = {}
    k = 0
    for X in range(days[0], days[-1] + 2):
        while k < len(full) and full[k] < X:
            k += 1
        res[X] = rng[k - n:k].mean() if k >= n else np.nan
    return res


def score_series(rth):
    """Pine f_score on full sessions. Returns {full_session_day: score} (NaN until 61 sessions)."""
    full = [d for d in sorted(rth) if rth[d]["nb"] >= 13]
    C = np.array([rth[d]["c"] for d in full])
    H = np.array([rth[d]["h"] for d in full])
    L_ = np.array([rth[d]["l"] for d in full])
    O = np.array([rth[d]["o"] for d in full])
    N = np.array([rth[d]["onl"] for d in full])
    rg = np.where(H - L_ > 0, H - L_, np.nan)
    clv = np.where(H - L_ > 0, (C - L_) / np.where(H - L_ > 0, H - L_, 1), 0.5)
    out = {}
    feats = {}
    for k in range(len(full)):
        if k < 60:
            out[full[k]] = np.nan
            continue
        a = np.nanmean(rg[k - 13:k + 1])
        c0 = C[k]
        up = np.sum(C[k - 4:k + 1] > C[k - 5:k])
        x = np.array([
            -(c0 - C[k - 4:k + 1].mean()) / a,
            -(c0 - C[k - 9:k + 1].mean()) / a,
            -(c0 - C[k - 19:k + 1].mean()) / a,
            -(c0 - C[k - 3]) / (a * np.sqrt(3.0)),
            -(c0 - C[k - 5]) / (a * np.sqrt(5.0)),
            -(c0 - C[k - 10]) / (a * np.sqrt(10.0)),
            -(c0 - C[k - 9:k + 1].max()) / a,
            -(c0 - C[k - 19:k + 1].max()) / a,
            -(c0 - C[k - 59:k + 1].max()) / a,
            -(clv[k - 2:k + 1].mean() - 0.5),
            -(clv[k - 4:k + 1].mean() - 0.5),
            -(up / 5.0 - 0.5),
            -(O[k] - C[k - 1]) / a,
            1.0 if N[k] < L_[k - 1] else 0.0])
        zz = np.array([(x[i] - Z[i][0]) / Z[i][1] for i in range(14)])
        feats[full[k]] = zz
        out[full[k]] = zz.mean()
    return out, feats


@dataclass
class Win:
    """Management window of a trade: bars after the entry bar up to and including the exit-event bar."""
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    cmin: np.ndarray = field(init=False)
    cmax: np.ndarray = field(init=False)

    def __post_init__(self):
        self.cmin = np.minimum.accumulate(self.l) if len(self.l) else self.l
        self.cmax = np.maximum.accumulate(self.h) if len(self.h) else self.h

    @property
    def xc(self):
        return self.c[-1]


def bracket_exit(w, side, E, sd, td, slip=0.0):
    """Exit price of a bracket (stop distance sd, target distance td, points) managed bar by bar on window w."""
    n = len(w.cmin)
    if n == 0:
        return E, "none"
    if side == 1:
        js = np.searchsorted(-w.cmin, -(E - sd), "left")
        jt = np.searchsorted(w.cmax, E + td + TK, "left") if np.isfinite(td) else n
    else:
        js = np.searchsorted(w.cmax, E + sd, "left")
        jt = np.searchsorted(-w.cmin, -(E - td - TK), "left") if np.isfinite(td) else n
    if js < n and js <= jt:
        stop = E - side * sd
        op = w.o[js]
        px = op if (side == 1 and op <= stop) or (side == -1 and op >= stop) else stop
        return px - side * slip, "stop"
    if jt < n:
        return E + side * td, "target"
    return w.xc - side * slip, "time"


class Sessions:
    """Everything the Pine script needs per NQ/MNQ session, precomputed from bars (tf = 1 or 5)."""

    EV = dict(on=10, onx=930, od=935, ib=990, ibend=1140, eod=1320)

    def __init__(self, nq, spx, tf, adr_src=None, stale_score=True, ev=None, score=None):
        """ev: override event minutes since 18:00 (sensitivity tests). score: precomputed score_series output."""
        ev = dict(self.EV, **(ev or {}))
        t, o, h, l, c = nq
        self.tf = tf
        s, day = sess_cols(t)
        self.rth = rth_sessions(*nq)
        self.adr = adr_by_session(adr_src if adr_src is not None else self.rth)
        srth = rth_sessions(*spx)
        self.srth = srth
        self.score_raw, self.feats = score if score is not None else score_series(srth)
        ids, start = np.unique(day, return_index=True)
        end = np.r_[start[1:], len(t)]
        self.days = []
        self.S = {}
        sc_keys = np.array(sorted(self.score_raw))
        sc_vals = np.array([self.score_raw[k] for k in sc_keys])
        srth_keys = np.array(sorted(srth))
        for d, a, b in zip(ids, start, end):
            d = int(d)
            ss = s[a:b]

            def first(m, lo=0):
                j = np.searchsorted(ss, m - tf, "left")
                return a + j if j < len(ss) else None

            e_on, x_on = first(ev["on"]), first(ev["onx"])
            r0 = np.where((ss >= 930) & (ss < 1320))[0]
            e_od, x_eod = first(ev["od"]), first(ev["eod"])
            ib_arm, ib_end = first(ev["ib"]), first(ev["ibend"])
            last = b - 1
            rec = dict(day=d, last=last)
            i = np.searchsorted(sc_keys, d) - 1
            sc = sc_vals[i] if i >= 0 else np.nan
            if not stale_score:
                j = np.searchsorted(srth_keys, d) - 1  # last S&P session of any kind before d
                if j < 0 or srth[srth_keys[j]]["nb"] < 13:
                    sc = np.nan  # previous session was partial (holiday / early close): no fresh score
            rec["score"] = sc
            rec["adr"] = self.adr.get(d, np.nan)
            # overnight leg: 18:10 -> 09:30
            if e_on is not None and s[e_on] < ev["onx"]:
                xe = x_on if x_on is not None else last
                rec["on"] = dict(E=c[e_on], t=int(t[e_on]), w=Win(o[e_on + 1:xe + 1], h[e_on + 1:xe + 1],
                                                                  l[e_on + 1:xe + 1], c[e_on + 1:xe + 1]))
            # RTH legs
            if len(r0) and e_od is not None and s[e_od] >= 930 and s[e_od] < 1320:
                r_first = a + r0[0]
                if r_first <= e_od:
                    xe = x_eod if x_eod is not None else last
                    rec["rOpen"] = o[r_first]
                    rec["od"] = dict(E=c[e_od], t=int(t[e_od]), w=Win(o[e_od + 1:xe + 1], h[e_od + 1:xe + 1],
                                                                      l[e_od + 1:xe + 1], c[e_od + 1:xe + 1]))
                    if ib_arm is not None and s[ib_arm] < 1320:
                        ibr = a + r0[(ss[r0] < ev["ib"])]
                        if len(ibr):
                            be = ib_end if ib_end is not None else xe
                            rec["ib"] = dict(H=h[ibr].max(), L=l[ibr].min(), arm=ib_arm, end=be, eod=xe)
            rec["rng"] = (o, h, l, c, t)
            rec["i0"], rec["i1"] = int(a), int(b)  # this session's bar index range (research.py minute-level legs)
            self.S[d] = rec
            self.days.append(d)
        self.days = np.array(self.days)

    # ------------------------------------------------------------------ signals
    def on_side(self, d, thr=THR):
        sc = self.S[d]["score"]
        if np.isnan(sc) or np.isnan(self.S[d]["adr"]) or "on" not in self.S[d]:
            return 0
        return 1 if sc >= thr else (-1 if sc <= -thr else 0)

    def od_side(self, d, k=0.10):
        r = self.S[d]
        if "od" not in r or np.isnan(r["adr"]):
            return 0
        d5 = (r["od"]["E"] - r["rOpen"]) / r["adr"]
        return (1 if d5 > 0 else -1) if abs(d5) >= k else 0


def news_night(d):
    """Pine newsSkip: the session's calendar day is a Thursday, or a Friday with day-of-month <= 7."""
    date = np.datetime64(int(d), "D").astype(object)
    return date.weekday() == 3 or (date.weekday() == 4 and date.day <= 7)


# ---------------------------------------------------------------------- per-leg trades at 1 MNQ (funded logic)
def funded_on(S, d, side, slip=0.0, stop_adr=0.5, n=1, comm=1.0):
    r = S.S[d]
    E = r["on"]["E"] + side * slip
    px, why = bracket_exit(r["on"]["w"], side, E, stop_adr * r["adr"], np.inf, slip)
    return ((px - E) * side * PV - comm) * n, why


def pyramid(S, d, side, slip=0.0, stop=0.35, add=0.15, trail=0.25, n=1, comm=1.0, fix_gap=False, add2=None):
    """add2 (round 3, E): a second add of n at add2 x ADR from the first entry; the stop then sits at least at the
    first add's price."""
    r = S.S[d]
    A = r["adr"]
    w = r["od"]["w"]
    E1 = r["od"]["E"] + side * slip
    stp = E1 - side * stop * A
    best = E1
    ents = [E1]

    def pnl(px):
        return (sum((px - e) * side for e in ents) * PV - len(ents) * comm) * n

    for j in range(len(w.o)):
        hit = w.l[j] <= stp if side == 1 else w.h[j] >= stp
        if hit:
            op = w.o[j]
            px = op if (side == 1 and op <= stp) or (side == -1 and op >= stp) else stp
            return pnl(px - side * slip), "stop"
        fav = w.h[j] if side == 1 else w.l[j]
        if (fav - best) * side > 0:
            best = fav
        for k_add, dist in ((1, add), (2, add2)):
            if dist is None or len(ents) != k_add or (best - E1) * side < dist * A:
                continue
            lvl = E1 + side * dist * A
            gap = (side == 1 and w.o[j] > lvl) or (side == -1 and w.o[j] < lvl)
            ents.append((w.o[j] if (fix_gap and gap) else lvl) + side * slip)  # stop order: open on a gap
            lock = E1 if k_add == 1 else ents[1]  # first add -> breakeven; second add -> the first add's price
            if (lock - stp) * side > 0:
                stp = lock
        ts = best - side * trail * A
        if (ts - stp) * side > 0:
            stp = ts
    return pnl(w.xc - side * slip), "time"


def ib_breakout(S, d, slip=0.0, stop=0.25, tgt=0.5, n=1, comm=1.0, only_side=0):
    """only_side=+1/-1 arms just that stop order (v2.1: on opening-drive days only the drive's side, so no account
    ever holds a position opposite to another leg or another copy-traded account)."""
    r = S.S[d]
    if "ib" not in r:
        return None
    o, h, l, c, t = r["rng"]
    ib = r["ib"]
    A = r["adr"]
    buy, sell = ib["H"] + TK, ib["L"] - TK
    for j in range(ib["arm"] + 1, ib["end"] + 1):
        hu = h[j] >= buy and only_side >= 0
        hd = l[j] <= sell and only_side <= 0
        if hu and hd:
            return 0.0, "both-skip", 0
        if hu or hd:
            side = 1 if hu else -1
            E = (max(buy, o[j]) if hu else min(sell, o[j])) + side * slip
            if (side == 1 and E - l[j] >= stop * A) or (side == -1 and h[j] - E >= stop * A):
                return (-stop * A * PV - comm - slip * PV) * n, "stop-fillbar", side
            w = Win(o[j + 1:ib["eod"] + 1], h[j + 1:ib["eod"] + 1], l[j + 1:ib["eod"] + 1], c[j + 1:ib["eod"] + 1])
            px, why = bracket_exit(w, side, E, stop * A, tgt * A, slip)
            return ((px - E) * side * PV - comm) * n, why, side
    return None
