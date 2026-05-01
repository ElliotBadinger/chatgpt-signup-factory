# Resend Owner Browserless Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and prove a fully browserless Resend-based OpenAI Business alias onboarding flow.

**Architecture:** Keep Resend receiving in `authTrace/resendReceiving.js`, direct OpenAI auth replay in `authTrace/openaiAuthReplay.js`, workspace invite and acceptance in `rotation/browserlessWorkspaceClient.js` and `rotation/browserlessMemberOnboarder.js`, and Pi router writes in `rotation/routerOnboarder.js`. The CLI `src/cli/resend-owner-onboard-alias.js` orchestrates the whole owner -> invite -> alias -> router flow.

**Tech Stack:** Node.js ESM, Jest, native `fetch`, Resend receiving API, ChatGPT/OpenAI backend HTTP APIs, local Pi router JSON files.

---

## File Structure

- Modify: `src/pipeline/authTrace/openaiAuthReplay.js`
  - Owns direct HTTP OpenAI auth replay and the owner OTP problem.
- Modify: `src/pipeline/authTrace/resendReceiving.js`
  - Owns Resend receiving and OTP parsing. Keep this provider-specific and browserless.
- Modify: `src/pipeline/rotation/browserlessMemberOnboarder.js`
  - Owns alias invite polling, invite parsing, alias membership verification.
- Modify: `src/cli/resend-owner-onboard-alias.js`
  - Owns CLI orchestration and final result shape.
- Modify or create focused tests:
  - `tests/pipeline/authTrace/resendReceiving.test.js`
  - `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`
  - `tests/pipeline/authTrace/openaiAuthReplay.test.js`
  - `tests/pipeline/rotation/browserlessMemberOnboarder.test.js`
  - `tests/cli/resendOwnerOnboardAlias.test.js`
- Do not modify:
  - Codex source code under `.nvm` or installed package directories.
  - Cloudflare receiving code for this task.
  - AgentMail receiving behavior except to preserve non-Resend paths.

## Task 1: Verify Normal Codex Network Path

**Files:**
- Read: `/home/epistemophile/bin/codex`
- Read: `/home/epistemophile/bin/check-codex-network`
- Read: `/home/epistemophile/bin/codex-smoke`

- [ ] **Step 1: Run the plain shell network checker**

Run:

```bash
check-codex-network
```

Expected:

```text
network-ok
```

Also expected:

- `127.0.0.1:9` returns `ECONNREFUSED`, not `EPERM`.
- `https://api.resend.com` returns `200`.
- Codex LB model list includes `gpt-5.5`.

- [ ] **Step 2: Run the plain Codex smoke**

Run:

```bash
codex-smoke
```

Expected:

```text
Yes. It printed `network-ok`.
```

- [ ] **Step 3: If the smoke fails with `EPERM`, diagnose wrapper launch**

Run:

```bash
command -v codex
sed -n '1,120p' /home/epistemophile/bin/codex
```

Expected:

- `command -v codex` returns `/home/epistemophile/bin/codex`.
- Wrapper contains `--disable use_linux_sandbox_bwrap`.
- Wrapper contains `--sandbox danger-full-access`.

## Task 2: Lock Resend Receiving Behavior

**Files:**
- Modify: `src/pipeline/authTrace/resendReceiving.js`
- Test: `tests/pipeline/authTrace/resendReceiving.test.js`

- [ ] **Step 1: Run existing Resend tests**

Run:

```bash
npm test -- tests/pipeline/authTrace/resendReceiving.test.js --runInBand
```

Expected:

```text
PASS tests/pipeline/authTrace/resendReceiving.test.js
```

- [ ] **Step 2: Add a failing test if stale OTPs can be selected**

Add this test only if current implementation does not reject older mail correctly:

```js
test('ignores OTP messages older than sinceMs', async () => {
  const fetchImpl = jest.fn(async (url) => {
    if (String(url).endsWith('/emails/receiving?limit=50')) {
      return response(200, {
        data: [{
          id: 'msg-old',
          to: ['openai_1@epistemophile.store'],
          subject: 'Your temporary ChatGPT verification code',
          created_at: '2026-04-24 01:00:00.000000+00',
        }],
      });
    }
    return response(200, {
      id: 'msg-old',
      subject: 'Your temporary ChatGPT verification code',
      text: '111111',
      created_at: '2026-04-24 01:00:00.000000+00',
    });
  });

  await expect(pollResendReceivedOtp({
    email: 'openai_1@epistemophile.store',
    apiKey: 're_test',
    fetchImpl,
    sinceMs: new Date('2026-04-24T01:01:00.000Z').getTime(),
    timeoutMs: 5,
    pollIntervalMs: 1,
  })).rejects.toThrow('Resend OTP poll timeout');
});
```

- [ ] **Step 3: Implement minimal fix if test fails**

Ensure `fetchLatestResendReceivedEmail()` filters list metadata by:

```js
.filter((message) => parseCreatedAt(message.created_at) >= sinceMs)
```

and ensure retrieved full messages are still passed through the same matcher before returning.

- [ ] **Step 4: Re-run Resend tests**

Run:

```bash
npm test -- tests/pipeline/authTrace/resendReceiving.test.js --runInBand
```

Expected:

```text
PASS tests/pipeline/authTrace/resendReceiving.test.js
```

## Task 3: Stabilize Owner OTP Trigger

**Files:**
- Modify: `src/pipeline/authTrace/openaiAuthReplay.js`
- Test: `tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js`
- Test: `tests/pipeline/authTrace/openaiAuthReplay.test.js`

- [ ] **Step 1: Reproduce owner OTP behavior live with redacted logging**

Run:

```bash
node src/cli/resend-owner-onboard-alias.js --dry-run
```

Expected:

- Dry run succeeds.
- No live OTP request is made.

Then run a focused owner auth probe if one exists, or temporarily run the owner sign-in portion with logs that print only:

- step name
- HTTP status
- redirect host/path
- whether a fresh OTP was found

Do not print cookies or tokens.

- [ ] **Step 2: Add a unit test for password-page email-code fallback**

Use a fake `fetchImpl` that returns a redirect to `/log-in/password`, then asserts the replay calls the email OTP send endpoint and polls Resend.

Expected test behavior:

- `replayOpenAiAuthFlow({ email: 'openai_1@epistemophile.store', mode: 'existing-login-otp' })` does not end at `password-login-unsupported` when a send-code endpoint succeeds.
- It calls `pollResendReceivedOtp()` with `sinceMs` captured immediately before the OTP request.

- [ ] **Step 3: Implement fallback only from observed endpoints**

Patch `openaiAuthReplay.js` so the password-page fallback:

- Uses the observed OpenAI auth endpoint only after verifying required CSRF/state cookies are available.
- Records a step for OTP send attempt.
- Uses a fresh `sinceMs`.
- Fails with a message that includes the send endpoint status and response preview when no OTP is delivered.

- [ ] **Step 4: Re-run auth replay tests**

Run:

```bash
npm test -- \
  tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js \
  --runInBand
```

Expected:

```text
PASS tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js
PASS tests/pipeline/authTrace/openaiAuthReplay.test.js
```

## Task 4: Verify Workspace Invite And Alias Acceptance

**Files:**
- Modify: `src/pipeline/rotation/browserlessMemberOnboarder.js`
- Test: `tests/pipeline/rotation/browserlessMemberOnboarder.test.js`

- [ ] **Step 1: Run current member onboarding tests**

Run:

```bash
npm test -- tests/pipeline/rotation/browserlessMemberOnboarder.test.js --runInBand
```

Expected:

```text
PASS tests/pipeline/rotation/browserlessMemberOnboarder.test.js
```

- [ ] **Step 2: Add a Resend invite mismatch test if not present**

Add a test where Resend returns an invite for `other@epistemophile.store` while onboarding `openai_6@epistemophile.store`.

Expected:

```js
await expect(onboardBrowserlessWorkspaceMember(/* mismatch fixture */))
  .rejects.toThrow('Invite email mismatch');
```

- [ ] **Step 3: Ensure invite parser validates alias and workspace**

Implementation must reject:

- invite email mismatch.
- selected workspace id mismatch.
- missing workspace id.

- [ ] **Step 4: Re-run member onboarding tests**

Run:

```bash
npm test -- tests/pipeline/rotation/browserlessMemberOnboarder.test.js --runInBand
```

Expected:

```text
PASS tests/pipeline/rotation/browserlessMemberOnboarder.test.js
```

## Task 5: Harden End-To-End CLI Result And Router Verification

**Files:**
- Modify: `src/cli/resend-owner-onboard-alias.js`
- Modify: `src/pipeline/rotation/routerOnboarder.js` only if verification evidence is insufficient.
- Test: `tests/cli/resendOwnerOnboardAlias.test.js`

- [ ] **Step 1: Run CLI tests**

Run:

```bash
npm test -- tests/cli/resendOwnerOnboardAlias.test.js --runInBand
```

Expected:

```text
PASS tests/cli/resendOwnerOnboardAlias.test.js
```

- [ ] **Step 2: Add result-shape test**

Add or extend a test so `runResendOwnerOnboardAlias()` with mocked owner/alias clients returns:

```js
expect(result).toEqual(expect.objectContaining({
  status: 'onboarded',
  ownerEmail: 'openai_1@epistemophile.store',
  aliasEmail: 'openai_6@epistemophile.store',
  workspaceId: 'workspace-123',
  aliasId: 'openai_6',
  verification: expect.objectContaining({ pass: true }),
}));
```

- [ ] **Step 3: Ensure final JSON includes enough evidence**

The final result must include:

- owner email.
- alias email.
- workspace id.
- alias id.
- router verification object.

- [ ] **Step 4: Re-run CLI test**

Run:

```bash
npm test -- tests/cli/resendOwnerOnboardAlias.test.js --runInBand
```

Expected:

```text
PASS tests/cli/resendOwnerOnboardAlias.test.js
```

## Task 6: Run Focused Regression Suite

**Files:**
- No source changes unless tests fail.

- [ ] **Step 1: Run focused regression suite**

Run:

```bash
npm test -- \
  tests/pipeline/authTrace/resendReceiving.test.js \
  tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js \
  tests/pipeline/authTrace/openaiAuthReplay.test.js \
  tests/pipeline/rotation/browserlessMemberOnboarder.test.js \
  tests/pipeline/evidence/resendNotifier.test.js \
  tests/cli/resendOwnerOnboardAlias.test.js \
  --runInBand
```

Expected:

```text
PASS
```

- [ ] **Step 2: Fix only failures in touched surfaces**

If failures appear outside these files, confirm whether they are unrelated recovered-repo noise before widening scope.

## Task 7: Live Dry Run And Live End-To-End Run

**Files:**
- No source changes unless live evidence reveals a real bug.

- [ ] **Step 1: Dry run**

Run:

```bash
node src/cli/resend-owner-onboard-alias.js --dry-run
```

Expected:

```json
{
  "status": "dry-run",
  "ownerEmail": "openai_1@epistemophile.store",
  "aliasEmail": "openai_N@epistemophile.store"
}
```

- [ ] **Step 2: Live run**

Run:

```bash
node src/cli/resend-owner-onboard-alias.js
```

Expected:

```json
{
  "status": "onboarded",
  "verification": {
    "pass": true
  }
}
```

- [ ] **Step 3: Router verification**

Run:

```bash
ALIAS_ID=openai_N node --input-type=module - <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const aliasId = process.env.ALIAS_ID;
const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8'));
const router = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'account-router.json'), 'utf8'));
const alias = (router.aliases ?? []).find((entry) => entry.id === aliasId);
const pool = (router.pools ?? []).find((entry) => entry.name === 'openai-codex');
console.log(JSON.stringify({
  aliasId,
  auth: Boolean(auth[aliasId]),
  alias,
  inPoolProviders: Boolean(pool?.providers?.includes(aliasId)),
  route: (pool?.routes ?? []).find((entry) => entry.provider === aliasId) ?? null,
}, null, 2));
NODE
```

Expected:

- `auth` is `true`.
- `alias.email` matches the onboarded alias.
- `inPoolProviders` is `true`.
- `route.provider` equals the alias id.

## Task 8: Final Report

**Files:**
- Modify: `docs/handoff-progress.md` only if the live run outcome needs durable recording.

- [ ] **Step 1: Record verification**

Record:

- command outputs summarized.
- alias email.
- workspace id.
- pass/fail status.
- remaining risk.

- [ ] **Step 2: Final answer**

Final answer must state:

- changed files.
- tests run.
- live commands run.
- whether a fresh alias was fully onboarded.
- any blocker with exact failing command and error.

## Self-Review

Spec coverage:

- Resend receiving is covered by Tasks 2 and 7.
- Owner OTP is covered by Task 3.
- Workspace invite is covered by Task 4.
- CLI orchestration is covered by Task 5.
- Regression and live proof are covered by Tasks 6 and 7.
- Handoff reporting is covered by Task 8.

Placeholder scan:

- This plan contains concrete file paths, commands, expected results, and test snippets.

Type consistency:

- Alias id examples use `openai_N`.
- Owner email examples use `openai_1@epistemophile.store`.
- Workspace examples use `workspace-123` only as mocked test data.
