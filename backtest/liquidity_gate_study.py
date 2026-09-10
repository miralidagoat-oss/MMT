#!/usr/bin/env python3
"""Does the Obizhaeva-Wang book state improve the sweep signal?

This is the research behind indicators/liquidity_matrix.pine, which merges the
sweep-rejection signal engine with the O-W liquidity model.

THE HYPOTHESIS.  A sweep is an order-flow impulse that eats the book. O-W says
its impact splits into a permanent part and a transient part that decays at
rate rho. If the transient state D_t carries information about which sweeps
revert, it should separate winning setups from losing ones.

WHAT THE DATA SAYS.  Of six O-W state variables tested against trade outcome,
only |D|/sigma -- the SIZE of the deviation, regardless of direction -- shows a
monotone gradient: PF 1.16 / 0.93 / 0.89 / 0.74 across quartiles, correlation
t = -1.6. That is one of six features tested, so it is not significant once
that is accounted for. It reads sensibly: fading a
sweep works when the book is near its steady state, and fails when a large
impact process is already running. As a gate it improves 7 of 9 test series,
but only from PF 0.93 to 0.96 -- it makes a losing system less losing.

AND THE TIMEFRAME PROBLEM.  The two engines do not live at the same scale:
  - at 15m/5m the O-W model is identifiable but the sweep signal LOSES
    (pooled 1,042 signals across MNQ/NQ/ES/YM/RTY, PF 0.93, -0.04R)
  - at 1H the sweep signal WORKS (see study_mnq.py) but the O-W fit degenerates
    -- rho pins to the grid floor and lambda goes negative, because the book
    fully recovers inside one hourly bar
So the liquidity layer cannot rescue the 15m signal, and has nothing to add at
1H. The indicator ships with the 1H signal config as the default and reports
the liquidity model as "not identifiable" there rather than guessing.

Modes:
  python3 liquidity_gate_study.py <dir> features   feature vs outcome
  python3 liquidity_gate_study.py <dir> gate       the |D| gate, per series
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ow_impact import load, signed_flow           # noqa: E402

# rho, kappa, lambda per instrument-timeframe from ow_impact.py `decay`.
# Only 15m and 5m are included: 1H and above do not produce a usable fit.
PRESET = {
    ("MNQ", "15m"): (0.2832, 7.091, 24.994), ("NQ", "15m"): (0.3182, 5.957, 23.065),
    ("ES", "15m"): (0.5071, 0.540, 3.043),   ("YM", "15m"): (0.4258, 3.087, 23.595),
    ("RTY", "15m"): (0.3001, 0.336, 1.513),
    ("MNQ", "5m"): (0.1407, 1.465, 10.192),  ("NQ", "5m"): (0.1492, 1.256, 8.502),
    ("ES", "5m"): (0.2377, 0.075, 1.107),    ("RTY", "5m"): (0.0260, 0.151, 0.396),
}
SETS = list(PRESET.keys())
COST_PTS = {"YM": 3.0}          # ~2 ticks all-in; YM ticks are 1 point
SIG = dict(look=12, body_max=0.33, wick_min=0.35, close_min=0.7, range_exp=1.0,
           cool=10, stop_sigma=1.5, rr=4.0, hold=24)


def book_state(bars, rho, kappa, lam_ewma=0.94, seed=20):
    """Transient deviation D_t (points) and EWMA sigma (points)."""
    _, O, H, L, C, V = bars
    n = len(C)
    x, _ = signed_flow(bars)
    phi = math.exp(-rho)
    S = [0.0] * n
    for i in range(1, n):
        S[i] = phi * S[i - 1] + x[i]
    D = [kappa * S[i] for i in range(n)]
    lr = [0.0] + [math.log(C[i] / C[i - 1]) for i in range(1, n)]
    ew = [None] * n
    for i in range(n):
        if (ew[i - 1] is None) if i else True:
            if i >= seed - 1:
                w = lr[i - seed + 1:i + 1]
                m = sum(w) / seed
                ew[i] = sum((z - m) ** 2 for z in w) / seed
        else:
            ew[i] = lam_ewma * ew[i - 1] + (1 - lam_ewma) * lr[i] ** 2
    sig = [math.sqrt(max(ew[i], 0.0)) * C[i] if ew[i] is not None else None for i in range(n)]
    return x, D, sig


def signals(tag, tf, bars, P=SIG):
    """Every sweep setup, graded, with the O-W state recorded at entry."""
    rho, kappa, lam = PRESET[(tag, tf)]
    _, O, H, L, C, V = bars
    n = len(C)
    x, D, sig = book_state(bars, rho, kappa)
    rng = [H[i] - L[i] for i in range(n)]
    cost = COST_PTS.get(tag, 0.5)
    out, last = [], {1: -10 ** 9, -1: -10 ** 9}
    for i in range(max(P["look"], 130), n - 1):
        if sig[i] is None:
            continue
        rs = sum(rng[i - 19:i + 1]) / 20
        bar = rng[i]
        if bar <= 0:
            continue
        body = abs(C[i] - O[i])
        topw = H[i] - max(C[i], O[i])
        botw = min(C[i], O[i]) - L[i]
        phh, pll = max(H[i - P["look"]:i]), min(L[i - P["look"]:i])
        for d in (1, -1):
            if i - last[d] < P["cool"]:
                continue
            wick = botw if d == 1 else topw
            cpos = (C[i] - L[i]) if d == 1 else (H[i] - C[i])
            swept = (L[i] < pll and C[i] > pll) if d == 1 else (H[i] > phh and C[i] < phh)
            if not (swept and body <= bar * P["body_max"] and wick / bar >= P["wick_min"]
                    and cpos / bar >= P["close_min"] and bar >= rs * P["range_exp"]):
                continue
            entry = C[i]
            stop = (L[i] - P["stop_sigma"] * sig[i]) if d == 1 else (H[i] + P["stop_sigma"] * sig[i])
            risk = abs(entry - stop)
            if risk <= 0:
                continue
            tgt = entry + d * P["rr"] * risk
            ex = None
            for k in range(i + 1, min(n, i + 1 + P["hold"])):
                if (L[k] <= stop) if d == 1 else (H[k] >= stop):
                    ex = stop
                    break
                if (H[k] >= tgt) if d == 1 else (L[k] <= tgt):
                    ex = tgt
                    break
            if ex is None:
                ex = C[min(n - 1, i + P["hold"])]
            out.append(dict(R=(d * (ex - entry) - cost) / risk,
                            dev_sigma=abs(D[i]) / sig[i],
                            dev_signed=d * D[i] / sig[i],
                            flow=d * x[i],
                            sweep_sigma=((pll - L[i]) if d == 1 else (H[i] - phh)) / sig[i]))
            last[d] = i
    return out


def stats(rs):
    if len(rs) < 8:
        return None
    n = len(rs)
    m = sum(rs) / n
    sd = math.sqrt(sum((z - m) ** 2 for z in rs) / (n - 1)) if n > 1 else 0.0
    gw = sum(z for z in rs if z > 0)
    gl = -sum(z for z in rs if z < 0)
    return dict(n=n, m=m, pf=(gw / gl if gl > 0 else float("inf")),
                t=(m / (sd / math.sqrt(n)) if sd > 0 else 0.0))


def collect(d):
    out = {}
    for tag, tf in SETS:
        p = os.path.join(d, f"{tag}_{tf}.csv")
        if os.path.exists(p):
            out[(tag, tf)] = signals(tag, tf, load(p))
    return out


def mode_features(d):
    allsig = [s for v in collect(d).values() for s in v]
    print(f"pooled {len(allsig)} sweep setups, mean {sum(s['R'] for s in allsig)/len(allsig):+.3f}R\n")
    print("  quartiles by feature (Q1 lowest). Only dev_sigma is monotone.\n")
    for feat in ("dev_sigma", "dev_signed", "flow", "sweep_sigma"):
        xs = sorted(allsig, key=lambda s: s[feat])
        m = len(xs) // 4
        line = f"  {feat:<12}"
        for j in range(4):
            ch = xs[j * m:(j + 1) * m] if j < 3 else xs[3 * m:]
            st = stats([s["R"] for s in ch])
            line += f"  Q{j+1}:{st['m']:+5.2f}R PF{st['pf']:4.2f}"
        a = [s[feat] for s in allsig]
        b = [s["R"] for s in allsig]
        ma, mb = sum(a) / len(a), sum(b) / len(b)
        sa = math.sqrt(sum((z - ma) ** 2 for z in a))
        sb = math.sqrt(sum((z - mb) ** 2 for z in b))
        c = sum((a[i] - ma) * (b[i] - mb) for i in range(len(a))) / (sa * sb) if sa * sb else 0
        print(line + f"   corr={c:+.3f} t={c*math.sqrt(len(a)):+.1f}")


def mode_gate(d, thresholds=(0.5, 0.75, 1.0)):
    data = collect(d)
    for thr in thresholds:
        print(f"\n══ gate: take the setup only when |D| <= {thr}σ ══")
        better = 0
        pool_a, pool_g = [], []
        for (tag, tf), S in data.items():
            g = [s for s in S if s["dev_sigma"] <= thr]
            a, b = stats([s["R"] for s in S]), stats([s["R"] for s in g])
            if a and b:
                if b["pf"] > a["pf"]:
                    better += 1
                print(f"  {tag:<4}{tf:<4} all n={a['n']:<4} PF{a['pf']:5.2f} {a['m']:+5.2f}R"
                      f"  |  gated n={b['n']:<4} PF{b['pf']:5.2f} {b['m']:+5.2f}R"
                      f"  {'better' if b['pf'] > a['pf'] else ''}")
            pool_a += [s["R"] for s in S]
            pool_g += [s["R"] for s in g]
        pa, pg = stats(pool_a), stats(pool_g)
        print(f"  ── improved on {better}/{len(data)} series")
        print(f"  POOLED all   n={pa['n']:<5} PF={pa['pf']:5.2f} expR={pa['m']:+5.2f} t={pa['t']:+4.1f}")
        print(f"  POOLED gated n={pg['n']:<5} PF={pg['pf']:5.2f} expR={pg['m']:+5.2f} t={pg['t']:+4.1f}")


if __name__ == "__main__":
    directory = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "gate"
    if mode == "features":
        mode_features(directory)
    elif mode == "gate":
        mode_gate(directory)
    else:
        raise SystemExit(f"unknown mode {mode}")
