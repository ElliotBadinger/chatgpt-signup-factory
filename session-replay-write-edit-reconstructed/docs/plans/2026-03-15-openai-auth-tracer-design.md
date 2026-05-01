# OpenAI Auth Tracer Design

**Date:** 2026-03-15
**Status:** Approved
**Scope:** Discovery tooling for reverse-engineering ChatGPT/OpenAI/Clerk auth flows

## Objective

Build a forensic auth tracer for `auth.openai.com` and `chatgpt.com` that runs in local real Chrome + Xvfb, captures the full request/state timeline for signup/login/session establishment, and produces artifacts that support an API-first reimplementation.

This tracer is not the new production pipeline. It is a discovery tool used to answer:

1. What exact request sequence creates or resumes a ChatGPT session?
2. Where does Clerk state end and ChatGPT session exchange begin?
3. What cookies, tokens, and redirects occur at each step?
4. Why does the `create-account/password` step stall?
5. Which steps are replayable without frontend automation?

## Scope

### In scope
- Real Chrome tracing under local Xvfb
- Navigation timeline capture across `chatgpt.com`, `auth.openai.com`, Clerk-related domains, and Cloudflare challenge domains
- Request/response metadata capture for relevant domains
- Checkpoints with URL, title, DOM markers, cookies, Clerk summary, and ChatGPT session summary
- Screenshots at named checkpoints
- Support for both `signin-existing` and `signup-new` auth scenarios
- Manual, assisted, and observe-existing tracing modes
- Artifact persistence for later diffing and analysis

### Out of scope
- Solving Turnstile automatically
- Replacing the production rotation pipeline in this phase
- Registering aliases into router/auth files
- Scaling to 8 concurrent account creations
- Full API replay implementation in this phase

## Architecture

### 1. AuthTraceRunner
CLI entrypoint that:
- launches/attaches to local Chrome
- creates a fresh run directory
- sets trace configuration
- drives checkpoint recording
- writes summary artifacts

### 2. ChromeTraceSession
Wraps Puppeteer real Chrome and records:
- requests
- responses
- request failures
- frame navigations
- console output
- page errors

### 3. CheckpointRecorder
Captures named milestones such as:
- `landing`
- `auth-page-loaded`
- `email-submitted`
- `otp-page`
- `otp-submitted`
- `password-page`
- `password-submitted`
- `chatgpt-home`
- `invite-accepted`
- `session-established`

Each checkpoint stores:
- URL
- title
- visible auth/challenge markers
- hidden challenge markers
- Clerk summary
- session summary
- selected cookies

### 4. ArtifactWriter
Writes:
- `summary.json`
- `trace.jsonl`
- `checkpoints/*.json`
- `screenshots/*.png`
- optional filtered request/response bodies

### 5. ClerkProbe
Observational probe for:
- `window.Clerk` existence and loaded state
- exposed client/signUp/signIn/session fields
- high-level status markers only

## Artifact Layout

Run directory:

`artifacts/auth-traces/YYYY-MM-DD/<timestamp>-<label>/`

Files:
- `summary.json`
- `trace.jsonl`
- `checkpoints/<name>.json`
- `screenshots/<name>.png`
- optional `requests/<id>.json` and `responses/<id>.json`

## Redaction Policy

Redact or hash:
- OTP values
- access/refresh tokens
- raw cookie values
- sensitive bearer headers
- optionally invite links and email local parts

Preserve:
- endpoint paths
- header presence
- token/cookie names
- response status codes
- schema keys
- request body shapes

## Execution Modes

### manual
Tracer opens the page and records while the operator performs the flow.

### assisted
Tracer performs low-risk setup/navigation and pauses for the operator at sensitive steps.

### observe-existing
Tracer attaches to or launches an already-useful session/profile and records only.

## Learning Goals

The first 1–2 runs should answer:
1. The exact request graph for signup and sign-in
2. Where ChatGPT session creation actually happens
3. Why `create-account/password` stalls
4. Whether post-password transitions are replayable via direct HTTP
5. What minimum browser dependence remains

## Architectural Decision Framework

After traces, classify the auth flow as:

### A. Fully replayable
All meaningful transitions can be reproduced with direct requests.

### B. Browser bootstrap + API continuation
An early step requires browser execution, but the remaining flow is replayable.

### C. Browser required to completion
Auth remains browser-bound through the end.

## Target End State

### Ideal
Zero browser in the steady-state pipeline:
- create/verify account via direct Clerk/OpenAI requests
- exchange into ChatGPT session directly
- accept workspace invite via backend API
- store auth without UI automation

### Acceptable fallback
Use remote browser only for the irreducibly browser-bound bootstrap step, ideally on GCloud/OCI and connected to locally when needed.

## Scenario Coverage

Each run should declare and later infer an auth scenario:
- `signin-existing`
- `signup-new`
- `unknown-auto`

The summary should state which branch actually occurred and where divergence happened.

## Recommended Implementation Sequence

1. Build artifact and trace event writers
2. Build checkpoint recorder and Clerk probe
3. Build real-Chrome trace runner CLI for manual mode
4. Add assisted/manual prompts and run summaries
5. Use first traces to design API-first replay
