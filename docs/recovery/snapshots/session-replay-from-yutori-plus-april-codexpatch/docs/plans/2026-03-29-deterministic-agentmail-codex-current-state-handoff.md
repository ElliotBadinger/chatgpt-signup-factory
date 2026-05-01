# Deterministic AgentMail/Codex Pipeline Handoff (2026-03-29)

## Mission and scope
- Project: deterministic AgentMail/Codex pipeline in `chatgpt-factory-bundle`
- Immediate mission: recover healthy-workspace owner path and preserve deterministic onboarding behavior
- Workspace focus:
  - healthy workspace: `a5052b4c-79aa-4415-b325-7161b5883518`
  - owner lineage: `workspace-owner-b` / `nastypolicy361`

This file is the current onboarding baseline for new agents joining the pipeline effort.

## Proven current state

### Live-safe posture
- `openai-codex` live router pool currently has:
  - providers: `sprintc_20260314032841c`, `sprintc_20260314032841b`, `enchantinglist306`
  - routes for all three on model `gpt-5.4`
- Evidence source:
  - `~/.pi/agent/account-router.json` queried via `jq '.pools[] | select(.name=="openai-codex") | {providers,routes}'`
- `wickedlist240@agentmail.to` remains quarantined:
  - `status: "repair-needed"`
  - `linkedAliasId: null`
- Evidence source:
  - `~/.pi/agent/codex-inbox-pool.json`

### Pipeline hardening already landed
- Fail-closed onboarding behavior is in place for:
  - personal/free auth persistence risk
  - invite creation paths that error without a usable invite
  - workspace mismatch and non-materialized membership outcomes
- Owner resolution in manual healthy-workspace runner is tightened:
  - owner lane now requires proven `account-owner` identity, not just `listUsers()` capability

### Recent code changes with direct relevance
- `src/cli/recapture-agentmail-keys.js`
  - adds mandatory mailbox authority verification before recapture signin
- `src/pipeline/bootstrap/realStage1.js`
  - paginated `findRuleByEmail`
  - transient mailbox fetch retry in `pollOtp`
- `tests/pipeline/bootstrap/realStage1.test.js`
  - pagination + transient fetch regressions
- `tmp/manual-stable-workspace-onboard.mjs`
  - strict owner validation path
- `tests/tmp/manualStableWorkspaceOnboard.test.js`
  - owner-vs-standard-user guardrails
- `tests/pipeline/authTrace/runAuthCdpCapture.test.js`
  - capture runner phase-action coverage on owner password-reset mode

### Verified test runs from recent cycles
- `node --check src/cli/recapture-agentmail-keys.js` (pass)
- `npm test -- --runInBand tests/pipeline/bootstrap/realStage1.test.js` (pass)
- `npm test -- --runInBand tests/tmp/manualStableWorkspaceOnboard.test.js tests/pipeline/rotation/browserlessMemberOnboarder.test.js tests/pipeline/rotation/browserlessMemberOnboarderMultiWorkspace.test.js` (pass)

## Strongest current blockers (do not dilute)
1. Owner credential path is still unresolved for healthy workspace owner lineage.
2. Refresh-token recovery for owner lineage has returned hard failures in prior runs (`refresh_token_expired` / `refresh_token_reused`).
3. OTP-based owner recovery has repeatedly timed out in current channels.
4. Non-owner invite cleanup is correctly blocked by owner-only enforcement.
5. Password-only branch recovery for pending invite fallback still lacks decisive browser-derived transition replay.

## Explored dead ends (do-not-repeat unless new evidence appears)
- Repeating fresh-email non-owner onboarding loops:
  - `createInvite` falls into `errored_emails`
  - prune/cancel then fails with owner-only authorization
- Treating any alias that can `listUsers()` as owner:
  - this was false and has been fixed
- API-only password reset probing without route/session context:
  - produced invalid/unsupported state errors
- Re-running password replay without extracted continuation state:
  - repeatedly returns password-login unsupported outcomes
- Treating OTP timeout as proof of final impossibility:
  - not acceptable; only acceptable if trace-level evidence shows no remaining state-machine path

## Currently active promising branch
- Owner: Wegener branch (live capture/recovery lane)
- Active hypothesis:
  - bootstrap now reaches live password page
  - missing piece is deterministic forgot-password/reset phase driving inside CDP capture to extract decisive post-password transition
- Most relevant current artifacts:
  - `artifacts/auth-traces/2026-03-29T03-10-55-203Z-owner-password-reset-bootstrap-cookies`
  - `artifacts/auth-traces/2026-03-29T03-08-18-345Z-owner-password-reset-bootstrap`
  - `artifacts/tmp-replay-diagnostics/2026-03-29T03-08-owner-password-login-stub/owner-password-login-stub.json`
  - `artifacts/tmp-replay-diagnostics/2026-03-29T03-00-derive-authorize/openai-auth-replay.json`

## New agent onboarding checklist
1. Read this file fully.
2. Read:
   - `docs/plans/2026-03-29-healthy-workspace-owner-golden-trace-recovery-handoff.md`
   - `docs/pipeline.md`
   - `docs/2026-03-17-fully-browserless-codex-fleet-runbook.md`
3. Confirm live-safe posture before any mutation:
   - inspect `~/.pi/agent/account-router.json`
   - inspect `~/.pi/agent/codex-inbox-pool.json`
4. Check current active owner lane artifacts before adding a new branch.
5. Preserve single-owner-per-branch discipline.

## Branch ownership rules (mandatory)
- One implementer per code branch/slice.
- One read-only analyst per independent question.
- No duplicate implementers touching the same files simultaneously.
- Close finished branches quickly to avoid thread-limit churn.

## Completion criteria for this lane
1. Owner credential becomes recoverable with evidence.
2. Healthy-workspace onboarding succeeds deterministically.
3. Persisted alias is verified team-scoped and workspace-valid.
4. Live router/pool reflect only valid providers.
5. Evidence artifacts and runbook docs updated.

## Mandatory evidence format for future updates
- Every claim must cite:
  - exact file/artifact path
  - command used (when applicable)
  - concrete status/result
- No blocker statements without:
  - attempted paths
  - why each path failed
  - what materially changed since the previous attempt