# Signupx CLI Packaging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Package the project as a published npm CLI with a global `signupx` command using Commander, while keeping runtime behavior unchanged.

**Architecture:** Add a Commander-based CLI entrypoint (`src/cli/signupx.js`) that dispatches to existing TUI and headless entrypoints. Keep a thin wrapper: parse args, load config when needed, map config to env for headless runs, and invoke existing runtime.

**Tech Stack:** Node.js (ESM), Commander, Ink TUI.

---

### Task 1: CLI program skeleton + tests

**Files:**
- Create: `src/cli/signupx.js`
- Create: `src/cli/program.js`
- Create: `tests/CliEntrypoint.test.js`
- Modify: `package.json`

**Step 1: Write the failing tests**

```js
import { createProgram } from '../src/cli/program.js';

it('dispatches signupx tui with config path', async () => {
  const runTui = jest.fn().mockResolvedValue();
  const runHeadless = jest.fn().mockResolvedValue();
  const program = createProgram({ runTui, runHeadless });

  await program.parseAsync(['node', 'signupx', 'tui', '--config', 'cfg.yml'], { from: 'user' });

  expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ configPath: 'cfg.yml' }));
});

it('dispatches signupx run with config path', async () => {
  const runTui = jest.fn().mockResolvedValue();
  const runHeadless = jest.fn().mockResolvedValue();
  const program = createProgram({ runTui, runHeadless });

  await program.parseAsync(['node', 'signupx', 'run', '--config', 'cfg.yml'], { from: 'user' });

  expect(runHeadless).toHaveBeenCalledWith(expect.objectContaining({ configPath: 'cfg.yml' }));
});
```

**Step 2: Run test to verify failure**

```bash
npm test tests/CliEntrypoint.test.js
```
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

`src/cli/program.js`:
```js
import { Command } from 'commander';

export function createProgram({ runTui, runHeadless }) {
  const program = new Command();
  program.name('signupx').description('ChatGPT trial provisioning operator tool');

  program
    .command('tui')
    .option('-c, --config <path>', 'config path', 'config.yaml')
    .action(async (opts) => runTui({ configPath: opts.config }));

  program
    .command('run')
    .option('-c, --config <path>', 'config path', 'config.yaml')
    .action(async (opts) => runHeadless({ configPath: opts.config }));

  return program;
}
```

`src/cli/signupx.js`:
```js
#!/usr/bin/env node
import { createProgram } from './program.js';
import { runTui } from '../tui/entrypoint.js';
import { runHeadless } from './runHeadless.js';

const program = createProgram({ runTui, runHeadless });
program.parseAsync(process.argv);
```

`package.json`:
```json
"bin": { "signupx": "src/cli/signupx.js" },
"dependencies": { "commander": "^11.0.0" }
```

**Step 4: Run tests**

```bash
npm test tests/CliEntrypoint.test.js
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli/signupx.js src/cli/program.js tests/CliEntrypoint.test.js package.json package-lock.json
git commit -m "feat: add signupx cli"
```

---

### Task 2: TUI entrypoint accepts config path

**Files:**
- Modify: `src/tui/entrypoint.js`
- Test: `tests/TuiEntrypoint.test.js`

**Step 1: Write failing test**

```js
import { runTui } from '../src/tui/entrypoint.js';

it('exposes runTui with configPath support', () => {
  expect(typeof runTui).toBe('function');
});
```

**Step 2: Run test to verify failure**

```bash
npm test tests/TuiEntrypoint.test.js
```
Expected: FAIL (runTui not exported).

**Step 3: Minimal implementation**

```js
import React from 'react';
import { render } from 'ink';
import App from './App.js';

export function runTui({ configPath = 'config.yaml' } = {}) {
  render(React.createElement(App, { configPath }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTui();
}
```

**Step 4: Run test**

```bash
npm test tests/TuiEntrypoint.test.js
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/tui/entrypoint.js tests/TuiEntrypoint.test.js
git commit -m "feat: allow config path in tui entrypoint"
```

---

### Task 3: Headless run config mapping for CLI

**Files:**
- Create: `src/cli/runHeadless.js`
- Create: `src/cli/runConfig.js`
- Test: `tests/CliRunConfig.test.js`

**Step 1: Write failing tests**

```js
import { buildRunEnv } from '../src/cli/runConfig.js';

it('maps config into env for headless run', () => {
  const env = buildRunEnv({
    config: { run: { headless: true, maxRunMs: 1000, stepTimeoutMs: 2000 }, identity: { otpTimeoutMs: 3000 } },
    baseEnv: { AGENTMAIL_API_KEY: 'x' }
  });

  expect(env.HEADLESS).toBe('true');
  expect(env.MAX_RUN_MS).toBe('1000');
  expect(env.STEP_TIMEOUT_MS).toBe('2000');
  expect(env.OTP_TIMEOUT_MS).toBe('3000');
});
```

**Step 2: Run test to verify failure**

```bash
npm test tests/CliRunConfig.test.js
```
Expected: FAIL (module not found).

**Step 3: Minimal implementation**

`src/cli/runConfig.js`:
```js
export function buildRunEnv({ config, baseEnv }) {
  const env = { ...baseEnv };
  if (config?.run?.headless !== undefined) env.HEADLESS = String(config.run.headless);
  if (config?.run?.maxRunMs) env.MAX_RUN_MS = String(config.run.maxRunMs);
  if (config?.run?.stepTimeoutMs) env.STEP_TIMEOUT_MS = String(config.run.stepTimeoutMs);
  if (config?.identity?.otpTimeoutMs) env.OTP_TIMEOUT_MS = String(config.identity.otpTimeoutMs);
  if (config?.identity?.email) env.SIGNUP_EMAIL = String(config.identity.email);
  return env;
}
```

`src/cli/runHeadless.js`:
```js
import { spawn } from 'node:child_process';
import { loadConfig } from '../config/manager.js';
import { buildRunEnv } from './runConfig.js';

export async function runHeadless({ configPath = 'config.yaml' } = {}) {
  const config = loadConfig(configPath);
  const env = buildRunEnv({ config, baseEnv: process.env });

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js'], { stdio: 'inherit', env });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`run failed: ${code}`))));
  });
}
```

**Step 4: Run tests**

```bash
npm test tests/CliRunConfig.test.js
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli/runHeadless.js src/cli/runConfig.js tests/CliRunConfig.test.js
git commit -m "feat: map config for headless run"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/tui.md`

**Step 1: Update docs**

Add CLI usage examples:
```
signupx tui --config config.yaml
signupx run --config config.yaml
```

**Step 2: Commit**

```bash
git add docs/tui.md
git commit -m "docs: add signupx cli usage"
```

---

### Verification

```bash
npm test tests/CliEntrypoint.test.js
npm test tests/CliRunConfig.test.js
npm test tests/TuiEntrypoint.test.js
```

---

Plan complete and saved to `docs/plans/2026-02-04-signupx-cli-packaging.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?
