#!/bin/sh
# Usage: sh reject.sh [note]   Reject the open plan.
exec sh "$(dirname "$0")/decide.sh" rejected "${1:-rejected on Telegram}"
