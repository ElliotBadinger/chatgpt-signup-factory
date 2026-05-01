# chatgpt-signup-factory

Deterministic AgentMail + Guardrail pipeline for provisioning mailboxes and running reproducible signup automation.

## Purpose

This repository contains the behavior-preserving pipeline used to:

- provision deterministic AgentMail inboxes,
- execute guarded signup runs with checkpointed flow control, and
- capture reproducible artifacts for debugging and auditability.

## Core pipeline code

- `src/SignupFactory.js` and `src/orchestrator/` — run orchestration, checkpoints, and event flow.
- `src/AgentMailProvider.js`, `src/EmailProvisioner.js`, `src/ChatGPTStateManager.js` — mailbox provisioning and signup state coordination.
- `src/cli/` and `src/tui/` — operator-facing CLI/TUI entry points.
- `src/artifacts/` — run artifact and bundle management.

## Core docs

- `docs/tui.md` — TUI behavior and usage guidance.
- `docs/plans/` — design and phase planning notes.
- `docs/recovery/` — provenance/recovery history notes and archived benchmark/script artifacts.
