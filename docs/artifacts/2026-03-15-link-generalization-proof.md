# `/link` and `/link_credentials` Account-Generalization Proof — 2026-03-15

## Summary

This audit traced the current Worker runtime paths for Telegram `/link` and Telegram `/link_credentials` and checked whether account identity is derived dynamically from runtime authentication state or hidden fixed-account assumptions.

## Bottom line

**Code-path proof:**
- `/link` is **account-agnostic** at the Worker level. It binds the eventual session to whatever Prolific identity Auth0 returns at runtime, then derives/stores `prolificUserId` from the returned ID token.
- `/link_credentials` is **account-agnostic inside the Worker/job state path**. The Worker creates a login job keyed by the Telegram runtime user/chat, and later stores whatever `refreshToken` + `prolificUserId` the VM reports for that claimed job. There is no fixed participant ID in the Worker code path.

**Important limitation:**
- The current persistence model is still **single-linked-account per platform user** (`platform:userId` key). So these flows are generalizable to **any valid account**, but they are **not** proof that one Telegram/Discord user can keep multiple Prolific accounts linked simultaneously.

**What is not yet proven live:**
- A live multi-account A/B run using two distinct valid Prolific accounts through both flows was **not** executed in this task.
- For `/link_credentials`, the Worker trusts the VM to inject the correct `prolificUserId` for the claimed job; this task did not perform a live adversarial mismatch test.

## Trace 1 — `/telegram/link` runtime path

### Entry route
- `worker.fetch(...)` routes `POST /telegram/link` to:
  - `handleLinkCommand(request, env, "telegram", ctx)`

### `handleLinkCommand`
Relevant behavior:
1. Reads runtime user identity from request JSON:
   - `userId` from `body.userId` or `body.user_id`
   - `chatId` from `body.chatId` or `body.telegramChatId`
2. Builds Telegram notification target from the runtime `chatId`; no Prolific account ID is supplied here.
3. Calls `AuthClient.preparePkceAuthorization(...)` to create PKCE state/verifier/authorize URL.
4. Persists a `LinkBootstrapState` containing:
   - `state`, `verifier`, `userId`, `platform`, `notificationTargets`, `returnUrl`, `authorizeUrl`, `redirectUri`, `expiresAt`, etc.
5. Returns a share URL under `/otl/share?...`.

### Account binding point
The `/telegram/link` call itself does **not** choose a Prolific account. It only stores Telegram/platform/runtime routing state.

The account becomes bound later in the OAuth completion path:
- `/auth/share/callback` exchanges `code + verifier` for tokens.
- `/auth/share/claim` decrypts the authorized session and persists a `UserSessionRecord`.
- That persistence step sets:
  - `prolificUserId: extractProlificUserId(session)`

So the Prolific account is derived from the **returned Auth0/Prolific session**, not from any hard-coded participant ID.

## Trace 2 — `handleLinkCommand` account derivation details

`handleLinkCommand` stores only chat/platform routing and PKCE state. It does **not**:
- accept a participant ID,
- look up a fixed participant ID,
- or insert any static Prolific account binding.

The later session persistence path derives the participant ID using:
- `extractProlificUserId(session)`
  - first from ID-token claim `https://internal-api.prolific.com/user_id`
  - otherwise from the trailing segment of `sub`

This is direct code-path proof that the `/link` flow is bound to runtime auth output, not a repository-fixed account.

## Trace 3 — `/link_credentials` flow in `handleTelegramCommands`

### Entry route
- `worker.fetch(...)` routes `POST /telegram/commands` to:
  - `handleTelegramCommands(request, env, ctx)`

### Private-DM gating
`/link_credentials` is rejected outside private chats. In private chat:
- `userId = String(message.from.id)`
- `targetChatId = String(message.chat.id)`

### Onboarding state path
The command sequence is:
1. `/link_credentials`
   - stores Telegram onboarding state via `upsertTelegramCredentialState(...)`
   - state key is `userId + chatId`
   - stage becomes `awaiting_email`
2. user sends email
   - same state becomes `awaiting_password`
3. user sends password
   - `createTelegramLoginJob(...)` creates a DO job containing:
     - `telegramUserId`
     - `telegramChatId`
     - `encryptedCredentials`
   - onboarding state becomes `submitting`

### Claim/result path
VM-facing endpoints:
- `GET /vm/telegram-login-job/next`
  - calls `claimNextTelegramLoginJob(env)`
  - decrypts credentials for the claimed job
  - acknowledges claim and scrubs stored credentials
- `POST /vm/telegram-login-job/result`
  - stores sanitized result for the claimed `jobId`
  - sends final Telegram status DM to the claimed job’s `telegramChatId`

This path is keyed by **runtime job state**, not by a fixed Prolific account.

## Trace 4 — VM login job claim/result/inject path

### Job creation
`createTelegramLoginJob(...)` stores a short-lived job in `TelegramCredentialFlowDurableObject`.
- Job fields include `telegramUserId`, `telegramChatId`, and encrypted credentials.
- No participant ID is assigned here.

### Job claim
`GET /vm/telegram-login-job/next`:
- claims the oldest pending/retryable job
- returns the claimed job’s runtime Telegram identifiers and decrypted credentials

### Token injection
After the VM completes login, it calls:
- `POST /vm/token-inject`

Required injected fields:
- `refreshToken`
- `prolificUserId`
- `platform`
- `chatId`

`handleVmTokenInject(...)` then stores:
- `session.refreshToken = injected refreshToken`
- `record.userId = chatId`
- `record.platform = platform`
- `record.prolificUserId = injected prolificUserId`
- Telegram notification target = injected `chatId`

It then calls `stateStore.putUserSession(record)` and bootstraps the poller through `ensureDurablePoller(...)`.

### Result reporting
Finally the VM calls:
- `POST /vm/telegram-login-job/result`

The Worker updates the claimed job result and notifies the job’s `telegramChatId`.

## Trace 5 — participant-id derivation and storage

### `/link` / share flow
Participant ID derivation is dynamic:
- `extractProlificUserId(session)` decodes the returned ID token.
- The derived value is stored in `UserSessionRecord.prolificUserId` during `/auth/share/claim`.
- Poller/session sync also carries `prolificUserId` into poller metadata.

### `/link_credentials` / VM inject flow
Participant ID is not derived by the Worker from an ID token here.
Instead:
- the VM supplies `prolificUserId` to `/vm/token-inject`
- the Worker stores that exact runtime-supplied value in `UserSessionRecord.prolificUserId`
- downstream APIs and trigger fan-out use that stored value

### Downstream usage
The stored `prolificUserId` is then reused for:
- `/profile` and `/aboutme` API paths
- user-specific endpoint URLs such as `/api/v1/users/:prolificUserId/...`
- poller metadata sync
- `/vm/firestore-trigger`, which matches all stored session records where `record.prolificUserId === payload.prolificUserId`

## Findings: account-agnostic vs hidden assumptions

### Proven account-agnostic behavior
1. **No fixed participant ID exists in the traced Worker runtime paths.**
   - `/link` derives the Prolific user from the returned session.
   - `/link_credentials` routes work by runtime Telegram job state and injected runtime values.
2. **Stored Prolific identity is dynamic.**
   - It is either extracted from the current session (`/link`) or injected at runtime by the VM (`/link_credentials`).
3. **Fan-out by participant ID is data-driven.**
   - `/vm/firestore-trigger` enumerates stored session records and matches exact `record.prolificUserId` values; it is not pinned to a single known account in Worker code.

### Hidden single-account / platform assumptions that remain
1. **One linked session per platform user.**
   - `StateStore` keys user sessions by `platform:userId`.
   - Re-linking the same Telegram user replaces that user’s stored Prolific session.
   - Therefore the system currently supports “any one valid account per Telegram/Discord user,” not “many Prolific accounts per one Telegram/Discord user.”
2. **`/link_credentials` trusts VM-supplied `prolificUserId`.**
   - `handleVmTokenInject(...)` requires `prolificUserId` in the POST body and stores it directly.
   - The Worker does not independently cross-check that injected `refreshToken` belongs to that same participant at inject time.
   - This is not a fixed-account assumption, but it is a trust boundary.
3. **Telegram private-chat identity equivalence is assumed.**
   - `/link_credentials` onboarding state uses `from.id` and `chat.id` separately, but final session injection stores by `chatId`.
   - In Telegram private chats these identifiers are typically equivalent in practice, which is why production works, but it is still a platform assumption.

## Evidence used

### Code-path evidence
- `src/worker/prolific-monitor.ts`
  - `handleLinkCommand(...)`
  - `handleTelegramCommands(...)`
  - `handleShareCallback(...)`
  - `handleShareClaim(...)`
  - `handleVmTokenInject(...)`
  - `extractProlificUserId(...)`
  - `TelegramCredentialFlowDurableObject`
  - `StateStore.putUserSession/getUserSession/listUserSessionRecords(...)`
  - `ensureDurablePoller(...)`

### Test evidence
- `src/worker/__tests__/link-command.test.ts`
  - proves `/telegram/link` persists runtime-specific link state and Telegram targets
- `src/worker/__tests__/telegram-credentials.test.ts`
  - proves onboarding state is separated by runtime Telegram user/chat keys
- `src/worker/__tests__/vm-endpoints.test.ts`
  - proves `/vm/token-inject` stores the injected `prolificUserId` and session record

### Prior live runtime evidence relevant to this audit
- `docs/local-validation-plan.md` already records real production Telegram credential-link completion using a live chat, VM claim, `/vm/token-inject`, `/vm/telegram-login-job/result`, and follow-up `/status`, `/profile`, `/aboutme` reads.

## What this proof supports

This task supports the following bounded claim:

> The current Worker implementation of `/link` and Telegram `/link_credentials` is generalizable to any valid Prolific account because account identity is bound from runtime authentication state or runtime VM injection data, not from a Worker-hardcoded participant ID.

## What this proof does **not** support yet

This task does **not** prove that:
- one Telegram or Discord user can keep multiple Prolific accounts linked simultaneously,
- the VM cannot inject a mismatched `prolificUserId`,
- or live end-to-end multi-account switching has been exercised with two distinct consenting Prolific accounts.

No plaintext credentials or tokens are recorded here.
