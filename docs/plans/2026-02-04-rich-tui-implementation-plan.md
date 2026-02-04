# Rich TUI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a TUI-first workflow (wizard → preflight → confirm → run timeline → results + export bundle) for the existing headless signup/checkout automation, with safe defaults (no secret persistence unless opted in).

**Architecture:** Introduce a thin orchestration layer that wraps the existing `SignupFactory` run loop and emits structured events to a Rich TUI (Ink). Add a config manager (YAML + validation + redaction) and an artifact manager (per-run directory + export bundle manifest).

**Tech Stack:** Node.js (ESM), Ink (React), YAML config, Zod validation, EventEmitter-based run events.

---

## Ground Rules (Non‑negotiable)

- The automation engine remains snapshot-driven and must never type into chat.
- The TUI orchestrates runs; it must not bypass guardrails.
- Sensitive data masked in UI/logs; in-memory by default; explicit opt-in for storage.
- Add an architectural hook for a pre-billing / pre-subscribe “checkpoint prompt”. Default behavior in TUI is to require explicit confirmation before billing submission.

---

## Task 0: Dependency + entrypoint scaffolding

**Files:**
- Modify: `package.json`
- Create: `src/tui/index.js`
- Create: `src/tui/app/App.js` (Ink root component)
- Create: `src/tui/app/screens/*` (wizard/preflight/running/results)

**Step 1 (RED): Add a smoke test that the TUI entrypoint exports a callable `runTui()` (or similar)**
- Test: `tests/TuiEntrypoint.test.js`

**Step 2 (RED verify):**
```bash
npm test tests/TuiEntrypoint.test.js
```
Expected: FAIL (module not found / function missing).

**Step 3 (GREEN):**
- Add Ink + React deps:
  - `ink`, `react`, `ink-text-input`, `ink-select-input` (or minimal)
  - `yaml`, `zod`, `uuid`
- Add npm script:
  - `"tui": "node src/tui/index.js"`
- Implement `src/tui/index.js` to render `App`.

**Step 4 (GREEN verify):**
```bash
npm test tests/TuiEntrypoint.test.js
```
Expected: PASS.

---

## Task 1: Config model + validation + redaction

**Goal:** Support YAML config files (and wizard-generated configs) with strict validation and safe redaction.

**Files:**
- Create: `src/config/schema.js`
- Create: `src/config/ConfigManager.js`
- Create: `src/config/redaction.js`
- Test: `tests/ConfigManager.test.js`

**Step 1 (RED): Write validation tests**
- Valid minimal config loads.
- Missing required keys produces a friendly error.
- Redaction masks sensitive fields (card number, CVC, email/password) while preserving last4.

**Step 2 (RED verify):**
```bash
npm test tests/ConfigManager.test.js
```

**Step 3 (GREEN):**
- Implement Zod schema:
  - run: headless, stealth, timeouts
  - identity: email strategy + OTP timeout
  - plan: seat count, cadence
  - billing: card number/exp/cvc/address (optional if using test mode)
  - safety: requireConfirmBeforeSubscribe (default true)
  - artifacts: output dir, persistSecrets (default false)
- Implement YAML load/save using `yaml`.
- Implement redaction utilities.

**Step 4 (GREEN verify):** rerun test.

---

## Task 2: Artifact Manager + bundle export format

**Goal:** Each run writes artifacts into a per-run directory and emits a bundle manifest for export.

**Files:**
- Create: `src/artifacts/ArtifactManager.js`
- Create: `src/artifacts/RunBundle.js`
- Modify (small): `src/RunConfig.js` (add `artifactDir`, `runId`)
- Modify (small): `src/SignupFactory.js` (prefix all artifact writes with `artifactDir`)
- Test: `tests/ArtifactManager.test.js`

**Step 1 (RED):**
- Test that `ArtifactManager.createRunDir()` creates `artifacts/<run_id>/`.
- Test that writing a snapshot/screenshot path is recorded in a manifest JSON.
- Test that redacted config is embedded.

**Step 2 (RED verify):**
```bash
npm test tests/ArtifactManager.test.js
```

**Step 3 (GREEN):**
- `ArtifactManager` responsibilities:
  - allocate runId (`uuid`)
  - create run dir
  - provide `pathFor(kind, filename)` helpers
  - maintain `run.bundle.json` manifest with:
    - run_id, start_ts/end_ts, status
    - config_redacted
    - log_paths, snapshot_paths, screenshot_paths
    - failure_summary (if any)
- Update `SignupFactory` to accept `runConfig.artifactDir` and write:
  - `debug_snapshot.txt`, `failure_*.txt`, `checkout_failure_*.txt`
  - screenshots (step_*, checkout_*, etc)
  into that directory.

**Step 4 (GREEN verify):** rerun test.

**Notes:** This is the biggest behavioral refactor; keep it mechanical and covered by tests.

---

## Task 3: Run Orchestrator API (event stream + checkpoint hook)

**Goal:** Provide a stable API for the TUI to run the automation while receiving structured events.

**Files:**
- Create: `src/orchestrator/RunOrchestrator.js`
- Create: `src/orchestrator/events.js` (event type constants)
- Modify: `src/index.js` (keep current behavior; optionally expose a programmatic entry)
- Modify: `src/SignupFactory.js` (emit events via injected callback)
- Test: `tests/RunOrchestrator.test.js`

**Step 1 (RED):**
- Test that orchestrator emits:
  - `run:start`, `state:change`, `artifact:written`, `checkpoint:before_subscribe`, `run:success|run:failure`.
- Test that when checkpoint requires approval and approval is denied, the run aborts safely (no Subscribe click).

**Step 2 (RED verify):**
```bash
npm test tests/RunOrchestrator.test.js
```

**Step 3 (GREEN):**
- Implement `RunOrchestrator` wrapping `SignupFactory`.
- Provide `await orchestrator.run({ config })` and `orchestrator.on(event, handler)`.
- Add a `checkpointProvider` interface:
  - `async approve({ type, summary, artifacts }) -> boolean`
  - In TUI: prompt user.
  - In headless CLI (Phase A command): default approve=true for compatibility.

**Step 4 (GREEN verify):** rerun.

---

## Task 4: Rich TUI (Ink) screens + UX

**Goal:** Implement the wizard → preflight → confirm → running timeline → results flow.

**Files:**
- Create: `src/tui/app/screens/WizardScreen.js`
- Create: `src/tui/app/screens/PreflightScreen.js`
- Create: `src/tui/app/screens/ConfirmScreen.js`
- Create: `src/tui/app/screens/RunningScreen.js`
- Create: `src/tui/app/screens/ResultsScreen.js`
- Create: `src/tui/app/components/*` (StatusBar, Timeline, LogPane, ArtifactList)
- Test: `tests/TuiStateMachine.test.js` (pure reducer/state machine tests)

**Step 1 (RED):**
- Write reducer tests for screen transitions and keybindings (no Ink rendering needed).

**Step 2 (RED verify):**
```bash
npm test tests/TuiStateMachine.test.js
```

**Step 3 (GREEN):**
- Implement minimal state machine:
  - Wizard collects config (headless/stealth/timeouts/artifact output)
  - Preflight checks: env present (email provider keys), writable artifacts dir
  - Confirm screen: explicit start confirmation
  - Running: timeline of orchestrator events, latest artifacts
  - Results: success/failure summary, export path
- Redact sensitive values in all display.

**Step 4 (GREEN verify):** rerun.

---

## Task 5: Docs + usability

**Files:**
- Modify: `README.md` (or create `docs/tui.md`)

**Steps:**
- Document:
  - `npm run tui`
  - config file location (`--config path.yml`)
  - how artifacts are stored and how to export bundle
  - safety defaults (no secret persistence unless opted in)

---

## Verification Gates

### Unit Tests (mandatory after changes affecting runtime)
```bash
npm test tests/SignupFactoryAboutYou.test.js
npm test tests/ChatGPTStateManager.test.js
```

### Phase A (Gate 1) must remain reproducible
```bash
export USER_DATA_DIR=$(mktemp -d)
MAX_RUN_MS=300000 STEP_TIMEOUT_MS=60000 HEADLESS=true STEALTH=true node --env-file=../../.env src/index.js
```

---

## Execution Options

Plan saved to `docs/plans/2026-02-04-rich-tui-implementation-plan.md`.

Two execution options:

1) **Subagent‑Driven (this session)** — dispatch subagents per component (B1–B4) with review checkpoints.
2) **Parallel session** — open a new session and use superpowers:executing-plans.
