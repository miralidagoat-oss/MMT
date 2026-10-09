#!/usr/bin/env bash
# Verify indicators/nq_liquidity_heatmap_terminus.pine: on the same real data,
# the combined script must reproduce each standalone script exactly (plots,
# alerts, labels, boxes, lines), and a part switched off must produce nothing.
#
#   backtest/nq_liquidity_heatmap/verify_combined.sh [work_dir]
#
# Uses the same work_dir, fixtures and PineTS runner as verify.sh. TERMINUS
# is read from its branch (claude/friendly-mendel-0escsv), the combined file
# is rebuilt from both sources first and must match the committed one.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
WORK="${1:-${TMPDIR:-/tmp}/nq_liquidity_heatmap_verify}"
mkdir -p "$WORK/data" "$WORK/out_combined"

if [ ! -x "$WORK/venv/bin/python" ]; then
  python3 -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install -q backtesting pandas
fi
if [ ! -d "$WORK/node_modules/pinets" ]; then
  (cd "$WORK" && npm init -y >/dev/null && npm install --silent pinets@0.11.0)
fi
cp "$HERE/run_pinets.mjs" "$WORK/run_pinets.mjs"
"$WORK/venv/bin/python" "$HERE/prep_data.py" "$WORK/data" >/dev/null

HM="$ROOT/indicators/nq_liquidity_heatmap.pine"
TM="$WORK/terminus.pine"
COMBINED="$ROOT/indicators/nq_liquidity_heatmap_terminus.pine"
git -C "$ROOT" fetch -q origin claude/friendly-mendel-0escsv
git -C "$ROOT" show FETCH_HEAD:indicators/terminus_survival_reversal.pine > "$TM"
python3 "$ROOT/backtest/combine_heatmap_terminus.py" "$HM" "$TM" "$WORK/rebuilt.pine" >/dev/null
cmp "$WORK/rebuilt.pine" "$COMBINED" || { echo "committed combined file is stale: rebuild it"; exit 1; }

OFF_HM='{"bool hmOn = input\\.bool\\(true,": "bool hmOn = input.bool(false,"}'
OFF_TM='{"bool tmOn = input\\.bool\\(true,": "bool tmOn = input.bool(false,"}'
O="$WORK/out_combined"
tags=()
# runs are sequential: the --tv-timing runner rewrites its patched bundle on start
for setup in "EURUSD 60 1500" "EURNV 60 1500" "EURUSD 240 300"; do
  set -- $setup; tag="$1_$2_$3"; tags+=("$tag")
  echo "== $tag"
  (cd "$WORK" && node run_pinets.mjs "$COMBINED" data "$1" "$2" "$3" "$O/both_$tag.json" '{}' --tv-timing)
  (cd "$WORK" && node run_pinets.mjs "$COMBINED" data "$1" "$2" "$3" "$O/nohm_$tag.json" "$OFF_HM" --tv-timing)
  (cd "$WORK" && node run_pinets.mjs "$COMBINED" data "$1" "$2" "$3" "$O/notm_$tag.json" "$OFF_TM" --tv-timing)
  (cd "$WORK" && node run_pinets.mjs "$HM" data "$1" "$2" "$3" "$O/hm_$tag.json" '{}' --tv-timing)
  (cd "$WORK" && node run_pinets.mjs "$TM" data "$1" "$2" "$3" "$O/tm_$tag.json" '{}' --tv-timing)
done
python3 "$HERE/compare_combined.py" "$O" "${tags[@]}"
