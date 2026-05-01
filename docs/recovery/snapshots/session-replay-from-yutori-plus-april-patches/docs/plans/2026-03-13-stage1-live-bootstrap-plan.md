# Stage 1 live bootstrap plan

## Objective
Wire `runBootstrap` to real Stage 1 hooks that can deterministically:
1. verify mailbox authority for distinct `@epistemophile.space` roots,
2. create or recover AgentMail controller accounts,
3. capture and verify API keys,
4. optionally create inboxes,
5. persist evidence, summaries, and handoff artifacts.

## Root-cause findings from investigation
- Gmail/googlemail aliases are not safe for fresh signup because Clerk canonicalizes them and reports `already in use` while reset paths are contradictory.
- Fresh distinct `@epistemophile.space` roots are the intended path.
- Cloudflare routing must be treated as the mailbox authority layer and verified independently from AgentMail.
- Existing `.env` credentials currently fail direct API probes in this session (`AgentMail 403`, `Cloudflare 401`), so the live pipeline must record exact probe failures and support credential/source overrides instead of assuming one happy-path token.
- Prior experiments already contain the workable mechanics for:
  - Cloudflare catch-all forwarding to an AgentMail inbox,
  - OTP polling from AgentMail message APIs,
  - Clerk/AgentMail browser flows under real Chrome.

## Implementation approach
1. Add a dedicated Stage 1 live-hooks module.
2. Define explicit dependencies for network probes, browser execution, OTP polling, and artifact writing so tests can inject fakes.
3. Extend bootstrap metadata persistence to include evidence references and controller details without breaking existing tests.
4. Add failing tests for:
   - live hook order and persisted metadata,
   - API verification failure classification,
   - evidence file emission,
   - CLI manifest/env-driven live config resolution.
5. Implement the minimal production code to satisfy tests.
6. After tests pass, run live bootstrap from the worktree with real Chrome/Xvfb and collect proof for at least three roots.

## Notes
- Keep raw secrets out of committed artifacts; store references, prefixes, and redacted values only.
- Failures must remain stage-localized and resumable.
- Real browser automation will be driven through an adapter boundary so the deterministic pipeline state model stays testable.
