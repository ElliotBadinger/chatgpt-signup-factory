# Deterministic AgentMail Single-Workspace Vision

Date: 2026-04-01

## Purpose

Define the intended steady-state architecture for the Codex alias system under the revised business policy. This vision is the target state that implementation, testing, and live reconciliation must enforce.

## Canonical Production Intent

- There is exactly one active production workspace for `openai-codex` traffic.
- The active production workspace is `Root-Mail_a` / `workspace-owner-a` / `d3d588b2-8a74-4acc-aa2e-94662ff0e025` unless fresh direct evidence proves a replacement workspace has been intentionally promoted.
- All active production aliases must be explicitly placed into that workspace via `placementContext.workspaceId`.
- Workspace owner or workspace name fallback may not silently place a production alias.

## Canonical Health Invariants

The system is healthy only if all of the following hold at the same time:

1. The active `openai-codex` pool contains at least 4 healthy aliases.
2. Every healthy active alias resolves to workspace `d3d588b2-8a74-4acc-aa2e-94662ff0e025`.
3. Every healthy active alias has durable auth in `~/.pi/agent/auth.json`.
4. Every healthy active alias has router identity plus `openai-codex` route state in `~/.pi/agent/account-router.json`.
5. Every healthy active alias has placement metadata persisted and pointing to the active workspace.
6. Every healthy active alias passes live workspace/browserless verification and a live `pi` provider probe.
7. Pi state and codex-lb state agree on lifecycle status before an alias is considered healthy.

## Exact Quota Policy

The canonical quota rule is window-specific and symmetric:

- Keep active if both 5-hour remaining fraction and weekly remaining fraction are `>= 0.25`.
- Queue replacement if either window is `< 0.25`.
- Restore an archived alias only when both windows have renewed back to `>= 0.25`.

There is no separate looser restore threshold. Keep and restore use the same threshold so the system does not churn an alias in and out around two different policy lines.

If one or both windows are unknown, stale, or ambiguous:

- do not promote to healthy
- do not restore from archive
- treat the alias as needing reconciliation or replacement planning, not as safe capacity

## Lifecycle State Machine

The alias lifecycle must be explicit and singular:

- `candidate`: discovered or created, not yet durable
- `active`: healthy, routable, synced in Pi and codex-lb
- `queued-replacement`: below threshold or otherwise failed health contract, still present until handoff completes
- `archived`: removed from active routing, credentials and metadata preserved
- `restorable`: archived and now above both quota thresholds, but not yet needed in active routing
- `reinstated`: restored into active routing after full verification
- `quarantined`: excluded from active production because workspace, durability, or sync policy is violated

Rules:

- Archive-on-replace is mandatory.
- Replacement must be appended to pool/routes before removing the old alias.
- If the active pool already has 4 healthy aliases, a newly restorable alias remains `restorable` standby instead of being auto-promoted.
- Non-target-workspace aliases are not quota-replaced. They are quarantined and then archived or disabled by workspace-policy reconciliation.

## Auth Durability Requirement

Temporary web sessions are not sufficient.

A production alias is durable only if one of these is true:

- it has a refresh-bearing owned OAuth credential persisted in `auth.json`
- or an explicitly documented alternative credential form is proven to be equivalently refreshable, renewable, and durable under unattended rotation

If auth is access-token-only, session-only, or otherwise not formally durable, the alias may not become `active`.

## Synchronization Contract

Pi and codex-lb are one logical lifecycle boundary.

For every lifecycle transition, the canonical control plane must update:

- `auth.json`
- `account-router.json`
- archive state
- inbox/pool state when relevant
- codex-lb lifecycle state

No alias is healthy if one store says `active` and another says `deactivated`, absent, quarantined, or archived.

## Fail-Closed Contract

The following outcomes must not leave live router/auth residue:

- `workspace-account-mismatch`
- `MEMBERSHIP_NOT_MATERIALIZED`
- rejected workspace selection
- invalid or non-durable owned OAuth result
- wrong-workspace persistence
- incomplete finalize or route handoff

Fail-closed means:

- no live route remains for an alias that failed final verification
- no auth record remains for an alias that was not fully finalized
- no codex-lb row remains active if Pi rejected the alias

## Canonical Control Plane

The system needs one canonical lifecycle controller. The recommended boundary is:

- operator entrypoint: `src/cli/pipeline-check-archive-replace.js`
- preparation and targeting: `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- policy engine and orchestrator: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- onboarding and durability: `src/pipeline/rotation/routerOnboarder.js`
- state writes and reconciliation: a new dedicated lifecycle reconciler module that atomically coordinates Pi files, archive state, and codex-lb state

Daemonization is deferred. The first requirement is one correct command path with one policy engine. A daemon can wrap the same control plane later.

## Success Definition

The system is done when:

- all active `openai-codex` aliases are dedicated to `Root-Mail_a`
- at least 4 aliases satisfy the full healthy alias contract
- replacements happen without temporary route holes
- wrong-workspace aliases are not in production routing
- archived aliases are preserved and restorable
- codex-lb and Pi remain synchronized after every transition
- the control plane rejects ambiguous, stale, or degraded state instead of silently routing through it