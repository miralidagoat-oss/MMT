#!/usr/bin/env python3
"""Translate a search configuration into the exact inputs to type into
TradingView. Anything not listed keeps its shipped default."""

KZ_LABEL = {
    "NY AM only":    [("London killzone", "off"), ("NY AM killzone", "on  08:30-11:00"),
                      ("Silver bullet", "off"), ("NY PM killzone", "off")],
    "NY PM only":    [("London killzone", "off"), ("NY AM killzone", "off"),
                      ("Silver bullet", "off"), ("NY PM killzone", "on  13:30-16:00")],
    "AM + PM":       [("London killzone", "off"), ("NY AM killzone", "on  08:30-11:00"),
                      ("Silver bullet", "off"), ("NY PM killzone", "on  13:30-16:00")],
    "Silver bullet": [("London killzone", "off"), ("NY AM killzone", "off"),
                      ("Silver bullet", "on  10:00-11:00"), ("NY PM killzone", "off")],
    "London + AM":   [("London killzone", "on  02:00-05:00"), ("NY AM killzone", "on  08:30-11:00"),
                      ("Silver bullet", "off"), ("NY PM killzone", "off")],
    "All three":     [("London killzone", "on  02:00-05:00"), ("NY AM killzone", "on  08:30-11:00"),
                      ("Silver bullet", "off"), ("NY PM killzone", "on  13:30-16:00")],
    "RTH only":      [("London killzone", "off"), ("NY AM killzone", "on  09:30-16:00"),
                      ("Silver bullet", "off"), ("NY PM killzone", "off")],
}

ENUM = {
    "stop_mode": {"raid": "Beyond the raid", "zone": "Beyond entry zone",
                  "tighter": "Tighter of the two"},
    "fill_pref": {"aggressive": "Zone edge (aggressive)", "mid": "Zone mid (CE)",
                  "patient": "Zone far side (patient)"},
    "rr_mode": {"fixed": "Fixed R", "stretch": "Stretch to min R",
                "pool": "Nearest pool (skip if short)"},
}

# (internal key, TradingView label, section)
MAP = [
    ("thresh",          "[Custom] Confluence threshold",        "1 - ENGINE"),
    ("req_mss",         "[Custom] Require displacement / MSS",  "1 - ENGINE"),
    ("req_fvg",         "[Custom] Require a fair value gap",    "1 - ENGINE"),
    ("req_kz",          "[Custom] Require a killzone",          "1 - ENGINE"),
    ("allow_long",      "Longs",                                "1 - ENGINE"),
    ("allow_short",     "Shorts",                               "1 - ENGINE"),
    ("min_stop_atr",    "[Custom] Min stop distance (ATR x)",   "2 - RISK"),
    ("max_stop_atr",    "Max stop distance (ATR x)",            "2 - RISK"),
    ("rr_mode",         "[Custom] Target logic",                "2 - RISK"),
    ("fixed_r",         "[Custom] Fixed R target",              "2 - RISK"),
    ("min_r",           "Min reward:risk",                      "2 - RISK"),
    ("def_r",           "Default R when no pool in range",      "2 - RISK"),
    ("max_r",           "Max reward:risk",                      "2 - RISK"),
    ("use_part",        "[Custom] Scale out at TP1",            "2 - RISK"),
    ("tp1_r",           "TP1 at R",                             "2 - RISK"),
    ("tp1_pct",         "TP1 size (%)",                         "2 - RISK"),
    ("be_on",           "[Custom] Move stop to breakeven",      "2 - RISK"),
    ("be_trig_r",       "Breakeven trigger (R)",                "2 - RISK"),
    ("max_hold",        "Time stop (bars in trade)",            "2 - RISK"),
    ("div_len",         "Delta divergence lookback",            "6 - ORDERFLOW"),
    ("use_delta_score", "Delta contributes to the score",       "8 - FILTERS"),
    ("pv_len",          "Swing pivot length",                   "7 - STRUCTURE"),
    ("struct_lb",       "Structure lookback (bars)",            "7 - STRUCTURE"),
    ("sweep_lb",        "Sweep window (bars)",                  "7 - STRUCTURE"),
    ("min_pen_ticks",   "Min sweep penetration (ticks)",        "7 - STRUCTURE"),
    ("eq_tol_atr",      "Equal high/low tolerance (ATR x)",     "7 - STRUCTURE"),
    ("disp_atr",        "Displacement body (ATR x)",            "7 - STRUCTURE"),
    ("leg_atr",         "or displacement leg (ATR x)",          "7 - STRUCTURE"),
    ("mss_max_bar",     "Max bars sweep -> MSS",                "7 - STRUCTURE"),
    ("zone_valid",      "Limit order validity (bars)",          "7 - STRUCTURE"),
    ("zone_mode",       "Entry zone",                           "7 - STRUCTURE"),
    ("fill_pref",       "[Custom] Limit sits at",               "7 - STRUCTURE"),
    ("ote_hi",          "OTE deep",                             "7 - STRUCTURE"),
    ("ote_lo",          "OTE shallow",                          "7 - STRUCTURE"),
    ("ob_lb",           "Order block lookback",                 "7 - STRUCTURE"),
    ("no_retrace",      "If price never retraces",              "7 - STRUCTURE"),
    ("stop_mode",       "[Custom] Stop sits",                   "7 - STRUCTURE"),
    ("stop_buf_atr",    "Stop buffer (ATR x)",                  "7 - STRUCTURE"),
    ("rvol_min",        "Min relative volume (hard gate)",      "8 - FILTERS"),
    ("rvol_hot",        "Elevated relative volume (scores)",    "8 - FILTERS"),
    ("ema_fast",        "Chart bias EMA fast",                  "8 - FILTERS"),
    ("ema_slow",        "Chart bias EMA slow",                  "8 - FILTERS"),
    ("use_htf",         "HTF bias confirm",                     "8 - FILTERS"),
    ("htf_min",         "HTF timeframe (minutes)",              "8 - FILTERS"),
    ("veto_htf",        "Veto trades against HTF bias",         "8 - FILTERS"),
    ("use_vw_tgt",      "VWAP bands count as target pools",     "8 - FILTERS"),
]


def fmt(v):
    if isinstance(v, bool):
        return "ON" if v else "OFF"
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def render(cfg, title="CONFIGURATION"):
    out = [f"{title}", "=" * len(title), "",
           "Signal preset .......................... Custom      <- REQUIRED, or none of this applies",
           ""]
    sect = None
    for key, label, section in MAP:
        if key not in cfg:
            continue
        if section != sect:
            out.append(f"--- {section} ---")
            sect = section
        v = cfg[key]
        if key in ENUM:
            v = ENUM[key].get(v, v)
        dots = "." * max(2, 40 - len(label))
        out.append(f"{label} {dots} {fmt(v)}")
    if cfg.get("_kz"):
        out.append("--- 3 - SESSIONS / KILLZONES ---")
        for lab, val in KZ_LABEL[cfg["_kz"]]:
            dots = "." * max(2, 40 - len(lab))
            out.append(f"{lab} {dots} {val}")
    return "\n".join(out)


if __name__ == "__main__":
    import json, sys
    cfg = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else {}
    print(render(cfg))
