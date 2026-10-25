#!/bin/sh
# Usage: sh decide.sh approved|rejected [note]
# Records the ops lead's decision on the open plan through POST /actions.
. "$(dirname "$0")/lib.sh"
DECISION="$1"
NOTE="${2:-}"
R=$(get /risk) || { echo "$R"; exit 1; }
ID=$(echo "$R" | jq -r '.recommendation.id // empty')
if [ -z "$ID" ]; then
  echo "No open plan right now. Nothing to record."
  exit 0
fi
BODY=$(jq -nc --arg id "$ID" --arg d "$DECISION" --arg n "$NOTE" \
  '{recommendation_id: $id, decision: $d, by: "telegram:ops-lead", note: $n}')
OUT=$(post /actions "$BODY") || { echo "$OUT"; exit 1; }
echo "$OUT" | jq -r '
  if .ok and .already then "Plan \(.recommendation.id) was already \(.already)."
  elif .ok then "Plan \(.recommendation.id) \(.recommendation.status). Logged actions: \(.recommendation.actions | join("; "))."
  else "ERROR: \(.error)" end'
