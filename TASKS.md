# Task split (2 people)

The split is by folder so we never edit the same files:

- **Adi:** `backend/`, `agent/`. Everything on the GB10: feeds, risk engine, replay, API, NemoClaw/OpenClaw agent, Telegram.
- **Teammate:** `dashboard/`, `ops-data/`, `pitch/`. What the judges see: globe, gauges, alert timeline, mock operator data, slides, backup video.

The contract between us is `docs/api.md` plus the sample files in `fixtures/`. The dashboard can be built entirely against fixtures before the API exists. Switching to the live API is one URL parameter.

## Adi: backend + agent

| # | Task | Done by |
|---|---|---|
| A1 | Finish NemoClaw onboarding (sandbox `ops`, custom endpoint -> Qwen3.8, Telegram). Bot says hello | 12:45 |
| A2 | `backend/watcher.py`: poll NOAA every 5 min, CelesTrak at most every 2 h (cached to disk), compute positions + risk bands -> `state/*.json` | 13:30 |
| A3 | `backend/api.py` on :18310: GET `/state` `/positions` `/risk` `/timeline`, POST `/actions` `/replay`, and serve `dashboard/` as static files | 13:45 |
| A4 | Replay engine: `feb2022` (real Kp + simulated 49-sat batch at ~210 km) and `may2024` (real Kp 9 against today's constellation), accelerated time | 14:30 |
| A5 | `agent/`: AGENTS.md instructions, `check.sh` (prints NO_REPLY when calm), OpenShell policy preset for :18310, automation every 5 min | 15:00 |
| A6 | Approve loop: Telegram alert -> human replies "approve" -> agent POSTs `/actions` -> timeline updates -> agent confirms | 15:45 |
| A7 | Morning brief automation (07:00 daily, plus a "send brief now" trigger for the demo) | 16:15 |

## Teammate: dashboard + story

| # | Task | Done by |
|---|---|---|
| B1 | `dashboard/index.html`: 3D globe with globe.gl, plotting `positions.json` (lat, lon, alt_km). Vendor three.js, globe.gl and the Earth texture into `dashboard/vendor/` (venue wifi is slow) | 13:15 |
| B2 | Color points by `risk` (critical red, high orange, watch yellow, fine dim blue). Legend with counts from `risk.json` `bands`. Hover tooltip: name + altitude | 13:45 |
| B3 | Side panel from `state.json`: Kp gauge (now) + forecast sparkline, X-ray class, NOAA R/S/G scales, solar wind speed | 14:15 |
| B4 | `ops-data/`: mock operator data the agent reasons over. `launch_schedule.json` (next 3 launches, one is "L-12" with 49 sats), `runbook.md` (what to do at each storm level), `maneuver_budget.json` (fuel/delta-v per group). Label everything MOCK | 14:30 |
| B5 | Alert banner + timeline panel from `/timeline`. Replay buttons (Live / Feb 2022 / May 2024) that POST `/replay` | 15:15 |
| B6 | Switch to live data: poll the API every 2 s when `?api=http://localhost:18310` is set; fall back to `../fixtures/` otherwise | 15:30 |
| B7 | `pitch/`: 5 slides (problem, demo, how it works, local-first, business), submission write-up | 16:30 |
| B8 | Record the backup demo video during the 16:30 rehearsal | 17:00 |

## Sync points (both of us)

| Time | Check |
|---|---|
| 13:45 | Dashboard reads the live API from the GB10 (through `ssh -L 18310:127.0.0.1:18310 gb10`) |
| 15:00 | First end-to-end replay: storm climbs, Telegram alert arrives, timeline shows it |
| 16:30 | Full rehearsal #1, record backup video |
| 17:15 | Rehearsal #2, freeze code |
| 17:45 | Submit (deadline 18:00) |

## Rules

- Work in your own folders, commit small, push often to `main`. Pull before you push.
- Never commit secrets. The Telegram token stays in Apple Passwords and the GB10 terminal only.
- Anything made up (ops data, the simulated launch batch, decay numbers) is labeled MOCK or SIMULATED, in the UI too.
- Nothing in the demo waits on the network live. Cache feeds, vendor JS libraries, keep the backup video ready.
