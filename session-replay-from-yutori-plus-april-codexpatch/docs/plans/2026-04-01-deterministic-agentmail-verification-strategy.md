# Deterministic AgentMail Verification Strategy

Date: 2026-04-01

## Done Definition

The work is done only when production routing can be proven to satisfy all of these:

- all active `openai-codex` aliases point to workspace `d3d588b2-8a74-4acc-aa2e-94662ff0e025`
- at least 4 aliases satisfy the full healthy alias contract
- every active alias is synchronized in Pi and codex-lb
- wrong-workspace aliases are not in active production routing
- archive and restore semantics respect the exact `0.25` dual-window threshold
- failure cases leave no live auth/router residue

## Verification Layers

### 1. Unit Verification

Required unit coverage:

- quota classification with explicit 5-hour and weekly windows
- `>= 0.25` keep behavior
- `< 0.25` replace behavior for either window
- restore gating requiring both windows `>= 0.25`
- quarantine decisions for wrong-workspace aliases
- append-before-remove ordering
- lifecycle reconciler rollback on partial failure
- codex-lb agreement requirement
- archive entry schema and transition logic
- workspace lock behavior in production selector

Unit assertions must cover:

- active pool already at 4 healthy aliases and an archived alias becomes restorable
- wrong-workspace alias that is quota-healthy
- stale or ambiguous quota evidence
- owned OAuth result missing refresh token
- `workspace-account-mismatch`
- `MEMBERSHIP_NOT_MATERIALIZED`

### 2. Integration Verification

Required fixture surfaces:

- `auth.json`
- `account-router.json`
- `account-router-health.json`
- `codex-inbox-pool.json`
- archive file
- codex-lb sqlite store

Required integration scenarios:

- replacement append succeeds, old alias remains until verification, then old alias is archived
- replacement append fails and leaves no new Pi or codex-lb residue
- wrong-workspace active alias is quarantined and removed from production routes
- archive restore produces `restorable` when floor is already met
- restore promotes to `active` when healthy count is below 4
- codex-lb active plus Pi missing route results in alias being excluded from healthy count
- Pi route plus codex-lb deactivated results in alias being excluded from healthy count

### 3. File-State Verification

Post-run file checks must prove:

- `auth.json` has durable auth for all active aliases
- `account-router.json` active providers and routes exactly match intended active aliases
- every active alias record carries `workspaceId = d3d588b2-8a74-4acc-aa2e-94662ff0e025`
- wrong-workspace aliases are absent from active providers/routes
- archive file contains replaced aliases with complete metadata
- restorable archived aliases remain archived when the active floor is already satisfied

### 4. Runtime Verification

Each active alias must pass runtime verification:

- browserless workspace API probe passes
- live `pi` provider probe passes
- workspace account selected in session matches persisted workspace id
- session identity is present
- codex usability is verified

An alias fails healthy verification if any of those checks fail.

### 5. codex-lb Verification

For every active alias:

- codex-lb row exists
- codex-lb status is active
- codex-lb `chatgpt_account_id` matches `d3d588b2-8a74-4acc-aa2e-94662ff0e025`
- no quarantined or archived alias remains active in codex-lb

For every archived or quarantined alias:

- Pi active routes are absent
- codex-lb active status is absent

### 6. Workspace Invariant Verification

Run explicit checks that:

- there is exactly one workspace id among active `openai-codex` routes
- that workspace id is `d3d588b2-8a74-4acc-aa2e-94662ff0e025`
- no active alias remains on `a5052b4c-79aa-4415-b325-7161b5883518`

### 7. Route Handoff Ordering Verification

Required assertions for every replacement:

1. replacement route is appended first
2. runtime verification for replacement passes
3. old alias is then archived and removed from active routes
4. healthy floor never drops below 4 during the transition

If the floor would drop below 4, removal must be blocked.

### 8. Archive/Reinstate Verification

Required assertions:

- archive-on-replace always occurs
- archived alias retains credentials and placement metadata
- restore happens only after both quota windows are renewed to `>= 0.25`
- restored alias returns either to:
  - `active`, if healthy count is below 4
  - `restorable`, if healthy count is already at or above 4

### 9. Failure Residue Checks

For each fail-closed scenario, verify all residue is absent:

- no live route in `account-router.json`
- no live auth entry in `auth.json`
- no active codex-lb row
- no pool state claiming a healthy alias

Scenarios:

- `workspace-account-mismatch`
- `MEMBERSHIP_NOT_MATERIALIZED`
- rejected workspace selection
- non-durable auth result
- incomplete finalize or rollback failure

## Live Verification Commands

The implementation agent should finish with live-safe verification commands of this shape:

```bash
node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js --dry-run
jq '(.pools[] | select(.name=="openai-codex")) as $pool | {providers:$pool.providers,routes:$pool.routes}' ~/.pi/agent/account-router.json
jq '[.aliases[] | select(.cloneFrom=="openai-codex" and .disabled!=true) | {id,email,workspaceId,lineage}]' ~/.pi/agent/account-router.json
jq 'to_entries | map({aliasId:.key, accountId:(.value.accountId//null), hasRefresh:(.value.refresh!=null)})' ~/.pi/agent/auth.json
sqlite3 ~/.codex-lb/store.db "select email,status,chatgpt_account_id from accounts where status='active' order by email;"
```

The exact command set can change, but the verification content may not.

## Acceptance Checklist

- 4 or more healthy `Root-Mail_a` aliases are active
- every active alias is refresh-bearing or formally equivalent
- every active alias is present and consistent in Pi and codex-lb
- every active alias passes browserless and `pi` runtime checks
- no wrong-workspace aliases remain in active routing
- archive entries exist for replaced aliases
- restorable semantics are correct
- no fail-closed residue remains after forced failure tests