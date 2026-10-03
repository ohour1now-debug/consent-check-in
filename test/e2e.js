'use strict';
/**
 * End-to-end test: starts its own server on a free port with a temp DB,
 * simulates two people (A and B) over HTTP + WebSocket, and checks:
 *   create -> join -> confirm A (pending) -> confirm B (active) -> overlap
 *   pause -> both re-confirm -> active
 *   withdraw by B -> both sockets see "withdrawn" -> cannot confirm/resume/rejoin
 *   only timestamps stored -> delete removes records
 *   short-TTL session auto-expires
 * Usage: npm test        (or: node test/e2e.js)
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const WebSocket = require('ws');
const initSqlJs = require('sql.js');

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓ ' + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function main() {
  const port = await freePort();
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'consent-')), 'test.db');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: dbFile, SESSION_TTL_SECONDS: '5', SWEEP_MS: '200', JOIN_WINDOW_SECONDS: '4' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('listening') && res()));
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const socket = (id, token) => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${id}&token=${token}`);
    ws.msgs = []; ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => res(ws));
  });
  const lastState = (ws) => [...ws.msgs].reverse().find((m) => m.type === 'state')?.state;
  const waitFor = async (ws, pred, label) => {
    for (let i = 0; i < 50; i++) { const s = lastState(ws); if (s && pred(s)) return s; await sleep(50); }
    throw new Error('timeout waiting for ' + label);
  };

  try {
    // Use a long-lived session for the main flow: TTL is 5s, so keep it quick.
    console.log('Two people join');
    const A = await call('POST', '/api/sessions', { nickname: 'Sky' });
    ok(A.status === 201 && /^[A-Z2-9]{6}$/.test(A.body.code), `A created session, code ${A.body.code}`);
    ok(A.body.qr.startsWith('data:image/png'), 'QR code returned');
    const wsA = await socket(A.body.sessionId, A.body.token);
    const B = await call('POST', '/api/join', { code: A.body.code.toLowerCase(), nickname: 'River' });
    ok(B.status === 201 && B.body.sessionId === A.body.sessionId, 'B joined with code (case-insensitive)');
    const wsB = await socket(B.body.sessionId, B.body.token);
    ok((await call('POST', '/api/join', { code: A.body.code })).status === 404, 'code is single-use (third person rejected)');
    await waitFor(wsA, (s) => s.status === 'pending' && s.partner.nickname === 'River', 'A sees B joined');
    ok(true, 'A notified in real time that B joined');
    ok((await call('GET', `/api/sessions/${A.body.sessionId}`, null, 'bogus')).status === 403, 'wrong token rejected');

    console.log('Both confirm');
    const bad = await call('POST', `/api/sessions/${A.body.sessionId}/confirm`, { adult: true, sober: false, agree: true }, A.body.token);
    ok(bad.status === 400, 'confirm rejected if not sober');
    const cA = await call('POST', `/api/sessions/${A.body.sessionId}/confirm`, { adult: true, sober: true, agree: true, boundaries: ['kissing', 'cuddling', 'oral'], protection: true, note: 'Go slow' }, A.body.token);
    ok(cA.status === 200 && cA.body.status === 'pending', 'after A confirms: still pending (not active)');
    ok(cA.body.overlap === null, 'overlap hidden until both submit');
    const sB1 = await waitFor(wsB, (s) => s.partner.confirmed, 'B sees A confirmed');
    ok(sB1.overlap === null && sB1.status === 'pending', 'B sees A confirmed, but no overlap/choices yet');
    const cB = await call('POST', `/api/sessions/${B.body.sessionId}/confirm`, { adult: true, sober: true, agree: true, boundaries: ['kissing', 'touch_over', 'cuddling', 'not-a-key'], note: 'Check in often' }, B.body.token);
    ok(cB.body.status === 'active', 'after B confirms: ACTIVE');
    const sA = await waitFor(wsA, (s) => s.status === 'active', 'A sees active');
    ok(JSON.stringify(sA.overlap.activities) === JSON.stringify(['Kissing', 'Cuddling']), 'overlap = Kissing, Cuddling only');
    ok(sA.overlap.protection === true && sA.overlap.notes.partner === 'Check in often', 'protection flag + partner note shown');

    console.log('Pause / check in');
    ok((await call('POST', `/api/sessions/${A.body.sessionId}/pause`, null, B.body.token)).body.status === 'paused', 'B paused');
    await waitFor(wsA, (s) => s.status === 'paused' && s.pausedBy === 'partner', 'A sees paused');
    ok(true, 'A sees "paused by partner"');
    ok((await call('POST', `/api/sessions/${A.body.sessionId}/resume`, { sober: true, agree: true }, A.body.token)).body.status === 'paused', 'one re-confirm is not enough');
    ok((await call('POST', `/api/sessions/${A.body.sessionId}/resume`, { sober: true, agree: true }, B.body.token)).body.status === 'active', 'both re-confirm -> active again');

    console.log('Withdraw');
    const w = await call('POST', `/api/sessions/${B.body.sessionId}/withdraw`, null, B.body.token);
    ok(w.body.status === 'withdrawn' && w.body.endedBy === 'you', 'B withdrew');
    const wA = await waitFor(wsA, (s) => s.status === 'withdrawn', 'A sees withdrawn');
    ok(wA.endedBy === 'partner' && wA.overlap === null, 'A instantly sees "partner withdrew", overlap wiped');
    ok(lastState(wsB).status === 'withdrawn', 'B socket also shows withdrawn');
    ok((await call('POST', `/api/sessions/${A.body.sessionId}/confirm`, { adult: true, sober: true, agree: true }, A.body.token)).status === 409, 're-confirm after withdraw rejected (cannot undo)');
    ok((await call('POST', `/api/sessions/${A.body.sessionId}/resume`, { sober: true, agree: true }, A.body.token)).status === 409, 'resume after withdraw rejected');
    ok((await call('POST', `/api/sessions/${A.body.sessionId}/pause`, null, A.body.token)).status === 409, 'pause after withdraw rejected');
    ok((await call('POST', '/api/join', { code: A.body.code })).status === 404, 'old code cannot be reused');

    console.log('Privacy: stored data');
    const ev = await call('GET', `/api/sessions/${A.body.sessionId}/events`, null, A.body.token);
    const types = ev.body.events.map((e) => e.type);
    ok(JSON.stringify(types) === JSON.stringify(['created', 'joined', 'confirmed', 'confirmed', 'active', 'paused', 'reconfirmed', 'reconfirmed', 'active', 'withdrawn']), 'event log: ' + types.join(','));
    ok(ev.body.events.every((e) => Object.keys(e).sort().join() === 'at,role,type'), 'events hold only role/type/timestamp');
    await sleep(700); // let the DB flush
    const SQL = await initSqlJs();
    const raw = Buffer.from(fs.readFileSync(dbFile)).toString('latin1');
    ok(!raw.includes('Sky') && !raw.includes('River') && !raw.includes('Go slow') && !raw.includes('Kissing'), 'no nicknames / notes / choices in the database file');
    const del = await call('DELETE', `/api/sessions/${A.body.sessionId}`, null, A.body.token);
    ok(del.body.deleted === true, 'delete session');
    await sleep(100);
    ok(wsB.msgs.some((m) => m.type === 'deleted'), 'partner notified of deletion');
    const db = new SQL.Database(fs.readFileSync(dbFile));
    const n = db.exec(`SELECT COUNT(*) FROM events WHERE session_id='${A.body.sessionId}'`)[0].values[0][0];
    ok(n === 0, 'all event rows deleted');
    ok((await call('GET', `/api/sessions/${A.body.sessionId}`, null, A.body.token)).status === 404, 'session gone after delete');
    wsA.close(); wsB.close();

    console.log('Auto-expiry (TTL = 5s in test)');
    const X = await call('POST', '/api/sessions', {});
    const Y = await call('POST', '/api/join', { code: X.body.code });
    await call('POST', `/api/sessions/${X.body.sessionId}/confirm`, { adult: true, sober: true, agree: true }, X.body.token);
    const act = await call('POST', `/api/sessions/${X.body.sessionId}/confirm`, { adult: true, sober: true, agree: true }, Y.body.token);
    ok(act.body.status === 'active', 'second session active');
    const wsX = await socket(X.body.sessionId, X.body.token);
    for (let i = 0; i < 60 && lastState(wsX)?.status !== 'expired'; i++) await sleep(100);
    ok(lastState(wsX).status === 'expired', 'session auto-expired and pushed to client');
    ok((await call('POST', `/api/sessions/${X.body.sessionId}/pause`, null, X.body.token)).status === 409, 'expired session cannot be used');
    wsX.close();

    console.log(`\nAll ${passed} checks passed.`);
  } finally { srv.kill('SIGTERM'); }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
