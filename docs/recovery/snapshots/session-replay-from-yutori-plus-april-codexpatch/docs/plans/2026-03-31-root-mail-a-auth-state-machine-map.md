# Root-Mail_a Auth State Machine Map

## Scope

This document reconstructs the live onboarding/auth stack for the four existing Root-Mail_a aliases:

- `cruelfigure620@agentmail.to`
- `exciteditem179@agentmail.to`
- `blacktext181@agentmail.to`
- `annoyedcommittee236@agentmail.to`

Target workspace:

- name: `Root-Mail_a`
- id: `d3d588b2-8a74-4acc-aa2e-94662ff0e025`

It is based on current code, tests, live state, and the 2026-03-31 artifacts. The goal is to model the system as a protocol/state machine rather than as "one flow with variants".

## Layer Map

There are four distinct layers.

1. Replay layer
   - file: `src/pipeline/authTrace/openaiAuthReplay.js`
   - job: establish first-layer ChatGPT/auth.openai state and produce a ChatGPT session plus cookies
   - output: `finalCookies`, `chatgpt_session`, branch verdict, typed blocker in some cases

2. Recovery layer
   - file: `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
   - job: retry replay via different auth branches after password-only or OTP failures
   - output: recovered replay auth or terminal blocked/recreate-needed status

3. Workspace onboarding + owned OAuth upgrade layer
   - files:
     - `src/pipeline/rotation/browserlessMemberOnboarder.js`
     - `src/pipeline/authTrace/openaiOwnedOauth.js`
   - job: prove workspace membership/materialization, select workspace session, then upgrade to refresh-bearing auth
   - output: refresh-bearing workspace-bound auth or fail closed

4. Persistence + verification layer
   - files:
     - `src/pipeline/rotation/routerOnboarder.js`
     - `src/pipeline/rotation/piAccountRegistrar.js`
     - `src/pipeline/rotation/verifyRecoveredAlias.js`
   - job: write durable auth/router state, then verify downstream contract
   - output: `auth.json`, `account-router.json`, follow-on verification evidence

## First-Layer Replay Branches

Replay is keyed off the first authorize redirect after bootstrap.

### `existing-login-otp`

- Entry condition: authorize redirect is `/email-verification`.
- Core transitions:
  - `load_email_verification`
  - `email_otp_validate`
  - optional `load_workspace_selection`
  - optional `workspace_select`
  - `chatgpt_callback`
  - `chatgpt_session`
- OTP:
  - required
  - missing OTP throws, it does not become a typed replay blocker
- Output:
  - can produce a workspace-bound ChatGPT session
  - does not itself produce durable refresh-bearing owned OAuth
- Evidence:
  - `src/pipeline/authTrace/openaiAuthReplay.js`
  - `tests/pipeline/authTrace/openaiAuthReplay.test.js`

### `password-login`

- Entry condition: authorize redirect is `/log-in/password` and mode is not `forgot-password`.
- Core sub-branches:
  - direct password continuation if submit returns `continue_url`
  - `forgot-password-required` if password submit returns `next: forgot-password`
  - passwordless fallback from password page:
    - `passwordless_send_otp_from_password`
    - `load_email_verification_from_password`
    - `email_otp_validate_from_password`
    - `chatgpt_callback`
    - `chatgpt_session`
- OTP:
  - optional if direct password continuation works
  - required if passwordless fallback is used
- Typed blockers:
  - `password-login-challenged`
  - `password-login-unsupported`
  - `forgot-password-required`
  - `forgot-password-entry`
  - `passwordless-otp-unsupported`
  - `passwordless-otp-missing`
- Live divergence:
  - direct password submit is not reliable on the current owned OAuth stack
  - live probe observed `404 Invalid URL (POST /password/login)` after `/log-in/password`
- Evidence:
  - `src/pipeline/authTrace/openaiAuthReplay.js`
  - `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`
  - `artifacts/root-mail-a-router-onboarding-20260331/cruelfigure620-owned-oauth-network-probe-2026-03-31T17-03-02.json`

### `forgot-password`

- Entry condition: authorize redirect is `/log-in/password` and mode is `forgot-password`.
- Core transitions:
  - first run password-login with passwordless fallback disabled
  - only continue if result is `forgot-password-required`
  - default reset path:
    - `load_reset_password`
    - `password_reset_send_otp`
    - `load_password_reset_email_verification`
    - `email_otp_validate_password_reset`
    - `load_password_reset_new_password`
    - `complete_password_reset`
    - `chatgpt_callback`
    - `chatgpt_session`
- OTP:
  - required on default reset continuation
- Reset/password endpoints seen live or in code:
  - `/reset-password`
  - `/api/accounts/password/send-otp`
  - `/api/accounts/password/reset`
  - `/api/accounts/password/add`
- Typed blockers:
  - `password-reset-initiation-failed`
  - `password-reset-email-consumption-failed`
  - `password-reset-completion-failed`
  - `password-reset-continuation-missing`
- Live divergence:
  - this branch is real, but continuation is fragile
  - live probes show `password_already_used`, `reset_token_already_used`, and repeated terminal collapse to `password-reset-continuation-missing`
- Evidence:
  - `src/pipeline/authTrace/openaiAuthReplay.js`
  - `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`
  - `artifacts/root-mail-a-router-onboarding-20260331/cruelfigure620-reset-endpoint-probe-2026-03-31T16-14-52-187Z.json`
  - `artifacts/root-mail-a-router-onboarding-20260331/cruelfigure620-forgot-detailed-live-2026-03-31T16-39-34.json`

### `signup-new`

- Entry condition: authorize redirect is `/create-account/password`.
- Core transitions:
  - optional `preload_invite_url`
  - `load_create_account_password`
  - sentinel headers for `/api/accounts/user/register`
  - `user_register`
  - `email_otp_send`
  - `load_email_verification`
  - `email_otp_validate`
  - `load_about_you`
  - sentinel headers for `/api/accounts/create_account`
  - `create_account`
  - optional workspace selection continuation
  - `chatgpt_callback`
  - `chatgpt_session`
- OTP:
  - required
- Typed blocker:
  - `needs-sentinel-provider`
- Root-Mail_a-specific reality:
  - invite preload is necessary for proper workspace materialization
  - fresh invite creation remains upstream-blocked for net-new inboxes
- Evidence:
  - `src/pipeline/authTrace/openaiAuthReplay.js`
  - `tests/pipeline/authTrace/openaiAuthReplay.test.js`
  - `docs/plans/2026-03-30-root-mail-a-determinism-writeup.md`

## Replay Branch Summary

| Branch | OTP | Reset | Workspace select in replay | Refresh-bearing | Stable enough for automation |
| --- | --- | --- | --- | --- | --- |
| `existing-login-otp` | Required | No | Yes, if continuation lands on `/workspace` | No | Yes, if OTP reliably arrives |
| `password-login` direct continuation | Optional | No | Yes, via callback continuation | No | Only if direct password continuation is valid |
| `password-login` passwordless fallback | Required | No | Yes | No | Sometimes, but OTP delivery is inconsistent |
| `forgot-password` | Required on default path | Yes | Yes after continuation | No | Partially; continuation is fragile live |
| `signup-new` | Required | No | Yes | No | Only with sentinel + invite preload + healthy upstream invites |

## Recovery State Machine

Defined in `src/pipeline/authTrace/recoverBrowserlessIdentity.js`.

### Default configured order

1. `existing-login-otp`
2. `password-login`
3. `forgot-password`
4. `password-init`

### Root-Mail_a configured order

1. `forgot-password`
2. `password-init`
3. `password-login`
4. `existing-login-otp`

### Actual effective Root-Mail_a runtime order

1. `forgot-password`
2. `password-login`
3. `existing-login-otp`

Reason:

- `password-init` is named in the Root-Mail_a order, but the default engine does not actually run it unless `runPasswordInit` is explicitly injected.

### Recovery terminals

- `recovered`
  - first authenticated replay branch wins
- `blocked`
  - if no branch authenticates
  - `password-reset-continuation-missing` is preserved as terminal blocked reason
- `recreate-needed`
  - for `password-init-required`, `password-init-not-implemented`, `reset-not-available`

## Owned OAuth State Machine

Defined in `src/pipeline/authTrace/openaiOwnedOauth.js`.

This is the canonical durable-refresh path.

### Durable path

1. Seed jar from prior replay cookies.
2. Optionally select workspace with `POST /api/accounts/workspace/select`.
3. Start desktop authorize:
   - `https://auth.openai.com/oauth/authorize`
   - `client_id=app_EMoamEEZ73f0CkXaXp7hrann`
   - `redirect_uri=http://localhost:1455/auth/callback`
   - `originator=codex_chatgpt_desktop`
   - `scope=openid profile email offline_access`
4. Reach localhost callback carrying owned desktop OAuth code.
5. Redeem only that code at `POST /oauth/token`.
6. Require both `access_token` and `refresh_token`.
7. Require `accountId === d3d588b2-8a74-4acc-aa2e-94662ff0e025` and non-free plan.

### Critical boundary

The ChatGPT callback branch and the owned OAuth desktop callback branch are not equivalent.

- `chatgpt.com/api/auth/callback/openai?...`
  - establishes a ChatGPT browser session
  - leads to `chatgpt_session`
  - does not produce durable refresh
- `http://localhost:1455/auth/callback?...`
  - is the owned desktop OAuth callback
  - is the only callback that should be redeemed at `POST /oauth/token`

Live evidence:

- `cruelfigure620-existing-login-otp-owned-oauth-probe-2026-03-31T07-37-29-589Z.json`
  - replay reached `chatgpt_session` with the target workspace account
  - attempted token exchange failed with `401 token_exchange_user_error`

### Owned OAuth typed blockers

- `password-reset-initiation-failed`
- `password-reset-email-consumption-failed`
- `password-reset-completion-failed`
- `password-reset-continuation-missing`

### Owned OAuth hard failures that are not yet typed

- workspace select failed
- authorize did not return callback
- state mismatch
- callback code missing
- token exchange failed / no refresh token
- workspace mismatch after token exchange

### Overloaded blocker

`password-reset-continuation-missing` currently covers two materially different situations:

1. reset completion returned no usable `continue_url`
2. a continuation existed but never resolved to a localhost callback

## Persistence State Machine

### Intended contract

Defined across:

- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/rotation/piAccountRegistrar.js`
- `src/pipeline/rotation/verifyRecoveredAlias.js`

### Pre-write fail-closed gates

Before writing:

- access token must be present
- identity email must match alias email
- expected workspace account must be selected
- workspace plan must not be `free`, `guest`, or missing
- refresh-bearing auth must be present for workspace-scoped onboarding

### Write contract

`auth.json`

- key: `emailToAliasId(email)`
- value:
  - `type: 'oauth'`
  - `access`
  - `refresh`
  - `expires`
  - `accountId`

`account-router.json`

- alias object with:
  - `id`
  - `cloneFrom: 'openai-codex'`
  - `email`
  - workspace/owner metadata from placement context
- pool membership:
  - provider list contains alias id
  - route exists for model

### Post-write verification

`verifyPiRouterOnboarding()` requires:

- alias in auth
- alias in router
- email match
- `cloneFrom === 'openai-codex'`
- alias in pool providers
- alias has pool route
- JWT email matches and is verified
- `accountId` matches expected workspace
- workspace-capable plan when workspace is required

### Current live gap

For all four target aliases:

- present in `~/.pi/agent/codex-inbox-pool.json`
- absent from `~/.pi/agent/auth.json`
- absent from `~/.pi/agent/account-router.json`
- absent from `~/.pi/agent/account-router-health.json`

Pool entries are unlinked:

- no `linkedAliasId`
- no `routerAliasId`
- no `authAliasId`
- no linked account id

## Branch Divergence and State Loss

The current system under-models several state boundaries.

### Branch equivalence assumptions that are wrong

1. `password-only login` and `password-reset-continuation-missing` are collapsed into the same onboarding error class:
   - `NO_EMAIL_CODE_OPTION`
2. Recovery treats branch retries as mostly stateless:
   - branch-local cookies
   - login challenge state
   - reset continuation state
   - replay invite URL
   are not threaded into later attempts
3. Root-Mail_a names `password-init` as a first-class branch, but default recovery cannot execute it.
4. Replay success is treated as branch-equivalent once an access token exists, even though only owned OAuth can satisfy the durable contract.

### Places where state is created then lost

Challenge state:

- created in replay / owned OAuth via cookies like `login_session`, `hydra_redirect`, `auth_provider`, `oai-client-auth-session`
- often discarded from recovery decisions, which mostly inspect only `verdict`, redirect target, and blocker reason

Continuation state:

- created by replay reset steps and owned OAuth reset fallback as `continue_url` / `resetUrl`
- currently collapsed into broad blockers when lost

Workspace/invite state:

- created early in `browserlessMemberOnboarder.js`
- initial replay gets `inviteUrl`
- recovery replays do not get that invite/workspace context

Pool linkage state:

- never reconciled during onboarding
- even successful writes would leave the pool entry disconnected from auth/router state

## Live Blockers

### Stable facts from live evidence

1. ChatGPT callback auth can produce a real workspace-bound session.
2. That callback code is not redeemable as owned desktop OAuth.
3. Direct password submit is not a reliable primitive on the current owned OAuth login stack.
4. Reset/password-init primitives are real, but continuation is fragile and sometimes stale.
5. OTP delivery is inconsistent for these inboxes.
6. Persistence gates are correct and should not be weakened.

### Observed dead ends for durable router persistence

- replay-only success without owned OAuth refresh
- direct redemption of ChatGPT callback code at `/oauth/token`
- direct password submit on current login challenge stack
- forgot-password runs that end in:
  - `reset_token_already_used`
  - `password_already_used`
  - `password-reset-continuation-missing`
- fresh signup when Root-Mail_a invite creation fails upstream

### Stable enough for automation

- replay `existing-login-otp` if OTP reliably arrives
- replay `password-login` if direct continuation works
- owned desktop OAuth when cookies/session are already aligned and it reaches localhost callback

## Operator Decision

The evidence-backed canonical durable path for the four existing live aliases is:

1. recover or replay enough first-layer auth to establish the correct identity and workspace-capable session
2. preserve cookies, workspace state, and branch-specific continuation state
3. run owned desktop OAuth to obtain a refresh-bearing token bundle
4. persist only after downstream workspace/account/email verification passes
5. reconcile inbox-pool linkage to the persisted alias

## Smallest Durable Corrections

The smallest changes justified by this map are:

1. Preserve typed blocker semantics and recovery context.
   - Do not collapse `password-reset-continuation-missing` into `NO_EMAIL_CODE_OPTION`.
   - Pass replay-derived context into recovery attempts.
   - When recovery fails, surface the recovery blocker rather than the original flattened onboarding error.

2. Preserve and forward placement/linkage metadata.
   - Thread pool workspace/owner metadata into onboarding as `placementContext`.
   - Reconcile the pool entry after successful persistence so it links to the durable alias/account.

These changes are small enough to avoid ad hoc branch proliferation, and they directly target the two places where the current system loses contract-critical information.