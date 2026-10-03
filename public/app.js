/* Mutual Consent Check-in — single-page client (no framework, no third-party requests). */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const controls = $('#controls');
  const STORE = 'consent-session';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDur = (ms) => {
    ms = Math.max(0, ms); const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
  };

  let config = { boundaries: [] };
  let sess = load();          // { sessionId, token, role, qr, joinUrl }
  let state = null;           // last server view
  let clockSkew = 0;
  let screenKey = null;
  let ws = null, wsRetry = 0, pollTimer = null;
  let localEnded = null;      // optimistic end ('withdrawn') so Stop is instant even offline
  let ui = { screen: 'home', error: '' };

  function load() { try { return JSON.parse(sessionStorage.getItem(STORE)) || null; } catch { return null; } }
  function save() { sess ? sessionStorage.setItem(STORE, JSON.stringify(sess)) : sessionStorage.removeItem(STORE); }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json', ...(sess ? { 'X-Session-Token': sess.token } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
    });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  // ---------------------------------------------------------------- realtime
  function connect() {
    disconnect();
    if (!sess) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sess.sessionId)}&token=${encodeURIComponent(sess.token)}`);
    ws.onopen = () => { wsRetry = 0; };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'state') setState(m.state);
      else if (m.type === 'deleted' || m.type === 'gone') goneFromServer();
    };
    ws.onclose = () => {
      ws = null;
      if (!sess || isEnded()) return;
      setTimeout(connect, Math.min(8000, 500 * 2 ** wsRetry++));
    };
    clearInterval(pollTimer);
    // Polling fallback: if the socket isn't open, poll every 2s.
    pollTimer = setInterval(() => { if (sess && (!ws || ws.readyState !== 1)) refresh(); }, 2000);
  }
  function disconnect() { if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; } clearInterval(pollTimer); }
  async function refresh() {
    if (!sess) return;
    try { setState(await api('GET', `/api/sessions/${sess.sessionId}`)); }
    catch (e) { if (e.status === 404 || e.status === 403) goneFromServer(); }
  }
  function goneFromServer() {
    // Session no longer exists on the server (deleted, restarted, or expired & purged). Consent is NOT active.
    if (state && ['withdrawn', 'expired'].includes(state.status)) { state = { ...state, recordsDeleted: true }; render(); return; }
    state = { status: 'gone', role: sess?.role }; render();
    disconnect();
  }
  function isEnded() { const st = localEnded || state?.status; return ['withdrawn', 'expired', 'gone'].includes(st); }

  function setState(s) {
    if (localEnded && s.status !== 'withdrawn' && s.status !== 'expired') return; // never let a stale update "un-stop"
    if (state && state.status !== s.status && ['withdrawn', 'expired'].includes(s.status)) buzz();
    state = s; clockSkew = s.serverTime - Date.now();
    if (isEnded()) disconnectSoon();
    render();
  }
  let dsTimer; function disconnectSoon() { clearTimeout(dsTimer); dsTimer = setTimeout(() => { if (ws) { ws.onclose = null; ws.close(); ws = null; } clearInterval(pollTimer); }, 1500); }
  function buzz() { try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {} }

  // ---------------------------------------------------------------- screens
  function computeKey() {
    if (!sess) return `out:${ui.screen}`;
    if (localEnded) return 'ended:withdrawn';
    if (!state) return 'loading';
    const st = state.status;
    if (['withdrawn', 'expired', 'gone'].includes(st)) return `ended:${st}:${state.recordsDeleted ? 'del' : ''}`;
    if (st === 'paused') return state.you.ready ? 'paused:ready' : 'paused:mine';
    if (st === 'active') return 'active';
    return state.you.confirmed ? 'waitpartner' : 'confirm';
  }

  function render() {
    const key = computeKey();
    const inSession = !!sess && !isEnded() && !!state;
    document.body.classList.toggle('in-session', inSession);
    controls.classList.toggle('hidden', !inSession);
    $('#pauseBtn').disabled = !(state && state.status === 'active' && !localEnded);
    if (key !== screenKey) { screenKey = key; app.innerHTML = screens(key); bind(key); window.scrollTo(0, 0); }
    renderLive();
  }

  const resources = () => `<p class="resources">Need support? RAINN 24/7: <a href="tel:18006564673">1-800-656-4673</a> · <a href="https://rainn.org" target="_blank" rel="noopener noreferrer">rainn.org</a></p>`;
  const disclaimer = (title = 'Before you start') => `
    <div class="disclaimer" role="note">
      <strong>${title}</strong>
      <ul>
        <li>Consent can be withdrawn <b>at any moment, by words or actions</b> — whatever this app shows.</li>
        <li>This is a communication tool, <b>not legal proof of consent</b>.</li>
        <li>Someone who is <b>intoxicated, asleep, pressured, or under 18 can't consent</b>.</li>
      </ul>
    </div>`;

  function screens(key) {
    const err = ui.error ? `<div class="error" role="alert">${esc(ui.error)}</div>` : '';
    switch (key) {
      case 'out:home': return `
        <h1>Check in with each other</h1>
        <p class="muted">A simple, private way for two adults to confirm they both want to — and to stop at any time. Nicknames only. Nothing is shared.</p>
        <div class="card">
          <button class="btn btn-primary" id="goCreate">Start a session</button>
          <button class="btn btn-secondary" id="goJoin">Join with a code</button>
        </div>
        ${disclaimer()}${resources()}`;
      case 'out:create': return `
        <h1>Start a session</h1>
        <form class="card" id="createForm">
          <label class="field" for="nick">Nickname (optional)</label>
          <input type="text" id="nick" maxlength="24" autocomplete="off" placeholder="e.g. Sam, Blue, ☀️">
          <p class="muted">No real name needed. You'll get a code to show the other person.</p>
          ${err}<button class="btn btn-primary" type="submit">Create session</button>
          <button class="btn btn-secondary" type="button" data-home>Back</button>
        </form>${disclaimer()}${resources()}`;
      case 'out:join': return `
        <h1>Join a session</h1>
        <form class="card" id="joinForm">
          <label class="field" for="code">Code from the other person's phone</label>
          <input type="text" id="code" class="code-input" maxlength="6" inputmode="text" autocomplete="off" autocapitalize="characters" placeholder="ABC123" value="${esc(ui.prefill || '')}">
          <label class="field" for="nick">Nickname (optional)</label>
          <input type="text" id="nick" maxlength="24" autocomplete="off" placeholder="e.g. Alex, Green, 🌙">
          ${err}<button class="btn btn-primary" type="submit">Join</button>
          <button class="btn btn-secondary" type="button" data-home>Back</button>
        </form>${disclaimer()}${resources()}`;
      case 'loading': return `<p class="muted">Connecting…</p>`;
      case 'confirm': return `
        <div id="live"></div>
        <form class="card" id="confirmForm">
          <h2>Your check-in</h2>
          <p class="muted">Only you can answer this. Your partner sees only that you confirmed.</p>
          <label class="check req"><input type="checkbox" name="adult" required> <span>I am <b>18 or older</b>.</span></label>
          <label class="check req"><input type="checkbox" name="sober" required> <span>I'm <b>sober enough to decide</b> — not impaired by alcohol or drugs.</span></label>
          <label class="check req"><input type="checkbox" name="agree" required> <span>I <b>freely agree</b>, without pressure, and know I can stop at any time.</span></label>
          <h3>What I'm comfortable with <span class="muted">(optional)</span></h3>
          <p class="muted">Only things you <b>both</b> pick are shown, and only after you've both submitted.</p>
          <div class="chips">${config.boundaries.map((b) => `<label class="check"><input type="checkbox" name="b" value="${esc(b.key)}"> <span>${esc(b.label)}</span></label>`).join('')}</div>
          <label class="check" id="protCheck"><input type="checkbox" name="protection"> <span>I want us to use protection</span></label>
          <label class="field" for="note">Note for your partner <span class="muted">(optional, 280 chars)</span></label>
          <textarea id="note" maxlength="280" placeholder="e.g. Go slow. Ask before anything new."></textarea>
          ${err}<button class="btn btn-calm" type="submit">I confirm</button>
        </form>
        ${disclaimer()}${resources()}`;
      case 'waitpartner': return `<div id="live"></div>${disclaimer('Remember')}${resources()}`;
      case 'active': return `<div id="live"></div>
        <div class="card"><p><b>Keep checking in.</b> Active consent here doesn't replace asking each other. Either of you can stop at any moment — tap Stop, say so, or show it.</p></div>
        ${disclaimer('Remember')}${resources()}`;
      case 'paused:mine': return `<div id="live"></div>
        <div class="card">
          <h2>Talk to each other</h2>
          <p>Is everyone still OK? Nothing continues until you <b>both</b> re-confirm. If you're unsure, that's an answer — tap Stop.</p>
          <form id="resumeForm">
            <label class="check req"><input type="checkbox" name="sober" required> <span>I'm still not impaired.</span></label>
            <label class="check req"><input type="checkbox" name="agree" required> <span>I still freely want to continue.</span></label>
            ${err}<button class="btn btn-calm" type="submit">Re-confirm and continue</button>
          </form>
        </div>${resources()}`;
      case 'paused:ready': return `<div id="live"></div>${resources()}`;
    }
    if (key.startsWith('ended:')) return endScreen(key.split(':')[1]);
    return '';
  }

  function endScreen(kind) {
    const s = state || {};
    const deleted = s.recordsDeleted || ui.deleted;
    if (kind === 'withdrawn') {
      const who = localEnded ? 'You withdrew consent.' : s.endedBy === 'you' ? 'You withdrew consent.' : s.endedBy === 'partner' ? 'Your partner withdrew consent.' : 'Consent was withdrawn.';
      return `<section class="endscreen" role="alert">
        <div class="stopmark" aria-hidden="true">✋</div>
        <h1>Consent withdrawn.<br>Stop now.</h1>
        <p><b>${who}</b> This session is over and can't be restarted.</p>
        <p class="muted">${s.endedAt ? `Ended at ${fmtTime(s.endedAt)}.` : ''} If you both want to talk about it later, that's a new conversation — and a new session.</p>
        ${endActions(deleted)}</section>${resources()}`;
    }
    if (kind === 'expired') return `<section class="endscreen expired" role="alert">
        <div class="stopmark" aria-hidden="true">⏱</div>
        <h1>Session expired</h1>
        <p>Consent doesn't carry over to later. <b>Consent is not active.</b> If you both still want to, start a new session and check in again.</p>
        ${endActions(deleted)}</section>${resources()}`;
    return `<section class="endscreen" role="alert">
        <div class="stopmark" aria-hidden="true">✋</div>
        <h1>Session ended</h1>
        <p><b>Consent is not active.</b> ${ui.deleted ? 'You deleted this session.' : 'This session no longer exists (it was ended or deleted).'}</p>
        <button class="btn btn-primary" id="newSession">Start over</button></section>${resources()}`;
  }
  const endActions = (deleted) => `
    ${deleted ? '<p class="muted">✓ Session records deleted.</p>' : '<button class="btn btn-secondary" id="deleteBtn">Delete this session\'s record</button>'}
    <button class="btn btn-primary" id="newSession">Done — back to start</button>`;

  // dynamic parts that refresh without wiping forms
  function renderLive() {
    const live = $('#live'); if (!live || !state || !sess) return;
    const s = state; const now = Date.now() + clockSkew;
    const you = s.you || {}, p = s.partner || {};
    const person = (label, name, ok, txt) => `<div class="person"><span class="muted">${label}</span><b>${esc(name || '—')}</b><span class="pill ${ok ? 'ok' : 'wait'}">${txt}</span></div>`;
    const people = `<div class="people">
      ${person('You', you.nickname, you.confirmed, you.confirmed ? '✓ Confirmed' : 'Not yet')}
      ${p.joined ? person('Partner', p.nickname, p.confirmed, p.confirmed ? '✓ Confirmed' : 'Not yet') : person('Partner', 'Not joined', false, 'Waiting')}
    </div>`;
    const expires = `<p class="muted center">Session expires at ${fmtTime(s.expiresAt)} (<small class="timer">${fmtDur(s.expiresAt - now)}</small> left)</p>`;
    let html = '';
    if (s.status === 'waiting' && sess.role === 'A') {
      html += `<div class="card center">
        <h2>Show this to the other person</h2>
        <p class="muted">They join on their own phone — scan the QR or type the code.</p>
        <div class="code-big" aria-label="Join code">${esc(s.code || '')}</div>
        ${sess.qr ? `<img class="qr" alt="QR code to join this session" src="${sess.qr}">` : ''}
        <p class="muted">Code is single-use and expires at ${fmtTime(s.joinBy)}.</p></div>`;
    }
    if (s.status === 'active') {
      html += `<div class="status active"><div class="inherit">Both of you confirmed</div><div class="big">Consent active</div>
        <div>since ${fmtTime(s.activeSince)} · <small class="timer">${fmtDur(now - s.activeSince)}</small></div></div>${people}${overlapHtml(s.overlap)}${expires}`;
    } else if (s.status === 'paused') {
      html += `<div class="status paused"><div class="big">Paused — check in</div>
        <div>${s.pausedBy === 'you' ? 'You' : 'Your partner'} asked to pause. Consent is <b>not active</b> until you both re-confirm.</div></div>
        <div class="people">${person('You', you.nickname, you.ready, you.ready ? '✓ Ready' : 'Not yet')}${person('Partner', p.nickname, p.ready, p.ready ? '✓ Ready' : 'Not yet')}</div>
        ${you.ready ? '<p class="muted center">Waiting for your partner to re-confirm. Talk to each other.</p>' : ''}${expires}`;
    } else {
      const msg = !p.joined ? 'Waiting for the other person to join.' : !you.confirmed ? 'Each of you confirms on your own phone.' : 'Waiting for your partner to confirm.';
      html += `<div class="status pending"><div class="big">Not active yet</div><div>${msg}</div><div class="muted">Consent is active only when <b>both</b> confirm.</div></div>${people}${expires}`;
    }
    live.innerHTML = html;
  }
  function overlapHtml(o) {
    if (!o) return '';
    const acts = o.activities.length
      ? `<ul class="taglist">${o.activities.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
      : `<p class="muted">${o.anySelected ? 'Nothing you both selected overlaps — talk about it before anything happens.' : 'Neither of you picked specifics. Talk about what you each want.'}</p>`;
    const notes = [o.notes.you && `<div class="note"><span class="muted">Your note:</span> ${esc(o.notes.you)}</div>`, o.notes.partner && `<div class="note"><span class="muted">Partner's note:</span> ${esc(o.notes.partner)}</div>`].filter(Boolean).join('');
    return `<div class="card"><h2>You both said yes to</h2>${acts}
      ${o.protection ? '<p>🛡️ <b>Protection:</b> at least one of you asked to use protection.</p>' : ''}${notes}
      <p class="muted">Anything not listed here hasn't been agreed. Ask first. Either of you can change your mind at any time.</p></div>`;
  }

  // ---------------------------------------------------------------- events
  function bind(key) {
    app.querySelectorAll('[data-home]').forEach((b) => b.onclick = () => { ui = { screen: 'home', error: '' }; render(); });
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('#goCreate', () => { ui = { screen: 'create', error: '' }; render(); });
    on('#goJoin', () => { ui = { screen: 'join', error: '' }; render(); });
    on('#newSession', resetLocal);
    on('#deleteBtn', deleteSession);

    const cf = $('#createForm');
    if (cf) cf.onsubmit = async (e) => {
      e.preventDefault(); lock(cf, true);
      try {
        const r = await api('POST', '/api/sessions', { nickname: $('#nick').value });
        sess = { sessionId: r.sessionId, token: r.token, role: 'A', qr: r.qr, joinUrl: r.joinUrl }; save();
        ui.error = ''; setState(r.state); connect();
      } catch (err) { ui.error = err.message; screenKey = null; render(); }
    };
    const jf = $('#joinForm');
    if (jf) jf.onsubmit = async (e) => {
      e.preventDefault(); lock(jf, true);
      try {
        const r = await api('POST', '/api/join', { code: $('#code').value, nickname: $('#nick').value });
        sess = { sessionId: r.sessionId, token: r.token, role: 'B' }; save(); history.replaceState(null, '', '/');
        ui.error = ''; setState(r.state); connect();
      } catch (err) { ui.error = err.message; ui.prefill = $('#code').value; screenKey = null; render(); }
    };
    const conf = $('#confirmForm');
    if (conf) conf.onsubmit = async (e) => {
      e.preventDefault();
      const f = conf.elements;
      if (!f.adult.checked || !f.sober.checked || !f.agree.checked) { ui.error = 'All three statements must be true for you to confirm. If any aren\'t, don\'t continue.'; showErr(conf); return; }
      lock(conf, true);
      try {
        const r = await api('POST', `/api/sessions/${sess.sessionId}/confirm`, {
          adult: true, sober: true, agree: true,
          boundaries: [...conf.querySelectorAll('input[name=b]:checked')].map((i) => i.value),
          protection: f.protection.checked, note: $('#note').value,
        });
        ui.error = ''; setState(r);
      } catch (err) { ui.error = err.message; lock(conf, false); showErr(conf); if (err.status === 409) refresh(); }
    };
    const rf = $('#resumeForm');
    if (rf) rf.onsubmit = async (e) => {
      e.preventDefault(); lock(rf, true);
      try { setState(await api('POST', `/api/sessions/${sess.sessionId}/resume`, { sober: true, agree: true })); }
      catch (err) { ui.error = err.message; lock(rf, false); showErr(rf); }
    };
  }
  function lock(form, on) { form.querySelectorAll('button,input,textarea').forEach((el) => { el.disabled = on; }); }
  function showErr(form) {
    let el = form.querySelector('.error');
    if (!el) { el = document.createElement('div'); el.className = 'error'; el.setAttribute('role', 'alert'); form.querySelector('button[type=submit]').before(el); }
    el.textContent = ui.error;
  }

  // Stop: instant locally, then tell the server (retry until it lands).
  $('#stopBtn').onclick = async () => {
    if (!sess) return;
    localEnded = 'withdrawn'; buzz(); render();
    for (let i = 0; i < 20; i++) {
      try { const r = await api('POST', `/api/sessions/${sess.sessionId}/withdraw`); state = r; localEnded = null; render(); return; }
      catch (e) { if (e.status === 404 || e.status === 403) return; await new Promise((r) => setTimeout(r, 1000)); }
    }
  };
  $('#pauseBtn').onclick = async () => {
    if (!sess) return;
    try { setState(await api('POST', `/api/sessions/${sess.sessionId}/pause`)); } catch (e) { refresh(); }
  };
  $('#infoBtn').onclick = () => $('#info').showModal();

  async function deleteSession() {
    try { await api('DELETE', `/api/sessions/${sess.sessionId}`); } catch {}
    ui.deleted = true; if (state) state = { ...state, recordsDeleted: true }; render();
  }
  function resetLocal() {
    disconnect(); sess = null; state = null; localEnded = null; save();
    ui = { screen: 'home', error: '' }; screenKey = null; history.replaceState(null, '', '/'); render();
  }

  setInterval(() => { if (state && ['active', 'paused', 'waiting', 'pending'].includes(state.status)) renderLive(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ---------------------------------------------------------------- boot
  (async () => {
    try { config = await api('GET', '/api/config'); } catch {}
    const m = location.hash.match(/join=([A-Za-z0-9]{4,8})/);
    if (m && !sess) ui = { screen: 'join', error: '', prefill: m[1].toUpperCase() };
    if (sess) { await refresh(); connect(); }
    render();
  })();
})();
