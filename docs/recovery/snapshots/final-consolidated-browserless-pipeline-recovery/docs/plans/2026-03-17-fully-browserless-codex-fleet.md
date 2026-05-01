# Fully Browserless Codex Fleet Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the latest rotation pipeline into a fully browserless, recovery-first, multi-workspace Codex fleet manager that keeps Pi’s workspace-backed Codex accounts healthy using live evidence, browserless recovery/recreation, quota-aware policy, and verified reconciliation.

**Architecture:** Keep `src/cli/pipeline-check-archive-replace.js` as the primary entrypoint, but refactor the browserless path into explicit audit, policy, recovery, placement, and verification layers. Replace the current local-Chrome fallback with a browserless recovery ladder, add lineage-aware multi-workspace discovery and capacity selection, and make quota policy explicit for both-exhausted, five-hour-only, and low-on-both states.

**Tech Stack:** Node.js, Jest, browserless `fetch` flows, ChatGPT/OpenAI internal HTTP APIs, AgentMail APIs, Pi auth/router JSON state

---

### Task 1: Lock in the no-local-Chrome invariant for browserless onboarding

**Files:**
- Modify: `tests/pipeline/rotation/routerOnboarder.test.js`
- Modify: `src/pipeline/rotation/routerOnboarder.js`
- Test: `tests/pipeline/rotation/routerOnboarder.test.js`

**Step 1: Write the failing test**

Add a test proving that `NO_EMAIL_CODE_OPTION` no longer triggers `createBrowserSession()` / `createChatGptAccountImpl()` fallback and instead routes into a new browserless recovery hook.

Test shape:

```js
test('NO_EMAIL_CODE_OPTION routes into browserless recovery and never launches local Chrome', async () => {
  const browserlessOnboardMember = jest.fn().mockRejectedValue(
    new Error('NO_EMAIL_CODE_OPTION: browserless auth replay hit password-only login for member@example.com at https://auth.openai.com/log-in/password'),
  );
  const recoverBrowserlessIdentity = jest.fn().mockResolvedValue({
    accessToken: makeJwt('member@example.com'),
    expiresAt: Date.now() + 3600000,
    accountId: 'workspace-123',
    identityEmail: 'member@example.com',
  });
  const createBrowserSession = jest.fn();
  const createChatGptAccountImpl = jest.fn();

  const result = await onboardInboxToPiRouter({
    email: 'member@example.com',
    apiKey: 'am_us_test',
    authJsonPath: authPath,
    routerJsonPath: routerPath,
    browserlessOnboardMember,
    recoverBrowserlessIdentity,
    createBrowserSession,
    createChatGptAccountImpl,
  });

  expect(recoverBrowserlessIdentity).toHaveBeenCalled();
  expect(createBrowserSession).not.toHaveBeenCalled();
  expect(createChatGptAccountImpl).not.toHaveBeenCalled();
  expect(result.auth.accountId).toBe('workspace-123');
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /home/epistemophile/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/routerOnboarder.test.js --runInBand
```

Expected: FAIL because `recoverBrowserlessIdentity` is not part of `routerOnboarder` yet and local fallback still runs.

**Step 3: Write minimal implementation**

- Add a new optional dependency to `onboardInboxToPiRouter()`:
  - `recoverBrowserlessIdentity`
- When browserless onboarding throws `NO_EMAIL_CODE_OPTION`, call that recovery hook.
- Remove the local Chrome fallback path from the default browserless branch.
- Preserve current state-registration and verification behavior after successful recovery.

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/pipeline/rotation/routerOnboarder.test.js src/pipeline/rotation/routerOnboarder.js
git commit -m "refactor: remove local browser fallback from router onboarding"
```

### Task 2: Add a reusable browserless identity recovery orchestrator

**Files:**
- Create: `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
- Create: `tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js`
- Modify: `src/pipeline/rotation/routerOnboarder.js`
- Test: `tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js`

**Step 1: Write the failing test**

Add table-driven tests covering recovery outcomes:

- existing-login OTP success
- direct password login success
- forgot-password success
- recovery exhausted → returns recreate-needed classification

Test shape:

```js
test.each([
  ['existing-login-otp', { verdict: 'authenticated', branch: 'existing-login-otp' }, 'recovered'],
  ['password-login', { verdict: 'authenticated', branch: 'password-login' }, 'recovered'],
  ['forgot-password', { verdict: 'authenticated', branch: 'forgot-password' }, 'recovered'],
])('%s returns recovered classification', async (_label, replayResult, expected) => {
  const result = await recoverBrowserlessIdentity({
    email: 'member@example.com',
    runPasswordLogin: jest.fn().mockResolvedValue(replayResult),
    runForgotPassword: jest.fn().mockResolvedValue(replayResult),
    runExistingLogin: jest.fn().mockResolvedValue(replayResult),
  });

  expect(result.status).toBe(expected);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js --runInBand
```

Expected: FAIL because the file/module does not exist.

**Step 3: Write minimal implementation**

Create `recoverBrowserlessIdentity.js` that:

- accepts `email`, `agentMailApiKey`, `analysis`, and branch runners/hooks
- tries recovery branches in deterministic order:
  1. existing-login OTP
  2. password login
  3. forgot-password reset
  4. password-init / set-password (placeholder hook for next tasks)
- returns typed results:
  - `{ status: 'recovered', auth, branch, replay }`
  - `{ status: 'recreate-needed', reason, attempts }`
  - `{ status: 'blocked', reason, attempts }`

Wire `routerOnboarder.js` to use this module as the default `recoverBrowserlessIdentity` implementation.

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/recoverBrowserlessIdentity.js tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js src/pipeline/rotation/routerOnboarder.js
git commit -m "feat: add browserless identity recovery orchestrator"
```

### Task 3: Extend auth replay to support password and forgot-password browserless branches

**Files:**
- Modify: `src/pipeline/authTrace/openaiAuthReplay.js`
- Create: `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`
- Modify: `src/pipeline/authTrace/openaiSentinelProvider.js` (if request signing is needed on new paths)
- Test: `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`

**Step 1: Write the failing test**

Add tests for:

- authorize redirect to `/log-in/password` and successful password login branch
- forgot-password initiation path, reset completion, and authenticated session
- unsupported password flow returning a typed blocker instead of falling through silently

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js --runInBand
```

Expected: FAIL because password/reset branches are not implemented.

**Step 3: Write minimal implementation**

In `openaiAuthReplay.js`:

- factor branch handlers so new auth branches are easy to add
- add a password-login branch when authorize redirects to `/log-in/password`
- add a forgot-password reset branch using injected hooks for reset-initiation, reset-email consumption, and password completion
- keep branch results deterministic and fully artifacted
- preserve cookie jar/session handling and final session verification

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/openaiAuthReplay.js src/pipeline/authTrace/openaiSentinelProvider.js tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js
git commit -m "feat: add browserless password recovery branches"
```

### Task 4: Add a live authoritative audit module for Codex aliases

**Files:**
- Create: `src/pipeline/rotation/liveFleetAudit.js`
- Create: `tests/pipeline/rotation/liveFleetAudit.test.js`
- Modify: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- Test: `tests/pipeline/rotation/liveFleetAudit.test.js`

**Step 1: Write the failing test**

Add tests that:

- start from router/health/auth fixtures
- exclude `greasyhands` from first-batch policy fixture
- keep `nastypolice` as a normal candidate
- prefer live probe over stale health
- produce classifications like `keep-live`, `recover-browserless`, `recreate-browserless`, `blocked`

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/liveFleetAudit.test.js --runInBand
```

Expected: FAIL because `liveFleetAudit.js` does not exist.

**Step 3: Write minimal implementation**

Create `liveFleetAudit.js` with a single export like `auditCodexFleetLive()` that:

- reads local router/auth/health state
- enumerates active Codex aliases
- applies configurable exclusions
- calls injected live-probe/auth/workspace predicates
- returns a stable audit result object with per-alias classification and evidence

Then call this at the start of `runCheckArchiveAndReplace()` and keep the result available to later phases.

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/liveFleetAudit.js tests/pipeline/rotation/liveFleetAudit.test.js src/pipeline/rotation/checkArchiveAndReplaceExhausted.js
git commit -m "feat: add live fleet audit for codex aliases"
```

### Task 5: Add quota-aware fleet policy classification

**Files:**
- Create: `src/pipeline/rotation/quotaPolicy.js`
- Create: `tests/pipeline/rotation/quotaPolicy.test.js`
- Modify: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- Test: `tests/pipeline/rotation/quotaPolicy.test.js`

**Step 1: Write the failing test**

Add tests covering:

- `healthy`
- `five-hour-exhausted-only`
- `both-exhausted`
- `low-on-both`
- hybrid trigger for pre-warming based on absolute floor + percentage threshold
- workspace-wide 5h exhaustion causing supplementation/prewarm classification

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/quotaPolicy.test.js --runInBand
```

Expected: FAIL because `quotaPolicy.js` does not exist.

**Step 3: Write minimal implementation**

Create `quotaPolicy.js` with helpers such as:

- `classifyQuotaState()`
- `shouldPrewarmWorkspace()`
- `chooseWorkspaceAction()`

Use injected thresholds, for example:

- `minHealthyAccountsPerWorkspace`
- `minHealthyFraction`

Then thread those policy decisions into the orchestrator so it knows when to:

- keep
- archive for reinstatement
- replace
- prewarm

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/quotaPolicy.js tests/pipeline/rotation/quotaPolicy.test.js src/pipeline/rotation/checkArchiveAndReplaceExhausted.js
git commit -m "feat: add quota-aware fleet policy"
```

### Task 6: Add multi-workspace lineage discovery and capacity-aware selection

**Files:**
- Create: `src/pipeline/rotation/workspaceRegistry.js`
- Create: `src/pipeline/rotation/workspaceSelector.js`
- Create: `tests/pipeline/rotation/workspaceRegistry.test.js`
- Create: `tests/pipeline/rotation/workspaceSelector.test.js`
- Modify: `src/cli/pipeline-check-archive-replace.js`
- Test: `tests/pipeline/rotation/workspaceRegistry.test.js`
- Test: `tests/pipeline/rotation/workspaceSelector.test.js`

**Step 1: Write the failing tests**

Add tests proving:

- multiple owner auth entries produce multiple discovered workspace records
- no workspace IDs are hardcoded
- placement prefers same lineage first
- within a lineage, the selector picks the healthiest workspace with capacity
- if preferred workspace is full, it spills to another workspace in the same lineage

**Step 2: Run tests to verify they fail**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/workspaceRegistry.test.js tests/pipeline/rotation/workspaceSelector.test.js --runInBand
```

Expected: FAIL because the modules do not exist.

**Step 3: Write minimal implementation**

Create:

- `workspaceRegistry.js` for dynamic owner/workspace discovery
- `workspaceSelector.js` for lineage-first, capacity-aware placement

Refactor `pipeline-check-archive-replace.js` so owner client creation and workspace resolution use the registry/selector rather than a single globally resolved workspace.

**Step 4: Run tests to verify they pass**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/workspaceRegistry.js src/pipeline/rotation/workspaceSelector.js tests/pipeline/rotation/workspaceRegistry.test.js tests/pipeline/rotation/workspaceSelector.test.js src/cli/pipeline-check-archive-replace.js
git commit -m "feat: add lineage-aware multi-workspace selection"
```

### Task 7: Teach browserless workspace onboarding to target dynamically selected workspaces

**Files:**
- Modify: `src/pipeline/rotation/browserlessWorkspaceClient.js`
- Modify: `src/pipeline/rotation/browserlessMemberOnboarder.js`
- Create: `tests/pipeline/rotation/browserlessMemberOnboarderMultiWorkspace.test.js`
- Test: `tests/pipeline/rotation/browserlessMemberOnboarderMultiWorkspace.test.js`

**Step 1: Write the failing test**

Add tests where:

- owner lineage exposes two workspaces
- invite is created in the selected workspace
- accept/verification is performed against that exact workspace
- owner-side membership verification uses the selected workspace, not a global one

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/browserlessMemberOnboarderMultiWorkspace.test.js --runInBand
```

Expected: FAIL because onboarding assumes one resolved workspace flow.

**Step 3: Write minimal implementation**

Update `browserlessMemberOnboarder.js` so it can accept a selected workspace record or selector callback and use that consistently for:

- owner invite creation
- invite acceptance
- membership verification
- returned workspace metadata

Adjust `browserlessWorkspaceClient.js` only if request helpers need to expose more per-workspace methods or evidence.

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/browserlessWorkspaceClient.js src/pipeline/rotation/browserlessMemberOnboarder.js tests/pipeline/rotation/browserlessMemberOnboarderMultiWorkspace.test.js
git commit -m "feat: support selected workspace targeting in browserless onboarding"
```

### Task 8: Add five-hour-only archive/reinstatement and prewarm workflow support

**Files:**
- Modify: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- Modify: `src/pipeline/rotation/archiveManager.js`
- Modify: `src/pipeline/rotation/inboxPoolManager.js`
- Create: `tests/pipeline/rotation/checkArchiveAndReplaceReinstatement.test.js`
- Test: `tests/pipeline/rotation/checkArchiveAndReplaceReinstatement.test.js`

**Step 1: Write the failing test**

Add tests for:

- five-hour-only exhausted account gets archived for reinstatement, not replaced immediately
- workspace-wide five-hour exhaustion triggers supplementation/prewarm classification
- low-on-both workspace creates or reserves prewarmed standby account entries

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/checkArchiveAndReplaceReinstatement.test.js --runInBand
```

Expected: FAIL because the orchestrator does not yet support those states.

**Step 3: Write minimal implementation**

Extend archive/pool/orchestrator state handling to represent:

- `archived-five-hour`
- `awaiting-reinstatement`
- `prewarmed`

Ensure these states are persisted atomically and do not collide with existing `available`, `in-use`, `failed`, `chatgpt-used` semantics.

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/checkArchiveAndReplaceExhausted.js src/pipeline/rotation/archiveManager.js src/pipeline/rotation/inboxPoolManager.js tests/pipeline/rotation/checkArchiveAndReplaceReinstatement.test.js
git commit -m "feat: add five-hour reinstatement and prewarm workflow"
```

### Task 9: Add verification gates so only fully verified accounts count as successful

**Files:**
- Create: `src/pipeline/rotation/verifyRecoveredAlias.js`
- Create: `tests/pipeline/rotation/verifyRecoveredAlias.test.js`
- Modify: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- Test: `tests/pipeline/rotation/verifyRecoveredAlias.test.js`

**Step 1: Write the failing test**

Add tests proving success requires all of:

- browserless session valid
- workspace membership confirmed
- Pi auth/router state present
- live Codex probe passes

and that missing any one check yields a typed failure.

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/verifyRecoveredAlias.test.js --runInBand
```

Expected: FAIL because the verification module does not exist.

**Step 3: Write minimal implementation**

Create `verifyRecoveredAlias.js` with a single orchestrated verifier and integrate it into both the recovery and recreate paths inside `checkArchiveAndReplaceExhausted.js`.

Do not archive old aliases or count replacements as successful until verification passes.

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/verifyRecoveredAlias.js tests/pipeline/rotation/verifyRecoveredAlias.test.js src/pipeline/rotation/checkArchiveAndReplaceExhausted.js
git commit -m "feat: require full live verification before accepting replacements"
```

### Task 10: Add audit artifacts and CLI output for the new browserless fleet flow

**Files:**
- Modify: `src/cli/pipeline-check-archive-replace.js`
- Modify: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- Create: `tests/cli/pipelineCheckArchiveReplaceBrowserlessFleet.test.js`
- Test: `tests/cli/pipelineCheckArchiveReplaceBrowserlessFleet.test.js`

**Step 1: Write the failing test**

Add a CLI/integration-style test proving the command:

- writes a browserless audit artifact
- reports counts for `keep-live`, `recovered`, `replaced`, `awaiting-reinstatement`, `prewarmed`, `blocked`
- does not mention local Chrome fallback

**Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/cli/pipelineCheckArchiveReplaceBrowserlessFleet.test.js --runInBand
```

Expected: FAIL because the new artifact/result surface does not exist.

**Step 3: Write minimal implementation**

Update the CLI and orchestrator summaries to expose the new browserless-fleet result model and write artifacts under a timestamped run directory.

**Step 4: Run test to verify it passes**

Run the same Jest command.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli/pipeline-check-archive-replace.js src/pipeline/rotation/checkArchiveAndReplaceExhausted.js tests/cli/pipelineCheckArchiveReplaceBrowserlessFleet.test.js
git commit -m "feat: expose browserless fleet audit artifacts and summaries"
```

### Task 11: Run focused verification, then full suite on affected areas

**Files:**
- No new files required unless fixing regressions

**Step 1: Run focused test groups**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js \
  tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js \
  tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js \
  tests/pipeline/rotation/liveFleetAudit.test.js \
  tests/pipeline/rotation/quotaPolicy.test.js \
  tests/pipeline/rotation/workspaceRegistry.test.js \
  tests/pipeline/rotation/workspaceSelector.test.js \
  tests/pipeline/rotation/browserlessMemberOnboarderMultiWorkspace.test.js \
  tests/pipeline/rotation/checkArchiveAndReplaceReinstatement.test.js \
  tests/pipeline/rotation/verifyRecoveredAlias.test.js \
  tests/pipeline/rotation/routerOnboarder.test.js \
  tests/cli/pipelineCheckArchiveReplaceBrowserlessFleet.test.js \
  --runInBand
```

Expected: PASS.

**Step 2: Run the full affected browserless/rotation suite**

Run:

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/authTrace/ tests/pipeline/rotation/ tests/cli/ --runInBand --testPathIgnorePatterns='/node_modules/'
```

Expected: PASS.

**Step 3: Fix any failures minimally**

Only touch failing files and keep changes scoped.

**Step 4: Commit**

```bash
git add src/cli src/pipeline tests
git commit -m "test: verify fully browserless codex fleet pipeline"
```

### Task 12: Document runtime usage and first-batch operating policy

**Files:**
- Modify: `docs/2026-03-17-browserless-workspace-onboarding.md`
- Create: `docs/2026-03-17-fully-browserless-codex-fleet-runbook.md`
- Test: n/a

**Step 1: Document operational commands**

Add concrete examples for:

- live audit only
- hybrid audit + remediation
- multi-workspace selection behavior
- five-hour-only reinstatement policy
- both-exhausted replacement policy
- first-batch exclusion policy for `greasyhands`

**Step 2: Record expected artifacts and verification outputs**

Document:

- audit artifact paths
- reconciliation outputs
- verification requirements
- typed blocker semantics

**Step 3: Commit**

```bash
git add docs/2026-03-17-browserless-workspace-onboarding.md docs/2026-03-17-fully-browserless-codex-fleet-runbook.md
git commit -m "docs: add fully browserless codex fleet runbook"
```
