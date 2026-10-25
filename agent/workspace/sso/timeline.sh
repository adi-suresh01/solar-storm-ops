#!/bin/sh
# The last 8 events on the timeline.
. "$(dirname "$0")/lib.sh"
T=$(get /timeline) || { echo "$T"; exit 1; }
echo "$T" | jq -r '.[-8:][] | "\(.time) \(.kind): \(.text)"'
