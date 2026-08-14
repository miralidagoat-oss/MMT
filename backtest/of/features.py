"""Order-flow + options-flow feature engine.

Every feature here is deliberately constrained to things that can also be
computed inside Pine Script v6 on a TradingView chart. That constraint is the
whole point: a backtest feature with no Pine analogue is a feature you cannot
trade.

  order flow   <- built from 1-minute sub-bars, mirroring exactly what
                  ta.requestVolumeDelta()/request.security_lower_tf() gives Pine
  options flow <- CBOE VIX (request.security("CBOE:VIX")) combined with
                  realized vol measured on the chart

The dealer-gamma thesis
-----------------------
We cannot get a historical options chain for free, so we do not pretend to
compute true GEX. Instead we measure the *observable consequences* of dealer
gamma positioning, which is what actually matters for a trade:

  long-gamma  regime -> dealers sell rallies / buy dips -> index mean-reverts,
                        realized vol is suppressed, variance ratio < 1
  short-gamma regime -> dealers chase -> index trends, vol expands, VR > 1

Proxies: variance risk premium (VIX - realized), VIX z-score, and a direct
variance-ratio measurement of the tape.
"""
import numpy as np
import pandas as pd

RTH_START = pd.Timestamp("09:30").time()
RTH_END = pd.Timestamp("16:00").time()
ANNUAL = np.sqrt(252.0)


# ---------------------------------------------------------------- bar building
def signed_minute_volume(m1: pd.DataFrame) -> pd.DataFrame:
    """Classify each 1m bar as up/down volume.

    This is the same classification Pine applies to lower-timeframe bars when
    building volume delta: bar closes up -> volume counts as buying, closes
    down -> selling, unchanged -> neither.
    """
    m1 = m1.copy()
    up = m1["close"] > m1["open"]
    dn = m1["close"] < m1["open"]
    m1["buy_vol"] = np.where(up, m1["volume"], 0.0)
    m1["sell_vol"] = np.where(dn, m1["volume"], 0.0)
    return m1


def resample(m1: pd.DataFrame, rule: str) -> pd.DataFrame:
    """1m -> `rule` bars carrying true order-flow delta from the sub-bars."""
    g = m1.set_index("time").resample(rule, label="left", closed="left")
    bars = g.agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
        buy_vol=("buy_vol", "sum"),
        sell_vol=("sell_vol", "sum"),
        n_sub=("close", "size"),
    ).dropna(subset=["open"])
    bars["delta"] = bars["buy_vol"] - bars["sell_vol"]
    return bars.reset_index()


# ------------------------------------------------------- options-flow / regime
def realized_vol_daily(m1_ny: pd.DataFrame) -> pd.DataFrame:
    """Annualized realized vol per session from 1-minute returns.

    Sum of squared intraday log returns is the standard high-frequency
    realized-variance estimator; far more accurate than close-to-close.
    """
    df = m1_ny.copy()
    df["date"] = df["time_ny"].dt.date
    df["lr"] = np.log(df["close"]).groupby(df["date"]).diff()
    rv = df.groupby("date")["lr"].apply(lambda s: np.sqrt(np.nansum(s.values ** 2)))
    out = rv.to_frame("rv_daily").reset_index()
    out["rv_ann"] = out["rv_daily"] * ANNUAL * 100.0  # vol points, comparable to VIX
    return out


def variance_ratio(close: pd.Series, k: int = 6, window: int = 390) -> pd.Series:
    """Lo-MacKinlay variance ratio on a rolling window.

    VR = Var(k-bar returns) / (k * Var(1-bar returns))
      VR < 1 -> mean reverting (consistent with dealers long gamma)
      VR > 1 -> trending      (consistent with dealers short gamma)
    """
    lr = np.log(close).diff()
    v1 = lr.rolling(window).var()
    vk = np.log(close).diff(k).rolling(window).var()
    return vk / (k * v1)


def build_daily_regime(rv: pd.DataFrame, vix: pd.DataFrame) -> pd.DataFrame:
    """Daily options-flow regime table. Everything is lagged one session.

    The lag is essential: VIX close and the session's realized vol are only
    known after the close, so a bar during session T may only use data through
    session T-1. Without this the backtest silently peeks.
    """
    d = rv.merge(vix, on="date", how="left").sort_values("date").reset_index(drop=True)
    d["vix_close"] = d["vix_close"].ffill()

    d["vrp"] = d["vix_close"] - d["rv_ann"]
    d["vix_chg"] = d["vix_close"].diff()
    d["vix_z"] = _z(d["vix_close"], 252)
    d["vrp_z"] = _z(d["vrp"], 252)
    d["rv_5"] = d["rv_ann"].rolling(5).mean()
    d["rv_20"] = d["rv_ann"].rolling(20).mean()
    # short-horizon vs long-horizon realized: a term-structure analogue.
    # < 1 => calm front end (contango-like), > 1 => front-end stress.
    d["rv_term"] = d["rv_5"] / d["rv_20"]

    # lag EVERYTHING by one session
    cols = ["vix_close", "vrp", "vix_chg", "vix_z", "vrp_z",
            "rv_ann", "rv_5", "rv_20", "rv_term"]
    for c in cols:
        d[c] = d[c].shift(1)
    return d[["date"] + cols]


def _z(s: pd.Series, n: int) -> pd.Series:
    return (s - s.rolling(n).mean()) / s.rolling(n).std(ddof=0)


# ------------------------------------------------------------ intraday features
def build_intraday(bars: pd.DataFrame, tf_per_day: int) -> pd.DataFrame:
    """Order-flow and microstructure features on the trading timeframe."""
    b = bars.copy()
    b["date"] = b["time_ny"].dt.date
    b["tod"] = b["time_ny"].dt.hour * 60 + b["time_ny"].dt.minute
    grp = b.groupby("date", sort=False)

    rng = (b["high"] - b["low"]).replace(0, np.nan)
    b["range"] = rng

    # ---- order flow
    b["imbalance"] = b["delta"] / b["volume"].replace(0, np.nan)
    b["cvd"] = grp["delta"].cumsum()                       # session cumulative delta
    b["delta_z"] = _z(b["delta"], 100)
    # effort vs result: lots of delta, no price movement => absorption
    b["absorption"] = b["delta"].abs() / (rng / rng.rolling(100).mean())

    # relative volume against this bar's own time-of-day history. Rolling, not
    # expanding: tick volume grows secularly over 15 years, and an expanding
    # baseline would bake that trend into the feature.
    tod_mean = b.groupby("tod")["volume"].transform(
        lambda s: s.shift(1).rolling(60, min_periods=20).mean())
    b["rel_vol"] = b["volume"] / tod_mean

    # ---- session VWAP and dispersion bands
    pv = b["close"] * b["volume"]
    cum_pv = grp_cumsum(pv, b["date"])
    cum_v = grp_cumsum(b["volume"], b["date"])
    b["vwap"] = cum_pv / cum_v
    dev2 = grp_cumsum((b["close"] ** 2) * b["volume"], b["date"]) / cum_v - b["vwap"] ** 2
    b["vwap_sd"] = np.sqrt(dev2.clip(lower=0))
    b["vwap_z"] = (b["close"] - b["vwap"]) / b["vwap_sd"].replace(0, np.nan)

    # ---- volatility / structure
    tr = pd.concat([
        b["high"] - b["low"],
        (b["high"] - b["close"].shift()).abs(),
        (b["low"] - b["close"].shift()).abs(),
    ], axis=1).max(axis=1)
    b["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
    b["range_exp"] = rng / rng.rolling(20).mean()
    b["close_pos"] = (b["close"] - b["low"]) / rng          # 0 = on low, 1 = on high

    # sweep of the prior N-bar extreme, then rejection back inside
    n = 12
    prior_hi = b["high"].rolling(n).max().shift(1)
    prior_lo = b["low"].rolling(n).min().shift(1)
    b["swept_hi"] = (b["high"] > prior_hi) & (b["close"] < prior_hi)
    b["swept_lo"] = (b["low"] < prior_lo) & (b["close"] > prior_lo)

    # variance ratio measured on the trading timeframe
    b["vr"] = variance_ratio(b["close"], k=6, window=tf_per_day * 5)

    b["ret_fwd1"] = np.log(b["close"].shift(-1) / b["close"])
    return b


def grp_cumsum(s: pd.Series, key: pd.Series) -> pd.Series:
    return s.groupby(key).cumsum()


# --------------------------------------------------------------------- assembly
def assemble(m1: pd.DataFrame, vix: pd.DataFrame, tf: str = "5min",
             rth_only: bool = True) -> pd.DataFrame:
    m1 = signed_minute_volume(m1)
    m1["time_ny"] = m1["time"].dt.tz_convert("America/New_York")

    rv = realized_vol_daily(m1[in_rth(m1["time_ny"])])
    daily = build_daily_regime(rv, vix)

    bars = resample(m1, tf)
    bars["time_ny"] = bars["time"].dt.tz_convert("America/New_York")
    if rth_only:
        bars = bars[in_rth(bars["time_ny"])].reset_index(drop=True)

    per_day = int(6.5 * 60 / int(tf.replace("min", "")))
    feat = build_intraday(bars, per_day)
    feat = feat.merge(daily, on="date", how="left")
    return feat


def in_rth(t_ny: pd.Series) -> pd.Series:
    tt = t_ny.dt.time
    wd = t_ny.dt.weekday
    return (tt >= RTH_START) & (tt < RTH_END) & (wd < 5)
