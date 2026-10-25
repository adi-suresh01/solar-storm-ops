// Solar Storm Ops console: polls the local data API and drives the scene + panels.
import { createScene } from './scene.js';

const params = new URLSearchParams(location.search);
const API = (params.get('api') || location.origin).replace(/\/$/, '');
const REPLAY_SPEED = Number(params.get('speed') || 720);
const POS_EVERY_MS = Number(params.get('posEvery') || 10000);  // /positions is ~1 MB, keep it at 10 s
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LEVEL_RANK = { none: 0, watch: 1, warning: 2, critical: 3 };
const RISK = ['critical', 'high', 'watch', 'fine'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const scene = createScene($('scene'), $('labels'), { reducedMotion });
let state = null, risk = null, timeline = [], positions = null;
let posAt = 0, lastMode = null, lastLevel = null, busy = false;

async function get(path) {
  const r = await fetch(API + path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `${path} answered ${r.status}`);
  return out;
}

// ---------------------------------------------------------------- formatting
const kpInt = (kp) => Math.round(Number(kp) || 0);
function kpPhrase(kp) {
  const k = kpInt(kp);
  if (k >= 9) return 'Extreme geomagnetic storm, G5';
  if (k >= 8) return 'Severe geomagnetic storm, G4';
  if (k >= 7) return 'Strong geomagnetic storm, G3';
  if (k >= 6) return 'Moderate geomagnetic storm, G2';
  if (k >= 5) return 'Minor geomagnetic storm, G1';
  if (k >= 4) return 'Active, below storm level';
  if (k >= 3) return 'Unsettled';
  return 'Quiet';
}
function kpColor(kp) {
  const k = kpInt(kp);
  return k >= 7 ? 'var(--critical)' : k >= 5 ? 'var(--high)' : k >= 4 ? 'var(--watch)' : 'var(--kp-quiet)';
}
function utc(s) { return new Date(s); }
function fmtTime(s, withDate) {
  const d = utc(s);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return withDate ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm}` : hm;
}
function fmtDate(s) { const d = utc(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
const isReplay = () => state && state.mode !== 'live';

// ---------------------------------------------------------------- render
function renderClock() {
  if (!state || !isReplay()) {
    const now = new Date().toISOString();
    $('clock-main').textContent = `${now.slice(11, 19)} UTC`;
    $('clock-sub').textContent = `${fmtDate(now)}, live`;
  } else {
    $('clock-main').textContent = `${fmtDate(state.sim_time)}, ${fmtTime(state.sim_time)} UTC`;
    const r = state.replay || {};
    $('clock-sub').textContent = r.done ? 'Replay finished' : `Replay at ${r.speed || REPLAY_SPEED}x real time`;
  }
}

function renderKp() {
  const kp = Number(state.kp_now) || 0;
  $('kp-value').textContent = kp.toFixed(1);
  $('kp-value').style.color = kpColor(kp);
  $('kp-phrase').textContent = kpPhrase(kp);
  const past = (state.kp_history || []).slice(-16);
  const next = (state.kp_forecast || []).slice(0, 24);
  const bars = [...past.map((p) => ({ ...p, f: false })), ...next.map((p) => ({ ...p, f: true }))];
  const x0 = 20, x1 = 296, y0 = 112, y1 = 8, n = Math.max(bars.length, 1);
  const bw = (x1 - x0) / n, yk = (k) => y0 - (Math.min(9, k) / 9) * (y0 - y1);
  let svg = '';
  for (let g = 5; g <= 9; g++) {
    svg += `<line x1="${x0}" x2="${x1}" y1="${yk(g)}" y2="${yk(g)}" stroke="rgba(147,161,184,.14)" stroke-dasharray="2 3"/>`;
    svg += `<text x="${x1 + 4}" y="${yk(g) + 3}">G${g - 4}</text>`;
  }
  for (const k of [0, 3, 6, 9]) svg += `<text x="${x0 - 6}" y="${yk(k) + 3}" text-anchor="end">${k}</text>`;
  bars.forEach((b, i) => {
    const h = Math.max(1.5, y0 - yk(b.kp));
    const col = kpColor(b.kp);
    svg += b.f
      ? `<rect x="${x0 + i * bw + 0.8}" y="${y0 - h}" width="${bw - 1.6}" height="${h}" fill="${col}" fill-opacity=".28" stroke="${col}" stroke-opacity=".7" stroke-width=".8"/>`
      : `<rect x="${x0 + i * bw + 0.8}" y="${y0 - h}" width="${bw - 1.6}" height="${h}" fill="${col}"/>`;
  });
  const xn = x0 + past.length * bw;
  svg += `<line x1="${xn}" x2="${xn}" y1="${y1 - 4}" y2="${y0 + 3}" stroke="var(--ink-2)" stroke-width="1"/>`;
  svg += `<text x="${xn}" y="${y0 + 14}" text-anchor="middle" fill="var(--ink-2)">now</text>`;
  if (past[0]) svg += `<text x="${x0}" y="${y0 + 14}">${esc(fmtTime(past[0].time, true).split(' ').slice(0, 2).join(' '))}</text>`;
  if (next.length) svg += `<text x="${x1}" y="${y0 + 14}" text-anchor="end">${esc(fmtTime(next[next.length - 1].time, true).split(' ').slice(0, 2).join(' '))}</text>`;
  svg += `<line x1="${x0}" x2="${x1}" y1="${y0}" y2="${y0}" stroke="rgba(147,161,184,.35)"/>`;
  const caption = isReplay()
    ? 'Archived Kp from GFZ Potsdam, 3-hour bars. Right of now is the Kp that followed, standing in for a forecast (SIMULATED).'
    : 'Planetary Kp from NOAA, 3-hour bars. Past two days left of now, NOAA forecast right of now.';
  $('kp-chart').innerHTML = `<title>${esc(caption)}</title>` + svg;
}

function renderReadouts() {
  $('xray').textContent = state.xray?.class && state.xray.class !== 'n/a' ? state.xray.class : '-';
  const sc = state.scales || {};
  $('scales').textContent = ['R', 'S', 'G'].map((k) => (sc[k] && sc[k] !== 'n/a' ? `${k}${sc[k]}` : '')).filter(Boolean).join(' ') || '-';
  const bz = state.imf_bz_nt;
  $('bz').textContent = bz == null ? '-' : `${bz > 0 ? '+' : ''}${Number(bz).toFixed(1)} nT`;
  $('bz').title = 'North-south part of the magnetic field in the solar wind. Strongly negative (southward) is when storms start.';

  const rows = (state.l1_monitors || []).map((m) => `
    <tr class="${m.active ? 'active' : ''}">
      <td>${esc(m.label)}</td>
      <td class="num">${m.speed_kms == null ? '-' : Math.round(m.speed_kms) + ' km/s'}</td>
      <td class="num">${m.bz_nt == null ? '-' : (m.bz_nt > 0 ? '+' : '') + Number(m.bz_nt).toFixed(1) + ' nT'}</td>
    </tr>`).join('');
  $('l1-table').querySelector('tbody').innerHTML = rows;
  $('l1-caption').textContent = isReplay() ? 'Not in the replay data.' : rows ? '' : 'Waiting for the first reading.';
}

function renderDecision() {
  const lvl = state.alert?.level || 'none';
  const titles = { none: 'All quiet', watch: 'Watching the forecast', warning: 'Storm warning', critical: 'Storm under way' };
  $('alert').className = `alert level-${lvl}`;
  $('alert-title').textContent = titles[lvl] || 'Space weather update';
  let summary = state.alert?.summary || '';
  if (lvl === 'none') {
    const peak = Math.max(0, ...(state.kp_forecast || []).map((p) => Number(p.kp) || 0));
    summary = `No storm in the 3-day forecast (peak Kp ${peak.toFixed(1)}).`;
  }
  $('alert-summary').textContent = summary;

  $('groups').innerHTML = (risk.groups || []).map((g) => `
    <div class="group"><b>${esc(g.name)}</b><span class="n">${Number(g.count).toLocaleString('en-US')} sats</span>
    <span>${esc(g.action || '')}</span><span class="n">lowest ${Math.round(g.min_alt_km)} km</span></div>`).join('');

  const rec = risk.recommendation;
  const launch = state.launch;
  let tail = '';
  if (launch && launch.status === 'held') {
    tail = utc(state.sim_time) >= utc(launch.time)
      ? `<p class="counterfactual">${esc(launch.id)} stayed on the ground. In the real event, 49 satellites launched at this time and about 38 reentered within days.</p>`
      : `<p class="counterfactual">${esc(launch.id)} is on hold. Liftoff was set for ${esc(fmtDate(launch.time))}, ${esc(fmtTime(launch.time))} UTC.</p>`;
  }
  if (!rec) { $('plan').innerHTML = tail; return; }
  const hold = rec.kind === 'hold';
  const words = { pending: 'Needs a decision', approved: hold ? 'Launch held' : 'Approved',
    rejected: hold ? 'Launch goes ahead' : 'Rejected', expired: 'Expired at liftoff' };
  const decided = [...timeline].reverse().find((e) => e.kind === 'approval');
  const title = hold ? `Hold launch ${launch?.id || ''}` : 'Protect the satellites';
  let html = `<div class="plan-head"><b>${esc(title)}</b><span class="status ${esc(rec.status)}">${esc(words[rec.status] || rec.status)}</span></div>
    <p class="caption">Plan ${esc(rec.id)}</p>
    <ul>${(rec.actions || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
  let when = `${hold ? 'Decide before liftoff' : 'Act by'} ${esc(fmtDate(rec.deadline))}, ${esc(fmtTime(rec.deadline))} UTC`;
  if (hold && launch && launch.status === 'scheduled' && rec.status === 'pending') {
    const mins = Math.max(0, Math.round((utc(launch.time) - utc(state.sim_time)) / 60000));
    when += `<span class="countdown">, in ${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min</span>`;
  }
  html += `<p class="deadline">${when}</p>`;
  if (rec.status === 'pending') {
    html += `<div class="actions"><button class="approve" id="approve">${hold ? 'Hold the launch' : 'Approve plan'}</button><button class="reject" id="reject">${hold ? 'Let it launch' : 'Reject plan'}</button></div>
      <p class="hint">Or reply "approve" on Telegram.</p>`;
  } else if (decided) {
    html += `<p class="hint">${esc(decided.text)}</p>`;
  }
  $('plan').innerHTML = html + tail;
  $('approve')?.addEventListener('click', () => decide('approved'));
  $('reject')?.addEventListener('click', () => decide('rejected'));
}

function renderLog() {
  const items = [...timeline].reverse().slice(0, 16);
  const today = new Date().toISOString().slice(0, 10);
  $('log').innerHTML = items.map((e) => {
    const withDate = isReplay() || !String(e.time).startsWith(today);
    return `<li class="${esc(e.kind)}-kind"><time datetime="${esc(e.time)}">${esc(fmtTime(e.time, withDate))}</time><span>${esc(e.text)}</span></li>`;
  }).join('') || '<li><time></time><span>Nothing logged yet.</span></li>';
}

function renderLegend() {
  if (!positions) return;
  const counts = { critical: 0, high: 0, watch: 0, fine: 0, protected: 0 };
  for (const s of positions.sats) { if (s.protected) counts.protected++; else counts[s.risk] = (counts[s.risk] || 0) + 1; }
  const label = { critical: 'critical', high: 'high', watch: 'watch', fine: 'fine', protected: 'protected' };
  const sim = positions.sats.filter((s) => s.simulated).length;
  const parts = [`<span><b>${(positions.count - sim).toLocaleString('en-US')}</b> Starlink${sim ? ` + ${sim} SIMULATED` : ''}</span>`];
  for (const k of [...RISK, 'protected']) {
    if (k === 'protected' && !counts.protected) continue;
    parts.push(`<span><i style="background:var(--${k})"></i><b>${counts[k].toLocaleString('en-US')}</b> ${label[k]}</span>`);
  }
  $('legend').innerHTML = parts.join('');
}

function renderNote() {
  // short on screen, the full honesty note on hover
  let note = isReplay()
    ? 'Replay: real Kp from GFZ Potsdam. Forecast, launch L-12 and its satellites are SIMULATED.'
    : 'Live: NOAA SWPC, NASA ACE and IMAP, CelesTrak.';
  if (scene.view === 'sun') note += ' Sun to Earth view not to scale.';
  $('note').textContent = note;
  $('note').title = state.note || '';
}

function renderButtons() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === scene.view)));
}

function render() {
  if (!state || !risk) return;
  renderClock(); renderKp(); renderReadouts(); renderDecision(); renderLog(); renderLegend(); renderNote(); renderButtons();
}

// ---------------------------------------------------------------- actions
async function decide(decision) {
  const rec = risk?.recommendation;
  if (!rec || busy) return;
  busy = true;
  document.querySelectorAll('.actions button').forEach((b) => { b.disabled = true; });
  try {
    await post('/actions', { recommendation_id: rec.id, decision, by: 'dashboard:ops-lead', note: '' });
    posAt = 0;
    await poll();
  } catch (e) { showOffline(`Could not record the decision: ${e.message}`); }
  finally { busy = false; }
}

async function setMode(mode) {
  if (busy || (state && state.mode === mode)) return;
  busy = true;
  try {
    await post('/replay', { scenario: mode, speed: REPLAY_SPEED });
    posAt = 0;
    await poll();
  } catch (e) { showOffline(`Could not start ${mode}: ${e.message}`); }
  finally { busy = false; }
}

function showOffline(msg) { const el = $('offline'); el.textContent = msg; el.hidden = !msg; }

// ---------------------------------------------------------------- polling
async function poll() {
  try {
    [state, risk, timeline] = await Promise.all([get('/state'), get('/risk'), get('/timeline')]);
    if (Date.now() - posAt > POS_EVERY_MS) {
      positions = await get('/positions');
      posAt = Date.now();
      scene.setPositions(positions);
    }
    showOffline('');
  } catch (e) {
    showOffline(`Can't reach the data API at ${API} (${e.message}). Retrying every 2 seconds.`);
    return;
  }
  scene.setTime(new Date());
  const active = (state.l1_monitors || []).find((m) => m.active);
  scene.setWeather({ kpNow: Number(state.kp_now) || 0, windSpeed: active?.speed_kms || state.solar_wind_kms, l1: state.l1_monitors || [], level: state.alert?.level });

  // choreography: replays open on the Sun to Earth view; a new alert launches a CME,
  // then the camera comes back to the satellites at risk
  if (lastMode !== null && state.mode !== lastMode) scene.flyTo(state.mode === 'live' ? 'earth' : 'sun');
  const lvl = state.alert?.level || 'none';
  scene.setLaunch(state.launch);
  if (lastLevel !== null && LEVEL_RANK[lvl] > LEVEL_RANK[lastLevel] && LEVEL_RANK[lvl] >= 2 && state.mode === lastMode) {
    scene.launchCME();
    if (scene.view !== 'sun') scene.flyTo('sun', 2);
    const next = state.launch && state.launch.status === 'scheduled' ? 'site' : scene.hasBatch ? 'batch' : 'earth';
    setTimeout(() => scene.flyTo(next, 3), 8500);
  }
  lastMode = state.mode;
  lastLevel = lvl;
  render();
}

// ---------------------------------------------------------------- agent + local inference
let agent = null, lastAgentSeq = null, lastGpu = null;
const ago = (s) => {
  const sec = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 1000));
  return sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`;
};
const hms = (s) => new Date(s).toISOString().slice(11, 19);

function renderAgent() {
  if (!agent) return;
  const ask = agent.ask;
  const recent = (agent.events || []).filter((e) => Date.now() - new Date(e.time).getTime() < 8000);
  const working = (ask && ask.status === 'working') || recent.length > 0 || (agent.inference?.running > 0);
  $('agent').classList.toggle('working', !!working);
  $('agent-state').textContent = ask && ask.status === 'working' ? 'answering' : working ? 'working' : 'watching';
  $('agent-status').textContent = !agent.sandbox ? 'not on this machine'
    : agent.checks ? `${agent.checks.toLocaleString('en-US')} check${agent.checks === 1 ? '' : 's'}, last ${ago(agent.last_check)} ago` : 'waiting for first check';
  $('agent-status').title = 'The agent checks the risk by itself every 30 seconds.';

  $('agent-events').innerHTML = [...(agent.events || [])].reverse().slice(0, 3).map((e) => {
    const fresh = Date.now() - new Date(e.time).getTime() < 6000;
    return `<li class="${esc(e.kind)}${fresh ? ' fresh' : ''}"><time>${esc(hms(e.time).slice(0, 5))}</time><span title="${esc(e.text)}">${esc(e.text)}</span></li>`;
  }).join('');

  // only show the alert that belongs to the plan on screen, not one from an earlier run
  const recId = risk?.recommendation?.id;
  const run = (agent.runs || []).find((r) => recId && r.text && r.text.includes(recId));
  $('agent-msg').innerHTML = run && run.text ? `
    <div class="bubble">${esc(run.text)}</div>
    <p class="bubble-meta">Sent to ${esc(run.channel || 'Telegram')} at ${esc(hms(run.time).slice(0, 5))}, written on this GB10 in ${run.seconds} s</p>` : '';

  const btn = $('ask-button');
  btn.disabled = !!(ask && ask.status === 'working') || !agent.sandbox;
  if (!ask) $('ask-answer').innerHTML = '';
  else if (ask.status === 'working') {
    $('ask-answer').innerHTML = `<p class="ask-q">Working on it, ${esc(ago(ask.started))} so far</p>`;
  } else {
    $('ask-answer').innerHTML = `<p class="ask-q">${esc(ask.question)}</p><div class="answer">${esc(ask.answer || '')}</div>
      ${ask.status === 'done' ? `<p class="bubble-meta">Answered in ${ask.seconds} s on this GB10</p>` : ''}`;
  }

  const inf = agent.inference || {};
  if (inf.ok) {
    const tps = inf.gen_tps >= 1 ? `${Math.round(inf.gen_tps)} tokens/s` : 'idle';
    const gpu = inf.gpu_util ? `, GPU ${inf.gpu_util}%` : '';
    $('local-model').innerHTML = `<b>${esc(inf.model)}</b> on this GB10, ${esc(tps)}${esc(gpu)}`;
    $('local-detail').textContent = `${Number(inf.generation_tokens_total).toLocaleString('en-US')} tokens written locally. No cloud model.`;
    lastGpu = inf.gpu_util;
  }
}

async function pollAgent() {
  try { agent = await get('/agent'); } catch { return; }
  if (lastAgentSeq !== null && agent.seq > lastAgentSeq) scene.scan();
  lastAgentSeq = agent.seq;
  renderAgent();
}

$('ask-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('ask-input').value.trim();
  if (!q) return;
  $('ask-button').disabled = true;
  try {
    await post('/agent/ask', { question: q });
    $('ask-input').value = '';
  } catch (e) {
    $('ask-answer').innerHTML = `<p class="agent-status">${esc(e.message)}</p>`;
  }
  await pollAgent();
});

setInterval(pollAgent, 2000);
pollAgent();

// ---------------------------------------------------------------- deep analysis: the local model, streamed
let deepES = null, deepTimer = null;
function finishDeep() {
  if (deepES) deepES.close();
  deepES = null;
  clearInterval(deepTimer);
  $('deep-button').disabled = false;
}
function openDeep() {
  if (deepES) return;
  $('deep').hidden = false;
  $('deep').scrollIntoView({ block: 'start' });
  const textEl = $('deep-text'), thinkEl = $('deep-thinking'), bar = $('deep-progress').firstElementChild;
  textEl.innerHTML = '<span class="cursor"></span>';
  thinkEl.hidden = true; thinkEl.textContent = '';
  ['m-read', 'm-tps', 'm-gpu', 'm-time'].forEach((id) => { $(id).textContent = '-'; });
  ['m-read-s', 'm-tps-s', 'm-time-s'].forEach((id) => { $(id).textContent = ''; });
  $('deep-task').textContent = 'Starting the local model.';
  $('deep-button').disabled = true;
  bar.style.width = '0%';
  const t0 = performance.now();
  let ttft = null, estPrompt = 0, text = '', peakGpu = 0;
  deepTimer = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    $('m-time').textContent = el.toFixed(1);
    if (lastGpu != null) {
      peakGpu = Math.max(peakGpu, lastGpu);
      $('m-gpu').textContent = `${lastGpu}%`;
      $('m-gpu').dataset.peak = peakGpu;
    }
    if (ttft === null && estPrompt) bar.style.width = `${Math.min(95, (el / (estPrompt / 3000)) * 100)}%`;
  }, 200);
  const es = new EventSource(API + '/inference/analysis');
  deepES = es;
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'start') {
      estPrompt = ev.prompt_tokens || Math.round((ev.prompt_chars || 0) / 1.6);
      $('deep-task').textContent = `${ev.task || ''} ${ev.model} reads ${Number(ev.rows || 0).toLocaleString('en-US')} satellites, the forecast, the plan and the MOCK runbook (context window ${Math.round((ev.context_window || 0) / 1024)}k tokens).`;
      $('m-read').textContent = `${ev.prompt_tokens ? '' : '~'}${estPrompt.toLocaleString('en-US')}`;
      $('m-read-s').textContent = 'reading now';
    } else if (ev.type === 'prefill_done') {
      ttft = ev.ttft_s;
      bar.style.width = '100%';
      $('m-read-s').textContent = `read in ${Number(ev.ttft_s).toFixed(1)} s`;
    } else if (ev.type === 'thinking') {
      thinkEl.hidden = false;
      thinkEl.textContent += ev.text;
      thinkEl.scrollTop = thinkEl.scrollHeight;
    } else if (ev.type === 'delta') {
      text += ev.text;
      textEl.textContent = text;
      textEl.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
      textEl.scrollTop = textEl.scrollHeight;
    } else if (ev.type === 'stats') {
      $('m-tps').textContent = Math.round(ev.tps || 0);
      $('m-tps-s').textContent = `${ev.completion_tokens} written`;
    } else if (ev.type === 'done') {
      $('m-read').textContent = Number(ev.prompt_tokens).toLocaleString('en-US');
      $('m-read-s').textContent = `in ${Number(ev.ttft_s).toFixed(1)} s, ${Math.round(ev.prefill_tps).toLocaleString('en-US')} tokens/s`;
      $('m-tps').textContent = Math.round(ev.decode_tps);
      $('m-tps-s').textContent = `${ev.completion_tokens} tokens written`;
      $('m-time').textContent = Number(ev.total_s).toFixed(1);
      $('m-time-s').textContent = 'start to finish';
      if (peakGpu) $('m-gpu').textContent = `${peakGpu}%`;
      textEl.textContent = text;
      finishDeep();
    } else if (ev.type === 'error') {
      textEl.textContent = `${text ? text + '\n\n' : ''}Stopped: ${ev.message}`;
      finishDeep();
    }
  };
  es.onerror = () => {
    if (!deepES) return;  // normal end of stream after "done"
    textEl.textContent = `${text}\n\nThe stream from the data API broke off.`;
    finishDeep();
  };
}
$('deep-button').addEventListener('click', openDeep);
$('deep-close').addEventListener('click', () => { finishDeep(); $('deep').hidden = true; });

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { scene.flyTo(b.dataset.view); render(); }));
// clicked satellite: plain facts from the data, plus what the risk band means
const MU = 398600.4418, RE = 6371;
function baseBand(alt) { return alt < 250 ? 'critical' : alt < 350 ? 'high' : alt < 450 ? 'watch' : 'fine'; }
const BAND_RANGE = { critical: 'below 250 km', high: '250 to 350 km', watch: '350 to 450 km', fine: 'above 450 km' };
function renderSat(s) {
  const card = $('sat-card');
  if (!s) { card.hidden = true; return; }
  const a = RE + s.alt_km;
  const period = (2 * Math.PI * Math.sqrt(a ** 3 / MU)) / 60;
  const speed = Math.sqrt(MU / a);
  const base = baseBand(s.alt_km);
  const lat = `${Math.abs(s.lat).toFixed(1)} ${s.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(s.lon).toFixed(1)} ${s.lon >= 0 ? 'E' : 'W'}`;
  let why = s.risk === base
    ? `Risk comes from altitude: ${esc(base)} means ${BAND_RANGE[base]}.`
    : `At ${Math.round(s.alt_km)} km it is normally ${esc(base)}. The storm forecast raises it to ${esc(s.risk)}, because a storm heats and thickens the upper atmosphere and drag goes up.`;
  if (s.simulated) why += ' Part of launch batch L-12, a SIMULATED stand-in for the Feb 2022 launch.';
  if (s.protected) why += ' Protected by the approved plan.';
  card.style.setProperty('--sel', `var(--${s.protected ? 'protected' : s.risk})`);
  card.innerHTML = `
    <h2><span>${esc(s.name)}</span><button type="button" id="sat-close" aria-label="Clear selection">Clear</button></h2>
    <p class="caption">${s.simulated ? 'SIMULATED object' : `NORAD catalog number ${esc(s.id)}`}</p>
    <dl>
      <dt>Altitude</dt><dd>${Math.round(s.alt_km)} km</dd>
      <dt>Risk</dt><dd>${esc(s.protected ? 'protected' : s.risk)}</dd>
      <dt>Over</dt><dd>${lat}, ${lon}</dd>
      <dt>One orbit</dt><dd>${period.toFixed(1)} min at ${speed.toFixed(2)} km/s</dd>
    </dl>
    <p class="why">${why}</p>`;
  card.hidden = false;
  $('sat-close').addEventListener('click', () => scene.clearSelection());
}
scene.onSelect(renderSat);

scene.onHover((h) => {
  const tip = $('tooltip');
  if (!h || !h.sat) { tip.hidden = true; return; }
  const s = h.sat;
  const tags = [s.simulated ? 'SIMULATED' : '', s.protected ? 'protected' : ''].filter(Boolean).join(', ');
  tip.innerHTML = `<b>${esc(s.name)}</b>${Math.round(s.alt_km)} km, ${esc(s.risk)}${tags ? ` (${esc(tags)})` : ''}`;
  const r = $('scene').getBoundingClientRect();  // hover coords are relative to the globe window
  tip.style.left = `${r.left + h.x + 14}px`;
  tip.style.top = `${r.top + h.y + 14}px`;
  tip.hidden = false;
});

// ---------------------------------------------------------------- resizable globe band
(() => {
  const band = document.querySelector('.globe');
  const handle = $('globe-resize');
  const KEY = 'spf5000-globe-h';
  const maxH = () => window.innerHeight - document.querySelector('.bar').offsetHeight;
  // default: the globe fills the screen down to the strip, so the strip stays visible
  const defaultH = () => Math.max(340, maxH() - document.querySelector('.strip').offsetHeight);
  let custom = false;
  const set = (h, remember = true) => {
    h = Math.max(240, Math.min(maxH(), h));
    band.style.height = `${h}px`;
    if (remember) { custom = true; try { localStorage.setItem(KEY, String(Math.round(h))); } catch { /* private mode */ } }
  };
  const reset = () => {
    custom = false;
    band.style.height = `${defaultH()}px`;
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  };
  let saved = 0;
  try { saved = Number(localStorage.getItem(KEY)) || 0; } catch { /* private mode */ }
  const forced = Number(params.get('band')) || 0;  // ?band=480 for screenshots
  if (forced) { custom = true; set(forced, false); }
  else if (saved) { custom = true; set(saved, false); } else band.style.height = `${defaultH()}px`;
  window.addEventListener('resize', () => { if (!custom) band.style.height = `${defaultH()}px`; });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const y0 = e.clientY, h0 = band.getBoundingClientRect().height;
    const move = (ev) => set(h0 + ev.clientY - y0);
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => {
    if (Math.abs(band.getBoundingClientRect().height - defaultH()) < 20) set(Math.round(maxH() * 0.55)); else reset();
  });
  handle.addEventListener('keydown', (e) => {
    const h = band.getBoundingClientRect().height;
    if (e.key === 'ArrowDown') { e.preventDefault(); set(h + 40); }
    if (e.key === 'ArrowUp') { e.preventDefault(); set(h - 40); }
  });
})();

if (params.get('view')) setTimeout(() => scene.flyTo(params.get('view'), 0.01), 1500);
if (params.get('cme')) setTimeout(() => scene.launchCME(), Number(params.get('cme')));  // for screenshots
if (params.get('select')) setTimeout(() => scene.selectId(params.get('select')), 12500);  // for screenshots
if (params.get('scan')) setTimeout(() => scene.scan(), Number(params.get('scan')));  // for screenshots
if (params.get('deep')) setTimeout(() => $('deep-button').click(), Number(params.get('deep')));  // for screenshots
setInterval(renderClock, 1000);
setInterval(poll, 2000);
poll();
