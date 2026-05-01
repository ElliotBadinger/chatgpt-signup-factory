# Deterministic AgentMail Current-State Assessment

Date: 2026-04-01

## Executive Read

The codebase already contains pieces of the desired model, but production reality is still split across two workspace lineages and multiple incomplete lifecycle stores.

Direct evidence anchors used for this assessment:

- `docs/pipeline.md`
- `docs/plans/2026-03-29-deterministic-agentmail-codex-current-state-handoff.md`
- `artifacts/Hydra OAuth Continuation for Onboarded Aliases.md`
- `src/cli/pipeline-check-archive-replace.js`
- `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/pipeline/rotation/quotaPolicy.js`
- `src/pipeline/rotation/quotaDetector.js`
- `src/pipeline/rotation/piAccountRegistrar.js`
- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/rotation/browserlessWorkspaceClient.js`
- `src/pipeline/rotation/workspaceSelector.js`
- `src/pipeline/rotation/runtimeAliasProbe.js`
- `src/pipeline/rotation/archiveManager.js`
- live-safe reads from `~/.pi/agent/*.json`
- live-safe read from `~/.codex-lb/store.db`

## What Already Aligns

### Deterministic workspace evidence exists

- `routerOnboarder.js` already accepts `placementContext` and verifies `expectedWorkspaceId`.
- `runtimeAliasProbe.js` already fails closed on missing router workspace evidence and on `workspace-account-mismatch`.
- `docs/pipeline.md` already documents append-before-remove and fail-closed onboarding as intended behavior.

### Refresh-bearing auth is already treated as mandatory at the onboarding edge

- `routerOnboarder.js` calls `assertRefreshBearingRouterAuth()` before persistence on browserless and recovery paths.
- `openaiOwnedOauth.js` already contains a Hydra login-challenge continuation path and PKCE token exchange logic, so the durability lane is no longer purely conceptual.

### Browserless and `pi` probe ideas already exist

- `runtimeAliasProbe.js` combines browserless workspace checks with a live `pi` provider probe.
- `browserlessWorkspaceClient.js` already exposes the necessary workspace APIs to enforce explicit workspace selection and membership verification.

## What Conflicts With The Vision

### Active production routing is still mixed across two workspaces

Live router state currently shows `openai-codex` providers:

- `sprintc_20260314032841b`
- `sprintc_20260314032841c`
- `cruelfigure620`
- `exciteditem179`

Those providers span:

- `a5052b4c-79aa-4415-b325-7161b5883518` / `Agentmail_nasty`
- `d3d588b2-8a74-4acc-aa2e-94662ff0e025` / `Root-Mail_a`

That directly violates the one-workspace-only policy.

### Workspace selection still allows fallback routing

`workspaceSelector.js` still permits this decision order:

- explicit workspace id
- lineage-based same-lineage capacity choice
- owner/name fallback

That is acceptable for generic discovery tooling but not for production routing. It is a direct policy conflict.

### Quota policy semantics are wrong for the revised business rule

- `quotaPolicy.js` still uses thresholds `0.05`, `0.2`, and `0.3`.
- `quotaDetector.js` still collapses both windows into one effective fraction because persisted health data stores only one minimum value per model.
- `archiveManager.js` still restores at `> 0.1`.

The target policy needs explicit persisted 5-hour and weekly windows with a single `0.25` threshold for keep, replace, and restore.

### The archive lifecycle is too weak

Current archive state has one alias only:

- `greasyhands` / `greasymeal827@agentmail.to`

The stored archive shape lacks enough durable lifecycle fields for the new policy:

- no explicit workspace id
- no canonical lifecycle state
- no reliable per-window quota renewal evidence
- no mandatory `awaitingReinstatement`/`restorable` discipline

### codex-lb is not synchronized with Pi

Current split:

- Pi router pool still includes `sprintc_20260314032841b` and `sprintc_20260314032841c`.
- codex-lb shows those same emails as `deactivated` in workspace `a5052b4c-79aa-4415-b325-7161b5883518`.
- Pi router/auth contain `cruelfigure620`, but codex-lb does not list `cruelfigure620@agentmail.to` at all.
- codex-lb lists `brainstein@proton.me` and the root email as active in `Root-Mail_a`, but those are not the `openai-codex` alias pool in Pi.

This is a direct lifecycle split-brain.

## What Is Partial

### Root-Mail_a durability exists but only for two aliases

Direct local state shows only two refresh-bearing aliases persisted for workspace `d3d588b2-8a74-4acc-aa2e-94662ff0e025`:

- `cruelfigure620`
- `exciteditem179`

That means the 4-healthy floor is not close to satisfied yet.

### codex-lb target-workspace protection exists but only as a skip rule

`checkArchiveAndReplaceExhausted.js` and `pipelineCheckArchiveReplaceLiveFix.js` use codex-lb only to avoid rotating certain aliases that appear quota-positive in the target workspace.

What is missing:

- no canonical write boundary into codex-lb for every lifecycle change
- no shared lifecycle statuses across Pi and codex-lb
- no “agreement required before active” rule

### Recovery and owned OAuth are partially hardened

The Hydra continuation memo and `openaiOwnedOauth.js` indicate significant progress on durable owned OAuth acquisition.

What remains partial:

- durability success is not yet translated into a canonical 4-alias floor
- the Root-Mail_a control plane is not yet the only active production lineage
- the durability lane still depends on downstream reconciliation that is not singular or complete

## What Is Dangerous

### Wrong-workspace aliases are still routable

`sprintc_20260314032841b` and `sprintc_20260314032841c` remain in the `openai-codex` pool despite the revised policy and despite codex-lb marking the underlying workspace deactivated.

### Health can be overstated by file presence

The current health model can mistake presence for health because:

- `auth.json` and `account-router.json` can both contain an alias
- `account-router-health.json` can show a quota fraction
- but there may be no passing live browserless probe, no passing live `pi` probe, and no codex-lb agreement

### The pool can dip below required floor during replacement

Append-before-remove is documented, but there is no explicit 4-healthy floor enforcement in the current policy engine for the one-workspace target state.

### Restore semantics are unsafe

Current restore logic uses a single `probeQuota(aliasId, auth) > 0.1` rule. That can restore an alias with incomplete quota evidence or only one renewed window.

## Where Split-Brain Exists

### Workspace lineage split-brain

- `workspace-owner-b` lineage still exists in active routing.
- `workspace-owner-a` lineage exists alongside it.

### Store split-brain

- Pi router says some aliases are active.
- codex-lb says those same aliases are deactivated or absent.
- archive state does not encode enough lifecycle truth to arbitrate.

### Policy split-brain

- `docs/pipeline.md` describes a more deterministic lifecycle than the current quota and archive code actually enforce.
- the April 1 Hydra memo assumes a Root-Mail_a durability path, but the active router still carries the older `workspace-owner-b` lineage.

## Implicit Assumptions That Must Become Explicit

- production routing may choose a workspace by owner/name fallback
- one collapsed quota fraction is enough to drive keep/replace/restore
- a codex-lb row can be treated as advisory instead of lifecycle-critical
- wrong-workspace aliases can stay active until their quota runs out
- restore threshold can differ from keep threshold
- any refresh-bearing auth in the correct workspace is automatically production-healthy

All of those assumptions must be removed or formalized.

## Smallest Set Of Files That Actually Matter

These are the decisive modules for the next implementation pass:

- `src/cli/pipeline-check-archive-replace.js`
- `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/pipeline/rotation/quotaPolicy.js`
- `src/pipeline/rotation/quotaDetector.js`
- `src/pipeline/rotation/archiveManager.js`
- `src/pipeline/rotation/workspaceSelector.js`
- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/rotation/piAccountRegistrar.js`
- `src/pipeline/rotation/runtimeAliasProbe.js`
- `src/pipeline/authTrace/openaiOwnedOauth.js`

Everything else is supporting surface.

## Bottom Line

The codebase is not starting from zero. The correct direction already exists in:

- explicit workspace verification
- refresh-bearing auth enforcement
- browserless plus `pi` runtime probes
- Root-Mail_a durable aliases

But the active system is still not durably healthy because:

- the production pool is mixed-workspace
- codex-lb and Pi disagree
- quota and restore semantics do not match policy
- only 2 Root-Mail_a aliases currently meet the durable-auth baseline