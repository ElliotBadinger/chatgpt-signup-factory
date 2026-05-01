# Yutori Local Linux Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a launchable Linux Yutori Local app that authenticates, provisions credentials, connects to the production relay, executes browser sessions, and clearly surfaces Linux-specific capability differences.

**Architecture:** Reuse the recovered Electron runtime behavior for protocol parity, but add a Linux launch wrapper, safe persistence/logging, a Linux-safe terminal executor, and runtime capability detection for desktop control and iMessage. Keep browser execution on Electron + CDP for highest parity with the macOS reference.

**Tech Stack:** Electron, Node.js, recovered Yutori runtime modules, WebSocket relay, BrowserWindow/CDP, local HTML/JS settings UI where needed, Node test/integration scripts.

---

## File structure / ownership

- `package.json` — root launcher scripts and dependencies for the Linux port
- `app/` — Linux-port-specific wrapper files if new shell files are needed
- `app.asar.extracted/dist/main/*.js` — recovered runtime modules patched for Linux compatibility
- `docs/handoff-progress.md` — ongoing execution log
- `docs/runbook.md` — exact run instructions
- `docs/verification.md` — commands, outputs, and artifact references
- `docs/known-issues.md` — residual limitations and honest capability notes
- `artifacts/` — screenshots, logs, traces, and verification output

## Execution phases

### Phase 1: Launchable app shell
- [ ] Add root package metadata and Electron launch script.
- [ ] Start the recovered app on Linux and record the baseline behavior.
- [ ] Save startup logs and first UI screenshots.

### Phase 2: Auth and persistence
- [ ] Verify the recovered auth flow still provisions keys on Linux.
- [ ] Reuse existing authenticated machine context where possible.
- [ ] Confirm credentials persist and survive relaunch.

### Phase 3: Relay presence
- [ ] Verify the app connects to `/ws/desktop/<userId>` with heartbeat/reconnect.
- [ ] Capture logs showing connected/disconnected state.
- [ ] Capture Scouts screenshots showing running/not-running.

### Phase 4: Browser parity
- [ ] Verify `/ws/browser/<sessionId>` handling from the app path.
- [ ] Exercise init/action/screenshot/evaluateJs behavior.
- [ ] Save protocol traces and screenshots.

### Phase 5: Linux compatibility work
- [ ] Replace macOS terminal sandboxing with Linux-safe execution.
- [ ] Detect/surface desktop-control support honestly.
- [ ] Ensure iMessage remains unavailable and unregistered.

### Phase 6: Hardening
- [ ] Add durable log output paths and runbook guidance.
- [ ] Verify relaunch/reconnect/state recovery.
- [ ] Update docs with exact commands and artifacts.
