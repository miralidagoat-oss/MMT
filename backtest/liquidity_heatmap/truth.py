#!/usr/bin/env python3
"""Independent truth model for indicators/liquidity_heatmap_mtf.pine.

The Pine script is incremental (it carries pools from bar to bar, merges
timeframes, reconciles snapshots). This model is not: at every chart bar it
recomputes what is resting from raw OHLCV alone, then compares against the
script's output as executed by PineTS (see run_pinets.mjs):

  1. each timeframe's book of unswept swing levels as of the previous closed
     bar of that timeframe (TradingView pivot rule: >= the left bars,
     strictly > the right bars; at most CAP per side, oldest dropped),
  2. minus levels traded through between that timeframe bar's open and the
     current chart bar (high > level for BSL, low < level for SSL),
  3. merged into pools: same side, same price, overlapping swing-bar time
     spans (transitively); weight = largest swing-bar volume among members,
     or the number of distinct timeframes when the feed has no volume.

Checks:
  - the 8 Data Window series on every bar (counts, nearest, biggest + weight)
  - every sweep alert (which pools are taken on which bar)
  - the resting-liquidity profile drawn on the last bar
Each is compared twice: against ALL data (the truth) and against only the
bars visible on the chart. They may differ only while each timeframe's first
bar on the chart is still incomplete ("warm-up"); after that both must match
exactly or the script exits non-zero.

usage: truth.py <data_dir> <symbol> <chart_tf> <start_idx> <pinets_out.json>
                <slot tfs csv, chart tf first> [left right cap] [map]
map "on"  (default): a chart bar sees the snapshot of the timeframe bar that
          contains it — TradingView's lookahead_on
    "off": it sees the last timeframe bar that has closed by the chart bar's
          close — how stock PineTS 0.11 delivers arrays from request.security
"""
import bisect
import json
import math
import re
import sys

data_dir, sym, chart_tf, start_idx, pine_out, tfs = sys.argv[1:7]
L, R, CAP = (int(x) for x in (sys.argv[7:10] if len(sys.argv) > 9 else (5, 3, 10)))
MAP = sys.argv[10] if len(sys.argv) > 10 else "on"
start_idx = int(start_idx)
TICK = 0.00001 if sym.startswith("EUR") else 0.01
# script defaults used by the profile check
PROF_BARS, PROF_EXT_PCT, PROF_ROWS, PROF_WIDTH = 300, 25, 30, 30


def load(tf):
    with open(f"{data_dir}/{sym}_{tf}.json") as f:
        return json.load(f)


base = load(chart_tf)
chart = base[start_idx:]
chart_start, chart_end = chart[0]["openTime"], chart[-1]["openTime"]
base_open = [r["openTime"] for r in base]
has_volume = any(r["volume"] > 0 for r in base)


def pivots(rows):
    hs = [r["high"] for r in rows]
    ls = [r["low"] for r in rows]
    ph, pl = [None] * len(rows), [None] * len(rows)
    for n in range(L + R, len(rows)):
        c = n - R
        if all(hs[c - o] <= hs[c] for o in range(1, L + 1)) and all(hs[c + o] < hs[c] for o in range(1, R + 1)):
            ph[n] = hs[c]
        if all(ls[c - o] >= ls[c] for o in range(1, L + 1)) and all(ls[c + o] > ls[c] for o in range(1, R + 1)):
            pl[n] = ls[c]
    return ph, pl


def books(rows):
    """snaps[k] = (highs, lows) before bar k is applied; level = (px, vol, t0, t1)."""
    ph, pl = pivots(rows)
    hi, lo, snaps = [], [], []
    for k, r in enumerate(rows):
        snaps.append((list(hi), list(lo)))
        hi = [x for x in hi if not r["high"] > x[0]]
        lo = [x for x in lo if not r["low"] < x[0]]
        if ph[k] is not None:
            p = rows[k - R]
            hi.append((ph[k], p["volume"], p["openTime"], p["closeTime"]))
            if len(hi) > CAP:
                hi.pop(0)
        if pl[k] is not None:
            p = rows[k - R]
            lo.append((pl[k], p["volume"], p["openTime"], p["closeTime"]))
            if len(lo) > CAP:
                lo.pop(0)
    return snaps


slots = []
for tf in tfs.split(","):
    rows = chart if tf == chart_tf else [r for r in load(tf) if r["openTime"] <= chart_end]
    slots.append(dict(tf=tf, same=tf == chart_tf, opens=[r["openTime"] for r in rows],
                      closes=[r["closeTime"] for r in rows], snaps=books(rows)))


def snap_index(s, bar):
    if MAP == "on" or s["same"]:
        return bisect.bisect_right(s["opens"], bar["openTime"]) - 1
    return bisect.bisect_right(s["closes"], bar["closeTime"]) - 1


def extreme(a_time, b_time, visible_only):
    """max high / min low of base bars opening in [a_time, b_time]."""
    lo_i = bisect.bisect_left(base_open, max(a_time, chart_start) if visible_only else a_time)
    seg = base[lo_i:bisect.bisect_right(base_open, b_time)]
    if not seg:
        return None, None
    return max(r["high"] for r in seg), min(r["low"] for r in seg)


def pools_at(bar, visible_only, through=None):
    """Pools resting on `bar` after sweeps by base bars up to `through`
    (default: the bar itself)."""
    through = bar["openTime"] if through is None else through
    levels = []
    for si, s in enumerate(slots):
        k = snap_index(s, bar)
        if k < 0:
            continue
        hi, lo = s["snaps"][k]
        mx, mn = extreme(s["opens"][k], through, visible_only) if through >= s["opens"][k] else (None, None)
        levels += [(True, x, si) for x in hi if mx is None or not mx > x[0]]
        levels += [(False, x, si) for x in lo if mn is None or not mn < x[0]]
    parent = list(range(len(levels)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(levels)):
        for j in range(i + 1, len(levels)):
            a, b = levels[i], levels[j]
            if (a[0] == b[0] and abs(a[1][0] - b[1][0]) <= TICK * 0.5
                    and a[1][2] < b[1][3] and b[1][2] < a[1][3]):
                parent[find(i)] = find(j)
    groups = {}
    for i, lv in enumerate(levels):
        groups.setdefault(find(i), []).append(lv)
    out = []
    for g in groups.values():
        w = max(x[1][1] for x in g) if has_volume else float(len({x[2] for x in g}))
        out.append(dict(isHigh=g[0][0], price=g[0][1][0], w=w))
    return out


def summary(pools):
    bsl = [p for p in pools if p["isHigh"]]
    ssl = [p for p in pools if not p["isHigh"]]
    res = {"Resting BSL pools": len(bsl), "Resting SSL pools": len(ssl),
           "Nearest BSL": min((p["price"] for p in bsl), default=None),
           "Nearest SSL": max((p["price"] for p in ssl), default=None)}
    for side, ps in (("BSL", bsl), ("SSL", ssl)):
        w = max((p["w"] for p in ps), default=None)
        res[f"Biggest {side} weight"] = w
        res[f"Biggest {side}"] = None if w is None else sorted({p["price"] for p in ps if p["w"] == w})
    return res


with open(pine_out) as f:
    out = json.load(f)
pine = out["plots"]
KEYS = ["Resting BSL pools", "Resting SSL pools", "Nearest BSL", "Nearest SSL",
        "Biggest BSL weight", "Biggest SSL weight", "Biggest BSL", "Biggest SSL"]


def pv(name, i):
    v = pine[name][i]["value"]
    return None if v is None or v != v else v


def same(a, b, key):
    if key.startswith("Biggest") and not key.endswith("weight"):
        return (a is None and b is None) or (a is not None and b is not None
                                             and any(abs(a - x) <= TICK * 0.5 for x in b))
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= max(1e-9, abs(b) * 1e-12)


# warm-up: until every slot's first fully visible bar has opened
first_full = []
for s in slots:
    k0 = bisect.bisect_right(s["opens"], chart_start) - 1
    if s["opens"][k0] == chart_start:
        first_full.append(chart_start)
    elif k0 + 1 < len(s["opens"]):
        first_full.append(s["opens"][k0 + 1])
warm_end = max(first_full)
failed = False

# 1) Data Window series, every bar
for mode in ("all-data", "visible"):
    bad = bad_after = 0
    for i, bar in enumerate(chart):
        tr = summary(pools_at(bar, mode == "visible"))
        for k in KEYS:
            if not same(pv(k, i), tr[k], k):
                bad += 1
                bad_after += bar["openTime"] >= warm_end
    failed |= bad_after > 0
    print(f"  series  [{mode:8}] {len(chart)} bars x {len(KEYS)}: mismatches {bad} "
          f"(after warm-up: {bad_after})")

# 2) sweep alerts (default alert timeframe 60 <= chart timeframe: every pool alerts)
alerted = {}
for a in out.get("alerts") or []:
    if a["type"] == "alert":
        for m in re.finditer(r"(BSL|SSL) swept @ ([0-9.]+)", a["message"]):
            alerted.setdefault(a["bar_index"], set()).add((m.group(1), round(float(m.group(2)), 8)))
bad_after = n_expected = 0
for i in range(1, len(chart)):
    bar = chart[i]
    if bar["openTime"] < warm_end:
        continue
    rest = pools_at(bar, False, through=chart[i - 1]["openTime"])
    exp = {("BSL" if p["isHigh"] else "SSL", round(p["price"], 8)) for p in rest
           if (p["isHigh"] and bar["high"] > p["price"]) or (not p["isHigh"] and bar["low"] < p["price"])}
    n_expected += len(exp)
    bad_after += exp != alerted.get(i, set())
failed |= bad_after > 0
print(f"  alerts  [all-data] {n_expected} sweeps after warm-up: bars with mismatch {bad_after}")

# 3) profile on the last bar
last = chart[-1]
pools = pools_at(last, False)
win = chart[-min(PROF_BARS, len(chart)):]
hi, lo = max(b["high"] for b in win), min(b["low"] for b in win)
ext = (hi - lo) * PROF_EXT_PCT / 100.0
top, bot = hi + ext, lo - ext
rows = [0.0] * PROF_ROWS
row_h = (top - bot) / PROF_ROWS
for p in pools:
    if bot <= p["price"] <= top:
        r = min(PROF_ROWS - 1, int(math.floor((p["price"] - bot) / row_h)))
        rows[r] += p["w"]
mx = max(rows)
exp = sorted((round(bot + r * row_h, 6), max(1, int(math.floor(v / mx * PROF_WIDTH + 0.5))))
             for r, v in enumerate(rows) if v > 0) if mx > 0 else []
boxes = [b for b in pine["__boxes__"][-1]["value"] if not b.get("_deleted")]
got = sorted((round(b["bottom"], 6), b["right"] - b["left"]) for b in boxes)
failed |= exp != got
print(f"  profile [last bar] rows expected {len(exp)}, drawn {len(got)}: {'identical' if exp == got else 'MISMATCH'}")

sys.exit(1 if failed else 0)
