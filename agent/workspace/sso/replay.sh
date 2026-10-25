#!/bin/sh
# Usage: sh replay.sh feb2022|may2024|live [speed]
# Starts a storm replay (real archived Kp, SIMULATED forecast) or goes back to live.
. "$(dirname "$0")/lib.sh"
case "$1" in
  feb2022|may2024|live) ;;
  *) echo "ERROR: scenario must be feb2022, may2024 or live"; exit 1 ;;
esac
OUT=$(post /replay "{\"scenario\": \"$1\", \"speed\": ${2:-360}}") || { echo "$OUT"; exit 1; }
echo "$OUT" | jq -r 'if .ok then "Now in mode \(.mode)." else "ERROR: \(.error)" end'
