#!/usr/bin/env python3
"""Build indicators/nq_liquidity_heatmap_terminus.pine: the NQ Liquidity Heatmap
and TERMINUS as one Pine script, each part unchanged apart from what sharing a
script requires. Every edit is an exact, asserted string replacement, so a
change to either source that this script does not expect stops the build.

  git show origin/claude/friendly-mendel-0escsv:indicators/terminus_survival_reversal.pine > terminus.pine
  python3 backtest/combine_heatmap_terminus.py indicators/nq_liquidity_heatmap.pine \\
      terminus.pine indicators/nq_liquidity_heatmap_terminus.pine
"""
import re
import sys

hm_path, tm_path, out_path = sys.argv[1:4]
hm = open(hm_path).read()
tm = open(tm_path).read()

def rep(src, old, new, count=1):
    n = src.count(old)
    assert n == count, (old, n)
    return src.replace(old, new)

# ── heatmap: drop its declaration, namespace its input groups, add the on/off
#    switch and leave TERMINUS its share of the 500-line budget ──
hm_decl = ('//@version=6\nindicator("NQ/MNQ Liquidity Heatmap - ETH, all timeframes", shorttitle = "NQ ETH Liq", overlay = true,\n'
           '     max_lines_count = 500, max_boxes_count = 500, max_labels_count = 500)\n\n')
assert hm.startswith(hm_decl)
hm = hm[len(hm_decl):]
for g, name in [("G_NQ ", "Nasdaq-100 futures"), ("G_TF ", "Timeframes (all are scanned together)"),
                ("G_SW ", "Swing detection"), ("G_VIS", "Heatmap"), ("G_PRO", "Resting-liquidity profile"),
                ("G_TAB", "Summary table"), ("G_ALR", "Alerts")]:
    label = "Lines & colors" if name == "Heatmap" else name   # not "Heatmap · Heatmap"
    hm = rep(hm, f'var string {g} = "{name}"', f'var string {g} = "① Heatmap · {label}"')
hm = rep(hm, "    enabled and sec >= chartSec and not (useChartTf and sec == chartSec)",
             "    hmOn and enabled and sec >= chartSec and not (useChartTf and sec == chartSec)")
hm = rep(hm, "bool on0 = useChartTf", "bool on0 = hmOn and useChartTf")
hm = rep(hm, "bool on10   = useRTH and sessOk", "bool on10   = hmOn and useRTH and sessOk")
hm = rep(hm, "bool on11   = useON and sessOk", "bool on11   = hmOn and useON and sessOk")
hm = rep(hm, "int histCap = showHistory ? math.max(0, math.min(histMax, 480 - array.size(eng.active))) : 0",
             "// TM_LINES: lines kept free for TERMINUS (the 500-line limit is per script)\n"
             "int histCap = showHistory ? math.max(0, math.min(histMax, 480 - TM_LINES - array.size(eng.active))) : 0")
hm = rep(hm, "    // summary table\n    if showTable\n", "    // summary table\n    if showTable and hmOn\n")

# ── TERMINUS: drop its declaration, namespace its groups, resolve the one
#    clashing name (showTable), and skip its work when it is switched off ──
tm_decl = ('//@version=6\nindicator("TERMINUS · Price-Axis Survival Reversal Engine", shorttitle = "TERMINUS", overlay = true, '
           'max_boxes_count = 500, max_lines_count = 500, max_labels_count = 500, max_bars_back = 500)\n\n')
assert tm.startswith(tm_decl)
tm = tm[len(tm_decl):]
for i in range(1, 9):
    line = next(l for l in tm.splitlines() if l.startswith(f'string G{i} = "'))
    name = line.split('"')[1]
    tm = rep(tm, line, f'string G{i} = "② TERMINUS · {name}"')
tm = rep(tm, 'bool   showTable = input.bool(true, "Dashboard", group = G7)',
             'bool   showDash  = input.bool(true, "Dashboard", group = G7)')
tm = rep(tm, "    if showTable\n", "    if showDash\n")
tm = rep(tm, "\nif newEpoch and epP.size() > 20\n", "\nif tmOn and newEpoch and epP.size() > 20\n")
tm = rep(tm, "\nif absorb > 0 and uw + lw > 0\n", "\nif tmOn and absorb > 0 and uw + lw > 0\n")
tm = rep(tm, "\nif barstate.islast\n", "\nif barstate.islast and tmOn\n")
# names the heatmap also uses (as function locals / a parameter): give the
# TERMINUS globals their own names so no scope can ever shadow another
for a, b in [("ph", "stopPh"), ("pl", "stopPl"), ("tz", "sessTzT")]:
    assert not re.search(rf"\b{b}\b", hm + tm)
    tm = re.sub(rf"\b{a}\b", b, tm)
tm = rep(tm, "string sessTzT      = input.string(", "string sessTzT = input.string(")

head = '''//@version=6
indicator("NQ Liquidity Heatmap + TERMINUS", shorttitle = "NQ Liq+TRM", overlay = true,
     max_lines_count = 500, max_boxes_count = 500, max_labels_count = 500)

// ============================================================================
// TWO INDICATORS IN ONE SCRIPT
//   ① NQ/MNQ Liquidity Heatmap — ETH, all timeframes   (PART 1)
//   ② TERMINUS · Price-Axis Survival Reversal Engine   (PART 2)
//
// Each part is its standalone script, unchanged: its own inputs (settings
// groups prefixed ① / ②), math, drawings, table/dashboard, plots and alerts.
// Neither part reads the other's values. Either one can be switched off below;
// a switched-off part skips its work and draws nothing.
//
// The only things the two share are TradingView's per-script drawing limits
// (500 lines / boxes / labels). TERMINUS draws at most 20 lines (2 projections,
// 2 expectation lines, up to 8 ladder rows per side), so while it is on the
// heatmap keeps 20 fewer swept-history lines. Boxes and labels stay well under
// 500 combined. Renamed in TERMINUS only, so no name is declared twice:
// showTable → showDash, ph/pl → stopPh/stopPl, tz → sessTzT.
//
// TERMINUS's own declaration also set max_bars_back = 500. That argument sets
// the history buffer of EVERY series in the script, and here it would make
// TradingView keep 500 bars of the heatmap's per-timeframe level snapshots
// (arrays returned by 11 request.security calls), which is what the Pine docs
// name as the usual cause of "Memory limits exceeded". It is left out: every
// history reference in TERMINUS has a fixed length (inputs capped at 400 or
// less), which TradingView sizes automatically, and the heatmap sets its
// deep buffers explicitly with max_bars_back().
// ============================================================================

var string G_MOD = "Indicators in this script"
bool hmOn = input.bool(true, "① NQ Liquidity Heatmap (ETH, all timeframes)", group = G_MOD)
bool tmOn = input.bool(true, "② TERMINUS reversal engine", group = G_MOD)
int  TM_LINES = tmOn ? 20 : 0

// ############################################################################
// PART 1 — NQ/MNQ LIQUIDITY HEATMAP
// ############################################################################

'''
mid = '''
// ############################################################################
// PART 2 — TERMINUS · PRICE-AXIS SURVIVAL REVERSAL ENGINE
// ############################################################################

'''
out = head + hm.rstrip("\n") + "\n" + mid + tm.rstrip("\n") + "\n"
open(out_path, "w").write(out)
print(out_path, out.count("\n"), "lines")
