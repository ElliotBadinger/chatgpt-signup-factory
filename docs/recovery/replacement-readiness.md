# Replacement readiness note (cleanup branch checkpoint)

_Last updated (UTC): 2026-05-01T13:12:17Z_

## Purpose / scope of replacement

This checkpoint documents readiness to replace `main` with the cleanup branch while preserving rollback safety.

Scope in this checkpoint is **docs/process only**:

- record the active replacement candidate branch + commit,
- document backup refs currently available for rollback,
- capture the latest canonical verification results, and
- spell out exact replacement/rollback commands for operators.

No branch replacement is executed in this checkpoint.

## Active replacement branch and current HEAD

- Repository: `ElliotBadinger/chatgpt-signup-factory`
- Replacement branch: `agentmail-cleanup-20260501-115121`
- Current HEAD: `0b370bd6d13dd025b19dc6a28648f8f68684ecdf`

## Backup refs (commit SHAs)

- `backup/main-20260501-115121` → `717540244a615b6a452bc3b60e1419ae37663191`
- `backup/main-20260501-120749` → `5b49813ba8ce8109b8cc1c57070b554f155a4411`

## Verification commands run + latest results

Commands (from repository root):

```bash
npm ci
npm test
```

Latest checkpoint run window (UTC): `2026-05-01T13:12:07Z` to `2026-05-01T13:12:17Z`

- `npm ci`: **PASS** (`exit 0`)
  - `added 535 packages, and audited 536 packages in 5s`
  - `12 vulnerabilities (1 low, 3 moderate, 7 high, 1 critical)`
- `npm test`: **PASS** (`exit 0`)
  - `Test Suites: 1 skipped, 28 passed, 28 of 29 total`
  - `Tests: 2 skipped, 130 passed, 132 total`
  - `Time: 4.002 s`

## Residual risks / explicitly deferred items

- Replacing `main` requires a force update and should be coordinated around any concurrent pushes.
- This checkpoint reruns only canonical local gate (`npm ci` + `npm test`); it does not validate external deployment/integration systems.
- Branch-protection settings could block planned replacement/rollback commands.
- Executing replacement/rollback remains explicitly deferred to a separate operator step.

## Exact rollback command(s)

Rollback to newest backup ref:

```bash
git fetch origin
git checkout main
git reset --hard backup/main-20260501-120749
git push --force-with-lease origin main
```

Rollback to earlier backup ref (if needed):

```bash
git fetch origin
git checkout main
git reset --hard backup/main-20260501-115121
git push --force-with-lease origin main
```

## Exact replacement command(s) for `main` (planned, not executed)

```bash
git fetch origin
git checkout main
git reset --hard origin/agentmail-cleanup-20260501-115121
git push --force-with-lease origin main
```

Planned only in this checkpoint; **not executed here**.
