#!/usr/bin/env python3
"""Known-answer checks for the Level Odds engine and its grader.

1. Level bookkeeping on a hand-made week (PDH/PDL/PDC, ONH/ONL, PWH/PWL).
2. Oracle: synthetic random-walk sessions, predictions made with the TRUE
   remaining variance. The odds are then right by construction, so the
   grader must report "said X% -> hit X%" in every bucket. This tests the
   grader, not the model.
3. Full model on the same kind of market: it has to learn the volatility
   curve and regime itself, and should still grade as calibrated.
4. Negative control: a mean-reverting market, where per-bar volatility
   overstates how far price wanders, so the raw odds are too high. The
   grader must flag that, and self-calibration must pull c below 1 and fix
   most of it.

Run: python3 test_level_odds_engine.py
"""
import math
import sys
from datetime import date, timedelta

import numpy as np

from level_odds import Config, LevelOdds

K = 78                     # 09:30-16:00 in 5-minute bars
BASE_SIGMA = 0.0012        # per-bar log-return sd at the quietest part of the day


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        check.failed = True


check.failed = False


def u_shape(k):
    return 1.0 + 1.6 * math.exp(-k / 5.0) + 0.7 * math.exp(-(K - 1 - k) / 3.0)


def trading_days(n, start=date(2024, 1, 2)):
    d = start
    out = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def gen(n_days, kind, seed, sub=200):
    """Synthetic CME-like days: 18:00-09:30 overnight (quiet), 09:30-16:00
    session with a U-shaped volatility curve and persistent day-level
    volatility regimes, 16:00-17:00 post-close. Returns bars and the true
    per-bar session variances (for the oracle)."""
    rng = np.random.default_rng(seed)
    logp = math.log(20000.0)
    ln_s = 0.0
    bars, truth = [], {}
    for d in trading_days(n_days):
        ln_s = 0.7 * ln_s + rng.normal(0.0, 0.35)
        s_day = math.exp(ln_s - 0.12)
        # overnight: 18:00 the previous calendar evening (Sunday for Mondays) through 09:25
        night = [(d - timedelta(days=1), t) for t in range(18 * 60, 24 * 60, 5)]
        night += [(d, t) for t in range(0, 9 * 60 + 30, 5)]
        for bd, t in night:
            steps = rng.standard_normal(20) * (0.35 * BASE_SIGMA * math.sqrt(s_day) / math.sqrt(20))
            path = logp + np.cumsum(steps)
            bars.append((bd, t, math.exp(logp), math.exp(max(logp, path.max())),
                         math.exp(min(logp, path.min())), math.exp(path[-1])))
            logp = path[-1]
        anchor = logp
        var_k = []
        for k in range(K):
            sig = BASE_SIGMA * u_shape(k) * math.sqrt(s_day)
            var_k.append(sig * sig)
            eps = rng.standard_normal(sub) * (sig / math.sqrt(sub))
            if kind == "bm":
                path = logp + np.cumsum(eps)
            else:  # "ou": pulled back toward the session open, half-life one hour
                # x[n] = (1-θ) x[n-1] + θ·anchor + eps[n], solved in closed form
                theta = math.log(2.0) / 12.0 / sub
                pw = (1.0 - theta) ** np.arange(1, sub + 1)
                path = pw * (logp + np.cumsum((theta * anchor + eps) / pw))
            bars.append((d, 9 * 60 + 30 + 5 * k, math.exp(logp), math.exp(max(logp, path.max())),
                         math.exp(min(logp, path.min())), math.exp(path[-1])))
            logp = path[-1]
        truth[d] = var_k
        for t in range(16 * 60, 17 * 60, 5):
            steps = rng.standard_normal(20) * (0.35 * BASE_SIGMA * math.sqrt(s_day) / math.sqrt(20))
            path = logp + np.cumsum(steps)
            bars.append((d, t, math.exp(logp), math.exp(max(logp, path.max())),
                         math.exp(min(logp, path.min())), math.exp(path[-1])))
            logp = path[-1]
    bars.sort(key=lambda b: (b[0], b[1]))
    return bars, truth


def run(bars, cfg, oracle_truth=None):
    oracle = None
    if oracle_truth is not None:
        oracle = lambda eng, k: sum(oracle_truth[eng.sess_date][k + 1:])
    eng = LevelOdds(cfg, 0.25, oracle=oracle)
    for b in bars:
        eng.bar(*b)
    return eng


def calib_errors(eng):
    """(max |hit - said| in units of the bucket's SE, max absolute gap) over
    buckets with enough data."""
    worst_z = worst_abs = 0.0
    for b, n, said, hit, ci in eng.reliability():
        if n < 200:
            continue
        se = max(ci / 1.96, 1e-9)
        worst_z = max(worst_z, abs(hit - said) / se)
        worst_abs = max(worst_abs, abs(hit - said))
    return worst_z, worst_abs


def test_level_bookkeeping():
    cfg = Config(warmup=1000)  # never predicts; bookkeeping only
    eng = LevelOdds(cfg, 0.25)
    mon, tue = date(2024, 3, 4), date(2024, 3, 5)
    # Sunday evening opens the week's first exchange day (Monday)
    eng.bar(date(2024, 3, 3), 18 * 60, 100, 101, 99, 100)
    eng.bar(mon, 9 * 60, 100, 103, 98, 101)            # overnight: ONH 103 / ONL 98
    eng.bar(mon, 9 * 60 + 30, 101, 105, 100, 104)      # session opens
    check("ONH/ONL frozen at the open", (eng.onh, eng.onl) == (103, 98), f"{eng.onh}/{eng.onl}")
    eng.bar(mon, 15 * 60 + 55, 104, 106, 97, 102)      # session H 106 L 97 C 102
    eng.bar(mon, 16 * 60, 102, 102.5, 101.5, 102)      # post-close: finalizes the session
    check("PDH/PDL/PDC = previous session", (eng.pdh, eng.pdl, eng.pdc) == (106, 97, 102),
          f"{eng.pdh}/{eng.pdl}/{eng.pdc}")
    eng.bar(mon, 18 * 60, 102, 102.25, 101, 101.5)     # new exchange day: overnight resets here
    eng.bar(tue, 9 * 60 + 25, 101.5, 101.75, 100.5, 101)
    eng.bar(tue, 9 * 60 + 30, 101, 101.5, 100.75, 101.25)
    check("overnight resets at the 18:00 roll (post-close 102.5 excluded)",
          (eng.onh, eng.onl) == (102.25, 100.5), f"{eng.onh}/{eng.onl}")
    check("exchange-day levels = previous 18:00-17:00 day",
          (eng.pex_h, eng.pex_l, eng.pex_c) == (106, 97, 102), f"{eng.pex_h}/{eng.pex_l}/{eng.pex_c}")
    # next week: previous-week levels appear
    eng.bar(date(2024, 3, 10), 18 * 60, 101, 101.5, 100.5, 101)
    check("PWH/PWL = previous exchange week", (eng.pwh, eng.pwl) == (106, 97), f"{eng.pwh}/{eng.pwl}")


def test_oracle_grader():
    bars, truth = gen(600, "bm", seed=1)
    eng = run(bars, Config(calibrate=False, mix_sd=0.0), oracle_truth=truth)
    print(eng.report("oracle on random walk (true variance, no calibration)"))
    wz, wa = calib_errors(eng)
    check("oracle: every bucket hits what it said (within 3 SE)", wz < 3.0, f"worst {wz:.2f} SE, {100 * wa:.1f} pts")
    said = eng.call_p / eng.call_n
    hit = eng.call_hit / eng.call_n
    check("oracle: next-draw calls right as often as said", abs(said - hit) < 0.03,
          f"said {100 * said:.1f}% right {100 * hit:.1f}%")
    cov = eng.cov_in / eng.cov_n
    check("oracle: close lands inside ±1σ ~68.3% of the time", abs(cov - 0.683) < 0.03, f"{100 * cov:.1f}%")


def test_model_on_random_walk():
    bars, _ = gen(600, "bm", seed=2)
    eng = run(bars, Config(mix_sd=0.0))
    print(eng.report("full model on random walk"))
    wz, wa = calib_errors(eng)
    check("model: calibrated on a random walk (within 3 SE or 3 pts)", wz < 3.0 or wa < 0.03,
          f"worst {wz:.2f} SE, {100 * wa:.1f} pts")
    lo = min(min(c) for c in eng.cal_hist[100:])
    hi = max(max(c) for c in eng.cal_hist[100:])
    check("model: calibration stays near 1 when the model is right", 0.85 < lo and hi < 1.2,
          f"c range after 100 sessions {lo:.3f}..{hi:.3f}, final {eng.cal[0]:.3f}/{eng.cal[1]:.3f}")
    check("model: beats the base-rate baseline by a wide margin", eng.skill() > 0.3, f"skill {100 * eng.skill():+.1f}%")


def test_negative_control():
    bars, _ = gen(600, "ou", seed=3)
    raw = run(bars, Config(calibrate=False, mix_sd=0.0))
    print(raw.report("mean-reverting market, raw model (no calibration)"))
    over = [(said - hit) / max(ci / 1.96, 1e-9) for b, n, said, hit, ci in raw.reliability() if n >= 200]
    check("control: grader flags over-predicted touches (> 3 SE)", max(over) > 3.0, f"max {max(over):.1f} SE")
    cal = run(bars, Config(calibrate=True, mix_sd=0.0))
    print(cal.report("mean-reverting market, self-calibrating"))
    check("control: calibration pulls level c clearly below 1", cal.cal[0] < 0.9, f"c levels {cal.cal[0]:.3f}")
    check("control: calibration lowers the Brier score", cal.brier_m < raw.brier_m,
          f"{raw.brier_m / raw.base_n:.4f} -> {cal.brier_m / cal.base_n:.4f} per prediction")
    _, wa_raw = calib_errors(raw)
    _, wa_cal = calib_errors(cal)
    check("control: calibration shrinks the worst bucket gap", wa_cal < wa_raw,
          f"{100 * wa_raw:.1f} -> {100 * wa_cal:.1f} pts")


if __name__ == "__main__":
    test_level_bookkeeping()
    test_oracle_grader()
    test_model_on_random_walk()
    test_negative_control()
    print("\nALL PASSED" if not check.failed else "\nFAILURES ABOVE")
    sys.exit(1 if check.failed else 0)
