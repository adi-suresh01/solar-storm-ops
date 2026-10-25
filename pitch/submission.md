# Solar Storm Ops

## One-line description

A local-first space-weather operations assistant that connects public solar activity and satellite-orbit data to a human-reviewed operational picture.

## The problem

Geomagnetic storms heat and expand the upper atmosphere, increasing drag on low-Earth-orbit spacecraft. Satellite teams monitor space weather, spacecraft, and launch plans through separate systems. When a storm outlook changes, operators need to understand which assets and decisions may be exposed while there is still time to review options.

The February 2022 Starlink launch is a vivid example: 49 satellites were launched into a low orbit and about 38 reentered following a geomagnetic storm. We use the event to motivate earlier operational context; we do not claim a warning would certainly have prevented the losses.

## What we built

Solar Storm Ops brings NOAA space-weather feeds, cached CelesTrak Starlink orbit data, a simple altitude-based risk assessment, and operator context into one dashboard. An always-on local agent can summarize changing conditions, prepare a recommendation, and notify an ops lead over Telegram. A human approves or rejects; the decision is recorded in an event timeline.

A 3D globe visualizes satellite positions and risk bands. Kp, X-ray class, NOAA R/S/G scales, solar-wind speed, a forecast sparkline, the current recommendation, and the event log make the assessment inspectable. Replay controls demonstrate the February 2022 and May 2024 historical scenarios.

## How it works

1. The watcher retrieves public NOAA SWPC space-weather products and cached CelesTrak GP elements.
2. The backend estimates altitude and positions, assigns simple risk bands, and serves state through a local API.
3. The local agent reasons over that state and explicitly labeled mock operator files, then drafts a recommendation.
4. The ops lead reviews the alert in Telegram and approves or rejects. The dashboard shows the resulting timeline event.

All operation is decision support. The system does not send commands to spacecraft.

## Local-first design

The demo is designed to run on a Dell Pro Max GB10. The model, watcher, API, and operator data stay on the machine; only public feeds are fetched from the internet. This architecture is intended for workflows where maneuver plans and other operational data are sensitive. It is not a compliance certification or a claim that the prototype is production-ready.

## Demonstration and limitations

The dashboard defaults to local fixture data and can switch to the API with a URL parameter. It includes a mock launch schedule and illustrative maneuver-budget examples. The February 2022 L-12 launch batch is simulated. The risk engine uses simplified altitude bands and storm factors, not a validated physics-grade drag or mission-risk model. May 2024 replay applies an illustrative stress scenario to today's constellation. Every mock value is labeled; none should be used for real-world operations.

## Who could benefit

Satellite operators, launch providers, and insurers may benefit from a shared view of space-weather outlook and orbital exposure. The next step is to validate the model with qualified flight-dynamics and space-weather experts, then test a workflow with an operator using their own approved data and procedures.

## Sources

- NOAA Space Weather Prediction Center: public Kp, GOES X-ray, alerts, scales, and solar-wind products.
- CelesTrak: public Starlink GP elements, cached for the demonstration.
- GFZ German Research Centre for Geosciences: historical Kp index data for replay.
- SpaceX public February 2022 update concerning the Starlink launch and reentry event.

## Team

Built at the Dell × NVIDIA AI Hackathon, October 25, 2026. Backend and agent: Adi. Dashboard, mock operator context, and pitch: teammate.
