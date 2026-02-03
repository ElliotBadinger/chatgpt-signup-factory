---
type: report
title: Run Config and Fail-Fast Timeouts Plan
created: 2026-02-03
tags:
  - run-config
  - timeouts
  - plan
related:
  - "[[2026-02-03-run-config-timeouts-design]]"
---

# Run Config and Fail-Fast Timeouts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Centralize run-time configuration, enforce a hard wall-clock timeout, and align Jest timeouts with the new limits.

**Architecture:** Add a small RunConfig module for defaults + env overrides, pass it into SignupFactory, and use it to control retries and delays in the main loop.

**Tech Stack:** Node.js, Jest, existing SignupFactory modules.

### Task 1: Add RunConfig module and tests

**Files:**
- Create: `src/RunConfig.js`
- Create: `tests/RunConfig.test.js`

**Step 1: Write the failing test**

```javascript
import { getRunConfig, MAX_RUN_LIMIT_MS } from '../src/RunConfig.js';

// Expect default values and env overrides to be applied.
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/RunConfig.test.js`
Expected: FAIL with "Cannot find module '../src/RunConfig.js'"

**Step 3: Write minimal implementation**

```javascript
export const DEFAULT_RUN_CONFIG = { /* defaults */ };
export const getRunConfig = () => ({ /* env overrides */ });
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/RunConfig.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/RunConfig.js tests/RunConfig.test.js
git commit -m "feat: add run config defaults and tests"
```

### Task 2: Wire RunConfig into runtime and Jest

**Files:**
- Modify: `src/index.js`
- Modify: `src/SignupFactory.js`
- Modify: `jest.config.js`

**Step 1: Write the failing test**

```javascript
// Add a focused unit test (or extend existing tests) that asserts
// the run loop enforces MAX_RUN_MS when time advances.
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/<new-test>.js`
Expected: FAIL with timeout assertion

**Step 3: Write minimal implementation**

```javascript
const runConfig = getRunConfig();
const factory = new SignupFactory(API_KEY, runConfig);
```

```javascript
if (Date.now() - startTime > this.config.MAX_RUN_MS) throw new Error(...);
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/<new-test>.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.js src/SignupFactory.js jest.config.js
git commit -m "feat: enforce run timeouts via config"
```
