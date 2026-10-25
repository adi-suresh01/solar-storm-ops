#!/bin/sh
# Usage: sh ops.sh runbook.md|launch_schedule.json|maneuver_budget.json
# MOCK operator files, served by the data API from ops-data/.
. "$(dirname "$0")/lib.sh"
case "$1" in
  *[!A-Za-z0-9_.-]*|"") echo "ERROR: give a file name like runbook.md"; exit 1 ;;
esac
get "/ops-data/$1" || echo "(file $1 not found)"
