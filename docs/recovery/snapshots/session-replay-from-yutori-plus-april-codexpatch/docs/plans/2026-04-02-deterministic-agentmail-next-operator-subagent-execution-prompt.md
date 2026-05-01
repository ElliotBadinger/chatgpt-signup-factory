# Next Operator Prompt: Subagent-Driven Execution And Safe Worktree Cleanup

Use this prompt as the starting message for the next operator agent.

---

You are the next operator agent for:

`/home/epistemophile/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone`

You are not starting from a clean workspace. Your first job is to make the worktree fully clean safely, without losing substantive work, before execution begins.

## Mandatory bootstrap

Before any substantive action:

1. Open and follow:
   `/home/epistemophile/.codex/superpowers/skills/using-superpowers/SKILL.md`
2. Load and follow the skills that apply:
   - `master-agent-churn-control`
   - `orchestrating-swarms`
   - `repo-research-analyst`
3. Work as an operator, not a blind implementer.
4. Use subagents only for narrow, independent questions or single-owner execution slices.
5. Do not ask the user questions.

## Mission

Execute the single-workspace control-plane plan already prepared in the repo, using subagents carefully, starting with safe cleanup of the dirty worktree, then moving through the execution slices.

## Canonical documents to read first

Read these before spawning implementation work:

1. `docs/plans/2026-04-02-deterministic-agentmail-execution-brief.md`
2. `docs/plans/2026-04-02-deterministic-agentmail-execution-roadmap.md`
3. `docs/plans/2026-04-02-deterministic-agentmail-planning-integration-memo.md`
4. `docs/plans/2026-04-01-deterministic-agentmail-single-workspace-vision.md`
5. `docs/plans/2026-04-01-deterministic-agentmail-implementation-strategy.md`
6. `.planning/PROJECT.md`
7. `.planning/ROADMAP.md`
8. `.planning/REQUIREMENTS.md`
9. `.planning/phases/01-canonical-evidence-foundation/01-CONTEXT.md`
10. `.planning/phases/01-canonical-evidence-foundation/01-01-PLAN.md`

## Non-negotiable production target

- one active production workspace only
- `Root-Mail_a`
- `workspace-owner-a`
- workspace id `d3d588b2-8a74-4acc-aa2e-94662ff0e025`

## Stage 0: Safe Worktree Cleanup

You must finish this stage before any implementation.

### Current dirtiness snapshot

Assume the worktree includes:

- substantial tracked source/test/docs changes
- substantive untracked planning docs and tests
- a large amount of runtime residue, temp output, artifacts, ledgers, and browser profiles

### Cleanup objective

End Stage 0 only when:

```bash
git status --short
```

returns nothing.

### Required cleanup method

1. Inventory first.
   - Run `git status --short`
   - Run `git diff --stat`
   - Run `git ls-files --others --exclude-standard`
2. Spawn at most two read-only explorer subagents for classification:
   - one for tracked substantive changes
   - one for untracked preserve-vs-generated classification
3. Preserve substantive work before deleting anything.

### Preserve these tracked paths

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

### Preserve these untracked authored paths

- `.planning/codebase/PI_CODEX_RECOVERY_SLICE.md`
- `.planning/phases/01-canonical-evidence-foundation/*`
- `artifacts/Hydra OAuth Continuation for Onboarded Aliases.md`
- new authored tests under `tests/**`
- ambiguous utility files:
  - `.codex`
  - `tmp/*.mjs`
  - `tmp/*.js`

### Treat these as generated or disposable unless your inspection proves otherwise

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
- `state/rotation/ledger-*.json`
- `state/rotation/runs/`
- `state/workspace-owner-*-profile*`
- `state/*owner-profile*`

### Cleanup safety rules

- Do not lose substantive work.
- If a path is ambiguous, preserve it on a safety branch or archive it outside the repo before deleting it.
- Do not use destructive git commands that would discard uncommitted work without first preserving it.
- A safe route is:
  - create a safety branch
  - commit preserve-worthy tracked and untracked work there
  - archive ambiguous runtime or utility files outside the repo if not committing them
  - delete only clearly generated residue
  - verify the tree is clean

### Cleanup completion artifact

Create a short markdown artifact under `docs/plans/` recording:

- what was preserved
- what was archived outside the repo
- what was deleted as generated residue
- how the tree was verified clean

## Stage 1 onward: Subagent-driven execution

After Stage 0, execute the plan from `docs/plans/2026-04-02-deterministic-agentmail-execution-brief.md`.

### Execution order

1. Canonical evidence foundation
2. Workspace lock and quarantine
3. Canonical reconcile boundary
4. Durable auth and verification gates
5. Dual-window fleet capacity policy
6. Restore-first fleet reconciliation
7. Verification and de-legacy cleanup

### Subagent discipline

- One implementer owner per stage.
- Use small explorer agents for independent research only.
- After the owner passes tests, run exactly:
  - one spec review
  - one code review
- Batch all findings into one fix list.
- Re-test once.
- Re-review only if fixes materially changed behavior or added files.

### Do not do

- do not assign multiple implementers to the same files
- do not parallelize overlapping edits
- do not start a new stage while the previous one still has unresolved residue
- do not keep owner/name/synthetic-workspace fallback alive in the production path
- do not allow wrong-workspace aliases to count as healthy capacity
- do not treat browser session artifacts as durable auth

## Stage-specific notes

### Phase 1 reuse

Do not redesign the vocabulary. Reuse `.planning/phases/01-canonical-evidence-foundation/01-01-PLAN.md`.

Critical rule:

- `reinstated` is an event, not a steady state

### Workspace lock

Unify workspace and owner and root selection behind one explicit production policy surface. Remove production fallback ambiguity.

### Reconcile boundary

Pi and codex-lb are one lifecycle boundary. If you cannot make them agree, the alias is not healthy.

### Durable auth

Primary lane:

- Hydra login-challenge continuation plus PKCE

Fallback lane:

- passwordless continuation only if it yields durable target-workspace auth

### Capacity policy

- keep only if both windows are `>= 0.25`
- replace if either window is `< 0.25`
- restore only if both windows are back to `>= 0.25`
- ambiguous quota evidence blocks promotion and restore
- maintain a floor of 4 healthy aliases

## Planning-state drift you must resolve

`.planning/STATE.md` says Phase 1 is complete and ready for verification.

`.planning/ROADMAP.md` still says all phases are not started.

Do not ignore this. Update planning artifacts cleanly as work advances so the operator record does not split.

## Completion target

Stop only when all of these are true:

- the worktree is clean
- the canonical production path is singular
- active `openai-codex` routing points only to workspace `d3d588b2-8a74-4acc-aa2e-94662ff0e025`
- Pi and codex-lb agree on active lifecycle state
- active aliases are durable and runtime-verified
- at least 4 aliases satisfy the healthy contract

---

Begin with Stage 0 cleanup. Do not code before the tree is fully clean.