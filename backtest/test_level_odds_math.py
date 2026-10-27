#!/usr/bin/env python3
"""Known-answer checks for the Level Odds math: the erfc polynomial, the
one-level touch formula and the two-level "next draw" formula, each against
exact references or Monte Carlo of a Brownian path.

Monte Carlo paths are monitored at discrete steps, which hits a barrier
slightly less often than a continuous path; the standard Broadie-Glasserman-
Kou correction (shift the barrier out by 0.5826 * sigma * sqrt(dt)) makes the
continuous formula comparable.

Run: python3 test_level_odds_math.py
"""
import math
import sys

import numpy as np

from level_odds import MIX_SD, band68_k, erfcc, mix_nodes, race, race_mix, race_up, touch_mix

BGK = 0.5826


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        check.failed = True


check.failed = False


def test_erfcc():
    worst = 0.0
    for i in range(-6000, 6001):
        x = i / 1000.0
        ref = math.erfc(x)
        worst = max(worst, abs(erfcc(x) - ref) / ref)
    check("erfcc relative error < 1.2e-7 on [-6, 6]", worst < 1.2e-7, f"worst {worst:.2e}")


def paths(rng, n_paths, n_steps):
    return np.cumsum(rng.standard_normal((n_paths, n_steps)) / math.sqrt(n_steps), axis=1)


def test_touch_mc():
    rng = np.random.default_rng(7)
    n_steps, total = 400, 0
    hits = {d: 0 for d in (0.1, 0.5, 1.0, 1.5, 2.0, 3.0)}
    for _ in range(10):
        x = paths(rng, 20000, n_steps)
        mx = x.max(axis=1)
        total += len(mx)
        for d in hits:
            hits[d] += int((mx >= d).sum())
    shift = BGK / math.sqrt(n_steps)
    for d, h in hits.items():
        mc = h / total
        th = erfcc((d + shift) / math.sqrt(2.0))
        se = math.sqrt(th * (1 - th) / total)
        check(f"touch d={d:.1f}σ  MC {mc:.4f} vs formula {th:.4f}", abs(mc - th) < 4 * se + 1e-3,
              f"(raw continuous {erfcc(d / math.sqrt(2.0)):.4f})")


def test_race_series_agree():
    worst = 0.0
    for a in (0.05, 0.3, 1.0, 2.0):
        for b in (0.05, 0.3, 1.0, 2.0):
            w = a + b
            for q in (0.15, 0.2, 0.25, 0.3, 0.4):
                var = q * w * w
                # both expansions evaluated at the same point, forced either way
                s = math.sqrt(2.0 * var)
                img = sum(erfcc((a + 2 * k * w) / s) - erfcc((a + 2 * b + 2 * k * w) / s) for k in range(8))
                fou = b / w - sum((2.0 * (1 if k % 2 else -1) / (k * math.pi)) * math.sin(k * math.pi * b / w)
                                  * math.exp(-k * k * math.pi ** 2 * var / (2 * w * w)) for k in range(1, 40))
                worst = max(worst, abs(img - fou))
    check("race: images and Fourier series agree near the switch", worst < 1e-6, f"worst {worst:.2e}")
    # limits: no lower barrier -> single-barrier touch; long horizon -> gambler's ruin b/(a+b)
    pu = race_up(0.5, 50.0, 1.0)
    check("race: far lower barrier reduces to single-level touch", abs(pu - erfcc(0.5 / math.sqrt(2.0))) < 1e-9,
          f"{pu:.6f} vs {erfcc(0.5 / math.sqrt(2.0)):.6f}")
    pu = race_up(0.3, 0.7, 500.0)
    check("race: long horizon reduces to gambler's ruin", abs(pu - 0.7) < 1e-9, f"{pu:.6f} vs 0.700000")
    pu, pd, pn = race(0.4, 0.6, 0.5)
    check("race: probabilities sum to 1", abs(pu + pd + pn - 1.0) < 1e-12)
    pu_s, _, _ = race(0.4, None, 0.5)
    check("race: P(up first) <= P(touch up)", pu <= pu_s + 1e-12, f"{pu:.4f} <= {pu_s:.4f}")


def test_race_mc():
    rng = np.random.default_rng(11)
    n_steps = 400
    shift = BGK / math.sqrt(n_steps)
    cases = [(0.5, 0.5, 1.0), (0.3, 1.0, 1.0), (1.0, 2.0, 1.0), (0.2, 0.25, 1.0), (1.5, 1.5, 1.0)]
    for a, b, var in cases:
        up = dn = total = 0
        for _ in range(8):
            x = paths(rng, 20000, n_steps) * math.sqrt(var)
            hit_u = x >= a
            hit_d = x <= -b
            iu = np.where(hit_u.any(axis=1), hit_u.argmax(axis=1), n_steps + 1)
            idn = np.where(hit_d.any(axis=1), hit_d.argmax(axis=1), n_steps + 1)
            up += int((iu < idn).sum())
            dn += int((idn < iu).sum())
            total += x.shape[0]
        s = shift * math.sqrt(var)
        pu, pd, pn = race(a + s, b + s, var)
        mu, md = up / total, dn / total
        se = math.sqrt(max(pu * (1 - pu), pd * (1 - pd)) / total)
        ok = abs(mu - pu) < 4 * se + 1e-3 and abs(md - pd) < 4 * se + 1e-3
        check(f"race a={a} b={b}: MC up {mu:.4f}/dn {md:.4f} vs formula {pu:.4f}/{pd:.4f}", ok)


def test_mixture():
    one = mix_nodes(0.0)
    check("mixture off is the plain model", touch_mix(0.7, 0.9, one) == erfcc(0.7 / math.sqrt(0.9))
          and race_mix(0.3, 0.5, 0.4, one) == race(0.3, 0.5, 0.4)[:2] and abs(band68_k(one) - 1.0) < 1e-6)
    nodes = mix_nodes(MIX_SD)
    check("mixture weights sum to 1 and multipliers average 1",
          abs(sum(w for w, _ in nodes) - 1.0) < 1e-12 and abs(sum(w * m for w, m in nodes) - 1.0) < 1e-3,
          f"E[W] = {sum(w * m for w, m in nodes):.5f}")
    # Monte Carlo of a lognormal-variance Brownian motion: touches and the 68% band
    rng = np.random.default_rng(5)
    n_paths, n_steps, var, d = 60000, 400, 1.0, 1.0
    mult = np.exp(MIX_SD * rng.standard_normal(n_paths) - 0.5 * MIX_SD ** 2)
    x = np.cumsum(rng.standard_normal((n_paths, n_steps)), axis=1) * np.sqrt(var * mult / n_steps)[:, None]
    shift = BGK / math.sqrt(n_steps)
    hit = (x.max(axis=1) >= d).mean()
    th = sum(w * erfcc((d + shift * math.sqrt(m)) / math.sqrt(2.0 * var * m)) for w, m in nodes)
    check(f"mixture touch: MC {hit:.4f} vs formula {th:.4f}", abs(hit - th) < 4 * math.sqrt(th * (1 - th) / n_paths) + 2e-3)
    k = band68_k(nodes)
    cover = (np.abs(x[:, -1]) <= k * math.sqrt(var)).mean()
    check(f"mixture 68% band: MC coverage {cover:.4f} (k = {k:.4f})", abs(cover - 0.6827) < 0.006)


if __name__ == "__main__":
    test_mixture()
    test_erfcc()
    test_touch_mc()
    test_race_series_agree()
    test_race_mc()
    print("\nALL PASSED" if not check.failed else "\nFAILURES ABOVE")
    sys.exit(1 if check.failed else 0)
