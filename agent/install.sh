#!/usr/bin/env bash
# Install the Solar Storm Ops agent files into sandbox "ops". Run on the GB10 host
# from the repo root:  agent/install.sh
#
# AGENTS.md and SOUL.md in the sandbox = our section on top of OpenClaw's stock
# template (the files NemoClaw seeds), so the default guidance is kept.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$HOME/.local/bin:$PATH"
SB="${SSO_SANDBOX:-ops}"
WS=/sandbox/.openclaw/workspace
TPL=/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/docs/reference/templates
X=(openshell sandbox exec -n "$SB" --no-tty --)

strip_frontmatter() { awk 'NR==1 && /^---$/ {fm=1; next} fm && /^---$/ {fm=0; next} !fm {print}'; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/ws"
cp -R workspace/sso "$tmp/ws/"
for f in AGENTS.md SOUL.md; do
  { cat "workspace/$f"; printf '\n---\n'; "${X[@]}" cat "$TPL/$f" | strip_frontmatter; } > "$tmp/ws/$f"
done

tar -C "$tmp/ws" -cf - . | "${X[@]}" tar -C "$WS" -xf -
"${X[@]}" sh -c "chmod +x $WS/sso/*.sh && ls -la $WS $WS/sso"
echo "installed workspace files into sandbox $SB"

[ "${1:-}" = "--automations" ] || { echo "(pass --automations to recreate the automations too)"; exit 0; }

# Automations. Recreating storm-watch resets its dedupe state, so an open alert
# is sent again. The Telegram target is the allowlisted ops lead from the
# sandbox config, so no id lives in the repo.
oc() { "${X[@]}" openclaw "$@" 2>&1 | grep -v '^\[gateway\]'; }
TO="${SSO_TELEGRAM_TO:-$("${X[@]}" jq -r '.channels.telegram.accounts.default.allowFrom[0]' /sandbox/.openclaw/openclaw.json)}"
for n in storm-watch morning-brief; do
  id=$(oc automations list --all --json | jq -r --arg n "$n" '.jobs[] | select(.name == $n) | .id')
  [ -n "$id" ] && oc automations rm "$id" >/dev/null && echo "removed old $n"
done
COMMON=(--agent main --session isolated --announce --channel telegram --to "$TO"
        --tools exec --thinking off --timeout-seconds 180)
oc automations add --name storm-watch --display-name "Storm watch" "${COMMON[@]}" \
  --description "Every 30 s: check NOAA-driven risk; alert the ops lead on Telegram when a plan needs approval" \
  --every 30s --trigger-script "$WS/sso/storm-check.js" \
  --message "A storm alert just fired. The alert text from the Solar Storm Ops data API is appended below. Write the Telegram storm alert for the ops lead, following the Storm alerts rules in AGENTS.md. Use only facts from the alert text. Reply with the message only." \
  | jq -r '"added \(.name) \(.id)"'
oc automations add --name morning-brief --display-name "Morning brief" "${COMMON[@]}" \
  --description "07:00 daily: space weather and constellation brief for the ops lead" \
  --cron "0 7 * * *" --tz America/Los_Angeles --exact \
  --message "Morning brief time. Run sh $WS/sso/brief.sh and write the morning brief for the ops lead, following the Morning brief rules in AGENTS.md. Start with: Good morning. Reply with the message only." \
  | jq -r '"added \(.name) \(.id)"'
