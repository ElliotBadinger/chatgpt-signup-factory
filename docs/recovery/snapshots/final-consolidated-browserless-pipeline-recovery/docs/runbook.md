# Yutori Local Linux Port Runbook

## Prerequisites
- Linux desktop session with X11 (current test system: Plasma on X11)
- Node.js / npm available
- `bwrap` installed for preferred terminal sandboxing
- `xdotool` optional for local UI/window automation during verification

## Install
From `/home/epistemophile/Downloads/yutori-re`:

```bash
npm install
node node_modules/electron/install.js
npm install sharp
```

## Launch the app
```bash
./node_modules/.bin/electron app.asar.extracted
```

Logs can be redirected to an artifact file, for example:
```bash
mkdir -p artifacts/logs
./node_modules/.bin/electron app.asar.extracted > artifacts/logs/app.log 2>&1
```

## Reuse existing Scouts login and provision Local credentials
Current verified operator flow on this machine:
1. Launch Chrome against a copied authenticated profile.
2. Open `https://scouts.yutori.com/`.
3. Extract `window.Clerk.session.getToken()` over CDP.
4. Call `POST https://api.yutori.com/client/generate_key`.
5. Store the resulting `userId`, `apiKey`, and `email` into `~/.config/yutori-local/config.json`.

This was already verified and documented in `artifacts/logs/key-provisioning.json`.

## Verify UI launch
- Logged-out screenshot artifact: `artifacts/screenshots/ui-logged-out.png`
- Stored-config screenshot artifact: `artifacts/screenshots/ui-inner-logged-in-disconnected.png`

## Verify browser execution locally
Run:
```bash
./node_modules/.bin/electron scripts/browser-executor-smoke.js > artifacts/logs/browser-smoke.log 2>&1
```

Artifacts:
- `artifacts/browser-smoke/browser-smoke-log.json`
- `artifacts/browser-smoke/init-screenshot.webp`
- `artifacts/browser-smoke/action-screenshot.webp`
- `artifacts/browser-smoke/final-screenshot.webp`

## Verify Linux terminal tool behavior
The app now registers `local_terminal` on Linux.
Recommended settings:
- enable Terminal Access in config/UI
- add explicit allowlisted folders

Current verified allowlist example:
- `/home/epistemophile/Downloads/yutori-re`

## Mock relay verification mode
A local relay-compatible test harness exists for app-path verification independent of production relay health.

Start the mock relay:
```bash
node scripts/mock-relay-server.mjs
```

Launch the app against it:
```bash
YUTORI_RELAY_URL=ws://127.0.0.1:8787 ./node_modules/.bin/electron app.asar.extracted > artifacts/logs/app-mock-relay.log 2>&1
```

Primary artifact:
- `artifacts/mock-relay/mock-relay-log.json`

## Relay tunnel transport adapter
A dedicated WebSocket relay proxy lives in `relay-tunnel-service/`.

Local run:
```bash
cd relay-tunnel-service
npm install
UPSTREAM_RELAY_URL=wss://yutori--browser-relay-relay-app.modal.run npm start
```

Health check:
```bash
curl http://127.0.0.1:3000/healthz
```

Ink deployment currently used during verification:
- `https://yutori-relay-tunnel.ml.ink`

Point the app at the tunnel:
```bash
YUTORI_RELAY_URL=wss://yutori-relay-tunnel.ml.ink ./node_modules/.bin/electron app.asar.extracted > artifacts/logs/app-live-proxy.log 2>&1
```

Important behavior note:
- the tunnel is intentionally strict and now returns `502 Bad Gateway` if the upstream relay handshake times out,
- it no longer produces the earlier false-positive "connected" state that could occur when the proxy accepted the client socket before upstream success.

## Current live-relay limitation
At the moment of this runbook update, the production relay hostname resolves and completes TLS, but websocket upgrade requests are stalling without returning `101 Switching Protocols`.

This is now reproduced from both:
- the local Linux machine, and
- the Ink-hosted relay tunnel.

Evidence:
- `artifacts/logs/app-connected.log`
- `artifacts/logs/probe-desktop.log`
- `artifacts/logs/ws-debug.log`
- `artifacts/logs/relay-tunnel-probe.log`
- `artifacts/logs/relay-tunnel-ink.log`
- `artifacts/logs/relay-tunnel-health.json`

## Authenticated Scouts status check
The copied Chrome profile at `/tmp/yutori-chrome-full` is still useful for authenticated web verification.

Launch Chrome with DevTools:
```bash
rm -rf /tmp/yutori-chrome-snapshot
cp -a /tmp/yutori-chrome-full /tmp/yutori-chrome-snapshot
rm -f /tmp/yutori-chrome-snapshot/Singleton*
/usr/bin/google-chrome-stable \
  --user-data-dir=/tmp/yutori-chrome-snapshot \
  --profile-directory=Default \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --no-remote about:blank
```

Then connect with `agent-browser`:
```bash
agent-browser close
agent-browser connect 9222
agent-browser open https://scouts.yutori.com/
agent-browser wait --load networkidle
```

Authenticated API status from the Scouts page:
```bash
agent-browser eval '(async () => { const token = await window.Clerk.session.getToken(); const r = await fetch("https://api.yutori.com/client/desktop/status", { headers: { Authorization: `Bearer ${token}` } }); return await r.text(); })()'
```

Current result: `{"connected":false}`.
