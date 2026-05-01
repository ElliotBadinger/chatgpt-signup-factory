# Usable Lineage Workspace Registry Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live workspace discovery track observed workspaces per lineage, retain deactivated/ineligible workspaces as evidence, and cache/select only live verified usable owner+workspace records for live-fix/bootstrap decisions.

**Architecture:** Refactor the workspace registry layer from “one valid token per accountId group or fail” into a lineage-aware observation registry with explicit usability state. The CLI and live-fix preparation should consume the usable cached record for placement/bootstrap while preserving fail-closed behavior when no live verified usable record exists for the needed lineage.

**Tech Stack:** Node.js, Jest, browserless workspace APIs, file-backed Pi state, existing rotation/live-fix CLI

---

### Task 1: Define observed-vs-usable workspace registry behavior in tests

**Files:**
- Modify: `tests/pipeline/rotation/workspaceRegistryOperational.test.js`
- Modify: `tests/pipeline/rotation/workspaceRegistry.test.js`
- Create: `tests/pipeline/rotation/workspaceRegistryUsableSelection.test.js`

- [ ] **Step 1: Write the failing test for mixed lineage observations**

Cover a lineage with:
- one observed deactivated workspace
- one observed active usable workspace
- same root/owner lineage

Assert:
- both observations are retained
- only the active workspace is marked usable/selected
- selected record includes owner alias, owner email, workspace id/name, eligibility, and verification timestamp
- when multiple usable workspaces exist in the same lineage, the selector chooses the healthiest / highest-capacity usable record rather than first-seen order

- [ ] **Step 2: Run the focused registry tests to verify failure**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/workspaceRegistryOperational.test.js tests/pipeline/rotation/workspaceRegistry.test.js tests/pipeline/rotation/workspaceRegistryUsableSelection.test.js --runInBand`
Expected: FAIL because usable cached registry/selection behavior does not exist yet.

- [ ] **Step 3: Write the failing test for fail-closed behavior**

Cover a lineage where all observed workspaces are deactivated or ineligible.

Assert:
- observations are retained
- no usable record exists
- discovery fails closed only for missing usable record, not merely because a deactivated workspace was observed

- [ ] **Step 4: Commit the red tests**

```bash
git add tests/pipeline/rotation/workspaceRegistryOperational.test.js tests/pipeline/rotation/workspaceRegistry.test.js tests/pipeline/rotation/workspaceRegistryUsableSelection.test.js
git commit -m "test: define usable lineage workspace registry behavior"
```

### Task 2: Implement lineage observation registry and usable selection

**Files:**
- Modify: `src/pipeline/rotation/workspaceRegistry.js`
- Modify: `src/pipeline/rotation/workspaceSelector.js`
- Test: `tests/pipeline/rotation/workspaceRegistryOperational.test.js`
- Test: `tests/pipeline/rotation/workspaceRegistry.test.js`
- Test: `tests/pipeline/rotation/workspaceRegistryUsableSelection.test.js`

- [ ] **Step 1: Add explicit observation/eligibility fields to registry entries**

Add per-workspace observation fields such as:
- `observed: true`
- `eligibilityStatus`
- `deactivated`
- `usable`
- `lastVerifiedAt`
- `verificationSource`

- [ ] **Step 2: Add lineage-level usable owner/workspace selection**

Implement helpers that:
- group observations by lineage
- retain all observed workspaces
- choose one usable record per lineage from live verified non-deactivated eligible workspaces
- never select deactivated/ineligible observations as usable

- [ ] **Step 3: Keep fail-closed semantics narrow**

Only fail when:
- a required lineage has no live verified usable owner+workspace record

Do not fail merely because another observed workspace in the same lineage is deactivated.

- [ ] **Step 4: Run the focused registry tests to verify they pass**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/workspaceRegistryOperational.test.js tests/pipeline/rotation/workspaceRegistry.test.js tests/pipeline/rotation/workspaceRegistryUsableSelection.test.js --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/rotation/workspaceRegistry.js src/pipeline/rotation/workspaceSelector.js tests/pipeline/rotation/workspaceRegistryOperational.test.js tests/pipeline/rotation/workspaceRegistry.test.js tests/pipeline/rotation/workspaceRegistryUsableSelection.test.js
git commit -m "feat: cache usable live workspace records per lineage"
```

### Task 3: Make lineage resolution and live-fix consume usable cached records

**Files:**
- Modify: `src/pipeline/rotation/resolveExhaustedAliasLineage.js`
- Modify: `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- Modify: `tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js`
- Modify: `tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js`

- [ ] **Step 1: Write the failing tests for usable-record consumption**

Cover:
- alias auth points at a deactivated observed workspace account id
- registry also contains a usable lineage-selected workspace
- resolution/live-fix should use the usable cached lineage record rather than treating the deactivated observation as operationally required

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js --runInBand`
Expected: FAIL because resolver/live-fix still key off raw workspace matches only.

- [ ] **Step 3: Implement minimal resolver/live-fix changes**

Update resolver/live-fix to:
- prefer usable lineage records
- retain deactivated observations as evidence only
- skip/fail closed only if no usable owner+workspace exists

- [ ] **Step 4: Run the focused tests to verify pass**

Run the same command.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/rotation/resolveExhaustedAliasLineage.js src/cli/pipelineCheckArchiveReplaceLiveFix.js tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js
git commit -m "feat: use usable lineage workspace records in live-fix"
```

### Task 4: Update CLI discovery to use usable cached registry records

**Files:**
- Modify: `src/cli/pipeline-check-archive-replace.js`
- Create: `tests/cli/pipelineCheckArchiveReplaceUsableWorkspaceRegistry.test.js`
- Modify: `tests/cli/pipelineCheckArchiveReplaceLiveFixFailClosed.test.js`

- [ ] **Step 1: Write the failing CLI tests**

Cover:
- deactivated workspace observed + active workspace usable in same lineage
- CLI selects/logs the usable owner/root email + workspace
- run proceeds past current registry blocker
- fail-closed only when no usable record exists anywhere relevant

- [ ] **Step 2: Run the focused CLI tests to verify failure**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/cli/pipelineCheckArchiveReplaceUsableWorkspaceRegistry.test.js tests/cli/pipelineCheckArchiveReplaceLiveFixFailClosed.test.js --runInBand`
Expected: FAIL because CLI still uses raw operational registry discovery and workspaceId matching.

- [ ] **Step 3: Implement minimal CLI changes**

Update CLI registry loading/selection to:
- consume the new usable cached registry format
- log selected usable owner/root email and workspace
- continue when usable lineage/workspace exists
- preserve fail-closed behavior otherwise

- [ ] **Step 4: Run the focused CLI tests to verify pass**

Run the same command.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/pipeline-check-archive-replace.js tests/cli/pipelineCheckArchiveReplaceUsableWorkspaceRegistry.test.js tests/cli/pipelineCheckArchiveReplaceLiveFixFailClosed.test.js
git commit -m "feat: consume usable cached workspace registry in live CLI"
```

### Task 5: Run affected regressions and one real rerun

**Files:**
- No new files unless a narrowly-scoped regression fix is required

- [ ] **Step 1: Run affected regression suite**

Run:
`node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/workspaceRegistry*.test.js tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js tests/cli/pipelineCheckArchiveReplaceLiveFix*.test.js tests/cli/pipelineCheckArchiveReplaceUsableWorkspaceRegistry.test.js tests/cli/pipelineCheckArchiveReplacePreRemove*.test.js tests/pipeline/rotation/preRemoveWorkspaceMembers.test.js tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js --runInBand`

Expected: PASS

- [ ] **Step 2: Run one real rerun**

Run: `node src/cli/pipeline-check-archive-replace.js`

Capture:
- selected root email
- selected owner alias
- selected workspace id/name
- whether cached usable record was used
- whether pipeline advanced past the prior blocker
- next exact blocker if any

- [ ] **Step 3: Commit final implementation**

```bash
git add src/cli src/pipeline tests
git commit -m "fix: prefer usable live workspace records over deactivated observations"
```
