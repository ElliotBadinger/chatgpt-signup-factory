# Deterministic AgentMail Execution Roadmap

Date: 2026-04-02

## Purpose

Provide a stateless handoff roadmap for the next implementation agent. This document is execution-first: ordered slices, decisive branches, rollback points, and file ownership boundaries.

## Canonical Operator Command

All production execution should route through:

```bash
node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js
```

No alternate production mutation path should be used while this roadmap is being executed.

## Pre-Execution Checkpoint

Before editing code or mutating live state, confirm:

- active `openai-codex` providers in `~/.pi/agent/account-router.json`
- durable auth entries in `~/.pi/agent/auth.json`
- current quota and provider status in `~/.pi/agent/account-router-health.json`
- archive state in `~/.pi/agent/codex-alias-archive.json`
- codex-lb state in `~/.codex-lb/store.db`

The target assumption remains:

- active production workspace: `d3d588b2-8a74-4acc-aa2e-94662ff0e025`

Planning checkpoint:

- `.planning/PROJECT.md` and `.planning/REQUIREMENTS.md` already align with this roadmap and should be treated as the parallel program-level contract.
- `.planning/STATE.md` currently says Phase 1 is complete and ready for verification, while `.planning/ROADMAP.md` still shows all phases as not started. The next implementation agent should not inherit that ambiguity silently. Reconcile status first in operator notes or phase artifacts before claiming progress.

## Slice 1: Policy And State Model

Goal:

- replace legacy quota/archive semantics with the canonical lifecycle model

Files:

- `src/pipeline/rotation/quotaPolicy.js`
- `src/pipeline/rotation/quotaDetector.js`
- `src/pipeline/rotation/archiveManager.js`
- `src/pipeline/rotation/lifecycleModel.js`
- `src/pipeline/state/schemas.js`
- new shared lifecycle policy module if needed

Required outputs:

- explicit 5-hour and weekly policy decisions
- unified `0.25` keep/replace/restore threshold
- lifecycle states:
  - `active`
  - `queued-replacement`
  - `archived`
  - `restorable`
  - `reinstated`
  - `quarantined`

Existing planning assets to reuse:

- `.planning/phases/01-canonical-evidence-foundation/01-CONTEXT.md`
- `.planning/phases/01-canonical-evidence-foundation/01-01-PLAN.md`

Phase-1 specific note:

- `.planning` already decided that `reinstated` is a restore event, not a steady-state lifecycle value. The implementation agent should preserve that distinction instead of reintroducing `reinstated` as a durable state.

Checkpoint:

- tests prove no restore on partial or ambiguous quota evidence

Rollback rule:

- if dual-window persistence cannot be completed in the same slice, treat ambiguous state as non-promotable rather than preserving old threshold behavior

## Slice 2: Workspace Lock

Goal:

- make one-workspace-only production routing enforceable

Files:

- `src/pipeline/rotation/workspaceSelector.js`
- `src/cli/pipeline-check-archive-replace.js`
- `src/cli/pipelineCheckArchiveReplaceLiveFix.js`

Required outputs:

- production path requires explicit target workspace id
- no owner/name fallback for production
- wrong-workspace aliases are marked for quarantine before quota logic
- workspace or owner or root selection logic is unified behind one explicit production policy surface rather than split across CLI, routing-domain, registry, and selector helpers

Decisive branch:

- if a generic fallback path is still needed for non-production utilities, keep it out of the production command path

Checkpoint:

- mixed-workspace active pool is detectable and causes quarantine planning, not silent routing

## Slice 3: Lifecycle Reconciler

Goal:

- make Pi and codex-lb transition together

Files:

- new `src/pipeline/rotation/lifecycleReconciler.js`
- new `src/pipeline/rotation/codexLbLifecycleStore.js` or equivalent
- `src/pipeline/rotation/piAccountRegistrar.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`

Required outputs:

- append replacement before remove
- archive-on-replace
- synchronized writes to Pi plus codex-lb
- rollback on partial finalize failure
- canonical run artifact and friction ledger continue to reflect lifecycle transitions and rollback outcomes

Decisive branch:

- if codex-lb write support cannot be made atomic immediately, freeze aliases in quarantine instead of treating codex-lb as advisory

Checkpoint:

- an alias is not healthy unless Pi and codex-lb agree

## Slice 4: Durable Auth Boundary

Goal:

- ensure active aliases are refresh-bearing and target-workspace correct

Files:

- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/authTrace/openaiOwnedOauth.js`

Primary lane:

- Hydra login-challenge continuation plus PKCE exchange

Fallback lane:

- passwordless continuation only if it yields durable target-workspace auth

Non-goal:

- do not preserve access-token-only persistence
- do not treat browser-session artifacts as production-durable auth

Decisive branch:

- if owned OAuth returns wrong workspace or no refresh token, fail closed and do not persist

Checkpoint:

- tests and live-safe validation show durable auth is mandatory before registration

## Slice 5: Current Fleet Reconciliation

Goal:

- move production from mixed-workspace to target-workspace-only

Files:

- `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- lifecycle reconciler

Ordered actions:

1. identify wrong-workspace active aliases
2. quarantine them
3. count healthy target-workspace aliases
4. restore eligible archived target-workspace aliases first
5. onboard durable target-workspace replacements if floor still below 4
6. archive or disable wrong-workspace aliases after synchronized removal

Decisive branch:

- if a wrong-workspace alias is quota-healthy, workspace policy still wins and it must not stay in production routing

Checkpoint:

- active pool contains only `Root-Mail_a` aliases

## Slice 6: Floor Enforcement

Goal:

- preserve at least 4 healthy aliases through all transitions

Files:

- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- lifecycle reconciler
- verification tests

Required outputs:

- projected floor calculation before every removal
- restore-first behavior for target-workspace aliases
- `restorable` standby behavior when active healthy count is already 4 or more

Decisive branch:

- if removal would drop the floor below 4, block removal and continue recovery or restore instead

Checkpoint:

- append-before-remove and floor enforcement are covered in integration tests

## Slice 7: Verification And De-Legacy

Goal:

- prove the new control plane and deprecate conflicting posture

Files:

- tests touching policy, reconcile, onboarding, and verification paths
- docs and CLI copy that name the canonical operator command

Required outputs:

- unit coverage
- integration coverage
- live-safe verification checklist run
- explicit deprecation posture for old mixed-workspace assumptions
- updated `.planning` status so roadmap, state, and operator artifacts do not disagree about phase completion

Decisive branch:

- if daemonization is requested before the command path is stable, defer it; correctness of one command beats automation of two conflicting ones

Checkpoint:

- docs and CLI outputs point operators to one canonical path only

## Branch Matrix

### Branch A: Archived target-workspace alias is fully renewed

Action:

- restore if floor is below 4
- otherwise keep as `restorable`

### Branch B: Existing target-workspace alias can be durably upgraded

Action:

- run owned OAuth upgrade
- persist only after workspace and refresh verification

### Branch C: Wrong-workspace alias still looks healthy

Action:

- quarantine and remove from production lifecycle

### Branch D: codex-lb and Pi disagree

Action:

- freeze alias out of healthy count until reconciled

### Branch E: Inbox supplier becomes pacing item

Action:

- prefer restore and recovery of known target-workspace aliases before net-new inbox creation

## Suggested Commit Boundaries

1. policy and archive semantics
2. workspace lock
3. lifecycle reconciler and codex-lb sync
4. durable auth tightening
5. fleet reconciliation and floor enforcement
6. verification and doc cleanup

## Exit Criteria

The roadmap is complete only when:

- active `openai-codex` routes all point to `d3d588b2-8a74-4acc-aa2e-94662ff0e025`
- 4 or more aliases satisfy the healthy contract
- wrong-workspace aliases are quarantined or archived
- codex-lb and Pi agree on active versus archived lifecycle state
- restore behavior obeys the same `0.25` threshold as keep behavior