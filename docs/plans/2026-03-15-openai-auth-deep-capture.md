# OpenAI / ChatGPT Deep Auth Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Node-first deep capture tool that starts mitmproxy + Chrome + CDP network capture for one manual auth flow and emits richer auth artifacts plus catalog analysis.

**Architecture:** New deep-capture modules under `src/pipeline/authTrace/deepCapture/`, a new CLI entrypoint, and a small enhancement to `launchLocalChrome.js` so Chrome can run behind a proxy with a temp profile.

**Tech Stack:** Node.js ESM, Jest, Puppeteer, child_process, JSONL artifacts, mitmproxy/mitmdump.

---

### Task 1: Extend Chrome launcher for proxy-aware deep capture
- Test: add failing tests to `tests/pipeline/authTrace/launchLocalChrome.test.js`
- Impl: support `proxyServer`, `ignoreCertificateErrors`, `userDataDir`, `extraArgs`
- Verify targeted tests

### Task 2: Add mitmproxy launcher
- Create `src/pipeline/authTrace/deepCapture/launchMitmproxy.js`
- Create `tests/pipeline/authTrace/launchMitmproxy.test.js`
- TDD process: fail, implement spawn wrapper, pass

### Task 3: Add CDP network attachment
- Create `src/pipeline/authTrace/deepCapture/attachCdpNetwork.js`
- Create `tests/pipeline/authTrace/attachCdpNetwork.test.js`
- TDD process: fail, implement JSONL writer-backed event capture, pass

### Task 4: Add deep artifact helpers + evidence merger
- Create `src/pipeline/authTrace/deepCapture/deepCaptureArtifacts.js`
- Create `src/pipeline/authTrace/deepCapture/mergeDeepEvidence.js`
- Create tests for both
- Emit redirect chains, cookie chronology, merged evidence

### Task 5: Add deep capture runner
- Create `src/pipeline/authTrace/deepCapture/runDeepAuthCapture.js`
- Create `tests/pipeline/authTrace/runDeepAuthCapture.test.js`
- TDD process: orchestrate proxy + browser + checkpoints + analyzer with injected fakes

### Task 6: Add CLI
- Create `src/cli/pipeline-auth-capture-deep.js`
- Create `tests/cli/pipelineAuthCaptureDeep.test.js`
- Parse args and delegate to runner

### Task 7: Verification
- Run focused tests for new deep-capture modules and related auth-trace tests
- Provide final command and operator instructions
