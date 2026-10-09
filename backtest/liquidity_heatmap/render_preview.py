#!/usr/bin/env python3
"""Draw the Liquidity Heatmap's own output (lines, profile boxes, labels,
summary table as recorded by run_pinets.mjs) over the candles it ran on.
Nothing is recomputed here — it only plots what the script drew.

Usage: python3 render_preview.py <pinets_out.json> <chart_klines.json> <start_idx> <out.png> [bars]
Needs matplotlib.
"""
import bisect
import datetime as dt
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

BG, FG, GRID = "#131722", "#d1d4dc", "#1e222d"


def rgba(h):
    h = h.lstrip("#")
    a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
    return int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, a


def main(src, klines, start_idx, out, n_show=300):
    with open(src) as f:
        plots = json.load(f)["plots"]
    with open(klines) as f:
        bars = json.load(f)[start_idx:]
    n = len(bars)
    times = [b["openTime"] for b in bars]

    def x_of(t):  # bar-time coordinate → fractional bar index
        i = bisect.bisect_right(times, t) - 1
        if i < 0:
            return -1e9
        if i < n - 1 and t > times[i]:
            return i + (t - times[i]) / (times[i + 1] - times[i])
        return i

    last = lambda k: plots[k][-1]["value"]  # noqa: E731
    fig, ax = plt.subplots(figsize=(16, 9), dpi=110)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    x0 = n - n_show
    for i in range(x0, n):
        b = bars[i]
        c = "#089981" if b["close"] >= b["open"] else "#f23645"
        ax.plot([i, i], [b["low"], b["high"]], color=c, lw=0.7, zorder=2)
        ax.add_patch(Rectangle((i - 0.3, min(b["open"], b["close"])), 0.6,
                               max(abs(b["close"] - b["open"]), 1e-9), color=c, zorder=3))
    for ln in last("__lines__"):
        if ln.get("_deleted") or x_of(ln["x2"]) < x0:
            continue
        ax.plot([max(x_of(ln["x1"]), x0 - 1), x_of(ln["x2"])], [ln["y1"], ln["y2"]],
                color=rgba(ln["color"]), lw=ln["width"] * 1.1, solid_capstyle="butt", zorder=4)
    for bx in last("__boxes__"):
        if not bx.get("_deleted"):
            ax.add_patch(Rectangle((bx["left"], bx["bottom"]), bx["right"] - bx["left"], bx["top"] - bx["bottom"],
                                   facecolor=rgba(bx["bgcolor"]), edgecolor=BG, lw=0.8, zorder=5))
    for lb in last("__labels__"):
        if not lb.get("_deleted"):
            ax.text(lb["x"], lb["y"], " " + lb["text"], color=FG, fontsize=8, va="center", ha="left",
                    zorder=6, clip_on=True, bbox=dict(boxstyle="square,pad=0.2", fc=BG, ec="none", alpha=0.85))
    table = last("__tables__")[0]
    text = "\n".join("   ".join(c["text"] for c in row if c.get("text")) for row in table["cells"])
    ax.text(0.005, 0.01, text, transform=ax.transAxes, ha="left", va="bottom", fontsize=8, color=FG,
            family="monospace", bbox=dict(boxstyle="square,pad=0.5", fc="#1e222d", ec="#363a45"), zorder=7)
    lo = min(b["low"] for b in bars[x0:])
    hi = max(b["high"] for b in bars[x0:])
    pad = (hi - lo) * 0.35
    ax.set_xlim(x0 - 1, n + 75)
    ax.set_ylim(lo - pad, hi + pad)
    ax.tick_params(colors="#787b86", labelsize=8)
    for sp in ax.spines.values():
        sp.set_color("#2a2e39")
    ticks = list(range(x0, n, max(1, n_show // 8)))
    ax.set_xticks(ticks)
    ax.set_xticklabels([dt.datetime.fromtimestamp(times[i] / 1000, dt.UTC).strftime("%b %d") for i in ticks])
    ax.yaxis.tick_right()
    ax.grid(color=GRID, lw=0.6)
    plt.tight_layout()
    plt.savefig(out, facecolor=BG)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5]) if len(sys.argv) > 5 else 300)
