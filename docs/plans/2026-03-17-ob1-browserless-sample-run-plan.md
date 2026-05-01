# OB1 Browserless Sample Run Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run four isolated live browserless onboarding samples on the `ob1-dedicated-1773603455` GCloud VM and report their status without changing host-level VM configuration or production local state files.

**Architecture:** Stage a self-contained temp bundle on the VM containing the current repo snapshot, a portable Node runtime, required npm dependencies, and copied state/secrets files. Execute `pipeline-check-archive-replace.js` only through `--router-onboard-email` against copied `auth/router/pool/health/archive` files so the live onboarding path is exercised while avoiding production state-file mutation.

**Tech Stack:** Node.js 24 portable runtime, npm, GCloud SSH/SCP, Chromium on VM, existing browserless workspace/onboarding pipeline.

---

### Task 1: Prepare isolated local bundle

**Files:**
- Create: `docs/plans/2026-03-17-ob1-browserless-sample-run-plan.md`
- Read: `src/cli/pipeline-check-archive-replace.js`
- Read: `src/pipeline/rotation/browserlessMemberOnboarder.js`
- Read: `src/pipeline/rotation/piAccountRegistrar.js`

**Step 1:** Select four unique sample inboxes with AgentMail API keys.

**Step 2:** Build isolated copied state files:
- minimal `account-router.json` with `openai-codex` pool only
- copied `auth.json` containing valid owner auth entry
- copied `codex-inbox-pool.json` containing only the four sample inboxes
- copied `account-router-health.json` with no exhausted codex aliases
- empty `codex-alias-archive.json`

**Step 3:** Bundle repo snapshot plus required auth-trace artifacts for browserless replay.

### Task 2: Stage runtime on OB1 VM

**Files:**
- Create remotely under `/tmp` only

**Step 1:** Copy portable Node runtime from local machine to VM temp dir.

**Step 2:** Copy project bundle and isolated state bundle to VM temp dir.

**Step 3:** Install only required npm dependencies in the temp project dir.

### Task 3: Execute four live sample runs

**Files:**
- Write remotely under temp run dir only

**Step 1:** Run `pipeline-check-archive-replace.js` with four `--router-onboard-email` arguments and path overrides pointing to copied state.

**Step 2:** Capture stdout/stderr to a run log.

**Step 3:** Save resulting copied state files and a concise machine-readable summary artifact.

### Task 4: Cleanup external workspace seats if needed

**Files:**
- Write remotely under temp run dir only

**Step 1:** Inspect run results for successfully joined workspace members.

**Step 2:** Remove successful sample members from the workspace owner account when safe, to avoid leaving extra consumed seats.

**Step 3:** Preserve copied auth/router artifacts for evidence.

### Task 5: Report status

**Files:**
- Create: `artifacts/workspace-replays/2026-03-17-ob1-browserless-sample-run-summary.json`

**Step 1:** Summarize per-email status, join path, router registration result, and cleanup result.

**Step 2:** Include VM target, temp run directory, and log/artifact paths.

**Step 3:** Report final outcome back to the user.
