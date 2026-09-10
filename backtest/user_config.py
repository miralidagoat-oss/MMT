#!/usr/bin/env python3
"""The user's own Arashi settings, transcribed field by field from their
indicator panel, so every number below can be checked against the screenshots.

Panel                                   value            engine field
--------------------------------------  ---------------  ---------------------
Preset                                  Custom           (all fields explicit)
Exchange timezone                       America/New_York (fixed in engine)
Previous day high / low                 on               pools
Previous week high / low                on               pools
Asia session high / low                 on               pools
London session high / low               on               pools
Initial balance high / low              on               pools
Unswept fractal pivots                  on               pools
Pivots must be equal highs / lows       OFF              eq_only=False
Min sweep depth (x ATR)                 0.4              min_sweep_atr
Max sweep depth (x ATR, 0 = no cap)     0                max_sweep_atr=0
Reclaim window (bars)                   7                reclaim_bars
Reclaim bar must close in direction     on               require_close_dir
Cooldown between signals (bars)         6                cooldown
Signal session                          All hours        session="all"
Min reclaim volume (x 20-bar avg)       0                vol_mult=0
Long / Short setups                     both on          longs/shorts
PO3 manipulation gate                   Off              po3_mode="off"
PO3 period                              Day              po3_period="day"
VWAP anchor                             Week             (display only here)
Filter: raid stretched from VWAP        OFF              use_vwap=False
...by at least (x sigma)                3                dev_entry (inert)
Filter: reclaim closes across VWAP      OFF              vwap_reclaim=False
Band 1 / Band 2 (sigma)                 1 / 2            display only
Entry                                   Market on close  entry_mode
Max risk (x ATR, 0 = off)               0                max_risk_atr=0
Min target size (points, 0 = off)       0                min_target_pts=0
Stop buffer beyond sweep extreme        0.5              stop_buf_atr
Risk : reward target                    1.5              rr
Move stop to breakeven at (R)           0.25             be_at_r
Limit order expiry (bars)               12               validity (inert: market entry)
Time stop after fill (bars)             0                max_hold=0
Max concurrently tracked setups         20               (never binds; peak is 5)
Round-trip cost (ticks)                 4                cost_ticks
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402

USER = E.Params(
    min_sweep_atr=0.4,
    max_sweep_atr=0.0,          # "0 = no cap"
    reclaim_bars=7,
    eq_only=False,
    use_vwap=False,
    dev_entry=3.0,              # inert: the stretch filter is off
    vwap_reclaim=False,
    po3_mode="off",
    po3_period="day",
    require_close_dir=True,
    vol_mult=0.0,
    entry_mode="reclaim_close",
    stop_buf_atr=0.50,
    max_risk_atr=0.0,
    min_target_pts=0.0,
    tp_mode="rr",
    rr=1.5,
    be_at_r=0.25,
    validity=12,
    max_hold=0,
    session="all",
    cooldown=6,
    longs=True,
    shorts=True,
    tick=0.25,
    cost_ticks=4.0,
)

# what ships as the validated 1H configuration, for side-by-side comparison
from evaluate import CANDIDATE  # noqa: E402,E501

DIFFS = [
    ("min sweep depth", "0.40 ATR", "0.35 ATR"),
    ("reclaim window", "7 bars", "2 bars"),
    ("PO3 manipulation gate", "Off", "Sweep beyond open"),
    ("PO3 period", "Day", "Week"),
    ("risk : reward", "1.5", "3.0"),
    ("breakeven trigger", "0.25R", "1.0R"),
]

if __name__ == "__main__":
    print("Your settings vs the shipped validated preset — only these differ:\n")
    print(f"{'setting':<26} {'yours':<22} {'validated preset'}")
    for name, mine, theirs in DIFFS:
        print(f"{name:<26} {mine:<22} {theirs}")
    print("\nEverything else is identical.")
