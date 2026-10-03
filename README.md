# Mutual Consent Check-in (prototype)

A small, mobile-first web app that helps two adults **talk about and confirm mutual consent**, and lets
either of them **stop at any moment** with one tap.

> **Important.** Consent can be withdrawn at any moment, by words or actions, regardless of what this app
> shows. This app is a communication tool and is **not legal proof of consent**. Someone who is intoxicated,
> asleep, pressured, or under 18 cannot consent.
> Support: RAINN National Sexual Assault Hotline **1-800-656-4673** · <https://rainn.org>

## How it works

1. **Person A** taps *Start a session* (nickname optional) and gets a 6-character **code + QR** (single-use;
   expires if no one joins within 15 min).
2. **Person B** scans the QR or types the code on **their own phone**.
3. Each person **separately** confirms: 18+, sober enough to decide (not impaired), and freely agrees.
   They can also pick what they're comfortable with from a short checklist, ask for protection, and add a note.
4. Consent shows **"Active" only when both have confirmed**. The **overlap** (things both picked) and any
   notes appear only after both have submitted.
5. **Stop / I withdraw consent** is pinned to the bottom of every session screen for both people. One tap ends
   the session for both immediately: both phones show **"Consent withdrawn. Stop now."** (with vibration where
   supported). It can't be undone; a new session is needed.
6. **Pause / check in** (while active) sets consent back to *not active* until **both** re-confirm.
7. Sessions **auto-expire after 3 hours**. Consent never carries over to a later session, and a server restart
   ends every open session.

Real-time updates use a **WebSocket**, with 2-second **polling as a fallback**.

## Privacy

- Nicknames only. No accounts, email, phone, location, analytics, cookies, or third-party requests
  (strict Content-Security-Policy, `no-referrer`, `noindex`).
- Nicknames, checklist choices and notes exist **only in server memory** while the session is open and are wiped
  when it ends (withdraw / expiry / delete).
- The SQLite database (`data/consent.db`) stores **only** a session id and timestamped events:
  `created, joined, confirmed, active, paused, reconfirmed, withdrawn, expired`, plus role `A`/`B`. No IP
  addresses or content.
- Ended sessions' records are **purged automatically after 24h** (`RECORD_RETENTION_HOURS`), and either person
  can tap **Delete this session's record** to erase them right away (deleting also withdraws consent).
- There's no share or export feature. Session tokens are kept in `sessionStorage` (the browser tab) only.

## Run it

Requires Node.js 18+ (tested on Node 20).

```bash
cd /workspace/consent-app
npm install
npm start                # http://localhost:3210  (PORT=xxxx to change)
```

Open it on two phones on the same network at `http://<computer-ip>:3210`, or use two browser windows (one of
them private/incognito, because each tab keeps its own session).

### Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3210` / `0.0.0.0` | Listen address |
| `SESSION_TTL_SECONDS` | `10800` (3h) | Hard expiry for every session |
| `JOIN_WINDOW_SECONDS` | `900` (15m) | Time for Person B to join before the code expires |
| `RECORD_RETENTION_HOURS` | `24` | Auto-purge of ended sessions' timestamp records |
| `DB_FILE` | `data/consent.db` | SQLite file (sql.js, pure WASM, so no native build) |
| `PUBLIC_URL` | request host | Base URL encoded in the QR code (set this behind a proxy) |
| `JOIN_RATE_PER_MIN` | `20` | Join attempts per IP per minute (to stop code guessing) |

## Tests

```bash
npm test                         # spawns its own server (temp DB, 5s TTL) and runs 34 end-to-end checks:
                                 # join, both-confirm -> active, overlap, pause/resume, withdraw (pushed to
                                 # both WebSockets, can't be undone), privacy of the DB file, delete, auto-expiry
bash test/curl-demo.sh           # curl walkthrough against a running server (BASE=http://localhost:3210)
npm run screenshots              # drives two headless Chrome "phones" with puppeteer-core -> screenshots/*.png
                                 # (CHROME=/path/to/chrome, BASE_URL=...)
```

## API (all JSON; participant calls need the `X-Session-Token` header)

| Method & path | Purpose |
|---|---|
| `POST /api/sessions` `{nickname?}` | Create the session as A → `{sessionId, token, code, joinUrl, qr}` |
| `POST /api/join` `{code, nickname?}` | Join as B (code is single-use) |
| `GET /api/sessions/:id` | Your view of the session state |
| `POST /api/sessions/:id/confirm` `{adult, sober, agree, boundaries[], protection, note}` | Confirm (the three booleans must all be `true`) |
| `POST /api/sessions/:id/pause` · `/resume` `{sober, agree}` | Check-in; resumes only when both re-confirm |
| `POST /api/sessions/:id/withdraw` | End for both, can't be undone |
| `DELETE /api/sessions/:id` | Withdraw and erase all records |
| `GET /api/sessions/:id/events` | The timestamps stored for this session |
| `WS /ws?session=…&token=…` | Pushes `{type:"state"}` on every change |

## Files

```
server.js              Express + ws + sql.js backend
public/index.html      SPA shell, About & help dialog (disclaimers, RAINN)
public/app.js          Client (screens, realtime, instant Stop)
public/styles.css      Mobile-first calm theme
test/e2e.js            End-to-end test (npm test)
test/curl-demo.sh      curl walkthrough
test/screenshots.js    Headless-Chrome screenshots
screenshots/           1-start-session-code-qr, 2-check-in-form, 3-consent-active-both-confirmed, 4-consent-withdrawn-stop-now
```

## Before a real deployment

- **HTTPS is required** (TLS via a reverse proxy like Caddy/nginx or a PaaS). Over plain HTTP, the session token
  and notes travel unencrypted; `wss://` is used automatically under HTTPS. Set `PUBLIC_URL`, and
  `app.set('trust proxy', 1)` so per-IP rate limiting sees real client IPs.
- **Hosting**: single process, in-memory live state. To scale horizontally you'd need shared state (e.g. Redis
  pub/sub) and sticky WebSockets. Restarts end all open sessions on purpose. Use a persistent volume for `data/`
  or set retention to 0.
- **Abuse & safety review**: get legal/advocacy review of the wording (e.g. RAINN, local laws on age of consent,
  which varies by jurisdiction and isn't always 18), plus accessibility (screen reader, contrast), localization,
  and region-specific hotlines outside the US.
- **Security hardening**: real rate limiting at the edge, security headers via the proxy (HSTS), dependency
  audits, and logging that never records request bodies. Consider making tokens rotate on reconnect.
- **App stores**: as-is, it's a web app. To ship it, wrap it as a PWA (manifest + service worker) or with
  Capacitor/React Native. Apple and Google review sexual-content-adjacent apps strictly (age rating 17+/Mature,
  privacy nutrition labels, data-safety form), and will likely want a clear safety purpose, moderation story,
  and privacy policy.
- **Product**: there's no account system on purpose. If you add one, keep the "no carry-over" rule and never
  surface past sessions as evidence.
