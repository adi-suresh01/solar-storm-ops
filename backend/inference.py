"""Deep analysis: one long-context briefing from the local model, streamed to the console.

GET /inference/analysis[?thinking=1] answers with Server-Sent Events. The prompt is built
from live engine data (space weather, risk, timeline, operator files and every satellite
below 450 km), sent to the local vLLM server on this machine, and the answer is streamed
back token by token with timing, so the console can show prefill and decode speed.

Events (each `data: {json}` + blank line):
  start         {model, context_window, rows, prompt_chars, prompt_tokens (exact, or null), task}
  prefill_done  {ttft_s}
  thinking      {text}            only when reasoning is on and the model streams it
  delta         {text}
  stats         {completion_tokens, elapsed_s, tps}   about every 0.5 s while decoding
  done          {prompt_tokens, completion_tokens, ttft_s, prefill_tps, decode_tps, total_s}
  error         {message}
"""
import json
import os
import threading
import time
import urllib.request

from watcher import ROOT, log

VLLM = os.environ.get("SSO_VLLM", "http://127.0.0.1:18300")
DEFAULT_CONTEXT = 131072
SHELL_KM = 450
_busy = threading.Lock()

TASK_LINE = ("Read every satellite below 450 km, the space weather, the risk picture, recent"
             " events and the operator files, then write an operations briefing.")

SYSTEM = (
    "You are the flight dynamics analyst for a satellite operator. You run on the operator's"
    " own machine. The data you get is real public data (NOAA SWPC space weather, CelesTrak"
    " Starlink orbits, GFZ Potsdam Kp archive) except anything marked MOCK or SIMULATED, and"
    " you keep those labels when you mention it. Use only numbers that appear in the data."
    " Never invent or estimate a number. Write plain text with short headed sections. No"
    " markdown tables, no bold, no emoji."
)

TASK = """Write an operations briefing with exactly these sections:

Situation
2 to 3 lines: mode and time, Kp now, the alert level and what it means for this fleet.

Most exposed satellites
The 10 lowest satellites in the table, one per line: name, altitude in km, risk band, and a
short reason (altitude, and the storm shift if the band is above what altitude alone gives).

Altitude shells
The table only holds satellites below 450 km. For each risk band, give the count from the
risk picture, and the lowest altitude only if that band has rows in the table.

Recommended actions
Tie each action to the operator runbook and to the open plan, if there is one.

Next 72 hours
What to watch, from the Kp forecast: the highest forecast Kp and when."""


def _model():
    d = json.loads(urllib.request.urlopen(VLLM + "/v1/models", timeout=5).read())
    m = d["data"][0]
    return m["id"], int(m.get("max_model_len") or DEFAULT_CONTEXT)


def _count_tokens(model, messages):
    """Exact prompt size from vLLM's tokenizer, or None if the endpoint is missing."""
    try:
        req = urllib.request.Request(VLLM + "/tokenize", data=json.dumps({"model": model, "messages": messages}).encode(),
                                     headers={"Content-Type": "application/json"})
        return int(json.loads(urllib.request.urlopen(req, timeout=10).read())["count"])
    except Exception:
        return None


def _ops_file(name):
    p = os.path.join(ROOT, "ops-data", name)
    try:
        with open(p) as f:
            return f.read().strip()
    except OSError:
        return "(not available)"


def build_prompt(engine):
    """Everything the model reads, from the engine as it is right now."""
    st, rk, tl = engine.state(), engine.risk(), engine.timeline()[-10:]
    with engine.lock:
        sats = json.loads(engine.pos_bytes).get("sats", [])
    rows = sorted((s for s in sats if s["alt_km"] < SHELL_KM), key=lambda s: s["alt_km"])
    lines = ["id,name,alt_km,risk_now,lat,lon,note"]
    for s in rows:
        note = "SIMULATED" if s.get("simulated") else ""
        if s.get("protected"):
            note = (note + " protected").strip()
        lines.append(f"{s['id']},{s['name']},{s['alt_km']:.1f},{s['risk']},{s['lat']:.1f},{s['lon']:.1f},{note}")

    weather = {k: st.get(k) for k in ("mode", "sim_time", "note", "kp_now", "kp_history", "kp_forecast",
                                      "xray", "scales", "solar_wind_kms", "imf_bz_nt", "l1_monitors",
                                      "cme", "alert", "launch")}
    risk = {k: rk.get(k) for k in ("storm_factor", "kp_peak_forecast", "bands", "groups", "recommendation")}
    events = "\n".join(f"{e['time']} {e['kind']}: {e['text']}" for e in tl) or "(none)"
    data = "\n\n".join([
        "SPACE WEATHER NOW (JSON)\n" + json.dumps(weather, separators=(",", ":")),
        "RISK PICTURE (JSON). risk bands by altitude: critical below 250 km, high 250 to 350,"
        " watch 350 to 450, fine above 450; a forecast storm (Kp 5 or more) raises every"
        " satellite one band, Kp 7 or more two bands.\n" + json.dumps(risk, separators=(",", ":")),
        "LAST EVENTS\n" + events,
        "OPERATOR RUNBOOK (MOCK)\n" + _ops_file("runbook.md"),
        "LAUNCH SCHEDULE (MOCK)\n" + _ops_file("launch_schedule.json"),
        "MANEUVER BUDGET (MOCK)\n" + _ops_file("maneuver_budget.json"),
        f"EVERY SATELLITE BELOW {SHELL_KM} KM ({len(rows)} rows, lowest first, CSV)\n" + "\n".join(lines),
    ])
    user = data + "\n\n" + TASK
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], len(rows)


def _sse(handler, obj):
    handler.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
    handler.wfile.flush()


def serve_analysis(handler, engine, thinking=False):
    """Write the whole SSE response to `handler` (a BaseHTTPRequestHandler)."""
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()
    if not _busy.acquire(blocking=False):
        _sse(handler, {"type": "error", "message": "an analysis is already running"})
        return
    resp = None
    try:
        try:
            model, ctx = _model()
        except Exception as e:
            _sse(handler, {"type": "error", "message": f"the local model server is not answering ({e})"})
            return
        messages, rows = build_prompt(engine)
        chars = sum(len(m["content"]) for m in messages)
        _sse(handler, {"type": "start", "model": model, "context_window": ctx, "rows": rows,
                       "prompt_chars": chars, "prompt_tokens": _count_tokens(model, messages),
                       "task": TASK_LINE})
        body = {"model": model, "messages": messages, "stream": True,
                # reasoning eats tokens before the answer starts, so give it more room
                "stream_options": {"include_usage": True}, "max_tokens": 3500 if thinking else 900,
                "temperature": 0.2,
                "chat_template_kwargs": {"enable_thinking": bool(thinking)}}
        req = urllib.request.Request(VLLM + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        t0 = time.time()
        resp = urllib.request.urlopen(req, timeout=300)
        t_first = None
        approx_tokens, text_chars, usage = 0, 0, None
        last_stats = 0.0
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            chunk = json.loads(payload)
            if chunk.get("usage"):
                usage = chunk["usage"]
            for ch in chunk.get("choices") or []:
                d = ch.get("delta") or {}
                reasoning = d.get("reasoning_content") or d.get("reasoning")
                content = d.get("content")
                if (reasoning or content) and t_first is None:
                    t_first = time.time()
                    _sse(handler, {"type": "prefill_done", "ttft_s": round(t_first - t0, 2)})
                if reasoning:
                    approx_tokens += 1
                    _sse(handler, {"type": "thinking", "text": reasoning})
                if content:
                    approx_tokens += 1
                    text_chars += len(content)
                    _sse(handler, {"type": "delta", "text": content})
            now = time.time()
            el = now - t_first if t_first is not None else 0
            if el >= 0.5 and now - last_stats >= 0.5:
                last_stats = now
                # speculative decoding can put several tokens in one chunk, so also
                # estimate from characters (about 3.3 per token for this kind of text)
                n = max(approx_tokens, int(text_chars / 3.3))
                _sse(handler, {"type": "stats", "completion_tokens": n, "elapsed_s": round(now - t0, 1),
                               "tps": round(n / el, 1)})
        t_end = time.time()
        ttft = (t_first or t_end) - t0
        prompt_tokens = (usage or {}).get("prompt_tokens")
        completion = (usage or {}).get("completion_tokens") or max(approx_tokens, int(text_chars / 3.3))
        decode_s = t_end - (t_first or t_end)
        _sse(handler, {"type": "done", "prompt_tokens": prompt_tokens, "completion_tokens": completion,
                       "ttft_s": round(ttft, 2),
                       "prefill_tps": round(prompt_tokens / ttft) if prompt_tokens and ttft > 0 else None,
                       "decode_tps": round((completion - 1) / decode_s, 1) if decode_s > 0 and completion > 1 else None,
                       "total_s": round(t_end - t0, 1)})
        log(f"analysis: {rows} rows, {prompt_tokens} prompt tokens, ttft {ttft:.2f}s, {completion} out")
    except (BrokenPipeError, ConnectionResetError):
        log("analysis: console disconnected, stopping")
    except Exception as e:
        log(f"analysis failed: {e!r}")
        try:
            _sse(handler, {"type": "error", "message": f"analysis failed: {e}"})
        except Exception:
            pass
    finally:
        if resp is not None:
            try:
                resp.close()  # closing the stream makes vLLM abort the request
            except Exception:
                pass
        _busy.release()
