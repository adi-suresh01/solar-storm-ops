// Condition script for the "storm-watch" automation (runs every 30 s).
// Peeks at the data API. Fires once per plan and level; the first line of the
// alert ("SOLAR STORM WARNING - plan rec-004") is the dedupe key.
const API = "http://host.openshell.internal:18310";
const res = await exec({ command: `curl -s -m 10 '${API}/check?peek=1'` });
const out = String(res?.aggregated ?? "").trim();
const prev = trigger.state ?? {};
if (!out.startsWith("SOLAR STORM")) {
  json({ fire: false, state: prev });
} else {
  const key = out.split("\n")[0];
  if (key === prev.key) {
    json({ fire: false, state: prev });
  } else {
    // Mark it sent on the timeline. If the agent turn fails, state is not
    // saved, so the next check fires again from the peek.
    await exec({ command: `curl -s -m 10 -o /dev/null '${API}/check'` });
    json({ fire: true, message: out, state: { key } });
  }
}
