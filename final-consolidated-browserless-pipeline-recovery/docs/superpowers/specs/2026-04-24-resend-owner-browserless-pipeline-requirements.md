# Resend Owner Browserless Pipeline Requirements

## Summary

This document is the full requirements handoff for completing the OpenAI Business alias onboarding pipeline. It assumes the next worker has no prior context.

The required system is a fully browserless pipeline that:

1. Authenticates `openai_1@epistemophile.store` as the existing OpenAI Business owner using an email OTP received by Resend.
2. Uses the owner session to discover the OpenAI Business workspace.
3. Allocates a fresh `openai_N@epistemophile.store` alias.
4. Invites that alias into the workspace.
5. Authenticates the alias using an email OTP received by Resend.
6. Accepts the workspace invite through backend API calls.
7. Registers the alias into the local Pi account router.
8. Verifies router/auth state and workspace membership.

## Repository And Runtime

- Worktree:
  `/home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/final-consolidated-browserless-pipeline-recovery`
- Git root:
  `/home/epistemophile/Development/chatgpt-factory-bundle`
- Runtime:
  Node.js ESM project.
- Test runner:
  `npm test -- <tests> --runInBand`
- Package script:
  `npm test` runs Jest through `../../../node_modules/jest/bin/jest.js`.

## Credentials And Secrets

Required secrets already exist locally:

- `/home/epistemophile/Development/chatgpt-factory-bundle/.env`
  - `RESEND_API_KEY`
  - `RESEND_FROM_EMAIL=onboarding@epistemophile.store`

Do not print secrets. Do not write API keys, bearer tokens, cookies, access tokens, refresh tokens, or full JWTs into docs, logs, or final responses.

## Email Domain

- Domain:
  `epistemophile.store`
- Receiving provider:
  Resend receiving.
- Sender configured for notifications:
  `onboarding@epistemophile.store`
- Owner:
  `openai_1@epistemophile.store`
- Alias format:
  `openai_N@epistemophile.store`

The user explicitly rejected Cloudflare and AgentMail for receiving in this flow. AgentMail code can remain for other flows, but this flow must use Resend for `@epistemophile.store`.

## Existing Known Mail State

Prior live checks showed Resend receiving contained OpenAI OTP and invite emails for:

- `openai_1@epistemophile.store`
- `openai_2@epistemophile.store`
- `openai_3@epistemophile.store`
- `openai_4@epistemophile.store`

The next worker must re-check current state because received mail and provider state are time-sensitive.

## Local Codex/Network State

The previous session found that the tool sandbox had no network access because it was launched under `bwrap --unshare-net`. That was not a Resend/OpenAI bug.

User-level wrapper changes were made outside Codex source:

- `/home/epistemophile/bin/codex`
  - unsets `CODEX_SANDBOX_NETWORK_DISABLED`
  - passes `--disable use_linux_sandbox_bwrap`
  - passes `--sandbox danger-full-access`
  - passes `--add-dir /home/epistemophile`
  - passes `--config 'model_provider="codex-lb"'`
- `/home/epistemophile/bin/codex-net`
  - retains the same network/full-access behavior for explicit use.
- `/home/epistemophile/bin/check-codex-network`
  - verifies sockets, DNS, OpenAI/Resend/ChatGPT HTTPS reachability, and Codex LB model list.
- `/home/epistemophile/bin/codex-smoke`
  - verifies the plain `codex` path using `gpt-5.5`.
- `/home/epistemophile/bin/codex-net-smoke`
  - verifies the explicit `codex-net` path using `gpt-5.5`.

The next worker must run from a normal shell, not from an already network-disabled parent sandbox.

## Existing Code Map

### CLI

`src/cli/resend-owner-onboard-alias.js`

Responsibilities:

- Parse CLI args.
- Allocate next alias.
- Optionally dry-run.
- Run network preflight.
- Reuse valid owner auth from `auth.json` if present.
- Otherwise sign owner in with Resend OTP.
- Create owner workspace client.
- Select workspace.
- Create or reuse invite.
- Delegate alias onboarding and router registration.
- Return final JSON.

Important exports:

- `nextAliasEmail()`
- `runResendOwnerOnboardAlias()`

### Resend Receiving

`src/pipeline/authTrace/resendReceiving.js`

Responsibilities:

- Resolve `RESEND_API_KEY`.
- Load nearest `.env` when env is not already set.
- List Resend received emails.
- Retrieve full messages.
- Filter by exact recipient.
- Extract OTP.
- Poll fresh OTP.

Important exports:

- `isResendReceivingAddress()`
- `extractOtpFromResendEmail()`
- `listResendReceivedEmails()`
- `getResendReceivedEmail()`
- `fetchLatestResendReceivedEmail()`
- `pollResendReceivedOtp()`

### Auth Replay

`src/pipeline/authTrace/openaiAuthReplay.js`

Responsibilities:

- Direct HTTP OpenAI auth replay.
- Select Resend OTP provider for `@epistemophile.store`.
- Complete callback and fetch ChatGPT session.
- Report verdicts and steps.

Risk:

- Prior live owner auth attempt reached `/log-in/password` and did not receive a fresh OTP through the guessed endpoint fallback. This is the highest-risk remaining implementation area.

### Member Onboarding

`src/pipeline/rotation/browserlessMemberOnboarder.js`

Responsibilities:

- Authenticate alias.
- Validate session identity.
- Create workspace client.
- Poll invite email.
- Accept invite.
- Verify account and owner membership state.

Important behavior:

- If address is a Resend receiving address, it uses Resend invite polling.
- If address is not a Resend receiving address, it preserves AgentMail behavior.

### Router Onboarding

`src/pipeline/rotation/routerOnboarder.js`

Responsibilities:

- Register alias credentials in Pi auth/router files.
- Verify auth/router invariants.
- Contains legacy browser login helpers.

Requirement:

- The Resend owner pipeline must stay on the browserless branch. Do not use the legacy browser branch as the final solution.

### Workspace Client

`src/pipeline/rotation/browserlessWorkspaceClient.js`

Responsibilities:

- Backend API calls for session, user, accounts, invites, invite acceptance, and workspace users.

## Existing Test Map

Primary tests to preserve and extend:

- `tests/pipeline/authTrace/resendReceiving.test.js`
- `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`
- `tests/pipeline/authTrace/openaiAuthReplay.test.js`
- `tests/pipeline/rotation/browserlessMemberOnboarder.test.js`
- `tests/pipeline/evidence/resendNotifier.test.js`
- `tests/cli/resendOwnerOnboardAlias.test.js`

The full recovered repo test suite is not the right blocker because it contains unrelated stale/mixed tests. Use focused tests around changed files and live verification.

## Success Path In Detail

### Stage 1: Preflight

Run:

```bash
check-codex-network
codex-smoke
```

Success means:

- No `EPERM`.
- DNS resolves.
- HTTPS reaches OpenAI/Resend/ChatGPT.
- Codex LB on `127.0.0.1:2455` returns models including `gpt-5.5`.
- Plain `codex` can run a network command out of the box.

### Stage 2: Resend Sanity

Run a live Resend list probe using `listResendReceivedEmails()`.

Success means:

- Resend API returns messages.
- `@epistemophile.store` recipients are visible.
- No secrets printed.

### Stage 3: Dry Run

Run:

```bash
node src/cli/resend-owner-onboard-alias.js --dry-run
```

Success means:

- CLI resolves owner email.
- CLI allocates a next alias without touching live OpenAI state.

### Stage 4: Owner Auth

Run the owner auth path.

Success means:

- Fresh OTP request is triggered for `openai_1@epistemophile.store`.
- OTP arrives in Resend.
- OTP is submitted through direct HTTP auth replay.
- ChatGPT session endpoint returns `accessToken`.
- Session identity is owner email.

### Stage 5: Workspace Discovery And Invite

Success means:

- Owner `getAccounts()` returns a workspace account.
- Workspace is selected deterministically.
- Existing invite is reused or a new invite is created.
- Invite is for the allocated alias.

### Stage 6: Alias Auth And Invite Acceptance

Success means:

- Alias OTP arrives in Resend.
- Alias session is authenticated.
- Invite email arrives in Resend.
- Invite link parses to the expected alias/workspace.
- `acceptInvite()` succeeds.
- Alias accounts include workspace.
- Owner users include alias.

### Stage 7: Router Registration

Success means:

- Alias appears in `~/.pi/agent/auth.json`.
- Alias appears in `~/.pi/agent/account-router.json`.
- `verifyPiRouterOnboarding()` returns `pass: true`.

## Blockers To Prove Before Stopping

Only stop if one of these is proven with command output:

- Network-disabled shell still returns `EPERM` after using patched `codex` from a normal shell.
- Resend API rejects the configured API key.
- Resend domain receiving is no longer enabled.
- OpenAI no longer sends email OTP for the owner account and no documented/browserless endpoint can trigger it.
- Owner account no longer has owner/workspace access.
- OpenAI backend invite/accept APIs changed and the current client cannot discover the new contract from available responses.

## Things Not To Do

- Do not switch back to Cloudflare receiving.
- Do not switch `@epistemophile.store` aliases to AgentMail receiving.
- Do not use a browser as the final implementation.
- Do not ask the user to manually copy OTPs.
- Do not modify Codex source code.
- Do not reset or overwrite router/auth files.
- Do not claim completion after only dry-run or unit tests.

## Evidence To Leave For The Next Handoff

Record:

- Exact command run.
- Start and end timestamps.
- Alias allocated.
- Workspace selected.
- Resend message ids for OTP/invite, redacted enough to avoid secrets.
- Result JSON.
- Router verification JSON.
- Any failing response status, URL host, and normalized error code.
