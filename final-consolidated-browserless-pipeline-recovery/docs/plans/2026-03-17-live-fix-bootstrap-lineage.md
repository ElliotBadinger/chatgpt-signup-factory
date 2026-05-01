# Live Fix: Bootstrap Capacity and Resolve Lineage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Patch the live browserless rotation pipeline so it can resolve exhausted alias lineage from runtime auth/workspace evidence, bootstrap fresh capacity when the global pool is empty, and then rerun the full pipeline against the current exhausted Codex demand.

**Architecture:** Add two focused runtime layers in front of the existing rotation flow: a lineage resolution pass for exhausted aliases and a capacity bootstrap pass for zero-capacity conditions. Keep all inference evidence-based, skip unresolved aliases rather than guessing, and feed the resulting placement/bootstrap state into the existing strict browserless verification pipeline.

**Tech Stack:** Node.js, Jest, existing browserless workspace client, existing rotation CLI, file-backed Pi state, ChatGPT workspace APIs

---

### Task 1: Add runtime exhausted-alias lineage resolver

**Files:**
- Create: `src/pipeline/rotation/resolveExhaustedAliasLineage.js`
- Create: `tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js`
- Modify: `src/cli/pipeline-check-archive-replace.js`

**Step 1: Write the failing test**

Cover:
- resolve workspace from current auth account id
- map workspace to owner/root lineage from discovered registry
- choose healthiest owner when multiple owners match same workspace
- return skipped/unresolved when no safe mapping exists

**Step 2: Run test to verify it fails**

```bash
cd /home/epistemophile/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js --runInBand
```

**Step 3: Write minimal implementation**

Implement a resolver returning:
- resolved placement context
- resolution source/confidence
- unresolved reason when skipped

Wire it into the CLI pre-run preparation path.

**Step 4: Run test to verify it passes**

Run the same command.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/resolveExhaustedAliasLineage.js tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js src/cli/pipeline-check-archive-replace.js
git commit -m "feat: resolve exhausted alias lineage from runtime workspace evidence"
```

### Task 2: Add zero-capacity bootstrap orchestrator

**Files:**
- Create: `src/pipeline/rotation/bootstrapRuntimeCapacity.js`
- Create: `tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js`
- Modify: `src/cli/pipeline-check-archive-replace.js`

**Step 1: Write the failing test**

Cover:
- global usable capacity zero triggers bootstrap
- known owners are ranked by viability
- bootstrap continues until exhausted demand is covered
- partial/bootstrap failure produces explicit blocker result

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js --runInBand
```

**Step 3: Write minimal implementation**

Implement an orchestrator that:
- counts current usable pool capacity
- computes current exhausted Codex demand
- tries both known owner lineages in viability order
- accumulates created inbox capacity
- returns explicit artifactable results

Wire it into the CLI before the main rerun.

**Step 4: Run test to verify it passes**

Run the same command.

**Step 5: Commit**

```bash
git add src/pipeline/rotation/bootstrapRuntimeCapacity.js tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js src/cli/pipeline-check-archive-replace.js
git commit -m "feat: bootstrap runtime capacity when global pool is empty"
```

### Task 3: Integrate resolution + bootstrap into the live rerun path

**Files:**
- Modify: `src/cli/pipeline-check-archive-replace.js`
- Modify: `src/pipeline/rotation/preRemoveWorkspaceMembers.js`
- Create: `tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js`

**Step 1: Write the failing test**

Cover:
- unresolved aliases are skipped explicitly
- resolved aliases get placement context for pre-removal/onboarding
- zero-capacity pool triggers bootstrap before main rotation call
- rerun proceeds only when capacity exists

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js --runInBand
```

**Step 3: Write minimal implementation**

Integrate the two new layers so the CLI does:
1. resolve exhausted aliases
2. skip unresolved aliases explicitly
3. bootstrap if usable capacity is zero
4. run the main rotation pipeline

Emit concise logs/artifacts for skipped aliases and bootstrap results.

**Step 4: Run test to verify it passes**

Run the same command.

**Step 5: Commit**

```bash
git add src/cli/pipeline-check-archive-replace.js src/pipeline/rotation/preRemoveWorkspaceMembers.js tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js
git commit -m "feat: integrate lineage resolution and capacity bootstrap into live rerun"
```

### Task 4: Verify the affected suite

**Files:**
- No new files required unless regression fixes are needed

**Step 1: Run focused verification**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js \
  tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js \
  tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js \
  tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js \
  tests/pipeline/rotation/preRemoveWorkspaceMembers.test.js \
  tests/pipeline/rotation/runtimeAliasProbe.test.js \
  tests/cli/pipelineCheckArchiveReplace.test.js \
  tests/cli/pipelineCheckArchiveReplaceBrowserlessFleet.test.js \
  --runInBand
```

**Step 2: Run broader affected regression**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/ tests/cli/pipelineCheckArchiveReplace*.test.js --runInBand --testPathIgnorePatterns='/node_modules/'
```

**Step 3: Commit**

```bash
git add src/cli src/pipeline tests
git commit -m "test: verify live-fix bootstrap and lineage resolution flow"
```

### Task 5: Perform live rerun and capture evidence

**Files:**
- Modify if needed: `docs/2026-03-17-fully-browserless-codex-fleet-runbook.md`

**Step 1: Run status before live rerun**

```bash
node src/cli/pipeline-check-archive-replace.js --status
```

**Step 2: Run full pipeline**

```bash
node src/cli/pipeline-check-archive-replace.js
```

**Step 3: Capture result summary**

Record:
- whether capacity bootstrap ran
- which owner/root lineage supplied capacity
- which aliases were skipped unresolved
- whether rotation progressed beyond the first alias
- artifact paths produced

**Step 4: Commit docs only if runbook needed updates**

```bash
git add docs/2026-03-17-fully-browserless-codex-fleet-runbook.md
git commit -m "docs: record live rerun behavior for bootstrap lineage fix"
```
