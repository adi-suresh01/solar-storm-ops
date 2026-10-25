#!/bin/sh
# Usage: sh approve.sh [note]   Approve the open plan.
exec sh "$(dirname "$0")/decide.sh" approved "${1:-approved on Telegram}"
