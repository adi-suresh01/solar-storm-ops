# agent

The OpenClaw agent in NemoClaw sandbox `ops` on the GB10. Model: Qwen3.8-Flash-Next
on local vLLM. Channel: Telegram DM with the ops lead (allowlist only).

| Path | What |
|---|---|
| `workspace/AGENTS.md`, `SOUL.md` | Our instructions. `install.sh` puts them on top of OpenClaw's stock templates |
| `workspace/sso/*.sh` | Scripts the agent runs with `exec` (status, check, approve, reject, brief, timeline, ops files, replay) |
| `workspace/sso/storm-check.js` | Condition script for the `storm-watch` automation |
| `policy/solar-storm-api.yaml` | OpenShell preset: curl in the sandbox may reach the data API routes, nothing else |
| `install.sh` | Copies the workspace into the sandbox; `--automations` recreates the two automations |

## How it fits together

```
api.py (host, 127.0.0.1 + 172.18.0.1:18310)
   ^  curl via OpenShell proxy, policy solar-storm-api
   |
storm-watch automation, every 30 s
   storm-check.js peeks GET /check -> new "SOLAR STORM ..." first line?
   -> agent turn (Qwen3.8) writes the alert -> announced to Telegram
ops lead replies "approve"
   -> normal chat turn -> sso/approve.sh -> POST /actions -> timeline + globe update
morning-brief automation, 07:00 PT daily (or say "brief" in the chat)
```

Measured 2026-10-25: alert reaches Telegram about 70 s after `POST /replay feb2022`
at speed 360 (alert at 30 s, trigger within 30 s, agent turn about 15 s).

## Setup (already done on the GB10)

```bash
nemoclaw ops policy add --from-file agent/policy/solar-storm-api.yaml --yes
backend/run.sh start 127.0.0.1,172.18.0.1
agent/install.sh --automations
```

Creating automations needs the `operator.admin` scope for the sandbox CLI. It was
granted once with `openclaw devices approve <requestId>` inside the sandbox.

## Handy

```bash
X="openshell sandbox exec -n ops --no-tty --"
$X openclaw automations list
$X openclaw automations runs --id <job-id>
$X openclaw automations run <job-id>          # e.g. send the morning brief now
$X openclaw agent --session-id test -m "how is the sun?"
```
