# OpenAI Signup Sentinel Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the browserless `signup-new` replay path to create a brand-new OpenAI/ChatGPT account end-to-end using live sentinel headers, fresh AgentMail OTP, and final ChatGPT session verification.

**Architecture:** Reuse the proven golden trace as the source of sentinel request/header templates, add a dedicated sentinel provider that swaps in live sentinel response tokens, then extend `openaiAuthReplay.js` to execute the entire signup branch with deterministic step artifacts and latency accounting. Add a tiny AgentMail inbox provisioning helper so final live verification uses a truly new inbox.

**Tech Stack:** Node.js ESM, Jest, fetch, existing authTrace helpers, AgentMail REST API.

---

### Task 1: Add failing analysis tests for sentinel template extraction

**Files:**
- Modify: `tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js`
- Modify: `src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js`

**Step 1: Write the failing test**

Assert that analyzed telemetry includes per-flow sentinel request/header templates with enough information to build live headers for:
- `username_password_create`
- `oauth_create_account`

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js --runInBand`

Expected: FAIL because sentinel templates are not yet emitted.

**Step 3: Write minimal implementation**

Update analysis output to include:
- sentinel request templates by flow
- downstream header templates by path/header name

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

**Step 5: Commit**

```bash
git add tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js
git commit -m "test: extract sentinel templates from openai auth telemetry"
```

### Task 2: Add failing tests for the live sentinel provider

**Files:**
- Create: `tests/pipeline/authTrace/openaiSentinelProvider.test.js`
- Create: `src/pipeline/authTrace/openaiSentinelProvider.js`

**Step 1: Write the failing test**

Cover:
- building a sentinel request from trace-derived template data
- calling live sentinel endpoint
- returning `openai-sentinel-token` and `openai-sentinel-so-token` with live `c` token substituted

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' tests/pipeline/authTrace/openaiSentinelProvider.test.js --runInBand`

Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Implement:
- `createOpenAiSentinelProvider(...)`
- helper(s) to merge live sentinel response into trace-derived header JSON

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

**Step 5: Commit**

```bash
git add tests/pipeline/authTrace/openaiSentinelProvider.test.js src/pipeline/authTrace/openaiSentinelProvider.js
git commit -m "feat: add live openai sentinel provider"
```

### Task 3: Add failing signup replay tests

**Files:**
- Modify: `tests/pipeline/authTrace/openaiAuthReplay.test.js`
- Modify: `src/pipeline/authTrace/openaiAuthReplay.js`

**Step 1: Write the failing test**

Add a full mocked `signup-new` flow asserting:
- authorize redirects to `/create-account/password`
- live sentinel headers are attached to register and create_account
- OTP send/validate succeeds
- callback + session succeed
- replay verdict is `authenticated`
- branch is `signup-new`
- latency summary is present

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' tests/pipeline/authTrace/openaiAuthReplay.test.js --runInBand`

Expected: FAIL because signup branch still returns a sentinel placeholder verdict.

**Step 3: Write minimal implementation**

Extend replay logic to execute:
- load create-account/password
- register with live sentinel token header
- email OTP send
- OTP validate
- load about-you
- create_account with live sentinel headers
- ChatGPT callback
- session verification
- latency capture

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

**Step 5: Commit**

```bash
git add tests/pipeline/authTrace/openaiAuthReplay.test.js src/pipeline/authTrace/openaiAuthReplay.js
git commit -m "feat: replay browserless openai signup with live sentinel"
```

### Task 4: Add failing tests for new inbox provisioning helper

**Files:**
- Create: `tests/pipeline/authTrace/agentMailInboxProvisioning.test.js`
- Create: `src/pipeline/authTrace/agentMailInboxProvisioning.js`

**Step 1: Write the failing test**

Cover:
- creating an AgentMail inbox with a root API key
- returning the created inbox address and metadata
- rejecting on non-200 response

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' tests/pipeline/authTrace/agentMailInboxProvisioning.test.js --runInBand`

Expected: FAIL because the helper does not exist.

**Step 3: Write minimal implementation**

Implement a small helper that POSTs to `https://api.agentmail.to/v0/inboxes` and returns a normalized record.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

**Step 5: Commit**

```bash
git add tests/pipeline/authTrace/agentMailInboxProvisioning.test.js src/pipeline/authTrace/agentMailInboxProvisioning.js
git commit -m "feat: add agentmail inbox provisioning helper for signup e2e"
```

### Task 5: Add CLI support for signup replay artifacts and latency

**Files:**
- Modify: `src/cli/pipeline-auth-openai-replay.js`
- Modify: `tests/cli/pipelineAuthOpenaiReplay.test.js`

**Step 1: Write the failing test**

Add parser coverage for any new flags needed for fresh signup replay, such as:
- `--sentinel-trace-dir`
- `--pool-path`
- `--root-api-key`
- `--new-inbox`

Only add flags actually needed by the implementation.

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' tests/cli/pipelineAuthOpenaiReplay.test.js --runInBand`

Expected: FAIL because parser does not expose the new fields.

**Step 3: Write minimal implementation**

Update the CLI parser and artifact writer to include:
- replay summary
- end-to-end latency
- optional new inbox metadata

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

**Step 5: Commit**

```bash
git add tests/cli/pipelineAuthOpenaiReplay.test.js src/cli/pipeline-auth-openai-replay.js
git commit -m "feat: extend openai replay cli for signup e2e evidence"
```

### Task 6: Run focused verification suite

**Files:**
- No code changes required unless failures appear

**Step 1: Run focused suite**

Run:
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' \
  tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/openaiSentinelProvider.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js \
  tests/pipeline/authTrace/agentMailInboxProvisioning.test.js \
  tests/cli/pipelineAuthOpenaiReplay.test.js \
  --runInBand
```

Expected: PASS.

### Task 7: Run broader auth-trace verification suite

**Files:**
- No code changes required unless failures appear

**Step 1: Run broader suite**

Run:
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' \
  tests/pipeline/authTrace \
  tests/cli/pipelineAuthTrace.test.js \
  tests/cli/pipelineAuthCatalog.test.js \
  tests/cli/pipelineAuthAgentBrowserReport.test.js \
  tests/cli/pipelineAuthBootstrapReplay.test.js \
  tests/cli/pipelineAuthOpenaiReport.test.js \
  tests/cli/pipelineAuthOpenaiReplay.test.js \
  --runInBand
```

Expected: PASS.

### Task 8: Fresh live signup replay with a brand-new AgentMail inbox

**Files:**
- Possibly create artifact dir under `artifacts/auth-replays/`

**Step 1: Provision a brand-new inbox**

Use a root API key from `~/.pi/agent/codex-inbox-pool.json` to create a fresh AgentMail inbox.

**Step 2: Run fresh live signup replay**

Run the replay CLI against that new inbox in signup mode and save artifacts under a timestamped directory.

**Step 3: Record evidence**

Write:
- `new-inbox.json`
- `signup-e2e-summary.json`

Include:
- inbox address
- start/end timestamps
- total duration ms
- branch
- verdict
- final session summary

**Step 4: Verify result**

Confirm from fresh artifact output that:
- branch = `signup-new`
- verdict = `authenticated`
- final session `hasAccessToken = true`
- final session email matches the new inbox

### Task 9: Final completion verification

**Files:**
- No code changes unless failures appear

**Step 1: Re-run the exact broader verification command from Task 7**

Expected: PASS.

**Step 2: Re-read the fresh live artifact summary**

Expected evidence:
- new inbox used
- end-to-end latency recorded
- final authenticated ChatGPT session proven

**Step 3: Prepare final report**

Summarize:
- code/tests added
- verification commands run
- fresh artifact paths
- measured end-to-end latency
- final authenticated session evidence
