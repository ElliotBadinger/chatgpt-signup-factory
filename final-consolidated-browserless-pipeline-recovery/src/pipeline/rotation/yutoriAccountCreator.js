/**
 * yutoriAccountCreator.js
 *
 * Creates a ChatGPT account using the Yutori Browsing API (n1-latest vision agent).
 *
 * v3 redesign — from live run diagnostics:
 *
 *  Problem 1: DevTools F12 unavailable ("browser in restricted mode")
 *  Problem 2: api.agentmail.to direct URL → "Unauthorized" (no auth header via navigation)
 *  Fix: Cloudflare Worker OTP proxy at otp-proxy.windsurf-epistemophile.workers.dev
 *       Agent navigates to plain HTTPS URL → sees OTP/invite in 100px text, auto-refreshes
 *       Worker fetches AgentMail server-side → no CORS, no DevTools, no auth header needed
 *
 *  Problem 3: Agent clicks Sign-up → create-account/password instead of OTP flow
 *  Fix: start_url = auth.openai.com/log-in-or-create-account (skips chatgpt.com homepage)
 *
 *  Problem 4: Password field unresponsive (vision model sees dots ●, thinks nothing typed)
 *  Fix: Task explains password fields show dots (normal), use fixed password C0dexAg3nt!2025
 *       Also: look for "Continue with email"/"Email me a code" to switch to OTP first
 *
 *  Problem 5: Transient POST "fetch failed" (1/8 tasks)
 *  Fix: Retry POST 3× with exponential backoff
 *
 * Cloudflare Worker (otp-proxy.windsurf-epistemophile.workers.dev):
 *   GET /otp/{inboxId}?k={base64ApiKey}
 *   → Fetches AgentMail server-side, shows OTP + invite link as HTML, auto-refreshes every 6s
 *   → No auth header or DevTools required from the agent
 *
 * Public API:
 *   buildProxyUrl(inboxId, apiKey)        → HTTPS proxy URL for this inbox
 *   buildBrowsingTask(opts)               → BrowsingTaskConfig
 *   pollTaskUntilDone(id, key, opts)      → BrowsingTaskResult
 *   extractAuthFromResult(result)         → ChatGptAuth | null
 *   createAccountViaYutori(opts)          → CreateChatGptAccountResult
 */

import { Buffer } from 'node:buffer';
import { YutoriTimeoutError } from './errors.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const YUTORI_BASE_URL  = 'https://api.yutori.com';
const OTP_PROXY_BASE   = 'https://otp-proxy.windsurf-epistemophile.workers.dev';
const DEFAULT_AGENT    = 'navigator-n1-latest';
const DEFAULT_STEPS    = 75;
const DEFAULT_POLL_MS  = 15_000;
const DEFAULT_TIMEOUT  = 15 * 60 * 1000; // 15 minutes
const POST_RETRIES     = 3;
const POST_RETRY_BASE  = 2_000;

// Fixed password for all new accounts.  Long enough (15 chars), passes all
// ChatGPT password requirements (upper + lower + digit + special).
const ACCOUNT_PASSWORD = 'C0dexAg3nt!2025';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   email:              string;
 *   agentMailApiKey:    string;
 *   agentMailInboxId:   string;
 *   yutoriApiKey:       string;
 *   name?:              string;
 *   teamInviteCallback?: (email: string) => Promise<void>;
 *   agent?:             string;
 *   maxSteps?:          number;
 *   pollIntervalMs?:    number;
 *   taskTimeoutMs?:     number;
 * }} YutoriAccountCreatorOpts
 */

/**
 * @typedef {{
 *   task:          string;
 *   start_url:     string;
 *   max_steps:     number;
 *   agent:         string;
 *   output_schema: object;
 * }} BrowsingTaskConfig
 */

/**
 * @typedef {{
 *   task_id: string;
 *   status:  'queued' | 'running' | 'succeeded' | 'failed';
 *   output?: object;
 *   error?:  string;
 * }} BrowsingTaskResult
 */

/**
 * @typedef {{
 *   type:      'oauth';
 *   access:    string;
 *   refresh:   string | null;
 *   expires:   number;
 *   accountId: string | null;
 * }} ChatGptAuth
 */

/**
 * @typedef {
 *   | { success: true;  auth: ChatGptAuth }
 *   | { success: false; error: string }
 * } CreateChatGptAccountResult
 */

// ─── Input validation ─────────────────────────────────────────────────────────

/** @param {YutoriAccountCreatorOpts} opts @throws {TypeError} */
function assertOpts(opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('opts must be an object');
  if (typeof opts.email !== 'string' || !opts.email.includes('@'))
    throw new TypeError(`opts.email must be a valid email; got: ${JSON.stringify(opts.email)}`);
  if (typeof opts.agentMailApiKey !== 'string' || opts.agentMailApiKey.length < 5)
    throw new TypeError(`opts.agentMailApiKey must be a non-empty string`);
  if (typeof opts.agentMailInboxId !== 'string' || !opts.agentMailInboxId)
    throw new TypeError(`opts.agentMailInboxId must be a non-empty string`);
  if (typeof opts.yutoriApiKey !== 'string' || !opts.yutoriApiKey.startsWith('yt'))
    throw new TypeError(`opts.yutoriApiKey must be a Yutori API key starting with 'yt'`);
}

// ─── Proxy URL builder ────────────────────────────────────────────────────────

/**
 * Build the Cloudflare Worker OTP proxy URL for a given inbox.
 *
 * The agent navigates to this URL in the browser.  The worker fetches
 * AgentMail server-side (no CORS, no DevTools, no auth header from the browser)
 * and returns an auto-refreshing HTML page showing the OTP + invite link.
 *
 * @param {string} inboxId
 * @param {string} apiKey
 * @returns {string}
 */
export function buildProxyUrl(inboxId, apiKey) {
  const keyB64 = Buffer.from(apiKey).toString('base64');
  return `${OTP_PROXY_BASE}/otp/${encodeURIComponent(inboxId)}?k=${encodeURIComponent(keyB64)}`;
}

// ─── Task builder ─────────────────────────────────────────────────────────────

/**
 * Build the Yutori browsing task configuration.
 *
 * v3 key changes:
 *  - start_url: auth.openai.com/log-in-or-create-account (skips chatgpt.com)
 *  - OTP/invite: one Cloudflare Worker URL (auto-refreshes, no DevTools)
 *  - Password: explicit handling with fixed password + "show dots" explanation
 *  - Invite: same proxy URL shows invite link after OTP section
 *
 * @param {Pick<YutoriAccountCreatorOpts,
 *   'email'|'agentMailApiKey'|'agentMailInboxId'|'name'|'agent'|'maxSteps'>} opts
 * @returns {BrowsingTaskConfig}
 */
export function buildBrowsingTask(opts) {
  const {
    email,
    agentMailApiKey,
    agentMailInboxId,
    name      = 'Codex Agent',
    agent     = DEFAULT_AGENT,
    maxSteps  = DEFAULT_STEPS,
  } = opts;

  const proxyUrl = buildProxyUrl(agentMailInboxId, agentMailApiKey);

  const task = `\
TASK: Log in to (or create) a ChatGPT account and join a workspace.

CREDENTIALS:
  Email: ${email}
  Name: ${name}
  Password (if needed): ${ACCOUNT_PASSWORD}

━━━ STEP 1: ENTER EMAIL ━━━
You are already on the OpenAI auth page.
Find the email input field. Type: ${email}
Click the "Continue" button.

━━━ STEP 2: HANDLE THE RESULT ━━━

CASE A — OTP / "Check your email" screen (asks for a 6-digit code):
→ Skip to STEP 3.

CASE B — Password screen (asks to create or enter a password):
→ IMPORTANT: Password input fields display typed characters as dots (●●●●●). 
  This is completely normal. The characters ARE being entered even though you 
  cannot see them as plain text.
→ First, look for any link/button labeled "Continue with email", "Email me a code",
  "Send me a code", "Use email code", or "Passwordless sign-in". If found, click it.
→ If no such link exists, click the password field, then type: ${ACCOUNT_PASSWORD}
  (You will see dots ●●●●●●●●●●●●●●● — that is correct, the password IS being entered)
→ If there is a "Confirm password" or second password field, click it and type the same.
→ Click Continue / Submit.
→ Continue to STEP 3.

━━━ STEP 3: GET THE OTP CODE ━━━
A verification code has been sent to the email inbox.
Navigate to this URL (it shows the code automatically):

${proxyUrl}

This page polls the email inbox and displays the 6-digit code in large green text.
It auto-refreshes every 6 seconds. Wait up to 4 minutes for the code to appear.

When you see the code displayed (e.g., "483729"):
1. Remember the 6-digit number.
2. Press the Back button to return to the ChatGPT verification page.
3. Click the verification code input field.
4. Type the 6-digit code.
5. Click Continue.

━━━ STEP 4: COMPLETE ACCOUNT SETUP ━━━
If prompted for your name, type: ${name}
Click Continue / Next / Start / Let's go on any screens until you reach the main
ChatGPT chat interface (chatgpt.com with a text input box visible).

━━━ STEP 5: GET WORKSPACE INVITE LINK ━━━
Navigate to the same proxy URL again:

${proxyUrl}

This time, look at the blue section labeled "INVITE:" at the bottom.
It shows a URL starting with https://chatgpt.com/...
Wait up to 3 minutes. When the invite link appears:
1. Remember the full URL.
2. Navigate to that URL.
3. If asked to log in, use: ${email}  password: ${ACCOUNT_PASSWORD}
4. Click Accept / Join to accept the workspace invitation.

━━━ STEP 6: CAPTURE SESSION TOKEN ━━━
Navigate to: https://chatgpt.com/api/auth/session
The page displays a JSON object with session data including accessToken.
Return the complete JSON as your structured output.
`;

  const output_schema = {
    type: 'object',
    properties: {
      accessToken:  { type: 'string', description: 'OAuth access token (JWT)' },
      refreshToken: { type: 'string', description: 'OAuth refresh token' },
      expires:      { type: 'string', description: 'ISO 8601 expiry timestamp' },
      user: {
        type: 'object',
        properties: {
          id:    { type: 'string' },
          email: { type: 'string' },
        },
      },
    },
    required: ['accessToken'],
  };

  return {
    task,
    start_url: 'https://auth.openai.com/log-in-or-create-account',
    max_steps: maxSteps,
    agent,
    output_schema,
  };
}

// ─── Poller ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll GET /v1/browsing/tasks/{taskId} until terminal state or timeout.
 * Returns failed result rather than throwing (caller classifies).
 * Only throws YutoriTimeoutError if the clock runs out.
 *
 * @param {string} taskId
 * @param {string} yutoriApiKey
 * @param {{ pollIntervalMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<BrowsingTaskResult>}
 */
export async function pollTaskUntilDone(taskId, yutoriApiKey, opts = {}) {
  const { pollIntervalMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_TIMEOUT } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${YUTORI_BASE_URL}/v1/browsing/tasks/${taskId}`, {
      headers: {
        'X-API-Key':     yutoriApiKey,
        'Authorization': `Bearer ${yutoriApiKey}`,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new YutoriTimeoutError(
        `Yutori poll returned HTTP ${res.status}: ${body}`,
        { taskId, statusCode: res.status },
      );
    }

    /** @type {BrowsingTaskResult} */
    const data = await res.json();
    if (data.status === 'succeeded' || data.status === 'failed') return data;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  throw new YutoriTimeoutError(
    `Yutori browsing task '${taskId}' did not complete within ${timeoutMs}ms`,
    { taskId, elapsedMs: timeoutMs, timeoutMs },
  );
}

// ─── Auth extractor ───────────────────────────────────────────────────────────

/**
 * Extract a strongly-typed ChatGptAuth from a succeeded browsing task result.
 * Returns null if output is missing or has no accessToken.
 *
 * @param {BrowsingTaskResult} result
 * @returns {ChatGptAuth | null}
 */
export function extractAuthFromResult(result) {
  const output = result?.output;
  const access = output?.accessToken ?? output?.access_token ?? null;
  if (!access) return null;

  const refresh    = output?.refreshToken ?? output?.refresh_token ?? null;
  const expiresRaw = output?.expires ?? null;
  const expires    = expiresRaw ? Date.parse(expiresRaw) : Date.now() + 3_600_000;
  const accountId  = output?.user?.id ?? output?.sub ?? null;

  return { type: 'oauth', access, refresh, expires, accountId };
}

// ─── POST with retry ──────────────────────────────────────────────────────────

/**
 * POST /v1/browsing/tasks with exponential backoff retry.
 *
 * @param {string} yutoriApiKey
 * @param {object} body
 * @returns {Promise<{task_id: string}>}
 */
async function postBrowsingTask(yutoriApiKey, body) {
  let lastErr;
  for (let attempt = 1; attempt <= POST_RETRIES; attempt++) {
    try {
      const res = await fetch(`${YUTORI_BASE_URL}/v1/browsing/tasks`, {
        method:  'POST',
        headers: {
          'X-API-Key':     yutoriApiKey,
          'Authorization': `Bearer ${yutoriApiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < POST_RETRIES) await sleep(POST_RETRY_BASE * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Create (or log in to) a ChatGPT account using the Yutori Browsing API.
 * Parallel-safe: no shared state, no file I/O.
 *
 * @param {YutoriAccountCreatorOpts} opts
 * @returns {Promise<CreateChatGptAccountResult>}
 */
export async function createAccountViaYutori(opts) {
  assertOpts(opts);

  const {
    email,
    agentMailApiKey,
    agentMailInboxId,
    yutoriApiKey,
    name           = 'Codex Agent',
    teamInviteCallback,
    agent          = DEFAULT_AGENT,
    maxSteps       = DEFAULT_STEPS,
    pollIntervalMs = DEFAULT_POLL_MS,
    taskTimeoutMs  = DEFAULT_TIMEOUT,
  } = opts;

  try {
    // 1. Pre-invite before launching task
    if (teamInviteCallback) {
      await teamInviteCallback(email);
    }

    // 2. Build + launch browsing task (3× retry)
    const config = buildBrowsingTask({ email, agentMailApiKey, agentMailInboxId, name, agent, maxSteps });
    const { task_id: taskId } = await postBrowsingTask(yutoriApiKey, {
      task:          config.task,
      start_url:     config.start_url,
      max_steps:     config.max_steps,
      agent:         config.agent,
      output_schema: config.output_schema,
    });

    // 3. Poll until terminal
    const result = await pollTaskUntilDone(taskId, yutoriApiKey, { pollIntervalMs, timeoutMs: taskTimeoutMs });

    // 4. Extract auth
    if (result.status === 'failed') {
      return { success: false, error: result.error ?? `Yutori task ${taskId} failed` };
    }
    const auth = extractAuthFromResult(result);
    if (!auth) {
      return { success: false, error: `Yutori task ${taskId} succeeded but output contained no accessToken` };
    }
    return { success: true, auth };

  } catch (err) {
    if (err instanceof TypeError) throw err;
    return { success: false, error: `yutoriAccountCreator: ${err?.message ?? String(err)}` };
  }
}
