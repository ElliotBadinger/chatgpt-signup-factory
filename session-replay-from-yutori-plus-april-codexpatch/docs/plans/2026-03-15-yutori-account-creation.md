# Yutori Browsing API — Account Creation Implementation Plan

> **Goal:** Replace the brittle Puppeteer+Lightpanda `createChatGptAccount()` state machine
> with the Yutori Browsing API, achieving parallel account creation (9×) with
> zero local browser infra, Cloudflare-resistant automation, and UI-change immunity.

---

## Architecture

**Old path:**
```
createBrowserSession()  → Lightpanda cloud Chrome (brittle, bot-detected)
createChatGptAccount()  → 6 page.evaluate() scripts (DOM selectors break on deploys)
concurrency: 1          → serial — 300 s budget for 9 accounts, fail-fast kills all
```

**New path:**
```
preInviteTeamMember()        → send workspace invite (works before account exists)
yutori.POST /browsing/tasks  → real Chrome cloud, n1 vision agent
  └ agent:  chatgpt.com signup + OTP via api.agentmail.to DevTools + invite accept
yutori.GET /browsing/tasks   → poll until succeeded/failed
extractAuthFromResult()      → parse output_schema JSON → ChatGptAuth
concurrency: 9              → all aliases in parallel, no fail-fast
```

**OTP Strategy — Same-Origin DevTools Console:**
The browsing agent navigates to `https://api.agentmail.to/`, opens Chrome DevTools
console (F12), and runs a `fetch('/v0/inboxes/…', {headers:{Authorization:'Bearer …'}})`.
Because the browser is ON the api.agentmail.to origin, this is same-origin — CORS
is irrelevant. The agent reads the 6-digit code from the console output, closes
DevTools, presses Back to return to the auth.openai.com OTP page.

**Invite Strategy — Pre-invite + Agent Accept:**
Invite is sent by `productionTeamDriver.inviteTeamMember(email)` BEFORE the browsing
task starts (ChatGPT sends invite emails to any address, no account required).
The browsing agent, after login, fetches the invite link from AgentMail via the
same DevTools console technique, then navigates to the invite URL and accepts.

**Credential Map:**
| Credential | Source | How agent accesses |
|---|---|---|
| `YUTORI_API_KEY` | env var | Node.js → Yutori REST API |
| `inbox.rootApiKey` | pool JSON | embedded in task string → DevTools fetch |
| `inbox.agentMailInboxId` | pool JSON | embedded in task string → DevTools fetch |
| `inbox.inboxAddress` | pool JSON | email filled on chatgpt.com form |

No new credentials introduced. Cloudflare email routing is pre-configured.

---

## Files

| Action | Path |
|--------|------|
| **Create** | `src/pipeline/rotation/yutoriAccountCreator.js` |
| **Create** | `tests/pipeline/rotation/yutoriAccountCreator.test.js` |
| **Modify** | `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js` |
| **Modify** | `src/cli/pipeline-check-archive-replace.js` |

---

## Tasks

### Task 1: Typed error classes

**Files:** `src/pipeline/rotation/errors.js`

**Step 1:** Add `YutoriError` and `YutoriTimeoutError` to errors.js

**Step 2:** Run full test suite — must still pass 233/233

**Step 3:** Commit: `feat(yutori): add YutoriError + YutoriTimeoutError to errors`

---

### Task 2: yutoriAccountCreator — TDD skeleton

**Files:**
- Create: `tests/pipeline/rotation/yutoriAccountCreator.test.js`
- Create: `src/pipeline/rotation/yutoriAccountCreator.js`

Write ALL tests (red) then implement (green).

**Tests to write (in order):**

1. `buildBrowsingTask` embeds email in task string
2. `buildBrowsingTask` embeds inboxId and apiKey in task string
3. `buildBrowsingTask` output_schema requires accessToken
4. `buildBrowsingTask` sets max_steps=75, agent=navigator-n1-latest
5. `pollTaskUntilDone` resolves immediately when status=succeeded
6. `pollTaskUntilDone` resolves immediately when status=failed (returns result not throws)
7. `pollTaskUntilDone` polls multiple times before succeeded
8. `pollTaskUntilDone` throws YutoriTimeoutError when deadline exceeded
9. `extractAuthFromResult` parses accessToken + refreshToken + expires + user.id
10. `extractAuthFromResult` returns null when output missing accessToken
11. `createAccountViaYutori` success path: task→poll→extract, calls teamInviteCallback
12. `createAccountViaYutori` failure path: returns `{success:false, error}`
13. `createAccountViaYutori` HTTP error from POST: returns `{success:false, error}`
14. `createAccountViaYutori` validates required opts (missing yutoriApiKey, email, etc.)

**Step 1:** Write all 14 tests → verify all FAIL
**Step 2:** Run: `npm test -- --testPathPattern=yutoriAccountCreator`
**Step 3:** Implement `yutoriAccountCreator.js` to pass all tests
**Step 4:** Run again → all pass
**Step 5:** Run full suite → 233+14 = 247 pass
**Step 6:** Commit: `feat(yutori): yutoriAccountCreator with full test coverage`

---

### Task 3: checkArchiveAndReplaceExhausted — yutori path

**Files:**
- Modify: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- Modify: `tests/pipeline/rotation/checkArchiveAndReplaceExhausted.test.js`  ← add 2 tests

**Changes:**
- Add `yutoriCreateAccount?: (inbox, opts) => Promise<CreateChatGptAccountResult>` param
- When set: send pre-invite, call `yutoriCreateAccount(inbox, {teamInviteCallback?})` instead of `createBrowserSession+createChatGptAccount`
- When unset: existing path unchanged

**Step 1:** Write 2 new failing tests
**Step 2:** Implement changes
**Step 3:** All tests pass
**Step 4:** Commit: `feat(yutori): checkArchiveAndReplaceExhausted yutori path`

---

### Task 4: CLI — auto-select yutori when YUTORI_API_KEY set

**Files:** `src/cli/pipeline-check-archive-replace.js`

**Changes:**
- When `YUTORI_API_KEY` is set: concurrency=9, failFast=false, yutoriCreateAccount wired
- When not set: existing behaviour (concurrency=1, failFast=true, puppeteer path)
- Remove `createBrowserSession` call from the yutori path

**Step 1:** Update CLI
**Step 2:** Run full test suite → all pass
**Step 3:** Commit: `feat(yutori): CLI auto-selects yutori path when YUTORI_API_KEY set`

---

### Task 5: Pre-flight validation smoke test

A `dry-run` with `YUTORI_API_KEY` set and all inbox credentials present must:
1. Detect yutori path is active (log it)
2. Not call Yutori API (dry-run)
3. Exit 0

Run: `YUTORI_API_KEY=yt_test DRY_RUN=true node src/cli/pipeline-check-archive-replace.js --dry-run --status`

---

## Success Criteria (E2E)

```
YUTORI_API_KEY=yt_Xn0S1ZO... \
WORKSPACE_OWNER_EMAIL=agentmailroot1773504739a@epistemophile.space \
WORKSPACE_NAME=Root-Mail_a \
WORKSPACE_MAX_MEMBERS=8 \
BROWSER_WS_ENDPOINT='wss://cloud.lightpanda.io/ws?token=...' \
node src/cli/pipeline-check-archive-replace.js --force-replace-all-9
```

Expected:
- Log: `[yutori] Using Yutori Browsing API — concurrency=9`
- 9 browsing tasks launched in parallel
- New accounts created (or reused) for all 9 inboxes
- All added to workspace
- Exit 0
- `node src/cli/pipeline-check-archive-replace.js --status` shows 0 exhausted aliases
