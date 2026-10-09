#!/usr/bin/env bash
# Verify indicators/liquidity_heatmap_mtf.pine end to end on real data:
# run the actual Pine source in PineTS, then check every bar of its output
# against the independent truth model (truth.py).
#
#   backtest/liquidity_heatmap/verify.sh [work_dir]
#
# Needs python3 (venv) and node >= 20 with npm. Installs `backtesting`
# (only for its bundled EURUSD/GOOG history), pandas, and pinets@0.11.0
# into work_dir. Exits non-zero if any check fails after warm-up.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PINE="$HERE/../../indicators/liquidity_heatmap_mtf.pine"
WORK="${1:-${TMPDIR:-/tmp}/liquidity_heatmap_verify}"
mkdir -p "$WORK/data" "$WORK/out"

if [ ! -x "$WORK/venv/bin/python" ]; then
  python3 -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install -q backtesting pandas
fi
if [ ! -d "$WORK/node_modules/pinets" ]; then
  (cd "$WORK" && npm init -y >/dev/null && npm install --silent pinets@0.11.0)
fi
cp "$HERE/run_pinets.mjs" "$WORK/run_pinets.mjs"
"$WORK/venv/bin/python" "$HERE/prep_data.py" "$WORK/data" >/dev/null

fail=0
check() {  # symbol chart_tf start_idx slot_tfs left right cap
  local sym=$1 tf=$2 st=$3 tfs=$4 l=$5 r=$6 c=$7
  local ov out="$WORK/out/${sym}_${tf}_${st}_${l}_${r}_${c}.json"
  ov=$(printf '{"input.int\\\\(5,  \\"Swing strength: bars on the left\\"":"input.int(%s,  \\"Swing strength: bars on the left\\"","input.int\\\\(3,  \\"Swing strength: bars on the right\\"":"input.int(%s,  \\"Swing strength: bars on the right\\"","input.int\\\\(10, \\"Unswept levels tracked":"input.int(%s, \\"Unswept levels tracked"}' "$l" "$r" "$c")
  echo "== $sym chart=$tf start=$st swing=$l/$r cap=$c"
  (cd "$WORK" && node run_pinets.mjs "$PINE" "$WORK/data" "$sym" "$tf" "$st" "$out" "$ov" --tv-timing)
  "$WORK/venv/bin/python" "$HERE/truth.py" "$WORK/data" "$sym" "$tf" "$st" "$out" "$tfs" "$l" "$r" "$c" on || fail=1
}

# defaults and alternate swing/cap settings, several chart start phases
check EURUSD 60  1500 60,240,D,W,M 5 3 10
check EURUSD 60  1503 60,240,D,W,M 5 3 10
check EURUSD 60  2222 60,240,D,W,M 5 3 10
check EURUSD 60  1777 60,240,D,W,M 2 1 3
check EURUSD 60  2500 60,240,D,W,M 2 1 1
check EURUSD 60  1200 60,240,D,W,M 10 5 20
check EURUSD 240 300  240,D,W,M    5 3 10
check EURUSD D   60   D,W,M        2 1 5
check GOOG   D   700  D,W,M        5 3 10
check GOOG   D   1900 D,W,M        2 1 2
# starts where a higher-timeframe level was already swept before the chart's first bar
check EURUSD 60  970  60,240,D,W,M 5 3 10
check EURUSD 60  2020 60,240,D,W,M 5 3 10
check EURUSD 60  975  60,240,D,W,M 2 1 10
check EURUSD 60  3492 60,240,D,W,M 2 1 10
check GOOG   D   1569 D,W,M        2 1 10
# no volume feed → heat = number of confirming timeframes
check EURNV  60  1500 60,240,D,W,M 5 3 10
check EURNV  240 400  240,D,W,M    3 2 6

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL CHECKS PASSED"
