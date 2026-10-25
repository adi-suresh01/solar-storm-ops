#!/usr/bin/env bash
# Start/stop the data API on the GB10.
#   backend/run.sh start [bind-list]   e.g. backend/run.sh start 127.0.0.1,172.17.0.1
#   backend/run.sh stop | status | log
# Never binds 0.0.0.0 (api.py refuses it).
set -u
cd "$(dirname "$0")/.."
PY="${SSO_PYTHON:-$HOME/sso-venv/bin/python}"
[ -x "$PY" ] || PY=python3
mkdir -p state
BIND="${2:-${SSO_BIND:-127.0.0.1}}"

case "${1:-status}" in
  start)
    pkill -f "backend/api.py" 2>/dev/null; sleep 1
    setsid -f nohup "$PY" backend/api.py --bind "$BIND" > state/api.log 2>&1 < /dev/null
    for _ in $(seq 1 20); do grep -q serving state/api.log && break; sleep 1; done
    cat state/api.log ;;
  stop)
    pkill -f "backend/api.py" && echo stopped ;;
  status)
    pgrep -af "backend/api.py" || echo "not running" ;;
  log)
    tail -n 50 state/api.log ;;
esac
