#!/usr/bin/env python3
"""MMT-X: a walk-forward multi-signal model for NQ intraday.

This is a different animal from everything else in the repo. Every previous
version was ONE hand-written rule -- fade a sweep, break a range -- tuned until
its backtest looked good. That approach has now failed twice under honest
measurement, and the reason is structural: no single OHLCV pattern on NQ has
information content above |IC| 0.02, so there is nothing for a single rule to
stand on.

Systematic desks do not solve this by finding a stronger pattern. They combine
many weak ones. A dozen features with IC 0.02 that are not perfectly
correlated can produce a combined signal worth trading, and none of the
individual pieces would ever look impressive on its own.

So: standardise a feature set (NQ microstructure + cross-asset relative
value), fit a ridge regression to forward returns on past data only, trade the
tails of the prediction with a volatility stop and a session exit, and walk it
forward year by year. Parameters and coefficients for year Y come only from
years < Y.

The model is deliberately linear. If a linear combination of these features
finds nothing, a nonlinear one on the same features is fitting noise with more
degrees of freedom, not finding a deeper truth.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

import core
import engine
import validate
from core import POINT_VALUE, TICK
from edge_search import build_panel, features, responses, NMIN
import xpanel

FLAT_M = 385
COMMISSION_PTS = 1.20 / POINT_VALUE
SLIP_PTS = TICK


@dataclass
class ModelCfg:
    horizon: int = 60          # forward minutes the model is trained to predict
    step: int = 5              # decision grid, minutes
    first_m: int = 15          # no decisions before 09:45
    last_m: int = 330          # no new entries after 15:00
    ridge: float = 30.0        # regularisation
    entry_q: float = 0.90      # trade above this quantile of |prediction|
    stop_sig: float = 0.60     # stop, in units of the day's volatility scale
    max_trades_day: int = 2
    min_train_days: int = 400


def build_design(P, scale):
    """Assemble features + response into aligned (days, minutes) matrices."""
    F, _ = features(P)
    X, names = [], []
    for k, v in F.items():
        X.append(v)
        names.append(k)
    for k, v in xpanel.micro_features(P, scale).items():
        X.append(v)
        names.append(k)
    XF, loaded = xpanel.cross_features(P, scale)
    for k, v in XF.items():
        X.append(v)
        names.append(k)
    return np.stack(X, axis=-1), names, loaded


def fit_ridge(X, y, lam):
    """Ridge on standardised columns. Returns (beta, mu, sd, y_mu)."""
    ok = np.isfinite(X).all(axis=1) & np.isfinite(y)
    if ok.sum() < 500:
        return None
    Xt, yt = X[ok], y[ok]
    mu = Xt.mean(axis=0)
    sd = Xt.std(axis=0)
    sd[sd < 1e-12] = 1.0
    Z = (Xt - mu) / sd
    ymu = yt.mean()
    yc = yt - ymu
    A = Z.T @ Z + lam * np.eye(Z.shape[1])
    beta = np.linalg.solve(A, Z.T @ yc)
    return beta, mu, sd, ymu


def predict(X, fit):
    beta, mu, sd, ymu = fit
    Z = (X - mu) / sd
    p = Z @ beta + ymu
    p[~np.isfinite(X).all(axis=-1)] = np.nan
    return p


def simulate(P, scale, pred, cfg: ModelCfg, thresh, day_lo, day_hi):
    """Trade the tails of the prediction. Market entry, vol stop, time/EOD exit."""
    H, L, C, days = P["H"], P["L"], P["C"], P["days"]
    out = []
    for d in range(day_lo, day_hi):
        sc = scale[d, 0]
        if not np.isfinite(sc) or sc <= 0:
            continue
        n_today = 0
        m = cfg.first_m
        while m <= cfg.last_m and n_today < cfg.max_trades_day:
            p = pred[d, m]
            if not np.isfinite(p) or abs(p) < thresh:
                m += cfg.step
                continue
            side = 1 if p > 0 else -1
            entry = C[d, m] + side * SLIP_PTS
            risk = cfg.stop_sig * sc
            if risk < 4 * TICK:
                break
            stop = entry - side * risk
            end = min(m + cfg.horizon, FLAT_M)
            exit_m, exit_px, reason = -1, np.nan, engine.X_TIME
            peak = entry
            for j in range(m + 1, end + 1):
                hi, lo = H[d, j], L[d, j]
                peak = max(peak, hi) if side == 1 else min(peak, lo)
                if (lo <= stop) if side == 1 else (hi >= stop):
                    exit_m, exit_px, reason = j, stop - side * SLIP_PTS, engine.X_STOP
                    break
            if exit_m < 0:
                exit_m = end
                exit_px = C[d, end] - side * SLIP_PTS
                reason = engine.X_FLAT if end == FLAT_M else engine.X_TIME
            gross = (exit_px - entry) * side
            net = gross - COMMISSION_PTS
            ts = int(days[d]) * 86400
            out.append((ts + m * 60, ts + m * 60, ts + exit_m * 60, side, entry,
                        stop, np.nan, exit_px, risk, reason, gross / risk,
                        net / risk, net * POINT_VALUE, 0.0,
                        (peak - entry) * side / risk, exit_m - m,
                        570 + m, int(days[d]), 0))
            n_today += 1
            m = exit_m + cfg.step
        # while
    return np.array(out, dtype=engine.TRADE_DTYPE) if out else \
        np.empty(0, dtype=engine.TRADE_DTYPE)


def walk_forward(P, scale, X, cfg: ModelCfg, verbose=True):
    """Expanding-window walk-forward by calendar year."""
    R = responses(P, scale, horizons=(cfg.horizon,))
    y = R[f"y{cfg.horizon}"]
    nd = len(P["C"])
    yr = (P["days"] * 86400).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    years = np.unique(yr)

    grid = np.zeros((nd, NMIN), dtype=bool)
    grid[:, cfg.first_m:cfg.last_m + 1:cfg.step] = True
    grid &= np.isfinite(scale)

    oos, folds = [], []
    for Y in years:
        tr = yr < Y
        te = yr == Y
        if tr.sum() < cfg.min_train_days or te.sum() < 30:
            continue
        gtr = grid & tr[:, None]
        fit = fit_ridge(X[gtr], y[gtr], cfg.ridge)
        if fit is None:
            continue
        # threshold from the TRAINING distribution only
        ptr = predict(X[gtr], fit)
        ptr = ptr[np.isfinite(ptr)]
        if len(ptr) < 200:
            continue
        thresh = np.quantile(np.abs(ptr - np.median(ptr)), cfg.entry_q)

        pred = np.full((nd, NMIN), np.nan)
        gte = grid & te[:, None]
        pred[gte] = predict(X[gte], fit)
        lo, hi = int(np.argmax(te)), int(nd - np.argmax(te[::-1]))
        led = simulate(P, scale, pred, cfg, thresh, lo, hi)
        s = engine.stats(led)
        folds.append((int(Y), s, fit[0]))
        if len(led):
            oos.append(led)
        if verbose:
            print(f"  {Y}: train {tr.sum():>4}d  n={s['n']:>4}  WR={s['wr']:>5.1f}%  "
                  f"PF={s['pf']:>5.2f}  net={s['net_r']:>+7.1f}R")
    ledger = np.concatenate(oos) if oos else np.empty(0, dtype=engine.TRADE_DTYPE)
    return ledger, folds


def main():
    m1 = core.load_1m()
    P = build_panel(m1)
    F, scale = features(P)
    X, names, loaded = build_design(P, scale)
    print(f"panel {len(P['C'])} sessions | {X.shape[-1]} features")
    print(f"cross-asset series loaded: {loaded or 'NONE'}")
    print(f"features: {', '.join(names)}\n")

    cfg = ModelCfg()
    print("walk-forward by year (model fit only on prior years):")
    led, folds = walk_forward(P, scale, X, cfg)
    print()
    print(engine.fmt(engine.stats(led), "STITCHED OOS"))
    return P, scale, X, names, led, folds


if __name__ == "__main__":
    main()


# ── triple-barrier labelling ─────────────────────────────────────────────────

def triple_barrier(P, scale, cfg: ModelCfg, grid):
    """Label each decision by which barrier a long trade would hit first.

    Training on raw forward return teaches the model to predict something it
    will never collect: the trade does not run to the horizon, it exits at a
    stop. Labelling by which barrier is touched first (Lopez de Prado's triple
    barrier) aligns the target with the execution the strategy actually uses,
    so the model optimises the thing being traded.

    +1  upper barrier first, -1  lower barrier first, 0  neither inside the
    horizon (settled by the sign of the terminal move, scaled down).
    """
    H, L, C = P["H"], P["L"], P["C"]
    nd = len(C)
    y = np.full((nd, NMIN), np.nan)
    ms = np.flatnonzero(grid.any(axis=0))
    for d in range(nd):
        sc = scale[d, 0]
        if not np.isfinite(sc) or sc <= 0:
            continue
        risk = cfg.stop_sig * sc
        for m in ms:
            if not grid[d, m]:
                continue
            end = min(m + cfg.horizon, FLAT_M)
            if end <= m:
                continue
            c0 = C[d, m]
            if not np.isfinite(c0):
                continue
            hi = H[d, m + 1:end + 1]
            lo = L[d, m + 1:end + 1]
            up = np.flatnonzero(hi >= c0 + risk)
            dn = np.flatnonzero(lo <= c0 - risk)
            iu = up[0] if len(up) else 10 ** 9
            idn = dn[0] if len(dn) else 10 ** 9
            if iu == idn == 10 ** 9:
                y[d, m] = 0.25 * np.sign(C[d, end] - c0)
            elif iu < idn:
                y[d, m] = 1.0
            elif idn < iu:
                y[d, m] = -1.0
            else:
                y[d, m] = 0.0
    return y


def walk_forward2(P, scale, X, cfg: ModelCfg, target="barrier", verbose=True):
    """As walk_forward, but selectable target and cached labels."""
    nd = len(P["C"])
    grid = np.zeros((nd, NMIN), dtype=bool)
    grid[:, cfg.first_m:cfg.last_m + 1:cfg.step] = True
    grid &= np.isfinite(scale)

    if target == "barrier":
        y = triple_barrier(P, scale, cfg, grid)
    else:
        y = responses(P, scale, horizons=(cfg.horizon,))[f"y{cfg.horizon}"]

    yr = (P["days"] * 86400).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    oos, folds = [], []
    for Y in np.unique(yr):
        tr, te = yr < Y, yr == Y
        if tr.sum() < cfg.min_train_days or te.sum() < 30:
            continue
        gtr = grid & tr[:, None]
        fit = fit_ridge(X[gtr], y[gtr], cfg.ridge)
        if fit is None:
            continue
        ptr = predict(X[gtr], fit)
        ptr = ptr[np.isfinite(ptr)]
        if len(ptr) < 200:
            continue
        thresh = np.quantile(np.abs(ptr - np.median(ptr)), cfg.entry_q)
        pred = np.full((nd, NMIN), np.nan)
        gte = grid & te[:, None]
        pred[gte] = predict(X[gte], fit)
        lo, hi = int(np.argmax(te)), int(nd - np.argmax(te[::-1]))
        led = simulate(P, scale, pred, cfg, thresh, lo, hi)
        s = engine.stats(led)
        folds.append((int(Y), s, fit[0]))
        if len(led):
            oos.append(led)
        if verbose:
            print(f"  {Y}: n={s['n']:>4}  WR={s['wr']:>5.1f}%  PF={s['pf']:>5.2f}  "
                  f"net={s['net_r']:>+7.1f}R")
    ledger = np.concatenate(oos) if oos else np.empty(0, dtype=engine.TRADE_DTYPE)
    return ledger, folds


# ── nested walk-forward: hyperparameters chosen on a validation split ────────

def _grid_cfgs(base: ModelCfg):
    out = []
    for hz in (30, 60, 120):
        for st in (0.4, 0.6, 1.0):
            for q in (0.90, 0.96):
                for lam in (10.0, 100.0):
                    c = ModelCfg(**{**base.__dict__})
                    c.horizon, c.stop_sig, c.entry_q, c.ridge = hz, st, q, lam
                    out.append(c)
    return out


def walk_forward_nested(P, scale, X, base: ModelCfg, verbose=True, cfgs=None):
    """Choose the model's own hyperparameters the same way it chooses its
    coefficients: on past data only.

    Reporting the best of a hyperparameter grid picked by its test-set score
    is the oldest way to publish a fake edge. Here the training block is split
    -- everything but its final year fits the ridge, the final year scores the
    configuration -- and only the winner is applied to the untouched test year.
    """
    nd = len(P["C"])
    yr = (P["days"] * 86400).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    years = np.unique(yr)
    cfgs = cfgs or _grid_cfgs(base)

    # cache barrier labels per (horizon, stop_sig) so the grid is affordable
    cache = {}

    def labels_for(c):
        key = (c.horizon, c.stop_sig, c.step, c.first_m, c.last_m)
        if key not in cache:
            g = np.zeros((nd, NMIN), dtype=bool)
            g[:, c.first_m:c.last_m + 1:c.step] = True
            g &= np.isfinite(scale)
            cache[key] = (triple_barrier(P, scale, c, g), g)
        return cache[key]

    oos, folds = [], []
    for Y in years:
        tr = yr < Y
        te = yr == Y
        if tr.sum() < base.min_train_days or te.sum() < 30:
            continue
        val_year = years[np.searchsorted(years, Y) - 1]
        inner = tr & (yr < val_year)
        val = yr == val_year
        if inner.sum() < 300 or val.sum() < 30:
            continue

        best, best_sc = None, -1e18
        for c in cfgs:
            y, g = labels_for(c)
            fit = fit_ridge(X[g & inner[:, None]], y[g & inner[:, None]], c.ridge)
            if fit is None:
                continue
            pin = predict(X[g & inner[:, None]], fit)
            pin = pin[np.isfinite(pin)]
            if len(pin) < 200:
                continue
            th = np.quantile(np.abs(pin - np.median(pin)), c.entry_q)
            pred = np.full((nd, NMIN), np.nan)
            gv = g & val[:, None]
            pred[gv] = predict(X[gv], fit)
            lo, hi = int(np.argmax(val)), int(nd - np.argmax(val[::-1]))
            led = simulate(P, scale, pred, c, th, lo, hi)
            if len(led) < 40:
                continue
            r = led["r_net"]
            sc_ = r.mean() - 0.5 * abs(r.mean()) / np.sqrt(len(r))
            if sc_ > best_sc:
                best_sc, best = sc_, c
        if best is None:
            continue

        # refit the winner on the FULL training block, then trade the test year
        y, g = labels_for(best)
        fit = fit_ridge(X[g & tr[:, None]], y[g & tr[:, None]], best.ridge)
        if fit is None:
            continue
        ptr = predict(X[g & tr[:, None]], fit)
        ptr = ptr[np.isfinite(ptr)]
        th = np.quantile(np.abs(ptr - np.median(ptr)), best.entry_q)
        pred = np.full((nd, NMIN), np.nan)
        gt = g & te[:, None]
        pred[gt] = predict(X[gt], fit)
        lo, hi = int(np.argmax(te)), int(nd - np.argmax(te[::-1]))
        led = simulate(P, scale, pred, best, th, lo, hi)
        s = engine.stats(led)
        folds.append((int(Y), s, best, fit[0]))
        if len(led):
            oos.append(led)
        if verbose:
            print(f"  {Y}: hz={best.horizon:>3} stop={best.stop_sig} q={best.entry_q} "
                  f"lam={best.ridge:>5.0f} | n={s['n']:>4} WR={s['wr']:>5.1f}% "
                  f"PF={s['pf']:>5.2f} net={s['net_r']:>+7.1f}R")
    ledger = np.concatenate(oos) if oos else np.empty(0, dtype=engine.TRADE_DTYPE)
    return ledger, folds
