# Context

## Purpose

This repository is the deterministic AgentMail pipeline for creating, recovering, rotating, and proving ChatGPT workspace accounts with durable file-backed state and handoff artifacts.

The primary purpose is not to port or operate Yutori Local. Any Yutori-derived recovery material is provenance only unless it directly supports the AgentMail pipeline.

## Domain Terms

### Deterministic AgentMail pipeline

The full workflow that turns mailbox authority into controller roots, inboxes, workspace invitations, onboarding proof, and Pi account-router credentials. The pipeline must be resumable from persisted state and must preserve blockers as evidence.

### Controller root

An AgentMail account that owns API authority for creating or recovering inboxes. Controller roots are tracked in the controller registry and can be resumed instead of recreated.

### Target

A pending, selected, invited, joined, or proven workspace member account that the pipeline is consuming. Targets are tracked in the target registry and should advance through explicit lifecycle states.

### Inviter

A workspace member or owner account that can issue ChatGPT workspace invites for targets. Inviter selection must be deterministic and must respect workspace hard-cap observations.

### Guardrail workspace

The ChatGPT workspace being maintained by the rotation and onboarding flow. The workspace is selected from live account data and placement context, not from hardcoded account IDs.

### Rotation cycle

A complete replacement attempt for an exhausted or unhealthy alias: assess quota, select or create inbox supply, invite/onboard a replacement, verify the replacement, register it, and retire or archive the exhausted alias.

### Handoff bundle

The durable artifact set emitted when a run completes, blocks, or needs manual continuation. A handoff bundle includes the current status, identifiers, proof paths, blocker text, and copy-pasteable resume/status commands.

### Auth trace

Captured browser, network, cookie, and session evidence used to understand or replay OpenAI authentication flows. Auth traces are evidence inputs, not the primary runtime path.

### Recovery evidence

Recovered session logs, patch replays, previous snapshots, and verification archives. Recovery evidence is valuable for auditability but should not sit in the active runtime source tree once the clean repo replacement is prepared.
