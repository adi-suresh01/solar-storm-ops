"""What the agent is doing, for the console.

- Logs the agent's own calls to the data API. Those arrive on the sandbox bridge
  address, so they can't be confused with the console or local scripts.
- Reads the storm-watch automation runs (the alert text the model wrote, model,
  tokens, time, delivery) through `openshell sandbox exec`.
- Runs "ask the agent" questions through the real OpenClaw agent in the sandbox.
- Reads the local vLLM metrics, to show that inference happens on this machine.
Everything here degrades quietly when openshell or vLLM are not around (laptops).
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request

from watcher import iso, log, now_utc

SANDBOX = os.environ.get("SSO_SANDBOX", "ops")
OPENSHELL = shutil.which("openshell") or os.path.expanduser("~/.local/bin/openshell")
VLLM = os.environ.get("SSO_VLLM", "http://127.0.0.1:18300")
NVIDIA_SMI = shutil.which("nvidia-smi")

# What each agent call means, in plain words. First match wins.
DESCRIBE = [
    ("GET", "/check?peek", None),  # the 30 s heartbeat: counted, not listed
    ("GET", "/check", "Picked up the storm alert to write and send"),
    ("GET", "/state", "Read space weather and the alert level"),
    ("GET", "/risk", "Read satellite risk and the open plan"),
    ("GET", "/timeline", "Read the event log"),
    ("GET", "/brief", "Pulled the data for a brief"),
    ("GET", "/ops-data/runbook", "Read the operator runbook (MOCK)"),
    ("GET", "/ops-data/launch_schedule", "Read the launch schedule (MOCK)"),
    ("GET", "/ops-data/maneuver_budget", "Read the maneuver budget (MOCK)"),
    ("GET", "/ops-data/", "Read an operator file (MOCK)"),
    ("POST", "/actions", "Recorded the ops lead's decision"),
    ("POST", "/replay", "Started a replay on request"),
]


def sandbox(args, timeout=90):
    """Run a command inside the sandbox; returns (rc, stdout without gateway banners)."""
    p = subprocess.run([OPENSHELL, "sandbox", "exec", "-n", SANDBOX, "--no-tty", "--", *args],
                       capture_output=True, text=True, timeout=timeout)
    keep = [ln for ln in p.stdout.splitlines() if not ln.startswith("[gateway]")]
    return p.returncode, "\n".join(keep).strip()


def first_json(text):
    i = text.find("{")
    if i < 0:
        raise ValueError("no JSON in output")
    return json.JSONDecoder().raw_decode(text[i:])[0]


class AgentBridge:
    def __init__(self):
        self.lock = threading.Lock()
        self.seq = 0
        self.events = []        # newest last
        self.checks = 0
        self.last_check = None
        self.runs = []          # storm-watch runs, newest first
        self.inference = {"ok": False}
        self.ask_state = None   # the current or last console question
        self.job_id = None
        self._last_tok = None
        self.has_sandbox = os.path.exists(OPENSHELL)

    # ------------------------------------------------------------ agent API calls

    def _event(self, kind, text):
        self.seq += 1
        self.events.append({"seq": self.seq, "time": iso(now_utc()), "kind": kind, "text": text})
        del self.events[:-60]

    def note_request(self, method, path, body=None):
        for m, prefix, text in DESCRIBE:
            if m == method and path.startswith(prefix):
                with self.lock:
                    if text is None:
                        self.checks += 1
                        self.last_check = iso(now_utc())
                        self.seq += 1  # lets the console animate each check
                        return
                    if prefix == "/actions" and isinstance(body, dict):
                        text += f": {body.get('decision', 'approved')}"
                    self._event("tool", text)
                return

    # ------------------------------------------------------------ background polling

    def start(self):
        threading.Thread(target=self._loop, daemon=True, name="agent-bridge").start()

    def _loop(self):
        last_runs = 0.0
        while True:
            try:
                self._poll_inference()
            except Exception as e:
                with self.lock:
                    self.inference = {"ok": False, "error": str(e)[:120]}
            if self.has_sandbox and time.time() - last_runs > 12:
                last_runs = time.time()
                try:
                    self._poll_runs()
                except Exception as e:
                    log(f"agent runs poll failed: {e!r}")
            time.sleep(4)

    def _poll_inference(self):
        txt = urllib.request.urlopen(VLLM + "/metrics", timeout=3).read().decode()

        def total(name):
            vals = re.findall(rf"^{re.escape(name)}(?:{{[^}}]*}})? ([0-9.eE+-]+)$", txt, re.M)
            return sum(float(v) for v in vals) if vals else None

        gen = total("vllm:generation_tokens_total")
        prompt = total("vllm:prompt_tokens_total")
        running = total("vllm:num_requests_running")
        waiting = total("vllm:num_requests_waiting")
        now = time.time()
        gen_tps = None
        if self._last_tok and gen is not None:
            dt = now - self._last_tok[0]
            if dt > 0:
                gen_tps = max(0.0, (gen - self._last_tok[1]) / dt)
        self._last_tok = (now, gen or 0.0)
        model = self.inference.get("model")
        if not model:
            d = json.loads(urllib.request.urlopen(VLLM + "/v1/models", timeout=3).read())
            model = d["data"][0]["id"]
        gpu = None
        if NVIDIA_SMI:
            try:
                out = subprocess.run([NVIDIA_SMI, "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                                     capture_output=True, text=True, timeout=3).stdout.strip().splitlines()
                gpu = int(out[0]) if out and out[0].strip().isdigit() else None
            except Exception:
                gpu = None
        with self.lock:
            self.inference = {
                "ok": True, "model": model, "where": "vLLM on this GB10 (127.0.0.1:18300)",
                "gen_tps": round(gen_tps, 1) if gen_tps is not None else None,
                "running": int(running or 0), "waiting": int(waiting or 0),
                "generation_tokens_total": int(gen or 0), "prompt_tokens_total": int(prompt or 0),
                "gpu_util": gpu, "cloud_model": None,
            }

    def _poll_runs(self):
        if not self.job_id:
            rc, out = sandbox(["openclaw", "automations", "list", "--json"], timeout=60)
            jobs = first_json(out).get("jobs", [])
            self.job_id = next((j["id"] for j in jobs if j.get("name") == "storm-watch"), None)
            if not self.job_id:
                return
        rc, out = sandbox(["openclaw", "automations", "runs", "--id", self.job_id], timeout=60)
        entries = first_json(out).get("entries", [])[:5]
        runs = []
        for e in entries:
            usage = e.get("usage") or {}
            runs.append({
                "time": e.get("tsIso") or e.get("runAtIso"),
                "status": e.get("status"), "delivered": e.get("deliveryStatus"),
                "seconds": round((e.get("durationMs") or 0) / 1000, 1),
                "model": e.get("model"), "provider": e.get("provider"),
                "tokens_in": usage.get("input_tokens"), "tokens_out": usage.get("output_tokens"),
                "text": (e.get("summary") or "")[:1200],
                "channel": {"telegram": "Telegram", "slack": "Slack", "discord": "Discord"}.get(
                    ((e.get("delivery") or {}).get("resolved") or {}).get("channel"), "chat"),
            })
        with self.lock:
            known = {r["time"] for r in self.runs}
            fresh = [r for r in runs if r["time"] not in known]
            if self.runs or not fresh:  # don't replay old runs as news on startup
                for r in reversed(fresh):
                    self._event("llm", f"Wrote the storm alert with {r['model'] or 'the local model'} on this GB10"
                                       f" and sent it to {r['channel'] or 'Telegram'} ({r['seconds']} s,"
                                       f" {r['tokens_out'] or '?'} tokens written)")
            self.runs = runs

    # ------------------------------------------------------------ ask the agent

    def ask(self, question):
        q = " ".join(str(question or "").split())[:300]
        if not q:
            return 400, {"ok": False, "error": "type a question first"}
        if not self.has_sandbox:
            return 503, {"ok": False, "error": "the agent sandbox is not on this machine"}
        with self.lock:
            if self.ask_state and self.ask_state["status"] == "working":
                return 409, {"ok": False, "error": "the agent is still answering the last question"}
            self.seq += 1
            ask_id = f"ask-{int(time.time())}"
            self.ask_state = {"id": ask_id, "question": q, "status": "working",
                              "started": iso(now_utc()), "answer": None, "seconds": None}
            self._event("ask", f"Question from the console: {q}")
        threading.Thread(target=self._run_ask, args=(ask_id, q), daemon=True).start()
        return 200, {"ok": True, "id": ask_id}

    def _run_ask(self, ask_id, q):
        t0 = time.time()
        prompt = ("Question from the ops console, shown on a big screen. Answer in 2 to 5 short plain-text"
                  " lines. Use your scripts for every number. Question: " + q)
        try:
            rc, out = sandbox(["openclaw", "agent", "--session-id", f"console-{ask_id}",
                               "--message", prompt, "--timeout", "150"], timeout=200)
            answer = out if rc == 0 and out else f"The agent did not answer (exit {rc})."
            status = "done" if rc == 0 and out else "failed"
        except subprocess.TimeoutExpired:
            answer, status = "The agent took too long to answer.", "failed"
        except Exception as e:
            answer, status = f"Could not reach the agent: {e}", "failed"
        secs = round(time.time() - t0, 1)
        with self.lock:
            if self.ask_state and self.ask_state["id"] == ask_id:
                self.ask_state.update(status=status, answer=answer[:2000], seconds=secs)
            self._event("llm", f"Answered the console question in {secs} s" if status == "done"
                        else "Could not answer the console question")

    # ------------------------------------------------------------ view

    def snapshot(self):
        with self.lock:
            return {"seq": self.seq, "checks": self.checks, "last_check": self.last_check,
                    "events": list(self.events[-20:]), "runs": list(self.runs[:3]),
                    "inference": dict(self.inference), "ask": dict(self.ask_state) if self.ask_state else None,
                    "sandbox": self.has_sandbox}
