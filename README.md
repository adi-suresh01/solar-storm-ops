# Solar Storm Ops

An always-on agent that watches the sun for satellite operators. It runs entirely on a Dell Pro Max GB10: a local 125B model, local data, and alerts and approvals over Telegram.

Built at the Dell x NVIDIA AI Hackathon, Oct 25 2026.

- `PLAN.md`: pitch, verified facts, architecture, demo script, risks
- `TASKS.md`: who does what, with times and sync points
- `docs/api.md`: the data contract between backend and dashboard
- `fixtures/`: real sample data (11,112 Starlink satellites, NOAA space weather, Kp history for the Feb 2022 and May 2024 storms) plus hand-made alert examples

## Layout

```
backend/     feeds, risk engine, replay, data API (:18310)   - Adi
agent/       OpenClaw instructions, check script, policy     - Adi
dashboard/   globe + gauges + timeline (static HTML/JS)      - teammate
ops-data/    MOCK operator data the agent reasons over       - teammate
pitch/       slides, write-up                                - teammate
fixtures/    sample data for every API endpoint
```

## Run the dashboard against fixtures

```bash
python3 -m http.server 8000      # from the repo root
open http://localhost:8000/dashboard/
```

## Notes

- Public data only: NOAA SWPC, CelesTrak, GFZ Potsdam. We are not affiliated with SpaceX.
- Operator data and the simulated launch batch are mock data and labeled as such.
- CelesTrak returns 403 if the same data is fetched twice within 2 hours. Use the cached `fixtures/starlink_gp.json` while developing.
