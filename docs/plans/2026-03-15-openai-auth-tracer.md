# OpenAI Auth Tracer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local real-Chrome auth tracing tool that captures network, checkpoint, cookie, Clerk, and session evidence for `auth.openai.com` and `chatgpt.com` flows.

**Architecture:** Add a small evidence-focused tracing subsystem under `src/pipeline/authTrace/` plus a new CLI entrypoint. Keep the tracer observational and artifact-oriented; do not mix in production rotation logic. Use TDD for each module and reuse existing artifact-writing patterns where possible.

**Tech Stack:** Node.js, Puppeteer, puppeteer-extra, Jest, JSONL artifacts, real Chrome, Xvfb.

---

### Task 1: Add trace artifact path helpers

**Files:**
- Create: `src/pipeline/authTrace/artifacts.js`
- Test: `tests/pipeline/authTrace/artifacts.test.js`

**Step 1: Write the failing test**
Create tests for:
- `traceRunId(label, now)` returns deterministic run id
- `traceArtifactDir(baseDir, runId)` nests under base dir
- `ensureTraceRunDir(dir)` creates base subdirs (`checkpoints`, `screenshots`)

**Step 2: Run test to verify it fails**
Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. tests/pipeline/authTrace/artifacts.test.js --runInBand`
Expected: FAIL because module does not exist.

**Step 3: Write minimal implementation**
Implement deterministic helpers and directory creation.

**Step 4: Run test to verify it passes**
Run the same command.
Expected: PASS.

**Step 5: Commit**
```bash
git add tests/pipeline/authTrace/artifacts.test.js src/pipeline/authTrace/artifacts.js
git commit -m "feat: add auth trace artifact helpers"
```

### Task 2: Add redaction and trace-event serialization helpers

**Files:**
- Create: `src/pipeline/authTrace/redaction.js`
- Create: `src/pipeline/authTrace/traceWriter.js`
- Test: `tests/pipeline/authTrace/redaction.test.js`
- Test: `tests/pipeline/authTrace/traceWriter.test.js`

**Step 1: Write the failing tests**
Cover:
- bearer/cookie/token values are redacted
- JSONL appends one event per line
- trace writer preserves non-sensitive metadata

**Step 2: Run tests to verify they fail**
Run targeted Jest tests.

**Step 3: Write minimal implementation**
Implement redaction helpers and an append-only JSONL writer.

**Step 4: Run tests to verify they pass**
Run targeted Jest tests.

**Step 5: Commit**
```bash
git add tests/pipeline/authTrace/redaction.test.js tests/pipeline/authTrace/traceWriter.test.js src/pipeline/authTrace/redaction.js src/pipeline/authTrace/traceWriter.js
git commit -m "feat: add auth trace redaction and event writer"
```

### Task 3: Add Clerk/session checkpoint probe

**Files:**
- Create: `src/pipeline/authTrace/checkpoints.js`
- Test: `tests/pipeline/authTrace/checkpoints.test.js`

**Step 1: Write the failing tests**
Cover:
- checkpoint snapshot shape
- Clerk summary extraction from provided page probe data
- session summary extraction from `/api/auth/session`
- challenge marker detection from DOM text/flags

**Step 2: Run test to verify it fails**
Run targeted Jest test.

**Step 3: Write minimal implementation**
Implement pure helpers for normalizing checkpoint payloads and a browser probe script export.

**Step 4: Run test to verify it passes**
Run targeted Jest test.

**Step 5: Commit**
```bash
git add tests/pipeline/authTrace/checkpoints.test.js src/pipeline/authTrace/checkpoints.js
git commit -m "feat: add auth trace checkpoint probes"
```

### Task 4: Add Chrome trace session recorder

**Files:**
- Create: `src/pipeline/authTrace/chromeTraceSession.js`
- Test: `tests/pipeline/authTrace/chromeTraceSession.test.js`

**Step 1: Write the failing tests**
Cover:
- attaches listeners for request/response/nav/console/pageerror/requestfailed
- filters relevant domains
- writes redacted events through trace writer

**Step 2: Run test to verify it fails**
Run targeted Jest test.

**Step 3: Write minimal implementation**
Implement listener attachment with dependency injection for browser/page/writer.

**Step 4: Run test to verify it passes**
Run targeted Jest test.

**Step 5: Commit**
```bash
git add tests/pipeline/authTrace/chromeTraceSession.test.js src/pipeline/authTrace/chromeTraceSession.js
git commit -m "feat: add chrome trace session recorder"
```

### Task 5: Add manual trace runner orchestration

**Files:**
- Create: `src/pipeline/authTrace/runAuthTrace.js`
- Test: `tests/pipeline/authTrace/runAuthTrace.test.js`

**Step 1: Write the failing tests**
Cover:
- run creates artifact dir and summary
- manual mode records initial checkpoint and final summary
- scenario/mode options propagate into summary

**Step 2: Run test to verify it fails**
Run targeted Jest test.

**Step 3: Write minimal implementation**
Implement a lightweight runner with injectable Chrome launcher and prompt/writer hooks.

**Step 4: Run test to verify it passes**
Run targeted Jest test.

**Step 5: Commit**
```bash
git add tests/pipeline/authTrace/runAuthTrace.test.js src/pipeline/authTrace/runAuthTrace.js
git commit -m "feat: add auth trace runner"
```

### Task 6: Add CLI entrypoint

**Files:**
- Create: `src/cli/pipeline-auth-trace.js`
- Test: `tests/cli/pipelineAuthTrace.test.js`

**Step 1: Write the failing tests**
Cover:
- parses `--mode`, `--scenario`, `--label`, `--artifact-dir`, `--start-url`
- delegates to `runAuthTrace`

**Step 2: Run test to verify it fails**
Run targeted Jest test.

**Step 3: Write minimal implementation**
Implement CLI parser and dependency injection pattern consistent with other CLIs.

**Step 4: Run test to verify it passes**
Run targeted Jest test.

**Step 5: Commit**
```bash
git add tests/cli/pipelineAuthTrace.test.js src/cli/pipeline-auth-trace.js
git commit -m "feat: add auth trace CLI"
```

### Task 7: Add local real-Chrome launcher integration

**Files:**
- Modify: `src/pipeline/authTrace/runAuthTrace.js`
- Create: `src/pipeline/authTrace/launchLocalChrome.js`
- Test: `tests/pipeline/authTrace/launchLocalChrome.test.js`
- Test: `tests/pipeline/authTrace/runAuthTrace.test.js`

**Step 1: Write the failing tests**
Cover:
- launcher uses configured Chrome binary
- launcher returns page/browser/cleanup
- runner calls launcher in manual mode

**Step 2: Run test to verify it fails**
Run targeted Jest tests.

**Step 3: Write minimal implementation**
Add local Chrome launch path using puppeteer-extra + stealth.

**Step 4: Run test to verify it passes**
Run targeted Jest tests.

**Step 5: Commit**
```bash
git add tests/pipeline/authTrace/launchLocalChrome.test.js tests/pipeline/authTrace/runAuthTrace.test.js src/pipeline/authTrace/launchLocalChrome.js src/pipeline/authTrace/runAuthTrace.js
git commit -m "feat: add local chrome launcher for auth trace"
```

### Task 8: Run focused verification, then full suite

**Files:**
- Modify: any touched files above

**Step 1: Run focused auth-trace tests**
Run:
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. tests/pipeline/authTrace tests/cli/pipelineAuthTrace.test.js --runInBand
```
Expected: PASS.

**Step 2: Run full suite**
Run:
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --runInBand
```
Expected: all tests pass.

**Step 3: Manual smoke run**
Run:
```bash
xvfb-run -a -s "-screen 0 1280x1024x24" node src/cli/pipeline-auth-trace.js --mode manual --scenario unknown-auto --label local-smoke
```
Expected: artifact directory created and initial trace files emitted.

**Step 4: Commit**
```bash
git add -A
git commit -m "feat: add openai auth tracing pipeline"
```

Plan complete and saved to `docs/plans/2026-03-15-openai-auth-tracer.md`.
