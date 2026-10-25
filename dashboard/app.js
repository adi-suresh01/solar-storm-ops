(() => {
  const params = new URLSearchParams(location.search);
  const apiBase = (params.get('api') || '').replace(/\/$/, '');
  const fixtureBase = '../fixtures/';
  const el = (id) => document.getElementById(id);
  const COLORS = { critical: '#ff6375', high: '#ff9d62', watch: '#f0cf70', fine: '#7891a5' };
  const app = { mode: 'live', state: null, risk: null, positions: null, timeline: [], launch: null, globe: null, points: [], loading: true, localRecommendation: null, localTimeline: null, lastPositionsAt: 0, lastPollAt: 0, useFixtures: !apiBase };

  const safeFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  };
  const fixture = (file) => safeFetch(`${fixtureBase}${file}`);
  const endpoint = (path) => apiBase ? `${apiBase}/${path}` : null;

  async function fetchDashboard(forcePositions = false) {
    if (app.useFixtures) {
      const [state, risk, timeline, positions] = await Promise.all([
        fixture('state.json'), fixture('risk.json'), fixture('timeline.json'),
        (forcePositions || !app.positions) ? fixture('positions.json') : Promise.resolve(app.positions)
      ]);
      app.state = state; app.risk = risk; app.timeline = timeline;
      if (forcePositions || !app.positions) app.positions = positions;
      return;
    }
    const [state, risk, timeline] = await Promise.all([
      safeFetch(endpoint('state')), safeFetch(endpoint('risk')), safeFetch(endpoint('timeline'))
    ]);
    app.state = state; app.risk = risk; app.timeline = timeline;
    if (forcePositions || !app.positions || Date.now() - app.lastPositionsAt > 10000) {
      app.positions = await safeFetch(endpoint('positions'));
      app.lastPositionsAt = Date.now();
    }
  }

  async function loadLaunchSchedule() {
    try { app.launch = await safeFetch('../ops-data/launch_schedule.json'); }
    catch { app.launch = { label: 'MOCK', launches: [] }; }
    renderLaunches();
  }

  function formatTime(value, includeDate = false) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-US', includeDate
      ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }
      : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }).format(date);
  }
  function formatNum(value, digits = 1) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'; }
  function levelFromKp(kp) { return kp >= 7 ? 'critical' : kp >= 5 ? 'warning' : kp >= 4 ? 'watch' : 'none'; }
  function currentLevel() { return app.state?.alert?.level || levelFromKp(app.state?.kp_now || 0); }
  function setText(id, text) { el(id).textContent = text ?? '—'; }
  function renderClock() { setText('clock', `${formatTime(new Date().toISOString())} UTC`); }

  function render() {
    if (!app.state || !app.risk || !app.positions) return;
    renderWeather(); renderAlert(); renderRisk(); renderTimeline(); renderRecommendation(); renderGlobe();
    setText('mode-tag', `${app.mode === 'live' ? 'LIVE' : app.mode.toUpperCase()} / ${apiBase ? 'API' : 'FIXTURES'}`);
    setText('footer-mode', apiBase ? `LIVE API · ${apiBase}` : 'FIXTURE DATA · NO LIVE CONNECTION');
    setText('connection-label', apiBase ? 'API CONNECTED' : 'FIXTURE MODE');
    setText('positions-source', apiBase ? 'LIVE GP DATA' : 'PUBLIC GP DATA');
    el('connection-label').style.color = apiBase ? 'var(--teal)' : '#dfc873';
    document.querySelectorAll('.scenario-button').forEach((button) => button.classList.toggle('active', button.dataset.scenario === app.mode));
  }

  function renderWeather() {
    const state = app.state;
    const kp = Number(state.kp_now || 0);
    const forecast = Array.isArray(state.kp_forecast) ? state.kp_forecast : [];
    const peak = forecast.reduce((max, item) => Math.max(max, Number(item.kp) || 0), kp);
    setText('kp-now', formatNum(kp, 1));
    const gauge = el('kp-gauge');
    gauge.style.setProperty('--kp-progress', `${Math.min(100, (kp / 9) * 100)}%`);
    gauge.style.setProperty('--kp-color', kp >= 7 ? COLORS.critical : kp >= 5 ? COLORS.high : kp >= 4 ? COLORS.watch : 'var(--teal)');
    gauge.setAttribute('aria-label', `Current Kp ${formatNum(kp, 1)} out of 9`);
    setText('kp-status', kp >= 7 ? 'Severe geomagnetic storm' : kp >= 5 ? 'Geomagnetic storm' : kp >= 4 ? 'Elevated activity' : 'Quiet conditions');
    setText('kp-peak', `Forecast peak ${formatNum(peak, 1)} · next 3 days`);
    setText('xray-class', state.xray?.class || 'n/a');
    setText('xray-flux', state.xray?.flux == null ? 'Flux n/a' : `Flux ${Number(state.xray.flux).toExponential(1)} W/m²`);
    setText('solar-wind', state.solar_wind_kms == null ? '—' : Math.round(state.solar_wind_kms));
    setText('scale-r', state.scales?.R ?? '—'); setText('scale-s', state.scales?.S ?? '—'); setText('scale-g', state.scales?.G ?? '—');
    setText('weather-stamp', app.mode === 'live' ? 'NOAA / SWPC' : 'HISTORICAL REPLAY');
    renderSparkline(forecast);
  }

  function renderSparkline(values) {
    const box = el('kp-forecast');
    if (!values.length) { box.innerHTML = ''; return; }
    const width = 180, height = 36, pad = 3;
    const points = values.map((item, index) => `${pad + index * (width - 2 * pad) / Math.max(1, values.length - 1)},${height - pad - Math.min(9, Number(item.kp) || 0) / 9 * (height - 2 * pad)}`).join(' ');
    const area = `${pad},${height} ${points} ${width - pad},${height}`;
    box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Kp forecast trend"><defs><linearGradient id="kp-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#62e0c0" stop-opacity=".22"/><stop offset="1" stop-color="#62e0c0" stop-opacity="0"/></linearGradient></defs><polygon points="${area}" fill="url(#kp-fill)"/><polyline points="${points}" fill="none" stroke="#62e0c0" stroke-width="1.5" vector-effect="non-scaling-stroke"/><line x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" stroke="#263a43" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderAlert() {
    const level = currentLevel();
    const strip = el('alert-strip');
    strip.className = `alert-strip alert-${level === 'none' ? 'none' : level}`;
    const names = { none: 'ALL SYSTEMS NOMINAL', watch: 'SPACE WEATHER WATCH', warning: 'STORM WARNING · ACTION REVIEW', critical: 'CRITICAL SPACE WEATHER' };
    setText('alert-title', names[level] || 'SPACE WEATHER UPDATE');
    setText('alert-summary', app.state.alert?.summary || 'Space weather monitoring is active.');
    setText('alert-time', app.state.sim_time ? `${formatTime(app.state.sim_time, true)} UTC` : 'MONITORING');
    setText('alert-icon', level === 'none' ? '✳' : level === 'watch' ? '◉' : '⚠');
  }

  function renderRisk() {
    const bands = app.risk.bands || {};
    ['critical', 'high', 'watch', 'fine'].forEach((band) => setText(`count-${band}`, Number(bands[band] || 0).toLocaleString('en-US')));
    setText('sat-total', Number(app.positions.count || app.positions.sats?.length || 0).toLocaleString('en-US'));
    setText('position-time', `POSITION EPOCH ${formatTime(app.positions.time, true).toUpperCase()} UTC`);
  }

  function renderTimeline() {
    const list = el('timeline-list');
    const events = app.localTimeline || app.timeline || [];
    setText('timeline-count', `${events.length} EVENT${events.length === 1 ? '' : 'S'}`);
    if (!events.length) { list.innerHTML = '<div class="timeline-empty">No events recorded yet. Monitoring is active.</div>'; return; }
    list.innerHTML = events.slice(-12).reverse().map((event) => {
      const kind = ['alert', 'approval', 'action'].includes(event.kind) ? event.kind : 'info';
      return `<div class="timeline-event"><span class="event-time">${escapeHtml(formatTime(event.time))}Z</span><i class="event-marker ${kind}"></i><span class="event-text">${escapeHtml(event.text || '')}</span></div>`;
    }).join('');
  }

  function renderRecommendation() {
    const rec = app.localRecommendation || app.risk.recommendation;
    const panel = el('recommendation-panel');
    const status = el('rec-status');
    const content = el('recommendation-content');
    const actions = el('approval-actions');
    if (!rec) {
      status.className = 'status-pill'; status.textContent = currentLevel() === 'none' ? 'CLEAR' : 'MONITORING';
      content.innerHTML = '<div class="clear-state"><span class="clear-check">✓</span><div><strong>No pending plan</strong><p>Monitoring continues. Any operational action requires a human decision.</p></div></div>';
      actions.hidden = true; return;
    }
    const state = rec.status || 'pending';
    status.className = `status-pill ${state}`; status.textContent = state.toUpperCase();
    const actionItems = (rec.actions || []).map((action) => `<li>${escapeHtml(action)}</li>`).join('');
    const headline = app.mode === 'feb2022' ? 'SIMULATED LAUNCH BATCH' : app.mode === 'may2024' ? 'ILLUSTRATIVE RISK REVIEW' : 'RECOMMENDED RESPONSE';
    content.innerHTML = `<div class="panel-kicker" style="margin-bottom:8px;color:#e4c975">${headline}</div><p class="recommendation-summary">${escapeHtml(rec.summary || 'Review the storm outlook and operator plan.')}</p><ul class="rec-actions">${actionItems}</ul><div class="rec-meta">PLAN ${escapeHtml(rec.id || 'DEMO')} · ${rec.deadline ? `REVIEW BY ${escapeHtml(formatTime(rec.deadline, true).toUpperCase())} UTC` : 'DEMO ONLY'}</div>`;
    const pending = state === 'pending';
    actions.hidden = !pending;
    panel.classList.toggle('has-pending', pending);
  }

  function renderLaunches() {
    const list = el('launch-list');
    const launches = app.launch?.launches || [];
    if (!launches.length) { list.innerHTML = '<div class="timeline-empty">No schedule loaded.</div>'; return; }
    list.innerHTML = launches.slice(0, 3).map((launch) => {
      const simulated = /L-12/i.test(`${launch.id || ''} ${launch.name || ''}`);
      return `<div class="launch-row"><strong class="launch-name">${escapeHtml(launch.id || launch.name || 'Launch')}</strong><span class="launch-badge ${simulated ? 'sim' : ''}">${simulated ? 'SIMULATED' : 'MOCK'}</span><span class="launch-window">${escapeHtml(launch.window_utc || launch.window || 'Window TBD')} · ${escapeHtml(launch.vehicle || '—')}</span></div>`;
    }).join('');
  }

  function renderGlobe() {
    const sats = app.positions.sats || [];
    if (!sats.length) { setText('globe-status', 'NO POSITION DATA'); return; }
    app.points = sats.map((sat) => ({ ...sat, color: COLORS[sat.risk] || COLORS.fine, altitude: Math.max(.015, Math.min(.16, Number(sat.alt_km || 400) / 6371 * 1.15)) }));
    setText('globe-status', `${app.points.length.toLocaleString('en-US')} OBJECTS · INTERACTIVE 3D VIEW`);
    if (!app.globe && typeof window.Globe === 'function') initGlobe();
    if (app.globe) app.globe.pointsData(app.points);
  }

  function initGlobe() {
    try {
      const globe = window.Globe()(el('globe'))
        .globeImageUrl('vendor/earth-dark.jpg')
        .backgroundColor('rgba(0,0,0,0)')
        .showAtmosphere(true).atmosphereColor('#4ca69c').atmosphereAltitude(.16)
        .pointsData(app.points).pointLat('lat').pointLng('lon').pointAltitude('altitude')
        .pointRadius((point) => point.risk === 'critical' ? .15 : .105)
        .pointColor('color').pointResolution(5)
        .pointLabel((point) => `<div class="tooltip"><strong>${escapeHtml(point.name || `SAT ${point.id}`)}</strong><br><small>${formatNum(point.alt_km)} km · ${escapeHtml((point.risk || 'fine').toUpperCase())}</small></div>`)
        .pointsMerge(true);
      globe.controls().autoRotate = true; globe.controls().autoRotateSpeed = .28;
      globe.controls().enableDamping = true; globe.controls().dampingFactor = .08;
      globe.pointOfView({ lat: 18, lng: -25, altitude: 2.35 }, 0);
      const resize = () => { const box = el('globe-wrap'); globe.width(box.clientWidth); globe.height(box.clientHeight); };
      window.addEventListener('resize', resize); resize();
      app.globe = globe;
      el('globe-loading').classList.add('hidden');
    } catch (error) {
      console.error('Globe initialization failed:', error);
      el('globe-loading').innerHTML = '<span>3D VIEW UNAVAILABLE · DATA PANELS REMAIN ACTIVE</span>';
      setText('globe-status', '3D VIEW UNAVAILABLE');
    }
  }

  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

  async function setScenario(scenario) {
    if (scenario === app.mode) return;
    document.querySelectorAll('.scenario-button').forEach((button) => { button.disabled = true; });
    try {
      app.localRecommendation = null; app.localTimeline = null;
      if (apiBase) {
        const response = await fetch(endpoint('replay'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario, speed: 360 }) });
        if (!response.ok) throw new Error(`Replay request failed: ${response.status}`);
        app.useFixtures = false;
      } else {
        app.useFixtures = true;
        await loadFixtureScenario(scenario);
      }
      app.mode = scenario;
      if (apiBase) await fetchDashboard(true);
      render();
    } catch (error) {
      console.error(error);
      showToast(`Could not load ${scenario} replay. ${error.message}`);
    } finally { document.querySelectorAll('.scenario-button').forEach((button) => { button.disabled = false; }); }
  }

  async function loadFixtureScenario(scenario) {
    if (scenario === 'live') {
      const [state, risk, timeline] = await Promise.all([fixture('state.json'), fixture('risk.json'), fixture('timeline.json')]);
      app.state = state; app.risk = risk; app.timeline = timeline; return;
    }
    const [baseState, baseRisk, positions, replay] = await Promise.all([fixture('state.json'), fixture('risk.json'), fixture('positions.json'), fixture('replay_kp.json')]);
    app.positions = positions;
    if (scenario === 'feb2022') {
      [app.state, app.risk, app.timeline] = await Promise.all([fixture('state_alert.json'), fixture('risk_alert.json'), fixture('timeline.json')]);
      app.state = { ...app.state, alert: { ...app.state.alert, summary: 'G1 storm expected. SIMULATED L-12 batch at ~210 km shown for demo; human approval required.' } };
      app.risk = { ...app.risk, recommendation: { ...app.risk.recommendation, status: 'pending' } };
      return;
    }
    const points = replay.may2024 || [];
    const peakPoint = points.reduce((best, item) => Number(item.kp) > Number(best?.kp || 0) ? item : best, null);
    const peak = Number(peakPoint?.kp || 9);
    const bands = baseRisk.bands;
    const shifted = { critical: bands.critical + bands.high, high: bands.watch, watch: bands.fine, fine: 0 };
    app.state = { ...baseState, mode: 'may2024', sim_time: peakPoint?.time || '2024-05-11T00:00:00Z', kp_now: peak,
      kp_history: points.slice(-12), kp_forecast: points.slice(-10), scales: { R: '2', S: '4', G: '5' }, solar_wind_kms: 900,
      xray: { class: 'X-class (historical event)', flux: null },
      alert: { level: 'critical', summary: 'May 2024 replay: historical Kp 9 storm against today’s constellation. Risk-band shift is illustrative; review actions with an operator.' } };
    app.risk = { ...baseRisk, time: app.state.sim_time, scenario: 'may2024', storm_factor: 2, kp_peak_forecast: peak, bands: shifted,
      groups: [{ name: 'Low-altitude satellites (illustrative)', count: shifted.critical, min_alt_km: 217, band: 'critical', action: 'Prioritize operator review of low-altitude assets' }],
      recommendation: { id: 'demo-may2024', status: 'pending', summary: 'Historical Kp 9 replay. Compare the storm timeline against the current constellation; these bands are an illustrative replay, not a forecast.', actions: ['Review low-altitude assets and current maneuver constraints', 'Confirm launch windows with the flight dynamics team', 'Reassess as storm conditions evolve'], deadline: null } };
    app.timeline = [
      { time: '2024-05-10T00:00:00Z', kind: 'info', text: 'May 2024 historical Kp replay loaded against today’s constellation.' },
      { time: peakPoint?.time || '2024-05-11T00:00:00Z', kind: 'alert', text: `Historical Kp ${formatNum(peak, 1)} peak shown. Risk-band shift is illustrative.` }
    ];
  }

  async function submitDecision(decision) {
    const rec = app.localRecommendation || app.risk.recommendation;
    if (!rec) return;
    const buttons = [el('approve-button'), el('reject-button')]; buttons.forEach((button) => { button.disabled = true; });
    try {
      if (apiBase) {
        const response = await fetch(endpoint('actions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recommendation_id: rec.id, decision: decision === 'approve' ? 'approved' : 'rejected', by: 'dashboard-operator', note: 'Decision submitted from the dashboard.' }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Action failed: ${response.status}`);
        await fetchDashboard(true);
      } else {
        const updated = { ...rec, status: decision === 'approve' ? 'approved' : 'rejected' };
        app.localRecommendation = updated;
        const now = new Date().toISOString();
        app.localTimeline = [...(app.localTimeline || app.timeline), { time: now, kind: 'approval', text: `${updated.status === 'approved' ? 'Approved' : 'Rejected'} in fixture demo by dashboard operator.` }];
        if (updated.status === 'approved') app.localTimeline.push({ time: new Date(Date.now() + 1000).toISOString(), kind: 'action', text: `Plan ${updated.id} logged for demo. No spacecraft command was sent.` });
      }
      render();
    } catch (error) { showToast(error.message); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
  }

  let toastTimer;
  function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
    toast.textContent = message; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
  }

  async function refresh() {
    try { await fetchDashboard(Date.now() - app.lastPositionsAt > 10000); app.lastPollAt = Date.now(); render(); }
    catch (error) {
      console.error('Data refresh failed:', error);
      if (apiBase) { setText('connection-label', 'API DISCONNECTED'); el('connection-label').style.color = 'var(--red)'; showToast('API unavailable. Retrying automatically.'); }
    }
  }

  document.querySelectorAll('.scenario-button').forEach((button) => button.addEventListener('click', () => setScenario(button.dataset.scenario)));
  el('approve-button').addEventListener('click', () => submitDecision('approve'));
  el('reject-button').addEventListener('click', () => submitDecision('reject'));
  el('refresh-button').addEventListener('click', () => refresh());

  renderClock(); setInterval(renderClock, 1000);
  Promise.all([fetchDashboard(true), loadLaunchSchedule()]).then(render).catch((error) => {
    console.error('Initial data load failed:', error);
    el('globe-loading').innerHTML = '<span>DATA UNAVAILABLE · CHECK LOCAL HTTP SERVER</span>';
    showToast('Could not load fixture data. Serve the repository over HTTP and retry.');
  });
  setInterval(refresh, apiBase ? 2000 : 10000);
})();
