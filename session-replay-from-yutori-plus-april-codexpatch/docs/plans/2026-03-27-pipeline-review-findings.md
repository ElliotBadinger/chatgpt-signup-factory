# Pipeline Review Findings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the three scoped review findings in `pipeline-check-archive-replace` and add regression coverage that locks the intended behavior in place.

**Architecture:** Move CLI environment/bootstrap resolution to happen after argument parsing so `.env` and `--auth-path` both participate in default selection. Preserve explicit placement context and lineage-aware workspace selection by changing the workspace resolution order, then align tests and docs with that order.

**Tech Stack:** Node.js CLI, Jest, repo `.env` loader, workspace selection helpers

---

### Task 1: Add failing tests for CLI bootstrap defaults

**Files:**
- Modify: `tests/cli/pipelineCheckArchiveReplace.test.js`

**Step 1: Write failing tests**

Add focused tests that prove:
- repo `.env` values affect `WORKSPACE_OWNER_EMAIL` / `WORKSPACE_NAME` before defaults are computed
- `--auth-path` controls owner auth fallback instead of `~/.pi/agent/auth.json`

**Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/cli/pipelineCheckArchiveReplace.test.js --runInBand`

Expected: new tests fail for early env/default resolution and hardcoded auth path behavior.

### Task 2: Add failing tests for workspace selection precedence

**Files:**
- Modify: `tests/pipeline/rotation/workspaceSelector.test.js`

**Step 1: Write failing tests**

Add focused tests that prove:
- explicit `placementContext.workspaceId` wins before owner/name fallback filtering
- lineage-aware selection still works even when owner/name fallback would exclude those records

**Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/pipeline/rotation/workspaceSelector.test.js --runInBand`

Expected: new tests fail until selection order is corrected.

### Task 3: Implement minimal production changes

**Files:**
- Modify: `src/cli/pipeline-check-archive-replace.js`
- Modify: `src/pipeline/rotation/workspaceSelector.js`
- Modify: `docs/pipeline.md`

**Step 1: Move bootstrap/default resolution after args**

Load repo `.env` before computing workspace/browser defaults and resolve owner auth from the actual `authPath`.

**Step 2: Fix workspace resolution ordering**

Honor explicit placement context first, then lineage-aware selection, and only then use owner/name fallback selection for generic CLI targeting.

**Step 3: Keep docs aligned**

Document the same ordering the implementation and tests enforce.

### Task 4: Verify

**Files:**
- Test: `tests/cli/pipelineCheckArchiveReplace.test.js`
- Test: `tests/pipeline/rotation/workspaceSelector.test.js`

**Step 1: Run focused tests**

Run:
- `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/cli/pipelineCheckArchiveReplace.test.js --runInBand`
- `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/pipeline/rotation/workspaceSelector.test.js --runInBand`

Expected: both suites pass.