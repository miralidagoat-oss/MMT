"""Third pass: test effects that have real prior evidence in the literature.

Passes 1-2 established that intraday VWAP-reversion, sweep-fades and delta
confirmation have no edge on 15y of NDX (all below a random-signal baseline of
PF~1.05). Rather than keep drawing darts, test the handful of index-futures
effects that are actually documented, and see which survive here:

  1. overnight vs intraday decomposition (Cliff/Cooper/Gulen: essentially the
     entire equity risk premium accrues overnight, intraday drift ~ 0)
  2. drift by time of day
  3. those effects conditioned on the options-flow regime (VIX / VRP)
  4. day-of-week and monthly-OPEX gamma-pin effects

Train slice only.
"""
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, "backtest/of")
import features as F  # noqa: E402

TRAIN_END = pd.Timestamp("2015-01-01").date()


def sessions(m1: pd.DataFrame) -> pd.DataFrame:
    """Build a daily table of overnight and intraday returns."""
    m1 = m1.copy()
    m1["time_ny"] = m1["time"].dt.tz_convert("America/New_York")
    m1["date"] = m1["time_ny"].dt.date
    rth = m1[F.in_rth(m1["time_ny"])]

    day = rth.groupby("date").agg(
        rth_open=("open", "first"), rth_close=("close", "last"),
        rth_high=("high", "max"), rth_low=("low", "min"),
        vol=("volume", "sum"),
    ).reset_index()
    day["prev_close"] = day["rth_close"].shift(1)
    # overnight = prior RTH close -> today's RTH open ; intraday = open -> close
    day["overnight"] = np.log(day["rth_open"] / day["prev_close"]) * 1e4
    day["intraday"] = np.log(day["rth_close"] / day["rth_open"]) * 1e4
    day["full"] = day["overnight"] + day["intraday"]
    return day.dropna()


def t_of(x):
    x = pd.Series(x).dropna()
    if len(x) < 30:
        return np.nan, np.nan, 0
    return x.mean(), x.mean() / (x.std(ddof=1) / np.sqrt(len(x))), len(x)


def show(label, x, ann_days=252):
    m, t, n = t_of(x)
    if n == 0:
        print(f"  {label:<44} n too small")
        return
    ann = m * ann_days / 100.0  # bps/day -> % per year
    star = "  ***" if abs(t) > 3 else ("  *" if abs(t) > 2 else "")
    print(f"  {label:<44} {m:+7.2f} bp/day  t={t:+6.2f}  n={n:>5,}"
          f"  ~{ann:+6.1f}%/yr{star}")


def main():
    m1 = pd.read_parquet("/workspace/data/prepared/nas100_m1.parquet")
    vix = pd.read_parquet("/workspace/data/prepared/vix_daily.parquet")
    day = sessions(m1)
    day = day[day["date"] < TRAIN_END]

    print("=" * 84)
    print("1. OVERNIGHT vs INTRADAY decomposition  (NDX, train 2005-2014)")
    print("=" * 84)
    show("overnight  (prev close -> open)", day["overnight"])
    show("intraday   (open -> close)", day["intraday"])
    show("full day", day["full"])

    # regime conditioning
    v = vix.copy()
    v["vix_prev"] = v["vix_close"].shift(1)
    v["vix_z"] = ((v["vix_close"] - v["vix_close"].rolling(252).mean())
                  / v["vix_close"].rolling(252).std(ddof=0)).shift(1)
    d = day.merge(v[["date", "vix_prev", "vix_z"]], on="date", how="left")

    print("\n" + "=" * 84)
    print("2. OVERNIGHT edge conditioned on the options-flow regime")
    print("=" * 84)
    for lo, hi in [(0, 13), (13, 17), (17, 22), (22, 200)]:
        m = (d["vix_prev"] >= lo) & (d["vix_prev"] < hi)
        show(f"overnight | VIX in [{lo},{hi})", d.loc[m, "overnight"])
    print()
    for lo, hi in [(-9, -1), (-1, 0), (0, 1), (1, 9)]:
        m = (d["vix_z"] >= lo) & (d["vix_z"] < hi)
        show(f"overnight | VIX z in [{lo},{hi})", d.loc[m, "overnight"])

    print("\n" + "=" * 84)
    print("3. INTRADAY edge conditioned on regime (is fading ever right?)")
    print("=" * 84)
    for lo, hi in [(0, 13), (13, 17), (17, 22), (22, 200)]:
        m = (d["vix_prev"] >= lo) & (d["vix_prev"] < hi)
        show(f"intraday | VIX in [{lo},{hi})", d.loc[m, "intraday"])

    print("\n" + "=" * 84)
    print("4. DAY OF WEEK / OPEX")
    print("=" * 84)
    d["dt"] = pd.to_datetime(d["date"])
    d["dow"] = d["dt"].dt.dayofweek
    for i, nm in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri"]):
        show(f"overnight | {nm}", d.loc[d["dow"] == i, "overnight"])
    print()
    # monthly opex = third Friday
    d["is_opex_week"] = (d["dt"].dt.day.between(14, 20)) & (d["dow"] == 4)
    show("intraday | monthly OPEX Friday", d.loc[d["is_opex_week"], "intraday"])
    show("intraday | all other days", d.loc[~d["is_opex_week"], "intraday"])

    print("\n" + "=" * 84)
    print("5. INTRADAY DRIFT BY HOUR (RTH, train)")
    print("=" * 84)
    bars = F.assemble(m1, vix, tf="60min")
    bars = bars[bars["date"] < TRAIN_END]
    bars["ret"] = np.log(bars["close"] / bars["open"]) * 1e4
    for tod, g in bars.groupby("tod"):
        hh, mm = divmod(int(tod), 60)
        show(f"{hh:02d}:{mm:02d} ET hourly bar", g["ret"])


if __name__ == "__main__":
    main()
