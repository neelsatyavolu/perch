#!/usr/bin/env bash
# Runs a long Perch build unattended, safely.
#
#   scripts/overnight-build.sh [dev|release]      JOBS=8 by default
#
# Refuses to start off the charger, keeps the Mac awake while it runs (the lid must stay open
# unless an external display is attached), caps parallel jobs at low priority, and runs
# scripts/build-watchdog.sh, which stops the build on a heat or slowdown warning or if the
# charger is unplugged. Everything is logged to dist/overnight-<config>.log.
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${1:-dev}"
JOBS="${JOBS:-8}"
LOG="dist/overnight-$CONFIG.log"
mkdir -p dist

if ! pmset -g batt | head -1 | grep -q "AC Power"; then
    echo "error: plug the Mac in first" >&2
    exit 1
fi
echo "$(date '+%Y-%m-%d %H:%M') starting $CONFIG build with $JOBS jobs" >> "$LOG"
caffeinate -i -w $$ &
scripts/build-watchdog.sh "$LOG" &
uv run perch-build build --config "$CONFIG" --jobs "$JOBS" >> "$LOG" 2>&1
echo "$(date '+%Y-%m-%d %H:%M') $CONFIG build finished" >> "$LOG"
