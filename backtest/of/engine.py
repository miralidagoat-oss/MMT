"""Triple-barrier backtest engine with realistic MNQ costs.

Fill and accounting rules are deliberately pessimistic, because OHLC bars hide
the intrabar path and every ambiguity should be resolved against the strategy:

  * entry is at the NEXT bar's open after a confirmed signal (never the signal
    bar's close -- that is the single most common backtest lie)
  * if stop and target are both inside the same bar, the STOP is taken
  * time-stop exits book at that bar's close
  * costs are charged in points on every round trip

MNQ contract facts used here: $2.00 per index point, tick 0.25pt ($0.50).
Cost default 0.75pt round trip = 0.5pt spread/slippage + ~0.25pt commission,
which is realistic-to-conservative for a retail MNQ account.
"""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class Config:
    stop_atr: float = 1.0
    target_atr: float = 2.0
    max_hold: int = 24
    cost_points: float = 0.75
    point_value: float = 2.0
    allow_long: bool = True
    allow_short: bool = True
    cooldown: int = 3


@dataclass
class Result:
    trades: pd.DataFrame = field(default_factory=pd.DataFrame)

    @property
    def n(self):
        return len(self.trades)

    def summary(self) -> dict:
        t = self.trades
        if len(t) == 0:
            return {"trades": 0}
        r = t["r"]
        wins, losses = r[r > 0], r[r < 0]
        gp, gl = wins.sum(), -losses.sum()
        eq = r.cumsum()
        dd = (eq.cummax() - eq).max()
        # per-trade Sharpe annualized by observed trade frequency
        yrs = max((t["exit_time"].max() - t["entry_time"].min()).days / 365.25, 1e-9)
        tpy = len(t) / yrs
        sharpe = (r.mean() / r.std(ddof=1) * np.sqrt(tpy)) if r.std(ddof=1) > 0 else 0.0
        return {
            "trades": len(t),
            "per_year": round(tpy, 1),
            "win_rate": round((r > 0).mean() * 100, 2),
            "profit_factor": round(gp / gl, 3) if gl > 0 else np.inf,
            "expectancy_R": round(r.mean(), 4),
            "net_R": round(r.sum(), 1),
            "max_dd_R": round(dd, 1),
            "sharpe": round(sharpe, 2),
            "avg_win_R": round(wins.mean(), 3) if len(wins) else 0,
            "avg_loss_R": round(losses.mean(), 3) if len(losses) else 0,
            "net_usd": round(t["usd"].sum(), 0),
        }


def run(bars: pd.DataFrame, signal: pd.Series, cfg: Config) -> Result:
    """signal: +1 long, -1 short, 0 flat -- evaluated on the signal bar,
    entered at the next bar's open."""
    o = bars["open"].to_numpy(float)
    h = bars["high"].to_numpy(float)
    lo = bars["low"].to_numpy(float)
    c = bars["close"].to_numpy(float)
    atr = bars["atr"].to_numpy(float)
    ts = bars["time_ny"].to_numpy()
    day = bars["date"].to_numpy()
    sig = signal.to_numpy(float)
    n = len(bars)

    trades = []
    last_exit = -10**9

    for i in range(n - 1):
        s = sig[i]
        if s == 0 or not np.isfinite(s):
            continue
        if s > 0 and not cfg.allow_long:
            continue
        if s < 0 and not cfg.allow_short:
            continue
        if i - last_exit < cfg.cooldown:
            continue
        a = atr[i]
        if not np.isfinite(a) or a <= 0:
            continue

        entry_i = i + 1
        entry = o[entry_i]
        risk = cfg.stop_atr * a
        if risk <= 0:
            continue
        if s > 0:
            stop, target = entry - risk, entry + cfg.target_atr * a
        else:
            stop, target = entry + risk, entry - cfg.target_atr * a

        exit_i, exit_px, reason = None, None, None
        for j in range(entry_i, min(entry_i + cfg.max_hold, n)):
            # same-day only: never hold through the close
            if day[j] != day[entry_i]:
                exit_i, exit_px, reason = j - 1, c[j - 1], "eod"
                break
            hit_stop = (lo[j] <= stop) if s > 0 else (h[j] >= stop)
            hit_tgt = (h[j] >= target) if s > 0 else (lo[j] <= target)
            if hit_stop:                      # stop wins ties -- pessimistic
                exit_i, exit_px, reason = j, stop, "stop"
                break
            if hit_tgt:
                exit_i, exit_px, reason = j, target, "target"
                break
        if exit_i is None:
            exit_i = min(entry_i + cfg.max_hold, n) - 1
            exit_px, reason = c[exit_i], "time"

        gross = (exit_px - entry) * s
        net_pts = gross - cfg.cost_points
        trades.append({
            "entry_time": ts[entry_i], "exit_time": ts[exit_i],
            "dir": int(s), "entry": entry, "exit": exit_px, "stop": stop,
            "target": target, "reason": reason,
            "r": net_pts / risk, "points": net_pts,
            "usd": net_pts * cfg.point_value,
            "bars_held": exit_i - entry_i,
        })
        last_exit = exit_i

    df = pd.DataFrame(trades)
    if len(df):
        df["entry_time"] = pd.to_datetime(df["entry_time"])
        df["exit_time"] = pd.to_datetime(df["exit_time"])
    return Result(df)
