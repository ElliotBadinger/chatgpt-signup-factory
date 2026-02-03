# Phase 01: Foundation E2E Trial Path Design

**Goal:** Deliver a fully autonomous, end-to-end business/team trial flow that provisions a fresh alias, completes signup/login + OTP (including Turnstile), reaches chat, and drives into checkout with fast-fail timeouts. Produce a working prototype run that completes without user input.

## Context & Constraints
- Use AgentMail for default email provisioning; only fall back to Cloudflare/Zoho alias when AgentMail provisioning fails.
- Strict fast-fail timeouts with a hard wall-clock deadline (< 5 minutes total).
- Existing flow uses `SignupFactory` state machine with snapshot-based detection.
- Checkout may open a Stripe tab; must choose correct page after actions.
- Tests currently live under `tests/` and must avoid `chrome-devtools-mcp` build tests.

## Architecture Overview
- Add a centralized `RunConfig` module with defaults and env overrides.
- Add `EmailProvisioner` to create AgentMail inbox and optional fallback alias creation.
- Thread config + provisioned email into `index.js` and `SignupFactory`.
- Strengthen `ChatGPTStateManager` with additional chat heading variants and explicit `ACCESS_DENIED` detection.
- Improve `SignupFactory` state handling (ABOUT_YOU split DOB, ACCESS_DENIED fast-fail).
- Stabilize handshake input selection in `verifyAccount()` with expanded selectors and short retries.
- Introduce page selection helper to prefer non-blank newest pages and known URL patterns.

## Error Handling & Timeouts
- `MAX_RUN_MS` caps the run; `STEP_TIMEOUT_MS` governs per-state transitions.
- OTP polling uses `OTP_TIMEOUT_MS`.
- Snapshot retries bounded by `SNAPSHOT_RETRY_MS`.
- State stuck detection controlled by `STATE_STUCK_LIMIT` with debug artifacts.

## Testing Strategy
- Update `tests/ChatGPTStateManager.test.js` to cover new chat variants and ACCESS_DENIED.
- Add a focused test for split DOB detection helpers.
- Configure Jest to ignore `chrome-devtools-mcp` build tests.

## Success Criteria
- A local run reaches chat and drives into checkout within `MAX_RUN_MS`.
- Failure modes produce debug artifacts and stop quickly.
- Targeted unit tests pass and cover new detection logic.
