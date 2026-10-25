"""Replay of past storms with real Kp (GFZ Potsdam archive) on an accelerated clock.

We have no archived NOAA forecasts, so during a replay the "forecast" is the
archived Kp that actually followed. The API labels this as SIMULATED.
"""
import time
from datetime import timedelta

from watcher import L12_COUNT, iso, load_json, utc

SCENARIOS = {
    "feb2022": {
        "title": "Feb 2022 storm replay",
        "start": "2022-02-03T18:00:00Z",
        "end": "2022-02-05T00:00:00Z",
        # Starlink Group 4-7 lifted off 2022-02-03 18:13 UTC. Our batch L-12 is a
        # SIMULATED stand-in for it (historical orbits need a Space-Track account).
        "launch": "2022-02-03T18:13:00Z",
        "note": "REPLAY: real Kp from the GFZ archive. Forecast is SIMULATED (archived Kp that"
                " followed). Launch batch L-12 is SIMULATED. X-ray and solar wind not replayed.",
    },
    "may2024": {
        "title": "May 2024 storm replay",
        "start": "2024-05-09T18:00:00Z",
        "end": "2024-05-12T12:00:00Z",
        "launch": None,
        "note": "REPLAY: real Kp from the GFZ archive against today's real constellation."
                " Forecast is SIMULATED (archived Kp that followed). X-ray and solar wind not replayed.",
    },
}

HISTORY_BINS = 16  # 48 h of 3-hourly Kp
FORECAST_BINS = 24  # 72 h


class Replay:
    def __init__(self, scenario, speed=360.0, start=None):
        sc = SCENARIOS[scenario]
        self.scenario = scenario
        self.title = sc["title"]
        self.note = sc["note"]
        self.speed = float(speed)
        self.start = utc(start) if start else utc(sc["start"])
        self.end = utc(sc["end"])
        self.launch = utc(sc["launch"]) if sc["launch"] else None
        kp = load_json("replay_kp.json")[scenario]
        self.kp = [(utc(p["time"]), float(p["kp"])) for p in kp]
        # NASA DONKI CMEs for this window, if we ever managed to cache them
        self.cmes = load_json(f"donki_{scenario}.json") or []
        self.t0 = time.time()
        # Things that happen on the sim clock, in order: each 3-hourly Kp bin,
        # the launch, and CME departures. The engine logs each one when due.
        ev = [(t, "kp", None) for t, _ in self.kp if self.start <= t <= self.end]
        if self.launch and self.start <= self.launch <= self.end:
            ev.append((self.launch, "launch", None))
        ev += [(utc(c["start"]), "cme", c) for c in self.cmes
               if self.start < utc(c["start"]) <= self.end]
        ev.append((self.end, "end", None))
        order = {"kp": 0, "cme": 1, "launch": 2, "end": 3}
        self.events = sorted(ev, key=lambda e: (e[0], order[e[1]]))
        self.next_event = 0

    def now(self):
        sim = self.start + timedelta(seconds=(time.time() - self.t0) * self.speed)
        return min(sim, self.end)

    def done(self):
        return self.next_event >= len(self.events)

    def due_events(self):
        """Events whose sim time has passed since the last call."""
        t = self.now()
        out = []
        while self.next_event < len(self.events) and self.events[self.next_event][0] <= t:
            out.append(self.events[self.next_event])
            self.next_event += 1
        return out

    def launched(self, when):
        return self.launch is not None and when >= self.launch

    def kp_at(self, when):
        """Kp of the 3-hour bin that contains `when`."""
        k = self.kp[0][1]
        for t, v in self.kp:
            if t <= when:
                k = v
        return k

    def history(self, when):
        past = [(t, k) for t, k in self.kp if t <= when][-HISTORY_BINS:]
        return [{"time": iso(t), "kp": k} for t, k in past]

    def forecast(self, when):
        nxt = [(t, k) for t, k in self.kp if t > when][:FORECAST_BINS]
        return [{"time": iso(t), "kp": k} for t, k in nxt]

    def cmes_before_start(self):
        """CMEs already on their way when the replay starts (shown as context)."""
        return [c for c in self.cmes if utc(c["start"]) <= self.start
                and utc(c["earth_arrival"]) >= self.start - timedelta(days=1)]

    def batch_size(self, when):
        return L12_COUNT if self.launched(when) else 0
