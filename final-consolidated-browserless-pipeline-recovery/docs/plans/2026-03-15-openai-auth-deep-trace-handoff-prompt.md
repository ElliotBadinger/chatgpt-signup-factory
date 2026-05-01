# Stateless Agent Handoff Prompt: OpenAI / ChatGPT Deep Auth Trace

You are a stateless coding agent working in:
`/home/epistemophile/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone`

Your mission is to build the next-generation deep auth tracer that captures the OpenAI / ChatGPT auth flow at the backend transaction level so that the flow can later be replayed **without a browser** if possible.

## Read first
1. `docs/plans/2026-03-15-openai-auth-deep-trace-handoff.md`
2. `docs/plans/2026-03-15-openai-auth-tracer-design.md`
3. `docs/plans/2026-03-15-openai-auth-tracer.md`
4. `src/pipeline/authTrace/`
5. Artifact set:
   - `artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2/`

## Non-goal
Do **not** optimize browser UI automation as the end state.
The browser is only a capture instrument unless proven otherwise.

## Goal
Produce tooling and artifacts that answer:
- what exact internal endpoints participate in auth/session establishment?
- what cookies and redirects are required?
- which parts are replayable directly?
- which parts are browser-bound?
- can we build a browserless or nearly-browserless auth driver afterward?

## Existing evidence you must assume as true
- `deep-golden-signup-v2` is a real `signup-new` flow.
- `analysis.json` there says:
  - `actualScenario: signup-new`
  - `replayability.classification: browser-bootstrap-only`
- `auth.openai.com/create-account/password` is a real observed step.
- final ChatGPT auth state includes:
  - `accessToken` in `/api/auth/session`
  - `__Secure-next-auth.session-token`
  - `oai-client-auth-info`
- checkpoint names are noisy if operator timing was imperfect; trust actual URLs/cookies/requests more.

## Build next
Prioritize backend graph extraction.

### Required deliverables
- `endpoint-catalog.json`
- `flow-sequence.json`
- `cookie-evolution.json`
- `replay-candidates.json`
- improved `analysis.json`

### For each auth-critical endpoint record
- method
- full URL
- normalized path
- query param keys
- request headers
- sent cookies
- request body raw/redacted
- request JSON schema if applicable
- response status
- response headers
- redirect location
- set-cookie delta
- response body raw/redacted
- response JSON schema if applicable
- auth-critical yes/no
- replay candidate classification

### Replay classification buckets
- replayable directly
- replayable with dynamic cookie/csrf extraction
- browser-bound / challenge-bound

## Preferred approach
Use a superior instrument:
- real Chrome only as source of truth
- proxy-backed and/or CDP-backed deep network capture
- artifact-first backend analysis

## First milestone
Using the already-captured `requests/*.json` and `responses/*.json`, generate a normalized endpoint catalog and replay candidate report.

## Definition of success
The work is successful only if it materially advances the ability to replace browser-driven auth with direct backend replay where possible.
