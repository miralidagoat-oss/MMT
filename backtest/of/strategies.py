"""Candidate signal generators. Each returns +1/-1/0 per bar.

Every one of these is expressible in Pine Script v6 -- that is a hard design
constraint, not an afterthought.
"""
import numpy as np
import pandas as pd


def _blank(f):
    return pd.Series(0.0, index=f.index)


def vwap_reversion(f, z=2.0, **kw):
    """Fade stretch from session VWAP."""
    s = _blank(f)
    s[f["vwap_z"] > z] = -1
    s[f["vwap_z"] < -z] = 1
    return s


def vwap_reversion_flow(f, z=2.0, **kw):
    """Fade stretch, but only when order flow is not confirming the push."""
    s = _blank(f)
    s[(f["vwap_z"] > z) & (f["imbalance"] < 0)] = -1
    s[(f["vwap_z"] < -z) & (f["imbalance"] > 0)] = 1
    return s


def sweep_fade(f, **kw):
    s = _blank(f)
    s[f["swept_hi"]] = -1
    s[f["swept_lo"]] = 1
    return s


def sweep_fade_flow(f, rel_vol=1.0, **kw):
    """Sweep + delta confirming the rejection + participation."""
    s = _blank(f)
    hv = f["rel_vol"] > rel_vol
    s[f["swept_hi"] & (f["imbalance"] < 0) & hv] = -1
    s[f["swept_lo"] & (f["imbalance"] > 0) & hv] = 1
    return s


def momentum_flow(f, z=1.0, imb=0.3, **kw):
    """Trend continuation confirmed by cumulative delta."""
    s = _blank(f)
    s[(f["vwap_z"] > z) & (f["imbalance"] > imb) & (f["cvd"] > 0)] = 1
    s[(f["vwap_z"] < -z) & (f["imbalance"] < -imb) & (f["cvd"] < 0)] = -1
    return s


def regime_adaptive(f, z=2.0, vix_lo=13.0, vix_hi=25.0, **kw):
    """The dealer-gamma thesis, expressed as a switch.

    Calm//mid VIX  -> dealers long gamma  -> fade stretch (mean reversion)
    VIX stressed   -> dealers short gamma -> go with the push (momentum)
    """
    s = _blank(f)
    calm = (f["vix_close"] >= vix_lo) & (f["vix_close"] < vix_hi)
    stress = f["vix_close"] >= vix_hi
    s[calm & (f["vwap_z"] > z)] = -1
    s[calm & (f["vwap_z"] < -z)] = 1
    s[stress & (f["vwap_z"] > z) & (f["imbalance"] > 0)] = 1
    s[stress & (f["vwap_z"] < -z) & (f["imbalance"] < 0)] = -1
    return s


def vwap_rev_vrp(f, z=2.0, vrp_max=0.5, **kw):
    """Fade stretch only when the variance risk premium is not elevated."""
    s = _blank(f)
    ok = f["vrp_z"] < vrp_max
    s[ok & (f["vwap_z"] > z)] = -1
    s[ok & (f["vwap_z"] < -z)] = 1
    return s


REGISTRY = {
    "vwap_reversion": vwap_reversion,
    "vwap_reversion_flow": vwap_reversion_flow,
    "sweep_fade": sweep_fade,
    "sweep_fade_flow": sweep_fade_flow,
    "momentum_flow": momentum_flow,
    "regime_adaptive": regime_adaptive,
    "vwap_rev_vrp": vwap_rev_vrp,
}
