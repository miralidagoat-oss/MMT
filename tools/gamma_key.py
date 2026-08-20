#!/usr/bin/env python3
"""Build the QT KEY daily key string from live option chains.

This is the generator the Pine indicator consumes. It exists so that the numbers
pasted into the chart are REPRODUCIBLE: run it, and you can see exactly which
strikes, which open interest and which assumption produced every level.

    python3 tools/gamma_key.py                      # both instruments, next session
    python3 tools/gamma_key.py --max-dte 7          # near book only
    python3 tools/gamma_key.py --append             # add to an existing key file

PIPELINE
    1. pull the listed option chain (strike, open interest, implied vol) per expiry
    2. Black-Scholes gamma/vanna/charm per contract, at the live spot
    3. dollar gamma per 1% move  =  gamma * S^2 * 0.01 * OI * 100
    4. sign it by the DEALER POSITIONING ASSUMPTION (see below), sum per strike
    5. gamma flip: re-price the whole book across a spot grid, find the zero crossing
    6. score every candidate:  P(reached today) x (its share of the largest |gamma|)
    7. enforce separation, take the top five, emit the 24-field row

THE ASSUMPTION, STATED ONCE AND PLAINLY
    Open interest is UNSIGNED. Nothing in the data says who is long. This script
    uses the same convention every public gamma chart uses -- dealers long calls,
    short puts -- because it is the convention, not because it is measured. If it
    is wrong the sign of every level flips. `--dealer-sign inverted` is provided so
    you can see what that looks like rather than having to take it on faith.

WHAT IS AND IS NOT FITTED
    P(reached) is fitted and validated -- see tools/calibrate_reach.py, which is
    where the (s, k) below come from. The gamma share is a RAW PROXY: whether a
    level rejects once reached has no labelled data in this repo, so the two
    factors are multiplied unweighted. No exponent trades them off, because
    choosing one would be taste presented as a measurement.

Stdlib only.
"""
import argparse
import datetime as dt
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yahoo  # noqa: E402

SQ2PI = math.sqrt(2.0 * math.pi)

# Fitted by tools/calibrate_reach.py on 5,016 sessions (2000-2019) and validated on
# 1,663 holdout sessions (2020-2026). Regenerate with:
#     python3 tools/calibrate_reach.py --json tools/reach_params.json
REACH_DEFAULT = {
    "ES": {"up": (0.5015, 1.1300), "dn": (0.5163, 0.9736)},
    "NQ": {"up": (0.5357, 1.1878), "dn": (0.5098, 1.0017)},
}

# Each instrument reads BOTH its index book and its tracking ETF, folded into the
# index price frame. That is not belt-and-braces: Yahoo populates open interest for
# ^SPX on barely one expiry in ten, so an index-only ES key is built from a handful
# of far-OTM strikes and looks plausible while being empty. The ETF books carry the
# retail and near-tenor size anyway -- SPY alone is ~4.2m contracts inside a week
# against ~13k for ^SPX -- so merging them is both a data fix and the right book.
INSTRUMENTS = {
    "ES": {"cash": "^GSPC", "books": ["^SPX", "SPY"], "q": 0.012},
    "NQ": {"cash": "^NDX", "books": ["^NDX", "QQQ"], "q": 0.006},
}


def npdf(x):
    return math.exp(-0.5 * x * x) / SQ2PI


def ncdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def d1d2(S, K, T, r, q, sig):
    v = sig * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sig * sig) * T) / v
    return d1, d1 - v, v


def greeks(S, K, T, r, q, sig, is_call):
    """(gamma, vanna, charm) per unit of underlying, per contract. Zero if degenerate."""
    if S <= 0 or K <= 0 or T <= 0 or sig <= 0:
        return 0.0, 0.0, 0.0
    d1, d2, v = d1d2(S, K, T, r, q, sig)
    disc = math.exp(-q * T)
    ph = npdf(d1)
    gamma = disc * ph / (S * v)
    vanna = -disc * ph * d2 / sig
    # dDelta/dt (Haug). Sign convention documented rather than argued about: it is
    # only ever read as a badge number, and it is consistent across both books.
    common = -disc * ph * (2.0 * (r - q) * T - d2 * v) / (2.0 * T * v)
    charm = common + (q * disc * ncdf(d1) if is_call else -q * disc * ncdf(-d1))
    return gamma, vanna, charm


def wilder_atr(bars, n=14):
    if len(bars) <= n:
        return None
    tr = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i - 1][4]
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))
    atr = sum(tr[:n]) / n
    for x in tr[n:]:
        atr = (atr * (n - 1) + x) / n
    return atr


def p_reach(level, anchor, atr, params):
    """Fitted probability the session reaches `level`, given the prior close and ATR14."""
    if atr is None or atr <= 0:
        return 0.0
    u = abs(level - anchor) / atr
    s, k = params["up"] if level >= anchor else params["dn"]
    return math.exp(-((u / s) ** k))


def collect(symbol, max_dte, r, q, iv_floor, now):
    """Per-strike dealer-signed exposures for one option book, at that book's own spot."""
    expiries, spot = yahoo.option_expiries(symbol)
    if not spot:
        raise RuntimeError("no spot for %s" % symbol)
    rows = []          # (K, T, sig, oi, is_call)
    listed = set()     # every strike the book lists, OI or not
    used_exp = 0
    for e in expiries:
        dte = (e - now) / 86400.0
        if dte < 0 or dte > max_dte:
            continue
        try:
            calls, puts = yahoo.option_chain(symbol, e)
        except Exception as ex:                       # noqa: BLE001
            print("    ! %s expiry %s unavailable (%s)" % (symbol, e, type(ex).__name__),
                  file=sys.stderr)
            continue
        T = max(dte, 0.5) / 365.0                     # a 0DTE is not zero time to expiry
        got = 0
        for side, is_call in ((calls, True), (puts, False)):
            for c in side:
                K = c.get("strike")
                oi = c.get("openInterest") or 0
                sig = c.get("impliedVolatility") or 0.0
                if not K:
                    continue
                listed.add(float(K))
                if oi <= 0:
                    continue
                rows.append((float(K), T, max(float(sig), iv_floor), int(oi), is_call))
                got += 1
        if got:
            used_exp += 1
    return spot, rows, used_exp, listed


def book_exposure(spot, rows, r, q, sign, mult=100.0, at_spot=None):
    """Dollar gamma per 1% move, per strike, plus book-level vanna and charm.

    `at_spot` re-prices the same book at a hypothetical spot -- that is what makes
    the gamma flip a real zero crossing of the profile rather than an interpolation
    between two strikes.
    """
    S = at_spot if at_spot is not None else spot
    per_strike = {}
    tot_v = tot_c = 0.0
    for K, T, sig, oi, is_call in rows:
        g, vn, ch = greeks(S, K, T, r, q, sig, is_call)
        side = 1.0 if is_call else -1.0               # THE ASSUMPTION, applied here
        w = side * sign * oi * mult
        dollar_g = g * S * S * 0.01 * w
        per_strike[K] = per_strike.get(K, 0.0) + dollar_g
        tot_v += vn * S * 0.01 * w
        tot_c += ch * S * 0.01 * w
    return per_strike, tot_v, tot_c


def modal_step(strikes):
    """The book's own strike spacing: the modal gap between adjacent listed strikes."""
    ks = sorted(strikes)
    gaps = {}
    for a, b in zip(ks, ks[1:]):
        d = round(b - a, 4)
        if d > 0:
            gaps[d] = gaps.get(d, 0) + 1
    return max(gaps.items(), key=lambda kv: kv[1])[0] if gaps else 1.0


def find_flip(books, r, q, sign, lo, hi, steps=240):
    """Spot at which total dealer gamma crosses zero. None if it never does in range."""
    prev_s = prev_v = None
    cross = []
    for i in range(steps + 1):
        S = lo + (hi - lo) * i / steps
        tot = 0.0
        for spot, rows, mult, scale in books:
            ps, _, _ = book_exposure(spot, rows, r, q, sign, mult, at_spot=S / scale)
            tot += sum(ps.values())
        if prev_v is not None and (prev_v <= 0.0 < tot or prev_v >= 0.0 > tot):
            t = abs(prev_v) / max(1e-12, abs(prev_v) + abs(tot))
            cross.append(prev_s + (S - prev_s) * t)
        prev_s, prev_v = S, tot
    if not cross:
        return None
    return min(cross, key=lambda x: abs(x - (lo + hi) / 2.0))


def build_row(tag, session, max_dte, r, sign, iv_floor, reach, verbose=True):
    cfg = INSTRUMENTS[tag]
    q = cfg["q"]
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())

    bars = yahoo.daily_bars(cfg["cash"], start="2023-01-01")
    atr = wilder_atr(bars)
    anchor = bars[-1][4]

    merged = {}          # strike IN THE FRAME OF THE FIRST BOOK -> dollar gamma
    books = []
    frame_spot = None
    steps = []
    vsum = csum = 0.0
    for bi, sym in enumerate(cfg["books"]):
        try:
            spot, rows, nexp, listed = collect(sym, max_dte, r, q, iv_floor, now)
        except Exception as e:                          # noqa: BLE001
            print("    ! %s unavailable (%s) -- skipped" % (sym, e), file=sys.stderr)
            continue
        if frame_spot is None:
            frame_spot = spot
        scale = frame_spot / spot                       # QQQ -> NDX points
        ps, vn, ch = book_exposure(spot, rows, r, q, sign)
        for K, g in ps.items():
            kk = round(K * scale, 4)
            merged[kk] = merged.get(kk, 0.0) + g
        books.append((spot, rows, 100.0, scale))
        if listed:
            steps.append(modal_step(listed) * scale)
        if verbose:
            oi = sum(x[3] for x in rows)
            print("    %-6s spot %10.2f  expiries %2d  contracts %5d  OI %12s  scale x%.4f%s"
                  % (sym, spot, nexp, len(rows), format(oi, ","), scale,
                     "   ** NO OPEN INTEREST **" if oi == 0 else ""))
        vsum += vn
        csum += ch

    if not merged:
        raise RuntimeError("%s: no open interest inside --max-dte %s" % (tag, max_dte))

    step = min(steps) if steps else 1.0
    BN = 1e9

    # walls: largest positive (call-driven) and largest negative (put-driven) strike
    cw = max(merged.items(), key=lambda kv: kv[1])[0]
    pw = min(merged.items(), key=lambda kv: kv[1])[0]
    net = sum(merged.values()) / BN

    flip = find_flip(books, r, q, sign, frame_spot * 0.90, frame_spot * 1.10)
    if flip is None:
        flip = frame_spot

    # ── candidate pool: every strike carrying gamma, walls included on merit
    biggest = max(abs(v) for v in merged.values()) or 1.0
    cands = []
    for K, g in merged.items():
        if abs(g) <= 0:
            continue
        p = p_reach(K, anchor, atr, reach)
        cands.append({"px": K, "gex": g / BN, "p": p,
                      "score": p * (abs(g) / biggest)})
    cands.sort(key=lambda c: -c["score"])

    sep = max(step, 0.05 * (atr or step))
    chosen = []
    for c in cands:
        if all(abs(c["px"] - x["px"]) >= sep for x in chosen):
            chosen.append(c)
        if len(chosen) == 5:
            break
    while len(chosen) < 5:                              # thin book: pad rather than emit a short row
        chosen.append({"px": float("nan"), "gex": 0.0, "p": 0.0, "score": 0.0})

    f = ["%.2f" % flip, "%.3f" % net, "%.2f" % step,
         "%.3f" % (csum / BN), "%.3f" % (vsum / BN),
         "%.2f" % cw, "%.2f" % pw]
    for c in chosen:
        f += ["%.2f" % c["px"], "%.4f" % c["gex"], "%.4f" % c["p"]]
    row = ",".join([tag, session] + f)

    if verbose:
        print("    anchor %.2f  ATR14 %.2f  step %.2f  separation %.2f"
              % (anchor, atr or 0.0, step, sep))
        print("    flip %.2f   net %.3f $bn/1%%   CW %.2f   PW %.2f" % (flip, net, cw, pw))
        print("    %-4s %12s %12s %8s %8s" % ("rank", "price", "$bn/1%", "P(hit)", "score"))
        for i, c in enumerate(chosen):
            print("    %d/5  %12.2f %12.4f %7.1f%% %8.4f"
                  % (5 - i, c["px"], c["gex"], 100 * c["p"], c["score"]))
    return row


def next_session(d=None):
    """Key is generated after the close and stamped for the NEXT trading session."""
    d = d or dt.date.today()
    n = d + dt.timedelta(days=1)
    while n.weekday() >= 5:
        n += dt.timedelta(days=1)
    return n.strftime("%Y%m%d")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-dte", type=float, default=7.0,
                    help="include expiries out to this many days (default 7 -- the near book)")
    ap.add_argument("--rate", type=float, default=0.04, help="risk-free rate")
    ap.add_argument("--iv-floor", type=float, default=0.05,
                    help="floor for missing/zero implied vol")
    ap.add_argument("--dealer-sign", choices=["standard", "inverted"], default="standard",
                    help="standard = dealers long calls / short puts (the usual, UNPROVEN, "
                         "convention). inverted flips it, so you can see what the "
                         "assumption is actually worth.")
    ap.add_argument("--session", default=None, help="yyyymmdd stamp (default: next weekday)")
    ap.add_argument("--params", default=None, help="reach params json from calibrate_reach.py")
    ap.add_argument("--out", default=None, help="write the key string here")
    ap.add_argument("--append", action="store_true", help="append to --out instead of replacing")
    a = ap.parse_args()

    reach = dict(REACH_DEFAULT)
    if a.params:
        with open(a.params) as fh:
            for r in json.load(fh):
                reach[r["instrument"]] = {s: (r["sides"][s]["s"], r["sides"][s]["k"])
                                          for s in ("up", "dn")}
        print("reach params loaded from %s" % a.params)

    sign = 1.0 if a.dealer_sign == "standard" else -1.0
    session = a.session or next_session()
    print("session stamp %s   max-dte %.0f   dealer-sign %s"
          % (session, a.max_dte, a.dealer_sign))

    rows = []
    for tag in ("ES", "NQ"):
        print("\n[%s]" % tag)
        try:
            rows.append(build_row(tag, session, a.max_dte, a.rate, sign, a.iv_floor, reach[tag]))
        except Exception as e:                          # noqa: BLE001
            print("    FAILED: %s" % e, file=sys.stderr)

    key = ";".join(rows)
    print("\n" + "=" * 78)
    print("KEY (paste into the indicator's \"Key\" field):")
    print("=" * 78)
    print(key)
    if a.out:
        prev = ""
        if a.append and os.path.exists(a.out):
            prev = open(a.out).read().strip()
        with open(a.out, "w") as fh:
            fh.write((prev + ";" if prev else "") + key + "\n")
        print("\nwrote %s" % a.out)


if __name__ == "__main__":
    main()
