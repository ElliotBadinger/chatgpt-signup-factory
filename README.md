# Deterministic AgentMail Browserless Pipeline

This repository contains the canonical runtime and test tree for the deterministic AgentMail guardrail pipeline.

## Purpose

- Run deterministic inbox/bootstrap/rotation flows using AgentMail + browserless tooling.
- Preserve guardrail behavior (`check-archive-replace`, status snapshots, auth-trace artifacts).
- Keep operational provenance in `docs/` while keeping active runtime code under `src/`.

## Repository layout

- `src/` — runtime pipeline and CLI entrypoints.
- `tests/` — Jest coverage for pipeline, CLI, and guardrail behavior.
- `docs/` — runbooks, plans, and architecture/progress documentation.
- `docs/recovery/` — recovered provenance/manifests moved out of active runtime source.
- `scripts/` — small repository utility scripts.

## Setup

```bash
npm install
```

## Deterministic command entrypoints

```bash
npm test
npm run smoke:status
npm run pipeline:bootstrap -- --manifest ./path/to/bootstrap-manifest.json
npm run pipeline:consume -- --manifest ./path/to/consume-manifest.json
npm run pipeline:rotate -- --state-dir ./state
npm run pipeline:check-archive-replace -- --state-dir ./state
npm run pipeline:agentmail-signup -- --help
npm run pipeline:agentmail-verify -- --help
npm run pipeline:auth-trace -- --help
```

## Guardrail notes

- Live/browser actions require valid environment state (for example browser endpoint, AgentMail credentials, and expected state files).
- `pipeline:check-archive-replace` is the primary guardrail command for deterministic replacement behavior.
- Recovery provenance has been retained in `docs/recovery/` instead of root runtime paths.
