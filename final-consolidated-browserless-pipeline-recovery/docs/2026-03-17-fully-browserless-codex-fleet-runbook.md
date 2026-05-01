# Fully browserless Codex fleet runbook

Date: 2026-03-17

## Goals

- keep onboarding/recovery/rotation browserless
- avoid local Chrome fallback in the browserless fleet path
- place replacements with lineage-first workspace selection
- enforce strict live verification before counting replacements as success
- scope quota policy per workspace/lineage group

## Common commands

### Live audit only

```bash
node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js --dry-run
```

This produces:
- grouped browserless live audit output
- grouped quota policy output
- a browserless audit artifact path

### Hybrid audit + remediation

```bash
node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js
```

### Router onboarding for an existing inbox

```bash
node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js \
  --router-onboard-email member@example.com
```

## Workspace selection behavior

Runtime placement is lineage-first:

1. rotation builds placement context from the exhausted alias plus replacement inbox root
2. browserless onboarding selects a workspace from that context
3. invite issue, invite accept, and owner membership verification all use that exact selected workspace
4. if the invite email targets a different workspace than the selected one, onboarding fails closed

If no placement context exists, generic management helpers may still fall back to default workspace resolution, but replacement/onboard runtime flows are context-driven.

## Quota policy behavior

Quota policy is grouped per `workspaceGroupKey` / lineage.

Per group actions:
- `keep`
- `prewarm`
- `supplement-prewarm`
- `replace`

Alias-level quota states:
- `healthy`
- `five-hour-exhausted-only`
- `both-exhausted`
- `low-on-both`
- `exhausted-unknown-window`
- `unknown`

### Five-hour-only policy

If an alias is explicitly `five-hour-exhausted-only` from live quota windows:
- it is archived as `5h-exhausted`
- it is marked `awaitingReinstatement`
- it is not immediately replaced
- prewarm/supplement decisions apply only within that same workspace/lineage group

### Both-exhausted policy

If an alias is `both-exhausted`:
- replacement is allowed
- replacement still must pass strict verification before success is counted

## Strict verification requirements

A replacement is only accepted if all of these pass:
- valid authenticated session/token evidence
- workspace membership confirmation
- router/auth state present after finalize
- runtime browserless live probe passes

### Runtime probe source

Production CLI/runtime uses:
- `src/pipeline/rotation/runtimeAliasProbe.js`

It performs browserless authenticated API checks with the replacement alias bearer token via:
- `GET /backend-api/me`
- `GET /backend-api/accounts`
- optional `GET /backend-api/user_granular_consent`

If this probe is not configured or fails, verification fails closed and the replacement is rolled back.

## Artifacts

Each run writes browserless fleet artifacts under:

- `state/rotation/runs/<timestamp>/summary.json`
- `state/rotation/runs/<timestamp>/browserless-audit.json`

CLI output prints the browserless audit artifact path directly.

## First-batch operating policy

- keep `greasyhands` excluded from the first-batch audit fixture
- treat `nastypolice` as a normal candidate
- do not invent real password-reset endpoints without live evidence
- do not count unverified replacements as success
