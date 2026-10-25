# MOCK OPERATOR RUNBOOK — DEMONSTRATION ONLY

**Status:** Fictional example for the Solar Storm Ops demo. This is not an approved flight procedure, is not affiliated with SpaceX or any launch provider, and must not be used for real spacecraft operations. All response decisions belong to qualified operators using their own validated procedures.

## Example severity workflow

| Demo level | Example trigger | Example operator review prompt |
|---|---|---|
| Clear | No elevated storm outlook | Continue routine monitoring; no action is proposed. |
| Watch | Elevated forecast, below storm threshold | Review the forecast and upcoming launch windows; confirm data freshness. |
| Warning | Forecast reaches the configured storm threshold | Convene the responsible flight-dynamics operator; review vulnerable altitude groups and the mock launch schedule. Prepare options for human review. |
| Critical | Severe geomagnetic conditions or high modeled exposure | Escalate to the designated operations lead; validate all inputs and independently assess maneuver, attitude, and launch options. Follow only approved real-world procedures. |

## Demo approval flow

1. The watcher reports conditions and modeled risk; the local agent drafts a recommendation.
2. An authorized human reviews the recommendation and its assumptions.
3. Approval records an auditable decision in the demo timeline. It does **not** send a spacecraft command.
4. Operators re-check conditions and consult the authoritative runbook before any real action.

## Modeling caveats

Risk bands are simple altitude categories. Storm multipliers are illustrative, and historical replay is not a forecast. The February 2022 L-12 batch is simulated. Mock launch data and all modeled outcomes must remain labeled **MOCK** or **SIMULATED** in presentations and UI.
