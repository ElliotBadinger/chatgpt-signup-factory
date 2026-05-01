# Browserless workspace onboarding notes

Date: 2026-03-17

## Decisive production findings

See artifact:
`artifacts/workspace-replays/2026-03-17T03-24-14Z-browserless-invite-accept-proof/browserless-invite-accept-proof.json`

Confirmed live against the active Root-Mail_a workspace:

- Invite email format is:
  - `https://chatgpt.com/auth/login?inv_ws_name=<name>&inv_email=<email>&wId=<workspaceId>&accept_wId=<workspaceId>`
- Current production invite acceptance endpoint is:
  - `POST /backend-api/accounts/{workspaceId}/invites/accept`
  - body: `{ "email": "<inviteeEmail>" }`
  - observed live status: `200 {"success":true}`
- The older fallback path is stale:
  - `POST /backend-api/accounts/{workspaceId}/join`
  - observed live status: `404 {"detail":"Not Found"}`
- `POST https://auth.openai.com/api/accounts/workspace/select` is real, but it is **not** a standalone post-join API:
  - observed live status outside a valid auth step: `409 invalid_state`
  - this means it belongs to the auth.openai workspace-selection step, not the direct invite-accept step.

## Important behavioral detail

After `invites/accept` succeeds:

- `GET /backend-api/accounts` immediately shows the workspace for the joined user.
- `GET /backend-api/accounts/{workspaceId}/users` works with the joined user's bearer token **when** `ChatGPT-Account-ID` is set to the workspace id.
- Owner-side `GET /backend-api/accounts/{workspaceId}/users` confirms the new member.

This is sufficient for Pi registration with:

- access token from `GET /api/auth/session`
- `accountId = workspaceId`

Even if the session JSON still reports the personal account as the default account.

## Code path introduced

New browserless modules:

- `src/pipeline/rotation/browserlessWorkspaceClient.js`
- `src/pipeline/rotation/browserlessMemberOnboarder.js`

Integration points:

- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/cli/pipeline-check-archive-replace.js`

These changes keep post-auth workspace join and router registration browserless while preserving the existing local-file Pi registrar.

## Runtime placement and verification notes

The production browserless fleet path now threads placement context through runtime onboarding:

- exhausted alias lineage/workspace context is derived inside `checkArchiveAndReplaceExhausted.js`
- `routerOnboarder.js` forwards placement context into browserless onboarding
- `browserlessMemberOnboarder.js` selects or validates the exact target workspace from that context
- `pipeline-check-archive-replace.js` resolves invite/list/remove operations against the selected workspace when placement context is present

Strict replacement verification is also enforced in the runtime path:

- `src/pipeline/rotation/verifyRecoveredAlias.js` is the default verifier
- `src/pipeline/rotation/runtimeAliasProbe.js` provides the CLI/runtime browserless probe hook
- the CLI passes that probe into `runCheckArchiveAndReplace()`
- if the runtime probe is missing or fails, replacement verification fails closed and the replacement is rolled back

Quota policy is grouped per workspace/lineage, not fleet-global:

- live audit aliases carry `workspaceGroupKey`
- `checkArchiveAndReplaceExhausted.js` computes `summary.quotaPolicy.groups`
- five-hour-only defer/reinstatement and standby prewarm actions apply only inside the affected group
