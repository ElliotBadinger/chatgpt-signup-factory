# Deterministic AgentMail / Guardrail Pipeline

This pipeline is a two-stage, file-backed workflow for repeating the proven bootstrap → inbox → invite → onboarding → proof flow while preserving exact evidence and direct-command handoff artifacts.

## Stages

### Stage 1: Bootstrap controllers
Creates or resumes AgentMail controller roots from distinct mailbox authorities.

Responsibilities:
- normalize candidate root emails
- verify mailbox authority
- create or recover AgentMail controller accounts
- capture API keys
- create inboxes
- persist controller records and bootstrap events
- emit handoff bundles for incomplete bootstrap cases

Primary entrypoint:
- `node src/cli/pipeline-bootstrap.js --manifest state/examples/bootstrap-manifest.json --dry-run`

Direct flags:
- `--root <email>` (repeatable)
- `--state-dir <dir>`
- `--artifact-dir <dir>`
- `--manifest <path>`
- `--dry-run`

### Stage 2: Consume targets
Consumes fresh or resumed targets using deterministic target/inviter selection.

Responsibilities:
- pick resumable targets first, then fresh pending targets
- pick next inviter deterministically
- stop cleanly on workspace hard-cap observations
- issue invites
- poll mailbox
- run onboarding
- collect proof
- persist target transitions and emit handoff bundles

Primary entrypoint:
- `node src/cli/pipeline-consume.js --manifest state/examples/consume-manifest.json`

Direct flags:
- `--state-dir <dir>`
- `--artifact-dir <dir>`
- `--manifest <path>`
- `--resume <run-id>`

## Resume flow
The pipeline is designed to resume from persisted state rather than replaying the full flow.

Bootstrap resume rules:
- already-complete controllers are skipped
- incomplete bootstrap records can emit a fresh `handoff.md` and `commands.sh`
- failed bootstrap attempts preserve exact blocker text and a fresh resume command

Consume resume rules:
- resumable target checkpoints are preferred over new pending targets
- advanced states such as `invite-sent`, `invite-received`, `auth-started`, and `joined` avoid replaying earlier steps
- `proven` targets are not regressed

## State files
Stored under the pipeline state directory:
- `controller_registry.json`
- `target_registry.json`
- `inviter_registry.json`
- `workspace_observations.json`
- `run_history.jsonl`

## Artifact layout
Typical artifact layout under an artifact root:
- `artifacts/bootstrap/<controller-id>/handoff.md`
- `artifacts/bootstrap/<controller-id>/commands.sh`
- `artifacts/bootstrap/<controller-id>/summary.json`
- `artifacts/consume/<target-id>/handoff.md`
- `artifacts/consume/<target-id>/commands.sh`
- `artifacts/consume/<target-id>/summary.json`

## DM-friendly handoff bundles
Each handoff bundle contains:
- exact target and inviter identifiers
- invite link when available
- proof paths
- current status
- copy-pasteable resume command
- copy-pasteable status command
- blocker text and suggested next command for blocked runs

Files:
- `handoff.md`
- `commands.sh`
- `summary.json`

## Status command
Read a quick state summary with:

```bash
node src/cli/pipeline-status.js --state-dir ./state
```

## Known blockers
Known blockers should be preserved as state, not improvised away. Example:
- universal workspace seat cap observations such as `seats_in_use=10`

When a universal hard cap is active, fresh target consumption should block unless explicitly overridden by later orchestration policy.

## Example workflow

### Bootstrap dry run
```bash
node src/cli/pipeline-bootstrap.js --manifest state/examples/bootstrap-manifest.json --dry-run
```

### Consume run
```bash
node src/cli/pipeline-consume.js --manifest state/examples/consume-manifest.json
```

### Print handoff bundle
```bash
node src/cli/pipeline-handoff.js --artifact-dir ./artifacts/consume/example-target
```

### Rewrite command bundle
```bash
node src/cli/pipeline-handoff.js \
  --artifact-dir ./artifacts/consume/example-target \
  --rewrite-commands \
  --resume-command "node src/cli/pipeline-consume.js --resume example-run" \
  --status-command "node src/cli/pipeline-status.js --state-dir ./state"
```
