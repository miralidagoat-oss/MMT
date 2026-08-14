"""Scan candidate strategies x timeframes on the TRAIN slice only."""
import sys
import itertools

import pandas as pd

sys.path.insert(0, "backtest/of")
import features as F        # noqa: E402
import strategies as S      # noqa: E402
from engine import Config, run  # noqa: E402
from explore import split   # noqa: E402

TFS = ["5min", "15min", "30min", "60min"]
# hold windows chosen so every timeframe gets a comparable ~2-6 hour horizon
HOLD = {"5min": 24, "15min": 12, "30min": 8, "60min": 6}


def main():
    m1 = pd.read_parquet("/workspace/data/prepared/nas100_m1.parquet")
    vix = pd.read_parquet("/workspace/data/prepared/vix_daily.parquet")
    which = sys.argv[1] if len(sys.argv) > 1 else "train"

    rows = []
    for tf in TFS:
        f = F.assemble(m1, vix, tf=tf)
        tr, va, te = split(f)
        sl = {"train": tr, "val": va, "test": te}[which].reset_index(drop=True)
        for name, fn in S.REGISTRY.items():
            for tgt in (1.5, 2.0, 3.0):
                sig = fn(sl)
                cfg = Config(stop_atr=1.0, target_atr=tgt, max_hold=HOLD[tf],
                             cost_points=0.75)
                res = run(sl, sig, cfg)
                if res.n < 30:
                    continue
                s = res.summary()
                s.update({"tf": tf, "strategy": name, "target_atr": tgt})
                rows.append(s)

    df = pd.DataFrame(rows)
    cols = ["tf", "strategy", "target_atr", "trades", "per_year", "win_rate",
            "profit_factor", "expectancy_R", "net_R", "max_dd_R", "sharpe", "net_usd"]
    df = df[cols].sort_values("profit_factor", ascending=False)
    pd.set_option("display.width", 200)
    print(f"\n===== {which.upper()} SLICE  (cost 0.75 MNQ pts round trip) =====")
    print(df.to_string(index=False))
    df.to_csv(f"/workspace/data/prepared/scan_{which}.csv", index=False)


if __name__ == "__main__":
    main()
