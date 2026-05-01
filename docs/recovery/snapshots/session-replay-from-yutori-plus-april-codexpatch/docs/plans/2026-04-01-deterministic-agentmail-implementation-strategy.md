# Deterministic AgentMail Implementation Strategy

Date: 2026-04-01

## Objective

Move the system from mixed-workspace, partially synchronized rotation to a single canonical control plane that keeps at least 4 healthy `Root-Mail_a` aliases active with explicit per-window quota policy and fail-closed lifecycle handling.

## Canonical Control Plane Recommendation

Use `src/cli/pipeline-check-archive-replace.js` as the operator command and make it call one canonical lifecycle engine.

Recommended shape:

- operator command stays `node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js`
- `pipelineCheckArchiveReplaceLiveFix.js` remains the preparation layer
- `checkArchiveAndReplaceExhausted.js` becomes the canonical reconcile engine
- a new lifecycle reconciler module owns all writes to:
  - `auth.json`
  - `account-router.json`
  - archive state
  - inbox/pool state
  - codex-lb

Daemonization is deferred until this command path is correct. Do not keep a parallel legacy operator lane alive.

## Phase Order

### Phase 1: Introduce a single explicit policy module

Ownership:

- `quotaPolicy.js`
- new lifecycle policy module
- `quotaDetector.js`
- `archiveManager.js`

Work:

- replace current threshold constants with explicit `0.25` keep/replace/restore policy
- persist or derive a two-window structure:
  - `fiveHourRemainingFraction`
  - `weeklyRemainingFraction`
- define canonical lifecycle statuses:
  - `active`
  - `queued-replacement`
  - `archived`
  - `restorable`
  - `reinstated`
  - `quarantined`
- define conservative behavior for stale or ambiguous windows

Transaction constraint:

- do not change replacement behavior before the policy module exists, or the control plane will remain partly old and partly new

### Phase 2: Hard-lock production to the target workspace

Ownership:

- `workspaceSelector.js`
- `pipeline-check-archive-replace.js`
- `pipelineCheckArchiveReplaceLiveFix.js`

Work:

- require explicit target workspace id in production mode
- remove owner/name fallback from the production path
- keep generic fallback behavior only for non-production discovery utilities if still needed
- add explicit quarantine handling for aliases whose persisted workspace id is not `d3d588b2-8a74-4acc-aa2e-94662ff0e025`

Decision:

- non-target-workspace aliases do not participate in quota replacement
- they enter `quarantined` first
- after reconciliation succeeds, they are archived or disabled and removed from active routes

### Phase 3: Build the lifecycle reconciler

Ownership:

- new module, recommended names:
  - `src/pipeline/rotation/lifecycleReconciler.js`
  - `src/pipeline/rotation/codexLbLifecycleStore.js`
- thin write wrappers in `piAccountRegistrar.js`

Work:

- replace scattered one-off writes with ordered lifecycle transitions
- codify append-before-remove as a single reconciler operation
- reconcile Pi and codex-lb together
- make “active” require agreement across both stores plus runtime proof

Required ordered transitions:

1. create or verify durable replacement auth
2. append alias metadata and route in Pi
3. write codex-lb active state
4. run runtime verification
5. only then remove or archive the old alias

Rollback rule:

- if any step after append fails, remove the replacement from Pi and codex-lb before returning failure

### Phase 4: Finish the durability path

Ownership:

- `routerOnboarder.js`
- `openaiOwnedOauth.js`

Work:

- keep refresh-bearing auth mandatory
- treat owned OAuth as the primary durability route
- do not persist an alias until owned OAuth has produced a durable credential and workspace match
- make wrong-workspace owned OAuth results fail closed

Primary route:

- existing session plus Hydra login-challenge continuation plus PKCE token exchange

Fallback route:

- passwordless OTP continuation only if it still yields durable owned OAuth for the target workspace

Non-primary route:

- reset-password fallback may exist as a rescue branch, but it is not the primary operational lane

### Phase 5: Reconcile the current mixed fleet into the target state

Ownership:

- `pipelineCheckArchiveReplaceLiveFix.js`
- `checkArchiveAndReplaceExhausted.js`

Work:

- detect all active aliases not in `Root-Mail_a`
- quarantine them before quota logic
- count currently healthy `Root-Mail_a` aliases
- if fewer than 4, onboard durable replacements into `Root-Mail_a`
- if an archived `Root-Mail_a` alias is fully renewed and healthy, prefer restore before net-new creation

Priority order for filling the floor:

1. restore archived target-workspace alias with both windows `>= 0.25`
2. recover and durably onboard existing target-workspace candidate
3. create new target-workspace alias only if the above cannot satisfy the floor

### Phase 6: Archive and restore semantics

Ownership:

- `archiveManager.js`
- lifecycle reconciler

Work:

- enrich archive entries with:
  - workspace id
  - placement metadata
  - lifecycle state
  - archive reason
  - both quota windows at archive time
  - both quota windows at restore check
  - codex-lb state snapshot
- implement `restorable` standby state
- if active healthy count is already 4 or more, keep renewed aliases in archive as `restorable`, not immediately `reinstated`

### Phase 7: Remove legacy posture

Ownership:

- docs
- CLI messaging
- any legacy commands that bypass the canonical control plane

Work:

- mark mixed-workspace behavior as deprecated
- make the canonical operator command explicit in docs and CLI output
- route all production execution through the single reconcile path

## Exact Semantics Changes By File

### `src/pipeline/rotation/quotaPolicy.js`

- replace current threshold model with explicit dual-window `0.25`
- add `keep`, `queue-replacement`, `restorable`, `quarantine`
- remove logic that prewarms based on loose fractions without dual-window context

### `src/pipeline/rotation/quotaDetector.js`

- stop pretending one persisted fraction equals both windows
- either persist real 5-hour and weekly values or mark state as ambiguous and non-promotable

### `src/pipeline/rotation/archiveManager.js`

- replace `REINSTATEMENT_THRESHOLD = 0.1`
- store richer lifecycle metadata
- restore only when both windows are renewed to `>= 0.25`

### `src/pipeline/rotation/workspaceSelector.js`

- production path may only accept direct workspace-id match
- no owner/name fallback for `openai-codex` production lifecycle

### `src/pipeline/rotation/piAccountRegistrar.js`

- demote to a low-level Pi writer
- lifecycle reconciler owns higher-order transitions
- add explicit disable/quarantine semantics for wrong-workspace aliases

### `src/pipeline/rotation/routerOnboarder.js`

- persistence happens only after durable auth plus workspace match
- surface durable-auth failure as a first-class lifecycle result

### `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`

- replace current “assessment.exhausted” centric behavior with lifecycle decisions driven by:
  - workspace policy
  - dual-window quota policy
  - 4-healthy floor
  - restore-first logic
  - codex-lb agreement

### `src/cli/pipeline-check-archive-replace.js`

- require explicit target workspace for production
- print canonical control-plane identity and chosen workspace
- refuse mixed-workspace execution

### `src/cli/pipelineCheckArchiveReplaceLiveFix.js`

- treat wrong-workspace aliases as quarantine candidates
- use codex-lb as a synchronized lifecycle participant, not just a protection hint

## State Transition Model

Canonical transition graph:

- `candidate -> active`
- `active -> queued-replacement`
- `queued-replacement -> archived`
- `archived -> restorable`
- `restorable -> reinstated -> active`
- `active -> quarantined -> archived`

Forbidden shortcuts:

- `candidate -> active` without durable auth
- `archived -> active` without explicit restore verification
- `active -> removed` before replacement append succeeds when floor would drop below 4

## Decisive Branches And Fallback Routes

### Branch A: Target-workspace alias is already durable and restorable

Action:

- restore first
- verify
- promote only if healthy count is below 4

### Branch B: Target-workspace alias exists but is not durable

Action:

- run owned OAuth durability upgrade
- persist only after refresh-bearing success

Fallback:

- if owned OAuth primary lane is weak, use passwordless continuation only if it yields refresh-bearing target-workspace auth

### Branch C: Active alias is wrong-workspace but still quota-healthy

Action:

- quarantine immediately
- do not let quota health keep it in production

Fallback:

- archive or disable after synchronized reconciliation if clean quarantine cannot be represented in existing stores

### Branch D: codex-lb and Pi disagree

Action:

- alias is not healthy
- canonical control plane reconciles both stores before routing

Fallback:

- freeze alias in quarantine and exclude from floor count

## Dependencies

- dual-window quota persistence must land before policy correctness is possible
- lifecycle reconciler must land before codex-lb synchronization can be trusted
- explicit workspace lock must land before current mixed active pool can be safely repaired
- durable auth path must be stable before attempting to raise the healthy floor to 4

## Recommended Execution Order For The Next Implementation Agent

1. implement explicit policy and lifecycle state model
2. hard-lock production workspace selection
3. add lifecycle reconciler and codex-lb write boundary
4. finish durable-auth persistence path
5. quarantine wrong-workspace aliases
6. restore or durably onboard until 4 healthy `Root-Mail_a` aliases exist
7. remove legacy mixed-workspace posture and tighten docs/CLI output