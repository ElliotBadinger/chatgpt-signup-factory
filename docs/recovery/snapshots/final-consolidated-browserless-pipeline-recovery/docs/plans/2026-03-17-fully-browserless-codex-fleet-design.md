# Fully Browserless Codex Fleet Recovery Design

Date: 2026-03-17
Worktree: `.worktrees/deterministic-agentmail-pipeline-clone`

## Goal

Turn the latest browserless pipeline into a fully browserless, recovery-first Codex fleet manager that keeps Pi’s Codex accounts healthy across one or more ChatGPT workspaces without any local Chrome fallback.

The system should:

- use live evidence rather than stale local state as the final authority
- recover existing identities browserlessly before recreating them
- replace accounts whose 5h and weekly quotas are both exhausted
- archive and later reinstate accounts that are only 5h exhausted when that is the better workspace-level choice
- pre-warm new AgentMail / ChatGPT accounts when workspace fleet health is trending low
- support N dynamically discovered workspaces with no hardcoded workspace IDs
- prefer workspace placement based on root/owner lineage, then select within that lineage by live capacity

## Current constraints and confirmed facts

### Already present in this worktree

- Browserless ChatGPT/OpenAI auth replay exists in `src/pipeline/authTrace/openaiAuthReplay.js`.
- Browserless workspace invite acceptance exists in `src/pipeline/rotation/browserlessWorkspaceClient.js` and `src/pipeline/rotation/browserlessMemberOnboarder.js`.
- Router onboarding currently tries browserless first, but still falls back to local Chrome when auth reaches `NO_EMAIL_CODE_OPTION`.
- The latest live findings show the current invite acceptance endpoint is:
  - `POST /backend-api/accounts/{workspaceId}/invites/accept`
- Workspace IDs are already discoverable dynamically from owner auth by calling `GET /backend-api/accounts`.

### Updated product assumptions from discussion

- Initial target source is local exhausted/stale Codex state, but a more authoritative live source should win whenever available.
- Success means all of the following:
  1. present in Pi auth/router state
  2. confirmed as a live member of the target ChatGPT workspace
  3. passes a live Codex usability/quota probe
- Live probe wins over stale local health.
- Recovery policy is browserless-only and recovery-first:
  1. existing-login OTP
  2. browserless password login
  3. forgot-password reset
  4. password-init / internal set-password path if available
  5. browserless recreate-new-account path
- Execution mode should be hybrid:
  - quick full audit first
  - immediate remediation in the same run
- `greasyhands` is hard-excluded for the first batch.
- `nastypolice` is now a normal candidate.
- There are multiple workspaces now, including one owned by `nastypolicy361@agentmail.to`.
- Workspaces must never be hardcoded; more may be added later.
- Workspace selection is both:
  - root / owner lineage aware
  - capacity aware within that lineage
- Quota policy is not binary; the pipeline must distinguish between 5h-only exhaustion and both 5h + weekly exhaustion.
- Low-fleet health should trigger proactive pre-warming using a hybrid threshold model (absolute floor + percentage threshold).

## Recommended architecture

Use the existing rotation entrypoint and browserless modules, but add a dedicated browserless recovery and fleet policy layer.

This is a refactor of the current pipeline, not a rewrite.

### Why this approach

- The workspace and auth browserless foundations already exist.
- The missing capability is deterministic policy and recovery orchestration.
- A new standalone system would duplicate useful work and slow down remediation.
- A thin patch would entangle rotation, workspace, auth, and quota policy too tightly.

## System overview

The new system should have five major concerns:

1. **Authoritative live audit**
2. **Quota-aware account classification**
3. **Browserless recovery ladder**
4. **Multi-workspace placement and lifecycle management**
5. **Verified apply + reconciliation**

## 1. Authoritative live audit

### Input sources

Local state:

- `~/.pi/agent/account-router-health.json`
- `~/.pi/agent/account-router.json`
- `~/.pi/agent/auth.json`
- `~/.pi/agent/codex-inbox-pool.json`
- `~/.pi/agent/codex-alias-archive.json`

Live state:

- owner workspace discovery via live `GET /backend-api/accounts`
- live workspace users/invites
- browserless auth replay branch outcome per alias/email
- live Codex usability/quota probe
- owner/root lineage inventory and workspace capacity observations

### Evidence authority order

For deciding whether an alias should be kept, recovered, archived, replaced, or used to trigger pre-warming:

1. live Codex probe
2. live auth/workspace evidence
3. local router/auth/archive/pool mapping
4. local health file

The health file is only a candidate generator, not the final truth.

### Audit outputs

Every run should emit a machine-readable audit artifact, for example:

- `artifacts/rotation/<timestamp>/browserless-audit.json`

Each alias record should include:

- alias id
- email
- current workspace lineage
- local health classification
- live probe result
- auth branchability result
- workspace membership result
- chosen action
- final verification outcome

## 2. Quota-aware classification

The system should classify each active Codex account with explicit 5h and weekly quota state.

### Primary quota states

- `healthy`
- `five-hour-exhausted-only`
- `both-exhausted`
- `low-on-both`
- `blocked`

### Policy by state

#### Healthy

- keep the account
- optionally refresh health metadata
- do not replace

#### Five-hour exhausted only

This is a temporary depletion case.

Default behavior:

- archive or sidelink the account as temporarily exhausted
- track expected 5h recovery time
- pre-warm it for reinstatement
- re-invite / re-attach to the applicable ChatGPT workspace when it becomes reusable
- restore it to Pi router/auth state only when the account is valid again

But this path is only preferred when the workspace still has enough healthy capacity.

If all accounts in a workspace are 5h exhausted, the workspace should be treated as under-supplied and should trigger supplementation or pre-warming rather than simple waiting.

#### Both exhausted

This is the strongest replacement case.

Policy:

- if the root/owner lineage’s workspace still has room for another account, create a new AgentMail / ChatGPT account for that lineage
- otherwise, replace with a fresh account that goes through the browserless signup flow and lands in an eligible workspace for that lineage

Both-exhausted accounts should be archived once a verified replacement exists.

#### Low on both

This is a fleet-risk state, not yet a hard failure.

Policy:

- proactively pre-warm new rootmail / AgentMail / ChatGPT accounts for that workspace lineage
- keep standby candidates ready so the workspace does not hit a full outage state

### Hybrid trigger model for pre-warming

Use both:

- an absolute floor, e.g. fewer than `minHealthyAccountsPerWorkspace`
- a percentage threshold, e.g. healthy accounts below `minHealthyFraction`

Exact defaults should be configurable, but the system should require both a hard floor and a proportional signal.

## 3. Browserless recovery ladder

For each alias/email that is not keep-live, the system should run a deterministic browserless decision tree.

### Step 0: preflight

Collect:

- alias id and email
- mapped root/owner lineage
- current auth/router metadata
- workspace membership status
- available inbox/root API key
- any prior trace-derived browserless auth plan

### Step 1: existing identity recovery

Try these in order:

1. **Existing-login OTP**
   - use the current `/email-verification` OTP path from `openaiAuthReplay.js`

2. **Direct password login**
   - add a password-capable login branch when auth lands on `/log-in/password`
   - use known password if present in artifacts/config

3. **Forgot-password reset**
   - drive browserless reset initiation
   - consume reset email from AgentMail
   - set a new password
   - login again browserlessly

4. **Password-init / internal set-password**
   - if traces or internal APIs expose an initialization or password-setting path from a verified state, use that before giving up

### Step 2: reuse recovered identity

If any recovery path works:

- confirm session validity
- confirm workspace membership
- if missing from workspace, invite and re-accept browserlessly
- rewrite Pi auth/router state if needed
- run live Codex probe
- if probe passes, keep the account rather than replacing it

### Step 3: recreate fresh account

If same-identity recovery fails:

- provision or claim a fresh inbox from the correct lineage
- run full browserless new-account creation
- join the correct workspace browserlessly
- register the account in Pi auth/router
- run the live Codex probe
- archive/remove the old alias only after the replacement is verified

### Step 4: deterministic failure

If every browserless path fails:

- emit a typed blocker with exact stage and evidence
- never fall back to local Chrome
- leave resumable artifacts for that alias

### Required behavioral change

`src/pipeline/rotation/routerOnboarder.js` must stop falling back to local Chrome on `NO_EMAIL_CODE_OPTION`.

Instead:

- `NO_EMAIL_CODE_OPTION` becomes an internal routing signal into the browserless recovery ladder
- recovery escalates to browserless password/reset/init or recreate
- local browser fallback is removed entirely

## 4. Multi-workspace lineage-aware routing

### Workspace discovery

The pipeline must support N workspaces discovered dynamically from owner auth.

For each owner/root lineage, build a live workspace registry entry with:

- owner email
- owner alias/auth source
- workspace id
- workspace name
- current member count
- invite/join capability health
- eligibility for new placements

### Lineage model

Each AgentMail account/inbox should belong to the root email / owner lineage that created it.

When recovering or replacing an account:

1. determine the account’s lineage
2. discover all live workspaces for that lineage
3. choose the best placement by:
   - lineage affinity first
   - then capacity / health within that lineage

This satisfies:

- pinned ownership semantics
- dynamic capacity-aware routing

### No hardcoded workspace ids

All workspace IDs and candidate workspaces must come from live discovery.

The system may persist observations, but not static IDs as immutable truth.

### New root / owner bootstrap

If a needed lineage has no usable owner auth or no eligible workspace:

- recover or create the AgentMail owner/root account browserlessly
- create or recover the associated workspace
- then continue normal invite/onboarding

This allows the fleet manager to scale as more owner roots and workspaces are added.

## 5. Verified apply + reconciliation

No local state mutation should be treated as authoritative until all validations succeed.

### Replacement success contract

A recovered or recreated account is successful only if all of the following pass:

1. browserless auth/session valid
2. workspace membership confirmed live
3. Pi auth/router state written correctly
4. live Codex probe passes
5. selected workspace matches lineage and capacity policy

### Final reconciliation

At run completion:

- refresh local health observations
- update archive state
- update pool linkage state
- write a per-run ledger
- preserve evidence for every alias

## Alias lifecycle states

Each alias should move through explicit states:

- `candidate`
- `audited-live`
- `recovering`
- `recovered`
- `recreating`
- `replaced`
- `archived-five-hour`
- `awaiting-reinstatement`
- `prewarmed`
- `verified`
- `blocked`

This gives the pipeline durable semantics for both reactive recovery and proactive fleet management.

## Workspace-level fleet states

Each workspace lineage should also maintain an aggregate fleet view:

- active healthy accounts
- active low-on-both accounts
- five-hour exhausted accounts awaiting reinstatement
- both-exhausted accounts pending replacement
- pre-warmed standby accounts
- current healthy floor and fraction
- current seat/capacity observations

These aggregate metrics drive whether to:

- wait
- reinstate
- replace
- pre-warm
- bootstrap new owner/root/workspace infrastructure

## CLI direction

Keep `src/cli/pipeline-check-archive-replace.js` as the primary operational entrypoint for now, but evolve it into the default browserless fleet manager for this worktree.

Likely additions:

- browserless-only mode becomes the normal path
- explicit live audit stage artifact
- explicit recovery/recreate/prewarm classifications
- multi-workspace discovery and selection
- live verification summary at the end

A separate top-level CLI can still be added later if the policy layer becomes large enough, but it should not be required for the initial implementation.

## Testing strategy

### Unit tests

- workspace discovery from multiple owner auth entries
- lineage mapping
- workspace selection by lineage + capacity
- quota classification
- recovery ladder branch selection
- no-local-Chrome policy enforcement

### Integration tests

- orchestrator audit → recover → verify flow
- orchestrator audit → recreate → verify flow
- five-hour-only archive/reinstatement flow
- low-on-both prewarm trigger flow
- multi-workspace spillover within a lineage

### Regression tests

- `NO_EMAIL_CODE_OPTION` does not trigger local browser fallback
- no hardcoded workspace IDs remain in the browserless onboarding path
- live probe overrides stale local health classification
- `greasyhands` excluded in first-batch policy fixture
- `nastypolice` treated as a normal candidate

## Immediate implementation priorities

1. Remove local Chrome fallback from router onboarding and replace it with browserless recovery routing.
2. Add password login / forgot-password / password-init recovery branches to browserless auth orchestration.
3. Add authoritative live audit artifact and classification output.
4. Add multi-workspace lineage-aware discovery and selection.
5. Add quota-aware policy for both-exhausted replacement, five-hour-only reinstatement, and low-on-both prewarming.
6. Add end-to-end verification gates so Pi/router/workspace/live-Codex success is required before accepting any replacement.

## Summary

The target system is not just a stale-alias replacer. It is a fully browserless, quota-aware, lineage-aware Codex fleet manager.

Its core principles are:

- live evidence over stale local state
- browserless recovery before recreation
- no local Chrome fallback
- dynamic multi-workspace operation
- workspace fleet health management instead of purely per-account rotation
- only verified accounts count as successful replacements
