# Three-minute demo script

## 0:00–0:20 — Hook

“In February 2022, 49 Starlink satellites launched into a low orbit; about 38 reentered after a geomagnetic storm. Public space-weather data existed—but operators need that signal connected to their own assets and decisions. Solar Storm Ops is a local-first watch desk for that workflow.”

## 0:20–0:50 — Live picture

“Here is the public constellation view and current space weather. The globe is built from cached orbit data; the gauges show Kp, forecast, X-ray class, NOAA scales, and solar wind. The agent stays quiet when conditions are calm.”

## 0:50–1:30 — Replay

“Let’s replay February 2022. The Kp curve and risk context change. This 49-satellite L-12 batch is simulated, and the launch/operator schedule is mock data. The local agent turns the picture into a recommendation for human review.”

If Telegram is unavailable, show the pre-captured alert and say so; do not imply a live message was sent.

## 1:30–2:00 — Human approval

“The ops lead can approve or reject. I’ll approve this demo plan. The event appears in the timeline; this is an audit record only. It does not issue a spacecraft command.”

## 2:00–2:35 — Local-first

“The watcher, risk engine, model, and operator context run on the GB10. Public feeds come in; private operator data stays local. The example maneuver figures are illustrative, not flight-planning values.”

## 2:35–3:00 — Close

“This prototype makes space-weather context easier to review alongside an operator’s own data. The next step is validation with flight-dynamics experts and a real operator. The sun is outside your control. The response window is not.”

## Rehearsal checklist

- Start the dashboard and backend; confirm the fixture view works without external network access.
- Check that the globe, current weather, replay controls, event timeline, and mock labels are visible.
- If doing the live API path, confirm the tunnel and API before starting the talk.
- If Telegram is part of the demo, verify the bot and avoid putting secrets on screen.
- Record a backup locally during rehearsal; test playback with Wi-Fi disconnected.
- If a live component fails, state that it is a fallback and continue with the local fixture/replay path.
