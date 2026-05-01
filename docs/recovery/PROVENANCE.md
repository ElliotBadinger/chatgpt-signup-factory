# Recovery provenance note

Files in `docs/recovery/` are provenance artifacts that document recovery and repository-history context.

They are **not** active runtime source code or executable pipeline configuration.

The active runtime source of truth lives in `src/`, root runtime config files, and current scripts referenced by `package.json`.

## Archived provenance artifacts (Phase 2)

- `docs/recovery/test_nav.js`
- `docs/recovery/scripts/benchmark-coldstart-4.sh`
- `docs/recovery/benchmarks/2026-02-04/2026-02-04-coldstart-4runs.md`
- `docs/recovery/benchmarks/2026-02-04/logs/run-*.log`

Removed from active tree:

- `debug_snapshot.txt`

## Relocated recovery snapshots

- `docs/recovery/snapshots/golden-sentinel-json-recovery/` (relocated from repository root `golden-sentinel-json-recovery/`)
- `docs/recovery/snapshots/session-replay-write-edit-reconstructed/` (relocated from repository root `session-replay-write-edit-reconstructed/`)
