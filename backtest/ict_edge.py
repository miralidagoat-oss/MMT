#!/usr/bin/env python3
"""Does the ICT event itself predict anything?

Strips away entry/stop/target choices — the parts that are easy to overfit —
and asks the only question that matters first: after a liquidity sweep plus a
market structure shift, does price move in the MSS direction more than it does
at a random moment in the same session?

For every sweep->MSS event we record the forward move in ATR units at several
horizons, sign-adjusted so a positive number always means "the setup worked".
The baseline is every bar in the same killzone, sampled the same way, so the
comparison controls for session and for drift.
"""
import statistics as st
import sys

from ict_engine import Config, KILLZONES, load, prepare


def find_events(d, cfg):
    """Yield (bar, direction) for each sweep -> MSS confirmation."""
    o, h, l, c, n = d["o"], d["h"], d["l"], d["c"], d["n"]
    atr, minute, day = d["atr"], d["minute"], d["day"]
    k = cfg.pivot_len
    piv_hi, piv_lo = d["piv_hi"], d["piv_lo"]
    hi_ptr = lo_ptr = 0
    conf_hi, conf_lo = [], []
    sell_pools, buy_pools = [], []
    swept_low = swept_high = None
    added_pd, added_asia, added_lon = set(), set(), set()
    events = []

    for i in range(n):
        while hi_ptr < len(piv_hi) and piv_hi[hi_ptr][0] + k <= i:
            p, price = piv_hi[hi_ptr]
            conf_hi.append((p, price))
            buy_pools.append(dict(price=price, bar=p))
            hi_ptr += 1
        while lo_ptr < len(piv_lo) and piv_lo[lo_ptr][0] + k <= i:
            p, price = piv_lo[lo_ptr]
            conf_lo.append((p, price))
            sell_pools.append(dict(price=price, bar=p))
            lo_ptr += 1
        if cfg.use_pd_levels and day[i] not in added_pd:
            prev = d["prev_of"].get(day[i])
            if prev is not None:
                buy_pools.append(dict(price=d["day_hi"][prev], bar=i))
                sell_pools.append(dict(price=d["day_lo"][prev], bar=i))
            added_pd.add(day[i])
        if cfg.use_session_levels:
            if minute[i] >= 120 and day[i] not in added_asia:
                if day[i] in d["asia_hi"]:
                    buy_pools.append(dict(price=d["asia_hi"][day[i]], bar=i))
                    sell_pools.append(dict(price=d["asia_lo"][day[i]], bar=i))
                added_asia.add(day[i])
            if minute[i] >= 480 and day[i] not in added_lon:
                if day[i] in d["lon_hi"]:
                    buy_pools.append(dict(price=d["lon_hi"][day[i]], bar=i))
                    sell_pools.append(dict(price=d["lon_lo"][day[i]], bar=i))
                added_lon.add(day[i])

        a = atr[i]
        if a is None or a <= 0:
            continue

        rs = [pl for pl in sell_pools if l[i] < pl["price"]]
        rb = [pl for pl in buy_pools if h[i] > pl["price"]]
        if rs:
            best = max(rs, key=lambda pl: pl["price"])
            depth = best["price"] - l[i]
            if c[i] > best["price"] and cfg.min_sweep_atr * a <= depth <= cfg.max_sweep_atr * a:
                trig = next((pr for _, pr in reversed(conf_hi) if pr > c[i]), None)
                if trig is not None:
                    swept_low = dict(bar=i, low=l[i], trig=trig)
            sell_pools = [pl for pl in sell_pools if l[i] >= pl["price"]]
        if rb:
            best = min(rb, key=lambda pl: pl["price"])
            depth = h[i] - best["price"]
            if c[i] < best["price"] and cfg.min_sweep_atr * a <= depth <= cfg.max_sweep_atr * a:
                trig = next((pr for _, pr in reversed(conf_lo) if pr < c[i]), None)
                if trig is not None:
                    swept_high = dict(bar=i, high=h[i], trig=trig)
            buy_pools = [pl for pl in buy_pools if h[i] <= pl["price"]]
        sell_pools = [pl for pl in sell_pools if i - pl["bar"] <= cfg.pool_lookback]
        buy_pools = [pl for pl in buy_pools if i - pl["bar"] <= cfg.pool_lookback]

        for direction in (1, -1):
            ctx = swept_low if direction > 0 else swept_high
            if ctx is None or ctx["bar"] >= i:
                continue
            if i - ctx["bar"] > cfg.mss_window or \
                    ((l[i] < ctx["low"]) if direction > 0 else (h[i] > ctx["high"])):
                if direction > 0:
                    swept_low = None
                else:
                    swept_high = None
                continue
            broke = (c[i] > ctx["trig"]) if direction > 0 else (c[i] < ctx["trig"])
            if broke and abs(c[i] - o[i]) >= cfg.disp_atr * a:
                events.append((i, direction))
                if direction > 0:
                    swept_low = None
                else:
                    swept_high = None
    return events


def fwd(d, i, direction, k):
    """Forward close-to-close move in ATR units, signed so + means the setup worked."""
    c, atr, n = d["c"], d["atr"], d["n"]
    if i + k >= n or not atr[i]:
        return None
    return direction * (c[i + k] - c[i]) / atr[i]


def excursion(d, i, direction, k):
    """(MFE, MAE) over the next k bars in ATR units, from the MSS close."""
    h, l, c, atr, n = d["h"], d["l"], d["c"], d["atr"], d["n"]
    if i + k >= n or not atr[i]:
        return None
    hi = max(h[i + 1:i + k + 1])
    lo = min(l[i + 1:i + k + 1])
    if direction > 0:
        return (hi - c[i]) / atr[i], (c[i] - lo) / atr[i]
    return (c[i] - lo) / atr[i], (hi - c[i]) / atr[i]


def stats(xs):
    xs = [x for x in xs if x is not None]
    if len(xs) < 5:
        return None
    m = st.mean(xs)
    sd = st.pstdev(xs) or 1e-9
    return dict(n=len(xs), mean=m, med=st.median(xs), sd=sd,
                t=m / (sd / len(xs) ** 0.5), pos=sum(1 for x in xs if x > 0) / len(xs))


def analyse(path, symbol, cfg, horizons, label):
    d = prepare(load(path), cfg)
    events = find_events(d, cfg)
    kz = KILLZONES[cfg.killzone]
    in_kz = lambda i: any(a <= d["minute"][i] < b for a, b in kz)
    ev = [(i, s) for i, s in events if in_kz(i)]
    print(f"\n{label}: {len(events)} events ({len(ev)} in {cfg.killzone})")
    if len(ev) < 20:
        print("  too few events to say anything")
        return
    for k in horizons:
        e = stats([fwd(d, i, s, k) for i, s in ev])
        # baseline: every in-killzone bar, both directions, same horizon
        base_vals = []
        for i in range(0, d["n"] - k, max(1, d["n"] // 4000)):
            if in_kz(i):
                for s in (1, -1):
                    base_vals.append(fwd(d, i, s, k))
        b = stats(base_vals)
        if not e or not b:
            continue
        exc = [excursion(d, i, s, k) for i, s in ev]
        exc = [x for x in exc if x]
        mfe = st.mean([x[0] for x in exc]) if exc else 0
        mae = st.mean([x[1] for x in exc]) if exc else 0
        print(f"  +{k:3d} bars  event mean {e['mean']:+.3f} ATR (t={e['t']:+5.2f}, "
              f"{e['pos']:.0%} up, n={e['n']})   baseline {b['mean']:+.3f} "
              f"({b['pos']:.0%})   MFE {mfe:.2f} / MAE {mae:.2f} ATR")


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "../ictdata"
    for sym, tf, hz, kz in [("MNQ", "5m", [3, 6, 12, 24, 48], "rth"),
                            ("ES", "5m", [3, 6, 12, 24, 48], "rth"),
                            ("MNQ", "15m", [2, 4, 8, 16], "rth"),
                            ("MNQ", "1h", [1, 2, 4, 8], "rth"),
                            ("ES", "1h", [1, 2, 4, 8], "rth")]:
        cfg = Config(pivot_len=1, disp_atr=0.25, mss_window=6, killzone=kz)
        analyse(f"{data}/{sym}_{tf}.csv", sym, cfg, hz, f"{sym} {tf}")
