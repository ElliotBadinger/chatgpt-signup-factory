# Codex Quota Health System Redesign

Date: 2026-03-26
Status: Draft
Scope: pi account-router + Codex quota/identity health integration

## 1. Problem statement

The current quota-health flow can waste requests and make unsafe routing decisions because it blends together three different things:

1. **real quota state** — whether the provider/account is actually depleted
2. **probe state** — whether the last model probe succeeded or failed
3. **proof completeness/freshness** — whether the system has both 5-hour and weekly readings recently enough to trust them

Observed machine evidence:

- `~/.pi/agent/extensions/account-router/global-poll-planner.ts`
  - skips probing when quota proof is considered fresh
- `~/.pi/agent/extensions/account-router/codex-quota-compact.ts`
  - marks proof ambiguous when only one window type is observed
- `~/.pi/agent/account-router-health.json`
  - many codex aliases have historically shown `quotaRemainingFraction: 1` with `quotaProofAmbiguous: true`
- live alias evidence for `sprintc_20260314032841c`
  - session logs showed real usage-limit errors during a depletion window
  - repeated attempts continued during cooldown
  - later health refreshed to `quotaRemainingFraction: 0.85`, `quotaProofAmbiguous: false`

This means the current system can fail in both directions:

- **false healthy**: stale or ambiguous quota proof suppresses useful refreshes or keeps a route eligible too long
- **wasted probing**: repeated probes continue while the account is clearly still cooling down

## 2. External system facts from Codex repo

From local Codex sources under `~/Git/codex/codex-rs/`:

### Efficient low-token reads

- `account/read`
  - best identity/status read
  - supports `refreshToken: false`
- `getAuthStatus`
  - cheap auth-mode read
- `account/rateLimits/read`
  - structured quota read for windows and resets
- `account/rateLimits/updated`
  - push-style update notification

### Important implication

Codex already exposes a better primitive than model probing for quota health:

- **account/rateLimits/read** for explicit quota state
- **account/rateLimits/updated** and response headers/SSE for passive updates during normal traffic

So model probes should not be the primary quota-truth mechanism.

## 3. Design goals

1. **Do not burn model quota just to learn quota health** when a cheaper account/rate-limit read exists.
2. **Separate route usability from quota proof freshness**.
3. **Treat ambiguous data as incomplete, not healthy**.
4. **Exploit passive signals first** from real traffic before sending explicit refresh reads.
5. **Apply cooldown/backoff deterministically** after usage-limit failures.
6. **Preserve fast routing decisions** without repeated network work.
7. **Make operator/debug state legible** in `account-router-health.json` and dashboard surfaces.

## 4. Non-goals

- redesigning pi auth storage
- changing Codex backend semantics
- forcing weekly and 5-hour windows to always be observed before routing anything
- using expensive chat/model generations as health checks

## 5. Approaches considered

### Approach A — Keep current model probes, add stricter heuristics

Add more logic around ambiguous quota readings and provider cooldown reasons, but keep model probe as the main refresh path.

**Pros**
- smallest local change
- reuses current probe pipeline

**Cons**
- still spends expensive requests to learn health
- still conflates model success with quota truth
- still vulnerable to stale/ambiguous windows

### Approach B — Quota-first health plane backed by Codex account APIs

Make `account/rateLimits/read` the primary active quota read, consume passive `account/rateLimits/updated` / response-header signals from real traffic, and demote model probe to a last-resort route liveness check.

**Pros**
- lowest token waste
- best matches Codex’s native contract
- clean separation of quota truth vs probe truth
- easier cooldown policy

**Cons**
- requires new account-health state model and adapter logic
- requires explicit integration path from Codex reads into router health store

### Approach C — Purely passive quota tracking

Never actively read quota; only learn from normal traffic and hard failures.

**Pros**
- lowest active overhead

**Cons**
- too stale for routing decisions
- poor recovery visibility after cooldown windows
- weak startup health

## 6. Recommendation

Choose **Approach B**.

The machine evidence shows that real depletion can happen and repeated probing can continue during cooldown. The Codex repo already provides a cheaper, more reliable rate-limit surface than model probing. The redesign should therefore become **quota-first, passive-signal-enhanced, probe-last**.

## 7. Proposed architecture

Introduce three explicit health planes per alias/model:

### 7.1 Account quota plane

Truth source for quota windows and resets.

Sources, in precedence order:

1. passive `account/rateLimits/updated`
2. passive rate-limit headers / SSE from real Codex traffic
3. active `account/rateLimits/read`
4. hard usage-limit failures from model calls or probes

Stored fields:

- `quota.lastCheckedAt`
- `quota.source`
- `quota.fiveHour.remainingFraction | null`
- `quota.fiveHour.resetAt | null`
- `quota.weekly.remainingFraction | null`
- `quota.weekly.resetAt | null`
- `quota.completeness` = `complete | partial | unknown`
- `quota.effectiveRemainingFraction`
- `quota.decision` = `healthy | at_risk | exhausted | unknown`

### 7.2 Route liveness plane

Tracks whether a provider/model path is executable, independent of quota.

Stored fields:

- `liveness.lastSuccessAt`
- `liveness.lastFailureAt`
- `liveness.lastFailureReason`
- `liveness.cooldownUntil`
- `liveness.classification` = `ok | transient_fail | auth_invalid | workspace_invalid | unknown`

### 7.3 Auth/account plane

Tracks whether credentials and account identity are valid.

Stored fields:

- `auth.lastCheckedAt`
- `auth.accountId`
- `auth.email`
- `auth.planType`
- `auth.status` = `ok | invalid | expired | unknown`

## 8. Decision model

Routing should no longer ask a single overloaded question like “is this alias healthy?”

Instead:

### 8.1 Eligibility gate

A route is eligible only if:

- auth plane is not invalid
- liveness plane is not in active hard cooldown
- quota decision is not exhausted

### 8.2 Confidence model

Quota confidence levels:

- `high`: both windows observed recently
- `medium`: one window observed recently and no contradictory failure evidence
- `low`: stale or inferred mainly from failures
- `none`: no usable quota information

### 8.3 Ambiguity rule

`partial` or ambiguous quota proof must never be treated as equivalent to `healthy`.

Instead:

- if one window is present and positive, expose `decision=healthy` only with `confidence=medium`
- if a usage-limit failure exists later than the last positive quota proof, downgrade to `exhausted` or `at_risk` immediately
- if data is stale and no passive updates arrive, schedule a cheap active rate-limit read rather than a model probe

## 9. Probe policy redesign

### 9.1 Preferred sequence

1. **Passive ingest** from real Codex traffic updates health store
2. **Cheap active rate-limit read** when quota freshness expires
3. **Account/read or auth-status read** when auth/account confidence is stale
4. **Model probe only if** quota says usable but route liveness is unknown or contradictory

### 9.2 Model probe uses

Model probes should answer only:

- can this provider/model execute right now?
- does it fail with auth/workspace/toolchain error?

Model probes should **not** be the default mechanism for discovering quota windows.

### 9.3 Cooldown suppression

After a `usage-limit` failure, set a hard cooldown window using the strongest available reset evidence:

1. exact reset from quota API
2. approximate reset from response headers/SSE
3. fallback bounded backoff if reset is unknown

During this cooldown:

- do not model-probe the same alias/model
- do not active-read quota more often than the cooldown refresh schedule
- mark route as unavailable with explicit reason

## 10. Polling strategy

Replace single global polling intent with two budgets:

### 10.1 Quota refresh budget

Cheap account-level reads only.

- target aliases with stale quota confidence
- prioritize active route, then dashboard-visible routes, then round-robin
- one alias at a time
- adaptive interval based on fleet freshness and recent traffic

### 10.2 Liveness probe budget

Expensive model probes only when strictly needed.

- only for aliases where quota is usable/unknown but liveness is stale or contradicted
- suppressed during quota cooldown
- longer TTL than quota refreshes

## 11. Health-store v2 shape

Add a versioned structure that keeps planes separate.

Illustrative shape:

```json
{
  "version": 2,
  "providers": {
    "sprintc_20260314032841c": {
      "auth": {
        "status": "ok",
        "lastCheckedAt": 1774591180000,
        "email": "sprintc-20260314032841c@agentmail.to",
        "accountId": "a5052b4c-79aa-4415-b325-7161b5883518",
        "planType": "team"
      },
      "quota": {
        "lastCheckedAt": 1774591189654,
        "source": "account/rateLimits/read",
        "completeness": "complete",
        "confidence": "high",
        "fiveHour": { "remainingFraction": 0.85, "resetAt": 1774600000000 },
        "weekly": { "remainingFraction": 0.92, "resetAt": 1775000000000 },
        "effectiveRemainingFraction": 0.85,
        "decision": "healthy"
      },
      "liveness": {
        "classification": "ok",
        "lastSuccessAt": 1774591208952,
        "lastFailureAt": 1774560000000,
        "lastFailureReason": "usage-limit",
        "cooldownUntil": null
      }
    }
  }
}
```

## 12. Freshness policy

Use separate TTLs:

- `authFreshMs`
- `quotaFreshMsComplete`
- `quotaFreshMsPartial`
- `livenessFreshMs`
- `usageLimitCooldownMinRefreshMs`

Rules:

- complete quota proof can stay fresh longer than partial quota proof
- partial quota proof must expire faster
- liveness freshness cannot substitute for quota freshness
- quota freshness cannot substitute for liveness freshness

## 13. Conflict-resolution rules

### 13.1 Usage-limit failure after positive quota

If a usage-limit failure timestamp is newer than the most recent positive quota reading:

- immediately mark quota decision `exhausted` or `at_risk`
- lower confidence
- schedule one cheap quota refresh at the next allowed cooldown checkpoint

### 13.2 Positive quota after cooldown/auth deny

If a fresh positive quota reading arrives:

- clear quota-like provider deny state
- do not clear auth-invalid state unless auth plane independently recovers

### 13.3 Partial windows

If only one window is observed:

- persist the observed window explicitly
- compute effective fraction conservatively from observed data only
- dashboard must show `partial`, not ambiguous-as-healthy shorthand

## 14. Dashboard / operator UX

Dashboard should show:

- alias
- auth state
- quota state (`healthy`, `at risk`, `exhausted`, `unknown`)
- confidence (`high`, `medium`, `low`)
- completeness (`complete`, `partial`)
- 5h and weekly values separately when present
- source of latest quota signal
- next scheduled refresh / cooldown end

Example compact cell:

- `quota: healthy/high W:92%(3d4h) 5h:85%(1h12m)`
- `quota: partial/medium 5h:12%(34m)`
- `quota: exhausted/low from usage-limit, refresh in 18m`

## 15. Why this would fix the observed failure mode

For `sprintc_20260314032841c`:

- the real usage-limit failures would have moved the alias into an explicit quota cooldown state
- repeated model probes during that window would have been suppressed
- recovery would have happened through cheap quota refresh reads or passive updates
- once fresh quota returned at `0.85`, the route would become eligible again without needing multiple expensive retries

For older aliases that showed `1.0 + ambiguous`:

- they would become `partial`, not implicitly healthy
- the scheduler would perform cheap rate-limit refreshes instead of expensive model probes
- routing could choose higher-confidence aliases first

## 16. Risks

- local extension complexity increases
- Codex push notifications may not be available in every integration path, so fallback polling still matters
- migration from health-store v1 to v2 must preserve existing evidence and cooldown semantics

## 17. Validation strategy

### 17.1 Static validation

- map every current health decision site to one of the three planes
- ensure no caller uses partial quota as equivalent to complete quota

### 17.2 Simulation cases

1. complete positive quota, no failures
2. partial positive quota only
3. stale positive quota followed by usage-limit error
4. usage-limit error followed by positive quota refresh
5. auth-invalid with positive stale quota
6. workspace invalid but quota still positive

### 17.3 Live acceptance criteria

- cooldown aliases are not repeatedly model-probed
- dashboard distinguishes partial vs complete quota proof
- active aliases update quota from passive real-traffic signals without extra probes
- recovery after cooldown uses cheap quota reads before model probes
- routing prefers high-confidence healthy aliases over partial-confidence ones

## 18. Recommended implementation order

1. introduce health-store v2 schema and compatibility loader
2. add Codex quota adapter for `account/rateLimits/read`
3. ingest passive `account/rateLimits/updated` and header/SSE rate-limit signals
4. split quota refresh scheduler from liveness probe scheduler
5. update route selection to use plane-based eligibility/confidence
6. update dashboard surfaces and operator text
7. add migration and regression tests for ambiguous/partial windows

## 19. Summary

The safer system is:

- **quota-first** instead of probe-first
- **plane-separated** instead of overloaded health flags
- **passive-signal-enhanced** instead of repeatedly probing
- **cheap account reads first, model probes last**

That is the design most aligned with both the machine evidence and the Codex repo’s native quota surfaces.
