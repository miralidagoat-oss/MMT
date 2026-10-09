#!/usr/bin/env bash
# Verify indicators/nq_liquidity_heatmap.pine end to end on real data: run
# the actual Pine source in PineTS, then check every bar of its output
# against the independent truth model (truth.py).
#
#   backtest/nq_liquidity_heatmap/verify.sh [work_dir]
#
# Needs python3 (venv) and node >= 20 with npm. Installs `backtesting`
# (only for its bundled EURUSD/GOOG history), pandas, and pinets@0.11.0
# into work_dir. Exits non-zero if any check fails after warm-up.
#
# No public Nasdaq-100 futures history ships with any package reachable
# here, so the fixtures are other real markets; what is verified is the
# script's logic (books, merging, sweeps, sessions, alerts, profile), which
# is symbol-agnostic. Session tests use the finest real data available (1H),
# with session boundaries on the hour.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PINE="$HERE/../../indicators/nq_liquidity_heatmap.pine"
WORK="${1:-${TMPDIR:-/tmp}/nq_liquidity_heatmap_verify}"
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

# input overrides (regex on the Pine source → replacement), as JSON
overrides() {  # left right cap every(0|1) sessions(0|1)
  "$WORK/venv/bin/python" - "$@" <<'PY'
import json, sys
l, r, c, every, sess = sys.argv[1:6]
o = {
    r'input\.int\(5,  "Swing strength: bars on the left"': f'input.int({l},  "Swing strength: bars on the left"',
    r'input\.int\(3,  "Swing strength: bars on the right"': f'input.int({r},  "Swing strength: bars on the right"',
    r'input\.int\(10, "Unswept levels tracked': f'input.int({c}, "Unswept levels tracked',
    r'everyHTF = input\.bool\(true,': f'everyHTF = input.bool({"true" if every == "1" else "false"},',
}
if sess == "1":
    o[r'string SESS_TF = "30"'] = 'string SESS_TF = "60"'
    o[r'input\.session\("0930-1600"'] = 'input.session("1000-1600"'
    o[r'input\.session\("1800-0930"'] = 'input.session("1800-1000"'
print(json.dumps(o))
PY
}

fail=0
check() {  # symbol chart_tf start_idx slot_tfs left right cap every sessions
  local sym=$1 tf=$2 st=$3 tfs=$4 l=$5 r=$6 c=$7 ev=$8 se=$9
  local out="$WORK/out/${sym}_${tf}_${st}_${l}_${r}_${c}_e${ev}_s${se}.json" extra=()
  [ "$se" = 1 ] && extra=(--sessions "RTH=1000-1600,ON=1800-1000" --sess-tf 60)
  echo "== $sym chart=$tf start=$st swing=$l/$r cap=$c every-bar=$ev sessions=$se"
  (cd "$WORK" && node run_pinets.mjs "$PINE" "$WORK/data" "$sym" "$tf" "$st" "$out" "$(overrides "$l" "$r" "$c" "$ev" "$se")" --tv-timing)
  "$WORK/venv/bin/python" "$HERE/truth.py" "$WORK/data" "$sym" "$tf" "$st" "$out" "$tfs" \
    --swing "$l" "$r" --cap "$c" --every "$ev" "${extra[@]}" || fail=1
}

# defaults (every prior D/W/M high & low on) at several start phases and settings
check EURUSD 60  1500 60,240,D,W,M 5 3 10 1 0
check EURUSD 60  1503 60,240,D,W,M 5 3 10 1 0
check EURUSD 60  2222 60,240,D,W,M 5 3 10 1 0
check EURUSD 60  1777 60,240,D,W,M 2 1 3  1 0
check EURUSD 60  2500 60,240,D,W,M 2 1 1  1 0
check EURUSD 60  1200 60,240,D,W,M 10 5 20 1 0
check EURUSD 240 300  240,D,W,M    5 3 10 1 0
check EURUSD D   60   D,W,M        2 1 5  1 0
check GOOG   D   700  D,W,M        5 3 10 1 0
check GOOG   D   1900 D,W,M        2 1 2  1 0
# swing points only on D/W/M
check EURUSD 60  1500 60,240,D,W,M 5 3 10 0 0
check GOOG   D   700  D,W,M        5 3 10 0 0
check EURUSD D   60   D,W,M        2 1 5  0 0
# starts where a higher-timeframe level was already swept before the chart's first bar
check EURUSD 60  970  60,240,D,W,M 5 3 10 0 0
check EURUSD 60  2020 60,240,D,W,M 5 3 10 0 0
check EURUSD 60  975  60,240,D,W,M 2 1 10 0 0
check EURUSD 60  3492 60,240,D,W,M 2 1 10 0 0
check GOOG   D   1569 D,W,M        2 1 10 0 0
check EURUSD 60  970  60,240,D,W,M 5 3 10 1 0
# RTH / overnight session levels
check EURUSD 60  1500 60,240,D,W,M 5 3 10 1 1
check EURUSD 60  2222 60,240,D,W,M 2 1 4  1 1
check EURUSD 60  970  60,240,D,W,M 5 3 10 0 1
check EURUSD 60  3333 60,240,D,W,M 5 3 20 1 1
# no volume feed → heat = number of confirming sources
check EURNV  60  1500 60,240,D,W,M 5 3 10 1 1
check EURNV  240 400  240,D,W,M    3 2 6  1 0

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL CHECKS PASSED"
