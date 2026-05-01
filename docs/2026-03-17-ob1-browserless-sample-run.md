# OB1 browserless sample run status

Date: 2026-03-17
VM: `ob1-dedicated-1773603455`
Project: `gen-lang-client-0259644489`

## Isolation

The run was executed from `/tmp` on the VM using:

- temp-only Node v24 binary under `/tmp/node-v24.12.0-linux-x64`
- temp-only project bundle under `/tmp/ob1-browserless-sample-2026-03-17T03-54-00Z/project`
- copied state files (`auth/router/pool/health/archive`) under temp run dirs only

No VM services were deployed or modified.

## Artifact

Primary summary:

- `artifacts/workspace-replays/2026-03-17-ob1-browserless-sample-run/2026-03-17T15-47-19-026Z/summary.json`

Per-run logs are nested under that directory.

## Sample set

Executed 4 isolated one-email live samples through `pipeline-check-archive-replace.js` using only `--router-onboard-email` against copied state:

1. `lonelyowner768@agentmail.to`
2. `evilunit375@agentmail.to`
3. `fairstate44@agentmail.to`
4. `thoughtlessresult872@agentmail.to`

## Outcome

All 4 runs failed in the same deterministic branch:

- `NO_EMAIL_CODE_OPTION`
- redirect observed: `https://auth.openai.com/log-in/password`

That means these inbox identities currently resolve to password-only login in the browserless auth replay path, so OTP-only onboarding cannot complete for them.

## Per-run status

- `lonelyowner768@agentmail.to`
  - result: failed
  - preexisting workspace member: no
  - preexisting invite: yes
  - copied pool status after run: `failed`
- `evilunit375@agentmail.to`
  - result: failed
  - preexisting workspace member: no
  - preexisting invite: yes
  - copied pool status after run: `failed`
- `fairstate44@agentmail.to`
  - result: failed
  - preexisting workspace member: yes
  - preexisting invite: no
  - copied pool status after run: `failed`
- `thoughtlessresult872@agentmail.to`
  - result: failed
  - preexisting workspace member: no
  - preexisting invite: yes
  - copied pool status after run: `failed`

## Cleanup / side effects

- No new router/auth state was written to production local files; only copied temp state was modified.
- No new workspace members were added by these 4 runs.
- No preexisting members/invites were removed or canceled.

## Interpretation

The browserless workspace/onboarding implementation is functioning as designed in failure handling on OB1:

- the CLI launched correctly in an isolated GCloud VM environment
- owner workspace discovery worked
- live invite/member pre-checks worked
- each run failed fast with a typed deterministic auth-branch error

The current blocker for these sampled inboxes is not the VM environment or workspace API path; it is that the sampled identities now require password login rather than email-code OTP.
