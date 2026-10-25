"""Live feeds, orbit math and risk rules for Solar Storm Ops.

Stdlib plus sgp4. Every feed falls back to a cached file, so the API keeps
working with no network at all (state/ first, then fixtures/).
"""
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from sgp4 import omm
    from sgp4.api import Satrec, jday
except ImportError:  # still runs, with the static positions from fixtures/
    Satrec = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "fixtures")
STATE_DIR = os.environ.get("SSO_STATE_DIR", os.path.join(ROOT, "state"))
OFFLINE = bool(os.environ.get("SSO_OFFLINE"))

UA = {"User-Agent": "solar-storm-ops-hackathon/0.1"}
SWPC = "https://services.swpc.noaa.gov"
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json"
CELESTRAK_GAP_S = 2 * 3600 + 600  # CelesTrak answers 403 to a repeat within 2 h

MU, RE = 398600.4418, 6378.137
BANDS = ["fine", "watch", "high", "critical"]
HORIZON_H = 18  # a forecast storm inside this window raises a warning
OUTLOOK_H = 72  # a forecast storm inside this window raises a watch
LOW_KM = 350    # "low group": real satellites below this altitude

# Simulated launch batch for the Feb 2022 replay. Not real orbit data.
L12_COUNT = 49
L12_NAME = "Launch batch L-12 (SIMULATED, 49 sats at ~210 km)"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def utc(s):
    """Parse NOAA / GFZ / ISO time strings (with or without Z) to aware UTC."""
    s = s.strip().replace(" ", "T").rstrip("Z").split(".")[0]
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_utc():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- files

def load_json(name, dirs=(STATE_DIR, FIXTURES)):
    for d in dirs:
        p = os.path.join(d, name)
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)
    return None


def save_bytes(name, data):
    os.makedirs(STATE_DIR, exist_ok=True)
    p = os.path.join(STATE_DIR, name)
    with open(p + ".tmp", "wb") as f:
        f.write(data)
    os.replace(p + ".tmp", p)


def save_json(name, obj):
    save_bytes(name, json.dumps(obj).encode())


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- NOAA

def flare_class(flux):
    for c, lo in (("X", 1e-4), ("M", 1e-5), ("C", 1e-6), ("B", 1e-7)):
        if flux >= lo:
            return f"{c}{flux / lo:.1f}"
    return f"A{flux / 1e-8:.1f}"


def zt(t):
    """NOAA times come without a zone. They are UTC, so say so."""
    return iso(utc(t))


WEATHER_KEYS = ("kp_now", "kp_history", "kp_forecast", "xray", "scales", "solar_wind_kms")


def initial_weather():
    """Last good NOAA snapshot: state/weather.json, else fixtures/state.json."""
    w = load_json("weather.json", (STATE_DIR,)) or load_json("state.json", (FIXTURES,))
    w = {k: w[k] for k in WEATHER_KEYS if k in w}
    w["kp_history"] = [{"time": zt(p["time"]), "kp": p["kp"]} for p in w.get("kp_history", [])]
    w["kp_forecast"] = [{"time": zt(p["time"]), "kp": p["kp"]} for p in w.get("kp_forecast", [])]
    return w


def refresh_weather(prev):
    """Pull each NOAA feed. A feed that fails keeps its last good value."""
    w = dict(prev)
    ok = []

    def step(name, fn):
        try:
            fn()
            ok.append(name)
        except Exception as e:
            log(f"noaa {name} failed: {e!r}")

    def kp():
        d = json.loads(fetch(SWPC + "/products/noaa-planetary-k-index.json"))
        w["kp_now"] = float(d[-1]["Kp"])
        w["kp_history"] = [{"time": zt(p["time_tag"]), "kp": float(p["Kp"])} for p in d[-24:]]

    def forecast():
        d = json.loads(fetch(SWPC + "/products/noaa-planetary-k-index-forecast.json"))
        w["kp_forecast"] = [{"time": zt(p["time_tag"]), "kp": float(p["kp"])}
                            for p in d if p.get("observed") == "predicted"]

    def xray():
        d = json.loads(fetch(SWPC + "/json/goes/primary/xrays-1-day.json"))
        d = [p for p in d if p.get("energy") == "0.1-0.8nm" and p.get("flux")] or d
        w["xray"] = {"flux": d[-1]["flux"], "class": flare_class(d[-1]["flux"])}

    def scales():
        d = json.loads(fetch(SWPC + "/products/noaa-scales.json"))
        w["scales"] = {k: str(d["0"][k]["Scale"]) for k in ("R", "S", "G")}

    def wind():
        d = json.loads(fetch(SWPC + "/products/summary/solar-wind-speed.json"))
        d = d[0] if isinstance(d, list) else d
        w["solar_wind_kms"] = d["proton_speed"]

    for name, fn in (("kp", kp), ("forecast", forecast), ("xray", xray),
                     ("scales", scales), ("wind", wind)):
        step(name, fn)
    if ok:
        save_json("weather.json", w)
    return w, ok


# ---------------------------------------------------------------- CelesTrak

def gp_path():
    p = os.path.join(STATE_DIR, "starlink_gp.json")
    return p if os.path.exists(p) else os.path.join(FIXTURES, "starlink_gp.json")


def load_gp():
    with open(gp_path()) as f:
        return json.load(f)


def maybe_refresh_gp():
    """Refetch Starlink elements when the cache is over 2 h old. One try per 2 h."""
    if OFFLINE or os.environ.get("SSO_NO_CELESTRAK"):
        return False
    t = time.time()
    if t - os.path.getmtime(gp_path()) < CELESTRAK_GAP_S:
        return False
    stamp = os.path.join(STATE_DIR, "celestrak_last_try")
    if os.path.exists(stamp) and t - os.path.getmtime(stamp) < CELESTRAK_GAP_S:
        return False
    save_bytes("celestrak_last_try", iso(now_utc()).encode())
    try:
        raw = fetch(CELESTRAK_URL, timeout=180)
        gp = json.loads(raw)
        if not isinstance(gp, list) or len(gp) < 1000:
            raise ValueError(f"unexpected CelesTrak reply ({len(raw)} bytes)")
        save_bytes("starlink_gp.json", raw)
        log(f"celestrak refreshed: {len(gp)} objects")
        return True
    except Exception as e:
        log(f"celestrak failed: {e!r}")
        return False


# ---------------------------------------------------------------- orbits

def base_band(alt):
    if alt < 250:
        return "critical"
    if alt < 350:
        return "high"
    if alt < 450:
        return "watch"
    return "fine"


def gmst(jd, fr):
    d = jd + fr - 2451545.0
    return math.radians((280.46061837 + 360.98564736629 * d) % 360)


def to_latlon(x, y, z, g):
    lon = math.atan2(y, x) - g
    lon = math.degrees((lon + math.pi) % (2 * math.pi) - math.pi)
    lat = math.degrees(math.asin(z / math.sqrt(x * x + y * y + z * z)))
    return round(lat, 3), round(lon, 3)


class Constellation:
    """Starlink elements, propagated with sgp4 to wall-clock time."""

    def __init__(self, gp):
        self.sats = []
        for f in gp:
            try:
                n = f["MEAN_MOTION"] * 2 * math.pi / 86400
                alt = (MU / n ** 2) ** (1 / 3) - RE
                rec = None
                if Satrec:
                    rec = Satrec()
                    omm.initialize(rec, f)
                self.sats.append((f["NORAD_CAT_ID"], f["OBJECT_NAME"], rec,
                                  round(alt, 1), base_band(alt)))
            except Exception:
                continue

    def positions(self, when):
        if not Satrec:
            return static_positions()
        sec = when.second + when.microsecond / 1e6
        jd, fr = jday(when.year, when.month, when.day, when.hour, when.minute, sec)
        g = gmst(jd, fr)
        out = []
        for sid, name, rec, alt, band in self.sats:
            e, r, _ = rec.sgp4(jd, fr)
            if e != 0:
                continue
            lat, lon = to_latlon(*r, g)
            out.append({"id": sid, "name": name, "lat": lat, "lon": lon,
                        "alt_km": alt, "band": band})
        return out


def static_positions():
    p = load_json("positions.json", (FIXTURES,))
    return [dict(s, band=base_band(s["alt_km"])) for s in p["sats"]]


def l12_positions(when):
    """The SIMULATED Feb 2022 launch batch: a train of 49 satellites at ~210 km."""
    if Satrec:
        jd, fr = jday(when.year, when.month, when.day, when.hour, when.minute, when.second)
        g = gmst(jd, fr)
    else:
        g = 0.0
    t = when.timestamp()
    inc, raan = math.radians(53.2), math.radians(60.0)
    out = []
    for k in range(L12_COUNT):
        alt = 205.0 + (k % 5) * 2.5
        a = RE + alt
        period = 2 * math.pi * math.sqrt(a ** 3 / MU)
        u = 2 * math.pi * (t % period) / period - math.radians(0.6 * k)
        x = a * (math.cos(raan) * math.cos(u) - math.sin(raan) * math.sin(u) * math.cos(inc))
        y = a * (math.sin(raan) * math.cos(u) + math.cos(raan) * math.sin(u) * math.cos(inc))
        z = a * math.sin(u) * math.sin(inc)
        lat, lon = to_latlon(x, y, z, g)
        out.append({"id": 990001 + k, "name": f"L-12 SIM-{k + 1:02d}", "lat": lat, "lon": lon,
                    "alt_km": alt, "band": "critical", "simulated": True})
    return out


# ---------------------------------------------------------------- risk rules

def kp_int(kp):
    """NOAA counts Kp 5- (4.67) as Kp 5, so compare on the rounded value."""
    return int(round(kp))


def g_scale(kp):
    return max(0, min(5, kp_int(kp) - 4))


def storm_factor(kp):
    k = kp_int(kp)
    return 2 if k >= 7 else 1 if k >= 5 else 0


def shift(band, factor):
    return BANDS[min(len(BANDS) - 1, BANDS.index(band) + factor)]


def assess(when, kp_now, forecast, base_counts, low, batch):
    """Risk picture at `when`.

    forecast:    [{"time", "kp"}] predicted Kp after `when`
    base_counts: real satellites per altitude band, before any storm shift
    low:         {"count", "min_alt_km"} real satellites below LOW_KM
    batch:       None, or {"count", "min_alt_km", "protected"} for the L-12 batch
    """
    fc = [(utc(p["time"]), p["kp"]) for p in forecast]
    fc18 = [(t, k) for t, k in fc if when < t <= when + timedelta(hours=HORIZON_H)]
    fc72 = [(t, k) for t, k in fc if when < t <= when + timedelta(hours=OUTLOOK_H)]
    peak18 = max(fc18, key=lambda p: p[1], default=(None, 0.0))
    peak72 = max(fc72, key=lambda p: p[1], default=(None, 0.0))
    factor = storm_factor(max(kp_now, peak18[1]))

    counts = {b: 0 for b in BANDS}
    exposed = 0
    for b, n in base_counts.items():
        s = shift(b, factor)
        counts[s] += n
        if s == "critical":
            exposed += n
    if batch:
        counts["critical"] += batch["count"]
        if not batch["protected"]:
            exposed += batch["count"]

    if exposed and (kp_int(kp_now) >= 5 or kp_int(peak18[1]) >= 7):
        level = "critical"
    elif exposed and kp_int(peak18[1]) >= 5:
        level = "warning"
    elif kp_int(peak72[1]) >= 4 or kp_int(kp_now) >= 4:
        level = "watch"
    else:
        level = "none"

    groups = []
    if level != "none":
        if batch:
            groups.append({"name": L12_NAME, "count": batch["count"],
                           "min_alt_km": batch["min_alt_km"], "band": "critical",
                           "action": "Raise orbit now and fly low-drag attitude",
                           "protected": batch["protected"]})
        if low["count"]:
            groups.append({"name": f"Starlink below {LOW_KM} km (real, raising or deorbiting)",
                           "count": low["count"], "min_alt_km": low["min_alt_km"],
                           "band": shift(base_band(low["min_alt_km"]), factor),
                           "action": "Keep raising; hold any planned lowering burns"})

    peak = (when, kp_now) if kp_now >= peak18[1] else peak18
    return {"when": when, "kp_now": kp_now, "peak_kp": peak[1], "peak_time": peak[0],
            "outlook_kp": peak72[1], "factor": factor, "bands": counts,
            "exposed": exposed, "level": level, "groups": groups}


def build_recommendation(rec_id, a, batch):
    """Plan text from the numbers in `a`. Fixed template, no model involved."""
    kp, g = a["peak_kp"], g_scale(a["peak_kp"])
    if a["peak_time"] == a["when"]:
        head = f"Geomagnetic storm under way: Kp {kp:.1f} (G{g}) now."
    else:
        hours = max(1, math.ceil((a["peak_time"] - a["when"]).total_seconds() / 3600))
        head = f"Geomagnetic storm forecast: Kp {kp:.1f} (G{g}) within {hours} h."
    if batch:
        body = (f" {batch['count']} satellites in launch batch L-12 (SIMULATED) are at"
                f" ~210 km. Raise their orbits now and fly low-drag attitude.")
        actions = ["Batch L-12: start orbit raise now, low-drag attitude",
                   "Hold the next launch until the Kp forecast drops below 5",
                   "Re-check in 3 h"]
    else:
        low = next((x for x in a["groups"] if x["name"].startswith("Starlink below")), None)
        n = low["count"] if low else a["exposed"]
        body = f" {n} satellites are below {LOW_KM} km. Keep raising them and hold lowering burns."
        actions = [f"Satellites below {LOW_KM} km: keep raising, hold lowering burns",
                   "Hold launches until the Kp forecast drops below 5",
                   "Re-check in 3 h"]
    deadline = a["peak_time"] if a["peak_time"] != a["when"] else a["when"] + timedelta(hours=3)
    return {"id": rec_id, "summary": head + body, "actions": actions,
            "deadline": iso(deadline), "status": "pending"}
