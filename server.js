'use strict';
/**
 * Mutual Consent Check-in — prototype backend.
 * Express + WebSocket (ws) + SQLite (sql.js, persisted to ./data/consent.db).
 *
 * Privacy model:
 *  - Nicknames, boundary choices and notes live ONLY in server memory for the
 *    life of the session and are wiped as soon as it ends (withdraw/expire/delete).
 *  - SQLite stores only: session id + timestamps, and event rows
 *    (session id, role A/B, event type, timestamp). No names, no IPs, no notes.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const initSqlJs = require('sql.js');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'consent.db');
const TTL_MS = Number(process.env.SESSION_TTL_SECONDS || 3 * 60 * 60) * 1000;          // 3h
const JOIN_WINDOW_MS = Number(process.env.JOIN_WINDOW_SECONDS || 15 * 60) * 1000;      // 15m to join
const RETENTION_MS = Number(process.env.RECORD_RETENTION_HOURS || 24) * 3600 * 1000;   // event log kept 24h
const SWEEP_MS = Number(process.env.SWEEP_MS || 1000);

const BOUNDARY_OPTIONS = [
  { key: 'kissing', label: 'Kissing' },
  { key: 'cuddling', label: 'Cuddling' },
  { key: 'touch_over', label: 'Touching over clothes' },
  { key: 'touch_under', label: 'Touching under clothes' },
  { key: 'undressing', label: 'Undressing' },
  { key: 'oral', label: 'Oral sex' },
  { key: 'sex', label: 'Sex' },
];
const BOUNDARY_KEYS = new Set(BOUNDARY_OPTIONS.map((b) => b.key));
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

// ---------------------------------------------------------------- database
let db;
let dbDirty = false;
async function initDb() {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            ended_at INTEGER, end_reason TEXT);
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
            role TEXT, type TEXT NOT NULL, at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS events_session ON events(session_id);`);
  // Live state is in memory, so anything still "open" from a previous run is dead.
  // Consent never carries over a restart.
  const now = Date.now();
  db.run(`UPDATE sessions SET ended_at=?, end_reason='server_restart' WHERE ended_at IS NULL`, [now]);
  purgeOld();
  persist(true);
}
function persist(force) {
  dbDirty = true;
  if (force) flush();
}
function flush() {
  if (!dbDirty || !db) return;
  dbDirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_FILE);
}
setInterval(flush, 500).unref();
function logEvent(sessionId, role, type, at = Date.now()) {
  db.run('INSERT INTO events (session_id, role, type, at) VALUES (?,?,?,?)', [sessionId, role, type, at]);
  persist();
}
function purgeOld() {
  const cutoff = Date.now() - RETENTION_MS;
  db.run('DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?)', [cutoff]);
  db.run('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?', [cutoff]);
  persist();
}
function dbEvents(sessionId) {
  const out = [];
  const st = db.prepare('SELECT role, type, at FROM events WHERE session_id=? ORDER BY id');
  st.bind([sessionId]);
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

// ---------------------------------------------------------------- live sessions (memory only)
/** @type {Map<string, any>} */
const sessions = new Map();     // id -> session
const codes = new Map();        // join code -> id (only while waiting for B)

const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
function newCode() {
  for (;;) {
    let c = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!codes.has(c)) return c;
  }
}
const cleanNick = (s, fallback) => {
  const v = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return v || fallback;
};
const other = (role) => (role === 'A' ? 'B' : 'A');
const isEnded = (s) => ['withdrawn', 'expired', 'deleted'].includes(s.status);

function newParticipant(role, nickname) {
  return {
    role, token: rid(24), nickname: cleanNick(nickname, role === 'A' ? 'Person A' : 'Person B'),
    confirmed: false, confirmedAt: null, ready: false, boundaries: null, protection: false, note: '',
  };
}

function createSession(nickname) {
  const now = Date.now();
  const s = {
    id: rid(12), code: newCode(), createdAt: now, expiresAt: now + TTL_MS, joinBy: now + JOIN_WINDOW_MS,
    status: 'waiting', activeSince: null, pausedBy: null, endedAt: null, endReason: null, endedBy: null,
    participants: { A: newParticipant('A', nickname), B: null }, sockets: new Set(),
  };
  sessions.set(s.id, s);
  codes.set(s.code, s.id);
  db.run('INSERT INTO sessions (id, created_at, expires_at) VALUES (?,?,?)', [s.id, now, s.expiresAt]);
  logEvent(s.id, 'A', 'created', now);
  return s;
}

function endSession(s, reason, byRole) {
  if (isEnded(s)) return;
  const now = Date.now();
  s.status = reason;               // withdrawn | expired | deleted
  s.endedAt = now; s.endReason = reason; s.endedBy = byRole || null;
  s.activeSince = null;
  codes.delete(s.code);
  // wipe everything personal immediately
  for (const r of ['A', 'B']) {
    const p = s.participants[r];
    if (p) { p.nickname = r === 'A' ? 'Person A' : 'Person B'; p.boundaries = null; p.note = ''; p.protection = false; p.confirmed = false; p.ready = false; }
  }
  if (reason !== 'deleted') {
    db.run('UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?', [now, reason, s.id]);
    logEvent(s.id, byRole || null, reason, now);
  }
  broadcast(s);
  // keep a tombstone briefly so both phones can still read the final state, then forget it
  setTimeout(() => { sessions.delete(s.id); for (const ws of s.sockets) try { ws.close(4000, 'ended'); } catch {} }, 10 * 60 * 1000).unref();
}

function recompute(s) {
  const A = s.participants.A, B = s.participants.B;
  if (isEnded(s) || s.status === 'paused') return;
  if (!B) { s.status = 'waiting'; return; }
  if (A.confirmed && B.confirmed) {
    if (s.status !== 'active') { s.status = 'active'; s.activeSince = Date.now(); logEvent(s.id, null, 'active'); }
  } else s.status = 'pending';
}

function viewFor(s, role) {
  const me = s.participants[role];
  const them = s.participants[other(role)];
  const bothSubmitted = !!(me && them && me.confirmed && them.confirmed && !isEnded(s));
  let overlap = null;
  if (bothSubmitted) {
    const mine = new Set(me.boundaries || []);
    const shared = (them.boundaries || []).filter((k) => mine.has(k));
    overlap = {
      activities: BOUNDARY_OPTIONS.filter((b) => shared.includes(b.key)).map((b) => b.label),
      anySelected: (me.boundaries || []).length + (them.boundaries || []).length > 0,
      protection: me.protection || them.protection,
      notes: { you: me.note || '', partner: them.note || '' },
    };
  }
  return {
    sessionId: s.id, role, status: s.status, serverTime: Date.now(),
    code: s.status === 'waiting' ? s.code : null,
    createdAt: s.createdAt, expiresAt: s.expiresAt, joinBy: s.status === 'waiting' ? s.joinBy : null,
    activeSince: s.activeSince, pausedBy: s.pausedBy ? (s.pausedBy === role ? 'you' : 'partner') : null,
    endedAt: s.endedAt, endReason: s.endReason,
    endedBy: s.endedBy ? (s.endedBy === role ? 'you' : 'partner') : null,
    you: me ? { nickname: me.nickname, confirmed: me.confirmed, ready: me.ready } : null,
    partner: them ? { joined: true, nickname: them.nickname, confirmed: them.confirmed, ready: them.ready } : { joined: false },
    overlap,
  };
}

function broadcast(s) {
  for (const ws of s.sockets) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state: viewFor(s, ws.role) }));
  }
}

// expiry sweeper
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (isEnded(s)) continue;
    if (now >= s.expiresAt || (s.status === 'waiting' && now >= s.joinBy)) endSession(s, 'expired', null);
  }
}, SWEEP_MS).unref();
setInterval(purgeOld, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false }));

// tiny per-IP limiter for join attempts (stops code guessing)
const joinHits = new Map();
function joinLimited(ip) {
  const now = Date.now();
  const arr = (joinHits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now); joinHits.set(ip, arr);
  return arr.length > Number(process.env.JOIN_RATE_PER_MIN || 20);
}

function auth(req, res) {
  const s = sessions.get(req.params.id);
  const token = req.get('x-session-token') || '';
  if (!s) { res.status(404).json({ error: 'Session not found or already ended.' }); return null; }
  const role = ['A', 'B'].find((r) => s.participants[r] && safeEq(s.participants[r].token, token));
  if (!role) { res.status(403).json({ error: 'Not a participant in this session.' }); return null; }
  return { s, role };
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function joinUrl(req, code) {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/#join=${code}`;
}

app.get('/api/config', (req, res) => res.json({ boundaries: BOUNDARY_OPTIONS, ttlSeconds: TTL_MS / 1000 }));
app.get('/api/health', (req, res) => res.json({ ok: true, liveSessions: sessions.size }));

app.post('/api/sessions', async (req, res) => {
  const s = createSession(req.body && req.body.nickname);
  const url = joinUrl(req, s.code);
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#24324a', light: '#ffffff' } });
  res.status(201).json({ sessionId: s.id, token: s.participants.A.token, role: 'A', code: s.code, joinUrl: url, qr, state: viewFor(s, 'A') });
});

app.post('/api/join', (req, res) => {
  if (joinLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const id = codes.get(code);
  const s = id && sessions.get(id);
  if (!s || s.status !== 'waiting') return res.status(404).json({ error: 'That code is not valid, already used, or expired.' });
  s.participants.B = newParticipant('B', req.body && req.body.nickname);
  codes.delete(code);                       // single use
  logEvent(s.id, 'B', 'joined');
  recompute(s);
  broadcast(s);
  res.status(201).json({ sessionId: s.id, token: s.participants.B.token, role: 'B', state: viewFor(s, 'B') });
});

app.get('/api/sessions/:id', (req, res) => {
  const a = auth(req, res); if (!a) return;
  res.json(viewFor(a.s, a.role));
});

app.post('/api/sessions/:id/confirm', (req, res) => {
  const a = auth(req, res); if (!a) return;
  const { s, role } = a;
  if (isEnded(s)) return res.status(409).json({ error: 'Session has ended. Start a new session.', state: viewFor(s, role) });
  if (s.status === 'paused') return res.status(409).json({ error: 'Session is paused. Use "continue" after checking in.' });
  const b = req.body || {};
  if (b.adult !== true || b.sober !== true || b.agree !== true) {
    return res.status(400).json({ error: 'All three confirmations (18+, not impaired, freely agree) are required.' });
  }
  const p = s.participants[role];
  if (p.confirmed) return res.status(409).json({ error: 'Already confirmed.' });
  p.boundaries = Array.isArray(b.boundaries) ? [...new Set(b.boundaries.filter((k) => BOUNDARY_KEYS.has(k)))] : [];
  p.protection = b.protection === true;
  p.note = String(b.note || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 280);
  p.confirmed = true; p.ready = true; p.confirmedAt = Date.now();
  logEvent(s.id, role, 'confirmed', p.confirmedAt);
  recompute(s);
  broadcast(s);
  res.json(viewFor(s, role));
});

app.post('/api/sessions/:id/pause', (req, res) => {
  const a = auth(req, res); if (!a) return;
  const { s, role } = a;
  if (s.status !== 'active') return res.status(409).json({ error: 'Pause is only available while consent is active.' });
  s.status = 'paused'; s.pausedBy = role; s.activeSince = null;
  s.participants.A.ready = false; s.participants.B.ready = false;
  logEvent(s.id, role, 'paused');
  broadcast(s);
  res.json(viewFor(s, role));
});

app.post('/api/sessions/:id/resume', (req, res) => {
  const a = auth(req, res); if (!a) return;
  const { s, role } = a;
  if (s.status !== 'paused') return res.status(409).json({ error: 'Session is not paused.' });
  const b = req.body || {};
  if (b.sober !== true || b.agree !== true) return res.status(400).json({ error: 'Re-confirm you are not impaired and still agree.' });
  s.participants[role].ready = true;
  logEvent(s.id, role, 'reconfirmed');
  if (s.participants.A.ready && s.participants.B.ready) {
    s.status = 'active'; s.pausedBy = null; s.activeSince = Date.now(); logEvent(s.id, null, 'active');
  }
  broadcast(s);
  res.json(viewFor(s, role));
});

app.post('/api/sessions/:id/withdraw', (req, res) => {
  const a = auth(req, res); if (!a) return;
  const { s, role } = a;
  if (!isEnded(s)) endSession(s, 'withdrawn', role);
  res.json(viewFor(s, role));
});

app.delete('/api/sessions/:id', (req, res) => {
  const a = auth(req, res); if (!a) return;
  const { s, role } = a;
  // Deleting always withdraws consent first (for the other person's screen), then erases all records.
  if (!isEnded(s)) endSession(s, 'withdrawn', role);
  const view = viewFor(s, role);
  db.run('DELETE FROM events WHERE session_id=?', [s.id]);
  db.run('DELETE FROM sessions WHERE id=?', [s.id]);
  persist(true);
  s.recordsDeleted = true;
  for (const ws of s.sockets) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'deleted' }));
  sessions.delete(s.id);
  res.json({ deleted: true, state: view });
});

// Event log for a session: timestamps only (lets a participant see what is stored).
app.get('/api/sessions/:id/events', (req, res) => {
  const a = auth(req, res); if (!a) return;
  res.json({ events: dbEvents(a.s.id) });
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const s = sessions.get(u.searchParams.get('session') || '');
  const token = u.searchParams.get('token') || '';
  const role = s && ['A', 'B'].find((r) => s.participants[r] && safeEq(s.participants[r].token, token));
  if (!role) { ws.send(JSON.stringify({ type: 'gone' })); return ws.close(4004, 'not found'); }
  ws.role = role;
  s.sockets.add(ws);
  ws.on('close', () => s.sockets.delete(ws));
  ws.on('message', () => {}); // client->server actions go through HTTP
  ws.send(JSON.stringify({ type: 'state', state: viewFor(s, role) }));
});
// keepalive
setInterval(() => { for (const ws of wss.clients) { try { ws.ping(); } catch {} } }, 25_000).unref();

initDb().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`consent-app listening on http://${HOST}:${PORT}  (ttl ${TTL_MS / 1000}s, db ${DB_FILE})`);
  });
});
function shutdown() { try { flush(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

module.exports = { app };
