# Owned OAuth / durable alias / codex-lb overlay recovery

Recovered April durability overlay for the deterministic AgentMail/Codex browserless rotation pipeline.

Key themes recovered here:
- OpenAI owned-OAuth / PKCE token acquisition with refresh-token preservation.
- Workspace-aware OAuth session selection and mismatch fail-closed behavior.
- Pi account-router onboarding requiring durable refresh-bearing auth.
- codex-lb lifecycle / append-only router integration hooks via router onboarding.
- Billing-boundary probe module referenced by recovered router onboarding.
- AgentMail OTP helper version exporting `waitForInboundOtp` used by owned OAuth.

This package is an overlay over `final-consolidated-browserless-pipeline-recovery`, not a standalone repo. It was not copied into the live restored worktree.

Verification performed:
- `node --check` on all files in this package: all OK; see `NODE_CHECK_RESULTS.txt`.
- Isolated hardlinked verification copy was created at the path recorded in `_evidence/latest-isolated-verification-dir.txt`; targeted syntax passed. Broader Jest against a partial overlay exposed remaining dependency/version skew, so this is source recovery evidence, not a full green integration proof.

Caveat:
- This strengthens source recovery but does not prove full unattended live pipeline readiness. Full runtime still depends on installing a coherent recovered source set and resolving remaining golden sentinel template gaps.
