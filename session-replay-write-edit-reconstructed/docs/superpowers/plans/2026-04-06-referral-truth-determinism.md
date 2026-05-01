# Referral Truth Determinism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make referral verification deterministic by deriving `PROCEED`, `HOLD_RETRY`, `HOLD_REVIEW`, and `DEAD` from a replayable evidence ledger, while keeping `likely_proceedable` informational-only.

**Architecture:** Extend the existing referral SQLite schema with explicit deterministic-summary fields and richer evidence metadata, then refactor verification into two phases: probe classification and decision derivation. Keep backward-compatible `ReferralStatus` values for operator surfaces, but make the new derived truth fields the only authority for downstream automation and retry eligibility.

**Tech Stack:** Python 3.13, SQLite (`sqlite3`), Typer CLI, FastAPI/Jinja2 web UI, pytest

---

## File structure map

- `src/claude_sessions/referrals/models.py`
  - Referral truth dataclasses and enums.
  - Add deterministic summary fields (`likely_proceedable`, `decision_reason`, `challenge_count_windowed`) plus richer evidence metadata.
- `src/claude_sessions/referrals/store.py`
  - SQLite schema migration, atomic validation persistence, retry gate rules, and query surfaces for the new fields.
- `src/claude_sessions/referrals/verification.py`
  - Probe classification, challenge counting, sticky-dead / durable-proceed derivation, and `ValidationResult` serialization.
- `src/claude_sessions/cli.py`
  - Referral inspection and filtering surfaces for the deterministic truth fields.
- `src/claude_sessions/web.py`
  - Page messages and referral detail context for deterministic truth summaries.
- `src/claude_sessions/templates/index.html`
  - Render `truth_status`, `proceed_decision`, `likely_proceedable`, `decision_reason`, and retry eligibility.
- `tests/test_referrals.py`
  - Store, migration, verification, sticky-dead, durable-proceed, challenge-escalation, and retry tests.
- `tests/test_cli.py`
  - CLI output tests for deterministic truth fields and filters.
- `tests/test_web.py`
  - Web rendering tests for deterministic truth messages and retry links.

## Execution notes

- Run all commands from the repo root: `/home/epistemophile/Development/claude-sessions`.
- Use `uv run pytest ...` for all tests.
- Commit after each task with the suggested message before moving on.
- Keep scope tight: do not add operator override flows in this slice.

### Task 1: Extend the referral truth models and SQLite schema

**Files:**
- Modify: `src/claude_sessions/referrals/models.py`
- Modify: `src/claude_sessions/referrals/store.py`
- Test: `tests/test_referrals.py`

- [ ] **Step 1: Write the failing schema/model test**

Add this test near the existing referral store tests in `tests/test_referrals.py`:

```python
def test_store_persists_referral_determinism_fields(tmp_path: Path):
    store = ReferralStore(tmp_path / "referrals.db")
    store.upsert_referral(
        ReferralRecord(
            code="LIKELY001",
            url="https://claude.ai/referral/LIKELY001",
            status=ReferralStatus.DISCOVERED,
            source_doc="pytest",
        )
    )

    snapshot = ReferralTruthSnapshot(
        truth_status=ReferralTruthStatus.HOLD_REVIEW,
        evidence_score=4,
        proceed_decision=ProceedDecision.HOLD_REVIEW,
        likely_proceedable=True,
        decision_reason="hold_review.insufficient_evidence",
        challenge_count_windowed=2,
        threshold_version=THRESHOLD_VERSION,
    )

    store.record_referral_evidence(
        "LIKELY001",
        [
            ReferralEvidenceInput(
                evidence_kind="cloudflare_challenge",
                evidence_source="transport.challenge",
                polarity="negative",
                reason_code="hold_retry.cloudflare_challenge",
                weight=-6,
                probe_kind="verification",
                response_fingerprint="fp-likely-1",
                window_bucket="2026-04-06T12",
                payload={"retryable": True},
            )
        ],
        snapshot=snapshot,
    )

    referral = store.get_referral("LIKELY001")
    assert referral["likely_proceedable"] == 1
    assert referral["decision_reason"] == "hold_review.insufficient_evidence"
    assert referral["challenge_count_windowed"] == 2

    evidence = store.list_referral_evidence(code="LIKELY001")
    assert evidence[0]["polarity"] == "negative"
    assert evidence[0]["reason_code"] == "hold_retry.cloudflare_challenge"
    assert evidence[0]["probe_kind"] == "verification"
    assert evidence[0]["response_fingerprint"] == "fp-likely-1"
    assert evidence[0]["window_bucket"] == "2026-04-06T12"
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
uv run pytest tests/test_referrals.py::test_store_persists_referral_determinism_fields -v
```

Expected: FAIL because `ReferralTruthSnapshot` / `ReferralEvidenceInput` do not accept the new keyword arguments yet, and the new SQLite columns do not exist.

- [ ] **Step 3: Add the deterministic truth fields to the dataclasses**

Update `src/claude_sessions/referrals/models.py` with these exact field additions:

```python
@dataclass(slots=True, frozen=True)
class ReferralTruthSnapshot:
    truth_status: ReferralTruthStatus
    evidence_score: int
    proceed_decision: ProceedDecision
    likely_proceedable: bool = False
    decision_reason: str = "hold_review.insufficient_evidence"
    challenge_count_windowed: int = 0
    threshold_version: str = THRESHOLD_VERSION
    last_evidence_at: str | None = None
    last_retry_after: str | None = None


@dataclass(slots=True, frozen=True)
class ReferralEvidenceInput:
    evidence_kind: str
    evidence_source: str
    polarity: str = "neutral"
    reason_code: str = ""
    weight: int = 0
    hard_fail: bool = False
    probe_kind: str = "verification"
    response_fingerprint: str | None = None
    window_bucket: str | None = None
    payload: dict[str, Any] | None = None


@dataclass(slots=True, frozen=True)
class ReferralRecord:
    code: str
    url: str | None
    status: ReferralStatus
    source_doc: str
    source_section: str | None = None
    notes: str | None = None
    truth_status: ReferralTruthStatus | None = None
    evidence_score: int | None = None
    proceed_decision: ProceedDecision | None = None
    likely_proceedable: bool | None = None
    decision_reason: str | None = None
    challenge_count_windowed: int | None = None
    threshold_version: str = THRESHOLD_VERSION
    last_evidence_at: str | None = None
    last_retry_after: str | None = None
```

- [ ] **Step 4: Add the schema columns and query surfaces in the store**

Update `src/claude_sessions/referrals/store.py` with these exact schema helpers and query additions:

```python
def _ensure_referral_columns(self, conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(referrals)").fetchall()}
    for name, ddl in (
        ("truth_status", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("evidence_score", "INTEGER NOT NULL DEFAULT 0"),
        ("proceed_decision", f"TEXT NOT NULL DEFAULT '{ProceedDecision.HOLD_REVIEW.value}'"),
        ("likely_proceedable", "INTEGER NOT NULL DEFAULT 0"),
        ("decision_reason", "TEXT NOT NULL DEFAULT 'hold_review.insufficient_evidence'"),
        ("challenge_count_windowed", "INTEGER NOT NULL DEFAULT 0"),
        ("threshold_version", f"TEXT NOT NULL DEFAULT '{THRESHOLD_VERSION}'"),
        ("last_evidence_at", "TEXT"),
        ("last_retry_after", "TEXT"),
    ):
        if name not in columns:
            conn.execute(f"ALTER TABLE referrals ADD COLUMN {name} {ddl}")


def _ensure_referral_evidence_columns(self, conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(referral_evidence)").fetchall()}
    for name, ddl in (
        ("probe_kind", "TEXT NOT NULL DEFAULT 'verification'"),
        ("polarity", "TEXT NOT NULL DEFAULT 'neutral'"),
        ("reason_code", "TEXT NOT NULL DEFAULT ''"),
        ("response_fingerprint", "TEXT"),
        ("window_bucket", "TEXT"),
    ):
        if name not in columns:
            conn.execute(f"ALTER TABLE referral_evidence ADD COLUMN {name} {ddl}")


def _ensure_validation_attempt_columns(self, conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(validation_attempts)").fetchall()}
    for name, ddl in (
        ("attempt_class", "TEXT NOT NULL DEFAULT 'verification'"),
        ("derived_weight", "INTEGER NOT NULL DEFAULT 0"),
        ("retry_after", "TEXT"),
        ("decision_reason", "TEXT NOT NULL DEFAULT 'hold_review.insufficient_evidence'"),
        ("likely_proceedable", "INTEGER NOT NULL DEFAULT 0"),
        ("challenge_count_windowed", "INTEGER NOT NULL DEFAULT 0"),
        ("threshold_version", f"TEXT NOT NULL DEFAULT '{THRESHOLD_VERSION}'"),
    ):
        if name not in columns:
            conn.execute(f"ALTER TABLE validation_attempts ADD COLUMN {name} {ddl}")
```

Also update the relevant `SELECT` / `INSERT` statements so these fields are returned and persisted:

```python
SELECT
    code,
    url,
    status,
    source_doc,
    source_section,
    notes,
    truth_status,
    evidence_score,
    proceed_decision,
    likely_proceedable,
    decision_reason,
    challenge_count_windowed,
    threshold_version,
    last_evidence_at,
    last_retry_after,
    created_at,
    updated_at
FROM referrals
```

```python
INSERT INTO referral_evidence(
    referral_code,
    evidence_kind,
    evidence_source,
    polarity,
    reason_code,
    weight,
    hard_fail,
    probe_kind,
    response_fingerprint,
    window_bucket,
    payload_json,
    created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

```python
UPDATE referrals
SET truth_status = ?,
    evidence_score = ?,
    proceed_decision = ?,
    likely_proceedable = ?,
    decision_reason = ?,
    challenge_count_windowed = ?,
    threshold_version = ?,
    last_evidence_at = ?,
    last_retry_after = ?,
    updated_at = ?
WHERE code = ?
```

- [ ] **Step 5: Update snapshot backfill defaults so legacy rows get deterministic values**

Extend `_snapshot_from_record()` and `_legacy_truth_snapshot()` in `src/claude_sessions/referrals/store.py` so they preserve the new fields:

```python
return ReferralTruthSnapshot(
    truth_status=record.truth_status or legacy.truth_status,
    evidence_score=record.evidence_score if record.evidence_score is not None else legacy.evidence_score,
    proceed_decision=record.proceed_decision or legacy.proceed_decision,
    likely_proceedable=(record.likely_proceedable if record.likely_proceedable is not None else legacy.likely_proceedable),
    decision_reason=record.decision_reason or legacy.decision_reason,
    challenge_count_windowed=(
        record.challenge_count_windowed
        if record.challenge_count_windowed is not None
        else legacy.challenge_count_windowed
    ),
    threshold_version=record.threshold_version or legacy.threshold_version,
    last_evidence_at=record.last_evidence_at or legacy.last_evidence_at,
    last_retry_after=record.last_retry_after or legacy.last_retry_after,
)
```

```python
if status in {ReferralStatus.INVALID_EXPIRED, ReferralStatus.INVALID_CONSUMED}:
    return ReferralTruthSnapshot(
        truth_status=ReferralTruthStatus.DEAD,
        evidence_score=0,
        proceed_decision=ProceedDecision.DEAD,
        likely_proceedable=False,
        decision_reason="dead.legacy_status",
        challenge_count_windowed=0,
        last_evidence_at=last_evidence_at,
        last_retry_after=last_retry_after,
    )
```

Use the same pattern for the other legacy mappings:
- `retry_later -> hold_retry.legacy_status`
- `ambiguous -> hold_review.legacy_status`
- `discovered -> hold_review.insufficient_evidence`
- `valid/auth_* -> proceed.legacy_status`

- [ ] **Step 6: Run the focused tests to verify the schema/model work passes**

Run:

```bash
uv run pytest tests/test_referrals.py::test_store_persists_referral_determinism_fields tests/test_referrals.py::test_store_migrates_legacy_ambiguous_and_retry_later_rows -v
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/claude_sessions/referrals/models.py src/claude_sessions/referrals/store.py tests/test_referrals.py
git commit -m "feat: persist deterministic referral truth fields"
```

### Task 2: Refactor verification into probe classification plus deterministic derivation

**Files:**
- Modify: `src/claude_sessions/referrals/verification.py`
- Modify: `src/claude_sessions/referrals/models.py`
- Test: `tests/test_referrals.py`

- [ ] **Step 1: Write the failing decision-engine tests**

Append these tests to `tests/test_referrals.py`:

```python
def test_verify_referral_sets_likely_proceedable_without_unlocking_auth(tmp_path: Path):
    store = ReferralStore(tmp_path / "referrals.db")
    store.upsert_referral(
        ReferralRecord(
            code="LIKELY002",
            url="https://claude.ai/referral/LIKELY002",
            status=ReferralStatus.DISCOVERED,
            source_doc="pytest",
        )
    )

    result = verify_referral_code(
        "LIKELY002",
        store=store,
        fetcher=lambda _: TransportResponse(
            status_code=200,
            text="Referral invite for code LIKELY002",
            headers={"content-type": "text/html"},
            challenge=ChallengeDetection(detected=False, confidence=0.0, reasons=()),
        ),
    )

    assert result.truth_status == ReferralTruthStatus.HOLD_REVIEW
    assert result.proceed_decision == ProceedDecision.HOLD_REVIEW
    assert result.likely_proceedable is True
    assert result.decision_reason == "hold_review.insufficient_evidence"
    assert result.challenge_count_windowed == 0


def test_verify_referral_escalates_third_challenge_to_hold_review(tmp_path: Path):
    store = ReferralStore(tmp_path / "referrals.db")
    store.upsert_referral(
        ReferralRecord(
            code="CHALLENG3",
            url="https://claude.ai/referral/CHALLENG3",
            status=ReferralStatus.DISCOVERED,
            source_doc="pytest",
        )
    )

    challenge_response = lambda _: TransportResponse(
        status_code=403,
        text="Checking your browser before accessing Claude",
        headers={"server": "cloudflare", "cf-ray": "123"},
        challenge=ChallengeDetection(detected=True, confidence=0.9, reasons=("header:cf-ray",)),
    )

    first = verify_referral_code("CHALLENG3", store=store, fetcher=challenge_response)
    second = verify_referral_code("CHALLENG3", store=store, fetcher=challenge_response)
    third = verify_referral_code("CHALLENG3", store=store, fetcher=challenge_response)

    assert first.proceed_decision == ProceedDecision.HOLD_RETRY
    assert second.proceed_decision == ProceedDecision.HOLD_RETRY
    assert third.proceed_decision == ProceedDecision.HOLD_REVIEW
    assert third.decision_reason == "hold_review.challenge_escalated"
    assert third.challenge_count_windowed == 3


def test_verify_referral_preserves_proceed_until_dead_marker_arrives(tmp_path: Path):
    store = ReferralStore(tmp_path / "referrals.db")
    store.upsert_referral(
        ReferralRecord(
            code="PROCEED01",
            url="https://claude.ai/referral/PROCEED01",
            status=ReferralStatus.DISCOVERED,
            source_doc="pytest",
        )
    )

    proceed = verify_referral_code(
        "PROCEED01",
        store=store,
        fetcher=lambda _: TransportResponse(
            status_code=200,
            text="Accept referral and get started with Claude today",
            headers={"content-type": "text/html"},
            challenge=ChallengeDetection(detected=False, confidence=0.0, reasons=()),
        ),
    )
    noisy = verify_referral_code(
        "PROCEED01",
        store=store,
        fetcher=lambda _: TransportResponse(
            status_code=403,
            text="Checking your browser before accessing Claude",
            headers={"server": "cloudflare", "cf-ray": "456"},
            challenge=ChallengeDetection(detected=True, confidence=0.9, reasons=("header:cf-ray",)),
        ),
    )
    dead = verify_referral_code(
        "PROCEED01",
        store=store,
        fetcher=lambda _: TransportResponse(
            status_code=200,
            text="This referral has already been redeemed and consumed",
            headers={"content-type": "text/html"},
            challenge=ChallengeDetection(detected=False, confidence=0.0, reasons=()),
        ),
    )

    assert proceed.proceed_decision == ProceedDecision.PROCEED
    assert noisy.proceed_decision == ProceedDecision.PROCEED
    assert noisy.decision_reason.startswith("proceed.")
    assert dead.proceed_decision == ProceedDecision.DEAD
    assert dead.decision_reason == "dead.consumed"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
uv run pytest \
  tests/test_referrals.py::test_verify_referral_sets_likely_proceedable_without_unlocking_auth \
  tests/test_referrals.py::test_verify_referral_escalates_third_challenge_to_hold_review \
  tests/test_referrals.py::test_verify_referral_preserves_proceed_until_dead_marker_arrives -v
```

Expected: FAIL because `ValidationResult` does not expose the new fields yet and verification still uses score-only heuristics.

- [ ] **Step 3: Extend `ValidationResult` and its JSON serializer**

Update `src/claude_sessions/referrals/verification.py` with these exact fields:

```python
@dataclass(slots=True, frozen=True)
class ValidationResult:
    code: str
    url: str | None
    status: ReferralStatus
    reason: str
    response_status_code: int | None
    challenge_detected: bool
    body_preview: str | None
    truth_status: ReferralTruthStatus = ReferralTruthStatus.UNKNOWN
    proceed_decision: ProceedDecision = ProceedDecision.HOLD_REVIEW
    likely_proceedable: bool = False
    decision_reason: str = "hold_review.insufficient_evidence"
    challenge_count_windowed: int = 0
    evidence_score: int = 0
    threshold_version: str = THRESHOLD_VERSION
    retry_after: str | None = None
    evidence_inputs: tuple[ReferralEvidenceInput, ...] = field(default_factory=tuple)
```

And return those fields from `as_dict()`:

```python
"likely_proceedable": self.likely_proceedable,
"decision_reason": self.decision_reason,
"challenge_count_windowed": self.challenge_count_windowed,
```

- [ ] **Step 4: Rewrite probe classification so each evidence item carries polarity and reason code**

In `_classify_response()` inside `src/claude_sessions/referrals/verification.py`, replace the current `ReferralEvidenceInput(...)` calls with explicit metadata like this:

```python
evidence.append(
    ReferralEvidenceInput(
        evidence_kind="cloudflare_challenge",
        evidence_source="transport.challenge",
        polarity="negative",
        reason_code="hold_retry.cloudflare_challenge",
        weight=-6,
        probe_kind="verification",
        response_fingerprint=_response_fingerprint(status_code, location, body_preview),
        window_bucket=_window_bucket(),
        payload={
            "retryable": True,
            "retry_after": _retry_after_from_headers(headers),
            "status_code": status_code,
            "challenge_reasons": list(response.challenge.reasons),
        },
    )
)
```

Use the same pattern for the other classifiers:
- accept/join CTA -> `polarity="positive"`, `reason_code="proceed.accept_cta"`
- known `/new` redirect -> `polarity="positive"`, `reason_code="proceed.known_redeem_redirect"`
- invite semantics only -> `polarity="positive"`, `reason_code="hold_review.insufficient_evidence"`
- expired/invalid -> `polarity="dead"`, `reason_code="dead.expired"`
- consumed -> `polarity="dead"`, `reason_code="dead.consumed"`
- retryable transport failure -> `polarity="negative"`, `reason_code="hold_retry.retryable_transport"`

Also add these helpers near the bottom of the file:

```python
def _response_fingerprint(status_code: int | None, location: str, body_preview: str | None) -> str:
    preview = (body_preview or "")[:64]
    return f"{status_code}|{location}|{preview}"


def _window_bucket() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H")
```

- [ ] **Step 5: Replace `_evaluate_referral_truth()` with deterministic derivation helpers**

In `src/claude_sessions/referrals/verification.py`, replace `_evaluate_referral_truth()` with this exact structure:

```python
CHALLENGE_WINDOW = timedelta(hours=24)
CHALLENGE_ESCALATION_THRESHOLD = 3


def _evaluate_referral_truth(
    store: ReferralStore,
    *,
    code: str,
    new_evidence: list[ReferralEvidenceInput],
) -> ReferralTruthSnapshot:
    existing_rows = list(reversed(store.list_referral_evidence(code=code, limit=1000)))
    existing_evidence = [_row_to_evidence_input(row) for row in existing_rows]
    combined = [*existing_evidence, *new_evidence]
    current = store.get_referral(code)
    score = sum(item.weight for item in combined)
    challenge_count = _count_recent_challenges(existing_evidence, new_evidence)
    retry_after = _latest_retry_after(combined)
    likely = any(item.polarity == "positive" for item in combined) and not _is_hard_proceed_probe(new_evidence)

    if _has_dead_evidence(combined):
        return ReferralTruthSnapshot(
            truth_status=ReferralTruthStatus.DEAD,
            evidence_score=score,
            proceed_decision=ProceedDecision.DEAD,
            likely_proceedable=False,
            decision_reason=_dead_reason(combined),
            challenge_count_windowed=challenge_count,
            threshold_version=THRESHOLD_VERSION,
            last_evidence_at=_utc_now(),
            last_retry_after=retry_after,
        )

    if current is not None and current["proceed_decision"] == ProceedDecision.PROCEED.value:
        return ReferralTruthSnapshot(
            truth_status=ReferralTruthStatus.PROCEED,
            evidence_score=score,
            proceed_decision=ProceedDecision.PROCEED,
            likely_proceedable=False,
            decision_reason=str(current["decision_reason"] or "proceed.accept_cta"),
            challenge_count_windowed=challenge_count,
            threshold_version=THRESHOLD_VERSION,
            last_evidence_at=_utc_now(),
            last_retry_after=retry_after,
        )

    if _is_hard_proceed_probe(new_evidence):
        return ReferralTruthSnapshot(
            truth_status=ReferralTruthStatus.PROCEED,
            evidence_score=score,
            proceed_decision=ProceedDecision.PROCEED,
            likely_proceedable=False,
            decision_reason=_hard_proceed_reason(new_evidence),
            challenge_count_windowed=challenge_count,
            threshold_version=THRESHOLD_VERSION,
            last_evidence_at=_utc_now(),
            last_retry_after=retry_after,
        )

    if _latest_probe_has_reason(new_evidence, "hold_retry.cloudflare_challenge"):
        escalated = challenge_count >= CHALLENGE_ESCALATION_THRESHOLD
        return ReferralTruthSnapshot(
            truth_status=ReferralTruthStatus.HOLD_REVIEW if escalated else ReferralTruthStatus.HOLD_RETRY,
            evidence_score=score,
            proceed_decision=ProceedDecision.HOLD_REVIEW if escalated else ProceedDecision.HOLD_RETRY,
            likely_proceedable=likely,
            decision_reason="hold_review.challenge_escalated" if escalated else "hold_retry.cloudflare_challenge",
            challenge_count_windowed=challenge_count,
            threshold_version=THRESHOLD_VERSION,
            last_evidence_at=_utc_now(),
            last_retry_after=retry_after,
        )

    if any(_is_retryable(item) for item in new_evidence):
        return ReferralTruthSnapshot(
            truth_status=ReferralTruthStatus.HOLD_RETRY,
            evidence_score=score,
            proceed_decision=ProceedDecision.HOLD_RETRY,
            likely_proceedable=likely,
            decision_reason="hold_retry.retryable_transport",
            challenge_count_windowed=challenge_count,
            threshold_version=THRESHOLD_VERSION,
            last_evidence_at=_utc_now(),
            last_retry_after=retry_after,
        )

    return ReferralTruthSnapshot(
        truth_status=ReferralTruthStatus.HOLD_REVIEW,
        evidence_score=score,
        proceed_decision=ProceedDecision.HOLD_REVIEW,
        likely_proceedable=likely,
        decision_reason="hold_review.insufficient_evidence",
        challenge_count_windowed=challenge_count,
        threshold_version=THRESHOLD_VERSION,
        last_evidence_at=_utc_now(),
        last_retry_after=retry_after,
    )
```

Add the supporting helpers below it:

```python
def _count_recent_challenges(
    existing_evidence: list[ReferralEvidenceInput],
    new_evidence: list[ReferralEvidenceInput],
) -> int:
    cutoff = datetime.now(UTC) - CHALLENGE_WINDOW
    total = 0
    for item in [*existing_evidence, *new_evidence]:
        if item.reason_code != "hold_retry.cloudflare_challenge":
            continue
        observed_at = (item.payload or {}).get("observed_at")
        if observed_at is None:
            total += 1
            continue
        if datetime.fromisoformat(observed_at) >= cutoff:
            total += 1
    return total


def _is_hard_proceed_probe(evidence: list[ReferralEvidenceInput]) -> bool:
    has_positive = any(item.reason_code in {"proceed.accept_cta", "proceed.known_redeem_redirect"} for item in evidence)
    has_blocker = any(item.polarity in {"dead", "negative"} and item.reason_code == "hold_retry.cloudflare_challenge" for item in evidence)
    return has_positive and not has_blocker


def _has_dead_evidence(evidence: list[ReferralEvidenceInput]) -> bool:
    return any(item.polarity == "dead" or item.hard_fail for item in evidence)
```

- [ ] **Step 6: Thread the new snapshot fields into `_build_result()` and `_validation_record()`**

Update these exact return blocks in `src/claude_sessions/referrals/verification.py`:

```python
return ValidationResult(
    code=code,
    url=url,
    status=_legacy_status_for_snapshot(store, code=code, snapshot=snapshot, current_evidence=evidence_inputs),
    reason=reason,
    response_status_code=response_status_code,
    challenge_detected=challenge_detected,
    body_preview=body_preview,
    truth_status=snapshot.truth_status,
    proceed_decision=snapshot.proceed_decision,
    likely_proceedable=snapshot.likely_proceedable,
    decision_reason=snapshot.decision_reason,
    challenge_count_windowed=snapshot.challenge_count_windowed,
    evidence_score=snapshot.evidence_score,
    threshold_version=snapshot.threshold_version,
    retry_after=snapshot.last_retry_after,
    evidence_inputs=tuple(evidence_inputs),
)
```

```python
return ReferralRecord(
    code=result.code,
    url=result.url,
    status=result.status,
    source_doc="referrals.verification",
    source_section="verify_referral",
    notes=result.reason,
    truth_status=snapshot.truth_status,
    evidence_score=snapshot.evidence_score,
    proceed_decision=snapshot.proceed_decision,
    likely_proceedable=snapshot.likely_proceedable,
    decision_reason=snapshot.decision_reason,
    challenge_count_windowed=snapshot.challenge_count_windowed,
    threshold_version=snapshot.threshold_version,
    last_evidence_at=snapshot.last_evidence_at,
    last_retry_after=snapshot.last_retry_after,
)
```

- [ ] **Step 7: Run the focused verification tests to confirm the new deterministic derivation passes**

Run:

```bash
uv run pytest \
  tests/test_referrals.py::test_verify_referral_sets_likely_proceedable_without_unlocking_auth \
  tests/test_referrals.py::test_verify_referral_escalates_third_challenge_to_hold_review \
  tests/test_referrals.py::test_verify_referral_preserves_proceed_until_dead_marker_arrives \
  tests/test_referrals.py::test_verify_referral_dead_marker_overrides_positive_evidence -v
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/claude_sessions/referrals/verification.py src/claude_sessions/referrals/models.py tests/test_referrals.py
git commit -m "feat: derive referral truth deterministically"
```

### Task 3: Persist validation atomically and restrict retries to hold states

**Files:**
- Modify: `src/claude_sessions/referrals/store.py`
- Modify: `src/claude_sessions/referrals/verification.py`
- Test: `tests/test_referrals.py`

- [ ] **Step 1: Write the failing persistence and retry-gate tests**

Add these tests to `tests/test_referrals.py`:

```python
def test_validation_attempt_persists_decision_fields(tmp_path: Path):
    store = ReferralStore(tmp_path / "referrals.db")
    store.upsert_referral(
        ReferralRecord(
            code="ATTEMPT01",
            url="https://claude.ai/referral/ATTEMPT01",
            status=ReferralStatus.DISCOVERED,
            source_doc="pytest",
        )
    )

    verify_referral_code(
        "ATTEMPT01",
        store=store,
        fetcher=lambda _: TransportResponse(
            status_code=200,
            text="Referral invite for code ATTEMPT01",
            headers={"content-type": "text/html"},
            challenge=ChallengeDetection(detected=False, confidence=0.0, reasons=()),
        ),
    )

    attempt = store.list_validation_attempts(code="ATTEMPT01", limit=1)[0]
    assert attempt["decision_reason"] == "hold_review.insufficient_evidence"
    assert attempt["likely_proceedable"] == 1
    assert attempt["challenge_count_windowed"] == 0


def test_retry_referral_rejects_proceed_and_dead_rows(tmp_path: Path):
    store = ReferralStore(tmp_path / "referrals.db")
    store.upsert_referral(
        ReferralRecord(
            code="PROCEED02",
            url="https://claude.ai/referral/PROCEED02",
            status=ReferralStatus.VALID,
            source_doc="pytest",
            truth_status=ReferralTruthStatus.PROCEED,
            proceed_decision=ProceedDecision.PROCEED,
            decision_reason="proceed.accept_cta",
        )
    )
    store.upsert_referral(
        ReferralRecord(
            code="DEAD0001",
            url="https://claude.ai/referral/DEAD0001",
            status=ReferralStatus.INVALID_CONSUMED,
            source_doc="pytest",
            truth_status=ReferralTruthStatus.DEAD,
            proceed_decision=ProceedDecision.DEAD,
            decision_reason="dead.consumed",
        )
    )

    with pytest.raises(ValueError, match="only hold referrals can be retried"):
        store.retry_referral("PROCEED02")

    with pytest.raises(ValueError, match="only hold referrals can be retried"):
        store.retry_referral("DEAD0001")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
uv run pytest \
  tests/test_referrals.py::test_validation_attempt_persists_decision_fields \
  tests/test_referrals.py::test_retry_referral_rejects_proceed_and_dead_rows -v
```

Expected: FAIL because validation attempts do not store the new summary fields and `retry_referral()` currently resets every referral back to `discovered`.

- [ ] **Step 3: Add an atomic validation persistence helper in the store**

In `src/claude_sessions/referrals/store.py`, add a new method that uses one SQLite transaction for referral summary, validation attempt, and evidence writes:

```python
def persist_validation_outcome(
    self,
    *,
    result: ValidationResult,
    response_headers: dict[str, Any] | None,
) -> None:
    now = _utc_now()
    snapshot = ReferralTruthSnapshot(
        truth_status=result.truth_status,
        evidence_score=result.evidence_score,
        proceed_decision=result.proceed_decision,
        likely_proceedable=result.likely_proceedable,
        decision_reason=result.decision_reason,
        challenge_count_windowed=result.challenge_count_windowed,
        threshold_version=result.threshold_version,
        last_evidence_at=now,
        last_retry_after=result.retry_after,
    )
    record = _validation_record(result, snapshot)

    with self._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        self._upsert_referral_conn(conn, record=record)
        self._record_validation_attempt_conn(
            conn,
            code=result.code,
            resulting_status=result.status,
            reason=result.reason,
            response_status_code=result.response_status_code,
            challenge_detected=result.challenge_detected,
            response_headers=response_headers,
            body_preview=result.body_preview,
            attempt_class="verification",
            derived_weight=sum(item.weight for item in result.evidence_inputs),
            retry_after=result.retry_after,
            decision_reason=result.decision_reason,
            likely_proceedable=result.likely_proceedable,
            challenge_count_windowed=result.challenge_count_windowed,
            threshold_version=result.threshold_version,
            now=now,
        )
        self._record_referral_evidence_conn(
            conn,
            code=result.code,
            evidence=list(result.evidence_inputs),
            snapshot=snapshot,
            now=now,
        )
```

Extract the SQL bodies of `upsert_referral()`, `record_validation_attempt()`, and `record_referral_evidence()` into private `*_conn` helpers so both the public methods and the atomic helper reuse the same statements.

- [ ] **Step 4: Persist the new validation-attempt columns and tighten retry eligibility**

Update `src/claude_sessions/referrals/store.py` with these exact SQL changes:

```python
INSERT INTO validation_attempts(
    code,
    resulting_status,
    reason,
    response_status_code,
    challenge_detected,
    response_headers_json,
    body_preview,
    attempt_class,
    derived_weight,
    retry_after,
    decision_reason,
    likely_proceedable,
    challenge_count_windowed,
    threshold_version,
    created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

```python
SELECT
    id,
    code,
    resulting_status,
    reason,
    response_status_code,
    challenge_detected,
    response_headers_json,
    body_preview,
    attempt_class,
    derived_weight,
    retry_after,
    decision_reason,
    likely_proceedable,
    challenge_count_windowed,
    threshold_version,
    created_at
FROM validation_attempts
```

Then gate retries like this:

```python
def retry_referral(self, code: str, *, notes: str | None = None) -> dict[str, Any]:
    existing = self.get_referral(code)
    if existing is None:
        raise ValueError(f"Unknown referral code: {code}")
    if existing["truth_status"] not in {
        ReferralTruthStatus.UNKNOWN.value,
        ReferralTruthStatus.HOLD_RETRY.value,
        ReferralTruthStatus.HOLD_REVIEW.value,
    }:
        raise ValueError(f"Referral {code} cannot be retried; only hold referrals can be retried")

    snapshot = _legacy_truth_snapshot(ReferralStatus.DISCOVERED)
    self.upsert_referral(
        ReferralRecord(
            code=code,
            url=existing["url"],
            status=ReferralStatus.DISCOVERED,
            source_doc="operator.retry",
            source_section="retry_referral",
            notes=notes or "Manually requeued for another verification attempt",
            truth_status=snapshot.truth_status,
            evidence_score=snapshot.evidence_score,
            proceed_decision=snapshot.proceed_decision,
            likely_proceedable=False,
            decision_reason="hold_review.insufficient_evidence",
            challenge_count_windowed=0,
            threshold_version=snapshot.threshold_version,
            last_evidence_at=snapshot.last_evidence_at,
            last_retry_after=snapshot.last_retry_after,
        )
    )
    updated = self.get_referral(code)
    if updated is None:
        raise ValueError(f"Unknown referral code: {code}")
    return updated
```

- [ ] **Step 5: Switch verification over to atomic persistence**

In `src/claude_sessions/referrals/verification.py`, replace `_persist_validation_result()` with this exact call:

```python
def _persist_validation_result(
    store: ReferralStore,
    result: ValidationResult,
    *,
    response_headers: dict[str, object] | None,
) -> None:
    store.persist_validation_outcome(
        result=result,
        response_headers=dict(response_headers) if response_headers is not None else None,
    )
```

- [ ] **Step 6: Run the focused persistence tests to verify the atomic write path and retry guard pass**

Run:

```bash
uv run pytest \
  tests/test_referrals.py::test_validation_attempt_persists_decision_fields \
  tests/test_referrals.py::test_retry_referral_rejects_proceed_and_dead_rows \
  tests/test_referrals.py::test_create_auth_run_rejects_non_proceed_referral -v
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/claude_sessions/referrals/store.py src/claude_sessions/referrals/verification.py tests/test_referrals.py
git commit -m "feat: persist referral validations atomically"
```

### Task 4: Expose deterministic truth fields in the CLI and web UI

**Files:**
- Modify: `src/claude_sessions/cli.py`
- Modify: `src/claude_sessions/web.py`
- Modify: `src/claude_sessions/templates/index.html`
- Test: `tests/test_cli.py`
- Test: `tests/test_web.py`

- [ ] **Step 1: Write the failing CLI and web tests**

Add this CLI test to `tests/test_cli.py`:

```python
def test_referral_verify_outputs_determinism_fields(monkeypatch):
    monkeypatch.setattr(
        cli_module,
        "verify_referral_code",
        lambda code, store=None: ValidationResult(
            code=code,
            url=f"https://claude.ai/referral/{code}",
            status=cli_module.ReferralStatus.AMBIGUOUS,
            reason="invite_semantics_detected",
            response_status_code=200,
            challenge_detected=False,
            body_preview="Referral invite",
            truth_status=cli_module.ReferralTruthStatus.HOLD_REVIEW,
            proceed_decision=cli_module.ProceedDecision.HOLD_REVIEW,
            likely_proceedable=True,
            decision_reason="hold_review.insufficient_evidence",
            challenge_count_windowed=0,
            evidence_score=4,
        ),
    )

    result = runner.invoke(cli_module.app, ["referral-verify", "LIKELY003"])

    assert result.exit_code == 0
    assert '"likely_proceedable": true' in result.output
    assert '"decision_reason": "hold_review.insufficient_evidence"' in result.output
    assert '"challenge_count_windowed": 0' in result.output
```

At the top of `tests/test_cli.py`, add these imports next to the existing imports:

```python
from claude_sessions.referrals.models import ProceedDecision, ReferralTruthStatus
from claude_sessions.referrals.verification import ValidationResult
```

Then add this web test to `tests/test_web.py`:

```python
def test_referral_verify_endpoint_renders_deterministic_summary(monkeypatch):
    monkeypatch.setattr("claude_sessions.web.discover_profiles", lambda: [])
    monkeypatch.setattr(
        "claude_sessions.web.verify_referral_code",
        lambda code, store=None: ValidationResult(
            code=code,
            url=f"https://claude.ai/referral/{code}",
            status=ReferralStatus.AMBIGUOUS,
            reason="invite_semantics_detected",
            response_status_code=200,
            challenge_detected=False,
            body_preview="Referral invite",
            truth_status=ReferralTruthStatus.HOLD_REVIEW,
            proceed_decision=ProceedDecision.HOLD_REVIEW,
            likely_proceedable=True,
            decision_reason="hold_review.insufficient_evidence",
            challenge_count_windowed=0,
            evidence_score=4,
        ),
    )

    response = TestClient(app).get("/referrals/verify", params={"code": "LIKELY003"})

    assert response.status_code == 200
    assert "Referral LIKELY003 decision HOLD_REVIEW" in response.text
    assert "hold_review.insufficient_evidence" in response.text
    assert "likely proceedable: yes" in response.text.lower()
```

At the top of `tests/test_web.py`, extend the imports like this:

```python
from claude_sessions.referrals.models import ProceedDecision, ReferralStatus, ReferralTruthStatus
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
uv run pytest tests/test_cli.py::test_referral_verify_outputs_determinism_fields tests/test_web.py::test_referral_verify_endpoint_renders_deterministic_summary -v
```

Expected: FAIL because the CLI module does not import the truth enums yet and the web template/message do not render the new summary fields.

- [ ] **Step 3: Add truth-filter and truth-enum imports to the CLI**

Update the CLI imports and the `referral-list` command in `src/claude_sessions/cli.py` like this:

```python
from claude_sessions.referrals.models import ProceedDecision, ReferralStatus, ReferralTruthStatus
```

```python
@app.command("referral-list")
def referral_list_command(
    limit: int = 25,
    status: str | None = None,
    truth_status: str | None = None,
    proceed_decision: str | None = None,
) -> None:
    """List persisted referral candidates and outcomes."""
    parsed_status = ReferralStatus(status) if status else None
    parsed_truth_status = ReferralTruthStatus(truth_status) if truth_status else None
    parsed_proceed_decision = ProceedDecision(proceed_decision) if proceed_decision else None
    typer.echo(
        json.dumps(
            ReferralStore().list_referrals(
                limit=limit,
                status=parsed_status,
                truth_status=parsed_truth_status,
                proceed_decision=parsed_proceed_decision,
            ),
            indent=2,
        )
    )
```

`referral-verify` can keep using `result.as_dict()`; once Task 2 lands, the new fields will already appear.

- [ ] **Step 4: Render deterministic truth summaries in the web endpoint and template**

Update the `/referrals/verify` success message in `src/claude_sessions/web.py` to this exact string:

```python
"message": (
    f"Referral {code} decision {result.proceed_decision.value} "
    f"({result.decision_reason}); likely proceedable: {'yes' if result.likely_proceedable else 'no'}."
),
```

Then update the referral list in `src/claude_sessions/templates/index.html` to render the new summary fields and only offer retry for hold states:

```jinja2
{% if recent_referrals %}
  <h2>Recent referral states</h2>
  <ul>
    {% for referral in recent_referrals %}
      <li>
        <strong>{{ referral.code }}</strong>
        — truth {{ referral.truth_status }}
        · proceed {{ referral.proceed_decision }}
        · likely {{ "yes" if referral.likely_proceedable else "no" }}
        · reason {{ referral.decision_reason }}
        · challenges {{ referral.challenge_count_windowed }}
        {% if referral.source_doc %}· {{ referral.source_doc }}{% endif %}
        {% if referral.url %}· <a href="/referrals/verify?code={{ referral.code }}">verify now</a>{% endif %}
        {% if referral.truth_status in ["unknown", "hold_retry", "hold_review"] %}
          · <a href="/referrals/retry?code={{ referral.code }}">requeue</a>
        {% endif %}
      </li>
    {% endfor %}
  </ul>
{% endif %}
```

Also expand the summary list above it to include the existing truth/proceed counts already returned by `ReferralStore.summary()`:

```jinja2
{% if referral_summary and referral_summary.truth_counts %}
  {% for status, count in referral_summary.truth_counts.items() %}
    <li>truth {{ status }}: {{ count }}</li>
  {% endfor %}
{% endif %}
{% if referral_summary and referral_summary.proceed_counts %}
  {% for status, count in referral_summary.proceed_counts.items() %}
    <li>decision {{ status }}: {{ count }}</li>
  {% endfor %}
{% endif %}
```

- [ ] **Step 5: Run the CLI and web tests to verify the new deterministic surfaces pass**

Run:

```bash
uv run pytest \
  tests/test_cli.py::test_referral_verify_outputs_determinism_fields \
  tests/test_web.py::test_referral_verify_endpoint_renders_deterministic_summary \
  tests/test_web.py::test_referral_retry_endpoint_renders_message -v
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/claude_sessions/cli.py src/claude_sessions/web.py src/claude_sessions/templates/index.html tests/test_cli.py tests/test_web.py
git commit -m "feat: expose deterministic referral truth in operator surfaces"
```

### Task 5: Run the full referral regression slice and clean up any mismatched expectations

**Files:**
- Modify as needed: `tests/test_referrals.py`
- Modify as needed: `tests/test_cli.py`
- Modify as needed: `tests/test_web.py`

- [ ] **Step 1: Run the focused regression suite**

Run:

```bash
uv run pytest tests/test_referrals.py tests/test_cli.py tests/test_web.py -v
```

Expected: one of two outcomes:
- PASS if all referral-related expectations now match the deterministic behavior, or
- FAIL only in tests whose old assumptions still expect score-only truth derivation or unconditional retry links.

- [ ] **Step 2: If any old assertions still expect the pre-deterministic behavior, update them to the new contracts**

Use these exact assertion patterns when fixing any remaining mismatches:

```python
assert result.proceed_decision == ProceedDecision.HOLD_REVIEW
assert result.decision_reason == "hold_review.insufficient_evidence"
assert result.likely_proceedable is True
```

```python
assert "requeue" not in response.text if "dead" in response.text.lower() else True
```

```python
assert store.get_referral("PROCEED01")["proceed_decision"] == ProceedDecision.PROCEED.value
```

Only change tests whose assumptions are genuinely outdated. Do not relax assertions.

- [ ] **Step 3: Re-run the full focused regression suite until it is green**

Run:

```bash
uv run pytest tests/test_referrals.py tests/test_cli.py tests/test_web.py -v
```

Expected: PASS.

- [ ] **Step 4: Run one final targeted verification command for completion evidence**

Run:

```bash
uv run pytest \
  tests/test_referrals.py::test_verify_referral_escalates_third_challenge_to_hold_review \
  tests/test_referrals.py::test_verify_referral_preserves_proceed_until_dead_marker_arrives \
  tests/test_referrals.py::test_retry_referral_rejects_proceed_and_dead_rows \
  tests/test_cli.py::test_referral_verify_outputs_determinism_fields \
  tests/test_web.py::test_referral_verify_endpoint_renders_deterministic_summary -v
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add tests/test_referrals.py tests/test_cli.py tests/test_web.py
git commit -m "test: verify deterministic referral truth regression slice"
```

## Spec coverage check

- Two-tier truth model (`likely_proceedable` informational, hard `PROCEED` authoritative): Tasks 1-2
- Sticky `DEAD`: Task 2 tests and derivation helper
- Durable `PROCEED`: Task 2 durable-proceed test and derivation helper
- Challenge escalation: Task 2 challenge-count logic and tests
- Atomic persistence + replayable ledger: Task 3
- Retry blocked for `DEAD` / `PROCEED`: Task 3
- CLI/web visibility for deterministic truth: Task 4
- Regression evidence: Task 5

## Placeholder scan

- No `TODO`, `TBD`, or "implement later" placeholders remain.
- All steps include exact file paths, commands, and code snippets.
- Later task names and field names are consistent with earlier tasks:
  - `likely_proceedable`
  - `decision_reason`
  - `challenge_count_windowed`
  - `proceed_decision`
  - `persist_validation_outcome`

## Type consistency check

- `ReferralTruthSnapshot`, `ReferralRecord`, and `ValidationResult` all use the same deterministic summary field names.
- CLI and web tests refer to `ProceedDecision` and `ReferralTruthStatus`, matching the model names used in code tasks.
- Store helpers use the same column names proposed in Task 1 and read in Tasks 3-4.
