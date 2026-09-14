#!/usr/bin/env python3
"""V3-Z1 cross-market panel construction. COMPUTES NO OUTCOME VALUE ON REAL DATA.

Builds the synchronized NQ/ES/YM/RTY hourly panel, the frozen calendar roll
exclusion, and the frozen feature definitions. The outcome FUNCTION is defined
here so it can be unit-tested on synthetic bars; it is never evaluated against
the real panel in the preregistration turn.

Terminology, kept precise throughout: these are Yahoo Finance generic/continuous
futures series REFERENCING CME equity-index futures. Historical child-contract
identity, the generic-symbol switch date, the roll algorithm, back-adjustment
methodology and vendor revision history are all UNKNOWN.
"""
import csv, datetime as dt, math, os, statistics, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S

MARKETS = ("NQ", "ES", "YM", "RTY")
BASKET = ("ES", "YM", "RTY")
HOUR = 3600

# ── frozen engineering constants ──────────────────────────────────────────
VOL_LOOKBACK = 120          # closed hourly returns for sigma (~5 CME sessions)
VOL_MIN_OBS = 120           # FULL window required; no partial estimate
WARMUP_BARS = 121           # sigma needs 120 returns, which needs 121 closes
ROLL_BEFORE_DAYS = 10       # calendar days before expiry
ROLL_AFTER_DAYS = 2         # calendar days after expiry
ROLL_MONTHS = (3, 6, 9, 12)


def load(tag, interval="1h", root="data_z1"):
    """Hour-aligned CLOSED bars only.

    Two kinds of row are dropped, both by one pre-frozen rule (ts % 3600 == 0):
    the trailing still-forming bar (e.g. 02:28 UTC), whose close is not a
    closed-bar observation, and irregular early-close stubs (e.g. 16:30/17:30
    on 2025-12-24). 25 such rows exist per market in the frozen snapshot.
    """
    out = []
    with open(f"{root}/{tag}_{interval}.csv") as f:
        r = csv.reader(f); next(r)
        for x in r:
            ts = int(x[0])
            if interval == "1h" and ts % HOUR != 0:
                continue
            out.append((ts, float(x[1]), float(x[2]), float(x[3]),
                        float(x[4]), float(x[5])))
    return out


# ── frozen roll exclusion, CALENDAR-BASED, never outcome-derived ──────────
def third_friday(year, month):
    d = dt.date(year, month, 1)
    fridays = [d + dt.timedelta(days=i) for i in range(31)
               if (d + dt.timedelta(days=i)).month == month
               and (d + dt.timedelta(days=i)).weekday() == 4]
    return fridays[2]


def roll_excluded_dates(first, last):
    """CME equity-index futures expire on the third Friday of Mar/Jun/Sep/Dec.
    The published lead-month roll is the Thursday 8 days prior. Because the
    Yahoo generic series switches on an UNKNOWN date, the exclusion is
    deliberately WIDER than the published convention: every CME trade date in
    [expiry - 10d, expiry + 2d] is excluded. Frozen before any outcome; never
    tuned to Z1 results."""
    out = set()
    for yr in range(first.year - 1, last.year + 2):
        for mth in ROLL_MONTHS:
            e = third_friday(yr, mth)
            d = e - dt.timedelta(days=ROLL_BEFORE_DAYS)
            while d <= e + dt.timedelta(days=ROLL_AFTER_DAYS):
                if first <= d <= last:
                    out.add(d)
                d += dt.timedelta(days=1)
    return out


# ── strict synchronization: no fill of any kind ───────────────────────────
def build_panel(root="data_z1"):
    """One row per timestamp at which EVERY market has a closed hourly bar.

    No forward fill, no backward fill, no interpolation, no fabricated zero
    return, and no observation built from a market whose hour is absent.
    """
    series = {m: {r[0]: r for r in load(m, "1h", root)} for m in MARKETS}
    common = set(series["NQ"])
    for m in MARKETS[1:]:
        common &= set(series[m])
    rows = []
    for ts in sorted(common):
        d = S.trade_date(ts)
        if d is None:                       # maintenance hour: neither session
            continue
        rows.append({"ts": ts, "trade_date": d,
                     **{m: series[m][ts] for m in MARKETS}})
    return rows, series


# The CME day has a ONE-HOUR maintenance break (17:00-18:00 ET) that belongs to
# neither session. Consecutive panel rows therefore sit 2 hours apart once per
# trade date. That break is a normal daily feature of the instrument, not a data
# gap; a weekend or holiday gap is genuinely different and is 47h+.
MAX_RETURN_GAP_SEC = 2 * HOUR       # frozen: admits the maintenance break only


def log_returns(rows, market):
    """r(t) = ln(C(t)/C(t-1)) between CONSECUTIVE PANEL rows.

    Valid only when the elapsed time is <= MAX_RETURN_GAP_SEC, which admits the
    ordinary 1-hour bar step and the single daily maintenance break, and
    excludes weekend and holiday gaps (47h+). Nothing is ever synthesized: an
    inadmissible gap yields None and that hour contributes no return.
    """
    out = [None] * len(rows)
    for i in range(1, len(rows)):
        if rows[i]["ts"] - rows[i-1]["ts"] > MAX_RETURN_GAP_SEC:
            continue
        a = rows[i-1][market][4]; b = rows[i][market][4]
        if a > 0 and b > 0:
            out[i] = math.log(b / a)
    return out


def rolling_sigma(ret, i, lookback=VOL_LOOKBACK, min_obs=VOL_MIN_OBS):
    """sigma known AT the close of panel row i: sample std of the most recent
    `lookback` VALID returns at or before i.

    Gap returns are OMITTED from the window rather than poisoning it. Requiring
    a contiguous block instead would be unsatisfiable: a 120-hour window spans
    roughly one calendar week, so it always contains a weekend break, and the
    first implementation produced 0.00% availability for exactly that reason.
    Omission stitches nothing - it simply declines to treat a weekend as an
    hourly observation. The FULL count of `min_obs` valid returns is still
    required; no partial estimate is ever used.
    """
    if i < 0:
        return None
    w = []
    k = i
    while k >= 0 and len(w) < lookback:
        if ret[k] is not None:
            w.append(ret[k])
        k -= 1
    if len(w) < min_obs:
        return None
    s = statistics.stdev(w)
    return s if s > 0 and s == s and s != float("inf") else None


# ── frozen Z1 feature family: EXACTLY 3 primary hypotheses ────────────────
#
#   z_m(t)   = r_m(t) / sigma_m(t-1)          volatility-normalized hourly move
#   z_B(t)   = mean over {ES, YM, RTY} of z_m(t)        the broad-complex factor
#
#   F1 divergence_1h      = z_NQ(t) - z_B(t)           expected NEGATIVE
#   F2 divergence_session = sum of (z_NQ - z_B) since the 18:00 ET session open
#                           through t, divided by sqrt(n hours)  expected NEGATIVE
#   F3 basket_z           = z_B(t)                     expected POSITIVE
#
# sigma uses the window ending at t-1 (STRICTLY prior to the return it scales),
# so the normalizer can never be contaminated by the bar it normalizes.
# AMENDMENT 01 (pre-outcome): basket_z was REMOVED from the confirmatory family.
#
# The baseline contains nq_z = z_NQ(t). Conditional on it,
#     span{nq_z, divergence_1h} = span{nq_z, nq_z - z_B} = span{nq_z, z_B}
# so
#     Y = a + b1*nq_z + c*(nq_z - z_B)  ==  a + (b1+c)*nq_z + (-c)*z_B.
# Fitted values, residuals and standard errors are identical; only the
# parameterization differs. Measured on a synthetic design matrix: the two
# coefficients satisfy c_basket = -c_divergence to machine precision and the
# p-values agree to 14 decimals. They are ONE test written twice.
#
# Worse, the preregistered signs were NEGATIVE for divergence_1h and POSITIVE
# for basket_z. Because c_basket = -c_divergence, those two expectations would
# have been confirmed or refuted SIMULTANEOUSLY AND AUTOMATICALLY - a built-in
# guaranteed agreement that would have read as independent support.
#
# Removed BEFORE any outcome was inspected, for algebraic equivalence, NOT
# because of an observed result. The slot is NOT refilled: m drops 3 -> 2.
FEATURES = ("divergence_1h", "divergence_session")
EXPECTED_SIGN = {"divergence_1h": -1, "divergence_session": -1}

# Retained ONLY as a component of the divergence equation and as a reported
# diagnostic. It is never independently tested and can never be promoted.
DIAGNOSTIC_ONLY = ("basket_z",)

BASELINE = ("nq_z", "nq_vol_state", "session_bucket", "prev_day_nq_return")

# ── frozen standardization (AMENDMENT 01) ─────────────────────────────────
# Only the PREDICTOR is standardized. Y is already sigma-normalized by its own
# definition and receives NO further scaling. Scale parameters are estimated
# from DEVELOPMENT predictor values ONLY, never using any outcome, and never
# using replication or prospective data. They are then frozen: replication and
# prospective observations are transformed with the development constants.


def fit_scaler(values):
    """mean and sample std of the non-missing DEVELOPMENT predictor values.
    Reads no outcome. A degenerate (zero/NaN) scale returns None -> the feature
    is not testable rather than silently rescaled."""
    v = [x for x in values if x is not None and x == x]
    if len(v) < 2:
        return None
    mu = sum(v) / len(v)
    sd = statistics.stdev(v)
    if not (sd > 0 and sd == sd and sd != float("inf")):
        return None
    return {"mean": mu, "sd": sd, "n": len(v)}


def apply_scaler(x, sc):
    """Centered and scaled with FROZEN development constants."""
    if x is None or sc is None or x != x:
        return None
    return (x - sc["mean"]) / sc["sd"]


def z_scores(rows, rets, i):
    """Volatility-normalized hourly moves for every market at panel row i.
    sigma is measured on the window ENDING AT i-1, strictly before r(i)."""
    out = {}
    for m in MARKETS:
        r = rets[m][i]
        s = rolling_sigma(rets[m], i - 1)
        out[m] = (r / s) if (r is not None and s) else None
    return out


def features_at(rows, rets, i, session_acc):
    """The three frozen features at panel row i, computable from closed bars
    <= t only. `session_acc` carries the running session sum, itself built
    only from rows already passed."""
    z = z_scores(rows, rets, i)
    f = {k: None for k in FEATURES}
    if z["NQ"] is None or any(z[m] is None for m in BASKET):
        return f, z
    zb = sum(z[m] for m in BASKET) / len(BASKET)
    f["divergence_1h"] = z["NQ"] - zb
    f["basket_z"] = zb
    n = session_acc["n"]
    if n >= 1:
        f["divergence_session"] = session_acc["sum"] / math.sqrt(n)
    return f, z


def session_key(ts):
    """The CME trade date owning this bar - the accumulator resets with it."""
    return S.trade_date(ts)


# ── frozen PRIMARY OUTCOME (defined here, evaluated only in the next turn) ──
#
#   Y(t) = r_NQ(t+1) / sigma_NQ(t)
#
# The numerator begins STRICTLY AFTER bar t closes. The denominator is known AT
# the close of bar t. No component of Y is available to any feature at t, and no
# feature input extends past t. The next panel row must be the consecutive hour;
# across a panel gap Y is CENSORED, never stitched.
PRIMARY_HORIZON_HOURS = 1
SECONDARY_HORIZONS_HOURS = (2, 3)          # DESCRIPTIVE ONLY, no second family


def primary_outcome(rows, rets, i, horizon=PRIMARY_HORIZON_HOURS):
    """Y at panel row i. Returns None (CENSORED) if the required consecutive
    future hours are absent or sigma is unavailable."""
    j = i + horizon
    if j >= len(rows):
        return None
    # deliberately STRICTER than the return rule: the outcome requires exactly
    # consecutive hours, so Y is CENSORED across the maintenance break. Y then
    # measures one homogeneous quantity (an ordinary trading hour) rather than
    # mixing in a higher-variance session-open gap once per day.
    for k in range(i + 1, j + 1):
        if rows[k]["ts"] - rows[k-1]["ts"] != HOUR:
            return None
    s = rolling_sigma(rets["NQ"], i)
    if not s:
        return None
    a = rows[i]["NQ"][4]; b = rows[j]["NQ"][4]
    if a <= 0 or b <= 0:
        return None
    return math.log(b / a) / s


# ── baseline: prev_day_nq_return, exact and non-bridging (AMENDMENT 01) ───
def session_bounds_rows(rows):
    """trade_date -> (first_index, last_index) in the panel."""
    out = {}
    for i, r in enumerate(rows):
        d = r["trade_date"]
        if d not in out:
            out[d] = [i, i]
        else:
            out[d][1] = i
    return {k: tuple(v) for k, v in out.items()}


def prev_day_nq_return(rows, bounds, ordered_dates, date_pos, d, excluded):
    """The OPEN-TO-CLOSE return of the IMMEDIATELY PRECEDING eligible CME trade
    date, known in full before the current session opens.

    Frozen rules, all of which yield MISSING rather than a substitute:
      * the required day is the IMMEDIATELY preceding trade date in the panel's
        own date sequence. If it is invalid we do NOT walk further back until a
        convenient valid day appears.
      * if that day is roll-excluded -> MISSING (never bridges the roll window).
      * if that day is absent from the panel (holiday, missing session)
        -> MISSING.
      * open-to-close WITHIN one completed trade date, so it can never be a
        multi-day change wearing a one-day label.
      * the previous session closes at 17:00 ET, before the current session
        opens at 18:00 ET, so the value is fully available at every hour of d.
    """
    k = date_pos.get(d)
    if k is None or k == 0:
        return None
    p = ordered_dates[k - 1]
    if p in excluded or p not in bounds:
        return None
    a, b = bounds[p]
    o = rows[a]["NQ"][1]           # open of that day's FIRST panel bar
    c = rows[b]["NQ"][4]           # close of that day's LAST panel bar
    if o <= 0 or c <= 0:
        return None
    return math.log(c / o)


# ── prospective accumulation: ELIGIBLE trade dates only (AMENDMENT 01) ────
PROSPECTIVE_REQUIRED_ELIGIBLE_DATES = 126
MIN_ROWS_FOR_ELIGIBLE_DATE = 20     # of the 23-hour modal session


def eligible_prospective_dates(rows, excluded, freeze_epoch):
    """Calendar time after the freeze is NOT the requirement; ELIGIBLE observed
    trade dates are. A date counts only if every condition holds:
        * all of its bars are timestamped after the freeze instant
        * it is not roll-excluded (the September window can overlap the start
          of prospective collection)
        * it is not partial - at least MIN_ROWS_FOR_ELIGIBLE_DATE panel rows
    Roll-excluded, missing and partial dates count for NOTHING.
    """
    per = {}
    for r in rows:
        if r["ts"] <= freeze_epoch:
            continue
        per.setdefault(r["trade_date"], 0)
        per[r["trade_date"]] += 1
    return sorted(d for d, n in per.items()
                  if d not in excluded and n >= MIN_ROWS_FOR_ELIGIBLE_DATE)
