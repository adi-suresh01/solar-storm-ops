"""Solar Storm Ops data API and always-on watcher, in one process.

    python3 backend/api.py [--bind 127.0.0.1,<bridge-ip>] [--port 18310]

Contract: docs/api.md. Extra routes for the agent: GET /check, GET /brief,
GET /health, and static files under /dashboard/, /fixtures/, /ops-data/.
Set SSO_OFFLINE=1 to run from cached files with no network at all.
"""
import argparse
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from replay import SCENARIOS, Replay  # noqa: E402
from watcher import (BANDS, LOW_KM, OFFLINE, ROOT, STATE_DIR, Constellation, assess,  # noqa: E402
                     build_recommendation, cme_line, cmes_known, g_scale,
                     initial_weather, iso, l12_positions, load_gp, load_json, log,
                     maybe_fetch_donki, maybe_refresh_gp, now_utc, refresh_weather,
                     shift)

NOAA_EVERY_S = 300
PROPAGATE_EVERY_S = 30
GP_CHECK_EVERY_S = 600
LEVELS = ["none", "watch", "warning", "critical"]
STATIC_DIRS = ("dashboard", "fixtures", "ops-data")


class Run:
    """One live session or one replay. Owns its own timeline and plan."""

    def __init__(self, mode, replay=None):
        self.mode = mode
        self.replay = replay
        self.timeline = []
        self.rec = None
        self.notified = set()
        self.level = "none"
        self.protected = False
        self.a = None  # latest risk assessment


class Engine:
    def __init__(self):
        self.lock = threading.RLock()
        self.weather = initial_weather()
        self.const = Constellation(load_gp())
        self.last_noaa = 0.0
        self.last_donki = 0.0
        self.live_cmes = load_json("donki_live.json", (STATE_DIR,)) or []
        self.last_gp = time.time()
        self.last_prop = 0.0
        self.pos_key = None
        self.pos_bytes = b"{}"
        self._propagate()
        self.live = Run("live")
        self.run = self.live
        with self.lock:
            self._log(self.live, now_utc(), "info",
                      f"Agent started. Watching NOAA space weather and {len(self.real):,}"
                      " Starlink satellites.")
            self._step()
            self._render_positions()

    # ------------------------------------------------------------ background

    def start(self):
        # Two threads: network fetches can hang for minutes and must never
        # stall the replay clock or the API.
        threading.Thread(target=self._forever, args=(self.fetch, 5), daemon=True,
                         name="fetch").start()
        threading.Thread(target=self._forever, args=(self.tick, 1), daemon=True,
                         name="tick").start()

    def _forever(self, fn, every):
        while True:
            try:
                fn()
            except Exception:
                log(f"{fn.__name__} failed:\n" + traceback.format_exc())
            time.sleep(every)

    def fetch(self):
        """Network side: NOAA, NASA DONKI, CelesTrak. Slow is fine here."""
        t = time.time()
        if not OFFLINE and t - self.last_noaa >= NOAA_EVERY_S:
            self.last_noaa = t
            w, ok = refresh_weather(self.weather)
            log(f"noaa refreshed: {','.join(ok) or 'nothing'} kp_now={w.get('kp_now')}")
            with self.lock:
                self.weather = w
        if t - self.last_donki >= 60:  # maybe_fetch_donki throttles itself to 20 min
            self.last_donki = t
            if any(g.startswith("live") for g in maybe_fetch_donki()):
                cmes = load_json("donki_live.json", (STATE_DIR,)) or []
                with self.lock:
                    self.live_cmes = cmes
        if t - self.last_gp >= GP_CHECK_EVERY_S:
            self.last_gp = t
            if maybe_refresh_gp():
                self.const = Constellation(load_gp())
                self.last_prop = 0.0

    def tick(self):
        """Local side: positions, replay clock, risk picture. Never touches the network."""
        t = time.time()
        if t - self.last_prop >= PROPAGATE_EVERY_S:
            self.last_prop = t
            self._propagate()
        with self.lock:
            self._step()
            self._render_positions()

    def _propagate(self):
        when = now_utc()
        pos = self.const.positions(when)
        counts = {b: 0 for b in BANDS}
        for s in pos:
            counts[s["band"]] += 1
        low = [s["alt_km"] for s in pos if s["alt_km"] < LOW_KM]
        with self.lock:
            self.real, self.real_time, self.base_counts = pos, when, counts
            self.low = {"count": len(low), "min_alt_km": min(low) if low else None}
            self.pos_key = None

    # ------------------------------------------------------------ risk + timeline

    def _log(self, run, when, kind, text):
        run.timeline.append({"time": iso(when), "kind": kind, "text": text})

    def _sim_now(self, run):
        return run.replay.now() if run.replay else now_utc()

    def _assess(self, run, when):
        if run.replay:
            r = run.replay
            kp_now, forecast = r.kp_at(when), r.forecast(when)
            n = r.batch_size(when)
            batch = {"count": n, "min_alt_km": 205.0, "protected": run.protected} if n else None
        else:
            kp_now, forecast, batch = self.weather["kp_now"], self.weather["kp_forecast"], None
        a = assess(when, kp_now, forecast, self.base_counts, self.low, batch)
        a["batch"] = batch
        return a

    def _step(self):
        """Advance the current run: replay events in order, or the live picture."""
        run = self.run
        if run.replay:
            for when, kind, data in run.replay.due_events():
                if kind == "launch":
                    self._log(run, when, "info",
                              "Launch L-12: 49 satellites deployed at ~210 km (SIMULATED batch).")
                if kind == "cme":
                    self._log(run, when, "info", cme_line(data))
                self._update(run, self._assess(run, when), kp_tick=(kind == "kp"))
                if kind == "end":
                    self._log(run, when, "info", "Replay finished.")
            if run.a is None:
                run.a = self._assess(run, run.replay.now())
        else:
            a = self._assess(run, now_utc())
            hist = self.weather.get("kp_history") or [{}]
            newest = hist[-1].get("time")
            tick = getattr(run, "last_kp_time", None) not in (None, newest)
            run.last_kp_time = newest
            self._update(run, a, kp_tick=tick)

    def _update(self, run, a, kp_tick):
        prev, lvl = run.level, a["level"]
        run.a, run.level = a, lvl
        when, kp, g = a["when"], a["kp_now"], g_scale(a["peak_kp"])
        rec = run.rec
        if lvl in ("warning", "critical") and rec is None:
            run.rec = build_recommendation(self._next_rec_id(), a, a["batch"])
            self._log(run, when, "alert", run.rec["summary"] + " Awaiting approval on Telegram.")
        elif lvl == prev:
            if kp_tick:
                self._log(run, when, "info", self._status_line(run, a))
        elif lvl == "critical" and rec and rec["status"] == "pending":
            self._log(run, when, "alert",
                      f"Storm now Kp {kp:.1f} (G{g}). Plan {rec['id']} still awaiting approval.")
        elif lvl == "none":
            run.rec = None
            self._log(run, when, "info", "All quiet. No action needed.")
        elif LEVELS.index(lvl) < LEVELS.index(prev):
            self._log(run, when, "info", "Storm easing. " + self._status_line(run, a))
        else:
            self._log(run, when, "info", self._status_line(run, a))

    def _next_rec_id(self):
        """Plan ids stay unique across restarts; the agent dedupes alerts on them."""
        p = os.path.join(STATE_DIR, "rec_counter")
        try:
            with open(p) as f:
                n = int(f.read().strip() or 0)
        except (OSError, ValueError):
            n = 0
        n += 1
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(p, "w") as f:
            f.write(str(n))
        return f"rec-{n:03d}"

    def _status_line(self, run, a):
        lvl, kp = a["level"], a["kp_now"]
        if lvl == "none":
            return f"Watching. Kp {kp:.1f}, no action needed."
        if lvl == "watch":
            return f"Watching. Kp {kp:.1f} now, up to {a['outlook_kp']:.1f} forecast in the next 3 days."
        rec = run.rec
        plan = f" Plan {rec['id']} {rec['status']}." if rec else ""
        return f"Kp {kp:.1f} now, peak Kp {a['peak_kp']:.1f}.{plan}"

    def _summary(self, run):
        a, rec = run.a, run.rec
        lvl = a["level"]
        if lvl == "none":
            return "All quiet. No action needed."
        if lvl == "watch" or rec is None:
            return f"Watching. Kp up to {a['outlook_kp']:.1f} forecast in the next 3 days."
        g = g_scale(a["peak_kp"])
        head = f"G{g} storm {'under way' if lvl == 'critical' else 'expected'}."
        if rec["status"] == "pending":
            if a["batch"]:
                return f"{head} {a['batch']['count']} satellites in batch L-12 at ~210 km at risk. Awaiting approval."
            return f"{head} {self.low['count']} satellites below {LOW_KM} km at risk. Awaiting approval."
        if rec["status"] == "approved":
            what = "L-12 orbit raise under way." if a["batch"] else "low satellites raising, launches on hold."
            return f"{head} Plan {rec['id']} approved: {what}"
        return f"{head} Plan {rec['id']} rejected by the ops lead."

    # ------------------------------------------------------------ positions

    def _render_positions(self):
        run, a = self.run, self.run.a
        batch = a["batch"]
        key = (self.real_time, a["factor"], bool(batch), run.protected)
        if key == self.pos_key:
            return
        f = a["factor"]
        sats = [{"id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"],
                 "alt_km": s["alt_km"], "risk": shift(s["band"], f)} for s in self.real]
        if batch:
            for s in l12_positions(self.real_time):
                s.pop("band")
                s["risk"] = "critical"
                s["protected"] = run.protected
                sats.append(s)
        doc = {"time": iso(self.real_time), "count": len(sats), "sats": sats}
        self.pos_bytes = json.dumps(doc, separators=(",", ":")).encode()
        self.pos_key = key

    # ------------------------------------------------------------ API views

    def state(self):
        with self.lock:
            run = self.run
            if run.replay:
                r = run.replay
                when = r.now()
                kp_now = r.kp_at(when)
                st = {"mode": r.scenario, "sim_time": iso(when), "kp_now": kp_now,
                      "kp_history": r.history(when), "kp_forecast": r.forecast(when),
                      "xray": {"flux": None, "class": "n/a"},
                      "scales": {"R": "n/a", "S": "n/a", "G": str(g_scale(kp_now))},
                      "solar_wind_kms": None}
                st["note"] = r.note
                st["replay"] = {"title": r.title, "speed": r.speed, "start": iso(r.start),
                                "end": iso(r.end), "done": r.done()}
                st["l1_monitors"], st["imf_bz_nt"] = [], None
                st["cme"] = cmes_known(r.cmes, when)
            else:
                w = self.weather
                when = now_utc()
                st = {"mode": "live", "sim_time": iso(when), "kp_now": w["kp_now"],
                      "kp_history": w["kp_history"], "kp_forecast": w["kp_forecast"],
                      "xray": w["xray"], "scales": w["scales"],
                      "solar_wind_kms": w["solar_wind_kms"]}
                st["l1_monitors"] = w.get("l1_monitors", [])
                active = next((m for m in st["l1_monitors"] if m["active"]), None)
                st["imf_bz_nt"] = active["bz_nt"] if active else None
                st["cme"] = cmes_known(self.live_cmes, when)
                st["note"] = ("LIVE: NOAA SWPC space weather, solar wind at L1 from NOAA's"
                              " active monitor plus NASA ACE and IMAP, CelesTrak Starlink orbits.")
            st["alert"] = {"level": run.a["level"], "summary": self._summary(run)}
            return st

    def _l1_line(self, st):
        mons = st.get("l1_monitors") or []
        if not mons:
            return None
        parts = []
        for m in mons:
            v = f"{m['speed_kms']:.0f} km/s" if m["speed_kms"] is not None else "n/a"
            bz = f", Bz {m['bz_nt']:+.1f} nT" if m["bz_nt"] is not None else ""
            parts.append(f"{m['label']}{' (active)' if m['active'] else ''} {v}{bz}")
        return "Solar wind at L1: " + "; ".join(parts) + "."

    def risk(self):
        with self.lock:
            run, a = self.run, self.run.a
            return {"time": iso(self._sim_now(run)), "scenario": run.mode,
                    "storm_factor": a["factor"], "kp_peak_forecast": round(a["peak_kp"], 2),
                    "bands": a["bands"], "groups": a["groups"], "recommendation": run.rec}

    def timeline(self):
        with self.lock:
            return list(self.run.timeline)

    def health(self):
        with self.lock:
            return {"ok": True, "mode": self.run.mode, "sim_time": iso(self._sim_now(self.run)),
                    "sats": len(self.real), "positions_time": iso(self.real_time),
                    "offline": OFFLINE, "level": self.run.a["level"]}

    def start_replay(self, scenario, speed, start=None):
        with self.lock:
            if scenario == "live":
                self.run = self.live
            else:
                r = Replay(scenario, speed, start)
                run = Run(scenario, r)
                self._log(run, r.start, "info", f"Replay started: {r.title} at {speed:g}x. {r.note}")
                for c in r.cmes_before_start():
                    self._log(run, r.start, "info", "Already on its way. " + cme_line(c))
                self.run = run
            self._step()
            self.pos_key = None
            self._render_positions()
            return {"ok": True, "mode": self.run.mode}

    def act(self, body):
        with self.lock:
            run, rec = self.run, self.run.rec
            rid = body.get("recommendation_id") or (rec["id"] if rec else None)
            if not rec or rid != rec["id"]:
                return 409, {"ok": False, "error": f"no open recommendation {rid}",
                             "current": rec["id"] if rec else None}
            decision = str(body.get("decision", "approved")).lower()
            decision = {"approve": "approved", "reject": "rejected"}.get(decision, decision)
            if decision not in ("approved", "rejected"):
                return 400, {"ok": False, "error": "decision must be approved or rejected"}
            if rec["status"] != "pending":
                return 200, {"ok": True, "already": rec["status"], "recommendation": rec}
            when = self._sim_now(run)
            note = str(body.get("note") or "").strip()[:300]
            rec["status"] = decision
            rec["by"] = str(body.get("by") or "telegram")[:80]
            if decision == "approved":
                run.protected = True
                self._log(run, when, "approval", "Approved by ops lead on Telegram.")
                text = f"Plan {rec['id']} logged: " + "; ".join(rec["actions"]) + "."
                self._log(run, when + timedelta(seconds=5), "action",
                          text + (f" Note: {note}" if note else ""))
            else:
                self._log(run, when, "approval",
                          "Rejected by ops lead on Telegram." + (f" Note: {note}" if note else ""))
            run.a = self._assess(run, run.a["when"])
            self._render_positions()
            return 200, {"ok": True, "recommendation": rec}

    def check(self, peek=False):
        """For the agent: NO_REPLY when calm, else the alert text.

        Without peek: returns each alert once per plan and level, and logs it as
        sent. With peek: returns the open alert every time and changes nothing,
        so the automation can dedupe on the first line and retry a failed run.
        """
        with self.lock:
            run, rec = self.run, self.run.rec
            lvl = run.a["level"]
            if not rec or rec["status"] != "pending" or lvl not in ("warning", "critical"):
                return "NO_REPLY"
            if peek:
                return self._alert_text(run)
            key = (rec["id"], lvl)
            if key in run.notified:
                return "NO_REPLY"
            run.notified.add(key)
            self._log(run, self._sim_now(run), "info",
                      f"Alert {rec['id']} sent to the ops lead on Telegram.")
            return self._alert_text(run)

    def _alert_text(self, run):
        a, rec = run.a, run.rec
        lines = [f"SOLAR STORM {a['level'].upper()} - plan {rec['id']}"]
        if run.replay:
            lines.append(f"[{run.replay.title}: real Kp, SIMULATED forecast and launch batch."
                         f" Sim time {iso(run.replay.now())}]")
        lines += ["", rec["summary"]]
        st = self.state()
        lines += [cme_line(c) for c in st["cme"]]
        if self._l1_line(st):
            lines.append(self._l1_line(st))
        lines += ["", "At risk:"]
        for g in a["groups"]:
            lines.append(f"- {g['name']}: {g['count']} sats, lowest {g['min_alt_km']:.0f} km")
        lines += ["", "Plan:"]
        lines += [f"{i}. {x}" for i, x in enumerate(rec["actions"], 1)]
        lines += [f"Act by {rec['deadline']}.", "",
                  'Reply "approve" to log this plan, or "reject".']
        return "\n".join(lines)

    def brief(self):
        st, rk = self.state(), self.risk()
        with self.lock:
            tl = self.run.timeline[-3:]
        fc = max([p["kp"] for p in st["kp_forecast"]], default=0.0)
        b = rk["bands"]
        sc = " ".join(f"{k}{v}" if v != "n/a" else f"{k} n/a" for k, v in st["scales"].items())
        wind = f"{st['solar_wind_kms']} km/s" if st["solar_wind_kms"] is not None else "n/a"
        rec = rk["recommendation"]
        lines = [
            f"MORNING BRIEF ({st['mode']}, {st['sim_time']})",
            f"Space weather: Kp {st['kp_now']:.1f} now, max Kp {fc:.1f} forecast in the next 3 days."
            f" X-ray {st['xray']['class']}. NOAA scales {sc}."
            f" Solar wind {wind}.",
            f"Constellation: {sum(b.values()):,} satellites. Bands now: critical {b['critical']},"
            f" high {b['high']}, watch {b['watch']}, fine {b['fine']}.",
            f"Risk level: {st['alert']['level']}. {st['alert']['summary']}",
            f"Open plan: {rec['id'] + ' ' + rec['status'] if rec else 'none'}.",
        ]
        if self._l1_line(st):
            lines.insert(2, self._l1_line(st))
        lines += [cme_line(c) for c in st["cme"]] or ["NASA DONKI: no Earth-directed CME on record."
                                                      if self._donki_loaded() else
                                                      "NASA DONKI: not available right now."]
        lines += ["Last events:"] + [f"- {e['time']} {e['kind']}: {e['text']}" for e in tl]
        return "\n".join(lines)

    def _donki_loaded(self):
        run = self.run
        if run.replay:
            return load_json(f"donki_{run.replay.scenario}.json") is not None
        return os.path.exists(os.path.join(STATE_DIR, "donki_live.json"))


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    engine = None
    server_version = "solar-storm-ops/0.1"

    def log_message(self, fmt, *args):
        pass  # the dashboard polls every 2 s; keep the log readable

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        e = self.engine
        try:
            if path == "/state":
                return self._send(200, e.state())
            if path == "/positions":
                with e.lock:
                    body = e.pos_bytes
                return self._send(200, body)
            if path == "/risk":
                return self._send(200, e.risk())
            if path == "/timeline":
                return self._send(200, e.timeline())
            if path == "/check":
                peek = "peek" in parse_qs(qs)
                return self._send(200, e.check(peek=peek), "text/plain; charset=utf-8")
            if path == "/brief":
                return self._send(200, e.brief(), "text/plain; charset=utf-8")
            if path == "/health":
                return self._send(200, e.health())
            if path == "/":
                return self._redirect("/dashboard/")
            return self._static(path)
        except Exception:
            log("GET failed:\n" + traceback.format_exc())
            return self._send(500, {"ok": False, "error": "internal error"})

    def do_POST(self):
        path = self.path.partition("?")[0]
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")
        except Exception as ex:
            return self._send(400, {"ok": False, "error": f"bad JSON: {ex}"})
        log(f"POST {path} {json.dumps(body)[:300]}")
        try:
            if path == "/replay":
                sc = body.get("scenario", "live")
                if sc != "live" and sc not in SCENARIOS:
                    return self._send(400, {"ok": False, "error": f"unknown scenario {sc}",
                                            "scenarios": ["live", *SCENARIOS]})
                speed = float(body.get("speed") or 360)
                if not 1 <= speed <= 100000:
                    return self._send(400, {"ok": False, "error": "speed must be 1..100000"})
                return self._send(200, self.engine.start_replay(sc, speed, body.get("start")))
            if path == "/actions":
                code, out = self.engine.act(body)
                return self._send(code, out)
            return self._send(404, {"ok": False, "error": "not found"})
        except Exception:
            log("POST failed:\n" + traceback.format_exc())
            return self._send(500, {"ok": False, "error": "internal error"})

    def _redirect(self, to):
        self.send_response(302)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _static(self, path):
        parts = unquote(path).lstrip("/").split("/", 1)
        if parts[0] not in STATIC_DIRS:
            return self._send(404, {"ok": False, "error": "not found"})
        base = os.path.realpath(os.path.join(ROOT, parts[0]))
        full = os.path.realpath(os.path.join(base, parts[1] if len(parts) > 1 else ""))
        if full != base and not full.startswith(base + os.sep):
            return self._send(404, {"ok": False, "error": "not found"})
        if os.path.isdir(full):
            if not path.endswith("/"):
                return self._redirect(path + "/")
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self._send(404, {"ok": False, "error": "not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            return self._send(200, f.read(), ctype)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--bind", default="127.0.0.1",
                    help="comma-separated addresses, e.g. 127.0.0.1,172.17.0.1")
    ap.add_argument("--port", type=int, default=18310)
    args = ap.parse_args()
    addrs = [a.strip() for a in args.bind.split(",") if a.strip()]
    if any(a in ("0.0.0.0", "::", "*") for a in addrs):
        sys.exit("refusing to bind all interfaces; pass 127.0.0.1 and/or the sandbox bridge IP")

    engine = Engine()
    Handler.engine = engine
    engine.start()
    up = 0
    for a in addrs:
        try:
            srv = ThreadingHTTPServer((a, args.port), Handler)
        except OSError as ex:
            log(f"cannot bind {a}:{args.port}: {ex}")
            continue
        threading.Thread(target=srv.serve_forever, daemon=True, name=f"http-{a}").start()
        log(f"serving http://{a}:{args.port}")
        up += 1
    if not up:
        sys.exit("no address bound")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
