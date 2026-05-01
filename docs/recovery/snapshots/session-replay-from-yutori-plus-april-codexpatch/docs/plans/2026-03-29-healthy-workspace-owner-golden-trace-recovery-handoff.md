# Healthy Workspace Owner Golden-Trace Recovery Handoff (2026-03-29)

## Scope and objective
- Target lane: healthy workspace owner credential recovery for workspace `a5052b4c-79aa-4415-b325-7161b5883518`
- Target owner identity: `nastypolicy361` / `workspace-owner-b`
- Immediate bounded request addressed before this handoff: trace-based explanation of why `enchantinglist306@agentmail.to` hits password-only auth and recovery stalls.
- Constraint for follow-up work: browserless-first recovery; any browser usage should extract reproducible state to convert back into browserless replay.

## Workflow completed in this lane
1. Read and traced the auth replay/recovery code paths responsible for password-only handling.
2. Pulled historical artifacts related to `enchantinglist306@agentmail.to` invite/onboard behavior.
3. Collected line-level evidence for where `NO_EMAIL_CODE_OPTION`, `password-login-unsupported`, and `forgot-password-unsupported` are produced.
4. Investigated reset-route frontend bundles and endpoint behavior (`/api/accounts/password/send-otp`) to test whether a direct API-only recovery path exists without missing route/session state.
5. Confirmed owner/inbox constraints observed in current state (owner mailbox lookup failures for expected addresses with available key).

## Exact trace/code evidence

### 1) Password-only branch detection and hard stop
- File: `src/pipeline/authTrace/openaiAuthReplay.js`
  - Password route detection: lines 601-639 (`/log-in/password` triggers password/fallback branches).
  - Password branch blocks without `continue_url`: lines 324-330 (`blockerReason: password-login-unsupported`).
  - Forgot-password branch requires password branch to emit `forgot-password-required`; otherwise returns `forgot-password-unsupported`: lines 380-385.
  - Forgot-password branch requires all three hooks (`initiateForgotPassword`, `consumeResetEmail`, `completeForgotPassword`), else returns `forgot-password-unsupported`: lines 388-393.

### 2) Recovery ladder and terminal reasoning
- File: `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
  - Recovery branch order: existing-login -> password-login -> forgot-password -> password-init: lines 94-141.
  - Password-login replay includes `submitOpenAiPasswordLogin`: lines 107-117.
  - Forgot-password replay currently passes mode only (no forgot hooks): lines 119-127.
  - Terminal fallback: returns blocked with last blocked reason if present, else `browserless-recovery-exhausted`: lines 262-263.

### 3) NO_EMAIL_CODE_OPTION propagation
- File: `src/pipeline/rotation/browserlessMemberOnboarder.js`
  - Password-only replay classification triggers deterministic `NO_EMAIL_CODE_OPTION`: lines 23-31.
  - Browserless recovery is attempted only after `NO_EMAIL_CODE_OPTION`: lines 221-239.

### 4) Historical artifact evidence for `enchantinglist306@agentmail.to`
- File: `artifacts/manual-browserless-onboard-live-rerun.log`
  - Invite list shows `enchantinglist306@agentmail.to` as pending invite: lines 10 and 22.
  - Prune operation targets `enchantinglist306@agentmail.to`: lines 11 and 23.
  - Onboarding attempt errors: `Only account owners can perform this action`: lines 12 and 24.
- File: `artifacts/bootstrap-live-fix/1773866450012-workspace-owner-a-fresh-root/controller-agentmailroot1773866450012-epistemophile-space/inbox-creation.json`
  - Inbox creation includes `enchantinglist306@agentmail.to`.
- File: `artifacts/live-wicked-remediation-20260328/codex-inbox-pool.before.json`
  - Pool entry includes `enchantinglist306@agentmail.to` and matching inbox id (lines 391-392 in prior grep evidence).

### 5) Reset endpoint probing evidence
- Route bundle discovery showed `RESET_PASSWORD_START` route invoking:
  - `POST https://auth.openai.com/api/accounts/password/send-otp`
- Endpoint probing outcomes:
  - Guessed params (`username`, `email`, etc.) -> `400 unknown_parameter`
  - Empty/no-body call -> `409 invalid_state` (`Invalid session. Please start over.`)
- Interpretation: endpoint exists but requires route/session/challenge context from prior browser state machine; raw API call is insufficient.

## Current blockers (as of this handoff)
1. Password-login replay is blocked by missing valid continuation state after password submit (observed in lane output as `password-login-unsupported`; direct password submit path had 403 challenge response previously observed).
2. Forgot-password branch is not fully implementable locally yet because recovery does not provide forgot hooks; code path intentionally returns `forgot-password-unsupported`.
3. Direct reset endpoint replay lacks prerequisite route/session/challenge state (`invalid_state`) and rejects guessed fields (`unknown_parameter`).
4. Healthy-workspace owner operations still hit authorization constraints (`Only account owners can perform this action`) while owner credential/session recovery remains unresolved.
5. Owner mailbox visibility for `workspace-owner-b` appears inconsistent with available key in observed checks (inbox lookup returning 404 for expected owner addresses).

## Browserless-first hypotheses
1. The missing piece is a reproducible route/session/challenge state machine for the password/reset branch, not a missing static endpoint.
2. A viable browserless replay likely requires capturing and replaying one or more ephemeral artifacts generated in-browser (route transaction state, anti-bot challenge token(s), and exact request sequencing).
3. Existing golden-signup trace methodology (sentinel-provider style) can be adapted if equivalent extractor logic is built for password/reset branch artifacts.

## Browser-derived extraction ideas (only to make replay browserless afterward)
1. Use CDP capture on password/reset path to extract exact request payloads, header deltas, and cookie transitions around:
   - `/log-in/password`
   - forgot-password trigger
   - `/api/accounts/password/send-otp`
   - reset completion endpoint(s)
2. Identify all server-validated opaque state fields (transaction/session ids, challenge token bindings) and classify:
   - derivable from previous responses,
   - generated client-side but reproducible,
   - anti-bot tokens requiring challenge solve.
3. Build a minimal deterministic extractor from captured browser events into a replay artifact schema (similar spirit to existing sentinel extraction).

## Exact files inspected
- `src/pipeline/authTrace/openaiAuthReplay.js`
- `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
- `src/pipeline/rotation/browserlessMemberOnboarder.js`
- `tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js`
- `src/cli/pipeline-auth-cdp-capture.js`
- `src/pipeline/authTrace/cdpLive/runAuthCdpCapture.js`
- `src/pipeline/authTrace/cdpLive/criticalAuthTracker.js`
- `src/pipeline/authTrace/cdpLive/browserCdp.js`
- `artifacts/manual-browserless-onboard-live-rerun.log`
- `artifacts/bootstrap-live-fix/1773866450012-workspace-owner-a-fresh-root/controller-agentmailroot1773866450012-epistemophile-space/inbox-creation.json`
- `artifacts/live-wicked-remediation-20260328/codex-inbox-pool.before.json`
- `~/.pi/agent/codex-inbox-pool.json` (read for pool/inbox linkage evidence)
- `~/.pi/agent/auth.json` (read for workspace-owner token/account/email mapping evidence)

## Commands used in this lane (exact command forms)
- `nl -ba .../openaiAuthReplay.js | sed -n '300,430p'`
- `nl -ba .../recoverBrowserlessIdentity.js | sed -n '80,180p'`
- `nl -ba .../recoverBrowserlessIdentity.js | sed -n '220,300p'`
- `nl -ba .../browserlessMemberOnboarder.js | sed -n '1,90p'`
- `nl -ba .../browserlessMemberOnboarder.js | sed -n '160,250p'`
- `nl -ba .../browserlessMemberOnboarder.js | sed -n '250,380p'`
- `nl -ba .../openaiAuthReplay.js | sed -n '450,760p'`
- `nl -ba .../manual-browserless-onboard-live-rerun.log | sed -n '1,220p'`
- `rg -n "enchantinglist306@agentmail.to|forgot-password-unsupported|password-login-unsupported|browserless-recovery-exhausted|NO_EMAIL_CODE_OPTION" ...`
- `rg --files src/cli | rg 'auth|replay|recover|onboard'`
- `node .../pipeline-auth-openai-replay.js --help`
- One bounded live probe command for replay+recovery (`node --input-type=module -e ...`) was started and then intentionally aborted by user before completion.

## Most promising next experiments (ranked)
1. **Capture password/reset CDP golden trace and derive replay artifact**
   - Why first: directly addresses missing route/session/challenge state.
   - Validation: replay can reproduce `send-otp` request shape/state without browser and avoid `invalid_state`.
2. **Implement forgot-password hooks in recovery with strict scope**
   - Wire `initiateForgotPassword`, `consumeResetEmail`, `completeForgotPassword` for `recoverBrowserlessIdentity`.
   - Validation: recovery attempt no longer returns `forgot-password-unsupported`; proceeds to either authenticated or explicit upstream anti-bot rejection.
3. **Instrument password-login submit diagnostics**
   - Persist full structured status/reason classifier for `submit_password_login` when non-JSON challenge pages are returned.
   - Validation: deterministic classifier distinguishes challenge block vs protocol mismatch.
4. **Owner mailbox reachability audit for workspace-owner-b**
   - Verify expected owner address, available API key scope, and inbox existence.
   - Validation: successful `GET /v0/inboxes/<owner>/messages` for the exact owner identity used in recovery.
5. **Controlled browser-to-browserless bridge test**
   - Run one browser capture solely to extract missing state; immediately test browserless replay from extracted artifact.
   - Validation: second run succeeds without browser interaction.

## Concrete validation plan for next investigator
1. Baseline replay/recovery check for `enchantinglist306@agentmail.to`
   - Record: branch, verdict, blockerReason, and per-attempt reasons.
   - Pass condition: hard evidence of current terminal branch and reason is captured in an artifact JSON.
2. CDP capture run for password/reset path
   - Use existing `pipeline-auth-cdp-capture`/`cdpLive` stack.
   - Record: ordered requests, response codes, cookies, and route transitions.
   - Pass condition: identify exact prereq state for `password/send-otp`.
3. Implement narrow hook support (if state extraction is sufficient)
   - Add only minimal recovery hooks and tests around new branch behavior.
   - Pass condition: tests cover supported + blocked outcomes deterministically.
4. Live browserless replay retest
   - Run replay/recovery for target email with extracted state artifacts.
   - Pass condition: authenticated session obtained browserlessly, no manual browser.
5. Onboarding + team-scope verification
   - Re-run healthy workspace onboarding.
   - Pass condition: alias is team-scoped, workspace membership materializes, and owner endpoints accept action.

## Notes for continuity
- This handoff intentionally stops before further live recovery action, per user instruction for this turn.
- No code logic changes were applied in this handoff turn; this file is the only new artifact produced now.