# Shared helpers for the agent scripts. Sourced, not run.
API="${SSO_API:-http://host.openshell.internal:18310}"

# get <path>: GET from the data API, or print ERROR and fail
get() {
  curl -sf -m 15 "$API$1" || { echo "ERROR: data API unreachable ($1)"; return 1; }
}

# post <path> <json>: POST JSON to the data API
post() {
  curl -s -m 15 -X POST -H 'Content-Type: application/json' --data-binary "$2" "$API$1" \
    || { echo "ERROR: data API unreachable ($1)"; return 1; }
}
