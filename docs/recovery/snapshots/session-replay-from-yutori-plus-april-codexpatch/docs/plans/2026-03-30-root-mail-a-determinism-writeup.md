# Root-Mail_a Deterministic Handoff

## System Overview

Root-Mail_a onboarding in this repo has 3 distinct layers:

1. `openaiAuthReplay.js`
   - browserless auth/sign-up replay against `chatgpt.com` and `auth.openai.com`
   - yields `/api/auth/session` shape plus cookies
2. `browserlessMemberOnboarder.js`
   - turns a recovered ChatGPT identity into a verified workspace member
   - handles invite dispatch, invite acceptance, membership probes, and workspace selection/materialization
3. `routerOnboarder.js`
   - consumes the onboarded identity and persists it into `~/.pi/agent/auth.json` and `~/.pi/agent/account-router.json`
   - must preserve refresh-bearing auth and workspace scoping; it fails closed otherwise

The enforced auth contract that must not regress is still correct:

- preserve refresh-bearing auth (`refreshToken` / `refresh_token`)
- refuse degraded auth persistence
- refuse workspace-scoping regressions
- refuse personal/free auth as workspace success

Target workspace:

- workspace name: `Root-Mail_a`
- workspace id: `d3d588b2-8a74-4acc-aa2e-94662ff0e025`

## Root-Mail_a Timeline

Known-good recovered members before this pass:

- `cruelfigure620@agentmail.to`
- `exciteditem179@agentmail.to`
- `blacktext181@agentmail.to`

Known-bad fresh-onboarding attempts before this pass:

- `sparklingevent72@agentmail.to`
- `carefulmusic791@agentmail.to`

New results from this pass:

- local auth/onboarding bug was traced to invite ordering
- invite-aware replay support was added and covered with tests
- truly net-new fresh invite creation still errored upstream for `motionlessmagazine30@agentmail.to`
- a 4th usable Root-Mail_a alias was recovered deterministically from an existing legacy member:
  - `annoyedcommittee236@agentmail.to`

## Healthy Vs Degraded Auth Shapes

Healthy workspace-scoped recovery shape:

- `accessToken`: present
- `accountId`: `d3d588b2-8a74-4acc-aa2e-94662ff0e025`
- JWT plan type: `team`
- `/backend-api/accounts` includes Root-Mail_a
- `/backend-api/accounts/{workspaceId}/users` works with workspace header

Degraded or non-durable shape:

- `refreshToken`: missing
- personal/free `accountId` or `accountId = null`
- session authenticated but not bound to Root-Mail_a
- `invites/accept` or materialization does not create membership

This repo still correctly refuses to persist degraded auth into the router.

## Root Cause Of The 4th-Alias Blocker

### Local root cause

The failing fresh-account path in `browserlessMemberOnboarder.js` authenticated first and invited later.

That sequencing is wrong for truly net-new workspace sign-up:

1. replay created or authenticated a personal account without invite context
2. session came back with `accountId = null` or personal account state
3. later `invites/accept` had to operate from a session that never went through the auth.openai workspace-selection step
4. downstream acceptance/materialization was inconsistent or failed with `invalid_workspace_selected`

The missing test coverage reflected the bug:

- existing-login OTP already had workspace-selection coverage
- `signup-new` had no invite-aware workspace-selection coverage

### Upstream blocker found after the local fix

Once invite-aware preloading was implemented, the fresh prototype moved failure earlier:

- `motionlessmagazine30@agentmail.to` was created successfully as a fresh AgentMail inbox
- pre-auth invite creation failed with `Unable to invite user due to an error.`
- live workspace probe at the same time showed:
  - 6 current users
  - 0 pending invites

So the remaining net-new blocker at the end of this pass was not seat exhaustion and not the old local ordering bug. It was upstream invite creation refusing the fresh inbox before signup began.

## codex-lb Comparison

Repo investigated:

- `https://github.com/Soju06/codex-lb`
- local clone: `/tmp/codex-lb`

What codex-lb does well:

- standard OAuth browser/device flows
- durable token handling
- refresh rotation via `/oauth/token`
- deriving `chatgpt_account_id` from `id_token`

What codex-lb does not solve for this repo:

- it does not implement ChatGPT Business workspace invite onboarding
- it does not model `chatgpt.com/auth/login?...accept_wId=...`
- it does not handle invite email materialization or auth.openai workspace-selection sequencing for business invites

Conclusion:

- codex-lb was useful as a reference for durable OAuth/refresh discipline
- it was not reusable as the fix for Root-Mail_a invite/materialization
- the durable local fix had to stay in this repo’s replay/onboarder flow

## Final Code Fix

### 1. Invite-aware replay preload

File:

- [openaiAuthReplay.js](src/pipeline/authTrace/openaiAuthReplay.js)

Change:

- `replayOpenAiAuthFlow()` now accepts `inviteUrl`
- when supplied, it preloads the workspace invite URL before the normal login bootstrap

Effect:

- fresh signup can carry workspace invite context into the later auth.openai continuation chain

### 2. Pre-auth invite dispatch for known workspaces

File:

- [browserlessMemberOnboarder.js](src/pipeline/rotation/browserlessMemberOnboarder.js)

Change:

- when the target workspace is already known (`selectedWorkspace` or `placementContext.workspaceId`), the onboarder now:
  - creates or reuses the invite first
  - synthesizes the corresponding invite URL
  - passes that URL into `replayOpenAiAuthFlow()`

Effect:

- the auth replay can reach the workspace-selection step during fresh signup instead of trying to bolt workspace membership on afterward

### 3. Relaxed assumption on pre-join `account.id`

File:

- [browserlessMemberOnboarder.js](src/pipeline/rotation/browserlessMemberOnboarder.js)

Change:

- the onboarder no longer hard-fails just because pre-join `session.account.id` is absent

Reason:

- fresh invite-aware signup may still need to prove workspace membership through accounts/users probes rather than an already-populated personal `account.id`

## Proven Operational Outcome

### Fresh net-new onboarding

What is proven:

- the local invite-order bug is fixed in code and tests
- the fresh prototype now fails at invite creation, not at post-auth materialization

What is not yet proven live:

- a full new-inbox Root-Mail_a invite-preload signup from start to finish, because the invite endpoint itself refused the fresh inbox during this pass

### 4th usable alias

What is proven live:

- `annoyedcommittee236@agentmail.to` recovered to a workspace-bound Root-Mail_a session
- observed recovery summary:
  - status: `recovered`
  - branch: `existing-login-otp`
  - replay branch: `password-login`
  - final workspace id: `d3d588b2-8a74-4acc-aa2e-94662ff0e025`
  - team/workspace session shape

This made Root-Mail_a operationally usable with 4 verified aliases:

- `cruelfigure620@agentmail.to`
- `exciteditem179@agentmail.to`
- `blacktext181@agentmail.to`
- `annoyedcommittee236@agentmail.to`

## Tests And Verification

Fresh verification commands run in this worktree:

1. `npm test -- --runTestsByPath tests/pipeline/authTrace/openaiAuthReplay.test.js`
2. `npm test -- --runTestsByPath tests/pipeline/rotation/browserlessMemberOnboarder.test.js`
3. `npm test -- --runTestsByPath tests/pipeline/rotation/browserlessWorkspaceClient.test.js`

Observed result:

- all 41 targeted tests passed after the fix

New coverage added:

- invite-preloaded `signup-new` workspace selection in replay
- pre-auth invite dispatch and invite URL propagation in member onboarding

## Spec-Compliance Review

Result: pass

Reasons:

- refresh-bearing router contract was preserved
- no degraded auth persistence was introduced
- workspace scoping checks were not loosened
- healthy existing auth/onboarder paths remained covered by the full targeted suites
- codex-lb was investigated and not cargo-culted into the solution

## Code-Quality Review

Result: pass with one documented limitation

Good:

- changes are minimal and stay inside the existing auth/onboarder seam
- no router persistence logic was weakened
- test coverage was added exactly at the missing provider-sequencing edge

Limitation:

- pre-auth invite dispatch for truly net-new inboxes is still at the mercy of upstream invite creation health
- that is now isolated cleanly and fails before the repo creates false-positive personal sessions

## Deterministic Process Going Forward

### For existing legacy Root-Mail_a members

Use recovery first:

1. recover the existing member with `recoverBrowserlessIdentity()`
2. verify `accountId = d3d588b2-8a74-4acc-aa2e-94662ff0e025`
3. verify membership with `listUsers()`
4. only attempt router registration if refresh-bearing auth is present

### For truly net-new Root-Mail_a members

Use invite-aware onboarding:

1. create or reuse the workspace invite first
2. replay auth with the invite URL preloaded
3. let auth.openai perform workspace selection during the auth continuation
4. verify membership with accounts/users probes
5. fail closed if invite creation itself errors or if refresh-bearing auth is missing

## Hardening Recommendations

1. Add explicit artifact writing for every live recovery run so console-only recovery evidence is not lost.
2. Split invite creation health from signup health in operational dashboards.
3. Add a dedicated live runbook for “existing member recovery” vs “net-new member invite-preload onboarding”.
4. Keep router persistence strict; do not backslide to storing access-only workspace auth.

## Artifact Index

- Working Root-Mail_a workspace snapshot:
  - [workspace-snapshot.json](artifacts/root-mail-a-determinism-20260330/workspace-snapshot.json)
- Healthy recovered aliases from earlier pass:
  - [cruelfigure620-recovery.json](artifacts/root-mail-a-determinism-20260330/cruelfigure620-recovery.json)
  - [exciteditem179-recovery.json](artifacts/root-mail-a-determinism-20260330/exciteditem179-recovery.json)
  - [blacktext181-recovery.json](artifacts/root-mail-a-determinism-20260330/blacktext181-recovery.json)
- Newly verified 4th usable alias summary:
  - [annoyedcommittee236-recovery-summary.json](artifacts/root-mail-a-determinism-20260330/annoyedcommittee236-recovery-summary.json)
- Fresh invite-preload prototype and failure summary:
  - [root-mail-a-invite-preload-prototype.mjs](tmp/root-mail-a-invite-preload-prototype.mjs)
  - [invite-preload-prototype-failure-summary.json](artifacts/root-mail-a-determinism-20260330/invite-preload-prototype-failure-summary.json)
- Code changed in this pass:
  - [openaiAuthReplay.js](src/pipeline/authTrace/openaiAuthReplay.js)
  - [browserlessMemberOnboarder.js](src/pipeline/rotation/browserlessMemberOnboarder.js)
  - [openaiAuthReplay.test.js](tests/pipeline/authTrace/openaiAuthReplay.test.js)
  - [browserlessMemberOnboarder.test.js](tests/pipeline/rotation/browserlessMemberOnboarder.test.js)