"""Build real sample data for the dashboard from CelesTrak + NOAA + GFZ.

Usage: uv run --with sgp4 python make_fixtures.py <out_dir>
"""
import json, math, sys, time, urllib.request
from datetime import datetime, timezone
from sgp4.api import Satrec, jday
from sgp4 import omm

OUT = sys.argv[1]
UA = {"User-Agent": "solar-storm-ops-hackathon/0.1"}
MU, RE = 398600.4418, 6378.137


def get(url, timeout=120):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout).read()


def band(alt):
    if alt < 250:
        return "critical"
    if alt < 350:
        return "high"
    if alt < 450:
        return "watch"
    return "fine"


raw = get("https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json")
gp = json.loads(raw)
with open(f"{OUT}/starlink_gp.json", "wb") as f:
    f.write(raw)

now = datetime.now(timezone.utc)
jd, fr = jday(now.year, now.month, now.day, now.hour, now.minute, now.second)
# Greenwich sidereal angle, good enough for a display globe
d = jd + fr - 2451545.0
gmst = math.radians((280.46061837 + 360.98564736629 * d) % 360)

positions, counts = [], {"critical": 0, "high": 0, "watch": 0, "fine": 0}
for fields in gp:
    sat = Satrec()
    omm.initialize(sat, fields)
    e, r, _ = sat.sgp4(jd, fr)
    if e != 0:
        continue
    x, y, z = r
    lon = math.atan2(y, x) - gmst
    lon = math.degrees((lon + math.pi) % (2 * math.pi) - math.pi)
    rr = math.sqrt(x * x + y * y + z * z)
    lat = math.degrees(math.asin(z / rr))
    n = fields["MEAN_MOTION"] * 2 * math.pi / 86400
    alt_mean = (MU / n**2) ** (1 / 3) - RE
    b = band(alt_mean)
    counts[b] += 1
    positions.append({
        "id": fields["NORAD_CAT_ID"],
        "name": fields["OBJECT_NAME"],
        "lat": round(lat, 3),
        "lon": round(lon, 3),
        "alt_km": round(alt_mean, 1),
        "risk": b,
    })

stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump({"time": stamp, "count": len(positions), "sats": positions},
          open(f"{OUT}/positions.json", "w"))

kp = json.loads(get("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"))
fc = json.loads(get("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"))
xr = json.loads(get("https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json"))
sc = json.loads(get("https://services.swpc.noaa.gov/products/noaa-scales.json"))
sw = json.loads(get("https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json"))


def flare_class(flux):
    for c, lo in (("X", 1e-4), ("M", 1e-5), ("C", 1e-6), ("B", 1e-7)):
        if flux >= lo:
            return f"{c}{flux / lo:.1f}"
    return f"A{flux / 1e-8:.1f}"


xr_long = [p for p in xr if p.get("energy") == "0.1-0.8nm"] or xr
state = {
    "mode": "live",
    "sim_time": stamp,
    "kp_now": kp[-1]["Kp"],
    "kp_history": [{"time": p["time_tag"], "kp": p["Kp"]} for p in kp[-24:]],
    "kp_forecast": [{"time": p["time_tag"], "kp": p["kp"]} for p in fc
                    if p.get("observed") == "predicted"],
    "xray": {"flux": xr_long[-1]["flux"], "class": flare_class(xr_long[-1]["flux"])},
    "scales": {k: sc["0"][k]["Scale"] for k in ("R", "S", "G")},
    "solar_wind_kms": sw[0]["proton_speed"] if isinstance(sw, list) else sw["proton_speed"],
    "alert": {"level": "none", "summary": "All quiet. No action needed."},
}
json.dump(state, open(f"{OUT}/state.json", "w"), indent=2)

risk = {
    "time": stamp,
    "storm_factor": 0,
    "bands": counts,
    "groups": [],
    "recommendation": None,
}
json.dump(risk, open(f"{OUT}/risk.json", "w"), indent=2)

kp_feb = json.loads(get("https://kp.gfz-potsdam.de/app/json/?start=2022-02-01T00:00:00Z"
                        "&end=2022-02-07T00:00:00Z&index=Kp"))
kp_may = json.loads(get("https://kp.gfz-potsdam.de/app/json/?start=2024-05-09T00:00:00Z"
                        "&end=2024-05-13T00:00:00Z&index=Kp"))
json.dump({"feb2022": [{"time": t, "kp": k} for t, k in zip(kp_feb["datetime"], kp_feb["Kp"])],
           "may2024": [{"time": t, "kp": k} for t, k in zip(kp_may["datetime"], kp_may["Kp"])]},
          open(f"{OUT}/replay_kp.json", "w"), indent=1)

print("sats", len(positions), counts, "kp_now", state["kp_now"], "xray", state["xray"]["class"])
