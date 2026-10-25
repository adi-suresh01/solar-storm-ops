# Solar Storm Ops

An always-on agent that watches the sun for satellite operators. It runs entirely on a Dell Pro Max GB10: local model, local data, alerts and approvals over Telegram.

Dell x NVIDIA AI Hackathon, Sun Oct 25 2026, Frontier Tower SF. Submissions close 18:00, top-8 demos 18:30.

## The pitch in one breath

On Feb 3 2022 SpaceX launched 49 Starlink satellites into a low 210 km orbit. A minor geomagnetic storm (Kp 5.33, NOAA G1) thickened the upper atmosphere, drag went up, and about 38 of them fell back and burned up. NOAA saw the storm coming. Nobody connected the space weather forecast to the launch plan in time.

Solar Storm Ops connects them. It watches NOAA space weather 24/7, checks it against the operator's constellation and launch schedule, and messages the ops lead on Telegram before the storm hits: "Kp 6 forecast in 18h. 47 satellites below 300 km. Recommend raising orbits for this group and holding launch L-12." The ops lead taps approve, the agent logs the plan and confirms.

Everything runs on one GB10. The operator's maneuver plans and orbit data are confidential and often export controlled (ITAR), so they cannot go to a cloud model.

## Verified facts we can say on stage

| Fact | Value | Source (checked 2026-10-25) |
|---|---|---|
| Starlink objects tracked today | 11,113 | CelesTrak GP data, GROUP=starlink |
| Starlink objects below 300 km now | 47 | computed from CelesTrak mean motion |
| Starlink objects below 400 km now | 945 | same |
| Median Starlink altitude | ~466 km | same |
| Feb 2022 storm peak | Kp 5.33 (Feb 3 09:00 UTC and Feb 4 15:00 UTC) | GFZ Potsdam Kp archive |
| May 2024 "Gannon" storm peak | Kp 9.0 | GFZ Potsdam Kp archive |
| Feb 2022 loss | 49 launched, ~38 reentered | SpaceX update, Feb 2022 (well known; cite on slide) |
| Space weather today | Kp 0.33, GOES X-ray B-class, NOAA scales R0/S0/G0 | NOAA SWPC |

Not verified, don't put on a slide as fact: the dollar cost of the Feb 2022 loss (often quoted as tens of millions), and market-size numbers.

We are not affiliated with SpaceX. We use public Starlink orbit data as the example constellation. The operator's launch schedule, runbook and maneuver budget in the demo are mock data, labeled as such.

## Judging criteria, and how we hit them

| Criterion | How |
|---|---|
| Technical execution | 125B MoE model (Qwen3.8-Flash-Next NVFP4) on the GB10 at ~37 tok/s; real NOAA and CelesTrak feeds; orbit math on 11k satellites; NemoClaw/OpenClaw/OpenShell agent with a sandbox policy |
| Business value | One storm cost one operator ~38 satellites. Every LEO operator, launch provider and insurer has this risk |
| Local-first design | Model, ops data, risk engine and agent all on the GB10. Only public feeds come in. Nothing private goes out |
| Demo quality | Live globe of the real constellation, a replayed storm, the phone buzzes on stage, approve, plan applied |

## Architecture

```
            public feeds (in only)
  NOAA SWPC ----+                  CelesTrak ----+
                v                                v
  +----------------------- GB10 host ---------------------------+
  |  watcher.py (every 5 min live, accelerated in replay)       |
  |    - pulls Kp observed + forecast, GOES X-ray, alerts,      |
  |      NOAA scales, solar wind                                |
  |    - pulls CelesTrak Starlink GP data (cache, max every 2h) |
  |    - computes altitude per satellite + risk table           |
  |    - writes state/*.json                                    |
  |                                                             |
  |  data API (GETs + POST /actions, /replay), :18310           |
  |  dashboard (globe + gauges + timeline), served by the API   |
  |  Qwen3.8 via vLLM, 127.0.0.1:18300 (running)                |
  |                                                             |
  |  +------------- OpenShell sandbox "ops" ----------------+   |
  |  |  OpenClaw agent                                      |   |
  |  |   - automation every 5 min: check.sh -> NO_REPLY or  |   |
  |  |     an alert summary                                 |   |
  |  |   - on alert: reads risk table + mock runbook +      |   |
  |  |     launch schedule, drafts the recommendation       |   |
  |  |   - Telegram: alert, approve, confirm, morning brief |   |
  |  +------------------------------------------------------+   |
  +-------------------------------------------------------------+
                                  |
                              Telegram (ops lead's phone)
```

### Data sources (all verified working from the venue)

- Kp observed: `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json`
- Kp 3-day forecast: `https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json`
- GOES X-ray flux (flares): `https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json`
- NOAA alerts: `https://services.swpc.noaa.gov/products/alerts.json`
- NOAA scales (R/S/G): `https://services.swpc.noaa.gov/products/noaa-scales.json`
- Solar wind: `https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json` and `/products/summary/solar-wind-speed.json` (the old `/products/solar-wind/*` paths return 404)
- Aurora oval: `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json`
- Starlink orbits: `https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json` (4.7 MB; CelesTrak rate-limits, so fetch at most every 2 hours and cache)
- Historical Kp for replays: `https://kp.gfz-potsdam.de/app/json/?start=2022-02-02T00:00:00Z&end=2022-02-06T00:00:00Z&index=Kp`

Venue wifi is slow (~400 KB/s). Cache every feed to disk by 14:00 so the demo works offline.

### Risk engine (keep it simple and honest)

- Altitude per satellite from mean motion: `a = (mu / n^2)^(1/3)`, `alt = a - 6378 km`. Use `sgp4` or `skyfield` for positions on the globe.
- Risk bands: below 250 km critical, 250 to 350 km high, 350 to 450 km watch, above 450 km fine.
- Storm factor from Kp forecast: Kp 5 (G1) and up raises the bands one level, Kp 7 (G3) and up two levels.
- The recommendation template: which group, how many satellites, what action (raise orbit, hold launch, safe mode), and by when.
- On stage, call the decay numbers "illustrative". It is a simple drag model, not a physics-grade one.

### Replay mode

- Feb 2022: the real Kp sequence from GFZ, plus a simulated batch of 49 satellites at 210 km (labeled simulated, since historical orbit data needs a Space-Track account).
- May 2024: real Kp up to 9.0 against today's real constellation, to show scale.
- Time is accelerated, e.g. 1 hour of storm = 10 seconds.

### Agent wiring (from the NemoClaw docs research)

- Custom skills currently don't load (NemoClaw issue #12670). Put the agent's instructions in the workspace `AGENTS.md` and have it call our scripts with `exec`.
- Always-on: an OpenClaw automation every 5 min runs `check.sh`. If all is calm the script prints `NO_REPLY` and nothing is sent to Telegram.
- Approvals from automation runs never reach chat, so the alert asks the human to reply "approve". That reply starts a normal chat turn, and the agent then POSTs the plan to `/actions`.
- The sandbox reaches the host only through an OpenShell network policy preset on a non-loopback host IP (`nemoclaw ops policy add --from-file ... --trusted-private-host <ip>`). Confirm the IP after install.
- Morning brief: a daily automation at 07:00.

## Team roles

Two people. Full task list with times in `TASKS.md`.

| Who | Owns |
|---|---|
| Adi | `backend/` + `agent/`: model server (done), NemoClaw + Telegram, feeds, risk engine, replay, data API, approve loop |
| Teammate | `dashboard/` + `ops-data/` + `pitch/`: 3D globe, gauges, timeline, replay controls, mock operator data, slides, backup video |

## Timeline

| Time | Milestone |
|---|---|
| 12:15 to 13:00 | NemoClaw installed, Telegram says hello. watcher.py pulls all feeds. Globe shows the 11k satellites |
| 13:00 | Lunch, eaten while building |
| 13:00 to 15:00 | Risk table, check.sh + automation, first real Telegram alert from replay data |
| 15:00 to 16:30 | Approve -> /actions -> dashboard update -> confirmation. Morning brief. Polish the globe |
| 16:30 to 17:15 | Two full rehearsals, record a backup video |
| 17:15 to 17:45 | Submission write-up, slides |
| 18:00 | Submit |

Rule: nothing waits on the network live. Cache feeds, pre-render the replay, keep the backup video ready.

## Demo script (about 3 minutes)

1. 0:00 Hook: "In February 2022 SpaceX lost 38 brand-new satellites to a storm NOAA saw coming."
2. 0:20 Live: the globe with 11,113 real Starlink satellites, today's sun calm (Kp 0.3). The agent has run all day and stayed quiet: no spam when nothing is wrong.
3. 0:50 "Now replay Feb 3 2022." Kp climbs on the gauge, the agent flags the low batch, and the phone buzzes on stage. Read the Telegram message out loud.
4. 1:40 Tap approve. The plan is logged, the globe marks the batch as protected, and the agent confirms on Telegram.
5. 2:10 Local-first: a 125B model on the GB10 at 37 tok/s. The ops data never left the box, and that matters for ITAR.
6. 2:40 Business: every LEO operator, launch provider and insurer carries this risk. Close on one line.

## Risks and fallbacks

| Risk | Fallback |
|---|---|
| Slow venue wifi | Phone hotspot; cache all feeds early |
| NemoClaw skill bug | AGENTS.md + exec scripts |
| Automation flags behave differently than documented | Host-side cron that calls the data API and triggers the agent through the Telegram chat |
| Sandbox can't reach the host API | Fix the policy preset; worst case, serve the data from a file mounted at onboarding (`--host-mount`) |
| Model server crash | `./flash start` restores it in ~3.5 min; the backup video covers the demo |
| Memory | Qwen3.8 runs at GPU_MEM=0.72 (KV pool 288,623 tokens), which leaves headroom for the sandbox and dashboard |

## Setup status (as of ~12:15)

- GB10 reachable from the Mac over the Ethernet cable: `ssh gb10` (dell@169.254.10.2).
- Qwen3.8-Flash-Next NVFP4 is serving on `127.0.0.1:18300`, model id `qwen3.8-flash-next`, 131k context. Smoke test: 37 tok/s decode, 2,016 tok/s prefill, tool calling on (`qwen3_coder` parser).
- NemoClaw is installing (sandbox name `ops`, custom endpoint, Telegram).
- Qwen3.6-35B-A3B NVFP4 is also on disk as a backup model.

## Handy commands

```bash
ssh gb10                                           # from the Mac
cd ~/dell-hackathon/qwen3.8-Flash-DGX
./flash status | ./flash logs | ./flash test       # model server
nemoclaw ops status | nemoclaw ops logs --follow   # agent sandbox
openshell term                                     # approve or deny blocked network requests
```
