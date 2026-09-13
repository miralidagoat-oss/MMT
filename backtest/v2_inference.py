#!/usr/bin/env python3
"""Cluster-robust inference for V2_PROXY (audit items 7-11).

One coherent framework. `report_result.cr1_se()` is an estimator for a SAMPLE
MEAN and is NOT reused here: it cannot produce a standard error for a rank-
regression slope, a mean difference, or a categorical omnibus effect.

Everything below is OLS with a CR1 cluster-robust covariance, clustered on CME
trade date:

    V_CR1 = (X'X)^-1 [ Σ_g X_g' u_g u_g' X_g ] (X'X)^-1 · c

    c = (G / (G-1)) · ((N-1) / (N-K))          finite-sample correction, FROZEN

where G = number of clusters, N = observations, K = columns of X (intercept
included), u = OLS residuals.

Frozen choices:
  critical distribution : Student-t with G-1 degrees of freedom (NOT normal -
                          with clustered data the effective sample size is the
                          cluster count, and t is the conventional conservative
                          choice)
  ties                  : average ranks
  singular design       : FAIL CLOSED (SingularDesign)
  minimum clusters      : 30, else FAIL CLOSED (TooFewClusters)
  NaN                   : rows with any NaN in y, X or cluster are DROPPED, and
                          the count of dropped rows is returned, never silently
                          imputed

No V2 outcome is computed in this module. It operates on whatever arrays it is
given, and its tests use synthetic data only.
"""
import math

MIN_CLUSTERS = 30
CORRECTION = "(G/(G-1)) * ((N-1)/(N-K))"


class SingularDesign(Exception):
    """X'X is not invertible. Never pseudo-inverted, never regularised."""


class TooFewClusters(Exception):
    """Fewer than MIN_CLUSTERS trade dates. Cluster-robust inference with a
    handful of clusters is badly biased; refusing beats reporting it."""


# ── small dense linear algebra (no numpy dependency) ───────────────────────
def _matmul(A, B):
    n, k, m = len(A), len(B), len(B[0])
    return [[sum(A[i][t] * B[t][j] for t in range(k)) for j in range(m)]
            for i in range(n)]


def _transpose(A):
    return [list(col) for col in zip(*A)]


def _inv(A, eps=1e-12):
    """Gauss-Jordan with partial pivoting. Raises rather than regularising."""
    n = len(A)
    M = [row[:] + [1.0 if i == j else 0.0 for j in range(n)]
         for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < eps:
            raise SingularDesign(
                f"X'X is singular at column {col} (pivot {M[piv][col]:.3e}). "
                "A constant or perfectly collinear predictor was supplied; "
                "failing closed rather than pseudo-inverting.")
        M[col], M[piv] = M[piv], M[col]
        p = M[col][col]
        M[col] = [v / p for v in M[col]]
        for r in range(n):
            if r == col:
                continue
            f = M[r][col]
            if f:
                M[r] = [a - f * b for a, b in zip(M[r], M[col])]
    return [row[n:] for row in M]


def average_ranks(v):
    """Average ranks for ties, 1-based. Frozen tie rule."""
    order = sorted(range(len(v)), key=lambda i: v[i])
    out = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        r = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            out[order[k]] = r
        i = j + 1
    return out


# ── Student-t tail, series + continued fraction (no scipy) ─────────────────
def _lgamma(x):
    g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
         -176.61502916214059, 12.507343278686905, -0.13857109526572012,
         9.9843695780195716e-6, 1.5056327351493116e-7]
    if x < 0.5:
        return math.log(math.pi / abs(math.sin(math.pi * x))) - _lgamma(1 - x)
    x -= 1
    a = 0.99999999999980993
    t = x + 7.5
    for i, c in enumerate(g):
        a += c / (x + i + 1)
    return 0.5 * math.log(2 * math.pi) + (x + 0.5) * math.log(t) - t + math.log(a)


def _betacf(a, b, x, itmax=300, eps=3e-14):
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1.0 / d
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        c = 1.0 + aa / c
        if abs(d) < 1e-30: d = 1e-30
        if abs(c) < 1e-30: c = 1e-30
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        c = 1.0 + aa / c
        if abs(d) < 1e-30: d = 1e-30
        if abs(c) < 1e-30: c = 1e-30
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < eps:
            break
    return h


def _betainc(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    lb = (_lgamma(a + b) - _lgamma(a) - _lgamma(b)
          + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1) / (a + b + 2):
        return math.exp(lb) * _betacf(a, b, x) / a
    return 1.0 - math.exp(lb) * _betacf(b, a, 1 - x) / b


def t_sf2(t, df):
    """Two-sided Student-t tail probability."""
    return _betainc(df / 2.0, 0.5, df / (df + t * t))


def f_sf(f, d1, d2):
    """Upper tail of the F distribution, for the omnibus Wald test."""
    if f <= 0: return 1.0
    return _betainc(d2 / 2.0, d1 / 2.0, d2 / (d2 + d1 * f))


def t_crit(df, alpha=0.05):
    lo, hi = 0.0, 100.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if t_sf2(mid, df) > alpha:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


# ── the estimator ──────────────────────────────────────────────────────────
def cr1_ols(y, X, clusters, alpha=0.05):
    """OLS with CR1 cluster-robust covariance.

    y        : list of floats
    X        : list of rows WITHOUT an intercept; one is prepended here
    clusters : list of cluster keys (CME trade dates), same length as y

    Returns a dict with beta, se, t, p, ci, and the diagnostics that make the
    result reproducible (N, G, K, df, dropped).
    """
    rows = [(yi, xi, ci) for yi, xi, ci in zip(y, X, clusters)
            if yi is not None and ci is not None
            and not (isinstance(yi, float) and math.isnan(yi))
            and all(v is not None and not (isinstance(v, float) and math.isnan(v))
                    for v in xi)]
    dropped = len(y) - len(rows)
    if not rows:
        raise SingularDesign("every row dropped for NaN/None")
    yv = [r[0] for r in rows]
    Xv = [[1.0] + list(r[1]) for r in rows]
    cv = [r[2] for r in rows]

    G = len(set(cv))
    if G < MIN_CLUSTERS:
        raise TooFewClusters(
            f"{G} clusters < {MIN_CLUSTERS} required. Cluster-robust inference "
            "on this few clusters is badly biased; failing closed.")
    N, K = len(yv), len(Xv[0])
    if N <= K:
        raise SingularDesign(f"N={N} <= K={K}")

    Xt = _transpose(Xv)
    XtX = _matmul(Xt, Xv)
    XtX_inv = _inv(XtX)
    Xty = _matmul(Xt, [[v] for v in yv])
    beta = [r[0] for r in _matmul(XtX_inv, Xty)]
    u = [yv[i] - sum(beta[j] * Xv[i][j] for j in range(K)) for i in range(N)]

    # meat: sum over clusters of (X_g' u_g)(X_g' u_g)'
    by = {}
    for i, c in enumerate(cv):
        acc = by.setdefault(c, [0.0] * K)
        for j in range(K):
            acc[j] += Xv[i][j] * u[i]
    meat = [[0.0] * K for _ in range(K)]
    for s in by.values():
        for a in range(K):
            for b in range(K):
                meat[a][b] += s[a] * s[b]

    c = (G / (G - 1.0)) * ((N - 1.0) / (N - K))
    V = _matmul(_matmul(XtX_inv, meat), XtX_inv)
    V = [[c * V[a][b] for b in range(K)] for a in range(K)]

    df = G - 1
    tc = t_crit(df, alpha)
    se = [math.sqrt(V[j][j]) if V[j][j] > 0 else float("nan") for j in range(K)]
    tstat = [beta[j] / se[j] if se[j] and se[j] == se[j] else float("nan")
             for j in range(K)]
    p = [t_sf2(abs(tstat[j]), df) if tstat[j] == tstat[j] else float("nan")
         for j in range(K)]
    ci = [(beta[j] - tc * se[j], beta[j] + tc * se[j]) for j in range(K)]
    return {"beta": beta, "se": se, "t": tstat, "p": p, "ci": ci, "V": V,
            "N": N, "G": G, "K": K, "df": df, "dropped": dropped,
            "correction": CORRECTION, "critical": f"Student-t(df={df})"}


def continuous_test(x, y, clusters, alpha=0.05):
    """Audit item 8. rank(Y) = a + b*rank(X); CR1 by trade date.

    Sign and information are equivalent to a Spearman association, but the
    p-value and interval come from the SAME clustered fit rather than being
    spliced from two unrelated procedures.
    """
    keep = [(xi, yi, ci) for xi, yi, ci in zip(x, y, clusters)
            if xi is not None and yi is not None
            and not (isinstance(xi, float) and math.isnan(xi))
            and not (isinstance(yi, float) and math.isnan(yi))]
    dropped = len(x) - len(keep)
    rx = average_ranks([k[0] for k in keep])
    ry = average_ranks([k[1] for k in keep])
    out = cr1_ols(ry, [[v] for v in rx], [k[2] for k in keep], alpha)
    out.update(kind="continuous_rank", beta_of_interest=out["beta"][1],
               p_of_interest=out["p"][1], ci_of_interest=out["ci"][1],
               dropped_pre=dropped)
    return out


def boolean_test(b, y, clusters, alpha=0.05):
    """Audit item 9. Y = a + b*B; CR1 by trade date. beta is a mean difference."""
    out = cr1_ols(list(y), [[1.0 if v else 0.0] for v in b], list(clusters), alpha)
    out.update(kind="boolean_mean_difference", beta_of_interest=out["beta"][1],
               p_of_interest=out["p"][1], ci_of_interest=out["ci"][1])
    return out


def categorical_test(cat, y, clusters, alpha=0.05):
    """Audit item 10. rank(Y) on K-1 dummies; ONE clustered omnibus Wald test.

    H0: all K-1 category coefficients are zero. Individual category
    coefficients are descriptive and never promote a feature by themselves.

    Wald = (R b)' (R V R')^-1 (R b) / q, referred to F(q, G-1). The reference
    category is the first in sorted order, fixed so the test is reproducible.
    """
    keep = [(c, yi, gi) for c, yi, gi in zip(cat, y, clusters)
            if c is not None and yi is not None
            and not (isinstance(yi, float) and math.isnan(yi))]
    levels = sorted({k[0] for k in keep})
    if len(levels) < 2:
        raise SingularDesign(f"categorical feature has {len(levels)} level(s)")
    ref, others = levels[0], levels[1:]
    ry = average_ranks([k[1] for k in keep])
    X = [[1.0 if k[0] == lv else 0.0 for lv in others] for k in keep]
    out = cr1_ols(ry, X, [k[2] for k in keep], alpha)

    q = len(others)
    b = [out["beta"][j + 1] for j in range(q)]
    Vsub = [[out["V"][a + 1][b_ + 1] for b_ in range(q)] for a in range(q)]
    Vinv = _inv(Vsub)
    wald = sum(b[a] * sum(Vinv[a][c] * b[c] for c in range(q)) for a in range(q)) / q
    out.update(kind="categorical_omnibus", levels=levels, reference=ref,
               q=q, wald_F=wald, p_of_interest=f_sf(wald, q, out["df"]),
               beta_of_interest=None, ci_of_interest=None,
               category_betas=dict(zip(others, b)))
    return out


def holm(pvalues, alpha=0.05):
    """Holm step-down FWER control. Returns [(key, p, adjusted_p, reject)]."""
    items = sorted(pvalues.items(), key=lambda kv: kv[1])
    m = len(items)
    out, running = [], 0.0
    for i, (k, p) in enumerate(items):
        adj = min(1.0, max(running, (m - i) * p))
        running = adj
        out.append((k, p, adj, adj <= alpha))
    return out
