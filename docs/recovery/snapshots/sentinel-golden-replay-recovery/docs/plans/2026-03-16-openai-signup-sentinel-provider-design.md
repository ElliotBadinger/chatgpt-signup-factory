# OpenAI Signup Sentinel Provider Design

## Goal

Enable the `signup-new` branch of the browserless OpenAI/ChatGPT auth replay to complete end-to-end for a truly new AgentMail inbox, producing a final authenticated ChatGPT session with fresh evidence.

## Context

Stage B already proves the `existing-login-otp` path can be replayed browserlessly from a blank ChatGPT bootstrap through final `chatgpt.com/api/auth/session`. The remaining gap is the `signup-new` branch, where OpenAI requires dynamic sentinel headers on:

- `POST /api/accounts/user/register`
- `POST /api/accounts/create_account`

The golden trace already contains:

- live request/response pairs for both sentinel flows
- the exact header shapes used by the browser
- successful downstream register → OTP → about-you → create-account → callback transitions

## Recommended approach

Use a hybrid trace-derived sentinel provider.

### Why this approach

A full reimplementation of OpenAI’s sentinel header synthesis would be slow and speculative. The trace already gives us the proven request and header templates. The only dynamic value that clearly must be live is the sentinel response token `c`, returned by:

- `POST https://sentinel.openai.com/backend-api/sentinel/req`

So the fastest deterministic path is:

1. extract proven per-flow sentinel request/header templates from the golden trace
2. call sentinel live for the needed flow
3. inject the live token into the proven header templates
4. replay the rest of the signup flow browserlessly

## Architecture

### 1. Telemetry analysis emits reusable sentinel templates

`src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js` should enrich the report/plan with:

- sentinel request templates per flow:
  - `username_password_create`
  - `oauth_create_account`
- sentinel header templates used downstream:
  - `openai-sentinel-token`
  - `openai-sentinel-so-token`
- the exact request body/header JSON structure captured in the golden trace

This keeps the replay logic deterministic and grounded in captured evidence.

### 2. New sentinel provider module

Add `src/pipeline/authTrace/openaiSentinelProvider.js`.

Responsibilities:

- accept analyzed trace data and a fetch implementation
- issue live sentinel requests for the required flow
- build downstream auth headers by combining:
  - trace-derived template JSON
  - live sentinel token from the response
- return ready-to-send headers for:
  - register
  - create_account

The provider must be pure enough to unit test with mocked fetch.

### 3. Signup replay branch in `openaiAuthReplay.js`

Extend the current `signup-new` branch from placeholder to full replay:

1. ChatGPT bootstrap
2. authorize with `login_hint`
3. load create-account/password
4. live sentinel for `username_password_create`
5. `user/register`
6. OTP send redirect
7. poll AgentMail OTP
8. `email-otp/validate`
9. load about-you
10. live sentinel for `oauth_create_account`
11. `create_account`
12. ChatGPT callback
13. callback redirect if present
14. final `chatgpt.com/api/auth/session`

### 4. Fresh new inbox provisioning for end-to-end validation

For fresh evidence, add a small utility/CLI-level workflow to create a brand-new AgentMail inbox via the root API key. The live validation run must use a newly created inbox, not an already known address.

Store evidence showing:

- inbox address used
- provisioning timestamp
- full replay artifact path
- end-to-end duration in milliseconds
- final session summary (`hasAccessToken`, email, accountId)

## Error handling

The replay should fail loudly with structured verdicts when:

- sentinel request fails
- sentinel header generation fails
- register or create_account returns non-200
- OTP does not arrive
- callback does not establish a ChatGPT session

Artifacts should preserve enough step history to debug failures without re-running blindly.

## Testing strategy

### Unit tests first

Add failing tests for:

- sentinel template extraction from trace analysis
- sentinel provider header generation from live response token
- full `signup-new` replay with mocked fetch + mocked OTP provider
- CLI arg parsing for any new flags used by live validation

### Fresh live verification

Run:

1. focused unit tests for new modules
2. broader auth trace / CLI suite
3. fresh signup replay against a brand-new AgentMail inbox

Success condition:

- replay verdict is `authenticated`
- branch is `signup-new`
- final session has `accessToken`
- final session email matches the newly created inbox
- artifact records total end-to-end latency

## Output artifacts

The final live run should emit an artifact directory containing at least:

- `openai-auth-report.json`
- `openai-auth-plan.json`
- `openai-auth-replay.json`
- `new-inbox.json`
- `signup-e2e-summary.json`

## Non-goals

- fully reverse-engineering sentinel crypto beyond what is needed for deterministic replay
- replacing the trace-derived approach with a generalized from-scratch sentinel SDK
- browser automation for the signup flow
