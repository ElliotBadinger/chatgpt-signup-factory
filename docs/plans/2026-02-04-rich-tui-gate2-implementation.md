# Rich TUI Gate 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete Rich TUI Gate 2 with ops-grade UX, event-driven run.bundle.json updates, and comprehensive unit/functional/integration/property tests.

**Architecture:** RunOrchestrator emits canonical events; ArtifactManager listens and persists derived state to run.bundle.json; TUI listens and renders only (except it writes its own redacted log file which is recorded as a normal artifact).

**Tech Stack:** Node.js (ESM), Ink, Zod, YAML, Jest, ink-testing-library, fast-check.

---

### Task 1: Git hygiene + runtime artifact ignore

**Files:**
- Modify: `.gitignore`

**Step 1: Write the failing test**

_Not applicable (config-only change)._ Create a minimal checklist in this task instead:
- Ensure runtime artifacts (`artifacts/`, `*_snapshot.txt`, `*_screenshot.png`, `failure_meta*.json`, `auth_error_*.{png,txt}`, `restart_cloudflare_*.{png,txt}`) are ignored.

**Step 2: Apply change**

Add ignore patterns to `.gitignore`.

**Step 3: Verify**

```bash
git status -sb
```
Expected: runtime artifacts no longer appear as untracked.

**Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore runtime artifacts"
```

---

### Task 2: PreflightResult model + tests

**Files:**
- Create: `src/tui/preflight.js`
- Test: `tests/Preflight.test.js`

**Step 1: Write the failing test**

```js
import { runPreflight } from '../src/tui/preflight.js';

test('preflight returns structured checks and ok=false when env missing', () => {
  const result = runPreflight({ env: {}, artifactsDir: '/tmp' });
  expect(result.ok).toBe(false);
  expect(result.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'env.agentmail', ok: false })
    ])
  );
});
```

**Step 2: Run test to verify it fails**

```bash
npm test tests/Preflight.test.js
```
Expected: FAIL (module not found / runPreflight missing).

**Step 3: Write minimal implementation**

```js
export function runPreflight({ env, artifactsDir, fsImpl = fs } = {}) {
  const checks = [];
  // add checks with {id, ok, message, fixHint}
  return { ok: checks.every(c => c.ok), checks };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test tests/Preflight.test.js
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/tui/preflight.js tests/Preflight.test.js
git commit -m "test: add preflight result model"
```

---

### Task 3: State machine invariants + property tests

**Files:**
- Modify: `src/tui/stateMachine.js`
- Test: `tests/TuiStateMachine.test.js`
- Create: `tests/TuiStateMachine.property.test.js`

**Step 1: Write failing tests**

Add unit tests for:
- screen transitions
- checkpoint lifecycle
- invalid state protection (cannot be RESULTS with run.status=running)

Add property tests with fast-check:

```js
fc.assert(fc.property(fc.constantFrom('RUN_SUCCESS','RUN_FAILURE'), (action) => {
  const s = reducer(reducer(createInitialState(), {type:'RUN_START'}), {type: action});
  expect(s.run.status).not.toBe('running');
  expect(s.checkpoint.pending).toBe(false);
}));
```

**Step 2: Run tests to verify failure**

```bash
npm test tests/TuiStateMachine.test.js
npm test tests/TuiStateMachine.property.test.js
```
Expected: FAIL (missing behaviors / fast-check not installed yet).

**Step 3: Minimal implementation**

Update reducer to enforce invariants, add fast-check to devDependencies.

**Step 4: Run tests to verify pass**

```bash
npm test tests/TuiStateMachine.test.js
npm test tests/TuiStateMachine.property.test.js
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/tui/stateMachine.js tests/TuiStateMachine.test.js tests/TuiStateMachine.property.test.js package.json package-lock.json
git commit -m "test: enforce TUI state invariants"
```

---

### Task 4: ArtifactManager event listener + bundle updates

**Files:**
- Modify: `src/artifacts/ArtifactManager.js`
- Modify: `src/artifacts/RunBundle.js`
- Test: `tests/ArtifactManager.test.js`
- Create: `tests/ArtifactManager.property.test.js`

**Step 1: Write failing tests**

```js
// in ArtifactManager.test.js
manager.handleEvent({ type: 'run:start' });
manager.handleEvent({ type: 'artifact:written', kind: 'snapshot', path: 'snapshots/a.txt' });
manager.handleEvent({ type: 'run:failure', reason: 'ERR' });
expect(manager.getManifest().status).toBe('failure');
expect(manager.getManifest().snapshot_paths).toContain('snapshots/a.txt');
```

Property test for path safety:

```js
fc.assert(fc.property(fc.string(), (p) => {
  const res = resolveArtifactPath('artifacts/run', p);
  expect(res.includes('..')).toBe(false);
}));
```

**Step 2: Run tests to verify failure**

```bash
npm test tests/ArtifactManager.test.js
npm test tests/ArtifactManager.property.test.js
```

**Step 3: Minimal implementation**

- Add `handleEvent(event)` to ArtifactManager to update bundle status, last_state, failure_summary, and artifact paths.
- Add `event_summary` (optional) to RunBundle JSON for last_state/last_event_ts.

**Step 4: Run tests to verify pass**

```bash
npm test tests/ArtifactManager.test.js
npm test tests/ArtifactManager.property.test.js
```

**Step 5: Commit**

```bash
git add src/artifacts/ArtifactManager.js src/artifacts/RunBundle.js tests/ArtifactManager.test.js tests/ArtifactManager.property.test.js
git commit -m "feat: persist run events in bundle"
```

---

### Task 5: Engine emits artifact:written for all artifacts

**Files:**
- Modify: `src/SignupFactory.js`
- Test: `tests/RunOrchestrator.test.js` (expanded with fake factory) or add `tests/SignupFactoryArtifacts.test.js`

**Step 1: Write failing test**

Add a test with a fake factory that simulates artifact emission and ensure event contains artifactDir-prefixed paths.

**Step 2: Run test to verify failure**

```bash
npm test tests/RunOrchestrator.test.js
```
Expected: FAIL.

**Step 3: Minimal implementation**

- Emit `artifact:written` after every snapshot/screenshot write in SignupFactory (including debug_snapshot, failure artifacts, and tool-driven screenshots).
- Include `{ kind, path }` with artifactDir-prefixed paths.

**Step 4: Run test to verify pass**

```bash
npm test tests/RunOrchestrator.test.js
```

**Step 5: Commit**

```bash
git add src/SignupFactory.js tests/RunOrchestrator.test.js
git commit -m "feat: emit artifact events with full paths"
```

---

### Task 6: RunOrchestrator attaches ArtifactManager + log artifacts

**Files:**
- Modify: `src/orchestrator/RunOrchestrator.js`
- Modify: `src/orchestrator/events.js`
- Create: `src/tui/runLogger.js`
- Test: `tests/RunOrchestrator.test.js`
- Create: `tests/RunOrchestrator.integration.test.js`

**Step 1: Write failing tests**

Integration test:
- Instantiate RunOrchestrator with FakeFactory emitting events.
- Pass ArtifactManager; verify run.bundle.json updated when events occur.

**Step 2: Run tests to verify failure**

```bash
npm test tests/RunOrchestrator.integration.test.js
```
Expected: FAIL.

**Step 3: Minimal implementation**

- RunOrchestrator accepts `artifactManager` and `logger`.
- Register listeners internally to call `artifactManager.handleEvent(ev)`.
- Add `Events.LOG_LINE` for log artifact handling.
- `runLogger` writes redacted log lines to `logs/tui.log` and emits `log` events.

**Step 4: Run tests to verify pass**

```bash
npm test tests/RunOrchestrator.test.js
npm test tests/RunOrchestrator.integration.test.js
```

**Step 5: Commit**

```bash
git add src/orchestrator/RunOrchestrator.js src/orchestrator/events.js src/tui/runLogger.js tests/RunOrchestrator.test.js tests/RunOrchestrator.integration.test.js
git commit -m "feat: orchestrator persists run events and logs"
```

---

### Task 7: TUI core UX (wizard, preflight, confirm, running, results)

**Files:**
- Modify: `src/tui/App.js`
- Modify: `src/tui/screens/WizardScreen.js`
- Modify: `src/tui/screens/PreflightScreen.js`
- Modify: `src/tui/screens/ConfirmScreen.js`
- Modify: `src/tui/screens/RunningScreen.js`
- Modify: `src/tui/screens/ResultsScreen.js`
- Create: `src/tui/components/*`
- Test: `tests/TuiEntrypoint.test.js`
- Create: `tests/TuiScreens.test.js`

**Step 1: Write failing tests**

Functional tests using ink-testing-library for:
- Wizard loads YAML, edits fields, saves YAML.
- Preflight renders check results.
- Confirm shows redacted preview.
- Running shows timeline entries and artifact list.
- Checkpoint prompt handles y/n.

**Step 2: Run tests to verify failure**

```bash
npm test tests/TuiScreens.test.js
```
Expected: FAIL.

**Step 3: Minimal implementation**

- Implement multi-section wizard with config + configRedacted split.
- Add YAML load/save actions.
- Use PreflightResult model.
- Running screen includes timeline, artifacts, log filter toggles, failure summary panel.
- Results screen shows bundle path and status.

**Step 4: Run tests to verify pass**

```bash
npm test tests/TuiScreens.test.js
npm test tests/TuiEntrypoint.test.js
```

**Step 5: Commit**

```bash
git add src/tui/App.js src/tui/screens src/tui/components tests/TuiScreens.test.js tests/TuiEntrypoint.test.js
git commit -m "feat: complete Rich TUI UX flow"
```

---

### Task 8: Config → TUI integration tests

**Files:**
- Create: `tests/TuiConfig.integration.test.js`

**Step 1: Write failing test**

- Load YAML config, feed into wizard, confirm preview uses redaction, run uses validated values.

**Step 2: Run tests to verify failure**

```bash
npm test tests/TuiConfig.integration.test.js
```

**Step 3: Minimal implementation**

Add mapping helpers in TUI to apply validated config to wizard state.

**Step 4: Run tests to verify pass**

```bash
npm test tests/TuiConfig.integration.test.js
```

**Step 5: Commit**

```bash
git add tests/TuiConfig.integration.test.js src/tui/App.js src/tui/screens/WizardScreen.js
git commit -m "test: config-to-tui integration"
```

---

### Task 9: Property-based redaction/path invariants

**Files:**
- Create: `tests/Redaction.property.test.js`
- Modify: `src/config/redaction.js`

**Step 1: Write failing test**

```js
fc.assert(fc.property(fc.record({ password: fc.string(), cvc: fc.string(), cardNumber: fc.string() }), (input) => {
  const redacted = redactConfig({ identity: { password: input.password }, billing: { cvc: input.cvc, cardNumber: input.cardNumber } });
  expect(JSON.stringify(redacted)).not.toContain(input.password);
  expect(JSON.stringify(redacted)).not.toContain(input.cvc);
}));
```

**Step 2: Run test to verify failure**

```bash
npm test tests/Redaction.property.test.js
```

**Step 3: Minimal implementation**

Update redaction to defensively mask all sensitive fields even when nested or missing.

**Step 4: Run test to verify pass**

```bash
npm test tests/Redaction.property.test.js
```

**Step 5: Commit**

```bash
git add src/config/redaction.js tests/Redaction.property.test.js
git commit -m "test: redaction invariants"
```

---

### Task 10: Docs update

**Files:**
- Modify: `docs/tui.md`

**Step 1: Update docs**

Document YAML load/save, preflight checklist, checkpoint prompt, artifact paths, and run.bundle.json contents.

**Step 2: Commit**

```bash
git add docs/tui.md
git commit -m "docs: update TUI guide"
```

---

### Verification Gates (run after implementation)

```bash
npm test tests/TuiEntrypoint.test.js
npm test tests/TuiStateMachine.test.js
npm test tests/ConfigManager.test.js
npm test tests/ArtifactManager.test.js
npm test tests/ArtifactPathUtils.test.js
npm test tests/RunOrchestrator.test.js
```

If engine behavior was modified:

```bash
npm test tests/SignupFactoryAboutYou.test.js
npm test tests/ChatGPTStateManager.test.js
```

Phase A regression:

```bash
./scripts/benchmark-coldstart-4.sh
```

---

Plan complete and saved to `docs/plans/2026-02-04-rich-tui-gate2-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?
