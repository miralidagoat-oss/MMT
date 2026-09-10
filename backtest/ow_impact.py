#!/usr/bin/env python3
"""Obizhaeva-Wang (2005) limit-order-book parameters estimated from NQ/MNQ bars.

Estimates the four quantities the optimal-execution model needs --
  1/q     instantaneous impact  (the paper's A_0+ jump, points per unit flow)
  lambda  permanent impact      (the part that never comes back)
  kappa   transient impact      (1/q - lambda, the part the book refills)
  rho     resilience            (decay rate of the transient part)
-- and runs the honesty checks that decide what the model may be used for.

IDENTIFICATION.  The signed-flow regressor x_t is built only from
(h_t, l_t, c_t, v_t).  Regressing the price change (c_{t+1+k} - c_{t-1}) on
x_t therefore shares no price observation with the regressor at any k >= 0,
so bid-ask bounce and close-position mechanics cannot manufacture either the
level of the impact or its decay.  This matters: the naive contemporaneous
regression of dp_t on x_t and its own lagged EWMA reports a hugely
significant transient term (t = -7.8 on MNQ 1h) that is almost entirely
mechanical -- c_{t-1} appears in both sides.  See `horserace` below.

All standard errors are Newey-West with lag = horizon, because the forward
windows overlap.

Modes:
  python3 ow_impact.py <data_dir> decay     [tags...]   parameter estimates
  python3 ow_impact.py <data_dir> horserace [tags...]   is it tradeable?
  python3 ow_impact.py <data_dir> rolling   [tags...]   live-estimator stability
"""
import csv
import math
import os
import sys

ADVLEN = 100          # bars in the average-daily-volume normaliser
LAGS = (0, 2, 4, 8)   # short lags used by the in-Pine estimator
KLONG = 24            # lag treated as "permanent" by the in-Pine estimator


# ── data ─────────────────────────────────────────────────────────────────────

def load(path):
    """OHLCV loader; drops halt/rollover artefact bars (zero volume or range)."""
    T, O, H, L, C, V = [], [], [], [], [], []
    with open(path) as f:
        for row in csv.DictReader(f):
            o, h, l, c, v = (float(row[k]) for k in
                             ("open", "high", "low", "close", "volume"))
            if h <= l or v <= 0:
                continue
            T.append(int(row["time"]))
            O.append(o); H.append(h); L.append(l); C.append(c); V.append(v)
    return T, O, H, L, C, V


def signed_flow(bars, advlen=ADVLEN):
    """Signed volume proxy x_t = volume * close-location-value, in ADV units.

    CLV = (2c - h - l)/(h - l) in [-1, 1] is the standard bar-level proxy for
    the buy/sell imbalance.  Normalising by trailing average volume makes the
    impact coefficients read as "points per 1 ADV of signed flow", which is
    scale-free across contracts and timeframes.
    """
    _, O, H, L, C, V = bars
    n = len(C)
    adv, run = [], 0.0
    for i in range(n):
        run += V[i]
        if i >= advlen:
            run -= V[i - advlen]
        adv.append(run / min(i + 1, advlen))
    x = []
    for i in range(n):
        clv = (2 * C[i] - H[i] - L[i]) / (H[i] - L[i])
        x.append(clv * V[i] / adv[i] if adv[i] > 0 else 0.0)
    return x, adv


# ── regression helpers ───────────────────────────────────────────────────────

def slope_nw(y, x, lag):
    """Univariate OLS slope with a Newey-West standard error."""
    m = len(y)
    mx, my = sum(x) / m, sum(y) / m
    sxx = sum((a - mx) ** 2 for a in x)
    sxy = sum((x[i] - mx) * (y[i] - my) for i in range(m))
    b = sxy / sxx
    a0 = my - b * mx
    r = [y[i] - (a0 + b * x[i]) for i in range(m)]
    xc = [x[i] - mx for i in range(m)]
    S = sum(r[i] ** 2 * xc[i] ** 2 for i in range(m))
    for L in range(1, lag + 1):
        w = 1.0 - L / (lag + 1)
        S += 2 * w * sum(r[i] * r[i - L] * xc[i] * xc[i - L] for i in range(L, m))
    return b, math.sqrt(S) / sxx


def _solve(A, b):
    p = len(b)
    M = [A[r][:] + [b[r]] for r in range(p)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        if abs(M[c][c]) < 1e-14:
            return None
        d = M[c][c]
        M[c] = [z / d for z in M[c]]
        for r in range(p):
            if r != c and M[r][c]:
                f = M[r][c]
                M[r] = [M[r][j] - f * M[c][j] for j in range(p + 1)]
    return [M[r][p] for r in range(p)]


def _inv(A):
    p = len(A)
    B = [row[:] for row in A]
    I = [[1.0 if r == c else 0.0 for c in range(p)] for r in range(p)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(B[r][c]))
        B[c], B[piv] = B[piv], B[c]
        I[c], I[piv] = I[piv], I[c]
        d = B[c][c]
        B[c] = [z / d for z in B[c]]
        I[c] = [z / d for z in I[c]]
        for r in range(p):
            if r != c and B[r][c]:
                f = B[r][c]
                B[r] = [B[r][j] - f * B[c][j] for j in range(p)]
                I[r] = [I[r][j] - f * I[c][j] for j in range(p)]
    return I


def ols_nw(y, cols, lag):
    """Multivariate OLS with Newey-West SEs. Returns [(beta, se), ...]."""
    m = len(y)
    X = [[1.0] * m] + cols
    p = len(X)
    XtX = [[sum(X[a][i] * X[b][i] for i in range(m)) for b in range(p)] for a in range(p)]
    Xty = [sum(X[a][i] * y[i] for i in range(m)) for a in range(p)]
    beta = _solve(XtX, Xty)
    if beta is None:
        return None
    r = [y[i] - sum(beta[a] * X[a][i] for a in range(p)) for i in range(m)]
    S = [[sum(r[i] ** 2 * X[a][i] * X[b][i] for i in range(m)) for b in range(p)]
         for a in range(p)]
    for L in range(1, lag + 1):
        w = 1.0 - L / (lag + 1)
        for a in range(p):
            for b in range(p):
                S[a][b] += w * sum(
                    r[i] * r[i - L] * (X[a][i] * X[b][i - L] + X[a][i - L] * X[b][i])
                    for i in range(L, m))
    Inv = _inv(XtX)
    V = [[sum(Inv[a][u] * S[u][w2] * Inv[w2][b] for u in range(p) for w2 in range(p))
          for b in range(p)] for a in range(p)]
    return [(beta[a], math.sqrt(V[a][a]) if V[a][a] > 0 else float("nan"))
            for a in range(p)]


# ── 1. impact decay: the parameter estimates ─────────────────────────────────

def fit_exponential(ks, betas):
    """Least squares fit of beta_k = lambda + kappa*exp(-rho k) over a rho grid."""
    best = None
    for j in range(200):
        rho = 0.002 * (1.06 ** j)
        if rho > 5.0:
            break
        e = [math.exp(-rho * k) for k in ks]
        n = len(ks)
        se, see = sum(e), sum(z * z for z in e)
        sb = sum(betas)
        sbe = sum(betas[i] * e[i] for i in range(n))
        det = n * see - se * se
        if abs(det) < 1e-12:
            continue
        lam = (see * sb - se * sbe) / det
        kap = (n * sbe - se * sb) / det
        ss = sum((betas[i] - (lam + kap * e[i])) ** 2 for i in range(n))
        if best is None or ss < best[0]:
            best = (ss, lam, kap, rho)
    return best


def decay(tag, bars, K=40, advlen=ADVLEN, quiet=False):
    _, O, H, L, C, V = bars
    n = len(C)
    x, adv = signed_flow(bars, advlen)
    lo = advlen + 5
    ks = list(range(K + 1))
    betas, ses = [], []
    for k in ks:
        y = [C[i + 1 + k] - C[i - 1] for i in range(lo, n - k - 2)]
        a = [x[i] for i in range(lo, n - k - 2)]
        b, se = slope_nw(y, a, max(k, 1))
        betas.append(b)
        ses.append(se)
    ss, lam, kap, rho = fit_exponential(ks, betas)
    invq = lam + kap
    advm = sum(adv[lo:]) / len(adv[lo:])
    if not quiet:
        print(f"\n═══ {tag}   {n} bars, mean volume {advm:,.0f} contracts/bar ═══")
        print(f"  {'k':>3} {'beta_k (pts per ADV)':>22} {'t (NW)':>8}")
        for k in (0, 1, 2, 3, 4, 6, 8, 12, 16, 20, 30, 40):
            if k <= K:
                print(f"  {k:>3} {betas[k]:>22.3f} {betas[k]/ses[k]:>8.1f}")
        print(f"  ── fit  beta_k = lambda + kappa*exp(-rho k)   (SSR {ss:.4f})")
        print(f"     1/q     {invq:8.3f} pts/ADV   depth {advm/invq:>9,.0f} contracts/pt")
        print(f"     lambda  {lam:8.3f} pts/ADV   permanent {100*lam/invq:>5.1f}%")
        print(f"     kappa   {kap:8.3f} pts/ADV   transient {100*kap/invq:>5.1f}%")
        print(f"     rho     {rho:8.4f} per bar   half-life {math.log(2)/rho:>6.2f} bars")
    return dict(invq=invq, lam=lam, kap=kap, rho=rho, adv=advm,
                hl=math.log(2) / rho)


# ── 2. horse race: is the deviation tradeable as a signal? ───────────────────

def horserace(tag, bars, hl=10.0, horizons=(4, 10, 15, 20), advlen=ADVLEN):
    """Does the OW flow state beat a plain return EWMA at predicting reversion?

    A: forward return on the flow state D_t          (the paper's mechanism)
    B: forward return on an EWMA of past returns     (no volume information)
    C: both jointly -- does D survive the control?
    """
    _, O, H, L, C, V = bars
    n = len(C)
    x, _ = signed_flow(bars, advlen)
    phi = 0.5 ** (1.0 / hl)
    S = [0.0] * n
    R = [0.0] * n
    for i in range(1, n):
        S[i] = phi * S[i - 1] + x[i]
        R[i] = phi * R[i - 1] + (C[i] - C[i - 1])
    lo = advlen + 5
    sdS = math.sqrt(sum(S[i] ** 2 for i in range(lo, n)) / (n - lo))
    sdR = math.sqrt(sum(R[i] ** 2 for i in range(lo, n)) / (n - lo))
    print(f"\n═══ {tag}   flow half-life {hl} bars, forward return from c_(t+1) ═══")
    print(f"{'h':>3} | {'A: flow state':>19} | {'B: returns only':>19} | "
          f"{'C: flow | returns':>19} {'C: returns':>17}")
    for h in horizons:
        y, a, b = [], [], []
        for i in range(lo, n - h - 1):
            y.append(C[i + 1 + h] - C[i + 1])
            a.append(S[i] / sdS)
            b.append(R[i] / sdR)
        rA, rB, rC = ols_nw(y, [a], h), ols_nw(y, [b], h), ols_nw(y, [a, b], h)
        f = lambda r, i: f"{r[i][0]:+7.2f} (t{r[i][0]/r[i][1]:+5.1f})"
        print(f"{h:>3} | {f(rA,1):>19} | {f(rB,1):>19} | {f(rC,1):>19} {f(rC,2):>17}")


# ── 3. rolling estimator: what the Pine script can actually compute live ─────

def pine_estimator(bars, W, advlen=ADVLEN, lags=LAGS, klong=KLONG):
    """The 5-lag causal estimator the Pine indicator runs on every bar.

    beta_k = cov(c_t - c_{t-k-2}, x_{t-k-1}) / var(x_{t-k-1}) over a window W.
    Both series are historical at bar t, so this is computable live.
    """
    _, O, H, L, C, V = bars
    n = len(C)
    x, _ = signed_flow(bars, advlen)
    out = []
    need = max(max(lags), klong) + 3
    for t in range(advlen + W + need, n):
        betas = {}
        for k in list(lags) + [klong]:
            xs = [x[t - j - k - 1] for j in range(W)]
            ys = [C[t - j] - C[t - j - k - 2] for j in range(W)]
            mx, my = sum(xs) / W, sum(ys) / W
            sxx = sum((a - mx) ** 2 for a in xs)
            sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(W))
            betas[k] = sxy / sxx if sxx > 0 else float("nan")
        lam, b0 = betas[klong], betas[0]
        kap = b0 - lam
        if not (kap > 0 and b0 > 0):
            out.append((t, b0, lam, kap, float("nan")))
            continue
        rs = []
        for m in lags:
            if m == 0:
                continue
            frac = (betas[m] - lam) / kap
            if 0.02 < frac < 0.999:
                rs.append(-math.log(frac) / m)
        out.append((t, b0, lam, kap, sum(rs) / len(rs) if rs else float("nan")))
    return out


def rolling(tag, bars, full_rho, windows=(500, 1000, 2000), smooth=100):
    print(f"\n═══ {tag}   live-estimator stability (full-sample rho {full_rho:.3f}) ═══")
    for W in windows:
        if len(bars[4]) < W + 400:
            continue
        rows = pine_estimator(bars, W)
        raw = [r[4] for r in rows if not math.isnan(r[4])]
        if not raw:
            print(f"  W={W:<5} no valid estimates")
            continue
        ema, k, ser = None, 2.0 / (smooth + 1), []
        for v in raw:
            v = min(max(v, 0.01), 3.0)
            ema = v if ema is None else ema + k * (v - ema)
            ser.append(ema)
        ser = ser[200:] or ser
        q = lambda s, p: sorted(s)[int(len(s) * p)]
        print(f"  W={W:<5} valid {100*len(raw)/len(rows):5.1f}%   "
              f"smoothed rho {q(ser,.5):.3f} [{q(ser,.1):.3f}, {q(ser,.9):.3f}]   "
              f"half-life {math.log(2)/q(ser,.5):.2f} bars")


# ── cli ──────────────────────────────────────────────────────────────────────

DEFAULT_TAGS = ("MNQ_15m", "NQ_15m", "MNQ_5m", "NQ_5m")
FULL_RHO = {"MNQ_15m": 0.2754, "NQ_15m": 0.3212, "MNQ_5m": 0.1378, "NQ_5m": 0.1488}


def main():
    data_dir = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "decay"
    tags = sys.argv[3:] or list(DEFAULT_TAGS)
    for tag in tags:
        path = os.path.join(data_dir, tag + ".csv")
        if not os.path.exists(path):
            print(f"missing {path}", file=sys.stderr)
            continue
        bars = load(path)
        if mode == "decay":
            decay(tag, bars)
        elif mode == "horserace":
            horserace(tag, bars)
        elif mode == "rolling":
            rolling(tag, bars, FULL_RHO.get(tag, float("nan")))
        else:
            raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
