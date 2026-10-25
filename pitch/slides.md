# Solar Storm Ops — five-slide pitch

## Slide 1 — A storm can change the orbit

**Headline:** Space weather is an operations risk.

- In February 2022, SpaceX launched 49 Starlink satellites into a low orbit during a geomagnetic storm; about 38 reentered.
- NOAA observed the storm. The operational challenge is connecting a changing space-weather outlook to asset and launch context in time.
- LEO operators need a clear, actionable picture—not another disconnected alert.

**Visual:** Earth horizon + one timeline: launch → storm → atmospheric drag → reentry.

**Source note:** SpaceX update (Feb. 2022); GFZ Potsdam Kp archive; NOAA SWPC. The specific causal phrasing should be checked against the cited SpaceX account before presenting. Do not claim an alert would certainly have prevented losses.

## Slide 2 — See the risk, review a plan

**Headline:** From public feed to human decision in one screen.

- Globe view of public Starlink general-perturbations data; satellite locations are computed for the demo.
- Live conditions: Kp, forecast trend, X-ray class, NOAA R/S/G scales, solar-wind speed.
- Risk bands, a contextual recommendation, and an auditable event timeline.
- Replay Feb. 2022 or May 2024 to make the operational workflow visible.

**Visual:** Dashboard screenshot. Label the L-12 group **SIMULATED** and the schedule **MOCK**.

## Slide 3 — A local watch loop

**Headline:** Observe → assess → recommend → human approval.

1. Watch NOAA space-weather feeds and cached CelesTrak orbit data.
2. Compute a simple altitude-based risk picture across the tracked constellation.
3. A local agent consults operator context and drafts a recommendation.
4. The ops lead approves or rejects; the decision is logged and confirmed.

**Visual:** Feeds → local watcher/risk engine → local model/agent → operator on Telegram → event log.

**Caveat:** This is decision support, not autonomous spacecraft control. Risk bands and replay are illustrative; operators validate all actions.

## Slide 4 — Local-first for sensitive operations

**Headline:** Public data in. Sensitive plans stay on the box.

- The demo runs on a Dell Pro Max GB10 with a local model and local data/API.
- Public space-weather and orbit feeds are fetched in; mock operator schedule and maneuver examples remain local.
- Human approvals, event history, and plans are not sent to a hosted model.
- Local-first deployment can support organizations with strict data-handling constraints; it is not a certification or compliance claim.

**Visual:** GB10 boundary with NOAA/CelesTrak arrows inward; operator approval stays within the local workflow.

## Slide 5 — Earlier context for a growing orbital economy

**Headline:** Turn a forecast into an operations conversation.

- Potential users: satellite operators, launch providers, and insurers.
- Value proposition: bring space-weather outlook, asset exposure, and operator context together before a decision window closes.
- Next steps: validate the drag/risk model with mission experts, integrate authenticated operator data, and test with a real operations team.

**Closing line:** “The sun is outside your control. The response window is not.”

**Do not add unverified TAM, cost-savings, or loss-prevention numbers.**