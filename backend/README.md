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
- `/risk.recommendation.status`: `pending` | `approved` | `rejected`.
- `/positions`: the 49 L-12 satellites (ids 990001-990049) have `"simulated": true` and
  `"protected": false|true` (true after the ops lead approves). Positions are always for
  the current wall-clock time, also during a replay.
- Timeline text can include a free-text note from the agent. Render it as text, not HTML.

## Replay timing

`POST /replay {"scenario": "feb2022", "speed": 360}` (1 storm hour = 10 s):

- 0 s: sim 2022-02-03 18:00 UTC, level `watch`
- 2 s: L-12 launch (SIMULATED batch of 49 at ~210 km)
- 30 s: sim 21:00, level `warning`, plan `rec-NNN` created, `/check` hands the alert to the agent
- 3.5 min: sim 2022-02-04 15:00, Kp 5.3, level `critical`
- 5 min: sim 2022-02-05 00:00, replay ends and holds

`may2024` starts 2024-05-09 18:00 UTC and goes `critical` (Kp 7.7 forecast) 30 s in.
`{"scenario": "live"}` goes back to live data.

## Agent routes (not used by the dashboard)

- `GET /check`: `NO_REPLY`, or the alert text once per plan and level. `?peek=1` doesn't mark it sent.
- `GET /brief`: morning brief text.
- `GET /health`.
- `GET /ops-data/<file>`: the MOCK operator files, so the sandboxed agent can read them.
