# OpenAI / ChatGPT Auth Endpoint Cataloger — Design

**Date:** 2026-03-15  
**Status:** Approved  
**Scope:** Offline artifact analyzer that turns captured auth trace artifacts into a normalized backend endpoint map and replayability assessment.

---

## Objective

Produce tooling and artifacts that answer, with evidence:

1. What exact internal endpoints participate in auth/session establishment?
2. What cookies, redirects, CSRF/state values, and token exchanges are required?
3. Which steps are replayable directly via HTTP?
4. Which steps are replayable with dynamic cookie/csrf extraction?
5. Which steps are browser-bound or challenge-bound?
6. Can we build a browserless or nearly-browserless auth driver afterward?

---

## Scope

### In scope
- Pure offline analysis of an existing trace directory
- Endpoint catalog generation with normalized method/path/schema
- Flow sequence with timestamp ordering and auth-critical flagging
- Cookie evolution across auth phases
- Replayability classification per endpoint
- Upgraded `analysis.json` answering the six key questions
- CLI entrypoint: `pipeline-auth-catalog`
- Integration with tracer (Phase B): auto-emit catalog after every capture run

### Out of scope (this phase)
- New browser capture or proxy instrumentation
- Selector fixes or checkpoint choreography
- Scaling or concurrent account creation

---

## Architecture

Two phases:

### Phase A — Standalone offline analyzer
New pure-analysis modules under `src/pipeline/authTrace/`:

| Module | Responsibility |
|---|---|
| `traceArtifactLoader.js` | Load and order request/response pairs + cookie-diffs + checkpoints |
| `endpointCatalog.js` | Normalize, deduplicate, and enrich endpoint entries |
| `flowSequence.js` | Produce ordered auth-relevant transaction timeline |
| `cookieEvolution.js` | Track cookie appearance/removal across auth phases |
| `replayCandidates.js` | Classify each endpoint into a replay bucket |
| `analysis.js` (upgrade) | Answer the six key questions from catalog + evolution data |

New CLI: `src/cli/pipeline-auth-catalog.js`

Output artifacts written alongside existing trace artifacts:
- `endpoint-catalog.json`
- `flow-sequence.json`
- `cookie-evolution.json`
- `replay-candidates.json`
- `analysis.json` (upgraded, replacing existing)

### Phase B — Tracer integration
Wire `pipeline-auth-catalog` analysis into the end of every `runAuthTrace` run automatically.

---

## Data Flow

```
trace dir
   ├── requests/request-N.json   ──┐
   ├── responses/response-N.json ──┤→ traceArtifactLoader → ordered pairs
   ├── cookie-diffs/*.json        ──┘        │
   └── checkpoints/*.json ─────────────────→─┤
                                             ↓
                                    endpointCatalog
                                    (one entry per unique method+path template)
                                             │
                                    flowSequence
                                    (entries in timestamp order, auth-critical flagged)
                                             │
                                    cookieEvolution
                                    (cookie lifecycle across phases)
                                             │
                                    replayCandidates
                                    (classification per endpoint)
                                             │
                                    upgraded analysis.json
                                    (answers the key questions)
```

Key rules:
- Request/response pairs matched by url + sequential id
- Each entry gets a stable `endpointId` = `METHOD:normalizedPath`
- Timestamps from request artifacts drive ordering throughout
- Phase boundaries = `landing → auth-page-loaded → post-callback → final`
- Auth-critical flag = endpoint on `auth.openai.com` OR appears before first `/api/auth/session` with `accessToken`

---

## Endpoint Entry Schema

```json
{
  "endpointId": "GET:/api/auth/session",
  "method": "GET",
  "url": "https://chatgpt.com/api/auth/session",
  "normalizedPath": "/api/auth/session",
  "host": "chatgpt.com",
  "queryParamKeys": [],
  "requestHeaders": {},
  "requestCookieNames": [],
  "requestBodySchema": null,
  "responseStatus": 200,
  "responseHeaders": {},
  "redirectLocation": null,
  "setCookieNames": [],
  "responseBodySchema": { "type": "object", "keys": { "WARNING_BANNER": "string" } },
  "authCritical": true,
  "replayClassification": "replayable-direct",
  "occurrences": 2,
  "firstTs": 1773604910260,
  "lastTs": 1773604980000
}
```

---

## Replay Classification Buckets

| Bucket | Criteria |
|---|---|
| `replayable-direct` | No auth-side cookies required, no CSRF, stateless GET or simple POST |
| `replayable-with-dynamic-cookie-csrf-extraction` | Requires cookies/CSRF tokens from earlier steps, but those can be extracted programmatically |
| `browser-bound` | Requires browser-executed JS, redirects through challenge pages, or Cloudflare Turnstile |
| `challenge-bound` | Contains Turnstile, CAPTCHA, or email/OTP challenge evidence |
| `unknown` | Insufficient evidence to classify |

---

## Cookie Evolution Schema

```json
{
  "phases": [
    {
      "phase": "landing",
      "added": ["__Host-next-auth.csrf-token@chatgpt.com"],
      "removed": [],
      "present": ["__Host-next-auth.csrf-token@chatgpt.com"]
    },
    {
      "phase": "auth-page-loaded",
      "added": ["oai-login-csrf_*@auth.openai.com", "login_session@auth.openai.com"],
      "removed": [],
      "present": [...]
    }
  ],
  "firstAppearance": {
    "__Secure-next-auth.session-token@.chatgpt.com": "post-callback"
  },
  "authSideCookies": [...],
  "chatgptSideCookies": [...],
  "sessionCookies": [...]
}
```

---

## Upgraded Analysis Questions

The upgraded `analysis.json` must explicitly answer:

1. `firstAuthSideSessionRequest` — what request first establishes auth-side session?
2. `firstAccessTokenRequest` — what request first causes `/api/auth/session` to include `accessToken`?
3. `preCallbackCookies` — which cookies appear before the callback phase?
4. `postCallbackCookies` — which cookies appear only after the callback?
5. `browserBoundEndpoints` — which endpoints depend on browser-only challenge/bootstrap state?
6. `likelyReplayCandidates` — which endpoints are likely pure replay candidates?

---

## Error Handling

- Missing response for a request → entry with `responseStatus: null`, `replayClassification: "unknown"`
- Non-JSON response body → record raw/redacted preview only, skip schema extraction
- Missing cookie-diffs for a phase → mark phase evolution as `"data-missing"`, do not crash
- All analysis functions are pure (no I/O) — I/O failures surface at loader level only

---

## Testing Strategy

TDD for every module using fixture data drawn from `deep-golden-signup-v2`:

| Test file | Covers |
|---|---|
| `traceArtifactLoader.test.js` | Loads/orders pairs correctly, handles gaps |
| `endpointCatalog.test.js` | Path normalization, deduplication, schema shape |
| `flowSequence.test.js` | Timestamp ordering, auth-critical flagging |
| `cookieEvolution.test.js` | Phase assignment, first-appearance tracking |
| `replayCandidates.test.js` | Correct bucket for known endpoint families |
| `analysis.test.js` | Correct answers to all six key questions |
| `pipelineAuthCatalog.test.js` | CLI parses args, delegates correctly |

One integration test: given real `deep-golden-signup-v2` dir → all five output files produced and structurally valid.

---

## Phase B: Tracer Integration

After Phase A artifacts are stable, `runAuthTrace.js` will:
1. After capture completes, call `runCatalogAnalysis(traceDir)`
2. Emit catalog artifacts alongside existing trace artifacts
3. Log summary of replay classification counts

No changes to checkpoint or capture behavior.

---

## Definition of Success

The work is successful when a stateless engineer can:
1. Point the CLI at any trace dir
2. Get a normalized backend endpoint map
3. Read a clear verdict: which endpoints are replayable directly, which need cookie extraction, which are browser-bound
4. Use that map as the spec for building a browserless auth driver
