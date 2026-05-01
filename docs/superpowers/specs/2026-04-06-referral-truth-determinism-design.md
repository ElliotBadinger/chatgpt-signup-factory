# Referral Truth Determinism Design

- Date: 2026-04-06
- Project: `claude-sessions`
- Topic: deterministic referral truth gate
- Status: approved in chat, written for review

## Goal

Make referral verification reliable and deterministic by ensuring the system derives the same referral truth decision from the same evidence history every time.

This slice is specifically about the **referral truth gate**, not downstream auth or onboarding. It exists to prevent false proceeds from poisoning later automation.

## Scope

### In scope
- Deterministic referral truth derivation
- Replayable evidence ledger
- Clear separation between probe classification and decision derivation
- Sticky `DEAD`
- Durable `PROCEED`
- Challenge escalation policy
- CLI/web visibility for gate decisions
- Migration-safe extension of the current repo model

### Out of scope
- Auth/onboarding execution changes beyond reading the gate output
- Browserless auth design changes
- Provider selection changes
- Alias onboarding changes
- Any implementation that bypasses third-party auth/security controls

## Chosen design summary

Use a **two-tier referral truth model**:
- `likely_proceedable`: informational only
- hard `PROCEED`: the only state that unlocks downstream automation

Use an **evidence-ledger architecture**:
- every verification probe writes immutable evidence rows
- a deterministic derivation function computes the current truth summary from persisted evidence and current record state

This preserves explainability, replayability, and stable gate behavior.

## Alternatives considered

### 1. Simple enum-first gate
Store one primary truth state and a `likely_proceedable` boolean.

**Pros**
- Simple to understand
- Minimal schema changes

**Cons**
- Less replayable and auditable
- Encourages hidden heuristics
- Harder to explain repeated-probe behavior

### 2. Evidence ledger with derived decisions (**chosen**)
Persist evidence rows and derive current truth from explicit rules.

**Pros**
- Most deterministic
- Fully auditable
- Supports challenge escalation and sticky `DEAD` cleanly
- Best fit for repo reliability goals

**Cons**
- More schema and code complexity
- Slightly larger CLI/web updates

### 3. Epoch-based verifier
Separate evidence into verification epochs and derive only from the latest active epoch.

**Pros**
- Very clean historical segmentation

**Cons**
- More complexity than currently needed
- Can be added later if threshold/version evolution requires it

## Core invariants

1. **Automation gate**
   - downstream automation may run only when `proceed_decision = PROCEED`

2. **Informational tier**
   - `likely_proceedable = true` never unlocks automation
   - it is for operator visibility only

3. **Sticky dead**
   - once a referral is `DEAD`, normal verifier runs cannot promote it
   - only explicit operator override may clear `DEAD`

4. **Durable proceed**
   - once a referral is `PROCEED`, it remains `PROCEED` unless new dead evidence appears
   - noisy, ambiguous, or challenge-driven probes do not demote it

5. **Challenge non-truth**
   - challenge responses are never treated as positive evidence
   - they only drive hold states

6. **Replayability**
   - every derived decision must be reconstructible from persisted evidence rows

## Truth model

### Primary derived fields
The referral summary row should expose:
- `truth_status`: `unknown | hold_retry | hold_review | proceed | dead`
- `likely_proceedable`: `true | false`
- `proceed_decision`: `PROCEED | HOLD_RETRY | HOLD_REVIEW | DEAD`
- `evidence_score`: numeric summary only, not sole authority
- `decision_reason`: stable machine-readable reason code
- `last_verified_at`
- `challenge_count_windowed`

### Decision semantics
- `DEAD`: hard terminal result from explicit dead evidence
- `PROCEED`: hard positive decision that unlocks automation
- `HOLD_RETRY`: uncertain but retryable
- `HOLD_REVIEW`: escalated uncertainty or conflicting evidence
- `likely_proceedable = true`: positive hints exist, but not enough for `PROCEED`

## Hard `PROCEED` rule

A referral may become hard `PROCEED` if the deciding probe shows either:
1. direct acceptance/join page evidence, or
2. a stable redirect to a known redeem step,

and the same deciding probe contains **no** dead or challenge signal.

## Challenge policy

Cloudflare/challenge responses are never positive.

Use an escalating policy:
- first few challenges in a rolling window -> `HOLD_RETRY`
- repeated challenges in that window -> `HOLD_REVIEW`

### Default window
- rolling window: `24h`
- escalation threshold: `3` challenge-classified probes

So:
- 1-2 challenge probes in 24h -> `HOLD_RETRY`
- 3+ challenge probes in 24h -> `HOLD_REVIEW`

## Dead policy

`DEAD` is sticky.

Dead evidence includes explicit signals such as:
- expired referral
- invalid referral
- already used
- already claimed
- consumed referral

Normal verification cannot reverse `DEAD`.
Any future dead-clearing behavior must be a separate explicit operator override path with audit logging.

## Freshness policy

Hard `PROCEED` does **not** expire automatically.
It remains valid unless later contradicted by dead evidence.

This avoids non-deterministic drift caused by TTL-based demotion.

## Evidence ledger design

Each verification probe should produce immutable evidence rows.

### Evidence row fields
Recommended structure for `referral_evidence`:
- `referral_code`
- `observed_at`
- `probe_kind`
- `evidence_kind`
- `polarity` (`positive | negative | dead | neutral`)
- `reason_code`
- `weight`
- `response_fingerprint`
- `window_bucket`
- `payload_json`

### Evidence kinds

#### Positive
- `accept_cta_detected`
- `join_claude_cta_detected`
- `known_redeem_redirect`
- `invite_semantics_detected`

#### Negative / hold-driving
- `cloudflare_challenge`
- `retryable_transport_failure`
- `unexpected_auth_wall`
- `ambiguous_redirect`
- `missing_referral_payload`

#### Dead
- `expired_referral`
- `invalid_referral`
- `already_used`
- `already_claimed`
- `consumed_referral`

## Deterministic derivation order

The decision engine should derive state in this order:

1. **Sticky dead check**
   - if dead evidence exists in the active record history, return `DEAD`

2. **Durable proceed preservation**
   - if the current record is already `PROCEED`, keep it `PROCEED`
   - unless new dead evidence appears

3. **Hard proceed from current deciding probe**
   - if the latest successful probe shows accept/join CTA or stable known redeem redirect
   - and the deciding probe has no dead/challenge signal
   - return `PROCEED`

4. **Challenge escalation**
   - if the latest probe is challenge-classified:
     - below threshold -> `HOLD_RETRY`
     - threshold crossed -> `HOLD_REVIEW`

5. **Likely proceedable**
   - if positive hints exist but do not satisfy hard `PROCEED`, set `likely_proceedable = true`
   - keep the decision in a hold state

6. **Default hold**
   - retryable uncertainty -> `HOLD_RETRY`
   - conflicting or escalated uncertainty -> `HOLD_REVIEW`

## Stable decision reason codes

The final derived summary should expose stable reason codes such as:
- `dead.expired`
- `dead.invalid`
- `dead.already_used`
- `dead.consumed`
- `proceed.accept_cta`
- `proceed.known_redeem_redirect`
- `hold_retry.cloudflare_challenge`
- `hold_review.challenge_escalated`
- `hold_review.conflicting_evidence`
- `hold_retry.retryable_transport`
- `hold_review.insufficient_evidence`

These reason codes should appear in CLI/web output and tests.

## Concrete repo shape

### `src/claude_sessions/referrals/models.py`
Keep existing coarse `ReferralStatus` values for backward compatibility, but make the new truth fields authoritative.

Add to the authoritative truth surface:
- `likely_proceedable: bool`
- `decision_reason: str`
- `challenge_count_windowed: int`

### `src/claude_sessions/referrals/store.py`

#### `referrals` additions
- `likely_proceedable INTEGER NOT NULL DEFAULT 0`
- `decision_reason TEXT NOT NULL DEFAULT 'hold_review.insufficient_evidence'`
- `challenge_count_windowed INTEGER NOT NULL DEFAULT 0`
- preserve existing truth fields:
  - `truth_status`
  - `evidence_score`
  - `proceed_decision`
  - `threshold_version`
  - `last_evidence_at`
  - `last_retry_after`

#### `referral_evidence` additions
- `probe_kind TEXT NOT NULL DEFAULT 'verification'`
- `polarity TEXT NOT NULL DEFAULT 'neutral'`
- `reason_code TEXT NOT NULL`
- `response_fingerprint TEXT`
- `window_bucket TEXT`

#### `validation_attempts` additions
Keep this table as the attempt log, but not the truth authority.
Add:
- `decision_reason TEXT`
- `likely_proceedable INTEGER NOT NULL DEFAULT 0`
- `challenge_count_windowed INTEGER NOT NULL DEFAULT 0`

### `src/claude_sessions/referrals/verification.py`
Split behavior into two phases:

1. **Probe classification**
   - classify one response into evidence items only

2. **Decision derivation**
   - read current referral state, new evidence, and recent challenge window
   - derive:
     - `truth_status`
     - `proceed_decision`
     - `likely_proceedable`
     - `decision_reason`
     - `challenge_count_windowed`

### Recommended helper boundaries
- `_classify_probe(...) -> list[ReferralEvidenceInput]`
- `_count_recent_challenges(...) -> int`
- `_derive_truth_decision(current_record, new_evidence, challenge_count) -> ReferralTruthSnapshot`
- `_is_hard_proceed_probe(evidence) -> bool`
- `_has_dead_evidence(evidence) -> bool`

## Data flow

For one verification run:

1. load referral record and recent evidence
2. execute one probe
3. classify probe into immutable evidence rows
4. derive truth decision from current state + new evidence + recent challenge window
5. persist attempt log, evidence rows, and summary fields atomically
6. return explicit result to CLI/web/API

## Failure handling

### Transport failure
- never promotes to `PROCEED`
- usually yields `HOLD_RETRY`
- emits a stable reason like `hold_retry.retryable_transport`

### Challenge response
- never positive
- below threshold -> `HOLD_RETRY`
- threshold crossed -> `HOLD_REVIEW`

### Ambiguous positive hints
- may set `likely_proceedable = true`
- must still block automation

### Dead evidence
- immediately sets `DEAD`
- remains sticky until operator override

### Previously proven referral with later noisy probes
- if already `PROCEED`, later noisy/challenge probes do not demote it
- only dead evidence can demote it

## CLI/web behavior

### CLI
`referral-verify <code>` should display:
- `truth_status`
- `proceed_decision`
- `likely_proceedable`
- `decision_reason`
- `challenge_count_windowed`
- `evidence_score`

### Web
Referral views should emphasize:
- hard gate state
- likely flag
- reason code
- challenge escalation count

## Testing strategy

### Unit tests
Add tests covering:
- hard proceed from accept CTA
- hard proceed from known redeem redirect
- one/two challenge probes -> `HOLD_RETRY`
- three challenge probes in 24h -> `HOLD_REVIEW`
- positive hints only -> `likely_proceedable=true`, no `PROCEED`
- dead evidence -> sticky `DEAD`
- prior `PROCEED` + later challenge -> still `PROCEED`

### Store/migration tests
- legacy rows backfill deterministically
- new columns receive stable defaults
- evidence ledger replays to the same derived summary

### CLI/web tests
- output includes `likely_proceedable`, `decision_reason`, and `challenge_count_windowed`
- filters for `truth_status` and `proceed_decision`
- dead/proceed badges render consistently

## Recommended implementation order

1. model/schema additions
2. derivation engine extraction
3. atomic persistence changes
4. CLI/web rendering
5. migration and regression tests

## Why this design is the right next slice

This is the smallest high-leverage change that improves reliability in line with the repo’s stated goal:
- stop false proceeds
- make decisions explainable
- make verification replayable
- keep downstream automation gated by explicit truth

It strengthens determinism without requiring immediate changes to later pipeline slices.
