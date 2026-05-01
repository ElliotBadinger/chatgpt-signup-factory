# Root-Mail_a Router And 4th Slot Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Get the 3 recovered Root-Mail_a members into durable router state if possible, then resolve or hard-block the 4th-slot onboarding path with concrete evidence, and save a determinism hardening writeup.

**Architecture:** First verify whether current browserless recoveries already satisfy the router durability contract. If not, trace where refresh-bearing auth is supposed to come from and use the existing hardened onboarding paths or captured artifacts instead of ad hoc state writes. Only after the router state is understood should the remaining 4th-slot invite/materialization failure be pushed further.

**Tech Stack:** Node.js, local JSON state in `~/.pi/agent/`, browserless ChatGPT/AgentMail recovery flows, workspace API verification.

---

### Task 1: Verify Router Preconditions For Recovered Members

**Files:**
- Read: `src/pipeline/rotation/routerOnboarder.js`
- Read: `src/pipeline/rotation/piAccountRegistrar.js`
- Read: `src/pipeline/rotation/verifyRecoveredAlias.js`

**Step 1:** Inspect the router onboarding contract, especially refresh-token requirements and workspace checks.

**Step 2:** Compare the 3 recovered member artifacts against that contract.

**Step 3:** Record whether operational registration can proceed without code changes.

### Task 2: Attempt Durable Router Onboarding

**Files:**
- Read/Run: `src/cli/router-onboard-inboxes.js`
- Read/Run: `src/pipeline/rotation/routerOnboarder.js`

**Step 1:** If current auth satisfies the contract, onboard the 3 usable aliases through the supported registrar path.

**Step 2:** Verify `~/.pi/agent/auth.json`, `~/.pi/agent/account-router.json`, and live workspace/router checks after registration.

**Step 3:** If registration fails, capture the exact failing condition and treat it as a debugging problem.

### Task 3: Debug Durable Auth Gap

**Files:**
- Read: `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
- Read: `src/pipeline/authTrace/openaiAuthReplay.js`
- Read: `src/pipeline/rotation/browserlessMemberOnboarder.js`

**Step 1:** Trace where refresh-bearing auth is expected to appear in the successful browserless path.

**Step 2:** Check existing recovery artifacts for hidden durable credentials or session state that can be converted safely.

**Step 3:** Only if root cause is proven and local, decide whether a code change is warranted under TDD.

### Task 4: Continue 4th-Slot Operational Recovery

**Files:**
- Read/Run: `src/pipeline/authTrace/agentMailOtp.js`
- Read/Run: `src/pipeline/rotation/browserlessWorkspaceClient.js`
- Read/Run: `src/pipeline/authTrace/recoverBrowserlessIdentity.js`

**Step 1:** Continue from the current `sparklingevent72` and `carefulmusic791` evidence rather than creating unnecessary new identities.

**Step 2:** Prove whether the blocker is invite delivery, workspace materialization, or account-selection state.

**Step 3:** Either produce a 4th usable workspace-bound alias or collect concrete external blocker evidence.

### Task 5: Save Hardening Writeup

**Files:**
- Create: `docs/plans/2026-03-30-root-mail-a-determinism-writeup.md`

**Step 1:** Summarize recovered aliases and router onboarding evidence.

**Step 2:** Document remaining blockers and root causes.

**Step 3:** Write concrete determinism hardening recommendations and an artifact index.