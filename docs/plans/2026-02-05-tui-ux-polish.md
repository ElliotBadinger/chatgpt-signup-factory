# TUI UX Polish + E2E Test Harness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the Ink-based TUI into a clearer, less confusing operator experience with consistent layout, understandable run states/phases, robust error handling, and true end-to-end TUI tests.

**Architecture:** Keep Ink as the renderer, but introduce a small component library (StatusBar, Notifications, KeyValueTable, LogViewer) and refactor `App` to support dependency injection of a `preflightProvider` and `runEngine` so we can run full TUI flows in tests deterministically.

**Tech Stack:** Ink 4.x, ink-testing-library, Jest, (new) ink-spinner, ink-select-input, ink-text-input.

---

### Task 1: Add failing E2E TUI test (success flow)

**Files:**
- Create: `tests/TuiE2E.test.js`
- Modify (expected): `src/tui/App.js`

**Step 1: Write the failing test**
- Render `App` with injected `preflightProvider` returning `{ok:true}` and injected `runEngine` that emits a small sequence of events and then resolves.
- Simulate key presses: Enter → Preflight, Enter → Confirm, Enter → Start.
- Assert final frame contains `Results` and `SUCCESS`.

**Step 2: Run test to verify it fails**
Run: `npm test -- tests/TuiE2E.test.js`
Expected: FAIL because `App` doesn’t accept injected providers.

**Step 3: Implement minimal injection API in App**
- Add optional props: `preflightProvider`, `runEngine`.
- Default to current behavior when not provided.

**Step 4: Run test to verify it passes**

**Step 5: Commit**

---

### Task 2: Add failing E2E TUI test (checkpoint approval + failure flow)

**Files:**
- Modify: `tests/TuiE2E.test.js`
- Modify: `src/tui/App.js`, `src/tui/screens/RunningScreen.js`

**Step 1: Add a test**
- `runEngine` emits checkpoint request then waits for `approve()`.
- Simulate pressing `y` and ensure run continues.
- Add a failure variant and assert failure summary shows friendly state + error.

**Step 2: Run test to verify it fails**

**Step 3: Implement support**
- Ensure checkpoint UI is prominent and key handling deterministic.

**Step 4: Run tests; ensure pass**

---

### Task 3: Component library for polished layout (TDD with screen snapshot tests)

**Files:**
- Create: `src/tui/components/StatusBar.js`
- Create: `src/tui/components/NotificationBar.js`
- Create: `src/tui/components/KeyValueTable.js`
- Create: `src/tui/components/LogViewer.js`
- Modify: `src/tui/components/Header.js`
- Modify: `src/tui/screens/WizardScreen.js`
- Modify: `src/tui/screens/ConfirmScreen.js`
- Modify: `src/tui/screens/RunningScreen.js`
- Modify: `src/tui/screens/ResultsScreen.js`
- Test: `tests/TuiScreens.test.js`

**Steps:**
1. Update `tests/TuiScreens.test.js` expectations to the new layout (RED).
2. Implement components + screen refactors (GREEN).
3. Run `npm test`.

---

### Task 4: Understandable run states/phases

**Files:**
- Create: `src/tui/stateLabels.js`
- Modify: `src/tui/screens/RunningScreen.js`
- Test: `tests/TuiScreens.test.js`, `tests/TuiE2E.test.js`

**Steps:**
1. Add mapping from agent state names (`LOGIN_EMAIL`, `OTP_VERIFICATION`, etc.) to friendly labels and a coarse phase (`Authentication`, `Onboarding`, `Checkout`).
2. Display current phase + last agent state prominently.

---

### Task 5: Error handling throughout the TUI

**Files:**
- Modify: `src/tui/App.js`
- Test: `tests/TuiE2E.test.js`

**Steps:**
1. Introduce notification mechanism (info/warn/error).
2. Surface load/save config errors and run failures consistently.

---

### Task 6: Dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

**Steps:**
1. Add `ink-spinner`, `ink-select-input`, `ink-text-input`.
2. Run `npm test`.

---

### Task 7: Verification

Run:
- `npm test`
- (Optional) `scripts/benchmark-coldstart-4.sh` (to ensure no regressions outside TUI)
