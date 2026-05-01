# Deterministic AgentMail Planning Integration Memo

Date: 2026-04-02

## Purpose

Integrate the repo's `.planning/` program artifacts into the operator handoff package so the next implementation agent can reuse them directly instead of creating a parallel strategy stack.

## What `.planning/` Confirms

The planning program is aligned with the operator package on the core mission:

- one active production workspace only
- explicit `placementContext.workspaceId`
- Pi plus codex-lb as one lifecycle boundary
- exact dual-window `0.25` keep/replace/restore semantics
- restore-first operations
- Hydra plus PKCE as the primary durable-auth lane
- canonical operator entrypoint remains `src/cli/pipeline-check-archive-replace.js`

Key supporting files:

- `.planning/PROJECT.md`
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/research/SUMMARY.md`
- `.planning/research/ARCHITECTURE.md`

## Strongest Reusable `.planning` Decisions

### Canonical sequencing

`.planning/ROADMAP.md` sharpens the order:

1. canonical evidence foundation
2. workspace lock and quarantine
3. canonical reconcile boundary
4. durable auth and verification gates
5. dual-window fleet capacity policy
6. restore-first operations and lab routes

This sequence should be treated as authoritative for execution ordering.

### Lifecycle vocabulary

Phase 1 context and plan already settled:

- steady states: `candidate`, `active`, `queued-replacement`, `archived`, `restorable`, `quarantined`
- `reinstated` is an event, not a steady state
- blocker classes are canonicalized
- audit artifacts and friction ledgers are first-class outputs

This means the next implementation agent should reuse:

- `.planning/phases/01-canonical-evidence-foundation/01-CONTEXT.md`
- `.planning/phases/01-canonical-evidence-foundation/01-01-PLAN.md`

instead of re-deciding the vocabulary.

### Architecture direction

`.planning/research/ARCHITECTURE.md` and `.planning/research/SUMMARY.md` are stronger than the current production code on one point:

- the control plane should be modeled as a single-writer lifecycle engine
- Pi, codex-lb, JSON files, and probe outputs are projections and evidence, not peers

That recommendation is compatible with the current docs package and should be considered the long-term canonical shape, even if the first implementation increment still writes to existing JSON files.

## Planning-State Conflicts The Next Agent Must Resolve

### Phase-status drift

`.planning/STATE.md` says:

- Phase 1 complete
- ready for verification

`.planning/ROADMAP.md` still says:

- all phases not started

The next implementation agent should not claim progress without first reconciling this documentation drift.

### Research-vs-current-code boundary

The research stack suggests:

- Node 24
- strict TypeScript
- SQLite WAL as canonical state

Current code is still:

- Node ESM JavaScript
- JSON-backed operational truth

That is not a blocker. It is a boundary:

- v1 should adopt the lifecycle and reconciliation semantics first
- storage and language migration can follow once the control plane is singular

## Additional Operator Guidance From `.planning`

### Remove ambiguous workspace/owner/root fallback from the production lane

`.planning/codebase/PI_CODEX_RECOVERY_SLICE.md` identifies the selection ambiguity as structural, not incidental:

- owner resolution
- routing-domain inference
- synthetic workspace fallback
- multi-surface workspace selection

The next implementation agent should explicitly consolidate that into one production policy boundary during the workspace-lock slice.

### Keep browserful and reverse-engineering work isolated

The roadmap and research are consistent:

- production lane should stay canonical and fail-closed
- reverse-engineering and alternative routes are valuable
- but they should remain lab work until promoted through typed boundaries and verification

That means:

- no accidental expansion of browser fallback into the production default
- no using reverse-engineering findings to bypass the reconcile boundary

## Practical Reuse Checklist For The Next Implementation Agent

Read these before implementing:

1. `.planning/PROJECT.md`
2. `.planning/ROADMAP.md`
3. `.planning/REQUIREMENTS.md`
4. `.planning/phases/01-canonical-evidence-foundation/01-CONTEXT.md`
5. `.planning/phases/01-canonical-evidence-foundation/01-01-PLAN.md`
6. `docs/plans/2026-04-01-deterministic-agentmail-single-workspace-vision.md`
7. `docs/plans/2026-04-01-deterministic-agentmail-implementation-strategy.md`
8. `docs/plans/2026-04-02-deterministic-agentmail-execution-roadmap.md`

## Bottom Line

The operator package and `.planning/` program artifacts are aligned. The main job now is not choosing a new direction; it is collapsing the planning and implementation surfaces into one execution lane and eliminating status drift, fallback ambiguity, and split-brain lifecycle ownership.