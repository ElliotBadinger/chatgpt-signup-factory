# Live Fix New-Root Escalation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend live-fix bootstrap so actionable demand first consumes truly reinstatable archived capacity and otherwise escalates browserlessly to a fresh dedicated AgentMail root/owner whose new inboxes are onboarded into the applicable active workspace(s), with full-demand gating preserved.

**Architecture:** Keep the existing live-fix preparation seam in `src/cli/pipelineCheckArchiveReplaceLiveFix.js`, but split capacity sourcing into explicit stages: archived/reinstatable recovery, current-root bootstrap/recovery, and new-root escalation. Persist only evidence-backed usable entries/workspaces, and update the usable workspace registry/cache only after the new root has a verified active workspace and usable inboxes.

**Tech Stack:** Node.js, Jest, existing Stage 1 live bootstrap hooks, browserless workspace onboarding, file-backed pool/archive/auth/router state.

---

### Task 1: Model archived/reinstatable capacity as a live-fix source

**Files:**
- Modify: `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- Test: `tests/cli/pipelineCheckArchiveReplaceLiveBootstrap.test.js`

- [ ] **Step 1: Write the failing test**

Add a test showing that when actionable lineage demand exists and archive entries are present, only entries that are non-reinstated, reuse-eligible, and actually reusable for the active workspace are counted before any new-root escalation.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/cli/pipelineCheckArchiveReplaceLiveBootstrap.test.js --runInBand`

Expected: FAIL because live-fix bootstrap does not yet consume archived/reinstatable capacity.

- [ ] **Step 3: Write minimal implementation**

Add helper(s) that:
- read/select archive-derived reusable entries for the preferred actionable lineage/workspace
- reject `chatgpt-used` pool entries as free capacity
- mark why entries were eligible/ineligible

- [ ] **Step 4: Run test to verify it passes**

Run the same command.

### Task 2: Add explicit new-root escalation after current-root exhaustion

**Files:**
- Modify: `src/cli/pipelineCheckArchiveReplaceLiveFix.js`
- Modify: `src/pipeline/rotation/bootstrapRuntimeCapacity.js`
- Test: `tests/cli/pipelineCheckArchiveReplaceLiveBootstrap.test.js`
- Test: `tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js`

- [ ] **Step 1: Write the failing test**

Add coverage for:
- current actionable lineage root returns `bootstrap-live-inboxes-already-known`
- no archived/reinstatable capacity exists
- escalation provisions a fresh root and returns usable entries only after they are pipeline-usable

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js tests/cli/pipelineCheckArchiveReplaceLiveBootstrap.test.js --runInBand`

Expected: FAIL because bootstrap currently stops after the exhausted current-root attempt.

- [ ] **Step 3: Write minimal implementation**

Implement a narrow escalation path that:
- creates a fresh root email via existing Stage 1 helper capabilities
- provisions/captures API key and fresh inboxes
- maps them to the actionable workspace lineage
- returns a typed result such as `bootstrap-escalated-new-root`

- [ ] **Step 4: Run tests to verify they pass**

Run the same command.

### Task 3: Persist evidence-backed usable state for the new root/workspace

**Files:**
- Modify: `src/cli/pipeline-check-archive-replace.js`
- Modify: `src/pipeline/rotation/workspaceRegistry.js`
- Test: `tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js`
- Test: `tests/pipeline/rotation/workspaceRegistryOperational.test.js`

- [ ] **Step 1: Write the failing test**

Add coverage that a successful new-root escalation updates cached usable registry state with the new root/owner/workspace record only after live verification.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js tests/pipeline/rotation/workspaceRegistryOperational.test.js --runInBand`

Expected: FAIL because escalation results are not yet persisted into usable registry/cache.

- [ ] **Step 3: Write minimal implementation**

Persist the new usable observation into `state/rotation/live-workspace-registry.json` only when:
- root/owner is provisioned/recovered
- target workspace is active/usable
- returned inboxes are usable entries for the pipeline

- [ ] **Step 4: Run tests to verify they pass**

Run the same command.

### Task 4: Verify affected slice and perform one real rerun

**Files:**
- No new files unless a regression requires it

- [ ] **Step 1: Run focused verification**

Run:
`node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/bootstrapRuntimeCapacity.test.js tests/cli/pipelineCheckArchiveReplaceLiveBootstrap.test.js tests/cli/pipelineCheckArchiveReplaceLiveFix.test.js tests/pipeline/rotation/workspaceRegistryOperational.test.js --runInBand`

- [ ] **Step 2: Run affected regression slice**

Run:
`node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/workspaceRegistry*.test.js tests/pipeline/rotation/resolveExhaustedAliasLineage.test.js tests/cli/pipelineCheckArchiveReplace*.test.js tests/pipeline/rotation/preRemoveWorkspaceMembers.test.js tests/pipeline/rotation/browserlessWorkspaceClient.test.js --runInBand`

- [ ] **Step 3: Run one real rerun**

Run:
`node src/cli/pipeline-check-archive-replace.js`

Capture:
- archived capacity used vs new-root escalation
- selected root email / owner alias
- workspace(s) targeted
- usable capacity coverage vs demand
- whether Phase 2 begins or the next exact blocker
