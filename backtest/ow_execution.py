#!/usr/bin/env python3
"""Obizhaeva-Wang optimal execution: solver, cost model, and paper verification.

Risk-neutral (Propositions 2 and 3):
    x_0 = x_T = X0/(rho T + 2)          discrete clips at both ends
    mu_t       = rho X0/(rho T + 2)     constant continuous rate between them
Note the striking result: the SCHEDULE depends only on rho and T -- not on
lambda, not on the depth q.  Only the COST depends on those.

Risk-averse (Proposition 4) is solved generically.  f solves the Riccati (A.22)
    f'(2 rho kappa + a s^2) - kappa rho^2 f^2 - 2 a s^2 rho f + 2 a s^2 rho = 0,
    f(T) = 1
the continuous-trade region is the locus X_t = g(t) D_t with
    g = -(f' - rho f)/(kappa f' + a s^2)
and the opening clip follows from the jump onto that locus, X0 - x_0 = g(0) kappa x_0:
    x_0 = X0/(1 + kappa g(0))
which is algebraically the paper's  X0 (kappa f'(0) + a s^2)/(kappa rho f(0) + a s^2).
Thereafter  mu_t = (rho g - g') D_t/(1 + kappa g)  and  dD/dt = -rho D + kappa mu.

`verify()` checks the generic solver against the closed form and reproduces
the paper's Table 1.  Risk aversion is exposed as a dimensionless urgency
u = a*sigma^2/(kappa*rho); u = 0 is risk neutral.

Modes:
  python3 ow_execution.py verify
  python3 ow_execution.py plan <contracts> <horizon_bars> [preset] [urgency]
"""
import math
import sys

# Full-sample estimates from ow_impact.py (see README for the derivation).
# rho and kappa are per BAR of the stated timeframe.
PRESETS = {
    #                 rho     kappa  lambda    ADV      $/pt  tick
    "MNQ_15m": dict(rho=0.2832, kappa=7.091, lam=24.994, adv=28333, ptval=2.0,  tick=0.25),
    "NQ_15m":  dict(rho=0.3182, kappa=5.957, lam=23.065, adv=5655,  ptval=20.0, tick=0.25),
    "MNQ_5m":  dict(rho=0.1407, kappa=1.465, lam=10.192, adv=9541,  ptval=2.0,  tick=0.25),
    "NQ_5m":   dict(rho=0.1492, kappa=1.256, lam=8.502,  adv=1906,  ptval=20.0, tick=0.25),
}


# ── solver ───────────────────────────────────────────────────────────────────

def _fprime(f, rho, kappa, asig2):
    A = 2.0 * rho * kappa + asig2
    return (kappa * rho * rho * f * f + 2.0 * asig2 * rho * f - 2.0 * asig2 * rho) / A


def schedule(X0, T, rho, kappa, urgency=0.0, N=400):
    """Optimal schedule. Returns (x0, continuous_total, xT, mu_series, dt).

    urgency u is dimensionless: a*sigma^2 = u*kappa*rho. u=0 -> risk neutral,
    in which case the exact closed form is used instead of the ODE solve.
    """
    if urgency <= 0.0:
        x0 = X0 / (rho * T + 2.0)
        mu = rho * X0 / (rho * T + 2.0)
        return x0, X0 - 2.0 * x0, x0, [mu] * N, T / N

    asig2 = urgency * kappa * rho
    h = T / N
    f = [0.0] * (N + 1)
    f[N] = 1.0
    for i in range(N, 0, -1):                      # backward RK4
        y = f[i]
        k1 = _fprime(y, rho, kappa, asig2)
        k2 = _fprime(y - 0.5 * h * k1, rho, kappa, asig2)
        k3 = _fprime(y - 0.5 * h * k2, rho, kappa, asig2)
        k4 = _fprime(y - h * k3, rho, kappa, asig2)
        f[i - 1] = y - (h / 6.0) * (k1 + 2 * k2 + 2 * k3 + k4)

    fp = [_fprime(f[i], rho, kappa, asig2) for i in range(N + 1)]
    g = [-(fp[i] - rho * f[i]) / (kappa * fp[i] + asig2) for i in range(N + 1)]
    gp = [0.0] * (N + 1)
    for i in range(N + 1):
        if i == 0:
            gp[i] = (g[1] - g[0]) / h
        elif i == N:
            gp[i] = (g[N] - g[N - 1]) / h
        else:
            gp[i] = (g[i + 1] - g[i - 1]) / (2 * h)

    x0 = X0 / (1.0 + kappa * g[0])
    X, D = X0 - x0, kappa * x0
    mu = []
    for i in range(N):
        m = max((rho * g[i] - gp[i]) * D / (1.0 + kappa * g[i]), 0.0)
        m = min(m, X / h) if h > 0 else m
        mu.append(m)
        X -= m * h
        D += (-rho * D + kappa * m) * h
    return x0, X0 - x0 - max(X, 0.0), max(X, 0.0), mu, h


# ── costs (net of fundamental value, in points x ADV-units) ──────────────────

def cost_optimal(X0, T, rho, kappa, lam):
    """Proposition 3 expected net execution cost."""
    return 0.5 * lam * X0 * X0 + kappa * X0 * X0 / (rho * T + 2.0)


def cost_twap(X0, T, rho, kappa, lam):
    """Conventional constant-rate (TWAP) net cost -- the paper's section 7.2."""
    rt = rho * T
    if rt <= 0:
        return 0.5 * lam * X0 * X0 + kappa * X0 * X0
    return 0.5 * lam * X0 * X0 + kappa * X0 * X0 * (rt - (1.0 - math.exp(-rt))) / (rt * rt)


def cost_market(X0, invq):
    """Cost of dumping the whole order into the book now: x^2/(2q)."""
    return 0.5 * invq * X0 * X0



def simulate_cost(x0, mu, dt, xT, rho, kappa, lam, invq):
    """Expected net cost of ANY schedule, walked through the paper's own
    state equations (A.11)-(A.13), excluding the strategy-independent
    fundamental term (F0 + s/2) X0.

      discrete trade x:  cost += (lam*Xcum + D + x/(2q))*x ; D += kappa*x
      continuous mu dt:  cost += (lam*Xcum + D)*mu*dt      ; dD = (-rho D + kappa mu) dt

    This prices risk-averse and hand-built schedules, which the closed-form
    Proposition-3 expression does not cover.  Its agreement with that
    expression on the risk-neutral schedule is checked in verify().
    """
    cost = 0.0
    D = 0.0
    xcum = 0.0
    if x0 > 0:
        cost += (lam * xcum + D + 0.5 * invq * x0) * x0
        D += kappa * x0
        xcum += x0
    for m in mu:
        cost += (lam * xcum + D) * m * dt
        D += (-rho * D + kappa * m) * dt
        xcum += m * dt
    if xT > 0:
        cost += (lam * xcum + D + 0.5 * invq * xT) * xT
        D += kappa * xT
        xcum += xT
    return cost


def twap_schedule(X0, T, N=400):
    """Constant-rate execution -- the conventional-model benchmark."""
    return 0.0, [X0 / T] * N, T / N, 0.0


# ── verification against the paper ───────────────────────────────────────────

def verify():
    print("═══ generic ODE solver (urgency=0) vs closed form, 48 configs ═══")
    worst = 0.0
    for X0 in (100000.0, 500.0):
        for T in (1.0, 6.5, 24.0):
            for rho in (0.05, 0.5, 2.0, 10.0):
                for kappa in (0.1, 7.09):
                    # force the ODE path with a vanishing urgency
                    x0, cont, xT, mu, _ = schedule(X0, T, rho, kappa, 1e-12, N=4000)
                    px0 = X0 / (rho * T + 2.0)
                    pmu = rho * X0 / (rho * T + 2.0)
                    worst = max(worst, abs(x0 - px0) / X0, abs(xT - px0) / X0,
                                abs(mu[len(mu) // 2] - pmu) / max(pmu, 1e-9))
    print(f"  worst relative error: {worst:.3e}")
    assert worst < 5e-3, "solver does not reproduce Proposition 2/3"
    print("  ✓ reproduces Propositions 2 and 3\n")

    print("═══ paper Table 1 (X0 = 100,000, T = 1 day) ═══")
    paper = {0.001: 49975, 0.01: 49751, 0.5: 40000, 1: 33333, 2: 25000, 4: 16667,
             5: 14286, 10: 8333, 20: 4545, 50: 1921, 300: 331, 1000: 100, 10000: 10}
    print(f"{'rho':>8} {'x0 (ours)':>11} {'x0 (paper)':>11} {'continuous':>12} {'match':>7}")
    bad = 0
    for rho, want in paper.items():
        x0, cont, xT, _, _ = schedule(100000.0, 1.0, rho, 7.09, 0.0)
        ok = abs(x0 - want) <= max(2, 0.0005 * want)
        bad += 0 if ok else 1
        print(f"{rho:>8} {x0:>11,.0f} {want:>11,} {cont:>12,.0f} {'ok' if ok else 'DIFF':>7}")
    print(f"  ({bad} row(s) differ; rho=50 is 100000/52 = 1923, a rounding slip in the table)\n")

    print("═══ grid-size sensitivity (sets the Pine loop count) ═══")
    print(f"{'N':>6} {'x0':>12} {'xT':>12} {'sum err':>10} {'vs N=4000':>11}")
    ref = None
    for N in (100, 200, 400, 800, 2000, 4000):
        x0, cont, xT, _, _ = schedule(100000.0, 8.0, 0.2832, 7.091, 1.0, N=N)
        ref = ref or x0
        print(f"{N:>6} {x0:>12,.1f} {xT:>12,.1f} "
              f"{abs(x0+cont+xT-100000.0):>10.2e} {abs(x0-ref)/ref:>11.2e}")


    print("\n═══ path simulator vs closed-form costs (must agree) ═══")
    print(f"{'case':<26} {'simulated':>12} {'closed form':>13} {'rel err':>10}")
    for X0, T, rho, kappa, lam in ((0.0176, 8.0, 0.2832, 7.091, 24.994),
                                   (0.1765, 16.0, 0.3182, 5.957, 23.065),
                                   (0.5000, 4.0, 1.0000, 3.000, 10.000)):
        invq = lam + kappa
        x0, cont, xT, mu, dt = schedule(X0, T, rho, kappa, 0.0, N=4000)
        sim = simulate_cost(x0, mu, dt, xT, rho, kappa, lam, invq)
        cf = cost_optimal(X0, T, rho, kappa, lam)
        print(f"{'OW optimal  T=' + str(T):<26} {sim:>12.6f} {cf:>13.6f} "
              f"{abs(sim-cf)/cf:>10.2e}")
        tx0, tmu, tdt, txT = twap_schedule(X0, T, 4000)
        sim = simulate_cost(tx0, tmu, tdt, txT, rho, kappa, lam, invq)
        cf = cost_twap(X0, T, rho, kappa, lam)
        print(f"{'TWAP        T=' + str(T):<26} {sim:>12.6f} {cf:>13.6f} "
              f"{abs(sim-cf)/cf:>10.2e}")
    print("  (the discrete clips carry an x^2/2q term the continuum formula")
    print("   also carries, so agreement here validates both)")

    print("\n═══ risk aversion front-loads the schedule (paper Figure 5) ═══")
    print(f"{'urgency':>9} {'first clip':>12} {'continuous':>12} {'last clip':>11} {'front %':>9}")
    for u in (0.0, 0.5, 1.0, 2.0, 5.0, 20.0):
        x0, cont, xT, _, _ = schedule(100000.0, 8.0, 0.2832, 7.091, u)
        print(f"{u:>9.2f} {x0:>12,.0f} {cont:>12,.0f} {xT:>11,.0f} {100*x0/100000:>9.1f}")


# ── planner ──────────────────────────────────────────────────────────────────

def plan(contracts, T_bars, preset="MNQ_15m", urgency=0.0):
    p = PRESETS[preset]
    rho, kappa, lam, adv, ptval = p["rho"], p["kappa"], p["lam"], p["adv"], p["ptval"]
    invq = lam + kappa
    X0 = contracts / adv                       # order size in ADV units
    x0, cont, xT, mu, dt = schedule(X0, T_bars, rho, kappa, urgency)

    def dollars(c):                            # points*ADV -> dollars
        return c * adv * ptval

    def per_contract(c):                       # points*ADV -> points per contract
        return c * adv / contracts if contracts else 0.0

    # a front-loaded (risk-averse) schedule is not priced by the Proposition-3
    # formula, so walk that one through the state equations instead
    c_opt = (simulate_cost(x0, mu, dt, xT, rho, kappa, lam, invq) if urgency > 0
             else cost_optimal(X0, T_bars, rho, kappa, lam))
    c_twp = cost_twap(X0, T_bars, rho, kappa, lam)
    c_mkt = cost_market(X0, invq)

    print(f"\n═══ {preset}   {contracts:,} contracts over {T_bars} bars  "
          f"(urgency {urgency}) ═══")
    print(f"  rho {rho:.4f}/bar  half-life {math.log(2)/rho:.2f} bars   "
          f"kappa {kappa:.3f}  lambda {lam:.3f}  depth {adv/invq:,.0f} contracts/pt")
    print(f"\n  SCHEDULE")
    print(f"    first clip (now)      {x0*adv:>12,.0f} contracts  ({100*x0/X0:.1f}%)")
    print(f"    continuous            {cont*adv:>12,.0f} contracts  ({100*cont/X0:.1f}%)"
          f"  = {cont*adv/T_bars:,.0f}/bar")
    print(f"    last clip (at T)      {xT*adv:>12,.0f} contracts  ({100*xT/X0:.1f}%)")
    print(f"\n  EXPECTED IMPACT COST (excess over arrival mid)")
    hdr = f"    {'strategy':<22} {'$ total':>12} {'pts/contract':>14} {'ticks':>8}"
    print(hdr)
    tag = "Obizhaeva-Wang" + (f" (u={urgency:g})" if urgency > 0 else "")
    for name, c in ((tag, c_opt), ("TWAP (constant rate)", c_twp),
                    ("market order now", c_mkt)):
        print(f"    {name:<22} {dollars(c):>12,.0f} {per_contract(c):>14.4f} "
              f"{per_contract(c)/p['tick']:>8.2f}")
    print(f"    {'-'*56}")
    if urgency > 0:
        print(f"    urgency {urgency:g} pays extra expected cost to cut variance,")
        print(f"    so treat the lines below as a decomposition, not a free lunch.")
    print(f"    {'saved vs TWAP':<22} {dollars(c_twp-c_opt):>12,.0f} "
          f"{100*(c_twp-c_opt)/c_twp:>13.2f}%")
    print(f"    {'saved vs market order':<22} {dollars(c_mkt-c_opt):>12,.0f} "
          f"{100*(c_mkt-c_opt)/c_mkt:>13.2f}%")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if mode == "verify":
        verify()
    else:
        plan(float(sys.argv[2]), float(sys.argv[3]),
             sys.argv[4] if len(sys.argv) > 4 else "MNQ_15m",
             float(sys.argv[5]) if len(sys.argv) > 5 else 0.0)
