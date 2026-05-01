# Account-Router Lazy Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce startup latency by deferring account-router runtime initialization and background work until needed, while preserving dashboard, failover, quota, and polling behavior.

**Architecture:** Add a one-time runtime initialization gate and move heavy `session_start` work into deferred maintenance. Keep boot path minimal; force runtime readiness only on `/accounts`, `/quotas`, and failover paths.

**Tech Stack:** TypeScript, Node test runner, pi account-router extension.

---

### Task 1: Add a startup helper and tests

**Files:**
- Create: `/home/epistemophile/.pi/agent/extensions/account-router/startup-lifecycle.ts`
- Create: `/home/epistemophile/.pi/agent/extensions/account-router/tests/startup-lifecycle.test.ts`

- [ ] **Step 1: Write failing tests for one-time deferred scheduling semantics**
- [ ] **Step 2: Implement helper for one-time runtime readiness and deferred startup scheduling**
- [ ] **Step 3: Run startup helper tests**

### Task 2: Wire lazy runtime readiness into `index.ts`

**Files:**
- Modify: `/home/epistemophile/.pi/agent/extensions/account-router/index.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/startup-lifecycle.test.ts`

- [ ] **Step 1: Add runtime-ready and runtime-dirty state**
- [ ] **Step 2: Add `ensureRuntimeReady(ctx)` and `markRuntimeDirty()` helpers**
- [ ] **Step 3: Replace eager `session_start` runtime work with deferred scheduling**

### Task 3: Force runtime readiness on real feature paths

**Files:**
- Modify: `/home/epistemophile/.pi/agent/extensions/account-router/index.ts`

- [ ] **Step 1: Call `ensureRuntimeReady(ctx)` in `/accounts`**
- [ ] **Step 2: Call `ensureRuntimeReady(ctx)` in `/quotas`**
- [ ] **Step 3: Call `ensureRuntimeReady(ctx)` in failover `turn_end` path**
- [ ] **Step 4: On config-changing input, mark runtime dirty instead of eagerly reinitializing everything**

### Task 4: Verify lazy-startup slice and regressions

**Files:**
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/startup-lifecycle.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/smoke.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/global-poller.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/health-store.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/global-poll-planner.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/route-selection-strict.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/quota-proof-state.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/availability-state.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/dashboard-quota-freshness.test.ts`

- [ ] **Step 1: Run focused lazy-startup tests**
- [ ] **Step 2: Run quota/failover regression suite**
- [ ] **Step 3: Run final combined verification command**
