"""End-to-end check of the data API against docs/api.md and fixtures/.

    python3 backend/smoke_test.py [http://127.0.0.1:18310]

Runs the Feb 2022 replay at high speed, approves the plan, then goes back
to live. Leaves the API in live mode.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18310").rstrip("/")
FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures")
fails = []


def req(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data,
                               headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            code = resp.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    try:
        return code, json.loads(raw)
    except ValueError:
        return code, raw.decode()


def fixture(name):
    with open(os.path.join(FIX, name)) as f:
        return json.load(f)


def ok(cond, what):
    print(("PASS " if cond else "FAIL ") + what)
    if not cond:
        fails.append(what)


def same_keys(got, want, what):
    missing = set(want) - set(got)
    ok(not missing, f"{what} has fixture keys" + (f" (missing {sorted(missing)})" if missing else ""))


def wait_for(fn, what, timeout=20):
    t = time.time()
    while time.time() - t < timeout:
        if fn():
            return True
        time.sleep(0.5)
    ok(False, f"timed out waiting for {what}")
    return False


# live shapes
req("/replay", {"scenario": "live"})
c, st = req("/state")
ok(c == 200, "GET /state 200")
same_keys(st, fixture("state.json"), "/state")
same_keys(st["alert"], {"level": 0, "summary": 0}, "/state.alert")
c, rk = req("/risk")
ok(c == 200, "GET /risk 200")
same_keys(rk, fixture("risk.json"), "/risk")
c, pos = req("/positions")
ok(c == 200 and pos["count"] > 10000, f"GET /positions count {pos.get('count')}")
same_keys(pos["sats"][0], fixture("positions.json")["sats"][0], "/positions sat")
c, tl = req("/timeline")
ok(c == 200 and isinstance(tl, list) and tl, "GET /timeline list")
same_keys(tl[0], fixture("timeline.json")[0], "/timeline entry")
c, h = req("/health")
ok(c == 200 and h["ok"], "GET /health")
print("live:", st["mode"], "kp", st["kp_now"], "level", st["alert"]["level"], "bands", rk["bands"])

def sims():
    return [s for s in req("/positions")[1]["sats"] if s.get("simulated")]


def tl_has(text):
    return any(text in e["text"] for e in req("/timeline")[1])


# feb2022, path A: the agent asks to hold launch L-12, the ops lead approves before liftoff
c, r = req("/replay", {"scenario": "feb2022", "speed": 7200})
ok(c == 200 and r["mode"] == "feb2022", "POST /replay feb2022")
c, st = req("/state")
ln = st.get("launch") or {}
ok(ln.get("status") == "scheduled" and ln.get("site", {}).get("lat") == 28.608 and ln.get("simulated"),
   "/state.launch scheduled, with site")
ok(st["alert"]["level"] == "watch", f"feb2022 starts at watch ({st['alert']['level']})")
wait_for(lambda: req("/state")[1]["alert"]["level"] == "warning", "feb2022 warning", 15)
c, st = req("/state")
print("feb2022:", st["sim_time"], "kp", st["kp_now"], st["alert"])
c, rk = req("/risk")
same_keys(rk, fixture("risk_alert.json"), "/risk during storm")
rec = rk["recommendation"]
ok(rec and rec["status"] == "pending" and rec.get("kind") == "hold", "hold plan pending")
ok(rec["deadline"] == "2022-02-03T18:13:00Z", "hold plan deadline is liftoff")
ok(rk["groups"] and rk["groups"][0].get("launch"), "launch L-12 group first")
ok(not sims(), "no L-12 satellites before liftoff")
c, txt = req("/check?peek=1")
ok(isinstance(txt, str) and txt.startswith("SOLAR STORM") and "Hold launch L-12" in txt, "GET /check?peek hold alert")
c, txt = req("/check")
ok(txt.startswith("SOLAR STORM"), "GET /check alert once")
print(txt)
c, txt = req("/check")
ok(txt == "NO_REPLY", "GET /check NO_REPLY after first read")
c, out = req("/actions", {"recommendation_id": "rec-999", "decision": "approved", "by": "test"})
ok(c == 409, "POST /actions wrong id 409")
c, out = req("/actions", {"recommendation_id": rec["id"], "decision": "approved",
                          "by": "telegram:test", "note": "smoke test"})
ok(c == 200 and out["recommendation"]["status"] == "approved", "POST /actions approve hold")
c, out = req("/actions", {"recommendation_id": rec["id"], "decision": "approved"})
ok(c == 200 and out.get("already") == "approved", "POST /actions idempotent")
c, st = req("/state")
ok(st["launch"]["status"] == "held", "launch status held after approval")
ok("on hold" in st["alert"]["summary"], f"summary says on hold ({st['alert']['summary']})")
c, tl = req("/timeline")
kinds = [e["kind"] for e in tl]
ok("approval" in kinds and "action" in kinds, "timeline has approval + action")
ok(tl_has("launch L-12 on hold"), "action entry says launch L-12 on hold")
wait_for(lambda: tl_has("stays on the ground"), "held launch entry at 18:13", 30)
ok(not sims(), "no L-12 satellites after a held launch")
wait_for(lambda: req("/state")[1]["replay"]["done"], "feb2022 end", 30)
c, tl = req("/timeline")
ok(tl[-1]["text"] == "Replay finished.", "replay finished entry")
for e in tl:
    print(f"  {e['time']} {e['kind']:8} {e['text']}")

# feb2022, path B: nobody decides before liftoff -> batch launches -> raise-orbit plan
c, r = req("/replay", {"scenario": "feb2022", "speed": 20000})
wait_for(lambda: (req("/state")[1].get("launch") or {}).get("status") == "launched", "launch without decision", 20)
ok(tl_has("No decision on plan") and tl_has("Launch L-12: 49 satellites deployed"), "expired hold + launch entries")
wait_for(lambda: (req("/risk")[1]["recommendation"] or {}).get("kind") == "protect", "raise-orbit plan", 15)
c, rk = req("/risk")
rec2 = rk["recommendation"]
ok(rec2["status"] == "pending" and any("Launch batch L-12" in g["name"] for g in rk["groups"]),
   "raise-orbit plan pending with L-12 batch group")
s2 = sims()
ok(len(s2) == 49 and not s2[0]["protected"], f"49 simulated L-12 sats after launch ({len(s2)})")
c, out = req("/actions", {"recommendation_id": rec2["id"], "decision": "approved", "by": "telegram:test"})
ok(c == 200 and all(s["protected"] for s in sims()), "L-12 protected after approving the raise plan")
wait_for(lambda: req("/state")[1]["replay"]["done"], "feb2022 path B end", 20)

# may2024 replay: critical
req("/replay", {"scenario": "may2024", "speed": 7200})
wait_for(lambda: req("/state")[1]["alert"]["level"] == "critical", "may2024 critical", 15)
c, rk = req("/risk")
print("may2024:", rk["storm_factor"], rk["bands"], rk["recommendation"]["summary"])

# errors, static files, brief, back to live
c, _ = req("/replay", {"scenario": "nope"})
ok(c == 400, "POST /replay bad scenario 400")
c, _ = req("/fixtures/state.json")
ok(c == 200, "GET /fixtures/state.json 200")
c, _ = req("/fixtures/../backend/api.py")
ok(c == 404, "path traversal blocked")
c, br = req("/brief")
ok(c == 200 and br.startswith("MORNING BRIEF"), "GET /brief")
print(br)
c, r = req("/replay", {"scenario": "live"})
ok(c == 200 and req("/state")[1]["mode"] == "live", "back to live")

print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
