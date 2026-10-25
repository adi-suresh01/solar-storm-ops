# Data API contract

Base URL on the GB10: `http://127.0.0.1:18310`. From a laptop, tunnel it first:

```bash
ssh -L 18310:127.0.0.1:18310 gb10     # then open http://localhost:18310
```

Every GET endpoint has a matching sample file in `fixtures/` with the same shape (`/state` -> `fixtures/state.json`). Build against the fixtures first.

The `fixtures/*.json` files without a suffix are real data captured 2026-10-25 19:27 UTC. The `*_alert.json` files are hand-made examples of a storm alert, so the alert UI can be built before replay works.

## GET /state

Space weather right now (or at the replay's simulated time).

```json
{
  "mode": "live",                      // "live" | "feb2022" | "may2024"
  "sim_time": "2026-10-25T19:27:10Z",
  "kp_now": 0.33,
  "kp_history": [{"time": "2026-10-25T15:00:00", "kp": 0.33}],
  "kp_forecast": [{"time": "2026-10-28T00:00:00", "kp": 1.33}],
  "xray": {"flux": 2.9e-07, "class": "B2.9"},
  "scales": {"R": "0", "S": "0", "G": "0"},
  "solar_wind_kms": 341,
  "alert": {"level": "none", "summary": "All quiet. No action needed."}
}
```

`alert.level`: `none` | `watch` | `warning` | `critical`.

## GET /positions

One point per satellite. Lat and lon are in degrees, and `alt_km` is the mean altitude. About 11,100 entries, roughly 1.2 MB, so poll it every 10 s at most.

```json
{
  "time": "2026-10-25T19:27:10Z",
  "count": 11112,
  "sats": [{"id": 44714, "name": "STARLINK-1008", "lat": 12.3, "lon": -45.6, "alt_km": 546.2, "risk": "fine"}]
}
```

`risk`: `critical` (below 250 km) | `high` (250 to 350) | `watch` (350 to 450) | `fine`. A storm raises satellites by one or two bands.

## GET /risk

```json
{
  "time": "2026-10-25T19:27:10Z",
  "storm_factor": 0,                   // 0 calm, 1 for Kp >= 5, 2 for Kp >= 7
  "bands": {"critical": 12, "high": 151, "watch": 1045, "fine": 9904},
  "groups": [],                        // populated during a storm, see risk_alert.json
  "recommendation": null               // populated during a storm
}
```

## GET /timeline

Newest last.

```json
[{"time": "2022-02-03T21:00:00Z", "kind": "alert", "text": "Kp 5.3 expected ..."}]
```

`kind`: `info` | `alert` | `approval` | `action`.

## POST /replay

```json
{"scenario": "feb2022", "speed": 360}   // scenario: "live" | "feb2022" | "may2024"; speed = sim seconds per real second
```

## POST /actions

Called by the agent after the human approves on Telegram.

```json
{"recommendation_id": "rec-001", "decision": "approved", "by": "telegram:<user>", "note": "raise orbit for batch L-12"}
```

Appends an `approval` and an `action` entry to `/timeline`.
