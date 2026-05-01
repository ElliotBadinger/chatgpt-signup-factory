# Live Fix: Bootstrap Capacity and Resolve Lineage Design

Date: 2026-03-17
Worktree: `.worktrees/deterministic-agentmail-pipeline-clone`

## Goal

Patch the live browserless rotation pipeline so it can:

1. resolve workspace/root lineage for exhausted aliases from current auth/workspace evidence,
2. bootstrap fresh capacity automatically when global usable pool capacity is zero,
3. skip only aliases whose lineage remains unresolved after safe inference,
4. rerun the normal full pipeline with enough capacity for the currently exhausted Codex demand.

## Requirements from operator

- Resolve exhausted alias lineage from current `auth.accountId` / live workspace membership.
- Link back to root email only through workspace→owner mapping; never guess.
- If a workspace maps to multiple possible owners, pick the healthiest viable owner automatically.
- If still unresolved, skip.
- If global usable pool capacity is zero, bootstrap fresh capacity automatically.
- Bootstrap should try both known owner/root lineages and use the healthiest viable one first.
- Bootstrap target is enough capacity for the full currently exhausted Codex demand.

## Architecture

### 1. Alias lineage resolution layer

Add a runtime resolver that takes an exhausted alias and tries to derive:

- current workspace id
- workspace name
- owner alias id
- owner/root email
- lineage key

Resolution order:

1. current auth account id
2. live workspace/account visibility from current token
3. discovered owner/workspace registry
4. healthiest-owner tie-break if multiple owners map to same workspace
5. skip if unresolved

This layer must output an explicit resolution artifact per alias so skipped aliases are explainable.

### 2. Capacity bootstrap layer

Add a bootstrap orchestrator that runs only when global usable capacity is zero.

Usable capacity means pool entries that are currently valid for replacement work, e.g.:

- `available`
- optionally `prewarmed` if the reserved action is compatible with the current run

Bootstrap logic:

1. compute current exhausted Codex demand
2. inspect both known owner/root lineages
3. rank owners by health/viability
4. bootstrap fresh inbox capacity under the healthiest viable lineage
5. continue until capacity covers exhausted demand or all known owners fail

### 3. Safe rerun gate

The pipeline rerun should only happen after:

- lineage resolution pass completes
- unresolved aliases are explicitly skipped
- capacity is nonzero and ideally sized for current demand

Then rerun the normal entrypoint.

## Data model additions

### Resolved alias placement

Each resolved alias should carry:

- `aliasId`
- `email`
- `workspaceId`
- `workspaceName`
- `ownerAliasId`
- `rootEmail`
- `lineage`
- `resolutionSource`
- `resolutionConfidence`

### Bootstrap result

Each bootstrap attempt should record:

- owner/root tried
- workspace targeted
- inboxes created
- failures/blockers
- cumulative capacity after attempt

## Safety rules

- Never guess root email from alias string alone.
- Never map an alias to a workspace without auth/workspace evidence.
- If workspace→owner mapping is ambiguous, choose the healthiest viable owner only when both are confirmed candidates for that workspace.
- Otherwise skip.
- If bootstrap cannot reach sufficient capacity, stop and report instead of partially pretending success.

## Verification

Before rerun:

- resolved aliases must have placement context
- skipped aliases must be explicitly listed
- bootstrap output must show usable new capacity

After rerun:

- rely on the existing strict browserless verification chain already implemented

## Expected outcome

After this live-fix patch, the full pipeline should no longer fail immediately due to:

- `workspace-unresolved` for current exhausted aliases
- `no-inboxes-available` when global capacity is zero

Instead it should either:

- resolve + bootstrap + rerun successfully, or
- stop with explicit unresolved-lineage/bootstrap-capacity blockers.
