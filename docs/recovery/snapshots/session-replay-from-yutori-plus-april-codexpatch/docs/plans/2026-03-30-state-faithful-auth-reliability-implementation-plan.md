# State-Faithful Auth Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the current auth-trace, deep-capture, and browserless replay stack so the pipeline can reason about browser runtime state and app bootstrap state as first-class evidence, instead of relying only on cookies, headers, and request sequences.

**Architecture:** Keep the existing browserless pipeline, Sentinel template extraction, deep-capture tooling, and workspace onboarding logic. Add a new runtime-state evidence layer that summarizes the browser's application context at key boundaries, correlate that evidence with Cloudflare and OpenAI auth events, and use the result to classify failures and gate replay decisions. The intended outcome is higher reliability, faster diagnosis, and fewer wasted retries, not a broader or more aggressive challenge-evasion surface.

**Tech Stack:** Node.js ESM, existing Puppeteer/CDP capture code, existing Jest test suite, JSON artifact files in `artifacts/auth-traces/*`, current browserless replay modules under `src/pipeline/authTrace/`, and current operator-facing reports under `src/cli/` and `src/operatorDashboard/`.

---

## 1. Why This Plan Exists

This repository already contains a substantial amount of valuable logic for:

- browserless ChatGPT/OpenAI auth replay
- Sentinel header extraction and live-token substitution
- OTP-driven recovery branches
- workspace invite acceptance and membership materialization
- post-recovery router persistence and fail-closed verification

However, the current implementation still treats most auth reliability problems as if they can be explained by:

- missing cookies
- missing headers
- bad redirects
- weak session payloads
- obvious challenge pages

That model is incomplete.

The codebase can already see a lot of network and session data, but it cannot yet answer the most important reliability questions:

1. What exact client-side runtime state existed when the auth flow crossed from `chatgpt.com` into `auth.openai.com`?
2. What changed in the browser's application state before and after a Cloudflare or Turnstile challenge boundary?
3. Which failures happened because replay used the wrong network inputs, and which happened because the page never reached the runtime state required for the next request to be valid?
4. Which captured traces are "state-faithful enough" to be used as replay sources, and which are only partial evidence?

The current codebase is already close enough to support this improvement without a rewrite.

The best place to improve the system is not in the workspace logic. The workspace logic is already the repo's strongest area. The best place to improve the system is in the evidence model around auth-state boundaries.

This plan turns that idea into an implementation sequence.

## 2. Reader Orientation

This section is intentionally verbose. Do not skip it if you have not worked in this repo before.

### 2.1 What this repository does

At a high level, this repository is a deterministic automation pipeline for:

- creating or recovering mailbox-backed identities
- authenticating those identities with ChatGPT/OpenAI
- onboarding them into specific workspaces
- verifying that the resulting auth is durable and workspace-scoped
- persisting only healthy, refresh-bearing, verified auth into the downstream router files

The main browserless operational entrypoint is:

```bash
npm run pipeline:browserless
```

The formal pipeline overview lives in:

- `docs/pipeline.md`

The auth and replay subsystem relevant to this plan lives mainly in:

- `src/pipeline/authTrace/`
- `src/pipeline/authTrace/deepCapture/`
- `src/pipeline/authTrace/cdpLive/`

### 2.2 What the current auth evidence model already captures well

The current code already captures:

- request and response pairs from deep traces
- cookies and cookie evolution
- CDP network traffic
- basic page checkpoints
- session payloads from `/api/auth/session`
- Sentinel request templates and downstream header templates
- browserless replay steps and replay artifacts

That is already strong.

### 2.3 What the current auth evidence model does not capture well

The current code does **not** yet capture enough browser application state to explain challenge-dependent failures.

Today, the code can usually tell you:

- "Cloudflare challenge requests happened"
- "a Turnstile iframe existed"
- "a session cookie existed"
- "a Sentinel request returned a token"

But it usually cannot tell you:

- whether the page's client bootstrap completed
- whether auth-specific globals were present
- whether storage contained expected bootstrap material
- whether the page was at a stable runtime boundary before replay-worthy requests were sent
- whether a captured trace was missing app-state prerequisites that matter later

### 2.4 What this plan is trying to improve

This plan improves three things at once:

1. **Reliability**
   - The pipeline should fail less often because it is operating with a better model of what state is actually required.

2. **Efficiency**
   - The pipeline should stop retrying flows that were never at the right runtime boundary.

3. **Diagnosis quality**
   - Failures should resolve into typed, explainable categories instead of generic "Cloudflare blocked" or "callback failed".

## 3. Current-State Technical Assessment

This section anchors the plan in the code that already exists.

### 3.1 Current checkpoint model

`src/pipeline/authTrace/checkpoints.js` currently summarizes:

- URL
- title
- a small Clerk probe
- basic session payload information
- challenge markers from the DOM
- cookie names and domains

This file is useful, but it is still focused on superficial auth surface indicators.

### 3.2 Current CDP runtime capture model

`src/pipeline/authTrace/cdpLive/browserCdp.js` currently reads:

- `location.href`
- `document.title`
- `document.readyState`
- `document.referrer`
- full `localStorage`
- full `sessionStorage`

This is a good foundation, but not a strong summary.

The main problem is not that the file captures too little raw data. The main problem is that it does not normalize or label the data into an auth-reliability model.

### 3.3 Current deep-capture merge model

`src/pipeline/authTrace/deepCapture/mergeDeepEvidence.js` is extremely thin right now. It mostly returns raw grouped evidence:

- proxy flows
- CDP events
- browser trace

That means the repo stores evidence, but does not extract enough meaning from it.

### 3.4 Current Sentinel analysis model

`src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js` already extracts:

- Sentinel request templates by flow
- downstream auth header templates by request path
- required Sentinel headers for specific paths

That is exactly the right network-level abstraction.

What it lacks is a runtime-state abstraction that says:

- what page state likely existed before those headers were observed
- what storage and DOM markers were present
- whether the request only appeared after a specific bootstrap boundary

### 3.5 Current replay model

`src/pipeline/authTrace/openaiAuthReplay.js` already performs:

- blank-jar bootstrap
- authorize with login hint
- signup or login branching
- Sentinel-backed register and create-account requests
- callback completion
- final session verification

This is the code most likely to benefit from state-aware preflight checks and typed blockers.

### 3.6 Current operator report model

`src/pipeline/authTrace/agentBrowserTelemetryAnalysis.js` already reports:

- challenge request counts
- presence of Cloudflare clearance cookie
- presence of NextAuth cookies
- a bootstrap failure summary

That is a useful operator report, but it is still mostly network and cookie oriented.

## 4. Implementation Principles

These principles are mandatory for this work.

### 4.1 Do not build "anti-bot logic"

The point of this plan is:

- observability
- typed failure semantics
- replay gating
- evidence quality

The point is **not**:

- adding more aggressive evasion tactics
- expanding challenge circumvention logic
- widening the system's behavioral risk surface

### 4.2 Preserve the current business-logic strengths

Do not destabilize:

- workspace selection
- invite issuance and acceptance
- membership materialization
- refresh-bearing auth requirements
- router fail-closed registration

This plan is focused on the auth evidence layer, not on replacing the repo's onboarding rules.

### 4.3 Prefer summaries over raw dumps at decision boundaries

The repository may continue storing raw data, but decision code should use normalized summaries such as:

- page bootstrap markers present or absent
- runtime storage keys of interest present or absent
- app-state confidence level
- challenge-state confidence level
- replay readiness classification

### 4.4 Make blockers typed and actionable

Future failures should land in typed categories such as:

- `runtime-state-incomplete`
- `state-faithfulness-insufficient`
- `sentinel-template-missing-runtime-context`
- `challenge-interposed-before-bootstrap`
- `post-otp-state-mismatch`

Avoid generic buckets such as:

- `failed`
- `blocked`
- `callback-failed`

unless there is truly no better explanation.

## 5. Target End State

When this plan is complete, the auth subsystem should have the following capabilities.

### 5.1 Runtime-state summary capture

At each meaningful auth boundary, the system should be able to summarize:

- document readiness
- storage keys and selected storage values of interest
- presence of auth-bootstrapping globals
- presence of app bootstrap markers
- presence of challenge markers
- whether the page looks stable enough for replay-worthy auth requests

### 5.2 Correlated deep evidence

The deep-capture merge output should correlate:

- runtime-state snapshots
- challenge events
- cookie changes
- Sentinel requests
- auth endpoint transitions

### 5.3 Replay preflight gating

Before attempting sensitive replay steps, the system should be able to decide:

- whether the captured source trace is state-faithful enough
- whether the current live page state is consistent with the request about to be sent
- whether the replay should stop early with a typed blocker instead of wasting retries

### 5.4 Better operator reports

Reports should be able to explain:

- whether a trace failed before bootstrap completion
- whether the page reached a stable auth state
- whether a challenge happened before or after runtime initialization
- whether a replay artifact is good enough to be used as a source for future runs

## 6. Scope

### 6.1 In scope

- runtime-state summarization
- checkpoint enrichment
- CDP capture enrichment
- deep-evidence correlation
- Sentinel analysis enrichment
- replay preflight and typed blocker improvements
- operator report improvements
- test coverage for all of the above
- documentation updates for the new artifact model

### 6.2 Out of scope

- workspace onboarding redesign
- router file format redesign
- new mailbox provider work
- full browser-profile persistence redesign
- adding new challenge-evasion features
- replacing the current browserless replay architecture

## 7. Task Plan

The tasks below are ordered deliberately. Do not skip ahead. The intended sequence is:

1. establish a shared runtime-state summary layer
2. capture that state from checkpoints and CDP
3. correlate it in deep evidence
4. enrich telemetry analysis
5. gate replay with the new evidence model
6. expose the result in reports and docs

### Task 1: Introduce a reusable runtime-state summary layer

**Why this task exists:**

Right now the codebase captures some runtime facts in multiple places, but it does not have a single, shared, testable summary model for "what browser app state matters for auth reliability." That shared model must exist before the rest of the implementation can be consistent.

**Files:**
- Create: `src/pipeline/authTrace/runtimeStateSummary.js`
- Create: `tests/pipeline/authTrace/runtimeStateSummary.test.js`
- Modify: `src/pipeline/authTrace/checkpoints.js`
- Modify: `tests/pipeline/authTrace/checkpoints.test.js`

**Step 1: Write the failing unit test for runtime-state normalization**

Create `tests/pipeline/authTrace/runtimeStateSummary.test.js` with coverage for:

- empty input
- input with only URL and storage
- input with challenge markers
- input with auth/bootstrap globals
- input with noisy storage that should be summarized rather than copied blindly

The test should assert that the summary object exposes stable top-level fields such as:

- `document`
- `storage`
- `challenge`
- `bootstrap`
- `confidence`

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/runtimeStateSummary.test.js
```

Expected:

- FAIL because the module does not exist yet.

**Step 2: Implement the summary module**

Create `src/pipeline/authTrace/runtimeStateSummary.js`.

Implement small pure helpers such as:

- `summarizeStorageState(...)`
- `detectBootstrapMarkers(...)`
- `detectRuntimeChallengeMarkers(...)`
- `buildRuntimeStateSummary(...)`

The implementation should:

- avoid copying arbitrarily large raw storage values into the summary
- preserve key presence information
- detect whether likely auth/bootstrap markers exist
- emit a coarse confidence classification

Do not make this module OpenAI-specific beyond marker naming. It should be auth-runtime oriented, not site-hardcoded beyond the markers the current repo actually needs.

**Step 3: Wire the summary module into checkpoint normalization**

Modify `src/pipeline/authTrace/checkpoints.js` so `probePageCheckpoint(...)` and `normalizeCheckpoint(...)` can include a normalized runtime-state summary instead of only body-text and cookie-name level signals.

Retain the existing challenge and session summaries. Do not break downstream consumers that still expect current checkpoint fields.

**Step 4: Run focused tests**

Run:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/runtimeStateSummary.test.js \
  tests/pipeline/authTrace/checkpoints.test.js
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add \
  src/pipeline/authTrace/runtimeStateSummary.js \
  src/pipeline/authTrace/checkpoints.js \
  tests/pipeline/authTrace/runtimeStateSummary.test.js \
  tests/pipeline/authTrace/checkpoints.test.js
git commit -m "feat: add runtime state summary model for auth checkpoints"
```

### Task 2: Enrich CDP runtime capture with structured auth-state summaries

**Why this task exists:**

`browserCdp.js` already reads raw runtime values, but those values are not yet turned into a stable summary that can be compared across phases or consumed by downstream analysis.

**Files:**
- Modify: `src/pipeline/authTrace/cdpLive/browserCdp.js`
- Modify: `tests/pipeline/authTrace/browserCdp.test.js`
- Reuse: `src/pipeline/authTrace/runtimeStateSummary.js`

**Step 1: Write the failing CDP capture test**

Extend `tests/pipeline/authTrace/browserCdp.test.js` to assert that `captureBoundary(...)` returns:

- existing storage data
- normalized runtime-state summary
- bootstrap markers
- challenge markers
- confidence information

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/browserCdp.test.js
```

Expected:

- FAIL because the new runtime summary fields are not yet present.

**Step 2: Update `readRuntimeState()`**

Modify `src/pipeline/authTrace/cdpLive/browserCdp.js` so the in-page evaluation also captures:

- selected document-level markers needed for bootstrap understanding
- a compact list of known global names when present
- storage keys of interest

Do not return a giant raw global-object dump.

Keep the payload bounded and deterministic.

**Step 3: Update `captureBoundary(...)`**

Use the new shared helper from `runtimeStateSummary.js` to attach a normalized `runtimeStateSummary` field to each boundary capture.

The returned object should still preserve:

- URL
- title
- cookies
- storage

The new summary is additive.

**Step 4: Run focused tests**

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/browserCdp.test.js
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add \
  src/pipeline/authTrace/cdpLive/browserCdp.js \
  tests/pipeline/authTrace/browserCdp.test.js
git commit -m "feat: add structured runtime state summaries to cdp boundaries"
```

### Task 3: Make checkpoint analysis understand state transitions, not just cookie transitions

**Why this task exists:**

`analysis.js` currently thinks mostly in terms of cookie additions and removals. That is too weak for the new reliability model. The code should also understand meaningful runtime-state transitions.

**Files:**
- Modify: `src/pipeline/authTrace/analysis.js`
- Modify: `tests/pipeline/authTrace/analysis.test.js`

**Step 1: Write the failing analysis test**

Extend `tests/pipeline/authTrace/analysis.test.js` with coverage for a new comparison helper that can detect differences such as:

- bootstrap markers newly present
- challenge state newly present
- storage-key set changes of interest
- confidence changes across checkpoints

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/analysis.test.js
```

Expected:

- FAIL because the new comparison helper does not exist.

**Step 2: Implement runtime-state diff helpers**

Modify `src/pipeline/authTrace/analysis.js` to add helpers such as:

- `summarizeRuntimeStateDiff(prev, next)`
- `classifyBootstrapBoundary(checkpoints)`

Keep the existing cookie diff helpers intact.

The new helpers should return structured, low-cardinality outputs that are safe to store in artifacts.

**Step 3: Keep scenario inference backward compatible**

Do not rewrite the whole scenario classifier in this task. Only enrich it with additional state signals where useful. The point of this task is to add state transition understanding without destabilizing current behavior.

**Step 4: Run focused tests**

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/analysis.test.js
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add \
  src/pipeline/authTrace/analysis.js \
  tests/pipeline/authTrace/analysis.test.js
git commit -m "feat: analyze runtime state transitions across auth checkpoints"
```

### Task 4: Upgrade deep-capture merging from raw evidence bundling to correlated auth-state evidence

**Why this task exists:**

The current deep merge is almost a passthrough. That wastes the strong capture pipeline the repo already has. The system needs one correlated artifact that can answer "what state existed when this challenge or Sentinel event happened?"

**Files:**
- Modify: `src/pipeline/authTrace/deepCapture/mergeDeepEvidence.js`
- Modify: `tests/pipeline/authTrace/mergeDeepEvidence.test.js`
- Modify: `src/pipeline/authTrace/deepCapture/runDeepAuthCapture.js`
- Modify: `tests/pipeline/authTrace/runDeepAuthCapture.test.js`

**Step 1: Write the failing merge test**

Extend `tests/pipeline/authTrace/mergeDeepEvidence.test.js` to assert that the merged evidence now includes:

- a normalized timeline
- challenge-related events
- runtime-state boundary snapshots if present
- correlation between request phases and runtime-state summaries

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/mergeDeepEvidence.test.js
```

Expected:

- FAIL because `mergeDeepEvidence(...)` currently returns raw grouped arrays.

**Step 2: Implement a correlated deep merge**

Modify `src/pipeline/authTrace/deepCapture/mergeDeepEvidence.js` so it emits a structure with sections such as:

- `timeline`
- `challengeTimeline`
- `runtimeBoundaries`
- `sentinelTimeline`
- `notableTransitions`

Keep the raw grouped arrays if they are useful for backward compatibility, but add a normalized correlated representation that downstream analysis can depend on.

**Step 3: Write the failing deep-capture integration test**

Extend `tests/pipeline/authTrace/runDeepAuthCapture.test.js` so the test asserts that `runDeepAuthCapture(...)` writes and returns the richer merged evidence artifact.

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/runDeepAuthCapture.test.js
```

Expected:

- FAIL because the new artifact shape is not yet written.

**Step 4: Update `runDeepAuthCapture(...)`**

Modify `src/pipeline/authTrace/deepCapture/runDeepAuthCapture.js` to:

- consume the richer merge result
- write it to disk
- preserve existing artifacts
- avoid breaking current callers

**Step 5: Run focused tests**

Run:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/mergeDeepEvidence.test.js \
  tests/pipeline/authTrace/runDeepAuthCapture.test.js
```

Expected:

- PASS

**Step 6: Commit**

```bash
git add \
  src/pipeline/authTrace/deepCapture/mergeDeepEvidence.js \
  src/pipeline/authTrace/deepCapture/runDeepAuthCapture.js \
  tests/pipeline/authTrace/mergeDeepEvidence.test.js \
  tests/pipeline/authTrace/runDeepAuthCapture.test.js
git commit -m "feat: correlate deep auth evidence with runtime state boundaries"
```

### Task 5: Teach telemetry analysis to extract runtime-state prerequisites from golden traces

**Why this task exists:**

The repo already extracts Sentinel network templates. It now needs to extract the state context in which those templates were observed, so future replay logic can tell whether a trace is complete enough to trust.

**Files:**
- Modify: `src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js`
- Modify: `tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js`

**Step 1: Write the failing telemetry-analysis test**

Extend `tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js` to assert that the report now includes a section such as:

- `runtimePrerequisites`
- `statefulBoundaries`
- `traceFaithfulness`

The test should cover at least:

- register path prerequisites
- create-account path prerequisites
- a coarse trace-faithfulness classification

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js
```

Expected:

- FAIL because those fields do not yet exist.

**Step 2: Implement runtime prerequisite extraction**

Modify `src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js` so it can enrich the existing Sentinel report with:

- what checkpoint or boundary preceded an observed Sentinel-backed request
- whether bootstrap looked complete
- what storage or runtime markers were present, if captured
- a coarse faithfulness assessment such as:
  - `complete`
  - `partial`
  - `network-only`

Do not overfit the logic to one trace. Keep it simple and explainable.

**Step 3: Preserve the existing report shape**

The current report already powers tests and downstream code. Add new sections instead of restructuring the whole object.

**Step 4: Run focused tests**

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add \
  src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js \
  tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js
git commit -m "feat: extract runtime prerequisites from auth telemetry traces"
```

### Task 6: Add replay preflight logic that refuses low-faithfulness state before expensive replay steps

**Why this task exists:**

This is the main reliability improvement. The replay engine should stop early when the trace or live state is clearly missing the prerequisites for a high-confidence replay step. This prevents wasted OTP fetches, wasted retries, and misleading blocker reports.

**Files:**
- Create: `src/pipeline/authTrace/replayStatePreflight.js`
- Create: `tests/pipeline/authTrace/replayStatePreflight.test.js`
- Modify: `src/pipeline/authTrace/openaiAuthReplay.js`
- Modify: `tests/pipeline/authTrace/openaiAuthReplay.test.js`

**Step 1: Write the failing preflight unit test**

Create `tests/pipeline/authTrace/replayStatePreflight.test.js` covering:

- complete trace faithfulness
- network-only trace without state prerequisites
- challenge-interposed-before-bootstrap
- signup step allowed only after sufficient runtime state

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/replayStatePreflight.test.js
```

Expected:

- FAIL because the preflight module does not exist.

**Step 2: Implement the preflight helper**

Create `src/pipeline/authTrace/replayStatePreflight.js`.

Implement helpers such as:

- `assessReplayReadiness(...)`
- `assertReplayReadyForStep(...)`
- `buildReplayBlocker(...)`

The output should be deterministic and typed.

**Step 3: Extend replay tests first**

Modify `tests/pipeline/authTrace/openaiAuthReplay.test.js` to cover:

- replay refusing a low-faithfulness signup trace
- replay returning a typed blocker before register or create-account
- replay still succeeding when the enriched prerequisites are satisfied

Run:

```bash
npm test -- --runTestsByPath tests/pipeline/authTrace/openaiAuthReplay.test.js
```

Expected:

- FAIL because replay does not yet call the preflight helper.

**Step 4: Integrate preflight into replay**

Modify `src/pipeline/authTrace/openaiAuthReplay.js` so the signup branch:

- computes replay readiness from the analysis report
- checks readiness before `user_register`
- checks readiness again before `create_account` if the post-OTP state is inconsistent
- returns a typed blocker if prerequisites are not satisfied

Do not add a giant rule engine. Keep the logic narrow and evidence-based.

**Step 5: Preserve existing successful flows**

Existing tests for healthy replay paths must still pass.

Do not regress:

- existing-login OTP
- password-login branches
- successful signup replay when prerequisites are present

**Step 6: Run focused tests**

Run:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/replayStatePreflight.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js
```

Expected:

- PASS

**Step 7: Commit**

```bash
git add \
  src/pipeline/authTrace/replayStatePreflight.js \
  src/pipeline/authTrace/openaiAuthReplay.js \
  tests/pipeline/authTrace/replayStatePreflight.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js
git commit -m "feat: gate auth replay on runtime state faithfulness"
```

### Task 7: Upgrade agent-browser telemetry reporting to explain state-related failure modes

**Why this task exists:**

The operator-facing report is currently too shallow. It should explain whether the browser reached a stable auth/bootstrap boundary before challenge or failure, because that is the operational question humans actually need answered.

**Files:**
- Modify: `src/pipeline/authTrace/agentBrowserTelemetryAnalysis.js`
- Modify: `tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js`
- Modify: `src/pipeline/authTrace/cdpLive/bootstrapAnalysis.js`
- Modify: `tests/pipeline/authTrace/bootstrapAnalysis.test.js`

**Step 1: Write the failing report-analysis tests**

Extend:

- `tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js`
- `tests/pipeline/authTrace/bootstrapAnalysis.test.js`

Add assertions for fields such as:

- `bootstrapState`
- `runtimeStateConfidence`
- `challengeBeforeBootstrap`
- `stateFaithfulnessAssessment`

Run:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/bootstrapAnalysis.test.js
```

Expected:

- FAIL because those report fields do not yet exist.

**Step 2: Enrich bootstrap analysis**

Modify `src/pipeline/authTrace/cdpLive/bootstrapAnalysis.js` to reason about:

- whether bootstrap likely completed
- whether challenge likely happened before bootstrap completion
- whether the restart or failure happened after a stable state

Keep the function small. It should remain a summary helper, not a full replay classifier.

**Step 3: Enrich agent-browser telemetry analysis**

Modify `src/pipeline/authTrace/agentBrowserTelemetryAnalysis.js` so the report includes:

- state-related bootstrap interpretation
- coarse faithfulness assessment
- more precise explanation of why the run is or is not a good replay source

**Step 4: Run focused tests**

Run:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/bootstrapAnalysis.test.js
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add \
  src/pipeline/authTrace/agentBrowserTelemetryAnalysis.js \
  src/pipeline/authTrace/cdpLive/bootstrapAnalysis.js \
  tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/bootstrapAnalysis.test.js
git commit -m "feat: explain auth bootstrap failures with runtime state analysis"
```

### Task 8: Document the new artifact model and update the operator-facing workflow

**Why this task exists:**

Once the code lands, future operators and implementers need to know how to read the new evidence. Without docs, the feature will exist but the team will not trust or use it correctly.

**Files:**
- Modify: `docs/pipeline.md`
- Create: `docs/2026-03-30-state-faithful-auth-reliability-runbook.md`
- Optionally modify: `src/cli/pipeline-auth-openai-report.js`
- Optionally modify: `tests/cli/pipelineAuthOpenaiReport.test.js`

**Step 1: Write the failing CLI/report test if the CLI is updated**

If you choose to expose the new state-faithfulness fields through an existing CLI report, first add the failing test in:

- `tests/cli/pipelineAuthOpenaiReport.test.js`

Run:

```bash
npm test -- --runTestsByPath tests/cli/pipelineAuthOpenaiReport.test.js
```

Expected:

- FAIL if the CLI output is being extended.

If the CLI is not changed in this task, skip this test step and document only.

**Step 2: Update the main pipeline docs**

Modify `docs/pipeline.md` to explain:

- what a runtime-state summary is
- what a state-faithful trace means
- how the replay engine now refuses low-faithfulness conditions
- how this changes debugging expectations

**Step 3: Add a dedicated runbook**

Create `docs/2026-03-30-state-faithful-auth-reliability-runbook.md`.

This runbook should explain, in plain technical language:

- what artifacts are produced
- which JSON files to inspect
- what typed blockers mean
- how to tell whether a trace is usable for replay
- how to interpret challenge-before-bootstrap versus post-bootstrap failures

**Step 4: Update the CLI if needed**

If the operator workflow benefits from a richer report surface, modify:

- `src/cli/pipeline-auth-openai-report.js`

Only do this if the new evidence is otherwise too buried to be useful.

**Step 5: Run focused verification**

Run:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/runtimeStateSummary.test.js \
  tests/pipeline/authTrace/checkpoints.test.js \
  tests/pipeline/authTrace/browserCdp.test.js \
  tests/pipeline/authTrace/analysis.test.js \
  tests/pipeline/authTrace/mergeDeepEvidence.test.js \
  tests/pipeline/authTrace/runDeepAuthCapture.test.js \
  tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/replayStatePreflight.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js \
  tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/bootstrapAnalysis.test.js
```

If the CLI was changed, also run:

```bash
npm test -- --runTestsByPath tests/cli/pipelineAuthOpenaiReport.test.js
```

Expected:

- PASS

**Step 6: Commit**

```bash
git add \
  docs/pipeline.md \
  docs/2026-03-30-state-faithful-auth-reliability-runbook.md \
  src/cli/pipeline-auth-openai-report.js \
  tests/cli/pipelineAuthOpenaiReport.test.js
git commit -m "docs: add state-faithful auth reliability runbook"
```

## 8. Full Verification Suite

After all tasks are complete, run the broader auth-trace suite.

Run:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/analysis.test.js \
  tests/pipeline/authTrace/bootstrapAnalysis.test.js \
  tests/pipeline/authTrace/browserCdp.test.js \
  tests/pipeline/authTrace/checkpoints.test.js \
  tests/pipeline/authTrace/mergeDeepEvidence.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js \
  tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/runDeepAuthCapture.test.js \
  tests/pipeline/authTrace/runtimeStateSummary.test.js \
  tests/pipeline/authTrace/replayStatePreflight.test.js
```

Then run the broad auth-trace regression slice:

```bash
npm test -- --runTestsByPath \
  tests/pipeline/authTrace/agentBrowserTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/analysis.test.js \
  tests/pipeline/authTrace/browserlessBootstrapReplay.test.js \
  tests/pipeline/authTrace/checkpoints.test.js \
  tests/pipeline/authTrace/cookieEvolution.test.js \
  tests/pipeline/authTrace/httpCookies.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js \
  tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js \
  tests/pipeline/authTrace/openaiAuthTelemetryAnalysis.test.js \
  tests/pipeline/authTrace/openaiSentinelProvider.test.js \
  tests/pipeline/authTrace/recoverBrowserlessIdentity.test.js \
  tests/pipeline/authTrace/runAuthTrace.test.js \
  tests/pipeline/authTrace/runCatalogAnalysis.test.js \
  tests/pipeline/authTrace/runDeepAuthCapture.test.js
```

Expected:

- PASS

## 9. Risks and Failure Modes

This section exists so the implementer does not accidentally ship a "smart-looking" but low-value abstraction.

### 9.1 Risk: runtime summary becomes a raw dump

Bad version:

- dumping giant storage objects
- dumping huge DOM fragments
- dumping arbitrary global objects

Good version:

- bounded, explainable summaries
- marker presence
- key presence
- confidence labels
- small structured evidence

### 9.2 Risk: preflight logic becomes an overfit rules engine

Bad version:

- dozens of site-specific one-off conditions
- hardcoded assumptions from one trace
- brittle branch logic that fails whenever upstream UX shifts

Good version:

- narrow checks tied to observed prerequisites
- typed blockers
- additive evidence model
- easy-to-read decision path

### 9.3 Risk: backward compatibility regressions

The new fields should be additive wherever possible.

Avoid:

- changing existing checkpoint object shapes destructively
- removing existing fields that downstream tools already consume
- renaming current artifact files without migration

### 9.4 Risk: replay becomes stricter than necessary

The new gating should stop obviously low-faithfulness runs.

It should not:

- reject every imperfect trace
- force a perfect bootstrap classification before any branch can run

Prefer coarse but useful confidence levels over rigid absolutes.

## 10. Acceptance Criteria

This plan is complete only when all of the following are true:

1. A shared runtime-state summary module exists and is covered by tests.
2. Checkpoints and CDP boundary captures expose normalized runtime-state summaries.
3. Deep-capture merge artifacts correlate runtime boundaries with challenge and Sentinel events.
4. Telemetry analysis reports runtime prerequisites and a trace-faithfulness assessment.
5. Replay can return typed blockers for low-faithfulness state before expensive signup steps.
6. Operator-facing analysis can explain challenge-before-bootstrap versus post-bootstrap failure.
7. All new tests pass.
8. Existing healthy replay and recovery tests still pass.
9. Documentation explains how to interpret the new artifact model.

## 11. Suggested Commit Order

The intended commit order is:

1. `feat: add runtime state summary model for auth checkpoints`
2. `feat: add structured runtime state summaries to cdp boundaries`
3. `feat: analyze runtime state transitions across auth checkpoints`
4. `feat: correlate deep auth evidence with runtime state boundaries`
5. `feat: extract runtime prerequisites from auth telemetry traces`
6. `feat: gate auth replay on runtime state faithfulness`
7. `feat: explain auth bootstrap failures with runtime state analysis`
8. `docs: add state-faithful auth reliability runbook`

## 12. Final Guidance For The Implementer

If you are implementing this plan:

- do not start by touching `openaiAuthReplay.js`
- build the evidence model first
- keep all new logic small and testable
- prefer additive object fields over invasive reshapes
- preserve the repo's current fail-closed posture
- optimize for diagnosis quality and determinism

The codebase already has strong auth and workspace business logic.

The missing piece is not more power. The missing piece is better state understanding.