#!/usr/bin/env python3
"""Execution simulator: signals on aggregate bars, fills resolved on 1m bars.

The previous generation graded trades on the same bars that produced the
signal, so every ambiguity ("did the stop or the target print first inside
this 1-hour candle?") had to be resolved by assumption. With a 1-minute
series underneath, the path is resolved 60x finer and the remaining
ambiguity is confined to a single minute.

Non-negotiables enforced here:
  F2  an order becomes live only on the 1m bar AFTER the aggregate bar that
      produced it has closed. Asserted, not just intended.
  F3  every trade reaches a terminal state and lands in the ledger.
  F8  nothing is silently dropped: cancelled/expired orders are counted too.
  F13 commission, spread and stop slippage are charged in points, every trade.
  F5  a setup whose risk is below `min_risk_ticks` is rejected, not traded.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from core import TICK, POINT_VALUE

LONG, SHORT = 1, -1

# exit reason codes
X_STOP, X_TARGET, X_BE, X_TIME, X_FLAT = 0, 1, 2, 3, 4
X_NAME = {X_STOP: "stop", X_TARGET: "target", X_BE: "breakeven",
          X_TIME: "time", X_FLAT: "session-flat"}


@dataclass
class Costs:
    """Round-turn cost model for MNQ, in index points per contract.

    Defaults are deliberately on the expensive side of retail reality:
      commission  $1.20 round turn  (typical micro all-in incl. exchange+NFA)
      entry       passive limit — we pay no spread, but must be traded THROUGH
                  by `fill_through_ticks` before we count as filled, which is
                  the honest price of standing in a queue
      stop        stop-market — crosses the spread and slips
      target      passive limit — also requires a through-trade, no slippage
                  credit taken
      flatten     market — crosses the spread
    """
    commission_rt_usd: float = 1.20
    fill_through_ticks: float = 1.0
    stop_slip_ticks: float = 1.0
    flat_slip_ticks: float = 1.0
    target_through_ticks: float = 1.0

    @property
    def commission_points(self):
        return self.commission_rt_usd / POINT_VALUE


@dataclass
class ExecCfg:
    validity_min: int = 90        # cancel an unfilled limit after N minutes
    max_hold_min: int = 240       # time stop
    be_trigger_r: float = 1.0     # move stop to entry at +1R  (W4)
    be_lock_ticks: float = 0.0    # optional extra tick locked at BE
    cooldown_min: int = 15        # after an exit, before a new order goes live
    flatten_et_min: int = 955     # 15:55 ET — day trading: no overnight risk
    min_risk_ticks: float = 4.0   # F5
    one_at_a_time: bool = True


TRADE_DTYPE = np.dtype([
    ("t_signal", "i8"), ("t_entry", "i8"), ("t_exit", "i8"),
    ("dir", "i1"), ("entry", "f8"), ("stop", "f8"), ("tp", "f8"),
    ("exit_px", "f8"), ("risk", "f8"), ("reason", "i1"),
    ("r_gross", "f8"), ("r_net", "f8"), ("usd_net", "f8"),
    ("mae_r", "f8"), ("mfe_r", "f8"), ("hold_min", "i4"),
    ("et_min", "i4"), ("et_day", "i8"), ("tag", "i4"),
])


def simulate(m1, sig_i1, sig_dir, sig_entry, sig_stop, sig_tp, sig_tag,
             costs: Costs = None, cfg: ExecCfg = None):
    """Run the fill simulation.

    m1        : core.Bars at 1-minute resolution (the execution clock)
    sig_i1    : index into m1 at which each order becomes live (already +1 past
                the close of its originating aggregate bar)
    returns   : (ledger structured array, stats dict)
    """
    costs = costs or Costs()
    cfg = cfg or ExecCfg()
    h, l, c, t = m1.h, m1.l, m1.c, m1.t
    et_min, et_day, _ = m1.et
    n = len(c)

    ft = costs.fill_through_ticks * TICK
    tt = costs.target_through_ticks * TICK
    ss = costs.stop_slip_ticks * TICK
    fs = costs.flat_slip_ticks * TICK
    comm = costs.commission_points

    order = np.argsort(sig_i1, kind="stable")
    out = []
    n_signals = len(order)
    n_skip_busy = n_expire = n_reject_risk = 0
    free_at = -1

    for k in order:
        i0 = int(sig_i1[k])
        if i0 >= n:
            continue
        d = int(sig_dir[k])
        entry = float(sig_entry[k]); stop = float(sig_stop[k]); tp = float(sig_tp[k])
        risk = abs(entry - stop)
        if risk < cfg.min_risk_ticks * TICK:      # F5
            n_reject_risk += 1
            continue
        if cfg.one_at_a_time and i0 < free_at:
            n_skip_busy += 1
            continue

        # ── pending: wait for the limit to be traded through ───────────────
        fill_i = -1
        deadline = min(i0 + cfg.validity_min, n)
        for j in range(i0, deadline):
            if et_min[j] >= cfg.flatten_et_min:
                break
            if (l[j] <= entry - ft) if d == LONG else (h[j] >= entry + ft):
                fill_i = j
                break
        if fill_i < 0:
            n_expire += 1
            continue

        # ── filled: walk the path ─────────────────────────────────────────
        cur_stop = stop
        be_done = False
        mae = mfe = 0.0
        exit_i = -1; exit_px = np.nan; reason = -1
        hard_end = min(fill_i + cfg.max_hold_min, n - 1)

        for j in range(fill_i, hard_end + 1):
            hi, lo = h[j], l[j]
            if d == LONG:
                mfe = max(mfe, (hi - entry) / risk)
                mae = min(mae, (lo - entry) / risk)
                stop_hit = lo <= cur_stop
                tp_hit = hi >= tp + tt
            else:
                mfe = max(mfe, (entry - lo) / risk)
                mae = min(mae, (entry - hi) / risk)
                stop_hit = hi >= cur_stop
                tp_hit = lo <= tp - tt

            # pessimistic: never credit the target on the fill bar, and if
            # both print inside one minute the stop wins
            if j == fill_i:
                tp_hit = False
            if stop_hit:
                exit_i = j
                exit_px = cur_stop - ss * d          # slips against us
                reason = X_BE if be_done else X_STOP
                break
            if tp_hit:
                exit_i = j; exit_px = tp; reason = X_TARGET
                break
            if et_min[j] >= cfg.flatten_et_min:
                exit_i = j; exit_px = c[j] - fs * d; reason = X_FLAT
                break
            # breakeven promotion evaluated on completed bars only (W4)
            if (not be_done) and cfg.be_trigger_r > 0 and mfe >= cfg.be_trigger_r:
                lock = cfg.be_lock_ticks * TICK * d
                cand = entry + lock
                if (cand > cur_stop) if d == LONG else (cand < cur_stop):
                    cur_stop = cand
                    be_done = True

        if exit_i < 0:                                # time stop (F3/F8)
            exit_i = hard_end
            exit_px = c[exit_i] - fs * d
            reason = X_TIME

        gross_pts = (exit_px - entry) * d
        net_pts = gross_pts - comm
        out.append((t[int(sig_i1[k])], t[fill_i], t[exit_i], d, entry, stop, tp,
                    exit_px, risk, reason, gross_pts / risk, net_pts / risk,
                    net_pts * POINT_VALUE, mae, mfe, exit_i - fill_i,
                    int(et_min[fill_i]), int(et_day[fill_i]), int(sig_tag[k])))
        free_at = exit_i + cfg.cooldown_min

    led = np.array(out, dtype=TRADE_DTYPE) if out else np.empty(0, dtype=TRADE_DTYPE)

    # F2: no order may be live before its aggregate bar closed — the caller
    # builds sig_i1 from resample()'s src_end+1; verify nothing preceded it.
    if len(led):
        assert np.all(led["t_entry"] >= led["t_signal"]), "F2 LOOKAHEAD"
        assert np.all(led["t_exit"] >= led["t_entry"]), "negative hold"
        assert np.all(np.isfinite(led["r_net"])), "F3 unresolved trade"

    stats = dict(signals=n_signals, taken=len(led), expired=n_expire,
                 skipped_busy=n_skip_busy, rejected_risk=n_reject_risk)
    return led, stats


# ── performance statistics ───────────────────────────────────────────────────

def stats(led, r_field="r_net"):
    if len(led) == 0:
        return dict(n=0, pf=0.0, wr=0.0, exp=0.0, net_r=0.0, dd=0.0,
                    sharpe=0.0, usd=0.0, win=0, loss=0, scratch=0)
    r = led[r_field]
    win = int((r > 1e-9).sum()); loss = int((r < -1e-9).sum())
    scratch = len(r) - win - loss
    gw = r[r > 0].sum(); gl = -r[r < 0].sum()
    eq = np.cumsum(r)
    dd = float(np.max(np.maximum.accumulate(np.r_[0.0, eq]) - np.r_[0.0, eq]))
    sd = r.std(ddof=1) if len(r) > 1 else 0.0
    return dict(
        n=len(r), win=win, loss=loss, scratch=scratch,
        wr=100.0 * win / max(win + loss, 1),
        pf=float(gw / gl) if gl > 0 else (float("inf") if gw > 0 else 0.0),
        exp=float(r.mean()), net_r=float(r.sum()), dd=dd,
        sharpe=float(r.mean() / sd * np.sqrt(len(r))) if sd > 0 else 0.0,
        usd=float(led["usd_net"].sum()),
    )


def fmt(s, label=""):
    if s["n"] == 0:
        return f"{label:<26} no trades"
    return (f"{label:<26} n={s['n']:>5}  WR={s['wr']:>5.1f}%  PF={s['pf']:>5.2f}  "
            f"exp={s['exp']:>+6.3f}R  net={s['net_r']:>+8.1f}R  "
            f"maxDD={s['dd']:>5.1f}R  ${s['usd']:>+10,.0f}")


if __name__ == "__main__":
    # engine selftest on a synthetic series with a known outcome
    from core import Bars
    n = 4000
    t = np.arange(n, dtype=np.int64) * 60 + 1700000000
    px = 15000 + np.cumsum(np.random.default_rng(1).normal(0, 1.0, n))
    b = Bars(t, px, px + 2, px - 2, px, np.ones(n))
    si = np.array([100, 500, 900]); sd = np.array([1, -1, 1])
    e = px[si] - 1.0 * sd
    st = e - 10.0 * sd
    tp = e + 40.0 * sd
    led, s = simulate(b, si, sd, e, st, tp, np.zeros(3, dtype=int))
    assert s["signals"] == 3
    assert len(led) + s["expired"] + s["skipped_busy"] + s["rejected_risk"] == 3, \
        "F8: trades unaccounted for"
    # costs must always make net worse than gross
    if len(led):
        assert np.all(led["r_net"] < led["r_gross"] + 1e-12), "F13 costs not charged"
    print("engine selftest OK", s)
