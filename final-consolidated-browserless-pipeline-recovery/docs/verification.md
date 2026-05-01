# Yutori Local Linux Port Verification

## Evidence log format
- Timestamp
- Command
- Expected result
- Actual result
- Artifact path

## Verified evidence

### 2026-03-27T09:31Z — launchable local app UI (logged out)
- Command: `./node_modules/.bin/electron app.asar.extracted > artifacts/logs/app-launch.log 2>&1 &`
- Expected: Electron app launches and shows the settings window.
- Actual: Main process started, settings window reached `DOM ready`, `ready-to-show`, and `shown`.
- Artifacts:
  - `artifacts/logs/app-launch.log`
  - `artifacts/screenshots/ui-logged-out.png`

### 2026-03-27T09:43Z — Local key provisioning from existing authenticated Scouts context
- Command: browser-backed Clerk token extraction from a copied Chrome profile, followed by `POST https://api.yutori.com/client/generate_key`.
- Expected: recover a Clerk token from the existing signed-in Scouts session and provision a Yutori Local key.
- Actual: succeeded; key was provisioned and stored locally with redacted evidence.
- Artifacts:
  - `artifacts/logs/key-provisioning.json`

### 2026-03-27T09:47Z — app state recovery after relaunch with stored credentials
- Command: relaunch Electron app after writing `~/.config/yutori-local/config.json`.
- Expected: app reuses stored credentials and returns to configured state.
- Actual: app relaunched, reused stored config, and showed the configured settings UI.
- Artifacts:
  - `artifacts/logs/app-linux-tools.log`
  - `artifacts/screenshots/ui-inner-logged-in-disconnected.png`

### 2026-03-27T09:47Z — Linux terminal tool registration
- Command: app relaunch with Linux tool registration patch.
- Expected: `local_terminal` registers on Linux even when mac-only advanced capabilities are unavailable.
- Actual: log shows `Registered tool: local_terminal`.
- Artifacts:
  - `artifacts/logs/app-linux-tools.log`

### 2026-03-27T09:52Z — Linux terminal tool sandbox/allowlist behavior
- Command: direct registry execution tests against `local_terminal`.
- Expected: allowed folder command succeeds; disallowed working directory is rejected.
- Actual: allowed execution returned repo path and `ok`; disallowed `/tmp` was rejected with an allowlist error.
- Artifacts:
  - command output captured in session transcript

### 2026-03-27T09:57Z — browser execution smoke test
- Command: `./node_modules/.bin/electron scripts/browser-executor-smoke.js > artifacts/logs/browser-smoke.log 2>&1`
- Expected: browser executor initializes a BrowserWindow, evaluates JS, executes an action, and captures screenshots.
- Actual: succeeded with exit code 0.
- Artifacts:
  - `artifacts/logs/browser-smoke.log`
  - `artifacts/browser-smoke/browser-smoke-log.json`
  - `artifacts/browser-smoke/init-screenshot.webp`
  - `artifacts/browser-smoke/action-screenshot.webp`
  - `artifacts/browser-smoke/final-screenshot.webp`

## Current blocker under investigation

### 2026-03-27T09:45Z onward — production relay handshake stalls
- Command(s):
  - Electron app desktop relay connect
  - `node scripts/yutori-relay-probe.mjs desktop ...`
  - direct websocket/curl upgrade attempts
- Expected: websocket `open` / 101 upgrade response from `wss://yutori--browser-relay-relay-app.modal.run/ws/desktop/<userId>`.
- Actual: DNS resolution and TLS negotiation succeed, but the websocket upgrade does not complete; requests time out without a response.
- Artifacts:
  - `artifacts/logs/app-connected.log`
  - `artifacts/logs/probe-desktop.log`
  - `artifacts/logs/ws-debug.log`

### 2026-03-27T10:00Z — full app websocket/browser flow against a mock relay
- Command(s):
  - `node scripts/mock-relay-server.mjs`
  - `YUTORI_RELAY_URL=ws://127.0.0.1:8787 ./node_modules/.bin/electron app.asar.extracted > artifacts/logs/app-mock-relay.log 2>&1`
- Expected: app connects desktop websocket, receives `newSession`, opens browser websocket, handles `initBrowser`, `evaluateJs`, `takeScreenshot`, `executeAction`, and `ping`.
- Actual: succeeded; the mock relay log shows all expected message exchanges and app responses.
- Artifacts:
  - `artifacts/logs/app-mock-relay.log`
  - `artifacts/logs/mock-relay-server.log`
  - `artifacts/mock-relay/mock-relay-log.json`

### 2026-03-27T11:35Z — relay tunnel service behavior is covered by automated tests
- Command: `npm test > artifacts/logs/relay-proxy-tests.log 2>&1`
- Expected: the proxy should forward websocket paths/headers/messages correctly and must not report a successful websocket upgrade when upstream handshake fails.
- Actual: passed.
- Artifacts:
  - `artifacts/logs/relay-proxy-tests.log`
  - `tests/relay-proxy.test.js`
  - `relay-tunnel-service/relay-proxy-server.js`

### 2026-03-27T11:40Z — Ink-hosted relay tunnel health
- Command: `curl -sS https://yutori-relay-tunnel.ml.ink/healthz > artifacts/logs/relay-tunnel-health.json`
- Expected: tunnel service responds and exposes configured upstream relay URL.
- Actual: succeeded; service returned `{"ok":true,"upstreamBaseUrl":"wss://yutori--browser-relay-relay-app.modal.run"}`.
- Artifacts:
  - `artifacts/logs/relay-tunnel-health.json`

### 2026-03-27T11:45Z — Ink-hosted relay tunnel confirms upstream relay outage instead of hiding it
- Command: `node scripts/yutori-relay-probe.mjs desktop wss://yutori-relay-tunnel.ml.ink <userId> <apiKey>`
- Expected: if the upstream relay works, the tunnel should return websocket `open`; if upstream relay is unhealthy, the tunnel should fail the upgrade honestly.
- Actual: failed with `Unexpected server response: 502`; Ink logs show the tunnel attempted the correct upstream URL and then hit `Opening handshake has timed out`.
- Artifacts:
  - `artifacts/logs/relay-tunnel-probe.log`
  - `artifacts/logs/relay-tunnel-ink.log`

### 2026-03-27T11:50Z — authenticated Scouts desktop status check
- Command(s):
  - launch Chrome against `/tmp/yutori-chrome-snapshot` with remote debugging,
  - connect via `agent-browser`,
  - evaluate authenticated fetch to `https://api.yutori.com/client/desktop/status` using `window.Clerk.session.getToken()`.
- Expected: API reflects current backend view of Yutori Local desktop presence.
- Actual: returned `{"connected":false}`.
- Artifacts:
  - `artifacts/logs/scouts-desktop-status.txt`
  - `artifacts/scouts-live/scouts-local-popover-disconnected.png`

## Remaining verification targets
- Production relay connected state screenshot in Scouts (`running`) once a production-equivalent relay handshake succeeds again.
- Production relay disconnected flip-back screenshot after a confirmed connected run.
- Full end-to-end browser session over the real production relay path.
- Reconnect proof against a working production relay endpoint.
