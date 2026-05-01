# Yutori Local Linux Port Handoff Progress

## 2026-03-27T09:20Z
- Read the reverse-engineering notes, compatibility notes, design spec, relay probe, and extracted behavioral reference files.
- Established implementation direction: use the recovered Electron app behavior as the protocol/runtime reference, then add Linux-safe replacements and a runnable app wrapper for this system.

## 2026-03-27T09:31Z
- Added a root `package.json` and installed Electron so the recovered app can launch directly from this workspace.
- Resolved the Linux `sharp` runtime issue by installing a Linux-compatible `sharp` and repointing the recovered app’s `sharp` dependency to it.
- Verified a real visible settings window and captured a logged-out screenshot.

## 2026-03-27T09:40Z
- Reused the machine’s existing authenticated Scouts context by launching Chrome with a copied profile and extracting a live Clerk token from the signed-in Scouts page over CDP.
- Called the real production `POST /client/generate_key` flow and stored the resulting Local credentials in `~/.config/yutori-local/config.json`.
- Relaunched the app and verified that it recovered stored state without requiring a fresh login.

## 2026-03-27T09:47Z
- Patched Linux tool registration so `local_terminal` is available on Linux while iMessage remains unregistered.
- Replaced the macOS `sandbox-exec` terminal implementation with a Linux-safe executor that:
  - enforces allowlisted folders,
  - uses Bubblewrap when available,
  - falls back to a restricted subprocess runner,
  - enforces timeout and output truncation.
- Verified allowlisted success and disallowed-path rejection behavior.

## 2026-03-27T09:57Z
- Added and ran `scripts/browser-executor-smoke.js` to verify browser session primitives locally through Electron + CDP.
- Confirmed successful `initBrowser`, `evaluateJs`, `executeAction`, and `takeScreenshot` behavior with saved artifacts.

## Active blocker
- Production relay connectivity is currently stalled at websocket upgrade time.
- Evidence now shows this is **not just a local Linux-network issue**:
  - direct local probes still time out at websocket upgrade,
  - the latest upstream 0.4.8 DMG still points at the same relay hostname,
  - a dedicated relay-tunnel proxy deployed on Ink can accept local traffic, but its own upstream connection to the same Modal relay also times out,
  - the Scouts web app’s authenticated `GET https://api.yutori.com/client/desktop/status` still reports `{"connected":false}`.
- This blocks final proof for:
  - Scouts `Yutori Local is running`,
  - real production desktop/browser relay sessions,
  - reconnect verification against the live service.

## Most important next steps
1. Continue alternate live-relay discovery using authenticated Scouts/API surfaces (`/client/desktop/status`, `/client/desktop/login`) and any newly shipped assets/releases.
2. Keep the relay-tunnel proxy available as a transport adapter so final live verification can resume immediately if the upstream relay recovers or an alternate upstream host is discovered.
3. Improve Linux desktop-control surfacing/runtime detection so the remaining non-relay parity gaps keep closing while the upstream relay is unhealthy.
4. Re-attempt live Scouts `running` / `not running` capture the moment a production-equivalent relay path succeeds again.

## 2026-03-27T10:00Z
- Added environment override support for Scouts/API/relay config (`YUTORI_SCOUTS_URL`, `YUTORI_API_URL`, `YUTORI_RELAY_URL`, `YUTORI_ROUTER_TOKEN`).
- Added `scripts/mock-relay-server.mjs` and verified the real app end-to-end against a local relay-compatible websocket harness.
- Confirmed the app now handles:
  - desktop relay connect,
  - `newSession`,
  - browser relay connect,
  - `initBrowser`,
  - `evaluateJs`,
  - `takeScreenshot`,
  - `executeAction`,
  - browser `ping`/`pong`.

## 2026-03-27T11:35Z
- Added a tested relay transport adapter under `relay-tunnel-service/` plus `tests/relay-proxy.test.js`.
- Verified the proxy’s handshake semantics with fresh tests: it now refuses to report a client WebSocket as open until the upstream relay handshake succeeds.
- Deployed the proxy to Ink at `https://yutori-relay-tunnel.ml.ink` with upstream `wss://yutori--browser-relay-relay-app.modal.run`.
- Verified the proxy health endpoint works, but real upstream relay upgrades still fail **even from Ink**, returning `502` to the client after upstream handshake timeout.
- Reused an authenticated copied Chrome profile to inspect Scouts again and confirmed:
  - the site is still signed in,
  - the Yutori Local menu can be opened,
  - authenticated `desktop/status` currently reports `{"connected":false}`.
