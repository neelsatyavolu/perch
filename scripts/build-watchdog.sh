#!/bin/bash
# Stops the Perch build if the Mac leaves AC power or macOS reports thermal/performance trouble.
LOG="$1"
stop_build() {
  echo "$(date '+%H:%M:%S') STOPPING BUILD: $1" >> "$LOG"
  pkill -f "perch-build build"; pkill -f autoninja; pkill -f siso
  exit 0
}
sleep 20
while pgrep -f "perch-build build" >/dev/null; do
  pmset -g batt | head -1 | grep -q "AC Power" || stop_build "not on AC power"
  therm="$(pmset -g therm)"
  echo "$therm" | grep -qiE "thermal warning level[^0-9]*[1-9]" && stop_build "thermal warning: $(echo "$therm" | tr '\n' ' ')"
  echo "$therm" | grep -qiE "performance warning level[^0-9]*[1-9]" && stop_build "performance warning: $(echo "$therm" | tr '\n' ' ')"
  limit="$(echo "$therm" | sed -n 's/.*CPU_Speed_Limit[^0-9]*\([0-9]*\).*/\1/p' | head -1)"
  [ -n "$limit" ] && [ "$limit" -lt 80 ] && stop_build "CPU speed limited to ${limit}%"
  sleep 30
done
echo "$(date '+%H:%M:%S') build ended; watchdog exiting" >> "$LOG"
