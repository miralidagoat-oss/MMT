"""Load NAS100 1-minute bars + VIX daily into a single tidy parquet.

Sources (both public, fetched in-session):
  - NAS100_USD 1m OHLCV 2005..2020-05  : github.com/FutureSharks/financial-data (Oanda)
  - VIX daily OHLC 1990..present       : github.com/datasets/finance-vix (CBOE)

NAS100 is the Nasdaq-100 CFD -- the same underlying index MNQ/NQ futures track.
Volume is Oanda tick-volume (count of price updates), not CME contract volume.
That distinction is handled in the feature layer, not here.
"""
import glob
import os
import sys

import numpy as np
import pandas as pd

NAS_DIR = "/workspace/futuresharks/financial-data/pyfinancialdata/data/currencies/oanda/NAS100_USD"
VIX_CSV = "/workspace/data/finance-vix/data/vix-daily.csv"
OUT_DIR = "/workspace/data/prepared"


def load_nas100() -> pd.DataFrame:
    files = sorted(glob.glob(os.path.join(NAS_DIR, "*", "*.csv")))
    if not files:
        raise SystemExit(f"no NAS100 csv files under {NAS_DIR}")
    frames = []
    for f in files:
        df = pd.read_csv(f)
        frames.append(df)
    out = pd.concat(frames, ignore_index=True)
    out["time"] = pd.to_datetime(out["time"], utc=True)
    out = out[["time", "open", "high", "low", "close", "volume"]]
    out = out.dropna().sort_values("time").drop_duplicates("time")
    # Oanda feed occasionally emits zero-range filler bars on holidays.
    out = out[out["volume"] > 0]
    out = out[(out["high"] >= out["low"]) & (out["close"] > 0)]
    return out.reset_index(drop=True)


def load_vix() -> pd.DataFrame:
    v = pd.read_csv(VIX_CSV)
    v.columns = [c.strip().lower() for c in v.columns]
    v["date"] = pd.to_datetime(v["date"]).dt.date
    v = v.rename(columns={"close": "vix_close", "open": "vix_open",
                          "high": "vix_high", "low": "vix_low"})
    return v[["date", "vix_open", "vix_high", "vix_low", "vix_close"]].dropna()


def diagnose_timezone(m1: pd.DataFrame) -> None:
    """Volume-by-UTC-hour tells us where the US cash session sits."""
    prof = m1.groupby(m1["time"].dt.hour)["volume"].mean()
    prof = prof / prof.mean()
    print("\n  relative tick-volume by UTC hour (1.00 = day average)")
    for h, v in prof.items():
        bar = "#" * int(v * 30)
        print(f"    {h:02d}:00 UTC  {v:5.2f}  {bar}")
    peak = int(prof.idxmax())
    print(f"\n  peak UTC hour = {peak:02d}  "
          f"(US cash open 09:30 ET = 13:30 UTC EST / 14:30 UTC EDT)")


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    print("loading NAS100 1m ...")
    m1 = load_nas100()
    print(f"  {len(m1):,} bars  {m1['time'].min()} .. {m1['time'].max()}")

    diagnose_timezone(m1)

    print("\nloading VIX ...")
    vix = load_vix()
    print(f"  {len(vix):,} days  {vix['date'].min()} .. {vix['date'].max()}")

    m1.to_parquet(os.path.join(OUT_DIR, "nas100_m1.parquet"), index=False)
    vix.to_parquet(os.path.join(OUT_DIR, "vix_daily.parquet"), index=False)
    print(f"\nwrote -> {OUT_DIR}")


if __name__ == "__main__":
    main()
