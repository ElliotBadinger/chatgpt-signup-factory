# Agent-browser auth telemetry analysis and browserless bootstrap replay

## Goal

Turn ad-hoc `agent-browser` auth telemetry runs into deterministic evidence, then use that evidence to replay the ChatGPT bootstrap path outside a real browser.

## Scope

1. Analyze an `agent-browser` telemetry directory and emit stable machine-readable outputs.
2. Extract the minimal cookie/header/endpoint sequence needed for browserless replay.
3. Replay that sequence with Node `fetch`, preserving cookies across steps.
4. Capture where browserless replay succeeds and where it still falls back to OpenAI login.

## Outputs

For each telemetry run directory:

- `agent-browser-report.json`
- `browserless-bootstrap-plan.json`
- `browserless-bootstrap-replay.json`

## Design

### Analyzer

Input files:
- `critical-requests.jsonl`
- `recorder-summary.json`
- `url-history.txt` when present

Derived facts:
- whether `chatgpt.com/auth/login_with` loaded
- whether Cloudflare challenge requests ran
- whether `cf_clearance` was issued
- whether next-auth CSRF/state cookies were issued
- whether ChatGPT restarted signin
- the browserless replay sequence and initial cookie jar

### Replay harness

The replay harness consumes `browserless-bootstrap-plan.json` and executes:

1. `GET /auth/login_with`
2. `GET /api/auth/providers`
3. `GET /api/auth/csrf`
4. `POST /api/auth/signin/openai`
5. `GET` the authorize URL returned by step 4

Important details:
- cookie jar is updated from every `Set-Cookie`
- CSRF token is refreshed from the live `/api/auth/csrf` response
- the authorize URL is taken from the live signin JSON response, not from stale captured state
- replay records response status, selected headers, JSON, and text preview

## Success criteria

- Re-running the analyzer on the same telemetry dir produces the same report/plan structure.
- Browserless replay proves which ChatGPT bootstrap steps are browserless-compatible.
- Artifacts explicitly show the current remaining blocker if full login still cannot complete.

## Current interpretation

The browserless replay path now reproduces:
- `login_with` HTML load
- Cloudflare-cleared cookie state reuse
- next-auth providers/csrf/signin sequence
- issuance of a fresh authorize URL from ChatGPT
- OpenAI authorize redirect to `https://auth.openai.com/log-in`

This means the ChatGPT-side bootstrap is partially replayable outside the browser, but the OpenAI auth continuation still falls back to login in the current replay state.
