# Yutori Local Full Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Linux Yutori Local port to verified parity/reliability for all achievable subsystems, with fresh evidence for every completion-gate item.

**Architecture:** Preserve the extracted Electron app as the behavioral reference, make the smallest possible Linux-specific changes in the main-process/runtime layers, and verify each milestone with saved artifacts. Focus first on desktop control enablement, then sandbox hardening, reconnect reliability, anti-detection, storage/security, tests, logging, and docs.

**Tech Stack:** Electron 35, Node.js built-in test runner, ws, sharp, bubblewrap, KDE Plasma X11, extracted Yutori Local app sources.

---

### Task 1: Re-establish fresh baseline evidence (M1)

**Files:**
- Modify: `docs/verification.md`
- Modify: `docs/handoff-progress.md`
- Create: `artifacts/verification/M1-*`

- [ ] **Step 1: Re-run app launch and stored-credential recovery checks**

Run:
```bash
mkdir -p artifacts/verification
./node_modules/.bin/electron app.asar.extracted > artifacts/verification/M1-app-launch.log 2>&1 &
```
Expected: app launches, settings window becomes visible, logs show current config state.

- [ ] **Step 2: Capture fresh running/not-running relay proof**

Run the live app and authenticated Scouts checks from `docs/runbook.md`, saving fresh outputs under `artifacts/verification/M1-*`.
Expected: connected screenshot/API proof and disconnected screenshot/API proof.

- [ ] **Step 3: Re-run mock relay browser-session flow**

Run:
```bash
node scripts/mock-relay-server.mjs > artifacts/verification/M1-mock-relay-server.log 2>&1 &
YUTORI_RELAY_URL=ws://127.0.0.1:8787 ./node_modules/.bin/electron app.asar.extracted > artifacts/verification/M1-app-mock-relay.log 2>&1
```
Expected: fresh mock relay log with `initBrowser`, `executeAction`, `takeScreenshot`, `evaluateJs`, `closeBrowser`.

### Task 2: Investigate and enable Linux desktop control (M2)

**Files:**
- Modify: `app.asar.extracted/dist/main/desktop-permissions.js`
- Modify: `app.asar.extracted/dist/main/task-manager.js`
- Possibly modify: `app.asar.extracted/dist/main/desktop-executor.js`
- Possibly create: `tests/desktop-executor.test.js`
- Modify: `docs/verification.md`
- Modify: `docs/known-issues.md`
- Create: `artifacts/verification/M2-*`

- [ ] **Step 1: Prove backend availability before changing code**

Run:
```bash
node -e "console.log(process.platform, process.env.DISPLAY, process.env.WAYLAND_DISPLAY); const nut=require('./app.asar.extracted/node_modules/@nut-tree-fork/nut-js'); console.log(Object.keys(nut).slice(0,20));"
```
Expected: successful require of nut-js on Linux X11, saved output under `artifacts/verification/M2-nutjs-probe.log`.

- [ ] **Step 2: Create a failing regression test for Linux desktop-permission support**

Add a test asserting Linux X11 + available backend reports `platformSupported: true` and that non-darwin permission assertion does not reject when Linux backend is usable.
Expected: test fails before implementation.

- [ ] **Step 3: Implement the minimal Linux enablement**

Update `desktop-permissions.js` to return Linux support when X11 + nut-js backend are available. Update `task-manager.js` so `initDesktop` is allowed on supported Linux, keeping Statsig and user-toggle gating intact.
Expected: existing `DesktopExecutor` works unchanged or with only minimal Linux-safe adjustments.

- [ ] **Step 4: Verify desktop init/action/screenshot cycle**

Run an Electron/runtime probe that exercises `initDesktop`, `executeAction(left_click at 640,400)`, and `takeScreenshot`, storing logs/images under `artifacts/verification/M2-*`.
Expected: documented success, or exhaustive evidence of failure with exact error if input injection still breaks.

### Task 3: Harden Linux terminal sandbox and restore gating parity (M3)

**Files:**
- Modify: `app.asar.extracted/dist/main/index.js`
- Modify: `app.asar.extracted/dist/main/tools/terminal.js`
- Create: `tests/terminal-bwrap.test.js`
- Modify: `docs/verification.md`
- Modify: `docs/known-issues.md`
- Create: `artifacts/verification/M3-*`

- [ ] **Step 1: Add failing tests for bwrap args/gating expectations**

Add tests covering `--unshare-net`, `--clearenv`, and mount behavior for 0/1/3 allowed folders.
Expected: tests fail before implementation.

- [ ] **Step 2: Implement minimal hardening**

Add `--unshare-net` and `--clearenv` to bwrap args, export testable helpers if needed, and make Linux terminal registration follow the same Statsig gate behavior as the reference.
Expected: terminal registration and args match intended parity.

- [ ] **Step 3: Verify sandbox behavior end to end**

Run allowed command, disallowed path, timeout, output truncation, and network-isolation checks; save fresh evidence under `artifacts/verification/M3-*`.
Expected: all five scenarios produce clear pass/fail evidence.

### Task 4: Expand automated test coverage (M8)

**Files:**
- Create: `tests/relay-client.test.js`
- Create: `tests/session-store.test.js`
- Create: `tests/local-tools.test.js`
- Create: `tests/action-executor.test.js`
- Modify: `tests/desktop-permissions.test.js`
- Modify: `tests/relay-proxy.test.js` (only if needed)
- Modify: `docs/verification.md`

- [ ] **Step 1: Add relay-client state-machine tests**

Cover connect/disconnect state, heartbeat handling, reconnect backoff calculation, and `forceReconnect`.
Expected: multiple deterministic unit tests with mocked timers/ws.

- [ ] **Step 2: Add session-store and local-tools tests**

Cover credential CRUD, encryption/plaintext fallback behavior via mocked safeStorage, site logins, terminal folders, register/unregister/list/execute.
Expected: full CRUD behavior under test.

- [ ] **Step 3: Add action-executor dispatch tests**

Mock `cdp-actions` and verify all 16 action types map to the right dispatch calls.
Expected: ≥15 total tests across ≥5 files.

- [ ] **Step 4: Run the full suite and save fresh output**

Run:
```bash
npm test > artifacts/verification/M8-npm-test.log 2>&1
```
Expected: all tests passing.

### Task 5: Add security/observability/runtime verification (M4, M5, M6, M7, M9)

**Files:**
- Modify: `app.asar.extracted/dist/main/index.js`
- Possibly modify: `app.asar.extracted/dist/main/relay-client.js`
- Possibly create: logging helper under `app.asar.extracted/dist/main/`
- Modify: `docs/verification.md`
- Modify: `docs/known-issues.md`
- Create: `artifacts/verification/M4-*`
- Create: `artifacts/verification/M5-*`
- Create: `artifacts/verification/M6-*`
- Create: `artifacts/verification/M7-*`
- Create: `artifacts/verification/M9-*`

- [ ] **Step 1: Verify safeStorage backend and add warning if plaintext**

Log `safeStorage.getSelectedStorageBackend()` at startup (guarded for availability), verify API-key round-trip, and document if backend is `basic_text`.
Expected: fresh saved artifact and known-issues update.

- [ ] **Step 2: Verify anti-detection and login lifecycle**

Use a UA-detection page plus a live/mock login-window flow; capture UA screenshot and site-login sync evidence.
Expected: no `Electron` or app name in UA, sync PUT evidence saved.

- [ ] **Step 3: Add structured file logging**

Write logs to `~/.config/yutori-local/logs/app.log`, rotate at 5MB keeping 3 files, and tag relay/session events.
Expected: persistent log file evidence.

- [ ] **Step 4: Reconnect stress test**

Force 3 desktop-relay disconnect cycles and prove reconnect within target window plus post-reconnect browser-session success.
Expected: fresh `M4-*` logs and status flips.

### Task 6: Final documentation and completion-gate refresh (M10)

**Files:**
- Modify: `docs/runbook.md`
- Modify: `docs/verification.md`
- Modify: `docs/known-issues.md`
- Modify: `docs/handoff-progress.md`

- [ ] **Step 1: Update docs with exact commands, timestamps, and artifact paths**

Record every major verification in `docs/verification.md`, all operational steps in `docs/runbook.md`, residual limitations in `docs/known-issues.md`, and chronological work in `docs/handoff-progress.md`.
Expected: docs reflect final state exactly.

- [ ] **Step 2: Re-read the completion gate and confirm every row has evidence**

Run the fresh verification commands needed for any missing row.
Expected: zero unproven claims.
