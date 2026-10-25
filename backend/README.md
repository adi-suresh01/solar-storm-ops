# backend

One process: `api.py` serves the API in `docs/api.md` and runs the watcher loop
(NOAA every 5 min, Starlink positions every 30 s, CelesTrak at most every 2 h).
Stdlib plus `sgp4`. Every feed falls back to the cache in `state/`, then `fixtures/`.

| File | What |
|---|---|
| `api.py` | HTTP server + engine (risk picture, timeline, plans, approvals) |
| `watcher.py` | NOAA / CelesTrak fetches, sgp4 positions, risk bands, plan template |
| `replay.py` | Feb 2022 and May 2024 replays on an accelerated clock |
| `smoke_test.py` | Checks every endpoint against `fixtures/`, runs a replay and an approval |
| `run.sh` | `start [bind-list]`, `stop`, `status`, `log` on the GB10 |

## Run it on any laptop (no GB10 needed)

```bash
pip install sgp4                          # optional; without it the globe uses fixture positions
SSO_OFFLINE=1 python3 backend/api.py      # http://127.0.0.1:18310, no network calls
python3 backend/smoke_test.py             # optional self-check
```

## Notes for the dashboard

Shapes match `fixtures/`. Differences and additions:

- All times end in `Z` (UTC). NOAA's raw times had no zone.
- During a replay there is no historical X-ray or solar wind data, so
  `xray.flux` is `null`, `xray.class` is `"n/a"`, `scales.R` and `scales.S` are `"n/a"`,
  `solar_wind_kms` is `null`. `scales.G` is computed from Kp.
- `/state.note`: a label to show on screen (says LIVE, or REPLAY + what is SIMULATED).
- `/state.l1_monitors`: live solar wind per spacecraft at L1, from NOAA's real-time feed:
  `[{source, label, active, time, speed_kms, density_cc, bz_nt, bt_nt}]`. Labels include
  `NASA ACE` and `NASA IMAP`; `active` is NOAA's operational source. Empty during replays.
- `/state.imf_bz_nt`: Bz of the active monitor (negative = southward, storms start there). `null` in replays.
- `/state.cme`: Earth-directed CMEs from NASA DONKI `[{id, start, speed_kms, earth_arrival,
  kp_estimate_max, source}]`. NASA's DONKI service is down today, so this is `[]` unless
  it comes back (the API retries every 20 min and caches it).
- `/state.replay`: `{title, speed, start, end, done}` during a replay.
- `/state.launch`: the SIMULATED launch L-12 in the Feb 2022 replay, `null` otherwise:
  `{id: "L-12", time, site: {lat, lon, name}, sats: 49, target_km: 210, status, simulated: true}`.
  `status` is `scheduled`, then `held` (a hold plan was approved before liftoff) or
  `launched` (liftoff time came without an approved hold). Site is a Florida launch site
  (28.608, -80.604), labeled SIMULATED.
- `/risk.recommendation.kind`: `hold` (hold a scheduled launch) or `protect` (satellites in orbit).
- `/risk.recommendation.status`: `pending` | `approved` | `rejected` | `expired` (a hold plan
  nobody decided on before liftoff; a `protect` plan replaces it after launch).
- `/risk.groups[]`: while L-12 is still scheduled, the first group is the launch, with `"launch": true`.
- `/positions`: the 49 L-12 satellites (ids 990001-990049) appear only after a liftoff that
  was not held. They have `"simulated": true` and `"protected": false|true` (true after the
  ops lead approves the raise-orbit plan). Positions are always for the current wall-clock
  time, also during a replay.
- Timeline text can include a free-text note from the agent. Render it as text, not HTML.

## Replay timing

The Feb 2022 replay is a launch go/no-go. In the real event a G1 storm was under way on
the morning of 3 Feb 2022, another was forecast, and 49 Starlink satellites launched at
18:13 UTC into a ~210 km orbit; about 38 reentered. Our L-12 is the SIMULATED stand-in.

`POST /replay {"scenario": "feb2022", "speed": 720}` (1 storm hour = 5 s, the demo speed):

- 0 s: sim 2 Feb 09:00 UTC, level `watch`, launch L-12 `scheduled` for 3 Feb 18:13
- 15 s: sim 2 Feb 12:00, level `warning` (Kp 5.0 forecast within 18 h), hold plan
  `rec-NNN` (kind `hold`) created; the agent picks it up within 30 s and Telegram gets it
  about 35 to 65 s after start
- 105 s: sim 3 Feb 06:00, Kp 5.0 now, level `critical`. If the plan is still pending,
  the agent sends a second (CRITICAL) alert. Approve before this to avoid it.
- 166 s: sim 3 Feb 18:13, liftoff time
  - hold approved: "L-12 stays on the ground (launch held). In the real event, 49
    satellites launched at this time and about 38 reentered within days."
  - not approved: the hold plan expires, L-12 launches (49 SIMULATED satellites appear),
    and at 180 s (sim 3 Feb 21:00, `warning`) a raise-orbit plan (kind `protect`) follows
- 5 min 15 s: sim 5 Feb 00:00, replay ends and holds

At speed 360 every time above doubles.

`may2024` starts 2024-05-09 18:00 UTC and goes `critical` (Kp 7.7 forecast) 30 s in.
`{"scenario": "live"}` goes back to live data.

## Agent routes (not used by the dashboard)

- `GET /check`: `NO_REPLY`, or the alert text once per plan and level. `?peek=1` doesn't mark it sent.
- `GET /brief`: morning brief text.
- `GET /health`.
- `GET /ops-data/<file>`: the MOCK operator files, so the sandboxed agent can read them.
