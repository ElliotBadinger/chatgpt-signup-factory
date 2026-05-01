# Deterministic AgentMail Execution Brief

Date: 2026-04-02

## Purpose

Convert the strategy package into an execution brief the next implementation agent can run slice by slice with minimal ambiguity.

This brief assumes:

- the operator command remains `node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js`
- the control plane target remains one active production workspace:
  - `Root-Mail_a`
  - `workspace-owner-a`
  - `d3d588b2-8a74-4acc-aa2e-94662ff0e025`

## Stage 0: Clean The Worktree Safely First

Current dirtiness evidence:

- `43` modified tracked files
- `5177` insertions / `316` deletions in tracked diffs
- `12639` untracked paths from `git ls-files --others --exclude-standard`

The next implementation agent should not begin code execution work until the tree is fully clean.

### Preserve-worthy tracked changes

These likely contain substantive implementation work and should be preserved before cleanup:

- `package.json`
- `.planning/config.json`
- `docs/pipeline.md`
- `docs/2026-03-17-fully-browserless-codex-fleet-runbook.md`
- `src/cli/*`
- `src/pipeline/authTrace/*`
- `src/pipeline/bootstrap/*`
- `src/pipeline/rotation/*`
- `tests/cli/*`
- `tests/pipeline/authTrace/*`
- `tests/pipeline/bootstrap/*`
- `tests/pipeline/rotation/*`

### Preserve-worthy untracked files

These appear authored rather than generated:

- `.planning/codebase/PI_CODEX_RECOVERY_SLICE.md`
- `.planning/phases/01-canonical-evidence-foundation/*`
- `artifacts/Hydra OAuth Continuation for Onboarded Aliases.md`
- new authored tests under:
  - `tests/agentmail/`
  - `tests/cli/pipelineAuth*.test.js`
  - `tests/cli/routerOnboardInboxes.test.js`
  - `tests/pipeline/authTrace/*.test.js`
  - `tests/pipeline/config/*.test.js`
  - `tests/pipeline/rotation/browserlessInvitePolicy.test.js`
  - `tests/pipeline/rotation/browserlessOwnedOauthUpgrade.test.js`
  - `tests/pipeline/rotation/browserlessWorkspaceClient.test.js`
  - `tests/scripts/onboardAliasWithPolledOtp.test.js`
  - `tests/tmp/manualStableWorkspaceOnboard.test.js`
- ambiguous but likely hand-authored utilities:
  - `.codex`
  - `tmp/*.mjs`
  - `tmp/*.js`

### Generated or disposable bulk outputs

These look like runtime residue and should be archived outside the repo or deleted after preservation:

- `.tmp-*`
- `.tmp-jest/`
- `artifacts/auth-*`
- `artifacts/bootstrap-live-fix/`
- `artifacts/direct-*`
- `artifacts/live-*`
- `artifacts/manual-*`
- `artifacts/onboard-polled-*`
- `artifacts/probe-*`
- `artifacts/recapture-*`
- `artifacts/rotation/`
- `artifacts/tmp-*`
- `artifacts/workspace-replays/`
- browser profiles and live state under:
  - `state/workspace-owner-*-profile*`
  - `state/*owner-profile*`
  - `state/rotation/ledger-*.json`
  - `state/rotation/runs/`

### Cleanup gate

The worktree is clean only when:

```bash
git status --short
```

returns nothing.

The safe route is:

1. preserve substantive tracked and untracked work on a dedicated safety branch or clean commits
2. archive ambiguous one-off files outside the repo if they are not being committed
3. remove disposable generated output
4. verify `git status --short` is empty

## Stage 1: Canonical Evidence Foundation

Goal:

- make lifecycle vocabulary, blocker taxonomy, and canonical run artifacts explicit before more production mutations are trusted

Primary files:

- `src/pipeline/rotation/lifecycleModel.js`
- `src/pipeline/state/schemas.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/cli/pipeline-check-archive-replace.js`
- `src/pipeline/rotation/liveFleetAudit.js`
- `src/pipeline/evidence/artifacts.js`

Planning assets to reuse:

- `.planning/phases/01-canonical-evidence-foundation/01-CONTEXT.md`
- `.planning/phases/01-canonical-evidence-foundation/01-01-PLAN.md`

Expected outputs:

- canonical lifecycle states:
  - `candidate`
  - `active`
  - `queued-replacement`
  - `archived`
  - `restorable`
  - `quarantined`
- `reinstated` recorded only as a restore event
- canonical blocker classes
- canonical run artifact path surfaced in CLI output
- friction ledger preserved across runs

Primary tests:

- `tests/pipeline/rotation/lifecycleModel.test.js`
- `tests/pipeline/state/schemas.test.js`
- `tests/pipeline/rotation/checkArchiveAndReplaceExhausted.test.js`

Gate:

- lifecycle vocabulary and artifact model are explicit and tested

## Stage 2: Workspace Lock And Quarantine

Goal:

- production aliases are either in the target workspace or out of production

Primary files:

- `src/pipeline/rotation/workspaceSelector.js`
- `src/cli/pipeline-check-archive-replace.js`
- `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- `src/pipeline/rotation/resolveExhaustedAliasLineage.js`
- `src/pipeline/rotation/workspaceRegistry.js`

Expected outputs:

- production path requires explicit target workspace id
- owner/name/synthetic-workspace fallback removed from the production lane
- wrong-workspace aliases quarantined before quota reasoning
- mixed-workspace active routing explicitly reported

Primary tests:

- `tests/pipeline/rotation/workspaceSelector.test.js`
- `tests/pipeline/rotation/workspaceRegistryOperational.test.js`
- `tests/pipeline/rotation/workspaceRegistryUsableSelection.test.js`
- `tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js`

Gate:

- production-active aliases all resolve to `d3d588b2-8a74-4acc-aa2e-94662ff0e025`

## Stage 3: Canonical Reconcile Boundary

Goal:

- one lifecycle transition boundary updates Pi, archive state, and codex-lb with rollback semantics

Primary files:

- new `src/pipeline/rotation/lifecycleReconciler.js`
- new `src/pipeline/rotation/codexLbLifecycleStore.js`
- `src/pipeline/rotation/piAccountRegistrar.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/cli/pipeline-check-archive-replace.js`

Expected outputs:

- append-before-remove as one transition
- archive-on-replace mandatory
- rollback clears partial Pi and codex-lb residue
- active state requires store agreement

Primary tests:

- `tests/pipeline/rotation/piAccountRegistrar.test.js`
- `tests/cli/pipelineCheckArchiveReplace.test.js`
- `tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js`
- add or extend reconciler-specific tests

Gate:

- a failed replacement leaves no active Pi route, no active auth, and no active codex-lb row

## Stage 4: Durable Auth And Verification Gates

Goal:

- only renewable, target-workspace-correct aliases can become or remain active

Primary files:

- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/authTrace/openaiOwnedOauth.js`
- `src/pipeline/authTrace/openaiAuthReplay.js`
- `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
- `src/pipeline/rotation/browserlessMemberOnboarder.js`
- `src/pipeline/rotation/runtimeAliasProbe.js`
- `src/pipeline/rotation/verifyRecoveredAlias.js`

Expected outputs:

- Hydra plus PKCE is the primary durable-auth lane
- passwordless continuation is fallback only if it yields durable target-workspace auth
- access-token-only and browser-session-only auth cannot be promoted
- wrong-workspace owned OAuth results fail closed

Primary tests:

- `tests/pipeline/authTrace/openaiOwnedOauth.test.js`
- `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`
- `tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js`
- `tests/pipeline/rotation/browserlessMemberOnboarder.test.js`
- `tests/pipeline/rotation/routerOnboarder.test.js`
- `tests/pipeline/rotation/runtimeAliasProbe.test.js`
- `tests/pipeline/rotation/verifyRecoveredAlias.test.js`

Gate:

- active aliases are refresh-bearing, workspace-correct, and runtime-verified

## Stage 5: Dual-Window Fleet Capacity Policy

Goal:

- queue replacement and restore using explicit 5-hour plus weekly windows while preserving the healthy floor

Primary files:

- `src/pipeline/rotation/quotaPolicy.js`
- `src/pipeline/rotation/quotaDetector.js`
- `src/pipeline/rotation/archiveManager.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`

Expected outputs:

- separate `fiveHourRemainingFraction` and `weeklyRemainingFraction`
- keep only if both `>= 0.25`
- replace if either `< 0.25`
- restore only if both `>= 0.25`
- ambiguous or stale quota evidence blocks promotion and restore
- floor of at least 4 healthy aliases enforced through transitions

Primary tests:

- quota policy and detector tests
- archive manager tests
- integration coverage in `pipelineCheckArchiveReplace*` tests

Gate:

- quota semantics are exact and no longer depend on a collapsed single fraction

## Stage 6: Restore-First Fleet Reconciliation

Goal:

- prefer restore and upgrade of target-workspace aliases over net-new creation

Primary files:

- `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- lifecycle reconciler
- archive manager

Expected outputs:

- restore-first behavior for eligible target-workspace archived aliases
- `restorable` standby state when floor is already met
- wrong-workspace aliases archived or disabled after synchronized removal

Primary tests:

- `tests/cli/pipelineCheckArchiveReplaceBrowserlessFleet.test.js`
- `tests/cli/pipelineCheckArchiveReplaceLiveBootstrap.test.js`
- `tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js`

Gate:

- active pool contains only `Root-Mail_a` aliases and at least 4 of them satisfy the full healthy contract

## Stage 7: Verification And De-Legacy

Goal:

- prove the control plane and remove documentation or CLI ambiguity

Primary files:

- docs and CLI summary output
- verification tests
- `.planning` status documents if execution advances the phase state

Expected outputs:

- live-safe verification commands documented and run
- canonical operator command named everywhere
- `.planning/STATE.md`, `.planning/ROADMAP.md`, and the operator artifacts no longer disagree about phase progress

Primary verification:

- `git status --short` clean
- policy tests pass
- integration tests pass
- live-safe verification commands show only target-workspace active aliases

## Subagent Operating Pattern

Use one implementer owner per stage.

Allowed parallelism:

- independent read-only explorers for narrow questions
- one spec reviewer and one code reviewer only after the owner’s tests pass

Do not:

- assign multiple implementers to the same stage
- re-review after every small fix
- start implementation before Stage 0 cleanup is complete

## Exit Condition

The execution brief is complete when the next implementation agent can:

1. start from a fully clean worktree
2. follow the stages in order
3. know the exact files, tests, and gates for each stage
4. finish with one active production workspace and a 4-healthy alias floor