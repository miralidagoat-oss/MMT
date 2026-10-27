#!/usr/bin/env python3
"""Level Odds — reference implementation of indicators/level_odds.pine.

Every formula, constant and update order below mirrors the Pine script, so
running this on a bar series reproduces what the indicator shows and grades
on the same bars. Change one, change both.

Model
  Price is a driftless random walk whose clock runs on volatility, not
  minutes. Each bar-of-session k has an expected log-variance v[k], learned
  per time-of-day from past sessions; S scales it to today's regime. After
  bar j the variance left until the close is V = S * sum(v[k] for k > j),
  and the reflection principle gives the chance of touching a level at log
  distance d before the close:  P = erfc(d / sqrt(2 c V)).

  The variance left is never known exactly, so V is integrated over a
  mean-one lognormal multiplier (log-sd MIX_SD, 5-node Gauss-Hermite); that
  is what fits the fat tails of real NQ / ES intraday moves. c is one factor
  per event class (session high/low breaks, external levels) fitted to the
  model's own graded history by Brier score, shrunk toward 1 by its
  cluster-robust uncertainty (c = 1: raw model right).

  "Next draw" is the two-barrier version: which of the nearest untouched
  levels above (distance a) and below (distance b) trades first before the
  close. Method of images for short horizons, Fourier series for long ones.

Grading
  Predictions are locked at checkpoint bar closes (every `grade_every`
  minutes of session time) for every untouched level plus the session
  high/low, and graded only after the session ends, using only bars that
  came after the prediction. The model that made them was fit on earlier
  sessions only, so every grade is out-of-sample. Error bars are
  cluster-robust by session, because predictions inside one day are
  correlated.

Usage:
  python3 level_odds.py <csv> [--tz America/New_York] [--session 0930-1600]
                        [--tf 5] [--tick 0.25] [--day-start 1800] [--no-calibrate]
  CSV columns: time (unix seconds, UTC), open, high, low, close[, volume]
"""
import csv
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# ── constants (identical in the Pine script) ─────────────────────────────────

PHI = 0.5             # regime prior weight, in units of one full session's expected variance
LAMBDA_S = 0.8        # per-session EWMA decay of the volatility regime
CAL_H = 0.1           # half-step in ln c for each session's local Brier quadratic
CAL_MEMORY = 250      # sessions of memory for the calibration fit (it targets persistent bias)
PRIOR_SD = 0.25       # prior sd of ln c: c moves off 1 only as far as the evidence supports
LNC_MAX = 1.2         # |ln c| clamp
MIX_SD = 0.85         # log-sd of the volatility-uncertainty mixture (chosen on NQ 1h, first 60%)
N_BUCKETS = 5         # reliability buckets: 0-20, 20-40, 40-60, 60-80, 80-100 %

# volatility uncertainty: the variance left is a mean-one lognormal multiple
# of the forecast, integrated with 5-node Gauss-Hermite quadrature
GH_X = (-2.856970013872806, -1.355626179974266, 0.0, 1.355626179974266, 2.856970013872806)
GH_W = (0.011257411327721, 0.222075922005613, 0.533333333333333, 0.222075922005613, 0.011257411327721)

UP, DOWN, NONE, AMBIG = 0, 1, 2, 3
EXT, HL = 0, 1        # event classes: external level touch / session high-low break


# ── numerics ─────────────────────────────────────────────────────────────────

def erfcc(x):
    """Complementary error function, Numerical Recipes `erfcc`
    (fractional error < 1.2e-7 everywhere). Pine has no erf, so the
    indicator evaluates this exact polynomial in the same Horner order."""
    z = abs(x)
    t = 1.0 / (1.0 + 0.5 * z)
    poly = -0.82215223 + t * 0.17087277
    poly = 1.48851587 + t * poly
    poly = -1.13520398 + t * poly
    poly = 0.27886807 + t * poly
    poly = -0.18628806 + t * poly
    poly = 0.09678418 + t * poly
    poly = 0.37409196 + t * poly
    poly = 1.00002368 + t * poly
    r = t * math.exp(-z * z - 1.26551223 + t * poly)
    return r if x >= 0 else 2.0 - r


def race_up(a, b, var):
    """P(a driftless walk from 0 hits +a before -b, within variance-time var).
    a, b, var > 0."""
    w = a + b
    if var <= 0.25 * w * w:
        # method of images: terms fall off like erfc(2kW / sqrt(2 var))
        s = math.sqrt(2.0 * var)
        tot = 0.0
        for k in range(4):
            x1 = (a + 2.0 * k * w) / s
            if x1 > 6.5:
                break                     # this and every later term < 1e-19
            tot += erfcc(x1) - erfcc((a + 2.0 * b + 2.0 * k * w) / s)
        return tot
    # Fourier series of the two-barrier problem: terms fall off like exp(-k^2 pi^2 var / 2W^2)
    tot = b / w
    for k in range(1, 9):
        sign = 1.0 if k % 2 == 1 else -1.0
        tot -= (2.0 * sign / (k * math.pi) * math.sin(k * math.pi * b / w)
                * math.exp(-k * k * math.pi * math.pi * var / (2.0 * w * w)))
    return tot


def race(a, b, var):
    """(P up first, P down first, P neither) before the close.
    a / b are log distances to the nearest untouched level above / below,
    or None when that side has no level."""
    if var <= 0 or (a is None and b is None):
        return 0.0, 0.0, 1.0
    if b is None:
        pu = erfcc(a / math.sqrt(2.0 * var))
        return pu, 0.0, 1.0 - pu
    if a is None:
        pd = erfcc(b / math.sqrt(2.0 * var))
        return 0.0, pd, 1.0 - pd
    pu = min(max(race_up(a, b, var), 0.0), 1.0)
    pd = min(max(race_up(b, a, var), 0.0), 1.0)
    return pu, pd, max(1.0 - pu - pd, 0.0)


def bucket_of(p):
    return min(int(p * N_BUCKETS), N_BUCKETS - 1)


def mix_nodes(sd):
    """[(weight, variance multiplier)] of the volatility-uncertainty mixture."""
    if sd <= 0:
        return [(1.0, 1.0)]
    return [(w, math.exp(sd * x - 0.5 * sd * sd)) for x, w in zip(GH_X, GH_W)]


def touch_mix(z, c, nodes):
    """P(touch) for standardized distance z = d / sqrt(2V), calibration c."""
    tot = 0.0
    for w, m in nodes:
        tot += w * erfcc(z / math.sqrt(c * m))
    return tot


def race_mix(a, b, var, nodes):
    pu = pd = 0.0
    for w, m in nodes:
        x, y, _ = race(a, b, var * m)
        pu += w * x
        pd += w * y
    return pu, pd


def band68_k(nodes):
    """Half-width of the central 68.27% of the mixture, in units of sqrt(var).
    The mixture is scale-free, so this is a constant of the model."""
    lo_h, hi_h = 0.0, 4.0
    for _ in range(60):
        h = 0.5 * (lo_h + hi_h)
        cover = 0.0
        for w, m in nodes:
            cover += w * (1.0 - erfcc(h / math.sqrt(2.0 * m)))
        if cover < 0.682689492:
            lo_h = h
        else:
            hi_h = h
    return 0.5 * (lo_h + hi_h)


def fit_c(acc):
    """Calibration factor from the accumulated session quadratics.

    Each graded session s contributes the slope g and curvature H of its own
    Brier score in ln c at the ln c it used (theta_s); with a = g - H*theta_s,
    the total objective's minimum is theta_hat = -sum(a) / sum(H). Sessions
    are independent but predictions inside one are not, so the variance of
    theta_hat is the cluster-robust sandwich meat / sum(H)^2, and theta_hat is
    shrunk toward 0 by that uncertainty against a N(0, PRIOR_SD^2) prior."""
    s_h, s_a, s_aa, s_ah, s_hh = acc
    if s_h <= 0:
        return 1.0
    th = min(max(-s_a / s_h, -LNC_MAX), LNC_MAX)
    meat = s_aa + 2.0 * th * s_ah + th * th * s_hh
    if meat <= 0:
        return 1.0
    info = s_h * s_h / meat
    return math.exp(th * info / (info + 1.0 / (PRIOR_SD * PRIOR_SD)))


# ── engine ───────────────────────────────────────────────────────────────────

@dataclass
class Config:
    start_min: int = 9 * 60 + 30     # session open, minutes after local midnight
    end_min: int = 16 * 60           # session close (must be later than the open)
    tf_min: int = 5                  # bar size, minutes
    day_start_min: int = 18 * 60     # exchange trading-day roll (CME equity futures: 18:00 ET)
    memory: int = 60                 # sessions of memory for the vol curve and calibration
    warmup: int = 10                 # completed sessions before odds are shown or graded
    grade_every: int = 30            # minutes of session time between graded checkpoints
    calibrate: bool = True
    mix_sd: float = MIX_SD           # log-sd of the volatility-uncertainty mixture (0 = off)
    prev_day_source: str = "session"  # "session" (previous session) | "exchange" (daily bar)
    levels: tuple = ("PDH", "PDL", "PDC", "ONH", "ONL")
    custom: tuple = ()


class LevelOdds:
    def __init__(self, cfg, tick, oracle=None):
        self.cfg = cfg
        self.tick = tick
        self.eps = tick * 1e-3
        self.len_min = cfg.end_min - cfg.start_min
        if self.len_min <= 0:
            raise ValueError("session must not cross midnight")
        self.K = math.ceil(self.len_min / cfg.tf_min)
        self.oracle = oracle          # tests only: f(engine, k) -> true remaining variance
        self.nodes = mix_nodes(cfg.mix_sd)
        self.k68 = band68_k(self.nodes)

        # learned model
        self.vhat = [0.0] * self.K
        self.vcnt = [0] * self.K
        self.days = 0
        self.s_prior = 1.0
        self.acc = [[0.0] * 5, [0.0] * 5]          # per class: sum H, sum a, sum a^2, sum aH, sum H^2
        self.cal = [1.0, 1.0]                      # fitted c per event class

        # exchange day / week (overnight reset, daily-bar levels, PWH/PWL)
        self.ex_key = None
        self.ex_h = self.ex_l = self.ex_c = None
        self.pex_h = self.pex_l = self.pex_c = None
        self.wk_key = None
        self.wk_h = self.wk_l = None
        self.pwh = self.pwl = None

        self.on_h = self.on_l = None            # running overnight extremes
        self.pdh = self.pdl = self.pdc = None   # previous session
        self.onh = self.onl = None              # overnight extremes frozen at the open

        self.active = False
        self.sess_date = None

        # track record
        self.rel_n = [0] * N_BUCKETS
        self.rel_h = [0] * N_BUCKETS
        self.rel_p = [0.0] * N_BUCKETS
        self.rel_cl = [0] * N_BUCKETS
        self.rel_nn = [0.0] * N_BUCKETS
        self.rel_hh = [0.0] * N_BUCKETS
        self.rel_hn = [0.0] * N_BUCKETS
        self.brier_m = 0.0
        self.brier_b = 0.0
        self.base_n = 0
        self.base_h = 0
        self.graded_days = 0
        self.race_cnt = [0, 0, 0]
        self.race_n = 0
        self.race_amb = 0
        self.race_brier_m = 0.0
        self.race_brier_b = 0.0
        self.call_n = 0
        self.call_p = 0.0
        self.call_hit = 0
        self.cov_n = 0
        self.cov_in = 0
        self.history = []             # per graded session: (date, c used, n preds, hits)
        self.diag = [[[0, 0, 0.0] for _ in range(N_BUCKETS)] for _ in range(2)]  # per class: n, hits, sum p
        self.cal_hist = []

    # ── levels ──

    def external_levels(self):
        """(name, price) of every enabled external level, in the Pine slot order."""
        cfg = self.cfg
        if cfg.prev_day_source == "exchange":
            pdh, pdl, pdc = self.pex_h, self.pex_l, self.pex_c
        else:
            pdh, pdl, pdc = self.pdh, self.pdl, self.pdc
        slots = [("PDH", pdh), ("PDL", pdl), ("PDC", pdc), ("ONH", self.onh), ("ONL", self.onl),
                 ("PWH", self.pwh), ("PWL", self.pwl)]
        out = [(n, p) for n, p in slots if n in cfg.levels and p is not None]
        for i, p in enumerate(cfg.custom):
            if p and p > 0:
                out.append((f"L{i + 1}", p))
        return out

    # ── session lifecycle ──

    def _start(self, date):
        self.active = True
        self.sess_date = date
        self.ready = self.days >= self.cfg.warmup
        self.c_sess = list(self.cal) if self.cfg.calibrate else [1.0, 1.0]
        self.onh, self.onl = self.on_h, self.on_l
        self.sess_h = self.sess_l = self.sess_c = None
        self.prev_c = None
        self.today_r2 = [None] * self.K
        self.x_sum = 0.0
        self.e_sum = 0.0
        self.e_tot = sum(self.vhat)
        suffix = [0.0] * (self.K + 1)
        for k in range(self.K - 1, -1, -1):
            suffix[k] = suffix[k + 1] + self.vhat[k]
        self.suffix = suffix
        self.preds = []      # (z, p shown, level, above)
        self.races = []      # [U, D, pu, pd, pn, outcome]
        self.covs = []       # (close, sigma)

    def regime(self):
        """Today's volatility multiplier S: the prior from recent sessions,
        updated by how much variance has realized so far versus normal."""
        den = PHI * self.e_tot + self.e_sum
        return (self.s_prior * PHI * self.e_tot + self.x_sum) / den if den > 0 else self.s_prior

    def remaining_var(self, k):
        if self.oracle is not None:
            return self.oracle(self, k)
        return self.regime() * self.suffix[k + 1]

    def bar(self, date, tod, o, h, l, c):
        """Feed one confirmed bar. date: local calendar date, tod: bar open,
        minutes after local midnight."""
        cfg = self.cfg

        # exchange trading day (CME rolls at 18:00) and week
        ex_date = date + timedelta(days=1) if tod >= cfg.day_start_min else date
        if ex_date != self.ex_key:
            if self.ex_key is not None:
                self.pex_h, self.pex_l, self.pex_c = self.ex_h, self.ex_l, self.ex_c
            self.ex_key = ex_date
            self.ex_h, self.ex_l = h, l
            self.on_h = self.on_l = None
        else:
            self.ex_h, self.ex_l = max(self.ex_h, h), min(self.ex_l, l)
        self.ex_c = c
        wk = ex_date.isocalendar()[:2]
        if wk != self.wk_key:
            if self.wk_key is not None:
                self.pwh, self.pwl = self.wk_h, self.wk_l
            self.wk_key = wk
            self.wk_h, self.wk_l = h, l
        else:
            self.wk_h, self.wk_l = max(self.wk_h, h), min(self.wk_l, l)

        in_sess = cfg.start_min <= tod < cfg.end_min
        if not in_sess:
            if self.active:
                self._finalize()
            self.on_h = h if self.on_h is None else max(self.on_h, h)
            self.on_l = l if self.on_l is None else min(self.on_l, l)
            return

        if not self.active or date != self.sess_date:
            if self.active:
                self._finalize()
            self._start(date)

        k = min(max((tod - cfg.start_min) // cfg.tf_min, 0), self.K - 1)
        r = math.log(c / self.prev_c) if self.prev_c is not None else math.log(c / o)
        self.prev_c = c
        self.today_r2[k] = r * r if self.today_r2[k] is None else self.today_r2[k] + r * r
        self.x_sum += r * r
        self.e_sum += self.vhat[k]
        self.sess_h = h if self.sess_h is None else max(self.sess_h, h)
        self.sess_l = l if self.sess_l is None else min(self.sess_l, l)
        self.sess_c = c

        # resolve earlier "next draw" calls with this bar
        for rc in self.races:
            if rc[5] is not None:
                continue
            up_hit = rc[0] is not None and h >= rc[0] - self.eps
            dn_hit = rc[1] is not None and l <= rc[1] + self.eps
            if up_hit and dn_hit:
                rc[5] = AMBIG
            elif up_hit:
                rc[5] = UP
            elif dn_hit:
                rc[5] = DOWN

        el_open = tod - cfg.start_min
        el_close = el_open + cfg.tf_min
        checkpoint = (el_close // cfg.grade_every) > (el_open // cfg.grade_every) and el_close < self.len_min
        if checkpoint and self.ready:
            self._predict(k, c)

    def _predict(self, k, close):
        var = self.remaining_var(k)
        if var <= 0:
            return
        sq = math.sqrt(2.0 * var)
        c_lv, c_hl = self.c_sess[EXT], self.c_sess[HL]
        # session high / low breaks: price must print one tick beyond the extreme
        hi_lv, lo_lv = self.sess_h + self.tick, self.sess_l - self.tick
        z_hi = math.log(hi_lv / close) / sq
        p_hi = touch_mix(z_hi, c_hl, self.nodes)
        self.preds.append((z_hi, p_hi, hi_lv, True, HL))
        p_lo = 0.0
        if lo_lv > 0:
            z_lo = math.log(close / lo_lv) / sq
            p_lo = touch_mix(z_lo, c_hl, self.nodes)
            self.preds.append((z_lo, p_lo, lo_lv, False, HL))
        # external levels: untouched means beyond the session range. A level
        # past the high can't be likelier than a new high (same below).
        up = dn = None
        p_up = p_dn = 0.0
        seen = [hi_lv, lo_lv]
        for _, lv in self.external_levels():
            above = lv > self.sess_h + self.eps
            if lv <= 0 or (not above and not lv < self.sess_l - self.eps):
                continue
            z = abs(math.log(lv / close)) / sq
            if abs(lv - hi_lv) <= self.eps:
                p = p_hi                      # one tick past the high: same event as a new high
            elif abs(lv - lo_lv) <= self.eps:
                p = p_lo
            else:
                p = min(touch_mix(z, c_lv, self.nodes), p_hi if above else p_lo)
            if not any(abs(lv - s) <= self.eps for s in seen):
                seen.append(lv)
                self.preds.append((z, p, lv, above, EXT))
            if above and (up is None or lv < up):
                up, p_up = lv, p
            if not above and (dn is None or lv > dn):
                dn, p_dn = lv, p
        if up is not None or dn is not None:
            a = math.log(up / close) if up is not None else None
            b = math.log(close / dn) if dn is not None else None
            pu, pd = race_mix(a, b, c_lv * var, self.nodes)
            pu, pd = min(pu, p_up), min(pd, p_dn)   # first-touch can't beat touch
            self.races.append([up, dn, pu, pd, max(1.0 - pu - pd, 0.0), None])
        self.covs.append((close, self.k68 * math.sqrt(c_lv * var)))

    def _finalize(self):
        cfg = self.cfg
        fh, fl, fc = self.sess_h, self.sess_l, self.sess_c

        if self.preds:
            n_sb = [0] * N_BUCKETS
            h_sb = [0] * N_BUCKETS
            base = (self.base_h + 1.0) / (self.base_n + 2.0)
            hits = 0
            ys = [1 if (fh >= lv - self.eps if above else fl <= lv + self.eps) else 0
                  for z, p, lv, above, cls in self.preds]
            for (z, p, lv, above, cls), y in zip(self.preds, ys):
                b = bucket_of(p)
                self.rel_n[b] += 1
                self.rel_h[b] += y
                self.rel_p[b] += p
                n_sb[b] += 1
                h_sb[b] += y
                self.brier_m += (p - y) * (p - y)
                self.brier_b += (base - y) * (base - y)
                hits += y
                d = self.diag[cls][b]
                d[0] += 1
                d[1] += y
                d[2] += p
            for b in range(N_BUCKETS):
                if n_sb[b] > 0:
                    self.rel_cl[b] += 1
                    self.rel_nn[b] += n_sb[b] * n_sb[b]
                    self.rel_hh[b] += h_sb[b] * h_sb[b]
                    self.rel_hn[b] += h_sb[b] * n_sb[b]
            self.base_n += len(self.preds)
            self.base_h += hits
            self.graded_days += 1
            self.history.append((self.sess_date, tuple(self.c_sess), len(self.preds), hits))

            # calibration: per event class, this session's Brier score as a local
            # quadratic in ln c around the value it used, accumulated with slow
            # forgetting (squared terms with squared weights, for the sandwich)
            delta = 1.0 - 1.0 / CAL_MEMORY
            for cls in (EXT, HL):
                items = [(z, y) for (z, p, lv, above, kind), y in zip(self.preds, ys) if kind == cls]
                if not items:
                    continue
                th = math.log(self.c_sess[cls])
                b3 = [0.0, 0.0, 0.0]
                for j in range(3):
                    cg = math.exp(th + (j - 1) * CAL_H)
                    for z, y in items:
                        err = touch_mix(z, cg, self.nodes) - y
                        b3[j] += err * err
                g = (b3[2] - b3[0]) / (2.0 * CAL_H)
                hh = (b3[2] - 2.0 * b3[1] + b3[0]) / (CAL_H * CAL_H)
                a = g - hh * th
                acc = self.acc[cls]
                acc[0] = acc[0] * delta + hh
                acc[1] = acc[1] * delta + a
                acc[2] = acc[2] * delta * delta + a * a
                acc[3] = acc[3] * delta * delta + a * hh
                acc[4] = acc[4] * delta * delta + hh * hh
                self.cal[cls] = fit_c(acc)
            self.cal_hist.append(tuple(self.cal))

        if self.races:
            seen_cnt = list(self.race_cnt)   # baseline uses outcomes of earlier sessions only
            for rc in self.races:
                if rc[5] is None:
                    rc[5] = NONE
                if rc[5] == AMBIG:
                    self.race_amb += 1
                    continue
                probs = (rc[2], rc[3], rc[4])
                outc = rc[5]
                possible = (rc[0] is not None, rc[1] is not None, True)
                f = [(seen_cnt[i] + 1.0) if possible[i] else 0.0 for i in range(3)]
                fs = sum(f)
                for i in range(3):
                    y = 1.0 if i == outc else 0.0
                    self.race_brier_m += (probs[i] - y) * (probs[i] - y)
                    self.race_brier_b += (f[i] / fs - y) * (f[i] / fs - y)
                call = max(range(3), key=lambda i: probs[i])
                self.call_n += 1
                self.call_p += probs[call]
                self.call_hit += 1 if call == outc else 0
                self.race_cnt[outc] += 1
                self.race_n += 1

        for c0, sig in self.covs:
            self.cov_n += 1
            self.cov_in += 1 if abs(math.log(fc / c0)) <= sig else 0

        # learn the time-of-day volatility curve and the regime from this session
        for k in range(self.K):
            if self.today_r2[k] is not None:
                self.vcnt[k] += 1
                w = max(1.0 / self.vcnt[k], 1.0 / cfg.memory)
                self.vhat[k] += w * (self.today_r2[k] - self.vhat[k])
        if self.ready and self.e_sum > 0:
            self.s_prior = LAMBDA_S * self.s_prior + (1.0 - LAMBDA_S) * (self.x_sum / self.e_sum)
        self.days += 1
        self.pdh, self.pdl, self.pdc = fh, fl, fc
        self.on_h = self.on_l = None   # what prints from here on belongs to the next overnight
        self.active = False

    # ── reporting ──

    def reliability(self):
        rows = []
        for b in range(N_BUCKETS):
            n = self.rel_n[b]
            if n == 0:
                rows.append((b, 0, None, None, None))
                continue
            ph = self.rel_h[b] / n
            said = self.rel_p[b] / n
            cl = self.rel_cl[b]
            num = self.rel_hh[b] - 2.0 * ph * self.rel_hn[b] + ph * ph * self.rel_nn[b]
            var = max(num, 0.0) / (n * n) * (cl / (cl - 1.0) if cl > 1 else 1.0)
            rows.append((b, n, said, ph, 1.96 * math.sqrt(var)))
        return rows

    def skill(self):
        return 1.0 - self.brier_m / self.brier_b if self.brier_b > 0 else None

    def race_skill(self):
        return 1.0 - self.race_brier_m / self.race_brier_b if self.race_brier_b > 0 else None

    def report(self, title=""):
        lines = [f"── {title} ──" if title else "──"]
        lines.append(f"sessions learned {self.days}, graded {self.graded_days}, "
                     f"predictions {self.base_n}, calibration c: levels {self.cal[EXT]:.3f} "
                     f"/ high-low {self.cal[HL]:.3f}")
        lines.append(f"{'said':>7} {'hit':>7} {'±95%':>6} {'n':>6}")
        for b, n, said, ph, ci in self.reliability():
            if n:
                lines.append(f"{100 * said:6.1f}% {100 * ph:6.1f}% {100 * ci:5.1f} {n:6d}")
            else:
                lines.append(f"{'—':>7} {'—':>7} {'':>6} {0:6d}")
        sk = self.skill()
        lines.append(f"Brier skill vs base rate: {'—' if sk is None else f'{100 * sk:+.1f}%'}")
        if self.call_n:
            rs = self.race_skill()
            lines.append(f"next-draw calls: said {100 * self.call_p / self.call_n:.1f}% → right "
                         f"{100 * self.call_hit / self.call_n:.1f}%  (n={self.call_n}, ambiguous {self.race_amb}, "
                         f"skill {'—' if rs is None else f'{100 * rs:+.1f}%'})")
        if self.cov_n:
            lines.append(f"close inside the 68% range: {100 * self.cov_in / self.cov_n:.1f}% (target 68.3%, n={self.cov_n})")
        for cls, name in ((EXT, "levels"), (HL, "high/low")):
            cells = []
            for n, h, p in self.diag[cls]:
                cells.append(f"{100 * p / n:4.1f}→{100 * h / n:4.1f} ({n})" if n else "—")
            lines.append(f"  {name:>8}: " + "  ".join(cells))
        return "\n".join(lines)


# ── CSV driver ───────────────────────────────────────────────────────────────

def load_bars(path, tz, tf_min):
    """Read UTC bars, convert to local time and aggregate to tf_min bars
    aligned on the local clock (the way TradingView builds them)."""
    zone = ZoneInfo(tz)
    out = []   # [date, tod, open, high, low, close]
    with open(path) as f:
        for row in csv.DictReader(f):
            t = datetime.fromtimestamp(int(float(row["time"])), tz=timezone.utc).astimezone(zone)
            tod = t.hour * 60 + t.minute
            tod -= tod % tf_min
            o, h, l, c = (float(row[k]) for k in ("open", "high", "low", "close"))
            if out and out[-1][0] == t.date() and out[-1][1] == tod:
                out[-1][3] = max(out[-1][3], h)
                out[-1][4] = min(out[-1][4], l)
                out[-1][5] = c
            else:
                out.append([t.date(), tod, o, h, l, c])
    return out


def main(argv):
    path = argv[1]
    flags = [a for a in argv[2:] if a == "--no-calibrate"]
    rest = [a for a in argv[2:] if a != "--no-calibrate"]
    opts = dict(zip(rest[::2], rest[1::2]))
    tz = opts.get("--tz", "America/New_York")
    sess = opts.get("--session", "0930-1600")
    tf = int(opts.get("--tf", "5"))
    tick = float(opts.get("--tick", "0.25"))
    ds = opts.get("--day-start", "1800")
    cfg = Config(start_min=int(sess[:2]) * 60 + int(sess[2:4]),
                 end_min=int(sess[5:7]) * 60 + int(sess[7:9]),
                 tf_min=tf, day_start_min=int(ds[:2]) * 60 + int(ds[2:]),
                 calibrate=not flags)
    eng = LevelOdds(cfg, tick)
    for date, tod, o, h, l, c in load_bars(path, tz, tf):
        eng.bar(date, tod, o, h, l, c)
    print(eng.report(path))


if __name__ == "__main__":
    main(sys.argv)
