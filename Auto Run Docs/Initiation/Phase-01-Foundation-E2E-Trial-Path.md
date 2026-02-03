# Phase 01: Foundation E2E Trial Path

Establish a fully autonomous, end-to-end business/team trial flow that provisions a fresh alias, completes signup/login + OTP, handles Turnstile if it appears, reaches chat, and drives into checkout with fast-fail timeouts. This phase fixes the known structural breakages and produces a working prototype run that completes without user input.

## Tasks

- [x] Add centralized run configuration and fail-fast timeouts:
  - Added `src/RunConfig.js`, wired to `src/index.js` and `src/SignupFactory.js`, and aligned Jest timeout.
  - Create a small config module (e.g., `src/RunConfig.js`) with defaults and env overrides for `MAX_RUN_MS`, `STEP_TIMEOUT_MS`, `OTP_TIMEOUT_MS`, `SNAPSHOT_RETRY_MS`, `STATE_STUCK_LIMIT` (all < 5 minutes total)
  - Thread config into `src/index.js` and `src/SignupFactory.js` so the main loop enforces a hard wall-clock timeout and short per-state waits
  - Update Jest global timeout in `jest.config.js` to match the new constraints

- [ ] Implement deterministic email + inbox provisioning for default runs:
  - Add an email provisioning helper (e.g., `src/EmailProvisioner.js`) that can:
    - Create a fresh AgentMail inbox and return `{ inboxId, address }`
    - Optionally create a Cloudflare routing alias and/or Zoho alias when configured
  - Update `src/index.js` to provision and pass `{ email, agentMailInbox }` into `new SignupFactory(...)` when not provided
  - Ensure cleanup of created aliases/inbox on success and on failure in `finally`

- [ ] Fix state detection drift and handle ACCESS_DENIED explicitly:
  - Update `src/ChatGPTStateManager.js` to recognize “What can I help with?” as `CHAT_INTERFACE`
  - Add any additional chat heading variants found in `repl_output*.txt`
  - Add an `ACCESS_DENIED` branch in `SignupFactory.handleState()` that fails fast with debug artifacts

- [ ] Make ABOUT_YOU deterministic for split DOB fields:
  - Update `SignupFactory.handleState()` to detect separate day/month/year spinbuttons
  - Fill each field individually (e.g., day=01, month=01, year=1990) and then continue
  - Keep the single-field fallback only if no split fields are detected

- [ ] Stabilize verification handshake input targeting:
  - Expand `verifyAccount()` input discovery to include contenteditable + textarea + role="textbox" variants
  - Prefer the most specific chat input element by scanning the snapshot for “message”/“prompt” near editable elements
  - Add a short retry loop with snapshot refresh before failing handshake

- [ ] Fix checkout page selection when Stripe opens a new tab:
  - Add a helper to choose the active page by URL pattern (e.g., `chatgpt.com`, `stripe.com`, `checkout.stripe.com`), preferring the newest non-blank page
  - Update `callTool()` (or create a dedicated `selectBestPage()` wrapper) to use the helper after each action

- [ ] Add/adjust unit tests for the new state logic and ABOUT_YOU handling:
  - Update `tests/ChatGPTStateManager.test.js` for the new chat heading variants and ACCESS_DENIED expectations
  - Add a focused test case for split DOB field detection in `tests/ChatGPTStateManager.test.js` or a new test file

- [ ] Run targeted tests and a single local smoke run:
  - Run `npm test` and fix failures
  - Run `node src/index.js` with env configured to verify a full autonomous pass (fail fast if exceeding `MAX_RUN_MS`)
